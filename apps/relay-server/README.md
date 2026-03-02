# OpenClaw Relay Server

A deployable relay server for tunneling HTTP requests between mobile apps and OpenClaw gateways.

## Quick Start

```bash
# From the monorepo root
npm install
npm run build

# Start the server
cd apps/relay-server
cp .env.example .env
npm start
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP/WebSocket listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATABASE_PATH` | `./relay.db` | SQLite database file path |
| `HEARTBEAT_MS` | `30000` | WebSocket ping interval in ms |

## Docker

```bash
# Build from monorepo root
docker build -t openclaw-relay -f apps/relay-server/Dockerfile .

# Run
docker run -d \
  --name openclaw-relay \
  -p 8080:8080 \
  -v relay-data:/data \
  openclaw-relay
```

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/health` | None | Health check |
| `POST` | `/api/pairing/initiate` | Gateway token | Create pairing code |
| `POST` | `/api/pairing/exchange` | None | Exchange code for app token |
| `POST` | `/api/admin/gateway-token` | None | Register new gateway |
| `GET` | `/api/apps` | Gateway token | List paired apps |
| `DELETE` | `/api/apps/:appId` | Gateway token | Revoke an app |
| `ALL` | `/api/gateway/*` | App token | Forward request to gateway |
| `WS` | `/v1/tunnel` | Protocol-level | Gateway WebSocket tunnel |

## Registering a Gateway

```bash
curl -X POST http://localhost:8080/api/admin/gateway-token \
  -H 'Content-Type: application/json' \
  -d '{"gateway_id": "my-gateway", "gateway_name": "My Mac"}'
```

Returns a `gw_live_xxx` token to use with the gateway client.
