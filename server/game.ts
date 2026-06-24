// Authoritative game state for one room. Fresh for Knight Rendezvous — NOT a
// port of chess's turn-based Match. It holds the generated puzzle, the two knight
// positions, and each knight's trail. C2 adds independent (non-turn-based)
// movement; C3 will add rendezvous (same-square win) detection.
//
// The server is the only oracle: it generates the puzzle ONCE per room from a
// random seed and projects a client-facing Board snapshot. The witness `path`
// stays inside the Puzzle and is NEVER projected onto the wire.

import { generatePuzzle, knightMoves, type Cell, type Puzzle } from "../shared/engine";
import { BOARD_N, BOARD_STEPS } from "../shared/config";
import type { Board, ColorToken, PlayerId, PlayerView } from "../shared/protocol";

export interface GamePlayer {
  id: PlayerId;
  name: string;
  connected: boolean;
}

// Discriminated result for a move attempt, mirroring chess's Match.move →
// Room.move contract (an ActionResult). On failure, the room sends the error to
// the ACTOR only; on success, it broadcasts the new state.
export interface MoveError {
  code: "illegal_move";
  message: string;
}
export type MoveResult = { ok: true } | { ok: false; error: MoveError };

function fail(message: string): MoveResult {
  return { ok: false, error: { code: "illegal_move", message } };
}

const otherPid = (pid: PlayerId): PlayerId => (pid === "p1" ? "p2" : "p1");

function sameCell(a: Cell, b: Cell): boolean {
  return a.r === b.r && a.c === b.c;
}

// Distinct knight + trail colors. p1 = amber, p2 = violet (locked decision 3).
export function colorOf(pid: PlayerId): ColorToken {
  return pid === "p1" ? "amber" : "violet";
}

// Server-only seed source. Math.random is fine HERE (never in shared/): the seed
// is the single nondeterministic input, and it is broadcast so both clients
// reproduce the identical board.
function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff) + 1;
}

export class Game {
  readonly puzzle: Puzzle;
  // Knight positions. p1 starts on the puzzle start, p2 on the end (locked
  // decision 3). In C1 they never move; C2 will mutate these on validated hops.
  readonly knights: { p1: Cell; p2: Cell };
  // Each knight's trail (ordered visited squares, including its start). Seeded
  // here so C2's movement/sync has the structure ready; unused in C1 rendering.
  readonly visited: { p1: Cell[]; p2: Cell[] };

  constructor(
    readonly players: { p1: GamePlayer; p2: GamePlayer },
    seed: number = randomSeed(),
  ) {
    this.puzzle = generatePuzzle(BOARD_N, BOARD_STEPS, seed);
    const start: Cell = { r: this.puzzle.start.r, c: this.puzzle.start.c };
    const end: Cell = { r: this.puzzle.end.r, c: this.puzzle.end.c };
    this.knights = { p1: start, p2: end };
    this.visited = { p1: [{ ...start }], p2: [{ ...end }] };
  }

  colorOf(pid: PlayerId): ColorToken {
    return colorOf(pid);
  }

  /**
   * Attempt to hop `pid`'s OWN knight to `cell`. Not turn-based: either player
   * may call this at any time. The room is single-threaded, so concurrent moves
   * are serialized here — first valid wins, a now-illegal follow-up errors.
   *
   * Validation runs in a fixed order; crucially we bounds-check `cell` BEFORE
   * indexing `available`, so a malformed/off-board target is a clean
   * `illegal_move`, never a crash:
   *   (a) `cell` is a legal knight move from this knight's CURRENT cell;
   *   (b) `cell` is in-bounds AND available[r][c] is true;
   *   (c) `cell` is not in union(visited.p1, visited.p2);
   *   (d) `cell` is not the OTHER knight's current cell.
   *
   * (c) already subsumes (d) today (the other knight's current cell is the last
   * entry of its trail), but (d) is kept as a SEPARATE, explicitly-named branch
   * on purpose: C3 flips exactly THIS branch into the rendezvous win. A
   * dedicated test anchors it.
   *
   * On success: push `cell` onto visited[pid] and set knights[pid] = cell.
   */
  move(pid: PlayerId, cell: Cell): MoveResult {
    const n = this.puzzle.n;
    const current = this.knights[pid];

    // (a) legal knight move from the current cell.
    const reachable = knightMoves(current, n);
    if (!reachable.some((m) => sameCell(m, cell))) {
      return fail("That is not a knight move from your current square.");
    }

    // (b) in-bounds AND available. BOUNDS FIRST — never index `available` with an
    // out-of-range cell. (knightMoves already keeps cells in-bounds, but this
    // guard is independent and defensive.)
    if (cell.r < 0 || cell.r >= n || cell.c < 0 || cell.c >= n) {
      return fail("That square is off the board.");
    }
    if (!this.puzzle.available[cell.r][cell.c]) {
      return fail("That square is not part of the board.");
    }

    // (c) not already visited by EITHER knight (no-reuse spans both trails).
    const visitedByEither = (c: Cell): boolean =>
      this.visited.p1.some((v) => sameCell(v, c)) || this.visited.p2.some((v) => sameCell(v, c));
    if (visitedByEither(cell)) {
      return fail("That square has already been visited.");
    }

    // (d) not the OTHER knight's current cell. C3 anchor: this exact branch
    // becomes the rendezvous win. For C2 it is REJECTED.
    if (sameCell(cell, this.knights[otherPid(pid)])) {
      return fail("You cannot land on the other knight.");
    }

    this.visited[pid].push({ r: cell.r, c: cell.c });
    this.knights[pid] = { r: cell.r, c: cell.c };
    return { ok: true };
  }

  /**
   * Project the public Board. Carries the full (n, steps, seed) triple so any
   * client/test reproduces the puzzle deterministically, plus the derived
   * available/start/end. Arrays are CLONED so neither tests nor server internals
   * can mutate engine-owned state through the snapshot. The witness `path` is
   * NEVER included.
   */
  board(): Board {
    const p = this.puzzle;
    return {
      n: p.n,
      steps: BOARD_STEPS,
      seed: p.seed,
      available: p.available.map((row) => row.slice()),
      start: { r: p.start.r, c: p.start.c },
      end: { r: p.end.r, c: p.end.c },
    };
  }

  snapshotKnights(): { p1: Cell; p2: Cell } {
    return {
      p1: { r: this.knights.p1.r, c: this.knights.p1.c },
      p2: { r: this.knights.p2.r, c: this.knights.p2.c },
    };
  }

  /**
   * Project each knight's trail. CLONES every cell (same discipline as board()
   * and snapshotKnights()) so the live engine arrays are never exposed on the
   * wire and a client/test cannot mutate game state through the snapshot.
   * `visited.pX[0]` is the start cell, `visited.pX[last]` is the current cell.
   */
  snapshotVisited(): { p1: Cell[]; p2: Cell[] } {
    return {
      p1: this.visited.p1.map((c) => ({ r: c.r, c: c.c })),
      p2: this.visited.p2.map((c) => ({ r: c.r, c: c.c })),
    };
  }

  playerViews(): PlayerView[] {
    return (["p1", "p2"] as const).map((id) => ({
      id,
      color: colorOf(id),
      name: this.players[id].name,
      connected: this.players[id].connected,
    }));
  }
}
