import { knownGaps } from './metrics.js';

/**
 * Reports behaviour that is wrong today without failing the suite. The test asserts the DESIRED status codes in
 * `desired`; while the platform still answers something else, a `known_gaps` sample tagged `gap:<name>` is recorded
 * and a warning is logged. Nothing fails, so a known bug is neither hidden nor pinned in place. When the platform is
 * fixed the sample stops appearing; then turn the call into a normal `check`.
 *
 * Returns true when the platform already behaves as desired.
 */
export function knownGap(name, res, desired) {
  const fixed = desired.includes(res.status);
  if (!fixed) {
    knownGaps.add(1, { gap: name });
    console.warn(`KNOWN GAP "${name}": got HTTP ${res.status}, want ${desired.join(' or ')}`);
  }
  return fixed;
}
