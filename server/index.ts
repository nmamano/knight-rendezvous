// Hono app: WS upgrade, static serving of the built frontend, listen on PORT or SITE_SOCKET.
// In-memory state only: this MUST run as exactly one process. A second one would hold
// a separate room store, so two players on different processes could never meet.

import { chmodSync, rmSync } from "node:fs";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { serveStatic } from "hono/bun";
import { RoomStore } from "./rooms";
import { registerSocket } from "./socket";

const PORT = Number(process.env.PORT ?? 3000);
// When set, listen on this Unix socket instead of PORT (the VPS reverse proxy).
const SITE_SOCKET = process.env.SITE_SOCKET;

const app = new Hono();
// Quiet under `bun test` (NODE_ENV=test); log requests in dev/prod.
if (process.env.NODE_ENV !== "test") app.use("*", logger());

const store = new RoomStore();
// The WS route is registered first, so it always wins over the static catch-all.
const websocket = registerSocket(app, store);

app.get("/health", (c) => c.json({ ok: true, rooms: store.size }));

// Serve the built SPA (frontend/dist), falling back to index.html for any route
// the static handler doesn't resolve. Only meaningful once `bun run build` has
// produced frontend/dist; in dev, use the Vite dev server (it proxies /ws here).
app.get("*", serveStatic({ root: "./frontend/dist" }));
app.get("*", serveStatic({ path: "./frontend/dist/index.html" }));

// Tests serve these handlers on an ephemeral port; `bun run start` listens below.
export const handlers = { fetch: app.fetch, websocket };

if (import.meta.main) {
  if (SITE_SOCKET) {
    // A socket file left by a killed process makes listen fail with EADDRINUSE.
    rmSync(SITE_SOCKET, { force: true });
    Bun.serve({ ...handlers, unix: SITE_SOCKET });
    // The reverse proxy connects as another user.
    chmodSync(SITE_SOCKET, 0o666);
    console.log(`Listening on unix:${SITE_SOCKET}`);
  } else {
    const server = Bun.serve({ ...handlers, port: PORT });
    console.log(`Listening on ${server.url}`);
  }
}
