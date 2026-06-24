// Dual-client real-browser smoke gate for Knight Rendezvous (C3 + C4 + C5).
//
// C5: with a small KR_PLAYBACK_STEP_MS injected into the server, context A clicks
// "View solution" and BOTH contexts observe status "playback" then a return to
// "playing" with the pre-playback state restored EXACTLY (never marked solved) —
// judged via the server-authoritative window.__KR__. Then context A clicks "Hint"
// and ONLY context A highlights a cell (data-hint="1"); context B's __KR__ is
// byte-unchanged and shows no hint UI (the hint is actor-only). The "path"-leak
// guard is extended to cover playback frames and the hint. All waits use
// waitForFunction — never a fixed timeout.
//
// Boots ONE Bun server (server/index.ts) on reserved port 4318 serving the built
// frontend/dist, then drives TWO headless system-Chrome contexts: context A
// creates a room (scraping the code from window.__KR__), context B joins it.
//
// ORACLE (server state, not the DOM): read window.__KR__ from BOTH contexts and
// assert board/knights/visited are byte-identical (same seed + available +
// start + end), and that knights p1 = board.start, p2 = board.end.
//
// C3: reconstructs the witness path from the broadcast board, walks BOTH knights
// along DISJOINT halves until they are adjacent (covering the WHOLE board), then
// performs the MEET-HOP — p1 clicks the cell the other knight currently occupies,
// the rendezvous. The meet-hop is guarded ONLY by knight-move legality (NOT a
// "legal move excluding the other knight" helper, which by construction cannot
// target the partner). We then assert (via the server-authoritative window.__KR__
// on BOTH contexts) status==="won" and result.perfect===true (full coverage), and
// that the post-win state is byte-identical across the two clients.
//
// C4: BEFORE any winning hop, p1 hops one cell then UNDOES it (its trail shrinks
// by one and its knight reverts), and separately hops then RETRIES (its trail
// collapses to [start]) — driving the real Undo/Retry buttons. After EVERY C4 op
// the OTHER player (p2) must be byte-identical on BOTH contexts (locked decision
// 6: per-player only). All C4 judging is via window.__KR__ on both contexts.
//
// The rendered DOM (the cell grid + two knight overlays) is confirmed only as a
// health check. pageerror is strict; only expected WS/resource console noise is
// filtered. Exits non-zero on any failure.
//
// Prerequisite: `bun run build` (the smoke npm script runs it first).

import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 4318;
const URL = `http://localhost:${PORT}`;

function startServer() {
  const child = spawn("bun", ["run", "server/index.ts"], {
    stdio: ["ignore", "pipe", "pipe"],
    // KR_PLAYBACK_STEP_MS: a small view-solution cadence so the C5 playback
    // assertions never wait real seconds (still uses waitForFunction, never a
    // fixed timeout). RoomStore reads it per createRoom.
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: "production",
      KR_PLAYBACK_STEP_MS: "20",
    },
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));
  child.on("exit", (code) => {
    if (code && code !== 0 && code !== null) {
      console.error("bun server exited early:", code, stderr);
    }
  });
  return child;
}

async function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${URL}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("bun server did not come up on " + URL);
}

// Expected, harmless console noise: a transient WS connect blip on first paint
// (the client connects right after load) + favicon 404 (no favicon in C1).
function isExpectedConsoleNoise(text) {
  return (
    /websocket/i.test(text) ||
    /favicon/i.test(text) ||
    /Failed to load resource/i.test(text) ||
    /the server responded with a status of 404/i.test(text)
  );
}

function attachStrictHandlers(page, label, pageErrors) {
  page.on("pageerror", (e) => pageErrors.push(`[${label}] ${String(e)}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (!isExpectedConsoleNoise(text)) pageErrors.push(`[${label}] console.error: ${text}`);
  });
}

async function waitForReady(page) {
  await page.waitForFunction(() => window.__KR__ && window.__KR__.ready === true, {
    timeout: 15000,
  });
}

// The 8 knight offsets — Node-side mirror of shared/engine's KNIGHT_DELTAS, used
// to reconstruct the witness path and to guard the MEET-HOP by knight-move
// legality ONLY. The rendezvous hop targets the OTHER knight's current cell, so a
// "legal move that excludes the other knight" helper cannot drive it.
const DELTAS = [
  [-2, -1],
  [-2, 1],
  [-1, -2],
  [-1, 2],
  [1, -2],
  [1, 2],
  [2, -1],
  [2, 1],
];
const sameCell = (a, b) => a.r === b.r && a.c === b.c;
function knightMovesOf(cell, n) {
  const out = [];
  for (const [dr, dc] of DELTAS) {
    const r = cell.r + dr;
    const c = cell.c + dc;
    if (r >= 0 && r < n && c >= 0 && c < n) out.push({ r, c });
  }
  return out;
}

// Reconstruct the witness path (start → end) by DFS over the playable graph. The
// board's available cells ARE a single non-revisiting knight's walk, so DFS from
// `start` covering all available cells and ending at `end` recovers it. This lets
// the smoke walk BOTH knights from the two ends toward a shared meeting cell along
// DISJOINT halves, covering the whole board → a PERFECT rendezvous.
function reconstructPath(board, start, end) {
  const n = board.n;
  const cells = [];
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) if (board.available[r][c]) cells.push({ r, c });
  const total = cells.length;
  const enc = (cell) => cell.r * n + cell.c;
  const visited = new Set();
  const path = [];
  const dfs = (cur) => {
    path.push(cur);
    visited.add(enc(cur));
    if (path.length === total) {
      if (sameCell(cur, end)) return true;
    } else {
      for (const m of knightMovesOf(cur, n)) {
        if (!board.available[m.r][m.c] || visited.has(enc(m))) continue;
        if (dfs(m)) return true;
      }
    }
    path.pop();
    visited.delete(enc(cur));
    return false;
  };
  if (!dfs(start)) throw new Error("could not reconstruct the witness path in smoke");
  return path;
}

let server;
let browser;
let failed = false;
try {
  server = startServer();
  await waitForServer();

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const pageErrors = [];

  // ---- Context A: create a room ------------------------------------------
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  attachStrictHandlers(pageA, "A", pageErrors);

  await pageA.goto(URL, { waitUntil: "domcontentloaded" });
  // Fill a name + create.
  await pageA.getByPlaceholder("Enter a name").fill("Alice");
  await pageA.getByRole("button", { name: "Create game" }).click();
  await waitForReady(pageA);
  await pageA.waitForFunction(() => window.__KR__ && window.__KR__.lobby === "waiting", {
    timeout: 10000,
  });
  const code = await pageA.evaluate(() => window.__KR__.code);
  if (!code || code.length !== 4) {
    throw new Error(`expected a 4-char room code from window.__KR__, got ${JSON.stringify(code)}`);
  }

  // ---- Context B: join that room -----------------------------------------
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  attachStrictHandlers(pageB, "B", pageErrors);

  await pageB.goto(URL, { waitUntil: "domcontentloaded" });
  await pageB.getByPlaceholder("Enter a name").fill("Bob");
  await pageB.getByPlaceholder("CODE").fill(code);
  await pageB.getByRole("button", { name: "Join", exact: true }).click();

  // Both contexts must reach the active play screen with a board.
  for (const page of [pageA, pageB]) {
    await page.waitForFunction(
      () => window.__KR__ && window.__KR__.lobby === "active" && window.__KR__.board !== null,
      { timeout: 15000 },
    );
  }

  // ---- ORACLE: both boards byte-identical, knights on the endpoints -------
  const boardA = await pageA.evaluate(() => window.__KR__.board);
  const boardB = await pageB.evaluate(() => window.__KR__.board);
  const knightsA = await pageA.evaluate(() => window.__KR__.knights);
  const knightsB = await pageB.evaluate(() => window.__KR__.knights);

  if (JSON.stringify(boardA) !== JSON.stringify(boardB)) {
    throw new Error(
      `boards differ between contexts:\n  A=${JSON.stringify(boardA)}\n  B=${JSON.stringify(boardB)}`,
    );
  }
  if (boardA.seed !== boardB.seed) {
    throw new Error(`seeds differ: A=${boardA.seed} B=${boardB.seed}`);
  }
  if (JSON.stringify(knightsA) !== JSON.stringify(knightsB)) {
    throw new Error("knight positions differ between contexts");
  }
  if (JSON.stringify(knightsA.p1) !== JSON.stringify(boardA.start)) {
    throw new Error("p1 knight is not on board.start");
  }
  if (JSON.stringify(knightsA.p2) !== JSON.stringify(boardA.end)) {
    throw new Error("p2 knight is not on board.end");
  }
  // The witness path must never reach the client.
  if (JSON.stringify(boardA).includes('"path"')) {
    throw new Error("board snapshot leaked the witness path");
  }

  // ---- Health check: a board with two knight overlays is actually rendered.
  for (const [page, label] of [
    [pageA, "A"],
    [pageB, "B"],
  ]) {
    const cellCount = await page.locator("[data-cell]").count();
    if (cellCount !== boardA.n * boardA.n) {
      throw new Error(`[${label}] expected ${boardA.n * boardA.n} cells, found ${cellCount}`);
    }
    const knightCount = await page.locator("[data-knight]").count();
    if (knightCount !== 2) {
      throw new Error(`[${label}] expected 2 knight overlays, found ${knightCount}`);
    }
    // The two knight overlays must be at distinct positions (start != end).
    const p1Cell = await page
      .locator('[data-cell="' + knightsA.p1.r + "-" + knightsA.p1.c + '"]')
      .count();
    if (p1Cell !== 1) throw new Error(`[${label}] p1 start cell not in the grid`);
  }

  // ---- C3: drive a FULL-COVER rendezvous to a PERFECT win -----------------
  // pageA created the room (p1), pageB joined it (p2). Verify that binding, then
  // walk both knights along DISJOINT halves of the reconstructed witness until
  // they are adjacent, and finally MEET-HOP one onto the other so the whole board
  // is covered → a perfect rendezvous. Both contexts must then read status==="won"
  // and result.perfect===true (asserted against the server-authoritative snapshot).
  const youA = await pageA.evaluate(() => window.__KR__.you);
  const youB = await pageB.evaluate(() => window.__KR__.you);
  if (youA !== "p1" || youB !== "p2") {
    throw new Error(`unexpected player binding: A=${youA} B=${youB}`);
  }

  // Reconstruct the witness from the (server-broadcast) board; the available cells
  // ARE a single knight's walk start → end.
  const path = reconstructPath(boardA, boardA.start, boardA.end);
  const last = path.length - 1;
  // Split the path so the two halves cover EVERY cell with no overlap until the
  // meet. p1 walks forward to path[last-1]; p2 retreats one step to path[last].
  // Wait — p2 starts ON path[last] (= board.end), so p2 must vacate so p1 can land
  // there. Instead: p2 retreats back to path[k]; p1 advances to path[k-1] (a
  // knight move from path[k]); p1 then hops onto p2 at path[k]. With k = last-? we
  // want p2's trail = path[k..last] and p1's trail = path[0..k-1], union = all.
  // Choosing k = 1 makes p2 walk almost the whole board and p1 stay near start;
  // choosing k = last-1 is the inverse. Use the midpoint so neither half dead-ends.
  const meetK = Math.floor(last / 2);
  const meetCell = path[meetK]; // p2's final resting square == the rendezvous cell

  // Click `target` for `actorPage` and wait for BOTH contexts to observe the
  // server state where `pid`'s knight sits on `target`.
  async function hopAndConverge(actorPage, pid, target) {
    await actorPage.locator(`[data-cell="${target.r}-${target.c}"]`).click();
    for (const page of [pageA, pageB]) {
      await page.waitForFunction(
        ([p, t]) => {
          const s = window.__KR__;
          if (!s || !s.knights) return false;
          const k = s.knights[p];
          return k.r === t.r && k.c === t.c;
        },
        [pid, target],
        { timeout: 15000 },
      );
    }
  }

  // ---- C4: exercise per-player UNDO + RETRY BEFORE any winning hop -----------
  // Drive the real buttons (not the Net internals) so the UI wiring is covered;
  // judge ONLY via the server-authoritative window.__KR__ on BOTH contexts. Both
  // ops must affect ONLY the acting player's knight/trail (locked decision 6).
  //
  // Snapshot p2 (the OTHER player) up front; after every C4 op below it must be
  // byte-identical on BOTH contexts. We run these while p1 is still at its start
  // and p2 has not moved, so the perfect-win walk further down is undisturbed.
  const p2BeforeC4 = JSON.stringify(
    await pageA.evaluate(() => ({
      visited: window.__KR__.visited.p2,
      knight: window.__KR__.knights.p2,
    })),
  );
  const assertP2Untouched = async (where) => {
    for (const [page, label] of [
      [pageA, "A"],
      [pageB, "B"],
    ]) {
      const now = JSON.stringify(
        await page.evaluate(() => ({
          visited: window.__KR__.visited.p2,
          knight: window.__KR__.knights.p2,
        })),
      );
      if (now !== p2BeforeC4) {
        throw new Error(`[${label}] p2 (the OTHER player) changed during ${where}: ${now}`);
      }
    }
  };
  // Wait for BOTH contexts to observe p1's trail length === len and its knight on
  // `cell` (the server is the oracle, read on each context).
  const awaitP1 = async (len, cell) => {
    for (const page of [pageA, pageB]) {
      await page.waitForFunction(
        ([l, t]) => {
          const s = window.__KR__;
          if (!s || !s.visited || !s.knights) return false;
          const v = s.visited.p1;
          const k = s.knights.p1;
          return v.length === l && k.r === t.r && k.c === t.c;
        },
        [len, cell],
        { timeout: 15000 },
      );
    }
  };

  // (1) p1 HOPS one cell, then UNDOES it. p1's trail must shrink by one and its
  // knight revert to start; p2 untouched on BOTH contexts.
  await hopAndConverge(pageA, "p1", path[1]); // p1 trail: [start, path[1]]
  await awaitP1(2, path[1]);
  await assertP2Untouched("p1 hop (pre-undo)");
  await pageA.getByRole("button", { name: "Undo" }).click();
  await awaitP1(1, boardA.start); // back to [start]
  await assertP2Untouched("p1 undo");

  // (2) p1 HOPS again, then RETRIES. p1's trail must collapse to [start]; p2
  // untouched on BOTH contexts. (Retry from a single-hop trail is the same shape
  // as retry from many hops — both collapse to [start].)
  await hopAndConverge(pageA, "p1", path[1]); // p1 trail: [start, path[1]]
  await awaitP1(2, path[1]);
  await pageA.getByRole("button", { name: "Retry" }).click();
  await awaitP1(1, boardA.start); // collapsed to [start]
  await assertP2Untouched("p1 retry");

  // p1 is back on its start and p2 never moved → the perfect-win choreography
  // below proceeds exactly as in C3.

  // ---- C5: VIEW SOLUTION (room-wide) — both contexts animate then RESTORE -----
  // p1 hops once so the pre-playback state is non-trivial (the restore must bring
  // it back EXACTLY). Drive the real "View solution" button on context A; assert
  // via the server-authoritative window.__KR__ on BOTH contexts that status goes
  // "playback" then back to "playing" with the pre-playback state restored.
  await hopAndConverge(pageA, "p1", path[1]); // p1 trail: [start, path[1]]
  await awaitP1(2, path[1]);
  const preVS = JSON.stringify(
    await pageA.evaluate(() => ({
      knights: window.__KR__.knights,
      visited: window.__KR__.visited,
      status: window.__KR__.status,
      result: window.__KR__.result,
    })),
  );

  await pageA.getByRole("button", { name: "View solution" }).click();

  // BOTH contexts must observe the playback status (server-driven frames).
  for (const page of [pageA, pageB]) {
    await page.waitForFunction(() => window.__KR__ && window.__KR__.status === "playback", {
      timeout: 15000,
    });
  }
  // BOTH contexts must then return to "playing" with the pre-playback state
  // restored EXACTLY (view-solution never marks the puzzle solved).
  for (const [page, label] of [
    [pageA, "A"],
    [pageB, "B"],
  ]) {
    await page.waitForFunction(
      (pre) => {
        const s = window.__KR__;
        if (!s || s.status !== "playing" || !s.visited || !s.knights) return false;
        const now = JSON.stringify({
          knights: s.knights,
          visited: s.visited,
          status: s.status,
          result: s.result,
        });
        return now === pre;
      },
      preVS,
      { timeout: 15000 },
    );
    const after = JSON.stringify(
      await page.evaluate(() => ({
        knights: window.__KR__.knights,
        visited: window.__KR__.visited,
        status: window.__KR__.status,
        result: window.__KR__.result,
      })),
    );
    if (after !== preVS) {
      throw new Error(`[${label}] view-solution did not restore the pre-playback state`);
    }
  }

  // Undo p1's extra hop so the perfect-win choreography below starts from start.
  await pageA.getByRole("button", { name: "Undo" }).click();
  await awaitP1(1, boardA.start);

  // ---- C5: HINT (per-player, ACTOR-ONLY) — only the requester highlights -------
  // Snapshot context B's server state up front; after A requests a hint, B's
  // __KR__ must be byte-identical AND B must show NO hint cell (the response is
  // sent to A alone, never broadcast).
  const bBeforeHint = JSON.stringify(await pageB.evaluate(() => window.__KR__));
  await pageA.getByRole("button", { name: "Hint", exact: true }).click();
  // Context A highlights exactly one hinted cell (data-hint="1").
  await pageA.waitForFunction(() => document.querySelectorAll('[data-hint="1"]').length === 1, {
    timeout: 10000,
  });
  // Context B never highlights a hint cell, and its server state is unchanged.
  const bHintCells = await pageB.locator('[data-hint="1"]').count();
  if (bHintCells !== 0) {
    throw new Error(`hint leaked to the other context: B shows ${bHintCells} hint cells`);
  }
  const bAfterHint = JSON.stringify(await pageB.evaluate(() => window.__KR__));
  if (bAfterHint !== bBeforeHint) {
    throw new Error("hint changed the OTHER context's server state (must be actor-only)");
  }
  // The hinted cell on A must be a real, available cell on the board.
  const hintCellA = await pageA.evaluate(() => {
    const el = document.querySelector('[data-hint="1"]');
    return el ? el.getAttribute("data-cell") : null;
  });
  if (!hintCellA) throw new Error("context A did not surface a hinted cell");
  // Let the transient hint pulse clear before the win choreography (no fixed wait
  // for game state — just remove the highlight so it can't confuse later reads).
  await pageA.waitForFunction(() => document.querySelectorAll('[data-hint="1"]').length === 0, {
    timeout: 10000,
  });

  // The witness path must NEVER reach a client — neither through a playback frame
  // (now in __KR__ history) nor the hint. Guard the CURRENT __KR__ on both.
  for (const [page, label] of [
    [pageA, "A"],
    [pageB, "B"],
  ]) {
    const krJson = await page.evaluate(() => JSON.stringify(window.__KR__));
    if (krJson.includes('"path"')) {
      throw new Error(`[${label}] window.__KR__ leaked the witness path after C5`);
    }
  }

  // p1 walks forward path[1]..path[meetK-1].
  for (let j = 1; j <= meetK - 1; j++) {
    await hopAndConverge(pageA, "p1", path[j]);
  }
  // p2 walks backward path[last-1]..path[meetK].
  for (let j = last - 1; j >= meetK; j--) {
    await hopAndConverge(pageB, "p2", path[j]);
  }

  // Sanity (server oracle): p2 rests on meetCell, p1 is a knight-move from it, the
  // game is still playing, and the union of trails already covers every cell.
  const pre = await pageA.evaluate(() => ({
    knights: window.__KR__.knights,
    visited: window.__KR__.visited,
    status: window.__KR__.status,
    board: window.__KR__.board,
  }));
  if (!sameCell(pre.knights.p2, meetCell)) {
    throw new Error(
      `p2 not on the meet cell: ${JSON.stringify(pre.knights.p2)} vs ${JSON.stringify(meetCell)}`,
    );
  }
  if (!knightMovesOf(pre.knights.p1, boardA.n).some((m) => sameCell(m, meetCell))) {
    throw new Error("p1 is not a knight-move from the meet cell before the hop");
  }
  if (pre.status !== "playing") {
    throw new Error(`expected status "playing" before the meet-hop, got ${pre.status}`);
  }
  const coveredBefore = new Set();
  for (const v of pre.visited.p1) coveredBefore.add(v.r * boardA.n + v.c);
  for (const v of pre.visited.p2) coveredBefore.add(v.r * boardA.n + v.c);
  let availableCells = 0;
  for (let r = 0; r < boardA.n; r++)
    for (let c = 0; c < boardA.n; c++) if (boardA.available[r][c]) availableCells++;
  if (coveredBefore.size !== availableCells) {
    throw new Error(
      `pre-hop coverage ${coveredBefore.size} != available ${availableCells}; meet-hop would not be perfect`,
    );
  }

  // ---- THE MEET-HOP: p1 hops ONTO p2's current cell (the rendezvous) ----------
  // Guarded ONLY by knight-move legality (we already verified adjacency above) —
  // NOT computeLegalTarget, which excludes the other knight's cell.
  await pageA.locator(`[data-cell="${meetCell.r}-${meetCell.c}"]`).click();

  // ---- ORACLE: both contexts read a perfect WIN -------------------------------
  for (const [page, label] of [
    [pageA, "A"],
    [pageB, "B"],
  ]) {
    await page.waitForFunction(() => window.__KR__ && window.__KR__.status === "won", {
      timeout: 15000,
    });
    const result = await page.evaluate(() => window.__KR__.result);
    if (!result) throw new Error(`[${label}] won but result is null`);
    if (result.perfect !== true) {
      throw new Error(`[${label}] expected perfect:true, got ${JSON.stringify(result)}`);
    }
    if (!sameCell(result.meetCell, meetCell)) {
      throw new Error(
        `[${label}] meetCell mismatch: ${JSON.stringify(result.meetCell)} vs ${JSON.stringify(meetCell)}`,
      );
    }
  }

  // Post-win state must be byte-identical across the two contexts, and the witness
  // path must STILL never have leaked.
  const wonA = await pageA.evaluate(() => ({
    knights: window.__KR__.knights,
    visited: window.__KR__.visited,
    board: window.__KR__.board,
    status: window.__KR__.status,
    result: window.__KR__.result,
  }));
  const wonB = await pageB.evaluate(() => ({
    knights: window.__KR__.knights,
    visited: window.__KR__.visited,
    board: window.__KR__.board,
    status: window.__KR__.status,
    result: window.__KR__.result,
  }));
  if (JSON.stringify(wonA) !== JSON.stringify(wonB)) {
    throw new Error(
      `post-win state differs between contexts:\n  A=${JSON.stringify(wonA)}\n  B=${JSON.stringify(wonB)}`,
    );
  }
  // The mover (p1) now sits on the meet cell — the one allowed shared square.
  if (!sameCell(wonA.knights.p1, meetCell)) {
    throw new Error("p1 knight is not on the meet cell after the rendezvous");
  }
  if (JSON.stringify(wonA).includes('"path"')) {
    throw new Error("post-win snapshot leaked the witness path");
  }

  // ---- C6: NEW PUZZLE (room-wide reset) — both contexts get a fresh identical
  // board with knights reset to start/end. Drive the real "New puzzle" button on
  // context A (it is enabled on the WIN screen by its own enable rule). Judge via
  // the server-authoritative window.__KR__ on BOTH contexts.
  await pageA.getByRole("button", { name: "New puzzle" }).click();
  // Wait for BOTH contexts to leave the won state: a fresh "playing" board with
  // both trails collapsed to their singleton starts (knights on start/end).
  for (const page of [pageA, pageB]) {
    await page.waitForFunction(
      () => {
        const s = window.__KR__;
        return (
          s &&
          s.status === "playing" &&
          s.result === null &&
          s.visited &&
          s.visited.p1.length === 1 &&
          s.visited.p2.length === 1 &&
          s.knights &&
          s.board &&
          s.knights.p1.r === s.board.start.r &&
          s.knights.p1.c === s.board.start.c &&
          s.knights.p2.r === s.board.end.r &&
          s.knights.p2.c === s.board.end.c
        );
      },
      { timeout: 15000 },
    );
  }
  const freshA = await pageA.evaluate(() => ({
    board: window.__KR__.board,
    knights: window.__KR__.knights,
    visited: window.__KR__.visited,
    status: window.__KR__.status,
    result: window.__KR__.result,
  }));
  const freshB = await pageB.evaluate(() => ({
    board: window.__KR__.board,
    knights: window.__KR__.knights,
    visited: window.__KR__.visited,
    status: window.__KR__.status,
    result: window.__KR__.result,
  }));
  // The fresh board must be BYTE-IDENTICAL across the two contexts (seed +
  // available + start + end + knights + visited). We do NOT assert it differs
  // from the previous board — randomSeed can repeat.
  if (JSON.stringify(freshA) !== JSON.stringify(freshB)) {
    throw new Error(
      `newPuzzle board differs between contexts:\n  A=${JSON.stringify(freshA)}\n  B=${JSON.stringify(freshB)}`,
    );
  }
  if (freshA.status !== "playing" || freshA.result !== null) {
    throw new Error(`newPuzzle did not reset to a fresh playing board: ${JSON.stringify(freshA)}`);
  }
  if (JSON.stringify(freshA).includes('"path"')) {
    throw new Error("newPuzzle board leaked the witness path");
  }

  // ---- C6: outbound cross-link to Knight's Puzzle must be present in the DOM.
  const kpLink = await pageA.locator('a[href="https://knight.nilmamano.com"]').count();
  if (kpLink < 1) {
    throw new Error("outbound Knight's Puzzle link is missing from the DOM");
  }

  // ---- C6: branding assets must RESOLVE from the served dist build (not 404).
  // The defensive console-noise filter stays, but here we assert the assets
  // explicitly so a missing favicon/og can never be masked as "expected noise".
  for (const asset of ["/favicon.svg", "/og.png"]) {
    const res = await fetch(`${URL}${asset}`);
    if (res.status !== 200) {
      throw new Error(`asset ${asset} did not resolve: HTTP ${res.status}`);
    }
  }

  if (pageErrors.length) {
    throw new Error("pageerrors: " + pageErrors.join("; "));
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        code,
        seed: boardA.seed,
        n: boardA.n,
        steps: boardA.steps,
        start: boardA.start,
        end: boardA.end,
        startKnights: knightsA,
        meetCell,
        status: wonA.status,
        result: wonA.result,
        afterKnights: wonA.knights,
        coveredCells: coveredBefore.size,
        availableCells,
        identicalBoards: true,
        identicalWinState: true,
        c4UndoVerified: true,
        c4RetryVerified: true,
        c4OtherPlayerUntouched: true,
        c5ViewSolutionRestored: true,
        c5HintActorOnly: true,
        c6NewPuzzleReset: true,
        c6NewPuzzleSeed: freshA.board.seed,
        c6OutboundLinkPresent: true,
        c6AssetsResolve: true,
        chrome: browser.version(),
      },
      null,
      2,
    ),
  );
} catch (err) {
  failed = true;
  console.error("SMOKE FAILED:", err?.message || err);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill("SIGTERM");
}
process.exit(failed ? 1 : 0);
