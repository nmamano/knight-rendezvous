// Hono app: WS upgrade, static serving of the built frontend, Bun default export.
// In-memory state only — this MUST run on exactly one machine (deploy is C7).

import { Hono } from "hono";
import { logger } from "hono/logger";
import { serveStatic } from "hono/bun";
import { RoomStore } from "./rooms";
import { registerSocket } from "./socket";

const PORT = Number(process.env.PORT ?? 3000);

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

export default {
  port: PORT,
  fetch: app.fetch,
  websocket,
};
