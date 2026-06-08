# syntax=docker/dockerfile:1

# ---- Build stage: full toolchain (compiles native modules) + Vite build ----
FROM node:20 AS build
WORKDIR /app

# Install ALL deps first (native modules like better-sqlite3 / @napi-rs/canvas
# compile/download here; node:20 ships the build tools they need).
COPY package.json package-lock.json ./
RUN npm ci

# Build the server (tsc -> dist/) and the web app (vite -> app/dist/).
COPY . .
RUN npm run build && npm run build:app

# Drop dev dependencies but keep the already-built native binaries.
RUN npm prune --omit=dev

# ---- Runtime stage: slim image, no build tools needed -----------------------
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/app/dist ./app/dist
COPY --from=build /app/package.json ./package.json

# Render (and most hosts) inject $PORT; src/http/start.ts reads it.
EXPOSE 10000
CMD ["node", "dist/http/start.js"]
