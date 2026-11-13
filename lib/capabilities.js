import { cfg } from './config.js';
import { safeJson } from './util.js';

/**
 * Optional feature tests call this in setup(): it reports which of the node classes they need are registered with
 * the api-server, so a missing feature worker means "skipped", not "failed".
 *
 * Uses POST /api/v1/node-explorer/nodes/task-queues, which maps node ids (fully qualified class names) to the task
 * queue of the worker that serves them. A node counts as available when it maps to a non-empty string.
 * NOTE: how that endpoint answers for an unregistered id (missing key vs null vs empty) has been read from source
 * but not observed live. Both "missing" and "empty" are treated as unavailable; confirm on the first live run.
 */
export function availableNodes(t, nodeIds) {
  const res = t.post(cfg.apiServer, '/api/v1/node-explorer/nodes/task-queues', nodeIds, { endpoint: 'task_queues' });
  const map = res.status === 200 ? safeJson(res.body) : undefined;
  const found = {};
  for (const id of nodeIds) {
    found[id] = !!(map && typeof map[id] === 'string' && map[id].length > 0);
  }
  return found;
}

/** Returns the missing node ids (empty array = all present). */
export function missingNodes(t, nodeIds) {
  const found = availableNodes(t, nodeIds);
  return nodeIds.filter((id) => !found[id]);
}

/** Node classes used by the shared fixture workflow. */
export const FIXTURE_NODES = [
  'org.projectcontinuum.feature.base.analytics.node.CreateTableNodeModel',
  'org.projectcontinuum.feature.base.analytics.node.AnomalyDetectorZScoreNodeModel',
  'org.projectcontinuum.feature.base.analytics.node.ConditionalSplitterNodeModel',
];
