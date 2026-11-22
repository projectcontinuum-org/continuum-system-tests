// Smoke: one VU, one pass. Proves the stack is up and the main path works. Run on every PR (about a minute).
//   k6 run -e API_SERVER_URL=http://localhost:8080 -e CREDENTIALS_URL=http://localhost:8083 suites/smoke.js
import http from 'k6/http';
import { check, fail } from 'k6';
import { cfg } from '../lib/config.js';
import { tenant, tenantIds } from '../lib/tenant.js';
import { FIXTURE_NODES, missingNodes } from '../lib/capabilities.js';
import { startWorkflow, waitForTerminal } from '../lib/workflows.js';
import { newRunId, safeJson } from '../lib/util.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
    workflow_success: ['rate==1'],
  },
};

export function setup() {
  const runId = cfg.runId || newRunId();
  return { runId };
}

export default function (data) {
  const [id] = tenantIds(data.runId, ['smoke']);
  const t = tenant(id);

  // 1. Health. Both services have spring-boot-starter-actuator, which exposes /actuator/health by default.
  for (const [name, base] of [['api-server', cfg.apiServer], ['credentials-server', cfg.credentials]]) {
    const res = http.get(`${base}/actuator/health`, { tags: { endpoint: 'health', service: name } });
    check(res, { [`${name} health is 200`]: (r) => r.status === 200 });
  }

  // 2. The feature-base worker has registered the nodes the fixture needs.
  const missing = missingNodes(t, FIXTURE_NODES);
  if (missing.length > 0) {
    fail(`feature-base worker is not serving: ${missing.join(', ')}. Is continuum-feature-base up and registered?`);
  }

  // 3. A workflow runs to completion.
  const { workflowId, startedAt } = startWorkflow(t, data.runId);
  if (!workflowId) {
    fail('workflow did not start, see the failed check above');
  }
  const final = waitForTerminal(t, workflowId, startedAt);
  check(final, { 'workflow FINISHED': (s) => s === 'FINISHED' }, { tenant: id });

  // 4. The run record is readable by the owner.
  const run = t.get(cfg.apiServer, `/api/v1/workflow-runs/${encodeURIComponent(workflowId)}`, { endpoint: 'run_get' });
  check(run, { 'owner can read the run record': (r) => r.status === 200 });

  // 5. Credential round trip (body shape is not asserted: only status codes and that the name comes back).
  const credName = `smoke-${data.runId}`;
  const typeName = `smoke-type-${data.runId}`;
  const type = t.post(
    cfg.credentials,
    '/api/v1/credential-types',
    { type: typeName, version: '1.0.0', schema: {}, uiSchema: {} },
    { endpoint: 'cred_type_create' },
  );
  check(type, { 'credential type created (200/201)': (r) => r.status === 200 || r.status === 201 });

  const created = t.post(
    cfg.credentials,
    '/api/v1/credentials',
    { name: credName, type: typeName, typeVersion: '1.0.0', data: { user: 'u', secret: 's3cret' } },
    { endpoint: 'cred_create' },
  );
  check(created, { 'credential created (201)': (r) => r.status === 201 });

  const read = t.get(cfg.credentials, `/api/v1/credentials/${credName}`, { endpoint: 'cred_get' });
  check(read, {
    'credential readable by owner (200)': (r) => r.status === 200,
    'credential response names it': (r) => (safeJson(r.body) || {}).name === credName,
  });

  const del = t.del(cfg.credentials, `/api/v1/credentials/${credName}`, { endpoint: 'cred_delete' });
  check(del, { 'credential deleted (204)': (r) => r.status === 204 });
}
