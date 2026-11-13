import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isTerminal,
  newRunId,
  normalizeStatus,
  pageContent,
  randomHex,
  renameWorkflow,
  safeJson,
} from '../lib/util.js';

test('normalizeStatus accepts the proto name, the short name and the ordinal', () => {
  assert.equal(normalizeStatus('WORKFLOW_EXECUTION_STATUS_COMPLETED'), 'COMPLETED');
  assert.equal(normalizeStatus('completed'), 'COMPLETED');
  assert.equal(normalizeStatus(2), 'COMPLETED');
  assert.equal(normalizeStatus('2'), 'COMPLETED');
  assert.equal(normalizeStatus(1), 'RUNNING');
  assert.equal(normalizeStatus(7), 'TIMED_OUT');
});

test('normalizeStatus returns UNKNOWN for anything it cannot read', () => {
  for (const v of [undefined, null, '', 99, {}, []]) {
    assert.equal(normalizeStatus(v), 'UNKNOWN');
  }
});

test('only finished statuses are terminal', () => {
  for (const s of ['COMPLETED', 'FAILED', 'CANCELED', 'TERMINATED', 'TIMED_OUT', 'CONTINUED_AS_NEW']) {
    assert.equal(isTerminal(s), true, s);
  }
  for (const s of ['RUNNING', 'UNKNOWN', 'UNSPECIFIED']) {
    assert.equal(isTerminal(s), false, s);
  }
});

test('randomHex returns exactly the requested number of hex characters', () => {
  assert.match(randomHex(64), /^[0-9a-f]{64}$/);
  assert.equal(randomHex(0), '');
});

test('newRunId is short, url-safe and different on every call', () => {
  const a = newRunId();
  const b = newRunId();
  assert.match(a, /^[0-9a-z]+$/);
  assert.ok(a.length <= 16, a);
  assert.notEqual(a, b);
});

test('renameWorkflow gives a fresh id and a url-safe path name without touching the fixture', () => {
  const fixture = { id: 'old', name: 'old.cwf', active: false, nodes: [{ id: '1' }], edges: [] };
  const copy = renameWorkflow(fixture, { runId: 'abc1', tenant: 'systest-abc1-a', n: 3 });
  assert.match(copy.id, /^[0-9a-f]{64}$/);
  assert.equal(copy.name, '/systest/abc1/systest-abc1-a/wf-3.cwf');
  assert.doesNotThrow(() => new URL(`file://${copy.name}`));
  assert.deepEqual(fixture, { id: 'old', name: 'old.cwf', active: false, nodes: [{ id: '1' }], edges: [] });
  copy.nodes[0].id = 'changed';
  assert.equal(fixture.nodes[0].id, '1');
});

test('pageContent reads Spring DTO pages and tolerates anything else', () => {
  assert.deepEqual(pageContent({ content: [{ a: 1 }], page: { size: 20 } }), [{ a: 1 }]);
  for (const v of [undefined, null, {}, { content: 'x' }, []]) {
    assert.deepEqual(pageContent(v), []);
  }
});

test('safeJson returns undefined instead of throwing on a non-JSON body', () => {
  assert.deepEqual(safeJson('{"a":1}'), { a: 1 });
  assert.equal(safeJson('<html>'), undefined);
  assert.equal(safeJson(''), undefined);
});
