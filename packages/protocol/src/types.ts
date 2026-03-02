/** Frame type identifiers for clawd-tunnel/1 protocol */
export const FrameType = {
  HELLO: 0x01,
  HELLO_ACK: 0x02,
  REQUEST: 0x10,
  RESPONSE_HEAD: 0x11,
  RESPONSE_BODY: 0x12,
  RESPONSE_END: 0x13,
  STREAM_DATA: 0x20,
  STREAM_END: 0x21,
  PING: 0x30,
  PONG: 0x31,
  ERROR: 0xff,
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

/** Human-readable names for frame types */
export const FrameTypeName: Record<FrameTypeValue, string> = {
  [FrameType.HELLO]: 'HELLO',
  [FrameType.HELLO_ACK]: 'HELLO_ACK',
  [FrameType.REQUEST]: 'REQUEST',
  [FrameType.RESPONSE_HEAD]: 'RESPONSE_HEAD',
  [FrameType.RESPONSE_BODY]: 'RESPONSE_BODY',
  [FrameType.RESPONSE_END]: 'RESPONSE_END',
  [FrameType.STREAM_DATA]: 'STREAM_DATA',
  [FrameType.STREAM_END]: 'STREAM_END',
  [FrameType.PING]: 'PING',
  [FrameType.PONG]: 'PONG',
  [FrameType.ERROR]: 'ERROR',
};

/** Flag bits */
export const Flags = {
  NONE: 0x00,
  COMPRESSED: 0x01,
  CONTINUED: 0x02,
  PRIORITY: 0x04,
} as const;

/** Frame header size in bytes: type(1) + channelId(4) + sequence(4) + flags(1) + length(4) = 14 */
export const HEADER_SIZE = 14;

/** A parsed frame */
export interface Frame {
  type: FrameTypeValue;
  channelId: number;
  sequence: number;
  flags: number;
  payload: Buffer;
}

/** HELLO frame payload */
export interface HelloPayload {
  protocolVersion: string;
  token: string;
  gatewayName?: string;
}

/** HELLO_ACK frame payload */
export interface HelloAckPayload {
  gatewayId: string;
  heartbeatInterval: number;
}

/** REQUEST frame payload - HTTP request forwarded from relay to gateway */
export interface RequestPayload {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

/** RESPONSE_HEAD frame payload */
export interface ResponseHeadPayload {
  status: number;
  headers: Record<string, string>;
}

/** ERROR frame payload */
export interface ErrorPayload {
  code: string;
  message: string;
}
