// api-server: /api/v1/workflow-runs (list + paging, filter, get by id, count, distinct-workflows).
//   ./run.sh suites/api/runs.js
import { check, fail } from 'k6';
import { cfg } from '../../lib/config.js';
import { tenant, tenantIds } from '../../lib/tenant.js';
import { FIXTURE_NODES, missingNodes } from '../../lib/capabilities.js';
import { startWorkflow, waitForRecord, waitForTerminal } from '../../lib/workflows.js';
import { newRunId, outputsOf, safeJson } from '../../lib/util.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: { checks: ['rate==1'] },
};

const R = '/api/v1/workflow-runs';

export function setup() {
  const runId = cfg.runId || newRunId();
  const [owner, other] = tenantIds(runId, ['runs', 'runs-other']);
  const t = tenant(owner);
  const missing = missingNodes(t, FIXTURE_NODES);
  if (missing.length > 0) {
    fail(`feature-base worker is not serving: ${missing.join(', ')}`);
  }
  const { workflowId, startedAt } = startWorkflow(t, runId);
  if (!workflowId) {
    fail('workflow did not start');
  }
  waitForTerminal(t, workflowId, startedAt);
  // The run record is updated by the message-bridge from Kafka events, a moment after Temporal finishes.
  const record = waitForRecord(t, workflowId, (r) => r.status === 'FINISHED' && outputsOf(r).length > 0, 45);
  return { runId, owner, other, workflowId, uri: record ? record.workflowUri : undefined, finished: !!record };
}

export default function (d) {
  const t = tenant(d.owner);
  const o = tenant(d.other);
  const A = cfg.apiServer;
  const id = encodeURIComponent(d.workflowId);

  check(d, { 'setup: run record reached FINISHED with its outputs recorded': (x) => x.finished && !!x.uri });

  // --- list: a Spring page serialised as {content, page}
  const list = t.get(A, `${R}`, { endpoint: 'runs_list' });
  const body = safeJson(list.body) || {};
  const item = (body.content || []).find((r) => r.workflowId === d.workflowId) || {};
  check(list, {
    'list is 200': (r) => r.status === 200,
    'list has content[] and a page object': () => Array.isArray(body.content) && typeof body.page === 'object',
    'page has size, number, totalElements, totalPages': () =>
      ['size', 'number', 'totalElements', 'totalPages'].every((k) => typeof (body.page || {})[k] === 'number'),
    'list contains the caller\'s run': () => !!item.workflowId,
    'list contains only the caller\'s runs': () => (body.content || []).every((r) => r.ownedBy === d.owner),
    'a summary item has the expected fields': () =>
      ['workflowId', 'workflowType', 'ownedBy', 'workflowUri', 'progressPercentage', 'status', 'createdAt', 'updatedAt']
        .every((k) => item[k] !== undefined),
    'a summary item leaves out the heavy data column': () => item.data === undefined,
    'a finished run is FINISHED at 100%': () => item.status === 'FINISHED' && item.progressPercentage === 100,
  });

  // --- paging: the caller has exactly one run
  const p0 = safeJson(t.get(A, `${R}?page=0&size=1`).body) || {};
  check(p0, {
    'size=1 returns at most one item': (b) => (b.content || []).length === 1,
    'page.size echoes the requested size': (b) => (b.page || {}).size === 1,
    'totalElements counts the caller\'s runs': (b) => (b.page || {}).totalElements === 1,
  });
  const p1 = safeJson(t.get(A, `${R}?page=1&size=1`).body) || {};
  check(p1, { 'a page past the end is empty': (b) => Array.isArray(b.content) && b.content.length === 0 });

  // --- filter (RSQL): values are quoted, so URIs with slashes work
  const byStatus = safeJson(t.get(A, `${R}?filter=${encodeURIComponent('status==FINISHED')}`).body) || {};
  check(byStatus, { 'filter status==FINISHED finds the run': (b) => (b.content || []).some((r) => r.workflowId === d.workflowId) });
  const noMatch = safeJson(t.get(A, `${R}?filter=${encodeURIComponent('status==NO_SUCH_STATUS')}`).body) || {};
  check(noMatch, { 'filter with no match returns an empty page': (b) => Array.isArray(b.content) && b.content.length === 0 });
  const byUri = safeJson(t.get(A, `${R}?filter=${encodeURIComponent(`workflowUri=="${d.uri}"`)}`).body) || {};
  check(byUri, { 'filter by a quoted workflowUri finds the run': (b) => (b.content || []).some((r) => r.workflowId === d.workflowId) });
  // A malformed filter, an unknown field and a value of the wrong type are client errors.
  check(t.get(A, `${R}?filter=${encodeURIComponent('((bad')}`), { 'a malformed RSQL filter is 400': (r) => r.status === 400 });
  check(t.get(A, `${R}?filter=${encodeURIComponent('noSuchField==1')}`), { 'an unknown RSQL field is 400': (r) => r.status === 400 });
  check(t.get(A, `${R}/count?filter=${encodeURIComponent('createdAt==notadate')}`), { 'a malformed RSQL date is 400': (r) => r.status === 400 });

  // --- by id: the full record, including the workflow snapshot and the stored outputs
  const one = t.get(A, `${R}/${id}`, { endpoint: 'run_get' });
  const rec = safeJson(one.body) || {};
  check(one, {
    'get by id is 200': (r) => r.status === 200,
    'record carries the workflow snapshot': () => !!(rec.data && rec.data.workflowSnapshot && rec.data.workflowSnapshot.nodes),
    'record carries the stored outputs': () => outputsOf(rec).length > 0,
    'record is owned by the caller': () => rec.ownedBy === d.owner,
  });
  check(t.get(A, `${R}/no-such-run`), { 'get of an unknown id is 404': (r) => r.status === 404 });

  // --- count
  const count = safeJson(t.get(A, `${R}/count`).body) || {};
  check(count, { 'count is 1': (c) => c.count === 1 });
  const none = safeJson(t.get(A, `${R}/count?filter=${encodeURIComponent('status==NO_SUCH_STATUS')}`).body) || {};
  check(none, { 'count with a filter that matches nothing is 0': (c) => c.count === 0 });

  // --- distinct workflows (by workflowUri)
  const distinct = safeJson(t.get(A, `${R}/distinct-workflows`).body) || {};
  check(distinct, {
    'distinct-workflows lists the run\'s uri': (b) => (b.content || []).indexOf(d.uri) !== -1,
    'distinct-workflows is a page': (b) => typeof (b.page || {}).totalElements === 'number',
  });

  // --- another tenant sees none of it
  const otherList = safeJson(o.get(A, `${R}`).body) || {};
  check(otherList, { 'other tenant\'s list is empty': (b) => Array.isArray(b.content) && b.content.length === 0 });
  check(o.get(A, `${R}/${id}`), { 'other tenant gets 404 for the run': (r) => r.status === 404 });
  check(safeJson(o.get(A, `${R}/count`).body) || {}, { 'other tenant\'s count is 0': (c) => c.count === 0 });
  const otherDistinct = safeJson(o.get(A, `${R}/distinct-workflows`).body) || {};
  check(otherDistinct, { 'other tenant\'s distinct-workflows is empty': (b) => (b.content || []).length === 0 });
}
