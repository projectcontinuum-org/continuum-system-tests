// api-server: /api/v1/workflow (start, cancel, terminate). Run state is read from /api/v1/workflow-runs (runs.js).
// One workflow is started in setup() and reused for the read checks. Run against the compose stack:
//   ./run.sh suites/api/workflow.js
import { check, fail } from 'k6';
import { cfg } from '../../lib/config.js';
import { tenant, tenantIds } from '../../lib/tenant.js';
import { FIXTURE_NODES, missingNodes } from '../../lib/capabilities.js';
import { getStatus, startWorkflow, waitForTerminal } from '../../lib/workflows.js';
import { newRunId } from '../../lib/util.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: { checks: ['rate==1'] },
};

export function setup() {
  const runId = cfg.runId || newRunId();
  const [owner] = tenantIds(runId, ['wf']);
  const t = tenant(owner);

  const missing = missingNodes(t, FIXTURE_NODES);
  if (missing.length > 0) {
    fail(`feature-base worker is not serving: ${missing.join(', ')}`);
  }
  const { workflowId, startedAt } = startWorkflow(t, runId);
  if (!workflowId) {
    fail('workflow did not start');
  }
  const final = waitForTerminal(t, workflowId, startedAt);
  return { runId, owner, workflowId, final };
}

export default function (d) {
  const t = tenant(d.owner);
  const A = cfg.apiServer;
  const W = '/api/v1/workflow';
  const wf = encodeURIComponent(d.workflowId);

  check(d, { 'setup: workflow reached FINISHED': (x) => x.final === 'FINISHED' });

  // --- start: input validation
  const badBody = t.post(A, W, { nope: 1 }, { endpoint: 'start_bad_body' });
  check(badBody, { 'start with a body missing required fields is 400': (r) => r.status === 400 });
  const notJson = t.post(A, W, 'garbage', { endpoint: 'start_not_json' });
  check(notJson, { 'start with a non-JSON body is 400': (r) => r.status === 400 });

  // --- cancel / terminate. Both signal the running workflow, so:
  //   - an unknown id is 404 (never a silent 204),
  //   - a FINISHED workflow is also 404: Temporal has nothing to signal, and the service rethrows that,
  //   - a RUNNING workflow owned by the caller is 204.
  check(t.post(A, `${W}/does-not-exist/cancel`, null), { 'cancel of an unknown id is 404': (r) => r.status === 404 });
  check(t.post(A, `${W}/does-not-exist/terminate`, null), { 'terminate of an unknown id is 404': (r) => r.status === 404 });
  check(t.post(A, `${W}/${wf}/cancel`, null), { 'cancel of a finished workflow is 404 (nothing to signal)': (r) => r.status === 404 });
  check(t.post(A, `${W}/${wf}/terminate`, null), { 'terminate of a finished workflow is 404 (nothing to signal)': (r) => r.status === 404 });
  // A finished workflow stays finished: a rejected cancel must not change its final status.
  check(getStatus(t, d.workflowId), { 'a rejected cancel leaves a FINISHED workflow FINISHED': (s) => s.status === 'FINISHED' });

  for (const action of ['cancel', 'terminate']) {
    // Start a fresh workflow and stop it at once. It takes a few seconds to run, so it is still running here.
    const running = startWorkflow(t, d.runId);
    if (!running.workflowId) {
      fail(`could not start a workflow to ${action}`);
    }
    const id = encodeURIComponent(running.workflowId);
    check(t.post(A, `${W}/${id}/${action}?reason=system-test`, null, { endpoint: action }), {
      [`${action} of a running owned workflow is 204`]: (r) => r.status === 204,
    });
    // The hard stop is deferred by a grace period, so the workflow may still complete first. Either way it must
    // reach a terminal status; this proves it is not left running or stuck.
    const final = waitForTerminal(t, running.workflowId, running.startedAt);
    check(final, { [`a workflow that was sent ${action} reaches a terminal status`]: (s) => s !== 'TIMEOUT' });
  }
}
