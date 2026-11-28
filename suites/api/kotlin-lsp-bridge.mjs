#!/usr/bin/env node
// Black-box checks of the workbench's language-server bridge (the Kotlin Script editor's code intelligence), over the wire.
// It talks to a running workbench backend like the browser does, with no browser and no platform code imported:
//   1. GET / for the `theia-connection-token` cookie (Theia refuses a WebSocket upgrade without it),
//   2. a WebSocket to /socket.io (Engine.IO v4) carrying Socket.IO's `/services` namespace and Theia's `initialConnection`,
//   3. Theia's channel multiplexer: one channel per editor, path `/services/language-server/<id>` (id `kotlin-script`),
//      one JSON-RPC message per string on that channel.
// The framings are implemented in lib/theia-wire.mjs, lib/ws-frames.mjs and lib/theia-client.mjs (unit-tested).
//
// What it proves
//   handshake    the bridge is reachable only through Theia's own token + origin checks
//   offline      (--offline) the run happens with no outbound network, i.e. everything the server needs is bundled
//   lifecycle    no server process before the first editor, exactly one for any number of editors (also when they connect
//                at the same instant), reuse by later editors, stop after the idle timeout (also when a client just
//                vanishes), a fresh process on the next connection
//   packaging    (EXPECT_LS_HOME) the server and its Java runtime come from the bundled install directory
//   coldwindow   (needs IDLE_TIMEOUT_SECONDS) a script opened at several moments around the instant a cold server becomes
//                ready (0 ms ... 1.5 s after it) gets its diagnostics, and the first edit after that is applied, not dropped
//                (diagnostics and completion follow the new text; typing a mistake into a clean script as the first edit
//                is diagnosed at the typed line)
//   diagnostics  a type error is reported at the user's line and column, the documented clean script produces no
//                diagnostics, completion/hover/signature help work for `row`, `flow` and the stdlib; `initialize` promises
//                only features the bridge serves
//   documents    one owner per document, ownership released on close/disconnect, diagnostics never cross connections
//   context      the reported names as a hidden context document opened before the script: `flow.` completes get/set/all, hover
//                shows the KDoc, a type mismatch and a valid script are diagnosed as they should be, two contexts with the
//                same type name are isolated, a context document is refused for a non-virtual URI and is freed on close
//   security     unknown language ids are refused; only virtual `continuum-script:/<key>.kt` documents are accepted (never a
//                `file:` path, whatever the spelling); only the documented methods pass; malformed input is harmless;
//                the server runs in its private directory
//   leak         (LEAK_PROBE_DIR) a Kotlin file planted in a folder the backend might offer as a workspace stays invisible
//   memory       the server's resident memory stays under the restart ceiling for one editor and for a handful of editors at
//                once, every answer is served without error, and it runs with -Xmx
//   exhaustion   (opt-in: ONLY=exhaustion, it overloads the server on purpose) how many scripts can be open at once before
//                the server's heap runs out; then, with requests still coming the way an editor sends them, whether the
//                bridge replaces the failing server, which state it ends in (serving again, or unavailable), the memory of
//                every server process of the run, and whether closing the scripts brings a working server back
//   protocol     only state notices, diagnostics and responses ever reach a client
//
// Run (workbench backend serving the language-server bridge; no platform stack needed):
//   WORKBENCH_URL=http://127.0.0.1:3002 IDLE_TIMEOUT_SECONDS=15 node suites/api/kotlin-lsp-bridge.mjs [--offline]
// Needs Node 20+ and nothing else. Exit code 1 when any check FAILs; SKIP lines say what could not be checked and why.
//
// Env
//   WORKBENCH_URL          base URL of the backend (default http://127.0.0.1:3002).
//   BACKEND_PID            pid of the backend whose child processes are counted. Default: the process that listens on the
//                          port of WORKBENCH_URL, which is only visible when the suite runs on the backend's host or in its
//                          container (see suites/api/kotlin-lsp-image.mjs); otherwise the process checks are SKIPped.
//   IDLE_TIMEOUT_SECONDS   the CONTINUUM_LANGUAGE_SERVER_IDLE_TIMEOUT_SECONDS the backend runs with (image default 600). Start
//                          a backend with a small value (15) to let the idle-stop checks finish quickly; unset = SKIPped.
//                          With the default (600) the lifecycle group takes 10 minutes per idle wait: IDLE_CHECKS=vanished
//                          leaves out the second wait (values: vanished, orderly; default both).
//   LS_MEMORY_LIMIT_MB     restart ceiling the bridge enforces (default 1000); LS_XMX_MB expected -Xmx (default 512).
//   EXPECT_LS_HOME         install directory the server and its runtime must run from (image: /opt/continuum/kotlin-ls).
//   LEAK_PROBE_DIR         comma-separated folders the backend might wrongly offer as a workspace (image: the Theia workspace
//                          folder and /app, the backend's working directory). The suite drops a Kotlin file into each and
//                          checks the server cannot see it; the files are removed afterwards.
//   START_TIMEOUT_SECONDS  how long a cold server may take to become ready (default 90). ONLY=<group>[,<group>] runs groups.
//   LS_OPEN_DOCUMENTS      scripts open at once in the `memory` group's several-editors check (default 5).
//   EXHAUSTION_DOCUMENTS   upper bound of the `exhaustion` group (default 24).
//   EXHAUSTION_WATCH_SECONDS  how long the `exhaustion` group keeps asking like an editor after the first failed answer,
//                          waiting for a replacement or a verdict (default 420).
//   EXHAUSTION_SOAK_SECONDS  when the replaced server serves again: how long the `exhaustion` group then keeps the editors
//                          typing (a full-text change of one open script and a completion, about once a second) to see
//                          whether the replacement keeps up or fails again (default 0 = not done).
//   COLDWINDOW_OFFSETS_MS  the moments, in ms after a cold server became ready, at which the `coldwindow` group opens a script
//                          (default 0,150,400,490,510,700,1500: the bridge re-sends the open documents 500 ms after ready).
// Test data: documents are named `systest-<runId>-<n>` and live only in the server's memory; everything is closed at the end.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { TheiaConnection, fetchConnectionCookie, openWebSocket } from '../../lib/theia-client.mjs';
import { LspSession } from '../../lib/lsp-session.mjs';
import { weaveScript, userDiagnostics, documentUri, contextDocument, reportedContextFromFeatureSource } from '../../lib/kotlin-script.mjs';
import { advertisedFeatures, workspacePromises, promisesBeyond, probeParams } from '../../lib/lsp-capabilities.mjs';
import { findListenerPid, kotlinServersUnder, readProcess, readCwd } from '../../lib/proc-info.mjs';
import { createRecorder } from '../../lib/runner.mjs';

const BASE = process.env.WORKBENCH_URL || 'http://127.0.0.1:3002';
const args = process.argv.slice(2);
const OFFLINE = args.includes('--offline') || process.env.OFFLINE === '1';
const ONLY = (process.env.ONLY || '').split(',').map((part) => part.trim()).filter(Boolean);
const IDLE_SECONDS = process.env.IDLE_TIMEOUT_SECONDS ? Number(process.env.IDLE_TIMEOUT_SECONDS) : undefined;
const IDLE_CHECKS = (process.env.IDLE_CHECKS || 'vanished,orderly').split(',').map((part) => part.trim()).filter(Boolean);
const MEMORY_LIMIT_MB = Number(process.env.LS_MEMORY_LIMIT_MB || 1000);
const XMX_MB = Number(process.env.LS_XMX_MB || 512);
const EXPECT_LS_HOME = process.env.EXPECT_LS_HOME;
const LEAK_PROBE_DIRS = (process.env.LEAK_PROBE_DIR || '').split(',').map((part) => part.trim()).filter(Boolean);
const START_TIMEOUT_MS = Number(process.env.START_TIMEOUT_SECONDS || 90) * 1000;
const SEVERAL_EDITORS = Number(process.env.LS_OPEN_DOCUMENTS || 5);
const EXHAUSTION_LIMIT = Number(process.env.EXHAUSTION_DOCUMENTS || 24);
const EXHAUSTION_WATCH_MS = Number(process.env.EXHAUSTION_WATCH_SECONDS || 420) * 1000;
const EXHAUSTION_SOAK_MS = Number(process.env.EXHAUSTION_SOAK_SECONDS || 0) * 1000;
const COLDWINDOW_OFFSETS = (process.env.COLDWINDOW_OFFSETS_MS || '0,150,400,490,510,700,1500').split(',').map((part) => Number(part.trim())).filter((ms) => Number.isFinite(ms) && ms >= 0);
const NUDGE_DELAY_MS = 500; // the documented delay after `ready` at which the bridge re-sends the open documents
const COLD_MANY_DOCUMENTS = 3; // scripts opened one after another while a cold server starts (`coldwindow` group)
const coldManyName = () => `${COLD_MANY_DOCUMENTS} scripts opened one after another while a cold server is still starting all get their diagnostics (within 10 s of ready)`;
const TYPED_ERROR_NAME = 'typing a mistake into a clean script as the first edit after the bridge re-sent the open documents is diagnosed at the typed line (document version 2, as an editor numbers it)';
/** The request methods the bridge forwards (the documented set); `initialize` must not promise anything beyond them. */
const SERVED_METHODS = ['textDocument/completion', 'textDocument/hover', 'textDocument/signatureHelp', 'textDocument/definition', 'textDocument/typeDefinition',
  'textDocument/references', 'textDocument/documentHighlight', 'textDocument/documentSymbol'];
const runId = Date.now().toString(36);
const key = (name) => `systest-${runId}-${name}`;
// What the Kotlin Script node reports about its names, built from the real source of its API (sibling repo continuum-feature-base).
const REPORTED = reportedContextFromFeatureSource();
const LANGUAGE = 'kotlin-script';
const channelPath = (id) => `/services/language-server/${id}`;

const rec = createRecorder({ only: ONLY });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const secondsSince = (t) => Math.round((Date.now() - t) / 100) / 10;

async function until(predicate, timeoutMs, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await sleep(stepMs);
  }
  return Boolean(await predicate());
}

// ---- which backend process are we looking at ---------------------------------------------------------------------------
const port = Number(new URL(BASE).port || (new URL(BASE).protocol === 'https:' ? 443 : 80));
const backendPid = process.env.BACKEND_PID ? Number(process.env.BACKEND_PID) : findListenerPid(port);
const backendProcess = backendPid ? readProcess(backendPid) : undefined;
const processesVisible = Boolean(backendProcess) && (Boolean(process.env.BACKEND_PID) || /backend[/\\]main\.js|theia/.test(backendProcess.cmdline.join(' ')));
const servers = () => (processesVisible ? kotlinServersUnder(backendPid) : []);
const NO_PROCESS_VIEW = `the backend's processes are not visible from here (listener of port ${port}: ${backendProcess ? backendProcess.cmdline.join(' ').slice(0, 80) : 'none found'}); run the suite on the backend's host or in its container, or set BACKEND_PID`;

// ---- sessions ----------------------------------------------------------------------------------------------------------
const connections = [];
const sessions = [];

async function startSession(id = LANGUAGE, { timeoutMs } = {}) {
  const connection = await TheiaConnection.connect(BASE, { timeoutMs });
  connections.push(connection);
  const channel = await connection.openChannel(channelPath(id));
  const lsp = new LspSession(channel);
  sessions.push(lsp);
  return { connection, channel, lsp };
}

/** Waits for `ready`, then does the client handshake; resolves the `initialize` response. */
async function becomeReady(lsp) {
  await lsp.waitForState('ready', { timeoutMs: START_TIMEOUT_MS });
  return lsp.initialize();
}

/**
 * Does what the editor does before it opens a script: opens the hidden context document (own namespace per connection: one
 * connection alone may own a document URI), waits for the server to answer a request on it, and remembers it for `weave`.
 */
let contextCounter = 0;
async function openContext(lsp, context = REPORTED.context) {
  const namespace = `ctxsystest${runId}s${++contextCounter}`;
  const doc = contextDocument(context, namespace);
  lsp.open(doc.uri, doc.text);
  await lsp.request('textDocument/documentSymbol', { textDocument: { uri: doc.uri } });
  lsp.scriptContext = { context, namespace, uri: doc.uri };
  return lsp.scriptContext;
}

/** The script document as the editor shows it to the server, for the context this session opened (none: plain wrapper). */
const weave = (lsp, userText, documentKey) => weaveScript(userText, documentKey, '.kt', lsp.scriptContext);

function openScript(lsp, name, userText, version = 1) {
  const woven = weave(lsp, userText, key(name));
  lsp.open(woven.uri, woven.text, { version });
  return woven;
}

/** Completion labels carry the signature (`get(name: String)`); the member name is what the editor inserts. */
const memberNames = (result) => (Array.isArray(result) ? result : result?.items ?? []).map((item) => String(item.label).replace(/\(.*$/s, ''));
const isRefusal = (response, method) => response.error?.code === -32602 && (method === undefined || String(response.error.message).includes(method));
const rssMb = (pid) => { const info = readProcess(pid); return info?.vmRssKb ? Math.round(info.vmRssKb / 1024) : undefined; };

async function outboundReachable() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '1.1.1.1', port: 443 });
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 3000);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

let privateDirectory;
let coldStart; // { readyMs, rssAfterReadyMb } of the first server this run started, when the run saw it start
function rememberPrivateDirectory() {
  const [server] = servers();
  privateDirectory = privateDirectory ?? (server ? readCwd(server.pid) : undefined);
  return privateDirectory;
}

// ---- groups ------------------------------------------------------------------------------------------------------------
async function handshakeGroup() {
  const group = 'handshake';
  const socketUrl = new URL('/socket.io/?EIO=4&transport=websocket', BASE).href;
  const refusal = async (headers) => openWebSocket(socketUrl, { headers, timeoutMs: 5000 }).then((ws) => { ws.destroy(); return undefined; }, (error) => error);
  await rec.check(group, 'a client with the connection-token cookie completes the Theia handshake and the bridge channel opens', async () => {
    const { connection, channel } = await startSession();
    const detail = `Engine.IO sid ${connection.engineInfo?.sid}, channel ${channel.id} acknowledged`;
    connection.close();
    return detail;
  });
  await rec.check(group, 'a WebSocket upgrade without the connection-token cookie is refused (Theia hardening)', async () => {
    const error = await refusal({});
    return { ok: error?.statusCode >= 400 && error.statusCode < 500, detail: `HTTP ${error?.statusCode ?? 'upgraded'}` };
  });
  await rec.check(group, 'a WebSocket upgrade with a foreign Origin is refused (Theia hardening)', async () => {
    const cookie = await fetchConnectionCookie(BASE);
    const error = await refusal({ Cookie: cookie, Origin: 'http://evil.example' });
    return { ok: error?.statusCode >= 400 && error.statusCode < 500, detail: `HTTP ${error?.statusCode ?? 'upgraded'}` };
  });
}

async function offlineGroup() {
  const group = 'offline';
  if (!OFFLINE) {
    rec.skip(group, 'the run has no outbound network', 'not requested; pass --offline (the image run does: suites/api/kotlin-lsp-image.mjs)');
    return;
  }
  await rec.check(group, 'precondition: this environment has no outbound network (a connect to 1.1.1.1:443 fails)', async () => {
    const reachable = await outboundReachable();
    const proxies = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].filter((name) => process.env[name]);
    return { ok: !reachable && proxies.length === 0, detail: `${reachable ? 'REACHABLE' : 'blocked'}${proxies.length ? `, proxies set: ${proxies.join(',')}` : ''}` };
  });
}

/** Lifecycle: the process counts are read from the backend's process tree, so every check here needs a view of it. */
async function lifecycleGroup() {
  const group = 'lifecycle';
  if (!processesVisible) {
    ['no server process before the first editor connects', 'one server for several editors that connect at the same instant', 'a later editor reuses the running server',
      'closing one editor keeps the server for the others', 'a server stops after the idle timeout', 'the next connection starts a new server'].forEach((name) => rec.skip(group, name, NO_PROCESS_VIEW));
    return;
  }
  let before = servers();
  if (before.length > 0 && IDLE_SECONDS) {
    await until(() => servers().length === 0, (IDLE_SECONDS + 15) * 1000);
    before = servers();
  }
  if (before.length > 0) {
    rec.skip(group, 'no server process before the first editor connects', `a language server (pid ${before[0].pid}) is already running: another client holds it or its idle window has not run out; use a fresh backend or IDLE_TIMEOUT_SECONDS`);
  } else {
    rec.record(group, 'no server process before the first editor connects', true, `0 processes under backend pid ${backendPid}`);
  }

  // Three editors connect at the same instant; the first one opens a script before the server is ready, as the editor does.
  const t0 = Date.now();
  const cold = before.length === 0;
  const trio = await Promise.all([startSession(), startSession(), startSession()]);
  const [first, second, third] = trio;
  const coldBroken = cold ? openScript(first.lsp, 'cold-1', 'val cold: Int = "a"') : undefined;
  const initialized = await Promise.all(trio.map((s) => becomeReady(s.lsp)));
  const startMs = Date.now() - t0;
  const running = servers();
  await rec.check(group, 'one server for several editors that connect at the same instant (started lazily, reported starting then ready)', () => {
    const states = trio.map((s) => s.lsp.states.join('>'));
    const parent = running[0] ? readProcess(running[0].ppid)?.pid : undefined;
    return {
      ok: running.length === 1 && initialized.every((r) => r.result?.capabilities) && states.every((s) => /^(starting>)?ready$/.test(s)),
      detail: `${running.length} process(es) pid ${running.map((p) => p.pid).join(',')} parent ${parent}; states ${states.join(' | ')}; ready ${startMs} ms after connecting${cold ? '' : ' (warm: a server was already running)'}`,
    };
  });
  const pid = running[0]?.pid;
  rememberPrivateDirectory();
  if (cold && pid) {
    await sleep(2000);
    coldStart = { readyMs: startMs, rssAfterReadyMb: rssMb(pid) };
  }

  if (cold) {
    await rec.check(group, 'a document opened while the server is still starting gets its diagnostics once the server is ready', async () => {
      const diagnostics = await first.lsp.waitForDiagnostics(coldBroken.uri, (d) => d.length > 0, { timeoutMs: 15000 }).then((p) => p.diagnostics, () => undefined);
      return { ok: Boolean(diagnostics), detail: diagnostics ? `${diagnostics.length} diagnostic(s)` : 'none within 15 s after ready (a later edit of the same document does publish them)' };
    });
    if (!first.lsp.diagnosticEvents({ uri: coldBroken.uri }).length) {
      // keep going on a warm, analysed server for the other groups
      first.lsp.change(coldBroken.uri, coldBroken.text, 2);
      await first.lsp.waitForDiagnostics(coldBroken.uri, (d) => d.length > 0, { timeoutMs: 15000 }).catch(() => undefined);
    }
  }

  const fourth = await startSession();
  const tReuse = Date.now();
  await becomeReady(fourth.lsp);
  await rec.check(group, 'a later editor reuses the running server (same process, ready at once)', () => {
    const now = servers();
    const readyMs = Date.now() - tReuse;
    return { ok: now.length === 1 && now[0].pid === pid && readyMs < 3000, detail: `pid ${now[0]?.pid} (was ${pid}), ${now.length} process(es), ready ${readyMs} ms after connecting` };
  });

  first.connection.close();
  second.connection.close();
  await sleep(1500);
  await rec.check(group, 'closing editors keeps the server for the editors that remain', async () => {
    const answer = await third.lsp.request('textDocument/hover', { textDocument: { uri: 'continuum-script:/never-opened.kt' }, position: { line: 0, character: 0 } });
    const now = servers();
    return { ok: now.length === 1 && now[0].pid === pid && Boolean(answer.error), detail: `${now.length} process(es), pid ${now[0]?.pid}; the remaining editor still gets answers (${answer.error?.code})` };
  });

  third.connection.close();
  fourth.connection.close();
  const closedAt = Date.now();
  await sleep(2000);
  await rec.check(group, 'the server is not stopped the moment the last editor closes', () => ({ ok: servers().length === 1, detail: `${servers().length} process(es) 2 s after the last close` }));

  if (!IDLE_SECONDS) {
    ['the server stops after the idle timeout', 'a reconnect inside the idle window reuses the server', 'a vanished client (no close) also lets the server stop', 'the next connection starts a new server'].forEach((name) => rec.skip(group, name, 'IDLE_TIMEOUT_SECONDS (the backend\'s idle timeout) is not set; start a backend with CONTINUUM_LANGUAGE_SERVER_IDLE_TIMEOUT_SECONDS=15 and pass the same value'));
    return;
  }

  // A reconnect inside the idle window finds the same process; its abrupt disappearance restarts the idle clock.
  await sleep(Math.max(0, Math.min(4000, (IDLE_SECONDS * 1000) / 3) - (Date.now() - closedAt)));
  const reconnect = await startSession();
  await rec.check(group, 'a reconnect inside the idle window reuses the server (idle stop cancelled)', async () => {
    await becomeReady(reconnect.lsp);
    const now = servers();
    return { ok: now.length === 1 && now[0].pid === pid, detail: `pid ${now[0]?.pid} (was ${pid}), ${secondsSince(closedAt)} s after the last close` };
  });
  reconnect.connection.drop();
  const droppedAt = Date.now();
  await sleep((IDLE_SECONDS * 1000) / 2);
  const stillUp = servers().length === 1;
  const stopped = await until(() => servers().length === 0, (IDLE_SECONDS * 1000) / 2 + 12000);
  const stoppedAfter = secondsSince(droppedAt);
  await rec.check(group, `a vanished client (socket dropped, no close) lets the server stop after the ${IDLE_SECONDS} s idle timeout, not before`, () => ({
    ok: stillUp && stopped && stoppedAfter >= IDLE_SECONDS - 1 && stoppedAfter <= IDLE_SECONDS + 10,
    detail: `still running at ${IDLE_SECONDS / 2} s: ${stillUp}; gone after ${stoppedAfter} s`,
  }));

  const restarted = await startSession();
  const coldAgain = openScript(restarted.lsp, 'cold-2', 'val cold: Int = "a"');
  await becomeReady(restarted.lsp);
  await rec.check(group, 'the next connection after an idle stop starts a new server (lazily)', () => {
    const now = servers();
    return { ok: now.length === 1 && now[0].pid !== pid, detail: `${now.length} process(es), pid ${now[0]?.pid} (previous ${pid})` };
  });
  await rec.check(group, 'a document opened while the restarted server is starting gets its diagnostics once ready', async () => {
    const diagnostics = await restarted.lsp.waitForDiagnostics(coldAgain.uri, (d) => d.length > 0, { timeoutMs: 15000 }).then((p) => p.diagnostics, () => undefined);
    return { ok: Boolean(diagnostics), detail: diagnostics ? `${diagnostics.length} diagnostic(s)` : 'none within 15 s after ready' };
  });
  restarted.connection.close();
  if (!IDLE_CHECKS.includes('orderly')) {
    rec.skip(group, `an orderly close lets the server stop after the ${IDLE_SECONDS} s idle timeout`, 'IDLE_CHECKS=vanished: the vanished-client check above already measured the same idle timer');
    return;
  }
  const closedAgain = Date.now();
  const stoppedAgain = await until(() => servers().length === 0, (IDLE_SECONDS + 12) * 1000);
  const after = secondsSince(closedAgain);
  await rec.check(group, `an orderly close lets the server stop after the ${IDLE_SECONDS} s idle timeout`, () => ({
    ok: stoppedAgain && after >= IDLE_SECONDS - 1 && after <= IDLE_SECONDS + 10,
    detail: `gone after ${after} s`,
  }));
}

async function packagingGroup(lsp) {
  const group = 'packaging';
  if (!EXPECT_LS_HOME) {
    rec.skip(group, 'the server and its runtime run from the bundled install directory', 'EXPECT_LS_HOME is not set (image: /opt/continuum/kotlin-ls)');
    return;
  }
  if (!processesVisible) {
    rec.skip(group, 'the server and its runtime run from the bundled install directory', NO_PROCESS_VIEW);
    return;
  }
  const [server] = servers();
  await rec.check(group, `the server runs on the bundled Java runtime and server files under ${EXPECT_LS_HOME}`, () => {
    let exe;
    try { exe = fs.readlinkSync(`/proc/${server.pid}/exe`); } catch (error) { return { ok: false, detail: `cannot read /proc/${server.pid}/exe: ${error.code}` }; }
    const classpath = server.cmdline.join(' ');
    return { ok: exe.startsWith(`${EXPECT_LS_HOME}/jre/`) && classpath.includes(`${EXPECT_LS_HOME}/server/lib/`), detail: `java ${exe}; classpath under server/lib: ${classpath.includes(`${EXPECT_LS_HOME}/server/lib/`)}` };
  });
}

async function intelligenceGroup() {
  const group = 'diagnostics';
  if (!REPORTED.context) {
    rec.skip(group, 'the editor features for the reported names (row, flow)', REPORTED.skip);
    return;
  }
  const { lsp, connection } = await startSession();
  const init = await becomeReady(lsp);
  await openContext(lsp);
  await sleep(1500); // a document opened in the first ~300 ms after `ready` is covered by the lifecycle checks
  rememberPrivateDirectory();

  await rec.check(group, 'initialize is answered by the bridge: full-text sync, server capabilities for the allowed features', () => {
    const caps = init.result?.capabilities ?? {};
    return {
      ok: caps.textDocumentSync?.openClose === true && caps.textDocumentSync?.change === 1 && Boolean(caps.completionProvider) && Boolean(caps.hoverProvider) && Boolean(caps.signatureHelpProvider),
      detail: `${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version}; sync ${JSON.stringify(caps.textDocumentSync)}`,
    };
  });

  const broken = openScript(lsp, 'type-error', 'val x: Int = "a"');
  await rec.check(group, 'a type error is published at the user\'s line and column (the hidden header does not shift it)', async () => {
    const params = await lsp.waitForDiagnostics(broken.uri, (d) => d.length > 0, { timeoutMs: 20000 });
    const mine = userDiagnostics(broken, params.diagnostics).filter((d) => d.severity === 1);
    const range = mine[0]?.range;
    return { ok: mine.length === 1 && range.start.line === 0 && range.start.character === 13 && range.end.line === 0 && range.end.character === 16 && mine[0].code === 'TYPE_MISMATCH', detail: `${mine.map((d) => `${d.code} ${JSON.stringify(d.range)}`).join('; ')}` };
  });

  const importing = 'import java.time.LocalDate\n\nval a = 1\nval b: Int = "oops"';
  const wovenImporting = openScript(lsp, 'imports', importing);
  await rec.check(group, 'an error below leading imports is reported at the user\'s line (header goes after the imports)', async () => {
    const params = await lsp.waitForDiagnostics(wovenImporting.uri, (d) => d.length > 0, { timeoutMs: 20000 });
    const mine = userDiagnostics(wovenImporting, params.diagnostics).filter((d) => d.severity === 1);
    return { ok: mine.length === 1 && mine[0].range.start.line === 3 && mine[0].range.start.character === 13, detail: `${mine.map((d) => JSON.stringify(d.range)).join('; ')} (virtual line ${params.diagnostics.find((d) => d.severity === 1)?.range.start.line})` };
  });

  const cleanText = 'row["a"]?.toString() + flow.get("x")';
  const clean = openScript(lsp, 'clean', cleanText);
  await rec.check(group, 'the documented clean script (row["a"]?.toString() + flow.get("x")) is analysed and publishes no diagnostics at all', async () => {
    await lsp.waitForDiagnostics(clean.uri, () => true, { timeoutMs: 20000 }); // the analysis of the opened document has run
    const completion = await lsp.request('textDocument/completion', { textDocument: { uri: clean.uri }, position: clean.toVirtualPosition({ line: 0, character: cleanText.length }) });
    await lsp.quiet(3000); // late publishes would arrive here
    const published = lsp.diagnosticEvents({ uri: clean.uri });
    const raw = published.flatMap((p) => p.diagnostics);
    const onUserLines = published.flatMap((p) => userDiagnostics(clean, p.diagnostics));
    return {
      ok: !completion.error && completion.result !== undefined && published.length > 0 && raw.length === 0,
      detail: `${published.length} publish(es), ${raw.length} diagnostic(s) in total (${onUserLines.length} on the user's lines${raw.length ? `: ${raw.slice(0, 3).map((d) => `${d.code ?? ''} ${d.message}`.trim().slice(0, 60)).join('; ')}` : ''}); completion answered in ${completion.ms} ms`,
    };
  });

  await rec.check(group, 'fixing the error clears the markers: an empty diagnostics list is published for the user\'s lines', async () => {
    const fixed = weave(lsp, 'val x: Int = 1', key('type-error'));
    const mark = lsp.mark();
    lsp.change(fixed.uri, fixed.text, 2);
    const params = await lsp.waitForDiagnostics(fixed.uri, (d) => userDiagnostics(fixed, d).filter((x) => x.severity === 1).length === 0, { timeoutMs: 20000, from: mark });
    return { ok: true, detail: `${params.diagnostics.length} diagnostic(s) left, none an error on the user's lines` };
  });

  await rec.check(group, 'typing `flow.` offers get, set and all', async () => {
    const woven = openScript(lsp, 'flow-completion', 'flow.');
    const response = await lsp.request('textDocument/completion', { textDocument: { uri: woven.uri }, position: woven.toVirtualPosition({ line: 0, character: 5 }) });
    const found = memberNames(response.result);
    return { ok: ['get', 'set', 'all'].every((name) => found.includes(name)), detail: `${found.length} items, first: ${found.slice(0, 6).join(', ')}; ${response.ms} ms` };
  });
  await rec.check(group, 'typing `row.` offers the members of Map<String, Any>', async () => {
    const woven = openScript(lsp, 'row-completion', 'row.');
    const response = await lsp.request('textDocument/completion', { textDocument: { uri: woven.uri }, position: woven.toVirtualPosition({ line: 0, character: 4 }) });
    const found = memberNames(response.result);
    return { ok: ['containsKey', 'keys', 'size'].every((name) => found.includes(name)), detail: `${found.length} items (the server caps the list); ${response.ms} ms` };
  });
  await rec.check(group, 'the Kotlin standard library resolves (`"abc".le` offers String.length and the stdlib\'s let)', async () => {
    const woven = openScript(lsp, 'stdlib-completion', '"abc".le');
    const response = await lsp.request('textDocument/completion', { textDocument: { uri: woven.uri }, position: woven.toVirtualPosition({ line: 0, character: 8 }) });
    const found = memberNames(response.result);
    return { ok: ['length', 'let'].every((name) => found.includes(name)), detail: `${found.length} items, first: ${found.slice(0, 5).join(', ')}` };
  });
  await rec.check(group, 'classes of the Java modules a script can reasonably use resolve (java.net.http, java.sql, java.rmi, javax.tools, org.ietf.jgss): no unresolved reference', async () => {
    const text = [
      'import java.net.http.HttpClient',
      'import java.sql.Timestamp',
      'import java.rmi.Remote',
      'import javax.tools.ToolProvider',
      'import org.ietf.jgss.GSSManager',
      '',
      'val client: HttpClient = HttpClient.newHttpClient()',
      'val stamp = Timestamp(0L)',
      'val remote: Remote? = null',
      'val compiler = ToolProvider.getSystemJavaCompiler()',
      'val manager = GSSManager.getInstance()',
    ].join('\n');
    const woven = openScript(lsp, 'jdk-modules', text);
    await lsp.waitForDiagnostics(woven.uri, () => true, { timeoutMs: 30000 }); // the analysis of the opened document has run
    await lsp.quiet(3000);
    const published = lsp.diagnosticEvents({ uri: woven.uri });
    const raw = published.flatMap((p) => p.diagnostics);
    const unresolved = raw.filter((d) => d.code === 'UNRESOLVED_REFERENCE' || /unresolved reference/i.test(d.message ?? ''));
    return {
      ok: published.length > 0 && unresolved.length === 0,
      detail: unresolved.length
        ? `unresolved: ${unresolved.slice(0, 5).map((d) => `${d.message} (line ${d.range.start.line})`).join('; ')}`
        : `${published.length} publish(es), ${raw.length} diagnostic(s) in total, none unresolved${raw.length ? `: ${raw.slice(0, 3).map((d) => `${d.code ?? ''} ${d.message}`.trim().slice(0, 60)).join('; ')}` : ''}`,
    };
  });
  {
    // A control for the check above, recorded as a measurement because the answer depends on the runtime the server runs on
    // (a full JDK resolves it, the image's reduced runtime does not ship the module): shows the check can notice a missing module.
    const woven = openScript(lsp, 'jdk-outside-reduced-runtime', 'import com.sun.net.httpserver.HttpServer\n\nval server: HttpServer? = null');
    await lsp.waitForDiagnostics(woven.uri, () => true, { timeoutMs: 30000 }).catch(() => undefined);
    await lsp.quiet(2000);
    const raw = lsp.diagnosticEvents({ uri: woven.uri }).flatMap((p) => p.diagnostics);
    const unresolved = raw.filter((d) => d.code === 'UNRESOLVED_REFERENCE' || /unresolved reference/i.test(d.message ?? ''));
    rec.record(group, 'a class of a module the image\'s reduced runtime does not ship (com.sun.net.httpserver, module jdk.httpserver) (measurement)', true, unresolved.length
      ? `unresolved (${unresolved.length} diagnostic(s): ${unresolved[0].message}): the server only sees the modules of the runtime it runs on`
      : `resolved (${raw.length} diagnostic(s)): the runtime the server runs on has the module`);
  }
  await rec.check(group, 'hovering `flow.set` shows its signature and KDoc', async () => {
    const text = 'flow.set("k", 1)';
    const woven = openScript(lsp, 'hover', text);
    await lsp.request('textDocument/hover', { textDocument: { uri: woven.uri }, position: woven.toVirtualPosition({ line: 0, character: 6 }) }); // first answer may precede analysis
    const response = await lsp.request('textDocument/hover', { textDocument: { uri: woven.uri }, position: woven.toVirtualPosition({ line: 0, character: 6 }) });
    const value = JSON.stringify(response.result?.contents ?? '');
    return { ok: /set\(name: String, value: Any\?\)/.test(value) && /Sets or updates flow variable/.test(value), detail: value.slice(0, 160) };
  });
  await rec.check(group, 'signature help appears after `flow.set(`', async () => {
    const text = 'flow.set(';
    const woven = openScript(lsp, 'signature', text);
    const response = await lsp.request('textDocument/signatureHelp', { textDocument: { uri: woven.uri }, position: woven.toVirtualPosition({ line: 0, character: text.length }) });
    const label = response.result?.signatures?.[0]?.label ?? '';
    return { ok: /set\(name: String, value: Any\?\)/.test(label), detail: label || JSON.stringify(response.error ?? response.result) };
  });

  // What `initialize` promises must be what the bridge serves: a client trusts the advertisement (an editor offers rename or
  // format when it is promised, and the user then gets an error). Every promised feature is called on a document this
  // connection owns, so a -32602 can only mean the method itself is refused.
  await rec.check(group, 'initialize promises only features the bridge serves: every promised method is answered (not refused) on an owned document', async () => {
    const capabilities = init.result?.capabilities ?? {};
    const beyond = promisesBeyond(capabilities, SERVED_METHODS);
    const workspace = workspacePromises(capabilities);
    const woven = openScript(lsp, 'promises', 'val promised = 1');
    await lsp.waitForDiagnostics(woven.uri, () => true, { timeoutMs: 20000 }).catch(() => undefined);
    const at = woven.toVirtualPosition({ line: 0, character: 5 });
    const promised = advertisedFeatures(capabilities).filter((feature) => feature.method);
    const refused = [];
    for (const { key, method } of promised) {
      const response = await lsp.request(method, probeParams(method, woven.uri, at), { timeoutMs: 15000 }).catch((error) => ({ error: { code: 'timeout', message: error.message } }));
      if (response.error?.code === -32602) { refused.push(`${key} -> ${method}: ${response.error.message}`); }
    }
    const problems = [
      ...beyond.unaccepted.map((p) => `promised but outside the served set: ${p}`),
      ...beyond.unknown.map((p) => `unknown provider promised: ${p}`),
      ...workspace.map((p) => `promised: ${p}`),
      ...refused.map((p) => `refused when called: ${p}`),
    ];
    return { ok: problems.length === 0, detail: problems.length ? problems.join(' | ') : `${promised.length} promised (${promised.map((f) => f.key.replace(/Provider$/, '')).join(', ')}), every one answered; no workspace promises; textDocumentSync ${JSON.stringify(capabilities.textDocumentSync)}` };
  });

  connection.close();
}

async function documentsGroup() {
  const group = 'documents';
  const a = await startSession();
  const b = await startSession();
  await Promise.all([becomeReady(a.lsp), becomeReady(b.lsp)]);
  await sleep(1500);
  const shared = weave(a.lsp, 'val shared: Int = "a"', key('shared'));
  a.lsp.open(shared.uri, shared.text);
  await a.lsp.waitForDiagnostics(shared.uri, (d) => d.length > 0, { timeoutMs: 20000 });

  await rec.check(group, 'the owner of a document can read it (hover answers, no error)', async () => {
    const response = await a.lsp.request('textDocument/hover', { textDocument: { uri: shared.uri }, position: shared.toVirtualPosition({ line: 0, character: 5 }) });
    return { ok: !response.error && response.result !== undefined, detail: JSON.stringify(response.result ?? response.error).slice(0, 100) };
  });
  await rec.check(group, 'another connection cannot open or read a document the first one has open', async () => {
    const takeover = weave(b.lsp, 'val takeover = 1', key('shared'));
    b.lsp.open(takeover.uri, takeover.text);
    const response = await b.lsp.request('textDocument/hover', { textDocument: { uri: shared.uri }, position: { line: 2, character: 5 } });
    return { ok: isRefusal(response, 'textDocument/hover'), detail: JSON.stringify(response.error ?? response.result).slice(0, 120) };
  });
  await rec.check(group, 'diagnostics of one connection\'s documents never reach another connection', async () => {
    const own = weave(b.lsp, 'val own: Int = "b"', key('own-b'));
    b.lsp.open(own.uri, own.text);
    await b.lsp.waitForDiagnostics(own.uri, (d) => d.length > 0, { timeoutMs: 20000 });
    await sleep(1000);
    const leaked = b.lsp.diagnosticEvents({}).filter((p) => p.uri !== own.uri);
    const crossed = a.lsp.diagnosticEvents({ uri: own.uri });
    return { ok: leaked.length === 0 && crossed.length === 0, detail: `B saw ${leaked.length} foreign publish(es), A saw ${crossed.length} of B's` };
  });
  await rec.check(group, 'closing a document releases it: another connection can then open it', async () => {
    a.lsp.closeDocument(shared.uri);
    await sleep(500);
    b.lsp.open(shared.uri, shared.text);
    const params = await b.lsp.waitForDiagnostics(shared.uri, (d) => d.length > 0, { timeoutMs: 20000 }).catch(() => undefined);
    return { ok: Boolean(params), detail: params ? `${params.diagnostics.length} diagnostic(s) delivered to the new owner` : 'no diagnostics for the new owner' };
  });
  await rec.check(group, 'a connection that vanishes releases its documents: another connection can open them', async () => {
    const mine = weave(a.lsp, 'val gone: Int = "a"', key('vanish'));
    a.lsp.open(mine.uri, mine.text);
    await a.lsp.waitForDiagnostics(mine.uri, (d) => d.length > 0, { timeoutMs: 20000 });
    a.connection.drop();
    await sleep(1500);
    b.lsp.open(mine.uri, mine.text);
    const params = await b.lsp.waitForDiagnostics(mine.uri, (d) => d.length > 0, { timeoutMs: 20000 }).catch(() => undefined);
    return { ok: Boolean(params), detail: params ? 'the second connection owns it and gets its diagnostics' : 'the document stayed owned by the dead connection' };
  });
  await rec.check(group, 'a full-text didChange is applied; an incremental (range) change is refused', async () => {
    const doc = weave(b.lsp, 'val v: Int = 1', key('incremental'));
    b.lsp.open(doc.uri, doc.text);
    await sleep(1500);
    const mark = b.lsp.mark();
    // range replaces the `1` in the user's line with "a": a server that received it would report TYPE_MISMATCH
    b.lsp.notify('textDocument/didChange', { textDocument: { uri: doc.uri, version: 2 }, contentChanges: [{ range: { start: doc.toVirtualPosition({ line: 0, character: 13 }), end: doc.toVirtualPosition({ line: 0, character: 14 }) }, text: '"a"' }] });
    const afterIncremental = (await b.lsp.quiet(2500)).filter((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === doc.uri && m.params.diagnostics.some((d) => d.severity === 1));
    const broken = weave(b.lsp, 'val v: Int = "a"', key('incremental'));
    b.lsp.change(doc.uri, broken.text, 3);
    const full = await b.lsp.waitForDiagnostics(doc.uri, (d) => d.some((x) => x.severity === 1), { timeoutMs: 20000, from: mark }).catch(() => undefined);
    return { ok: afterIncremental.length === 0 && Boolean(full), detail: `incremental change produced ${afterIncremental.length} error publish(es); the full-text change ${full ? 'did' : 'did NOT'} produce diagnostics` };
  });
  await rec.check(group, 'at most 50 documents per connection; the 51st is refused', async () => {
    const c = await startSession();
    await becomeReady(c.lsp);
    for (let index = 0; index < 51; index++) {
      const doc = weave(c.lsp, `val n${index} = ${index}`, key(`bulk-${index}`));
      c.lsp.open(doc.uri, doc.text);
    }
    await sleep(500);
    const last = await c.lsp.request('textDocument/hover', { textDocument: { uri: documentUri(key('bulk-50')) }, position: { line: 2, character: 5 } });
    const fiftieth = await c.lsp.request('textDocument/hover', { textDocument: { uri: documentUri(key('bulk-49')) }, position: { line: 2, character: 5 } });
    c.connection.close();
    return { ok: isRefusal(last, 'textDocument/hover') && !fiftieth.error, detail: `51st: ${JSON.stringify(last.error ?? last.result).slice(0, 80)}; 50th: ${fiftieth.error ? JSON.stringify(fiftieth.error) : 'answered'}` };
  });
  b.connection.close();
}

const BAD_URIS = [
  ['file:///etc/passwd', 'an absolute file: URI'],
  ['file:///tmp/systest.kt', 'a file: URI to a Kotlin file'],
  ['file://localhost/etc/passwd', 'a file: URI with a host'],
  ['FILE:///etc/passwd', 'a file: URI with an upper-case scheme'],
  ['file:/etc/passwd', 'a file: URI without authority'],
  ['http://127.0.0.1:1/x.kt', 'an http: URI'],
  ['jar:file:///etc/x.jar!/x.kt', 'a jar: URI'],
  ['data:text/plain,hello', 'a data: URI'],
  ['continuum-script:/../etc/passwd.kt', 'a traversal through the virtual scheme'],
  ['continuum-script:/a/b.kt', 'a nested virtual path'],
  ['continuum-script:/%2e%2e/etc.kt', 'an encoded traversal'],
  ['continuum-script:/a b.kt', 'a key with a space'],
  ['continuum-script://host/x.kt', 'a virtual URI with an authority'],
  ['continuum-script:x.kt', 'a virtual URI without the slash'],
  ['CONTINUUM-SCRIPT:/x.kt', 'an upper-case virtual scheme'],
  [`continuum-script:/${'k'.repeat(65)}.kt`, 'a key of 65 characters'],
  ['continuum-script:/.kt', 'an empty key'],
  ['', 'an empty URI'],
  ['../../etc/passwd', 'a relative path'],
];

async function securityGroup() {
  const group = 'security';

  // 1. Language ids
  const idsBefore = servers().length;
  const unknown = ['bogus', 'Kotlin-Script', 'kotlin_script', 'kotlin-script-2', 'a'.repeat(41), '..', 'kotlin-script%00'];
  await rec.check(group, 'a connection for an unknown or malformed language id is refused (channel closed by the server, nothing delivered)', async () => {
    const outcomes = [];
    for (const id of unknown) {
      const connection = await TheiaConnection.connect(BASE);
      connections.push(connection);
      const channel = await connection.openChannel(channelPath(id));
      const closed = await channel.whenClosed(5000);
      outcomes.push({ id: id.length > 20 ? `${id.slice(0, 8)}…(${id.length})` : id, closed, delivered: channel.received.length });
      connection.close();
    }
    const bad = outcomes.filter((o) => !o.closed || o.delivered > 0);
    return { ok: bad.length === 0, detail: bad.length ? `not refused: ${JSON.stringify(bad)}` : `${outcomes.length} ids refused` };
  });
  if (processesVisible && idsBefore === 0) {
    await rec.check(group, 'a refused language id starts no server process', () => ({ ok: servers().length === 0, detail: `${servers().length} process(es) after the refused connections` }));
  }

  // 2. The owner can read; hostile requests are refused
  const { lsp, connection } = await startSession();
  await becomeReady(lsp);
  await sleep(1500);
  const own = weave(lsp, 'val ok = 1', key('own'));
  lsp.open(own.uri, own.text);
  const at = { line: own.toVirtualPosition({ line: 0, character: 5 }).line, character: 5 };
  await rec.check(group, 'a request on the connection\'s own virtual document is served (the isolation checks below are not vacuous)', async () => {
    const response = await lsp.request('textDocument/hover', { textDocument: { uri: own.uri }, position: at });
    return { ok: !response.error && response.result?.contents !== undefined, detail: JSON.stringify(response.result ?? response.error).slice(0, 100) };
  });

  await rec.check(group, `requests naming a file: path or a malformed document URI are refused with -32602 (${BAD_URIS.length} spellings)`, async () => {
    const failing = [];
    for (const [uri, what] of BAD_URIS) {
      for (const method of ['textDocument/hover', 'textDocument/definition']) {
        const response = await lsp.request(method, { textDocument: { uri }, position: { line: 0, character: 0 } }, { timeoutMs: 8000 }).catch((error) => ({ error: { code: 'timeout', message: error.message } }));
        if (!isRefusal(response, method) || response.result !== undefined) {
          failing.push(`${what} (${method}): ${JSON.stringify(response.error ?? response.result).slice(0, 80)}`);
        }
      }
    }
    return { ok: failing.length === 0, detail: failing.length ? failing.join(' | ') : 'all refused by the bridge' };
  });

  await rec.check(group, 'didOpen of a file: or malformed URI is dropped: no analysis, no diagnostics, the document stays unreadable', async () => {
    for (const [uri] of BAD_URIS) {
      lsp.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'kotlin', version: 1, text: 'val x: Int = "a"' } });
    }
    const after = await lsp.quiet(2500);
    const diagnostics = after.filter((m) => m.method === 'textDocument/publishDiagnostics');
    const readable = [];
    for (const [uri] of BAD_URIS.slice(0, 5)) {
      const response = await lsp.request('textDocument/hover', { textDocument: { uri }, position: { line: 0, character: 5 } });
      if (!isRefusal(response)) { readable.push(uri); }
    }
    return { ok: diagnostics.length === 0 && readable.length === 0, detail: `${diagnostics.length} diagnostics for ${BAD_URIS.length} hostile documents; readable afterwards: ${readable.length}` };
  });

  await rec.check(group, 'a document URI hidden in other parameters is refused too (nested uri / *Uri keys, any depth up to the limit and beyond)', async () => {
    const deep = (value, levels) => Array.from({ length: levels }).reduce((inner) => ({ nested: inner }), value);
    const cases = [
      ['completionItem/resolve', { label: 'x', data: { uri: 'file:///etc/passwd' } }],
      ['completionItem/resolve', { label: 'x', data: { targetUri: 'file:///etc/passwd' } }],
      ['completionItem/resolve', { label: 'x', data: { rootUri: 'file:///etc' } }],
      ['completionItem/resolve', { label: 'x', data: deep({ uri: 'file:///etc/passwd' }, 6) }],
      ['completionItem/resolve', { label: 'x', data: deep({ uri: 'file:///etc/passwd' }, 20) }],
      ['textDocument/references', { textDocument: { uri: own.uri }, position: at, context: { includeDeclaration: true, workspaceFolderUri: 'file:///etc' } }],
    ];
    const failing = [];
    for (const [method, params] of cases) {
      const response = await lsp.request(method, params, { timeoutMs: 8000 }).catch((error) => ({ error: { message: error.message } }));
      if (!isRefusal(response, method)) { failing.push(`${method} ${JSON.stringify(params).slice(0, 70)} -> ${JSON.stringify(response.error ?? response.result).slice(0, 70)}`); }
    }
    const harmless = await lsp.request('completionItem/resolve', { label: 'x' });
    return { ok: failing.length === 0 && harmless.error?.code !== -32602, detail: failing.length ? failing.join(' | ') : `${cases.length} refused; a resolve without any URI passes (${harmless.error ? harmless.error.code : 'answered'})` };
  });

  await rec.check(group, 'methods outside the documented set are refused with -32602 (execute command, rename, format, workspace search, edits, unknown)', async () => {
    const range = { start: at, end: at };
    const methods = [
      ['workspace/executeCommand', { command: 'convertJavaToKotlin', arguments: ['file:///etc/passwd'] }],
      ['textDocument/rename', { textDocument: { uri: own.uri }, position: at, newName: 'renamed' }],
      ['textDocument/formatting', { textDocument: { uri: own.uri }, options: { tabSize: 4, insertSpaces: true } }],
      ['textDocument/rangeFormatting', { textDocument: { uri: own.uri }, range, options: { tabSize: 4, insertSpaces: true } }],
      ['textDocument/codeAction', { textDocument: { uri: own.uri }, range, context: { diagnostics: [] } }],
      ['textDocument/semanticTokens/full', { textDocument: { uri: own.uri } }],
      ['textDocument/inlayHint', { textDocument: { uri: own.uri }, range }],
      ['workspace/symbol', { query: '' }],
      ['workspace/applyEdit', { edit: { changes: { 'file:///etc/passwd': [] } } }],
      ['custom/anything', {}],
    ];
    const failing = [];
    for (const [method, params] of methods) {
      const response = await lsp.request(method, params, { timeoutMs: 8000 }).catch((error) => ({ error: { message: error.message } }));
      if (!isRefusal(response, method)) { failing.push(`${method} -> ${JSON.stringify(response.error ?? response.result).slice(0, 90)}`); }
    }
    return { ok: failing.length === 0, detail: failing.length ? failing.join(' | ') : `${methods.length} refused` };
  });

  await rec.check(group, 'notifications that could widen the server\'s reach are dropped silently (workspace folders, configuration, watched files, save)', async () => {
    const mark = lsp.mark();
    lsp.notify('workspace/didChangeWorkspaceFolders', { event: { added: [{ uri: 'file:///', name: 'root' }], removed: [] } });
    lsp.notify('workspace/didChangeConfiguration', { settings: { kotlin: { compiler: { jvm: { target: '1.8' } } } } });
    lsp.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: 'file:///etc/passwd', type: 2 }] });
    lsp.notify('textDocument/didSave', { textDocument: { uri: 'file:///etc/passwd' } });
    lsp.notify('textDocument/didClose', { textDocument: { uri: 'file:///etc/passwd' } });
    const after = await lsp.quiet(1500);
    const response = await lsp.request('textDocument/hover', { textDocument: { uri: own.uri }, position: at });
    return { ok: after.length === 0 && !response.error, detail: `${after.length} message(s) came back; the connection still works (${response.error ? JSON.stringify(response.error) : 'hover answered'})` };
  });

  await rec.check(group, 'a client cannot widen the roots through initialize (rootUri/workspaceFolders are ignored; the cached answer is returned)', async () => {
    const response = await lsp.request('initialize', { processId: 1, rootUri: 'file:///etc', workspaceFolders: [{ uri: 'file:///etc', name: 'etc' }], capabilities: {} });
    return { ok: Boolean(response.result?.capabilities?.textDocumentSync) && !JSON.stringify(response.result).includes('/etc'), detail: `answered by the bridge in ${response.ms} ms` };
  });

  await rec.check(group, 'didOpen with another language id and a message for a document that was never opened are refused', async () => {
    const other = weave(lsp, 'val q = 1', key('wrong-language'));
    lsp.notify('textDocument/didOpen', { textDocument: { uri: other.uri, languageId: 'plaintext', version: 1, text: other.text } });
    const readable = await lsp.request('textDocument/hover', { textDocument: { uri: other.uri }, position: { line: 2, character: 5 } });
    const unopened = await lsp.request('textDocument/hover', { textDocument: { uri: documentUri(key('never-opened')) }, position: { line: 0, character: 0 } });
    return { ok: isRefusal(readable, 'textDocument/hover') && isRefusal(unopened, 'textDocument/hover'), detail: `wrong language id: ${readable.error?.code}; unopened: ${unopened.error?.code}` };
  });

  await rec.check(group, 'malformed JSON-RPC (not JSON, no method, wrong types) is ignored; the connection and the backend keep working', async () => {
    const mark = lsp.mark();
    ['this is not json', '[]', 'null', '42', '{"jsonrpc":"2.0"}', '{"jsonrpc":"2.0","id":9001}', '{"jsonrpc":"2.0","id":9002,"method":42}', '{"jsonrpc":"2.0","method":"textDocument/hover","params":"oops"}', '{"jsonrpc":"2.0","method":"textDocument/didOpen","params":null}', '{"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":{"x":1}}}']
      .forEach((text) => lsp.sendText(text));
    const after = await lsp.quiet(1500);
    const response = await lsp.request('textDocument/hover', { textDocument: { uri: own.uri }, position: at });
    const alive = await fetchConnectionCookie(BASE).then(() => true, () => false);
    return { ok: !response.error && alive && (!processesVisible || readProcess(backendPid) !== undefined), detail: `${after.length} unsolicited message(s); hover ${response.error ? 'failed' : 'answered'}; backend answers HTTP: ${alive}` };
  });

  await rec.check(group, 'shutdown and exit from one client do not stop the shared server', async () => {
    const before = servers().map((p) => p.pid);
    const shutdown = await lsp.request('shutdown', null);
    lsp.notify('exit', null);
    await sleep(1000);
    const other = await startSession();
    const ready = await other.lsp.waitForState('ready', { timeoutMs: 5000 }).then(() => true, () => false);
    const answer = await other.lsp.request('textDocument/completion', { textDocument: { uri: 'continuum-script:/never-opened.kt' }, position: { line: 0, character: 0 } });
    const after = servers().map((p) => p.pid);
    other.connection.close();
    return { ok: ready && shutdown.error === undefined && (!processesVisible || before.join() === after.join()) && answer.error?.code === -32602, detail: `shutdown result ${JSON.stringify(shutdown.result)}; processes ${before.join()} -> ${after.join()}; a new client is served at once: ${ready}` };
  });

  // 3. The server sees no workspace besides its private directory
  const [server] = servers();
  if (processesVisible && server) {
    await rec.check(group, 'the server runs inside its private directory, which is empty (no seed file, no virtual document is written)', () => {
      const directory = readCwd(server.pid);
      let entries;
      try { entries = fs.readdirSync(directory).sort(); } catch (error) { return { ok: false, detail: `cannot list ${directory}: ${error.code}` }; }
      return { ok: entries.length === 0 && path.basename(directory) === LANGUAGE, detail: `cwd ${directory}: ${entries.join(', ')}` };
    });
  } else {
    rec.skip(group, 'the server runs inside its private directory, which is empty', NO_PROCESS_VIEW);
  }
  connection.close();
}

/** The reported names as a hidden context document (the real declarations of the node's API, opened the way the editor opens them). */
async function contextGroup() {
  const group = 'context';
  if (!REPORTED.context) {
    rec.skip(group, 'the reported names as a context document', REPORTED.skip);
    return;
  }
  const { lsp, connection } = await startSession();
  await becomeReady(lsp);
  await sleep(1500);
  await openContext(lsp);
  const diagnosticsOf = async (name, text, wantAny = true) => {
    const woven = openScript(lsp, name, text);
    const params = await lsp.waitForDiagnostics(woven.uri, (d) => !wantAny || d.length > 0, { timeoutMs: 20000 }).catch(() => undefined);
    return { woven, diagnostics: params ? userDiagnostics(woven, params.diagnostics) : undefined };
  };
  await rec.check(group, 'typing `flow.` offers get, set and all after the context document was acknowledged', async () => {
    const woven = openScript(lsp, 'ctx-completion', 'flow.');
    const response = await lsp.request('textDocument/completion', { textDocument: { uri: woven.uri }, position: woven.toVirtualPosition({ line: 0, character: 5 }) });
    const found = memberNames(response.result);
    return { ok: ['get', 'set', 'all'].every((m) => found.includes(m)), detail: found.slice(0, 8).join(', ') || JSON.stringify(response.error) };
  });
  await rec.check(group, 'hovering `flow.set` shows the KDoc of the declared member', async () => {
    const woven = openScript(lsp, 'ctx-hover', 'flow.set("k", 1)');
    await lsp.request('textDocument/hover', { textDocument: { uri: woven.uri }, position: woven.toVirtualPosition({ line: 0, character: 6 }) });
    const response = await lsp.request('textDocument/hover', { textDocument: { uri: woven.uri }, position: woven.toVirtualPosition({ line: 0, character: 6 }) });
    const value = JSON.stringify(response.result?.contents ?? '');
    return { ok: /Sets or updates flow variable/.test(value), detail: value.slice(0, 140) };
  });
  await rec.check(group, '`val x: Int = flow.all()` is a type mismatch on the user\'s line', async () => {
    const { diagnostics } = await diagnosticsOf('ctx-mismatch', 'val x: Int = flow.all()');
    const found = (diagnostics ?? []).filter((d) => d.severity === 1);
    return { ok: found.length > 0 && found[0].range.start.line === 0, detail: found.map((d) => d.message).join('; ').slice(0, 120) };
  });
  await rec.check(group, 'a valid script that reads both names produces no diagnostic', async () => {
    const text = 'row["a"]?.toString() + flow.get("x")';
    const { woven, diagnostics } = await diagnosticsOf('ctx-valid', text, false);
    await lsp.quiet(2000);
    const published = lsp.diagnosticEvents({ uri: woven.uri }).flatMap((p) => p.diagnostics);
    return { ok: published.length === 0 && (diagnostics ?? []).length === 0, detail: `${published.length} diagnostic(s)` };
  });

  // Two contexts that declare the same type name differently: each script sees only its own.
  const makeContext = (member) => ({ language: 'kotlin', bindings: [{ name: 'it1', type: 'Shared' }], declarations: `interface Shared {\n  fun ${member}(): Int\n}\n` });
  await rec.check(group, 'two contexts with the same type name in one connection are isolated and raise no redeclaration', async () => {
    await openContext(lsp, makeContext('alpha'));
    const first = openScript(lsp, 'ctx-iso-a', 'it1.');
    const firstItems = memberNames(await lsp.request('textDocument/completion', { textDocument: { uri: first.uri }, position: first.toVirtualPosition({ line: 0, character: 4 }) }).then((r) => r.result));
    await openContext(lsp, makeContext('beta'));
    const second = openScript(lsp, 'ctx-iso-b', 'it1.');
    const secondItems = memberNames(await lsp.request('textDocument/completion', { textDocument: { uri: second.uri }, position: second.toVirtualPosition({ line: 0, character: 4 }) }).then((r) => r.result));
    const redeclared = [first, second].flatMap((w) => lsp.diagnosticEvents({ uri: w.uri }).flatMap((p) => p.diagnostics)).filter((d) => /redeclaration/i.test(d.message ?? ''));
    return { ok: firstItems.includes('alpha') && !firstItems.includes('beta') && secondItems.includes('beta') && !secondItems.includes('alpha') && redeclared.length === 0, detail: `first: ${firstItems.slice(0, 4)}; second: ${secondItems.slice(0, 4)}; redeclaration ${redeclared.length}` };
  });
  await rec.check(group, 'a context document at a non-virtual URI is refused, and closing the real one frees it', async () => {
    const refused = await lsp.request('textDocument/documentSymbol', { textDocument: { uri: 'file:///etc/ctx.kt' } });
    lsp.notify('textDocument/didOpen', { textDocument: { uri: 'file:///etc/ctx.kt', languageId: 'kotlin', version: 1, text: 'package continuum.x' } });
    const afterRefusedOpen = await lsp.request('textDocument/documentSymbol', { textDocument: { uri: 'file:///etc/ctx.kt' } });
    const context = lsp.scriptContext;
    lsp.closeDocument(context.uri);
    await sleep(300);
    const closed = await lsp.request('textDocument/documentSymbol', { textDocument: { uri: context.uri } });
    return { ok: isRefusal(refused) && isRefusal(afterRefusedOpen) && isRefusal(closed, 'textDocument/documentSymbol'), detail: `non-virtual: ${refused.error?.code}/${afterRefusedOpen.error?.code}; after close: ${closed.error?.code ?? 'answered'}` };
  });
  connection.close();
}

/**
 * Folders the backend might wrongly offer as a workspace (LEAK_PROBE_DIR): a Kotlin file planted in each must stay invisible to
 * the server, whose only root is its private directory. Its own group so a run as another user (the image's `/app` is root-owned)
 * can do just this: ONLY=leak.
 */
async function leakGroup() {
  const group = 'leak';
  if (LEAK_PROBE_DIRS.length === 0) {
    rec.skip(group, 'a Kotlin file in the backend\'s workspace folder is invisible to the server', 'LEAK_PROBE_DIR is not set (image: /home/continuum/workspace,/app)');
    return;
  }
  const { connection, lsp } = await startSession();
  await becomeReady(lsp);
  for (const [index, directory] of LEAK_PROBE_DIRS.entries()) {
    const probePackage = `systestleak${runId}x${index}`;
    const probeFile = path.join(directory, `SystestLeak${runId}x${index}.kt`);
    try {
      fs.writeFileSync(probeFile, `package ${probePackage}\n\nobject Leak { val secret = 42 }\n`);
    } catch (error) {
      rec.skip(group, `a Kotlin file in ${directory} is invisible to the server`, `NOT VERIFIED: cannot write the probe file there: ${error.code}`);
      continue;
    }
    try {
      await rec.check(group, `a Kotlin file in ${directory} (a folder the backend could offer as workspace) is invisible to the server`, async () => {
        const text = `import ${probePackage}.Leak\nval s = Leak.secret\nval ctx = continuum.ScriptFlowVariables()`; // no context document is open here: continuum.ScriptFlowVariables must not exist
        const woven = openScript(lsp, `leak-probe-${index}`, text);
        const params = await lsp.waitForDiagnostics(woven.uri, (d) => d.length > 0, { timeoutMs: 20000 });
        const unresolved = userDiagnostics(woven, params.diagnostics).filter((d) => /unresolved reference/i.test(d.message));
        const importLineUnresolved = unresolved.some((d) => d.range.start.line === 0);
        const noSeed = unresolved.some((d) => d.range.start.line === 2 && /ScriptFlowVariables/.test(d.message));
        return { ok: importLineUnresolved && noSeed, detail: `import of ${probePackage}.Leak unresolved: ${importLineUnresolved} (continuum.ScriptFlowVariables is unresolved without a context document, so nothing is seeded: ${noSeed})` };
      });
    } finally {
      fs.rmSync(probeFile, { force: true });
    }
  }
  connection.close();
}

/** A realistic script: `lines` declarations, then the documented use of `row` and `flow` (only when the reported names are known). `variant` changes every literal. */
const scriptOf = (tag, variant = 0, lines = 30) => `${Array.from({ length: lines }, (_, i) => `val v${tag}_${i}: Int = ${i + variant}`).join('\n')}\n${REPORTED.context ? 'flow.get("x")?.toString() + row["a"]' : 'val last = 1'}`;
const endOfScript = (text) => ({ line: text.split('\n').length - 1, character: 5 });
const completeAtEnd = (lsp, woven, text, timeoutMs = 20000) => lsp.request('textDocument/completion', { textDocument: { uri: woven.uri }, position: woven.toVirtualPosition(endOfScript(text)) }, { timeoutMs })
  .catch((error) => ({ error: { code: 'timeout', message: String(error.message).slice(0, 80) }, ms: timeoutMs }));
const failureOf = (response) => (response.error ? `${response.error.code} ${String(response.error.message).slice(0, 40)}` : undefined);
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function memoryGroup() {
  const group = 'memory';
  if (!processesVisible) {
    ['the server process is started with -Xmx', 'one editor: resident memory stays below the restart ceiling', `${SEVERAL_EDITORS} editors at once: all are served and memory stays below the restart ceiling`]
      .forEach((name) => rec.skip(group, name, NO_PROCESS_VIEW));
    return;
  }
  const { lsp, connection } = await startSession();
  await becomeReady(lsp);
  if (REPORTED.context) await openContext(lsp);
  await sleep(1500);
  const [server] = servers();
  if (!server) {
    rec.record(group, 'a server process is running for the memory checks', false, `no language server process under backend pid ${backendPid}`);
    connection.close();
    return;
  }
  const pid = server.pid;
  const flags = server.cmdline.join(' ');
  await rec.check(group, `the server process is started with -Xmx${XMX_MB}m (and the other JVM limits)`, () => ({
    ok: flags.includes(`-Xmx${XMX_MB}m`) && /-XX:\+UseSerialGC/.test(flags) && /ReservedCodeCacheSize=64m/.test(flags) && /MaxMetaspaceSize=192m/.test(flags),
    detail: server.cmdline.filter((arg) => arg.startsWith('-X')).join(' '),
  }));

  const samples = [];
  const sampler = setInterval(() => { const mb = rssMb(pid); if (mb !== undefined) { samples.push(mb); } }, 400);
  const restarted = () => servers()[0]?.pid !== pid || lsp.states.at(-1) !== 'ready';
  const headroom = (peak) => `${MEMORY_LIMIT_MB - peak} MB (${Math.round(((MEMORY_LIMIT_MB - peak) / MEMORY_LIMIT_MB) * 100)} %) below the ${MEMORY_LIMIT_MB} MB ceiling`;
  const hwmMb = () => Math.round((readProcess(pid)?.vmHwmKb ?? 0) / 1024);
  try {
    // One editor, as the Script editor behaves: open once, a change per edit, a completion now and then.
    const from = samples.length;
    const failures = [];
    const latencies = [];
    let text = scriptOf('one', 0);
    let woven = weave(lsp, text, key('one-editor'));
    lsp.open(woven.uri, woven.text);
    await sleep(1500);
    for (let edit = 1; edit <= 100; edit++) {
      text = scriptOf('one', edit);
      woven = weave(lsp, text, key('one-editor'));
      lsp.change(woven.uri, woven.text, edit + 1);
      await sleep(150);
      if (edit % 10 === 0) {
        const response = await completeAtEnd(lsp, woven, text);
        latencies.push(response.ms);
        failures.push(failureOf(response));
      }
    }
    await sleep(2000);
    lsp.closeDocument(woven.uri);
    const peakOne = Math.max(...samples.slice(from));
    await rec.check(group, `one editor (a 30-line script, 100 edits, 10 completions): resident memory stays below the ${MEMORY_LIMIT_MB} MB restart ceiling, no restart, every answer served`, () => ({
      ok: peakOne < MEMORY_LIMIT_MB && !restarted() && failures.every((f) => f === undefined),
      detail: `${coldStart?.rssAfterReadyMb ? `${coldStart.rssAfterReadyMb} MB 2 s after the cold start; ` : ''}${samples[from]} MB when the edits began, peak ${peakOne} MB = ${headroom(peakOne)} (kernel high-water mark ${hwmMb()} MB); completions median ${median(latencies)} ms, max ${Math.max(...latencies)} ms; failures: ${failures.filter(Boolean).join(', ') || 'none'}; restarted: ${restarted()}`,
    }));

    // Several editors at once: one script each, a completion in each, none closed until all are open.
    const fromMany = samples.length;
    const open = [];
    const answers = [];
    for (let n = 1; n <= SEVERAL_EDITORS; n++) {
      const scriptText = scriptOf(`m${n}`, 0);
      const doc = weave(lsp, scriptText, key(`several-${n}`));
      lsp.open(doc.uri, doc.text);
      open.push(doc);
      await sleep(700);
      answers.push(await completeAtEnd(lsp, doc, scriptText));
    }
    await sleep(1500);
    const peakMany = Math.max(...samples.slice(fromMany));
    await rec.check(group, `${SEVERAL_EDITORS} editors at once (a 30-line script each): every completion is served without error, memory stays below the restart ceiling, no restart`, () => ({
      ok: answers.every((a) => !a.error && a.ms < 5000) && peakMany < MEMORY_LIMIT_MB && !restarted(),
      detail: `completions ${answers.map((a) => (a.error ? failureOf(a) : `${a.ms} ms`)).join(', ')}; peak ${peakMany} MB = ${headroom(peakMany)}; restarted: ${restarted()}`,
    }));
    open.forEach((doc) => lsp.closeDocument(doc.uri));
  } finally {
    clearInterval(sampler);
  }
  connection.close();
}

/**
 * Cold-start window (needs the process view and IDLE_TIMEOUT_SECONDS: each sample needs a server that has not been started
 * yet). A script opened while the server starts, or in the first moments after it became ready, used to get no diagnostics
 * until the next edit. The bridge now re-sends every open document `NUDGE_DELAY_MS` after `ready`; this sweeps the moment of
 * the open across that instant and checks two things per sample: the diagnostics arrive, and the FIRST edit the editor makes
 * afterwards (the next document version, as an editor numbers it) is applied by the server, i.e. neither the diagnostics nor a
 * completion on the new text are stale. Samples opened after the re-send are the control for the second check.
 */
async function coldWindowGroup() {
  const group = 'coldwindow';
  const names = ['a script opened around the moment a cold server becomes ready gets its diagnostics', 'the first edit after the bridge re-sent the open documents is applied by the server', coldManyName(), TYPED_ERROR_NAME];
  if (!processesVisible || !IDLE_SECONDS) {
    names.forEach((name) => rec.skip(group, name, !processesVisible ? NO_PROCESS_VIEW : 'IDLE_TIMEOUT_SECONDS (the backend\'s idle timeout) is not set: each sample needs a server that has stopped, which takes the idle timeout'));
    return;
  }
  const brokenText = 'val broken: Int = "a"';
  const editedText = 'val fixed: Int = "abc".length';
  const samples = [];
  for (const offsetMs of COLDWINDOW_OFFSETS) {
    const sample = { offsetMs };
    samples.push(sample);
    if (!(await until(() => servers().length === 0, (IDLE_SECONDS + 25) * 1000))) {
      sample.skipped = `a server was still running ${IDLE_SECONDS + 25} s after the previous sample (another connection holds it)`;
      continue;
    }
    const { lsp, connection } = await startSession();
    try {
      // The editor-like path: `initialize` is sent at once and answered when the server is ready.
      const handshake = lsp.request('initialize', { processId: null, rootUri: null, capabilities: {} }, { timeoutMs: START_TIMEOUT_MS }).catch(() => undefined);
      await lsp.waitForState('ready', { timeoutMs: START_TIMEOUT_MS });
      const readyAt = Date.now();
      await handshake;
      lsp.notify('initialized', {});
      await sleep(Math.max(0, offsetMs - (Date.now() - readyAt)));
      const broken = weave(lsp, brokenText, key(`cold-${offsetMs}`));
      const from = lsp.mark();
      const openedAt = Date.now();
      sample.openedAfterReadyMs = openedAt - readyAt;
      lsp.open(broken.uri, broken.text, { version: 1 });
      const first = await lsp.waitForDiagnostics(broken.uri, (d) => d.length > 0, { timeoutMs: 12000, from }).catch(() => undefined);
      sample.diagnosticsMs = first ? Date.now() - openedAt : undefined;

      // The first edit an editor makes after the open is version 2. Wait until the re-send (if any) is over and analysed.
      await sleep(Math.max(0, NUDGE_DELAY_MS + 1500 - (Date.now() - readyAt)));
      const edited = weave(lsp, editedText, key(`cold-${offsetMs}`));
      const probe = async (version) => {
        const mark = lsp.mark();
        lsp.change(edited.uri, edited.text, version);
        const completion = completeAt(lsp, edited, { line: 0, character: editedText.length }, 10000);
        const cleared = await lsp.waitForDiagnostics(edited.uri, (d) => userDiagnostics(edited, d).filter((x) => x.severity === 1).length === 0, { timeoutMs: 10000, from: mark }).then(() => true, () => false);
        const answer = await completion;
        const members = memberNames(answer.result);
        return { diagnosticsCleared: cleared, completionSeesEdit: !answer.error && members.includes('length'), completion: answer.error ? failureOf(answer) : `${members.length} item(s) without \`length\`` };
      };
      sample.firstEdit = await probe(2);
      if (!sample.firstEdit.diagnosticsCleared || !sample.firstEdit.completionSeesEdit) {
        sample.nextEdit = await probe(3); // is the document alive at all: a later version is honoured
      }
    } catch (error) {
      sample.error = String(error?.message ?? error).slice(0, 200);
    } finally {
      connection.close();
    }
  }
  const ran = samples.filter((s) => !s.skipped && !s.error);
  const describe = (s) => `+${s.offsetMs} ms: ${s.diagnosticsMs === undefined ? 'NO diagnostics in 12 s' : `diagnostics in ${s.diagnosticsMs} ms`}; first edit ${s.firstEdit.diagnosticsCleared ? 'cleared the diagnostics' : 'left the diagnostics stale'}, completion ${s.firstEdit.completionSeesEdit ? 'saw the edit' : `did not see it (${s.firstEdit.completion})`}${s.nextEdit ? `; the next version ${s.nextEdit.diagnosticsCleared && s.nextEdit.completionSeesEdit ? 'was applied' : 'was not applied either'}` : ''}`;
  samples.filter((s) => s.skipped).forEach((s) => rec.skip(group, `a script opened ${s.offsetMs} ms after a cold server became ready gets its diagnostics`, s.skipped));
  samples.filter((s) => s.error).forEach((s) => rec.record(group, `a script opened ${s.offsetMs} ms after a cold server became ready gets its diagnostics (within 10 s)`, false, `the sample could not run to the end: ${s.error}`));
  for (const sample of ran) {
    await rec.check(group, `a script opened ${sample.offsetMs} ms after a cold server became ready gets its diagnostics (within 10 s)`, () => ({
      ok: sample.diagnosticsMs !== undefined && sample.diagnosticsMs < 10000,
      detail: sample.diagnosticsMs === undefined ? 'no diagnostics within 12 s (a later edit of the document publishes them)' : `${sample.diagnosticsMs} ms after the open (the open came ${sample.openedAfterReadyMs} ms after the ready notice)`,
    }));
  }
  await severalDocumentsWhileStarting(group);
  await typedErrorWhileStarting(group);
  if (ran.length === 0) {
    rec.skip(group, names[1], 'no sample could run');
    return;
  }
  const dropped = ran.filter((s) => !s.firstEdit.diagnosticsCleared || !s.firstEdit.completionSeesEdit);
  await rec.check(group, `${names[1]} (document version 2, as an editor numbers it; diagnostics update and a completion sees the new text)`, () => ({
    ok: dropped.length === 0,
    detail: dropped.length === 0 ? ran.map(describe).join(' | ') : `first edit ignored at ${dropped.map((s) => `+${s.offsetMs} ms`).join(', ')} of ${ran.map((s) => `+${s.offsetMs}`).join(', ')} | ${ran.map(describe).join(' | ')}`,
  }));
}

/**
 * Several scripts opened one right after another while a cold server is still starting: the bridge replays them to the server
 * back to back when it becomes ready (a server may drop the analysis of a document when another arrives a few ms later), so
 * each of them must still get its diagnostics, within 10 s of the ready notice.
 */
async function severalDocumentsWhileStarting(group) {
  const documents = COLD_MANY_DOCUMENTS;
  const name = coldManyName();
  if (!(await until(() => servers().length === 0, (IDLE_SECONDS + 25) * 1000))) {
    rec.skip(group, name, `a server was still running ${IDLE_SECONDS + 25} s after the previous sample (another connection holds it)`);
    return;
  }
  const { lsp, connection } = await startSession();
  try {
    const handshake = lsp.request('initialize', { processId: null, rootUri: null, capabilities: {} }, { timeoutMs: START_TIMEOUT_MS }).catch(() => undefined);
    const wasStarting = lsp.lastState !== 'ready';
    const opened = Array.from({ length: documents }, (_, index) => weave(lsp, `val broken${index}: Int = "a"`, key(`cold-many-${index}`)));
    opened.forEach((doc) => lsp.open(doc.uri, doc.text, { version: 1 }));
    await lsp.waitForState('ready', { timeoutMs: START_TIMEOUT_MS });
    const readyAt = Date.now();
    await handshake;
    lsp.notify('initialized', {});
    const arrivals = await Promise.all(opened.map((doc) => lsp.waitForDiagnostics(doc.uri, (d) => d.length > 0, { timeoutMs: 12000 }).then(() => Date.now() - readyAt, () => undefined)));
    await rec.check(group, name, () => ({
      ok: wasStarting && arrivals.every((ms) => ms !== undefined && ms < 10000),
      detail: `${wasStarting ? 'opened before the ready notice' : 'the server was already ready when they were opened (no cold start)'}; diagnostics after the ready notice: ${arrivals.map((ms) => (ms === undefined ? 'NONE in 12 s' : `${ms} ms`)).join(', ')}`,
    }));
  } catch (error) {
    rec.record(group, name, false, `the sample could not run to the end: ${String(error?.message ?? error).slice(0, 200)}`);
  } finally {
    connection.close();
  }
}

/**
 * The first-edit guarantee as a user meets it: a clean script is open while the server starts (the bridge replays it when the server
 * is ready and re-sends it once more `NUDGE_DELAY_MS` later), and the first thing typed afterwards is a mistake. The editor numbers
 * that edit as document version 2; the red marker must appear at the typed line, and the lines above it stay clean.
 */
async function typedErrorWhileStarting(group) {
  const name = TYPED_ERROR_NAME;
  if (!(await until(() => servers().length === 0, (IDLE_SECONDS + 25) * 1000))) {
    rec.skip(group, name, `a server was still running ${IDLE_SECONDS + 25} s after the previous sample (another connection holds it)`);
    return;
  }
  const cleanText = 'val greeting = "hello"\nval size: Int = greeting.length';
  const typedText = `${cleanText}\nval oops: Int = "typed"`;
  const typedLine = 2;
  const { lsp, connection } = await startSession();
  try {
    const handshake = lsp.request('initialize', { processId: null, rootUri: null, capabilities: {} }, { timeoutMs: START_TIMEOUT_MS }).catch(() => undefined);
    const clean = weave(lsp, cleanText, key('cold-typed'));
    lsp.open(clean.uri, clean.text, { version: 1 });
    await lsp.waitForState('ready', { timeoutMs: START_TIMEOUT_MS });
    const readyAt = Date.now();
    await handshake;
    lsp.notify('initialized', {});
    await sleep(Math.max(0, NUDGE_DELAY_MS + 1500 - (Date.now() - readyAt)));
    const typed = weave(lsp, typedText, key('cold-typed'));
    const mark = lsp.mark();
    const typedAt = Date.now();
    lsp.change(typed.uri, typed.text, 2);
    const isTypedError = (x) => x.severity === 1 && x.range.start.line === typedLine;
    const params = await lsp.waitForDiagnostics(typed.uri, (d) => userDiagnostics(typed, d).some(isTypedError), { timeoutMs: 10000, from: mark }).catch(() => undefined);
    const found = params ? userDiagnostics(typed, params.diagnostics).find(isTypedError) : undefined;
    const above = params ? userDiagnostics(typed, params.diagnostics).filter((x) => x.severity === 1 && x.range.start.line < typedLine) : [];
    await rec.check(group, name, () => ({
      ok: found !== undefined && above.length === 0,
      detail: found === undefined
        ? `no error at line ${typedLine} within 10 s of the edit (the server never saw the typed text); diagnostics since: ${JSON.stringify(lsp.diagnosticEvents({ uri: typed.uri, from: mark }).map((p) => p.diagnostics.length))}`
        : `error at line ${found.range.start.line}, column ${found.range.start.character} ${Date.now() - typedAt} ms after the edit: ${String(found.message).slice(0, 80)}; errors above it: ${above.length}`,
    }));
  } catch (error) {
    rec.record(group, name, false, `the sample could not run to the end: ${String(error?.message ?? error).slice(0, 200)}`);
  } finally {
    connection.close();
  }
}

/** A completion at a position of the user's script; resolves `{ result, error, ms }`, never rejects. */
function completeAt(lsp, woven, position, timeoutMs = 20000) {
  return lsp.request('textDocument/completion', { textDocument: { uri: woven.uri }, position: woven.toVirtualPosition(position) }, { timeoutMs })
    .catch((error) => ({ error: { code: 'timeout', message: String(error.message).slice(0, 80) }, ms: timeoutMs }));
}

/**
 * Opt-in (ONLY=exhaustion): opens scripts one after the other, none closed, until the server fails to answer (its heap is
 * full), then keeps asking the way an editor does (a completion about once a second) and watches what the bridge does:
 * whether it replaces the failing server, which state it ends in (serving again, or unavailable), what every server process
 * of the run was started with and how much memory it used, and whether closing the scripts brings a working server back.
 * The healthy answers are "no failure up to EXHAUSTION_DOCUMENTS scripts" or "replaced, and serving or unavailable at the end".
 */
async function exhaustionGroup() {
  const group = 'exhaustion';
  if (!processesVisible) {
    rec.skip(group, 'a server whose heap is full is replaced by the bridge', NO_PROCESS_VIEW);
    return;
  }
  const { lsp, connection } = await startSession();
  await becomeReady(lsp);
  if (REPORTED.context) await openContext(lsp);
  await sleep(1500);

  // Every server process of this group, with its flags and its memory: a replaced server is a new process.
  const processes = new Map();
  const observe = () => {
    for (const server of servers()) {
      const info = readProcess(server.pid);
      if (!info) { continue; }
      const entry = processes.get(server.pid) ?? { firstSeenAt: Date.now(), flags: info.cmdline.filter((arg) => arg.startsWith('-X')).join(' '), peakRssMb: 0, hwmMb: 0 };
      entry.peakRssMb = Math.max(entry.peakRssMb, Math.round((info.vmRssKb ?? 0) / 1024));
      entry.hwmMb = Math.max(entry.hwmMb, Math.round((info.vmHwmKb ?? 0) / 1024));
      processes.set(server.pid, entry);
    }
  };
  observe();
  const watcher = setInterval(observe, 1000);
  const firstPid = [...processes.keys()][0];
  const statesBase = lsp.states.length; // a `starting` notice after this point is a replacement of the server
  const texts = new Map();
  const open = [];
  let firstFailure;
  let end;
  let soak;
  try {
    for (let n = 1; n <= EXHAUSTION_LIMIT && !firstFailure; n++) {
      const scriptText = scriptOf(`x${n}`, 0);
      const doc = weave(lsp, scriptText, key(`exhaust-${n}`));
      texts.set(doc.uri, scriptText);
      lsp.open(doc.uri, doc.text);
      open.push(doc);
      await sleep(700);
      const response = await completeAtEnd(lsp, doc, scriptText, 45000);
      if (response.error || response.ms > 10000) {
        firstFailure = { n, ms: response.ms, failure: failureOf(response) ?? 'no error, but very slow', data: JSON.stringify(response.error?.data ?? '').slice(0, 300) };
      }
    }
    observe();
    const rssAtFailure = processes.get(firstPid)?.peakRssMb;
    rec.record(group, 'how many scripts can be open at once (measurement; the failure is judged by the checks below)', true, firstFailure
      ? `the ${firstFailure.n}th open script failed (${firstFailure.failure} after ${firstFailure.ms} ms, RSS ${rssMb(firstPid) ?? 'n/a'} MB, peak ${rssAtFailure} MB; error data: ${firstFailure.data})`
      : `no failure up to ${open.length} open scripts (RSS ${rssMb(firstPid) ?? 'n/a'} MB)`);

    if (firstFailure) {
      end = await watchAfterFailure(lsp, open, texts, statesBase);
      if (end.verdict === 'serving' && EXHAUSTION_SOAK_MS > 0) {
        soak = await soakAfterReplacement(lsp, open, texts, statesBase);
      }
    }
  } finally {
    clearInterval(watcher);
  }
  observe();

  const all = [...processes.entries()];
  const memory = all.map(([pid, p]) => `pid ${pid}: peak RSS ${p.peakRssMb} MB (kernel high-water ${p.hwmMb} MB)`).join('; ');
  if (firstFailure) {
    await rec.check(group, 'a server whose heap is full is replaced by the bridge while the editors stay open (a starting state follows the first failed answer)', () => ({
      ok: end.restartAfterMs !== undefined,
      detail: end.restartAfterMs !== undefined ? `replacement began ${Math.round(end.restartAfterMs / 100) / 10} s after the first failed answer; ${end.restarts} restart(s) in ${Math.round(end.watchedMs / 1000)} s; processes seen: ${all.length}` : `no new starting state in ${Math.round(end.watchedMs / 1000)} s: the failing server was left in place (states ${lsp.states.join('>')})`,
    }));
    await rec.check(group, 'the exhaustion ends in a defined state, not a silent hang: the server serves again (30 s of answers) or the bridge reports it unavailable', () => ({
      ok: end.verdict === 'serving' || end.verdict === 'unavailable',
      detail: `${end.verdict}: ${end.detail}; states since the failure: ${end.states.join('>') || 'none'}`,
    }));
    if (soak) {
      await rec.check(group, `the replaced server keeps up while the editors keep typing (${Math.round(EXHAUSTION_SOAK_MS / 1000)} s of edits on the open scripts): it serves, or is replaced again, or the bridge reports it unavailable; it is never left failing`, () => ({
        ok: soak.verdict !== 'failing' && soak.verdict !== 'connection-closed',
        detail: `${soak.verdict}: ${soak.detail}`,
      }));
    }
  } else {
    rec.record(group, 'a server whose heap is full is replaced by the bridge, or never fills up', true, `no failure up to ${open.length} open scripts`);
  }

  // Back to a working server: close the scripts; when the bridge gave up, the old connection is renewed.
  let working = connection;
  let workingLsp = lsp;
  if (!lsp.closed) {
    open.forEach((doc) => lsp.closeDocument(doc.uri));
  }
  await sleep(3000);
  if (end?.verdict === 'unavailable' || lsp.lastState === 'unavailable' || lsp.closed) {
    connection.close();
    ({ connection: working, lsp: workingLsp } = await startSession());
    await workingLsp.waitForState('ready', { timeoutMs: START_TIMEOUT_MS }).catch(() => undefined);
    await workingLsp.initialize().catch(() => undefined);
    if (REPORTED.context) await openContext(workingLsp).catch(() => undefined);
  }
  const fresh = scriptOf('after', 0);
  const freshDoc = weave(workingLsp, fresh, key('exhaust-after'));
  workingLsp.open(freshDoc.uri, freshDoc.text);
  await sleep(1500);
  let last;
  const recovered = await until(async () => { last = await completeAtEnd(workingLsp, freshDoc, fresh, 8000); return !last.error && last.ms < 5000; }, 60000, 2000);
  if (firstFailure) {
    await rec.check(group, `after the scripts are closed${end?.verdict === 'unavailable' ? ' and the connection is renewed' : ''} a working server answers again (completion within 5 s on a fresh script)`, () => ({
      ok: recovered,
      detail: recovered ? `served in ${last.ms} ms` : `still failing after 60 s: ${failureOf(last)}; states ${workingLsp.states.join('>')}`,
    }));
  }
  await rec.check(group, `every server process of the run was started with -Xmx${XMX_MB}m (the heap cap is unchanged) and stayed below the ${MEMORY_LIMIT_MB} MB restart ceiling`, () => ({
    ok: all.length > 0 && all.every(([, p]) => p.flags.includes(`-Xmx${XMX_MB}m`)) && all.every(([, p]) => p.hwmMb < MEMORY_LIMIT_MB),
    detail: `${memory}; flags ${[...new Set(all.map(([, p]) => p.flags))].join(' || ')}`,
  }));
  working.close();
}

/**
 * After the first failed answer: keeps sending the completion an editor would send (on the last opened script, about once a
 * second), counts the restarts the bridge reports, and stops at `unavailable`, at 30 s of answers after a restart, or at the
 * watch budget. Resolves what was seen.
 */
async function watchAfterFailure(lsp, open, texts, statesBase) {
  const since = Date.now();
  const last = open.at(-1);
  const answers = [];
  let restartAt = lsp.states.slice(statesBase).includes('starting') ? since : undefined; // began before the watch did
  let servingSince;
  let verdict = 'undecided';
  let detail = '';
  while (Date.now() - since < EXHAUSTION_WATCH_MS) {
    const response = await completeAtEnd(lsp, last, texts.get(last.uri), 20000);
    const ok = !response.error && response.ms < 10000;
    answers.push({ at: Date.now(), ok });
    const states = lsp.states.slice(statesBase);
    if (restartAt === undefined && states.includes('starting')) { restartAt = Date.now(); }
    if (states.includes('unavailable') || lsp.lastState === 'unavailable') {
      verdict = 'unavailable';
      detail = `the bridge reported unavailable ${Math.round((Date.now() - since) / 1000)} s after the first failed answer`;
      break;
    }
    if (ok && restartAt !== undefined && lsp.lastState === 'ready') {
      servingSince = servingSince ?? Date.now();
      if (Date.now() - servingSince >= 30000) {
        verdict = 'serving';
        detail = `serving again: answers for 30 s after the replacement, ${Math.round((Date.now() - since) / 1000)} s after the first failed answer`;
        break;
      }
    } else {
      servingSince = undefined;
    }
    if (lsp.closed) { verdict = 'connection-closed'; detail = 'the channel was closed by the backend'; break; }
    await sleep(1000);
  }
  const states = lsp.states.slice(statesBase);
  if (verdict === 'undecided') {
    const tail = answers.slice(-10);
    detail = `${Math.round((Date.now() - since) / 1000)} s watched, ${answers.filter((a) => a.ok).length}/${answers.length} answers served, last 10: ${tail.map((a) => (a.ok ? 'ok' : 'fail')).join(',')}`;
  }
  return { verdict, detail, states, restarts: states.filter((s) => s === 'starting').length, restartAfterMs: restartAt === undefined ? undefined : restartAt - since, watchedMs: Date.now() - since };
}

/**
 * After a replacement that serves again: keeps the editors typing (a full-text change of one open script, then the completion
 * an editor asks for, about once a second, rotating over the open scripts) for EXHAUSTION_SOAK_SECONDS. Resolves whether the
 * replacement kept up (`serving`), was replaced again or given up on (`unavailable`), or was left failing (`failing`).
 */
async function soakAfterReplacement(lsp, open, texts, statesBase) {
  const since = Date.now();
  const restartsBefore = lsp.states.slice(statesBase).filter((s) => s === 'starting').length;
  const answers = [];
  let edits = 0;
  let verdict = 'serving';
  while (Date.now() - since < EXHAUSTION_SOAK_MS) {
    if (lsp.closed) { verdict = 'connection-closed'; break; }
    if (lsp.lastState === 'unavailable') { verdict = 'unavailable'; break; }
    const doc = open[edits % open.length];
    edits++;
    lsp.change(doc.uri, `${doc.text}\n// soak ${edits}`, 100 + edits);
    const response = await completeAtEnd(lsp, doc, texts.get(doc.uri), 20000);
    answers.push({ ok: !response.error && response.ms < 10000 });
    await sleep(1000);
  }
  const states = lsp.states.slice(statesBase);
  const restarts = states.filter((s) => s === 'starting').length - restartsBefore;
  const tail = answers.slice(-10);
  if (verdict === 'serving' && tail.length > 0 && tail.every((a) => !a.ok)) { verdict = 'failing'; }
  return {
    verdict,
    detail: `${Math.round((Date.now() - since) / 1000)} s, ${edits} edit(s) on ${open.length} open scripts, ${answers.filter((a) => a.ok).length}/${answers.length} completions served, ${restarts} further restart(s), state now ${lsp.lastState}`,
  };
}

async function protocolGroup() {
  const group = 'protocol';
  const unexpected = [];
  let total = 0;
  let leaks = [];
  for (const lsp of sessions) {
    for (const message of lsp.messages) {
      total++;
      const isState = message.method === 'continuum/serverState' && ['starting', 'ready', 'unavailable'].includes(message.params?.state);
      const isDiagnostics = message.method === 'textDocument/publishDiagnostics' && String(message.params?.uri).startsWith('continuum-script:/');
      const isResponse = message.method === undefined && message.id !== undefined;
      if (!isState && !isDiagnostics && !isResponse) { unexpected.push(JSON.stringify(message).slice(0, 100)); }
    }
    leaks = leaks.concat(lsp.channel.received.filter((text) => text.includes('file:/') || (privateDirectory && text.includes(privateDirectory))));
  }
  await rec.check(group, `only state notices, diagnostics and responses reached the clients (${total} messages over ${sessions.length} connections)`, () => ({ ok: unexpected.length === 0 && sessions.every((s) => s.invalid.length === 0), detail: unexpected.slice(0, 3).join(' | ') }));
  await rec.check(group, 'the server\'s own file: paths and private directory never reach a client', () => ({ ok: leaks.length === 0, detail: leaks.slice(0, 2).map((l) => l.slice(0, 100)).join(' | ') }));
  await rec.check(group, 'the server never sends a request to a client (the bridge answers them itself)', () => ({ ok: sessions.every((s) => s.serverRequests.length === 0), detail: '' }));
}

// ---- main --------------------------------------------------------------------------------------------------------------
console.log(`kotlin-lsp-bridge  ${BASE}  run ${runId}${OFFLINE ? '  (offline)' : ''}  backend pid ${backendPid ?? 'unknown'}${processesVisible ? '' : ' (process checks SKIPped)'}  idle timeout ${IDLE_SECONDS ?? 'unknown'} s`);
try {
  // The lifecycle group needs a server that has not been started yet, so it goes first; the others share one running server.
  if (rec.selected('lifecycle')) { await lifecycleGroup(); }
  if (rec.selected('coldwindow')) { await coldWindowGroup(); }
  if (rec.selected('handshake')) { await handshakeGroup(); }
  if (rec.selected('offline')) { await offlineGroup(); }
  if (rec.selected('diagnostics')) { await intelligenceGroup(); }
  if (rec.selected('packaging')) { const s = await startSession(); await becomeReady(s.lsp); await packagingGroup(s.lsp); s.connection.close(); }
  if (rec.selected('documents')) { await documentsGroup(); }
  if (rec.selected('context')) { await contextGroup(); }
  if (rec.selected('security')) { await securityGroup(); }
  if (rec.selected('leak')) { await leakGroup(); }
  if (rec.selected('memory')) { await memoryGroup(); }
  if (ONLY.includes('exhaustion')) {
    await exhaustionGroup();
  } else if (rec.selected('exhaustion')) {
    rec.skip('exhaustion', 'a server whose heap is full is replaced by the bridge', 'opt-in: it overloads the server on purpose; run with ONLY=exhaustion');
  }
  if (rec.selected('protocol')) { await protocolGroup(); }
} catch (error) {
  rec.record('suite', 'the suite ran to the end', false, error?.stack ?? String(error));
} finally {
  connections.forEach((connection) => connection.close());
  await sleep(500);
}
const summary = rec.summary();
console.log(`\n${summary.pass} passed, ${summary.fail} failed, ${summary.skip} skipped (NOT VERIFIED), ${summary.knownGap} known gaps, ${summary.total} checks`);
process.exit(rec.exitCode());
