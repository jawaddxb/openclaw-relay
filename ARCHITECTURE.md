بسم الله — let me think through this properly. This is a foundational architecture decision.

---

# AgentDraw Relay Architecture

**A Purpose-Built Tunnel for AI Agent Communication**

---

## 1. Executive Summary

The **OpenClaw Relay** is a WebSocket-based tunnel service that enables mobile apps to communicate with OpenClaw gateways regardless of network topology. Gateways establish persistent outbound connections to the relay; apps connect to the relay and request routing to their paired gateway. The relay multiplexes HTTP request/response cycles and SSE streams over these connections using a simple binary framing protocol. V1 runs on a single Node.js process, scales horizontally via subdomain-based routing, and ships as an npm package (`@openclaw/relay`) with both server and client SDKs.

---

## 2. Protocol Design

### 2.1 Transport: WebSocket

**Decision: WebSocket over `wss://`**

| Alternative | Why Not |
|-------------|---------|
| WebRTC | Overkill — we don't need peer-to-peer; the relay IS the rendezvous point. Complex STUN/TURN infrastructure for no benefit. |
| QUIC | Promising but ecosystem immature in Node.js/React Native. H3 support inconsistent. Revisit in v2. |
| Raw TCP | Loses WebSocket's framing, proxy traversal, and browser compatibility. |
| HTTP long-polling | Latency disaster for streaming AI responses. |

**WebSocket wins because:**
- Universal support (Node.js, React Native, browsers, Cloudflare Workers)
- Works through corporate proxies on 443
- Built-in framing eliminates parsing ambiguity
- Mature libraries (`ws`, `@fastify/websocket`)
- Clear upgrade path to HTTP/2 streams later

### 2.2 The Tunnel Protocol: `clawd-tunnel/1`

A simple binary framing protocol multiplexed over WebSocket:

```
┌─────────────────────────────────────────────────────────┐
│                    FRAME HEADER (16 bytes)              │
├──────────┬──────────┬──────────┬──────────┬─────────────┤
│  Type    │ Channel  │ Sequence │  Flags   │   Length    │
│  1 byte  │  4 bytes │  4 bytes │  1 byte  │   4 bytes   │
├──────────┴──────────┴──────────┴──────────┴─────────────┤
│                    PAYLOAD (variable)                   │
└─────────────────────────────────────────────────────────┘
```

**Frame Types:**

| Type | Value | Direction | Purpose |
|------|-------|-----------|---------|
| `HELLO` | 0x01 | G→R | Gateway announces itself, sends gateway token |
| `HELLO_ACK` | 0x02 | R→G | Relay confirms, assigns gateway ID |
| `REQUEST` | 0x10 | R→G | HTTP request from app to gateway |
| `RESPONSE_HEAD` | 0x11 | G→R | HTTP status + headers |
| `RESPONSE_BODY` | 0x12 | G→R | Response body chunk |
| `RESPONSE_END` | 0x13 | G→R | End of response (supports trailers) |
| `STREAM_DATA` | 0x20 | G→R | SSE/streaming chunk |
| `STREAM_END` | 0x21 | G→R | Stream terminated |
| `PING` | 0x30 | Both | Keepalive |
| `PONG` | 0x31 | Both | Keepalive response |
| `ERROR` | 0xFF | Both | Error with code + message |

**Flags byte:**
- Bit 0: `COMPRESSED` — payload is zstd compressed
- Bit 1: `CONTINUED` — more frames follow for this message
- Bit 2: `PRIORITY` — high priority (skip queue)
- Bits 3-7: Reserved

### 2.3 Multiplexing

**Channel IDs** identify concurrent request/response cycles:

```
App Request 1  ──┐
                 ├──▶ Relay ──────▶ Gateway Connection
App Request 2  ──┘         (multiplexed)
```

- Each app request gets a unique 32-bit channel ID (relay-assigned)
- Gateway responds on the same channel ID
- Responses can interleave at the frame level
- Channel closes on `RESPONSE_END` or `ERROR`

**Ordering guarantees:**
- Frames within a channel arrive in order (sequence numbers)
- No ordering between channels (parallel streams)

### 2.4 SSE Streaming (Critical Path)

AI chat streaming is the primary use case. Here's how SSE works:

```
┌──────────┐         ┌───────────┐         ┌──────────┐
│   App    │         │   Relay   │         │ Gateway  │
└────┬─────┘         └─────┬─────┘         └────┬─────┘
     │                     │                    │
     │ HTTP GET /chat      │                    │
     │ Accept: text/event-stream               │
     │ ─────────────────▶  │                    │
     │                     │  REQUEST frame     │
     │                     │ ─────────────────▶ │
     │                     │                    │
     │                     │  RESPONSE_HEAD     │
     │                     │  Content-Type: text/event-stream
     │                     │ ◀───────────────── │
     │ HTTP 200            │                    │
     │ Headers...          │                    │
     │ ◀───────────────────│                    │
     │                     │                    │
     │                     │  STREAM_DATA       │
     │                     │  "data: {token}\n\n"
     │ ◀─────────────────  │ ◀───────────────── │
     │                     │                    │
     │      ...repeats...  │     ...repeats...  │
     │                     │                    │
     │                     │  STREAM_END        │
     │ Connection closed   │ ◀───────────────── │
     │ ◀───────────────────│                    │
```

**Key design decisions:**
1. **No buffering in relay** — pure byte pipe, frames forwarded immediately
2. **Backpressure via WebSocket flow control** — if app is slow, relay pauses reading from gateway
3. **Early flush** — each `STREAM_DATA` frame = immediate write to app
4. **Heartbeat during streams** — `PING/PONG` every 30s to detect dead connections

### 2.5 Latency Analysis

```
Request path:  App → Relay → Gateway → LLM
Response path: LLM → Gateway → Relay → App

Added latency from relay: ~2-5ms per hop (same region)
                          ~50-100ms cross-region

For streaming: Per-token latency ≈ 2 * relay_hop_latency
               At 50 tokens/second, adds ~5ms avg visible delay
```

**Mitigation:**
- Deploy relay in multiple regions
- Gateways connect to nearest relay
- Apps connect to same relay as their gateway (encoded in pairing)

---

## 3. Identity & Authentication

### 3.1 Three-Tier Auth Model

```
┌─────────────────────────────────────────────────────────┐
│                    AUTHENTICATION LAYERS                │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────┐   Long-lived    ┌─────────────────┐   │
│  │   Gateway   │ ──────────────▶ │  Gateway Token  │   │
│  └─────────────┘   (secret)      └─────────────────┘   │
│                                                         │
│  ┌─────────────┐   Short-lived   ┌─────────────────┐   │
│  │   Pairing   │ ──────────────▶ │  Pairing Code   │   │
│  └─────────────┘   (1-time use)  └─────────────────┘   │
│                                                         │
│  ┌─────────────┐   Medium-lived  ┌─────────────────┐   │
│  │     App     │ ──────────────▶ │    App Token    │   │
│  └─────────────┘   (30 days)     └─────────────────┘   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 3.2 Token Specifications

**Gateway Token:**
```
Format: gw_live_[base64url(32 random bytes)]
Example: gw_live_7Hj2kL9mNpQrStUvWxYz0123456789abcdefghij

Storage: ~/.openclaw/relay-token (600 permissions)
Lifetime: Permanent until revoked
Scope: Full gateway access
```

**Pairing Code:**
```
Format: [6 alphanumeric, uppercase, no ambiguous chars]
Alphabet: ACDEFGHJKLMNPQRTUVWXY346789 (no 0/O, 1/I, 2/Z, 5/S, B/8)
Example: ACDF47

Lifetime: 5 minutes
Scope: Single-use, exchanges for App Token
```

**App Token:**
```
Format: app_[gateway_id]_[base64url(24 random bytes)]
Example: app_gw7x9_mNpQrStUvWxYz01234567890abc

Lifetime: 30 days, auto-refresh on use
Scope: Access to paired gateway only
Revokable: Yes, from gateway CLI
```

### 3.3 Token Exchange Flow

```
1. Gateway: POST /api/pairing/initiate
   Headers: Authorization: Bearer gw_live_xxx
   Response: { code: "ACDF47", expires: "2024-01-01T12:05:00Z" }

2. App: POST /api/pairing/exchange
   Body: { code: "ACDF47", device_name: "Jawad's iPhone" }
   Response: { 
     app_token: "app_gw7x9_...",
     gateway_id: "gw7x9",
     relay_endpoint: "wss://gw7x9.relay.agentdraw.com/v1/tunnel"
   }
```

### 3.4 Request Authentication

Every app request includes:
```
Authorization: Bearer app_gw7x9_mNpQrStUvWxYz01234567890abc
X-Request-ID: [uuid]
```

Relay validates:
1. Token format valid
2. Token not revoked
3. Token's gateway_id matches target gateway
4. Rate limits not exceeded

Then forwards to gateway with:
```
X-Relay-Forwarded-For: [app_ip]
X-Relay-App-ID: [app_id derived from token]
X-Request-ID: [preserved from app]
```

---

## 4. The npm Package

### 4.1 Package Naming

**Decision: `@openclaw/relay`**

Reasoning:
- `openclaw-relay` feels branded correctly
- Scoped package (`@openclaw/`) enables future ecosystem packages
- Generic enough to reuse, specific enough to find

Alternative considered: `clawd-relay` (matches clawd daemon) — rejected because less discoverable.

### 4.2 Package Structure

```
@openclaw/relay/
├── server        # Relay server
├── gateway       # Gateway client (connects TO relay)
├── app           # App client (for testing/Node.js apps)
├── protocol      # Shared frame encoding/decoding
└── types         # TypeScript types
```

### 4.3 Server API

```typescript
// @openclaw/relay/server

import { createRelayServer, RelayServer } from '@openclaw/relay/server';

const relay = createRelayServer({
  // Required
  port: 8080,
  
  // Auth
  validateGatewayToken: async (token) => {
    // Return gateway info or null to reject
    return { id: 'gw7x9', name: 'Jawad's Mac mini' };
  },
  validateAppToken: async (token) => {
    return { id: 'app_123', gatewayId: 'gw7x9' };
  },
  
  // Optional
  tls: { cert, key },                    // Or use reverse proxy
  redis: 'redis://localhost:6379',       // For multi-node
  metrics: true,                          // Prometheus /metrics
  maxConnectionsPerGateway: 100,
  maxRequestsPerMinute: 1000,
});

relay.on('gateway:connected', ({ id, name }) => { });
relay.on('gateway:disconnected', ({ id, reason }) => { });
relay.on('request', ({ gatewayId, appId, method, path }) => { });

await relay.listen();
```

**As Express/Fastify middleware (alternative):**

```typescript
import express from 'express';
import { relayMiddleware } from '@openclaw/relay/server';

const app = express();

app.use('/relay', relayMiddleware({
  validateGatewayToken: async (token) => { ... },
  validateAppToken: async (token) => { ... },
}));

app.listen(8080);
```

### 4.4 Gateway Client API

```typescript
// @openclaw/relay/gateway

import { GatewayClient } from '@openclaw/relay/gateway';

const client = new GatewayClient({
  relayUrl: 'wss://relay.agentdraw.com/v1/tunnel',
  token: process.env.OPENCLAW_RELAY_TOKEN,
  
  // The HTTP server to tunnel to
  upstream: 'http://localhost:3000',
  
  // Or handle requests programmatically
  handler: async (req) => {
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    };
  },
  
  // Optional
  reconnect: true,
  reconnectDelay: { min: 1000, max: 30000 },
  pingInterval: 30000,
});

client.on('connected', () => console.log('Tunnel established'));
client.on('disconnected', ({ reason }) => { });
client.on('request', ({ method, path, channelId }) => { });

await client.connect();

// Pairing
const { code, expiresAt } = await client.createPairingCode();
console.log(`Pair with code: ${code}`);

// Later: list connected apps
const apps = await client.listApps();
// [{ id: 'app_123', deviceName: "Jawad's iPhone", connectedAt: ... }]

// Revoke an app
await client.revokeApp('app_123');
```

### 4.5 App Client API (for testing / Node.js apps)

```typescript
// @openclaw/relay/app

import { AppClient } from '@openclaw/relay/app';

const client = new AppClient({
  appToken: 'app_gw7x9_...',
  relayUrl: 'wss://gw7x9.relay.agentdraw.com/v1/tunnel',
});

// Make HTTP requests through the tunnel
const response = await client.fetch('/api/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message: 'Hello' }),
});

// SSE streaming
const stream = await client.stream('/api/chat/stream', { ... });
for await (const event of stream) {
  console.log(event.data); // Each SSE event
}
```

### 4.6 React Native / Expo Integration

```typescript
// In AgentDraw app

import { RelayConnection } from '@openclaw/relay/app';

class OpenClawService {
  private connection: RelayConnection;
  
  async pair(qrData: string) {
    // QR contains: agentdraw://pair?code=ACDF47&relay=relay.agentdraw.com
    const { code, relay } = parseQR(qrData);
    
    const { appToken, gatewayId, relayEndpoint } = await fetch(
      `https://${relay}/api/pairing/exchange`,
      { method: 'POST', body: JSON.stringify({ code, device_name: getDeviceName() }) }
    ).then(r => r.json());
    
    await SecureStore.setItemAsync('app_token', appToken);
    await SecureStore.setItemAsync('relay_endpoint', relayEndpoint);
    
    this.connection = new RelayConnection({ appToken, relayEndpoint });
    await this.connection.connect();
  }
  
  async sendMessage(message: string): AsyncGenerator<string> {
    const stream = await this.connection.stream('/api/agent/chat', {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
    
    for await (const chunk of stream) {
      yield chunk.data;
    }
  }
}
```

---

## 5. Pairing Flow

### 5.1 Complete Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        PAIRING FLOW                              │
└─────────────────────────────────────────────────────────────────┘

 User's Terminal                    Relay                     AgentDraw App
       │                              │                              │
       │  $ openclaw pair             │                              │
       │  ─────────────────────────▶  │                              │
       │                              │                              │
       │  ┌────────────────────────┐  │                              │
       │  │ Scan this QR code:     │  │                              │
       │  │                        │  │                              │
       │  │   ██████████████████   │  │                              │
       │  │   ██              ██   │  │                              │
       │  │   ██  ██████████  ██   │  │                              │
       │  │   ██  ██      ██  ██   │  │                              │
       │  │   ██████████████████   │  │                              │
       │  │                        │  │                              │
       │  │ Or enter: ACDF47       │  │                              │
       │  │ Expires in 5:00        │  │                              │
       │  └────────────────────────┘  │                              │
       │                              │                              │
       │                              │    [User opens app, scans]   │
       │                              │                              │
       │                              │  POST /api/pairing/exchange  │
       │                              │  { code: "ACDF47" }          │
       │                              │ ◀───────────────────────────│
       │                              │                              │
       │                              │──┐                           │
       │                              │  │ Validate code             │
       │                              │  │ Generate app token        │
       │                              │◀─┘                           │
       │                              │                              │
       │                              │  { app_token, relay_endpoint }
       │                              │ ─────────────────────────────▶
       │                              │                              │
       │  ✓ Device connected:         │                              │
       │    "Jawad's iPhone"          │                              │
       │ ◀─────────────────────────── │                              │
       │                              │                              │
       │  Connection established.     │    [App saves token,         │
       │  Press Ctrl+C to exit.       │     connects to relay]       │
       │                              │                              │
```

### 5.2 QR Code Contents

**Format:** Deep link URL

```
agentdraw://pair?code=ACDF47&relay=relay.agentdraw.com&name=Mac%20mini
```

**Fields:**
- `code`: 6-character pairing code
- `relay`: Relay hostname (without protocol)
- `name`: Gateway display name (URL-encoded)

**Why deep link, not raw data?**
- Works with system QR scanner → opens app automatically
- Fallback: web page at `https://pair.agentdraw.com?code=...` redirects or shows instructions

### 5.3 pair.agentdraw.com Web Page

For users who scan with system camera (not in-app):

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│                         AgentDraw                                │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                                                            │ │
│  │     Connect to: Jawad's Mac mini                          │ │
│  │                                                            │ │
│  │     ┌─────────────────────────────────────────────────┐   │ │
│  │     │                                                 │   │ │
│  │     │     [Open in AgentDraw]                        │   │ │
│  │     │                                                 │   │ │
│  │     └─────────────────────────────────────────────────┘   │ │
│  │                                                            │ │
│  │     Don't have the app?                                   │ │
│  │     [App Store]  [Google Play]                            │ │
│  │                                                            │ │
│  │     ─────────────────────────────────────────────────     │ │
│  │                                                            │ │
│  │     Or enter code manually: ACDF47                        │ │
│  │                                                            │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│                    Expires in 4:32                               │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 5.4 CLI Experience

```bash
$ openclaw pair

Pairing Mode
────────────────────────────────────────

Scan this QR code with AgentDraw:

  ████████████████████████████████████
  ██              ██          ██    ██
  ██  ██████████  ██████████  ██    ██
  ██  ██      ██  ██      ██  ██    ██
  ██  ██████████  ██████████  ██    ██
  ██              ██              ████
  ████████████████████████████████████

Or enter this code manually: ACDF47
Or visit: https://pair.agentdraw.com/ACDF47

Waiting for connection... (expires in 4:58)

✓ Connected: Jawad's iPhone

Your gateway is now paired. The app will stay connected
even when you close this terminal.

Manage devices: openclaw devices

$ openclaw devices

Connected Devices
────────────────────────────────────────
  
  1. Jawad's iPhone
     Connected: 2 hours ago
     Last active: Just now
     
  2. iPad Pro
     Connected: 3 days ago  
     Last active: 1 day ago

Actions:
  [R]evoke device  [Q]uit

> 
```

---

## 6. Infrastructure Design

### 6.1 V1: Single Node Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          RELAY V1                                │
│                     (Single Node.js Process)                     │
└─────────────────────────────────────────────────────────────────┘

                    ┌─────────────────────────┐
                    │     Load Balancer       │
                    │   (Cloudflare/nginx)    │
                    │                         │
                    │  relay.agentdraw.com    │
                    │  *.relay.agentdraw.com  │
                    └───────────┬─────────────┘
                                │
                    ┌───────────▼─────────────┐
                    │                         │
                    │   Node.js Relay Server  │
                    │                         │
                    │   ┌─────────────────┐   │
                    │   │  WebSocket Hub  │   │
                    │   │                 │   │
                    │   │  Gateways: Map  │   │
                    │   │  Apps: Map      │   │
                    │   │  Channels: Map  │   │
                    │   └─────────────────┘   │
                    │                         │
                    │   ┌─────────────────┐   │
                    │   │   HTTP API      │   │
                    │   │                 │   │
                    │   │  /api/pairing/* │   │
                    │   │  /api/health    │   │
                    │   │  /metrics       │   │
                    │   └─────────────────┘   │
                    │                         │
                    └───────────┬─────────────┘
                                │
                    ┌───────────▼─────────────┐
                    │        SQLite           │
                    │   (or PostgreSQL)       │
                    │                         │
                    │  - Gateway tokens       │
                    │  - App tokens           │
                    │  - Pairing codes        │
                    │  - Audit log            │
                    └─────────────────────────┘
```

**Why this works for v1:**
- Single WebSocket connection per gateway = low memory
- A $20/month VPS handles 10,000+ concurrent connections
- SQLite for persistence, upgrade to Postgres later
- Cloudflare in front for DDoS, TLS termination

### 6.2 Scaling: Multi-Node with Subdomain Routing

```
┌─────────────────────────────────────────────────────────────────┐
│                        RELAY V2 (Scaled)                         │
└─────────────────────────────────────────────────────────────────┘

        Apps connect to:                 Gateways connect to:
     gw7x9.relay.agentdraw.com          relay.agentdraw.com
              │                                  │
              │                                  │
              ▼                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Cloudflare DNS + Load Balancer               │
│                                                                  │
│   *.relay.agentdraw.com → consistent hash by subdomain          │
│   relay.agentdraw.com → any node (registration)                 │
└─────────────────────────────────────────────────────────────────┘
              │                                  │
     ┌────────┴────────┐                ┌────────┴────────┐
     ▼                 ▼                ▼                 ▼
┌─────────┐      ┌─────────┐      ┌─────────┐      ┌─────────┐
│ Node 1  │      │ Node 2  │      │ Node 3  │      │ Node 4  │
│         │      │         │      │         │      │         │
│ gw7x9   │      │ gwa2b   │      │ gwc3d   │      │ gwe4f   │
│ gw8y0   │      │ gwb5c   │      │ gwd4e   │      │ gwf5g   │
└────┬────┘      └────┬────┘      └────┬────┘      └────┬────┘
     │                │                │                │
     └────────────────┴────────────────┴────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │   Redis Cluster   │
                    │                   │
                    │ - Token storage   │
                    │ - Gateway→Node map│
                    │ - Pub/sub events  │
                    └───────────────────┘
```

**How it works:**
1. Gateway connects to `relay.agentdraw.com` (any node)
2. Node registers gateway, assigns subdomain `gw7x9.relay.agentdraw.com`
3. Subdomain consistently hashes to specific node
4. Gateway reconnects to assigned node: `wss://gw7x9.relay.agentdraw.com/v1/tunnel`
5. Apps connect to same subdomain → routed to same node
6. Redis stores mapping + shared token state

### 6.3 Resource Estimates

| Metric | Per Connection | 1K Gateways | 10K Gateways |
|--------|----------------|-------------|--------------|
| Memory | ~50KB | 50MB | 500MB |
| File descriptors | 1 | 1,000 | 10,000 |
| Bandwidth (idle) | ~1KB/min | 1MB/min | 10MB/min |
| Bandwidth (active) | ~100KB/s | 100MB/s | 1GB/s |

**V1 server recommendation:** 4GB RAM, 2 CPU, 1TB transfer

---

## 7. Edge Cases & Resilience

### 7.1 Gateway Goes Offline Mid-Session

```
App sends request
        │
        ▼
   ┌─────────────────┐
   │ Gateway online? │──No──▶ Hold in buffer (2 seconds)
   └────────┬────────┘                    │
            │ Yes                         │
            ▼                             ▼
   Forward to gateway          ┌──────────────────────┐
                               │ Still offline?      │
                               └──────────┬──────────┘
                                          │ Yes
                                          ▼
                               Return 502 Bad Gateway
                               { "error": "gateway_offline",
                                 "retry_after": 5 }
```

**App behavior:**
- Show "Reconnecting..." UI
- Retry with exponential backoff
- After 30s, show "Gateway offline" with manual retry button

### 7.2 Relay Server Restarts

**Gateway reconnection:**
```typescript
// Built into GatewayClient
reconnect: {
  enabled: true,
  delay: {
    initial: 1000,
    max: 30000,
    multiplier: 1.5,
    jitter: 0.2,
  },
  maxAttempts: Infinity, // Always reconnect
}
```

**State recovery:**
- Tokens stored in DB → survive restart
- In-flight requests → lost, apps retry
- SSE streams → clients reconnect, resume from last event ID

**Graceful shutdown:**
```typescript
relay.on('SIGTERM', async () => {
  // Stop accepting new connections
  await relay.stopAccepting();
  
  // Notify all gateways: "reconnect to different node"
  await relay.broadcastReconnect();
  
  // Wait for in-flight requests (max 30s)
  await relay.drain(30000);
  
  // Exit
  process.exit(0);
});
```

### 7.3 Multiple Apps → Same Gateway

Fully supported via channel multiplexing:

```
App 1 (iPhone)  ───┐
                   │     ┌───────────┐     ┌───────────┐
App 2 (iPad)    ───┼────▶│   Relay   │────▶│  Gateway  │
                   │     └───────────┘     └───────────┘
App 3 (Web)     ───┘
```

Each app:
- Has its own app token
- Gets unique channel IDs
- Can have concurrent requests
- Sees only its own responses

Gateway sees:
- `X-Relay-App-ID` header identifying source
- Can implement per-app rate limits
- Can broadcast events to all apps (future feature)

### 7.4 Large File Transfers

**Problem:** Uploading images, documents through the relay.

**Solution:** Chunked streaming with backpressure:

```
App                     Relay                    Gateway
 │                        │                         │
 │ POST /upload           │                         │
 │ Content-Length: 50MB   │                         │
 │ [headers only]         │                         │
 │───────────────────────▶│                         │
 │                        │ REQUEST frame           │
 │                        │───────────────────────▶ │
 │                        │                         │
 │ [body chunk 1: 64KB]   │                         │
 │───────────────────────▶│ BODY_CHUNK frame        │
 │                        │───────────────────────▶ │
 │                        │                         │
 │ [body chunk 2: 64KB]   │                         │
 │───────────────────────▶│ BODY_CHUNK frame        │
 │                        │───────────────────────▶ │
 │                        │                         │
 │        ...             │          ...            │
 │                        │                         │
 │ [final chunk]          │ BODY_END frame          │
 │───────────────────────▶│───────────────────────▶ │
```

**Limits:**
- Max request body: 100MB (configurable)
- Chunk size: 64KB
- Timeout: 10 minutes for large uploads
- Memory: Streaming, no full-body buffering

### 7.5 Rate Limiting & Abuse Prevention

```typescript
const limits = {
  // Per gateway
  gateway: {
    maxApps: 20,                    // Max paired devices
    maxConcurrentRequests: 100,     // Across all apps
    maxRequestsPerMinute: 1000,
  },
  
  // Per app
  app: {
    maxConcurrentRequests: 10,
    maxRequestsPerMinute: 100,
    maxBodySize: '100MB',
  },
  
  // Per IP (unauthenticated)
  ip: {
    maxPairingAttempts: 10,         // Per hour
    maxFailedAuth: 20,              // Per hour, then block
  },
};
```

**Enforcement:**
- 429 Too Many Requests with `Retry-After` header
- Persistent violators → temporary IP block
- Gateway can set custom limits via config

---

## 8. Build Prioritization

### Phase 1: MVP (Week 1-2)
**Goal: "It works on same WiFi via relay"**

1. **Protocol implementation** (`@openclaw/relay/protocol`)
   - Frame encoding/decoding
   - Basic message types (HELLO, REQUEST, RESPONSE_*, ERROR)
   - No compression, no streaming yet

2. **Single-node relay server** (`@openclaw/relay/server`)
   - WebSocket hub
   - In-memory gateway registry
   - Simple token validation (hardcoded for testing)

3. **Gateway client** (`@openclaw/relay/gateway`)
   - Connect to relay
   - Forward HTTP requests to local server
   - Auto-reconnect

4. **Basic CLI integration**
   - `openclaw relay connect` (manual connection)
   - Environment variable for token

### Phase 2: Pairing (Week 3)
**Goal: QR code pairing works**

5. **Pairing API**
   - POST /api/pairing/initiate
   - POST /api/pairing/exchange
   - SQLite token storage

6. **CLI pairing flow**
   - `openclaw pair` command
   - QR code generation in terminal
   - Waiting animation

7. **pair.agentdraw.com** 
   - Simple redirect page
   - Deep link to app

### Phase 3: Streaming (Week 4)
**Goal: AI chat streaming works**

8. **SSE support**
   - STREAM_DATA, STREAM_END frames
   - Proper backpressure
   - Connection keepalive

9. **React Native integration**
   - AgentDraw SDK wrapper
   - Streaming message component

### Phase 4: Production (Week 5-6)
**Goal: Deployable, observable, reliable**

10. **Multi-device support**
    - `openclaw devices` management
    - Token revocation

11. **Observability**
    - Prometheus metrics
    - Structured logging
    - Health endpoints

12. **Hardening**
    - Rate limiting
    - Graceful shutdown
    - Reconnection stress testing

### Phase 5: Scale (Future)
- Multi-node with Redis
- Regional deployment
- WebSocket compression
- QUIC transport option

---

## 9. Open Questions Requiring Decisions

### 9.1 Hosting Decision

| Option | Pros | Cons |
|--------|------|------|
| **Self-hosted only** | Simple, no infra cost | Adoption friction, no hosted option |
| **Hosted at relay.agentdraw.com** | Zero setup for users | Running costs, we're the middleman |
| **Both (open source + hosted)** | Best of both worlds | More to maintain |

**Recommendation:** Both. Open source the relay, run hosted version. Most users use hosted, power users self-host.

### 9.2 Pricing Model (if hosted)

| Model | Description |
|-------|-------------|
| **Free forever** | Funded by MizanXYZ, goodwill |
| **Freemium** | Free tier (1 gateway, 2 devices), paid for more |
| **Pay-as-you-go** | Metered bandwidth, $X per GB |
| **Bundled** | Included with OpenClaw Pro subscription |

**Recommendation:** Free for reasonable use (1 gateway, 5 devices, 10GB/mo), bundled with future Pro tier.

### 9.3 Encryption: End-to-End?

Currently: TLS to relay, TLS to gateway = transport encryption but relay sees plaintext.

**Options:**
1. **Trust the relay** (v1) — relay is ours, it's fine
2. **E2E encryption** — app and gateway negotiate keys, relay is blind

**Recommendation:** V1 trusts relay. V2 considers E2E for enterprise users.

### 9.4 Domain: Which Subdomain Pattern?

| Pattern | Example | Notes |
|---------|---------|-------|
| `{gateway-id}.relay.agentdraw.com` | `gw7x9.relay.agentdraw.com` | Clean, but leaks gateway IDs |
| `relay-{region}.agentdraw.com` | `relay-us.agentdraw.com` | Regional, but doesn't identify gateway |
| `{random}.r.agentdraw.com` | `7hj2kl9m.r.agentdraw.com` | Opaque, short subdomain |

**Recommendation:** `{random}.r.agentdraw.com` — opaque, no information leakage, short.

### 9.5 What Happens to Existing Sessions When Gateway Disconnects?

| Behavior | UX | Complexity |
|----------|-----|------------|
| **Immediate fail** | Fast feedback, app shows "offline" | Simple |
| **Buffer briefly** | Hide transient disconnects | Medium |
| **Queue and replay** | Requests survive reconnect | Complex |

**Recommendation:** Buffer 2-5 seconds, then fail. Simple and honest UX.

---

## 10. Summary

**What we're building:**
- `@openclaw/relay` — npm package with server, gateway client, and app client
- `relay.agentdraw.com` — hosted relay service
- `pair.agentdraw.com` — web pairing helper

**Key technical decisions:**
- WebSocket transport with custom binary framing (`clawd-tunnel/1`)
- Three-tier auth (gateway tokens, pairing codes, app tokens)
- Subdomain-based routing for horizontal scaling
- SSE streaming with immediate frame forwarding

**First milestone:** Working relay with manual token config (Week 2)
**Production milestone:** QR pairing + SSE streaming (Week 4)

---

This architecture is intentionally opinionated. It optimizes for:
1. **Simplicity** — v1 is a single Node.js process
2. **UX** — QR code pairing, no port forwarding ever
3. **Streaming** — first-class SSE support for AI chat
4. **Extensibility** — clean separation for future features

Let's build it. بسم الله.