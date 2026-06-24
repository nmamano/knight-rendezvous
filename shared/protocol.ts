// The client⇄server wire protocol. Imported by both the server and the frontend,
// so it must stay browser-safe: types only, plus the pure engine types.
//
// Knight Rendezvous is a server-authoritative co-op game. It is NOT turn-based,
// and (unlike chess) carries no turn/phase machinery in C1 — both players will
// later move freely (C2+). The server is the only oracle: it picks the random
// seed and broadcasts the FULL (n, steps, seed) triple plus the derived board so
// any client or test reproduces the identical board deterministically.

import type { Cell } from "./engine";

export type PlayerId = "p1" | "p2";

// Distinct knight + trail colors, one per player. p1 = amber, p2 = violet.
export type ColorToken = "amber" | "violet";

// Room lifecycle. "waiting" = no opponent yet (no puzzle generated; board and
// knights are null); "active" = both players present and the puzzle is live.
export type LobbyPhase = "waiting" | "active";

export interface PlayerView {
  id: PlayerId;
  color: ColorToken; // p1 = amber, p2 = violet
  name: string;
  connected: boolean;
}

/**
 * The full public board, carried on the wire so any client/test can reproduce it
 * deterministically: the (n, steps, seed) triple regenerates the SAME puzzle, and
 * available/start/end are sent alongside so a client need not even run the engine
 * to render it.
 *
 * The witness `path` is deliberately NOT here — it stays server-side only.
 */
export interface Board {
  n: number;
  steps: number;
  seed: number;
  available: boolean[][];
  start: Cell;
  end: Cell;
}

/**
 * The full, player-AGNOSTIC view of a room the server broadcasts to every client.
 * One identical snapshot is sent to both players; per-client identity (your
 * PlayerId and reconnect token) is delivered once, in `joined`.
 *
 * `board`, `knights`, and `visited` are null while waiting and all set once
 * active. p1's knight starts on board.start, p2's on board.end (see game.ts).
 *
 * `visited` is each knight's FULL trail, INCLUDING its start cell:
 * `visited.pX[0]` is the start cell and `visited.pX[last]` is the knight's
 * CURRENT cell — so `knights.pX === visited.pX[last]` always holds. The witness
 * solution is NEVER projected; intentionally there is no field named `path`.
 *
 * `status` is "playing" while the rendezvous is still open, "won" once one knight
 * has hopped onto the other's square (locked decision 1), and "playback" while a
 * view-solution animation is running (locked decision 7). Playback is room-wide
 * and REVERSIBLE: when it ends the status returns to "playing" with the
 * pre-playback knights/visited restored — view-solution NEVER marks the puzzle
 * solved. `result` is null while waiting AND while playing AND during playback;
 * only once won does it carry whether the win was `perfect` (every playable square
 * covered by ≥1 trail) and the `meetCell` where the two knights met (the one
 * allowed shared square). The knights/visited mutate frame-by-frame during
 * playback, so a reconnecting client sees the current frame and the rest.
 */
export interface RoomSnapshot {
  code: string;
  lobby: LobbyPhase;
  players: PlayerView[];
  board: Board | null;
  knights: { p1: Cell; p2: Cell } | null;
  visited: { p1: Cell[]; p2: Cell[] } | null;
  status: "playing" | "won" | "playback";
  result: { perfect: boolean; meetCell: Cell } | null;
}

// ---- client → server -------------------------------------------------------

export type ClientMsg =
  | { t: "create"; name?: string }
  | { t: "join"; code: string; name?: string }
  | { t: "reconnect"; code: string; token: string }
  // Hop the SENDER's own knight to `cell`. The player is inferred server-side
  // from the bound slot — it is deliberately NOT carried on the wire.
  | { t: "move"; cell: Cell }
  // Reset ONLY the sender's own knight to its start, freeing its whole trail
  // (locked decision 6). Like move, the player is inferred from the bound slot
  // and there are no payload fields. Forbidden once the game is won.
  | { t: "retry" }
  // Pop ONLY the sender's own last move (locked decision 6). No payload fields;
  // a benign no-op when the knight is already at its start. Forbidden once won.
  | { t: "undo" }
  // Trigger the view-solution animation for the WHOLE room (locked decision 7):
  // both knights animate along the witness toward the rendezvous. No payload —
  // it is room-wide, not per-player. Ignored unless the game is "playing"; it
  // never marks the puzzle solved and restores the prior state when it ends.
  | { t: "viewSolution" }
  // Ask for a witness-only hint for the SENDER's own knight (locked decision 7).
  // No payload (the player is inferred from the bound slot); the response is
  // ACTOR-ONLY (a `hint` ServerMsg sent to the requester alone), never broadcast.
  // Only meaningful while "playing".
  | { t: "hint" }
  // Reset the WHOLE room to a FRESH random puzzle (C6, locked decision 5: this
  // keeps us within the single random-puzzle screen — no levels/catalog). It is
  // a RESET, not a win-gated rematch: allowed while "playing" OR "won", and
  // during "playback" the server cancels the running playback first, then
  // regenerates. Both clients re-render the new identical board; the witness
  // `path` stays server-side.
  //
  // Optional `n`/`steps` choose the new board's size + path length (set by the
  // play-screen sliders). They are NOT trusted: the server CLAMPS them into the
  // valid ranges (clampN/clampSteps), and an absent/non-integer value falls back
  // to the defaults (BOARD_N/BOARD_STEPS).
  | { t: "newPuzzle"; n?: number; steps?: number }
  | { t: "leave" };

// ---- server → client -------------------------------------------------------

export type ErrorCode =
  | "room_not_found"
  | "room_full"
  | "bad_token"
  | "bad_message"
  | "illegal_move"
  | "game_over";

export type ServerMsg =
  // `you` and `token` are returned ONLY here — never in a broadcast.
  | { t: "joined"; code: string; you: PlayerId; token: string; state: RoomSnapshot }
  | { t: "state"; state: RoomSnapshot } // pushed on every transition
  // ACTOR-ONLY hint response (locked decision 7): sent to the REQUESTER alone,
  // never broadcast, so the other client learns nothing. `status:"prefix"` carries
  // the requester's own next witness `cell`; `status:"off_path"` (cell null) means
  // the requester has diverged from the witness. The hint is only ever produced
  // while "playing" — there is deliberately NO "done"/"won" branch, and the raw
  // witness `path` is NEVER projected (only the single next cell).
  | { t: "hint"; status: "prefix"; cell: Cell }
  | { t: "hint"; status: "off_path"; cell: null }
  | { t: "opponentLeft" }
  | { t: "error"; code: ErrorCode; message: string };
