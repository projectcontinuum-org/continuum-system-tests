// JSON-RPC 2.0 over one Theia channel, the way the language-server bridge speaks it: one JSON message per string.
// Correlates responses with requests, and keeps everything the bridge sent (state notices, diagnostics, responses) in
// arrival order so a check can look at "what arrived since here" without racing the network. Node only, no I/O of its
// own: it works on any object with `send(text)`, `received[]`, `closed` and `on('message'|'close')` (a TheiaChannel,
// or a fake in the unit tests).

const DEFAULT_TIMEOUT_MS = 15000;

function summarize(messages) {
  return messages.slice(-6).map((message) => JSON.stringify(message).slice(0, 160)).join(' | ') || 'nothing';
}

export class LspSession {
  constructor(channel, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.channel = channel;
    this.timeoutMs = timeoutMs;
    this.messages = [];
    this.invalid = [];
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = [];
    for (const text of channel.received) {
      this.#ingest(text);
    }
    channel.on('message', (text) => this.#ingest(text));
    channel.on('close', () => this.#onClose());
  }

  get closed() {
    return this.channel.closed === true;
  }

  /** Index to pass as `from` to later waits: "only what arrives after now". */
  mark() {
    return this.messages.length;
  }

  /** The `continuum/serverState` values received so far, in order. */
  get states() {
    return this.messages.filter((m) => m.method === 'continuum/serverState').map((m) => m.params?.state);
  }

  get lastState() {
    return this.states.at(-1);
  }

  /** Requests and notifications the server direction sent that a client should never see (a request from the server). */
  get serverRequests() {
    return this.messages.filter((m) => m.method !== undefined && m.id !== undefined);
  }

  /** Every `textDocument/publishDiagnostics` params received since `from`, optionally for one URI. */
  diagnosticEvents({ uri, from = 0 } = {}) {
    return this.messages.slice(from)
      .filter((m) => m.method === 'textDocument/publishDiagnostics' && (uri === undefined || m.params?.uri === uri))
      .map((m) => m.params);
  }

  notify(method, params) {
    this.channel.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  /** Sends a request; resolves `{ result, error, ms }` for either outcome and rejects only on timeout or a closed channel. */
  request(method, params, { timeoutMs = this.timeoutMs } = {}) {
    const id = this.nextId++;
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error(`channel closed before ${method} could be sent`));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no response to ${method} within ${timeoutMs} ms (last messages: ${summarize(this.messages)})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method, startedAt });
      this.channel.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /** Sends text as is (for malformed-input checks). */
  sendText(text) {
    this.channel.send(text);
  }

  /** Resolves with the first message at or after index `from` that satisfies `predicate`; rejects after `timeoutMs`. */
  waitFor(predicate, { timeoutMs = this.timeoutMs, from = 0, what = 'a matching message' } = {}) {
    const existing = this.messages.slice(from).find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, from };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`timed out after ${timeoutMs} ms waiting for ${what} (last messages: ${summarize(this.messages)})`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  waitForState(state, options = {}) {
    return this.waitFor((m) => m.method === 'continuum/serverState' && m.params?.state === state, { what: `serverState ${state}`, ...options });
  }

  /** Resolves with the params of the first `publishDiagnostics` for `uri` that satisfies `predicate(diagnostics, params)`. */
  async waitForDiagnostics(uri, predicate = () => true, options = {}) {
    const message = await this.waitFor(
      (m) => m.method === 'textDocument/publishDiagnostics' && m.params?.uri === uri && predicate(m.params.diagnostics ?? [], m.params),
      { what: `diagnostics for ${uri}`, ...options },
    );
    return message.params;
  }

  /** Waits `ms` and returns what arrived meanwhile (to assert that nothing did). */
  async quiet(ms) {
    const from = this.mark();
    await new Promise((resolve) => setTimeout(resolve, ms));
    return this.messages.slice(from);
  }

  /** The handshake a client does: `initialize` (answered by the bridge) then `initialized`. */
  async initialize(params = {}) {
    const response = await this.request('initialize', { processId: null, rootUri: null, capabilities: {}, ...params });
    this.notify('initialized', {});
    return response;
  }

  open(uri, text, { version = 1, languageId = 'kotlin' } = {}) {
    this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version, text } });
  }

  /** A full-text change (the only kind the bridge accepts). */
  change(uri, text, version) {
    this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
  }

  closeDocument(uri) {
    this.notify('textDocument/didClose', { textDocument: { uri } });
  }

  #ingest(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.invalid.push(text);
      return;
    }
    this.messages.push(message);
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve({ result: message.result, error: message.error, message, ms: Date.now() - pending.startedAt });
      }
    }
    for (const waiter of [...this.waiters]) {
      if (this.messages.length - 1 >= waiter.from && waiter.predicate(message)) {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  }

  #onClose() {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`channel closed while ${pending.method} was pending`));
      this.pending.delete(id);
    }
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('channel closed while waiting for a message'));
    }
  }
}
