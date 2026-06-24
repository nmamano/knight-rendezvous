// Engine port fidelity + determinism. A handful of knights-puzzle engine tests,
// plus the crucial co-op guarantee: generatePuzzle(n, steps, seed) is a pure
// function of its inputs — two calls give an identical board, and it reproduces a
// KNOWN board. That determinism is what lets two clients render the same puzzle
// from one broadcast seed.

import { test, expect, describe } from "bun:test";
import {
  generatePuzzle,
  knightMoves,
  legalMoves,
  makeRng,
  isWin,
  type Cell,
} from "../shared/engine";
import { BOARD_N, BOARD_STEPS } from "../shared/config";

function availStr(available: boolean[][]): string {
  return available.map((row) => row.map((x) => (x ? 1 : 0)).join("")).join("|");
}

describe("knightMoves", () => {
  test("a corner has exactly two in-board moves", () => {
    const moves = knightMoves({ r: 0, c: 0 }, 8);
    expect(moves).toEqual([
      { r: 1, c: 2 },
      { r: 2, c: 1 },
    ]);
  });

  test("a central square has all eight moves", () => {
    expect(knightMoves({ r: 4, c: 4 }, 8)).toHaveLength(8);
  });
});

describe("makeRng (mulberry32)", () => {
  test("is deterministic per seed and differs across seeds", () => {
    const a = makeRng(42);
    const b = makeRng(42);
    const c = makeRng(43);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual([c(), c(), c()]);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("generatePuzzle", () => {
  test("rejects invalid arguments", () => {
    expect(() => generatePuzzle(2, 5, 1)).toThrow();
    expect(() => generatePuzzle(6, 0, 1)).toThrow();
    expect(() => generatePuzzle(6, 5, 1.5)).toThrow();
  });

  test("produces a real knight's walk: every step is a knight move on playable cells", () => {
    const p = generatePuzzle(6, BOARD_STEPS, 777);
    expect(p.path.length).toBeGreaterThanOrEqual(2);
    expect(p.path[0]).toEqual(p.start);
    expect(p.path[p.path.length - 1]).toEqual(p.end);
    for (let i = 1; i < p.path.length; i++) {
      const a = p.path[i - 1];
      const b = p.path[i];
      const dr = Math.abs(a.r - b.r);
      const dc = Math.abs(a.c - b.c);
      expect((dr === 1 && dc === 2) || (dr === 2 && dc === 1)).toBe(true);
      expect(p.available[b.r][b.c]).toBe(true);
    }
    // No cell is visited twice (the path is its own coverage).
    const seen = new Set(p.path.map((c) => `${c.r}-${c.c}`));
    expect(seen.size).toBe(p.path.length);
  });

  test("DETERMINISM: same (n, steps, seed) yields identical available/start/end", () => {
    const a = generatePuzzle(BOARD_N, BOARD_STEPS, 12345);
    const b = generatePuzzle(BOARD_N, BOARD_STEPS, 12345);
    expect(availStr(a.available)).toBe(availStr(b.available));
    expect(a.start).toEqual(b.start);
    expect(a.end).toEqual(b.end);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("DETERMINISM: reproduces a KNOWN board for the C1 params (n=6, steps=18, seed=12345)", () => {
    const p = generatePuzzle(BOARD_N, BOARD_STEPS, 12345);
    expect(p.start).toEqual({ r: 5, c: 1 });
    expect(p.end).toEqual({ r: 4, c: 2 });
    expect(p.path.length).toBe(19);
    expect(availStr(p.available)).toBe("010010|001100|101101|001110|011111|010101");
  });

  test("different seeds generally yield different boards", () => {
    const a = generatePuzzle(BOARD_N, BOARD_STEPS, 1);
    const b = generatePuzzle(BOARD_N, BOARD_STEPS, 2);
    expect(availStr(a.available)).not.toBe(availStr(b.available));
  });

  test("the C1 params generate successfully across many seeds (no failures)", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const p = generatePuzzle(BOARD_N, BOARD_STEPS, seed);
      expect(p.path.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("legalMoves", () => {
  test("only returns playable, unvisited knight destinations", () => {
    const p = generatePuzzle(6, BOARD_STEPS, 99);
    const start = p.start;
    const moves = legalMoves(p, start, [start]);
    for (const m of moves) {
      expect(p.available[m.r][m.c]).toBe(true);
      expect(m).not.toEqual(start);
    }
    // The witness's second cell is a legal first move from the start.
    const second = p.path[1];
    expect(moves.some((m) => m.r === second.r && m.c === second.c)).toBe(true);
  });
});

describe("isWin (single-knight model; port-fidelity only, NOT wired into C1)", () => {
  test("the full witness path is a win; a prefix is not", () => {
    const p = generatePuzzle(6, BOARD_STEPS, 2024);
    expect(isWin(p, p.path)).toBe(true);
    const prefix: Cell[] = p.path.slice(0, p.path.length - 1);
    expect(isWin(p, prefix)).toBe(false);
  });
});
