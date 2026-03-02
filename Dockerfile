FROM node:20-slim AS builder

WORKDIR /app

# Copy everything and install
COPY package.json package-lock.json* ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY apps/relay-server/package.json apps/relay-server/

RUN npm install

COPY tsconfig.json ./
COPY packages/protocol/ packages/protocol/
COPY packages/server/ packages/server/
COPY apps/relay-server/ apps/relay-server/

RUN npm run build

# ── Production stage ──────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

# Copy everything from builder (simpler, avoids workspace node_modules issues)
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/packages/protocol/dist/ packages/protocol/dist/
COPY --from=builder /app/packages/protocol/package.json packages/protocol/
COPY --from=builder /app/packages/server/dist/ packages/server/dist/
COPY --from=builder /app/packages/server/package.json packages/server/
COPY --from=builder /app/apps/relay-server/dist/ apps/relay-server/dist/
COPY --from=builder /app/apps/relay-server/package.json apps/relay-server/

RUN mkdir -p /data

ENV PORT=8080
ENV HOST=0.0.0.0
ENV DATABASE_PATH=/data/relay.db

EXPOSE 8080

CMD ["node", "apps/relay-server/dist/main.js"]
