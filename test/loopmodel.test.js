import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOOP_DEFAULTS,
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
  workflowNode,
  workflowOf,
} from '../lib/loopmodel.js';

const fixture = {
  nodes: [
    { id: '1', data: { nodeModel: 'org.x.CreateTableNodeModel', properties: { jsonArrayString: '[]' } } },
    { id: '2', data: { nodeModel: 'org.x.AnomalyDetectorZScoreNodeModel', properties: { valueCol: 'value' } } },
    { id: '3', data: { nodeModel: 'org.x.ConditionalSplitterNodeModel', properties: { column: 'value' } } },
  ],
};

test('nodeTemplates indexes the fixture node data by simple class name', () => {
  const t = nodeTemplates(fixture);
  assert.deepEqual(Object.keys(t).sort(), ['AnomalyDetectorZScoreNodeModel', 'ConditionalSplitterNodeModel', 'CreateTableNodeModel']);
  assert.equal(t.CreateTableNodeModel.nodeModel, 'org.x.CreateTableNodeModel');
});

test('workflowNode merges properties over a copy of the template and sets parentNode only for members', () => {
  const template = { nodeModel: 'org.x.A', properties: { a: 1, b: 2 } };
  const top = workflowNode({ id: 'n', template, properties: { b: 3 } });
  const member = workflowNode({ id: 'm', template, parent: 'L', x: 40 });
  assert.deepEqual(top.data.properties, { a: 1, b: 3 });
  assert.deepEqual(template.properties, { a: 1, b: 2 }, 'template untouched');
  assert.equal(top.parentNode, undefined);
  assert.equal(member.parentNode, 'L');
  assert.deepEqual(member.position, { x: 40, y: 60 });
  assert.equal(top.type, 'BaseNode');
});

test('loopNode is type Loop with the Loop model and the defaults merged under the given properties', () => {
  const l = loopNode({ id: 'L', properties: { maxIterations: 3 } });
  assert.equal(l.type, 'Loop');
  assert.equal(l.data.nodeModel, LOOP_NODE_MODEL);
  assert.deepEqual(l.data.properties, { ...LOOP_DEFAULTS, maxIterations: 3 });
  assert.equal(l.data.collapsed, false);
  assert.equal(l.parentNode, undefined);
  assert.equal(loopNode({ id: 'I', parent: 'L' }).parentNode, 'L');
});

test('loopNode uses a copy of the registered node data when given', () => {
  const registered = { id: LOOP_NODE_MODEL, nodeModel: LOOP_NODE_MODEL, propertiesSchema: { type: 'object' }, properties: {} };
  const l = loopNode({ id: 'L', registered });
  assert.deepEqual(l.data.propertiesSchema, { type: 'object' });
  assert.deepEqual(registered.properties, {}, 'registered data untouched');
});

test('edge names its endpoints and has a unique id per endpoint pair', () => {
  const e = edge('a', 'out', 'b', 'in');
  assert.deepEqual(
    { source: e.source, sourceHandle: e.sourceHandle, target: e.target, targetHandle: e.targetHandle },
    { source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' },
  );
  assert.notEqual(e.id, edge('a', 'out', 'c', 'in').id);
});

test('workflowOf gives a 64-hex id and a systest-prefixed name', () => {
  const wf = workflowOf({ runId: 'r1', tenant: 'systest-r1-a', label: 'x', nodes: [] });
  assert.match(wf.id, /^[0-9a-f]{64}$/);
  assert.equal(wf.name, '/systest/r1/systest-r1-a/x.cwf');
  assert.deepEqual(wf.edges, []);
});

test('chainLoopWorkflow lists the loop before its members and wires seed -> score -> split -> after', () => {
  const wf = chainLoopWorkflow({ runId: 'r', tenant: 't', label: 'c', templates: nodeTemplates(fixture), loop: { check: 'before' } });
  const ids = wf.nodes.map((n) => n.id);
  assert.deepEqual(ids, ['seed', 'L', 'score', 'split', 'after']);
  assert.ok(ids.indexOf('L') < ids.indexOf('score'));
  assert.deepEqual(wf.nodes.filter((n) => n.parentNode === 'L').map((n) => n.id), ['score', 'split']);
  assert.equal(wf.nodes[1].data.properties.check, 'before');
  assert.deepEqual(wf.edges.map((e) => `${e.source}->${e.target}`), ['seed->score', 'score->split', 'split->after']);
  assert.ok(wf.edges.every((e) => e.source !== 'L' && e.target !== 'L'), 'no edge names the loop');
});

test('nodeState, nodeOutput and errorText read the run record and tolerate missing parts', () => {
  const record = {
    data: {
      workflowSnapshot: { nodes: [{ id: 'L', data: { status: 'FAILED', nodeProgress: { message: 'm' } } }, { id: 'x', data: {} }] },
      nodeToOutputMap: { L: { $error: { data: 'boom' }, $variable: { data: { a: 1 } } } },
    },
  };
  assert.deepEqual(nodeState(record, 'L'), { status: 'FAILED', message: 'm' });
  assert.deepEqual(nodeState(record, 'x'), { status: undefined, message: undefined });
  assert.deepEqual(nodeState(record, 'nope'), { status: undefined, message: undefined });
  assert.deepEqual(nodeOutput(record, 'L', '$variable').data, { a: 1 });
  assert.equal(nodeOutput(record, 'nope', '$variable'), undefined);
  assert.equal(errorText(record, 'L'), 'boom');
  assert.equal(errorText(record, 'x'), '');
  assert.equal(errorText(undefined, 'x'), '');
});

test('issuesAt filters by node and optional property', () => {
  const issues = [
    { node: 'L', property: 'condition', message: 'a' },
    { node: 'L', property: 'maxIterations', message: 'b' },
    { node: 'x', property: 'condition', message: 'c' },
    { edge: 'e', message: 'd' },
  ];
  assert.deepEqual(issuesAt(issues, 'L', 'condition').map((i) => i.message), ['a']);
  assert.deepEqual(issuesAt(issues, 'L').map((i) => i.message), ['a', 'b']);
  assert.deepEqual(issuesAt(undefined, 'L'), []);
});

test('isNonDecreasing', () => {
  assert.equal(isNonDecreasing([]), true);
  assert.equal(isNonDecreasing([5]), true);
  assert.equal(isNonDecreasing([0, 10, 10, 100]), true);
  assert.equal(isNonDecreasing([0, 50, 40, 100]), false);
});

test('conditionOfLength and nestedCondition build the boundary inputs', () => {
  assert.equal(conditionOfLength(2048).length, 2048);
  assert.equal(conditionOfLength(2049).length, 2049);
  assert.ok(conditionOfLength(2049).startsWith('vars["page"] < 10'));
  assert.equal(nestedCondition(3), '((vars["a"] > 0))');
  assert.equal(nestedCondition(1), 'vars["a"] > 0');
  assert.equal(nestedCondition(33).split('(').length - 1, 32, '32 parentheses plus the index bracket');
});

test('mcpMessage reads plain JSON and server-sent-event frames', () => {
  assert.deepEqual(mcpMessage('{"jsonrpc":"2.0","id":1,"result":{}}'), { jsonrpc: '2.0', id: 1, result: {} });
  const sse = 'id:abc\nevent:message\ndata:{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n';
  assert.deepEqual(mcpMessage(sse), { jsonrpc: '2.0', id: 2, result: { tools: [] } });
  assert.equal(mcpMessage('garbage'), undefined);
  assert.equal(mcpMessage(undefined), undefined);
});

test('mcpToolResult parses the first text content block', () => {
  const message = { result: { content: [{ type: 'text', text: '{"valid":true}' }], isError: false } };
  assert.deepEqual(mcpToolResult(message), { valid: true });
  assert.equal(mcpToolResult({ result: { content: [{ type: 'text', text: 'not json' }] } }), undefined);
  assert.equal(mcpToolResult({ error: { code: -1 } }), undefined);
});
