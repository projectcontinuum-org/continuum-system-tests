// The three framings a raw (browser-less) client has to speak to a Theia 1.7x backend, as pure encode/decode helpers.
// Node-only (Buffer), no I/O and no k6; unit-tested in test/theia-wire.test.js. theia-client.mjs puts them on a socket.
//
//  1. Engine.IO v4 over WebSocket (what Socket.IO rides on). Every WebSocket text message is `<type><data>`; types:
//     0 open (server, JSON handshake), 1 close, 2 ping (server, answer with 3), 3 pong, 4 message, 6 noop.
//     A binary WebSocket message is a message packet with binary data.
//  2. Socket.IO v5 inside engine message packets: `<type>[<attachments>-][<namespace>,][<ack id>]<json>`, types
//     0 CONNECT, 1 DISCONNECT, 2 EVENT, 3 ACK, 4 CONNECT_ERROR, 5 BINARY_EVENT, 6 BINARY_ACK. A binary event is the text
//     packet (the binary argument replaced by `{"_placeholder":true,"num":0}`) followed by one binary message per
//     attachment. Theia uses the `/services` namespace, the events `initialConnection` (client id handshake) and
//     `message` (one Theia channel frame as binary attachment).
//  3. Theia's channel multiplexer (@theia/core common/message-rpc/channel.js) on top of those binary attachments:
//     `[type uint8][channel id string]` plus, for Data, the payload. A string is a uint32 big-endian byte length and the
//     UTF-8 bytes (Uint8ArrayWriteBuffer.writeString). The language-server bridge writes one JSON-RPC message as one
//     string per Data frame.

export const ENGINE = Object.freeze({ open: '0', close: '1', ping: '2', pong: '3', message: '4', upgrade: '5', noop: '6' });
export const SOCKET = Object.freeze({ connect: 0, disconnect: 1, event: 2, ack: 3, connectError: 4, binaryEvent: 5, binaryAck: 6 });
export const CHANNEL = Object.freeze({ open: 1, close: 2, ackOpen: 3, data: 4 });

/** Theia string: uint32 big-endian length of the UTF-8 bytes, then the bytes. */
export function writeString(text) {
  const bytes = Buffer.from(text, 'utf8');
  const out = Buffer.alloc(4 + bytes.length);
  out.writeUInt32BE(bytes.length, 0);
  bytes.copy(out, 4);
  return out;
}

/** Reads a Theia string at `offset`; returns the text and the offset after it. Throws when the buffer is too short. */
export function readString(buffer, offset = 0) {
  if (buffer.length < offset + 4) {
    throw new RangeError('buffer too short for a string length');
  }
  const length = buffer.readUInt32BE(offset);
  const start = offset + 4;
  if (buffer.length < start + length) {
    throw new RangeError(`string of ${length} bytes does not fit in the buffer`);
  }
  return { value: buffer.toString('utf8', start, start + length), next: start + length };
}

export function openFrame(channelId) {
  return Buffer.concat([Buffer.from([CHANNEL.open]), writeString(channelId)]);
}

export function closeFrame(channelId) {
  return Buffer.concat([Buffer.from([CHANNEL.close]), writeString(channelId)]);
}

/** A Data frame carrying one string, which is how the language-server bridge exchanges JSON-RPC messages. */
export function dataFrame(channelId, text) {
  return Buffer.concat([Buffer.from([CHANNEL.data]), writeString(channelId), writeString(text)]);
}

/** Frame with a raw payload after the channel id (used to send what a real client never would). */
export function rawDataFrame(channelId, payload) {
  return Buffer.concat([Buffer.from([CHANNEL.data]), writeString(channelId), payload]);
}

/**
 * Decodes a multiplexer frame to `{ kind, id }` plus `text` for a Data frame that carries one string. Data frames with
 * another payload shape keep it as `payload`. Throws on a frame that is too short or of an unknown type.
 */
export function parseChannelFrame(buffer) {
  if (buffer.length < 1) {
    throw new RangeError('empty channel frame');
  }
  const type = buffer[0];
  const { value: id, next } = readString(buffer, 1);
  switch (type) {
    case CHANNEL.open:
      return { kind: 'open', id };
    case CHANNEL.close:
      return { kind: 'close', id };
    case CHANNEL.ackOpen:
      return { kind: 'ackOpen', id };
    case CHANNEL.data: {
      const payload = buffer.subarray(next);
      try {
        const { value, next: end } = readString(payload, 0);
        if (end === payload.length) {
          return { kind: 'data', id, text: value };
        }
      } catch {
        // not a single string: fall through and hand the bytes over as they are
      }
      return { kind: 'data', id, payload };
    }
    default:
      throw new RangeError(`unknown channel frame type ${type}`);
  }
}

/** Engine.IO text packet (one WebSocket text message) to `{ type, data }`, `type` being the name from ENGINE. */
export function parseEnginePacket(text) {
  if (text.length === 0) {
    throw new RangeError('empty Engine.IO packet');
  }
  const names = Object.entries(ENGINE).find(([, code]) => code === text[0]);
  if (!names) {
    throw new RangeError(`unknown Engine.IO packet type ${JSON.stringify(text[0])}`);
  }
  return { type: names[0], data: text.slice(1) };
}

/** An Engine.IO message packet around a Socket.IO packet text. */
export function engineMessage(socketPacket) {
  return ENGINE.message + socketPacket;
}

/** Socket.IO CONNECT to a namespace, as the text to wrap with `engineMessage`. */
export function socketConnect(namespace) {
  return `${SOCKET.connect}${namespace},`;
}

/** Socket.IO text EVENT, e.g. `socketEvent('/services', 'initialConnection', frontendId)`. */
export function socketEvent(namespace, name, ...args) {
  return `${SOCKET.event}${namespace},${JSON.stringify([name, ...args])}`;
}

/** Header text of a Socket.IO binary event with one binary argument; the bytes follow as a separate binary message. */
export function socketBinaryEventHeader(namespace, name) {
  return `${SOCKET.binaryEvent}1-${namespace},${JSON.stringify([name, { _placeholder: true, num: 0 }])}`;
}

/**
 * Parses Socket.IO packet text: `{ type, namespace, attachments, id, data }`. `data` is the parsed JSON (undefined
 * when the packet has none). The namespace defaults to `/`, as on the wire.
 */
export function parseSocketPacket(text) {
  let i = 0;
  const type = Number(text[i++]);
  if (!Number.isInteger(type) || type < 0 || type > 6) {
    throw new RangeError(`unknown Socket.IO packet type in ${JSON.stringify(text.slice(0, 20))}`);
  }
  let attachments = 0;
  if (type === SOCKET.binaryEvent || type === SOCKET.binaryAck) {
    const dash = text.indexOf('-', i);
    if (dash < 0) {
      throw new RangeError('binary Socket.IO packet without an attachment count');
    }
    attachments = Number(text.slice(i, dash));
    i = dash + 1;
  }
  let namespace = '/';
  if (text[i] === '/') {
    const comma = text.indexOf(',', i);
    if (comma < 0) {
      namespace = text.slice(i);
      i = text.length;
    } else {
      namespace = text.slice(i, comma);
      i = comma + 1;
    }
  }
  let idEnd = i;
  while (idEnd < text.length && text[idEnd] >= '0' && text[idEnd] <= '9') {
    idEnd++;
  }
  const id = idEnd > i ? Number(text.slice(i, idEnd)) : undefined;
  i = idEnd;
  const data = i < text.length ? JSON.parse(text.slice(i)) : undefined;
  return { type, namespace, attachments, id, data };
}

/** Replaces `{ _placeholder: true, num }` entries in an event's arguments by the received attachments. */
export function fillPlaceholders(value, attachments) {
  if (Array.isArray(value)) {
    return value.map((item) => fillPlaceholders(item, attachments));
  }
  if (value && typeof value === 'object') {
    if (value._placeholder === true && Number.isInteger(value.num)) {
      return attachments[value.num];
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillPlaceholders(item, attachments)]));
  }
  return value;
}
