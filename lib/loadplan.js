// Load plans: which phases a load profile runs, as k6 scenarios and thresholds. Pure (no k6 imports), so the numbers
// can be unit-tested with plain node.
//
// Every profile is a SEQUENCE OF PHASES, each its own constant-arrival-rate scenario (so k6 tags every sample with
// `scenario:<phase>` and each phase gets its own latency and success numbers):
//   throughput  steps 1x, 2x, 4x, 8x of the base rate      -> where does latency start to climb?
//   stress      steps 1x ... 64x, aborts when it breaks      -> what breaks first, and at which rate?
//   spike       base, 10x for two minutes, base again        -> does it recover?
//   soak        four equal quarters at the base rate         -> does it drift?
//
// Arrival-rate executors keep the offered load constant when the system slows down, which is what makes saturation
// visible. Rates are integers per minute, so a small machine can run well under one workflow per second.

const UNIT_SECONDS = { s: 1, m: 60, h: 3600 };

export function parseDuration(text) {
  const m = /^(\d+(?:\.\d+)?)(s|m|h)$/.exec(String(text));
  if (!m) {
    throw new Error(`not a duration: '${text}' (use 30s, 5m or 1h)`);
  }
  return Number(m[1]) * UNIT_SECONDS[m[2]];
}

/** Phases of a profile. `base` is the base rate in workflows per minute. Durations are in seconds, unscaled. */
export function profilePhases(profile, { base, soakSec = 600 }) {
  const steps = (multipliers) => multipliers.map((m) => ({ name: `step${m}x`, ratePerMin: base * m, sec: 60 }));
  switch (profile) {
    case 'throughput':
      return steps([1, 2, 4, 8]);
    case 'stress':
      return steps([1, 2, 4, 8, 16, 32, 64]);
    case 'spike':
      return [
        { name: 'before', ratePerMin: base, sec: 60 },
        { name: 'spike', ratePerMin: base * 10, sec: 120 },
        { name: 'after', ratePerMin: base, sec: 120 },
      ];
    case 'soak':
      return [1, 2, 3, 4].map((i) => ({ name: `q${i}`, ratePerMin: base, sec: soakSec / 4 }));
    default:
      throw new Error(`unknown load profile '${profile}' (throughput, stress, spike, soak)`);
  }
}

/** Phases laid end to end: [{name, ratePerMin, sec, startSec, endSec}], durations scaled by `scale`. */
export function timeline(phases, scale = 1) {
  let at = 0;
  return phases.map((p) => {
    const sec = Math.max(1, Math.round(p.sec * scale));
    const entry = { ...p, sec, startSec: at, endSec: at + sec };
    at += sec;
    return entry;
  });
}

/** VUs needed to hold `ratePerMin` when one iteration takes about `iterSec`, with headroom, within [2, maxVUs]. */
export function vusFor(ratePerMin, iterSec, maxVUs) {
  return Math.min(maxVUs, Math.max(2, Math.ceil((ratePerMin / 60) * iterSec * 1.5)));
}

/** k6 scenarios for a timeline: one constant-arrival-rate scenario per phase, started one after the other. */
export function scenariosFor(tl, { iterSec = 10, maxVUs = 100, exec } = {}) {
  const out = {};
  for (const p of tl) {
    const fn = p.exec || exec;
    out[p.name] = {
      executor: 'constant-arrival-rate',
      rate: Math.max(1, Math.round(p.ratePerMin)),
      timeUnit: '1m',
      duration: `${p.sec}s`,
      startTime: `${p.startSec}s`,
      preAllocatedVUs: vusFor(p.ratePerMin, iterSec, maxVUs),
      maxVUs,
      ...(fn ? { exec: fn } : {}),
    };
  }
  return out;
}

/**
 * Noisy neighbour: one quiet tenant runs alone first (the baseline), then keeps the same modest rate while a second
 * tenant floods the system. The two "loud" phases start together, so the timeline overlaps (unlike a profile).
 */
export function noisyNeighborPlan({ quietRatePerMin, noisyRatePerMin, aloneSec, noiseSec }, scale = 1) {
  const alone = Math.max(1, Math.round(aloneSec * scale));
  const noise = Math.max(1, Math.round(noiseSec * scale));
  return [
    { name: 'quiet_alone', role: 'quiet', exec: 'quietRun', ratePerMin: quietRatePerMin, sec: alone, startSec: 0, endSec: alone },
    { name: 'quiet_loud', role: 'quiet', exec: 'quietRun', ratePerMin: quietRatePerMin, sec: noise, startSec: alone, endSec: alone + noise },
    { name: 'noisy', role: 'noisy', exec: 'noisyRun', ratePerMin: noisyRatePerMin, sec: noise, startSec: alone, endSec: alone + noise },
  ];
}

/** Only the quiet tenant while the neighbour is loud is gated: the flooding tenant may degrade itself. */
export const noisyGate = (p) => p.name === 'quiet_loud';

/** The phase running `elapsedSec` into the test, or undefined once the timeline is over. */
export function phaseAt(tl, elapsedSec) {
  return tl.find((p) => elapsedSec >= p.startSec && elapsedSec < p.endSec);
}

// --- thresholds ---------------------------------------------------------------------------------------------------

const START = (name) => `http_req_duration{scenario:${name},endpoint:workflow_start}`;
const E2E = (name) => `workflow_e2e_ms{scenario:${name}}`;
const OK = (name) => `workflow_success{scenario:${name}}`;

/**
 * Thresholds for a timeline. A k6 sub-metric only shows up in the end-of-test data when a threshold names it, so every
 * phase also declares always-true "report only" thresholds (`>=0`) for the numbers the report prints.
 *
 * `gate(phase)` decides which phases can fail the run; the others only report.
 */
export function thresholdsFor(tl, { gate, e2eP95MaxMs, startP95MaxMs, abortOnBreak = false, noDrops = true }) {
  const t = {
    checks: ['rate>0.99'],
    http_req_failed: abortOnBreak
      ? [{ threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '30s' }]
      : ['rate<0.01'],
  };
  if (abortOnBreak) {
    t.workflow_success = [{ threshold: 'rate>0.95', abortOnFail: true, delayAbortEval: '30s' }];
  }
  for (const p of tl) {
    const gated = gate(p);
    t[OK(p.name)] = gated ? ['rate>0.99'] : ['rate>=0'];
    t[E2E(p.name)] = gated ? [`p(95)<${e2eP95MaxMs}`, 'p(50)>=0'] : ['p(95)>=0', 'p(50)>=0'];
    t[START(p.name)] = gated ? [`p(95)<${startP95MaxMs}`] : ['p(95)>=0'];
    t[`iterations{scenario:${p.name}}`] = ['count>=0'];
    t[`dropped_iterations{scenario:${p.name}}`] = noDrops && gated ? ['count==0'] : ['count>=0'];
  }
  return t;
}

/** Which phases may fail the run for a profile. */
export function gateFor(profile) {
  switch (profile) {
    case 'throughput':
    case 'soak':
      return () => true;
    case 'spike':
      return (p) => p.name !== 'spike'; // the spike itself may degrade; "before" and "after" may not
    case 'stress':
      return () => false; // stress is meant to break the system; abortOnFail stops it
    default:
      throw new Error(`unknown load profile '${profile}'`);
  }
}

/** Offered load for a timeline, e.g. "step1x 6/min for 60s -> step2x 12/min for 60s". */
export function describe(tl) {
  return tl.map((p) => `${p.name} ${Math.round(p.ratePerMin)}/min for ${p.sec}s`).join(' -> ');
}

/** Distinct tenant name for iteration `i`, spread round-robin over `count` tenants. */
export function tenantName(runId, i, count) {
  return `systest-${runId}-t${i % Math.max(1, count)}`;
}
