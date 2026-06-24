# Knight Rendezvous

A co-op, two-player twist on [Knight's Puzzle](https://knight.nilmamano.com).

Two paired players each control a differently-colored knight on the same random
knight-puzzle board. Instead of one path from start to goal, the path is built
from **both ends at once** — and you win when the two knights **meet on the same
square**. Move freely, no turns.

- **Look & base logic:** ported from `knights-puzzle`.
- **Networking, pairing & deploy shape:** modeled on `round-trip-chess`
  (Bun + Hono WebSocket server, server-authoritative, fly.io single machine).

Built via a gated slice loop — see [`plans/knight-rendezvous-loop.md`](plans/knight-rendezvous-loop.md).

## Status
C4 done — each player has Retry (reset only your knight to its start) and Undo
(take back only your last move); neither touches the other knight, and both are
blocked once the game is won. Next: C5 (view solution to both + per-player hint).
