import { Frame, FrameTypeValue, HEADER_SIZE } from './types.js';

/**
 * Encode a frame into a binary buffer.
 *
 * Header layout (14 bytes):
 *   type(1) + channelId(4) + sequence(4) + flags(1) + length(4)
 */
export function encodeFrame(frame: Frame): Buffer {
  const header = Buffer.alloc(HEADER_SIZE);
  let offset = 0;

  header.writeUInt8(frame.type, offset);
  offset += 1;

  header.writeUInt32BE(frame.channelId, offset);
  offset += 4;

  header.writeUInt32BE(frame.sequence, offset);
  offset += 4;

  header.writeUInt8(frame.flags, offset);
  offset += 1;

  header.writeUInt32BE(frame.payload.length, offset);

  return Buffer.concat([header, frame.payload]);
}

/**
 * Decode a single frame from a buffer.
 * Returns the frame and the number of bytes consumed.
 * Returns null if the buffer doesn't contain a complete frame.
 */
export function decodeFrame(
  buf: Buffer,
  offset = 0,
): { frame: Frame; bytesRead: number } | null {
  const remaining = buf.length - offset;
  if (remaining < HEADER_SIZE) return null;

  const type = buf.readUInt8(offset) as FrameTypeValue;
  const channelId = buf.readUInt32BE(offset + 1);
  const sequence = buf.readUInt32BE(offset + 5);
  const flags = buf.readUInt8(offset + 9);
  const length = buf.readUInt32BE(offset + 10);

  if (remaining < HEADER_SIZE + length) return null;

  const payload = buf.subarray(offset + HEADER_SIZE, offset + HEADER_SIZE + length);

  return {
    frame: { type, channelId, sequence, flags, payload: Buffer.from(payload) },
    bytesRead: HEADER_SIZE + length,
  };
}

/**
 * Stream decoder: accumulates incoming data and yields complete frames.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  /** Feed raw data and return any complete frames */
  decode(data: Buffer): Frame[] {
    this.buffer = Buffer.concat([this.buffer, data]);
    const frames: Frame[] = [];

    let offset = 0;
    while (true) {
      const result = decodeFrame(this.buffer, offset);
      if (!result) break;
      frames.push(result.frame);
      offset += result.bytesRead;
    }

    if (offset > 0) {
      this.buffer = this.buffer.subarray(offset);
    }

    return frames;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}
