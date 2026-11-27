// Loops: the built-in Loop node over HTTP. Registry entry (published by the orchestration service), validation of the
// loop structure, settings and CEL condition on validate / start / schedule, the MCP workflow tools with `parent`, and
// live loop runs built from feature-base nodes. The runs steer the condition with the default flow variables every
// worker exports for each node run (`<nodeType>_<nodeId>.executionStatus`, `.startTimestamp`, `.endTimestamp`, ...),
// because no feature-base node sets a variable of the user's choosing. Conditions over the start and end timestamps
// of members that run only in chosen iterations (lib/loopscenarios.js) make loops run several iterations and stop.
// Slow conditions fail their own loop at the 200 ms budget; another tenant's slow conditions only delay a cheap loop.
// Last, terminate: a healthy loop run and a run that starves itself (5 parallel one-call loops) both end TERMINATED.
//   ./run.sh suites/api/loops.js
import { check, fail, sleep } from 'k6';
import { cfg } from '../../lib/config.js';
import { tenant, tenantIds } from '../../lib/tenant.js';
import { FIXTURE_NODES, missingNodes } from '../../lib/capabilities.js';
import { expectHidden, startWorkflow, waitForTerminal } from '../../lib/workflows.js';
import { flattenTree, isProblemJson, isTerminal, newRunId, safeJson } from '../../lib/util.js';
import {
  BUILTIN_TASK_QUEUE,
  LOOP_CATEGORY,
  LOOP_NODE_MODEL,
  chainLoopWorkflow,
  conditionOfLength,
  edge,
  errorText,
  isNonDecreasing,
  issuesAt,
  loopNode,
  mcpMessage,
  mcpToolResult,
  nestedCondition,
  nodeOutput,
  nodeState,
  nodeTemplates,
  snapshotNode,
  workflowNode,
  workflowOf,
} from '../../lib/loopmodel.js';
import {
  EVALUATION_THREADS,
  THREAD_HOLDING_CONDITION,
  beforeTwoIterationsLoop,
  carriedOverridesOutsideLoop,
  cheapLimitLoop,
  defaultVariable,
  emptyLoops,
  failingNodeWithoutLoop,
  laterMemberWinsLoop,
  memberFailsInIteration2Loop,
  nonBooleanInIteration2Loop,
  oneLongCallLoop,
  selfStarvingLoops,
  slowConditionLoop,
  threeIterationLoop,
  unconnectedMemberLoop,
} from '../../lib/loopscenarios.js';

export const options = {
  vus: 1,
  iterations: 1,
  setupTimeout: '300s',
  thresholds: { checks: ['rate==1'], isolation_violations: ['count==0'] },
};

const templates = nodeTemplates(JSON.parse(open('../../fixtures/workflows/anomaly-detector.json')));

const NE = '/api/v1/node-explorer';
const WF = '/api/v1/workflow';
const SCHED = '/api/v1/workflow/schedule';
const NEVER = '0 0 1 1 *'; // 1 January 00:00: a schedule that never fires during a test run

// Default flow variables of the members of the chain workflow (see lib/loopmodel.js chainLoopWorkflow).
const SPLIT_STATUS = 'conditionalSplitterNode_split.executionStatus';
const SPLIT_DURATION = 'conditionalSplitterNode_split.durationMs';
const SEED_STATUS = 'createTableNode_seed.executionStatus';

/** Rejected conditions and the reason text each one must report (the issue code's reasonText). */
const REJECTED_CONDITIONS = [
  { label: 'now() is not available', condition: 'now() > 1', reason: 'does not type-check' },
  { label: 'an undeclared name', condition: 'foo == 1', reason: 'does not type-check' },
  { label: 'an int result', condition: 'vars["p"] + 1', reason: 'does not return true or false' },
  { label: 'a syntax error', condition: 'vars["a"] ==', reason: 'is not a valid CEL expression' },
  { label: 'an invalid regex literal', condition: 'vars["s"].matches("(")', reason: 'contains an invalid regex, timestamp or duration literal' },
  { label: 'a re-bound cel.bind name', condition: 'cel.bind(a, 1, cel.bind(a, a + a, a > 0))', reason: 'binds a name that is already bound' },
  { label: 'brackets nested 33 deep', condition: nestedCondition(33), reason: 'nests brackets deeper than 32 levels' },
];

/** Full-CEL conditions the validator must accept. */
const ACCEPTED_CONDITIONS = [
  'vars["page"] < 10 && vars["hasMore"]',
  '"nextCursor" in vars',
  'vars["items"].exists(i, i > 2)',
  'vars["name"].lowerAscii() == "x"',
  'math.greatest(vars["a"], 1) > 0',
  'vars[?"r"].orValue(0) < 3',
  'timestamp(vars["ts"]) > timestamp("2026-01-01T00:00:00Z")',
  nestedCondition(32),
  conditionOfLength(2048),
];

export function setup() {
  const runId = cfg.runId || newRunId();
  const [owner, other] = tenantIds(runId, ['loops', 'loops-other']);
  const t = tenant(owner);
  const missing = missingNodes(t, FIXTURE_NODES);
  if (missing.length > 0) {
    fail(`feature-base worker is not serving: ${missing.join(', ')}`);
  }
  // The orchestration service registers the Loop at start-up (with retries), so it may appear a little later.
  const deadline = Date.now() + cfg.loopRegistrationTimeoutSec * 1000;
  while (missingNodes(t, [LOOP_NODE_MODEL]).length > 0) {
    if (Date.now() > deadline) {
      fail(`the built-in Loop is not registered after ${cfg.loopRegistrationTimeoutSec}s: is the orchestration service running?`);
    }
    sleep(2);
  }
  const found = flattenTree(safeJson(t.get(cfg.apiServer, `${NE}/search?query=Loop`).body)).find((i) => i.id === LOOP_NODE_MODEL);
  return { runId, owner, other, registeredLoop: found ? found.nodeInfo : undefined };
}

export default function (d) {
  const t = tenant(d.owner);
  const o = tenant(d.other);
  const ctx = { d, t, o, label: 0 };

  registryChecks(ctx);
  settingsChecks(ctx);
  structureChecks(ctx);
  conditionChecks(ctx);
  mcpChecks(ctx);
  scheduleChecks(ctx);
  runChecks(ctx);
  multiIterationChecks(ctx);
  nothingToRunChecks(ctx);
  sharedThreadChecks(ctx);
  loopFreeChecks(ctx);
  terminateChecks(ctx);
}

// ---------------------------------------------------------------------------------------------------------------------
// helpers

function chain(ctx, loop, extra = {}) {
  ctx.label += 1;
  return chainLoopWorkflow({
    runId: ctx.d.runId,
    tenant: ctx.d.owner,
    label: `loop-${ctx.label}`,
    templates,
    registeredLoop: ctx.d.registeredLoop,
    loop,
    ...extra,
  });
}

function validate(ctx, model, name) {
  const res = ctx.t.post(cfg.apiServer, `${WF}/validate`, model, { endpoint: name || 'loop_validate' });
  return { res, body: safeJson(res.body) || {} };
}

/** Exactly one error, on the loop `L` and `property`, and the answer is 200 valid:false. */
function expectOneLoopError(ctx, name, model, property, messagePart) {
  const { res, body } = validate(ctx, model);
  const atProperty = issuesAt(body.errors, 'L', property);
  check(res, {
    [`${name}: validate is 200 with valid=false`]: (r) => r.status === 200 && body.valid === false,
    [`${name}: exactly one error, on loop 'L' and '${property}'`]: () => atProperty.length === 1 && (body.errors || []).length === 1,
    [`${name}: the error says '${messagePart}'`]: () => atProperty.length === 1 && atProperty[0].message.indexOf(messagePart) >= 0,
  });
  return body;
}

// ---------------------------------------------------------------------------------------------------------------------
// The Loop in the node registry, published by the orchestration service

function registryChecks({ d, t, o }) {
  const A = cfg.apiServer;
  const queues = safeJson(t.post(A, `${NE}/nodes/task-queues`, [LOOP_NODE_MODEL], { endpoint: 'loop_queues' }).body) || {};
  check(queues, { 'the Loop is registered with the built-in task-queue marker $builtin': (q) => q[LOOP_NODE_MODEL] === BUILTIN_TASK_QUEUE });

  const info = d.registeredLoop || {};
  const schema = info.propertiesSchema || {};
  const props = schema.properties || {};
  check(info, {
    'search finds the Loop with its node info': (i) => i.id === LOOP_NODE_MODEL && i.nodeModel === LOOP_NODE_MODEL && i.title === 'Loop',
    'the registered Loop has no ports': (i) => !i.inputs && !i.outputs,
    'the registered schema requires condition, maxIterations, onLimit, onNonBooleanResult and check': () =>
      ['condition', 'maxIterations', 'onLimit', 'onNonBooleanResult', 'check'].every((p) => (schema.required || []).includes(p)),
    'the registered schema rejects undeclared properties': () => schema.additionalProperties === false,
    'onNonBooleanResult is fail | treat-as-false with default fail': () =>
      JSON.stringify((props.onNonBooleanResult || {}).enum) === '["fail","treat-as-false"]' && (props.onNonBooleanResult || {}).default === 'fail',
    'condition is a string of 1..2048 characters with the default vars["hasMore"] == true': () =>
      (props.condition || {}).minLength === 1 && (props.condition || {}).maxLength === 2048 && (props.condition || {}).default === 'vars["hasMore"] == true',
    'maxIterations is 1..10000, default 50': () => (props.maxIterations || {}).minimum === 1 && (props.maxIterations || {}).maximum === 10000 && (props.maxIterations || {}).default === 50,
    'the registered defaults include onNonBooleanResult: fail': (i) => (i.properties || {}).onNonBooleanResult === 'fail',
    'the UI schema renders the condition as a CEL query control, then onLimit before onNonBooleanResult': (i) => {
      const elements = ((i.propertiesUISchema || {}).elements || []).map((e) => e.scope);
      const first = ((i.propertiesUISchema || {}).elements || [])[0] || {};
      return first.scope === '#/properties/condition' && (first.options || {}).format === 'query' && (first.options || {}).language === 'CEL' &&
        elements.indexOf('#/properties/onLimit') >= 0 && elements.indexOf('#/properties/onLimit') < elements.indexOf('#/properties/onNonBooleanResult');
    },
  });

  const search = flattenTree(safeJson(t.get(A, `${NE}/search?query=Loop`, { endpoint: 'loop_search' }).body));
  const category = search.find((i) => i.type === 'CATEGORY' && i.id === LOOP_CATEGORY);
  check(category, { "search nests the Loop under the 'Flow Control' category": (c) => !!c && (c.children || []).some((n) => n.id === LOOP_NODE_MODEL) });

  const roots = safeJson(t.get(A, `${NE}/children?parentId=`).body) || [];
  const flow = safeJson(t.get(A, `${NE}/children?parentId=${encodeURIComponent(LOOP_CATEGORY)}`, { endpoint: 'loop_children' }).body) || [];
  check(null, {
    "the palette roots include 'Flow Control'": () => roots.some((r) => r.id === LOOP_CATEGORY && r.type === 'CATEGORY'),
    "'Flow Control' lists the Loop as a node": () => flow.some((n) => n.id === LOOP_NODE_MODEL && n.type === 'NODE'),
  });

  const doc = t.get(A, `${NE}/nodes/${LOOP_NODE_MODEL}/documentation`, { endpoint: 'loop_doc' });
  check(doc, {
    'the Loop documentation is 200 markdown starting with "# Loop"': (r) =>
      r.status === 200 && String(r.headers['Content-Type']).indexOf('text/markdown') === 0 && r.body.trim().indexOf('# Loop') === 0,
    'the Loop documentation describes CEL and onNonBooleanResult': (r) => r.body.indexOf('CEL') >= 0 && r.body.indexOf('onNonBooleanResult') >= 0,
    'the Loop documentation no longer describes a single-comparison subset': (r) => r.body.indexOf('one flow variable compared') < 0,
  });

  // The registry is shared by all tenants by design.
  const otherQueues = safeJson(o.post(A, `${NE}/nodes/task-queues`, [LOOP_NODE_MODEL]).body) || {};
  check(otherQueues, { 'another tenant sees the same Loop (the registry is shared by design)': (q) => q[LOOP_NODE_MODEL] === BUILTIN_TASK_QUEUE });
}

// ---------------------------------------------------------------------------------------------------------------------
// The Loop settings against the registered schema

function settingsChecks(ctx) {
  const defaults = validate(ctx, chain(ctx, {}));
  check(defaults.res, {
    'a loop with the default settings (onNonBooleanResult: fail included) is valid': (r) => r.status === 200 && defaults.body.valid === true,
    'a loop with the default settings has no error on the loop': () => issuesAt(defaults.body.errors, 'L').length === 0,
  });

  const bad = [
    ['maxIterations 0', { maxIterations: 0 }, 'maxIterations', 'minimum'],
    ['maxIterations 10001', { maxIterations: 10001 }, 'maxIterations', 'maximum'],
    ['onLimit outside its enum', { onLimit: 'retry' }, 'onLimit', 'enumeration'],
    ['check outside its enum', { check: 'during' }, 'check', 'enumeration'],
    ['onNonBooleanResult outside its enum', { onNonBooleanResult: 'maybe' }, 'onNonBooleanResult', 'enumeration'],
    ['an empty condition', { condition: '' }, 'condition', 'at least 1'],
    ['a 2,049-character condition', { condition: conditionOfLength(2049) }, 'condition', '2,048'],
  ];
  for (const [name, loop, property, messagePart] of bad) {
    expectOneLoopError(ctx, `loop setting: ${name}`, chain(ctx, loop), property, messagePart);
  }

  const start = ctx.t.post(cfg.apiServer, WF, chain(ctx, { onNonBooleanResult: 'maybe' }), { endpoint: 'loop_start_bad_setting' });
  const startBody = safeJson(start.body) || {};
  check(start, {
    'start with onNonBooleanResult outside its enum is 400 ProblemDetail': (r) => r.status === 400 && isProblemJson(r.headers['Content-Type']),
    'the start 400 names the loop and onNonBooleanResult': () => issuesAt(startBody.errors, 'L', 'onNonBooleanResult').length === 1,
  });

  const budget = validate(ctx, chain(ctx, { maxIterations: 10000 }));
  check(budget.res, {
    'maxIterations 10000 x 2 members is valid but warns on maxIterations about the run history limit': () =>
      budget.body.valid === true && issuesAt(budget.body.warnings, 'L', 'maxIterations').some((w) => w.message.indexOf('run history limit') >= 0),
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Loop structure: no edges to a loop, no path that leaves a loop and comes back

function structureChecks(ctx) {
  const d = ctx.d;
  ctx.label += 1;
  const toLoop = workflowOf({
    runId: d.runId,
    tenant: d.owner,
    label: `loop-${ctx.label}`,
    nodes: [
      workflowNode({ id: 'seed', template: templates.CreateTableNodeModel }),
      loopNode({ id: 'L', registered: d.registeredLoop }),
      workflowNode({ id: 'score', template: templates.AnomalyDetectorZScoreNodeModel, parent: 'L', x: 40 }),
    ],
    edges: [edge('seed', 'data', 'score', 'data'), edge('seed', 'data', 'L', 'data')],
  });
  const res = validate(ctx, toLoop);
  const edgeErrors = (res.body.errors || []).filter((e) => e.edge);
  check(res.res, {
    'an edge into a loop is invalid': () => res.body.valid === false,
    'the edge into the loop gets one error naming the edge and saying a loop has no ports': () =>
      edgeErrors.length === 1 && edgeErrors[0].message.indexOf("'L' is a loop. A loop has no ports") >= 0,
  });

  const valid = validate(ctx, chain(ctx, {}));
  check(valid.res, {
    'A -> X1 -> X2 -> B with X1, X2 in the loop is valid': () => valid.body.valid === true,
    'a loop is never reported as not connected': () => issuesAt(valid.body.warnings, 'L').every((w) => w.message.indexOf('not connected') < 0),
  });

  ctx.label += 1;
  const outAndBack = workflowOf({
    runId: d.runId,
    tenant: d.owner,
    label: `loop-${ctx.label}`,
    nodes: [
      workflowNode({ id: 'seed', template: templates.CreateTableNodeModel }),
      loopNode({ id: 'L', registered: d.registeredLoop }),
      workflowNode({ id: 'score', template: templates.AnomalyDetectorZScoreNodeModel, parent: 'L', x: 40 }),
      workflowNode({ id: 'mid', template: templates.AnomalyDetectorZScoreNodeModel, x: 1300 }),
      workflowNode({ id: 'split', template: templates.ConditionalSplitterNodeModel, parent: 'L', x: 370 }),
    ],
    edges: [edge('seed', 'data', 'score', 'data'), edge('score', 'data', 'mid', 'data'), edge('mid', 'data', 'split', 'data')],
  });
  const back = validate(ctx, outAndBack);
  const atLoop = issuesAt(back.body.errors, 'L');
  check(back.res, {
    "X1 -> Y -> X2 (Y outside loop L) is invalid with an error on 'L' naming 'Y'": () =>
      back.body.valid === false && atLoop.length === 1 && atLoop[0].message.indexOf("leave loop 'L' and come back into it through 'mid'") >= 0,
  });
  const backStart = ctx.t.post(cfg.apiServer, WF, outAndBack, { endpoint: 'loop_start_out_and_back' });
  check(backStart, { 'start of X1 -> Y -> X2 is 400': (r) => r.status === 400 });
}

// ---------------------------------------------------------------------------------------------------------------------
// The CEL condition: rejected and accepted conditions, the constant-condition warning, start 400

function conditionChecks(ctx) {
  for (const c of REJECTED_CONDITIONS) {
    expectOneLoopError(ctx, `condition ${c.label} (${c.condition.length > 40 ? `${c.condition.slice(0, 40)}...` : c.condition})`, chain(ctx, { condition: c.condition }), 'condition', `Loop 'L': the condition ${c.reason}`);
  }
  // Over 2,048 characters the schema's maxLength reports it (one error), and the CEL validator does not add a second.
  expectOneLoopError(ctx, 'condition of 2,049 characters (schema maxLength, no second error)', chain(ctx, { condition: conditionOfLength(2049) }), 'condition', 'must be at most 2,048 characters');

  for (const condition of ACCEPTED_CONDITIONS) {
    const name = condition.length > 60 ? `${condition.slice(0, 40)}... (${condition.length} characters)` : condition;
    const { res, body } = validate(ctx, chain(ctx, { condition }));
    check(res, { [`full-CEL condition accepted: ${name}`]: () => res.status === 200 && body.valid === true && issuesAt(body.errors, 'L').length === 0 });
  }

  const constant = validate(ctx, chain(ctx, { condition: 'true' }));
  const w1 = issuesAt(constant.body.warnings, 'L', 'condition');
  check(constant.res, {
    'condition `true` is valid with exactly one warning on the condition': () => constant.body.valid === true && w1.length === 1,
    'the warning says the condition reads no flow variable': () => w1.length === 1 && w1[0].message.indexOf('reads no flow variable, so it never changes') >= 0,
  });

  const start = ctx.t.post(cfg.apiServer, WF, chain(ctx, { condition: 'now() > 1' }), { endpoint: 'loop_start_bad_condition' });
  const body = safeJson(start.body) || {};
  const atCondition = issuesAt(body.errors, 'L', 'condition');
  check(start, {
    'start with a rejected condition is 400 ProblemDetail': (r) => r.status === 400 && isProblemJson(r.headers['Content-Type']),
    'the start 400 has one error on loop L / condition with the reason': () =>
      atCondition.length === 1 && atCondition[0].message.indexOf('does not type-check') >= 0,
    'a start rejected for its condition returns no workflowId': () => !body.workflowId,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// MCP (streamable HTTP at /mcp): the workflow tools accept loops through `parent`

function mcpSession(t) {
  const H = { Accept: 'application/json, text/event-stream' };
  const init = t.post(cfg.apiServer, '/mcp', {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'continuum-system-tests', version: '1' } },
  }, { endpoint: 'mcp_init' }, H);
  const session = init.headers['Mcp-Session-Id'];
  const headers = session ? { ...H, 'Mcp-Session-Id': session } : H;
  t.post(cfg.apiServer, '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, { endpoint: 'mcp_initialized' }, headers);
  let id = 1;
  const call = (method, params) => {
    id += 1;
    return mcpMessage(t.post(cfg.apiServer, '/mcp', { jsonrpc: '2.0', id, method, params }, { endpoint: 'mcp_call' }, headers).body);
  };
  return { init, session, call, tool: (name, args) => mcpToolResult(call('tools/call', { name, arguments: args })) };
}

function mcpChecks({ t }) {
  const mcp = mcpSession(t);
  check(mcp.init, { 'MCP initialize is 200 with a session id': (r) => r.status === 200 && !!mcp.session });

  const tools = (((mcp.call('tools/list', {}) || {}).result || {}).tools || []);
  const byName = {};
  for (const tool of tools) {
    byName[tool.name] = tool;
  }
  const validateDescription = (byName.validateContinuumWorkflow || {}).description || '';
  check(tools, {
    'MCP still has exactly six tools': (l) => l.length === 6,
    'the workflow tool descriptions teach the loop: nodeId, parent, vars["name"], onNonBooleanResult, validator authoritative': () =>
      [byName.validateContinuumWorkflow, byName.buildContinuumWorkflow].every((tool) => {
        const text = (tool || {}).description || '';
        return text.indexOf(LOOP_NODE_MODEL) >= 0 && text.indexOf('parent') >= 0 && text.indexOf('vars["name"]') >= 0 &&
          text.indexOf('onNonBooleanResult') >= 0 && text.indexOf('authoritative') >= 0;
      }),
    'the validate tool says edges never name a loop': () => validateDescription.indexOf('Edges never name a loop') >= 0,
  });

  const metadata = mcp.tool('getContinuumNodeMetadata', { nodeId: LOOP_NODE_MODEL }) || {};
  check(metadata, {
    'getContinuumNodeMetadata returns the Loop with its schemas': (m) =>
      m.nodeModel === LOOP_NODE_MODEL && !!m.propertiesSchema && !!m.propertiesUISchema && ((m.propertiesSchema || {}).required || []).includes('onNonBooleanResult'),
  });

  const spec = (condition) => ({
    name: 'loop-spec',
    nodes: [
      { key: 'seed', nodeId: FIXTURE_NODES[0], properties: { jsonArrayString: '[{"value": 1}]' } },
      { key: 'L', nodeId: LOOP_NODE_MODEL, properties: condition === undefined ? {} : { condition } },
      { key: 'score', nodeId: FIXTURE_NODES[1], parent: 'L', properties: { valueCol: 'value' } },
      { key: 'split', nodeId: FIXTURE_NODES[2], parent: 'L', properties: { column: 'value', threshold: 15 } },
    ],
    edges: [{ from: 'seed', fromPort: 'data', to: 'score', toPort: 'data' }, { from: 'score', fromPort: 'data', to: 'split', toPort: 'data' }],
  });

  const ok = mcp.tool('validateContinuumWorkflow', spec(`vars["${SPLIT_STATUS}"] != "SUCCESS"`)) || {};
  check(ok, { 'MCP validate accepts a spec with a loop and members declaring parent': (r) => r.valid === true && (r.errors || []).length === 0 });

  for (const c of REJECTED_CONDITIONS) {
    const res = mcp.tool('validateContinuumWorkflow', spec(c.condition)) || {};
    const atCondition = issuesAt(res.errors, 'L', 'condition');
    check(res, { [`MCP validate reports ${c.label} as one error on L / condition`]: (r) => r.valid === false && atCondition.length === 1 && atCondition[0].message.indexOf(c.reason) >= 0 });
  }
  const constant = mcp.tool('validateContinuumWorkflow', spec('true')) || {};
  check(constant, { 'MCP validate gives one warning on L / condition for condition `true`': (r) => r.valid === true && issuesAt(r.warnings, 'L', 'condition').length === 1 });

  const rejectedBuild = mcp.tool('buildContinuumWorkflow', spec('now() > 1')) || {};
  check(rejectedBuild, {
    'MCP build refuses a rejected condition with the error and no workflow': (r) => r.valid === false && issuesAt(r.errors, 'L', 'condition').length === 1 && !r.workflow,
  });

  const built = mcp.tool('buildContinuumWorkflow', spec(`vars["${SPLIT_STATUS}"] != "SUCCESS"`)) || {};
  const nodes = ((built.workflow || {}).nodes) || [];
  const ids = nodes.map((n) => n.id);
  const loop = nodes.find((n) => n.id === 'L') || {};
  const members = nodes.filter((n) => n.parentNode === 'L');
  check(built, {
    'MCP build of a loop spec is valid and returns a workflow': (r) => r.valid === true && !!r.workflow,
    'the built loop has type Loop and the Loop node model': () => loop.type === 'Loop' && (loop.data || {}).nodeModel === LOOP_NODE_MODEL,
    'the built loop comes before its members': () => ids.indexOf('L') >= 0 && ids.indexOf('L') < ids.indexOf('score') && ids.indexOf('L') < ids.indexOf('split'),
    'every built member has parentNode L and a position inside the box': () =>
      members.length === 2 && members.every((m) => m.position.x >= 0 && m.position.y >= 0 &&
        m.position.x + m.width <= loop.width && m.position.y + m.height <= loop.height),
    'the built edges never name the loop': () => (built.workflow.edges || []).length === 2 && built.workflow.edges.every((e) => e.source !== 'L' && e.target !== 'L'),
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Schedules validate loops like a start; a loop schedule belongs to its owner

function scheduleChecks(ctx) {
  const { t, o } = ctx;
  const A = cfg.apiServer;
  const created = [];
  try {
    const rejected = t.post(A, SCHED, { name: `loop-sched-bad-${ctx.d.runId}`, cronExpression: NEVER, continuumWorkflowModel: chain(ctx, { condition: 'foo == 1' }) }, { endpoint: 'loop_sched_bad' });
    if (rejected.status === 201) {
      created.push((safeJson(rejected.body) || {}).scheduleId);
    }
    check(rejected, {
      'a schedule whose loop condition is rejected is 400 with the error on L / condition': (r) =>
        r.status === 400 && issuesAt((safeJson(r.body) || {}).errors, 'L', 'condition').length === 1,
    });

    const res = t.post(A, SCHED, { name: `loop-sched-${ctx.d.runId}`, cronExpression: NEVER, continuumWorkflowModel: chain(ctx, {}) }, { endpoint: 'loop_sched' });
    const sch = safeJson(res.body) || {};
    if (sch.scheduleId) {
      created.push(sch.scheduleId);
    }
    const stored = ((sch.continuumWorkflowModel || {}).nodes) || [];
    check(res, {
      'a schedule of a valid loop workflow is 201': (r) => r.status === 201 && !!sch.scheduleId,
      'the stored schedule keeps the loop type and the members parentNode': () =>
        stored.some((n) => n.id === 'L' && n.type === 'Loop') && stored.filter((n) => n.parentNode === 'L').length === 2,
    });
    if (sch.scheduleId) {
      check(t.get(A, `${SCHED}/${sch.scheduleId}`), { 'the owner can read the loop schedule': (r) => r.status === 200 });
      expectHidden(o.get(A, `${SCHED}/${sch.scheduleId}`), 'loop schedule', ctx.d.other);
    }
  } finally {
    for (const id of created) {
      if (id) {
        t.del(A, `${SCHED}/${id}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Live loop runs

/**
 * The two watched runs (progress and iteration messages are sampled while they run) are started and followed one at a
 * time; every other run is started at once and followed afterwards.
 */
function runChecks(ctx) {
  const { t } = ctx;
  const done = {};
  const watched = [
    { name: 'limit 3 with stop-with-warning', watch: true, model: chain(ctx, { condition: `vars["${SPLIT_STATUS}"] == "SUCCESS"`, maxIterations: 3, onLimit: 'stop-with-warning' }) },
    { name: 'nested loops', watch: true, model: nestedWorkflow(ctx) },
  ];
  const runs = [];
  for (const w of watched) {
    const run = { ...w, ...start(ctx, w.name, w.model) };
    runs.push(run);
    done[run.name] = run.workflowId ? follow(t, run) : { record: undefined, observed: { progress: [], messages: [] } };
  }
  const cases = [
    { name: 'condition false after iteration 1', loop: { condition: `vars["${SPLIT_STATUS}"] != "SUCCESS"` } },
    { name: 'limit 2 with fail', loop: { condition: `vars["${SPLIT_STATUS}"] == "SUCCESS"`, maxIterations: 2, onLimit: 'fail' } },
    { name: 'check before, false at the start', loop: { condition: `vars["${SEED_STATUS}"] != "SUCCESS"`, check: 'before' } },
    { name: 'missing variable', loop: { condition: 'vars["hasMore"] == true' } },
    { name: 'missing variable absorbed by ||', loop: { condition: `vars["hasMore"] == true || vars["${SPLIT_STATUS}"] == "SUCCESS"`, maxIterations: 2, onLimit: 'stop-with-warning' } },
    { name: 'string == int is false', loop: { condition: `vars["${SPLIT_STATUS}"] == 1` } },
    { name: 'string > int is an evaluation error', loop: { condition: `vars["${SPLIT_STATUS}"] > 1` } },
    { name: 'int variable against a double literal', loop: { condition: `vars["${SPLIT_DURATION}"] > -1.5`, maxIterations: 2, onLimit: 'stop-with-warning' } },
    { name: 'non-boolean with fail', loop: { condition: `vars["${SPLIT_STATUS}"]` } },
    { name: 'non-boolean with treat-as-false', loop: { condition: `vars["${SPLIT_STATUS}"]`, onNonBooleanResult: 'treat-as-false' } },
    { name: 'check before, non-boolean with treat-as-false', loop: { condition: `vars["${SEED_STATUS}"]`, check: 'before', onNonBooleanResult: 'treat-as-false' } },
  ];
  const batch = cases.map((c) => ({ ...c, ...start(ctx, c.name, chain(ctx, c.loop)) }));
  batch.push({ name: 'member fails', ...start(ctx, 'member fails', failingMemberWorkflow(ctx)) });
  for (const run of batch) {
    runs.push(run);
    done[run.name] = run.workflowId ? follow(t, run) : { record: undefined, observed: { progress: [], messages: [] } };
  }
  const rec = (name) => done[name].record;
  const state = (name, node) => nodeState(rec(name), node);

  // A loop that stops normally
  check(rec('condition false after iteration 1'), {
    'a loop whose condition turns false ends SUCCESS "Finished after 1 iterations"': () =>
      state('condition false after iteration 1', 'L').status === 'SUCCESS' && state('condition false after iteration 1', 'L').message === 'Finished after 1 iterations',
    'the members ran and the node after the loop ran': () =>
      ['score', 'split', 'after'].every((n) => state('condition false after iteration 1', n).status === 'SUCCESS'),
    'a loop run that succeeds is FINISHED': (r) => !!r && r.status === 'FINISHED',
  });

  const limitWarn = rec('limit 3 with stop-with-warning');
  const carried = (nodeOutput(limitWarn, 'L', '$variable') || {}).data || {};
  const watchedRun = done['limit 3 with stop-with-warning'].observed;
  check(limitWarn, {
    'the limit with stop-with-warning ends WARNING "Stopped at the limit of 3 iterations"': () =>
      state('limit 3 with stop-with-warning', 'L').status === 'WARNING' && state('limit 3 with stop-with-warning', 'L').message === 'Stopped at the limit of 3 iterations',
    'after a stop-with-warning limit the node after the loop runs and the run is FINISHED': (r) =>
      state('limit 3 with stop-with-warning', 'after').status === 'SUCCESS' && !!r && r.status === 'FINISHED',
    "the finished loop stores the variables carried into its last iteration as its display $variable": () => carried[SPLIT_STATUS] === 'SUCCESS',
    'run progress was sampled while the loop ran, never decreased and ended at 100': (r) =>
      watchedRun.progress.some((p) => p < 100) && isNonDecreasing(watchedRun.progress) && !!r && r.progressPercentage === 100,
    'while the loop iterates it shows "Iteration k of 3"': () => watchedRun.messages.some((m) => /^L:Iteration [123] of 3$/.test(m)),
    'the run snapshot keeps the loop type and the members parentNode': (r) =>
      (snapshotNode(r, 'L') || {}).type === 'Loop' && (snapshotNode(r, 'score') || {}).parentNode === 'L' && (snapshotNode(r, 'split') || {}).parentNode === 'L',
  });

  failedLoop(rec, 'limit 2 with fail', "Loop 'L' reached its limit of 2 iterations and the condition still holds.", 'the limit with fail');

  check(rec('check before, false at the start'), {
    'check before with a false condition: loop SUCCESS "Condition was false before the first iteration"': () =>
      state('check before, false at the start', 'L').status === 'SUCCESS' && state('check before, false at the start', 'L').message === 'Condition was false before the first iteration',
    'check before with a false condition: members and the consumer after the loop are SKIPPED': () =>
      ['score', 'split', 'after'].every((n) => state('check before, false at the start', n).status === 'SKIPPED'),
    'check before with a false condition: the run is FINISHED': (r) => !!r && r.status === 'FINISHED',
  });

  // CEL semantics at run time
  failedLoop(rec, 'missing variable', "Loop 'L': flow variable 'hasMore' is not set when the condition is checked in iteration 1 (column", 'a missing variable');
  check(rec('missing variable absorbed by ||'), {
    'a || whose other side is true absorbs the missing variable (no failure; the loop reaches its limit with a warning)': () =>
      state('missing variable absorbed by ||', 'L').status === 'WARNING' && errorText(rec('missing variable absorbed by ||'), 'L') === '',
  });
  check(rec('string == int is false'), {
    'a string compared == with an int is false, so the loop ends after iteration 1': () =>
      state('string == int is false', 'L').status === 'SUCCESS' && state('string == int is false', 'L').message === 'Finished after 1 iterations',
  });
  failedLoop(rec, 'string > int is an evaluation error', "Loop 'L': the condition check in iteration 1 failed with EVALUATION_ERROR", 'a string > int comparison');
  check(rec('int variable against a double literal'), {
    'an int variable compares with a double literal by value (true: the loop reaches its limit, no failure)': () =>
      state('int variable against a double literal', 'L').status === 'WARNING' && state('int variable against a double literal', 'L').message === 'Stopped at the limit of 2 iterations',
  });

  // onNonBooleanResult
  failedLoop(rec, 'non-boolean with fail', 'Loop \'L\': the condition returned a string ("SUCCESS") in iteration 1, not true or false.', 'a non-boolean result with fail');
  check(rec('non-boolean with treat-as-false'), {
    'a non-boolean result with treat-as-false ends the loop WARNING with the treated-as-false message': () =>
      state('non-boolean with treat-as-false', 'L').status === 'WARNING' && state('non-boolean with treat-as-false', 'L').message === 'Condition returned string in iteration 1; treated as false.',
    'with treat-as-false the node after the loop runs and the run is FINISHED': (r) => state('non-boolean with treat-as-false', 'after').status === 'SUCCESS' && !!r && r.status === 'FINISHED',
  });
  check(rec('check before, non-boolean with treat-as-false'), {
    'check before and a non-boolean first check under treat-as-false: members SKIPPED, loop WARNING': () =>
      state('check before, non-boolean with treat-as-false', 'L').status === 'WARNING' &&
      state('check before, non-boolean with treat-as-false', 'L').message === 'Condition returned string before the first iteration; treated as false.' &&
      ['score', 'split'].every((n) => state('check before, non-boolean with treat-as-false', n).status === 'SKIPPED'),
  });

  // A failing member stops the loop
  failedLoop(rec, 'member fails', "Loop 'L' stopped in iteration 1: node 'bad' failed.", 'a failing member');

  // Nested loops
  const nested = done['nested loops'];
  check(nested.record, {
    'nested loops: the outer loop stops at its limit of 2 and the inner one at its limit of 3, with warnings': () =>
      state('nested loops', 'O').message === 'Stopped at the limit of 2 iterations' && state('nested loops', 'I').message === 'Stopped at the limit of 3 iterations' &&
      state('nested loops', 'O').status === 'WARNING' && state('nested loops', 'I').status === 'WARNING',
    'nested loops: the run is FINISHED and the node after the outer loop ran': (r) => !!r && r.status === 'FINISHED' && state('nested loops', 'after').status === 'SUCCESS',
    'nested loops: while iterating, a loop shows "Iteration k of max"': () => nested.observed.messages.some((m) => /^[OI]:Iteration \d+ of [23]$/.test(m)),
    'nested loops: run progress was sampled while running and never decreased': () =>
      nested.observed.progress.some((p) => p < 100) && isNonDecreasing(nested.observed.progress),
  });

  // A loop run belongs to its owner
  const anyRun = runs.find((r) => r.workflowId);
  if (anyRun) {
    const path = `/api/v1/workflow-runs/${encodeURIComponent(anyRun.workflowId)}`;
    check(t.get(cfg.apiServer, path), { 'the owner can read a loop run': (r) => r.status === 200 });
    expectHidden(ctx.o.get(cfg.apiServer, path), 'loop run record', ctx.d.other);
  }
}

function start(ctx, name, model) {
  const startedAt = Date.now();
  const res = ctx.t.post(cfg.apiServer, WF, model, { endpoint: 'loop_run_start' });
  const workflowId = res.status === 200 ? (safeJson(res.body) || {}).workflowId : undefined;
  check(res, { [`loop run "${name}" starts (200)`]: () => !!workflowId });
  return { workflowId, startedAt };
}

/** Polls a run record until it is terminal; when `watch` is set, records the progress and loop messages it saw. */
function follow(t, run) {
  const deadline = Date.now() + cfg.workflowTimeoutSec * 1000;
  const observed = { progress: [], messages: [] };
  let record;
  while (Date.now() < deadline) {
    const res = t.get(cfg.apiServer, `/api/v1/workflow-runs/${encodeURIComponent(run.workflowId)}`, { endpoint: 'loop_run_get' });
    record = res.status === 200 ? safeJson(res.body) : undefined;
    if (record && run.watch) {
      observed.progress.push(record.progressPercentage || 0);
      for (const loopId of ['L', 'O', 'I']) {
        const message = nodeState(record, loopId).message;
        if (message && observed.messages.indexOf(`${loopId}:${message}`) < 0) {
          observed.messages.push(`${loopId}:${message}`);
        }
      }
    }
    if (record && isTerminal(record.status)) {
      // The record is written asynchronously: give the last node events a moment to land.
      sleep(1);
      const last = t.get(cfg.apiServer, `/api/v1/workflow-runs/${encodeURIComponent(run.workflowId)}`);
      record = last.status === 200 ? safeJson(last.body) : record;
      break;
    }
    sleep(run.watch ? 0.2 : 1);
  }
  return { record, observed };
}

/**
 * A loop that failed: the loop is FAILED with `errorStart` as its `$error` (and message), the node after it is
 * SKIPPED, and the run record is FAILED (a run in which any node or loop failed is recorded FAILED, not FINISHED).
 */
function failedLoop(rec, name, errorStart, what, loopId = 'L') {
  const record = rec(name);
  const loop = nodeState(record, loopId);
  const shown = errorStart.length > 70 ? `${errorStart.slice(0, 70)}...` : errorStart;
  check(record, {
    [`${what} fails the loop (FAILED) with the $error "${shown}"`]: () =>
      loop.status === 'FAILED' && errorText(record, loopId).indexOf(errorStart) === 0,
    [`${what}: the node after the loop is SKIPPED`]: () => nodeState(record, 'after').status === 'SKIPPED',
    [`${what}: the run is recorded FAILED`]: (r) => !!r && r.status === 'FAILED',
  });
}

/** seed -> [L: bad (CreateTable with an invalid JSON array) -> score] -> after. */
function failingMemberWorkflow(ctx) {
  ctx.label += 1;
  return workflowOf({
    runId: ctx.d.runId,
    tenant: ctx.d.owner,
    label: `loop-${ctx.label}`,
    nodes: [
      loopNode({ id: 'L', registered: ctx.d.registeredLoop, properties: { condition: `vars["${SPLIT_STATUS}"] == "SUCCESS"`, maxIterations: 3 } }),
      workflowNode({ id: 'bad', template: templates.CreateTableNodeModel, parent: 'L', properties: { jsonArrayString: 'not a json array' }, x: 40 }),
      workflowNode({ id: 'score', template: templates.AnomalyDetectorZScoreNodeModel, parent: 'L', x: 370 }),
      workflowNode({ id: 'after', template: templates.AnomalyDetectorZScoreNodeModel, x: 1300 }),
    ],
    edges: [edge('bad', 'data', 'score', 'data'), edge('score', 'data', 'after', 'data')],
  });
}

/** seed -> [O (2 iterations): [I (3 iterations): score -> split]] -> after. */
function nestedWorkflow(ctx) {
  ctx.label += 1;
  const always = `vars["${SEED_STATUS}"] == "SUCCESS"`;
  return workflowOf({
    runId: ctx.d.runId,
    tenant: ctx.d.owner,
    label: `loop-${ctx.label}`,
    nodes: [
      workflowNode({ id: 'seed', template: templates.CreateTableNodeModel, properties: { jsonArrayString: '[{"value": 1}, {"value": 20}, {"value": 30}]' } }),
      loopNode({ id: 'O', registered: ctx.d.registeredLoop, properties: { condition: always, maxIterations: 2, onLimit: 'stop-with-warning' }, width: 1100, height: 400 }),
      loopNode({ id: 'I', registered: ctx.d.registeredLoop, parent: 'O', properties: { condition: always, maxIterations: 3, onLimit: 'stop-with-warning' }, x: 40, y: 60 }),
      workflowNode({ id: 'score', template: templates.AnomalyDetectorZScoreNodeModel, parent: 'I', x: 40 }),
      workflowNode({ id: 'split', template: templates.ConditionalSplitterNodeModel, parent: 'I', x: 370 }),
      workflowNode({ id: 'after', template: templates.AnomalyDetectorZScoreNodeModel, x: 1500 }),
    ],
    edges: [edge('seed', 'data', 'score', 'data'), edge('score', 'data', 'split', 'data'), edge('split', 'high', 'after', 'data')],
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Loops that run several iterations: conditions over the default start / end timestamps of members that run only in
// chosen iterations (see lib/loopscenarios.js for why each one is deterministic)

function scenario(ctx, build, ...args) {
  ctx.label += 1;
  return build({ runId: ctx.d.runId, tenant: ctx.d.owner, label: `loop-${ctx.label}`, templates, registeredLoop: ctx.d.registeredLoop }, ...args);
}

/** Starts every run of `models` (name -> model) at once, then follows each to its end; returns name -> record. */
function runAll(ctx, models, watched = []) {
  const started = Object.entries(models).map(([name, model]) => ({ name, watch: watched.includes(name), ...start(ctx, name, model) }));
  const done = {};
  for (const run of started) {
    done[run.name] = run.workflowId ? follow(ctx.t, run) : { record: undefined, observed: { progress: [], messages: [] } };
  }
  return done;
}

function multiIterationChecks(ctx) {
  const scoreModel = templates.AnomalyDetectorZScoreNodeModel.nodeModel;
  const startOf = (nodeId) => defaultVariable(scoreModel, nodeId, 'startTimestamp');
  const models = {
    'three iterations': scenario(ctx, threeIterationLoop),
    'check before, true for two iterations': scenario(ctx, beforeTwoIterationsLoop),
    'member fails in iteration 2': scenario(ctx, memberFailsInIteration2Loop),
    'non-boolean in iteration 2 with fail': scenario(ctx, nonBooleanInIteration2Loop, 'fail'),
    'non-boolean in iteration 2 with treat-as-false': scenario(ctx, nonBooleanInIteration2Loop, 'treat-as-false'),
    'carried value overrides the outside value': scenario(ctx, carriedOverridesOutsideLoop),
    'later member wins a name clash': scenario(ctx, laterMemberWinsLoop),
  };
  const three = validate(ctx, models['three iterations']);
  check(three.res, { 'the three-iteration loop over default timestamps is valid': () => three.body.valid === true && (three.body.errors || []).length === 0 });

  const done = runAll(ctx, models, ['three iterations']);
  const rec = (name) => done[name].record;
  const state = (name, node) => nodeState(rec(name), node);

  const threeRun = 'three iterations';
  const display = (nodeOutput(rec(threeRun), 'L', '$variable') || {}).data || {};
  check(rec(threeRun), {
    'a condition true in iterations 1 and 2 ends the loop SUCCESS "Finished after 3 iterations"': () =>
      state(threeRun, 'L').status === 'SUCCESS' && state(threeRun, 'L').message === 'Finished after 3 iterations',
    'while the three-iteration loop runs it shows "Iteration k of 10"': () => done[threeRun].observed.messages.some((m) => /^L:Iteration [123] of 10$/.test(m)),
    'after the three-iteration loop the node after it ran and the run is FINISHED': (r) =>
      state(threeRun, 'after').status === 'SUCCESS' && !!r && r.status === 'FINISHED',
    'the three-iteration loop shows as $variable the set carried into iteration 3 (m1 from iteration 1, then m2 from iteration 2)': () =>
      typeof display[startOf('m1')] === 'number' && typeof display[startOf('m2')] === 'number' && display[startOf('m1')] < display[startOf('m2')],
    'the node after the loop inherits the last iteration\'s carried variables (the observer loop reads m1 < m2 < score and stops after 1 iteration)': () =>
      state(threeRun, 'V').status === 'SUCCESS' && state(threeRun, 'V').message === 'Finished after 1 iterations' && state(threeRun, 'obs').status === 'SUCCESS',
  });

  const beforeRun = 'check before, true for two iterations';
  check(rec(beforeRun), {
    'check before with a condition that turns false after 2 iterations: loop SUCCESS "Finished after 2 iterations"': () =>
      state(beforeRun, 'L').status === 'SUCCESS' && state(beforeRun, 'L').message === 'Finished after 2 iterations',
    'check before, two iterations: the run is FINISHED': (r) => !!r && r.status === 'FINISHED',
  });

  failedLoop(rec, 'member fails in iteration 2', "Loop 'L' stopped in iteration 2: node 'I2' failed.", 'a member failing in iteration 2');
  check(rec('member fails in iteration 2'), {
    'a member failing in iteration 2: the nested loop holding it is FAILED naming the node': () =>
      state('member fails in iteration 2', 'I2').status === 'FAILED' && errorText(rec('member fails in iteration 2'), 'I2').indexOf("Loop 'I2' stopped in iteration 1: node 'bad' failed.") === 0,
  });

  failedLoop(rec, 'non-boolean in iteration 2 with fail', 'Loop \'L\': the condition returned a string ("SUCCESS") in iteration 2, not true or false.', 'a non-boolean result in iteration 2 with fail');
  const treatRun = 'non-boolean in iteration 2 with treat-as-false';
  check(rec(treatRun), {
    'a non-boolean result in iteration 2 with treat-as-false ends the loop WARNING after iteration 2': () =>
      state(treatRun, 'L').status === 'WARNING' && state(treatRun, 'L').message === 'Condition returned string in iteration 2; treated as false.',
    'with treat-as-false in iteration 2 the node after the loop runs and the run is FINISHED': (r) =>
      state(treatRun, 'after').status === 'SUCCESS' && !!r && r.status === 'FINISHED',
  });

  const overrideRun = 'carried value overrides the outside value';
  check(rec(overrideRun), {
    'in iteration 2 the entry member sees the carried value, not the outside value of the same name (loop ends after 2 iterations)': () =>
      state(overrideRun, 'L').status === 'SUCCESS' && state(overrideRun, 'L').message === 'Finished after 2 iterations' &&
      state(overrideRun, 'J').status === 'WARNING' && state(overrideRun, 'obs').status === 'SUCCESS',
  });
  const clashRun = 'later member wins a name clash';
  check(rec(clashRun), {
    'on a carried name clash the member later in run order wins (the condition reads its value: loop ends after 1 iteration)': () =>
      state(clashRun, 'L').status === 'SUCCESS' && state(clashRun, 'L').message === 'Finished after 1 iterations',
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Loops with nothing to run end at once, also at maxIterations 10,000; a slow condition (a macro repeating a call, or
// one function call of about a second) stops at the time budget

/** Milliseconds between a run record's creation and its last update, or Infinity when unknown. */
function recordSpanMs(record) {
  const span = record ? Date.parse(record.updatedAt) - Date.parse(record.createdAt) : NaN;
  return Number.isFinite(span) ? span : Infinity;
}

function nothingToRunChecks(ctx) {
  const models = {
    'empty loops at 10,000': scenario(ctx, emptyLoops),
    'loop around an unconnected node at 10,000': scenario(ctx, unconnectedMemberLoop),
    'slow condition': scenario(ctx, slowConditionLoop),
    'one long function call': scenario(ctx, oneLongCallLoop),
  };
  const empty = validate(ctx, models['empty loops at 10,000']);
  check(empty.res, {
    'the empty loops validate with a "has no nodes inside it" warning each': () =>
      empty.body.valid === true && ['E', 'EI'].every((id) => issuesAt(empty.body.warnings, id).some((w) => w.message.indexOf('has no nodes inside it') >= 0)),
  });
  const slow = validate(ctx, models['slow condition']);
  check(slow.res, { 'the slow condition is accepted by the validator': () => slow.body.valid === true && issuesAt(slow.body.errors, 'L').length === 0 });
  const oneCall = validate(ctx, models['one long function call']);
  check(oneCall.res, { 'the one-long-call condition is accepted by the validator': () => oneCall.body.valid === true && issuesAt(oneCall.body.errors, 'L').length === 0 });

  const done = runAll(ctx, models);
  const rec = (name) => done[name].record;
  const state = (name, node) => nodeState(rec(name), node);
  const noIteration = 'The loop has no nodes inside it to run; it ran no iteration';

  const emptyRun = 'empty loops at 10,000';
  check(rec(emptyRun), {
    'an empty loop at maxIterations 10,000 ends WARNING without an iteration': () => state(emptyRun, 'E').status === 'WARNING' && state(emptyRun, 'E').message === noIteration,
    'a loop holding only an empty loop ends WARNING without an iteration, the inner loop SKIPPED': () =>
      state(emptyRun, 'EO').status === 'WARNING' && state(emptyRun, 'EO').message === noIteration && state(emptyRun, 'EI').status === 'SKIPPED',
    'next to empty loops the other nodes run and the run is FINISHED within 30 s': (r) =>
      state(emptyRun, 'after').status === 'SUCCESS' && !!r && r.status === 'FINISHED' && recordSpanMs(r) < 30000,
  });

  const unconnectedRun = 'loop around an unconnected node at 10,000';
  check(rec(unconnectedRun), {
    'a loop whose only member cannot run ends SKIPPED "No node inside the loop could run in iteration 1"': () =>
      state(unconnectedRun, 'L').status === 'SKIPPED' && state(unconnectedRun, 'L').message === 'No node inside the loop could run in iteration 1',
    'the skipped member and the node after the skipped loop are SKIPPED': () =>
      state(unconnectedRun, 'score').status === 'SKIPPED' && state(unconnectedRun, 'after').status === 'SKIPPED',
    'a loop skipped for nothing to run does not fail the run (FINISHED within 30 s)': (r) => !!r && r.status === 'FINISHED' && recordSpanMs(r) < 30000,
  });

  failedLoop(rec, 'slow condition', "Loop 'L': the condition check in iteration 1 failed with LIMIT_EXCEEDED", 'a condition slower than the time budget');
  check(rec('slow condition'), {
    'the slow condition\'s $error says it took longer than 200 ms': (r) => errorText(r, 'L').indexOf('the condition took longer than 200 ms to evaluate') >= 0,
    'the slow condition fails the run within 30 s (no wedged workflow task)': (r) => recordSpanMs(r) < 30000,
  });

  // One function call that runs about a second: the time budget cannot stop it between values, so the orchestrator's
  // bounded wait must fail the check, with the same message, instead of letting it block the workflow thread.
  failedLoop(rec, 'one long function call', "Loop 'L': the condition check in iteration 1 failed with LIMIT_EXCEEDED", 'one function call longer than the time budget');
  check(rec('one long function call'), {
    'the one-long-call $error says it took longer than 200 ms': (r) => errorText(r, 'L').indexOf('the condition took longer than 200 ms to evaluate') >= 0,
    'the one-long-call condition fails the run within 30 s (no wedged workflow task)': (r) => recordSpanMs(r) < 30000,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The orchestrator's condition evaluation threads are shared by every run and tenant. Another tenant's abandoned
// one-call evaluations may hold all of them; an innocent loop's check is then retried (delayed), never failed.

/** Polls `client`'s runs until each one's loop L is no longer waiting for its first check (or the timeout). */
function waitForLoopsDecided(client, runs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let decided = false;
  while (!decided && Date.now() < deadline) {
    decided = runs.every((run) => {
      const res = client.get(cfg.apiServer, `/api/v1/workflow-runs/${encodeURIComponent(run.workflowId)}`, { endpoint: 'loop_run_get' });
      const status = res.status === 200 ? nodeState(safeJson(res.body), 'L').status : undefined;
      return status === 'FAILED' || status === 'SUCCESS' || status === 'WARNING';
    });
    if (!decided) {
      sleep(0.2);
    }
  }
  return decided;
}

function sharedThreadChecks(ctx) {
  const { d, o } = ctx;
  // Let the abandoned calls of the earlier one-call runs return first, so the other tenant's runs get every thread.
  sleep(3);
  const holderBase = (i) => ({ runId: d.runId, tenant: d.other, label: `thread-holder-${i}`, templates, registeredLoop: d.registeredLoop });
  const holders = [];
  for (let i = 0; i < EVALUATION_THREADS; i += 1) {
    const res = o.post(cfg.apiServer, WF, oneLongCallLoop(holderBase(i), THREAD_HOLDING_CONDITION), { endpoint: 'loop_run_start' });
    const workflowId = res.status === 200 ? (safeJson(res.body) || {}).workflowId : undefined;
    check(res, { [`the other tenant's thread-holding loop run ${i + 1} starts (200)`]: () => !!workflowId });
    holders.push({ name: `holder-${i}`, workflowId, startedAt: Date.now() });
  }
  const started = holders.every((h) => !!h.workflowId);
  // Each holder's check is given up after 250 ms and recorded, but its one call keeps its thread for several seconds.
  const abandoned = started && waitForLoopsDecided(o, holders, 60000);
  check(abandoned, { "the other tenant's 4 thread-holding checks were given up (their loops are decided)": (a) => a === true });

  ctx.label += 1;
  const cheap = start(ctx, 'cheap loop while the threads are held', cheapLimitLoop({ runId: d.runId, tenant: d.owner, label: `loop-${ctx.label}`, templates, registeredLoop: d.registeredLoop }));
  const victim = cheap.workflowId ? follow(ctx.t, cheap).record : undefined;
  check(victim, {
    'a cheap loop whose check finds every thread held by another tenant still ends WARNING "Stopped at the limit of 3 iterations"': (r) =>
      nodeState(r, 'L').status === 'WARNING' && nodeState(r, 'L').message === 'Stopped at the limit of 3 iterations',
    'a cheap loop delayed by another tenant\'s held threads: the node after it ran and the run is FINISHED, not FAILED': (r) =>
      nodeState(r, 'after').status === 'SUCCESS' && !!r && r.status === 'FINISHED',
    'the cheap loop was delayed by the held threads (record span over 3 s), so its check really met a busy pool': (r) => recordSpanMs(r) > 3000 && recordSpanMs(r) !== Infinity,
  });

  const holderRecords = holders.map((h) => (h.workflowId ? follow(o, h).record : undefined));
  check(holderRecords, {
    "the other tenant's thread-holding loops fail with the 200 ms budget text, none with a busy text": (records) =>
      records.every((r) => nodeState(r, 'L').status === 'FAILED' && errorText(r, 'L').indexOf('the condition took longer than 200 ms to evaluate') >= 0 &&
        errorText(r, 'L').indexOf('busy') < 0),
    "the other tenant's thread-holding runs are recorded FAILED": (records) => records.every((r) => !!r && r.status === 'FAILED'),
  });
  if (cheap.workflowId) {
    expectHidden(o.get(cfg.apiServer, `/api/v1/workflow-runs/${encodeURIComponent(cheap.workflowId)}`), 'delayed loop run', d.other);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Workflows without loops still validate and run as before; a failed node fails the run

function loopFreeChecks(ctx) {
  const { d, t } = ctx;
  const { workflowId, startedAt } = startWorkflow(t, d.runId);
  const final = workflowId ? waitForTerminal(t, workflowId, startedAt) : 'NOT STARTED';
  check(final, { 'a workflow without loops still runs to FINISHED': (s) => s === 'FINISHED' });

  const failing = runAll(ctx, { 'loop-free run with a failed node': scenario(ctx, failingNodeWithoutLoop) })['loop-free run with a failed node'].record;
  check(failing, {
    'a loop-free run whose node fails: the node is FAILED and the node after it SKIPPED': (r) =>
      nodeState(r, 'seed').status === 'FAILED' && nodeState(r, 'after').status === 'SKIPPED',
    'a loop-free run whose node fails is recorded FAILED': (r) => !!r && r.status === 'FAILED',
  });
  if (failing && failing.workflowId) {
    const list = safeJson(t.get(cfg.apiServer, `/api/v1/workflow-runs?filter=${encodeURIComponent('status==FAILED')}&size=100`, { endpoint: 'loop_runs_failed' }).body) || {};
    check(list, { 'the run list filter status==FAILED finds the failed run': (b) => (b.content || []).some((r) => r.workflowId === failing.workflowId) });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Terminate: a healthy loop run and a run that starves itself (it never handles the terminate signal) both end
// TERMINATED in their run record. Runs last: the stuck run's retries hold every evaluation thread until it is stopped.

const STOP_GRACE_MS = 5000; // the api-server's grace period between the stop signal and Temporal's hard stop
const RUN_PATH = (id) => `/api/v1/workflow-runs/${encodeURIComponent(id)}`;

function readRun(client, workflowId) {
  const res = client.get(cfg.apiServer, RUN_PATH(workflowId), { endpoint: 'loop_run_get' });
  return res.status === 200 ? safeJson(res.body) : undefined;
}

/** True when `workflowId` is on the first page (200) of the caller's runs with `status`. */
function listedWithStatus(client, workflowId, status) {
  const body = safeJson(client.get(cfg.apiServer, `/api/v1/workflow-runs?filter=${encodeURIComponent(`status==${status}`)}&size=200`, { endpoint: 'loop_runs_by_status' }).body) || {};
  return (body.content || []).some((r) => r.workflowId === workflowId);
}

/** Polls the record for up to `timeoutMs`; returns every distinct status seen, in order, and the last record. */
function watchStatuses(client, workflowId, timeoutMs, until) {
  const deadline = Date.now() + timeoutMs;
  const statuses = [];
  let record;
  while (Date.now() < deadline) {
    record = readRun(client, workflowId);
    const status = record ? record.status : 'NO RECORD';
    if (statuses[statuses.length - 1] !== status) {
      statuses.push(status);
    }
    if (until && until(record)) {
      break;
    }
    sleep(0.25);
  }
  return { statuses, record };
}

function terminate(client, workflowId, endpoint) {
  return client.post(cfg.apiServer, `${WF}/${encodeURIComponent(workflowId)}/terminate?reason=system-test`, null, { endpoint });
}

function terminateChecks(ctx) {
  const { d, t, o } = ctx;
  const base = () => {
    ctx.label += 1;
    return { runId: d.runId, tenant: d.owner, label: `loop-${ctx.label}`, templates, registeredLoop: d.registeredLoop };
  };

  // A healthy loop run (200 cheap iterations, about 30 s) is terminated while it iterates: its own signal handler
  // reports TERMINATED, which the record shows once; it never shows another final status.
  const healthy = start(ctx, 'healthy loop to terminate', cheapLimitLoop(base(), 200));
  if (healthy.workflowId) {
    const iterating = watchStatuses(t, healthy.workflowId, 30000, (r) => /^Iteration ([3-9]|\d\d+) of 200$/.test(nodeState(r, 'L').message || ''));
    check(iterating.record, { 'the healthy loop run is iterating before it is terminated': (r) => !!r && r.status === 'RUNNING' });
    check(terminate(t, healthy.workflowId, 'loop_terminate'), { 'terminate of a healthy running loop run is 204': (r) => r.status === 204 });
    const after = watchStatuses(t, healthy.workflowId, STOP_GRACE_MS + 5000);
    check(after, {
      'a terminated healthy loop run is recorded TERMINATED and shows no other final status': (w) =>
        !!w.record && w.record.status === 'TERMINATED' && w.statuses.every((s) => s === 'RUNNING' || s === 'TERMINATED'),
      'a terminated healthy loop run: the record keeps the loop as the run last reported it (BUSY, not reset)': (w) => nodeState(w.record, 'L').status === 'BUSY',
    });
  }

  // A run that starves itself never handles the terminate signal; the api-server records TERMINATED after the hard stop.
  const stuck = start(ctx, 'self-starving run to terminate', selfStarvingLoops(base()));
  if (!stuck.workflowId) {
    return;
  }
  let stopped = false;
  try {
    const waiting = watchStatuses(t, stuck.workflowId, 6000);
    // A run whose 5 loops can run (not stuck) fails within about 2 s; this one keeps retrying its first check task.
    check(waiting.record, { 'the self-starving run is stuck: still RUNNING 6 s after its start': (r) => !!r && r.status === 'RUNNING' });
    expectHidden(terminate(o, stuck.workflowId, 'loop_terminate_other'), 'stuck run terminate', d.other);
    expectHidden(o.get(cfg.apiServer, RUN_PATH(stuck.workflowId)), 'stuck run record', d.other);
    check(readRun(t, stuck.workflowId), { 'another tenant\'s terminate left the stuck run RUNNING': (r) => !!r && r.status === 'RUNNING' });

    const res = terminate(t, stuck.workflowId, 'loop_terminate');
    stopped = res.status === 204;
    check(res, { 'terminate of the owner\'s stuck run is 204': () => stopped });
    // The server's own clock (the Date header, whole seconds) dates the stop, so a skewed client clock does not matter.
    const stopAt = Date.parse(res.headers.Date);
    const ended = watchStatuses(t, stuck.workflowId, STOP_GRACE_MS + 10000, (r) => !!r && r.status === 'TERMINATED');
    const endMs = ended.record ? Date.parse(ended.record.updatedAt) - stopAt : NaN;
    check(ended, {
      'a terminated stuck run is recorded TERMINATED after the grace period, never another final status': (w) =>
        !!w.record && w.record.status === 'TERMINATED' && w.statuses.every((s) => s === 'RUNNING' || s === 'TERMINATED'),
      'a terminated stuck run: updatedAt is the end time, about 5 s after the terminate': () => endMs >= STOP_GRACE_MS - 1000 && endMs < STOP_GRACE_MS + 10000,
    });
    check(stuck.workflowId, {
      'a terminated stuck run is no longer listed by status==RUNNING': (id) => !listedWithStatus(t, id, 'RUNNING'),
      'a terminated stuck run is listed by status==TERMINATED': (id) => listedWithStatus(t, id, 'TERMINATED'),
    });
    // A retry attempt of the stuck task that was under way at the stop may still publish; it must not reopen the record.
    const held = watchStatuses(t, stuck.workflowId, 15000);
    check(held, { 'a terminated stuck run stays TERMINATED 15 s later': (w) => w.statuses.length === 1 && w.statuses[0] === 'TERMINATED' });
    expectHidden(o.get(cfg.apiServer, RUN_PATH(stuck.workflowId)), 'terminated stuck run record', d.other);
  } finally {
    if (!stopped) {
      // Never leave a self-starving run behind: it would keep holding the evaluation threads of every tenant.
      terminate(t, stuck.workflowId, 'loop_terminate_cleanup');
    }
  }
}
