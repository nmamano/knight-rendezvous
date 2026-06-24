# syntax = docker/dockerfile:1

# Bun version: keep in sync with the bun.lock format (locally generated with 1.3.x).
ARG BUN_VERSION=1.3.11
FROM oven/bun:${BUN_VERSION}-slim AS base
LABEL fly_launch_runtime="Bun"
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
EXPOSE 3000
CMD ["bun", "run", "start"]
