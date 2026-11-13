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
  smoke)    suite="suites/smoke.js" ;;
  tenancy)  suite="suites/tenancy/isolation.js" ;;
  "")       echo "usage: ./run.sh smoke | tenancy | <suite.js>" >&2; exit 2 ;;
  *)        suite="$1" ;;
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
  -e AUTH_MODE="${AUTH_MODE:-header}" \
  -e TENANT_TOKENS="$TENANT_TOKENS" \
  -e WORKFLOW_TIMEOUT_SEC="${WORKFLOW_TIMEOUT_SEC:-120}" \
  "${@:2}" "$suite"
