# continuum-system-tests

System, multi-tenant and load tests for [Project Continuum](https://github.com/projectcontinuum-org), written for [Grafana k6](https://k6.io). The tests are black-box: they call the platform's REST APIs on a running stack and never import platform code.

> **Status:** early. Only `smoke` and `tenancy/isolation` exist so far, and both pass against the docker-compose stack. The API suites, load profiles and per-feature tests are planned (see [Roadmap](#roadmap)).

## What is tested

| Suite | What it checks | Fails the run when |
|---|---|---|
| `suites/smoke.js` | api-server and credentials-server health, the feature-base nodes are registered, one workflow runs to `COMPLETED`, a credential create/read/delete round trip | any check fails |
| `suites/tenancy/isolation.js` | tenant B cannot read or act on tenant A's workflow runs, node output, credentials or schedules | any isolation check fails (`isolation_violations` must be 0) |

The isolation suite covers `/status`, `/cancel`, `/terminate`, `/active`, `/list`, `/count`, `/tree`, `/workflow-runs`, `/api/v1/data/...`, credentials and schedules.

## Requirements

- [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) (macOS: `brew install k6`)
- Docker with Compose, and roughly 6-8 GB of free RAM for the stack
- Node 20+ (only for the unit tests of the helper code)

## Quick start

```bash
make pull       # optional: download the images first, or re-download after a failed pull
make up         # start the stack (infra, platform services, the feature-base worker)
make smoke      # about a minute
make tenancy    # tenant isolation
make down       # stop the stack and delete its volumes
```

`make up` waits for the services to be healthy. The first start pulls a lot of images and can take several minutes.

### The stack

`docker/docker-compose.yml` is a copy of the compose file in `continuum-feature-template/docker/`, with one change: the four platform images use one variable.

```bash
CONTINUUM_PLATFORM_VERSION=0.0.22 make up   # default: 0.0.21
```

It pins `continuum-api-server`, `-orchestration-service`, `-message-bridge` and `-credentials-server`. The workbench and the feature workers have their own versions and are not affected.

`docker/.env` holds the Postgres and Temporal image versions. It is a copy of `continuum-feature-template/docker/.env`; re-copy it when the template changes. Keep secrets out of it: it is not git-ignored.

Set `CONTINUUM_PLATFORM_VERSION` before every `make` command that touches the stack. If it is missing, Compose recreates the containers on the default version.

To re-sync with the template, copy its compose file over `docker/docker-compose.yml` and re-apply the four `${CONTINUUM_PLATFORM_VERSION:-0.0.21}` image tags.

## Running against another environment

Everything is configured by environment variables, so the same suites run against compose, a port-forward or a cluster.

| Variable | Default | Meaning |
|---|---|---|
| `API_SERVER_URL` | `http://localhost:8080` | api-server base URL (some run configs use 8081) |
| `CREDENTIALS_URL` | `http://localhost:8083` | credentials-server base URL |
| `AUTH_MODE` | `header` | `header` sends only `x-continuum-user-id`; `bearer` also sends a token per tenant |
| `TENANT_TOKENS` | `{}` | JSON map `{"<tenant id>": "<token>"}`, used when `AUTH_MODE=bearer` |
| `WORKFLOW_TIMEOUT_SEC` | `120` | how long to wait for a workflow to reach a final status |
| `RUN_ID` | generated | makes tenant ids and workflow names unique per run |

```bash
API_SERVER_URL=http://localhost:8081 ./run.sh smoke
./run.sh tenancy --summary-export summary.json   # extra arguments go to k6
./run.sh suites/smoke.js                          # or any suite path
```

You can also call k6 directly: `k6 run -e API_SERVER_URL=... -e CREDENTIALS_URL=... suites/smoke.js`.

### Multi-tenancy and authentication

A tenant is only the `x-continuum-user-id` request header. The suites create tenants named `systest-<runId>-alice`, `systest-<runId>-bob` and so on, and tag every request and metric with `tenant:<id>`.

The platform trusts that header and expects an authenticating proxy in front of it in production. With `AUTH_MODE=header` the tests set the header themselves, which is right for docker-compose. To test the real proxy path, use `AUTH_MODE=bearer` with a token per tenant.

### Test data

Workflow runs cannot be deleted through the API. Everything a run creates is named with the `systest-<runId>` or `/systest/<runId>/` prefix, so you can find it afterwards. `make down` removes it along with the stack. Against a shared environment you have to clean up by that prefix.

## Layout

```
docker/        compose file and config for the stack under test
lib/           helpers shared by the suites
  config.js      env-driven configuration
  tenant.js      requests as a tenant (header, tags)
  workflows.js   start a workflow, poll until it finishes, isolation assertions
  capabilities.js  check which node classes are registered
  metrics.js     custom k6 metrics
  util.js        pure helpers with no k6 imports (unit-tested)
suites/        k6 scripts
fixtures/      workflow models posted to the api-server
test/          node unit tests for lib/util.js
```

The workflow fixture is `AnomalyDetector.cwf` from the template repo (`CreateTable`, `AnomalyDetectorZScore`, `ConditionalSplitter`). It needs only the feature-base worker and no network access.

## Tests for the test code

```bash
make test     # unit tests for lib/util.js; needs only node
make check    # syntax check of every k6 script
```

These do not need k6 or Docker. They do not run the suites.

## Writing a suite

- Make every request through `tenant(id)` from `lib/tenant.js`, so it carries the header and the metric tag.
- Take base URLs from `lib/config.js`. Do not hardcode ports.
- Assert status codes and the fields you depend on, not whole response bodies.
- `temporalStatus` can come back as a name or a number. Read it with `normalizeStatus`.
- A 404 or 500 from `/status` right after starting a workflow can be Temporal visibility lag. Poll instead of failing on the first miss (`waitForTerminal` does this).
- A test that needs an optional feature worker must check `lib/capabilities.js` first and skip when the nodes are absent.
- Keep k6-only code (`k6/http`, `open()`) out of `lib/util.js`.

See [AGENTS.md](AGENTS.md) for the full contracts.

## Known limitations

Both suites have been run successfully against the compose stack. What they do not cover yet:

- The branch for a node that is **not** registered (the "feature-base is not serving" failure) has not been exercised, only the case where the nodes are present.
- Credential responses are asserted by status code and `name` only.
- The isolation suite has been seen to pass, but not to fail. Before relying on it, break an ownership check on purpose (for example remove the owner check in the api-server's `cancelWorkflow`) and confirm the run goes red.

## Roadmap

1. **Per-service API suites** (`suites/api/`): api-server and credentials-server first, then the workbench, gateway and knime-scheduler, which need extra services. Includes regression checks for the CONTNM-161 security fixes.
2. **Load profiles**: throughput, stress, spike, soak, read-heavy and a noisy-neighbour test, with per-tenant thresholds. These will be opt-in and refuse to run against an environment that is not on an allow-list.
3. **Optional per-feature tests**: each feature declares the node classes it needs and is skipped when its worker is not deployed.
4. **CI**: smoke, API and tenancy on every pull request; a nightly load run.
