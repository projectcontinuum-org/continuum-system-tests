// api-server: /api/v1/node-explorer (palette tree, search, documentation, task-queue lookup).
// The node registry is shared by all tenants by design, so there is no ownership scoping to test here.
//   ./run.sh suites/api/node-explorer.js
import { check, fail } from 'k6';
import { cfg } from '../../lib/config.js';
import { tenant, tenantIds } from '../../lib/tenant.js';
import { FIXTURE_NODES, missingNodes } from '../../lib/capabilities.js';
import { flattenTree, newRunId, safeJson } from '../../lib/util.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: { checks: ['rate==1'] },
};

const N = '/api/v1/node-explorer';
const ANOMALY = 'org.projectcontinuum.feature.base.analytics.node.AnomalyDetectorZScoreNodeModel';

export function setup() {
  const runId = cfg.runId || newRunId();
  const [a, b] = tenantIds(runId, ['nodes', 'nodes-other']);
  const missing = missingNodes(tenant(a), FIXTURE_NODES);
  if (missing.length > 0) {
    fail(`feature-base worker is not serving: ${missing.join(', ')}`);
  }
  return { a, b };
}

export default function (d) {
  const t = tenant(d.a);
  const A = cfg.apiServer;

  // --- children: the roots are categories, and a category can be opened
  const roots = t.get(A, `${N}/children?parentId=`, { endpoint: 'ne_children' });
  const rootItems = safeJson(roots.body) || [];
  check(roots, {
    'children of the root is 200 and a non-empty array': (r) => r.status === 200 && Array.isArray(rootItems) && rootItems.length > 0,
    'every root is a CATEGORY with an id and a name': () => rootItems.every((i) => i.type === 'CATEGORY' && i.id && i.name),
    'roots report that they have children': () => rootItems.every((i) => i.hasChildren === true),
  });
  const first = rootItems[0] || {};
  const opened = safeJson(t.get(A, `${N}/children?parentId=${encodeURIComponent(first.id)}`).body) || [];
  check(opened, {
    'opening a category returns its non-empty children': (c) => Array.isArray(c) && c.length > 0,
    'children are CATEGORY or NODE': (c) => c.every((i) => i.type === 'CATEGORY' || i.type === 'NODE'),
  });
  check(t.get(A, `${N}/children?parentId=${encodeURIComponent('No/Such/Category')}`), {
    'children of an unknown parent is an empty list (200)': (r) => r.status === 200 && (safeJson(r.body) || []).length === 0,
  });

  // --- search: matches come back nested under their categories
  const search = t.get(A, `${N}/search?query=Anomaly`, { endpoint: 'ne_search' });
  const nodes = flattenTree(safeJson(search.body)).filter((i) => i.type === 'NODE');
  const anomaly = nodes.find((i) => i.id === ANOMALY) || {};
  check(search, {
    'search is 200': (r) => r.status === 200,
    'search finds the Anomaly Detector node': () => !!anomaly.id,
    'a found node carries its node info': () => !!anomaly.nodeInfo && anomaly.nodeInfo.id === ANOMALY && !!anomaly.nodeInfo.title,
  });
  check(t.get(A, `${N}/search?query=`), { 'a blank search is an empty list': (r) => r.status === 200 && (safeJson(r.body) || []).length === 0 });
  check(t.get(A, `${N}/search`), { 'search without the query parameter is 400': (r) => r.status === 400 });
  check(t.get(A, `${N}/search?query=zzz-no-such-node-zzz`), {
    'a search with no match is an empty list': (r) => r.status === 200 && (safeJson(r.body) || []).length === 0,
  });

  // --- documentation
  const doc = t.get(A, `${N}/nodes/${ANOMALY}/documentation`, { endpoint: 'ne_doc' });
  check(doc, {
    'documentation is 200 markdown': (r) => r.status === 200 && String(r.headers['Content-Type']).indexOf('text/markdown') === 0,
    'documentation starts with a heading': (r) => r.body.trim().indexOf('#') === 0,
  });
  check(t.get(A, `${N}/nodes/no.such.Node/documentation`), { 'documentation of an unknown node is 404': (r) => r.status === 404 });

  // --- task-queue lookup: only registered nodes are in the answer
  const queues = t.post(A, `${N}/nodes/task-queues`, [ANOMALY, 'no.such.Node'], { endpoint: 'ne_queues' });
  const map = safeJson(queues.body) || {};
  check(queues, {
    'task-queues is 200': (r) => r.status === 200,
    'a registered node maps to a task queue': () => typeof map[ANOMALY] === 'string' && map[ANOMALY].length > 0,
    'an unregistered node is left out': () => map['no.such.Node'] === undefined,
  });

  // --- the registry is global: another tenant sees the same palette
  const other = tenant(d.b);
  const otherNodes = flattenTree(safeJson(other.get(A, `${N}/search?query=Anomaly`).body)).filter((i) => i.type === 'NODE');
  check(otherNodes, { 'another tenant sees the same nodes (the registry is shared by design)': (n) => n.some((i) => i.id === ANOMALY) });
}
