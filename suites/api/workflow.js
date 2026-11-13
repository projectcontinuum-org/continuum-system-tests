// api-server: /api/v1/workflow (start, status, list, count, tree, active, cancel, terminate).
// One workflow is started in setup() and reused for the read checks. Run against the compose stack:
//   ./run.sh suites/api/workflow.js
import { check, fail } from 'k6';
import { cfg } from '../../lib/config.js';
import { tenant, tenantIds } from '../../lib/tenant.js';
import { FIXTURE_NODES, missingNodes } from '../../lib/capabilities.js';
import { getStatus, startWorkflow, waitForTerminal } from '../../lib/workflows.js';
import { isProblemJson, newRunId, safeJson } from '../../lib/util.js';

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

  check(d, { 'setup: workflow reached COMPLETED': (x) => x.final === 'COMPLETED' });

  // --- start: input validation
  const badBody = t.post(A, W, { nope: 1 }, { endpoint: 'start_bad_body' });
  check(badBody, { 'start with a body missing required fields is 400': (r) => r.status === 400 });
  const notJson = t.post(A, W, 'garbage', { endpoint: 'start_not_json' });
  check(notJson, { 'start with a non-JSON body is 400': (r) => r.status === 400 });

  // --- status
  const status = t.get(A, `${W}/${wf}/status`, { endpoint: 'status' });
  const body = safeJson(status.body) || {};
  check(status, {
    'status of an owned workflow is 200': (r) => r.status === 200,
    'status names the workflow': () => body.workflowId === d.workflowId,
    'status has a temporalStatus': () => body.temporalStatus !== undefined,
    'status carries the file name as a search attribute': () =>
      Object.keys(body.metadata || {}).some((k) => k.endsWith('WorkflowFileName')),
  });
  check(t.get(A, `${W}/does-not-exist/status`), { 'status of an unknown id is 404': (r) => r.status === 404 });

  // --- list: scoped to the caller, and the optional query is validated
  const list = t.get(A, `${W}/list`, { endpoint: 'list' });
  const listed = safeJson(list.body) || [];
  check(list, {
    'list is 200 and an array': (r) => r.status === 200 && Array.isArray(listed),
    'list contains the caller\'s workflow': () => listed.some((w) => w.workflowId === d.workflowId),
    'list contains only the caller\'s workflows': () => listed.every((w) => w.workflowId === d.workflowId),
  });

  // --- count, with and without grouping
  const count = safeJson(t.get(A, `${W}/count`, { endpoint: 'count' }).body) || {};
  check(count, {
    'count is a number >= 1': (c) => typeof c.count === 'number' && c.count >= 1,
    'count has a groups array': (c) => Array.isArray(c.groups),
  });
  const grouped = t.get(A, `${W}/count?query=${encodeURIComponent('GROUP BY ExecutionStatus')}`, { endpoint: 'count_grouped' });
  const groups = (safeJson(grouped.body) || {}).groups || [];
  check(grouped, {
    'count grouped by ExecutionStatus is 200': (r) => r.status === 200,
    'grouped count has at least one group with a count': () => groups.length >= 1 && typeof groups[0].count === 'number',
  });

  // --- tree
  const tree = t.get(A, `${W}/tree?baseDir=${encodeURIComponent('/')}`, { endpoint: 'tree' });
  check(tree, {
    'tree is 200 and an array': (r) => r.status === 200 && Array.isArray(safeJson(r.body)),
    'tree contains the workflow': (r) => r.body.indexOf(d.workflowId) !== -1,
  });
  check(t.get(A, `${W}/tree`), { 'tree without baseDir is 400': (r) => r.status === 400 });

  // --- active: finished workflows are not active
  const active = t.get(A, `${W}/active`, { endpoint: 'active' });
  check(active, {
    'active is 200 and an array': (r) => r.status === 200 && Array.isArray(safeJson(r.body)),
    'a finished workflow is not listed as active': (r) => r.body.indexOf(d.workflowId) === -1,
  });

  // --- the query parameter rejects anything that could escape its parentheses (CONTNM-161), as a problem+json 400
  const hostile = [
    ['semicolon', 'x; y'],
    ['line comment', 'x -- y'],
    ['block comment', 'x /* y'],
    ['unbalanced parentheses', 'x) OR (y'],
    ['unterminated quote', "x = 'y"],
    ['newline', 'x\nOR 1=1'],
  ];
  for (const [name, q] of hostile) {
    for (const path of ['list', 'count']) {
      const res = t.get(A, `${W}/${path}?query=${encodeURIComponent(q)}`, { endpoint: `${path}_hostile` });
      check(res, {
        [`${path}: ${name} in query is rejected with 400`]: (r) => r.status === 400,
        [`${path}: ${name} rejection is application/problem+json`]: (r) => isProblemJson(r.headers['Content-Type']),
      });
    }
  }
  // ...and a legitimate query still works and is narrowed to the caller's own workflows.
  const narrowed = t.get(A, `${W}/list?query=${encodeURIComponent("WorkflowType = 'IContinuumWorkflow'")}`, { endpoint: 'list_query' });
  check(narrowed, { 'a valid query is accepted (200)': (r) => r.status === 200 });

  // --- cancel / terminate. Both signal the running workflow, so:
  //   - an unknown id is 404 (never a silent 204),
  //   - a FINISHED workflow is also 404: Temporal has nothing to signal, and the service rethrows that,
  //   - a RUNNING workflow owned by the caller is 204.
  check(t.post(A, `${W}/does-not-exist/cancel`, null), { 'cancel of an unknown id is 404': (r) => r.status === 404 });
  check(t.post(A, `${W}/does-not-exist/terminate`, null), { 'terminate of an unknown id is 404': (r) => r.status === 404 });
  check(t.post(A, `${W}/${wf}/cancel`, null), { 'cancel of a finished workflow is 404 (nothing to signal)': (r) => r.status === 404 });
  check(t.post(A, `${W}/${wf}/terminate`, null), { 'terminate of a finished workflow is 404 (nothing to signal)': (r) => r.status === 404 });
  // A finished workflow stays finished: a rejected cancel must not change its final status.
  check(getStatus(t, d.workflowId), { 'a rejected cancel leaves a COMPLETED workflow COMPLETED': (s) => s.status === 'COMPLETED' });

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
    check(final, { [`a workflow that was sent ${action} reaches a terminal status`]: (s) => s !== 'TIMEOUT' && s !== 'RUNNING' });
  }
}
