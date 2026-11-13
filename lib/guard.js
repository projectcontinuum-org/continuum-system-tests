// Safety guard for load tests. Pure (no k6 imports) so it can be unit-tested with plain node.
//
// A load test creates real Temporal workflows, files in the object store and database rows, and none of that can be
// deleted through the API. It must never hit a shared or production environment by accident, so it refuses to run
// unless (1) ALLOW_LOAD=true was set explicitly and (2) every target host is on an allow-list.

/** Host part of a URL, lower-cased, without credentials or port. '' when the value is not an absolute URL. */
export function hostOf(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/?#]+)/i.exec(String(url || ''));
  return m ? m[1].toLowerCase() : '';
}

/**
 * @param allow         true only when ALLOW_LOAD=true
 * @param allowedHosts  exact host names that may be loaded (LOAD_ALLOWED_HOSTS)
 * @param urls          every URL the test will call; empty values are ignored (unused services)
 * @returns {{ok: boolean, problems: string[]}}
 */
export function checkLoadAllowed({ allow, allowedHosts, urls }) {
  const problems = [];
  if (!allow) {
    problems.push('ALLOW_LOAD=true is not set. Load tests create data that cannot be deleted through the API.');
  }
  const allowed = (allowedHosts || []).map((h) => h.toLowerCase());
  for (const url of urls || []) {
    if (!url) {
      continue;
    }
    const host = hostOf(url);
    if (!host) {
      problems.push(`cannot read a host from '${url}'`);
    } else if (allowed.indexOf(host) === -1) {
      problems.push(
        `target host '${host}' is not allowed. Add it to LOAD_ALLOWED_HOSTS only if it is an environment you may load ` +
          `(allowed now: ${allowed.join(', ') || 'none'}).`,
      );
    }
  }
  return { ok: problems.length === 0, problems };
}
