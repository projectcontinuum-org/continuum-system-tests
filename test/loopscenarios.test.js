import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVALUATION_THREADS,
  ONE_LONG_CALL_CONDITION,
  SLOW_CONDITION,
  THREAD_HOLDING_CONDITION,
  beforeTwoIterationsLoop,
  carriedOverridesOutsideLoop,
  cheapLimitLoop,
  conditionVariableNames,
  defaultVariable,
  defaultVariablePrefix,
  emptyLoops,
  failingNodeWithoutLoop,
  laterMemberWinsLoop,
  memberFailsInIteration2Loop,
  nonBooleanInIteration2Loop,
  oneLongCallCondition,
  oneLongCallLoop,
  selfStarvingLoops,
  slowConditionLoop,
  threeIterationLoop,
  unconnectedMemberLoop,
  varRef,
  varSet,
} from '../lib/loopscenarios.js';

const templates = {
  CreateTableNodeModel: { nodeModel: 'org.x.CreateTableNodeModel', properties: { jsonArrayString: '[]' } },
  AnomalyDetectorZScoreNodeModel: { nodeModel: 'org.x.AnomalyDetectorZScoreNodeModel', properties: { valueCol: 'value' } },
  ConditionalSplitterNodeModel: { nodeModel: 'org.x.ConditionalSplitterNodeModel', properties: { column: 'value' } },
};
const base = { runId: 'r', tenant: 't', label: 'l', templates, registeredLoop: undefined };
const byId = (wf) => Object.fromEntries(wf.nodes.map((n) => [n.id, n]));

test('defaultVariablePrefix follows the worker rule: camelCase type without Model, then the sanitized node id', () => {
  assert.equal(defaultVariablePrefix('org.x.AnomalyDetectorZScoreNodeModel', 'score'), 'anomalyDetectorZScoreNode_score');
  assert.equal(defaultVariablePrefix('org.x.RestNodeModel', '3'), 'restNode_3');
  assert.equal(defaultVariablePrefix('org.x.KNIMEWorkflowExecutorNodeModel', 'k'), 'knimeWorkflowExecutorNode_k');
  assert.equal(defaultVariablePrefix('org.x.RDKit2SVGNodeModel', 'a'), 'rdKit2SVGNode_a');
  assert.equal(defaultVariablePrefix('org.x.Outer$InnerNodeModel', 'a'), 'innerNode_a');
  assert.equal(defaultVariablePrefix('org.x.Model', 'a'), 'model_a');
  assert.equal(defaultVariablePrefix('org.x.CreateTableNodeModel', 'src-x'), 'createTableNode_src_x');
  assert.equal(defaultVariable('org.x.CreateTableNodeModel', 'src_x', 'startTimestamp'), 'createTableNode_src_x.startTimestamp');
});

test('varRef and varSet build the CEL forms, and conditionVariableNames reads both back', () => {
  assert.equal(varRef('a.b'), 'vars["a.b"]');
  assert.equal(varSet('a.b'), '"a.b" in vars');
  assert.deepEqual(conditionVariableNames(`${varSet('x')} && ${varRef('y')} > ${varRef('x')}`).sort(), ['x', 'y']);
  assert.deepEqual(conditionVariableNames(SLOW_CONDITION), []);
});

test('the three-iteration loop: two once gates inside L, an observer loop after it that reads m1, m2 and score', () => {
  const wf = threeIterationLoop(base);
  const n = byId(wf);
  assert.equal(n.L.type, 'Loop');
  assert.deepEqual(['score', 'I1', 'I2'].map((id) => n[id].parentNode), ['L', 'L', 'L']);
  assert.equal(n.m1.parentNode, 'I1');
  assert.equal(n.m2.parentNode, 'I2');
  assert.equal(n.obs.parentNode, 'V');
  assert.equal(n.after.parentNode, undefined);
  assert.equal(n.I1.data.properties.check, 'before');
  assert.ok(n.I2.data.properties.condition.indexOf('"anomalyDetectorZScoreNode_m1.startTimestamp" in vars') === 0);
  assert.deepEqual(conditionVariableNames(n.L.data.properties.condition).sort(), [
    'anomalyDetectorZScoreNode_m1.startTimestamp', 'anomalyDetectorZScoreNode_m2.startTimestamp', 'anomalyDetectorZScoreNode_score.endTimestamp',
  ]);
  assert.deepEqual(conditionVariableNames(n.V.data.properties.condition).sort(), [
    'anomalyDetectorZScoreNode_m1.startTimestamp', 'anomalyDetectorZScoreNode_m2.startTimestamp', 'anomalyDetectorZScoreNode_score.startTimestamp',
  ]);
  assert.ok(wf.edges.every((e) => !['L', 'I1', 'I2', 'V'].includes(e.source) && !['L', 'I1', 'I2', 'V'].includes(e.target)));
  assert.ok(wf.edges.some((e) => e.source === 'score' && e.target === 'after'));
});

test('the iteration-2 scenarios put the changing part in a gate behind m1', () => {
  const before = byId(beforeTwoIterationsLoop(base));
  assert.equal(before.L.data.properties.check, 'before');
  const fails = byId(memberFailsInIteration2Loop(base));
  assert.equal(fails.bad.parentNode, 'I2');
  assert.equal(fails.bad.data.properties.jsonArrayString, 'not a json array');
  assert.equal(fails.I2.data.properties.condition, '"anomalyDetectorZScoreNode_m1.startTimestamp" in vars');
  const nonBoolean = byId(nonBooleanInIteration2Loop(base, 'treat-as-false'));
  assert.equal(nonBoolean.L.data.properties.onNonBooleanResult, 'treat-as-false');
  assert.ok(nonBoolean.L.data.properties.condition.endsWith('? true : vars["anomalyDetectorZScoreNode_score.executionStatus"]'));
});

test('the override and clash scenarios use two nodes whose ids sanitize to the same prefix', () => {
  const override = byId(carriedOverridesOutsideLoop(base));
  assert.equal(override['src-x'].parentNode, undefined);
  assert.equal(override.src_x.parentNode, 'L');
  assert.equal(defaultVariablePrefix(override['src-x'].data.nodeModel, 'src-x'), defaultVariablePrefix(override.src_x.data.nodeModel, 'src_x'));
  assert.ok(override.J.data.properties.condition.indexOf('vars["createTableNode_src_x.startTimestamp"]') === 0);
  const clash = laterMemberWinsLoop(base);
  assert.deepEqual(clash.edges.map((e) => `${e.source}>${e.target}`), ['seed>c-1', 'c-1>mid', 'mid>c_1']);
});

test('the nothing-to-run scenarios run at maxIterations 10,000 and the failing ones are built as described', () => {
  const empty = byId(emptyLoops(base));
  assert.deepEqual(['E', 'EO', 'EI'].map((id) => empty[id].data.properties.maxIterations), [10000, 10000, 10000]);
  assert.equal(empty.EI.parentNode, 'EO');
  const unconnected = unconnectedMemberLoop(base);
  assert.equal(byId(unconnected).L.data.properties.maxIterations, 10000);
  assert.ok(unconnected.edges.every((e) => e.target !== 'score'));
  assert.equal(byId(slowConditionLoop(base)).L.data.properties.condition, SLOW_CONDITION);
  assert.equal(byId(oneLongCallLoop(base)).L.data.properties.condition, ONE_LONG_CALL_CONDITION);
  const failing = failingNodeWithoutLoop(base);
  assert.ok(failing.nodes.every((n) => n.type !== 'Loop'));
  assert.equal(byId(failing).seed.data.properties.jsonArrayString, 'not a json array');
});

test('the one-long-call condition is one sets.intersects over doubled 10,000-element lists, within the text caps', () => {
  assert.equal(ONE_LONG_CALL_CONDITION, oneLongCallCondition(8, 7));
  assert.ok(ONE_LONG_CALL_CONDITION.length <= 2048);
  assert.deepEqual(conditionVariableNames(ONE_LONG_CALL_CONDITION), []);
  assert.equal((ONE_LONG_CALL_CONDITION.match(/sets\./g) || []).length, 1);
  assert.ok(ONE_LONG_CALL_CONDITION.indexOf('sets.intersects(a8, b7)') > 0);
  assert.ok(ONE_LONG_CALL_CONDITION.indexOf('lists.range(10000)') > 0 && ONE_LONG_CALL_CONDITION.indexOf('lists.range(9999) + [0]') > 0);
  let depth = 0;
  let deepest = 0;
  for (const ch of ONE_LONG_CALL_CONDITION) {
    if ('([{'.includes(ch)) deepest = Math.max(deepest, (depth += 1));
    if (')]}'.includes(ch)) depth -= 1;
  }
  assert.equal(depth, 0);
  assert.ok(deepest <= 32, `nesting ${deepest} is within the validator's 32 levels`);
  assert.equal(oneLongCallCondition(1, 0), 'cel.bind(r, lists.range(10000), cel.bind(q, lists.range(9999) + [0], cel.bind(a0, [r], cel.bind(a1, a0 + a0, cel.bind(b0, [q], sets.intersects(a1, b0))))))');
});

test('the shared-thread scenario: a thread-holding one-call loop and a cheap loop that always reaches its limit of 3', () => {
  assert.equal(THREAD_HOLDING_CONDITION, oneLongCallCondition(9, 9));
  assert.ok(THREAD_HOLDING_CONDITION.length <= 2048);
  assert.deepEqual(conditionVariableNames(THREAD_HOLDING_CONDITION), []);
  assert.equal(EVALUATION_THREADS, 4);
  const holder = byId(oneLongCallLoop(base, THREAD_HOLDING_CONDITION));
  assert.equal(holder.L.data.properties.condition, THREAD_HOLDING_CONDITION);
  assert.equal(holder.L.data.properties.onLimit, 'fail');
  const cheap = cheapLimitLoop(base);
  const n = byId(cheap);
  assert.equal(n.score.parentNode, 'L');
  assert.equal(n.after.parentNode, undefined);
  assert.deepEqual(n.L.data.properties, { ...n.L.data.properties, maxIterations: 3, onLimit: 'stop-with-warning' });
  assert.equal(n.L.data.properties.condition, 'vars["anomalyDetectorZScoreNode_score.executionStatus"] == "SUCCESS"');
  assert.deepEqual(cheap.edges.map((e) => `${e.source}>${e.target}`), ['seed>score', 'score>after']);
  assert.equal(byId(cheapLimitLoop(base, 200)).L.data.properties.maxIterations, 200);
});

test('the self-starving run: one more check: before one-call loop than there are evaluation threads, all fed by seed', () => {
  const wf = selfStarvingLoops(base);
  const n = byId(wf);
  const loops = wf.nodes.filter((node) => node.id.startsWith('L'));
  assert.equal(loops.length, EVALUATION_THREADS + 1);
  for (const [i, loop] of loops.entries()) {
    assert.equal(loop.id, `L${i + 1}`);
    assert.equal(loop.data.properties.condition, ONE_LONG_CALL_CONDITION);
    assert.equal(loop.data.properties.check, 'before');
    assert.equal(n[`score${i + 1}`].parentNode, loop.id);
  }
  assert.deepEqual(wf.edges.map((e) => `${e.source}>${e.target}`), ['seed>score1', 'seed>score2', 'seed>score3', 'seed>score4', 'seed>score5']);
  assert.equal(selfStarvingLoops(base, 2).nodes.length, 5);
});
