// Authoritative game state for one room. Fresh for Knight Rendezvous — NOT a
// port of chess's turn-based Match. It holds the generated puzzle, the two knight
// positions, and each knight's trail. C2 added independent (non-turn-based)
// movement; C3 adds rendezvous (same-square win) detection + win status.
//
// The server is the only oracle: it generates the puzzle ONCE per room from a
// random seed and projects a client-facing Board snapshot. The witness `path`
// stays inside the Puzzle and is NEVER projected onto the wire.

import { generatePuzzle, knightMoves, type Cell, type Puzzle } from "../shared/engine";
import { BOARD_N, BOARD_STEPS } from "../shared/config";
import type { Board, ColorToken, PlayerId, PlayerView, RoomSnapshot } from "../shared/protocol";

// The win projection: `status` flips to "won" on the rendezvous hop, and
// `result` (null while playing) then carries soft-vs-perfect + where they met.
type GameStatus = RoomSnapshot["status"];
type GameResult = RoomSnapshot["result"];

export interface GamePlayer {
  id: PlayerId;
  name: string;
  connected: boolean;
}

// Discriminated result for a move attempt, mirroring chess's Match.move →
// Room.move contract (an ActionResult). On failure, the room sends the error to
// the ACTOR only; on success, it broadcasts the new state. The failure `code` is
// `illegal_move` for a rule violation and `game_over` once the rendezvous has
// already happened (the post-win guard, check (0)).
export interface MoveError {
  code: "illegal_move" | "game_over";
  message: string;
}
export type MoveResult = { ok: true } | { ok: false; error: MoveError };

function fail(message: string): MoveResult {
  return { ok: false, error: { code: "illegal_move", message } };
}

function gameOver(message: string): MoveResult {
  return { ok: false, error: { code: "game_over", message } };
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
  // Win status. "playing" until the rendezvous hop flips it to "won" (forever —
  // there is no un-winning in C3). `result` stays null until then, then carries
  // soft-vs-perfect + the shared meeting cell.
  status: GameStatus = "playing";
  result: GameResult = null;

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
   *   (0) POST-WIN GUARD (first, unconditional): if already `won`, short-circuit
   *       with `game_over`. No move may follow the rendezvous.
   *   (a) `cell` is a legal knight move from this knight's CURRENT cell;
   *   (b) `cell` is in-bounds AND available[r][c] is true;
   *   (W) RENDEZVOUS WIN-CHECK: if `cell` is the OTHER knight's CURRENT cell, this
   *       hop IS the win (locked decision 1) — the SOLE allowed exception to
   *       no-reuse. It runs BEFORE (c) precisely because the partner's cell is the
   *       last entry of its own trail, so (c) would otherwise reject it. We append
   *       `cell` to visited[pid] and set knights[pid] = cell (keeping the
   *       invariant `knights.pX === visited.pX[last]`; the two knights now share
   *       that one square), flip status to "won", and compute `perfect`.
   *   (c) `cell` is not in union(visited.p1, visited.p2) (no-reuse spans both).
   *
   * The old C2 check (d) ("cannot land on the OTHER knight") is GONE: (W) now
   * handles the partner's cell as the win, and that is the only no-reuse exception.
   *
   * On a non-win success: push `cell` onto visited[pid] and set knights[pid].
   */
  move(pid: PlayerId, cell: Cell): MoveResult {
    const n = this.puzzle.n;
    const current = this.knights[pid];

    // (0) post-win guard FIRST — unconditional short-circuit. Once the rendezvous
    // has happened the game is over; no further move is accepted from either side.
    if (this.status === "won") {
      return gameOver("The game is over.");
    }

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

    // (W) rendezvous win-check — AFTER (a)/(b), BEFORE (c). Landing on the OTHER
    // knight's CURRENT cell is the win (the one allowed shared square). Must beat
    // (c), which would otherwise reject the partner's cell as already visited.
    if (sameCell(cell, this.knights[otherPid(pid)])) {
      this.visited[pid].push({ r: cell.r, c: cell.c });
      this.knights[pid] = { r: cell.r, c: cell.c };
      this.status = "won";
      // Perfect = every playable square is covered by ≥1 trail. Count DISTINCT
      // cells across both trails (keyed r*n+c, NOT Board.tsx's r*1000+c) and
      // compare to the number of available-true cells (counted inline so the
      // engine's public surface is untouched).
      const covered = new Set<number>();
      for (const v of this.visited.p1) covered.add(v.r * n + v.c);
      for (const v of this.visited.p2) covered.add(v.r * n + v.c);
      let availableCells = 0;
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (this.puzzle.available[r][c]) availableCells++;
        }
      }
      const perfect = covered.size === availableCells;
      this.result = { perfect, meetCell: { r: cell.r, c: cell.c } };
      return { ok: true };
    }

    // (c) not already visited by EITHER knight (no-reuse spans both trails). The
    // rendezvous hop (W) above is the only square this rule does not guard.
    const visitedByEither = (c: Cell): boolean =>
      this.visited.p1.some((v) => sameCell(v, c)) || this.visited.p2.some((v) => sameCell(v, c));
    if (visitedByEither(cell)) {
      return fail("That square has already been visited.");
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

  /**
   * Project the win state. `status` defaults "playing"; `result` stays null until
   * the rendezvous flips status to "won", then carries soft-vs-perfect + the
   * shared meeting cell (cloned, same no-leak discipline as the other snapshots).
   */
  snapshotStatus(): GameStatus {
    return this.status;
  }

  snapshotResult(): GameResult {
    if (!this.result) return null;
    return {
      perfect: this.result.perfect,
      meetCell: { r: this.result.meetCell.r, c: this.result.meetCell.c },
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
