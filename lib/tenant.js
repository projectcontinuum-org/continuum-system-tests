import http from 'k6/http';
import { cfg } from './config.js';

/**
 * A tenant is just an identity header. Every request is made as one tenant and tagged `tenant:<id>`, so metrics and
 * thresholds can be split per tenant (needed for the noisy-neighbour and isolation suites).
 *
 *   const alice = tenant('systest-abc1-alice');
 *   alice.get(cfg.apiServer, '/api/v1/workflow/list', { endpoint: 'list' });
 */
export function tenant(id) {
  const headers = { 'Content-Type': 'application/json', 'x-continuum-user-id': id };
  if (cfg.authMode === 'bearer') {
    const token = cfg.tenantTokens[id];
    if (!token) {
      throw new Error(`AUTH_MODE=bearer but TENANT_TOKENS has no token for tenant '${id}'`);
    }
    headers.Authorization = `Bearer ${token}`;
  }

  const call = (method, base, path, body, tags, extra) =>
    http.request(method, `${base}${path}`, body === undefined || body === null ? null : JSON.stringify(body), {
      headers,
      tags: { tenant: id, ...tags },
      ...extra,
    });

  return {
    id,
    get: (base, path, tags) => call('GET', base, path, null, tags),
    post: (base, path, body, tags) => call('POST', base, path, body, tags),
    put: (base, path, body, tags) => call('PUT', base, path, body, tags),
    del: (base, path, tags) => call('DELETE', base, path, null, tags),
  };
}

/** Tenant ids for this run, e.g. tenants(['alice','bob']) -> ['systest-<runId>-alice', ...]. */
export function tenantIds(runId, names) {
  return names.map((n) => `systest-${runId}-${n}`);
}
