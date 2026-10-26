# syntax = docker/dockerfile:1

# Bun version: keep in sync with the bun.lock format (locally generated with 1.3.x).
# Pinned by digest (the 1.3.11-slim index, 2026-10-26): a moved tag cannot change the build.
FROM oven/bun:1.3.11-slim@sha256:478281fdd196871c7e51ba6a820b7803a8ae97042ec86cdbc2e1c6b6626442d9 AS base
WORKDIR /app
ENV NODE_ENV="production"

# ---- build stage: install deps + build the frontend ----
FROM base AS build

# Root deps (server: hono, nanoid). No native modules → no build toolchain needed.
COPY --link bun.lock package.json ./
RUN bun install --frozen-lockfile

# Frontend deps.
COPY --link frontend/bun.lock frontend/package.json ./frontend/
RUN cd frontend && bun install --frozen-lockfile

# App source (.dockerignore keeps node_modules/dist/tests out).
COPY --link . .

# Build the Vite frontend, then drop everything in frontend/ except dist.
WORKDIR /app/frontend
RUN bun run build
RUN find . -mindepth 1 ! -regex '^./dist\(/.*\)?' -delete

# ---- runtime stage ----
FROM base
COPY --from=build /app /app
# The image's own non-root user (uid 1000). On the VPS, compose sets the site user.
USER bun
EXPOSE 3000
# Bun runs the server as PID 1 (no `bun run` wrapper), so it gets the stop signal.
CMD ["bun", "server/index.ts"]
