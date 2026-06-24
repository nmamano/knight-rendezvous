// Difficulty analysis — pure, no DOM/React/Node/Bun, browser-safe.
//
// Ported from knights-puzzle/src/analysis.ts (the `branchingProfile` +
// `difficultyScore` half; the single-player `hint` there is NOT ported — KR's
// witness hint lives server-side in game.ts). Difficulty is measured from the
// generator's WITNESS path (`puzzle.path`), which exists by construction — there
// is deliberately NO solver. We walk the witness and, at each step, count how
// many legal knight moves were available (the player's apparent choices). The
// product of the genuine branch points (steps with >= 2 options) is the
// difficulty score.
//
// In Knight Rendezvous `puzzle.path` is SERVER-ONLY (it never goes on the wire).
// So these functions run on the SERVER (in Game) over its own Puzzle, and only
// the resulting difficulty NUMBER is projected onto the Board snapshot — the raw
// `path` is never sent.

import { legalMoves, type Puzzle } from "./engine";

/**
 * Per-move apparent-choice counts along the witness path.
 *
 * For each step `i` (0 .. path.length - 2): the number of legal knight moves
 * from `path[i]` given that `path[0..i]` have already been visited. That count
 * always includes the correct next cell `path[i+1]`, plus any other playable,
 * not-yet-visited knight-neighbour. The result has `path.length - 1` entries
 * (one per move); a single-cell path yields `[]`.
 *
 * EXCEPTION (the goal is not a real branch): landing on the GOAL square before
 * the final move ENDS the run early (an exit, not a genuine choice toward the
 * solution), so it does NOT count toward the branching factor. On the final move
 * — where reaching the goal IS the correct play — it counts normally.
 *
 * Pure: reads the puzzle only, never mutates it or its `path`.
 */
export function branchingProfile(puzzle: Puzzle): number[] {
  const path = puzzle.path;
  const end = path[path.length - 1];
  const profile: number[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    // visited = path[0..i] (includes path[i]); the correct next cell path[i+1]
    // is therefore NOT excluded, but every already-walked cell is.
    const options = legalMoves(puzzle, path[i], path.slice(0, i + 1));
    const next = path[i + 1];
    const finalMove = next.r === end.r && next.c === end.c;
    let count = options.length;
    // Drop the goal as an early-exit option on any non-final move.
    if (!finalMove && options.some((m) => m.r === end.r && m.c === end.c)) {
      count -= 1;
    }
    profile.push(count);
  }
  return profile;
}

/**
 * Difficulty score = the product of the apparent-choice counts at every genuine
 * branch point (>= 2 options) along the witness path. Steps with a single
 * forced option contribute a factor of 1; a fully forced path scores 1.
 *
 * NOTE: for long, branchy paths this can exceed `Number.MAX_SAFE_INTEGER`. That
 * is acceptable for ranking — the value stays finite and ordering stays sensible.
 */
export function difficultyScore(puzzle: Puzzle): number {
  let product = 1;
  for (const count of branchingProfile(puzzle)) {
    if (count >= 2) product *= count;
  }
  return product;
}
