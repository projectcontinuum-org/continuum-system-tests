// cluster-manager: /api/v1/workbench (per-user workbench pods: create, status, liveness, suspend, resume, update,
// delete, list, authorize, variants, tags). Optional: not part of `make up`, see `make up-cluster-manager`.
//
//   Tier 1 (always): needs only the cluster-manager and Postgres. Input validation, 404s, authorize, list, tenant
//     scoping. Every request is one the service rejects BEFORE it touches Kubernetes, so no pod is ever created.
//   Tier 2 (CLUSTER_MANAGER_K8S=true): creates, suspends, resumes, updates and deletes REAL workbench pods in the
//     cluster the cluster-manager points at. Capped at two instances, always deleted afterwards.
//
//   ./run.sh suites/api/cluster-manager.js
//   CLUSTER_MANAGER_K8S=true ./run.sh suites/api/cluster-manager.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { cfg } from '../../lib/config.js';
import { tenant, tenantIds } from '../../lib/tenant.js';
import { knownGap } from '../../lib/checks.js';
import { newRunId, safeJson } from '../../lib/util.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: { checks: ['rate==1'] },
};

const W = '/api/v1/workbench';

export function setup() {
  const runId = cfg.runId || newRunId();
  const [owner, other] = tenantIds(runId, ['wb', 'wb-other']);
  // The suite is optional: skip, loudly, when the service is not there.
  const res = http.get(`${cfg.clusterManager}/actuator/health`, { timeout: '5s', responseCallback: http.expectedStatuses({ min: 200, max: 599 }) });
  const up = res.status === 200;
  if (!up) {
    console.warn(
      `SKIPPED: the cluster-manager is not reachable at ${cfg.clusterManager} (HTTP ${res.status}). ` +
        'Start it with `make up-cluster-manager`, or set CLUSTER_MANAGER_URL.',
    );
  }
  return { runId, owner, other, up };
}

// A request body the service must reject before it reaches Kubernetes.
const body = (name, extra = {}) => ({ instanceName: name, ...extra });

// A complete `resources` object with one field replaced. The service needs every resource field: a partial object
// is a 500 today (see the known gap below), which would hide the validation these requests are meant to reach.
const resources = (override) => ({
  cpuRequest: '500m',
  cpuLimit: '2',
  memoryRequest: '512Mi',
  memoryLimit: '1Gi',
  storageSize: '5Gi',
  ...override,
});

export default function (d) {
  if (!d.up) {
    return;
  }
  const t = tenant(d.owner);
  const o = tenant(d.other);
  const U = cfg.clusterManager;

  // ===== Tier 1 =====================================================================================================

  // --- the shared, tenant-independent endpoints
  const variants = t.get(U, `${W}/variants`, { endpoint: 'wb_variants' });
  check(variants, {
    'variants is 200 and a list (empty when overlays are off)': (r) => r.status === 200 && Array.isArray(safeJson(r.body)),
  });
  // `tags` calls Docker Hub. Without outbound internet that is a 502; with it, a list. Both are correct behaviour.
  const tags = t.get(U, `${W}/tags`, { endpoint: 'wb_tags' });
  check(tags, {
    'tags is a list (200) or a clean 502 when Docker Hub is unreachable': (r) =>
      (r.status === 200 && Array.isArray(safeJson(r.body))) ||
      (r.status === 502 && (safeJson(r.body) || {}).error === 'Failed to fetch data from external service'),
  });

  // --- list, status, liveness, and every mutation of something that does not exist
  const ghost = `ghost-${d.runId}`;
  check(safeJson(t.get(U, W, { endpoint: 'wb_list' }).body), { 'a tenant with no workbenches lists an empty array': (l) => Array.isArray(l) && l.length === 0 });
  const notFound = t.get(U, `${W}/${ghost}`);
  check(notFound, {
    'status of an unknown workbench is 404': (r) => r.status === 404,
    'the 404 body is {"error": ...} and names the workbench': (r) => ((safeJson(r.body) || {}).error || '').indexOf(ghost) !== -1,
  });
  check(t.get(U, `${W}/${ghost}/liveness`), { 'liveness of an unknown workbench is 404': (r) => r.status === 404 });
  check(t.put(U, `${W}/${ghost}/suspend`, null), { 'suspend of an unknown workbench is 404': (r) => r.status === 404 });
  check(t.put(U, `${W}/${ghost}/resume`, null), { 'resume of an unknown workbench is 404': (r) => r.status === 404 });
  check(t.put(U, `${W}/${ghost}`, { image: 'projectcontinuum/continuum-workbench:0.0.14' }), { 'update of an unknown workbench is 404': (r) => r.status === 404 });
  check(t.del(U, `${W}/${ghost}`), { 'delete of an unknown workbench is 404': (r) => r.status === 404 });

  // --- create: input validation (CONTNM-161). All of these are rejected with 400 before any Kubernetes call, and
  //     none of them may leave a workbench behind.
  const rejected = [
    ['a newline plus a second YAML document in memoryLimit',
      body('inj-1', { resources: resources({ memoryLimit: '1Gi\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: pwned' }) }), /memoryLimit/],
    ['a newline in cpuRequest', body('inj-2', { resources: resources({ cpuRequest: '1\n  x: y' }) }), /cpuRequest/],
    ['a newline in storageSize', body('inj-3', { resources: resources({ storageSize: '5Gi\nfoo: bar' }) }), /storageSize/],
    ['a quantity with a unit that does not exist', body('inj-4', { resources: resources({ memoryRequest: '5 bananas' }) }), /memoryRequest/],
    ['a quantity longer than 32 characters', body('inj-5', { resources: resources({ cpuLimit: '1'.repeat(40) }) }), /cpuLimit/],
    ['a storage class that is not a DNS name', body('inj-6', { resources: resources({ storageClassName: 'Bad Name!' }) }), /storageClassName/],
    ['an image with whitespace', body('inj-7', { image: 'projectcontinuum/continuum-workbench:0.0.14 --privileged' }), /image/i],
    ['an image with a newline', body('inj-8', { image: 'projectcontinuum/continuum-workbench:0.0.14\nx: y' }), /image/i],
    ['an image with a shell substitution', body('inj-9', { image: 'projectcontinuum/continuum-workbench:$(id)' }), /image/i],
    ['an image longer than 512 characters', body('inj-10', { image: `projectcontinuum/continuum-workbench:${'a'.repeat(600)}` }), /image/i],
  ];
  if (cfg.clusterManagerImageAllowList) {
    rejected.push(['an image from outside the allowed repository', body('inj-11', { image: 'evil.example.com/crypto-miner:latest' }), /not allowed/i]);
    rejected.push(['a Docker Hub image from another account', body('inj-12', { image: 'someoneelse/continuum-workbench:latest' }), /not allowed/i]);
  }
  for (const [name, req, message] of rejected) {
    const res = t.post(U, W, req, { endpoint: 'wb_create_rejected' });
    check(res, {
      [`create with ${name} is 400`]: (r) => r.status === 400,
      [`... and the error names the problem`]: (r) => message.test((safeJson(r.body) || {}).error || ''),
    });
  }
  // A rejected create must not leave a record behind.
  check(safeJson(t.get(U, W).body), { 'rejected creates left no workbench behind': (l) => Array.isArray(l) && l.length === 0 });

  // User ids go into resource labels. The header is not trusted: control characters, quotes and backslashes are out.
  for (const [name, bad] of [['a double quote', 'a"b'], ['a backslash', 'a\\b'], ['a 300-character id', 'x'.repeat(300)]]) {
    const res = http.post(`${U}${W}`, JSON.stringify(body('uid-1')), {
      headers: { 'Content-Type': 'application/json', 'x-continuum-user-id': bad },
      tags: { endpoint: 'wb_create_rejected' },
      responseCallback: http.expectedStatuses({ min: 200, max: 499 }),
    });
    check(res, { [`a user id with ${name} is rejected (400)`]: (r) => r.status === 400 });
  }
  // A variant must be a valid overlay name. A path or a double dash is rejected whatever the config. A well-formed
  // but unknown name is only rejected when overlays are enabled (otherwise the variant is ignored), so that case
  // depends on CLUSTER_MANAGER_OVERLAYS.
  const badVariants = [['a path traversal', '../../etc/passwd'], ['a double dash', 'a--b'], ['a leading dot', '.hidden']];
  if (cfg.clusterManagerOverlays) {
    badVariants.push(['an unknown name', 'no-such-variant']);
  }
  for (const [name, bad] of badVariants) {
    const res = t.post(U, W, body('var-1', { variant: bad }), { endpoint: 'wb_create_rejected' });
    check(res, { [`a variant that is ${name} is rejected (400)`]: (r) => r.status === 400 });
  }
  // Malformed JSON and a missing instanceName are client errors. Today the generic handler makes them 500.
  // (Only requests that cannot succeed are sent here: a valid-looking create would start a real pod on a cluster.)
  knownGap('workbench: create with a non-JSON body returns 500, want 400', t.post(U, W, 'garbage'), [400]);
  knownGap('workbench: create with no instanceName returns 500, want 400', t.post(U, W, { image: 'projectcontinuum/continuum-workbench:0.0.14' }), [400]);
  // A `resources` object that omits a field also fails to parse (Kotlin non-null fields without defaults on the
  // request path), so a client that only wants to change the memory limit gets a 500.
  knownGap('workbench: create with a partial resources object returns 500, want 400', t.post(U, W, body('partial-1', { resources: { memoryLimit: '1Gi' } })), [400]);

  // --- update validation (an unknown workbench is 404 first, so this is checked on the live one in tier 2)

  // --- authorize: used by the ingress to gate every request to a workbench
  const authz = (user, host) =>
    http.get(`${U}${W}/authorize`, {
      headers: { 'x-continuum-user-id': user, 'X-Forwarded-Host': host },
      tags: { endpoint: 'wb_authorize' },
      responseCallback: http.expectedStatuses({ min: 200, max: 499 }),
    });
  check(authz(d.owner, `nobody-${d.runId}.example.com`), { 'authorize for a host with no workbench is 403': (r) => r.status === 403 });
  check(http.get(`${U}${W}/authorize`, { headers: { 'X-Forwarded-Host': 'x.example.com' }, responseCallback: http.expectedStatuses({ min: 200, max: 499 }) }), {
    'authorize without a user id is 400': (r) => r.status === 400,
  });
  check(http.get(`${U}${W}/authorize`, { headers: { 'x-continuum-user-id': d.owner }, responseCallback: http.expectedStatuses({ min: 200, max: 499 }) }), {
    'authorize without a forwarded host is 400': (r) => r.status === 400,
  });

  // --- tier 1 isolation: another tenant's list is independent of this tenant's
  check(safeJson(o.get(U, W).body), { 'another tenant lists no workbenches either': (l) => Array.isArray(l) && l.length === 0 });

  // ===== Tier 2 =====================================================================================================
  if (!cfg.clusterManagerK8s) {
    console.warn('Tier 2 (workbench lifecycle on a real cluster) skipped: set CLUSTER_MANAGER_K8S=true to run it.');
    return;
  }
  lifecycle(d, t, o, U);
}

// ===== Tier 2: the full lifecycle on a real cluster ===================================================================
function lifecycle(d, t, o, U) {
  const name = `wb-${d.runId}`.slice(0, 40);
  const image = 'projectcontinuum/continuum-workbench:0.0.14';
  const small = { cpuRequest: '100m', cpuLimit: '500m', memoryRequest: '256Mi', memoryLimit: '512Mi', storageSize: '1Gi' };
  const created = [];

  try {
    // --- create
    const res = t.post(U, W, { instanceName: name, image, resources: small }, { endpoint: 'wb_create' });
    const wb = safeJson(res.body) || {};
    if (res.status === 201) {
      created.push(name);
    }
    check(res, {
      'create is 201': (r) => r.status === 201,
      'the response has an instance id and echoes the name': () => !!wb.instanceId && wb.instanceName === name,
      'the response records the caller as owner': () => wb.userId === d.owner,
      'the response echoes the image and resources': () => wb.image === image && wb.resources && wb.resources.memoryLimit === '512Mi',
      'a new workbench is PENDING or RUNNING': () => ['PENDING', 'RUNNING'].indexOf(wb.status) !== -1,
      'the response has a service endpoint': () => typeof wb.serviceEndpoint === 'string' && wb.serviceEndpoint.length > 0,
    });
    if (res.status !== 201) {
      return;
    }

    // --- a second create with the same name while it is active is a conflict
    const dup = t.post(U, W, { instanceName: name, image, resources: small });
    check(dup, { 'creating the same name again is 400 and says it exists': (r) => r.status === 400 && /already exists/.test((safeJson(r.body) || {}).error || '') });

    // --- status, list
    check(t.get(U, `${W}/${name}`), { 'status is 200 and returns the workbench': (r) => r.status === 200 && (safeJson(r.body) || {}).instanceName === name });
    check(safeJson(t.get(U, W).body), { 'list contains it': (l) => Array.isArray(l) && l.some((w) => w.instanceName === name) });

    // --- wait until the pod is ready (a cold node pulls a multi-GB image)
    const ready = waitUntil(() => safeJson(t.get(U, `${W}/${name}/liveness`).body), (l) => l && l.ready === true, cfg.clusterReadyTimeoutSec);
    check(ready, { 'the workbench becomes ready (liveness ready=true, status RUNNING)': (l) => !!l && l.ready === true && l.status === 'RUNNING' });
    const live = safeJson(t.get(U, `${W}/${name}/liveness`).body) || {};
    check(live, { 'liveness reports ready and the status as separate fields': (l) => typeof l.ready === 'boolean' && typeof l.status === 'string' });

    // --- authorize accepts the owner on the workbench's host, and nobody else
    const full = safeJson(t.get(U, `${W}/${name}`).body) || {};
    if (full.ingressUrl) {
      const host = full.ingressUrl.replace(/^https?:\/\//, '');
      const authz = (user) => http.get(`${U}${W}/authorize`, { headers: { 'x-continuum-user-id': user, 'X-Forwarded-Host': host }, responseCallback: http.expectedStatuses({ min: 200, max: 499 }) });
      check(authz(d.owner), { 'authorize: the owner of a running workbench is allowed (200)': (r) => r.status === 200 });
      check(authz(d.other), { 'authorize: another user is refused (403)': (r) => r.status === 403 });
    } else {
      console.warn('The workbench has no ingress URL in this deployment; skipping the positive authorize check.');
    }

    // --- update: validated against the live workbench
    check(t.put(U, `${W}/${name}`, { image: 'evil.example.com/x:1' }), { 'update to an image outside the allowed repository is 400': (r) => !cfg.clusterManagerImageAllowList || r.status === 400 });
    check(t.put(U, `${W}/${name}`, { resources: { ...small, memoryLimit: '1Gi\nx: y' } }), { 'update with a newline in a resource is 400': (r) => r.status === 400 });
    check(t.get(U, `${W}/${name}`), { 'a rejected update leaves the workbench untouched': (r) => r.status === 200 && (safeJson(r.body) || {}).image === image });
    const upd = t.put(U, `${W}/${name}`, { resources: { ...small, memoryLimit: '768Mi' } });
    check(upd, {
      'a valid update is 200': (r) => r.status === 200,
      'the new resource limit is returned': (r) => ((safeJson(r.body) || {}).resources || {}).memoryLimit === '768Mi',
    });

    // --- suspend, then resume
    const sus = t.put(U, `${W}/${name}/suspend`, null);
    check(sus, { 'suspend is 200': (r) => r.status === 200, 'a suspended workbench reports SUSPENDED': (r) => (safeJson(r.body) || {}).status === 'SUSPENDED' });
    check(t.put(U, `${W}/${name}/suspend`, null), { 'suspending twice is 400 ("already suspended")': (r) => r.status === 400 && /already suspended/.test((safeJson(r.body) || {}).error || '') });
    check(safeJson(t.get(U, `${W}/${name}/liveness`).body) || {}, { 'a suspended workbench is not ready': (l) => l.ready === false });
    // Reading the status of a suspended workbench re-derives it from Kubernetes, where the Deployment is gone. That
    // used to turn SUSPENDED into UNKNOWN, after which resume (which needs SUSPENDED) was impossible.
    const afterGet = safeJson(t.get(U, `${W}/${name}`).body) || {};
    knownGapValue('workbench: reading a suspended workbench changes its status', afterGet.status === 'SUSPENDED', `status became ${afterGet.status}`);
    const res2 = t.put(U, `${W}/${name}/resume`, null);
    check(res2, { 'resume is 200': (r) => r.status === 200 });
    const ready2 = waitUntil(() => safeJson(t.get(U, `${W}/${name}/liveness`).body), (l) => l && l.ready === true, cfg.clusterReadyTimeoutSec);
    check(ready2, { 'a resumed workbench becomes ready again': (l) => !!l && l.ready === true });

    // --- another tenant cannot see or change it
    check(o.get(U, `${W}/${name}`), { 'other tenant gets 404 for the workbench': (r) => r.status === 404 });
    check(o.get(U, `${W}/${name}/liveness`), { 'other tenant gets 404 for its liveness': (r) => r.status === 404 });
    check(o.put(U, `${W}/${name}/suspend`, null), { 'other tenant cannot suspend it': (r) => r.status === 404 });
    check(o.put(U, `${W}/${name}`, { image }), { 'other tenant cannot update it': (r) => r.status === 404 });
    check(o.del(U, `${W}/${name}`), { 'other tenant cannot delete it': (r) => r.status === 404 });
    check(safeJson(o.get(U, W).body), { 'other tenant\'s list is empty': (l) => Array.isArray(l) && l.length === 0 });
    check(t.get(U, `${W}/${name}`), { 'the workbench survived the other tenant\'s attempts': (r) => r.status === 200 });

    // --- delete, and the name is free again
    check(t.del(U, `${W}/${name}`), { 'delete is 204': (r) => r.status === 204 });
    created.length = 0;
    check(safeJson(t.get(U, W).body), { 'a deleted workbench is no longer listed': (l) => Array.isArray(l) && !l.some((w) => w.instanceName === name) });
    check(t.del(U, `${W}/${name}`), { 'deleting it again is 404': (r) => r.status === 404 });
  } finally {
    // Whatever failed above, do not leave pods or volumes behind.
    for (const n of created) {
      t.del(U, `${W}/${n}`);
    }
  }
}

/** Polls `read()` every few seconds until `done(value)` holds or the timeout passes. Returns the last value. */
function waitUntil(read, done, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  let value;
  while (Date.now() < deadline) {
    value = read();
    if (done(value)) {
      return value;
    }
    sleep(3);
  }
  return value;
}

/** Like knownGap, for a condition that is not an HTTP status. */
function knownGapValue(name, ok, detail) {
  knownGap(name, { status: ok ? 200 : 0 }, [200]);
  if (!ok) {
    console.warn(`  detail: ${detail}`);
  }
}
