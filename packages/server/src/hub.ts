import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import {
  encodeFrame,
  FrameDecoder,
  FrameType,
  decodeHello,
  helloAckFrame,
  requestFrame,
  pingFrame,
  pongFrame,
  errorFrame,
  decodeResponseHead,
  decodeError,
} from '@openclaw/relay-protocol';
import type {
  Frame,
  RequestPayload,
  ResponseHeadPayload,
  ErrorPayload,
} from '@openclaw/relay-protocol';

export interface GatewayConnection {
  id: string;
  name: string;
  ws: WebSocket | null;
  decoder: FrameDecoder;
  connectedAt: Date;
  lastPingAt: Date;
  /** Set when WS closes; gateway kept in map during grace period */
  disconnectedAt: number | null;
}

export interface PendingChannel {
  channelId: number;
  gatewayId: string;
  resolve: (value: ChannelResponse) => void;
  reject: (reason: Error) => void;
  headReceived: boolean;
  head?: ResponseHeadPayload;
  bodyChunks: Buffer[];
  onStreamData?: (data: Buffer) => void;
  onStreamEnd?: () => void;
  onBodyChunk?: (data: Buffer) => void;
  onResponseEnd?: (head: ResponseHeadPayload, body: Buffer) => void;
}

export interface ChannelResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  isStream: boolean;
}

export interface HubEvents {
  'gateway:connected': { id: string; name: string };
  'gateway:disconnected': { id: string; reason: string };
  'gateway:reconnecting': { id: string };
  'gateway:reconnected': { id: string; name: string };
  'request': { gatewayId: string; method: string; path: string };
}

export class WebSocketHub extends EventEmitter {
  private gateways = new Map<string, GatewayConnection>();
  private channels = new Map<number, PendingChannel>();
  private nextChannelId = 1;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatMs: number;
  private heartbeatTimeoutMultiplier: number;
  private gracePeriodMs: number;

  constructor(heartbeatMs = 30_000, options?: { heartbeatTimeoutMultiplier?: number; gracePeriodMs?: number }) {
    super();
    this.heartbeatMs = heartbeatMs;
    this.heartbeatTimeoutMultiplier = options?.heartbeatTimeoutMultiplier ?? 3;
    this.gracePeriodMs = options?.gracePeriodMs ?? 45_000;
  }

  start(): void {
    this.pingInterval = setInterval(() => this.sendPings(), this.heartbeatMs);
  }

  stop(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    for (const gw of this.gateways.values()) {
      gw.ws?.close(1001, 'Server shutting down');
    }
    this.gateways.clear();
  }

  /** Handle a new gateway WebSocket connection */
  handleGatewayConnection(
    ws: WebSocket,
    validateToken: (token: string) => { id: string; name: string } | null,
  ): void {
    const decoder = new FrameDecoder();
    let authenticated = false;
    let gatewayId: string | null = null;
    /** Set to true when this socket is replaced by a new connection (code 4003) */
    let replacedByReconnect = false;

    const timeout = setTimeout(() => {
      if (!authenticated) {
        ws.close(4001, 'Authentication timeout');
      }
    }, 10_000);

    ws.on('message', (data: Buffer) => {
      const frames = decoder.decode(
        Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer),
      );
      for (const frame of frames) {
        if (!authenticated) {
          if (frame.type === FrameType.HELLO) {
            const hello = decodeHello(frame.payload);
            const info = validateToken(hello.token);
            if (!info) {
              ws.send(
                encodeFrame(
                  errorFrame(0, {
                    code: 'AUTH_FAILED',
                    message: 'Invalid gateway token',
                  }),
                ),
              );
              ws.close(4002, 'Authentication failed');
              return;
            }

            clearTimeout(timeout);
            authenticated = true;
            gatewayId = info.id;

            const existing = this.gateways.get(gatewayId);
            const wasDisconnected = existing?.disconnectedAt != null;

            // Close old socket if still open (mark it so its close handler doesn't emit disconnect)
            if (existing?.ws) {
              existing.ws.close(4003, 'Replaced by new connection');
            }

            const conn: GatewayConnection = {
              id: gatewayId,
              name: hello.gatewayName ?? info.name,
              ws,
              decoder,
              connectedAt: new Date(),
              lastPingAt: new Date(),
              disconnectedAt: null,
            };
            this.gateways.set(gatewayId, conn);

            ws.send(
              encodeFrame(
                helloAckFrame({
                  gatewayId,
                  heartbeatInterval: this.heartbeatMs,
                }),
              ),
            );

            if (wasDisconnected || existing) {
              // Reconnected within grace period or replaced active socket — no disconnect event
              this.emit('gateway:reconnected', {
                id: gatewayId,
                name: conn.name,
              });
            } else {
              this.emit('gateway:connected', {
                id: gatewayId,
                name: conn.name,
              });
            }
          }
          return;
        }

        this.handleGatewayFrame(gatewayId!, frame);
      }
    });

    ws.on('close', (code) => {
      clearTimeout(timeout);
      if (!gatewayId) return;

      // If this socket was replaced by a new connection, don't touch gateway state
      if (code === 4003 || replacedByReconnect) {
        replacedByReconnect = true;
        return;
      }

      const conn = this.gateways.get(gatewayId);
      // Only act if this is still the current connection's socket
      if (conn && conn.ws === ws) {
        // Enter grace period — keep entry but null the ws
        conn.ws = null;
        conn.disconnectedAt = Date.now();
        this.emit('gateway:reconnecting', { id: gatewayId });
      }
    });

    ws.on('error', () => {
      clearTimeout(timeout);
      if (!gatewayId) return;

      const conn = this.gateways.get(gatewayId);
      if (conn && conn.ws === ws) {
        conn.ws = null;
        conn.disconnectedAt = Date.now();
        this.emit('gateway:reconnecting', { id: gatewayId });
      }
    });
  }

  /** Reject all pending channels belonging to a gateway */
  private rejectPendingChannels(gatewayId: string): void {
    for (const [channelId, channel] of this.channels) {
      if (channel.gatewayId === gatewayId) {
        channel.reject(new Error('Gateway disconnected'));
        this.channels.delete(channelId);
      }
    }
  }

  private handleGatewayFrame(gatewayId: string, frame: Frame): void {
    const gw = this.gateways.get(gatewayId);

    if (frame.type === FrameType.PONG) {
      if (gw) gw.lastPingAt = new Date();
      return;
    }

    if (frame.type === FrameType.PING) {
      if (gw?.ws) {
        gw.ws.send(encodeFrame(pongFrame(frame.sequence)));
      }
      return;
    }

    const channel = this.channels.get(frame.channelId);
    if (!channel) return;

    switch (frame.type) {
      case FrameType.RESPONSE_HEAD: {
        const head = decodeResponseHead(frame.payload);
        channel.head = head;
        channel.headReceived = true;

        // Check if this is a streaming response
        const contentType = (head.headers['content-type'] ?? '').toLowerCase();
        if (contentType.includes('text/event-stream')) {
          // For SSE, we resolve immediately with the head so the caller can start streaming
          channel.resolve({
            status: head.status,
            headers: head.headers,
            body: Buffer.alloc(0),
            isStream: true,
          });
        }
        break;
      }

      case FrameType.RESPONSE_BODY: {
        if (channel.onBodyChunk) {
          channel.onBodyChunk(frame.payload);
        }
        channel.bodyChunks.push(frame.payload);
        break;
      }

      case FrameType.RESPONSE_END: {
        const body = Buffer.concat(channel.bodyChunks);
        if (channel.head && !channel.headReceived) {
          // Shouldn't happen, but handle gracefully
          channel.resolve({
            status: channel.head.status,
            headers: channel.head.headers,
            body,
            isStream: false,
          });
        } else if (channel.head) {
          if (channel.onResponseEnd) {
            channel.onResponseEnd(channel.head, body);
          } else {
            // Normal (non-stream) response — resolve with full body
            const contentType = (
              channel.head.headers['content-type'] ?? ''
            ).toLowerCase();
            if (!contentType.includes('text/event-stream')) {
              channel.resolve({
                status: channel.head.status,
                headers: channel.head.headers,
                body,
                isStream: false,
              });
            }
          }
        }
        if (channel.onStreamEnd) channel.onStreamEnd();
        this.channels.delete(frame.channelId);
        break;
      }

      case FrameType.STREAM_DATA: {
        if (channel.onStreamData) {
          channel.onStreamData(frame.payload);
        }
        break;
      }

      case FrameType.STREAM_END: {
        if (channel.onStreamEnd) channel.onStreamEnd();
        this.channels.delete(frame.channelId);
        break;
      }

      case FrameType.ERROR: {
        const err = decodeError(frame.payload);
        channel.reject(new Error(`Gateway error: ${err.code} - ${err.message}`));
        this.channels.delete(frame.channelId);
        break;
      }
    }
  }

  /** Forward an HTTP request to a gateway, return the response */
  async forwardRequest(
    gatewayId: string,
    request: RequestPayload,
    callbacks?: {
      onStreamData?: (data: Buffer) => void;
      onStreamEnd?: () => void;
      onBodyChunk?: (data: Buffer) => void;
      onHead?: (head: ResponseHeadPayload) => void;
    },
    timeoutMs = 60_000,
  ): Promise<ChannelResponse> {
    const gw = this.gateways.get(gatewayId);
    if (!gw || !gw.ws) {
      throw new Error('Gateway not connected');
    }

    const channelId = this.nextChannelId++;
    if (this.nextChannelId > 0xffffffff) this.nextChannelId = 1;

    return new Promise<ChannelResponse>((resolve, reject) => {
      const channel: PendingChannel = {
        channelId,
        gatewayId,
        resolve,
        reject,
        headReceived: false,
        bodyChunks: [],
        onStreamData: callbacks?.onStreamData,
        onStreamEnd: callbacks?.onStreamEnd,
        onBodyChunk: callbacks?.onBodyChunk,
      };

      this.channels.set(channelId, channel);

      const timer = setTimeout(() => {
        this.channels.delete(channelId);
        reject(new Error('Request timeout'));
      }, timeoutMs);

      const origResolve = resolve;
      const origReject = reject;
      channel.resolve = (val) => {
        clearTimeout(timer);
        if (callbacks?.onHead && channel.head) {
          callbacks.onHead(channel.head);
        }
        origResolve(val);
      };
      channel.reject = (err) => {
        clearTimeout(timer);
        origReject(err);
      };

      const frame = requestFrame(channelId, request);
      gw.ws!.send(encodeFrame(frame));

      this.emit('request', {
        gatewayId,
        method: request.method,
        path: request.path,
      });
    });
  }

  isGatewayConnected(gatewayId: string): boolean {
    const gw = this.gateways.get(gatewayId);
    return gw != null && gw.ws != null;
  }

  /** Returns true if the gateway exists in the map (connected or in grace period) */
  isGatewayAlive(gatewayId: string): boolean {
    return this.gateways.has(gatewayId);
  }

  getConnectedGateways(): Array<{ id: string; name: string; connectedAt: Date }> {
    return Array.from(this.gateways.values()).map((gw) => ({
      id: gw.id,
      name: gw.name,
      connectedAt: gw.connectedAt,
    }));
  }

  private sendPings(): void {
    const now = Date.now();
    for (const [id, gw] of this.gateways) {
      // Gateway in grace period (ws is null, waiting for reconnect)
      if (gw.disconnectedAt != null) {
        if (now - gw.disconnectedAt > this.gracePeriodMs) {
          // Grace period expired — actually disconnect
          this.gateways.delete(id);
          this.rejectPendingChannels(id);
          this.emit('gateway:disconnected', { id, reason: 'reconnect timeout' });
        }
        continue;
      }

      // Active connection — check ping timeout
      if (now - gw.lastPingAt.getTime() > this.heartbeatMs * this.heartbeatTimeoutMultiplier) {
        gw.ws?.close(4004, 'Ping timeout');
        // Enter grace period instead of immediate delete
        gw.ws = null;
        gw.disconnectedAt = Date.now();
        this.emit('gateway:reconnecting', { id });
        continue;
      }
      gw.ws?.send(encodeFrame(pingFrame()));
    }
  }
}
