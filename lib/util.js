// Pure helpers: no k6 imports, so they can be unit-tested with `node --test` (see test/util.test.js).

/**
 * `status` of a run record (`GET /api/v1/workflow-runs/{workflowId}`): `PENDING` (inserted at start), then what the
 * orchestration service publishes: `STARTED`, `RUNNING`, and one of the final values below.
 */
const TERMINAL = new Set(['FINISHED', 'FAILED', 'CANCELLED', 'TERMINATED']);

export function isTerminal(status) {
  return TERMINAL.has(status);
}

export function randomHex(length, rnd = Math.random) {
  let out = '';
  while (out.length < length) {
    out += Math.floor(rnd() * 16).toString(16);
  }
  return out;
}

/** Short id that makes this run's tenants and workflows unique and easy to find again. */
export function newRunId(now = Date.now(), rnd = Math.random) {
  return `${now.toString(36)}${randomHex(4, rnd)}`;
}

/**
 * Copy of a fixture workflow with a new id and a path-like, URL-safe name. Workflow runs have no delete endpoint,
 * so the `systest/<runId>/...` prefix in the name is the only way to find test data afterwards.
 */
export function renameWorkflow(model, { runId, tenant, n }, rnd = Math.random) {
  const copy = JSON.parse(JSON.stringify(model));
  copy.id = randomHex(64, rnd);
  copy.name = `/systest/${runId}/${tenant}/wf-${n}.cwf`;
  return copy;
}

/** Spring `Page` serialised via DTO: `{content: [...], page: {...}}`. */
export function pageContent(body) {
  return body && Array.isArray(body.content) ? body.content : [];
}

export function safeJson(body) {
  try {
    return JSON.parse(body);
  } catch (e) {
    return undefined;
  }
}

/**
 * Splits a stored output reference, `{remote}<runId>/<nodeId>/output.<port>.parquet`, into its parts.
 * Outputs live under the Temporal RUN id (not the workflow id the API returns), and `/api/v1/data` is addressed
 * the same way. Returns undefined for anything that isn't such a reference.
 */
export function parseStoredPath(path) {
  const m = /^\{remote\}([^/]+)\/([^/]+)\/output\.([^.]+)\.[A-Za-z0-9]+$/.exec(String(path || ''));
  return m ? { runId: m[1], nodeId: m[2], outputId: m[3] } : undefined;
}

/** Every output of a run record (`data.nodeToOutputMap`) as parsed {runId, nodeId, outputId} addresses. */
export function outputsOf(record) {
  const map = (record && record.data && record.data.nodeToOutputMap) || {};
  const out = [];
  for (const node of Object.keys(map)) {
    for (const port of Object.keys(map[node] || {})) {
      const parsed = parseStoredPath((map[node][port] || {}).data);
      if (parsed) {
        out.push(parsed);
      }
    }
  }
  return out;
}

/** Flattens node-explorer items (categories hold their matches in `children`) into one list. */
export function flattenTree(items) {
  const out = [];
  const walk = (list) => {
    for (const item of list || []) {
      out.push(item);
      if (item.children) {
        walk(item.children);
      }
    }
  };
  walk(items);
  return out;
}

export function isProblemJson(contentType) {
  return typeof contentType === 'string' && contentType.indexOf('application/problem+json') === 0;
}
