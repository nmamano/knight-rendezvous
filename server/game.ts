// Authoritative game state for one room. Fresh for Knight Rendezvous — NOT a
// port of chess's turn-based Match. In C1 it holds the generated puzzle and the
// two knight positions; there are deliberately NO move/win methods yet (C2 adds
// movement, C3 adds rendezvous detection).
//
// The server is the only oracle: it generates the puzzle ONCE per room from a
// random seed and projects a client-facing Board snapshot. The witness `path`
// stays inside the Puzzle and is NEVER projected onto the wire.

import { generatePuzzle, type Cell, type Puzzle } from "../shared/engine";
import { BOARD_N, BOARD_STEPS } from "../shared/config";
import type { Board, ColorToken, PlayerId, PlayerView } from "../shared/protocol";

export interface GamePlayer {
  id: PlayerId;
  name: string;
  connected: boolean;
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

  playerViews(): PlayerView[] {
    return (["p1", "p2"] as const).map((id) => ({
      id,
      color: colorOf(id),
      name: this.players[id].name,
      connected: this.players[id].connected,
    }));
  }
}
