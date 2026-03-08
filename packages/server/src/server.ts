import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { WebSocketHub } from './hub.js';
import { RelayDB } from './db.js';
import {
  hashPassword,
  verifyPassword,
  hashToken,
  signJWT,
  verifyJWT,
  checkRateLimit,
} from './auth.js';
import type { JWTPayload } from './auth.js';

export interface RelayServerOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  heartbeatMs?: number;
}

export interface RelayServer {
  app: FastifyInstance;
  hub: WebSocketHub;
  db: RelayDB;
  listen: () => Promise<string>;
  close: () => Promise<void>;
}

const COOKIE_NAME = 'agentdraw_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function createRelayServer(
  options: RelayServerOptions = {},
): Promise<RelayServer> {
  const {
    port = 8080,
    host = '0.0.0.0',
    dbPath = './relay.db',
    heartbeatMs = 30_000,
  } = options;

  const db = new RelayDB(dbPath);
  const hub = new WebSocketHub(heartbeatMs);

  const app = Fastify({ logger: true });
  await app.register(fastifyCors, {
    origin: true, // Allow all origins (app runs on any domain/localhost)
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'x-openclaw-agent-id', 'x-openclaw-session-key'],
    exposedHeaders: ['x-relay-app-id'],
    credentials: true,
  });
  await app.register(fastifyWebsocket);
  await app.register(fastifyCookie);

  // ── Auth helpers ─────────────────────────────────────────────

  const isSecure = process.env.NODE_ENV === 'production';

  function setSessionCookie(reply: FastifyReply, jwt: string): void {
    reply.setCookie(COOKIE_NAME, jwt, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    });
  }

  function clearSessionCookie(reply: FastifyReply): void {
    reply.clearCookie(COOKIE_NAME, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'lax',
      path: '/',
    });
  }

  /** Extract and validate user session from cookie or Authorization header */
  function authenticate(request: FastifyRequest): JWTPayload | null {
    let token: string | undefined;

    // Try cookie first
    const cookies = request.cookies as Record<string, string> | undefined;
    if (cookies?.[COOKIE_NAME]) {
      token = cookies[COOKIE_NAME];
    }

    // Try Authorization header
    if (!token) {
      const auth = request.headers.authorization;
      if (auth?.startsWith('Bearer ')) {
        token = auth.slice(7);
      }
    }

    if (!token) return null;

    const payload = verifyJWT(token);
    if (!payload) return null;

    // Verify session still exists and not expired
    const session = db.findSession(payload.sid);
    if (!session || session.expires_at < Date.now()) return null;

    // Touch last_used
    db.touchSession(payload.sid);

    return payload;
  }

  /** Helper: require auth or 401 */
  function requireAuth(request: FastifyRequest, reply: FastifyReply): JWTPayload | null {
    const user = authenticate(request);
    if (!user) {
      reply.status(401).send({ error: 'Authentication required' });
      return null;
    }
    return user;
  }

  // ── Gateway status tracking ──────────────────────────────────

  hub.on('gateway:connected', (info: { id: string; name: string }) => {
    db.updateGatewayStatus(info.id, 'online');
  });

  hub.on('gateway:disconnected', (info: { id: string; reason: string }) => {
    db.updateGatewayStatus(info.id, 'offline');
  });

  // ── WebSocket tunnel endpoint ────────────────────────────────

  app.register(async function wsRoutes(fastify) {
    fastify.get(
      '/v1/tunnel',
      { websocket: true },
      (socket, _req) => {
        hub.handleGatewayConnection(socket, (token) =>
          db.validateAnyGatewayToken(token),
        );
      },
    );
  });

  // ══════════════════════════════════════════════════════════════
  // AUTH ROUTES
  // ══════════════════════════════════════════════════════════════

  // ── POST /api/auth/register ──────────────────────────────────

  app.post<{
    Body: { email: string; password: string; name?: string };
  }>('/api/auth/register', async (request, reply) => {
    const { email, password, name } = request.body ?? {};

    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password required' });
    }

    if (password.length < 8) {
      return reply.status(400).send({ error: 'Password must be at least 8 characters' });
    }

    if (!checkRateLimit(`register:${request.ip}`, 5, 60_000)) {
      return reply.status(429).send({ error: 'Too many attempts, try again later' });
    }

    // Check if user already exists
    const existing = db.findUserByEmail(email);
    if (existing) {
      return reply.status(409).send({ error: 'Email already registered' });
    }

    const passwordHash = hashPassword(password);
    const user = db.createUser(email, name ?? null, passwordHash);

    // Create session
    const expiresAt = Date.now() + SESSION_TTL_MS;
    const sessionId = db.createSession(user.id, expiresAt, {
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });
    db.updateUserLastLogin(user.id);

    const jwt = signJWT({ sub: user.id, sid: sessionId, email: user.email });
    setSessionCookie(reply, jwt);

    return reply.send({
      user: { id: user.id, email: user.email, name: user.name },
      token: jwt,
    });
  });

  // ── POST /api/auth/login ────────────────────────────────────

  app.post<{
    Body: { email: string; password: string };
  }>('/api/auth/login', async (request, reply) => {
    const { email, password } = request.body ?? {};

    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password required' });
    }

    if (!checkRateLimit(`login:${request.ip}`, 5, 60_000)) {
      return reply.status(429).send({ error: 'Too many login attempts, try again later' });
    }

    const user = db.findUserByEmail(email);
    if (!user || !user.password_hash) {
      return reply.status(401).send({ error: 'Invalid email or password' });
    }

    if (!verifyPassword(password, user.password_hash)) {
      return reply.status(401).send({ error: 'Invalid email or password' });
    }

    // Create session
    const expiresAt = Date.now() + SESSION_TTL_MS;
    const sessionId = db.createSession(user.id, expiresAt, {
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });
    db.updateUserLastLogin(user.id);

    const jwt = signJWT({ sub: user.id, sid: sessionId, email: user.email });
    setSessionCookie(reply, jwt);

    return reply.send({
      user: { id: user.id, email: user.email, name: user.name },
      token: jwt,
    });
  });

  // ── POST /api/auth/logout ───────────────────────────────────

  app.post('/api/auth/logout', async (request, reply) => {
    const user = authenticate(request);
    if (user) {
      db.deleteSession(user.sid, user.sub);
    }
    clearSessionCookie(reply);
    return reply.send({ ok: true });
  });

  // ── GET /api/auth/me ────────────────────────────────────────

  app.get('/api/auth/me', async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;

    const user = db.findUserById(auth.sub);
    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }

    const gateways = db.listUserGateways(auth.sub).map((gw) => ({
      id: gw.id,
      name: gw.name,
      status: gw.status,
      machineInfo: gw.machine_info ? JSON.parse(gw.machine_info) : null,
      lastSeen: gw.last_seen,
      createdAt: gw.created_at,
      connected: hub.isGatewayConnected(gw.id),
    }));

    return reply.send({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerified: !!user.email_verified,
        createdAt: user.created_at,
      },
      gateways,
    });
  });

  // ══════════════════════════════════════════════════════════════
  // DEVICE AUTH (RFC 8628)
  // ══════════════════════════════════════════════════════════════

  // ── POST /api/auth/device — Start device auth (no session) ──

  app.post<{
    Body: { machine_info?: Record<string, string> };
  }>('/api/auth/device', async (request, reply) => {
    if (!checkRateLimit(`device:${request.ip}`, 3, 60_000)) {
      return reply.status(429).send({ error: 'Too many requests, try again later' });
    }

    const machineInfo = request.body?.machine_info
      ? JSON.stringify(request.body.machine_info)
      : undefined;

    const result = db.createDeviceAuth(machineInfo);

    return reply.send({
      device_code: result.deviceCode,
      user_code: result.userCode,
      verification_url: process.env.WEB_APP_URL || 'https://agentdraw-web-production.up.railway.app/link',
      expires_at: result.expiresAt,
      interval: result.interval,
    });
  });

  // ── POST /api/auth/device/authorize — Authorize device (session required) ──

  app.post<{
    Body: { user_code: string; gateway_name?: string };
  }>('/api/auth/device/authorize', async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;

    const { user_code, gateway_name } = request.body ?? {};
    if (!user_code) {
      return reply.status(400).send({ error: 'user_code required' });
    }

    const result = db.authorizeDevice(user_code, auth.sub, gateway_name);
    if (!result) {
      return reply.status(400).send({ error: 'Invalid or expired device code' });
    }

    return reply.send({
      ok: true,
      gateway_id: result.gatewayId,
      message: 'Gateway linked successfully',
    });
  });

  // ── POST /api/auth/device/token — Poll for token (no session) ──

  app.post<{
    Body: { device_code: string };
  }>('/api/auth/device/token', async (request, reply) => {
    const { device_code } = request.body ?? {};
    if (!device_code) {
      return reply.status(400).send({ error: 'device_code required' });
    }

    const result = db.pollDeviceToken(device_code);

    if (result.status === 'pending') {
      return reply.status(200).send({
        status: 'pending',
        interval: result.interval ?? 5,
      });
    }

    if (result.status === 'authorized') {
      return reply.send({
        status: 'authorized',
        gateway_token: result.gatewayToken,
        gateway_id: result.gatewayId,
      });
    }

    // expired or denied
    return reply.status(410).send({ status: result.status });
  });

  // ══════════════════════════════════════════════════════════════
  // LINK TOKENS
  // ══════════════════════════════════════════════════════════════

  // ── POST /api/link-tokens — Create link token (session required) ──

  app.post<{
    Body: { name?: string };
  }>('/api/link-tokens', async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;

    if (!checkRateLimit(`link-token:${auth.sub}`, 10, 3600_000)) {
      return reply.status(429).send({ error: 'Too many link tokens created, try again later' });
    }

    const result = db.createLinkToken(auth.sub, request.body?.name);

    return reply.send({
      token: result.token,
      id: result.id,
      expires_at: result.expiresAt,
      command: `npx agentdraw link ${result.token}`,
    });
  });

  // ── POST /api/link-tokens/redeem — Redeem link token (no session) ──

  app.post<{
    Body: { token: string; gateway_name?: string; machine_info?: Record<string, string> };
  }>('/api/link-tokens/redeem', async (request, reply) => {
    const { token, gateway_name, machine_info } = request.body ?? {};
    if (!token) {
      return reply.status(400).send({ error: 'token required' });
    }

    const machineInfoJson = machine_info ? JSON.stringify(machine_info) : undefined;
    const result = db.redeemLinkToken(token, gateway_name, machineInfoJson);
    if (!result) {
      return reply.status(400).send({ error: 'Invalid or expired link token' });
    }

    return reply.send({
      gateway_token: result.gatewayToken,
      gateway_id: result.gatewayId,
    });
  });

  // ══════════════════════════════════════════════════════════════
  // GATEWAY MANAGEMENT
  // ══════════════════════════════════════════════════════════════

  // ── GET /api/gateways — List user's gateways ────────────────

  app.get('/api/gateways', async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;

    const gateways = db.listUserGateways(auth.sub).map((gw) => ({
      id: gw.id,
      name: gw.name,
      status: gw.status,
      connected: hub.isGatewayConnected(gw.id),
      machineInfo: gw.machine_info ? JSON.parse(gw.machine_info) : null,
      lastSeen: gw.last_seen,
      createdAt: gw.created_at,
    }));

    return reply.send({ gateways });
  });

  // ── PATCH /api/gateways/:id — Rename gateway ────────────────

  app.patch<{
    Params: { id: string };
    Body: { name?: string };
  }>('/api/gateways/:id', async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;

    const { name } = request.body ?? {};
    if (!name) {
      return reply.status(400).send({ error: 'name required' });
    }

    const success = db.updateUserGateway(request.params.id, auth.sub, { name });
    if (!success) {
      return reply.status(404).send({ error: 'Gateway not found' });
    }

    return reply.send({ ok: true });
  });

  // ── DELETE /api/gateways/:id — Remove + revoke gateway ──────

  app.delete<{
    Params: { id: string };
  }>('/api/gateways/:id', async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;

    const success = db.deleteUserGateway(request.params.id, auth.sub);
    if (!success) {
      return reply.status(404).send({ error: 'Gateway not found' });
    }

    return reply.send({ ok: true });
  });

  // ══════════════════════════════════════════════════════════════
  // EXISTING ROUTES (backwards compat)
  // ══════════════════════════════════════════════════════════════

  // ── Pairing API ──────────────────────────────────────────────

  app.post<{
    Body: undefined;
    Headers: { authorization?: string };
  }>('/api/pairing/initiate', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Missing authorization' });
    }

    const token = auth.slice(7);
    const gateway = db.validateGatewayToken(token);
    if (!gateway) {
      return reply.status(401).send({ error: 'Invalid gateway token' });
    }

    const { code, expiresAt } = db.createPairingCode(gateway.id);
    return { code, expires: expiresAt, gatewayId: gateway.id };
  });

  app.post<{
    Body: { code: string; device_name?: string };
  }>('/api/pairing/exchange', async (request, reply) => {
    const { code, device_name } = request.body ?? {};
    if (!code) {
      return reply.status(400).send({ error: 'Missing pairing code' });
    }

    const result = db.exchangePairingCode(code, device_name ?? 'Unknown Device');
    if (!result) {
      return reply
        .status(400)
        .send({ error: 'Invalid or expired pairing code' });
    }

    return {
      app_token: result.appToken,
      gateway_id: result.gatewayId,
    };
  });

  // ── App request forwarding ───────────────────────────────────

  app.all<{
    Params: { '*': string };
    Headers: { authorization?: string };
  }>('/api/gateway/*', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Missing authorization' });
    }

    const token = auth.slice(7);
    const appInfo = db.validateAppToken(token);
    if (!appInfo) {
      return reply.status(401).send({ error: 'Invalid app token' });
    }

    if (!hub.isGatewayConnected(appInfo.gatewayId)) {
      return reply.status(502).send({
        error: 'gateway_offline',
        message: 'Gateway is not connected',
        retry_after: 5,
      });
    }

    const path = '/' + (request.params['*'] || '');
    const headers: Record<string, string> = {};
    for (const [key, val] of Object.entries(request.headers)) {
      if (
        key !== 'authorization' &&
        key !== 'host' &&
        typeof val === 'string'
      ) {
        headers[key] = val;
      }
    }
    headers['x-relay-app-id'] = appInfo.id;
    headers['x-relay-forwarded-for'] = request.ip;
    if (request.headers['x-request-id']) {
      headers['x-request-id'] = request.headers['x-request-id'] as string;
    }

    const accept = (request.headers.accept ?? '').toLowerCase();
    const isSSE = accept.includes('text/event-stream');

    if (isSSE) {
      // SSE streaming response
      try {
        let headersWritten = false;
        await hub.forwardRequest(
          appInfo.gatewayId,
          {
            method: request.method,
            path,
            headers,
            body:
              request.body != null ? JSON.stringify(request.body) : undefined,
          },
          {
            onHead: (head) => {
              // Write headers immediately when head arrives, BEFORE any data frames
              if (!headersWritten) {
                headersWritten = true;
                const origin = request.headers.origin || '*';
                reply.raw.writeHead(head.status, {
                  ...head.headers,
                  'cache-control': 'no-cache',
                  connection: 'keep-alive',
                  'access-control-allow-origin': origin,
                  'access-control-allow-credentials': 'true',
                  'access-control-expose-headers': 'x-relay-app-id',
                });
              }
            },
            onStreamData: (data) => {
              reply.raw.write(data);
            },
            onStreamEnd: () => {
              reply.raw.end();
            },
          },
        );
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Unknown error';
        return reply.status(502).send({ error: 'gateway_error', message });
      }
    } else {
      // Regular request/response
      try {
        const response = await hub.forwardRequest(appInfo.gatewayId, {
          method: request.method,
          path,
          headers,
          body: request.body != null ? JSON.stringify(request.body) : undefined,
        });

        reply.status(response.status).headers(response.headers).send(response.body);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Unknown error';
        return reply.status(502).send({ error: 'gateway_error', message });
      }
    }
  });

  // ── Real-time event stream (SSE) ─────────────────────────────

  const sseClients = new Set<{ res: import('http').ServerResponse; gatewayId: string }>();

  function broadcastEvent(gatewayId: string, event: string, data: unknown) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      if (client.gatewayId === gatewayId) {
        try { client.res.write(payload); } catch { sseClients.delete(client); }
      }
    }
  }

  // Emit events from hub to SSE clients
  hub.on('request', (info: { gatewayId: string; method: string; path: string }) => {
    broadcastEvent(info.gatewayId, 'request', {
      method: info.method,
      path: info.path,
      timestamp: Date.now(),
    });
  });

  hub.on('gateway:connected', (info: { id: string; name: string }) => {
    broadcastEvent(info.id, 'gateway:status', { connected: true, name: info.name });
  });

  hub.on('gateway:disconnected', (info: { id: string; reason: string }) => {
    broadcastEvent(info.id, 'gateway:status', { connected: false, reason: info.reason });
  });

  app.get<{
    Headers: { authorization?: string };
  }>('/api/events', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Missing authorization' });
    }

    const token = auth.slice(7);
    const appInfo = db.validateAppToken(token);
    if (!appInfo) {
      return reply.status(401).send({ error: 'Invalid app token' });
    }

    const origin = request.headers.origin || '*';
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
    });

    // Send initial connection event
    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ gatewayId: appInfo.gatewayId })}\n\n`);

    // Send current gateway status immediately so the client doesn't stay in "Checking..."
    const isGwConnected = hub.isGatewayConnected(appInfo.gatewayId);
    reply.raw.write(`event: gateway:status\ndata: ${JSON.stringify({ connected: isGwConnected })}\n\n`);

    const client = { res: reply.raw, gatewayId: appInfo.gatewayId };
    sseClients.add(client);

    // Keepalive ping every 15s
    const keepalive = setInterval(() => {
      try { reply.raw.write(': keepalive\n\n'); } catch { /* ignore */ }
    }, 15_000);

    request.raw.on('close', () => {
      clearInterval(keepalive);
      sseClients.delete(client);
    });
  });

  // ── RPC endpoint (app → relay → gateway shell) ───────────────

  app.post<{
    Body: { method: string; params?: Record<string, unknown> };
    Headers: { authorization?: string };
  }>('/rpc', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Missing authorization' });
    }
    const token = auth.slice(7);
    const appInfo = db.validateAppToken(token);
    if (!appInfo) {
      return reply.status(401).send({ error: 'Invalid app token' });
    }

    const { method, params = {} } = request.body ?? {};

    if (!hub.isGatewayConnected(appInfo.gatewayId)) {
      return reply.status(502).send({ error: { message: 'Gateway is not connected' } });
    }

    if (method === 'sessions.list') {
      // Forward sessions_list tool call through the tunnel to the gateway
      // Use activeMinutes param to widen the scope
      const limit = (params.limit as number) ?? 100;
      const activeMinutes = (params.activeMinutes as number) ?? 1440;
      try {
        const response = await hub.forwardRequest(appInfo.gatewayId, {
          method: 'POST',
          path: '/tools/invoke',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            tool: 'sessions_list',
            args: { limit, activeMinutes },
          }),
        });
        const text = response.body.toString('utf8');
        const json = JSON.parse(text);
        // Parse tool response — content[0].text has the JSON
        const content = json.result?.content ?? json.content ?? [];
        let sessions: unknown[] = [];
        if (content[0]?.text) {
          const parsed = JSON.parse(content[0].text);
          sessions = parsed.sessions ?? parsed.details?.sessions ?? [];
        }
        // Enrich with channel info from session key
        const enriched = (sessions as Array<Record<string, unknown>>).map((s) => {
          const key = (s.key || s.sessionKey || '') as string;
          const parts = key.split(':');
          return {
            ...s,
            key,
            agentId: s.agentId || parts[1] || 'main',
            channel: s.channel || parts[2] || 'unknown',
            kind: s.kind || parts[3] || 'direct',
            target: s.target || parts[4] || '',
          };
        });
        return reply.send({ result: { sessions: enriched, count: enriched.length } });
      } catch (err) {
        return reply.status(500).send({ error: { message: String(err) } });
      }
    }

    if (method === 'gateway.status') {
      try {
        const response = await hub.forwardRequest(appInfo.gatewayId, {
          method: 'GET',
          path: '/status',
          headers: {},
        });
        const text = response.body.toString('utf8');
        try {
          return reply.send({ result: JSON.parse(text) });
        } catch {
          return reply.send({ result: { raw: text } });
        }
      } catch (err) {
        return reply.status(500).send({ error: { message: String(err) } });
      }
    }

    return reply.status(400).send({ error: 'Unknown RPC method' });
  });

  // ── Admin / utility endpoints ────────────────────────────────

  app.get('/api/health', async () => {
    return {
      status: 'ok',
      gateways: hub.getConnectedGateways().length,
      uptime: process.uptime(),
    };
  });

  app.post<{
    Body: { gateway_id: string; gateway_name?: string };
    Headers: { authorization?: string };
  }>('/api/admin/gateway-token', async (request, reply) => {
    const { gateway_id, gateway_name } = request.body ?? {};
    if (!gateway_id) {
      return reply.status(400).send({ error: 'Missing gateway_id' });
    }
    const token = db.registerGatewayToken(
      gateway_id,
      gateway_name ?? gateway_id,
    );
    return { token, gateway_id };
  });

  app.get<{
    Headers: { authorization?: string };
  }>('/api/apps', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Missing authorization' });
    }

    const token = auth.slice(7);
    const gateway = db.validateGatewayToken(token);
    if (!gateway) {
      return reply.status(401).send({ error: 'Invalid gateway token' });
    }

    const apps = db.listApps(gateway.id);
    return { apps };
  });

  app.delete<{
    Params: { appId: string };
    Headers: { authorization?: string };
  }>('/api/apps/:appId', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Missing authorization' });
    }

    const token = auth.slice(7);
    const gateway = db.validateGatewayToken(token);
    if (!gateway) {
      return reply.status(401).send({ error: 'Invalid gateway token' });
    }

    const success = db.revokeApp(gateway.id, request.params.appId);
    if (!success) {
      return reply.status(404).send({ error: 'App not found' });
    }

    return { ok: true };
  });

  // ── Lifecycle ────────────────────────────────────────────────

  hub.start();

  async function listen(): Promise<string> {
    const address = await app.listen({ port, host });
    return address;
  }

  async function close(): Promise<void> {
    hub.stop();
    await app.close();
    db.close();
  }

  return { app, hub, db, listen, close };
}
