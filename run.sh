#!/usr/bin/env bash
# Runs a k6 suite against a running stack. Usage: ./run.sh smoke | tenancy | <path/to/suite.js>
# Override targets with env vars, e.g. API_SERVER_URL=http://localhost:8081 ./run.sh smoke
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v k6 >/dev/null 2>&1; then
  echo "k6 is not installed. Install it from https://grafana.com/docs/k6/latest/set-up/install-k6/ (macOS: brew install k6)" >&2
  exit 127
fi

case "${1:-}" in
  smoke)     suite="suites/smoke.js" ;;
  tenancy)   suite="suites/tenancy/isolation.js" ;;
  load)      suite="suites/load/profile.js" ;;
  noisy)     suite="suites/load/noisy-neighbor.js" ;;
  "")        echo "usage: ./run.sh smoke | tenancy | load | noisy | <suite.js>" >&2; exit 2 ;;
  *)         suite="$1" ;;
esac

# One id per invocation so the tenants and workflow names of different runs never collide.
export RUN_ID="${RUN_ID:-$(date +%s | xargs printf '%x')$(LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c 4)}"

# Set the JSON default on its own line: an inline ${VAR:-{}} default is mangled by bash's brace handling.
TENANT_TOKENS="${TENANT_TOKENS:-}"
if [ -z "$TENANT_TOKENS" ]; then
  TENANT_TOKENS='{}'
fi

exec k6 run \
  -e RUN_ID="$RUN_ID" \
  -e API_SERVER_URL="${API_SERVER_URL:-http://localhost:8080}" \
  -e CREDENTIALS_URL="${CREDENTIALS_URL:-http://localhost:8083}" \
  -e CLUSTER_MANAGER_URL="${CLUSTER_MANAGER_URL:-http://localhost:8082}" \
  -e CLUSTER_MANAGER_K8S="${CLUSTER_MANAGER_K8S:-false}" \
  -e CLUSTER_MANAGER_IMAGE_ALLOWLIST="${CLUSTER_MANAGER_IMAGE_ALLOWLIST:-true}" \
  -e CLUSTER_MANAGER_OVERLAYS="${CLUSTER_MANAGER_OVERLAYS:-false}" \
  -e CLUSTER_READY_TIMEOUT_SEC="${CLUSTER_READY_TIMEOUT_SEC:-300}" \
  -e AUTH_MODE="${AUTH_MODE:-header}" \
  -e TENANT_TOKENS="$TENANT_TOKENS" \
  -e WORKFLOW_TIMEOUT_SEC="${WORKFLOW_TIMEOUT_SEC:-120}" \
  -e POLL_INTERVAL_SEC="${POLL_INTERVAL_SEC:-1}" \
  -e ALLOW_LOAD="${ALLOW_LOAD:-false}" \
  -e LOAD_ALLOWED_HOSTS="${LOAD_ALLOWED_HOSTS:-localhost,127.0.0.1}" \
  -e PROFILE="${PROFILE:-throughput}" \
  -e BASE_RATE_PER_MIN="${BASE_RATE_PER_MIN:-6}" \
  -e LOAD_SCALE="${LOAD_SCALE:-1}" \
  -e SOAK_SEC="${SOAK_SEC:-600}" \
  -e LOAD_TENANTS="${LOAD_TENANTS:-10}" \
  -e MAX_VUS="${MAX_VUS:-100}" \
  -e E2E_P95_MAX_MS="${E2E_P95_MAX_MS:-30000}" \
  -e START_P95_MAX_MS="${START_P95_MAX_MS:-1000}" \
  -e QUIET_RATE_PER_MIN="${QUIET_RATE_PER_MIN:-${BASE_RATE_PER_MIN:-6}}" \
  -e NOISY_FACTOR="${NOISY_FACTOR:-8}" \
  -e FAIRNESS_MAX_RATIO="${FAIRNESS_MAX_RATIO:-2}" \
  -e FAIRNESS_SLACK_MS="${FAIRNESS_SLACK_MS:-2000}" \
  -e CALIBRATION_RUNS="${CALIBRATION_RUNS:-6}" \
  -e ALONE_SEC="${ALONE_SEC:-120}" \
  -e NOISE_SEC="${NOISE_SEC:-180}" \
  "${@:2}" "$suite"
