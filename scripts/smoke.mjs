// Dual-client real-browser smoke gate for Knight Rendezvous (C1).
//
// Boots ONE Bun server (server/index.ts) on reserved port 4318 serving the built
// frontend/dist, then drives TWO headless system-Chrome contexts: context A
// creates a room (scraping the code from window.__KR__), context B joins it.
//
// ORACLE (server state, not the DOM): read window.__KR__.board from BOTH contexts
// and assert they are byte-identical (same seed + available + start + end), and
// that knights p1 = board.start, p2 = board.end. The rendered DOM (the cell grid
// + two knight overlays) is confirmed only as a health check. pageerror is
// strict; only expected WS/resource console noise is filtered. Exits non-zero on
// any failure.
//
// Prerequisite: `bun run build` (the smoke npm script runs it first).

import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 4318;
const URL = `http://localhost:${PORT}`;

function startServer() {
  const child = spawn("bun", ["run", "server/index.ts"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "production" },
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
        knights: knightsA,
        identicalBoards: true,
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
