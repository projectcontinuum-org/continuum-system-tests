// RFC 6455 WebSocket frames, just enough for the raw Theia client in theia-client.mjs: encode a (masked) client
// frame, parse server frames from a byte stream, compute the handshake accept key. Pure and Node-only: no I/O,
// no k6, unit-tested in test/ws-frames.test.js. A hand-rolled codec keeps the suite free of dependencies and runnable
// on any Node 18+ (the global `WebSocket` only exists from Node 22) and inside a stock `node` container image.
import { createHash } from 'node:crypto';

export const OPCODE = Object.freeze({ continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa });

const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;

/** `Sec-WebSocket-Accept` a server must answer for a given `Sec-WebSocket-Key` (RFC 6455 section 4.2.2). */
export function acceptKeyFor(key) {
  return createHash('sha1').update(key + HANDSHAKE_GUID).digest('base64');
}

/**
 * One complete frame (FIN set). A client must mask every frame it sends: pass a 4-byte `mask`. Servers do not mask,
 * so leave `mask` out to build what a server would send (used by the tests).
 */
export function encodeFrame(opcode, payload, mask) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const length = body.length;
  const extension = length < 126 ? 0 : length < 65536 ? 2 : 8;
  const out = Buffer.alloc(2 + extension + (mask ? 4 : 0) + length);
  out[0] = 0x80 | opcode;
  const maskBit = mask ? 0x80 : 0;
  let offset = 1;
  if (length < 126) {
    out[offset++] = maskBit | length;
  } else if (length < 65536) {
    out[offset++] = maskBit | 126;
    out.writeUInt16BE(length, offset);
    offset += 2;
  } else {
    out[offset++] = maskBit | 127;
    out.writeBigUInt64BE(BigInt(length), offset);
    offset += 8;
  }
  if (mask) {
    if (mask.length !== 4) {
      throw new RangeError('a WebSocket mask is 4 bytes');
    }
    mask.copy(out, offset);
    offset += 4;
    for (let i = 0; i < length; i++) {
      out[offset + i] = body[i] ^ mask[i % 4];
    }
  } else {
    body.copy(out, offset);
  }
  return out;
}

/**
 * Incremental frame parser. `push(chunk)` returns the messages completed by that chunk, each `{ opcode, payload }`:
 * data frames are reassembled across continuation frames, control frames (close, ping, pong) are returned as they
 * arrive, as the protocol allows them in the middle of a fragmented message.
 */
export class FrameParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = undefined;
  }

  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages = [];
    for (;;) {
      const frame = this.#nextFrame();
      if (frame === undefined) {
        return messages;
      }
      if (frame.opcode >= OPCODE.close) {
        messages.push({ opcode: frame.opcode, payload: frame.payload });
        continue;
      }
      if (frame.opcode !== OPCODE.continuation) {
        this.fragmentOpcode = frame.opcode;
        this.fragments = [];
      } else if (this.fragmentOpcode === undefined) {
        throw new Error('continuation frame without a message to continue');
      }
      this.fragments.push(frame.payload);
      if (frame.fin) {
        messages.push({ opcode: this.fragmentOpcode, payload: Buffer.concat(this.fragments) });
        this.fragments = [];
        this.fragmentOpcode = undefined;
      }
    }
  }

  #nextFrame() {
    const buffer = this.buffer;
    if (buffer.length < 2) {
      return undefined;
    }
    const fin = (buffer[0] & 0x80) !== 0;
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) {
        return undefined;
      }
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) {
        return undefined;
      }
      const big = buffer.readBigUInt64BE(2);
      if (big > BigInt(MAX_PAYLOAD_BYTES)) {
        throw new RangeError(`WebSocket frame of ${big} bytes is larger than the ${MAX_PAYLOAD_BYTES} byte limit`);
      }
      length = Number(big);
      offset = 10;
    }
    if (length > MAX_PAYLOAD_BYTES) {
      throw new RangeError(`WebSocket frame of ${length} bytes is larger than the ${MAX_PAYLOAD_BYTES} byte limit`);
    }
    const maskLength = masked ? 4 : 0;
    if (buffer.length < offset + maskLength + length) {
      return undefined;
    }
    const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
    const start = offset + maskLength;
    const payload = Buffer.from(buffer.subarray(start, start + length));
    if (mask) {
      for (let i = 0; i < length; i++) {
        payload[i] ^= mask[i % 4];
      }
    }
    this.buffer = buffer.subarray(start + length);
    return { fin, opcode, payload };
  }
}
