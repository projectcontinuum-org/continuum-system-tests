import test from 'node:test';
import assert from 'node:assert/strict';
import { dropCause, formatTable, findings, loadSummary, ms, phaseRows, tenantSpread } from '../lib/report.js';
import { limitMs, median, percentile, ratioOf, sampleWarning, verdictLines } from '../lib/fairness.js';
import { noisyGate, noisyNeighborPlan, scenariosFor } from '../lib/loadplan.js';

const tl = [
  { name: 'step1x', ratePerMin: 6, sec: 60 },
  { name: 'step2x', ratePerMin: 12, sec: 60 },
];

// A k6 v2 end-of-test metrics object, as handleSummary receives it.
const metrics = (perPhase) => {
  const m = {};
  for (const [name, v] of Object.entries(perPhase)) {
    m[`workflow_e2e_ms{scenario:${name}}`] = { values: { med: v.p50, 'p(95)': v.p95, max: v.max } };
    m[`workflow_success{scenario:${name}}`] = { values: { passes: v.passes, fails: v.fails } };
    m[`iterations{scenario:${name}}`] = { values: { count: v.passes + v.fails } };
    if (v.dropped) {
      m[`dropped_iterations{scenario:${name}}`] = { values: { count: v.dropped } };
    }
    m[`http_req_duration{scenario:${name},endpoint:workflow_start}`] = { values: { 'p(95)': v.start } };
  }
  return m;
};

test('phaseRows never turns a phase with no finished workflow into a 0 ms latency', () => {
  // k6 reports an empty Trend as all zeros, and a Rate with failures only as passes: 0, fails: N.
  const m = {
    'workflow_e2e_ms{scenario:step1x}': { values: { med: 0, 'p(95)': 0, max: 0 } },
    'workflow_success{scenario:step1x}': { values: { passes: 0, fails: 3 } },
  };
  const [row] = phaseRows(m, [{ name: 'step1x', ratePerMin: 6, sec: 60 }]);
  assert.equal(row.workflows, 3);
  assert.equal(row.success, 0);
  assert.equal(row.e2eP95, undefined);
  assert.equal(row.e2eP50, undefined);
  assert.equal(row.e2eMax, undefined);
});

test('loadSummary writes no result file when no workflow ran', () => {
  const out = loadSummary({ metrics: {} }, { title: 'load throughput', tl, file: 'summary-load-throughput.json' });
  assert.deepEqual(Object.keys(out), ['stdout']);
  assert.match(out.stdout, /No workflow ran, so there is no report/);
});

test('loadSummary writes the table and a JSON file when workflows ran', () => {
  const m = metrics({ step1x: { p50: 3000, p95: 3500, max: 4000, passes: 5, fails: 0, start: 40 } });
  const out = loadSummary({ metrics: m }, { title: 'load throughput', tl, file: 'summary-load-throughput.json' });
  assert.deepEqual(Object.keys(out).sort(), ['stdout', 'summary-load-throughput.json']);
  assert.match(out.stdout, /=== load throughput ===/);
  const json = JSON.parse(out['summary-load-throughput.json']);
  assert.equal(json.phases[0].e2eP95, 3500);
  assert.equal(json.phases[1].e2eP95, undefined); // dropped by JSON.stringify, so absent rather than a fake 0
});

test('ms formats milliseconds and seconds, and a missing number as a dash', () => {
  assert.equal(ms(420), '420ms');
  assert.equal(ms(3080), '3.1s');
  assert.equal(ms(undefined), '-');
  assert.equal(ms(NaN), '-');
});

test('phaseRows reads the per-phase numbers and never turns a missing phase into zero', () => {
  const rows = phaseRows(metrics({ step1x: { p50: 3000, p95: 3500, max: 4000, passes: 5, fails: 0, start: 40 } }), tl);
  assert.equal(rows[0].workflows, 5);
  assert.equal(rows[0].success, 1);
  assert.equal(rows[0].e2eP95, 3500);
  assert.equal(rows[0].startP95, 40);
  assert.equal(rows[1].workflows, 0);
  assert.equal(rows[1].success, undefined); // no data is "unknown", not "0% succeeded"
  assert.equal(rows[1].e2eP95, undefined);
  assert.equal(rows[1].dropped, 0);
});

test('formatTable lines columns up and shows dashes for phases with no data', () => {
  const rows = phaseRows(metrics({ step1x: { p50: 3000, p95: 3500, max: 4000, passes: 5, fails: 0, start: 40 } }), tl);
  const lines = formatTable(rows).split('\n');
  assert.equal(lines.length, 4); // header, rule, two phases
  assert.match(lines[0], /phase\s+offered\s+for\s+workflows\s+success\s+e2e p50/);
  assert.match(lines[2], /step1x\s+6\/min\s+60s\s+5\s+100\.0%\s+3\.0s/);
  assert.match(lines[3], /step2x\s+12\/min\s+60s\s+0\s+-/);
  assert.ok(new Set(lines.map((l) => l.length)).size === 1, 'all rows are the same width');
});

test('findings report where latency doubles and where workflows start to fail', () => {
  const rows = phaseRows(
    metrics({
      step1x: { p50: 3000, p95: 3200, max: 3500, passes: 6, fails: 0, start: 30 },
      step2x: { p50: 9000, p95: 9500, max: 11000, passes: 10, fails: 2, start: 80 },
    }),
    tl,
  );
  const f = findings(rows).join(' ');
  assert.match(f, /Latency doubles at step2x \(12\/min\): p95 3\.2s -> 9\.5s/);
  assert.match(f, /start failing at step2x \(12\/min\): 83\.3% succeeded/);
});

test('findings say so when nothing degraded', () => {
  const rows = phaseRows(
    metrics({
      step1x: { p50: 3000, p95: 3200, max: 3500, passes: 6, fails: 0, start: 30 },
      step2x: { p50: 3100, p95: 3300, max: 3600, passes: 12, fails: 0, start: 30 },
    }),
    tl,
  );
  const f = findings(rows).join(' ');
  assert.match(f, /within 2x/);
  assert.match(f, /Every workflow in every phase succeeded/);
});

test('findings blame the load generator when iterations are dropped', () => {
  // 48/min with a 100 s p95 needs 48/60 * 100 = 80 VUs; the limit of 40 is the bottleneck.
  const rows = phaseRows(metrics({ step1x: { p50: 3000, p95: 100000, max: 120000, passes: 6, fails: 0, start: 30, dropped: 40 } }), [{ name: 'step1x', ratePerMin: 48, sec: 60 }]);
  assert.match(findings(rows, { maxVUs: 40 }).join(' '), /40 iterations dropped\. At p95 100\.0s this phase needs about 80 virtual users and the limit is 40: raise MAX_VUS/);
});

test('findings do NOT blame the VU limit when the phase needed far fewer VUs than the limit', () => {
  // The 20x noisy-neighbour run: 6/min with a 47.6 s p95 needs about 5 VUs of 100. The platform was saturated.
  const rows = phaseRows(metrics({ step1x: { p50: 34800, p95: 47620, max: 48400, passes: 16, fails: 0, start: 32, dropped: 3 } }), [{ name: 'step1x', ratePerMin: 6, sec: 180 }]);
  const f = findings(rows, { maxVUs: 100 }).join(' ');
  assert.match(f, /3 iterations dropped\. The VU limit \(100\) is NOT the cause: this phase needs only about 5/);
  assert.match(f, /already saturated/);
  assert.doesNotMatch(f, /raise MAX_VUS/);
});

test('dropCause is undefined when nothing was dropped or no latency was measured', () => {
  assert.equal(dropCause({ dropped: 0, rate: 6, e2eP95: 1000 }, 100), undefined);
  assert.equal(dropCause({ dropped: 5, rate: 6, e2eP95: undefined }, 100), undefined);
  assert.deepEqual(dropCause({ dropped: 5, rate: 120, e2eP95: 54442 }, 100), { needed: 109, limited: true });
  assert.deepEqual(dropCause({ dropped: 3, rate: 6, e2eP95: 47620 }, 100), { needed: 5, limited: false });
});

test('findings do not invent a result when no phase finished a workflow', () => {
  const rows = phaseRows({}, tl);
  assert.match(findings(rows)[0], /No workflow finished in any phase/);
});

test('tenantSpread compares the slowest and fastest tenant', () => {
  const m = {
    'workflow_e2e_ms{scenario:s,tenant:a}': { values: { 'p(95)': 3000 } },
    'workflow_e2e_ms{scenario:s,tenant:b}': { values: { 'p(95)': 4500 } },
  };
  const s = tenantSpread(m, ['a', 'b', 'c'], 's');
  assert.deepEqual([s.tenants, s.min, s.max, s.ratio], [2, 3000, 4500, 1.5]);
  assert.equal(tenantSpread({}, ['a'], 's'), undefined);
});

// ---- fairness ------------------------------------------------------------------------------------------------------

test('median handles odd, even and empty input and ignores junk', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), undefined);
  assert.equal(median([undefined, NaN, 5]), 5);
});

test('percentile is the nearest rank, and for a small sample the p90 is the slowest run', () => {
  assert.equal(percentile([1000, 1100, 1200, 3000, 1050, 1150], 90), 3000);
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([7], 90), 7);
  assert.equal(percentile([], 90), undefined);
  assert.equal(percentile([undefined, NaN, 4], 90), 4);
});

test('a baseline from the idle p90 is not undercut by ordinary idle variation', () => {
  // The run that failed in practice: idle runs of about 1s with an occasional 3s one. The median (1.084s) gave a
  // 3.084s limit, which a normal idle 3.1s run then exceeded. The p90 sees the slow one.
  const idle = [1050, 1078, 1100, 3000, 1090, 1060];
  assert.equal(median(idle), 1084); // sorted: 1050 1060 1078 1090 1100 3000, so (1078 + 1090) / 2
  assert.equal(limitMs(median(idle), 2, 2000), 3084);
  assert.equal(percentile(idle, 90), 3000);
  assert.equal(limitMs(percentile(idle, 90), 2, 2000), 6000);
});

test('sampleWarning says when there are too few quiet workflows for the 95% requirement', () => {
  assert.match(sampleWarning(11, 1), /Only 12 quiet workflows.*fewer than 20.*one slow workflow/);
  assert.equal(sampleWarning(19, 1), undefined);
  assert.equal(sampleWarning(100, 0), undefined);
  assert.match(sampleWarning(0, 0), /Only 0 quiet workflows/);
  assert.match(sampleWarning(undefined, undefined), /Only 0/);
});

test('limitMs is the ratio times the baseline, but never tighter than baseline plus the slack', () => {
  assert.equal(limitMs(10000, 2, 2000), 20000); // ratio dominates
  assert.equal(limitMs(500, 2, 2000), 2500); // slack dominates: a fast stack gets room for jitter
  assert.equal(limitMs(0, 2), undefined);
  assert.equal(limitMs(undefined, 2), undefined);
  assert.equal(limitMs(-5, 2), undefined);
});

test('ratioOf is undefined rather than infinite or zero when a number is missing', () => {
  assert.equal(ratioOf(6000, 3000), 2);
  for (const [a, b] of [[undefined, 3000], [6000, undefined], [6000, 0], [NaN, 3000]]) {
    assert.equal(ratioOf(a, b), undefined, `${a}/${b}`);
  }
});

test('verdictLines report the baseline, the limit and the slowdown', () => {
  const text = verdictLines({
    ratio: 1.5,
    maxRatio: 2,
    alone: { e2eP95: 3000 },
    loud: { e2eP95: 4500, success: 1 },
    noisy: { workflows: 40, e2eP95: 12000, success: 0.9 },
    baselineMs: 3000,
    limit: 6000,
  }).join('\n');
  assert.match(text, /baseline for the quiet tenant: 3000ms \(p90 of the calibration runs\).*limit.*6000ms/i);
  assert.match(text, /3000ms alone -> 4500ms with a loud neighbour \(1\.50x; the limit is 2x\)/);
  assert.match(text, /noisy tenant itself: 40 workflows, p95 12000ms, 90\.0% succeeded/);
});

test('verdictLines say when no ratio could be computed instead of passing', () => {
  const text = verdictLines({ ratio: undefined, maxRatio: 2, alone: {}, loud: {}, baselineMs: 3000, limit: 6000 }).join('\n');
  assert.match(text, /No phase-to-phase ratio could be computed/);
});

test('noisyNeighborPlan runs the quiet tenant alone first, then beside the noisy one for the same stretch', () => {
  const plan = noisyNeighborPlan({ quietRatePerMin: 6, noisyRatePerMin: 48, aloneSec: 120, noiseSec: 180 });
  const by = Object.fromEntries(plan.map((p) => [p.name, p]));
  assert.deepEqual([by.quiet_alone.startSec, by.quiet_alone.endSec], [0, 120]);
  assert.deepEqual([by.quiet_loud.startSec, by.noisy.startSec], [120, 120]);
  assert.deepEqual([by.quiet_loud.endSec, by.noisy.endSec], [300, 300]);
  assert.equal(by.quiet_loud.ratePerMin, by.quiet_alone.ratePerMin, 'the quiet tenant keeps its rate');
  assert.equal(by.noisy.ratePerMin, 48);
  assert.deepEqual(plan.map((p) => p.exec), ['quietRun', 'quietRun', 'noisyRun']);
});

test('noisyNeighborPlan scales both phases and never makes one shorter than a second', () => {
  const plan = noisyNeighborPlan({ quietRatePerMin: 6, noisyRatePerMin: 48, aloneSec: 120, noiseSec: 180 }, 0.001);
  assert.ok(plan.every((p) => p.sec >= 1));
});

test('scenariosFor honours a per-phase exec function and only the quiet-loud phase is gated', () => {
  const plan = noisyNeighborPlan({ quietRatePerMin: 6, noisyRatePerMin: 48, aloneSec: 60, noiseSec: 60 });
  const sc = scenariosFor(plan, { exec: 'ignored' });
  assert.deepEqual([sc.quiet_alone.exec, sc.quiet_loud.exec, sc.noisy.exec], ['quietRun', 'quietRun', 'noisyRun']);
  assert.equal(sc.noisy.rate, 48);
  assert.equal(sc.noisy.startTime, sc.quiet_loud.startTime);
  assert.deepEqual(plan.filter(noisyGate).map((p) => p.name), ['quiet_loud']);
});
