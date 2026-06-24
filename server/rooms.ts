// In-memory room store + the Room, which is the single owner of presence, the
// only place that broadcasts to clients, and the only place that holds a timer.
//
// Adapted from round-trip-chess/server/rooms.ts essentially wholesale — the
// room/slot/reconnect machinery is rules-agnostic. The only differences: the
// authoritative state is a co-op Game (not a turn-based Match), and the puzzle is
// generated when the SECOND player joins (the room becomes active).
//
// Timer invariant: there is EXACTLY ONE timer category — per-slot reconnect
// grace. Every disconnect/leave/reconnect path either clears the grace timer or
// no-ops safely when the slot's socket was replaced.

import { customAlphabet } from "nanoid";
import { Game, colorOf, type GamePlayer } from "./game";
import type { Cell } from "../shared/engine";
import {
  RECONNECT_GRACE_MS,
  CODE_LENGTH,
  CODE_ALPHABET,
  TOKEN_LENGTH,
  TOKEN_ALPHABET,
  MAX_NAME_LENGTH,
} from "../shared/config";
import type { ColorToken, PlayerId, ServerMsg, RoomSnapshot, ErrorCode } from "../shared/protocol";

const genCode = customAlphabet(CODE_ALPHABET, CODE_LENGTH);
const genToken = customAlphabet(TOKEN_ALPHABET, TOKEN_LENGTH);

type Timer = ReturnType<typeof setTimeout>;

/** The server's handle on one client socket. */
export interface Connection {
  send(msg: ServerMsg): void;
  close(): void;
}

interface Slot {
  player: GamePlayer;
  token: string;
  conn: Connection | null;
  graceTimer: Timer | null;
}

interface JoinError {
  error: ErrorCode;
  message: string;
}

function cleanName(name: unknown): string {
  const n = (typeof name === "string" ? name : "").trim().slice(0, MAX_NAME_LENGTH);
  return n.length ? n : "Player";
}

const other = (pid: PlayerId): PlayerId => (pid === "p1" ? "p2" : "p1");

export class Room {
  game: Game | null = null;
  private slots: { p1: Slot | null; p2: Slot | null } = { p1: null, p2: null };
  // Flipped false by teardown so a late socket close on a remaining player can't
  // arm a grace timer on an already-reaped room.
  private alive = true;

  constructor(
    readonly code: string,
    private readonly onEmpty: (code: string) => void,
  ) {}

  hasOpenSlot(): boolean {
    return this.slots.p2 === null;
  }

  // ---- joining ----------------------------------------------------------

  addCreator(name: string | undefined, conn: Connection): { pid: "p1"; token: string } {
    const token = genToken();
    this.slots.p1 = {
      player: { id: "p1", name: cleanName(name), connected: true },
      token,
      conn,
      graceTimer: null,
    };
    return { pid: "p1", token };
  }

  /** Attach the second player and generate the puzzle (room becomes active). */
  reserveJoiner(
    name: string | undefined,
    conn: Connection,
  ): { pid: "p2"; token: string } | JoinError {
    if (!this.slots.p1) return { error: "room_not_found", message: "Room is not ready." };
    if (this.slots.p2) return { error: "room_full", message: "This room is full." };

    const token = genToken();
    this.slots.p2 = {
      player: { id: "p2", name: cleanName(name), connected: true },
      token,
      conn,
      graceTimer: null,
    };

    // Pass the slot player objects by reference so presence changes propagate
    // into the game's snapshot without any extra wiring. The Game generates the
    // puzzle once here, with a random server seed.
    this.game = new Game({ p1: this.slots.p1.player, p2: this.slots.p2.player });
    return { pid: "p2", token };
  }

  /** Reclaim a slot by its secret token. Replaces the prior socket if any. */
  reconnect(token: string, conn: Connection): { pid: PlayerId } | JoinError {
    const pid = this.findByToken(token);
    if (!pid) return { error: "bad_token", message: "Could not rejoin this room." };

    const slot = this.slots[pid]!;
    if (slot.conn) slot.conn.close(); // replace the prior socket (friendly for refresh)
    slot.conn = conn;
    slot.player.connected = true;
    if (slot.graceTimer) {
      clearTimeout(slot.graceTimer);
      slot.graceTimer = null;
    }
    return { pid };
  }

  // ---- gameplay ---------------------------------------------------------

  /**
   * Hop `pid`'s OWN knight to `cell`. Near-verbatim of chess Room.move:
   * stale-socket guard (a replaced socket silently no-ops), no game silently
   * no-ops, an illegal move errors back to the ACTOR only, otherwise broadcast.
   * Concurrency ("first valid wins") falls out for free from the single-threaded
   * room: the later of two racing moves to the same target just gets the error.
   */
  move(pid: PlayerId, cell: Cell, conn: Connection): void {
    const slot = this.slots[pid];
    if (!slot || slot.conn !== conn) return; // a replaced/stale socket may not act
    if (!this.game) return;
    const res = this.game.move(pid, cell);
    if (!res.ok) {
      conn.send({ t: "error", code: res.error.code, message: res.error.message });
      return;
    }
    this.broadcast();
  }

  // ---- presence / teardown ---------------------------------------------

  /** Called when a socket closes. `conn` guards against a stale (replaced) socket. */
  handleDisconnect(pid: PlayerId, conn: Connection): void {
    if (!this.alive) return; // room already reaped (opponent left); nothing to arm
    const slot = this.slots[pid];
    if (!slot || slot.conn !== conn) return; // already replaced by a reconnect
    slot.conn = null;
    slot.player.connected = false;
    this.broadcast(); // opponent sees the connection dot drop

    if (slot.graceTimer) clearTimeout(slot.graceTimer);
    slot.graceTimer = setTimeout(() => {
      if (!slot.player.connected) this.teardown(pid);
    }, RECONNECT_GRACE_MS);
  }

  /** Explicit, immediate leave. */
  leave(pid: PlayerId, conn: Connection): void {
    if (!this.alive) return;
    const slot = this.slots[pid];
    if (!slot) return;
    if (slot.conn && slot.conn !== conn) return; // a stale socket may not force a leave
    slot.conn = null;
    slot.player.connected = false;
    this.teardown(pid);
  }

  private teardown(leftPid: PlayerId): void {
    this.alive = false;
    for (const pid of ["p1", "p2"] as const) {
      const s = this.slots[pid];
      if (s?.graceTimer) {
        clearTimeout(s.graceTimer);
        s.graceTimer = null;
      }
    }
    const opp = this.slots[other(leftPid)];
    opp?.conn?.send({ t: "opponentLeft" });
    this.onEmpty(this.code);
  }

  // ---- snapshots / broadcast -------------------------------------------

  /** The color a player holds. Static (p1 amber, p2 violet); never changes. */
  colorOf(pid: PlayerId): ColorToken {
    return colorOf(pid);
  }

  snapshot(): RoomSnapshot {
    if (!this.game) {
      // Waiting: only the creator is present; no puzzle yet (board/knights null).
      const p1 = this.slots.p1!.player;
      return {
        code: this.code,
        lobby: "waiting",
        players: [{ id: p1.id, color: colorOf(p1.id), name: p1.name, connected: p1.connected }],
        board: null,
        knights: null,
        visited: null,
        // No game yet → nothing has been played, so we are "playing" with no result.
        status: "playing",
        result: null,
      };
    }
    return {
      code: this.code,
      lobby: "active",
      players: this.game.playerViews(),
      board: this.game.board(),
      knights: this.game.snapshotKnights(),
      visited: this.game.snapshotVisited(),
      status: this.game.snapshotStatus(),
      result: this.game.snapshotResult(),
    };
  }

  broadcast(): void {
    const state = this.snapshot();
    for (const pid of ["p1", "p2"] as const) {
      const slot = this.slots[pid];
      if (slot?.conn) slot.conn.send({ t: "state", state });
    }
  }

  private findByToken(token: string): PlayerId | null {
    if (token && this.slots.p1?.token === token) return "p1";
    if (token && this.slots.p2?.token === token) return "p2";
    return null;
  }
}

export class RoomStore {
  private rooms = new Map<string, Room>();

  createRoom(): Room {
    let code = genCode();
    while (this.rooms.has(code)) code = genCode();
    const room = new Room(code, (c) => this.rooms.delete(c));
    this.rooms.set(code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get((code ?? "").toUpperCase());
  }

  has(code: string): boolean {
    return this.rooms.has(code);
  }

  get size(): number {
    return this.rooms.size;
  }
}
