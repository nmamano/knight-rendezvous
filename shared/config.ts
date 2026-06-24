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
