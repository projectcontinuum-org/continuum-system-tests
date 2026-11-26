// Pure helpers for the loop suite: building loop workflows, reading loop results from a run record, and reading MCP
// (streamable HTTP) answers. No k6 imports, so they can be unit-tested with `node --test` (see test/loopmodel.test.js).

import { randomHex } from './util.js';

/** Registered node id of the built-in Loop (published by the orchestration service at start-up). */
export const LOOP_NODE_MODEL = 'org.projectcontinuum.core.builtin.Loop';

/** Task-queue marker of a built-in node that runs no activity. */
export const BUILTIN_TASK_QUEUE = '$builtin';

/** Palette category of the Loop. */
export const LOOP_CATEGORY = 'Flow Control';

/** The Loop's property defaults, as registered. */
export const LOOP_DEFAULTS = Object.freeze({
  condition: 'vars["hasMore"] == true',
  maxIterations: 50,
  onLimit: 'fail',
  onNonBooleanResult: 'fail',
  check: 'after',
});

/**
 * The `data` block of every node in a fixture workflow, by the simple class name of its node model
 * (`CreateTableNodeModel`, ...). Used as templates, so a test workflow carries the same node metadata the fixture does.
 */
export function nodeTemplates(fixture) {
  const templates = {};
  for (const node of fixture.nodes || []) {
    const model = String((node.data && node.data.nodeModel) || '');
    templates[model.substring(model.lastIndexOf('.') + 1)] = node.data;
  }
  return templates;
}

const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * A registered (BaseNode) workflow node built from a template `data` block. `properties` are merged over the
 * template's. With `parent` the node is a member of that loop, and its position is relative to the loop box.
 */
export function workflowNode({ id, template, properties = {}, parent, x = 0, y = 60 }) {
  const data = clone(template);
  data.properties = { ...(data.properties || {}), ...properties };
  const node = { id, type: 'BaseNode', position: { x, y }, data, width: 224, height: 100, selected: false };
  if (parent) {
    node.parentNode = parent;
  }
  return node;
}

/**
 * A loop box. `data` is the Loop's registered node data (from the node registry) when available, so the box carries
 * the registered schemas like a node dropped from the palette; `properties` are merged over the Loop defaults.
 */
export function loopNode({ id, properties = {}, registered, parent, x = 300, y = 0, width = 900, height = 240 }) {
  const data = registered
    ? clone(registered)
    : { id: LOOP_NODE_MODEL, nodeModel: LOOP_NODE_MODEL, title: 'Loop', description: '', inputs: null, outputs: null };
  data.properties = { ...LOOP_DEFAULTS, ...properties };
  data.collapsed = false;
  const node = { id, type: 'Loop', position: { x, y }, data, width, height, selected: false };
  if (parent) {
    node.parentNode = parent;
  }
  return node;
}

/** One edge from `source.sourceHandle` to `target.targetHandle`. */
export function edge(source, sourceHandle, target, targetHandle) {
  return {
    type: 'BaseEdge',
    id: `e-${source}-${sourceHandle}-${target}-${targetHandle}`,
    source,
    sourceHandle,
    target,
    targetHandle,
  };
}

/**
 * A complete workflow model with a fresh id and a `/systest/<runId>/<tenant>/<label>.cwf` name (workflow runs cannot be
 * deleted through the API, so the prefix is how test data is found afterwards).
 */
export function workflowOf({ runId, tenant, label, nodes, edges = [] }, rnd = Math.random) {
  return {
    id: randomHex(64, rnd),
    name: `/systest/${runId}/${tenant}/${label}.cwf`,
    active: false,
    nodes,
    edges,
  };
}

/**
 * The paging-shaped loop workflow used by the run checks:
 * `seed` (outside) -> [loop `L`: `score` -> `split`] -> `after` (outside, fed by `split.high`).
 * `members` overrides the members (default: the two above); `loop` is merged into the loop's properties.
 */
export function chainLoopWorkflow({ runId, tenant, label, templates, registeredLoop, loop = {}, seedRows }) {
  const rows = seedRows || '[{"value": 1}, {"value": 20}, {"value": 30}]';
  const nodes = [
    workflowNode({ id: 'seed', template: templates.CreateTableNodeModel, properties: { jsonArrayString: rows }, x: 0 }),
    loopNode({ id: 'L', properties: loop, registered: registeredLoop }),
    workflowNode({ id: 'score', template: templates.AnomalyDetectorZScoreNodeModel, parent: 'L', x: 40 }),
    workflowNode({ id: 'split', template: templates.ConditionalSplitterNodeModel, parent: 'L', x: 370 }),
    workflowNode({ id: 'after', template: templates.AnomalyDetectorZScoreNodeModel, x: 1300 }),
  ];
  const edges = [edge('seed', 'data', 'score', 'data'), edge('score', 'data', 'split', 'data'), edge('split', 'high', 'after', 'data')];
  return workflowOf({ runId, tenant, label, nodes, edges });
}

/** A node of a run record's snapshot (`data.workflowSnapshot.nodes`), or undefined. */
export function snapshotNode(record, nodeId) {
  const nodes = (record && record.data && record.data.workflowSnapshot && record.data.workflowSnapshot.nodes) || [];
  return nodes.find((n) => n.id === nodeId);
}

/** `{status, message}` of a node in a run record: its `data.status` and `data.nodeProgress.message`. */
export function nodeState(record, nodeId) {
  const node = snapshotNode(record, nodeId);
  const data = (node && node.data) || {};
  return { status: data.status, message: data.nodeProgress ? data.nodeProgress.message : undefined };
}

/** A system key or port of a node's outputs in a run record (`data.nodeToOutputMap[node][key]`), or undefined. */
export function nodeOutput(record, nodeId, key) {
  const map = (record && record.data && record.data.nodeToOutputMap) || {};
  return (map[nodeId] || {})[key];
}

/** The `$error` text of a node in a run record ('' when it has none). */
export function errorText(record, nodeId) {
  const out = nodeOutput(record, nodeId, '$error');
  return out && typeof out.data === 'string' ? out.data : '';
}

/** The issues of a validation answer (`errors` or `warnings`) that point at `node` and, if given, `property`. */
export function issuesAt(issues, node, property) {
  return (issues || []).filter((i) => i.node === node && (property === undefined || i.property === property));
}

/** True when every value is at least the one before it (an empty or one-value list is non-decreasing). */
export function isNonDecreasing(values) {
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] < values[i - 1]) {
      return false;
    }
  }
  return true;
}

/** A string of exactly `length` characters that is a syntactically complete CEL comparison padded with spaces. */
export function conditionOfLength(length) {
  const core = 'vars["page"] < 10';
  return core + ' '.repeat(Math.max(0, length - core.length));
}

/**
 * A comparison whose brackets nest exactly `depth` levels deep. The index brackets of `vars["a"]` count as one level
 * (the validator counts every `(`, `[` and `{`), so it is wrapped in `depth - 1` parentheses: depth 3 is
 * `((vars["a"] > 0))`.
 */
export function nestedCondition(depth) {
  const parentheses = Math.max(0, depth - 1);
  return `${'('.repeat(parentheses)}vars["a"] > 0${')'.repeat(parentheses)}`;
}

/**
 * The JSON-RPC message of an MCP streamable-HTTP answer. The server answers either plain JSON or a server-sent-event
 * stream (`event:message` / `data:{...}` lines); returns the first `data:` payload that parses, or the whole body.
 */
export function mcpMessage(body) {
  const text = String(body || '');
  for (const line of text.split(/\r?\n/)) {
    if (line.indexOf('data:') === 0) {
      try {
        return JSON.parse(line.substring(5).trim());
      } catch (e) {
        // not a JSON payload; keep looking
      }
    }
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    return undefined;
  }
}

/** The JSON result an MCP tool returned as its first text content block (tools/call), or undefined. */
export function mcpToolResult(message) {
  const content = message && message.result && message.result.content;
  const first = Array.isArray(content) ? content.find((c) => c.type === 'text') : undefined;
  if (!first) {
    return undefined;
  }
  try {
    return JSON.parse(first.text);
  } catch (e) {
    return undefined;
  }
}
