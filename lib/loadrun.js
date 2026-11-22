// Shared pieces of the load suites (k6 imports allowed here; the pure parts are in loadplan.js and guard.js).
import exec from 'k6/execution';
import { fail } from 'k6';
import { cfg } from './config.js';
import { checkLoadAllowed } from './guard.js';
import { tenant } from './tenant.js';
import { FIXTURE_NODES, missingNodes } from './capabilities.js';
import { startWorkflow, waitForTerminal } from './workflows.js';
import { workflowSuccess } from './metrics.js';
import { tenantName } from './loadplan.js';
import { newRunId } from './util.js';

const env = (name, fallback) => (typeof __ENV !== 'undefined' && __ENV[name] !== undefined ? __ENV[name] : fallback);

/** Load settings. Everything has a conservative default for a laptop-sized stack. */
export const loadCfg = {
  allow: env('ALLOW_LOAD', 'false') === 'true',
  allowedHosts: env('LOAD_ALLOWED_HOSTS', 'localhost,127.0.0.1').split(',').map((h) => h.trim()).filter(Boolean),
  profile: env('PROFILE', 'throughput'),
  // Workflows per minute at the first step. One every ten seconds is gentle enough for a 2-CPU Docker VM.
  baseRatePerMin: Number(env('BASE_RATE_PER_MIN', '6')),
  // Scales every phase length, so `LOAD_SCALE=0.25` runs a quarter-length version of a profile.
  scale: Number(env('LOAD_SCALE', '1')),
  soakSec: Number(env('SOAK_SEC', '600')),
  tenants: Number(env('LOAD_TENANTS', '10')),
  maxVUs: Number(env('MAX_VUS', '100')),
  // The latency the profile is allowed to show. The fixture workflow takes about three seconds on an idle stack.
  e2eP95MaxMs: Number(env('E2E_P95_MAX_MS', '30000')),
  startP95MaxMs: Number(env('START_P95_MAX_MS', '1000')),
};

/** Stops the test before it sends a single request when the safety guard says no. Call first in setup(). */
export function requireLoadAllowed(extraUrls = []) {
  const verdict = checkLoadAllowed({
    allow: loadCfg.allow,
    allowedHosts: loadCfg.allowedHosts,
    urls: [cfg.apiServer, cfg.credentials, cfg.clusterManager, ...extraUrls],
  });
  if (!verdict.ok) {
    fail(`Refusing to run a load test:\n  - ${verdict.problems.join('\n  - ')}`);
  }
}

/** The platform must be up and serving the fixture's nodes before any load is applied. */
export function requireFixtureNodes(t) {
  const missing = missingNodes(t, FIXTURE_NODES);
  if (missing.length > 0) {
    fail(`feature-base worker is not serving: ${missing.join(', ')}`);
  }
}

export function newRun() {
  return cfg.runId || newRunId();
}

/**
 * One load iteration: one tenant starts a workflow and waits for it to finish. `tenantId` picks the identity.
 * Records workflow_start_ms, workflow_e2e_ms and workflow_success (all tagged tenant and scenario by k6/tenant()).
 */
export function oneWorkflow(runId, tenantId) {
  return timedWorkflow(runId, tenantId).ok;
}

/** Like oneWorkflow, but also returns how long the workflow took (start request to terminal status), in ms. */
export function timedWorkflow(runId, tenantId) {
  const t = tenant(tenantId);
  const started = startWorkflow(t, runId);
  if (!started.workflowId) {
    // A workflow that never started is a failed workflow. Without this it would vanish from workflow_success
    // (which is otherwise only recorded once a workflow is polled) and a saturated start path would look healthy.
    workflowSuccess.add(false, { tenant: tenantId });
    return { ok: false, ms: undefined };
  }
  const status = waitForTerminal(t, started.workflowId, started.startedAt);
  return { ok: status === 'FINISHED', ms: Date.now() - started.startedAt };
}

/** The tenant for the current iteration, spread round-robin over `count` tenants by the test-wide iteration number. */
export function tenantForIteration(runId, count) {
  return tenantName(runId, exec.scenario.iterationInTest, count);
}
