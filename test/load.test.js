import test from 'node:test';
import assert from 'node:assert/strict';
import { checkLoadAllowed, hostOf } from '../lib/guard.js';
import {
  describe as describePlan,
  gateFor,
  parseDuration,
  phaseAt,
  profilePhases,
  scenariosFor,
  tenantName,
  thresholdsFor,
  timeline,
  vusFor,
} from '../lib/loadplan.js';

// ---- guard ---------------------------------------------------------------------------------------------------------

test('hostOf reads the host from a URL and ignores credentials, ports and case', () => {
  assert.equal(hostOf('http://localhost:8080/x'), 'localhost');
  assert.equal(hostOf('https://User:pw@Staging.Example.com:8443/a?b=c'), 'staging.example.com');
  assert.equal(hostOf('http://[::1]:8080'), '[::1]');
  for (const v of ['', 'localhost:8080', 'not a url', undefined, null]) {
    assert.equal(hostOf(v), '', String(v));
  }
});

test('load is refused unless ALLOW_LOAD is set', () => {
  const r = checkLoadAllowed({ allow: false, allowedHosts: ['localhost'], urls: ['http://localhost:8080'] });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /ALLOW_LOAD=true/);
});

test('load is refused against a host that is not on the allow-list, even with ALLOW_LOAD', () => {
  const r = checkLoadAllowed({ allow: true, allowedHosts: ['localhost'], urls: ['http://localhost:8080', 'https://prod.example.com'] });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /prod\.example\.com/);
  assert.doesNotMatch(r.problems.join(' '), /'localhost'/);
});

test('a look-alike host does not match the allow-list', () => {
  for (const url of ['http://localhost.evil.com', 'http://evil.com/localhost', 'http://user@evil.com@localhost.evil.com']) {
    const r = checkLoadAllowed({ allow: true, allowedHosts: ['localhost'], urls: [url] });
    assert.equal(r.ok, false, url);
  }
});

test('load is allowed for allow-listed hosts, and unused (empty) URLs are ignored', () => {
  const r = checkLoadAllowed({
    allow: true,
    allowedHosts: ['localhost', '127.0.0.1'],
    urls: ['http://localhost:8080', 'http://127.0.0.1:8083', '', undefined],
  });
  assert.deepEqual(r, { ok: true, problems: [] });
});

test('a URL with no readable host is a problem, not a pass', () => {
  const r = checkLoadAllowed({ allow: true, allowedHosts: ['localhost'], urls: ['localhost:8080'] });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /cannot read a host/);
});

// ---- load plan -----------------------------------------------------------------------------------------------------

test('parseDuration reads s, m and h and rejects anything else', () => {
  assert.equal(parseDuration('30s'), 30);
  assert.equal(parseDuration('5m'), 300);
  assert.equal(parseDuration('1h'), 3600);
  assert.equal(parseDuration('1.5m'), 90);
  for (const v of ['', '10', '5 m', 'm5', '5d', undefined]) {
    assert.throws(() => parseDuration(v), /not a duration/, String(v));
  }
});

test('throughput steps the base rate 1x, 2x, 4x, 8x for a minute each', () => {
  const p = profilePhases('throughput', { base: 6 });
  assert.deepEqual(p.map((x) => x.ratePerMin), [6, 12, 24, 48]);
  assert.ok(p.every((x) => x.sec === 60));
});

test('stress climbs to 64x', () => {
  assert.deepEqual(profilePhases('stress', { base: 3 }).map((x) => x.ratePerMin), [3, 6, 12, 24, 48, 96, 192]);
});

test('spike is base, 10x for two minutes, then base again', () => {
  const p = profilePhases('spike', { base: 6 });
  assert.deepEqual(p.map((x) => [x.name, x.ratePerMin, x.sec]), [['before', 6, 60], ['spike', 60, 120], ['after', 6, 120]]);
});

test('soak is four equal quarters at the base rate that add up to the requested length', () => {
  const p = profilePhases('soak', { base: 6, soakSec: 1200 });
  assert.equal(p.length, 4);
  assert.ok(p.every((x) => x.ratePerMin === 6 && x.sec === 300));
});

test('an unknown profile is an error that names the choices', () => {
  assert.throws(() => profilePhases('turbo', { base: 6 }), /throughput, stress, spike, soak/);
  assert.throws(() => gateFor('turbo'), /unknown load profile/);
});

test('timeline lays phases end to end and scales their length', () => {
  const tl = timeline(profilePhases('spike', { base: 6 }), 0.5);
  assert.deepEqual(tl.map((p) => [p.startSec, p.endSec]), [[0, 30], [30, 90], [90, 150]]);
  assert.equal(timeline([{ name: 'a', ratePerMin: 1, sec: 1 }], 0.01)[0].sec, 1); // never shorter than a second
});

test('scenariosFor builds one arrival-rate scenario per phase, in order, with the right start times', () => {
  const sc = scenariosFor(timeline(profilePhases('throughput', { base: 6 })), { maxVUs: 50 });
  assert.deepEqual(Object.keys(sc), ['step1x', 'step2x', 'step4x', 'step8x']);
  assert.equal(sc.step1x.startTime, '0s');
  assert.equal(sc.step4x.startTime, '120s');
  assert.equal(sc.step2x.executor, 'constant-arrival-rate');
  assert.equal(sc.step2x.rate, 12);
  assert.equal(sc.step2x.timeUnit, '1m');
  assert.ok(Object.values(sc).every((s) => s.preAllocatedVUs >= 2 && s.preAllocatedVUs <= s.maxVUs));
});

test('vusFor grows with the rate and is capped', () => {
  assert.equal(vusFor(1, 10, 100), 2);
  assert.ok(vusFor(600, 10, 100) > vusFor(60, 10, 100));
  assert.equal(vusFor(100000, 10, 40), 40);
});

test('phaseAt finds the running phase and is undefined past the end', () => {
  const tl = timeline(profilePhases('spike', { base: 6 }));
  assert.equal(phaseAt(tl, 0).name, 'before');
  assert.equal(phaseAt(tl, 60).name, 'spike');
  assert.equal(phaseAt(tl, 179).name, 'spike');
  assert.equal(phaseAt(tl, 180).name, 'after');
  assert.equal(phaseAt(tl, 300), undefined);
});

test('thresholds gate the phases a profile allows, and only report on the others', () => {
  const tl = timeline(profilePhases('spike', { base: 6 }));
  const t = thresholdsFor(tl, { gate: gateFor('spike'), e2eP95MaxMs: 30000, startP95MaxMs: 1000 });
  assert.deepEqual(t['workflow_success{scenario:before}'], ['rate>0.99']);
  assert.deepEqual(t['workflow_success{scenario:spike}'], ['rate>=0']);
  assert.ok(t['workflow_e2e_ms{scenario:after}'].includes('p(95)<30000'));
  assert.ok(!t['workflow_e2e_ms{scenario:spike}'].some((x) => /<\d/.test(x)));
  assert.deepEqual(t['dropped_iterations{scenario:before}'], ['count==0']);
  assert.deepEqual(t['dropped_iterations{scenario:spike}'], ['count>=0']);
  // every phase's sub-metrics are declared, or k6 would leave them out of the end-of-test data
  for (const p of tl) {
    for (const key of [`workflow_e2e_ms{scenario:${p.name}}`, `workflow_success{scenario:${p.name}}`, `iterations{scenario:${p.name}}`]) {
      assert.ok(t[key], key);
    }
  }
});

test('stress aborts on a broken system instead of failing a gate', () => {
  const tl = timeline(profilePhases('stress', { base: 3 }));
  const t = thresholdsFor(tl, { gate: gateFor('stress'), e2eP95MaxMs: 1, startP95MaxMs: 1, abortOnBreak: true });
  assert.equal(t.workflow_success[0].abortOnFail, true);
  assert.equal(t.http_req_failed[0].abortOnFail, true);
  assert.deepEqual(t['workflow_success{scenario:step64x}'], ['rate>=0']);
});

test('describe summarises the offered load', () => {
  assert.equal(describePlan(timeline(profilePhases('spike', { base: 6 }))), 'before 6/min for 60s -> spike 60/min for 120s -> after 6/min for 120s');
});

test('tenantName spreads iterations round-robin over the tenants', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => tenantName('r1', i, 3)), ['systest-r1-t0', 'systest-r1-t1', 'systest-r1-t2', 'systest-r1-t0', 'systest-r1-t1']);
  assert.equal(tenantName('r1', 5, 0), 'systest-r1-t0');
});
