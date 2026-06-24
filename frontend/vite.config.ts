import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const backend = process.env.KR_BACKEND_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(here, "./src"),
      "@shared": resolve(here, "../shared"),
    },
  },
  server: {
    host: true,
    proxy: {
      // Dev: Vite proxies the WebSocket + health check to the Bun server.
      // Override KR_BACKEND_URL when :3000 is already occupied by another app.
      "/ws": { target: backend, ws: true, changeOrigin: true },
      "/health": { target: backend, changeOrigin: true },
    },
  },
});
