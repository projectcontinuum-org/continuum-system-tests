import { check, sleep } from 'k6';
import { cfg } from './config.js';
import { isolationViolations, workflowE2eMs, workflowStartMs, workflowSuccess } from './metrics.js';
import { isTerminal, normalizeStatus, renameWorkflow, safeJson } from './util.js';

const fixture = JSON.parse(open('../fixtures/workflows/anomaly-detector.json'));

let counter = 0;

/** Starts a fresh copy of the AnomalyDetector fixture as `t`. Returns {workflowId, res}. */
export function startWorkflow(t, runId) {
  counter += 1;
  const model = renameWorkflow(fixture, { runId, tenant: t.id, n: counter });
  const started = Date.now();
  const res = t.post(cfg.apiServer, '/api/v1/workflow', model, { endpoint: 'workflow_start' });
  workflowStartMs.add(Date.now() - started, { tenant: t.id });
  const ok = check(res, { 'start returns 200': (r) => r.status === 200 }, { tenant: t.id });
  const workflowId = ok ? (safeJson(res.body) || {}).workflowId : undefined;
  return { workflowId, res, startedAt: started };
}

/**
 * Reads the status of a workflow as `t`. Returns {code, status} where status is the short name (RUNNING,
 * COMPLETED, ...) or undefined when the status endpoint did not answer 200. Right after a start, Temporal
 * visibility can lag, so a 404 or 500 here is "not visible yet", not a failure; callers poll.
 */
export function getStatus(t, workflowId) {
  const res = t.get(cfg.apiServer, `/api/v1/workflow/${encodeURIComponent(workflowId)}/status`, {
    endpoint: 'workflow_status',
  });
  const body = res.status === 200 ? safeJson(res.body) : undefined;
  return { code: res.status, status: body ? normalizeStatus(body.temporalStatus) : undefined };
}

/** Polls until the workflow is terminal or the timeout passes. Records e2e latency and success metrics. */
export function waitForTerminal(t, workflowId, startedAt) {
  const deadline = Date.now() + cfg.workflowTimeoutSec * 1000;
  let last;
  while (Date.now() < deadline) {
    last = getStatus(t, workflowId);
    if (last.status && isTerminal(last.status)) {
      workflowE2eMs.add(Date.now() - startedAt, { tenant: t.id });
      workflowSuccess.add(last.status === 'COMPLETED', { tenant: t.id });
      return last.status;
    }
    sleep(cfg.pollIntervalSec);
  }
  workflowSuccess.add(false, { tenant: t.id });
  return last && last.status ? last.status : 'TIMEOUT';
}

/**
 * Asserts that `res` shows tenant isolation: the caller must not see another tenant's resource.
 * `ok` is true when the status is one of `allowed` (404 for "not yours"). Any other code counts as a violation.
 */
export function expectHidden(res, name, tenantId, allowed = [404]) {
  const ok = allowed.includes(res.status);
  if (!ok) {
    isolationViolations.add(1, { tenant: tenantId, check: name });
  }
  check(res, { [`${name}: hidden from other tenant (${allowed.join('/')})`]: () => ok }, { tenant: tenantId });
  return ok;
}
