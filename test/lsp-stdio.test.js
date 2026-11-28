import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { encodeMessage, MessageParser, StdioLspClient, answerToServerRequest } from '../lib/lsp-stdio.mjs';

const collect = () => {
  const messages = [];
  const errors = [];
  return { messages, errors, parser: new MessageParser((m) => messages.push(m), (e) => errors.push(e.message)) };
};

test('encodeMessage counts bytes, not characters', () => {
  const frame = encodeMessage({ jsonrpc: '2.0', method: 'x', params: { text: 'héllo 😀' } });
  const text = frame.toString('utf8');
  const [header, body] = text.split('\r\n\r\n');
  assert.equal(Number(/Content-Length: (\d+)/.exec(header)[1]), Buffer.byteLength(body, 'utf8'));
  assert.deepEqual(JSON.parse(body).params, { text: 'héllo 😀' });
});

test('the parser rebuilds messages whatever the chunk boundaries, one byte at a time included', () => {
  const frames = Buffer.concat([
    encodeMessage({ jsonrpc: '2.0', id: 1, result: { text: 'héllo 😀' } }),
    encodeMessage({ jsonrpc: '2.0', method: 'a', params: {} }),
  ]);
  for (const size of [1, 2, 7, 64, frames.length]) {
    const { messages, errors, parser } = collect();
    for (let at = 0; at < frames.length; at += size) {
      parser.push(frames.subarray(at, at + size));
    }
    assert.equal(errors.length, 0, `chunk size ${size}`);
    assert.deepEqual(messages.map((m) => m.id ?? m.method), [1, 'a'], `chunk size ${size}`);
    assert.equal(messages[0].result.text, 'héllo 😀');
  }
});

test('a frame without Content-Length is reported and skipped; a body that is not JSON is reported and the stream continues', () => {
  const { messages, errors, parser } = collect();
  parser.push(Buffer.from('X-Other: 1\r\n\r\n'));
  const bad = Buffer.from('not json');
  parser.push(Buffer.concat([Buffer.from(`Content-Length: ${bad.length}\r\n\r\n`), bad]));
  parser.push(encodeMessage({ jsonrpc: '2.0', method: 'fine' }));
  assert.equal(errors.length, 2);
  assert.deepEqual(messages.map((m) => m.method), ['fine']);
});

test('the parser accepts a lower-case header name', () => {
  const { messages, parser } = collect();
  const body = Buffer.from('{"a":1}');
  parser.push(Buffer.concat([Buffer.from(`content-length: ${body.length}\r\n\r\n`), body]));
  assert.deepEqual(messages, [{ a: 1 }]);
});

test('answerToServerRequest gives an editor-like answer: nulls per configuration item, else null', () => {
  assert.deepEqual(answerToServerRequest({ method: 'workspace/configuration', params: { items: [{}, {}] } }), [null, null]);
  assert.equal(answerToServerRequest({ method: 'window/workDoneProgress/create' }), null);
});

function pair() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const sent = [];
  const parser = new MessageParser((m) => sent.push(m));
  stdin.on('data', (chunk) => parser.push(chunk));
  return { stdin, stdout, sent, client: new StdioLspClient({ stdin, stdout }, { timeoutMs: 300 }) };
}
const serverSends = (stdout, message) => stdout.write(encodeMessage(message));
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test('a request resolves with the matching response, result or error', async () => {
  const { client, stdout, sent } = pair();
  const first = client.request('textDocument/completion', { a: 1 });
  const second = client.request('textDocument/hover', {});
  await tick();
  assert.deepEqual(sent.map((m) => [m.id, m.method]), [[1, 'textDocument/completion'], [2, 'textDocument/hover']]);
  serverSends(stdout, { jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'boom' } });
  serverSends(stdout, { jsonrpc: '2.0', id: 1, result: [1, 2, 3] });
  assert.deepEqual((await first).result, [1, 2, 3]);
  assert.equal((await second).error.code, -32603);
});

test('a request with no response rejects after the timeout', async () => {
  const { client } = pair();
  await assert.rejects(client.request('initialize', {}, { timeoutMs: 50 }), /no response to initialize within 50 ms/);
});

test('a request from the server is answered, and a notification is kept and awaited', async () => {
  const { client, stdout, sent } = pair();
  serverSends(stdout, { jsonrpc: '2.0', id: 'srv-1', method: 'workspace/configuration', params: { items: [{ section: 'kotlin' }] } });
  await tick();
  assert.deepEqual(sent.find((m) => m.id === 'srv-1'), { jsonrpc: '2.0', id: 'srv-1', result: [null] });
  const waiting = client.waitFor((m) => m.method === 'textDocument/publishDiagnostics', { what: 'diagnostics' });
  serverSends(stdout, { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'x', diagnostics: [] } });
  assert.equal((await waiting).params.uri, 'x');
  assert.equal((await client.waitFor((m) => m.method === 'textDocument/publishDiagnostics')).params.uri, 'x');
  await assert.rejects(client.waitFor((m) => m.method === 'never', { timeoutMs: 30, what: 'a message that never comes' }), /timed out after 30 ms waiting for a message that never comes/);
});

test('notify writes a notification frame', async () => {
  const { client, sent } = pair();
  client.notify('initialized', {});
  await tick();
  assert.deepEqual(sent, [{ jsonrpc: '2.0', method: 'initialized', params: {} }]);
});
