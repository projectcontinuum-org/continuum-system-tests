// Noisy neighbour: does one tenant flooding the system slow down another?
//
//   ALLOW_LOAD=true ./run.sh suites/load/noisy-neighbor.js
//
// setup():       the quiet tenant runs a few workflows ALONE on an idle stack. Their median time is the baseline, and
//                the limit is max(FAIRNESS_MAX_RATIO x baseline, baseline + FAIRNESS_SLACK_MS).
// quiet_alone:   the quiet tenant runs a modest steady rate by itself (a second measurement of the baseline).
// quiet_loud:    the same tenant keeps that rate while a second tenant ("noisy") floods the system at NOISY_FACTOR
//                times the rate. EVERY quiet workflow in this phase is checked against the limit.
// The run fails (exit 99) when fewer than 95% of the quiet tenant's workflows finish OK within the limit, or when its
// success rate drops. The noisy tenant is allowed to degrade itself.
//
// Both tenants use the platform exactly as in production: the same API and Temporal task queues. The platform has no
// per-tenant isolation of compute today, so on a small stack some slowdown is expected; the limit decides how much
// is acceptable.
import { loadCfg, newRun, requireFixtureNodes, requireLoadAllowed, timedWorkflow } from '../../lib/loadrun.js';
import { tenant } from '../../lib/tenant.js';
import { noisyNeighborPlan, scenariosFor } from '../../lib/loadplan.js';
import { loadSummary, phaseRows } from '../../lib/report.js';
import { limitMs, percentile, ratioOf, sampleWarning, verdictLines } from '../../lib/fairness.js';
import { fairnessWithinLimit } from '../../lib/metrics.js';

const env = (name, fallback) => (typeof __ENV !== 'undefined' && __ENV[name] !== undefined ? __ENV[name] : fallback);

const quietRate = Number(env('QUIET_RATE_PER_MIN', String(loadCfg.baseRatePerMin)));
const noisyFactor = Number(env('NOISY_FACTOR', '8'));
const maxRatio = Number(env('FAIRNESS_MAX_RATIO', '2'));
const slackMs = Number(env('FAIRNESS_SLACK_MS', '2000'));
const calibrationRuns = Number(env('CALIBRATION_RUNS', '6'));
const aloneSec = Number(env('ALONE_SEC', '120'));
const noiseSec = Number(env('NOISE_SEC', '180'));

const tl = noisyNeighborPlan(
  { quietRatePerMin: quietRate, noisyRatePerMin: quietRate * noisyFactor, aloneSec, noiseSec },
  loadCfg.scale,
);

export const options = {
  scenarios: scenariosFor(tl, { iterSec: 10, maxVUs: loadCfg.maxVUs }),
  thresholds: {
    checks: ['rate>0.99'],
    // The quiet tenant keeps succeeding, alone and while its neighbour floods the system...
    'workflow_success{scenario:quiet_alone}': ['rate>0.99'],
    'workflow_success{scenario:quiet_loud}': ['rate>0.99'],
    // ...and is not slowed past its limit. This is what fails the run for unfairness.
    fairness_within_limit: ['rate>0.95'],
    'workflow_e2e_ms{scenario:quiet_alone}': ['p(95)>=0', 'p(50)>=0'],
    'workflow_e2e_ms{scenario:quiet_loud}': ['p(95)>=0', 'p(50)>=0'],
    'workflow_e2e_ms{scenario:noisy}': ['p(95)>=0', 'p(50)>=0'],
    'workflow_success{scenario:noisy}': ['rate>=0'],
    'http_req_duration{scenario:quiet_loud,endpoint:workflow_start}': [`p(95)<${loadCfg.startP95MaxMs}`],
    // Report-only, so the start latency of the other phases appears in the table instead of a dash.
    'http_req_duration{scenario:quiet_alone,endpoint:workflow_start}': ['p(95)>=0'],
    'http_req_duration{scenario:noisy,endpoint:workflow_start}': ['p(95)>=0'],
    'dropped_iterations{scenario:quiet_loud}': ['count==0'],
    'dropped_iterations{scenario:quiet_alone}': ['count==0'],
    'dropped_iterations{scenario:noisy}': ['count>=0'],
    'iterations{scenario:noisy}': ['count>=0'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'max'],
};

export function setup() {
  requireLoadAllowed();
  const runId = newRun();
  const quiet = `systest-${runId}-quiet`;
  const noisy = `systest-${runId}-noisy`;
  requireFixtureNodes(tenant(`systest-${runId}-preflight`));

  // Baseline: the quiet tenant alone, one workflow at a time, on an otherwise idle stack. A workflow's time varies
  // from run to run (about 1s to 3s here), so the baseline is the idle TAIL (p90), not the median: against a median,
  // ordinary idle variation would be reported as a slowdown caused by the neighbour.
  const times = [];
  for (let i = 0; i < calibrationRuns; i++) {
    const r = timedWorkflow(runId, quiet);
    if (r.ok) {
      times.push(r.ms);
    }
  }
  const baselineMs = percentile(times, 90);
  const limit = limitMs(baselineMs, maxRatio, slackMs);
  if (limit === undefined) {
    throw new Error(`Could not measure a baseline: none of ${calibrationRuns} calibration workflows finished. Is the stack healthy?`);
  }
  console.log(
    `NOISY NEIGHBOUR: baseline ${Math.round(baselineMs)}ms (p90 of ${times.length} idle runs), limit ${Math.round(limit)}ms. ` +
      `Quiet ${quietRate}/min alone for ${Math.round(aloneSec * loadCfg.scale)}s, then with a neighbour at ` +
      `${quietRate * noisyFactor}/min for ${Math.round(noiseSec * loadCfg.scale)}s.`,
  );
  return { runId, quiet, noisy, baselineMs, limit };
}

export function quietRun(d) {
  const r = timedWorkflow(d.runId, d.quiet);
  // Every quiet workflow is held to the limit, in both phases: the idle phase proves the limit is not set too tight.
  fairnessWithinLimit.add(r.ok && r.ms <= d.limit, { tenant: d.quiet });
}

export function noisyRun(d) {
  timedWorkflow(d.runId, d.noisy);
}

export function handleSummary(data) {
  const rows = phaseRows(data.metrics, tl);
  const alone = rows.find((r) => r.phase === 'quiet_alone') || {};
  const loud = rows.find((r) => r.phase === 'quiet_loud') || {};
  const ratio = ratioOf(loud.e2eP95, alone.e2eP95);
  const setup = data.setup_data || {};
  const text = verdictLines({
    ratio,
    maxRatio,
    alone,
    loud,
    noisy: rows.find((r) => r.phase === 'noisy'),
    baselineMs: setup.baselineMs,
    limit: setup.limit,
  });
  const fair = (data.metrics.fairness_within_limit || {}).values || {};
  const passes = fair.passes || 0;
  const fails = fair.fails || 0;
  if (passes + fails > 0) {
    // This is the line that decides the exit code (the fairness_within_limit threshold), so say it in plain words.
    text.push(
      `Fairness ${fair.rate > 0.95 ? 'PASS' : 'FAIL'}: ${passes} of ${passes + fails} quiet workflows finished OK within the limit (need more than 95%).`,
    );
    const warning = sampleWarning(passes, fails);
    if (warning) {
      text.push(warning);
    }
  }
  return loadSummary(data, { title: 'noisy neighbour', tl, file: 'summary-load-noisy-neighbor.json', maxVUs: loadCfg.maxVUs, extra: ['', ...text.map((t) => `- ${t}`)] });
}
