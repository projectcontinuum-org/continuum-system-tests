// Loop workflows whose condition changes value between iterations, steered only by the default flow variables every
// worker exports for each node run (`<prefix>.startTimestamp`, `.endTimestamp`, `.executionStatus`, ...). No k6
// imports, so they can be unit-tested with `node --test` (see test/loopscenarios.test.js).
//
// Two facts make these conditions deterministic:
// - Within one iteration a node starts after the node it reads from has ended, so
//   `x.startTimestamp >= score.endTimestamp`, where `score` is the loop's entry member that runs in every iteration,
//   holds exactly when `x` ran in this iteration.
// - A member's variables stay in the loop's carried set, unchanged, until the member runs again. So
//   `"x.startTimestamp" in vars` holds from the iteration after `x` first ran.
// A nested `check: before` loop with the condition "x has not run yet" runs its member `x` exactly once, in the first
// iteration of the enclosing loop that reaches it (a "once gate"). Gates chained on each other's variables make the
// enclosing loop's condition true for a chosen number of iterations.

import { edge, loopNode, workflowNode, workflowOf } from './loopmodel.js';

const NODE_MODEL_SUFFIX = 'Model';
const NON_IDENTIFIER_CHARACTER = /[^A-Za-z0-9_]/g;

/** Lowercases the leading run of capitals as one word, keeping the last one when a lowercase letter follows. */
function decapitalize(typeName) {
  const leadingCapitals = (typeName.match(/^[A-Z]*/) || [''])[0].length;
  if (leadingCapitals === 0) {
    return typeName;
  }
  const next = typeName.charAt(leadingCapitals);
  const nextIsLowercase = next !== '' && next === next.toLowerCase() && next !== next.toUpperCase();
  const lowercasedLength = leadingCapitals > 1 && nextIsLowercase ? leadingCapitals - 1 : leadingCapitals;
  return typeName.substring(0, lowercasedLength).toLowerCase() + typeName.substring(lowercasedLength);
}

/**
 * The name prefix of a node's default flow variables, as the worker builds it: the node type in camelCase without a
 * trailing `Model`, `_`, then the node id with every character other than letters, digits and `_` replaced by `_`
 * (`...AnomalyDetectorZScoreNodeModel` + `score` -> `anomalyDetectorZScoreNode_score`).
 */
export function defaultVariablePrefix(nodeModel, nodeId) {
  const simpleName = String(nodeModel).split('.').pop().split('$').pop();
  const typeName = simpleName.length > NODE_MODEL_SUFFIX.length && simpleName.endsWith(NODE_MODEL_SUFFIX)
    ? simpleName.substring(0, simpleName.length - NODE_MODEL_SUFFIX.length)
    : simpleName;
  return `${decapitalize(typeName.replace(NON_IDENTIFIER_CHARACTER, '_'))}_${String(nodeId).replace(NON_IDENTIFIER_CHARACTER, '_')}`;
}

/** The full name of one default flow variable of a node, `<prefix>.<variable>`. */
export function defaultVariable(nodeModel, nodeId, variable) {
  return `${defaultVariablePrefix(nodeModel, nodeId)}.${variable}`;
}

/** The CEL reference to a flow variable, `vars["<name>"]`. */
export const varRef = (name) => `vars["${name}"]`;

/** The CEL test that a flow variable is set, `"<name>" in vars`. */
export const varSet = (name) => `"${name}" in vars`;

const SEED_ROWS = '[{"value": 1}, {"value": 20}, {"value": 30}]';

/** Builders and variable names for one scenario: `base` is {runId, tenant, label, templates, registeredLoop}. */
function scenarioKit({ templates, registeredLoop }) {
  const scoreModel = templates.AnomalyDetectorZScoreNodeModel.nodeModel;
  const tableModel = templates.CreateTableNodeModel.nodeModel;
  const scoreVar = (nodeId, variable) => defaultVariable(scoreModel, nodeId, variable);
  const ranBefore = (nodeId) => varSet(scoreVar(nodeId, 'startTimestamp'));
  // `nodeId` ran in this iteration of the loop whose entry member is `score`.
  const ranInThisIteration = (nodeId) =>
    `(${ranBefore(nodeId)} && ${varRef(scoreVar(nodeId, 'startTimestamp'))} >= ${varRef(scoreVar('score', 'endTimestamp'))})`;
  const seed = (properties = {}) => workflowNode({ id: 'seed', template: templates.CreateTableNodeModel, properties: { jsonArrayString: SEED_ROWS, ...properties } });
  const score = (id, parent, x = 40, y = 60) => workflowNode({ id, template: templates.AnomalyDetectorZScoreNodeModel, parent, x, y });
  const table = (id, parent, jsonArrayString, x = 40, y = 60) => workflowNode({ id, template: templates.CreateTableNodeModel, parent, x, y, properties: { jsonArrayString } });
  const loop = (id, properties, layout = {}) => loopNode({ id, registered: registeredLoop, properties, ...layout });
  /** A nested loop that runs `memberId` once: in the first iteration of its enclosing loop where `extraCondition` holds. */
  const onceGate = (gateId, memberId, parent, y, extraCondition) => [
    loop(gateId, {
      condition: extraCondition ? `${extraCondition} && !(${ranBefore(memberId)})` : `!(${ranBefore(memberId)})`,
      check: 'before',
      maxIterations: 5,
      onLimit: 'fail',
    }, { parent, x: 300, y, width: 400, height: 200 }),
    score(memberId, gateId),
  ];
  return { scoreModel, tableModel, scoreVar, ranBefore, ranInThisIteration, seed, score, table, loop, onceGate };
}

/**
 * Three iterations of loop `L`, then the condition is false:
 * `seed` -> [L: `score` -> {once gate I1: `m1`} and {once gate I2 (after m1): `m2`}] -> `after` -> [V: `obs`].
 * Iteration 1 runs `m1`, iteration 2 runs `m2`, iteration 3 runs neither, so "m1 or m2 ran in this iteration" is true,
 * true, false. `after` inherits through the entry member `score`, so it gets the set carried into iteration 3 (m1 from
 * iteration 1, m2 from iteration 2) with `score`'s iteration-3 values. The observer loop `V` reads what `after`
 * inherited: its condition needs m1, m2 and score in that start order, so it ends SUCCESS after one iteration only
 * when `after` got the carried variables, and fails with a missing variable otherwise.
 */
export function threeIterationLoop(base) {
  const k = scenarioKit(base);
  const start = (nodeId) => varRef(k.scoreVar(nodeId, 'startTimestamp'));
  return workflowOf({
    ...base,
    nodes: [
      k.seed(),
      k.loop('L', { condition: `${k.ranInThisIteration('m1')} || ${k.ranInThisIteration('m2')}`, maxIterations: 10, onLimit: 'fail' }, { x: 300, width: 1200, height: 600 }),
      k.score('score', 'L'),
      ...k.onceGate('I1', 'm1', 'L', 40),
      ...k.onceGate('I2', 'm2', 'L', 300, k.ranBefore('m1')),
      k.score('after', undefined, 1600),
      k.loop('V', { condition: `!(${start('m1')} < ${start('m2')} && ${start('m2')} < ${start('score')})`, maxIterations: 1, onLimit: 'fail' }, { x: 1900 }),
      k.score('obs', 'V'),
    ],
    edges: [edge('seed', 'data', 'score', 'data'), edge('score', 'data', 'm1', 'data'), edge('score', 'data', 'm2', 'data'),
      edge('score', 'data', 'after', 'data'), edge('after', 'data', 'obs', 'data')],
  });
}

/**
 * `check: before`, true for two iterations: `seed` -> [L: `score` -> {once gate I1: `m1`}]. Before iteration 1 `m1`
 * has not run (true); after iteration 1 it ran in that iteration (true); after iteration 2 it ran only earlier (false).
 */
export function beforeTwoIterationsLoop(base) {
  const k = scenarioKit(base);
  return workflowOf({
    ...base,
    nodes: [
      k.seed(),
      k.loop('L', { condition: `!(${k.ranBefore('m1')}) || ${k.ranInThisIteration('m1')}`, check: 'before', maxIterations: 10, onLimit: 'fail' }, { x: 300, width: 900, height: 400 }),
      k.score('score', 'L'),
      ...k.onceGate('I1', 'm1', 'L', 40),
    ],
    edges: [edge('seed', 'data', 'score', 'data'), edge('score', 'data', 'm1', 'data')],
  });
}

/**
 * A member that fails only in iteration 2: `seed` -> [L (always true, max 5): `score` -> {once gate I1: `m1`},
 * {I2, runs once m1 ran: `x`, `bad` (an invalid JSON table)}] -> `after`. Iteration 1 runs `m1`; iteration 2 enters
 * I2, where `bad` fails, so I2 fails and with it L, in iteration 2.
 */
export function memberFailsInIteration2Loop(base) {
  const k = scenarioKit(base);
  return workflowOf({
    ...base,
    nodes: [
      k.seed(),
      k.loop('L', { condition: `${varRef(k.scoreVar('score', 'executionStatus'))} == "SUCCESS"`, maxIterations: 5, onLimit: 'fail' }, { x: 300, width: 1200, height: 600 }),
      k.score('score', 'L'),
      ...k.onceGate('I1', 'm1', 'L', 40),
      k.loop('I2', { condition: k.ranBefore('m1'), check: 'before', maxIterations: 5, onLimit: 'fail' }, { parent: 'L', x: 300, y: 300, width: 600, height: 200 }),
      k.score('x', 'I2'),
      k.table('bad', 'I2', 'not a json array', 300),
      k.score('after', undefined, 1600),
    ],
    edges: [edge('seed', 'data', 'score', 'data'), edge('score', 'data', 'm1', 'data'), edge('score', 'data', 'x', 'data'), edge('score', 'data', 'after', 'data')],
  });
}

/**
 * A condition that is true in iteration 1 and returns a string in iteration 2: "m1 ran in this iteration ? true :
 * score.executionStatus" over `seed` -> [L: `score` -> {once gate I1: `m1`}] -> `after`.
 */
export function nonBooleanInIteration2Loop(base, onNonBooleanResult) {
  const k = scenarioKit(base);
  return workflowOf({
    ...base,
    nodes: [
      k.seed(),
      k.loop('L', {
        condition: `${k.ranInThisIteration('m1')} ? true : ${varRef(k.scoreVar('score', 'executionStatus'))}`,
        maxIterations: 5,
        onLimit: 'fail',
        onNonBooleanResult,
      }, { x: 300, width: 1200, height: 600 }),
      k.score('score', 'L'),
      ...k.onceGate('I1', 'm1', 'L', 40),
      k.score('after', undefined, 1600),
    ],
    edges: [edge('seed', 'data', 'score', 'data'), edge('score', 'data', 'm1', 'data'), edge('score', 'data', 'after', 'data')],
  });
}

/**
 * The carried value of a name overrides the outside value of the same name. The outside table `src-x` and the member
 * table `src_x` export the same variable names (`createTableNode_src_x.*`): `src-x` -> `pre` -> [L: `score` ->
 * {J (check before, max 1): `obs`}, `src_x`]. J runs only when the `src_x` start time it reads through `score` is after
 * `pre` ended, which holds only for the member's value. In iteration 1 `score` inherits the outside value, so J runs
 * zero iterations; in iteration 2 the entry member `score` gets the carried member value, so J runs `obs` and stops
 * at its limit; L, "until obs ran", then ends after iteration 2. Had the outside value won, J would never run and L
 * would fail at its limit of 3.
 */
export function carriedOverridesOutsideLoop(base) {
  const k = scenarioKit(base);
  const sharedStart = varRef(defaultVariable(k.tableModel, 'src_x', 'startTimestamp'));
  return workflowOf({
    ...base,
    nodes: [
      workflowNode({ id: 'src-x', template: base.templates.CreateTableNodeModel, properties: { jsonArrayString: SEED_ROWS } }),
      k.score('pre', undefined, 250, 0),
      k.loop('L', { condition: `!(${k.ranBefore('obs')})`, maxIterations: 3, onLimit: 'fail' }, { x: 500, width: 1200, height: 500 }),
      k.score('score', 'L'),
      k.table('src_x', 'L', '[{"value": 5}]', 40, 250),
      k.loop('J', { condition: `${sharedStart} > ${varRef(k.scoreVar('pre', 'endTimestamp'))}`, check: 'before', maxIterations: 1, onLimit: 'stop-with-warning' }, { parent: 'L', x: 400, y: 40, width: 400, height: 200 }),
      k.score('obs', 'J'),
    ],
    edges: [edge('src-x', 'data', 'pre', 'data'), edge('pre', 'data', 'score', 'data'), edge('score', 'data', 'obs', 'data')],
  });
}

/**
 * Two members export the same variable names (`c-1` and `c_1` both have the prefix `..._c_1`): `seed` -> [L: `c-1` ->
 * `mid` -> `c_1`]. The condition "c_1 started before mid ended" is false for the later member's value and true for
 * the earlier one's; the loop ends after iteration 1 only when the later member in run order wins.
 */
export function laterMemberWinsLoop(base) {
  const k = scenarioKit(base);
  return workflowOf({
    ...base,
    nodes: [
      k.seed(),
      k.loop('L', { condition: `${varRef(k.scoreVar('c_1', 'startTimestamp'))} < ${varRef(k.scoreVar('mid', 'endTimestamp'))}`, maxIterations: 2, onLimit: 'fail' }, { x: 300, width: 1100 }),
      k.score('c-1', 'L'),
      k.score('mid', 'L', 370),
      k.score('c_1', 'L', 700),
    ],
    edges: [edge('seed', 'data', 'c-1', 'data'), edge('c-1', 'data', 'mid', 'data'), edge('mid', 'data', 'c_1', 'data')],
  });
}

/**
 * Loops with no node to run, at `maxIterations` 10,000, next to `seed` -> `after`: the empty loop `E`, and `EO`, which
 * holds only the empty loop `EI`.
 */
export function emptyLoops(base) {
  const k = scenarioKit(base);
  const settings = { condition: 'vars["hasMore"] == true', maxIterations: 10000, onLimit: 'fail' };
  return workflowOf({
    ...base,
    nodes: [
      k.seed(),
      k.score('after', undefined, 300),
      k.loop('E', settings, { x: 700 }),
      k.loop('EO', settings, { x: 700, y: 400, width: 600, height: 300 }),
      k.loop('EI', settings, { parent: 'EO', x: 40, y: 40, width: 300, height: 150 }),
    ],
    edges: [edge('seed', 'data', 'after', 'data')],
  });
}

/** A loop (`maxIterations` 10,000) around only a node whose input is not connected: [L: `score`] -> `after`. */
export function unconnectedMemberLoop(base) {
  const k = scenarioKit(base);
  return workflowOf({
    ...base,
    nodes: [
      k.loop('L', { condition: 'vars["hasMore"] == true', maxIterations: 10000, onLimit: 'fail' }),
      k.score('score', 'L'),
      k.score('after', undefined, 1300),
    ],
    edges: [edge('score', 'data', 'after', 'data')],
  });
}

/** A condition the validator accepts that takes far longer than the evaluation time budget. */
export const SLOW_CONDITION = 'lists.range(20).all(i, sets.contains(lists.range(10000), lists.range(10000).reverse()))';

/** `seed` -> [L (the slow condition): `score`] -> `after`. */
export function slowConditionLoop(base) {
  const k = scenarioKit(base);
  return workflowOf({
    ...base,
    nodes: [k.seed(), k.loop('L', { condition: SLOW_CONDITION, maxIterations: 3, onLimit: 'fail' }), k.score('score', 'L'), k.score('after', undefined, 1300)],
    edges: [edge('seed', 'data', 'score', 'data'), edge('score', 'data', 'after', 'data')],
  });
}

/**
 * A condition whose time goes into ONE cel-java function call, which no between-values budget can cut short:
 * `sets.intersects(a, b)` over two disjoint lists of 10,000-element lists. `a` holds 2^`doublingsA` copies of
 * `[0..9999]`, `b` holds 2^`doublingsB` copies of `[0..9998, 0]`. Every pair differs only in its last element, so the
 * call compares all n x m pairs element by element and finds no match. Every list stays within the evaluator's
 * 10,000-element cap and the text within 2,048 characters. It reads no flow variable: no feature-base node can set the
 * two large list variables of the real-world shape (`sets.equivalent(vars["a"], vars["b"])`), so the lists are built
 * from literals with `cel.bind` doublings. At 8 and 7 doublings one call takes about 1.2 s on a fast idle machine.
 */
export function oneLongCallCondition(doublingsA = 8, doublingsB = 7) {
  let text = 'cel.bind(r, lists.range(10000), cel.bind(q, lists.range(9999) + [0], cel.bind(a0, [r]';
  let closing = ')))';
  for (let i = 1; i <= doublingsA; i += 1) {
    text += `, cel.bind(a${i}, a${i - 1} + a${i - 1}`;
    closing += ')';
  }
  text += ', cel.bind(b0, [q]';
  closing += ')';
  for (let i = 1; i <= doublingsB; i += 1) {
    text += `, cel.bind(b${i}, b${i - 1} + b${i - 1}`;
    closing += ')';
  }
  return `${text}, sets.intersects(a${doublingsA}, b${doublingsB})${closing}`;
}

/** The one-call condition the suite runs (see `oneLongCallCondition`). */
export const ONE_LONG_CALL_CONDITION = oneLongCallCondition();

/**
 * A one-call condition that keeps an evaluation thread for several seconds after its check was given up (about 9 s on
 * a fast idle machine): the orchestrator interrupts the thread, but cel-java sees the interrupt only after the call.
 */
export const THREAD_HOLDING_CONDITION = oneLongCallCondition(9, 9);

/** The orchestrator's number of condition evaluation threads, shared by every run and tenant. */
export const EVALUATION_THREADS = 4;

/**
 * `seed` -> [L (one function call far longer than the time budget): `score`] -> `after`. `condition` defaults to
 * `ONE_LONG_CALL_CONDITION`; pass `THREAD_HOLDING_CONDITION` to keep a thread busy for longer.
 */
export function oneLongCallLoop(base, condition = ONE_LONG_CALL_CONDITION) {
  const k = scenarioKit(base);
  return workflowOf({
    ...base,
    nodes: [k.seed(), k.loop('L', { condition, maxIterations: 3, onLimit: 'fail' }), k.score('score', 'L'), k.score('after', undefined, 1300)],
    edges: [edge('seed', 'data', 'score', 'data'), edge('score', 'data', 'after', 'data')],
  });
}

/**
 * An ordinary loop with a cheap condition that always holds: `seed` -> [L (`maxIterations`, default 3,
 * stop-with-warning): `score`] -> `after`. On any orchestrator it ends WARNING "Stopped at the limit of N iterations"
 * and the run FINISHED; at 200 it keeps running long enough (about 30 s) to be stopped while healthy.
 */
export function cheapLimitLoop(base, maxIterations = 3) {
  const k = scenarioKit(base);
  return workflowOf({
    ...base,
    nodes: [
      k.seed(),
      k.loop('L', { condition: `${varRef(k.scoreVar('score', 'executionStatus'))} == "SUCCESS"`, maxIterations, onLimit: 'stop-with-warning' }),
      k.score('score', 'L'),
      k.score('after', undefined, 1300),
    ],
    edges: [edge('seed', 'data', 'score', 'data'), edge('score', 'data', 'after', 'data')],
  });
}

/**
 * A run that starves itself (a documented platform limit): `seed` feeds `EVALUATION_THREADS + 1` parallel loops
 * `L1`..`L5`, each `check: before` with `ONE_LONG_CALL_CONDITION` around one `score<i>`. All the checks fall into one
 * workflow task, the first 4 hold every evaluation thread with their abandoned calls, the 5th finds none and the task
 * is retried, again and again. The run stays `RUNNING` until it is terminated; only the terminate checks start it.
 */
export function selfStarvingLoops(base, loops = EVALUATION_THREADS + 1) {
  const k = scenarioKit(base);
  const nodes = [k.seed()];
  const edges = [];
  for (let i = 1; i <= loops; i += 1) {
    nodes.push(k.loop(`L${i}`, { condition: ONE_LONG_CALL_CONDITION, maxIterations: 3, onLimit: 'fail', check: 'before' }, { x: 300, y: (i - 1) * 300 }));
    nodes.push(k.score(`score${i}`, `L${i}`));
    edges.push(edge('seed', 'data', `score${i}`, 'data'));
  }
  return workflowOf({ ...base, nodes, edges });
}

/** A workflow without loops whose first node fails (an invalid JSON table): `seed` -> `after`. */
export function failingNodeWithoutLoop(base) {
  const k = scenarioKit(base);
  return workflowOf({
    ...base,
    nodes: [k.seed({ jsonArrayString: 'not a json array' }), k.score('after', undefined, 300)],
    edges: [edge('seed', 'data', 'after', 'data')],
  });
}

/** Every `vars["<name>"]` and `"<name>" in vars` name a condition reads. */
export function conditionVariableNames(condition) {
  const names = new Set();
  for (const match of String(condition).matchAll(/vars\["([^"]+)"\]|"([^"]+)" in vars/g)) {
    names.add(match[1] || match[2]);
  }
  return [...names];
}
