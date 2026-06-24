// Centralized tunables. Browser-safe: constants only, no I/O, no imports that
// touch Bun/server. Imported by both the server and the frontend, so it is the
// single source of truth for room + puzzle parameters.

// ---------------------------------------------------------------------------
// Room / pairing tunables (mirrored from round-trip-chess).
// ---------------------------------------------------------------------------

// How long a room is kept alive after a player drops, so they can rejoin by code.
export const RECONNECT_GRACE_MS = 30000;

// Room code: short, unambiguous, uppercase, no look-alike characters.
export const CODE_LENGTH = 4;
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// Per-player reconnect token.
export const TOKEN_LENGTH = 24;
export const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// Display name guardrails.
export const MAX_NAME_LENGTH = 20;

// ---------------------------------------------------------------------------
// Fixed puzzle parameters for C1.
//
// generatePuzzle(BOARD_N, BOARD_STEPS, seed) with these values was verified to
// succeed for every seed in [1, 2000] (0 failures, always 19 playable cells),
// and to be fully deterministic. n=6 is a comfortable co-op board size; steps=18
// fills it densely (the walk clamps to whatever a real knight tour can reach).
// ---------------------------------------------------------------------------

export const BOARD_N = 6;
export const BOARD_STEPS = 18;

// ---------------------------------------------------------------------------
// Player-adjustable board-size + path-length bounds (ported from
// knights-puzzle/src/difficulty.ts). BOARD_N/BOARD_STEPS above stay the
// defaults for the FIRST board; the play-screen sliders let players pick any
// n in [MIN_N, MAX_N] and steps in [MIN_STEPS, maxSteps(n)] for a fresh puzzle.
// The server CLAMPS every requested value via clampN/clampSteps before it
// generates — the client is never trusted with the range.
// ---------------------------------------------------------------------------

export const MIN_N = 4;
export const MAX_N = 9;
export const MIN_STEPS = 3;

/** Largest legal path length (knight moves) on an n×n board. */
export function maxSteps(n: number): number {
  return n * n - 1;
}

/** Clamp board size into [MIN_N, MAX_N]. */
export function clampN(n: number): number {
  if (n < MIN_N) return MIN_N;
  if (n > MAX_N) return MAX_N;
  return n;
}

/** Clamp path length into [MIN_STEPS, maxSteps(n)]. Assumes n is already clamped. */
export function clampSteps(n: number, steps: number): number {
  const hi = maxSteps(n);
  if (steps < MIN_STEPS) return MIN_STEPS;
  if (steps > hi) return hi;
  return steps;
}

// ---------------------------------------------------------------------------
// View-solution playback cadence (C5, locked decision 7).
//
// The default per-frame interval the Room uses to drive view-solution playback.
// A normal, watchable pace. Tests and the smoke gate inject a SMALL value (via
// the Game/Room stepMs seam) so they assert on the frame SEQUENCE without
// waiting real seconds. Mirrors knights-puzzle's STEP_MS playback cadence.
// ---------------------------------------------------------------------------

export const PLAYBACK_STEP_MS = 280;

// ---------------------------------------------------------------------------
// View-solution FINAL-FRAME hold (locked decision 7).
//
// After the requester's knight walks the full solution path and lands co-located
// with the (frozen) partner, the Room HOLDS that final frame for this long before
// restoring the pre-playback state — so the player sees the two knights huddled
// at the rendezvous. Tests inject "0" (no real wait); smoke a small value; the
// production default is ~2s. Threaded through the Game/Room like PLAYBACK_STEP_MS.
// ---------------------------------------------------------------------------

export const PLAYBACK_HOLD_MS = 2000;
