import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LspSession } from '../lib/lsp-session.mjs';

/** The part of a TheiaChannel an LspSession uses: send, received, closed and message/close events. */
class FakeChannel extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.received = [];
    this.closed = false;
  }

  send(text) {
    this.sent.push(JSON.parse(text));
  }

  deliver(message) {
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    this.received.push(text);
    this.emit('message', text);
  }

  close() {
    this.closed = true;
    this.emit('close');
  }
}

const state = (value) => ({ jsonrpc: '2.0', method: 'continuum/serverState', params: { state: value } });

test('a request is sent with a fresh id and resolves with the result of the response carrying that id', async () => {
  const channel = new FakeChannel();
  const session = new LspSession(channel);
  const first = session.request('textDocument/hover', { a: 1 });
  const second = session.request('textDocument/completion', { b: 2 });
  assert.deepEqual(channel.sent.map((m) => [m.id, m.method]), [[1, 'textDocument/hover'], [2, 'textDocument/completion']]);
  channel.deliver({ jsonrpc: '2.0', id: 2, result: { items: [] } });
  channel.deliver({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'refused' } });
  assert.deepEqual((await second).result, { items: [] });
  const hover = await first;
  assert.equal(hover.error.code, -32602);
  assert.equal(hover.result, undefined);
  assert.equal(typeof hover.ms, 'number');
});

test('a request times out with the last messages in the error, and a closed channel rejects pending requests', async () => {
  const channel = new FakeChannel();
  const session = new LspSession(channel, { timeoutMs: 20 });
  channel.deliver(state('starting'));
  await assert.rejects(session.request('x', {}), /no response to x within 20 ms.*serverState|no response to x within 20 ms.*starting/s);
  const pending = session.request('y', {}, { timeoutMs: 5000 });
  channel.close();
  await assert.rejects(pending, /channel closed while y was pending/);
  await assert.rejects(session.request('z', {}), /channel closed before z/);
});

test('server state notices are collected in order; messages delivered before the session existed are not lost', () => {
  const channel = new FakeChannel();
  channel.received.push(JSON.stringify(state('starting')));
  const session = new LspSession(channel);
  channel.deliver(state('ready'));
  assert.deepEqual(session.states, ['starting', 'ready']);
  assert.equal(session.lastState, 'ready');
});

test('waitFor sees messages that already arrived, only those at or after `from`, and later ones', async () => {
  const channel = new FakeChannel();
  const session = new LspSession(channel, { timeoutMs: 1000 });
  channel.deliver(state('starting'));
  const mark = session.mark();
  assert.equal((await session.waitForState('starting')).params.state, 'starting');
  const later = session.waitForState('ready', { from: mark });
  channel.deliver(state('ready'));
  assert.equal((await later).params.state, 'ready');
  await assert.rejects(session.waitForState('starting', { from: mark, timeoutMs: 20 }), /timed out after 20 ms waiting for serverState starting/);
});

test('waitFor is rejected when the channel closes while waiting', async () => {
  const channel = new FakeChannel();
  const session = new LspSession(channel, { timeoutMs: 1000 });
  const waiting = session.waitForState('ready');
  channel.close();
  await assert.rejects(waiting, /channel closed while waiting/);
});

test('diagnostics are filtered by URI and by position in the stream', async () => {
  const channel = new FakeChannel();
  const session = new LspSession(channel, { timeoutMs: 1000 });
  const publish = (uri, diagnostics) => ({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } });
  channel.deliver(publish('continuum-script:/a.kt', [{ message: 'a1' }]));
  const mark = session.mark();
  channel.deliver(publish('continuum-script:/b.kt', [{ message: 'b1' }]));
  channel.deliver(publish('continuum-script:/a.kt', []));
  assert.equal(session.diagnosticEvents().length, 3);
  assert.equal(session.diagnosticEvents({ uri: 'continuum-script:/a.kt' }).length, 2);
  assert.equal(session.diagnosticEvents({ uri: 'continuum-script:/a.kt', from: mark }).length, 1);
  const params = await session.waitForDiagnostics('continuum-script:/a.kt', (list) => list.length === 0, { from: mark });
  assert.deepEqual(params.diagnostics, []);
});

test('notifications have no id; open, change and close carry the full-text shapes the bridge accepts', () => {
  const channel = new FakeChannel();
  const session = new LspSession(channel);
  session.open('continuum-script:/a.kt', 'text');
  session.change('continuum-script:/a.kt', 'text2', 2);
  session.closeDocument('continuum-script:/a.kt');
  assert.deepEqual(channel.sent, [
    { jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: 'continuum-script:/a.kt', languageId: 'kotlin', version: 1, text: 'text' } } },
    { jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri: 'continuum-script:/a.kt', version: 2 }, contentChanges: [{ text: 'text2' }] } },
    { jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri: 'continuum-script:/a.kt' } } },
  ]);
});

test('the initialize handshake sends initialize, waits for its answer, then sends initialized', async () => {
  const channel = new FakeChannel();
  const session = new LspSession(channel, { timeoutMs: 1000 });
  const done = session.initialize({ rootUri: 'file:///x' });
  assert.equal(channel.sent[0].method, 'initialize');
  assert.equal(channel.sent[0].params.rootUri, 'file:///x');
  assert.equal(channel.sent.length, 1);
  channel.deliver({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } });
  assert.deepEqual((await done).result, { capabilities: {} });
  assert.equal(channel.sent[1].method, 'initialized');
});

test('text that is not JSON is kept apart; a request that comes from the server side is visible as such', () => {
  const channel = new FakeChannel();
  const session = new LspSession(channel);
  channel.deliver('not json');
  channel.deliver({ jsonrpc: '2.0', id: 7, method: 'workspace/configuration', params: {} });
  channel.deliver({ jsonrpc: '2.0', method: 'window/logMessage', params: {} });
  assert.deepEqual(session.invalid, ['not json']);
  assert.deepEqual(session.serverRequests.map((m) => m.method), ['workspace/configuration']);
});

test('quiet() returns what arrived during the wait and nothing from before it', async () => {
  const channel = new FakeChannel();
  const session = new LspSession(channel);
  channel.deliver(state('ready'));
  const waiting = session.quiet(30);
  channel.deliver(state('starting'));
  const arrived = await waiting;
  assert.deepEqual(arrived.map((m) => m.params.state), ['starting']);
});
