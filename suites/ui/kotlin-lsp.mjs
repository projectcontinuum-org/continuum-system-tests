// Browser scenarios for Kotlin language-server support in the workbench: the Kotlin Script node's code editor in the node
// dialog (completion, hover, signature help, diagnostics, server loss, two dialogs, save) and `.kt` / `.kts` files in the
// normal file editor, plus the dialog/file-editor interplay (language registration, server processes, first-run prompts).
//
// Needs only a running workbench, NO platform stack: the node dialog is built from the schema stored in the `.cwf` itself.
// (The platform proxy of lib.mjs is therefore not used; `/api-server` and `/credentials-server` 404 in the console, ignore.)
// The node reports the names its script can use (`options.scriptContext`); the suite builds that report from the real source of the
// node's API in the sibling repository continuum-feature-base (FEATURE_BASE_DIR overrides) and SKIPs the scenarios that need it when absent.
//
// Run (from continuum-system-tests; Node and Java come from an interactive shell, see the factory's local policy):
//   WORKBENCH_URL=http://127.0.0.1:3002 BACKEND_PID=<pid of the workbench backend> SHOT_DIR=/abs/dir \
//     node suites/ui/kotlin-lsp.mjs
//   ONLY=<name>[,<name>...]   run only some scenarios; names: first-open completion valid diagnostics hover sighelp unclosed header
//                             fallback kill-early channel twodialogs twocontexts no-context bad-context save rest-unchanged editor-heights dark-theme kt-file journey hung
//                             (default: all except `hung`, which waits minutes for the server's health watchdog; ONLY=hung runs it)
//
// Scenarios:
//   first-open        a stored, erroneous script gets its markers on a COLD server without any edit (first-open nudge); a dialog alone
//                     starts exactly one server process and never the file-editor extension's
//   completion        `flow.` and `row.` offer their members and the popup is really visible (not clipped by the editor box)
//   valid             a correct script has no diagnostics     diagnostics   marker line/column = editor text
//   hover             `flow.set` hover (signature + KDoc)     sighelp       `flow.set(` signature help
//   unclosed          a missing `}` / `)` is flagged on the last user line (errors only)
//   header            a leading block comment / KDoc / `@file:` line before imports causes no false error and keeps exact positions
//   fallback          server killed -> starting -> restarted; killed again and again -> unavailable; editing + Save keep working
//   kill-early        the server is killed while it is still starting: back-off restart, dialog ends ready with its markers
//   channel           the channel open is held back in the test browser: chip -> unavailable after the watchdog, retries, late wire
//                     adopted; no uncaught "channel already open" error, exactly one connection and no doubled markers afterwards
//   kt-file           `.kt` / `.kts` in the file editor (completion, hover, diagnostics, extension environment)
//   no-context        a node that reports no context gets a plain code editor (no chip, connection, marker); typing and saving work
//   bad-context       malformed reports (wrong types, bad name, package line, over 64 KB, not an object) give a plain editor, no error
//   twocontexts       two nodes with different contexts that declare the same type name: each completes only its own members, no
//                     redeclaration marker
//   twodialogs        two dialogs independent, one shared server, providers/markers removed on close
//   save              stored script == typed text, also after reopening the dialog and after a page reload (no hidden prelude)
//   rest-unchanged    Rest / CreateTable / Claude editors untouched (no Kotlin server of any kind, declared languages, highlighting
//                     not Kotlin's)
//   editor-heights    code editors honour the `rows` option as a cap: height, scrolling and overlap of the Rest, Claude and
//                     CreateTable editors with realistic content, compared with the former fixed cap of 15 lines
//   dark-theme        the Script dialog (popups, markers, status chip, highlighting) under the dark colour theme
//   journey           one browser session through: workspace -> workflow -> dialog -> close -> `.kt` -> dialog again; records the
//                     server processes at every step, the dialog's highlighting before/after a `.kt` was opened, first-run
//                     prompts/downloads, and `.kt` + dialog together.
//   hung              (opt-in) the server process is frozen (SIGSTOP): after three unanswered requests it is replaced by itself
//
// Env (see also lib.mjs):
//   WORKBENCH_URL       workbench under test (default http://127.0.0.1:3002)
//   SHOT_DIR            where screenshots go (ABSOLUTE path outside version control; without it a temp dir is used)
//   BACKEND_PID         pid of the workbench backend (node). Default: the listener of the WORKBENCH_URL port found with `ss`.
//                       Without a pid the server-process checks are reported NOT VERIFIED.
//   BACKEND_LOG         optional path of the backend's log; lines about language servers written during a scenario are printed
//   THEIA_CONFIG_DIR    optional config dir of the workbench under test; the first-run marker of the fwcd.kotlin extension is read from it
//   READY_TIMEOUT_MS    how long to wait for the Kotlin server to become ready (default 150000); CHIP_TIMEOUT_MS for the chip (20000)
//   KT_EXT              file kinds of the kt-file scenario (default kt,kts)
//   SHOT_PREFIX         screenshot file name prefix (default `klsp`); use a different one per run to keep earlier evidence
//
// Server processes: scenarios that count Kotlin language-server JVMs start from a COLD server: they terminate an idle server of the
// workbench's bridge (SIGTERM, only that JVM, only the Kotlin one under BACKEND_PID); the bridge does not restart a server nobody uses.
//
// Known server behaviour the scenarios are written around (not a defect of the dialog): the Kotlin server answers completion from
// the LAST COMPILED text. Right after a whole-script replacement (select all + type, or a paste) a request made within the first
// seconds can return keywords only (`file, field, property, receiver, ...`) instead of members; the scenarios then ask again (Ctrl+Space)
// like a user would and report how many times they had to.
// Test data lives in a temp workspace systest-<runId>-kotlin-lsp-* that is removed at the end (KEEP=1 keeps it).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { reportedContextFromFeatureSource } from '../../lib/kotlin-script.mjs';

const runId = Date.now().toString(36);
if (!process.env.SHOT_DIR) process.env.SHOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `systest-${runId}-kotlin-lsp-shots-`));
const { puppeteer, WORKBENCH_URL, SHOT_DIR, sleep, record, results, shot: libShot, openWorkflow, saveWorkflow, readCwf } = await import('./lib.mjs');

const READY_MS = +(process.env.READY_TIMEOUT_MS || 150000);
const CHIP_MS = +(process.env.CHIP_TIMEOUT_MS || 20000);
const BACKEND_LOG = process.env.BACKEND_LOG || '';
const CONFIG_DIR = process.env.THEIA_CONFIG_DIR || '';
const OWNER = 'language-server-kotlin-script'; // marker owner of the dialog's diagnostics
const DIALOG_LANG = 'continuum-kotlin-script'; // Monaco language id of the Script dialog's editor (not `kotlin`: that one wakes the file-editor extension)

const ac = (id, name, ok, detail = '') => record(id, name, ok, detail);
const notVerified = [];
const nv = (id, name, why) => { notVerified.push({ id, name, why }); console.log(`NOT VERIFIED  ${id}  ${name}  -- ${why}`); };
let shotNo = 0;
const SHOT_PREFIX = process.env.SHOT_PREFIX || 'klsp';
async function snap(page, label) {
  const name = `${SHOT_PREFIX}-${String(++shotNo).padStart(2, '0')}-${label}`;
  await libShot(page, name).catch(() => {});
  console.log('SHOT', path.join(SHOT_DIR, name + '.png'));
  return name;
}

// ---------------------------------------------------------------------------------------------- server processes
function psRows() {
  const out = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=,etimes=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map((m) => ({ pid: +m[1], ppid: +m[2], rssMb: Math.round(+m[3] / 1024), ageS: +m[4], args: m[5] }));
}
function deriveBackendPid() {
  if (process.env.BACKEND_PID) return +process.env.BACKEND_PID;
  try {
    const port = new URL(WORKBENCH_URL).port || '80';
    const m = execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' }).match(/pid=(\d+)/);
    return m ? +m[1] : null;
  } catch { return null; }
}
const BACKEND_PID = deriveBackendPid();
const readCwd = (pid) => { try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return '?'; } };
const readEnv = (pid, name) => { try { const m = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find((e) => e.startsWith(name + '=')); return m ? m.slice(name.length + 1) : null; } catch { return '?'; } };
const KLS = /org\.javacs\.kt\.MainKt|kotlin-language-server/;
/** Kotlin language-server processes under the backend: `bridge` = started by the workbench's own bridge (child of the backend), `extension` = started by the fwcd.kotlin VS Code extension (child of the plugin host). */
function kotlinServers() {
  if (!BACKEND_PID) return null;
  const rows = psRows();
  const kids = new Map();
  for (const r of rows) { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid).push(r); }
  const under = new Set(); const stack = [BACKEND_PID];
  while (stack.length) for (const k of kids.get(stack.pop()) || []) { under.add(k.pid); stack.push(k.pid); }
  return rows.filter((r) => under.has(r.pid) && KLS.test(r.args) && !/^(\S*\/)?(node|ps|grep)\b/.test(r.args))
    .map((r) => ({ pid: r.pid, kind: r.ppid === BACKEND_PID ? 'bridge' : 'extension', rssMb: r.rssMb, ageS: r.ageS, cwd: readCwd(r.pid), args: r.args }));
}
const jvmLine = (list) => (list === null ? 'unknown (no backend pid)' : `${list.length}${list.length ? ': ' + list.map((s) => `${s.kind} pid ${s.pid} ${s.rssMb}MB age ${s.ageS}s cwd ${s.cwd}`).join(' | ') : ''}`);
const jvmTrail = [];
function jvmSnap(label) { const list = kotlinServers(); jvmTrail.push({ label, list }); console.log(`JVMS [${label}] ${jvmLine(list)}`); return list; }
const kindOf = (l) => (l || []).map((s) => s.kind).join('+') || 'none';
/**
 * Brings the workbench to "no Kotlin server running" so that a scenario can tell which action starts one. The bridge keeps an idle
 * server for 10 minutes after the last editor closed; ending that one process (SIGTERM, the Kotlin JVM only) makes the bridge forget it
 * (it does not restart a server nobody holds). Returns the process list afterwards (null without a backend pid).
 */
async function coldStart(label) {
  const list = kotlinServers();
  if (list === null) return null;
  for (const s of list) { try { process.kill(s.pid, 'SIGTERM'); } catch { /* gone already */ } }
  const t0 = Date.now();
  while (Date.now() - t0 < 20000 && (kotlinServers() || []).length) await sleep(300);
  await sleep(2500); // the bridge learns about the exit; nothing may respawn
  return jvmSnap(`${label}: cold start (all Kotlin servers ended: ${list.map((s) => `${s.kind} ${s.pid}`).join(', ') || 'none was running'})`);
}
const logSize = () => { try { return BACKEND_LOG ? fs.statSync(BACKEND_LOG).size : 0; } catch { return 0; } };
function logSince(offset) {
  if (!BACKEND_LOG) return [];
  try { return fs.readFileSync(BACKEND_LOG, 'utf8').slice(offset).split('\n').filter((l) => /language-server|kotlin|cannot be launched|download/i.test(l)).map((l) => l.slice(0, 260)); } catch { return []; }
}

// ---------------------------------------------------------------------------------------------- fixtures
const ws = fs.mkdtempSync(path.join(os.tmpdir(), `systest-${runId}-kotlin-lsp-`));
const write = (name, content) => { const p = path.join(ws, name); fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content)); return p; };
const SCRIPT_MODEL = 'org.projectcontinuum.feature.base.analytics.node.KotlinScriptNodeModel';
// Copied from KotlinScriptNodeModel.kt (continuum-feature-analytics): the code control declares options.language = "kotlin".
// The worker also reports the names the script can use in options.scriptContext; this suite stands in for the worker, so it adds
// the context built from the real source of the node's API (sibling repo continuum-feature-base, or FEATURE_BASE_DIR).
const REPORTED = reportedContextFromFeatureSource();
const SCRIPT_SCHEMA = { type: 'object', properties: { script: { type: 'string', title: 'Kotlin Script', description: "Kotlin script to evaluate (use 'row' for the current row; use flow.get(\"name\") / flow.set(\"name\", value) to read or set flow variables)", minLength: 1 } }, required: ['script'] };
/** The Script node's UI schema; `scriptContext` as the worker reports it (`undefined`: the field has none, e.g. an older worker). */
const scriptUi = (scriptContext) => ({ type: 'VerticalLayout', elements: [{ type: 'Control', scope: '#/properties/script', options: { format: 'code', language: 'kotlin', rows: 15, ...(scriptContext === undefined ? {} : { scriptContext }) } }] });
const SCRIPT_UI = scriptUi(REPORTED.context);
const nodeOf = (id, model, title, schema, ui, properties, x = 300, y = 200) => ({
  id, type: 'BaseNode', position: { x, y }, width: 224, height: 100, selected: false, dragging: false, positionAbsolute: { x, y },
  data: { id: model, nodeModel: model, title, subTitle: title, description: title, icon: '', busy: null, inputs: { data: { name: 'input table', contentType: 'application/json' } }, outputs: { data: { name: 'output table', contentType: 'application/json' } }, properties, propertiesSchema: schema, propertiesUISchema: ui, status: null, nodeProgress: null }
});
const cwf = (name, nodes) => ({ id: `wf-${runId}-${name}`, name: `${name}.cwf`, active: false, edges: [], nodes });
const scriptCwf = (name, script, nodeId = 'k1') => cwf(name, [nodeOf(nodeId, SCRIPT_MODEL, 'Kotlin Script', SCRIPT_SCHEMA, SCRIPT_UI, { script })]);
const scriptNode = (nodeId, scriptContext, script = '// systest\n', x = 300, y = 200) => nodeOf(nodeId, SCRIPT_MODEL, 'Kotlin Script', SCRIPT_SCHEMA, scriptUi(scriptContext), { script }, x, y);
// Descriptors of the other code-editor nodes, copied from the example workflows (RESTNode.cwf, Claude.cwf; the Claude uiSchema is cut down to its Prompt tab).
const REST = nodeOf('r1', 'org.projectcontinuum.feature.base.analytics.node.RestNodeModel', 'Rest',
  { type: 'object', properties: { method: { type: 'string', title: 'HTTP Method', enum: ['GET', 'POST', 'PUT', 'DELETE'], default: 'GET' }, url: { type: 'string', title: 'URL Template' }, payload: { type: 'string', title: 'Payload Template' } }, required: ['method', 'url'] },
  { type: 'VerticalLayout', elements: [{ type: 'Control', scope: '#/properties/method' }, { type: 'Control', scope: '#/properties/url', options: { format: 'code', language: 'freemarker2', rows: 1 } }, { type: 'Control', scope: '#/properties/payload', options: { format: 'code', language: 'freemarker2', rows: 10 }, rule: { effect: 'HIDE', condition: { scope: '#/properties/method', schema: { enum: ['GET', 'DELETE'] } } } }] },
  { method: 'POST', url: 'https://example.test/posts/${row.id}', payload: '{"name": "${row.name}"}' }, 60, 60);
const TABLE = nodeOf('t1', 'org.projectcontinuum.feature.base.analytics.node.CreateTableNodeModel', 'Create Table',
  { type: 'object', properties: { jsonArrayString: { type: 'string', title: 'JSON Array' } }, required: ['jsonArrayString'] },
  { type: 'VerticalLayout', elements: [{ type: 'Control', scope: '#/properties/jsonArrayString', options: { format: 'code', language: 'freemarker', rows: 15 } }] },
  { jsonArrayString: '[\n  {"id": 1}\n]' }, 60, 260);
const CLAUDE = nodeOf('c1', 'org.projectcontinuum.feature.ai.claude.node.ClaudeAIAgentNodeModel', 'Claude AI Agent',
  { type: 'object', properties: { prompt: { type: 'string', title: 'Prompt' }, systemPrompt: { type: 'string', title: 'System prompt' } } },
  { type: 'Categorization', elements: [{ type: 'Category', label: 'Prompt', elements: [{ type: 'Control', scope: '#/properties/prompt', options: { format: 'code', language: 'freemarker2', rows: 8 } }, { type: 'Control', scope: '#/properties/systemPrompt', options: { format: 'code', language: 'markdown', rows: 6 } }] }] },
  { prompt: 'Describe ${row.id}', systemPrompt: '# Rules' }, 60, 460);
// The two `json` code editors of the Claude node (Tools -> mcpServers, Output -> outputSchema; uiSchema options copied from ClaudeAIAgentNodeModel.kt), on one tab so that both are mounted.
const CLAUDE_JSON = nodeOf('j1', 'org.projectcontinuum.feature.ai.claude.node.ClaudeAIAgentNodeModel', 'Claude AI Agent (JSON)',
  { type: 'object', properties: { mcpServers: { type: 'string', title: 'MCP servers' }, outputSchema: { type: 'string', title: 'Output schema' } } },
  { type: 'VerticalLayout', elements: [{ type: 'Control', scope: '#/properties/mcpServers', options: { format: 'code', language: 'json', rows: 8 } }, { type: 'Control', scope: '#/properties/outputSchema', options: { format: 'code', language: 'json', rows: 8 } }] },
  { mcpServers: '{\n  "servers": [{"name": "files", "enabled": true}]\n}', outputSchema: '{"type": "object", "properties": {"n": {"type": "number"}}}' }, 60, 660);
const MAIN_KT = 'fun main() {\n    val xs = listOf(1, 2, 3)\n    val bad: Int = "text"\n    println(xs)\n}\n';
const TOOL_KTS = 'val greeting = "hello"\nval n: Int = "oops"\nprintln(greeting.length)\n';

// ---------------------------------------------------------------------------------------------- browser plumbing
// Hosts the workbench always talks to, with or without Kotlin: workflow-editor-extension/src/browser/icons/fa-import.css
// @imports Font Awesome from this CDN (committed long before the Kotlin feature). Not a Kotlin download.
const BASELINE_EXTERNAL = /^cdnjs\.cloudflare\.com$/;

/**
 * Fault injection for the `channel` scenario, installed in the TEST BROWSER only (nothing in the product changes): Theia sends every
 * message of the multiplexed connection as a Socket.IO text header (`45<n>-/services,["message",{"_placeholder":true,"num":0}]`)
 * followed by n binary frames. While `window.__fault.hold` is true the frame pair that opens the channel of the Kotlin Script
 * registration (it carries the path `/services/language-server/kotlin-script`) is kept back; `window.__fault.release()` sends it later.
 */
function faultInjectionSource() {
  return () => {
    const orig = WebSocket.prototype.send;
    const fault = { hold: false, held: [], seen: 0, heldAt: [], releasedAt: null, release() { this.hold = false; for (const h of this.held) { orig.call(h.ws, h.header); for (const b of h.bins) orig.call(h.ws, b); } this.releasedAt = Date.now(); this.held = []; } };
    window.__fault = fault;
    let pending = null; // { ws, header, left, bins }
    const text = (b) => { try { return new TextDecoder('latin1').decode(b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength)); } catch { return ''; } };
    WebSocket.prototype.send = function (data) {
      if (typeof data === 'string') {
        const m = /^45(\d+)-/.exec(data);
        if (m && !pending) { pending = { ws: this, header: data, left: +m[1], bins: [] }; return; }
        return orig.call(this, data);
      }
      if (pending && pending.ws === this) {
        pending.bins.push(data);
        if (--pending.left > 0) return;
        const p = pending; pending = null;
        const isOpen = p.bins.some((b) => text(b).includes('/services/language-server/kotlin-script'));
        if (isOpen && fault.hold) { fault.seen++; fault.held.push(p); fault.heldAt.push(Date.now()); return; }
        orig.call(this, p.header); for (const b of p.bins) orig.call(this, b);
        return;
      }
      return orig.call(this, data);
    };
  };
}

async function newBrowser() {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1700, height: 1000 } });
  const wb = new URL(WORKBENCH_URL);
  const ctx = { browser, errs: [], errTimes: [], logs: [], external: [], notifications: new Set(), t0: Date.now() };
  ctx.newPage = async ({ faultInjection = false } = {}) => {
    const page = await browser.newPage();
    ctx.last = page;
    if (faultInjection) await page.evaluateOnNewDocument(faultInjectionSource());
    const note = (e) => { ctx.errs.push(e); ctx.errTimes.push(Date.now()); };
    page.on('pageerror', (e) => note('pageerror ' + e.message.split('\n')[0].slice(0, 200)));
    page.on('console', (m) => {
      const t = m.text();
      if (m.type() === 'error') note('console ' + t.split('\n')[0].slice(0, 200));
      if (/language.?server|kotlin|intelligence|\blsp\b|channel/i.test(t)) ctx.logs.push(`${m.type()} ${t.slice(0, 220)}`);
    });
    page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('favicon')) note(`http ${r.status()} ${r.request().method()} ${r.url().slice(0, 140)}`); });
    page.on('request', (r) => { const u = r.url(); if (!/^(data|blob|about):/.test(u) && new URL(u).host !== wb.host && !BASELINE_EXTERNAL.test(new URL(u).host)) ctx.external.push(u.slice(0, 160)); });
    return page;
  };
  return ctx;
}
const NOISE = /\/api-server|\/credentials-server|WorkflowRunsTree|NodeExplorerTree|disposed|MUI|ECONNREFUSED|punycode|favicon|Unsupported activation|Failed to load resource: the server responded with a status of 404/i;
function reportErrors(ctx, label) {
  const fresh = [...new Set(ctx.errs.filter((e) => !NOISE.test(e)))];
  console.log(`ERRORS [${label}] ${fresh.length} not matching the known baseline noise${fresh.length ? ':\n   ' + fresh.slice(0, 12).join('\n   ') : ''}`);
  if (ctx.logs.length) console.log(`CONSOLE LOGS [${label}] ${ctx.logs.length}: ${[...new Set(ctx.logs)].slice(0, 8).join(' || ')}`);
  return fresh;
}

/** Test hooks inside the workbench page (dev build: webpack modules are addressable by path). Idempotent; install BEFORE the first dialog opens. */
async function installProbe(page) {
  return page.evaluate(() => {
    if (window.__klsp) return window.__klsp.info;
    const info = { monaco: false, store: false, wrapped: false, error: null };
    try {
      let req;
      window.webpackChunk_continuum_workbench.push([[Symbol('klsp')], {}, (r) => { req = r; }]);
      const get = (id) => { try { return req(id); } catch { return undefined; } };
      const monaco = get('../node_modules/@theia/monaco-editor-core/esm/vs/editor/editor.api.js');
      const mui = get('../workflow-editor-extension/lib/browser/store/MUIThemeStore.js');
      const lis = get('../workflow-editor-extension/lib/browser/store/LanguageIntelligenceStore.js');
      info.monaco = !!monaco; info.store = !!lis;
      const reg = { all: { registered: 0, active: 0 }, bridge: { registered: 0, active: 0 } };
      const adapterMonaco = mui && mui.useMUIThemeStore && mui.useMUIThemeStore.getState().monaco;
      const langs = (adapterMonaco && adapterMonaco.languages) || (monaco && monaco.languages);
      info.sameMonaco = !!(monaco && adapterMonaco && adapterMonaco.languages === monaco.languages);
      if (langs) {
        for (const fn of ['registerCompletionItemProvider', 'registerHoverProvider', 'registerSignatureHelpProvider', 'registerDefinitionProvider']) {
          const orig = langs[fn].bind(langs);
          langs[fn] = (...args) => {
            const d = orig(...args);
            const mine = /MonacoLspAdapter/.test(new Error().stack || '');
            reg.all.registered++; reg.all.active++;
            if (mine) { reg.bridge.registered++; reg.bridge.active++; }
            let done = false;
            return { dispose: () => { if (!done) { done = true; reg.all.active--; if (mine) reg.bridge.active--; } d.dispose(); } };
          };
        }
        info.wrapped = true;
      }
      const dialogEditors = () => monaco.editor.getEditors().filter((e) => e.getDomNode() && e.getDomNode().closest('[role="dialog"]'));
      const rangeText = (m) => { const model = monaco.editor.getModel(m.resource); return model ? model.getValueInRange({ startLineNumber: m.startLineNumber, startColumn: m.startColumn, endLineNumber: m.endLineNumber, endColumn: m.endColumn }) : null; };
      const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      // Fraction (0..1) of an element's box that a user can actually see: the box intersected with the viewport and with every
      // clipping ancestor (overflow other than visible). A position:fixed element escapes ancestors that are not containing blocks.
      const shownFraction = (el) => {
        const r = el.getBoundingClientRect(); const full = r.width * r.height;
        if (!full) return 0;
        let x1 = Math.max(r.left, 0); let y1 = Math.max(r.top, 0); let x2 = Math.min(r.right, window.innerWidth); let y2 = Math.min(r.bottom, window.innerHeight);
        let escaped = false;
        for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
          const s = getComputedStyle(n);
          if (n !== el) {
            const containing = (s.transform && s.transform !== 'none') || (s.filter && s.filter !== 'none') || /paint|layout|strict|content/.test(s.contain || '');
            if (escaped && containing) escaped = false;
            if (!escaped && (s.overflowX !== 'visible' || s.overflowY !== 'visible')) {
              const b = n.getBoundingClientRect();
              x1 = Math.max(x1, b.left); y1 = Math.max(y1, b.top); x2 = Math.min(x2, b.right); y2 = Math.min(y2, b.bottom);
            }
          }
          if (s.position === 'fixed') escaped = true;
        }
        return Math.max(0, x2 - x1) * Math.max(0, y2 - y1) / full;
      };
      window.__klspShown = shownFraction;
      window.__klsp = {
        info, reg, visible,
        models: () => monaco.editor.getModels().map((m) => ({ uri: m.uri.toString(), scheme: m.uri.scheme, lang: m.getLanguageId(), value: m.getValue() })),
        markers: (owner) => monaco.editor.getModelMarkers(owner ? { owner } : {}).map((m) => ({ owner: m.owner, uri: m.resource.toString(), severity: m.severity, message: m.message, sl: m.startLineNumber, sc: m.startColumn, el: m.endLineNumber, ec: m.endColumn, text: rangeText(m) })),
        intel: () => { const c = lis && lis.useLanguageIntelligenceStore.getState().client; return c ? { connections: c.connections ? c.connections.size : null, hasKotlin: !!(c.hasRegistrationFor && c.hasRegistrationFor('kotlin')) } : null; },
        tokenize: (text, lang) => monaco.editor.tokenize(text, lang).map((line) => line.map((t) => `${t.offset}:${t.type}`).join(' ')),
        dialogCount: () => dialogEditors().length,
        languageIds: () => monaco.languages.getLanguages().map((l) => l.id),
        dialogText: (i) => { const e = dialogEditors()[i]; return e ? e.getModel().getValue() : null; },
        dialogLang: (i) => { const e = dialogEditors()[i]; return e ? e.getModel().getLanguageId() : null; },
        dialogUri: (i) => { const e = dialogEditors()[i]; return e ? e.getModel().uri.toString() : null; },
        // One entry per code editor of the open dialogs: language id, text, the colours its rendered spans really have, and whether
        // Monaco's tokens for its text are the same as the Kotlin Script dialog's tokenizer would produce (=> it would look like Kotlin).
        editorsInfo: (kotlinId) => dialogEditors().map((e) => {
          const model = e.getModel(); const text = model.getValue(); const lang = model.getLanguageId();
          const sp = [...e.getDomNode().querySelectorAll('.view-lines .view-line > span > span')].map((s) => ({ t: s.textContent.replace(/\u00a0/g, ' '), c: getComputedStyle(s).color }));
          const tok = (l) => JSON.stringify(monaco.editor.tokenize(text, l));
          return { lang, uri: model.uri.toString(), text, colours: [...new Set(sp.map((s) => s.c))], spans: sp.slice(0, 24), tokens: tok(lang), sameAsKotlin: tok(lang) === tok(kotlinId) };
        }),
        setDialogText: (i, text) => { dialogEditors()[i].getModel().setValue(text); },
        typeIntoDialog: (i, text) => { const e = dialogEditors()[i]; e.focus(); e.trigger('klsp', 'type', { text }); },
        dismiss: (i) => { const e = dialogEditors()[i]; if (e) { e.trigger('klsp', 'hideSuggestWidget', {}); e.trigger('klsp', 'closeParameterHints', {}); } },
        // Screen rectangle of the first occurrence of `word` in an editor's rendered lines (scope: {dialog: i} or {file: true}).
        wordRect: (scope, word) => {
          const roots = scope.dialog !== undefined ? [document.querySelectorAll('[role="dialog"]')[scope.dialog]] : [...document.querySelectorAll('.monaco-editor')].filter((e) => !e.closest('[role="dialog"]'));
          for (const root of roots) {
            if (!root) continue;
            for (const line of root.querySelectorAll('.view-lines .view-line')) {
              const nodes = []; const w = document.createTreeWalker(line, NodeFilter.SHOW_TEXT); let n;
              while ((n = w.nextNode())) nodes.push(n);
              const full = nodes.map((x) => x.textContent).join('').replace(/\u00a0/g, ' ');
              const at = full.indexOf(word);
              if (at < 0) continue;
              const find = (off) => { let acc = 0; for (const x of nodes) { if (off <= acc + x.textContent.length) return [x, off - acc]; acc += x.textContent.length; } return null; };
              const a = find(at); const b = find(at + word.length);
              if (!a || !b) continue;
              const range = document.createRange(); range.setStart(a[0], a[1]); range.setEnd(b[0], b[1]);
              const r = range.getBoundingClientRect();
              if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            }
          }
          return null;
        }
      };
    } catch (e) { info.error = String(e); }
    return info;
  });
}

const chips = (page) => page.evaluate(() => [...document.querySelectorAll('[data-testid="language-server-status"]')].map((e) => ({ state: e.dataset.state, text: e.innerText.trim() })));
const footerCount = (page) => page.evaluate(() => document.querySelectorAll('[data-testid="language-intelligence-footer"]').length);
const regCounts = (page) => page.evaluate(() => (window.__klsp ? JSON.stringify(window.__klsp.reg) : 'no probe'));
const markers = (page, owner) => page.evaluate((o) => window.__klsp.markers(o), owner);
const dialogText = (page, i = 0) => page.evaluate((n) => window.__klsp.dialogText(n), i);

async function waitFor(read, pred, timeout, step = 300) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) { last = await read(); if (pred(last)) return last; await sleep(step); }
  return last;
}
async function waitChip(page, idx, pred, timeout) {
  const last = await waitFor(async () => (await chips(page))[idx], (c) => c && pred(c), timeout, 250);
  return last ? (pred(last) ? last : { ...last, timedOut: true }) : null;
}
/** Waits until the chip shows `ready`; records a failure under `id` and returns false when it does not appear / never gets ready. */
async function reachReady(page, id, what, idx = 0) {
  const first = await waitChip(page, idx, () => true, CHIP_MS);
  if (!first) {
    const detail = `no [data-testid=language-server-status] within ${CHIP_MS} ms (footers ${await footerCount(page)}, dialog model language ${await page.evaluate(() => window.__klsp && window.__klsp.dialogLang(0))}, intelligence client ${JSON.stringify(await page.evaluate(() => window.__klsp && window.__klsp.intel()))}, bridge providers ${await regCounts(page)})`;
    await snap(page, `${what}-no-chip`);
    ac(id, `${what}: the dialog shows the language-server status chip`, false, detail);
    return false;
  }
  const st = await waitChip(page, idx, (c) => c.state === 'ready' || c.state === 'unavailable', READY_MS);
  if (!st || st.state !== 'ready') {
    await snap(page, `${what}-not-ready`);
    ac(id, `${what}: the Kotlin server becomes ready`, false, `chip ended as '${st && st.state}' (${st && st.text}) (waited at most ${READY_MS} ms for 'ready'); JVMs ${jvmLine(kotlinServers())}`);
    return false;
  }
  return true;
}

async function gotoWorkspace(page) {
  await page.goto(WORKBENCH_URL + '/#' + ws, { waitUntil: 'networkidle2', timeout: 90000 });
  await sleep(6000);
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((x) => x.innerText.includes('Yes, I trust'))?.click(); });
  await sleep(2500);
}
async function quickOpen(page, name) {
  await page.keyboard.down('Control'); await page.keyboard.press('KeyP'); await page.keyboard.up('Control');
  await sleep(800);
  await page.keyboard.type(name);
  await sleep(1200);
  await page.keyboard.press('Enter');
  await sleep(1500);
}
async function openGear(page, nodeId) {
  await page.waitForSelector(`[data-testid="node-settings-button-${nodeId}"]`, { timeout: 30000 });
  await sleep(800);
  await page.evaluate((id) => document.querySelector(`[data-testid="node-settings-button-${id}"]`).click(), nodeId);
  await page.waitForSelector('[role="dialog"] .monaco-editor', { timeout: 30000 });
  await sleep(500);
}
/** Cancel / Save changes of dialog number `idx` (the last one is the top-most); resolves when that dialog is gone. */
async function pressDialogButton(page, label, idx = 0) {
  const before = await page.evaluate(() => document.querySelectorAll('[role="dialog"]').length);
  const clicked = await page.evaluate((text, i) => {
    const d = document.querySelectorAll('[role="dialog"]')[i];
    const b = d && [...d.querySelectorAll('button')].find((x) => x.innerText.trim().toLowerCase() === text.toLowerCase()); // innerText follows CSS text-transform (SAVE CHANGES)
    if (!b || b.disabled) return b ? 'disabled' : 'missing';
    b.click(); return 'clicked';
  }, label, idx);
  if (clicked === 'clicked') await waitFor(() => page.evaluate(() => document.querySelectorAll('[role="dialog"]').length), (n) => n < before, 10000);
  await sleep(600);
  return clicked;
}
async function withDialog(file, fn, { nodeId = 'k1' } = {}) {
  const ctx = await newBrowser(); const page = await ctx.newPage();
  try {
    await openWorkflow(page, ws, file);
    await installProbe(page);
    await openGear(page, nodeId);
    await fn({ ctx, page });
  } catch (e) { await snap(page, 'crash'); throw e; } finally { reportErrors(ctx, file); await ctx.browser.close(); }
}

// ---------------------------------------------------------------------------------------------- driving the editor
async function focusDialogEditor(page, idx = 0) {
  const box = await page.evaluate((i) => { const d = document.querySelectorAll('[role="dialog"]')[i]; const el = d && d.querySelector('.monaco-editor .view-lines'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, idx);
  if (!box) throw new Error('no dialog editor #' + idx);
  await page.mouse.click(box.x + Math.min(box.w / 2, 300), box.y + Math.min(box.h / 2, 10));
}
/** Real keystrokes into dialog `idx`: replaces the text, closes suggestion/parameter widgets (through the editor command, never the Escape key, which would close the dialog) before each Enter. */
/**
 * Types into the dialog editor with real key presses. `replace` selects everything first (the server then answers from a
 * stale analysis for a few seconds: asking for completion right after replacing a whole script can return keywords only,
 * see "Known server behaviour" in the header); `replace: false` appends at the end of the text, which is what a user editing does.
 */
async function typeKeys(page, text, { idx = 0, replace = true, delay = 25 } = {}) {
  await focusDialogEditor(page, idx);
  if (replace) { await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace'); }
  else { await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control'); }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await page.keyboard.type(lines[i], { delay });
    if (i < lines.length - 1) { await sleep(350); await page.evaluate((n) => window.__klsp.dismiss(n), idx); await page.keyboard.press('Enter'); }
  }
}
const suggestRows = (page) => page.evaluate(() => {
  const v = window.__klsp.visible;
  return [...document.querySelectorAll('.suggest-widget')].filter(v).flatMap((w) => { const shown = window.__klspShown(w); return [...w.querySelectorAll('.monaco-list-row')].map((r) => {
    const full = (r.querySelector('.label-name') || r).innerText.trim();
    return { label: full.replace(/[\s(<:].*$/s, ''), full, detail: (r.querySelector('.details-label, .signature-label') || { innerText: '' }).innerText.trim(), shown };
  }); });
});
/**
 * Waits until the suggestion widget lists every label in `want`. When another list shows up (keywords from a stale analysis, see the
 * header) it dismisses it and asks again with Ctrl+Space, as a user would, and counts those extra asks.
 */
async function suggestUntil(page, want, timeout = 60000) {
  const t0 = Date.now(); let asks = 0; let rows = [];
  while (Date.now() - t0 < timeout) {
    rows = await waitFor(() => suggestRows(page), (r) => r.length > 0 && want.every((w) => r.some((x) => x.label === w)), asks === 0 ? 12000 : 8000);
    if (want.every((w) => rows.some((r) => r.label === w))) return { rows, asks, ms: Date.now() - t0 };
    asks++;
    await page.evaluate(() => window.__klsp.dismiss(0));
    await sleep(2500);
    await page.keyboard.down('Control'); await page.keyboard.press('Space'); await page.keyboard.up('Control');
  }
  return { rows, asks, ms: Date.now() - t0 };
}
const hoverText = (page) => page.evaluate(() => { const v = window.__klsp.visible; return [...document.querySelectorAll('.monaco-hover')].filter(v).map((h) => h.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' || '); });
/** Largest visible fraction (0..1) among the hover widgets that carry text. */
const hoverShown = (page) => page.evaluate(() => { const v = window.__klsp.visible; return Math.max(0, ...[...document.querySelectorAll('.monaco-hover')].filter(v).filter((h) => h.innerText.trim()).map((h) => window.__klspShown(h))); });
const paramHints = (page) => page.evaluate(() => {
  const v = window.__klsp.visible; const w = [...document.querySelectorAll('.parameter-hints-widget')].find(v);
  return w ? { text: w.innerText.replace(/\s+/g, ' ').trim(), active: (w.querySelector('.parameter.active') || {}).textContent || null, shown: window.__klspShown(w) } : null;
});
const pct = (f) => `${Math.round((f || 0) * 100)}%`;
/** Moves the mouse over `word` until a hover widget containing `needle` shows (or time runs out); returns the hover text. */
async function hoverOver(page, scope, word, needle, timeout = 40000) {
  const t0 = Date.now(); let text = '';
  while (Date.now() - t0 < timeout) {
    const p = await page.evaluate((s, w) => window.__klsp.wordRect(s, w), scope, word);
    if (!p) { await sleep(500); continue; }
    await page.mouse.move(p.x - 40, p.y + 30); await page.mouse.move(p.x, p.y, { steps: 6 });
    text = await waitFor(() => hoverText(page), (t) => !!t && needle.test(t), 4000, 250);
    if (needle.test(text)) return text;
  }
  return text;
}
async function waitMarker(page, owner, pred, timeout) { return waitFor(() => markers(page, owner), (ms) => ms.some(pred), timeout, 500); }
const isError = (m) => m.severity === 8;
const waitModel = (page, suffix, timeout = 30000) => waitFor(() => page.evaluate((s) => window.__klsp.models().find((m) => m.uri.endsWith(s)) || null, suffix), (m) => !!m, timeout, 300);
const spans = (page, idx = 0) => page.evaluate((i) => [...document.querySelectorAll('[role="dialog"]')[i].querySelectorAll('.view-lines .view-line > span > span')].map((s) => ({ t: s.textContent.replace(/\u00a0/g, ' '), c: getComputedStyle(s).color })), idx);
const HIGHLIGHT_SAMPLE = 'val x = 1 // c\nval s = "str"';
/** Dialog highlighting: token colours of a sample plus Monaco's own tokenizer output for it, with the language the dialog's editor really uses. */
async function highlightOf(page, idx = 0) {
  await page.evaluate((n, t) => window.__klsp.setDialogText(n, t), idx, HIGHLIGHT_SAMPLE);
  await sleep(1200);
  const sp = await spans(page, idx);
  const col = (t) => (sp.find((s) => s.t.trim() === t) || {}).c || null;
  const lang = await page.evaluate((n) => window.__klsp.dialogLang(n), idx);
  const tokens = await page.evaluate((t, l) => window.__klsp.tokenize(t, l), HIGHLIGHT_SAMPLE, lang);
  return { lang, colours: { val: col('val'), x: col('x'), one: col('1'), comment: col('// c'), str: col('"str"') }, distinct: new Set(sp.map((s) => s.c)).size, tokens };
}
const colourful = (h) => !!h.colours.val && h.colours.val !== h.colours.x && h.colours.one !== h.colours.x && h.colours.comment !== h.colours.x && h.colours.str !== h.colours.x && h.distinct >= 4;

// ---------------------------------------------------------------------------------------------- scenarios
const popupGeometry = (page, selector = '.suggest-widget') => page.evaluate((sel) => {
  const v = window.__klsp.visible;
  const w = [...document.querySelectorAll(sel)].find(v); const d = document.querySelector('[role="dialog"] .monaco-editor');
  if (!w) return null;
  const r = (e) => { const b = e.getBoundingClientRect(); return `${Math.round(b.width)}x${Math.round(b.height)} at (${Math.round(b.left)},${Math.round(b.top)})`; };
  const b = w.getBoundingClientRect(); const eb = d ? d.getBoundingClientRect() : null;
  return { widget: r(w), position: getComputedStyle(w).position, editor: d ? r(d) : null, below: eb ? Math.round(b.bottom - eb.bottom) : null };
}, selector);

async function scenarioCompletion() {
  const id = 'completion';
  write('completion.cwf', scriptCwf('completion', '// systest\n'));
  await withDialog('completion.cwf', async ({ page }) => {
    if (!(await reachReady(page, id, 'completion'))) return;
    // ---- flow.
    await typeKeys(page, 'flow.');
    const flow = await suggestUntil(page, ['get', 'set', 'all']);
    const flowGeo = await popupGeometry(page);
    await snap(page, 'completion-flow-dot');
    ac(id, 'typing "flow." in the dialog offers get, set and all', ['get', 'set', 'all'].every((l) => flow.rows.some((r) => r.label === l)), `items: ${flow.rows.map((r) => r.full).slice(0, 12).join(', ')} (asked again ${flow.asks}x)`);
    const flowShown = flow.rows.length ? flow.rows[0].shown : 0;
    ac(id, '"flow." suggestion list is actually visible to the user (not clipped by the editor box)', flowShown >= 0.8, `${pct(flowShown)} of the suggest widget is inside the visible area; ${JSON.stringify(flowGeo)}`);
    ac(id, '"flow." suggestion list reaches below the (one line high) editor box, i.e. it is not clipped by it', !!flowGeo && flowGeo.below > 40, JSON.stringify(flowGeo));
    // ---- row.  (`row` is Map<String, Any>: the members of a Map)
    await page.evaluate(() => window.__klsp.dismiss(0));
    await sleep(600);
    await typeKeys(page, 'val r = row.');
    const row = await suggestUntil(page, ['get', 'containsKey', 'keys', 'values', 'entries']);
    const rowGeo = await popupGeometry(page);
    await snap(page, 'completion-row-dot');
    ac(id, 'typing "row." offers the members of a Map (get, containsKey, keys, values, entries)', ['get', 'containsKey', 'keys', 'values', 'entries'].every((l) => row.rows.some((r) => r.label === l)), `items: ${row.rows.map((r) => r.full).slice(0, 14).join(', ')} (asked again ${row.asks}x, ${row.ms} ms)`);
    const rowShown = row.rows.length ? row.rows[0].shown : 0;
    ac(id, '"row." suggestion list is actually visible to the user (not clipped by the editor box)', rowShown >= 0.8 && !!rowGeo && rowGeo.below > 40, `${pct(rowShown)} of the suggest widget is inside the visible area; ${JSON.stringify(rowGeo)}`);
    // accepting an item inserts it (Tab) and the stored text is exactly what is shown
    const pick = row.rows.findIndex((r) => r.label === 'containsKey');
    for (let i = 0; i < Math.max(pick, 0); i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Tab');
    await sleep(800);
    const accepted = await dialogText(page);
    await snap(page, 'completion-row-accepted');
    ac(id, 'accepting a suggestion inserts it into the editor text', /^val r = row\.containsKey/.test(accepted), `text ${JSON.stringify(accepted)}`);
  });
}

async function scenarioValid() {
  const id = 'valid';
  write('valid.cwf', scriptCwf('valid', '// systest\n'));
  await withDialog('valid.cwf', async ({ page }) => {
    if (!(await reachReady(page, id, 'valid'))) return;
    // Positive control first: diagnostics flow at all (an empty marker list right after typing proves nothing).
    await page.evaluate(() => window.__klsp.setDialogText(0, 'val x: Int = "a"'));
    const control = await waitMarker(page, OWNER, isError, 60000);
    if (!control.some(isError)) { await snap(page, 'valid-no-control'); ac(id, 'valid: control script with a type error produces an error marker', false, `markers: ${JSON.stringify(control)}`); return; }
    const script = 'row["a"]?.toString() + flow.get("x")';
    await typeKeys(page, script);
    const cleared = await waitFor(() => markers(page, OWNER), (ms) => ms.length === 0, 40000, 500);
    await sleep(4000);
    const later = await markers(page, OWNER);
    await snap(page, 'valid-script');
    ac(id, 'a correct script (row["a"]?.toString() + flow.get("x")) shows no diagnostics once ready', cleared.length === 0 && later.length === 0 && (await dialogText(page)) === script, `markers after ${later.length ? JSON.stringify(later.map((m) => m.message)) : 'none'}; editor text ${JSON.stringify(await dialogText(page))}`);
  });
}

async function scenarioDiagnostics() {
  const id = 'diagnostics';
  write('diag.cwf', scriptCwf('diag', '// systest\n'));
  await withDialog('diag.cwf', async ({ page }) => {
    if (!(await reachReady(page, id, 'diagnostics'))) return;
    const cases = [
      { name: 'statement on line 1 col 1', script: 'val x: Int = "a"', line: 1 },
      { name: 'statement on line 3', script: '// one\n// two\nval x: Int = "a"', line: 3 },
      { name: 'statement after a leading import (line 2)', script: 'import kotlin.math.abs\nval x: Int = "a"', line: 2 }
    ];
    for (const c of cases) {
      await page.evaluate((t) => window.__klsp.setDialogText(0, t), c.script);
      const ms = await waitMarker(page, OWNER, (m) => isError(m) && m.sl === c.line, 60000);
      const want = { line: c.line, col: c.script.split('\n')[c.line - 1].indexOf('"a"') + 1, text: '"a"' };
      const hit = ms.find((m) => isError(m) && m.sl === c.line);
      const lineCount = c.script.split('\n').length;
      const leaks = ms.filter((m) => m.sl > lineCount || /continuumScript|ScriptFlowVariables/.test(m.message) /* names of the reported context and the wrapper must never reach the user's diagnostics */);
      await snap(page, `diagnostics-line-${c.line}`);
      ac(id, `error marker for ${c.name} sits exactly on the editor text`, !!hit && hit.sc === want.col && hit.text === want.text && leaks.length === 0,
        `want line ${want.line} col ${want.col} over ${want.text}; got ${hit ? `${hit.sl}:${hit.sc}-${hit.el}:${hit.ec} over ${JSON.stringify(hit.text)} "${hit.message}"` : 'no error marker on that line'}; all: ${JSON.stringify(ms.map((m) => `${m.sl}:${m.sc} ${m.message.slice(0, 40)}`))}`);
    }
  });
}

async function scenarioHover() {
  const id = 'hover';
  write('hover.cwf', scriptCwf('hover', '// systest\n'));
  await withDialog('hover.cwf', async ({ page }) => {
    if (!(await reachReady(page, id, 'hover'))) return;
    await page.evaluate(() => window.__klsp.setDialogText(0, 'flow.set("k", 1)'));
    await sleep(1500);
    const text = await hoverOver(page, { dialog: 0 }, 'set', /set\(/);
    const shown = await hoverShown(page);
    await snap(page, 'hover-flow-set');
    ac(id, 'hovering flow.set shows its signature', /set\(name: String, value: Any\?\)/.test(text), `hover: ${text.slice(0, 300)}`);
    ac(id, 'hovering flow.set shows its KDoc', /Sets or updates flow variable/.test(text), `hover: ${text.slice(0, 300)}`);
    ac(id, 'the hover is actually visible to the user (not clipped by the editor box)', shown >= 0.8, `${pct(shown)} of the hover widget is inside the visible area`);
  });
}

async function scenarioSighelp() {
  const id = 'sighelp';
  write('sighelp.cwf', scriptCwf('sighelp', '// systest\n'));
  await withDialog('sighelp.cwf', async ({ page }) => {
    if (!(await reachReady(page, id, 'sighelp'))) return;
    await typeKeys(page, 'flow.set');
    await sleep(800); await page.evaluate(() => window.__klsp.dismiss(0));
    await page.keyboard.type('(', { delay: 40 });
    const hint = await waitFor(() => paramHints(page), (h) => !!h && /set\(/.test(h.text), 30000);
    await snap(page, 'sighelp-open-paren');
    ac(id, 'typing "flow.set(" shows signature help for set(name: String, value: Any?)', !!hint && /set\(name: String, value: Any\?\)/.test(hint.text), `widget: ${hint ? hint.text : 'none'} (active ${hint && hint.active})`);
    ac(id, 'the signature help is actually visible to the user (not clipped by the editor box)', !!hint && hint.shown >= 0.8, `${pct(hint && hint.shown)} of the parameter-hints widget is inside the visible area`);
    await page.keyboard.type('"k",', { delay: 40 });
    const next = await waitFor(() => paramHints(page), (h) => !!h && /value/.test(h.active || ''), 15000);
    await snap(page, 'sighelp-second-arg');
    ac(id, 'after the first argument and a comma the second parameter (value) is highlighted', !!next && /value/.test(next.active || ''), `active: ${next && next.active}`);
  });
}

async function scenarioSave() {
  const id = 'save';
  const file = write('save.cwf', scriptCwf('save', '// old\n'));
  const typed = 'val a = row["a"]?.toString()\nval b = a + flow.get("x")\nflow.set("k", b)';
  await withDialog('save.cwf', async ({ page }) => {
    const chip = await waitChip(page, 0, () => true, CHIP_MS);
    if (chip) await waitChip(page, 0, (c) => c.state === 'ready' || c.state === 'unavailable', READY_MS);
    const session = chip ? (await chips(page))[0].state : 'no chip';
    await typeKeys(page, typed);
    await sleep(1500);
    const editorText = await dialogText(page);
    await snap(page, 'save-typed');
    const clicked = await pressDialogButton(page, 'Save changes');
    await saveWorkflow(page);
    const wf = await readCwf(file, (w) => w.nodes[0].data.properties.script !== '// old\n');
    const stored = wf.nodes[0].data.properties.script;
    const noPrelude = !/continuum\.|ScriptFlowVariables|continuumScript|\brun \{/.test(stored);
    const label = chip ? '' : ' (WITHOUT a language-server session: no chip, see the dialog/chip findings)';
    ac(id, `Save changes (${clicked}) then Ctrl+S stores exactly the editor text${label}`, clicked === 'clicked' && stored === editorText, `editor ${JSON.stringify(editorText)}; stored ${JSON.stringify(stored)}; chip at typing time: ${session}`);
    ac(id, `the stored script has no hidden prelude/wrapper${label}`, noPrelude, `stored ${JSON.stringify(stored)}`);
    ac(id, `the stored script equals the text that was typed${label}`, stored === typed, stored === typed ? 'identical' : `typed ${JSON.stringify(typed)}`);
    if (!chip) nv(id, 'stored text with a live language-server session', 'no session was attached (no status chip)');
  });
}

async function scenarioRest() {
  const id = 'rest-unchanged';
  const ctrl = nodeOf('k1', SCRIPT_MODEL, 'Kotlin Script', SCRIPT_SCHEMA, SCRIPT_UI, { script: '// control\n' }, 420, 60); // positive control: THIS dialog must start the server
  write('rest.cwf', cwf('rest', [REST, TABLE, CLAUDE, CLAUDE_JSON, ctrl]));
  const cold = await coldStart('rest-unchanged');
  if (cold === null) nv(id, 'Rest / Create Table / Claude dialogs start no Kotlin server process', 'no backend pid to inspect');
  const ctx = await newBrowser(); const page = await ctx.newPage();
  try {
    await openWorkflow(page, ws, 'rest.cwf');
    await installProbe(page);
    jvmSnap('rest: workflow open, no dialog');
    const regBase = await page.evaluate(() => JSON.stringify(window.__klsp.reg.bridge));
    const nodes = [['r1', 'Rest', ['freemarker2', 'freemarker2']], ['t1', 'Create Table', ['freemarker2']], ['c1', 'Claude', ['freemarker2', 'markdown']], ['j1', 'Claude (JSON editors)', ['json', 'json']]];
    for (const [nodeId, what, want] of nodes) {
      const logFrom = ctx.logs.length;
      await openGear(page, nodeId);
      await sleep(6000);
      const o = await page.evaluate((kotlinId) => ({
        infos: window.__klsp.editorsInfo(kotlinId),
        footers: document.querySelectorAll('[data-testid="language-intelligence-footer"]').length, chips: document.querySelectorAll('[data-testid="language-server-status"]').length,
        intel: window.__klsp.intel(), bridgeProviders: window.__klsp.reg.bridge.active, markers: window.__klsp.markers().filter((m) => /^language-server/.test(m.owner)).length
      }), DIALOG_LANG);
      const jv = jvmSnap(`rest: ${what} dialog open (+6s)`);
      await snap(page, `rest-${nodeId}-dialog`);
      const langs = o.infos.map((i) => i.lang);
      const lines = ctx.logs.slice(logFrom);
      // Monaco falls back to plain text for an id nothing registered (this Theia build ships no `json` language): then plain text IS the declared language here.
      const known = await page.evaluate(() => window.__klsp.languageIds());
      const expected = want.map((l) => (known.includes(l) ? l : 'plaintext'));
      const missing = want.filter((l) => !known.includes(l));
      if (missing.length) console.log(`OBSERVATION [rest-unchanged] ${what} dialog: language(s) ${[...new Set(missing)].join(', ')} are not registered in this workbench's Monaco (${known.length} languages) -> the editors render as plain text`);
      ac(id, `${what} dialog: no editor is typed or tokenized as Kotlin; the editors keep the languages declared in the uiSchema (${want.join(', ')})`, JSON.stringify(langs) === JSON.stringify(expected) && !langs.some((l) => /kotlin/i.test(l)), `editor model languages: ${langs.join(',') || 'none'}; expected ${expected.join(',')}${missing.length ? ` (${[...new Set(missing)].join(', ')} not registered, so plain text)` : ''}`);
      ac(id, `${what} dialog: code editors present, and no language-server footer, chip, connection, provider or marker`,
        o.infos.length >= 1 && o.footers === 0 && o.chips === 0 && (!o.intel || o.intel.connections === 0) && o.bridgeProviders === 0 && o.markers === 0,
        `editors ${o.infos.length}; footers ${o.footers}; chips ${o.chips}; intel ${JSON.stringify(o.intel)}; bridge providers ${o.bridgeProviders} (before: ${regBase}); markers ${o.markers}`);
      ac(id, `${what} dialog: highlighting is the declared language's, not the Kotlin Script tokenizer's`, o.infos.length > 0 && o.infos.every((i) => !i.sameAsKotlin),
        o.infos.map((i) => `${i.lang}: tokens like Kotlin=${i.sameAsKotlin}; colours ${JSON.stringify(i.colours)}; first spans ${JSON.stringify(i.spans.slice(0, 5).map((s) => `${s.t}=${s.c}`))}`).join(' | '));
      ac(id, `${what} dialog: opening it starts no Kotlin language-server process (of any kind)`, jv === null ? true : jv.length === 0, `processes: ${jvmLine(jv)}`);
      ac(id, `${what} dialog: the browser console shows no Kotlin highlighting/language-server activity`, !lines.some((l) => /kotlin/i.test(l)), `console lines about language servers/Kotlin while it was open: ${JSON.stringify(lines)}`);
      if (jv === null) nv(id, `${what} dialog: no Kotlin server process`, 'no backend pid to inspect');
      await pressDialogButton(page, 'Cancel');
    }
    const after = jvmSnap('rest: all four dialogs closed');
    ac(id, 'after opening and closing Rest, Create Table, Claude and Claude-JSON dialogs there is still no Kotlin server process', after === null ? true : after.length === 0, `processes: ${jvmLine(after)}`);
    // positive control: the Script dialog of the same session does start exactly one server (so "none" above is meaningful)
    await openGear(page, 'k1');
    const chip = await waitChip(page, 0, () => true, CHIP_MS);
    const st = chip ? await waitChip(page, 0, (c) => c.state === 'ready' || c.state === 'unavailable', READY_MS) : null;
    const withCtrl = jvmSnap(`rest: control - Script dialog open, chip ${st ? st.state : 'absent'}`);
    await snap(page, 'rest-control-script-dialog');
    ac(id, 'control: the Script dialog of the same session starts exactly one Kotlin server (the workbench\'s own), no file-editor one', withCtrl === null ? true : (withCtrl.length === 1 && withCtrl[0].kind === 'bridge'), `processes: ${jvmLine(withCtrl)}; chip ${JSON.stringify(st)}`);
    await pressDialogButton(page, 'Cancel');
  } catch (e) { await snap(page, 'crash'); throw e; } finally { reportErrors(ctx, 'rest.cwf'); await ctx.browser.close(); }
}

async function scenarioKtFile() {
  const id = 'kt-file';
  write('Main.kt', MAIN_KT); write('tool.kts', TOOL_KTS);
  await coldStart('kt-file');
  const ctx = await newBrowser(); const page = await ctx.newPage();
  try {
    await gotoWorkspace(page);
    const none = jvmSnap('kt: workspace open, no file');
    if (none !== null) ac(id, 'a workspace without any Kotlin file open runs no Kotlin server process', none.length === 0, `processes: ${jvmLine(none)}`);
    await installProbe(page);
    for (const ext of (process.env.KT_EXT || 'kt,kts').split(',')) {
      const name = ext === 'kt' ? 'Main.kt' : 'tool.kts';
      const lbl = `${id} (.${ext})`;
      await quickOpen(page, name);
      const model = await waitModel(page, '/' + name);
      if (!model) { await snap(page, `${ext}-not-open`); ac(lbl, `${name} opens in the file editor`, false, 'no Monaco model for the file'); continue; }
      await sleep(2500);
      jvmSnap(`kt: ${name} just opened`);
      // diagnostics
      const wantBad = ext === 'kt' ? '"text"' : '"oops"';
      const ms = await waitFor(() => markers(page), (all) => all.some((m) => m.uri.endsWith('/' + name) && isError(m) && /mismatch/i.test(m.message)), READY_MS, 1000);
      const mine = ms.filter((m) => m.uri.endsWith('/' + name));
      const mismatch = mine.find((m) => isError(m) && /mismatch/i.test(m.message));
      jvmSnap(`kt: ${name} diagnostics`);
      await snap(page, `${ext}-diagnostics`);
      ac(lbl, `${name}: type error is reported as an error marker over the offending literal`, !!mismatch && mismatch.text === wantBad, `markers: ${JSON.stringify(mine.map((m) => `${m.sl}:${m.sc} sev ${m.severity} ${m.message.slice(0, 80)} [${m.text}]`))}`);
      const srv = (kotlinServers() || []).find((s) => s.kind === 'extension');
      if (srv) {
        const maven = readEnv(srv.pid, 'MAVEN_REPOSITORY');
        ac(lbl, `${name}: the extension's own server (pid ${srv.pid}) runs with the bundled stdlib repository (MAVEN_REPOSITORY=<.kotlin-ls>/m2)`, /\/\.kotlin-ls\/m2$/.test(maven || ''), `MAVEN_REPOSITORY=${maven}; command ${srv.args.slice(0, 160)}...`);
      } else if (BACKEND_PID) ac(lbl, `${name}: a server process of the file-editor extension exists`, false, `processes: ${jvmLine(kotlinServers())}`);
      if (ext === 'kts') ac(lbl, `${name}: only the deliberate type error is reported (no false-positive error markers)`, mine.filter(isError).length === 1, `error markers: ${JSON.stringify(mine.filter(isError).map((m) => `${m.sl}:${m.sc}-${m.el}:${m.ec} ${m.message.slice(0, 100)}`))}`);
      // hover
      const hovWord = ext === 'kt' ? 'listOf' : 'greeting';
      const hovNeedle = ext === 'kt' ? /listOf/ : /(val|var) greeting|: String/;
      const hov = await hoverOver(page, { file: true }, hovWord, hovNeedle, 60000);
      await snap(page, `${ext}-hover`);
      ac(lbl, `${name}: hovering "${hovWord}" shows its declaration`, ext === 'kt' ? /fun <T> listOf\(vararg elements: T\): List<T>/.test(hov) : hovNeedle.test(hov), `hover: ${hov.slice(0, 260)}`);
      // completion: new line at the end of the first statement of the body. The hover of the previous step may still cover the line: close it first.
      await page.mouse.move(900, 700); await page.keyboard.press('Escape'); await sleep(1200);
      const anchor = await page.evaluate((w) => window.__klsp.wordRect({ file: true }, w), ext === 'kt' ? 'listOf' : 'greeting');
      if (!anchor) { ac(lbl, `${name}: completion`, false, 'cannot locate the anchor word on screen'); continue; }
      await page.mouse.click(anchor.x + 300, anchor.y); // far right of the line: the cursor goes to its end
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type(ext === 'kt' ? 'xs.ma' : 'greeting.le', { delay: 40 });
      const rows = await waitFor(() => suggestRows(page), (r) => r.some((x) => /^(map|length)/.test(x.label)), 40000);
      const labels = rows.map((r) => r.label);
      await snap(page, `${ext}-completion`);
      ac(lbl, `${name}: member completion offers ${ext === 'kt' ? 'map' : 'length'}`, labels.some((l) => (ext === 'kt' ? /^map/ : /^length/).test(l)), `items: ${labels.slice(0, 12).join(', ')}; typed text now ${JSON.stringify((await page.evaluate((s) => window.__klsp.models().find((m) => m.uri.endsWith(s)), '/' + name) || {}).value || '')}`);
      await page.keyboard.press('Escape');
    }
    const out = await page.evaluate(() => { const m = window.__klsp.models().find((x) => x.scheme === 'output' && /Kotlin/.test(x.uri)); return m ? m.value.split('\n').filter((l) => /Connected|version|Reported|xception|Updated configuration/.test(l)).slice(0, 12).map((l) => l.slice(0, 160)) : null; });
    console.log('OUTPUT-PANEL [Kotlin]', JSON.stringify(out));
    jvmSnap('kt: end');
  } catch (e) { await snap(page, 'crash'); throw e; } finally { reportErrors(ctx, 'kt-file'); await ctx.browser.close(); }
}

async function scenarioTwoDialogs() {
  const id = 'twodialogs';
  write('two-b.cwf', scriptCwf('two-b', '// b\n', 'kb')); write('two-a.cwf', scriptCwf('two-a', '// a\n', 'ka'));
  await coldStart('twodialogs');
  const ctx = await newBrowser(); const page = await ctx.newPage();
  try {
    await openWorkflow(page, ws, 'two-b.cwf');
    await installProbe(page);
    const { openFile } = await import('./lib.mjs');
    await openFile(page, 'two-a.cwf'); // second editor tab; A is active, B stays mounted but hidden
    const base = await page.evaluate(() => JSON.stringify(window.__klsp.reg.bridge));
    await openGear(page, 'ka');
    if (!(await reachReady(page, id, 'twodialogs (dialog A)', 0))) return;
    await typeKeys(page, 'val a: Int = "from-a"', { idx: 0 });
    await waitMarker(page, OWNER, (m) => isError(m) && m.text === '"from-a"', 60000);
    // second dialog from the other (hidden) editor tab: opened programmatically, the first dialog's modal covers the page
    await page.evaluate(() => document.querySelector('[data-testid="node-settings-button-kb"]').click());
    await waitFor(() => page.evaluate(() => window.__klsp.dialogCount()), (n) => n >= 2, 15000);
    const both = await page.evaluate(() => window.__klsp.dialogCount());
    if (both < 2) { await snap(page, 'twodialogs-only-one'); nv(id, 'two dialogs open at once in one page', `only ${both} dialog editor present`); return; }
    const chipsNow = await waitFor(() => chips(page), (c) => c.length >= 2 && c.every((x) => x.state === 'ready'), READY_MS, 500);
    const shared = jvmSnap('twodialogs: both dialogs open and ready');
    if (shared !== null) ac(id, 'two dialogs open at once share ONE Kotlin server (the workbench\'s own)', shared.length === 1 && shared[0].kind === 'bridge', `processes: ${jvmLine(shared)}`);
    await typeKeys(page, 'val b: String = 5', { idx: 1 }); // dialog B is the top-most modal: real keystrokes
    await waitMarker(page, OWNER, (m) => isError(m) && m.text === '5', 60000);
    await snap(page, 'twodialogs-both');
    const split = async () => {
      const ms = await markers(page, OWNER);
      const uriA = await page.evaluate(() => window.__klsp.dialogUri(0)); const uriB = await page.evaluate(() => window.__klsp.dialogUri(1));
      return { a: ms.filter((m) => m.uri === uriA), b: ms.filter((m) => m.uri === uriB), other: ms.filter((m) => m.uri !== uriA && m.uri !== uriB) };
    };
    let s = await split();
    ac(id, 'two dialogs open at once: each shows only its own diagnostics', chipsNow.length >= 2 && s.a.some((m) => m.text === '"from-a"') && !s.a.some((m) => m.text === '5') && s.b.some((m) => m.text === '5') && !s.b.some((m) => m.text === '"from-a"') && s.other.length === 0,
      `A: ${JSON.stringify(s.a.map((m) => `${m.sl}:${m.sc} ${m.text}`))}; B: ${JSON.stringify(s.b.map((m) => `${m.sl}:${m.sc} ${m.text}`))}; other ${s.other.length}; chips ${JSON.stringify(chipsNow)}`);
    // editing A (programmatically: only the top-most modal accepts the keyboard) must not touch B's markers
    const bBefore = JSON.stringify(s.b);
    await page.evaluate(() => window.__klsp.setDialogText(0, 'val a2: Int = "again-a"'));
    await waitMarker(page, OWNER, (m) => m.text === '"again-a"', 60000);
    s = await split();
    ac(id, 'changing the text of dialog A leaves dialog B\'s diagnostics untouched', JSON.stringify(s.b) === bBefore && s.a.some((m) => m.text === '"again-a"') && !s.a.some((m) => m.text === '"from-a"'), `B before ${bBefore}; B after ${JSON.stringify(s.b)}; A ${JSON.stringify(s.a.map((m) => m.text))}`);
    const during = await page.evaluate(() => JSON.stringify(window.__klsp.reg.bridge));
    // close B (top-most): its markers and providers go, A keeps working
    await pressDialogButton(page, 'Cancel', 1);
    s = await split();
    const afterB = await page.evaluate(() => ({ reg: window.__klsp.reg.bridge.active, intel: window.__klsp.intel() }));
    ac(id, 'closing dialog B removes its providers and markers; A\'s stay', afterB.reg === 4 && s.b.length === 0 && s.a.length > 0 && afterB.intel.connections === 1, `providers active ${afterB.reg} (during: ${during}, base: ${base}); markers A ${s.a.length} B ${s.b.length}; connections ${afterB.intel && afterB.intel.connections}`);
    await page.evaluate(() => window.__klsp.setDialogText(0, 'val a3: Int = "third"'));
    const stillWorks = await waitMarker(page, OWNER, (m) => m.text === '"third"', 60000);
    ac(id, 'after closing B, dialog A still gets fresh diagnostics', stillWorks.some((m) => m.text === '"third"'), `markers: ${JSON.stringify(stillWorks.map((m) => m.text))}`);
    await pressDialogButton(page, 'Cancel', 0);
    await sleep(1500);
    const end = await page.evaluate(() => ({ reg: window.__klsp.reg.bridge.active, markers: window.__klsp.markers().filter((m) => /^language-server/.test(m.owner)).length, intel: window.__klsp.intel() }));
    ac(id, 'closing the last dialog leaves no providers, markers or connection behind', end.reg === 0 && end.markers === 0 && end.intel.connections === 0, JSON.stringify(end));
  } catch (e) { await snap(page, 'crash'); throw e; } finally { reportErrors(ctx, 'two dialogs'); await ctx.browser.close(); }
}

async function scenarioFallback() {
  const id = 'fallback';
  const file = write('fallback.cwf', scriptCwf('fallback', '// systest\n'));
  const typed = 'val kept = "still editable"';
  await withDialog('fallback.cwf', async ({ ctx, page }) => {
    const first = await waitChip(page, 0, () => true, CHIP_MS);
    if (!first) { await snap(page, 'fallback-no-chip'); ac(id, 'fallback: the dialog shows the status chip', false, `no chip within ${CHIP_MS} ms`); return; }
    let st = await waitChip(page, 0, (c) => c.state !== 'starting', READY_MS);
    const killed = new Set();
    const bridge = () => (kotlinServers() || []).find((s) => s.kind === 'bridge' && !killed.has(s.pid));
    const kill = (pid) => { killed.add(pid); try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } };
    if (st && st.state === 'ready') {
      if (BACKEND_PID === null) nv(id, 'server killed while the dialog is open', 'no backend pid: cannot find the server process');
      else {
        const j = bridge();
        if (!j) nv(id, 'server killed while the dialog is open', `no bridge JVM under the backend: ${jvmLine(kotlinServers())}`);
        else {
          await page.evaluate(() => window.__klsp.setDialogText(0, 'val x: Int = "a"'));
          await waitMarker(page, OWNER, isError, 60000);
          kill(j.pid);
          const starting = await waitChip(page, 0, (c) => c.state === 'starting', 10000);
          const during = await markers(page, OWNER);
          await snap(page, 'fallback-starting');
          ac(id, 'killing the server process: the chip changes to "starting" and the stale markers disappear', !!starting && starting.state === 'starting' && during.length === 0, `chip ${JSON.stringify(starting)}; markers left ${during.length}`);
          await typeKeys(page, 'val whileDown = 1');
          ac(id, 'while the server is down the editor stays editable', (await dialogText(page)) === 'val whileDown = 1', `text ${JSON.stringify(await dialogText(page))}`);
          const back = await waitChip(page, 0, (c) => c.state === 'ready' || c.state === 'unavailable', READY_MS);
          ac(id, 'a crashed server is restarted by itself (chip returns to ready)', !!back && back.state === 'ready', `chip ${JSON.stringify(back)}`);
          // keep killing each respawn until the restart budget is used up
          const t0 = Date.now();
          while (Date.now() - t0 < 120000) {
            const c = (await chips(page))[0];
            if (c && c.state === 'unavailable') break;
            const r = bridge();
            if (r && (c ? c.state !== 'unavailable' : true)) kill(r.pid);
            await sleep(150);
          }
          st = await waitChip(page, 0, (c) => c.state === 'unavailable', 5000);
          ac(id, `after repeated crashes (${killed.size} kills) the chip shows "unavailable"`, !!st && st.state === 'unavailable', `chip ${JSON.stringify(st)}; killed pids ${[...killed].join(',')}`);
        }
      }
    }
    if (!st || st.state !== 'unavailable') { await snap(page, 'fallback-state'); ac(id, 'fallback: dialog reaches the "unavailable" state to test the fallback', false, `chip ${JSON.stringify(st)}`); return; }
    await snap(page, 'fallback-unavailable');
    const errsBefore = ctx.errs.filter((e) => /^pageerror/.test(e)).length;
    // the fallback: no server, the editor is still an editor
    await typeKeys(page, typed);
    await sleep(800);
    const text = await dialogText(page);
    const h = await highlightOf(page);
    await typeKeys(page, typed); // real keystrokes again (the highlight probe replaced the text through the model API)
    await sleep(1500);
    ac(id, 'unavailable: typing still works', text === typed && (await dialogText(page)) === typed, `text ${JSON.stringify(text)}`);
    ac(id, 'unavailable: Kotlin syntax highlighting still works', colourful(h), JSON.stringify(h.colours));
    ac(id, 'unavailable: no language-server markers are shown', (await markers(page, OWNER)).length === 0, '');
    const clicked = await pressDialogButton(page, 'Save changes');
    await saveWorkflow(page);
    const wf = await readCwf(file, (w) => w.nodes[0].data.properties.script !== '// systest\n');
    ac(id, 'unavailable: Save changes is not blocked and the script is stored', clicked === 'clicked' && wf.nodes[0].data.properties.script === typed, `button ${clicked}; stored ${JSON.stringify(wf.nodes[0].data.properties.script)}`);
    const newPageErrors = ctx.errs.filter((e) => /^pageerror/.test(e)).slice(errsBefore).filter((e) => !NOISE.test(e));
    ac(id, 'unavailable: no uncaught page error while editing and saving', newPageErrors.length === 0, newPageErrors.slice(-3).join(' | ') || 'none');
    // opening the dialog again asks for the server again
    if (killed.size) {
      await openGear(page, 'k1');
      const again = await waitChip(page, 0, (c) => c.state === 'ready' || c.state === 'unavailable', READY_MS);
      await snap(page, 'fallback-reopen');
      ac(id, 'after "unavailable", closing and reopening the dialog starts the server again', !!again && again.state === 'ready', `chip ${JSON.stringify(again)}`);
    } else nv(id, 'recovery after "unavailable" by reopening the dialog', 'the server never ran on this instance, so there is nothing to recover');
  });
}

/** One session: workspace -> workflow -> dialog -> close -> `.kt` -> dialog again. Answers the cross-cutting runtime questions. */
async function scenarioJourney() {
  const id = 'JOURNEY';
  write('journey.cwf', scriptCwf('journey', 'val seed = 1\n')); write('Main.kt', MAIN_KT);
  await coldStart('journey');
  const ctx = await newBrowser(); const page = await ctx.newPage();
  const logMark = logSize(); // only log lines written by THIS run count for the download check
  const base = jvmSnap('0 before the browser starts');
  const configMarker = CONFIG_DIR ? path.join(CONFIG_DIR, 'globalStorage', 'fwcd.kotlin', 'config.json') : '';
  const markerBefore = configMarker && fs.existsSync(configMarker) ? fs.readFileSync(configMarker, 'utf8') : null;
  const popups = async () => page.evaluate(() => [...document.querySelectorAll('.theia-notification-list-item, .theia-notification-toast, .theia-dialog-shade .dialogBlock, .dialogBlock')].map((e) => e.innerText.replace(/\s+/g, ' ').slice(0, 220)).filter(Boolean));
  try {
    await gotoWorkspace(page);
    jvmSnap('1 workspace open, nothing else');
    await openWorkflow(page, ws, 'journey.cwf');
    await installProbe(page);
    jvmSnap('2 workflow canvas open, no dialog');
    // ---- dialog only
    await openGear(page, 'k1');
    jvmSnap('3a dialog just opened (+0.5s)');
    await sleep(9000);
    const dialogOnly = jvmSnap('3b dialog open (+10s)');
    const chip1 = await waitChip(page, 0, () => true, CHIP_MS);
    let ready1 = null;
    if (chip1) { ready1 = await waitChip(page, 0, (c) => c.state === 'ready' || c.state === 'unavailable', READY_MS); }
    const dialogReady = jvmSnap(`3c dialog open, chip ${ready1 ? ready1.state : 'absent'}`);
    const before = await highlightOf(page);
    await snap(page, 'journey-dialog-before-kt');
    console.log('HIGHLIGHT-BEFORE', JSON.stringify(before));
    // Only a dialog is open (no .kt file): exactly the bridge's own server may run, never the file-editor extension's
    const kind = kindOf;
    if (dialogReady === null) nv(id, 'only a dialog open starts no second Kotlin server', 'no backend pid');
    else {
      ac(id, 'a dialog alone (no .kt file open) runs exactly ONE Kotlin server process, the workbench\'s own', dialogReady.length === 1 && dialogReady[0].kind === 'bridge', `processes with only the dialog open: ${kind(dialogReady)} (${jvmLine(dialogReady)})`);
      ac(id, 'a dialog alone does not start the file-editor extension\'s server (also not 10 s after opening)', !dialogReady.some((s) => s.kind === 'extension') && !dialogOnly.some((s) => s.kind === 'extension'), `kinds at +0.5 s ${kind(jvmTrail.find((t) => t.label.startsWith('3a')).list)}, +10 s ${kind(dialogOnly)}, ready ${kind(dialogReady)}`);
      const afterProbe = jvmSnap('3d dialog open, after the highlighting probe');
      ac(id, 'still exactly one server after the highlighting probe tokenised with the dialog\'s language', afterProbe.length === 1 && afterProbe[0].kind === 'bridge', `processes: ${jvmLine(afterProbe)}`);
    }
    await pressDialogButton(page, 'Cancel');
    await sleep(3000);
    jvmSnap('4 dialog closed (+3s)');
    // ---- a .kt file
    await quickOpen(page, 'Main.kt');
    await waitModel(page, '/Main.kt');
    await sleep(2500);
    jvmSnap('5a Main.kt just opened');
    const ms = await waitFor(() => markers(page), (all) => all.some((m) => m.uri.endsWith('/Main.kt') && isError(m)), READY_MS, 1000);
    const mainMarkers = ms.filter((m) => m.uri.endsWith('/Main.kt'));
    const withKt = jvmSnap('5b Main.kt open, diagnostics shown');
    await snap(page, 'journey-main-kt');
    const fileSp = await page.evaluate(() => [...document.querySelectorAll('.monaco-editor')].filter((e) => !e.closest('[role="dialog"]')).flatMap((e) => [...e.querySelectorAll('.view-lines .view-line > span > span')].map((s) => ({ t: s.textContent.replace(/\u00a0/g, ' '), c: getComputedStyle(s).color }))));
    const fileLang = await page.evaluate(() => (window.__klsp.models().find((m) => m.uri.endsWith('/Main.kt')) || {}).lang);
    ac(id, 'the .kt file in the file editor is syntax-highlighted as well (language kotlin, 4+ colours)', fileLang === 'kotlin' && new Set(fileSp.map((s) => s.c)).size >= 4, `language ${fileLang}; colours ${JSON.stringify([...new Set(fileSp.map((s) => s.c))])}; first spans ${JSON.stringify(fileSp.slice(0, 6).map((s) => `${s.t}=${s.c}`))}`);
    ac(id, 'the file editor shows server diagnostics for Main.kt (fwcd.kotlin extension active)', mainMarkers.some(isError), JSON.stringify(mainMarkers.map((m) => `${m.sl}:${m.sc} ${m.message.slice(0, 60)}`)));
    if (withKt !== null) ac(id, 'a Kotlin server process serves the opened .kt file', withKt.length >= 1, `kinds: ${kind(withKt)}`);
    // ---- back to the dialog with the .kt open (also: highlighting after)
    await quickOpen(page, 'journey.cwf');
    await page.waitForSelector('.react-flow', { timeout: 30000 });
    await sleep(1500);
    await openGear(page, 'k1');
    const chip2 = await waitChip(page, 0, () => true, CHIP_MS);
    if (chip2) await waitChip(page, 0, (c) => c.state === 'ready' || c.state === 'unavailable', READY_MS);
    const both = jvmSnap(`6 dialog reopened with Main.kt open, chip ${chip2 ? (await chips(page))[0].state : 'absent'}`);
    const after = await highlightOf(page);
    await snap(page, 'journey-dialog-after-kt');
    console.log('HIGHLIGHT-AFTER', JSON.stringify(after));
    ac(id, `the Script dialog highlights Kotlin (editor language ${DIALOG_LANG}) before and after a .kt file was opened (keyword, number, comment, string all coloured)`, before.lang === DIALOG_LANG && after.lang === DIALOG_LANG && colourful(before) && colourful(after), `languages ${before.lang} / ${after.lang}; before ${JSON.stringify(before.colours)}; after ${JSON.stringify(after.colours)}`);
    ac(id, 'dialog highlighting is identical before and after the .kt file was opened (same token types and colours)', JSON.stringify(before) === JSON.stringify(after), `tokens before ${JSON.stringify(before.tokens)} after ${JSON.stringify(after.tokens)}`);
    // ---- both at once
    const hasSession = !!(await chips(page))[0];
    if (hasSession) {
      await page.evaluate(() => window.__klsp.setDialogText(0, 'val dlg: Int = "dialog-only"'));
      const dm = await waitMarker(page, OWNER, (m) => isError(m) && m.text === '"dialog-only"', 60000);
      const allNow = await markers(page);
      const mainNow = allNow.filter((m) => m.uri.endsWith('/Main.kt'));
      const dlgNow = allNow.filter((m) => m.owner === OWNER);
      await snap(page, 'journey-both-open');
      ac(id, 'with a .kt file and a dialog open, the dialog gets its own diagnostics', dm.some((m) => m.text === '"dialog-only"'), JSON.stringify(dlgNow.map((m) => `${m.uri.slice(0, 24)} ${m.sl}:${m.sc} ${m.text}`)));
      ac(id, 'the file editor\'s diagnostics are unchanged by the dialog, and neither leaks into the other', JSON.stringify(mainNow.map((m) => [m.sl, m.sc, m.message])) === JSON.stringify(mainMarkers.map((m) => [m.sl, m.sc, m.message])) && !dlgNow.some((m) => m.uri.endsWith('/Main.kt')) && !mainNow.some((m) => m.text === '"dialog-only"'), `Main.kt markers ${mainNow.length} (before ${mainMarkers.length}); dialog markers ${dlgNow.length}`);
      // Append on a new line instead of replacing the text: right after a whole-text replacement the server answers
      // completion from a stale analysis (keywords only) for a few seconds. That is a server behaviour, not a dialog/.kt
      // interaction (it reproduces with no .kt file open): see "Known server behaviour" in the header.
      await typeKeys(page, '\nflow.', { replace: false });
      const rows = await waitFor(() => suggestRows(page), (r) => r.length > 0, 30000);
      ac(id, 'completion in the dialog still works while the .kt file is open', ['get', 'set', 'all'].every((l) => rows.map((r) => r.label).includes(l)), rows.slice(0, 8).map((r) => r.label).join(', '));
    } else nv(id, 'dialog + .kt together', 'the dialog has no language-intelligence session to compare (no status chip)');
    await page.evaluate(() => window.__klsp.dismiss(0));
    await pressDialogButton(page, 'Cancel');
    jvmSnap('7 dialog closed again, Main.kt still open');
    // the file editor keeps working after the dialog is gone
    await quickOpen(page, 'Main.kt');
    await sleep(2000);
    const hov = await hoverOver(page, { file: true }, 'listOf', /listOf/, 40000);
    const after2 = (await markers(page)).filter((m) => m.uri.endsWith('/Main.kt'));
    ac(id, 'after the dialog is closed, the .kt file still has diagnostics and hover', after2.some(isError) && /listOf/.test(hov), `markers ${after2.length}; hover ${hov.slice(0, 120)}`);
    await snap(page, 'journey-main-kt-after-dialog');
    // ---- first-run prompt / downloads
    const pops = await popups();
    const logDownload = logSince(logMark).filter((l) => /\bdownload(?!:)/i.test(l)); // `yarn download:kotlin-ls` in an error hint is a script name, not a download
    const markerAfter = configMarker && fs.existsSync(configMarker) ? fs.readFileSync(configMarker, 'utf8') : null;
    ac(id, 'no first-run prompt, notification or download dialog appeared during the whole session', pops.length === 0, `popups: ${JSON.stringify(pops)}`);
    ac(id, 'the browser made no request to a host other than the workbench', ctx.external.length === 0, `external: ${JSON.stringify([...new Set(ctx.external)].slice(0, 6))}`);
    if (BACKEND_LOG) ac(id, 'the backend log mentions no download', logDownload.length === 0, JSON.stringify(logDownload.slice(0, 4)));
    else nv(id, 'backend log has no download lines', 'BACKEND_LOG not set');
    if (configMarker) ac(id, 'the extension\'s first-run marker is present and unchanged', markerBefore !== null && markerBefore === markerAfter, `before ${markerBefore} after ${markerAfter}`);
    else nv(id, 'first-run marker', 'THEIA_CONFIG_DIR not set');
    console.log('JOURNEY JVM TRAIL', JSON.stringify(jvmTrail.map((t) => ({ label: t.label, n: t.list === null ? null : t.list.length, kinds: kind(t.list), rssMb: (t.list || []).map((s) => s.rssMb) }))));
    void base; void both; void dialogOnly;
  } catch (e) { await snap(page, 'crash'); throw e; } finally {
    reportErrors(ctx, 'journey');
    await ctx.browser.close();
    await sleep(5000);
    jvmSnap('9 browser closed (+5s)');
  }
}

/** A stored script with a type error shows its marker on a COLD server without any edit; a dialog alone starts exactly one server process. */
async function scenarioFirstOpen() {
  const id = 'first-open';
  write('firstopen.cwf', scriptCwf('firstopen', 'val x: Int = "a"\n'));
  await coldStart('first-open');
  await withDialog('firstopen.cwf', async ({ page }) => {
    const t0 = Date.now();
    const first = await waitChip(page, 0, () => true, CHIP_MS);
    await snap(page, 'firstopen-starting');
    const st = first ? await waitChip(page, 0, (c) => c.state === 'ready' || c.state === 'unavailable', READY_MS) : null;
    const tReady = Date.now() - t0;
    const up = jvmSnap(`first-open: dialog ready (${Math.round(tReady / 1000)} s after opening)`);
    ac(id, 'cold start: the dialog shows the status chip (starting) and it becomes ready', !!first && !!st && st.state === 'ready', `first chip ${JSON.stringify(first)}; then ${JSON.stringify(st)} after ${tReady} ms`);
    if (!st || st.state !== 'ready') return;
    const t1 = Date.now();
    const ms = await waitMarker(page, OWNER, isError, 30000);
    const hit = ms.find(isError);
    await snap(page, 'firstopen-markers');
    ac(id, 'the stored script\'s type error is marked WITHOUT any edit (diagnostics after the first open)', !!hit && hit.sl === 1 && hit.sc === 14 && hit.text === '"a"' && (await dialogText(page)) === 'val x: Int = "a"\n',
      `marker ${hit ? `${hit.sl}:${hit.sc} over ${JSON.stringify(hit.text)} "${hit.message}"` : 'none'} ${Date.now() - t1} ms after ready; text untouched: ${JSON.stringify(await dialogText(page))}`);
    ac(id, 'a dialog alone starts exactly one Kotlin server, the workbench\'s own (no file-editor extension server)', up === null ? true : up.length === 1 && up[0].kind === 'bridge', `processes: ${jvmLine(up)}`);
    if (up === null) nv(id, 'a dialog alone starts exactly one Kotlin server', 'no backend pid to inspect');
    // the server is warm now: closing and reopening shows the marker again without an edit
    await pressDialogButton(page, 'Cancel');
    await sleep(1500);
    await openGear(page, 'k1');
    const t2 = Date.now();
    const again = await waitMarker(page, OWNER, isError, 40000);
    await snap(page, 'firstopen-reopen-warm');
    const hit2 = again.find(isError);
    ac(id, 'reopening the dialog on the warm server shows the marker again without an edit', !!hit2 && hit2.sl === 1 && hit2.sc === 14, `marker ${hit2 ? `${hit2.sl}:${hit2.sc}` : 'none'} ${Date.now() - t2} ms after reopening; processes ${jvmLine(kotlinServers())}`);
  });
}

/** Unclosed script: a missing closing `}` or `)` is reported on the last line the user can see (errors only), and disappears once fixed. */
async function scenarioUnclosed() {
  const id = 'unclosed';
  write('unclosed.cwf', scriptCwf('unclosed', '// systest\n'));
  await withDialog('unclosed.cwf', async ({ page }) => {
    if (!(await reachReady(page, id, 'unclosed'))) return;
    const cases = [
      { name: 'an `if` block that is never closed', script: 'if (true) {\n    println(1)', last: 2 },
      { name: 'a call whose parenthesis is never closed', script: 'println(1', last: 1 },
      { name: 'a function body that is never closed (4 lines)', script: 'fun f(): Int {\n    return 1\n\nval y = f()', last: 4 }
    ];
    let n = 0;
    for (const c of cases) {
      n++;
      await page.evaluate((t) => window.__klsp.setDialogText(0, t), c.script);
      const ms = await waitMarker(page, OWNER, isError, 60000);
      await sleep(1500);
      const all = await markers(page, OWNER);
      const lines = c.script.split('\n').length;
      const onLast = all.filter((m) => isError(m) && m.sl === c.last);
      const leaks = all.filter((m) => m.sl > lines || /continuumScript|ScriptFlowVariables/.test(m.message) /* names of the reported context and the wrapper must never reach the user's diagnostics */);
      await snap(page, `unclosed-${n}`);
      ac(id, `${c.name}: an error marker is shown on the last line of the script (line ${c.last})`, onLast.length > 0 && leaks.length === 0 && ms.some(isError), `markers: ${JSON.stringify(all.map((m) => `${m.sl}:${m.sc}-${m.el}:${m.ec} sev ${m.severity} ${m.message.slice(0, 70)}`))}; leaks ${leaks.length}`);
    }
    await page.evaluate(() => window.__klsp.setDialogText(0, 'if (true) {\n    println(1)\n}'));
    const cleared = await waitFor(() => markers(page, OWNER), (ms) => ms.length === 0, 40000, 500);
    await snap(page, 'unclosed-fixed');
    ac(id, 'closing the brace removes the marker (balanced script: no diagnostics)', cleared.length === 0, `markers: ${JSON.stringify(cleared.map((m) => `${m.sl}:${m.sc} ${m.message.slice(0, 60)}`))}`);
  });
}

/** Script header: a leading block comment, KDoc or `@file:` line before the imports must not push the imports into the wrapper function (false errors) or shift positions. */
async function scenarioHeader() {
  const id = 'header';
  write('header.cwf', scriptCwf('header', '// systest\n'));
  await withDialog('header.cwf', async ({ page }) => {
    if (!(await reachReady(page, id, 'header'))) return;
    const cases = [
      { name: 'a leading block comment before an import', head: '/* Copyright */\nimport kotlin.math.abs', lit: '"b1"' },
      { name: 'a multi-line KDoc block before two imports', head: '/**\n * Doc\n */\nimport kotlin.math.abs\nimport kotlin.math.max', lit: '"b2"' },
      { name: 'a @file: annotation before an import', head: '@file:Suppress("UNUSED_VARIABLE")\nimport kotlin.math.abs', lit: '"b3"' },
      { name: 'a block comment, a // comment and a @file: line before an import', head: '/* a */\n// b\n@file:Suppress("UNUSED_VARIABLE")\nimport kotlin.math.abs', lit: '"b4"' }
    ];
    let n = 0;
    for (const c of cases) {
      n++;
      const script = `${c.head}\nval n: Int = ${c.lit}`;
      const line = script.split('\n').length;
      await page.evaluate((t) => window.__klsp.setDialogText(0, t), script);
      await waitMarker(page, OWNER, (m) => isError(m) && m.text === c.lit, 60000);
      await sleep(3000);
      const all = await markers(page, OWNER);
      const errs = all.filter(isError);
      const hit = errs.find((m) => m.text === c.lit);
      await snap(page, `header-${n}`);
      ac(id, `${c.name}: the only error is the deliberate one, on its exact line and column (no false error on the imports)`, errs.length === 1 && !!hit && hit.sl === line && hit.sc === 'val n: Int = '.length + 1,
        `want ${line}:${'val n: Int = '.length + 1} over ${c.lit}; got ${JSON.stringify(all.map((m) => `${m.sl}:${m.sc}-${m.el}:${m.ec} sev ${m.severity} ${m.message.slice(0, 70)} [${m.text}]`))}`);
    }
    const valid = '/* Copyright */\nimport kotlin.math.abs\nval n = abs(-1)\nflow.set("n", n)';
    await page.evaluate((t) => window.__klsp.setDialogText(0, t), valid);
    const cleared = await waitFor(() => markers(page, OWNER), (ms) => ms.length === 0, 40000, 500);
    await sleep(4000);
    const later = await markers(page, OWNER);
    await snap(page, 'header-valid');
    ac(id, 'a valid script with a leading block comment and an import has no diagnostics at all', cleared.length === 0 && later.length === 0, `markers: ${JSON.stringify(later.map((m) => `${m.sl}:${m.sc} ${m.message.slice(0, 80)}`))}`);
    // declarations that Kotlin allows at script top level: the wrapper puts the script inside a function body, where `object`, `enum class`,
    // `interface` and `typealias` are not allowed (the node itself runs the text as a script, where they are). `class` and `fun` are fine in both.
    const decls = [
      ['class', 'class A(val x: Int)\nval a = A(1)\nflow.set("a", a.x)', false],
      ['fun', 'fun helper(x: Int) = x * 2\nflow.set("h", helper(2))', false],
      ['object', 'object Util { fun twice(x: Int) = x * 2 }\nval n = Util.twice(21)\nflow.set("n", n)', true],
      ['enum class', 'enum class Color { RED, GREEN }\nflow.set("c", Color.RED.name)', true],
      ['interface', 'interface Greeter { fun hi(): String }\nval g = object : Greeter { override fun hi() = "hi" }\nflow.set("g", g.hi())', true],
      ['typealias', 'typealias Row = Map<String, Any>\nval r: Row = row\nflow.set("r", r.size)', true]
    ];
    let d = 0;
    for (const [name, text, expectedLimit] of decls) {
      d++;
      await page.evaluate((t) => window.__klsp.setDialogText(0, t), text);
      await sleep(7000);
      const ms = await markers(page, OWNER);
      const errs = ms.filter(isError);
      await snap(page, `header-decl-${d}-${name.replace(/\W+/g, '-')}`);
      console.log(`OBSERVATION [header] top-level \`${name}\` declaration: ${errs.length ? 'ERROR MARKER(S) ' : 'no error marker '}${JSON.stringify(ms.map((m) => `${m.sl}:${m.sc} sev ${m.severity} ${m.message.slice(0, 90)}`))}`);
      ac(id, `a script that declares a top-level ${name} (valid in a Kotlin script) shows no error marker${expectedLimit ? ' [wrapper limit: the declaration is inside a function body]' : ''}`, errs.length === 0, `markers ${JSON.stringify(ms.map((m) => `${m.sl}:${m.sc}-${m.el}:${m.ec} sev ${m.severity} ${m.message.slice(0, 90)}`))}`);
    }
    nv(id, 'that the node\'s own script engine accepts top-level object/enum class/interface/typealias declarations', 'no platform stack, so a script cannot be run; derived from Kotlin script (REPL snippet) semantics');
  });
}

/** The server is killed while it is still starting: the bridge restarts it after its back-off; the dialog ends ready and shows its markers. */
async function scenarioKillEarly() {
  const id = 'kill-early';
  write('killearly.cwf', scriptCwf('killearly', 'val x: Int = "a"\n'));
  await coldStart('kill-early');
  await withDialog('killearly.cwf', async ({ ctx, page }) => {
    const t0 = Date.now(); let victim = null;
    while (Date.now() - t0 < 20000 && !victim) { victim = (kotlinServers() || []).find((s) => s.kind === 'bridge'); if (!victim) await sleep(100); }
    if (!victim) { await snap(page, 'killearly-no-server'); ac(id, 'a server process appears when the dialog opens', false, `none within 20 s; chip ${JSON.stringify((await chips(page))[0])}`); return; }
    const before = (await chips(page))[0];
    process.kill(victim.pid, 'SIGTERM');
    const tKill = Date.now();
    const line = []; let last = null; let sawUnavailable = false;
    const sample = async () => { const c = (await chips(page))[0]; const s = c ? c.state : 'none'; if (s === 'unavailable') sawUnavailable = true; if (s !== last) { last = s; line.push(`${((Date.now() - tKill) / 1000).toFixed(1)}s ${s}`); } return s; };
    await sample();
    const end = await waitFor(sample, (s) => s === 'ready', READY_MS, 250);
    const second = (kotlinServers() || []).find((s) => s.kind === 'bridge');
    await snap(page, 'killearly-ready');
    ac(id, `killing the server while it is starting (chip was ${before && before.state}): the dialog ends up ready on a NEW server process`, end === 'ready' && !!second && second.pid !== victim.pid, `killed pid ${victim.pid} at +${Math.round((tKill - t0) / 100) / 10} s after the dialog opened; chip timeline ${line.join(' -> ')}; new server ${second ? second.pid : 'none'}`);
    ac(id, 'a single early kill never shows "unavailable" (the bridge restarts it after its short back-off)', !sawUnavailable, `chip timeline ${line.join(' -> ')}`);
    const ms = await waitMarker(page, OWNER, isError, 40000);
    ac(id, 'after the restart the stored script\'s marker appears without an edit', ms.some((m) => isError(m) && m.sl === 1 && m.sc === 14), `markers ${JSON.stringify(ms.map((m) => `${m.sl}:${m.sc} ${m.text}`))}`);
    void ctx;
  });
}

/**
 * Channel: the channel open of the Kotlin registration never completes (simulated in the test browser by holding the Socket.IO frame
 * pair back; this is what a thin/browser-only workbench or a backend that does not answer looks like to the frontend). The chip must turn
 * to "unavailable" after the 10 s watchdog (not stay "starting" forever), the editor must stay editable, and a late answer must be adopted.
 */
async function scenarioChannel() {
  const id = 'channel';
  write('channel.cwf', scriptCwf('channel', 'val x: Int = "a"\n'));
  await coldStart('channel');
  const ctx = await newBrowser(); const page = await ctx.newPage({ faultInjection: true });
  try {
    await openWorkflow(page, ws, 'channel.cwf');
    await installProbe(page);
    await page.evaluate(() => { window.__fault.hold = true; });
    await openGear(page, 'k1');
    const t0 = Date.now();
    const line = []; let last = null;
    const sample = async () => { const c = (await chips(page))[0]; const s = c ? c.state : 'none'; if (s !== last) { last = s; line.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`); } return s; };
    await sample();
    await snap(page, 'channel-starting');
    const firstUnavailable = await waitFor(sample, (s) => s === 'unavailable', 25000, 250);
    const tUnavailable = Date.now() - t0;
    await snap(page, 'channel-unavailable');
    ac(id, 'the channel open never completes: the chip does not stay "starting" forever but turns "unavailable" after the ~10 s watchdog', firstUnavailable === 'unavailable' && tUnavailable >= 8000 && tUnavailable <= 16000, `chip timeline ${line.join(' -> ')} (unavailable after ${tUnavailable} ms)`);
    // keep it down long enough for two more retry rounds (back-off 1 s, then 2 s after each 10 s watchdog), watching the console
    await waitFor(sample, () => false, 26000, 250);
    const held = await page.evaluate(() => ({ seen: window.__fault.seen, held: window.__fault.held.length }));
    const down = jvmSnap('channel: open held back for ~40 s');
    ac(id, 'while the open is held back the chip stays "unavailable" and no Kotlin server was started', last === 'unavailable' && (down === null ? true : down.length === 0), `chip timeline ${line.join(' -> ')}; held open messages ${JSON.stringify(held)}; processes ${jvmLine(down)}`);
    // the editor is still an editor
    await typeKeys(page, 'val held: Int = "held"');
    await sleep(800);
    ac(id, 'while unavailable the editor stays editable', (await dialogText(page)) === 'val held: Int = "held"', `text ${JSON.stringify(await dialogText(page))}`);
    const errsHeld = ctx.errs.map((e, i) => ({ e, t: ((ctx.errTimes[i] - ctx.t0) / 1000).toFixed(1) })).filter((x) => !NOISE.test(x.e));
    console.log(`OBSERVATION console errors/warnings while the open was held back: ${JSON.stringify(errsHeld.map((x) => `${x.t}s ${x.e.slice(0, 160)}`))}; language-server logs ${JSON.stringify([...new Set(ctx.logs)].slice(0, 6))}`);
    // release the held frames: the late answer is adopted, the server starts, diagnostics flow again
    const tRel = Date.now();
    await page.evaluate(() => window.__fault.release());
    const back = await waitFor(sample, (s) => s === 'ready', READY_MS, 250);
    await snap(page, 'channel-late-ready');
    const up = jvmSnap('channel: late answer adopted');
    ac(id, 'a late answer of the held-back open is adopted: the chip goes ready and exactly one Kotlin server runs', back === 'ready' && (up === null ? true : up.length === 1 && up[0].kind === 'bridge'), `chip timeline ${line.join(' -> ')} (ready ${Math.round((Date.now() - tRel) / 100) / 10} s after the release); processes ${jvmLine(up)}`);
    const ms = await waitMarker(page, OWNER, (m) => isError(m) && m.text === '"held"', 40000);
    ac(id, 'after the late adoption the text typed while it was down is analysed (error marker on it)', ms.some((m) => isError(m) && m.text === '"held"'), `markers ${JSON.stringify(ms.map((m) => `${m.sl}:${m.sc} ${m.text}`))}`);
    await sleep(15000); // a retry that was already scheduled would fire now: it must not break the adopted wire
    const stillReady = (await chips(page))[0];
    const afterErrs = ctx.errs.map((e, i) => ({ e, t: ((ctx.errTimes[i] - ctx.t0) / 1000).toFixed(1) })).filter((x) => !NOISE.test(x.e));
    console.log(`OBSERVATION console errors after the release: ${JSON.stringify(afterErrs.slice(errsHeld.length).map((x) => `${x.t}s ${x.e.slice(0, 160)}`))}`);
    ac(id, 'the adopted wire stays healthy (chip still ready 15 s later, markers intact)', !!stillReady && stillReady.state === 'ready' && (await markers(page, OWNER)).some((m) => m.text === '"held"'), `chip ${JSON.stringify(stillReady)}`);
    // Save is never blocked
    const clicked = await pressDialogButton(page, 'Save changes');
    ac(id, 'Save changes works as usual', clicked === 'clicked', `button ${clicked}`);
  } catch (e) { await snap(page, 'crash'); throw e; } finally { reportErrors(ctx, 'channel'); await ctx.browser.close(); }
}

/** Opt-in (ONLY=hung): a frozen server (SIGSTOP) answers nothing; after three unanswered requests the bridge replaces it. */
async function scenarioHung() {
  const id = 'hung';
  write('hung.cwf', scriptCwf('hung', '// systest\n'));
  await coldStart('hung');
  let victim = null;
  try {
    await withDialog('hung.cwf', async ({ page }) => {
      if (!(await reachReady(page, id, 'hung'))) return;
      victim = (kotlinServers() || []).find((s) => s.kind === 'bridge');
      if (!victim) { nv(id, 'a frozen server is replaced', 'no bridge server process to freeze'); return; }
      process.kill(victim.pid, 'SIGSTOP');
      const tStop = Date.now();
      await typeKeys(page, 'flow.');
      for (let i = 0; i < 3; i++) { await sleep(1500); await page.keyboard.down('Control'); await page.keyboard.press('Space'); await page.keyboard.up('Control'); }
      await snap(page, 'hung-frozen');
      ac(id, 'while the server is frozen the editor stays editable', (await dialogText(page)) === 'flow.', `text ${JSON.stringify(await dialogText(page))}`);
      const swapped = await waitFor(() => (kotlinServers() || []).filter((s) => s.kind === 'bridge' && s.pid !== victim.pid), (l) => l.length > 0, 120000, 1000);
      const tSwap = Date.now() - tStop;
      const back = await waitChip(page, 0, (c) => c.state === 'ready', READY_MS);
      await snap(page, 'hung-replaced');
      ac(id, 'after three unanswered requests the frozen server is replaced by a new process and the chip is ready again', swapped.length > 0 && !!back && back.state === 'ready', `old pid ${victim.pid} frozen; new ${swapped.map((s) => s.pid).join(',') || 'none'} after ${Math.round(tSwap / 1000)} s; chip ${JSON.stringify(back)}`);
      await sleep(1500);
      const old = (kotlinServers() || []).find((s) => s.pid === victim.pid);
      ac(id, 'the frozen process is gone (no leftover JVM)', !old, `processes ${jvmLine(kotlinServers())}`);
    });
  } finally {
    if (victim) { try { process.kill(victim.pid, 'SIGCONT'); process.kill(victim.pid, 'SIGKILL'); } catch { /* gone */ } }
  }
}

// ---------------------------------------------------------------------------------------------- main
// ---- the names a script can use come from the node's report (options.scriptContext) ----------------------------------------
/** A context a node could report for its own types; `member` is the only member of its `Shared` type. */
const syntheticContext = (name, member) => ({ language: 'kotlin', bindings: [{ name, type: 'Shared' }], declarations: `/** Only here. */\ninterface Shared {\n  fun ${member}(): Int\n}\n` });

/** Opens the dialog of `nodeId`, waits, and describes whether the editor is a plain code editor (no chip, footer, connection, provider or marker). */
async function plainEditorState(page, nodeId) {
  await openGear(page, nodeId);
  await sleep(6000);
  return page.evaluate(() => ({
    editors: document.querySelectorAll('[role="dialog"] .monaco-editor').length,
    footers: document.querySelectorAll('[data-testid="language-intelligence-footer"]').length, chips: document.querySelectorAll('[data-testid="language-server-status"]').length,
    intel: window.__klsp.intel(), providers: window.__klsp.reg.bridge.active, markers: window.__klsp.markers().filter((m) => /^language-server/.test(m.owner)).length
  }));
}
const isPlain = (o) => o.editors >= 1 && o.footers === 0 && o.chips === 0 && (!o.intel || o.intel.connections === 0) && o.providers === 0 && o.markers === 0;

async function scenarioNoContext() {
  const id = 'no-context';
  const file = write('no-context.cwf', cwf('no-context', [scriptNode('k1', undefined, '// old\n')]));
  await withDialog('no-context.cwf', async ({ page }) => {
    await sleep(6000);
    const o = await page.evaluate(() => ({
      editors: document.querySelectorAll('[role="dialog"] .monaco-editor').length, footers: document.querySelectorAll('[data-testid="language-intelligence-footer"]').length, chips: document.querySelectorAll('[data-testid="language-server-status"]').length,
      intel: window.__klsp.intel(), providers: window.__klsp.reg.bridge.active, markers: window.__klsp.markers().filter((m) => /^language-server/.test(m.owner)).length
    }));
    ac(id, 'a Script node that reports no context gets a plain code editor: no chip, footer, connection, provider or marker', isPlain(o), JSON.stringify(o));
    const typed = 'val x: Int = "a"';
    await typeKeys(page, typed);
    await sleep(1500);
    const after = await page.evaluate(() => window.__klsp.markers().filter((m) => /^language-server/.test(m.owner)).length);
    ac(id, 'typing in it works and gets no language-server marker', (await dialogText(page)) === typed && after === 0, `markers ${after}`);
    const clicked = await pressDialogButton(page, 'Save changes');
    await saveWorkflow(page);
    const wf = await readCwf(file, (w) => w.nodes[0].data.properties.script !== '// old\n');
    ac(id, 'saving stores exactly the typed text', clicked === 'clicked' && wf.nodes[0].data.properties.script === typed, JSON.stringify(wf.nodes[0].data.properties.script));
  });
}

async function scenarioBadContext() {
  const id = 'bad-context';
  const good = { language: 'kotlin', bindings: [{ name: 'a', type: 'Int' }], declarations: 'interface Q\n' };
  const bad = [
    ['a binding type that is not text', { ...good, bindings: [{ name: 'a', type: 5 }] }],
    ['a binding name that is not an identifier', { ...good, bindings: [{ name: 'a b', type: 'Int' }] }],
    ['a package line in the declarations', { ...good, declarations: 'package evil\ninterface Q\n' }],
    ['declarations over 64 KB', { ...good, declarations: `interface Q\n${'// x\n'.repeat(20000)}` }],
    ['a context that is not an object', 'not an object']
  ];
  write('bad-context.cwf', cwf('bad-context', bad.map(([, context], index) => scriptNode(`b${index}`, context, '// systest\n', 80 + index * 40, 80 + index * 30))));
  const ctx = await newBrowser(); const page = await ctx.newPage();
  try {
    await openWorkflow(page, ws, 'bad-context.cwf');
    await installProbe(page);
    for (const [index, [what]] of bad.entries()) {
      const o = await plainEditorState(page, `b${index}`);
      await snap(page, `bad-context-${index}`);
      ac(id, `${what}: the editor is plain and the dialog still opens`, isPlain(o), JSON.stringify(o));
      await pressDialogButton(page, 'Cancel');
    }
  } catch (e) { await snap(page, 'crash'); throw e; } finally { reportErrors(ctx, 'bad-context.cwf'); await ctx.browser.close(); }
}

async function scenarioTwoContexts() {
  const id = 'twocontexts';
  // two workflows (editor tabs): a workflow shows one node dialog at a time, a second tab's dialog can be open at once
  write('twocontexts-b.cwf', cwf('twocontexts-b', [scriptNode('kb', syntheticContext('beta1', 'onlyInB'))]));
  write('twocontexts.cwf', cwf('twocontexts', [scriptNode('ka', syntheticContext('alpha1', 'onlyInA'))]));
  await coldStart('twocontexts');
  const ctx = await newBrowser(); const page = await ctx.newPage();
  try {
    await openWorkflow(page, ws, 'twocontexts-b.cwf');
    await installProbe(page);
    const { openFile } = await import('./lib.mjs');
    await openFile(page, 'twocontexts.cwf');
    await openGear(page, 'ka');
    if (!(await reachReady(page, id, 'twocontexts (dialog A)', 0))) return;
    await page.evaluate(() => document.querySelector('[data-testid="node-settings-button-kb"]').click());
    await waitFor(() => page.evaluate(() => window.__klsp.dialogCount()), (n) => n >= 2, 15000);
    await waitFor(() => chips(page), (c) => c.length >= 2 && c.every((x) => x.state === 'ready'), READY_MS, 500);
    await typeKeys(page, 'beta1.', { idx: 1 });
    const inB = await suggestUntil(page, ['onlyInB']);
    await snap(page, 'twocontexts-b');
    ac(id, 'dialog B offers the member of its own context and not the one of dialog A\'s', inB.rows.some((r) => r.label === 'onlyInB') && !inB.rows.some((r) => r.label === 'onlyInA'), `items: ${inB.rows.map((r) => r.full).slice(0, 8).join(', ')}`);
    await page.evaluate(() => window.__klsp.dismiss(0));
    await pressDialogButton(page, 'Cancel', 1);
    await typeKeys(page, 'alpha1.', { idx: 0 });
    const inA = await suggestUntil(page, ['onlyInA']);
    await snap(page, 'twocontexts-a');
    ac(id, 'dialog A offers the member of its own context and not dialog B\'s', inA.rows.some((r) => r.label === 'onlyInA') && !inA.rows.some((r) => r.label === 'onlyInB'), `items: ${inA.rows.map((r) => r.full).slice(0, 8).join(', ')}`);
    await sleep(3000);
    const redeclared = (await markers(page, OWNER)).filter((m) => /redeclaration|conflicting/i.test(m.message));
    ac(id, 'two contexts declaring the same type name raise no redeclaration marker', redeclared.length === 0, JSON.stringify(redeclared.map((m) => m.message)));
    await pressDialogButton(page, 'Cancel', 0);
  } catch (e) { await snap(page, 'crash'); throw e; } finally { reportErrors(ctx, 'twocontexts.cwf'); await ctx.browser.close(); }
}

const ALL = {
  'first-open': scenarioFirstOpen, completion: scenarioCompletion, valid: scenarioValid, diagnostics: scenarioDiagnostics, hover: scenarioHover, sighelp: scenarioSighelp,
  unclosed: scenarioUnclosed, header: scenarioHeader, save: scenarioSave, twodialogs: scenarioTwoDialogs, fallback: scenarioFallback, 'kill-early': scenarioKillEarly, channel: scenarioChannel,
  'rest-unchanged': scenarioRest, 'kt-file': scenarioKtFile, 'no-context': scenarioNoContext, 'bad-context': scenarioBadContext, twocontexts: scenarioTwoContexts, journey: scenarioJourney, hung: scenarioHung
};
const OPT_IN = new Set(['hung']);
/** Scenarios that do not use the real reported names (a plain editor, or the file editor), so they run without the feature source. */
const NEEDS_NO_REPORT = new Set(['kt-file', 'no-context', 'bad-context', 'twocontexts']);
const only = process.env.ONLY ? process.env.ONLY.split(',').map((s) => s.trim()) : null;
console.log(`kotlin-lsp suite against ${WORKBENCH_URL}; backend pid ${BACKEND_PID}; screenshots ${SHOT_DIR}; workspace ${ws}`);
for (const [name, fn] of Object.entries(ALL)) {
  if (only ? !only.includes(name) : OPT_IN.has(name)) continue;
  console.log(`\n=== ${name} ===`);
  if (REPORTED.skip && !NEEDS_NO_REPORT.has(name)) { nv(name, 'the scenario needs the names the node reports', REPORTED.skip); continue; }
  const t0 = Date.now(); const off = logSize();
  try { await fn(); } catch (e) { record(name, 'scenario crashed', false, String(e.stack || e).split('\n').slice(0, 3).join(' | ')); }
  const lines = logSince(off);
  if (lines.length) console.log(`BACKEND LOG during ${name}:\n  ${lines.slice(-14).join('\n  ')}`);
  console.log(`--- ${name} took ${Math.round((Date.now() - t0) / 1000)}s`);
}
console.log('\n=== SUMMARY ===');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.ac}  ${r.name}`);
for (const n of notVerified) console.log(`NOT VERIFIED  ${n.id}  ${n.name}  -- ${n.why}`);
if (!process.env.KEEP) fs.rmSync(ws, { recursive: true, force: true });
process.exit(results.some((r) => !r.ok) ? 1 : 0);
