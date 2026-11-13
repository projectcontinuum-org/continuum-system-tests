// api-server: /api/v1/data (node output preview) and the CONTNM-161 input-validation regression checks.
// Outputs are addressed by the Temporal RUN id from the stored path, not by the workflow id.
//   ./run.sh suites/api/data.js
import { check, fail } from 'k6';
import { cfg } from '../../lib/config.js';
import { tenant, tenantIds } from '../../lib/tenant.js';
import { FIXTURE_NODES, missingNodes } from '../../lib/capabilities.js';
import { outputPath, startWorkflow, waitForRecord, waitForTerminal } from '../../lib/workflows.js';
import { knownGap } from '../../lib/checks.js';
import { isProblemJson, newRunId, outputsOf, safeJson } from '../../lib/util.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: { checks: ['rate==1'] },
};

export function setup() {
  const runId = cfg.runId || newRunId();
  const [owner, other] = tenantIds(runId, ['data', 'data-other']);
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
  const record = waitForRecord(t, workflowId, (r) => outputsOf(r).length > 0, 45);
  const outputs = outputsOf(record);
  return { owner, other, output: outputs[0], outputs };
}

export default function (d) {
  const t = tenant(d.owner);
  const o = tenant(d.other);
  const A = cfg.apiServer;
  const out = d.output;
  check(d, { 'setup: found a stored output (run id, node, port)': (x) => !!x.output });

  // --- the owner reads rows
  const page = t.get(A, outputPath(out, 0, 2), { endpoint: 'data_page' });
  const body = safeJson(page.body) || {};
  const row = (body.data || [])[0] || [];
  check(page, {
    'the owner reads their output (200)': (r) => r.status === 200,
    'the page has the paging fields': () =>
      ['currentPage', 'currentPageSize', 'totalPages', 'totalElements'].every((k) => typeof body[k] === 'number') &&
      typeof body.hasNext === 'boolean' && typeof body.hasPrevious === 'boolean',
    'pageSize=2 returns two rows': () => Array.isArray(body.data) && body.data.length === 2,
    'the first page has no previous page': () => body.currentPage === 0 && body.hasPrevious === false,
    'totalPages matches totalElements / pageSize': () => body.totalPages === Math.ceil(body.totalElements / 2),
    'there are more rows after the first page': () => body.hasNext === true,
    'a cell has a name, a content type and a base64 value': () =>
      row.length > 0 && row.every((c) => c.name && c.contentType && typeof c.value === 'string'),
  });
  const second = safeJson(t.get(A, outputPath(out, 1, 2)).body) || {};
  check(second, {
    'the second page is page 1 and has a previous page': (b) => b.currentPage === 1 && b.hasPrevious === true,
    'the second page holds different rows': (b) => JSON.stringify(b.data) !== JSON.stringify(body.data),
  });
  // Every output of the run is readable, not just the first port.
  for (const other of d.outputs) {
    check(t.get(A, outputPath(other, 0, 1)), { [`output ${other.nodeId}/${other.outputId} is readable`]: (r) => r.status === 200 });
  }

  // --- paging limits (CONTNM-161): rejected before any data is read, as RFC 7807 problem+json
  for (const [name, p, s] of [['pageSize 0', 0, 0], ['pageSize 1001', 0, 1001], ['pageSize -1', 0, -1], ['page -1', -1, 10]]) {
    const res = t.get(A, outputPath(out, p, s), { endpoint: 'data_bad_paging' });
    check(res, {
      [`${name} is rejected with 400`]: (r) => r.status === 400,
      [`${name} rejection is application/problem+json`]: (r) => isProblemJson(r.headers['Content-Type']),
    });
  }
  check(t.get(A, outputPath(out, 0, 1000)), { 'the largest allowed pageSize (1000) is accepted': (r) => r.status === 200 });
  check(t.get(A, `${outputPath(out).split('?')[0]}?page=abc`), { 'a non-numeric page is 400': (r) => r.status === 400 });

  // --- id validation (CONTNM-161): node and output ids go into a file path and an S3 key
  const base = `/api/v1/data/${encodeURIComponent(out.runId)}/nodes`;
  const hostile = [
    ['a quote and SQL', "x'); SELECT 1; --"],
    ['a space', 'a b'],
    ['a backtick', '`id`'],
    ['a dollar sign', '$(id)'],
    ['dots only', '..'],
    ['an encoded slash', '..%2F..%2Fx'],
  ];
  for (const [name, bad] of hostile) {
    const enc = bad.indexOf('%') >= 0 ? bad : encodeURIComponent(bad);
    const asNode = t.get(A, `${base}/${enc}/outputs/${encodeURIComponent(out.outputId)}`, { endpoint: 'data_hostile' });
    check(asNode, { [`${name} as the node id is a client error`]: (r) => r.status >= 400 && r.status < 500 });
    const asOutput = t.get(A, `${base}/${encodeURIComponent(out.nodeId)}/outputs/${enc}`, { endpoint: 'data_hostile' });
    check(asOutput, { [`${name} as the output id is a client error`]: (r) => r.status >= 400 && r.status < 500 });
  }
  // The two that reach the validator are 400 problem+json (the others may be stopped earlier by the web server).
  check(t.get(A, `${base}/${encodeURIComponent(out.nodeId)}/outputs/${encodeURIComponent("x'); SELECT 1; --")}`), {
    'a quote in the output id is a 400 problem+json from the validator': (r) => r.status === 400 && isProblemJson(r.headers['Content-Type']),
  });
  check(t.get(A, `${base}/${encodeURIComponent("x'); SELECT 1; --")}/outputs/${encodeURIComponent(out.outputId)}`), {
    'a quote in the node id is a 400 problem+json from the validator': (r) => r.status === 400 && isProblemJson(r.headers['Content-Type']),
  });
  // A hostile RUN id never reaches the validator: ownership is checked first, so it is simply not found.
  const hostileRun = t.get(A, `/api/v1/data/${encodeURIComponent("x'); SELECT 1; --")}/nodes/1/outputs/data`);
  check(hostileRun, { 'a hostile run id is rejected (4xx), never served': (r) => r.status >= 400 && r.status < 500 });

  // --- ownership: another tenant, an unknown run, and the WORKFLOW id (which is not the run id)
  check(o.get(A, outputPath(out)), { 'another tenant gets 404': (r) => r.status === 404 });
  check(t.get(A, outputPath({ ...out, runId: 'no-such-run' })), { 'an unknown run is 404': (r) => r.status === 404 });
  const denied = o.get(A, outputPath(out));
  const unknown = t.get(A, outputPath({ ...out, runId: 'no-such-run' }));
  check(denied, { 'an unowned run and an unknown run give the same answer': (r) => r.body === unknown.body.replace('no-such-run', out.runId) || (safeJson(r.body) || {}).detail === (safeJson(unknown.body) || {}).detail });

  // --- an owned run with a node or port that has no stored file. Today the missing S3 object is an unhandled 500.
  knownGap('data: output port with no stored file returns 500, want 404', t.get(A, outputPath({ ...out, outputId: 'no-such-port' })), [404]);
  knownGap('data: node with no stored file returns 500, want 404', t.get(A, outputPath({ ...out, nodeId: '999' })), [404]);
}
