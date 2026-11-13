// api-server: /api/v1/workflow/schedule (create, get, list, filter, pause, unpause, trigger, delete).
// Schedules use a far-future cron, so they never fire on their own; `trigger` is the only thing that starts a run.
//   ./run.sh suites/api/schedules.js
import { check, fail, sleep } from 'k6';
import { cfg } from '../../lib/config.js';
import { tenant, tenantIds } from '../../lib/tenant.js';
import { FIXTURE_NODES, missingNodes } from '../../lib/capabilities.js';
import { workflowModel } from '../../lib/workflows.js';
import { knownGap } from '../../lib/checks.js';
import { newRunId, pageContent, safeJson } from '../../lib/util.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: { checks: ['rate==1'] },
};

const S = '/api/v1/workflow/schedule';
const NEVER = '0 0 1 1 *'; // 1 January 00:00: nothing fires during a test run

export function setup() {
  const runId = cfg.runId || newRunId();
  const [owner, other] = tenantIds(runId, ['sched', 'sched-other']);
  const missing = missingNodes(tenant(owner), FIXTURE_NODES);
  if (missing.length > 0) {
    fail(`feature-base worker is not serving: ${missing.join(', ')}`);
  }
  return { runId, owner, other };
}

export default function (d) {
  const t = tenant(d.owner);
  const o = tenant(d.other);
  const A = cfg.apiServer;
  const name = `sched-${d.runId}`;
  const created = [];

  const create = (overrides = {}, as = t) =>
    as.post(A, S, { name, cronExpression: NEVER, continuumWorkflowModel: workflowModel(d.runId, d.owner, 1), ...overrides }, { endpoint: 'sched_create' });

  try {
    // --- create
    const res = create();
    const sch = safeJson(res.body) || {};
    if (sch.scheduleId) {
      created.push(sch.scheduleId);
    }
    check(res, {
      'create is 200': (r) => r.status === 200,
      'the schedule has an id, its name and the caller as owner': () => !!sch.scheduleId && sch.name === name && sch.ownedBy === d.owner,
      'the schedule echoes the cron expression and starts unpaused': () => sch.cronExpression === NEVER && sch.paused === false,
      'the schedule lists its upcoming runs': () => Array.isArray(sch.nextRunTimes) && sch.nextRunTimes.length > 0,
      'the schedule embeds the workflow model': () => !!(sch.continuumWorkflowModel && sch.continuumWorkflowModel.nodes),
    });
    if (!sch.scheduleId) {
      fail('could not create a schedule; the remaining checks need one');
    }
    const id = sch.scheduleId;

    // --- create: validation
    check(create({ cronExpression: 'not a cron' }), { 'a malformed cron expression is 400': (r) => r.status === 400 });
    check(t.post(A, S, { nope: 1 }), { 'a body missing required fields is 400': (r) => r.status === 400 });

    // --- read
    check(t.get(A, `${S}/${id}`), {
      'get by id is 200 and returns the schedule': (r) => r.status === 200 && (safeJson(r.body) || {}).scheduleId === id,
    });
    check(t.get(A, `${S}/00000000-0000-0000-0000-000000000000`), { 'get of an unknown id is 404': (r) => r.status === 404 });
    check(t.get(A, `${S}/not-a-uuid`), { 'get of a non-UUID id is 400': (r) => r.status === 400 });

    // --- list, by name, and by RSQL filter
    const all = safeJson(t.get(A, S).body) || [];
    check(all, { 'list contains the schedule': (l) => Array.isArray(l) && l.some((s) => s.scheduleId === id) });
    const byName = safeJson(t.get(A, `${S}?name=${encodeURIComponent(name)}`).body) || [];
    check(byName, { 'list by name finds the schedule': (l) => l.some((s) => s.scheduleId === id) });
    const noName = safeJson(t.get(A, `${S}?name=no-such-name-${d.runId}`).body) || [];
    check(noName, { 'list by a name that does not match is empty': (l) => Array.isArray(l) && l.length === 0 });
    const byFilter = safeJson(t.get(A, `${S}/filter?filter=${encodeURIComponent(`name==${name}`)}`).body) || [];
    check(byFilter, { 'filter by name finds the schedule': (l) => l.some((s) => s.scheduleId === id) });

    // --- pause / unpause: the paused flag changes, and repeating either is accepted
    check(t.post(A, `${S}/${id}/pause?note=system-test`, null), { 'pause is 204': (r) => r.status === 204 });
    check(safeJson(t.get(A, `${S}/${id}`).body) || {}, { 'a paused schedule reports paused=true': (s) => s.paused === true });
    check(t.post(A, `${S}/${id}/pause`, null), { 'pausing again is 204': (r) => r.status === 204 });
    check(t.post(A, `${S}/${id}/unpause`, null), { 'unpause is 204': (r) => r.status === 204 });
    check(safeJson(t.get(A, `${S}/${id}`).body) || {}, { 'an unpaused schedule reports paused=false': (s) => s.paused === false });
    check(t.post(A, `${S}/${id}/unpause`, null), { 'unpausing again is 204': (r) => r.status === 204 });

    // --- trigger starts a run now, owned by the schedule's owner and linked to the schedule
    check(t.post(A, `${S}/${id}/trigger`, null), { 'trigger is 204': (r) => r.status === 204 });
    let triggered;
    for (let i = 0; i < 30 && !triggered; i++) {
      const runs = pageContent(safeJson(t.get(cfg.apiServer, `/api/v1/workflow-runs?filter=${encodeURIComponent(`scheduleId==${id}`)}`).body));
      triggered = runs[0];
      if (!triggered) {
        sleep(1);
      }
    }
    check(triggered, {
      'a triggered schedule produces a run linked to it': (r) => !!r && r.scheduleId === id,
      'the triggered run is owned by the schedule\'s owner': (r) => !!r && r.ownedBy === d.owner,
    });

    // --- unknown ids: every action is 404, never a silent 204
    const ghost = '00000000-0000-0000-0000-000000000000';
    for (const [label, call] of [
      ['pause', () => t.post(A, `${S}/${ghost}/pause`, null)],
      ['unpause', () => t.post(A, `${S}/${ghost}/unpause`, null)],
      ['trigger', () => t.post(A, `${S}/${ghost}/trigger`, null)],
      ['delete', () => t.del(A, `${S}/${ghost}`)],
    ]) {
      check(call(), { [`${label} of an unknown schedule is 404`]: (r) => r.status === 404 });
    }

    // --- another tenant: invisible, and cannot change it
    check(o.get(A, `${S}/${id}`), { 'other tenant gets 404 for the schedule': (r) => r.status === 404 });
    check(o.post(A, `${S}/${id}/pause`, null), { 'other tenant cannot pause it': (r) => r.status === 404 });
    check(o.post(A, `${S}/${id}/trigger`, null), { 'other tenant cannot trigger it': (r) => r.status === 404 });
    check(o.del(A, `${S}/${id}`), { 'other tenant cannot delete it': (r) => r.status === 404 });
    check(safeJson(o.get(A, S).body) || [], { 'other tenant\'s list is empty': (l) => Array.isArray(l) && l.length === 0 });
    check(safeJson(o.get(A, `${S}/filter?filter=${encodeURIComponent(`name==${name}`)}`).body) || [], {
      'other tenant\'s filter finds nothing': (l) => Array.isArray(l) && l.length === 0,
    });
    check(t.get(A, `${S}/${id}`), { 'the schedule survived the other tenant\'s attempts': (r) => r.status === 200 });

    // --- a malformed RSQL filter is a client error, but today it is a 500
    knownGap('schedules: malformed RSQL filter returns 500, want 400', t.get(A, `${S}/filter?filter=${encodeURIComponent('((bad')}`), [400]);

    // --- delete
    check(t.del(A, `${S}/${id}`), { 'delete is 204': (r) => r.status === 204 });
    check(t.get(A, `${S}/${id}`), { 'a deleted schedule is 404': (r) => r.status === 404 });
    check(t.del(A, `${S}/${id}`), { 'deleting it again is 404': (r) => r.status === 404 });
    created.length = 0;
  } finally {
    // Whatever failed above, leave no schedule behind.
    for (const id of created) {
      t.del(A, `${S}/${id}`);
    }
  }
}
