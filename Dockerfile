FROM node:20-slim AS builder

WORKDIR /app

# Copy root package files
COPY package.json package-lock.json* ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY apps/relay-server/package.json apps/relay-server/

# Install all dependencies
RUN npm install

# Copy source
COPY tsconfig.json ./
COPY packages/protocol/ packages/protocol/
COPY packages/server/ packages/server/
COPY apps/relay-server/ apps/relay-server/

# Build
RUN npm run build

# ── Production stage ──────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

# Copy built artifacts and node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/packages/protocol/dist/ packages/protocol/dist/
COPY --from=builder /app/packages/protocol/package.json packages/protocol/
COPY --from=builder /app/packages/server/dist/ packages/server/dist/
COPY --from=builder /app/packages/server/package.json packages/server/
COPY --from=builder /app/packages/server/node_modules/ packages/server/node_modules/
COPY --from=builder /app/apps/relay-server/dist/ apps/relay-server/dist/
COPY --from=builder /app/apps/relay-server/package.json apps/relay-server/

# Create data directory
RUN mkdir -p /data

ENV PORT=8080
ENV HOST=0.0.0.0
ENV DATABASE_PATH=/data/relay.db

EXPOSE 8080

CMD ["node", "apps/relay-server/dist/main.js"]
