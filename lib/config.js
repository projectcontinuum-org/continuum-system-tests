// Environment-driven configuration. Nothing here is hardcoded to a port: the api-server is on 8080 in the
// template compose but 8081 in the IntelliJ run configs, and knime-scheduler is 8084 in its config but 8085 in the
// gateway. Override any of these with `-e NAME=value` (k6) or an exported variable (run.sh / make).

const env = (name, fallback) => (typeof __ENV !== 'undefined' && __ENV[name] !== undefined ? __ENV[name] : fallback);

export const cfg = {
  // 'header' sets x-continuum-user-id itself (docker-compose, port-forward).
  // 'bearer' also sends `Authorization: Bearer <token>` from TENANT_TOKENS (JSON map) for runs through a real auth proxy.
  authMode: env('AUTH_MODE', 'header'),
  tenantTokens: JSON.parse(env('TENANT_TOKENS', '{}')),

  apiServer: env('API_SERVER_URL', 'http://localhost:8080'),
  credentials: env('CREDENTIALS_URL', 'http://localhost:8083'),
  clusterManager: env('CLUSTER_MANAGER_URL', ''),
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
