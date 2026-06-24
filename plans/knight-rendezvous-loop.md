# Knight Rendezvous loop — standing orders + slice handoffs

> **Re-read this entire file at the start of every iteration.** Conversations
> compact; this file does not. It is the loop's memory and the single source of
> truth for what we agreed.

---

## North star
A deployed, cutesy co-op web game where two paired players each drive one
**differently-colored knight** on an **identical random knight-puzzle board**, and
**win when one knight hops onto the square occupied by the other knight** (the
"rendezvous"). Same look + base logic as `knights-puzzle`; same pairing/deploy
shape as `round-trip-chess`. Not turn-based — both move freely and independently.

What must NOT be diluted: the knight-puzzle look & feel; server-authoritative
sync (the server is the only oracle); the rendezvous = **same square** win; pairing
straight into the random-puzzle screen with no levels and no local storage.

---

## Locked design decisions (do NOT relitigate inside the loop)
1. **Win = the two knights occupy the SAME square.** The final hop *onto the
   partner's current square* is the one allowed exception to no-reuse. Equivalent
   of the original knight stepping into the goal.
   - **Soft win** = rendezvous achieved.
   - **Perfect win** = rendezvous AND every playable square covered by ≥1 trail.
2. **No square reuse:** a knight may not move onto any square already visited by
   *either* knight, nor onto the other knight's current square — EXCEPT the
   rendezvous hop in (1).
3. **Two knights, distinct colors** (knight + trail colors distinct per player).
   P1 starts on `start`, P2 starts on `end`.
4. **Not turn-based.** Either player may move their own knight at any time. Server
   orders concurrent moves: first valid wins, the loser gets an `illegal` error.
5. **Pairing drops both players directly into the random-puzzle play screen.**
   No catalog, no levels, no localStorage. Server picks the random seed and
   broadcasts it so both clients render the identical board.
6. **Retry** resets only the requesting player's knight to its start (frees its
   trail). **Undo** pops only the requesting player's last move. Neither touches
   the other knight.
7. **View solution**: triggered by one player, plays on BOTH clients (both knights
   animate along the witness toward the meeting square); inputs locked during
   playback; never marks the puzzle solved. **Hint**: per-player, witness-only
   (points the requesting player's own knight to its next witness cell).
8. **Name = "Knight Rendezvous".** Repo at `~/nil/knight-rendezvous`.
9. **Deploy shape = fly.io (like chess), NOT static Vercel** — the live WebSocket
   server cannot be serverless. Single machine, in-memory state.

---

## Process per slice
```
plan  →  [subagent PLAN-GATE]  →  implement  →  always-run gates  →
[heavier gate if UI/integration touched]  →  [subagent DIFF-GATE]  →
sign-off  →  ONE focused commit (tick the slice checkbox in the same commit)
```
- **Review is done by SPAWNED SUBAGENTS, not an external agent.**
  - **Plan-gate subagent** (read-only `Explore`/`Plan` type): given the slice goal +
    intended approach, returns approve / change-requests *before* implementation.
  - **Diff-gate subagent**: given the actual diff + gate results, returns
    approve / blocking-findings *before* commit. Commit only on approve.
- One slice at a time. **Never start slice N+1 before slice N is committed.**
- A bug a gate catches gets a regression test at the right layer in the SAME slice.
- A gate failure is fixed in-slice OR becomes a queued decision — gates are NEVER
  weakened to pass.

---

## Gates per slice (exact commands)

**Always-run (cheap, deterministic, NO network / NO keys / NO quota):**
```
bun run format:check
bun run lint
bun run typecheck
bun test tests/        # unit engine + real-WebSocket integration on EPHEMERAL ports
bun run build
# convenience: bun run ci  == all of the above
```

**Heavier — run on any slice that touches UI, networking, or game flow
(still free + local, no quota):**
```
bun run smoke          # dual-client Playwright: 2 browser contexts, ONE local
                       # server, both knights move -> rendezvous -> win.
                       # Oracle = SERVER STATE SURFACE, not the DOM.
```

**Human-gated / credentialed (C7 only — NEVER run inside the loop):**
```
fly deploy / GitHub Action deploy   # runs as Nil
gh repo create                      # runs as Nil
DNS / custom subdomain changes      # runs as Nil
```

### Gate discipline (baked into the scripts)
- **Judge via the evidence surface, not the UI.** Server-authoritative
  `RoomSnapshot` (and a `/health` / debug-state read) is the oracle. The DOM /
  `window.__KR__` only confirms the client stayed healthy. Screenshots are
  artifacts, never assertions.
- **Isolation:** every test/smoke instance gets its own port + `/tmp` state dir.
  Reserved ports: **smoke server = 4318**, **spare = 4319**. Integration tests use
  ephemeral (port 0). NEVER reuse a live instance's port. (knights-puzzle smoke
  uses 4317 — do not collide.)
- **Playwright discipline:** assert against FRESH server reads, not hardcoded
  values; `innerText` reflects CSS text-transform (compare case-insensitively);
  clicks race re-renders (click-and-verify with retries); filter expected
  resource-error console noise, keep `pageerror` strict.
- **No quota anywhere** in this project — there are no paid APIs / LLM calls, so
  there are no quota-gated scripts. Default `bun test` burns nothing.

---

## Standing rails (Phase-1 prohibitions, verbatim)
1. **NEVER** run `fly deploy`, create a GitHub remote, push, or change DNS inside
   the loop — those are human-gated (C7), and run as Nil.
2. **NEVER** touch the live `knights-puzzle` or `round-trip-chess` deployments or
   their state. The knight back-link edit is its own reviewed commit in C7, not
   mid-loop.
3. **NEVER** judge a slice by what a browser pane / DOM shows — the server state
   surface and structured logs are the oracle.
4. **NEVER** weaken a gate to make it pass; fix in-slice or queue it.
5. Every test instance gets its own ephemeral port + `/tmp` state dir; never reuse
   a live port.
6. **One slice in flight**; commit (with its checkbox ticked) before starting the
   next.
7. Commit ONLY this repo's own changes; do not push.

---

## Slice plan
- [x] **C1 — Pair + identical board, two knights, no movement.** fly-shaped
  monorepo scaffold (`server/ shared/ frontend/`), knight engine ported into
  `shared/`, Hono WS create/join/reconnect + share link, server generates a random
  puzzle (seed) and broadcasts the SAME board; both browsers render the grass/hedge
  board with P1 knight on `start`, P2 knight on `end` (distinct colors). Baseline
  gates green. *(Tracer through net + render + theme.)*
- [ ] **C2 — Independent live movement + sync.** Each player hops their own knight
  (not turn-based); server validates (legal knight move, target unvisited by
  either, belongs to that player) + broadcasts; both clients see both trails.
- [ ] **C3 — Win/meet detection.** Shared-engine rendezvous logic (same-square per
  locked decision 1); soft vs perfect; win panel on both clients.
- [ ] **C4 — Retry + Undo (per-player).** Per locked decision 6.
- [ ] **C5 — View solution (both) + Hint (per-player).** Per locked decision 7.
- [ ] **C6 — Polish + cross-links + meta.** Name applied, OG/favicon, "new random
  puzzle" button, opponent-left/reconnect UX, mobile, link to/from knights-puzzle.
- [ ] **C7 (optional, human-gated) — Deploy.** Finalize Dockerfile/fly.toml, create
  GitHub repo, deploy, custom subdomain, add back-link into knights-puzzle repo +
  redeploy. All credentialed steps run as Nil.

---

## Deferred / parked
**Do-not-pick-up inside the loop:**
- Actual deployment, GitHub repo creation, DNS — all C7, human-triggered.
- Editing the live knights-puzzle repo (the back-link) — C7.

**Queued human-only decisions (`parked-for-Nil`):**
- **G2 — final subdomain:** `knight-rendezvous.fly.dev` only, or a custom
  `<something>.nilmamano.com` CNAME → fly? (Confirm at C7.)
- **C7 deploy mechanism:** GitHub Action + `FLY_API_TOKEN` secret (like chess), or
  install flyctl locally? (flyctl is NOT installed on this box.)

---

## Resources
**Reference repos (READ for patterns; do NOT modify until C7):**
- `~/nil/knights-puzzle` — look & base logic.
  - `src/engine/index.ts` — `Puzzle = {n, available[][], start, end, path, seed}`,
    `generatePuzzle`, `knightMoves`, `legalMoves`, `isWin`. Pure + deterministic
    (mulberry32 seed). Port this into `shared/`.
  - `src/game.ts` — `GameState = {puzzle, knight, visited[], won}`, `tryMove`,
    `undoMove`, `resetGame`. Adapt to two knights.
  - `src/analysis.ts` — witness-only `hint`. `src/App.tsx` — solution playback
    (`handleViewSolution`), evidence surface `window.__KP__`.
  - `src/index.css` — theme: `--grass:#97d36d --hedge:#38492f --path:#e8c892
    --accent:#6c5cff --ink:#2b2640`, font "Patrick Hand". Board = CSS grid +
    SVG trail + DOM knight overlay.
  - `scripts/smoke.mjs` — Playwright smoke pattern (reserved port 4317).
- `~/nil/round-trip-chess` — networking + pairing + deploy.
  - `shared/protocol.ts` — `ClientMsg`/`ServerMsg`/`RoomSnapshot`. Adapt: drop
    turn-based, add per-knight move with player ownership.
  - `server/index.ts` (Hono + WS `/ws` + static SPA + `/health`),
    `server/rooms.ts` (4-char nanoid codes, slots, 30s reconnect grace, broadcast),
    `server/match.ts` (authoritative state — replace chess rules with knight
    rendezvous), `server/socket.ts` (dispatch + validation).
  - `frontend/src/net/socket.ts` (auto-reconnect client), `components/Lobby.tsx`,
    `Waiting.tsx` (`/?room=CODE` share link), `Game.tsx`.
  - `tests/integration.test.ts` — real-WS-on-ephemeral-port pattern (copy it).
  - `Dockerfile`, `fly.toml` (single machine, `min_machines_running=1`),
    `.github/workflows/fly-deploy.yml`.

**Evidence surfaces (the oracles):**
- Server `RoomSnapshot` broadcast + `/health` (+ add a debug state read if needed).
- Client `window.__KR__` mirroring the snapshot (for smoke health checks only —
  NOT for assertions; assert against the server).

**House patterns:** Bun monorepo; pure logic in `shared/` (no I/O, browser-safe);
server-authoritative, no optimistic UI; `bun run ci` is the always-run bundle.

**Verified tooling (Phase 2, this box):** Bun 1.3.11, Node 24.14.0, Playwright
1.61.0, Chrome 145.0.7632.159 (`channel:"chrome"` headless dual-context OK), gh
2.45.0. flyctl NOT installed. Reference suites green: knights-puzzle 95/95,
round-trip-chess 111/111 (incl. real-WS integration).

---

## SLICE-1 PICKUP (C1) — authored now
- **Baseline:** HEAD at loop start = the commit that adds this file
  (`git rev-parse HEAD`).
- **Goal:** thinnest end-to-end tracer — two browsers pair via a room code and BOTH
  render the identical random knight-puzzle board in the knights-puzzle theme, with
  P1's knight on `start` and P2's knight on `end` in distinct colors. No movement
  logic yet (or trivial no-op).
- **Load-bearing mechanics / traps:**
  - Keep `shared/` pure and browser-safe (no Node imports) so the engine is
    reused by both server and frontend, exactly like chess's `shared/`.
  - Server generates ONE seed per room and broadcasts it; both clients call the
    SAME `generatePuzzle(n, steps, seed)` → identical boards. Determinism is the
    whole trick.
  - Copy chess's room/slot/reconnect machinery wholesale; only the payload
    (`RoomSnapshot`) changes — carry the puzzle seed + both knight positions.
  - Establish the green baseline: `package.json` scripts (`format:check`, `lint`,
    `typecheck`, `test`, `build`, `ci`, `smoke`), tsconfig(s), eslint, prettier,
    Vite + React + Tailwind frontend, Hono server. Mirror chess's layout.
  - Reserve smoke port 4318; integration tests use ephemeral ports.
- **Acceptance criteria:**
  - All always-run gates green from a clean checkout.
  - One integration test: two WS clients create+join a room and both receive a
    snapshot carrying the SAME seed + the two knight start positions.
  - `bun run smoke`: two browser contexts on one local server both show a rendered
    board with two knights at start/end (health via `window.__KR__`/server, NOT a
    DOM assertion on game logic).
- **Decide-with-(diff-gate)-subagent:** protocol shape (`RoomSnapshot` fields for
  the co-op puzzle), file/module layout of `shared/`.
- **Locked (don't relitigate):** locked decisions 1–9 above.
- **Resources:** see Resources section; clone chess scaffold + port knight engine.

## SLICE-2 PICKUP (C2 — independent live movement + sync) — authored after C1
- **Baseline commit:** `054639f` (C1).
- **What C1 taught (fold in):**
  - Server is the sole oracle; `server/game.ts` `board()`/`snapshot()` hand-builds
    the projection and OMITS `path`. Keep extending that projection — never leak
    `path`; the integration + smoke `"path"`-substring guards must stay green.
  - `Game` already holds `visited: { p1:[start], p2:[end] }` — build movement on it.
  - **No-reuse spans BOTH knights** (locked #2): a target must be unvisited by
    EITHER knight and not the other knight's current square (the rendezvous hop is
    C3 — for C2, reject landing on the other knight).
  - **Not turn-based** (locked #4): the room is single-threaded, so natural message
    ordering gives "first valid wins"; the later concurrent move that's now illegal
    just gets an error. C1's `socket.ts` has NO move message / per-action error code
    yet — C2 adds them.
  - Frontend: `data-cell="${r}-${c}"` and `data-knight` exist in Board.tsx;
    `window.__KR__` is FLAT (spreads the snapshot, e.g. `__KR__.board`). No
    optimistic UI — render only on server `state` (chess pattern).
  - Board params locked `n=6, steps=18` (config.ts); the known-board engine test
    pins seed 12345 → start{5,1}/end{4,2}/19 cells — don't break it.
  - `colorOf` is duplicated (module fn + `Game.colorOf` + `Room.colorOf`) — consider
    collapsing this slice.
- **Goal:** each player hops their OWN knight to a legal knight-move square (not
  turn-based); server validates + updates authoritative state + broadcasts; both
  clients see both knights move and both trails render. NO win/rendezvous yet (C3).
- **Load-bearing mechanics / traps:**
  - Add `ClientMsg` `move{ cell: Cell }`; infer the player from their bound slot
    (like chess infers pid from the connection). Server validates: it is that
    player's knight; `cell` is a legal knight move from that knight's current cell;
    `cell` is `available`; `cell` is NOT in `union(visited.p1, visited.p2)`; `cell`
    is NOT the other knight's current square. On success: push current→visited, move
    the knight, broadcast.
  - Add `ErrorCode` `illegal_move`. Stale-socket guard stays (act only if
    `slot.conn === conn`).
  - Extend `RoomSnapshot` to carry trails: `visited: { p1: Cell[]; p2: Cell[] }`.
    Keep `path` server-side.
  - Frontend: clickable cells → send `move`; render each player's trail in its color
    (amber/violet) — port knights-puzzle's SVG polyline trail or a simple themed
    cell tint. Legal-move highlight (from shared `legalMoves`) is a nice-to-have.
- **Acceptance criteria:**
  - Always-run gates green.
  - Integration test: each client moves its own knight several legal hops; both
    snapshots reflect both trails identically; illegal moves rejected (wrong owner,
    non-knight-move, onto a visited cell, onto the other knight, off-board/blocked);
    two concurrent moves to the same target → exactly one wins, the other errors.
  - Dual-client smoke: both contexts perform a legal hop; assert via server /
    `window.__KR__` that both knights + trails advanced identically on both clients.
- **Decide-with-(diff-gate)-subagent:** exact snapshot shape for trails; whether to
  compute client-side legal-move highlights from the shared engine.
- **Locked (don't relitigate):** decisions 1–9, especially #2 (no-reuse spans both)
  and #4 (not turn-based, first-valid-wins). **Rendezvous / same-square win is C3 —
  do NOT implement win in C2.**
- **Resources:** `shared/engine.ts` `legalMoves`; `server/game.ts` (add `move()`);
  `round-trip-chess/server/rooms.ts` `Room.move` + broadcast pattern (mirror it,
  minus turn ownership); chess `frontend/.../Game.tsx` for click→move handling shape.

## SLICE-N PICKUP — authored when N-1 commits
> Author each next handoff only AFTER the previous one commits, folding in a
> "what slice N-1 taught" block at the top. That is where workflow knowledge
> compounds.

---

## Completion note
_(filled in when the loop finishes: slice → commit → what landed, plus the
parked-for-Nil queue.)_
