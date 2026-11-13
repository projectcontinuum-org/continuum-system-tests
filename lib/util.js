// Pure helpers: no k6 imports, so they can be unit-tested with `node --test` (see test/util.test.js).

/** Temporal WorkflowExecutionStatus enum numbers (proto order). */
const STATUS_BY_NUMBER = {
  0: 'UNSPECIFIED',
  1: 'RUNNING',
  2: 'COMPLETED',
  3: 'FAILED',
  4: 'CANCELED',
  5: 'TERMINATED',
  6: 'CONTINUED_AS_NEW',
  7: 'TIMED_OUT',
};

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'TERMINATED', 'CONTINUED_AS_NEW', 'TIMED_OUT']);

/**
 * `temporalStatus` is a Temporal protobuf enum, and how the api-server's Jackson renders it (name or ordinal) has
 * not been checked against a live response. Accept both: `WORKFLOW_EXECUTION_STATUS_COMPLETED`, `COMPLETED`, `2`.
 * Returns the short name (`COMPLETED`), or `UNKNOWN` when it can't be interpreted.
 */
export function normalizeStatus(value) {
  if (typeof value === 'number') {
    return STATUS_BY_NUMBER[value] || 'UNKNOWN';
  }
  if (typeof value === 'string' && value.length > 0) {
    if (/^\d+$/.test(value)) {
      return STATUS_BY_NUMBER[Number(value)] || 'UNKNOWN';
    }
    return value.replace(/^WORKFLOW_EXECUTION_STATUS_/, '').toUpperCase();
  }
  return 'UNKNOWN';
}

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
