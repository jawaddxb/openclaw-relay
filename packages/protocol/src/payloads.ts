import type {
  HelloPayload,
  HelloAckPayload,
  RequestPayload,
  ResponseHeadPayload,
  ErrorPayload,
} from './types.js';

/** Encode a JSON-serializable payload to Buffer */
export function encodeJson<T>(data: T): Buffer {
  return Buffer.from(JSON.stringify(data), 'utf-8');
}

/** Decode a Buffer to a JSON payload */
export function decodeJson<T>(buf: Buffer): T {
  return JSON.parse(buf.toString('utf-8')) as T;
}

export function encodeHello(payload: HelloPayload): Buffer {
  return encodeJson(payload);
}

export function decodeHello(buf: Buffer): HelloPayload {
  return decodeJson<HelloPayload>(buf);
}

export function encodeHelloAck(payload: HelloAckPayload): Buffer {
  return encodeJson(payload);
}

export function decodeHelloAck(buf: Buffer): HelloAckPayload {
  return decodeJson<HelloAckPayload>(buf);
}

export function encodeRequest(payload: RequestPayload): Buffer {
  return encodeJson(payload);
}

export function decodeRequest(buf: Buffer): RequestPayload {
  return decodeJson<RequestPayload>(buf);
}

export function encodeResponseHead(payload: ResponseHeadPayload): Buffer {
  return encodeJson(payload);
}

export function decodeResponseHead(buf: Buffer): ResponseHeadPayload {
  return decodeJson<ResponseHeadPayload>(buf);
}

export function encodeError(payload: ErrorPayload): Buffer {
  return encodeJson(payload);
}

export function decodeError(buf: Buffer): ErrorPayload {
  return decodeJson<ErrorPayload>(buf);
}
