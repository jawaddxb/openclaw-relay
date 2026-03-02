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
  ws: WebSocket;
  decoder: FrameDecoder;
  connectedAt: Date;
  lastPingAt: Date;
}

export interface PendingChannel {
  channelId: number;
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
  'request': { gatewayId: string; method: string; path: string };
}

export class WebSocketHub extends EventEmitter {
  private gateways = new Map<string, GatewayConnection>();
  private channels = new Map<number, PendingChannel>();
  private nextChannelId = 1;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatMs: number;

  constructor(heartbeatMs = 30_000) {
    super();
    this.heartbeatMs = heartbeatMs;
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
      gw.ws.close(1001, 'Server shutting down');
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

            // Remove old connection if reconnecting
            const existing = this.gateways.get(gatewayId);
            if (existing) {
              existing.ws.close(4003, 'Replaced by new connection');
            }

            const conn: GatewayConnection = {
              id: gatewayId,
              name: hello.gatewayName ?? info.name,
              ws,
              decoder,
              connectedAt: new Date(),
              lastPingAt: new Date(),
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

            this.emit('gateway:connected', {
              id: gatewayId,
              name: conn.name,
            });
          }
          return;
        }

        this.handleGatewayFrame(gatewayId!, frame);
      }
    });

    ws.on('close', () => {
      clearTimeout(timeout);
      if (gatewayId) {
        this.gateways.delete(gatewayId);
        this.emit('gateway:disconnected', {
          id: gatewayId,
          reason: 'connection closed',
        });
      }
    });

    ws.on('error', () => {
      clearTimeout(timeout);
      if (gatewayId) {
        this.gateways.delete(gatewayId);
        this.emit('gateway:disconnected', {
          id: gatewayId,
          reason: 'connection error',
        });
      }
    });
  }

  private handleGatewayFrame(gatewayId: string, frame: Frame): void {
    const gw = this.gateways.get(gatewayId);

    if (frame.type === FrameType.PONG) {
      if (gw) gw.lastPingAt = new Date();
      return;
    }

    if (frame.type === FrameType.PING) {
      if (gw) {
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
  ): Promise<ChannelResponse> {
    const gw = this.gateways.get(gatewayId);
    if (!gw) {
      throw new Error('Gateway not connected');
    }

    const channelId = this.nextChannelId++;
    if (this.nextChannelId > 0xffffffff) this.nextChannelId = 1;

    return new Promise<ChannelResponse>((resolve, reject) => {
      const channel: PendingChannel = {
        channelId,
        resolve,
        reject,
        headReceived: false,
        bodyChunks: [],
        onStreamData: callbacks?.onStreamData,
        onStreamEnd: callbacks?.onStreamEnd,
        onBodyChunk: callbacks?.onBodyChunk,
      };

      this.channels.set(channelId, channel);

      // Timeout after 60s
      const timer = setTimeout(() => {
        this.channels.delete(channelId);
        reject(new Error('Request timeout'));
      }, 60_000);

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
      gw.ws.send(encodeFrame(frame));

      this.emit('request', {
        gatewayId,
        method: request.method,
        path: request.path,
      });
    });
  }

  isGatewayConnected(gatewayId: string): boolean {
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
      // If no pong in 2x heartbeat, disconnect
      if (now - gw.lastPingAt.getTime() > this.heartbeatMs * 2) {
        gw.ws.close(4004, 'Ping timeout');
        this.gateways.delete(id);
        this.emit('gateway:disconnected', { id, reason: 'ping timeout' });
        continue;
      }
      gw.ws.send(encodeFrame(pingFrame()));
    }
  }
}
