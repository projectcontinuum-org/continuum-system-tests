// Turns k6's end-of-test data into (a) a readable report per phase and (b) a JSON file to compare runs.
// The formatting is pure and unit-tested (test/report.test.js); only `loadSummary` touches k6's summary shape.

const num = (v, digits = 0) => (typeof v === 'number' && isFinite(v) ? v.toFixed(digits) : '-');
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

/** Seconds of latency from a Trend value in ms, e.g. 3080 -> "3.1s", 420 -> "420ms". */
export function ms(v) {
  if (typeof v !== 'number' || !isFinite(v)) {
    return '-';
  }
  return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
}

/**
 * One row per phase from the sub-metrics k6 reports for `scenario:<name>`. `metrics` is data.metrics (k6 v2 shape:
 * `{ "<name>{scenario:x}": { values: {...}, thresholds: {...} } }`). Missing numbers become '-' rather than 0, so a
 * phase that produced no data cannot look like a fast one.
 */
export function phaseRows(metrics, tl) {
  const get = (name, p) => (metrics[`${name}{scenario:${p.name}}`] || {}).values || {};
  return tl.map((p) => {
    const e2e = get('workflow_e2e_ms', p);
    const ok = get('workflow_success', p);
    const start = get('http_req_duration', p); // not tagged by endpoint here; see startOnly below
    const iterations = get('iterations', p);
    const dropped = get('dropped_iterations', p);
    const total = (ok.passes || 0) + (ok.fails || 0);
    // k6 reports a Trend with no samples as all zeros, not as missing. A phase in which no workflow finished must
    // read as "unknown", never as a 0 ms latency.
    const finished = (ok.passes || 0) > 0;
    const startVal = (metrics[`http_req_duration{scenario:${p.name},endpoint:workflow_start}`] || {}).values?.['p(95)'] ?? start['p(95)'];
    return {
      phase: p.name,
      rate: Math.round(p.ratePerMin),
      sec: p.sec,
      workflows: total,
      success: total > 0 ? (ok.passes || 0) / total : undefined,
      e2eP50: finished ? e2e.med : undefined,
      e2eP95: finished ? e2e['p(95)'] : undefined,
      e2eMax: finished ? e2e.max : undefined,
      startP95: total > 0 ? startVal : undefined,
      iterations: iterations.count,
      dropped: dropped.count || 0,
    };
  });
}

export function formatTable(rows) {
  const head = ['phase', 'offered', 'for', 'workflows', 'success', 'e2e p50', 'e2e p95', 'e2e max', 'start p95', 'dropped'];
  const lines = rows.map((r) => [
    r.phase,
    `${r.rate}/min`,
    `${r.sec}s`,
    r.workflows,
    r.success === undefined ? '-' : `${(r.success * 100).toFixed(1)}%`,
    ms(r.e2eP50),
    ms(r.e2eP95),
    ms(r.e2eMax),
    ms(r.startP95),
    r.dropped,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => String(l[i]).length)));
  const fmt = (cells) => cells.map((c, i) => (i === 0 ? pad(c, widths[i]) : rpad(c, widths[i]))).join('  ');
  return [fmt(head), fmt(widths.map((w) => '-'.repeat(w))), ...lines.map(fmt)].join('\n');
}

/**
 * Why k6 dropped iterations, from Little's law: a phase that offers R workflows per second, each taking about T
 * seconds, needs R x T virtual users busy at once. k6 drops iterations when that exceeds its VU limit.
 *  - needed > maxVUs: the VU limit is the bottleneck. Raise MAX_VUS.
 *  - needed <= maxVUs: the VU limit is NOT the cause. The platform got slower while the phase ran (the first VUs
 *    were still waiting on slow workflows), so the phase measures a platform that was already saturated.
 * Returns undefined when it cannot tell (no latency to multiply by).
 */
export function dropCause(row, maxVUs) {
  if (!(row.dropped > 0) || typeof row.e2eP95 !== 'number') {
    return undefined;
  }
  const needed = Math.ceil((row.rate / 60) * (row.e2eP95 / 1000));
  return { needed, limited: needed > maxVUs };
}

/** Plain-language verdict on a table: where latency climbs, where workflows start failing, where load is dropped. */
export function findings(rows, { maxVUs = 100 } = {}) {
  const out = [];
  const withData = rows.filter((r) => r.workflows > 0);
  if (withData.length === 0) {
    return ['No workflow finished in any phase: nothing to report. Is the stack healthy?'];
  }
  const baseline = withData[0].e2eP95;
  const slow = withData.find((r) => typeof baseline === 'number' && typeof r.e2eP95 === 'number' && r.e2eP95 > baseline * 2);
  if (slow) {
    out.push(`Latency doubles at ${slow.phase} (${slow.rate}/min): p95 ${ms(baseline)} -> ${ms(slow.e2eP95)}.`);
  } else {
    out.push(`Latency stayed within 2x of the first phase (p95 ${ms(baseline)}) across every phase.`);
  }
  const failing = withData.find((r) => r.success !== undefined && r.success < 0.99);
  if (failing) {
    out.push(`Workflows start failing at ${failing.phase} (${failing.rate}/min): ${(failing.success * 100).toFixed(1)}% succeeded.`);
  } else {
    out.push('Every workflow in every phase succeeded.');
  }
  for (const row of rows.filter((r) => r.dropped > 0)) {
    const why = dropCause(row, maxVUs);
    const head = `k6 could not offer the planned rate at ${row.phase} (${row.rate}/min): ${row.dropped} iterations dropped.`;
    if (!why) {
      out.push(`${head} No latency was measured, so the cause cannot be worked out.`);
    } else if (why.limited) {
      out.push(`${head} At p95 ${ms(row.e2eP95)} this phase needs about ${why.needed} virtual users and the limit is ${maxVUs}: raise MAX_VUS.`);
    } else {
      out.push(`${head} The VU limit (${maxVUs}) is NOT the cause: this phase needs only about ${why.needed}. Workflows took so long (p95 ${ms(row.e2eP95)}) that they piled up while it ran, so the platform was already saturated.`);
    }
  }
  return out;
}

/** Per-tenant fairness: the spread of p95 across the tenants of a phase. Used by the noisy-neighbour report. */
export function tenantSpread(metrics, tenantIds, scenario) {
  const p95s = [];
  for (const id of tenantIds) {
    const m = metrics[`workflow_e2e_ms{scenario:${scenario},tenant:${id}}`];
    if (m && m.values && typeof m.values['p(95)'] === 'number') {
      p95s.push(m.values['p(95)']);
    }
  }
  if (p95s.length === 0) {
    return undefined;
  }
  return { tenants: p95s.length, min: Math.min(...p95s), max: Math.max(...p95s), ratio: Math.max(...p95s) / Math.min(...p95s) };
}

/** Builds the handleSummary return value: a text report on stdout and a JSON file with the table and the raw numbers. */
export function loadSummary(data, { title, tl, file, extra = [], maxVUs = 100 }) {
  const rows = phaseRows(data.metrics, tl);
  // If setup() failed (the safety guard refused, or the stack was down) no workflow ran. Say so, and do not write a
  // JSON file named like a result: an all-empty file would be mistaken for a measurement.
  const ran = rows.some((r) => r.workflows > 0);
  if (!ran) {
    return {
      stdout: `\n=== ${title} ===\n\nNo workflow ran, so there is no report. See the error above (the safety guard, or an unhealthy stack).\n\n`,
    };
  }
  const lines = [
    '',
    `=== ${title} ===`,
    '',
    formatTable(rows),
    '',
    ...findings(rows, { maxVUs }).map((f) => `- ${f}`),
    ...extra,
    '',
  ];
  const known = (data.metrics.known_gaps || {}).values;
  if (known && known.count) {
    lines.push(`- ${known.count} known gap(s) hit; see the KNOWN GAP warnings above.`, '');
  }
  const json = JSON.stringify({ title, generatedAt: new Date().toISOString(), phases: rows, findings: findings(rows, { maxVUs }) }, null, 2);
  return { stdout: lines.join('\n'), [file]: json };
}
