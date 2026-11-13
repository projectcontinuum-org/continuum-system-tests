// Fairness arithmetic for the noisy-neighbour test. Pure (no k6 imports), so it is unit-tested with plain node.

export function median(values) {
  const v = values.filter((x) => typeof x === 'number' && isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) {
    return undefined;
  }
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Nearest-rank percentile (p in 0..100) of the finite numbers in `values`; undefined when there are none.
 * For small samples this is deliberately conservative: the p90 of six runs is the slowest of them.
 */
export function percentile(values, p) {
  const v = values.filter((x) => typeof x === 'number' && isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) {
    return undefined;
  }
  const rank = Math.ceil((p / 100) * v.length);
  return v[Math.min(v.length - 1, Math.max(0, rank - 1))];
}

/**
 * A warning when too few quiet workflows were measured. The pass mark is "more than 95% within the limit", which
 * with fewer than 20 workflows allows none to be slow, so a single outlier fails the run.
 */
export function sampleWarning(passes, fails, min = 20) {
  const n = (passes || 0) + (fails || 0);
  if (n >= min) {
    return undefined;
  }
  return `Only ${n} quiet workflows were measured. With fewer than ${min}, one slow workflow is enough to fail the 95% requirement; run a longer test (LOAD_SCALE=1) before trusting a verdict.`;
}

/**
 * The slowest a quiet tenant's workflow may be while a neighbour floods the system: `maxRatio` times its idle
 * baseline, but never less than the baseline plus `slackMs`. The slack stops a tiny baseline (a fast stack) from
 * turning ordinary jitter into a failure.
 */
export function limitMs(baselineMs, maxRatio, slackMs = 2000) {
  if (typeof baselineMs !== 'number' || !isFinite(baselineMs) || baselineMs <= 0) {
    return undefined;
  }
  return Math.max(baselineMs * maxRatio, baselineMs + slackMs);
}

/** loud / alone, or undefined when either number is missing or the baseline is not positive. */
export function ratioOf(loudMs, aloneMs) {
  if (typeof loudMs !== 'number' || typeof aloneMs !== 'number' || !isFinite(loudMs) || !isFinite(aloneMs) || aloneMs <= 0) {
    return undefined;
  }
  return loudMs / aloneMs;
}

/**
 * The text of the fairness verdict for the report. This is INFORMATION: the run is failed by the
 * `fairness_within_limit` threshold, which checks every quiet workflow against `limitMs`. A missing ratio is reported
 * as a failure, not a pass: with no finished workflow in a phase there is no evidence the tenant was treated fairly.
 */
export function verdictLines({ ratio, maxRatio, alone, loud, noisy, baselineMs, limit }) {
  const ms = (v) => (typeof v === 'number' ? `${Math.round(v)}ms` : 'n/a');
  const text = [`Idle baseline for the quiet tenant: ${ms(baselineMs)} (p90 of the calibration runs); limit while the neighbour is loud: ${ms(limit)}.`];
  if (ratio === undefined) {
    text.push(`No phase-to-phase ratio could be computed (quiet alone p95 ${ms(alone.e2eP95)}, with a loud neighbour p95 ${ms(loud.e2eP95)}): one phase finished no workflow.`);
  } else {
    text.push(`Quiet tenant p95: ${ms(alone.e2eP95)} alone -> ${ms(loud.e2eP95)} with a loud neighbour (${ratio.toFixed(2)}x; the limit is ${maxRatio}x).`);
  }
  if (typeof loud.success === 'number' && loud.success < 0.99) {
    text.push(`Only ${(loud.success * 100).toFixed(1)}% of the quiet tenant's workflows succeeded while the neighbour was loud.`);
  }
  if (noisy && typeof noisy.e2eP95 === 'number') {
    text.push(`For reference, the noisy tenant itself: ${noisy.workflows} workflows, p95 ${ms(noisy.e2eP95)}, ${typeof noisy.success === 'number' ? (noisy.success * 100).toFixed(1) : 'n/a'}% succeeded.`);
  }
  return text;
}
