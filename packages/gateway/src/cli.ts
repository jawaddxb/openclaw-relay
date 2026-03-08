import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync, appendFileSync, unlinkSync } from 'node:fs';
import { resolve, join, extname, normalize, sep, dirname } from 'node:path';
import { homedir, hostname, platform, arch } from 'node:os';
import crypto from 'node:crypto';
import { Command } from 'commander';
import { GatewayClient } from './client.js';
import { callOpenClawRpc, getOpenClawAgents } from './openclaw-rpc.js';

// ── Workspace file serving ────────────────────────────────────
const WORKSPACE_DIR = resolve(homedir(), '.openclaw', 'workspace');
const AGENTS_DIR = resolve(homedir(), '.openclaw', 'agents');
const MEMORY_DIR = resolve(homedir(), '.openclaw', 'workspace', 'memory');
const BRIEFINGS_DIR = join(MEMORY_DIR, 'briefings');
const RETROS_DIR = join(MEMORY_DIR, 'retros');
const SKILLS_GLOBAL_DIR = '/opt/homebrew/lib/node_modules/openclaw/skills';

import type { IncomingMessage, ServerResponse } from 'node:http';

function jsonRes(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function appendJsonl(filePath: string, obj: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(obj) + '\n');
}

function readJsonl(filePath: string): unknown[] {
  try {
    const raw = readFileSync(filePath, 'utf8');
    return raw.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(x => x !== null);
  } catch { return []; }
}

function collectBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
  });
}

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

const DEFAULT_RELAY = process.env.AGENTDRAW_DEFAULT_RELAY || 'https://divine-freedom-production.up.railway.app';
const DEFAULT_WS_RELAY = DEFAULT_RELAY.replace(/^https?/, 'wss') + '/v1/tunnel';

const program = new Command();

program
  .name('agentdraw')
  .description('AgentDraw — Connect your AI agents to the cloud')
  .version('0.1.0');

program
  .command('connect')
  .description('Connect gateway to relay server')
  .requiredOption('--token <token>', 'Gateway token (gw_live_xxx)')
  .requiredOption('--upstream <url>', 'Local HTTP server to tunnel to')
  .option('--relay <url>', 'Relay WebSocket URL', DEFAULT_WS_RELAY)
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
      res.setHeader('Access-Control-Allow-Origin', '*');

      try {
        // CORS preflight
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Max-Age': '86400',
          });
          res.end();
          return;
        }

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

        if ((url === '/api/sessions' || url.startsWith('/api/sessions?')) && !url.startsWith('/api/sessions/')) {
          try {
            const { readFileSync, readdirSync, existsSync } = await import('fs');
            const { join } = await import('path');
            const homeDir = process.env.HOME || '/root';
            const agentsDir = join(homeDir, '.openclaw', 'agents');
            const allSessions: Array<Record<string, unknown>> = [];

            // Scan all agent session files directly from filesystem
            if (existsSync(agentsDir)) {
              for (const agentId of readdirSync(agentsDir)) {
                const sessFile = join(agentsDir, agentId, 'sessions', 'sessions.json');
                try {
                  if (!existsSync(sessFile)) continue;
                  const raw = readFileSync(sessFile, 'utf8');
                  const entries = JSON.parse(raw) as Record<string, Record<string, unknown>>;
                  for (const [key, value] of Object.entries(entries)) {
                    const parts = key.split(':');
                    allSessions.push({
                      key,
                      agentId: parts[1] || agentId,
                      channel: (value as Record<string, unknown>).channel as string
                        || (value as Record<string, unknown>).lastChannel as string
                        || parts[2] || 'unknown',
                      kind: parts[3] || 'direct',
                      target: parts.slice(4).join(':') || '',
                      sessionId: (value as Record<string, unknown>).sessionId,
                      updatedAt: (value as Record<string, unknown>).updatedAt,
                      displayName: (value as Record<string, unknown>).displayName,
                      model: (value as Record<string, unknown>).model,
                      totalTokens: (value as Record<string, unknown>).totalTokens,
                      chatType: (value as Record<string, unknown>).chatType,
                    });
                  }
                } catch { /* file not readable */ }
              }
            }

            // Sort by updatedAt descending
            allSessions.sort((a, b) => ((b.updatedAt as number) || 0) - ((a.updatedAt as number) || 0));

            res.end(JSON.stringify({ sessions: allSessions, count: allSessions.length }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'unknown', sessions: [] }));
          }
          return;
        }

        if (url === '/api/health') {
          jsonRes(res, 200, { ok: true });
          return;
        }

        // ── GET /api/usage ────────────────────────────────────
        if (req.method === 'GET' && url === '/api/usage') {
          const MODEL_RATES: Record<string, { input: number; output: number }> = {
            opus: { input: 15, output: 75 },
            sonnet: { input: 3, output: 15 },
            'gpt-4o': { input: 5, output: 15 },
          };
          const DEFAULT_RATE = { input: 3, output: 15 };

          const sessFile = join(AGENTS_DIR, 'main', 'sessions', 'sessions.json');
          let sessions: Record<string, Record<string, unknown>> = {};
          try { sessions = JSON.parse(readFileSync(sessFile, 'utf8')); } catch { /* empty */ }

          const now = new Date();
          const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
          const weekStart = todayStart - (now.getDay() * 86400000);
          const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

          const periods = { today: { tokens: 0, cost: 0 }, week: { tokens: 0, cost: 0 }, month: { tokens: 0, cost: 0 }, allTime: { tokens: 0, cost: 0 } };
          const byModel: Record<string, { tokens: number; cost: number; sessions: number }> = {};

          for (const sess of Object.values(sessions)) {
            const updatedAt = (sess.updatedAt as number) || 0;
            const inputTokens = (sess.inputTokens as number) || 0;
            const outputTokens = (sess.outputTokens as number) || 0;
            const totalTokens = inputTokens + outputTokens;
            const modelStr = ((sess.model as string) || 'unknown').toLowerCase();

            let rateKey = Object.keys(MODEL_RATES).find(k => modelStr.includes(k));
            const rate = rateKey ? MODEL_RATES[rateKey] : DEFAULT_RATE;
            const cost = (inputTokens / 1_000_000) * rate.input + (outputTokens / 1_000_000) * rate.output;

            const modelName = (sess.model as string) || 'unknown';
            if (!byModel[modelName]) byModel[modelName] = { tokens: 0, cost: 0, sessions: 0 };
            byModel[modelName].tokens += totalTokens;
            byModel[modelName].cost += cost;
            byModel[modelName].sessions += 1;

            periods.allTime.tokens += totalTokens;
            periods.allTime.cost += cost;
            if (updatedAt >= monthStart) { periods.month.tokens += totalTokens; periods.month.cost += cost; }
            if (updatedAt >= weekStart) { periods.week.tokens += totalTokens; periods.week.cost += cost; }
            if (updatedAt >= todayStart) { periods.today.tokens += totalTokens; periods.today.cost += cost; }
          }

          // Round costs
          for (const p of Object.values(periods)) { p.cost = Math.round(p.cost * 100) / 100; }
          for (const m of Object.values(byModel)) { m.cost = Math.round(m.cost * 100) / 100; }

          jsonRes(res, 200, { ...periods, byModel });
          return;
        }

        // ── GET/POST /api/missions ────────────────────────────
        const parsedUrl = new URL(url, 'http://localhost');
        const pathname = parsedUrl.pathname;

        if (pathname === '/api/missions') {
          const missionsFile = join(MEMORY_DIR, 'missions.jsonl');
          if (req.method === 'GET') {
            const limit = parseInt(parsedUrl.searchParams.get('limit') || '50', 10);
            const all = readJsonl(missionsFile);
            const missions = all.slice(-limit).reverse();
            jsonRes(res, 200, { missions, total: all.length });
            return;
          }
          if (req.method === 'POST') {
            const body = await collectBody(req);
            const obj = JSON.parse(body);
            appendJsonl(missionsFile, obj);
            jsonRes(res, 200, { ok: true });
            return;
          }
        }

        // ── GET/POST /api/outputs ─────────────────────────────
        if (pathname === '/api/outputs') {
          const outputsFile = join(MEMORY_DIR, 'outputs.jsonl');
          if (req.method === 'GET') {
            const limit = parseInt(parsedUrl.searchParams.get('limit') || '50', 10);
            const all = readJsonl(outputsFile);
            const outputs = all.slice(-limit).reverse();
            jsonRes(res, 200, { outputs, total: all.length });
            return;
          }
          if (req.method === 'POST') {
            const body = await collectBody(req);
            const obj = JSON.parse(body);
            appendJsonl(outputsFile, obj);
            jsonRes(res, 200, { ok: true });
            return;
          }
        }

        // ── GET/POST /api/briefings, GET /api/briefings/:filename ──
        if (pathname === '/api/briefings') {
          if (req.method === 'GET') {
            mkdirSync(BRIEFINGS_DIR, { recursive: true });
            const files = readdirSync(BRIEFINGS_DIR).filter(f => f.endsWith('.md'));
            const result = files.map(filename => {
              const fp = join(BRIEFINGS_DIR, filename);
              const content = readFileSync(fp, 'utf8');
              const lines = content.split('\n').slice(0, 5);
              const titleLine = lines.find(l => l.startsWith('# '));
              const title = titleLine ? titleLine.replace(/^#\s+/, '') : filename;
              const tagsLine = lines.find(l => l.startsWith('Tags:'));
              const tags = tagsLine ? tagsLine.replace(/^Tags:\s*/, '').split(',').map(t => t.trim()) : [];
              const st = statSync(fp);
              const date = filename.replace(/\.md$/, '');
              return { filename, title, date, tags, size: st.size };
            });
            jsonRes(res, 200, result);
            return;
          }
          if (req.method === 'POST') {
            const body = await collectBody(req);
            const { filename, content } = JSON.parse(body);
            mkdirSync(BRIEFINGS_DIR, { recursive: true });
            const safeName = normalize(filename).replace(/^(\.\.[\\/])+/, '');
            writeFileSync(join(BRIEFINGS_DIR, safeName), content);
            jsonRes(res, 200, { ok: true });
            return;
          }
        }

        if (pathname.startsWith('/api/briefings/') && req.method === 'GET') {
          const filename = decodeURIComponent(pathname.replace('/api/briefings/', ''));
          const fp = resolve(BRIEFINGS_DIR, filename);
          if (!fp.startsWith(BRIEFINGS_DIR + sep) && fp !== BRIEFINGS_DIR) {
            jsonRes(res, 403, { error: 'Path traversal blocked' });
            return;
          }
          try {
            const content = readFileSync(fp, 'utf8');
            jsonRes(res, 200, { filename, content });
          } catch { jsonRes(res, 404, { error: 'Not found' }); }
          return;
        }

        // ── GET /api/retros, GET /api/retros/:filename ────────
        if (pathname === '/api/retros' && req.method === 'GET') {
          mkdirSync(RETROS_DIR, { recursive: true });
          const files = readdirSync(RETROS_DIR).filter(f => f.endsWith('.md'));
          const result = files.map(filename => {
            const fp = join(RETROS_DIR, filename);
            const st = statSync(fp);
            const content = readFileSync(fp, 'utf8');
            const titleLine = content.split('\n').find(l => l.startsWith('# '));
            const title = titleLine ? titleLine.replace(/^#\s+/, '') : filename;
            const week = filename.replace(/\.md$/, '');
            return { filename, week, title, size: st.size };
          });
          jsonRes(res, 200, result);
          return;
        }

        if (pathname.startsWith('/api/retros/') && req.method === 'GET') {
          const filename = decodeURIComponent(pathname.replace('/api/retros/', ''));
          const fp = resolve(RETROS_DIR, filename);
          if (!fp.startsWith(RETROS_DIR + sep) && fp !== RETROS_DIR) {
            jsonRes(res, 403, { error: 'Path traversal blocked' });
            return;
          }
          try {
            const content = readFileSync(fp, 'utf8');
            jsonRes(res, 200, { filename, content });
          } catch { jsonRes(res, 404, { error: 'Not found' }); }
          return;
        }

        // ── GET /api/skills ───────────────────────────────────
        if (pathname === '/api/skills' && req.method === 'GET') {
          const skills: Array<{ name: string; description: string; path: string; isLocal: boolean }> = [];

          const scanDir = (dir: string, isLocal: boolean) => {
            try {
              for (const name of readdirSync(dir)) {
                const skillMd = join(dir, name, 'SKILL.md');
                try {
                  const raw = readFileSync(skillMd, 'utf8');
                  // Skip frontmatter, get first sentence
                  const lines = raw.split('\n');
                  let descStart = 0;
                  if (lines[0]?.trim() === '---') {
                    descStart = lines.indexOf('---', 1) + 1;
                  }
                  const descLines = lines.slice(descStart).filter(l => l.trim().length > 0);
                  const firstSentence = descLines[0]?.replace(/\.\s.*$/, '.') || name;
                  skills.push({ name, description: firstSentence, path: join(dir, name), isLocal });
                } catch { /* no SKILL.md */ }
              }
            } catch { /* dir doesn't exist */ }
          };

          scanDir(WORKSPACE_DIR, true);
          scanDir(SKILLS_GLOBAL_DIR, false);
          jsonRes(res, 200, { skills });
          return;
        }

        // ── GET /api/sessions/list ────────────────────────────
        if (pathname === '/api/sessions/list' && req.method === 'GET') {
          const allSessions: Array<Record<string, unknown>> = [];
          try {
            if (existsSync(AGENTS_DIR)) {
              for (const agentId of readdirSync(AGENTS_DIR)) {
                const sessFile = join(AGENTS_DIR, agentId, 'sessions', 'sessions.json');
                try {
                  if (!existsSync(sessFile)) continue;
                  const entries = JSON.parse(readFileSync(sessFile, 'utf8')) as Record<string, Record<string, unknown>>;
                  for (const [key, value] of Object.entries(entries)) {
                    const parts = key.split(':');
                    allSessions.push({
                      key,
                      agentId: parts[1] || agentId,
                      channel: (value.channel as string) || (value.lastChannel as string) || parts[2] || 'unknown',
                      kind: parts[3] || 'direct',
                      target: parts.slice(4).join(':') || '',
                      sessionId: value.sessionId,
                      updatedAt: value.updatedAt,
                      displayName: value.displayName,
                      model: value.model,
                      totalTokens: value.totalTokens,
                      inputTokens: value.inputTokens,
                      outputTokens: value.outputTokens,
                      chatType: value.chatType,
                    });
                  }
                } catch { /* skip */ }
              }
            }
          } catch { /* skip */ }
          allSessions.sort((a, b) => ((b.updatedAt as number) || 0) - ((a.updatedAt as number) || 0));
          jsonRes(res, 200, allSessions.slice(0, 200));
          return;
        }

        // ── GET /api/sessions/:encodedKey/history ─────────────
        const historyMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/history$/);
        if (historyMatch && req.method === 'GET') {
          const encodedKey = historyMatch[1];
          const sessionKey = decodeURIComponent(encodedKey);
          const limit = parseInt(parsedUrl.searchParams.get('limit') || '50', 10);

          // Find sessionId from sessions.json
          let sessionId: string | null = null;
          try {
            for (const agentId of readdirSync(AGENTS_DIR)) {
              const sessFile = join(AGENTS_DIR, agentId, 'sessions', 'sessions.json');
              try {
                const entries = JSON.parse(readFileSync(sessFile, 'utf8')) as Record<string, Record<string, unknown>>;
                if (entries[sessionKey]) {
                  sessionId = entries[sessionKey].sessionId as string;
                  break;
                }
              } catch { continue; }
            }
          } catch { /* skip */ }

          if (!sessionId) {
            jsonRes(res, 404, { error: 'Session not found', messages: [] });
            return;
          }

          // Find and read the JSONL history file
          // Files can be UUID.jsonl or UUID-topic-SLUG.jsonl
          let messages: Array<Record<string, unknown>> = [];
          try {
            for (const agentId of readdirSync(AGENTS_DIR)) {
              const sessDir = join(AGENTS_DIR, agentId, 'sessions');
              if (!existsSync(sessDir)) continue;

              // Try exact UUID.jsonl first, then glob UUID-topic-*.jsonl
              let histFile = join(sessDir, `${sessionId}.jsonl`);
              if (!existsSync(histFile)) {
                const files = readdirSync(sessDir).filter(f => f.startsWith(`${sessionId}-`) && f.endsWith('.jsonl') && !f.includes('.deleted'));
                if (files.length > 0) histFile = join(sessDir, files[0]);
                else continue;
              }

              const raw = readJsonl(histFile) as Array<Record<string, unknown>>;
              messages = raw
                .filter(m => {
                  // OpenClaw JSONL has type-based entries; we want 'message' type
                  // or direct role-based entries (user/assistant)
                  const typ = m.type as string | undefined;
                  const role = m.role as string | undefined;
                  if (typ === 'message') return true;
                  if (role === 'user' || role === 'assistant') return true;
                  return false;
                })
                .map(m => {
                  // Handle nested message format: { type: 'message', message: { role, content } }
                  const nested = m.message as Record<string, unknown> | undefined;
                  const role = nested?.role || m.role || 'unknown';
                  const rawContent = nested?.content ?? m.content ?? '';
                  // Content can be string or array of { type: 'text', text: '...' }
                  let content = '';
                  if (typeof rawContent === 'string') {
                    content = rawContent;
                  } else if (Array.isArray(rawContent)) {
                    content = (rawContent as Array<{ type?: string; text?: string }>)
                      .filter(c => c.type === 'text')
                      .map(c => c.text || '')
                      .join('\n');
                  }
                  return {
                    role,
                    content,
                    timestamp: m.timestamp || nested?.timestamp || null,
                  };
                })
                .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content.trim().length > 0);
              break;
            }
          } catch { /* skip */ }

          jsonRes(res, 200, { messages: messages.slice(-limit) });
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
          reqBody = await collectBody(req);
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
  .option('--relay <url>', 'Relay HTTP URL', DEFAULT_RELAY)
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
  .option('--relay <url>', 'Relay HTTP URL', DEFAULT_RELAY)
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
        console.log('  Run `agentdraw pair` to connect a device.\n');
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

// ══════════════════════════════════════════════════════════════
// Config file helpers (~/.agentdraw/config.json)
// ══════════════════════════════════════════════════════════════

const CONFIG_DIR = resolve(homedir(), '.agentdraw');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

interface AgentDrawConfig {
  relay_url: string;
  gateway_id: string;
  gateway_token: string;
  user_email?: string;
  machine_id?: string;
  linked_at: string;
}

function loadConfig(): AgentDrawConfig | null {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveConfig(config: AgentDrawConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}

function deleteConfig(): void {
  try { unlinkSync(CONFIG_FILE); } catch { /* ignore */ }
}

function getMachineInfo(): { hostname: string; os: string; arch: string; version: string } {
  return {
    hostname: hostname(),
    os: platform(),
    arch: arch(),
    version: '0.1.0',
  };
}

function getMachineId(info: { hostname: string; os: string; arch: string }): string {
  return crypto.createHash('sha256').update(`${info.hostname}|${info.os}|${info.arch}`).digest('hex');
}

// ══════════════════════════════════════════════════════════════
// link command — Device auth + QR code flow
// ══════════════════════════════════════════════════════════════

program
  .command('link [token]')
  .description('Link this gateway to your AgentDraw account')
  .option('--relay <url>', 'Relay HTTP URL', DEFAULT_RELAY)
  .option('--name <name>', 'Gateway display name')
  .action(async (token: string | undefined, opts: { relay: string; name?: string }) => {
    if (token) {
      // Link token redemption flow
      await redeemLinkTokenFlow(token, opts);
    } else {
      // Device auth flow (interactive)
      await deviceAuthFlow(opts);
    }
  });

async function deviceAuthFlow(opts: { relay: string; name?: string }): Promise<void> {
  const relayUrl = opts.relay;
  const machineInfo = getMachineInfo();

  console.log('\n  AgentDraw Gateway Link');
  console.log('  ' + '─'.repeat(44));
  console.log();
  console.log('  Starting device authorization...');

  // Step 1: Initiate device auth
  let deviceRes: {
    device_code: string;
    user_code: string;
    verification_url: string;
    expires_at: number;
    interval: number;
  };

  try {
    const res = await fetch(`${relayUrl}/api/auth/device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machine_info: machineInfo }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${res.status}: ${body}`);
    }
    deviceRes = await res.json() as typeof deviceRes;
  } catch (err) {
    console.error(`  Failed to start device auth: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // Step 2: Show QR code + text instructions
  const verificationUrl = `${deviceRes.verification_url}?c=${deviceRes.user_code}`;

  try {
    const qrcode = await import('qrcode-terminal');
    qrcode.default.generate(verificationUrl, { small: true }, (qr: string) => {
      console.log();
      for (const line of qr.split('\n')) {
        console.log('    ' + line);
      }
    });
  } catch {
    console.log(`  QR link: ${verificationUrl}`);
  }

  console.log();
  console.log(`  Or visit:  ${deviceRes.verification_url}`);
  console.log(`  Enter code: ${deviceRes.user_code}`);
  console.log();
  console.log('  Waiting for authorization...');

  // Step 3: Poll for token
  const interval = (deviceRes.interval || 5) * 1000;
  const expiresAt = deviceRes.expires_at;

  const result = await new Promise<{ gateway_token: string; gateway_id: string } | null>((resolve) => {
    const poll = async () => {
      if (Date.now() > expiresAt) {
        console.log('\n  Device code expired.');
        resolve(null);
        return;
      }

      try {
        const res = await fetch(`${relayUrl}/api/auth/device/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_code: deviceRes.device_code }),
        });
        const data = await res.json() as { status: string; gateway_token?: string; gateway_id?: string };

        if (data.status === 'authorized' && data.gateway_token && data.gateway_id) {
          resolve({ gateway_token: data.gateway_token, gateway_id: data.gateway_id });
          return;
        }

        if (data.status === 'denied' || data.status === 'expired') {
          console.log(`\n  Authorization ${data.status}.`);
          resolve(null);
          return;
        }

        // Still pending — poll again
        setTimeout(poll, interval);
      } catch {
        // Network error — retry
        setTimeout(poll, interval);
      }
    };

    setTimeout(poll, interval);

    // Handle Ctrl+C
    process.on('SIGINT', () => {
      console.log('\n  Cancelled.');
      resolve(null);
    });
  });

  if (!result) {
    process.exit(1);
  }

  // Step 4: Save config
  const config: AgentDrawConfig = {
    relay_url: relayUrl,
    gateway_id: result.gateway_id,
    gateway_token: result.gateway_token,
    machine_id: getMachineId(machineInfo),
    linked_at: new Date().toISOString(),
  };
  saveConfig(config);

  console.log();
  console.log('  Gateway linked successfully!');
  console.log(`  Gateway ID: ${result.gateway_id}`);
  console.log(`  Config saved to: ${CONFIG_FILE}`);
  console.log();
  console.log('  To start tunneling, run:');
  console.log(`    agentdraw connect --token ${result.gateway_token} --upstream http://localhost:18789 --relay ${relayUrl.replace(/^http/, 'ws')}/v1/tunnel`);
  console.log();
}

async function redeemLinkTokenFlow(token: string, opts: { relay: string; name?: string }): Promise<void> {
  const relayUrl = opts.relay;
  const machineInfo = getMachineInfo();

  console.log('\n  Redeeming link token...');

  try {
    const res = await fetch(`${relayUrl}/api/link-tokens/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        gateway_name: opts.name || machineInfo.hostname,
        machine_info: machineInfo,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${res.status}: ${body}`);
    }

    const data = await res.json() as { gateway_token: string; gateway_id: string };

    const config: AgentDrawConfig = {
      relay_url: relayUrl,
      gateway_id: data.gateway_id,
      gateway_token: data.gateway_token,
      machine_id: getMachineId(machineInfo),
      linked_at: new Date().toISOString(),
    };
    saveConfig(config);

    console.log();
    console.log('  Gateway linked successfully!');
    console.log(`  Gateway ID: ${data.gateway_id}`);
    console.log(`  Config saved to: ${CONFIG_FILE}`);
    console.log();
    console.log('  To start tunneling, run:');
    console.log(`    agentdraw connect --token ${data.gateway_token} --upstream http://localhost:18789 --relay ${relayUrl.replace(/^http/, 'ws')}/v1/tunnel`);
    console.log();
  } catch (err) {
    console.error(`  Failed to redeem link token: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

// ══════════════════════════════════════════════════════════════
// status command
// ══════════════════════════════════════════════════════════════

program
  .command('status')
  .description('Show current gateway link status')
  .action(async () => {
    const config = loadConfig();
    if (!config) {
      console.log('\n  Not linked. Run `agentdraw link` to get started.\n');
      process.exit(0);
    }

    console.log('\n  Gateway Status');
    console.log('  ' + '─'.repeat(40));
    console.log(`  Gateway ID:  ${config.gateway_id}`);
    console.log(`  Relay:       ${config.relay_url}`);
    console.log(`  Linked at:   ${config.linked_at}`);
    if (config.user_email) {
      console.log(`  User:        ${config.user_email}`);
    }
    if (config.machine_id) {
      console.log(`  Machine ID:  ${config.machine_id.slice(0, 16)}...`);
    }
    console.log(`  Config:      ${CONFIG_FILE}`);
    console.log();
  });

// ══════════════════════════════════════════════════════════════
// unlink command
// ══════════════════════════════════════════════════════════════

program
  .command('unlink')
  .description('Unlink this gateway and remove stored credentials')
  .action(async () => {
    const config = loadConfig();
    if (!config) {
      console.log('\n  Not linked.\n');
      process.exit(0);
    }

    deleteConfig();
    console.log('\n  Gateway unlinked.');
    console.log(`  Removed config from ${CONFIG_FILE}`);
    console.log('  Note: the gateway may still appear in your account until removed from the web dashboard.\n');
  });

// ══════════════════════════════════════════════════════════════
// whoami command
// ══════════════════════════════════════════════════════════════

program
  .command('whoami')
  .description('Show linked account information')
  .action(async () => {
    const config = loadConfig();
    if (!config) {
      console.log('\n  Not linked. Run `agentdraw link` to get started.\n');
      process.exit(0);
    }

    console.log('\n  Account Info');
    console.log('  ' + '─'.repeat(40));
    if (config.user_email) {
      console.log(`  Email:       ${config.user_email}`);
    } else {
      console.log('  Email:       (not available — linked via legacy token)');
    }
    console.log(`  Gateway ID:  ${config.gateway_id}`);
    console.log(`  Relay:       ${config.relay_url}`);
    console.log(`  Linked:      ${config.linked_at}`);
    console.log();
  });

program.parse();
