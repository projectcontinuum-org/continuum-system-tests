import test from 'node:test';
import assert from 'node:assert/strict';
import { STATUS, createRecorder } from '../lib/runner.mjs';

function recorder(only = []) {
  const lines = [];
  return { rec: createRecorder({ print: (line) => lines.push(line), only }), lines };
}

test('a check passes for true, a string and { ok: true }, and fails for anything else', async () => {
  const { rec } = recorder();
  await rec.check('g', 'true', () => true);
  await rec.check('g', 'string', () => 'the detail');
  await rec.check('g', 'object ok', () => ({ ok: true, detail: 'd' }));
  await rec.check('g', 'object not ok', () => ({ ok: false, detail: 'why' }));
  await rec.check('g', 'false', () => false);
  await rec.check('g', 'nothing', () => undefined);
  await rec.check('g', 'truthy number', () => 1);
  assert.deepEqual(rec.results.map((r) => r.status), [STATUS.pass, STATUS.pass, STATUS.pass, STATUS.fail, STATUS.fail, STATUS.fail, STATUS.fail]);
  assert.equal(rec.results[1].detail, 'the detail');
  assert.equal(rec.results[3].detail, 'why');
});

test('a throwing or rejecting check is a failure carrying the message, and later checks still run', async () => {
  const { rec } = recorder();
  await rec.check('g', 'throws', () => { throw new Error('boom'); });
  await rec.check('g', 'rejects', async () => { throw new Error('async boom'); });
  await rec.check('g', 'after', () => true);
  assert.deepEqual(rec.results.map((r) => r.status), [STATUS.fail, STATUS.fail, STATUS.pass]);
  assert.match(rec.results[0].detail, /threw: boom/);
  assert.match(rec.results[1].detail, /threw: async boom/);
});

test('a skipped check says NOT VERIFIED with the reason and is never counted as a pass', () => {
  const { rec, lines } = recorder();
  rec.skip('g', 'needs docker', 'no docker here');
  assert.equal(rec.results[0].status, STATUS.skip);
  assert.equal(rec.results[0].detail, 'NOT VERIFIED: no docker here');
  assert.match(lines[0], /^SKIP\s+g {2}needs docker {2}-- NOT VERIFIED: no docker here$/);
  assert.deepEqual(rec.summary(), { pass: 0, fail: 0, skip: 1, knownGap: 0, total: 1 });
});

test('a known gap that is still open does not fail the run, one that was fixed is a pass', () => {
  const { rec } = recorder();
  rec.knownGap('g', 'still broken', false, 'x');
  assert.equal(rec.exitCode(), 0);
  rec.knownGap('g', 'fixed', true);
  assert.deepEqual(rec.results.map((r) => r.status), [STATUS.knownGap, STATUS.pass]);
});

test('the exit code is 1 when any check failed and 0 otherwise (skips and known gaps do not count)', async () => {
  const { rec } = recorder();
  assert.equal(rec.exitCode(), 0);
  rec.skip('g', 's', 'r');
  rec.knownGap('g', 'k', false);
  assert.equal(rec.exitCode(), 0);
  rec.record('g', 'bad', false);
  assert.equal(rec.exitCode(), 1);
  assert.deepEqual(rec.summary(), { pass: 0, fail: 1, skip: 1, knownGap: 1, total: 3 });
});

test('groups can be selected; without a selection every group is selected and a deselected check does not run', async () => {
  const all = recorder();
  assert.equal(all.rec.selected('anything'), true);
  const some = recorder(['a', 'b']);
  assert.equal(some.rec.selected('a'), true);
  assert.equal(some.rec.selected('c'), false);
  let ran = false;
  await some.rec.check('c', 'not selected', () => { ran = true; return true; });
  assert.equal(ran, false);
  assert.equal(some.rec.results.length, 0);
});

test('every result is printed on one line with status, group, name and detail', () => {
  const { rec, lines } = recorder();
  rec.record('lifecycle', 'idle stop', true, '15.4 s');
  rec.record('lifecycle', 'no detail', false);
  assert.equal(lines[0], 'PASS      lifecycle  idle stop  -- 15.4 s');
  assert.equal(lines[1], 'FAIL      lifecycle  no detail');
});
