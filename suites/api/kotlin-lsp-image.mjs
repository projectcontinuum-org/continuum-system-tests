#!/usr/bin/env node
// Black-box checks of the production workbench IMAGE and of the language-server bridge running inside it, from outside,
// through the docker CLI. It never builds anything and never touches a container or volume it did not create: everything it
// makes is named `<NAME_PREFIX>-<runId>-<role>` and removed in `finally` (a removal is refused for any other name).
//
// What it proves (groups, in run order)
//   image        what the image contains: the pinned Java 21 runtime (jlink-reduced, no JDK compiler, but the JDK modules the
//                server's own libraries may touch), the pinned Kotlin language server (marker = the pin in
//                scripts/download-kotlin-ls.sh), its start launcher and the Kotlin standard library in the Maven-layout folder
//                MAVEN_REPOSITORY points at, sizes, the start configuration and entrypoint script unchanged apart from the
//                seeding (BASELINE_IMAGE), the server's own start script runs on the bundled runtime, the VS Code Kotlin
//                extension is bundled
//   download     the installer script rejects a download whose checksum is not the pinned one and installs nothing (host-run)
//   launcher     the server's start launcher, started the way an editor extension starts it (minimal environment, no
//                MAVEN_REPOSITORY of its own, no network), speaks LSP over stdio and completes `"abc".le` with the String
//                members: the standard library is found through the launcher alone, with no bridge in between
//   seedscript   the source copy of the seed script (the one `yarn start` runs), on the host against temporary folders: a settings
//                file saved with a UTF-8 byte-order mark (plain, commented, nothing but the mark, not JSON at all)
//   seed         with the home folder on a volume (like the pod's persistent volume) the entrypoint writes the Kotlin extension
//                settings into the folder the app really reads (the server path is the launcher), keeps the user's other
//                settings, is repeatable, copes with a settings file that has comments and trailing commas and/or starts with
//                a UTF-8 byte-order mark (how editors on Windows save it; seeded directly and through the entrypoint), and
//                leaves an unreadable one alone without keeping the container from starting
//   asis         the image as shipped: started `--network none` as uid 1000, then lib/ + suites/api/kotlin-lsp-bridge.mjs are
//                copied in and run INSIDE the container with --offline (so every bridge check also proves "works with no
//                network"), including the language server's resident memory under load
// Opt-in (ONLY=<group>), because they take long or overload the server on purpose:
//   experiment    a diagnostic aid for a failing `asis` run: the same run again with the Kotlin standard library placed in a
//                 second Maven-layout folder inside the image and MAVEN_REPOSITORY pointing at it. It separates failures
//                 caused by a missing library from the rest (an image that ships the library has none of the first kind).
//   default-idle  the production default idle timeout (10 minutes): one container without the idle override, ~11 minutes
//   exhaustion    how many scripts one server can hold before its heap is full, and what the bridge does then (the
//                 `exhaustion` group of the bridge suite, run in the image as shipped)
//   pod-limit     the bridge's diagnostics + memory groups, then its exhaustion group, in a container limited to POD_LIMIT_GIB
//                 GiB of memory (a comma-separated list, default 1: the cluster manager's workbench default used to be 1 GiB):
//                 does the pod survive a Kotlin editor?
// Every container run also records, as measurements, the whole container's memory (cgroup) and a summary of the errors the
// language server wrote to its error stream (distinct internal errors, OutOfMemoryError mentions).
//
// Run (needs Node 20+ and the docker CLI; no k6, no platform stack):
//   IMAGE=projectcontinuum/continuum-workbench:<tag> node suites/api/kotlin-lsp-image.mjs
//   BASELINE_IMAGE=projectcontinuum/continuum-workbench:<previous> IMAGE=<new> node suites/api/kotlin-lsp-image.mjs
//   ONLY=default-idle IMAGE=<new> node suites/api/kotlin-lsp-image.mjs
// Exit code 1 when any check FAILs; SKIP lines say what could not be checked and why.
//
// Env
//   IMAGE                  (required) the workbench image to test; it must already exist locally.
//   BASELINE_IMAGE         a previous image of the same workbench: the start configuration and entrypoint script are compared.
//                          It must be a release from before the feature: one that already contains the Kotlin support (for
//                          example a local rebuild under the released tag) makes both comparisons SKIP (NOT VERIFIED).
//                          Pull the release by digest and tag it with a name of your own to be safe.
//   WORKBENCH_SOURCE_DIR   the continuum-workbench source folder (default: ../continuum-workbench next to this repo's tests);
//                          its scripts/download-kotlin-ls.sh is the source of the pin and the installer under test.
//   NAME_PREFIX            prefix of everything created (default kotlin-lsp-systest).
//   BRIDGE_TIMEOUT_MINUTES longest a bridge-suite run inside a container may take (default 30; default-idle needs ~11).
//   POD_LIMIT_GIB          memory limits (GiB, comma-separated) the `pod-limit` group runs with (default 1).
//   ONLY                   comma-separated groups to run.
// The bridge suite itself is configured through its own env (see its header); this driver sets WORKBENCH_URL, IDLE_TIMEOUT_SECONDS
// (15, so the idle-stop checks finish quickly), EXPECT_LS_HOME and LEAK_PROBE_DIR. The suite runs as the backend's own user (uid
// 1000: a container's root may not look into another user's processes), with the Theia workspace folder as probe folder; /app, the
// backend's working directory, belongs to root, so the probe there is a second, short run of the `leak` group as root.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecorder } from '../../lib/runner.mjs';
import { featureSourceFile } from '../../lib/kotlin-script.mjs';
import { StdioLspClient } from '../../lib/lsp-stdio.mjs';
import {
  megabytes, parseJavaVersion, parseModules, parseDu, parseMarker, parsePin, parseSummary, parseResultLines, groupTotals,
  ownedName, isOwnedName, describeImage, startDifferences, addedEnvironment, hasKotlinSupport, lineChanges, seededSettingsProblems,
  stdlibVersion, mavenStdlibPath, parseMemoryStat, parseUid, configurationDirectory, compareFailures, serverErrorSummary,
} from '../../lib/image-probe.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const testsRoot = path.resolve(here, '..', '..');
const IMAGE = process.env.IMAGE;
const BASELINE_IMAGE = process.env.BASELINE_IMAGE;
const PREFIX = process.env.NAME_PREFIX || 'kotlin-lsp-systest';
const SOURCE_DIR = process.env.WORKBENCH_SOURCE_DIR || path.resolve(testsRoot, '..', 'continuum-workbench');
const ONLY = (process.env.ONLY || '').split(',').map((part) => part.trim()).filter(Boolean);
const BRIDGE_TIMEOUT_MS = Number(process.env.BRIDGE_TIMEOUT_MINUTES || 30) * 60000;
const POD_LIMITS_GIB = (process.env.POD_LIMIT_GIB || '1').split(',').map((part) => Number(part.trim())).filter((gib) => Number.isFinite(gib) && gib > 0);
const KOTLIN_HOME = '/opt/continuum/kotlin-ls';
const BACKEND_UID = '1000';
const SUITE_DIR_IN_CONTAINER = '/tmp/kotlin-lsp-systest';
const runId = Date.now().toString(36);
const rec = createRecorder({ only: ONLY });
const OPT_IN = ['experiment', 'default-idle', 'exhaustion', 'pod-limit'];
const wants = (group) => (OPT_IN.includes(group) ? ONLY.includes(group) : rec.selected(group));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const secondsSince = (t) => Math.round((Date.now() - t) / 100) / 10;

// ---- docker ------------------------------------------------------------------------------------------------------------
function docker(args, { input, timeoutMs = 120000 } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', input, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.message };
}

function dockerOk(args, options) {
  const result = docker(args, options);
  if (result.status !== 0) {
    throw new Error(`docker ${args.slice(0, 3).join(' ')} failed (${result.status}): ${(result.stderr || result.stdout || result.error || '').trim().slice(0, 400)}`);
  }
  return result.stdout;
}

const created = { containers: new Set(), volumes: new Set() };
let oneShots = 0;
/** Bridge-suite knobs the driver hands on to the run inside the container when they are set in its own environment. */
const SUITE_TUNING = ['EXHAUSTION_DOCUMENTS', 'EXHAUSTION_WATCH_SECONDS', 'EXHAUSTION_SOAK_SECONDS', 'COLDWINDOW_OFFSETS_MS', 'LS_OPEN_DOCUMENTS'];

/** A throwaway container for one command (`docker run --rm`): no network, the image's own entrypoint unless one is given. */
function oneShot(args, { entrypoint, user = '1000:1000', env = {}, volumes = [], timeoutMs = 120000 } = {}) {
  const name = ownedName(PREFIX, runId, `once${++oneShots}`);
  created.containers.add(name);
  const dockerArgs = ['run', '--rm', '--name', name, '--network', 'none', '--user', user];
  if (entrypoint !== undefined) { dockerArgs.push('--entrypoint', entrypoint); }
  for (const [key, value] of Object.entries(env)) { dockerArgs.push('-e', `${key}=${value}`); }
  for (const volume of volumes) { dockerArgs.push('-v', volume); }
  dockerArgs.push(IMAGE, ...args);
  const result = docker(dockerArgs, { timeoutMs });
  if (result.status !== null) { created.containers.delete(name); } // `--rm` removed it; a timed-out run stays listed for cleanUp
  return result;
}
const inImage = (script, options = {}) => oneShot(['-c', script], { entrypoint: 'sh', ...options });

function startContainer(role, { env = {}, extraArgs = [], user = `${BACKEND_UID}:${BACKEND_UID}` } = {}) {
  const name = ownedName(PREFIX, runId, role);
  const args = ['run', '-d', '--name', name, '--network', 'none', '--user', user];
  for (const [key, value] of Object.entries(env)) { args.push('-e', `${key}=${value}`); }
  dockerOk([...args, ...extraArgs, IMAGE]);
  created.containers.add(name);
  return name;
}

function removeContainer(name) {
  if (!isOwnedName(name, PREFIX, runId)) {
    throw new Error(`refusing to remove container ${name}: it was not created by this run`);
  }
  docker(['rm', '-f', name], { timeoutMs: 60000 });
  created.containers.delete(name);
}

function removeVolume(name) {
  if (!isOwnedName(name, PREFIX, runId)) {
    throw new Error(`refusing to remove volume ${name}: it was not created by this run`);
  }
  docker(['volume', 'rm', '-f', name], { timeoutMs: 60000 });
  created.volumes.delete(name);
}

function cleanUp() {
  for (const name of [...created.containers]) { try { removeContainer(name); } catch (error) { console.error(error.message); } }
  for (const name of [...created.volumes]) { try { removeVolume(name); } catch (error) { console.error(error.message); } }
}

const exec = (container, args, { user, env = {}, timeoutMs = 60000 } = {}) => {
  const dockerArgs = ['exec'];
  if (user !== undefined) { dockerArgs.push('-u', user); }
  for (const [key, value] of Object.entries(env)) { dockerArgs.push('-e', `${key}=${value}`); }
  return docker([...dockerArgs, container, ...args], { timeoutMs });
};

async function waitForBackend(container, seconds = 90) {
  const probe = "fetch('http://127.0.0.1:8080/').then((r) => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))";
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    if (exec(container, ['node', '-e', probe], { timeoutMs: 20000 }).status === 0) {
      return secondsSince(started);
    }
    if (docker(['inspect', '-f', '{{.State.Running}}', container]).stdout.trim() !== 'true') {
      return undefined;
    }
    await sleep(500);
  }
  return undefined;
}

/** Runs a docker command, printing its output line by line with `prefix`; resolves with the exit status and the raw output. */
function streamDocker(args, { prefix, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let pending = '';
    const take = (chunk) => {
      output += chunk;
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      lines.forEach((line) => console.log(`${prefix}${line}`));
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (status) => {
      clearTimeout(timer);
      if (pending) { console.log(`${prefix}${pending}`); }
      resolve({ status, output });
    });
  });
}

function stageSuite(container) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), `${PREFIX}-stage-`));
  try {
    fs.mkdirSync(path.join(stage, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(stage, 'suites', 'api'), { recursive: true });
    for (const file of fs.readdirSync(path.join(testsRoot, 'lib')).filter((name) => name.endsWith('.mjs'))) {
      fs.copyFileSync(path.join(testsRoot, 'lib', file), path.join(stage, 'lib', file));
    }
    fs.copyFileSync(path.join(testsRoot, 'suites', 'api', 'kotlin-lsp-bridge.mjs'), path.join(stage, 'suites', 'api', 'kotlin-lsp-bridge.mjs'));
    // The suite builds the names the node reports from the real source of its API; the container has no sibling repository.
    const featureSource = featureSourceFile(process.env.FEATURE_BASE_DIR);
    if (fs.existsSync(featureSource)) {
      const staged = featureSourceFile(path.join(stage, 'continuum-feature-base'));
      fs.mkdirSync(path.dirname(staged), { recursive: true });
      fs.copyFileSync(featureSource, staged);
    }
    dockerOk(['cp', `${stage}${path.sep}.`, `${container}:${SUITE_DIR_IN_CONTAINER}`]);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function containerMemory(container) {
  const read = (file) => exec(container, ['cat', `/sys/fs/cgroup/${file}`]);
  const number = (result) => (result.status === 0 && /^\d+$/.test(result.stdout.trim()) ? Number(result.stdout.trim()) : undefined);
  const stat = parseMemoryStat(read('memory.stat').stdout);
  return { current: number(read('memory.current')), peak: number(read('memory.peak')), anon: stat.anon, file: stat.file };
}
const mb = (bytes) => (bytes === undefined ? 'n/a' : `${megabytes(bytes)} MB`);

/**
 * Starts a container from IMAGE (offline, uid 1000), waits for the backend, copies the bridge suite in and runs it there.
 * Resolves what the run produced: the parsed result lines, the container's memory and whether it survived.
 */
async function bridgePhase(role, { env = {}, containerArgs = [], setup, suiteEnv = {}, idleSeconds = 15 } = {}) {
  // idleSeconds: null leaves the image's own default (600 s) in place instead of overriding it
  const containerEnv = idleSeconds === null ? { ...env } : { CONTINUUM_LANGUAGE_SERVER_IDLE_TIMEOUT_SECONDS: String(idleSeconds), ...env };
  const name = startContainer(role, { env: containerEnv, extraArgs: containerArgs });
  const up = await waitForBackend(name);
  if (up === undefined) {
    const log = docker(['logs', '--tail', '15', name]);
    return { name, failedToStart: `the backend did not answer on 8080 within 90 s; log tail: ${(log.stdout + log.stderr).trim().slice(-500)}` };
  }
  if (setup) { setup(name); }
  stageSuite(name);
  const environment = {
    WORKBENCH_URL: 'http://127.0.0.1:8080',
    EXPECT_LS_HOME: KOTLIN_HOME,
    LEAK_PROBE_DIR: '/home/continuum/workspace',
    ...(idleSeconds === null ? {} : { IDLE_TIMEOUT_SECONDS: String(idleSeconds) }),
    ...Object.fromEntries(SUITE_TUNING.filter((variable) => process.env[variable]).map((variable) => [variable, process.env[variable]])),
    ...suiteEnv,
    FEATURE_BASE_DIR: `${SUITE_DIR_IN_CONTAINER}/continuum-feature-base`,
  };
  let peakAnon = 0;
  let peakCurrent = 0;
  const sampler = setInterval(() => {
    const sample = containerMemory(name);
    peakAnon = Math.max(peakAnon, sample.anon ?? 0);
    peakCurrent = Math.max(peakCurrent, sample.current ?? 0);
  }, 4000);
  const runSuite = (user, suiteEnvironment, label) => streamDocker(
    ['exec', '-u', user, ...Object.entries(suiteEnvironment).flatMap(([key, value]) => ['-e', `${key}=${value}`]), name, 'node', `${SUITE_DIR_IN_CONTAINER}/suites/api/kotlin-lsp-bridge.mjs`, '--offline'],
    { prefix: `    [${label}] `, timeoutMs: BRIDGE_TIMEOUT_MS });
  const started = Date.now();
  // As the backend's own user: root would not be allowed to look into the process of another user (no CAP_SYS_PTRACE in a container).
  const run = await runSuite(BACKEND_UID, environment, role);
  const results = parseResultLines(run.output);
  if (!suiteEnv.ONLY) {
    // /app, the backend's working directory, belongs to root: planting the probe file there takes root, so it is a short pass of its own.
    const rootPass = await runSuite('0', { WORKBENCH_URL: environment.WORKBENCH_URL, ONLY: 'leak', LEAK_PROBE_DIR: '/app' }, `${role}/root`);
    results.push(...parseResultLines(rootPass.output));
  }
  clearInterval(sampler);
  const state = docker(['inspect', '-f', '{{.State.Running}} {{.State.OOMKilled}} {{.State.ExitCode}}', name]).stdout.trim().split(' ');
  const memory = state[0] === 'true' ? containerMemory(name) : {};
  const backendLog = docker(['logs', name]);
  return {
    name, seconds: secondsSince(started), exitStatus: run.status,
    results, summary: parseSummary(run.output),
    running: state[0] === 'true', oomKilled: state[1] === 'true', containerExit: state[2],
    serverErrors: serverErrorSummary(`${backendLog.stdout}\n${backendLog.stderr}`),
    memory: { ...memory, sampledPeakAnon: peakAnon || undefined, sampledPeakCurrent: peakCurrent || undefined },
  };
}

/** One check per bridge-suite group, plus the facts about the container that ran it. */
function recordBridgePhase(group, label, phase) {
  if (phase.failedToStart) {
    rec.record(group, `${label}: the container starts and the backend answers`, false, phase.failedToStart);
    return;
  }
  if (!phase.summary) {
    rec.record(group, `${label}: the bridge suite ran to its summary`, false, `no summary line (exit status ${phase.exitStatus}${phase.running ? '' : `, container stopped: exit ${phase.containerExit}, OOM-killed ${phase.oomKilled}`})`);
  }
  for (const totals of groupTotals(phase.results)) {
    rec.record(group, `${label} · bridge ${totals.group}: ${totals.pass} passed, ${totals.fail} failed, ${totals.skip} skipped`, totals.fail === 0, totals.failing.join(' | ').slice(0, 600));
  }
  rec.record(group, `${label}: the container was not OOM-killed and the backend still ran after the suite`, phase.running && !phase.oomKilled, `running ${phase.running}, OOM-killed ${phase.oomKilled}, exit code ${phase.containerExit}`);
  const m = phase.memory;
  rec.record(group, `${label}: whole-container memory during the run (measurement)`, true,
    `sampled peak ${mb(m.sampledPeakCurrent)} (anonymous ${mb(m.sampledPeakAnon)}); cgroup peak since start ${mb(m.peak)} incl. page cache; at the end ${mb(m.current)} (anonymous ${mb(m.anon)}, file cache ${mb(m.file)}); the cluster manager's default workbench pod is 1 GiB requested / 2 GiB limit; run took ${phase.seconds} s`);
  const errors = phase.serverErrors;
  if (errors && (errors.errors.length > 0 || errors.outOfMemory > 0)) {
    const listed = errors.errors.slice(0, 4).map((e) => `${e.count}x ${e.message.slice(0, 150)}${e.cause && e.cause !== e.message ? ` [cause: ${e.cause.slice(0, 150)}]` : ''}`).join(' | ');
    rec.record(group, `${label}: the language server's own error log (measurement)`, true, `${errors.outOfMemory} line(s) mention an OutOfMemoryError; ${listed || 'no internal errors'}`);
  }
}

// ---- groups ------------------------------------------------------------------------------------------------------------
async function imageGroup() {
  const group = 'image';
  let pin;
  const pinFile = path.join(SOURCE_DIR, 'scripts', 'download-kotlin-ls.sh');
  if (fs.existsSync(pinFile)) { pin = parsePin(fs.readFileSync(pinFile, 'utf8')); }
  const image = describeImage(JSON.parse(dockerOk(['image', 'inspect', IMAGE])));

  if (BASELINE_IMAGE) {
    const baseline = describeImage(JSON.parse(dockerOk(['image', 'inspect', BASELINE_IMAGE])));
    if (hasKotlinSupport(baseline)) {
      // The tag was rebuilt locally from the working tree (or points at a later release): it already holds what the feature
      // added, so a comparison with it proves nothing and its "no difference" would read as a failure.
      const reason = `${BASELINE_IMAGE} already contains the Kotlin support (CONTINUUM_KOTLIN_LS_HOME=${baseline.env.CONTINUUM_KOTLIN_LS_HOME}): it is not a release from before the feature, perhaps a local rebuild under the same tag; pull the released image by digest, tag it with a name of your own and pass that as BASELINE_IMAGE`;
      rec.skip(group, `the image starts like ${BASELINE_IMAGE}: same entrypoint, command, working directory, user and ports`, reason);
      rec.skip(group, `the entrypoint script differs from ${BASELINE_IMAGE}'s only by seeding the Kotlin extension settings`, reason);
    } else {
      await rec.check(group, `the image starts like ${BASELINE_IMAGE}: same entrypoint, command, working directory, user and ports`, () => {
        const differences = startDifferences(image, baseline);
        const added = addedEnvironment(image, baseline);
        return { ok: differences.length === 0, detail: `${differences.join('; ') || 'identical'}; environment added: ${Object.entries(added).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}` };
      });
      await rec.check(group, `the entrypoint script differs from ${BASELINE_IMAGE}'s only by seeding the Kotlin extension settings`, () => {
        const entrypoint = '/usr/local/bin/continuum-entrypoint.sh';
        const after = oneShot([entrypoint], { entrypoint: 'cat' }).stdout;
        const before = docker(['run', '--rm', '--network', 'none', '--entrypoint', 'cat', BASELINE_IMAGE, entrypoint]).stdout;
        if (!before || !after) { return { ok: false, detail: `could not read the entrypoint script (baseline ${before.length} bytes, image ${after.length} bytes)` }; }
        const changes = lineChanges(before, after);
        const seedsKotlin = changes.added.some((line) => line.includes('seed-kotlin-settings'));
        const onlyKotlin = changes.added.every((line) => /kotlin|seed/i.test(line));
        return { ok: changes.removed.length === 0 && seedsKotlin && onlyKotlin, detail: `removed ${changes.removed.length} line(s); added: ${changes.added.map((l) => l.slice(0, 90)).join(' | ') || 'nothing'}` };
      });
    }
  } else {
    rec.skip(group, 'the start configuration and entrypoint script are unchanged apart from the seeding', 'BASELINE_IMAGE is not set (a previous image of the same workbench)');
  }

  await rec.check(group, 'the image bundles Java 21 (java -version of the runtime under /opt/continuum/kotlin-ls/jre)', () => {
    const result = oneShot(['-version'], { entrypoint: `${KOTLIN_HOME}/jre/bin/java` });
    const version = parseJavaVersion(`${result.stdout}\n${result.stderr}`);
    return { ok: result.status === 0 && version?.major === 21, detail: version ? `${version.version}; ${version.runtime ?? ''}` : `no version in: ${(result.stderr || result.stdout).slice(0, 120)}` };
  });

  await rec.check(group, 'the Java runtime is reduced (jlink) but complete for the server: java.base and the JDK modules its libraries may touch (java.net.http, java.compiler, java.rmi, java.security.jgss) are present, there is no JDK compiler module, no javac, and no other Java on the PATH', () => {
    const modules = parseModules(oneShot(['--list-modules'], { entrypoint: `${KOTLIN_HOME}/jre/bin/java` }).stdout);
    const bin = inImage(`ls ${KOTLIN_HOME}/jre/bin | tr '\\n' ' '; echo; command -v java || echo 'no java on PATH'`).stdout;
    const required = ['java.base', 'java.net.http', 'java.compiler', 'java.rmi', 'java.security.jgss'];
    const missing = required.filter((name) => !modules.includes(name));
    const ok = missing.length === 0 && !modules.includes('jdk.compiler') && !/javac/.test(bin) && /no java on PATH/.test(bin);
    return { ok, detail: `${modules.length} modules (${modules.join(', ')}); missing: ${missing.join(', ') || 'none'}; bin: ${bin.replace(/\n/g, ' | ').trim()}` };
  });

  await rec.check(group, 'those modules export the packages that need them (java.net.http, java.rmi, javax.tools, org.ietf.jgss): the runtime can load the classes, not just list the modules', () => {
    const wanted = [['java.net.http', 'java.net.http'], ['java.rmi', 'java.rmi'], ['java.compiler', 'javax.tools'], ['java.security.jgss', 'org.ietf.jgss']];
    const described = inImage(wanted.map(([module]) => `${KOTLIN_HOME}/jre/bin/java --describe-module ${module}`).join('; ')).stdout;
    const missing = wanted.filter(([, exported]) => !new RegExp(`^exports ${exported.replace(/\./g, '\\.')}(\\s|$)`, 'm').test(described)).map(([module, exported]) => `${module} (${exported})`);
    return { ok: missing.length === 0, detail: missing.length === 0 ? wanted.map(([module, exported]) => `${module} exports ${exported}`).join('; ') : `not exported: ${missing.join(', ')}` };
  });

  await rec.check(group, 'sizes (measurement): the runtime, the server directory, the standard library repository and the image', () => {
    const stdlibGlob = `${KOTLIN_HOME}/m2/org/jetbrains/kotlin/kotlin-stdlib/*/*.jar`;
    const sizes = parseDu(inImage(`for p in ${KOTLIN_HOME} ${KOTLIN_HOME}/jre ${KOTLIN_HOME}/server ${KOTLIN_HOME}/m2 ${KOTLIN_HOME}/jre/lib/modules; do du -sm "$p"; done`).stdout);
    const bytes = inImage(`stat -c '%s %n' ${KOTLIN_HOME}/jre/lib/modules ${stdlibGlob}`).stdout.trim().split('\n').map((line) => line.split(' '));
    const jre = sizes[`${KOTLIN_HOME}/jre`];
    const baselineSize = BASELINE_IMAGE ? describeImage(JSON.parse(dockerOk(['image', 'inspect', BASELINE_IMAGE]))).sizeBytes : undefined;
    return {
      ok: jre !== undefined && jre < 100,
      detail: `kotlin-ls ${sizes[KOTLIN_HOME]} MB in total (runtime ${jre} MB of which lib/modules ${bytes[0]?.[0]} bytes, server ${sizes[`${KOTLIN_HOME}/server`]} MB, standard library repository ${sizes[`${KOTLIN_HOME}/m2`]} MB = ${bytes[1]?.[0]} bytes jar); image ${image.sizeBytes} bytes = ${megabytes(image.sizeBytes)} MB${baselineSize ? `, ${BASELINE_IMAGE} is ${baselineSize} bytes = ${megabytes(baselineSize)} MB (a different build of the workbench: that difference is not the size of the Kotlin support, the kotlin-ls folder above is)` : ''}`,
    };
  });

  await rec.check(group, 'the Kotlin standard library is installed in a Maven-layout repository (the very jar the server ships), MAVEN_REPOSITORY points at that repository, and the start launcher is installed and executable', () => {
    const version = stdlibVersion(inImage(`ls ${KOTLIN_HOME}/server/lib`).stdout);
    if (!version) { return { ok: false, detail: 'no kotlin-stdlib jar in the server\'s lib folder' }; }
    const installed = mavenStdlibPath(`${KOTLIN_HOME}/m2`, version);
    const checked = inImage(`sha256sum ${KOTLIN_HOME}/server/lib/kotlin-stdlib-${version}.jar ${installed}; test -x ${KOTLIN_HOME}/bin/kotlin-language-server && echo LAUNCHER-OK; head -n 12 ${KOTLIN_HOME}/bin/kotlin-language-server`);
    const hashes = checked.stdout.split('\n').filter((line) => /^[0-9a-f]{64} /.test(line)).map((line) => line.split(' ')[0]);
    const sameJar = hashes.length === 2 && hashes[0] === hashes[1];
    const exportsRepository = /MAVEN_REPOSITORY/.test(checked.stdout);
    const environment = image.env.MAVEN_REPOSITORY;
    return {
      ok: sameJar && checked.stdout.includes('LAUNCHER-OK') && exportsRepository && environment === `${KOTLIN_HOME}/m2`,
      detail: `kotlin-stdlib ${version}: ${sameJar ? `${installed} equals the server's own jar (${hashes[0].slice(0, 12)}…)` : `jars differ or are missing (${hashes.length} hash(es) read: ${checked.stderr.trim().slice(0, 100)})`}; launcher executable ${checked.stdout.includes('LAUNCHER-OK')}, sets MAVEN_REPOSITORY ${exportsRepository}; image ENV MAVEN_REPOSITORY=${environment}`,
    };
  });

  await rec.check(group, 'the pinned Kotlin language server is installed: the marker file holds the pinned version and SHA-256, the jar and the start script are there', () => {
    const marker = parseMarker(inImage(`cat ${KOTLIN_HOME}/server/.continuum-installed`).stdout);
    const listing = inImage(`ls ${KOTLIN_HOME}/server/lib; test -x ${KOTLIN_HOME}/server/bin/kotlin-language-server && echo START-SCRIPT-OK`).stdout;
    if (!marker) { return { ok: false, detail: 'no readable marker file server/.continuum-installed' }; }
    const hasJar = listing.includes(`server-${marker.version}.jar`);
    const matchesPin = pin ? pin.version === marker.version && pin.sha256 === marker.sha256 : undefined;
    return {
      ok: hasJar && listing.includes('START-SCRIPT-OK') && matchesPin !== false,
      detail: `${marker.version} ${marker.sha256.slice(0, 12)}…; server-${marker.version}.jar ${hasJar ? 'present' : 'MISSING'}; ${matchesPin === undefined ? `pin not compared (${pinFile} not found)` : matchesPin ? 'equals the pin in scripts/download-kotlin-ls.sh' : `DIFFERS from the pin ${pin.version} ${pin.sha256.slice(0, 12)}…`}`,
    };
  });

  await rec.check(group, 'the server\'s own start script runs on the bundled runtime (its main class starts; it rejects the unknown --version option itself)', () => {
    const result = oneShot(['--version'], { entrypoint: `${KOTLIN_HOME}/server/bin/kotlin-language-server`, env: { JAVA_HOME: `${KOTLIN_HOME}/jre` } });
    const text = `${result.stdout}\n${result.stderr}`;
    return { ok: result.status !== 0 && /main parameter|ParameterException|org\.javacs/.test(text), detail: `exit ${result.status}: ${text.trim().split('\n')[0].slice(0, 140)}` };
  });
  rec.skip(group, 'the server reports its version with --version', 'the pinned server (1.3.13) has no --version option; the version is evidenced by the jar name, the marker file and serverInfo in the bridge\'s initialize answer');

  await rec.check(group, 'the VS Code Kotlin extension (.kt/.kts files) is bundled in the plugin folder', () => {
    const listing = inImage('ls /app/plugins; cat /app/plugins/fwcd.kotlin/extension/package.json | grep -m1 \'"version"\'').stdout;
    return { ok: /fwcd\.kotlin/.test(listing) && /"version"/.test(listing), detail: listing.replace(/\n/g, ' | ').trim() };
  });
}

async function downloadGroup() {
  const group = 'download';
  const script = path.join(SOURCE_DIR, 'scripts', 'download-kotlin-ls.sh');
  if (!fs.existsSync(script)) {
    rec.skip(group, 'the installer rejects a download whose checksum is not the pinned one', `${script} not found (set WORKBENCH_SOURCE_DIR)`);
    return;
  }
  const missingTool = ['bash', 'curl', 'unzip', 'sha256sum'].find((tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status !== 0);
  if (missingTool) {
    rec.skip(group, 'the installer rejects a download whose checksum is not the pinned one', `${missingTool} is not installed on this host`);
    return;
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `${PREFIX}-download-`));
  try {
    const run = (url, destination) => spawnSync('bash', [script, destination], { encoding: 'utf8', env: { ...process.env, KOTLIN_LS_URL: url }, timeout: 60000 });
    const tampered = path.join(work, 'tampered.zip');
    fs.writeFileSync(tampered, 'this is not the pinned release\n');
    await rec.check(group, 'a download whose SHA-256 is not the pinned one is rejected: exit 1, "checksum mismatch", nothing installed', () => {
      const destination = path.join(work, 'dest-tampered');
      const result = run(`file://${tampered}`, destination);
      return { ok: result.status === 1 && /checksum mismatch/.test(result.stderr) && !fs.existsSync(path.join(destination, 'server')), detail: `exit ${result.status}; ${result.stderr.trim().slice(0, 140)}; server dir created: ${fs.existsSync(path.join(destination, 'server'))}` };
    });
    await rec.check(group, 'an unreachable download location fails the install (non-zero exit) and installs nothing', () => {
      const destination = path.join(work, 'dest-missing');
      const result = run(`file://${path.join(work, 'does-not-exist.zip')}`, destination);
      return { ok: result.status !== 0 && !fs.existsSync(path.join(destination, 'server')), detail: `exit ${result.status}; ${result.stderr.trim().slice(0, 100)}` };
    });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The seed script of the source tree, run on the host (no docker) against temporary configuration folders: the same awkward
 * settings files as in the `seed` group, so the copy `yarn start` and `yarn seed:kotlin-settings` run is checked even when no image
 * is at hand. The main case is the byte-order mark an editor on Windows puts in front of a UTF-8 file.
 */
async function seedScriptGroup() {
  const group = 'seedscript';
  const script = path.join(SOURCE_DIR, 'scripts', 'seed-kotlin-settings.js');
  if (!fs.existsSync(script)) {
    rec.skip(group, 'a settings file saved with a UTF-8 byte-order mark is seeded by the source copy of the script', `${script} not found (set WORKBENCH_SOURCE_DIR)`);
    return;
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `${PREFIX}-seedscript-`));
  const install = '/opt/systest-kotlin-ls'; // only ever written into the settings, never opened
  const mark = Buffer.from([0xef, 0xbb, 0xbf]);
  try {
    const seedWith = (name, text) => {
      const configDirectory = path.join(work, name);
      fs.mkdirSync(configDirectory, { recursive: true });
      const settingsFile = path.join(configDirectory, 'settings.json');
      fs.writeFileSync(settingsFile, text);
      const before = fs.readFileSync(settingsFile);
      const run = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 30000, env: { ...process.env, THEIA_CONFIG_DIR: configDirectory, CONTINUUM_KOTLIN_LS_HOME: install, CONTINUUM_JAVA_HOME: `${install}/jre` } });
      const readBack = (file) => { try { return fs.readFileSync(path.join(configDirectory, file)); } catch { return undefined; } };
      const after = readBack('settings.json');
      let settings = null;
      try { settings = JSON.parse(after.toString('utf8')); } catch { /* reported by the caller */ }
      let marker = false;
      try { marker = JSON.parse(readBack(path.join('globalStorage', 'fwcd.kotlin', 'config.json')).toString('utf8')).initialized === true; } catch { /* no marker */ }
      return {
        before, after, settings, marker, exit: run.status, stderr: (run.stderr ?? '').trim(),
        backup: readBack('settings.json.continuum-backup'), plantedMark: before.subarray(0, 3).equals(mark), keepsMark: after !== undefined && after.subarray(0, 3).equals(mark),
        leftovers: fs.readdirSync(configDirectory).filter((file) => file.endsWith('.tmp')),
      };
    };
    const describe = (r) => `file had the mark before: ${r.plantedMark}; exit ${r.exit}${r.stderr ? ` (${r.stderr.slice(0, 100)})` : ''}; valid JSON afterwards ${r.settings !== null}; mark still there: ${r.keepsMark}`;

    const strict = seedWith('mark-strict', `\uFEFF{"editor.fontSize": 18, "files.autoSave": "off"}`);
    await rec.check(group, 'a settings file saved with a UTF-8 byte-order mark is seeded like any other: exit 0, the mark is gone, the file is valid JSON, the user\'s keys are kept, the installation paths and the first-run marker are written', () => {
      const problems = seededSettingsProblems(strict.settings, install);
      const kept = strict.settings?.['editor.fontSize'] === 18 && strict.settings?.['files.autoSave'] === 'off';
      return { ok: strict.plantedMark && strict.exit === 0 && strict.settings !== null && !strict.keepsMark && kept && problems.length === 0 && strict.marker && strict.leftovers.length === 0, detail: `${describe(strict)}; user's keys kept ${kept}; ${problems.join('; ') || 'seeded keys right'}; first-run marker ${strict.marker}; temporary files left ${strict.leftovers.length}` };
    });

    const commentedText = '\uFEFF{\n  // my preferences\n  "editor.fontSize": 19,\n  "kotlin.java.opts": "-Xmx300m",\n}\n';
    const commented = seedWith('mark-commented', commentedText);
    await rec.check(group, 'a commented settings file saved with a byte-order mark is merged too (the mark is gone, the user\'s choices are kept) and its backup keeps the original bytes, mark included', () => {
      const problems = seededSettingsProblems(commented.settings, install);
      const kept = commented.settings?.['editor.fontSize'] === 19 && commented.settings?.['kotlin.java.opts'] === '-Xmx300m';
      const backupKept = commented.backup !== undefined && commented.backup.equals(Buffer.from(commentedText, 'utf8'));
      return { ok: commented.plantedMark && commented.exit === 0 && commented.settings !== null && !commented.keepsMark && kept && problems.length === 0 && backupKept, detail: `${describe(commented)}; user's keys kept ${kept}; ${problems.join('; ') || 'seeded keys right'}; backup ${backupKept ? `${commented.backup.length} bytes identical to the original` : `${commented.backup === undefined ? 'missing' : 'DIFFERS'}`}` };
    });

    const onlyMark = seedWith('mark-only', '\uFEFF\n');
    await rec.check(group, 'a settings file that holds nothing but a byte-order mark counts as empty: exit 0 and every default is written', () => {
      const problems = seededSettingsProblems(onlyMark.settings, install);
      return { ok: onlyMark.plantedMark && onlyMark.exit === 0 && onlyMark.settings !== null && !onlyMark.keepsMark && problems.length === 0 && onlyMark.marker, detail: `${describe(onlyMark)}; ${problems.join('; ') || 'seeded keys right'}; first-run marker ${onlyMark.marker}` };
    });

    const brokenText = '\uFEFF{ "editor.fontSize": 20,\n  "kotlin.java.opts": ';
    const broken = seedWith('mark-broken', brokenText);
    await rec.check(group, 'a settings file with a byte-order mark that is not JSON even with comments is left byte for byte as it was: exit 1, a message on stderr, no first-run marker', () => ({
      ok: broken.exit === 1 && /not valid JSON/.test(broken.stderr) && broken.after.equals(Buffer.from(brokenText, 'utf8')) && !broken.marker,
      detail: `exit ${broken.exit}; stderr: ${broken.stderr.slice(0, 120)}; file ${broken.after.equals(Buffer.from(brokenText, 'utf8')) ? 'unchanged' : 'CHANGED'}; first-run marker ${broken.marker}`,
    }));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function seedGroup() {
  const group = 'seed';
  const volume = ownedName(PREFIX, runId, 'home');
  dockerOk(['volume', 'create', volume]);
  created.volumes.add(volume);
  // A home volume from an earlier release: the user's own settings (a font size and a heap choice for the extension's server) and
  // stale values of the two installation-owned path keys (the server's own start script and a runtime that is gone).
  const stalePaths = { 'kotlin.languageServer.path': `${KOTLIN_HOME}/server/bin/kotlin-language-server`, 'kotlin.java.home': '/old/jre' };
  const earlier = JSON.stringify({ 'editor.fontSize': 20, 'kotlin.java.opts': '-Xmx256m', ...stalePaths });
  const prepared = inImage(`mkdir -p /home/continuum/.continuum && printf '%s' "$SETTINGS_TEXT" > /home/continuum/.continuum/settings.json && chown -R 1000:1000 /home/continuum`,
    { user: '0', env: { SETTINGS_TEXT: earlier }, volumes: [`${volume}:/home/continuum`] });
  if (prepared.status !== 0) { throw new Error(`could not prepare the home volume: ${prepared.stderr.trim().slice(0, 200)}`); }
  const name = startContainer('seed', { extraArgs: ['-v', `${volume}:/home/continuum`] });
  const up = await waitForBackend(name);
  await rec.check(group, 'with the home folder on a volume the container starts offline as a non-root user and the backend answers', () => {
    const uid = parseUid(exec(name, ['cat', '/proc/1/status']).stdout);
    return { ok: up !== undefined && uid === 1000, detail: `answered after ${up} s; the backend (pid 1) runs as uid ${uid}` };
  });
  const readSettings = () => { try { return JSON.parse(exec(name, ['cat', '/home/continuum/.continuum/settings.json']).stdout); } catch { return null; } };
  await rec.check(group, 'the app reads its configuration from /home/continuum/.continuum, which is where the Kotlin settings are written', () => {
    const logs = docker(['logs', name]);
    const logged = configurationDirectory(`${logs.stdout}\n${logs.stderr}`);
    const settings = readSettings();
    const problems = seededSettingsProblems(settings, KOTLIN_HOME);
    return { ok: logged === '/home/continuum/.continuum' && problems.length === 0, detail: `Theia's configuration directory: ${logged}; ${problems.join('; ') || 'kotlin.* settings point at the bundled launcher and runtime'}` };
  });
  await rec.check(group, 'the user\'s own settings survive the seeding (the font size and the heap choice for the extension\'s server) while the stale installation paths are rewritten to the launcher and the bundled runtime', () => {
    const settings = readSettings();
    const kept = settings?.['editor.fontSize'] === 20 && settings?.['kotlin.java.opts'] === '-Xmx256m';
    const rewritten = settings?.['kotlin.languageServer.path'] === `${KOTLIN_HOME}/bin/kotlin-language-server` && settings?.['kotlin.java.home'] === `${KOTLIN_HOME}/jre`;
    return { ok: kept && rewritten, detail: `editor.fontSize ${settings?.['editor.fontSize']}; kotlin.java.opts ${JSON.stringify(settings?.['kotlin.java.opts'])} (kept: ${kept}); path ${settings?.['kotlin.languageServer.path']}; java.home ${settings?.['kotlin.java.home']} (rewritten: ${rewritten})` };
  });
  await rec.check(group, 'the extension is marked as initialised (no first-run download prompt) and the seeded paths exist and run', () => {
    const marker = exec(name, ['cat', '/home/continuum/.continuum/globalStorage/fwcd.kotlin/config.json']).stdout;
    const settings = readSettings();
    const script = exec(name, ['test', '-x', String(settings?.['kotlin.languageServer.path'])]).status === 0;
    const java = exec(name, ['test', '-x', `${settings?.['kotlin.java.home']}/bin/java`]).status === 0;
    let initialised = false;
    try { initialised = JSON.parse(marker).initialized === true; } catch { /* leave false */ }
    return { ok: initialised && script && java, detail: `config.json ${marker.trim().slice(0, 40)}; start script executable ${script}; java executable ${java}` };
  });
  await rec.check(group, 'restarting the container seeds again without losing anything (the seeding is repeatable)', async () => {
    dockerOk(['restart', '-t', '5', name], { timeoutMs: 60000 });
    const again = await waitForBackend(name);
    const settings = readSettings();
    return { ok: again !== undefined && settings?.['editor.fontSize'] === 20 && settings?.['kotlin.java.opts'] === '-Xmx256m' && seededSettingsProblems(settings, KOTLIN_HOME).length === 0, detail: `answered again after ${again} s` };
  });
  removeContainer(name);
  removeVolume(volume);
  // A first start: no settings file at all. Every default is written, the heap flags of the extension's server included.
  const fresh = inImage('node /opt/continuum/seed-kotlin-settings.js; echo "exit=$?"; cat "$HOME/.continuum/settings.json"', { env: { HOME: '/tmp/fresh-home' } });
  await rec.check(group, 'a first start with no settings file writes every default: the launcher, the bundled runtime and the extension server\'s heap flags', () => {
    const text = fresh.stdout.replace(/^exit=\d+\n/, '');
    let settings = null;
    try { settings = JSON.parse(text); } catch { /* reported below */ }
    const problems = seededSettingsProblems(settings, KOTLIN_HOME);
    const flags = settings?.['kotlin.java.opts'];
    return { ok: /exit=0/.test(fresh.stdout) && problems.length === 0 && /-Xmx512m/.test(String(flags)), detail: `${problems.join('; ') || 'defaults right'}; kotlin.java.opts ${JSON.stringify(flags)}` };
  });
  await seedEdgeCases(group);
}

/** The seed script itself, run in throwaway containers on home volumes prepared with awkward settings files. */
async function seedEdgeCases(group) {
  const home = '/home/continuum';
  const configDirectory = `${home}/.continuum`;
  const prepareVolume = (role, settingsText) => {
    const volume = ownedName(PREFIX, runId, role);
    dockerOk(['volume', 'create', volume]);
    created.volumes.add(volume);
    const prepared = inImage(`mkdir -p ${configDirectory} && printf '%s' "$SETTINGS_TEXT" > ${configDirectory}/settings.json && chown -R 1000:1000 ${home}`,
      { user: '0', env: { SETTINGS_TEXT: settingsText }, volumes: [`${volume}:${home}`] });
    if (prepared.status !== 0) { throw new Error(`could not prepare the ${role} volume: ${prepared.stderr.trim().slice(0, 200)}`); }
    return volume;
  };
  const withVolume = (volume) => ({ env: { HOME: home }, volumes: [`${volume}:${home}`] });
  const runSeed = (volume) => {
    const result = inImage('node /opt/continuum/seed-kotlin-settings.js; echo "exit=$?"', withVolume(volume));
    return { exit: Number(/exit=(\d+)/.exec(result.stdout)?.[1]), stderr: result.stderr.trim(), stdout: result.stdout };
  };
  const read = (volume, command) => inImage(command, withVolume(volume)).stdout;
  const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
  const listing = (volume) => read(volume, `cd ${configDirectory} && find . -type f | sort`).trim().split('\n');

  const original = '{\n  // my editor preferences\n  "editor.fontSize": 22, /* big */\n  "files.autoSave": "afterDelay",\n  "kotlin.java.opts": "-Xmx256m",\n  "note": "http://example.test/a//b", // the // inside the string is not a comment\n}\n';
  const jsonc = prepareVolume('seedjsonc', original);
  const first = runSeed(jsonc);
  const settings = parse(read(jsonc, `cat ${configDirectory}/settings.json`));
  const backup = read(jsonc, `cat ${configDirectory}/settings.json.continuum-backup`);
  await rec.check(group, 'a settings file with comments and trailing commas is merged, not discarded: the user\'s keys and choices are kept (also a string holding //), the file becomes plain JSON, the installation paths follow the install', () => {
    const problems = seededSettingsProblems(settings, KOTLIN_HOME);
    const kept = settings?.['editor.fontSize'] === 22 && settings?.['files.autoSave'] === 'afterDelay' && settings?.note === 'http://example.test/a//b' && settings?.['kotlin.java.opts'] === '-Xmx256m';
    return { ok: first.exit === 0 && settings !== null && kept && problems.length === 0, detail: `exit ${first.exit}${first.stderr ? ` (${first.stderr.slice(0, 120)})` : ''}; kept the user's keys ${kept}; ${problems.join('; ') || 'seeded keys right'}; parsed as plain JSON ${settings !== null}` };
  });
  await rec.check(group, 'the original of a commented settings file is kept once, byte for byte, as settings.json.continuum-backup', () => ({
    ok: backup === original, detail: backup === original ? `${backup.length} bytes identical` : `backup ${backup.length} bytes vs original ${original.length}: ${backup.slice(0, 60).replace(/\n/g, '\\n')}`,
  }));
  const files = listing(jsonc);
  const second = runSeed(jsonc);
  const settingsAgain = read(jsonc, `cat ${configDirectory}/settings.json`);
  const backupAgain = read(jsonc, `cat ${configDirectory}/settings.json.continuum-backup`);
  await rec.check(group, 'running the seed again changes nothing: same settings bytes, the first backup is not overwritten, and no temporary file is left behind', () => ({
    ok: second.exit === 0 && settingsAgain === `${JSON.stringify(settings, undefined, 2)}\n` && backupAgain === original && !listing(jsonc).some((file) => file.endsWith('.tmp')),
    detail: `exit ${second.exit}; files: ${files.join(' ')}; settings ${settingsAgain === `${JSON.stringify(settings, undefined, 2)}\n` ? 'identical' : 'CHANGED'}; backup ${backupAgain === original ? 'identical' : 'CHANGED'}`,
  }));

  const broken = '{ "editor.fontSize": 20,\n  "kotlin.java.opts": ';
  const unreadable = prepareVolume('seedbroken', broken);
  const refused = runSeed(unreadable);
  await rec.check(group, 'a settings file that is not JSON even with comments is left byte for byte as it was: exit 1, a message on stderr, and no first-run marker', () => {
    const after = read(unreadable, `cat ${configDirectory}/settings.json`);
    const marker = read(unreadable, `ls ${configDirectory}/globalStorage 2>&1`);
    return { ok: refused.exit === 1 && /not valid JSON/.test(refused.stderr) && after === broken && !/fwcd/.test(marker), detail: `exit ${refused.exit}; stderr: ${refused.stderr.slice(0, 140)}; file ${after === broken ? 'unchanged' : `CHANGED to ${after.slice(0, 40)}`}; marker dir: ${marker.trim().slice(0, 60) || 'none'}` };
  });
  const container = startContainer('seedbroken', { extraArgs: ['-v', `${unreadable}:${home}`] });
  const answered = await waitForBackend(container);
  await rec.check(group, 'a container whose settings file cannot be read still starts and serves (the entrypoint logs "could not seed" and goes on)', () => {
    const log = docker(['logs', container]);
    return { ok: answered !== undefined && /could not seed the Kotlin extension settings/.test(`${log.stdout}\n${log.stderr}`), detail: `answered after ${answered} s; log mentions the seeding problem ${/could not seed/.test(`${log.stdout}\n${log.stderr}`)}` };
  });
  removeContainer(container);

  // An editor on Windows saves UTF-8 with a byte-order mark (the bytes EF BB BF), which JSON.parse rejects. The mark must neither
  // keep the seeding from running nor survive it: the file is read by the app's own settings reader afterwards.
  const settingsFile = `${configDirectory}/settings.json`;
  const startsWithMark = (volume, file) => read(volume, `head -c 3 ${file} | od -An -tx1`).trim() === 'ef bb bf';
  const hexOf = (volume, file) => read(volume, `od -An -tx1 -v ${file} | tr -d ' \\n'`);
  const markerWritten = (volume) => parse(read(volume, `cat ${configDirectory}/globalStorage/fwcd.kotlin/config.json`))?.initialized === true;

  const bomText = '\uFEFF{"editor.fontSize": 18, "files.autoSave": "off"}';
  const bom = prepareVolume('seedbom', bomText);
  const bomPlanted = startsWithMark(bom, settingsFile);
  const withBom = runSeed(bom);
  await rec.check(group, 'a settings file saved with a UTF-8 byte-order mark is seeded like any other: exit 0, the mark is gone, the file is valid JSON, the user\'s keys are kept, the installation paths and the first-run marker are written', () => {
    const after = parse(read(bom, `cat ${settingsFile}`));
    const problems = seededSettingsProblems(after, KOTLIN_HOME);
    const kept = after?.['editor.fontSize'] === 18 && after?.['files.autoSave'] === 'off';
    const markGone = !startsWithMark(bom, settingsFile);
    return {
      ok: bomPlanted && withBom.exit === 0 && after !== null && markGone && kept && problems.length === 0 && markerWritten(bom),
      detail: `file had the mark before: ${bomPlanted}; exit ${withBom.exit}${withBom.stderr ? ` (${withBom.stderr.slice(0, 120)})` : ''}; valid JSON afterwards ${after !== null}; mark gone ${markGone}; user's keys kept ${kept}; ${problems.join('; ') || 'seeded keys right'}; first-run marker ${markerWritten(bom)}`,
    };
  });

  // The same mark in front of a commented file: the lenient reading must cope with it too, and the backup keeps the original bytes.
  const bomCommented = `\uFEFF{\n  // my preferences\n  "editor.fontSize": 19,\n  "kotlin.java.opts": "-Xmx300m",\n}\n`;
  const bomJsonc = prepareVolume('seedbomjsonc', bomCommented);
  const bomJsoncPlanted = startsWithMark(bomJsonc, settingsFile);
  const withBomJsonc = runSeed(bomJsonc);
  await rec.check(group, 'a commented settings file saved with a byte-order mark is merged too (the mark is gone, the user\'s choices are kept) and its backup keeps the original bytes, mark included', () => {
    const after = parse(read(bomJsonc, `cat ${settingsFile}`));
    const problems = seededSettingsProblems(after, KOTLIN_HOME);
    const kept = after?.['editor.fontSize'] === 19 && after?.['kotlin.java.opts'] === '-Xmx300m';
    const backupHex = hexOf(bomJsonc, `${settingsFile}.continuum-backup`);
    const originalHex = Buffer.from(bomCommented, 'utf8').toString('hex');
    return {
      ok: bomJsoncPlanted && withBomJsonc.exit === 0 && after !== null && !startsWithMark(bomJsonc, settingsFile) && kept && problems.length === 0 && backupHex === originalHex,
      detail: `file had the mark before: ${bomJsoncPlanted}; exit ${withBomJsonc.exit}${withBomJsonc.stderr ? ` (${withBomJsonc.stderr.slice(0, 120)})` : ''}; valid JSON afterwards ${after !== null}; user's keys kept ${kept}; ${problems.join('; ') || 'seeded keys right'}; backup ${backupHex === originalHex ? `${originalHex.length / 2} bytes identical to the original` : `DIFFERS (${backupHex.slice(0, 24)}... vs ${originalHex.slice(0, 24)}...)`}`,
    };
  });

  // End to end through the entrypoint: a container whose home volume holds such a file starts, seeds it and serves.
  const bomBoot = prepareVolume('seedbomboot', bomText);
  const bomBootPlanted = startsWithMark(bomBoot, settingsFile);
  const bootContainer = startContainer('seedbomboot', { extraArgs: ['-v', `${bomBoot}:${home}`] });
  const bootAnswered = await waitForBackend(bootContainer);
  await rec.check(group, 'a container whose settings file starts with a byte-order mark seeds it on start (no "could not seed" in its log), serves, and leaves a valid mark-free settings file with the user\'s keys', () => {
    const log = docker(['logs', bootContainer]);
    const logged = `${log.stdout}\n${log.stderr}`;
    const text = exec(bootContainer, ['cat', settingsFile]).stdout;
    const after = parse(text);
    const problems = seededSettingsProblems(after, KOTLIN_HOME);
    const markGone = text.length > 0 && !text.startsWith('\uFEFF');
    return {
      ok: bomBootPlanted && bootAnswered !== undefined && !/could not seed/.test(logged) && after !== null && markGone && after['editor.fontSize'] === 18 && problems.length === 0,
      detail: `file had the mark before: ${bomBootPlanted}; the backend answered after ${bootAnswered} s; "could not seed" in the log: ${/could not seed/.test(logged)}; valid JSON afterwards ${after !== null}; mark gone ${markGone}; fontSize ${after?.['editor.fontSize']}; ${problems.join('; ') || 'seeded keys right'}`,
    };
  });
  removeContainer(bootContainer);
  [jsonc, unreadable, bom, bomJsonc, bomBoot].forEach(removeVolume);
}

/**
 * The server's start launcher, driven over stdio the way an editor extension starts it: no bridge, a minimal environment (no
 * MAVEN_REPOSITORY), no network, the backend's user. The standard library must be found through the launcher alone.
 */
async function launcherGroup() {
  const group = 'launcher';
  const project = '/tmp/lsproj';
  const line = 'val s = "abc".le';
  const launch = async (role, serverCommand) => {
    const name = ownedName(PREFIX, runId, role);
    created.containers.add(name);
    const script = `mkdir -p ${project} && cd ${project} && printf '%s\\n' '${line}' > a.kt && exec env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp JAVA_HOME=${KOTLIN_HOME}/jre ${serverCommand}`;
    const child = spawn('docker', ['run', '--rm', '-i', '--name', name, '--network', 'none', '--user', `${BACKEND_UID}:${BACKEND_UID}`, '--entrypoint', 'sh', IMAGE, '-c', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const client = new StdioLspClient({ stdin: child.stdin, stdout: child.stdout }, { timeoutMs: 120000 });
    const outcome = {};
    try {
      const started = Date.now();
      outcome.init = await client.request('initialize', { processId: null, rootUri: `file://${project}`, capabilities: {} }, { timeoutMs: 120000 });
      outcome.initMs = Date.now() - started;
      client.notify('initialized', {});
      const uri = `file://${project}/a.kt`;
      client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'kotlin', version: 1, text: `${line}\n` } });
      outcome.completion = await client.request('textDocument/completion', { textDocument: { uri }, position: { line: 0, character: line.length } }, { timeoutMs: 120000 });
      await client.request('shutdown', null, { timeoutMs: 20000 }).catch(() => undefined);
      client.notify('exit', null);
    } catch (error) {
      outcome.error = error.message;
    } finally {
      child.stdin.end();
      await new Promise((resolve) => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 10000); child.on('close', () => { clearTimeout(timer); resolve(); }); });
      removeContainer(name);
    }
    outcome.stderr = stderr.trim();
    const items = Array.isArray(outcome.completion?.result) ? outcome.completion.result : outcome.completion?.result?.items ?? [];
    outcome.names = items.map((item) => String(item.label).replace(/\(.*$/s, ''));
    return outcome;
  };

  const viaLauncher = await launch('launcher', `${KOTLIN_HOME}/bin/kotlin-language-server`);
  await rec.check(group, 'the launcher, started with a minimal environment and no network, speaks LSP over stdio: initialize is answered with the server\'s capabilities', () => ({
    ok: Boolean(viaLauncher.init?.result?.capabilities), detail: viaLauncher.error ?? `${viaLauncher.init.result.serverInfo?.name} ${viaLauncher.init.result.serverInfo?.version} answered in ${viaLauncher.initMs} ms; ${viaLauncher.stderr.split('\n').slice(0, 2).join(' | ').slice(0, 160)}`,
  }));
  await rec.check(group, 'through the launcher alone the standard library is found: `"abc".le` completes with the String members length and let', () => ({
    ok: viaLauncher.names.includes('length') && viaLauncher.names.includes('let'),
    detail: viaLauncher.error ?? `${viaLauncher.names.length} items in ${viaLauncher.completion.ms} ms${viaLauncher.names.length < 20 ? `: ${viaLauncher.names.join(', ')}` : ''}`,
  }));
  const direct = await launch('direct', `${KOTLIN_HOME}/server/bin/kotlin-language-server`);
  rec.record(group, 'control (measurement): the server\'s own start script without the launcher and without MAVEN_REPOSITORY', true,
    direct.error ?? `${direct.names.length} items for "abc".le${direct.names.includes('let') ? ' (the standard library was found anyway)' : ' (no standard library: this is why the extension must start the launcher)'}`);
}

async function asisGroup() {
  const group = 'asis';
  const phase = await bridgePhase('asis');
  if (!phase.failedToStart) {
    const name = phase.name;
    await rec.check(group, 'the container has no network: only the loopback interface exists, and it runs as uid 1000', () => {
      const interfaces = exec(name, ['ls', '/sys/class/net']).stdout.trim().split(/\s+/);
      const mode = docker(['inspect', '-f', '{{.HostConfig.NetworkMode}}', name]).stdout.trim();
      return { ok: mode === 'none' && interfaces.length === 1 && interfaces[0] === 'lo', detail: `network mode ${mode}; interfaces: ${interfaces.join(', ')}` };
    });
  }
  recordBridgePhase(group, 'as shipped', phase);
  return phase;
}

/**
 * Puts the standard library into the Maven-layout repository of a running container (the image ships it there already; this is
 * the repair a packaging regression would need, so the experiment below can tell "no library" from every other failure).
 */
function installStdlib(container) {
  const version = stdlibVersion(exec(container, ['ls', `${KOTLIN_HOME}/server/lib`]).stdout);
  if (!version) { throw new Error('no kotlin-stdlib jar in the server\'s lib folder'); }
  const destination = mavenStdlibPath(`${KOTLIN_HOME}/m2`, version);
  dockerOk(['exec', '-u', '0', container, 'sh', '-c', `mkdir -p "$(dirname ${destination})" && cp ${KOTLIN_HOME}/server/lib/kotlin-stdlib-${version}.jar ${destination}`]);
}
const stdlibEnv = { MAVEN_REPOSITORY: `${KOTLIN_HOME}/m2` };

async function experimentGroup(asis) {
  const group = 'experiment';
  if (!asis || asis.failedToStart || asis.results.every((r) => r.status !== 'FAIL')) {
    rec.skip(group, 'with the standard library reachable the failures of the shipped image disappear', 'not needed: the shipped image had no failing check (or did not run)');
    return;
  }
  const phase = await bridgePhase('m2', { env: stdlibEnv, setup: installStdlib });
  recordBridgePhase(group, 'stdlib in a Maven-layout folder + MAVEN_REPOSITORY', phase);
  if (phase.failedToStart || !phase.summary) { return; }
  const difference = compareFailures(asis.results, phase.results);
  rec.record(group, 'placing the Kotlin standard library in a Maven-layout folder introduces no failure (measurement: what it fixes, what persists)', difference.introduced.length === 0,
    `newly failing: ${difference.introduced.join(' | ') || 'none'}; fixed ${difference.fixed.length}: ${difference.fixed.join(' | ').slice(0, 500) || 'none'}; still failing in both (not caused by the library): ${difference.persisting.join(' | ').slice(0, 300) || 'none'}`);
}

async function defaultIdleGroup() {
  const group = 'default-idle';
  const phase = await bridgePhase('idle', { idleSeconds: null, suiteEnv: { ONLY: 'lifecycle', IDLE_TIMEOUT_SECONDS: '600', IDLE_CHECKS: 'vanished' } });
  recordBridgePhase(group, 'production default idle timeout (600 s)', phase);
}

async function exhaustionGroup() {
  const group = 'exhaustion';
  const phase = await bridgePhase('exhaust', { suiteEnv: { ONLY: 'exhaustion' } });
  recordBridgePhase(group, 'scripts open at once until the server\'s heap is full, then what the bridge does', phase);
}

async function podLimitGroup() {
  const group = 'pod-limit';
  for (const gib of POD_LIMITS_GIB) {
    const limits = ['--memory', `${gib}g`, '--memory-swap', `${gib}g`];
    const typical = await bridgePhase(`pod${gib}`, { containerArgs: limits, suiteEnv: { ONLY: 'diagnostics,memory' } });
    recordBridgePhase(group, `container limited to ${gib} GiB: one and five editors`, typical);
    const heavy = await bridgePhase(`pod${gib}-exhaust`, { containerArgs: limits, suiteEnv: { ONLY: 'exhaustion' } });
    recordBridgePhase(group, `container limited to ${gib} GiB: scripts opened one after the other until the server fails, then what the bridge does`, heavy);
  }
}

// ---- main --------------------------------------------------------------------------------------------------------------
if (!IMAGE) {
  console.error('IMAGE is not set. Example: IMAGE=projectcontinuum/continuum-workbench:0.0.16 node suites/api/kotlin-lsp-image.mjs');
  process.exit(2);
}
const version = docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 20000 });
if (version.status !== 0) {
  console.log(`ENV: docker is not available (${(version.stderr || version.error || '').trim().slice(0, 120)}) - SETUP.md §1\n0 passed, 0 failed, 1 skipped (NOT VERIFIED), 0 known gaps, 1 checks`);
  process.exit(0);
}
const present = docker(['image', 'inspect', '--format', '{{.Size}}', IMAGE]);
if (present.status !== 0) {
  console.error(`The image ${IMAGE} does not exist locally; build or pull it first.`);
  process.exit(2);
}
process.on('SIGINT', () => { cleanUp(); process.exit(130); });
console.log(`kotlin-lsp-image  ${IMAGE} (${megabytes(Number(present.stdout))} MB)  run ${runId}  docker ${version.stdout.trim()}  baseline ${BASELINE_IMAGE ?? 'none'}`);
try {
  if (wants('image')) { await imageGroup(); }
  if (wants('download')) { await downloadGroup(); }
  if (wants('launcher')) { await launcherGroup(); }
  if (wants('seedscript')) { await seedScriptGroup(); }
  if (wants('seed')) { await seedGroup(); }
  let asis;
  if (wants('asis') || wants('experiment')) {
    if (wants('asis')) {
      asis = await asisGroup();
    } else {
      asis = await bridgePhase('asis');
    }
  }
  if (wants('experiment')) { await experimentGroup(asis); }
  if (wants('default-idle')) { await defaultIdleGroup(); }
  if (wants('exhaustion')) { await exhaustionGroup(); }
  if (wants('pod-limit')) { await podLimitGroup(); }
} catch (error) {
  rec.record('suite', 'the suite ran to the end', false, error?.stack ?? String(error));
} finally {
  cleanUp();
}
const summary = rec.summary();
console.log(`\n${summary.pass} passed, ${summary.fail} failed, ${summary.skip} skipped (NOT VERIFIED), ${summary.knownGap} known gaps, ${summary.total} checks`);
process.exit(rec.exitCode());
