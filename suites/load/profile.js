// Load profiles: throughput | stress | spike | soak. One script; PROFILE selects the shape.
//
//   ALLOW_LOAD=true PROFILE=throughput ./run.sh suites/load/profile.js
//
// What it does: many tenants each start the AnomalyDetector workflow and wait for it to finish. The offered rate is
// stepped (see lib/loadplan.js), and every step is its own k6 scenario, so each gets its own latency and success
// numbers in the report. It REFUSES to run unless ALLOW_LOAD=true and every target host is on LOAD_ALLOWED_HOSTS
// (default: localhost, 127.0.0.1): a run creates workflows, object-store files and database rows that cannot be
// deleted through the API.
import { loadCfg, newRun, oneWorkflow, requireFixtureNodes, requireLoadAllowed, tenantForIteration } from '../../lib/loadrun.js';
import { tenant } from '../../lib/tenant.js';
import { describe, gateFor, profilePhases, scenariosFor, thresholdsFor, timeline } from '../../lib/loadplan.js';
import { loadSummary } from '../../lib/report.js';

const phases = profilePhases(loadCfg.profile, { base: loadCfg.baseRatePerMin, soakSec: loadCfg.soakSec });
const tl = timeline(phases, loadCfg.scale);

export const options = {
  scenarios: scenariosFor(tl, { iterSec: 10, maxVUs: loadCfg.maxVUs, exec: 'loadWorkflow' }),
  thresholds: thresholdsFor(tl, {
    gate: gateFor(loadCfg.profile),
    e2eP95MaxMs: loadCfg.e2eP95MaxMs,
    startP95MaxMs: loadCfg.startP95MaxMs,
    abortOnBreak: loadCfg.profile === 'stress',
  }),
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'max'],
};

export function setup() {
  requireLoadAllowed();
  const runId = newRun();
  requireFixtureNodes(tenant(`systest-${runId}-preflight`));
  console.log(`LOAD ${loadCfg.profile}: ${describe(tl)}  (${loadCfg.tenants} tenants, run ${runId})`);
  return { runId };
}

export function loadWorkflow(d) {
  oneWorkflow(d.runId, tenantForIteration(d.runId, loadCfg.tenants));
}

export function handleSummary(data) {
  return loadSummary(data, { title: `load ${loadCfg.profile}`, tl, file: `summary-load-${loadCfg.profile}.json`, maxVUs: loadCfg.maxVUs });
}
