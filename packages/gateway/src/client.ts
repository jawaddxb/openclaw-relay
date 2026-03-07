import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import {
  encodeFrame,
  FrameDecoder,
  FrameType,
  helloFrame,
  pongFrame,
  pingFrame,
  responseHeadFrame,
  responseBodyFrame,
  responseEndFrame,
  streamDataFrame,
  streamEndFrame,
  errorFrame,
  decodeHelloAck,
  decodeRequest,
  decodeError,
} from '@openclaw/relay-protocol';
import type {
  Frame,
  HelloAckPayload,
  RequestPayload,
} from '@openclaw/relay-protocol';

export interface GatewayClientOptions {
  relayUrl: string;
  token: string;
  upstream?: string;
  /** Auth token to inject when forwarding requests to upstream */
  upstreamToken?: string;
  gatewayName?: string;
  reconnect?: boolean;
  reconnectDelay?: { min: number; max: number };
  pingInterval?: number;
}

export interface GatewayClientEvents {
  connected: { gatewayId: string };
  disconnected: { reason: string };
  request: { method: string; path: string; channelId: number };
  error: { error: Error };
}

export class GatewayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private decoder = new FrameDecoder();
  private options: Required<
    Pick<GatewayClientOptions, 'relayUrl' | 'token' | 'reconnect' | 'pingInterval'>
  > &
    GatewayClientOptions;
  private gatewayId: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(options: GatewayClientOptions) {
    super();
    this.options = {
      reconnect: true,
      reconnectDelay: { min: 1000, max: 30_000 },
      pingInterval: 30_000,
      ...options,
    };
  }

  async connect(): Promise<void> {
    this.closed = false;

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.options.relayUrl);

      this.ws.on('open', () => {
        this.decoder.reset();
        // Send HELLO
        const frame = helloFrame({
          protocolVersion: 'clawd-tunnel/1',
          token: this.options.token,
          gatewayName: this.options.gatewayName,
        });
        this.ws!.send(encodeFrame(frame));
      });

      this.ws.on('message', (data: Buffer) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        const frames = this.decoder.decode(buf);
        for (const frame of frames) {
          this.handleFrame(frame, resolve, reject);
        }
      });

      this.ws.on('close', (_code, _reason) => {
        this.stopPing();
        const reason = 'connection closed';
        this.emit('disconnected', { reason });
        if (this.options.reconnect && !this.closed) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        this.emit('error', { error: err });
        reject(err);
      });
    });
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
  }

  async createPairingCode(relayHttpUrl: string): Promise<{ code: string; expiresAt: string }> {
    const res = await fetch(`${relayHttpUrl}/api/pairing/initiate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.token}`,
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to create pairing code: ${res.status} ${body}`);
    }
    const data = (await res.json()) as { code: string; expires: string };
    return { code: data.code, expiresAt: data.expires };
  }

  async listApps(relayHttpUrl: string): Promise<
    Array<{ id: string; deviceName: string; createdAt: string; lastUsedAt: string }>
  > {
    const res = await fetch(`${relayHttpUrl}/api/apps`, {
      headers: {
        Authorization: `Bearer ${this.options.token}`,
      },
    });
    if (!res.ok) {
      throw new Error(`Failed to list apps: ${res.status}`);
    }
    const data = (await res.json()) as { apps: Array<{ id: string; deviceName: string; createdAt: string; lastUsedAt: string }> };
    return data.apps;
  }

  private handleFrame(
    frame: Frame,
    onConnected?: (value: void) => void,
    onError?: (reason: Error) => void,
  ): void {
    switch (frame.type) {
      case FrameType.HELLO_ACK: {
        const ack = decodeHelloAck(frame.payload);
        this.gatewayId = ack.gatewayId;
        this.reconnectAttempts = 0;
        this.startPing();
        this.emit('connected', { gatewayId: ack.gatewayId });
        onConnected?.();
        break;
      }

      case FrameType.PING: {
        this.ws?.send(encodeFrame(pongFrame(frame.sequence)));
        break;
      }

      case FrameType.PONG: {
        // Keep-alive acknowledged
        break;
      }

      case FrameType.REQUEST: {
        this.handleRequest(frame);
        break;
      }

      case FrameType.ERROR: {
        const err = decodeError(frame.payload);
        this.emit('error', {
          error: new Error(`Relay error: ${err.code} - ${err.message}`),
        });
        if (frame.channelId === 0 && onError) {
          onError(new Error(`${err.code}: ${err.message}`));
        }
        break;
      }
    }
  }

  private async handleRequest(frame: Frame): Promise<void> {
    const request = decodeRequest(frame.payload);
    const channelId = frame.channelId;

    this.emit('request', {
      method: request.method,
      path: request.path,
      channelId,
    });

    if (!this.options.upstream) {
      // No upstream configured, send 503
      this.sendError(channelId, 'NO_UPSTREAM', 'No upstream server configured');
      return;
    }

    try {
      const url = new URL(request.path, this.options.upstream);
      const fetchHeaders: Record<string, string> = { ...request.headers };
      // Inject upstream auth token (e.g. OpenClaw gateway token)
      if (this.options.upstreamToken) {
        fetchHeaders['authorization'] = `Bearer ${this.options.upstreamToken}`;
      }
      delete fetchHeaders['host'];
      delete fetchHeaders['connection'];

      const res = await fetch(url.toString(), {
        method: request.method,
        headers: fetchHeaders,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : (request.body ?? undefined),
      });

      const resHeaders: Record<string, string> = {};
      res.headers.forEach((val, key) => {
        resHeaders[key] = val;
      });

      const contentType = (resHeaders['content-type'] ?? '').toLowerCase();
      const isSSE = contentType.includes('text/event-stream');

      // Send RESPONSE_HEAD
      this.ws?.send(
        encodeFrame(
          responseHeadFrame(channelId, {
            status: res.status,
            headers: resHeaders,
          }),
        ),
      );

      if (isSSE && res.body) {
        // Stream SSE data
        const reader = res.body.getReader();
        let seq = 1;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            this.ws?.send(
              encodeFrame(
                streamDataFrame(
                  channelId,
                  Buffer.from(value),
                  seq++,
                ),
              ),
            );
          }
        } finally {
          this.ws?.send(encodeFrame(streamEndFrame(channelId, seq)));
        }
      } else {
        // Regular response: send body in chunks
        const body = Buffer.from(await res.arrayBuffer());
        const chunkSize = 64 * 1024;
        let seq = 1;

        for (let i = 0; i < body.length; i += chunkSize) {
          const chunk = body.subarray(i, Math.min(i + chunkSize, body.length));
          this.ws?.send(
            encodeFrame(responseBodyFrame(channelId, chunk, seq++)),
          );
        }

        this.ws?.send(encodeFrame(responseEndFrame(channelId, seq)));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.sendError(channelId, 'UPSTREAM_ERROR', message);
    }
  }

  private sendError(channelId: number, code: string, message: string): void {
    this.ws?.send(
      encodeFrame(errorFrame(channelId, { code, message })),
    );
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.ws?.send(encodeFrame(pingFrame()));
    }, this.options.pingInterval);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    const delay = this.options.reconnectDelay ?? { min: 1000, max: 30_000 };
    const backoff = Math.min(
      delay.min * Math.pow(1.5, this.reconnectAttempts),
      delay.max,
    );
    const jitter = backoff * 0.2 * Math.random();
    const wait = backoff + jitter;

    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {
        // Will trigger reconnect via close handler
      });
    }, wait);
  }
}
