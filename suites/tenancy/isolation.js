// Tenant isolation: tenant B must not be able to see or act on anything tenant A created. A hard-fail suite:
// any violation fails the run (threshold isolation_violations == 0 and every check passing).
//   k6 run -e API_SERVER_URL=... -e CREDENTIALS_URL=... suites/tenancy/isolation.js
import { check, fail } from 'k6';
import { cfg } from '../../lib/config.js';
import { tenant, tenantIds } from '../../lib/tenant.js';
import { FIXTURE_NODES, missingNodes } from '../../lib/capabilities.js';
import { expectHidden, startWorkflow, waitForTerminal } from '../../lib/workflows.js';
import { newRunId, pageContent, safeJson } from '../../lib/util.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    isolation_violations: ['count==0'],
    checks: ['rate==1'],
  },
};

export function setup() {
  const runId = cfg.runId || newRunId();
  const [a, b] = tenantIds(runId, ['alice', 'bob']);
  const alice = tenant(a);

  const missing = missingNodes(alice, FIXTURE_NODES);
  if (missing.length > 0) {
    fail(`feature-base worker is not serving: ${missing.join(', ')}`);
  }

  // Alice owns one finished workflow run (with node output), one credential and one schedule.
  const { workflowId, startedAt } = startWorkflow(alice, runId);
  if (!workflowId) {
    fail('alice could not start a workflow');
  }
  const final = waitForTerminal(alice, workflowId, startedAt);

  // Node outputs are stored under the Temporal RUN id, which differs from the workflow id: the workbench takes it
  // from the first segment of the stored path ({remote}<runId>/<nodeId>/output.<port>.parquet). Read it the same way.
  const run = safeJson(alice.get(cfg.apiServer, `/api/v1/workflow-runs/${workflowId}`).body) || {};
  const outputMap = (run.data && run.data.nodeToOutputMap) || {};
  const firstNode = Object.keys(outputMap)[0];
  const firstPort = firstNode ? Object.keys(outputMap[firstNode])[0] : undefined;
  const storedPath = firstNode && firstPort ? String((outputMap[firstNode][firstPort] || {}).data || '') : '';
  const pathMatch = /^\{remote\}([^/]+)\/([^/]+)\/output\.([^.]+)\./.exec(storedPath);
  const output = pathMatch ? { runId: pathMatch[1], nodeId: pathMatch[2], outputId: pathMatch[3] } : undefined;

  const typeName = `iso-type-${runId}`;
  alice.post(cfg.credentials, '/api/v1/credential-types', { type: typeName, version: '1.0.0', schema: {}, uiSchema: {} });
  const credName = `iso-cred-${runId}`;
  const cred = alice.post(cfg.credentials, '/api/v1/credentials', {
    name: credName,
    type: typeName,
    typeVersion: '1.0.0',
    data: { secret: 'alice-only' },
  });

  // A far-future cron, so the schedule never fires during the test.
  const wfModel = JSON.parse(alice.get(cfg.apiServer, `/api/v1/workflow-runs/${workflowId}`).body).data.workflowSnapshot;
  const sched = alice.post(cfg.apiServer, '/api/v1/workflow/schedule', {
    name: `iso-sched-${runId}`,
    cronExpression: '0 0 1 1 *',
    continuumWorkflowModel: wfModel,
  });
  const scheduleId = (safeJson(sched.body) || {}).scheduleId;

  return { runId, a, b, workflowId, final, credName, credStatus: cred.status, scheduleId, output };
}

export default function (d) {
  const alice = tenant(d.a);
  const bob = tenant(d.b);
  const wf = encodeURIComponent(d.workflowId);

  check(d, {
    'setup: alice workflow finished': (x) => x.final === 'FINISHED',
    'setup: alice credential created': (x) => x.credStatus === 201,
    'setup: alice schedule created': (x) => !!x.scheduleId,
    'setup: found alice\'s stored output path (run id, node, port)': (x) => !!x.output,
  });

  // Sanity: alice can see her own things, so a 404 for bob means "not yours", not "broken".
  check(alice.get(cfg.apiServer, `/api/v1/workflow-runs/${wf}`), { 'alice sees her run record': (r) => r.status === 200 });
  check(alice.get(cfg.credentials, `/api/v1/credentials/${d.credName}`), { 'alice reads her credential': (r) => r.status === 200 });

  // The owner CAN read their own node output. This is the check that was missing when ownership scoping broke it:
  // a suite that only proves "bob is denied" also passes when nobody can read anything.
  if (d.output) {
    const out = `/api/v1/data/${encodeURIComponent(d.output.runId)}/nodes/${encodeURIComponent(d.output.nodeId)}` +
      `/outputs/${encodeURIComponent(d.output.outputId)}?page=0&pageSize=10`;
    const mine = alice.get(cfg.apiServer, out, { endpoint: 'node_output' });
    check(mine, {
      'alice reads her own node output (200)': (r) => r.status === 200,
      'alice\'s node output has rows': (r) => ((safeJson(r.body) || {}).totalElements || 0) > 0,
    });
    // ...and bob, asking for exactly the same address, does not.
    expectHidden(bob.get(cfg.apiServer, out, { endpoint: 'node_output' }), 'node output', d.b);
  }

  // --- Workflow API: by id -> 404 for bob.
  expectHidden(bob.post(cfg.apiServer, `/api/v1/workflow/${wf}/cancel`, null), 'workflow cancel', d.b);
  expectHidden(bob.post(cfg.apiServer, `/api/v1/workflow/${wf}/terminate`, null), 'workflow terminate', d.b);
  expectHidden(bob.get(cfg.apiServer, `/api/v1/workflow-runs/${wf}`), 'run record', d.b);

  // --- Workflow API: collections must not contain alice's workflow id.
  const noLeak = (name, res) => {
    const leaked = res.body && res.body.indexOf(d.workflowId) !== -1;
    check(res, { [`${name}: ok status`]: (r) => r.status === 200, [`${name}: no leak of alice's workflow`]: () => !leaked });
    if (leaked) {
      expectHidden({ status: 200 }, `${name} leak`, d.b);
    }
  };
  noLeak('runs', bob.get(cfg.apiServer, '/api/v1/workflow-runs?size=100'));
  noLeak('distinct workflows', bob.get(cfg.apiServer, '/api/v1/workflow-runs/distinct-workflows'));
  const bobRuns = pageContent(safeJson(bob.get(cfg.apiServer, '/api/v1/workflow-runs?size=100').body));
  check(bobRuns, { 'runs: bob\'s page is empty': (c) => c.length === 0 });

  // --- Alice's workflow was not affected by bob's cancel/terminate attempts.
  const after = alice.get(cfg.apiServer, `/api/v1/workflow-runs/${wf}`);
  check(after, {
    'alice workflow not cancelled by bob': (r) => {
      const s = safeJson(r.body);
      return r.status === 200 && s && s.status === 'FINISHED';
    },
  });

  // --- Credentials.
  expectHidden(bob.get(cfg.credentials, `/api/v1/credentials/${d.credName}`), 'credential get', d.b);
  expectHidden(bob.put(cfg.credentials, `/api/v1/credentials/${d.credName}`, { description: 'hijack' }), 'credential update', d.b);
  expectHidden(bob.del(cfg.credentials, `/api/v1/credentials/${d.credName}`), 'credential delete', d.b);
  const bobCreds = bob.get(cfg.credentials, '/api/v1/credentials');
  check(bobCreds, {
    'credentials list: ok': (r) => r.status === 200,
    'credentials list: no leak of alice\'s credential': (r) => r.body.indexOf(d.credName) === -1,
  });
  check(alice.get(cfg.credentials, `/api/v1/credentials/${d.credName}`), { 'alice credential survived bob\'s delete': (r) => r.status === 200 });

  // --- Schedules.
  if (d.scheduleId) {
    const base = `/api/v1/workflow/schedule/${d.scheduleId}`;
    expectHidden(bob.get(cfg.apiServer, base), 'schedule get', d.b);
    expectHidden(bob.post(cfg.apiServer, `${base}/pause`, null), 'schedule pause', d.b);
    expectHidden(bob.post(cfg.apiServer, `${base}/unpause`, null), 'schedule unpause', d.b);
    expectHidden(bob.post(cfg.apiServer, `${base}/trigger`, null), 'schedule trigger', d.b);
    expectHidden(bob.del(cfg.apiServer, base), 'schedule delete', d.b);
    const bobScheds = bob.get(cfg.apiServer, '/api/v1/workflow/schedule');
    check(bobScheds, { 'schedules list: no leak': (r) => r.status === 200 && r.body.indexOf(d.scheduleId) === -1 });
    check(alice.get(cfg.apiServer, base), { 'alice schedule survived bob\'s delete': (r) => r.status === 200 });
  }
}

export function teardown(d) {
  const alice = tenant(d.a);
  if (d.scheduleId) {
    alice.del(cfg.apiServer, `/api/v1/workflow/schedule/${d.scheduleId}`);
  }
  alice.del(cfg.credentials, `/api/v1/credentials/${d.credName}`);
}
