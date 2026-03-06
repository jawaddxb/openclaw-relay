import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';
import { WebSocketHub } from './hub.js';
import { RelayDB } from './db.js';

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
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'x-openclaw-agent-id', 'x-openclaw-session-key'],
    exposedHeaders: ['x-relay-app-id'],
    credentials: true,
  });
  await app.register(fastifyWebsocket);

  // ── WebSocket tunnel endpoint ──────────────────────────────────
  app.register(async function wsRoutes(fastify) {
    fastify.get(
      '/v1/tunnel',
      { websocket: true },
      (socket, _req) => {
        hub.handleGatewayConnection(socket, (token) =>
          db.validateGatewayToken(token),
        );
      },
    );
  });

  // ── Pairing API ────────────────────────────────────────────────

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

  // ── App request forwarding ─────────────────────────────────────

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

  // ── Real-time event stream (SSE) ────────────────────────────────

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

  // ── RPC endpoint (app → relay → gateway shell) ─────────────────

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

    if (method === 'sessions.list') {
      // Shell out to openclaw status --json to get full sessions list
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      try {
        const { stdout } = await execAsync('openclaw status --json', { timeout: 10_000 });
        const status = JSON.parse(stdout);
        const recent = (status.sessions?.recent ?? []) as Array<{
          key: string;
          agentId: string;
          sessionId: string;
          updatedAt: number;
          kind?: string;
        }>;

        const limit = (params.limit as number) ?? 50;
        const activeMinutes = (params.activeMinutes as number) ?? 60;
        const cutoff = Date.now() - activeMinutes * 60 * 1000;

        const sessions = recent
          .filter((s) => !activeMinutes || s.updatedAt > cutoff)
          .slice(0, limit)
          .map((s) => {
            const parts = s.key.split(':');
            // key format: agent:<agentId>:<channel>:<kind>:<target>
            const channel = parts[2] ?? 'unknown';
            const kind = parts[3] ?? 'direct';
            const target = parts[4] ?? '';
            return {
              key: s.key,
              agentId: s.agentId,
              sessionId: s.sessionId,
              channel,
              kind,
              target,
              updatedAt: s.updatedAt,
            };
          });

        return reply.send({ result: { sessions, count: sessions.length } });
      } catch (err) {
        return reply.status(500).send({ error: { message: String(err) } });
      }
    }

    if (method === 'gateway.status') {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      try {
        const { stdout } = await execAsync('openclaw status --json', { timeout: 10_000 });
        const status = JSON.parse(stdout);
        return reply.send({
          result: {
            channels: status.channels ?? {},
            sessions: { count: status.sessions?.count ?? 0 },
            agents: (status.agents ?? []).map((a: { agentId: string; model?: string }) => ({
              agentId: a.agentId,
              model: a.model,
            })),
          },
        });
      } catch (err) {
        return reply.status(500).send({ error: { message: String(err) } });
      }
    }

    return reply.status(400).send({ error: 'Unknown RPC method' });
  });

  // ── Admin / utility endpoints ──────────────────────────────────

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

  // ── Lifecycle ──────────────────────────────────────────────────

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
