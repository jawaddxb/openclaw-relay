import { Frame, FrameType, Flags } from './types.js';
import {
  encodeHello,
  encodeHelloAck,
  encodeRequest,
  encodeResponseHead,
  encodeError,
} from './payloads.js';
import type {
  HelloPayload,
  HelloAckPayload,
  RequestPayload,
  ResponseHeadPayload,
  ErrorPayload,
} from './types.js';

/** Build a HELLO frame */
export function helloFrame(payload: HelloPayload, seq = 0): Frame {
  return {
    type: FrameType.HELLO,
    channelId: 0,
    sequence: seq,
    flags: Flags.NONE,
    payload: encodeHello(payload),
  };
}

/** Build a HELLO_ACK frame */
export function helloAckFrame(payload: HelloAckPayload, seq = 0): Frame {
  return {
    type: FrameType.HELLO_ACK,
    channelId: 0,
    sequence: seq,
    flags: Flags.NONE,
    payload: encodeHelloAck(payload),
  };
}

/** Build a REQUEST frame */
export function requestFrame(
  channelId: number,
  payload: RequestPayload,
  seq = 0,
): Frame {
  return {
    type: FrameType.REQUEST,
    channelId,
    sequence: seq,
    flags: Flags.NONE,
    payload: encodeRequest(payload),
  };
}

/** Build a RESPONSE_HEAD frame */
export function responseHeadFrame(
  channelId: number,
  payload: ResponseHeadPayload,
  seq = 0,
): Frame {
  return {
    type: FrameType.RESPONSE_HEAD,
    channelId,
    sequence: seq,
    flags: Flags.NONE,
    payload: encodeResponseHead(payload),
  };
}

/** Build a RESPONSE_BODY frame */
export function responseBodyFrame(
  channelId: number,
  data: Buffer,
  seq = 0,
): Frame {
  return {
    type: FrameType.RESPONSE_BODY,
    channelId,
    sequence: seq,
    flags: Flags.NONE,
    payload: data,
  };
}

/** Build a RESPONSE_END frame */
export function responseEndFrame(channelId: number, seq = 0): Frame {
  return {
    type: FrameType.RESPONSE_END,
    channelId,
    sequence: seq,
    flags: Flags.NONE,
    payload: Buffer.alloc(0),
  };
}

/** Build a STREAM_DATA frame */
export function streamDataFrame(
  channelId: number,
  data: Buffer,
  seq = 0,
): Frame {
  return {
    type: FrameType.STREAM_DATA,
    channelId,
    sequence: seq,
    flags: Flags.NONE,
    payload: data,
  };
}

/** Build a STREAM_END frame */
export function streamEndFrame(channelId: number, seq = 0): Frame {
  return {
    type: FrameType.STREAM_END,
    channelId,
    sequence: seq,
    flags: Flags.NONE,
    payload: Buffer.alloc(0),
  };
}

/** Build a PING frame */
export function pingFrame(seq = 0): Frame {
  return {
    type: FrameType.PING,
    channelId: 0,
    sequence: seq,
    flags: Flags.NONE,
    payload: Buffer.alloc(0),
  };
}

/** Build a PONG frame */
export function pongFrame(seq = 0): Frame {
  return {
    type: FrameType.PONG,
    channelId: 0,
    sequence: seq,
    flags: Flags.NONE,
    payload: Buffer.alloc(0),
  };
}

/** Build an ERROR frame */
export function errorFrame(
  channelId: number,
  payload: ErrorPayload,
  seq = 0,
): Frame {
  return {
    type: FrameType.ERROR,
    channelId,
    sequence: seq,
    flags: Flags.NONE,
    payload: encodeError(payload),
  };
}
