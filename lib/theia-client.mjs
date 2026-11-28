// A browser-less Theia client: HTTP GET for the connection-token cookie, a WebSocket upgrade, Socket.IO on top of it, then
// Theia's channel multiplexer, so a script can open `/services/...` channels (such as the language-server bridge's) the
// way the workbench frontend does. Node only (node:http/https, no dependencies), no k6. Wire formats: theia-wire.mjs.
//
// Why the cookie: Theia refuses a WebSocket upgrade that does not carry its `theia-connection-token` cookie (a
// cross-origin page cannot get it, a script has to ask for it). Any HTTP response from the backend sets it.
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { OPCODE, FrameParser, acceptKeyFor, encodeFrame } from './ws-frames.mjs';
import {
  ENGINE, SOCKET, closeFrame, dataFrame, engineMessage, fillPlaceholders, openFrame, parseChannelFrame, parseEnginePacket,
  parseSocketPacket, rawDataFrame, socketBinaryEventHeader, socketConnect, socketEvent,
} from './theia-wire.mjs';

export const TOKEN_COOKIE = 'theia-connection-token';
export const SERVICES_NAMESPACE = '/services';

function transportFor(url) {
  return url.protocol === 'https:' || url.protocol === 'wss:' ? https : http;
}

/** The `theia-connection-token=<value>` cookie pair a Theia backend sets on every HTTP response. */
export function fetchConnectionCookie(baseUrl, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL('/', baseUrl);
    const req = transportFor(url).get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      const cookies = [].concat(res.headers['set-cookie'] || []);
      const pair = cookies.map((c) => c.split(';')[0]).find((c) => c.startsWith(`${TOKEN_COOKIE}=`));
      if (pair) {
        resolve(pair);
      } else {
        reject(new Error(`no ${TOKEN_COOKIE} cookie in the response of GET ${url} (HTTP ${res.statusCode})`));
      }
    });
    req.on('timeout', () => req.destroy(new Error(`GET ${url} timed out`)));
    req.on('error', reject);
  });
}

/** A client WebSocket: events `text` (string), `binary` (Buffer), `close`, `error`. */
export class RawWebSocket extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.parser = new FrameParser();
    this.closed = false;
    this.closeCode = undefined;
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('close', () => {
      this.closed = true;
      this.emit('close', this.closeCode);
    });
    socket.on('error', (error) => this.emit('error', error));
    if (head && head.length > 0) {
      // bytes that arrived with the upgrade response: handle them once the owner has attached its listeners
      setImmediate(() => this.#onData(head));
    }
  }

  #onData(chunk) {
    let messages;
    try {
      messages = this.parser.push(chunk);
    } catch (error) {
      this.emit('error', error);
      this.socket.destroy();
      return;
    }
    for (const { opcode, payload } of messages) {
      if (opcode === OPCODE.text) {
        this.emit('text', payload.toString('utf8'));
      } else if (opcode === OPCODE.binary) {
        this.emit('binary', payload);
      } else if (opcode === OPCODE.ping) {
        this.#write(OPCODE.pong, payload);
      } else if (opcode === OPCODE.close) {
        this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        this.#write(OPCODE.close, payload.subarray(0, 2));
        this.socket.end();
      }
    }
  }

  #write(opcode, payload) {
    if (!this.socket.destroyed && this.socket.writable) {
      this.socket.write(encodeFrame(opcode, payload, randomBytes(4)));
    }
  }

  sendText(text) {
    this.#write(OPCODE.text, Buffer.from(text, 'utf8'));
  }

  sendBinary(buffer) {
    this.#write(OPCODE.binary, buffer);
  }

  /** Close handshake with a 1 s grace, then the socket is dropped. */
  close(code = 1000) {
    if (this.closed || this.socket.destroyed) {
      return;
    }
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    this.#write(OPCODE.close, payload);
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }

  /** Drops the TCP connection without any close handshake (what a crashed browser tab looks like to the server). */
  destroy() {
    this.socket.destroy();
  }
}

/**
 * Upgrades to a WebSocket. Rejects with `error.statusCode` (and `error.body`) when the server answers the upgrade with a
 * plain HTTP response, which is how Theia/Socket.IO refuse a request that fails origin or token validation.
 */
export function openWebSocket(url, { headers = {}, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    // node:http only speaks http(s); the upgrade is what makes it a WebSocket
    target.protocol = target.protocol === 'wss:' ? 'https:' : target.protocol === 'ws:' ? 'http:' : target.protocol;
    const key = randomBytes(16).toString('base64');
    const req = transportFor(target).request(target, {
      method: 'GET',
      timeout: timeoutMs,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key, ...headers },
    });
    req.once('upgrade', (res, socket, head) => {
      if (res.headers['sec-websocket-accept'] !== acceptKeyFor(key)) {
        socket.destroy();
        reject(new Error('the server answered the WebSocket upgrade with a wrong Sec-WebSocket-Accept'));
        return;
      }
      socket.setTimeout(0);
      resolve(new RawWebSocket(socket, head));
    });
    req.once('response', (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (part) => { body += part; });
      res.on('end', () => reject(Object.assign(new Error(`WebSocket upgrade refused: HTTP ${res.statusCode} ${body.slice(0, 200)}`), { statusCode: res.statusCode, body })));
    });
    req.on('timeout', () => req.destroy(new Error('WebSocket upgrade timed out')));
    req.on('error', reject);
    req.end();
  });
}

/** One multiplexed Theia channel. Everything received is kept in `received`, so late listeners lose nothing. */
export class TheiaChannel extends EventEmitter {
  constructor(connection, id) {
    super();
    this.connection = connection;
    this.id = id;
    this.received = [];
    this.rawReceived = [];
    this.closed = false;
    this.closedByServer = false;
    this.closeWaiters = [];
  }

  /** One string message (for the language-server bridge: one JSON-RPC message). */
  send(text) {
    this.connection.sendFrame(dataFrame(this.id, text));
  }

  /** A Data frame with an arbitrary payload after the channel id, for malformed-input checks. */
  sendRaw(payload) {
    this.connection.sendFrame(rawDataFrame(this.id, payload));
  }

  /** Closes the channel from the client side (a Close frame). */
  close() {
    if (!this.closed) {
      this.closed = true;
      this.connection.sendFrame(closeFrame(this.id));
      this.#notifyClosed();
    }
  }

  /** Resolves true as soon as the channel is closed (by either side), false after `timeoutMs`. */
  whenClosed(timeoutMs = 5000) {
    if (this.closed) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.closeWaiters.push(() => { clearTimeout(timer); resolve(true); });
    });
  }

  handleText(text) {
    this.received.push(text);
    this.emit('message', text);
  }

  handleRaw(payload) {
    this.rawReceived.push(payload);
  }

  handleServerClose() {
    this.closedByServer = true;
    this.closed = true;
    this.#notifyClosed();
  }

  #notifyClosed() {
    this.emit('close');
    this.closeWaiters.splice(0).forEach((resolve) => resolve());
  }
}

/** A Socket.IO connection to a Theia backend's `/services` namespace with Theia's channel multiplexer on top. */
export class TheiaConnection extends EventEmitter {
  /**
   * Connects and completes Theia's handshake. Options: `cookie` (skip the token fetch), `headers` (extra upgrade
   * headers, e.g. an Origin to test the origin check), `timeoutMs`.
   */
  static async connect(baseUrl, { cookie, headers = {}, timeoutMs = 15000, frontendId = randomUUID() } = {}) {
    const token = cookie === undefined ? await fetchConnectionCookie(baseUrl, { timeoutMs }) : cookie;
    const ws = await openWebSocket(new URL('/socket.io/?EIO=4&transport=websocket', baseUrl).href, {
      headers: token ? { Cookie: token, ...headers } : headers,
      timeoutMs,
    });
    const connection = new TheiaConnection(ws, frontendId);
    await connection.#handshake(timeoutMs);
    return connection;
  }

  constructor(ws, frontendId) {
    super();
    this.ws = ws;
    this.frontendId = frontendId;
    this.channels = new Map();
    this.pendingOpens = new Map();
    this.pendingBinary = undefined;
    this.closed = false;
    this.handshake = undefined;
    ws.on('text', (text) => this.#onText(text));
    ws.on('binary', (buffer) => this.#onBinary(buffer));
    ws.on('close', () => this.#onClosed());
    ws.on('error', (error) => this.emit('transportError', error));
  }

  #handshake(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Theia handshake timed out after ${timeoutMs} ms`)), timeoutMs);
      this.handshake = {
        done: () => { clearTimeout(timer); resolve(); },
        fail: (error) => { clearTimeout(timer); reject(error); },
      };
      this.ws.once('close', () => this.handshake?.fail(new Error('the WebSocket closed during the Theia handshake')));
    });
  }

  #onText(text) {
    let packet;
    try {
      packet = parseEnginePacket(text);
    } catch (error) {
      this.emit('protocolError', error);
      return;
    }
    switch (packet.type) {
      case 'open':
        this.engineInfo = JSON.parse(packet.data);
        this.ws.sendText(engineMessage(socketConnect(SERVICES_NAMESPACE)));
        break;
      case 'ping':
        this.ws.sendText(ENGINE.pong);
        break;
      case 'message':
        this.#onSocketPacket(parseSocketPacket(packet.data));
        break;
      case 'close':
        this.ws.close();
        break;
      default:
        break;
    }
  }

  #onSocketPacket(packet) {
    switch (packet.type) {
      case SOCKET.connect:
        this.ws.sendText(engineMessage(socketEvent(SERVICES_NAMESPACE, 'initialConnection', this.frontendId)));
        break;
      case SOCKET.connectError:
        this.handshake?.fail(new Error(`Socket.IO namespace refused: ${JSON.stringify(packet.data)}`));
        break;
      case SOCKET.disconnect:
        this.ws.close();
        break;
      case SOCKET.event:
        this.#onEvent(packet.data);
        break;
      case SOCKET.binaryEvent:
        this.pendingBinary = { packet, attachments: [] };
        break;
      default:
        break;
    }
  }

  #onBinary(buffer) {
    const pending = this.pendingBinary;
    if (!pending) {
      this.emit('protocolError', new Error('binary message without a binary event header'));
      return;
    }
    pending.attachments.push(buffer);
    if (pending.attachments.length >= pending.packet.attachments) {
      this.pendingBinary = undefined;
      this.#onEvent(fillPlaceholders(pending.packet.data, pending.attachments));
    }
  }

  #onEvent(args) {
    const [name, ...rest] = Array.isArray(args) ? args : [];
    if (name === 'initialConnection') {
      this.handshake?.done();
      this.handshake = undefined;
    } else if (name === 'message' && Buffer.isBuffer(rest[0])) {
      this.#onChannelFrame(rest[0]);
    }
  }

  #onChannelFrame(buffer) {
    let frame;
    try {
      frame = parseChannelFrame(buffer);
    } catch (error) {
      this.emit('protocolError', error);
      return;
    }
    const channel = this.channels.get(frame.id);
    if (frame.kind === 'ackOpen') {
      this.pendingOpens.get(frame.id)?.(channel);
      this.pendingOpens.delete(frame.id);
    } else if (frame.kind === 'close') {
      channel?.handleServerClose();
    } else if (frame.kind === 'data' && channel) {
      if (typeof frame.text === 'string') {
        channel.handleText(frame.text);
      } else {
        channel.handleRaw(frame.payload);
      }
    }
  }

  #onClosed() {
    this.closed = true;
    for (const channel of this.channels.values()) {
      if (!channel.closed) {
        channel.handleServerClose();
      }
    }
    this.emit('close');
  }

  /** Sends one multiplexer frame as a Socket.IO binary `message` event. */
  sendFrame(frame) {
    this.ws.sendText(engineMessage(socketBinaryEventHeader(SERVICES_NAMESPACE, 'message')));
    this.ws.sendBinary(frame);
  }

  /**
   * Opens the channel `path` (for the language-server bridge `/services/language-server/<id>`) and resolves when the backend
   * has acknowledged it. A backend acknowledges every Open; whether a handler accepts the channel shows afterwards.
   */
  openChannel(path, { timeoutMs = 10000 } = {}) {
    const channel = new TheiaChannel(this, path);
    this.channels.set(path, channel);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingOpens.delete(path);
        reject(new Error(`channel ${path} was not acknowledged within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pendingOpens.set(path, (opened) => { clearTimeout(timer); resolve(opened); });
      this.sendFrame(openFrame(path));
    });
  }

  /** Orderly disconnect: Socket.IO DISCONNECT, then the WebSocket close handshake. */
  close() {
    if (!this.closed) {
      this.ws.sendText(engineMessage(`${SOCKET.disconnect}${SERVICES_NAMESPACE},`));
      this.ws.close();
    }
  }

  /** Drops the TCP connection abruptly, with no channel Close and no Socket.IO or WebSocket goodbye. */
  drop() {
    this.ws.destroy();
  }
}
