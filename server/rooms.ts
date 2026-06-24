// In-memory room store + the Room, which is the single owner of presence, the
// only place that broadcasts to clients, and the only place that holds a timer.
//
// Adapted from round-trip-chess/server/rooms.ts essentially wholesale — the
// room/slot/reconnect machinery is rules-agnostic. The only differences: the
// authoritative state is a co-op Game (not a turn-based Match), and the puzzle is
// generated when the SECOND player joins (the room becomes active).
//
// Timer invariant: there are now TWO room-scoped timer categories.
//   1. Per-slot reconnect grace (one per slot). Every disconnect/leave/reconnect
//      path either clears the grace timer or no-ops safely when the slot's socket
//      was replaced.
//   2. A SINGLE view-solution playback timer (`playbackTimer`, at most one per
//      room, C5). It is cleared in exactly two places: when playback runs out of
//      frames (the final restore tick clears it), and in teardown() (so a room
//      reaped mid-playback cancels it). Its tick/restore callbacks also no-op if
//      the room is no longer alive or the game has left playback, so a late tick
//      after teardown/restore can never broadcast or crash.

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
  // The SINGLE view-solution playback timer (C5). At most one per room; null when
  // no playback is running. Cleared on the last frame and in teardown().
  private playbackTimer: Timer | null = null;

  constructor(
    readonly code: string,
    private readonly onEmpty: (code: string) => void,
    // Per-frame playback interval for this room's Game. Defaults to the Game's own
    // default (a normal pace); tests/smoke inject a small value via RoomStore.
    private readonly stepMs?: number,
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
    // puzzle once here, with a random server seed. `stepMs` (when injected by a
    // test/smoke via RoomStore) sets the view-solution playback cadence.
    this.game = new Game(
      { p1: this.slots.p1.player, p2: this.slots.p2.player },
      undefined,
      this.stepMs,
    );
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
    if (res.silent) return; // playback-locked: swallow without broadcasting
    this.broadcast();
  }

  /**
   * Reset ONLY `pid`'s own knight to its start (locked decision 6). Mirrors
   * Room.move EXACTLY: stale-socket guard (a replaced socket silently no-ops), no
   * game silently no-ops, a rejected op (post-win `game_over`) errors back to the
   * ACTOR only, otherwise broadcast. Uniform "ok ⇒ broadcast": we broadcast even
   * when retry was a no-op (already at start) — there is no "did anything change"
   * short-circuit.
   */
  retry(pid: PlayerId, conn: Connection): void {
    const slot = this.slots[pid];
    if (!slot || slot.conn !== conn) return; // a replaced/stale socket may not act
    if (!this.game) return;
    const res = this.game.retry(pid);
    if (!res.ok) {
      conn.send({ t: "error", code: res.error.code, message: res.error.message });
      return;
    }
    if (res.silent) return; // playback-locked: swallow without broadcasting
    this.broadcast();
  }

  /**
   * Pop ONLY `pid`'s own last move (locked decision 6). Mirrors Room.move EXACTLY
   * (same stale-socket guard, no-game no-op, error-to-actor, broadcast). Uniform
   * "ok ⇒ broadcast": we broadcast even when undo was a benign no-op (already at
   * start) — no "did anything change" short-circuit.
   */
  undo(pid: PlayerId, conn: Connection): void {
    const slot = this.slots[pid];
    if (!slot || slot.conn !== conn) return; // a replaced/stale socket may not act
    if (!this.game) return;
    const res = this.game.undo(pid);
    if (!res.ok) {
      conn.send({ t: "error", code: res.error.code, message: res.error.message });
      return;
    }
    if (res.silent) return; // playback-locked: swallow without broadcasting
    this.broadcast();
  }

  /**
   * Trigger room-wide view-solution playback (locked decision 7). Stale-socket
   * guarded like every other action. If the Game entered playback, drive its
   * ordered frames on a single `setInterval`: each tick applies the next frame and
   * broadcast()s; when frames are exhausted the Game RESTORES its pre-playback
   * state and a final broadcast() returns both clients to the playable position.
   * A no-op viewSolution (not "playing": won / already in playback / waiting)
   * broadcasts nothing and starts no timer.
   *
   * Both the tick and the final restore no-op if the room is no longer alive or
   * the game has left playback (B1 lifecycle): a late tick after teardown/restore
   * can neither broadcast nor crash.
   */
  viewSolution(pid: PlayerId, conn: Connection): void {
    const slot = this.slots[pid];
    if (!slot || slot.conn !== conn) return; // a replaced/stale socket may not act
    if (!this.game) return;
    if (this.playbackTimer) return; // a playback is already running (defensive)

    const res = this.game.viewSolution();
    if (!res.entered) return; // not "playing" → no-op, nothing sent, no timer
    const frames = res.frames;
    let i = 0;
    const stepMs = this.game.stepMs;

    const tick = () => {
      // Bail (and stop ticking) if the room was reaped or playback was ended out
      // from under us — never broadcast onto a dead/restored room.
      if (!this.alive || !this.game || !this.game.inPlayback()) {
        this.clearPlaybackTimer();
        return;
      }
      if (i < frames.length) {
        this.game.applyFrame(frames[i]);
        i++;
        this.broadcast();
        return;
      }
      // Frames exhausted: restore the pre-playback state and broadcast the return
      // to "playing", then stop the timer.
      this.clearPlaybackTimer();
      this.game.restore();
      this.broadcast();
    };

    this.playbackTimer = setInterval(tick, stepMs);
  }

  private clearPlaybackTimer(): void {
    if (this.playbackTimer) {
      clearInterval(this.playbackTimer);
      this.playbackTimer = null;
    }
  }

  /**
   * Per-player witness hint (locked decision 7): compute the requester's next
   * witness cell and send the ACTOR-ONLY `hint` ServerMsg to `conn` ONLY — NEVER
   * broadcast, so the other client learns nothing. The Game returns `null` (the
   * no-hint sentinel, when not "playing") → we send NOTHING.
   */
  hint(pid: PlayerId, conn: Connection): void {
    const slot = this.slots[pid];
    if (!slot || slot.conn !== conn) return; // a replaced/stale socket may not act
    if (!this.game) return;
    const res = this.game.hint(pid);
    if (!res) return; // no-hint sentinel → send nothing
    conn.send({ t: "hint", ...res });
  }

  /**
   * Reset the WHOLE room to a FRESH random puzzle (C6, locked decision 5). Mirrors
   * the PLUMBING of viewSolution/retry: stale-socket guard (a replaced socket
   * silently no-ops), no game silently no-ops. Unlike move/retry/undo it carries
   * NO win-gate and NO bad_phase error — newPuzzle is a RESET, allowed while
   * "playing" OR "won", and it CANCELS a running playback rather than rejecting.
   *
   * Order is load-bearing:
   *   (1) clearPlaybackTimer() FIRST (timer-leak discipline, same as teardown):
   *       any in-flight playback tick is stopped before we drop the old Game, so a
   *       late tick can never apply a frame onto / broadcast the new Game.
   *   (2) Build a FRESH Game REUSING the same slot.player references (so presence
   *       keeps propagating) and the same stepMs. The constructor's default seed
   *       (randomSeed()) picks a new random puzzle; status/result/visited/knights
   *       all reset in the constructor — we never reassign readonly fields on the
   *       old instance. Optional `n`/`steps` (from the play-screen sliders) pick
   *       the new board's size + path length; the Game constructor CLAMPS them
   *       server-side (clampN/clampSteps), so passing through unvalidated values
   *       is safe — they are bounded before they reach generatePuzzle. `undefined`
   *       falls back to the constructor defaults (BOARD_N/BOARD_STEPS).
   *   (3) broadcast() the new identical board to both clients.
   */
  newPuzzle(pid: PlayerId, conn: Connection, n?: number, steps?: number): void {
    const slot = this.slots[pid];
    if (!slot || slot.conn !== conn) return; // a replaced/stale socket may not act
    if (!this.game) return;
    // (1) cancel any running playback BEFORE swapping the game (teardown discipline).
    this.clearPlaybackTimer();
    // (2) fresh game: same player refs + same stepMs; constructor default = new
    //     seed; n/steps are CLAMPED inside the Game constructor.
    this.game = new Game(
      { p1: this.slots.p1!.player, p2: this.slots.p2!.player },
      undefined,
      this.stepMs,
      n,
      steps,
    );
    // (3) push the new identical board to both clients.
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
    // Cancel BOTH room-scoped timer categories: every slot's reconnect grace AND
    // the single view-solution playback timer (B1 lifecycle). With `alive` now
    // false, any already-queued playback tick also self-cancels (see viewSolution).
    for (const pid of ["p1", "p2"] as const) {
      const s = this.slots[pid];
      if (s?.graceTimer) {
        clearTimeout(s.graceTimer);
        s.graceTimer = null;
      }
    }
    this.clearPlaybackTimer();
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

  // Optional view-solution playback cadence applied to every room this store
  // creates. When omitted, each room reads `KR_PLAYBACK_STEP_MS` from the env at
  // creation time (so smoke can inject a small value) and otherwise falls back to
  // the Game's default. Tests pass it directly for a deterministic small interval.
  constructor(private readonly stepMs?: number) {}

  createRoom(): Room {
    let code = genCode();
    while (this.rooms.has(code)) code = genCode();
    const room = new Room(code, (c) => this.rooms.delete(c), this.resolveStepMs());
    this.rooms.set(code, room);
    return room;
  }

  private resolveStepMs(): number | undefined {
    if (this.stepMs !== undefined) return this.stepMs;
    const env = process.env.KR_PLAYBACK_STEP_MS;
    if (env === undefined) return undefined;
    const n = Number(env);
    return Number.isFinite(n) && n > 0 ? n : undefined;
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
