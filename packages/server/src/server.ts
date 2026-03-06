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
                reply.raw.writeHead(head.status, {
                  ...head.headers,
                  'cache-control': 'no-cache',
                  connection: 'keep-alive',
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
