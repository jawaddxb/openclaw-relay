/**
 * Minimal OpenClaw WS RPC client.
 * Handles the challenge/response auth and method calls.
 */
import WebSocket from 'ws';

export async function callOpenClawRpc<T>(
  wsUrl: string,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let connected = false;
    const id = Math.random().toString(36).slice(2);

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('OpenClaw RPC timeout'));
    }, 10_000);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'event' && msg.event === 'connect.challenge') {
          const connectId = Math.random().toString(36).slice(2);
          ws.send(JSON.stringify({
            type: 'req',
            id: connectId,
            method: 'connect',
            params: {
              auth: { token },
              client: {
                id: 'cli',
                mode: 'cli',
                displayName: 'AgentDraw Relay',
                version: '0.1.0',
                platform: 'node',
              },
              caps: [],
              minProtocol: 3,
              maxProtocol: 3,
              role: 'operator',
              scopes: ['operator.admin'],
            },
          }));
          return;
        }

        if (msg.type === 'event' && msg.event === 'connect.ok') {
          connected = true;
          ws.send(JSON.stringify({ type: 'req', id, method, params }));
          return;
        }

        if (msg.type === 'event' && msg.event === 'connect.error') {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(msg.payload?.message ?? 'Auth failed'));
          return;
        }

        // connect ok reply
        if (!connected && msg.type === 'res' && msg.ok !== false) {
          connected = true;
          ws.send(JSON.stringify({ type: 'req', id, method, params }));
          return;
        }

        if (msg.type === 'res' && msg.id === id) {
          clearTimeout(timeout);
          ws.close();
          if (msg.error) reject(new Error(msg.error.message ?? 'RPC error'));
          else resolve(msg.result as T);
        }
      } catch { /* ignore */ }
    });

    ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
    ws.on('close', (code) => {
      clearTimeout(timeout);
      if (!connected) reject(new Error(`Closed before connect: ${code}`));
    });
  });
}

export async function getOpenClawAgents(upstreamWsUrl: string, token: string) {
  // Get status to derive agents
  const status = await callOpenClawRpc<{
    sessions?: { paths?: string[] };
    heartbeat?: { defaultAgentId?: string; agents?: Array<{ agentId: string }> };
  }>(upstreamWsUrl, token, 'status');

  // Derive unique agent IDs from heartbeat config
  const agentIds = new Set<string>();

  if (status.heartbeat?.defaultAgentId) {
    agentIds.add(status.heartbeat.defaultAgentId);
  }
  for (const a of status.heartbeat?.agents ?? []) {
    agentIds.add(a.agentId);
  }
  // Fallback
  if (agentIds.size === 0) agentIds.add('main');

  return Array.from(agentIds).map((id) => ({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    status: 'online' as const,
    model: 'claude-sonnet-4-6',
    threadCount: 0,
    lastActivity: new Date().toISOString(),
  }));
}
