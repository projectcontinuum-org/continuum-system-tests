import { Counter, Rate, Trend } from 'k6/metrics';

// Custom metrics shared by the suites. Every sample is tagged with `tenant` by the caller where it matters.
export const workflowE2eMs = new Trend('workflow_e2e_ms', true); // start -> terminal status
export const workflowSuccess = new Rate('workflow_success'); // terminal status == COMPLETED
export const workflowStartMs = new Trend('workflow_start_ms', true);
export const isolationViolations = new Counter('isolation_violations'); // must stay 0
// Behaviour that is wrong today but reported, not failed. 1 per occurrence, tagged `gap:<name>`. See lib/checks.js.
export const knownGaps = new Counter('known_gaps');
