// A minimal Language Server Protocol client over a child process's stdio (`Content-Length` framing), for checking a language
// server's own start command the way an editor starts it, with no bridge in between. Node only, no I/O of its own: it works
// on any pair of streams `{ stdin, stdout }` (a spawned `docker exec -i`, or PassThrough streams in the unit tests).
// Unit-tested in test/lsp-stdio.test.js.

/** One JSON-RPC message as the bytes that go on the wire: `Content-Length: <bytes>\r\n\r\n<json>`. */
export function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

/** Splits a byte stream into the JSON messages it frames; `push` chunks as they arrive, whatever their boundaries. */
export class MessageParser {
  #buffer = Buffer.alloc(0);

  constructor(onMessage, onError = () => {}) {
    this.onMessage = onMessage;
    this.onError = onError;
  }

  push(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    for (;;) {
      const headerEnd = this.#buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        return;
      }
      const header = this.#buffer.subarray(0, headerEnd).toString('ascii');
      const length = /content-length:\s*(\d+)/i.exec(header)?.[1];
      if (length === undefined) {
        this.onError(new Error(`a frame without Content-Length: ${header.slice(0, 80)}`));
        this.#buffer = this.#buffer.subarray(headerEnd + 4);
        continue;
      }
      const start = headerEnd + 4;
      const end = start + Number(length);
      if (this.#buffer.length < end) {
        return;
      }
      const body = this.#buffer.subarray(start, end).toString('utf8');
      this.#buffer = this.#buffer.subarray(end);
      try {
        this.onMessage(JSON.parse(body));
      } catch (error) {
        this.onError(error);
      }
    }
  }
}

/** What an editor answers when a server asks it something: a list of nulls for `workspace/configuration`, else null. */
export function answerToServerRequest(message) {
  if (message.method === 'workspace/configuration') {
    return (message.params?.items ?? []).map(() => null);
  }
  return null;
}

/** A client over `{ stdin, stdout }`: requests with timeouts, notifications, everything the server sent kept in order. */
export class StdioLspClient {
  constructor({ stdin, stdout }, { timeoutMs = 20000 } = {}) {
    this.stdin = stdin;
    this.timeoutMs = timeoutMs;
    this.messages = [];
    this.parseErrors = [];
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = [];
    this.parser = new MessageParser((message) => this.#ingest(message), (error) => this.parseErrors.push(error.message));
    stdout.on('data', (chunk) => this.parser.push(chunk));
  }

  notify(method, params) {
    this.stdin.write(encodeMessage({ jsonrpc: '2.0', method, params }));
  }

  /** Resolves `{ result, error, ms }` for either outcome; rejects only when no response comes within the timeout. */
  request(method, params, { timeoutMs = this.timeoutMs } = {}) {
    const id = this.nextId++;
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no response to ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, timer, startedAt });
      this.stdin.write(encodeMessage({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /** Resolves with the first message (already received or arriving later) that satisfies `predicate`. */
  waitFor(predicate, { timeoutMs = this.timeoutMs, what = 'a matching message' } = {}) {
    const existing = this.messages.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`timed out after ${timeoutMs} ms waiting for ${what}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  #ingest(message) {
    this.messages.push(message);
    if (message.method !== undefined && message.id !== undefined) {
      this.stdin.write(encodeMessage({ jsonrpc: '2.0', id: message.id, result: answerToServerRequest(message) }));
    } else if (message.method === undefined && message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve({ result: message.result, error: message.error, message, ms: Date.now() - pending.startedAt });
      }
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(message)) {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  }
}
