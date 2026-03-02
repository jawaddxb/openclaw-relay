# @openclaw/relay

A WebSocket-based tunnel service that enables mobile apps to communicate with OpenClaw gateways regardless of network topology. Gateways establish persistent outbound connections to the relay; apps connect and request routing to their paired gateway.

## Architecture

```
Mobile App ──HTTP──▶ Relay Server ──WebSocket──▶ Gateway ──HTTP──▶ Local Server
```

The relay multiplexes HTTP request/response cycles and SSE streams over WebSocket connections using a binary framing protocol (`clawd-tunnel/1`).

### Packages

| Package | Description |
|---------|-------------|
| `packages/protocol` | Binary frame encoder/decoder for `clawd-tunnel/1` |
| `packages/server` | Fastify relay server with WebSocket hub, HTTP API, SQLite |
| `packages/gateway` | Gateway client + CLI for connecting to relay |
| `apps/relay-server` | Deployable relay server app with Docker support |

### Protocol

14-byte binary frame header: `type(1) + channelId(4) + sequence(4) + flags(1) + length(4)`

Frame types: `HELLO`, `HELLO_ACK`, `REQUEST`, `RESPONSE_HEAD`, `RESPONSE_BODY`, `RESPONSE_END`, `STREAM_DATA`, `STREAM_END`, `PING`, `PONG`, `ERROR`

### Auth Model

- **Gateway tokens** (`gw_live_xxx`) — long-lived, used by gateways to authenticate with the relay
- **Pairing codes** (6-char, 5-minute TTL) — one-time codes to pair mobile apps
- **App tokens** (`app_xxx`) — 30-day tokens issued to paired apps

## Quick Start

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Start the relay server
cd apps/relay-server
cp .env.example .env
npm start
```

## Register a Gateway

```bash
# Create a gateway token
curl -X POST http://localhost:8080/api/admin/gateway-token \
  -H 'Content-Type: application/json' \
  -d '{"gateway_id": "my-mac", "gateway_name": "My Mac"}'
# → {"token": "gw_live_xxx", "gateway_id": "my-mac"}
```

## Connect a Gateway

```bash
# Using the CLI
npx openclaw-relay connect \
  --token gw_live_xxx \
  --upstream http://localhost:18789 \
  --relay ws://localhost:8080/v1/tunnel
```

## Pair a Mobile App

```bash
# Generate a pairing QR code
npx openclaw-relay pair --token gw_live_xxx --relay http://localhost:8080

# List connected devices
npx openclaw-relay devices --token gw_live_xxx --relay http://localhost:8080
```

## Using the Server SDK

```typescript
import { createRelayServer } from '@openclaw/relay-server';

const relay = await createRelayServer({
  port: 8080,
  dbPath: './relay.db',
});

relay.hub.on('gateway:connected', ({ id, name }) => {
  console.log(`Gateway connected: ${id} (${name})`);
});

await relay.listen();
```

## Using the Gateway Client SDK

```typescript
import { GatewayClient } from '@openclaw/relay-gateway';

const client = new GatewayClient({
  relayUrl: 'ws://localhost:8080/v1/tunnel',
  token: 'gw_live_xxx',
  upstream: 'http://localhost:3000',
});

client.on('connected', ({ gatewayId }) => {
  console.log(`Connected as ${gatewayId}`);
});

await client.connect();
```

## Docker Deployment

```bash
# Build from monorepo root
docker build -t openclaw-relay -f apps/relay-server/Dockerfile .

# Run with persistent storage
docker run -d \
  --name openclaw-relay \
  -p 8080:8080 \
  -v relay-data:/data \
  openclaw-relay
```

## Development

```bash
npm install          # Install all workspace dependencies
npm run build        # Build all packages
npm run clean        # Remove all build artifacts
npm run typecheck    # Type-check without emitting
```

## License

MIT
