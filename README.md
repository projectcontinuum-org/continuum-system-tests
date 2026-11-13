# continuum-system-tests

System, multi-tenant and load tests for [Project Continuum](https://github.com/projectcontinuum-org), written for [Grafana k6](https://k6.io). The tests are black-box: they call the platform's REST APIs on a running stack and never import platform code.

> **Status:** early. `smoke`, `tenancy/isolation` and six API suites exist, and all pass against the docker-compose stack. The workbench, gateway and knime-scheduler suites, the load profiles and the per-feature tests are planned (see [Roadmap](#roadmap)).

## What is tested

| Suite | What it checks | Fails the run when |
|---|---|---|
| `suites/smoke.js` | api-server and credentials-server health, the feature-base nodes are registered, one workflow runs to `COMPLETED`, a credential create/read/delete round trip | any check fails |
| `suites/tenancy/isolation.js` | tenant B cannot read or act on tenant A's workflow runs, node output, credentials or schedules, and A can still read their own output | any isolation check fails (`isolation_violations` must be 0) |
| `suites/api/workflow.js` | start, status, list, count (with `GROUP BY`), tree, active, cancel and terminate (running, finished and unknown ids), query-injection rejection | any check fails |
| `suites/api/runs.js` | run list and paging, RSQL filter, get by id, count, distinct workflows | any check fails |
| `suites/api/schedules.js` | create, get, list, filter, pause, unpause, trigger, delete, validation, ownership | any check fails |
| `suites/api/node-explorer.js` | palette tree, search, documentation, task-queue lookup | any check fails |
| `suites/api/data.js` | node output paging, the CONTNM-161 paging and id validation, ownership | any check fails |
| `suites/api/credentials.js` | credential types and credentials CRUD, validation, per-tenant namespaces | any check fails |
| `suites/api/cluster-manager.js` | workbench API: input validation (CONTNM-161), 404s, authorize, tenant scoping; with a cluster, the full create / suspend / resume / update / delete lifecycle | any check fails. Skips when the service is not reachable. |

The isolation suite covers `/status`, `/cancel`, `/terminate`, `/active`, `/list`, `/count`, `/tree`, `/workflow-runs`, `/api/v1/data/...`, credentials and schedules.

### Cluster-manager suite (optional)

The cluster-manager (per-user workbench pods) is not part of `make up`. It has two tiers:

```bash
make up-cluster-manager      # starts it next to the running stack, on :8082
make cluster-manager         # tier 1
CLUSTER_MANAGER_K8S=true make cluster-manager   # tier 1 + tier 2
make down-cluster-manager    # stops and removes only the cluster-manager container
```

`make down` does not touch the cluster-manager (it only knows the main compose file), so use `make down-cluster-manager`
for it. It leaves the rest of the stack and the database alone; workbench records stay in Postgres until `make down`
removes the volumes. If it was run with `CLUSTER_MANAGER_K8S=true`, the suite already deleted its own workbench.

- **Tier 1 (default).** Needs only the cluster-manager and Postgres. It checks input validation, 404s, `authorize`, `variants`, `tags` and tenant scoping. Every request is one the service rejects *before* it touches Kubernetes, so nothing is ever created. Without a cluster, anything that does reach Kubernetes answers 500, so tier 1 sends none of those.
- **Tier 2 (`CLUSTER_MANAGER_K8S=true`).** Creates, waits for, updates, suspends, resumes and deletes **real workbench pods**, so the cluster-manager must be able to reach a cluster (set `KUBERNETES_MASTER_URL` for the container, with the credentials your cluster needs). It creates at most one workbench per run, with small resource requests, and always deletes it, even if a check fails. A cold node pulls a multi-GB image, so the ready timeout defaults to 300 s (`CLUSTER_READY_TIMEOUT_SEC`).
- If the service is not reachable the suite prints `SKIPPED` and exits 0.

| Variable | Default | Meaning |
|---|---|---|
| `CLUSTER_MANAGER_URL` | `http://localhost:8082` | cluster-manager base URL |
| `CLUSTER_MANAGER_K8S` | `false` | run tier 2 |
| `CLUSTER_MANAGER_IMAGE_ALLOWLIST` | `true` | the cluster-manager only accepts images from its own repository (its default). Set `false` if it runs with `WORKBENCH_ALLOWED_IMAGE_PREFIXES` empty. |
| `CLUSTER_MANAGER_OVERLAYS` | `false` | the cluster-manager runs with `OVERLAY_ENABLED=true`, so an unknown variant name is rejected |
| `CLUSTER_READY_TIMEOUT_SEC` | `300` | how long to wait for a pod to become ready |

### Known gaps

Behaviour that is wrong today is reported, not failed. The suite asserts the status code it *should* return; while the platform still answers something else, it logs a `KNOWN GAP` warning and counts it in the `known_gaps` metric (tagged `gap:<name>`). When the platform is fixed the warning disappears, and the call can become a normal check. Current gaps:

| Where | Today | Want |
|---|---|---|
| a malformed RSQL `filter` on `/workflow-runs` and `/workflow/schedule/filter` | 500 | 400 |
| `/api/v1/data` for a port or node with no stored file | 500 | 404 |
| credential create with a missing field or a non-JSON body | 500 | 400 |
| workbench create with a non-JSON body or no `instanceName` | 500 | 400 |
| workbench create or update with a `resources` object that omits a field (every `ResourceSpec` field is required, although the update code merges field by field and so looks designed for partial updates) | 500 | 400, or accepted and merged with the current values |
| reading a suspended workbench (tier 2) | status becomes `UNKNOWN`, so it can no longer be resumed | stays `SUSPENDED` |

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
make api        # all six API suites
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

## Load tests

Load tests answer different questions from the functional suites: where does latency start to climb, what breaks
first, does one tenant slow another, does the system recover, does it drift over time. They are **opt-in and guarded**.

> **Safety.** A run creates workflows, object-store files and database rows that **cannot be deleted through the API**.
> Every load suite refuses to send a single request unless **`ALLOW_LOAD=true`** is set **and** every target host
> (api-server, credentials-server, cluster-manager) is on **`LOAD_ALLOWED_HOSTS`** (default: `localhost,127.0.0.1`).
> The host match is exact, so `localhost.evil.com` does not match `localhost`. Do not add a shared or production host
> to that list. `make down` removes everything a run created on a local stack.

### Before you start

1. **Check the stack is healthy and idle.** `make smoke` should pass. Load numbers are only comparable when the machine
   is otherwise quiet: close other heavy apps, and do not run two load tests at once.
2. **Know your machine.** The default rates assume a small Docker VM (2 CPUs, 8 GB) that also runs Kafka, Temporal,
   Postgres and MinIO. If the feature worker image is `amd64` on Apple silicon it runs under emulation, which is
   slower. Look at `docker info --format 'CPUs={{.NCPU}} Mem={{.MemTotal}}'` and `docker stats --no-stream`.
3. **Start with a short run.** `LOAD_SCALE=0.25` shortens every phase to a quarter. It tells you whether the harness
   works and roughly where you are, but a shortened run measures little (see [Reading the result](#reading-the-result)).
4. **Keep a baseline.** Run the same profile once on a quiet stack and save its `summary-load-*.json` (see
   [Comparing two runs](#comparing-two-runs)). A number without a baseline from the same machine says very little.

### How to run

Settings are environment variables. `make` passes any variable you put on its command line through to the run, so
these are equivalent:

```bash
ALLOW_LOAD=true PROFILE=throughput make load
ALLOW_LOAD=true make load PROFILE=throughput
ALLOW_LOAD=true PROFILE=throughput ./run.sh load       # without make
ALLOW_LOAD=true ./run.sh suites/load/profile.js --out json=run.json   # extra arguments go to k6
```

Each run prints a table with one row per phase and a plain-language summary, and writes the same numbers to
`summary-load-<profile>.json` (git-ignored) so two runs can be compared.

```
phase   offered  for  workflows  success  e2e p50  e2e p95  e2e max  start p95  dropped
step1x    6/min  15s          2   100.0%     2.1s     3.0s     3.1s       48ms        0
step2x   12/min  15s          3   100.0%     1.0s     1.0s     1.0s       24ms        0
step4x   24/min  15s          6   100.0%     1.0s     2.8s     3.1s       27ms        0
step8x   48/min  15s         12   100.0%     2.6s     4.5s     5.1s       60ms        0

- Latency stayed within 2x of the first phase (p95 3.0s) across every phase.
- Every workflow in every phase succeeded.
```

That is a real run (`LOAD_SCALE=0.25`, so each phase is 15 seconds) on a 2-CPU Docker VM. It shows the output format;
the numbers are too few to conclude anything from (2 workflows in the first phase). The columns: **offered** is the
rate k6 tried to apply; **workflows** is how many it started and followed to the end; **e2e** is from the start request
to a final status; **start p95** is the latency of the start request alone; **dropped** is iterations k6 could not
start at all.

### Profiles

Load is applied with k6 **arrival-rate** executors: the offered rate stays constant when the system slows down, which
is what makes saturation visible. (With a fixed number of users, a slow system would simply receive less load and
look fine.) Every phase is its own k6 scenario, so each gets its own numbers. The base rate is `BASE_RATE_PER_MIN`.

| Profile | Shape (base rate B) | Takes | What it finds | Can fail the run |
|---|---|---|---|---|
| `throughput` | B, 2B, 4B, 8B, a minute each | 4 min | the rate where latency starts to climb | every step: success > 99%, e2e and start p95 under the limits, no dropped iterations |
| `stress` | B up to 64B, doubling each minute | 7 min | what breaks first, and at which rate | **aborts** the test when more than 5% of requests or workflows fail |
| `spike` | B for 1 min, **10B for 2 min**, B for 2 min | 5 min | does it recover after a burst? | `before` and `after`; the spike itself may degrade |
| `soak` | B for `SOAK_SEC`, in four equal quarters | `SOAK_SEC` | drift and leaks over time | every quarter |
| `noisy` | a quiet tenant alone, then beside a tenant at `NOISY_FACTOR` x its rate | 5 min | does one tenant slow another? | the quiet tenant (see below) |

All times are at `LOAD_SCALE=1`. `stress` is meant to break the system, so it has no latency gate: it stops itself.

### Realistic examples

Rates are workflows per minute. The fixture workflow (`CreateTable` of 1000 rows, an anomaly detector and a splitter)
takes about 1 to 3 seconds when the stack is idle. Pick the example nearest to your machine and adjust.

**1. Quick check that everything works (about 1 minute)**

```bash
ALLOW_LOAD=true LOAD_SCALE=0.25 make load PROFILE=throughput
```

**2. Capacity of a laptop-sized stack (4 minutes)** The default: starts at one workflow every 10 seconds and doubles
each minute up to 48 per minute. Look for the first row where e2e p95 more than doubles.

```bash
ALLOW_LOAD=true make load PROFILE=throughput
```

**3. Capacity of a larger machine or a cluster (4 minutes)** Start at 30 per minute (0.5 per second), reaching 240.
Raise `MAX_VUS` so k6 is not the limit: at 240 per minute and a 10-second workflow you need about 40 users in flight,
and more as latency grows.

```bash
ALLOW_LOAD=true BASE_RATE_PER_MIN=30 MAX_VUS=300 make load PROFILE=throughput
```

**4. Find the breaking point (7 minutes)** Doubles every minute from 6 to 384 per minute and aborts when more than 5%
of workflows fail. Warning: this pushes the machine to its limit and may make a small Docker VM unresponsive. Do
not run it on a machine you are working on.

```bash
ALLOW_LOAD=true BASE_RATE_PER_MIN=6 MAX_VUS=300 make load PROFILE=stress
```

**5. A traffic burst, then recovery (5 minutes)** A steady 12 per minute, a 2-minute burst of 120, then 12 again. The
question is whether the `after` phase returns to the `before` latency; if it does not, work is queueing and not
draining.

```bash
ALLOW_LOAD=true BASE_RATE_PER_MIN=12 MAX_VUS=200 make load PROFILE=spike
```

**6. Overnight soak (1 hour; run it at night)** A modest constant rate for a long time, to find leaks and drift. Compare
`q1` with `q4`: p95 that creeps up, or success that falls, points to a leak (the worker cache directory and the
api-server's DuckDB connection are known suspects, and nothing deletes object-store files).

```bash
ALLOW_LOAD=true BASE_RATE_PER_MIN=12 SOAK_SEC=3600 make load PROFILE=soak
```

**7. Many tenants, few tenants** Load is spread round-robin over `LOAD_TENANTS` tenants (default 10). Use one tenant to
see the single-tenant ceiling, and 100 to look for per-tenant cost (each tenant has its own rows and filters).

```bash
ALLOW_LOAD=true LOAD_TENANTS=1   make load PROFILE=throughput
ALLOW_LOAD=true LOAD_TENANTS=100 make load PROFILE=throughput
```

**8. Is one tenant slowing another? (5 minutes)** See [Noisy neighbour](#noisy-neighbour).

```bash
ALLOW_LOAD=true NOISY_FACTOR=12 make noisy          # 12x: a moderate neighbour
ALLOW_LOAD=true NOISY_FACTOR=20 MAX_VUS=200 make noisy   # 20x: heavy
```

**9. A stricter gate for CI** Fail the run when a step is slower than you will accept.

```bash
ALLOW_LOAD=true E2E_P95_MAX_MS=8000 START_P95_MAX_MS=300 make load PROFILE=throughput
```

**10. A slower platform behind a network** Longer waits before a workflow counts as timed out, and less polling.

```bash
ALLOW_LOAD=true WORKFLOW_TIMEOUT_SEC=300 POLL_INTERVAL_SEC=2 API_SERVER_URL=http://localhost:8081 make load
```

### Noisy neighbour

This is the multi-tenant load test: does one tenant flooding the system slow down another?

1. **Baseline.** In `setup()` the quiet tenant runs `CALIBRATION_RUNS` (6) workflows alone on the idle stack. The
   baseline is their **p90**, not the median: one workflow's time varies from run to run (about 1 s to 3 s on a small
   stack), and against a median that ordinary idle variation would be reported as a slowdown caused by the neighbour.
2. **Limit.** `max(FAIRNESS_MAX_RATIO x baseline, baseline + FAIRNESS_SLACK_MS)`. The slack stops a very fast stack
   from turning ordinary jitter into a failure.
3. **Test.** The quiet tenant keeps a steady rate (`QUIET_RATE_PER_MIN`, default the base rate); after `ALONE_SEC` a
   second tenant floods the system at `NOISY_FACTOR` x that rate. Every quiet workflow is checked against the limit, in
   both phases (the idle phase proves the limit is not set too tight).
4. **Verdict.** More than 95% of the quiet tenant's workflows must finish OK within the limit. The report ends with
   a `Fairness PASS` or `Fairness FAIL` line with the counts. That line, not the latency table, decides the exit code.
   The table is a comparison of p95s; a single workflow over the limit fails the run even when the p95 ratio is fine.
   With fewer than 20 quiet workflows (a shortened `LOAD_SCALE`) one slow workflow is enough to fail the 95% rule, and
   the report says so. Run it at `LOAD_SCALE=1` before trusting a verdict.

The platform has no per-tenant isolation of compute today: all tenants share the Temporal task queues and the workers.
So when the neighbour is heavy enough to saturate the workers, the quiet tenant waits in the same queue and the test
fails. That is a finding about the platform, not a flaw in the test. On a small stack, a 20x neighbour is expected to
fail it, while a neighbour that does not saturate the stack (about 8x on a 2-CPU VM) should pass. A deployment with
more workers, or per-tenant task queues, would behave differently and this test measures it.

### Load settings

All variables, with their defaults. Anything not listed here is not read by the load suites.

**Safety**

| Variable | Default | Meaning |
|---|---|---|
| `ALLOW_LOAD` | `false` | must be `true`, or the run refuses to start |
| `LOAD_ALLOWED_HOSTS` | `localhost,127.0.0.1` | comma-separated hosts that may be loaded; matched exactly |

**Shape of the load**

| Variable | Default | Meaning |
|---|---|---|
| `PROFILE` | `throughput` | `throughput`, `stress`, `spike` or `soak` (`make noisy` is its own target) |
| `BASE_RATE_PER_MIN` | `6` | workflows per minute at the first step. One every 10 s is gentle for a 2-CPU Docker VM |
| `LOAD_SCALE` | `1` | multiplies every phase length (`0.25` is a quarter of the time, `2` is double) |
| `SOAK_SEC` | `600` | total length of the `soak` profile, split into four quarters |
| `LOAD_TENANTS` | `10` | tenants the load is spread over, round-robin |
| `MAX_VUS` | `100` | cap on k6 virtual users per phase. Hitting it shows up as `dropped` iterations |

**What counts as a pass** (gated phases only)

| Variable | Default | Meaning |
|---|---|---|
| `E2E_P95_MAX_MS` | `30000` | highest end-to-end p95 a gated phase may show |
| `START_P95_MAX_MS` | `1000` | highest p95 of the start request alone |

**Waiting for workflows**

| Variable | Default | Meaning |
|---|---|---|
| `WORKFLOW_TIMEOUT_SEC` | `120` | how long to wait for one workflow to reach a final status before counting it failed |
| `POLL_INTERVAL_SEC` | `1` | how often to ask for its status. More polling adds load of its own |

**Noisy neighbour**

| Variable | Default | Meaning |
|---|---|---|
| `QUIET_RATE_PER_MIN` | `BASE_RATE_PER_MIN` | the quiet tenant's steady rate |
| `NOISY_FACTOR` | `8` | the neighbour's rate as a multiple of the quiet tenant's |
| `FAIRNESS_MAX_RATIO` | `2` | how many times its idle baseline the quiet tenant may take |
| `FAIRNESS_SLACK_MS` | `2000` | never tighter than the baseline plus this |
| `CALIBRATION_RUNS` | `6` | idle workflows run first to measure the baseline |
| `ALONE_SEC` / `NOISE_SEC` | `120` / `180` | length of the quiet-alone phase and of the loud phase (both scaled by `LOAD_SCALE`) |

**Targets** (shared with the other suites): `API_SERVER_URL`, `CREDENTIALS_URL`, `CLUSTER_MANAGER_URL`, `AUTH_MODE`.

### Reading the result

- **Look at the first row where latency doubles.** The findings line says it: "Latency doubles at step4x (24/min)".
  Below that rate the platform keeps up; above it, work queues.
- **Success below 100% means workflows failed or timed out**, not just that they were slow. A workflow that cannot
  even be started counts as failed. Check `WORKFLOW_TIMEOUT_SEC` before blaming the platform: a workflow still queued
  at the timeout is a failure.
- **`dropped` > 0** means k6 could not start the planned number of iterations. The report works out which of two things
  it is, using the rate and the measured latency (a phase needs about *rate x latency* virtual users):
  - the phase needed **more** users than `MAX_VUS`: raise `MAX_VUS`. The numbers for that phase describe k6.
  - the phase needed **far fewer** than `MAX_VUS`: the cap is not the cause. Workflows took so long that they piled
    up while the phase ran, so the platform was already saturated.
- **A short run measures little.** At `LOAD_SCALE=0.25` a phase is 15 seconds, so a "p95" may be one workflow. The
  harness check is fine; do not draw capacity conclusions from it.
- **Latency that rises across the phases of a flat profile is a finding.** In `soak`, `q4` slower than `q1` at the same
  rate means something accumulates.
- **The machine is small.** A 2-CPU Docker VM also hosts Kafka, Temporal and Postgres, and an `amd64` worker under
  emulation is slower still. Compare runs on the *same* machine; absolute numbers say little.
- **A run that finishes no workflow** reports "No workflow ran, so there is no report" and writes no result file.
  Never read an empty result as a fast one.

### Comparing two runs

Each run writes `summary-load-<profile>.json`. Copy it aside before the next run overwrites it, then compare with `jq`
(installed on most machines):

```bash
cp summary-load-throughput.json baseline-throughput.json      # keep the run you trust
ALLOW_LOAD=true make load PROFILE=throughput                  # change something, run again

jq -rs '
  def sec: if . == null then "-" else ((. / 100 | round) / 10 | tostring) + "s" end;
  [.[0].phases, .[1].phases] as [$a, $b]
  | ["phase","offered/min","p95 before","p95 after","change"],
    ( range(0; ($a|length)) as $i
      | [ $a[$i].phase, ($a[$i].rate|tostring), ($a[$i].e2eP95|sec), ($b[$i].e2eP95|sec),
          (if ($a[$i].e2eP95 and $b[$i].e2eP95) then "\((($b[$i].e2eP95 / $a[$i].e2eP95 - 1) * 100) | round)%" else "-" end) ] )
  | @tsv' baseline-throughput.json summary-load-throughput.json | column -t -s $'\t'
```

```
phase   offered/min  p95 before  p95 after  change
step1x  6            3s          4.5s       50%
step2x  12           1s          -          -
step4x  24           2.8s        4.2s       50%
step8x  48           4.5s        6.8s       50%
```

A `-` means that phase finished no workflow in one of the runs. Differences under about 20% between two runs of the same
profile are usually noise on a small machine; run each twice before concluding anything.

To keep the full k6 metrics as well, add `--out json=run.json` (large) or `--summary-export summary.json` (small).

### Cleaning up

A load run leaves workflow runs, objects in the `continuum-worker-storage` bucket and rows in Postgres. Everything it
created is named with the `systest-<runId>` prefix. On a local stack `make down` removes the lot (it deletes the
volumes). On a shared stack there is no API to delete workflow runs, so clean up by that prefix in the database and the
bucket, and think twice before loading a shared stack at all.

## Known limitations

All suites have been run successfully against the compose stack. What they do not cover yet:

- The branch for a node that is **not** registered (the "feature-base is not serving" failure) has not been exercised, only the case where the nodes are present.
- The isolation suite has been seen to pass, but not to fail. Before relying on it, break an ownership check on purpose (for example remove the owner check in the api-server's `cancelWorkflow`) and confirm the run goes red.
- Cancel and terminate are exercised on a workflow that is cancelled right after it starts. That race is intermittent, so run `suites/api/workflow.js` several times after any change to the orchestration service.
- The suites need a platform with the `run_id` column (0.0.23 built from this branch). Against an older api-server, node output is addressed by a different id and `data.js` and `isolation.js` fail.

## Roadmap

1. **Workbench suite** (the Theia UI itself; planned for later). The cluster-manager API suite is done. The gateway and knime-scheduler are not part of the core platform and have no suites.
2. **Load tests** are in: throughput, stress, spike, soak and noisy-neighbour (above). Not done: a read-heavy profile (many tenants paging `/data`, `/workflow-runs` and `/list`), Prometheus remote-write output, and a nightly CI run.
3. **Optional per-feature tests**: each feature declares the node classes it needs and is skipped when its worker is not deployed.
4. **CI**: smoke, API and tenancy on every pull request; a nightly load run.
