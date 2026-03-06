#!/usr/bin/env node

import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, extname, normalize, sep, dirname } from 'node:path';
import { homedir } from 'node:os';
import { Command } from 'commander';
import { GatewayClient } from './client.js';
import { callOpenClawRpc, getOpenClawAgents } from './openclaw-rpc.js';

// ── Workspace file serving ────────────────────────────────────
const WORKSPACE_DIR = resolve(homedir(), '.openclaw', 'workspace');

function isPathSafe(filePath: string): boolean {
  const resolved = resolve(filePath);
  return resolved.startsWith(WORKSPACE_DIR + sep) || resolved === WORKSPACE_DIR;
}

function serveWorkspace(url: string): { status: number; headers: Record<string, string>; body: string } | null {
  const parsed = new URL(url, 'http://localhost');
  const pathname = parsed.pathname;

  // Directory listing: /api/workspace/?dir=memory
  if (pathname === '/api/workspace/' || pathname === '/api/workspace') {
    const dirParam = parsed.searchParams.get('dir');
    const safeDirName = dirParam ? normalize(dirParam).replace(/^(\.\.[\\/])+/, '') : '';
    const dirPath = safeDirName ? join(WORKSPACE_DIR, safeDirName) : WORKSPACE_DIR;

    if (!isPathSafe(dirPath)) {
      return { status: 403, headers: {}, body: JSON.stringify({ error: 'Path traversal blocked' }) };
    }

    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });
      const files = entries
        .filter((e: any) => !e.name.startsWith('.'))
        .map((e: any) => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
          ext: extname(e.name).slice(1).toLowerCase(),
        }));
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(files) };
    } catch {
      return { status: 404, headers: {}, body: JSON.stringify({ error: 'Directory not found' }) };
    }
  }

  // File serving: /api/workspace/<path>
  const match = pathname.match(/^\/api\/workspace\/(.+?)$/);
  if (!match) return null;

  const rawPath = decodeURIComponent(match[1]);
  const filePath = resolve(WORKSPACE_DIR, rawPath);

  if (!isPathSafe(filePath)) {
    return { status: 403, headers: {}, body: JSON.stringify({ error: 'Path traversal blocked' }) };
  }

  try {
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      const entries = readdirSync(filePath, { withFileTypes: true });
      const files = entries
        .filter((e: any) => !e.name.startsWith('.'))
        .map((e: any) => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
          ext: extname(e.name).slice(1).toLowerCase(),
        }));
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(files) };
    }

    const ext = extname(filePath).toLowerCase();
    const textExts = new Set(['.md', '.txt', '.json', '.ts', '.tsx', '.js', '.jsx', '.py', '.sh', '.yml', '.yaml', '.toml', '.csv', '.html', '.css', '.env']);

    if (textExts.has(ext)) {
      const content = readFileSync(filePath, 'utf8');
      const ct = ext === '.json' ? 'application/json' : 'text/plain; charset=utf-8';
      return { status: 200, headers: { 'content-type': ct }, body: content };
    }

    // Binary files: base64
    const content = readFileSync(filePath).toString('base64');
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
      '.apk': 'application/vnd.android.package-archive',
    };
    const ct = mimeTypes[ext] || 'application/octet-stream';
    return { status: 200, headers: { 'content-type': ct, 'x-encoding': 'base64' }, body: content };
  } catch {
    return { status: 404, headers: {}, body: `File not found: ${rawPath}` };
  }
}

const program = new Command();

program
  .name('openclaw-relay')
  .description('OpenClaw Relay Gateway CLI')
  .version('0.1.0');

program
  .command('connect')
  .description('Connect gateway to relay server')
  .requiredOption('--token <token>', 'Gateway token (gw_live_xxx)')
  .requiredOption('--upstream <url>', 'Local HTTP server to tunnel to')
  .option('--relay <url>', 'Relay WebSocket URL', 'ws://localhost:8080/v1/tunnel')
  .option('--name <name>', 'Gateway display name')
  .option('--openclaw-token <token>', 'OpenClaw gateway token for RPC sidecar')
  .option('--sidecar-port <port>', 'Port for JSON sidecar server', '18790')
  .action(async (opts) => {
    const upstreamUrl = opts.upstream as string;
    const sidecarPort = parseInt(opts.sidecarPort, 10);

    // Build WS URL for OpenClaw RPC (same host as upstream, ws:// protocol)
    const ocWsUrl = upstreamUrl.replace(/^http/, 'ws');
    const ocToken = opts.openclawToken as string | undefined;

    // Start a JSON sidecar HTTP server that translates REST → OpenClaw WS RPC
    const sidecar = createServer(async (req, res) => {
      const url = req.url ?? '/';
      res.setHeader('Content-Type', 'application/json');

      try {
        // Workspace file serving (intercepted locally, never forwarded)
        if (req.method === 'GET' && url.startsWith('/api/workspace')) {
          const result = serveWorkspace(url);
          if (result) {
            res.statusCode = result.status;
            for (const [k, v] of Object.entries(result.headers)) {
              res.setHeader(k, v);
            }
            res.end(result.body);
            return;
          }
        }

        if (url === '/api/agents' || url.startsWith('/api/agents?')) {
          if (!ocToken) { res.end(JSON.stringify([])); return; }
          const agents = await getOpenClawAgents(ocWsUrl, ocToken);
          res.end(JSON.stringify(agents));
          return;
        }

        if (url === '/api/sessions' || url.startsWith('/api/sessions?')) {
          if (!ocToken) { res.end(JSON.stringify({ sessions: [] })); return; }
          const status = await callOpenClawRpc<{ sessions?: { paths?: string[] } }>(
            ocWsUrl, ocToken, 'status',
          );
          const paths = status.sessions?.paths ?? [];
          const sessions = paths.map((p) => {
            const parts = p.split('/');
            const key = parts[parts.length - 1] ?? p;
            const [agentId, ...rest] = key.split(':');
            return { key, agentId: agentId ?? 'main', threadId: rest.join(':') || key, createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(), messageCount: 0 };
          });
          res.end(JSON.stringify({ sessions }));
          return;
        }

        if (url === '/api/health') {
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        // Everything else: proxy to upstream with gateway auth
        const proxyHeaders = Object.fromEntries(
          Object.entries(req.headers).filter(([, v]) => typeof v === 'string') as [string, string][]
        );
        // Inject gateway auth token for the upstream OpenClaw gateway
        if (ocToken) {
          proxyHeaders['authorization'] = `Bearer ${ocToken}`;
        }
        delete proxyHeaders['host'];
        delete proxyHeaders['connection'];

        // Collect body for non-GET requests
        let reqBody: string | undefined;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          reqBody = await new Promise<string>((resolve) => {
            let body = '';
            req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
            req.on('end', () => resolve(body));
          });
        }

        const proxyRes = await fetch(`${upstreamUrl}${url}`, {
          method: req.method,
          headers: proxyHeaders,
          ...(reqBody ? { body: reqBody } : {}),
        });

        res.statusCode = proxyRes.status;

        // Check if this is an SSE stream — pipe it instead of buffering
        const ct = proxyRes.headers.get('content-type') || '';
        const isSSE = ct.includes('text/event-stream');
        const acceptsSSE = (req.headers.accept || '').includes('text/event-stream');

        if ((isSSE || acceptsSSE) && proxyRes.body) {
          // Pipe SSE stream through
          for (const [k, v] of proxyRes.headers.entries()) {
            if (k !== 'transfer-encoding') res.setHeader(k, v);
          }
          res.setHeader('cache-control', 'no-cache');
          res.setHeader('connection', 'keep-alive');
          res.flushHeaders();

          const reader = (proxyRes.body as any).getReader();
          const decoder = new TextDecoder();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(decoder.decode(value, { stream: true }));
            }
          } catch {
            // Client disconnected
          } finally {
            res.end();
          }
        } else {
          // Buffer normal responses
          for (const [k, v] of proxyRes.headers.entries()) {
            if (k !== 'transfer-encoding') res.setHeader(k, v);
          }
          const text = await proxyRes.text();
          res.end(text);
        }
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'unknown' }));
      }
    });

    await new Promise<void>((resolve) => sidecar.listen(sidecarPort, '127.0.0.1', resolve));
    console.log(`  Sidecar running on http://127.0.0.1:${sidecarPort}`);

    const client = new GatewayClient({
      relayUrl: opts.relay,
      token: opts.token,
      upstream: `http://127.0.0.1:${sidecarPort}`,
      upstreamToken: ocToken, // Inject OpenClaw gateway auth on tunneled requests
      gatewayName: opts.name,
    });

    client.on('connected', ({ gatewayId }) => {
      console.log(`\n  Connected to relay as gateway: ${gatewayId}`);
      console.log(`  Forwarding to: ${upstreamUrl} (via sidecar)`);
      console.log(`  Press Ctrl+C to disconnect.\n`);
    });

    client.on('disconnected', ({ reason }) => {
      console.log(`  Disconnected: ${reason}`);
    });

    client.on('request', ({ method, path }) => {
      console.log(`  ${method} ${path}`);
    });

    client.on('error', ({ error }) => {
      console.error(`  Error: ${error.message}`);
    });

    process.on('SIGINT', async () => {
      console.log('\n  Disconnecting...');
      await client.disconnect();
      process.exit(0);
    });

    try {
      await client.connect();
    } catch (err) {
      console.error(
        `Failed to connect: ${err instanceof Error ? err.message : err}`,
      );
      process.exit(1);
    }
  });

program
  .command('pair')
  .description('Generate a pairing code for mobile app')
  .requiredOption('--token <token>', 'Gateway token (gw_live_xxx)')
  .option('--relay <url>', 'Relay HTTP URL', 'http://localhost:8080')
  .option('--name <name>', 'Gateway display name')
  .action(async (opts) => {
    const client = new GatewayClient({
      relayUrl: opts.relay.replace(/^http/, 'ws') + '/v1/tunnel',
      token: opts.token,
      gatewayName: opts.name,
      reconnect: false,
    });

    try {
      const { code, expiresAt } = await client.createPairingCode(opts.relay);
      const expires = new Date(expiresAt);
      const remaining = Math.ceil(
        (expires.getTime() - Date.now()) / 1000 / 60,
      );

      console.log('\n  Pairing Mode');
      console.log('  ' + '─'.repeat(40));
      console.log();

      // Generate QR code in terminal
      const deepLink = `agentdraw://pair?code=${code}&relay=${new URL(opts.relay).host}&name=${encodeURIComponent(opts.name ?? 'Gateway')}`;

      try {
        const qrcode = await import('qrcode-terminal');
        qrcode.default.generate(deepLink, { small: true }, (qr: string) => {
          console.log('  Scan this QR code with AgentDraw:\n');
          for (const line of qr.split('\n')) {
            console.log('    ' + line);
          }
        });
      } catch {
        console.log(`  QR link: ${deepLink}`);
      }

      console.log();
      console.log(`  Or enter this code manually: ${code}`);
      console.log(`  Expires in ${remaining} minutes`);
      console.log();
      console.log('  Waiting for connection...');

      // Poll until code is used or expires
      const pollInterval = setInterval(async () => {
        if (Date.now() > expires.getTime()) {
          clearInterval(pollInterval);
          console.log('\n  Pairing code expired.');
          process.exit(1);
        }
      }, 5000);

      process.on('SIGINT', () => {
        clearInterval(pollInterval);
        console.log('\n  Cancelled.');
        process.exit(0);
      });
    } catch (err) {
      console.error(
        `Failed to create pairing code: ${err instanceof Error ? err.message : err}`,
      );
      process.exit(1);
    }
  });

program
  .command('devices')
  .description('List connected app devices')
  .requiredOption('--token <token>', 'Gateway token (gw_live_xxx)')
  .option('--relay <url>', 'Relay HTTP URL', 'http://localhost:8080')
  .action(async (opts) => {
    const client = new GatewayClient({
      relayUrl: opts.relay.replace(/^http/, 'ws') + '/v1/tunnel',
      token: opts.token,
      reconnect: false,
    });

    try {
      const apps = await client.listApps(opts.relay);

      console.log('\n  Connected Devices');
      console.log('  ' + '─'.repeat(40));

      if (apps.length === 0) {
        console.log('\n  No devices connected.');
        console.log('  Run `openclaw-relay pair` to connect a device.\n');
      } else {
        for (const [i, app] of apps.entries()) {
          console.log(`\n  ${i + 1}. ${app.deviceName}`);
          console.log(`     ID: ${app.id}`);
          console.log(`     Connected: ${app.createdAt}`);
          console.log(`     Last active: ${app.lastUsedAt}`);
        }
        console.log();
      }
    } catch (err) {
      console.error(
        `Failed to list devices: ${err instanceof Error ? err.message : err}`,
      );
      process.exit(1);
    }
  });

program.parse();
