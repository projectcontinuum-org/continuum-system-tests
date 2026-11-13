// Environment-driven configuration. Nothing here is hardcoded to a port: the api-server is on 8080 in the
// template compose but 8081 in the IntelliJ run configs, and knime-scheduler is 8084 in its config but 8085 in the
// gateway. Override any of these with `-e NAME=value` (k6) or an exported variable (run.sh / make).

const env = (name, fallback) => (typeof __ENV !== 'undefined' && __ENV[name] !== undefined ? __ENV[name] : fallback);

function parseTokens(raw) {
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`TENANT_TOKENS must be a JSON object such as {"tenant-id":"token"}, got: ${raw}`);
  }
}

export const cfg = {
  // 'header' sets x-continuum-user-id itself (docker-compose, port-forward).
  // 'bearer' also sends `Authorization: Bearer <token>` from TENANT_TOKENS (JSON map) for runs through a real auth proxy.
  authMode: env('AUTH_MODE', 'header'),
  tenantTokens: parseTokens(env('TENANT_TOKENS', '')),

  apiServer: env('API_SERVER_URL', 'http://localhost:8080'),
  credentials: env('CREDENTIALS_URL', 'http://localhost:8083'),
  // The cluster-manager is optional: suites/api/cluster-manager.js skips itself when it is not reachable.
  clusterManager: env('CLUSTER_MANAGER_URL', 'http://localhost:8082'),
  // Set to 'true' only when the cluster-manager can reach a Kubernetes cluster: it enables the lifecycle tier,
  // which creates, suspends, updates and deletes real workbench pods.
  clusterManagerK8s: env('CLUSTER_MANAGER_K8S', 'false') === 'true',
  // True when the cluster-manager restricts images to its own repository (its default). Set 'false' if it runs
  // with WORKBENCH_ALLOWED_IMAGE_PREFIXES empty, where an image outside the repository is accepted.
  clusterManagerImageAllowList: env('CLUSTER_MANAGER_IMAGE_ALLOWLIST', 'true') === 'true',
  // True when the cluster-manager runs with OVERLAY_ENABLED=true, where an unknown (well-formed) variant is rejected.
  clusterManagerOverlays: env('CLUSTER_MANAGER_OVERLAYS', 'false') === 'true',
  // How long to wait for a workbench pod to become ready (it pulls a ~4 GB image on a cold node).
  clusterReadyTimeoutSec: Number(env('CLUSTER_READY_TIMEOUT_SEC', '300')),
  gateway: env('GATEWAY_URL', ''),
  knimeScheduler: env('KNIME_SCHEDULER_URL', ''),

  // Terminal-status polling for workflow runs.
  workflowTimeoutSec: Number(env('WORKFLOW_TIMEOUT_SEC', '120')),
  pollIntervalSec: Number(env('POLL_INTERVAL_SEC', '1')),

  // Unique per k6 invocation so tenants and workflow names from different runs never collide.
  runId: env('RUN_ID', ''),
};

export function requireUrl(name, value) {
  if (!value) {
    throw new Error(`${name} is not set. Pass it with -e (for example -e ${name}=http://localhost:8080).`);
  }
  return value;
}
