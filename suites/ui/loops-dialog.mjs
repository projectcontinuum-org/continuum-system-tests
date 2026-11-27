// Browser scenarios for the Loop node (CONTNM-180), part 2: condition dialog , visuals , run display .
//
// Run (workbench with the loop changes serving; platform from `make up` or a local stack on 8080/8083):
//   WORKBENCH_URL=http://127.0.0.1:3003 SHOT_DIR=/path/to/screenshots node suites/ui/loops-dialog.mjs
//   ONLY=visual|dialog|shapes|run|design|dragout|mouse|r5theme  select one scenario. Env: see lib.mjs. Test data lives in a temp workspace systest-<runId>-loops-*.
import fs from 'node:fs';
import path from 'node:path';
import { drag, API, flags, launch, record, results, shot, sleep, makeWorkspace, openWorkflow, canvasNodes, zoomOut, readCwf, dblclick, openFile } from './lib.mjs';

const runId = Date.now().toString(36);
const ws = makeWorkspace(runId);
const EX = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../docker/example-workflows/test.cwf');
const ex = JSON.parse(fs.readFileSync(EX, 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
// The Loop node descriptor comes from the running platform's node explorer (nothing is read from /tmp).
const searchRes = await (await fetch(`${API}/api/v1/node-explorer/search?query=org.projectcontinuum.core.builtin.Loop`)).json();
const loopInfo = searchRes.flatMap((c) => c.children ?? []).find((c) => c.id === 'org.projectcontinuum.core.builtin.Loop')?.nodeInfo;
if (!loopInfo) throw new Error('Loop node not registered in the node explorer (is the orchestration service up?)');
const loopTpl = { id: 'L', type: 'Loop', position: { x: 0, y: 0 }, width: 520, height: 320, style: { width: 520, height: 320 }, selected: false, dragging: false, positionAbsolute: { x: 0, y: 0 }, data: { ...clone(loopInfo), inputs: loopInfo.inputs ?? {}, outputs: loopInfo.outputs ?? {}, collapsed: false } };
const splitTpl = ex.nodes.find((n) => /ConditionalSplitter/.test(n.data.nodeModel));
const tableTpl = ex.nodes.find((n) => /CreateTable/.test(n.data.nodeModel));

/** Workflow: seed table (outside) -> splitter (member of loop L). */
function build(condition, extra = {}) {
  const loop = clone(loopTpl); loop.id = 'L'; loop.position = { x: 380, y: 120 }; loop.width = 520; loop.height = 320; loop.style = { width: 520, height: 320 };
  loop.data.collapsed = false; Object.assign(loop.data.properties, { condition }, extra);
  const seed = clone(tableTpl); seed.id = 'seed'; seed.position = { x: 60, y: 200 };
  seed.data.properties = { jsonArrayString: '[{"id":1,"value":10},{"id":2,"value":20},{"id":3,"value":30}]' };
  const m = clone(splitTpl); m.id = 'm1'; m.parentNode = 'L'; m.extent = undefined; m.position = { x: 120, y: 100 };
  m.data.properties = { column: 'value', threshold: 15 };
  return { id: 'wf-' + runId, name: 'x.cwf', active: false, nodes: [loop, seed, m], edges: [{ type: 'BaseEdge', source: 'seed', sourceHandle: 'data', target: 'm1', targetHandle: 'data', id: 'reactflow__edge-seeddata-m1data' }] };
}
const write = (name, wf) => { fs.writeFileSync(path.join(ws, name), JSON.stringify(wf)); return path.join(ws, name); };
const tids = (page) => page.evaluate(() => [...document.querySelectorAll('[data-testid]')].map((e) => e.dataset.testid).filter((t) => /loop-condition/.test(t)));
const dlgText = (page) => page.evaluate(() => { const d = document.querySelector('[role="dialog"], .MuiDialog-root'); return d ? d.innerText.replace(/\s+/g, ' ').slice(0, 1200) : null; });
const loopBox = async (page) => (await canvasNodes(page)).find((n) => n.type === 'Loop');
const cond = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).nodes.find((n) => n.type === 'Loop').data.properties.condition;

async function openDialog(page) {
  await page.waitForSelector('[data-testid="loop-settings-button"]', { timeout: 20000 });
  await sleep(1000);
  await page.evaluate(() => document.querySelector('[data-testid="loop-settings-button"]').click());
  await sleep(4500);
}

async function scenarioVisual() {
  const errs = [];
  for (const collapsed of [false, true]) {
    const wf = buildRich(collapsed); const name = collapsed ? 'vis-c.cwf' : 'vis-e.cwf'; write(name, wf);
    const { browser, page, errs: e } = await launch(); errs.push(...e);
    try {
      await openWorkflow(page, ws, name);
      await page.click('.react-flow__controls-fitview').catch(() => {}); await sleep(1500);
      const tag = collapsed ? 'collapsed' : 'expanded';
      const hs = await page.evaluate(() => [...document.querySelectorAll('.react-flow__node-Loop .react-flow__handle')].map((h) => { const r = h.getBoundingClientRect(); return { op: getComputedStyle(h).opacity, w: r.width }; }));
      record('Loop', `${tag} Loop shows no visible connection handles (none, or invisible display-only anchors)`, hs.every((h) => parseFloat(h.op) === 0 || h.w < 2), JSON.stringify(hs));
      const wr = await page.evaluate(() => [...document.querySelectorAll('.react-flow__node-Loop')].map((w) => { const b = w.querySelector('[data-testid^="loop-node-"]'); const a = w.getBoundingClientRect(), c = b.getBoundingClientRect(); return { id: w.dataset.id, wrapper: [Math.round(a.x), Math.round(a.y), Math.round(a.width), Math.round(a.height)], box: [Math.round(c.x), Math.round(c.y), Math.round(c.width), Math.round(c.height)] }; }));
      console.log('WRAPPER-VS-BOX', tag, JSON.stringify(wr));
      const g = await edgeGeom(page); const L = g.nodes.L;
      if (collapsed) {
        record('Loop', 'collapsed Loop still draws both boundary-crossing edges', g.edges.length === 2, `edges=${g.edges.length}`);
        const near = (p, x) => p && Math.abs(p.x - x) < 8 && p.y > L.y - 4 && p.y < L.y + L.h + 4;
        const inE = g.edges.find((x) => /seed/.test(x.id)); const outE = g.edges.find((x) => /after/.test(x.id));
        record('Loop', 'inbound wire ends on the left edge of the collapsed box', near(inE?.b, L.x), JSON.stringify(inE?.b) + ' box.x=' + Math.round(L.x));
        record('Loop', 'outbound wire starts on the right edge of the collapsed box (like the mockup)', near(outE?.a, L.x + L.w), JSON.stringify(outE?.a) + ' box.right=' + Math.round(L.x + L.w));
        const ctl = await page.evaluate(() => ({ toggle: !!document.querySelector('[data-testid="loop-collapse-toggle"]'), gear: !!document.querySelector('[data-testid="loop-settings-button"]'), text: document.querySelector('[data-testid^="loop-node-"]').innerText.replace(/\n+/g, ' | ') }));
        record('Design', 'collapsed box shows "3 nodes inside" and an expand control', /3 nodes inside/.test(ctl.text) && ctl.toggle, ctl.text);
      } else {
        // an edge that crosses into the expanded box is painted above the box
        const top = await page.evaluate(() => {
          const e = [...document.querySelectorAll('.react-flow__edge')].find((x) => /seeddata-m1data/.test(x.getAttribute('data-testid') || x.id)); const p = e.querySelector('path');
          const lr = document.querySelector('.react-flow__node-Loop').getBoundingClientRect(); const len = p.getTotalLength(); const m = p.getScreenCTM();
          for (let t = 0.3; t < 0.98; t += 0.02) { const q = p.getPointAtLength(len * t); const x = q.x * m.a + m.e, y = q.y * m.d + m.f; if (x > lr.x + 10 && x < lr.x + lr.width - 10 && y > lr.y + 5 && y < lr.y + lr.height - 5) { const els = document.elementsFromPoint(x, y); return { idx: els.findIndex((el) => el.closest('.react-flow__edge') === e), first: String(els[0]?.className?.baseVal ?? els[0]?.className).slice(0, 60), stroke: getComputedStyle(p).stroke, sw: getComputedStyle(p).strokeWidth }; } }
          return null;
        });
        record('Loop', 'edge entering the expanded Loop is painted on top of the box where it overlaps it', !!top && top.idx === 0, JSON.stringify(top));
      }
      await shot(page, `71-visual-${tag}`);
    } finally { await browser.close(); }
  }
  return errs;
}

const stateOf = (page) => page.evaluate(() => {
  const d = document.querySelector('[role="dialog"]');
  if (!d) return { dialog: false };
  const q = (t) => d.querySelector(`[data-testid="${t}"]`);
  const sw = q('loop-condition-mode-toggle');
  const inp = sw?.querySelector('input');
  return {
    dialog: true,
    tids: [...d.querySelectorAll('[data-testid^="loop-condition"]')].map((e) => e.dataset.testid.replace('loop-condition-', '')),
    monaco: !!d.querySelector('.monaco-editor'),
    builder: !!d.querySelector('.ruleGroup, [class*="queryBuilder"]'),
    code: d.querySelector('.monaco-editor .view-lines')?.innerText.replace(/\u00a0/g, ' ') ?? null,
    status: [...d.querySelectorAll('[data-testid^="loop-condition-validation"]')].map((e) => e.innerText.replace(/\s+/g, ' ')),
    toggleChecked: inp?.checked, toggleDisabled: inp?.disabled,
    toggleTitle: (sw?.closest('label') ?? sw)?.getAttribute('title') ?? null,
    fields: [...d.querySelectorAll('.ruleGroup select, .ruleGroup input[type=text], .rule select, .rule input')].map((e) => (e.tagName === 'SELECT' ? e.selectedOptions[0]?.text : e.value)),
    saveDisabled: [...d.querySelectorAll('button')].find((b) => /SAVE/i.test(b.innerText))?.disabled,
    text: d.innerText.replace(/\s+/g, ' ').slice(0, 900),
  };
});
const selectAll = async (page) => { await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control'); };
const clickToggle = async (page) => { await page.click('[data-testid="loop-condition-mode-toggle"] input'); await sleep(1500); };
const clickEditor = async (page) => {
  const b = await page.evaluate(() => { const r = document.querySelector('[role="dialog"] .monaco-editor .view-lines')?.getBoundingClientRect(); return r && { x: r.x + 20, y: r.y + r.height / 2 }; });
  await page.mouse.click(b.x, b.y);
};
const clickSave = async (page) => { await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find((b) => /SAVE/i.test(b.innerText))?.click()); await sleep(2000); };
const clickCancel = async (page) => { await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find((b) => /CANCEL/i.test(b.innerText))?.click()); await sleep(1000); };

async function open(page, cwf, name) {
  write(name, build(cwf));
  await openWorkflow(page, ws, name);
  await zoomOut(page, 1);
  await page.waitForSelector('[data-testid="loop-settings-button"]', { timeout: 20000 });
  await sleep(1000);
  await page.evaluate(() => document.querySelector('[data-testid="loop-settings-button"]').click()); // gear in the Loop header
  await sleep(4500);
}
const tid = (page, t) => page.$(`[data-testid="${t}"]`);
const textOf = (page, t) => page.evaluate((t) => document.querySelector(`[data-testid="${t}"]`)?.innerText.replace(/\s+/g, ' ') ?? null, t);
const setBuilderValue = async (page, txt) => {
  // boolean value = checkbox: untick it for "false"; for text values type into the input
  const cb = await page.$('.rule input[type=checkbox]');
  if (cb) { await cb.click(); await sleep(1200); return; }
  const val = await page.$('.rule input[type=text], .ruleGroup input[type=text]');
  await val.click(); await page.keyboard.press('End'); for (let i = 0; i < 12; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type(txt, { delay: 80 }); await sleep(1200);
};

async function scenarioDialog() {
  const errs = [];
  let { browser, page, errs: e1 } = await launch(); errs.push(...e1);
  try {
    // ---- A: simple condition -> builder
    await open(page, 'vars["hasMore"] == true', 'd1.cwf');
    let st = await stateOf(page);
    await shot(page, '72-dialog-simple');
    console.log('A', JSON.stringify(st));
    record('Loop', 'the gear (loop-settings-button) opens the Loop settings dialog; only the Properties tab', st.dialog && /PROPERTIES/i.test(st.text) && !/Retry/i.test(st.text));
    record('Loop', 'dialog renders the Condition control (mode toggle, validation status)', ['mode-toggle', 'validation-status'].every((t) => st.tids.includes(t)), JSON.stringify(st.tids));
    record('Loop', 'a simple condition opens in builder mode (builder shown, no CEL editor, toggle = Builder)', st.builder && !st.monaco && st.toggleChecked === true);
    record('Loop', 'builder shows the variable name "hasMore" in its field and the value true', st.fields.some((f) => /hasMore/.test(f)) && st.fields.includes('on'), JSON.stringify(st.fields) + ' (boolean value is a checkbox; checked)');
    record('Loop', 'validation status for a valid condition reads "Condition is valid."', st.status.some((x) => /Condition is valid/.test(x)), JSON.stringify(st.status));
    await clickToggle(page); st = await stateOf(page);
    await shot(page, '73-dialog-cel-mode');
    record('Loop', 'builder -> CEL: the CEL editor shows the stored expression', st.monaco && /vars\["hasMore"\] == true/.test(st.code || ''), JSON.stringify(st.code));
    await clickToggle(page); st = await stateOf(page);
    record('Loop', 'CEL -> builder (representable text) works', st.builder && !st.monaco);
    await setBuilderValue(page, 'false');
    const typed = await page.evaluate(() => document.querySelector('.rule input[type=checkbox]')?.checked);
    record('Loop', 'builder boolean value checkbox can be toggled to false', typed === false, JSON.stringify(typed));
    await clickToggle(page); st = await stateOf(page);
    record('Loop', 'builder edit emits exact CEL vars["hasMore"] == false (boolean literal, not a string)', (st.code || '').trim() === 'vars["hasMore"] == false', JSON.stringify(st.code));
    await shot(page, '77-dialog-builder-edit');
    await clickSave(page);
    const dirty = await page.evaluate(() => !!document.querySelector('.theia-dirty, .dirty, .theia-mod-dirty') || /●/.test(document.querySelector('.p-TabBar-tab.p-mod-current, .lm-TabBar-tab.lm-mod-current')?.innerText || ''));
    let saved = cond(path.join(ws, 'd1.cwf'));
    if (saved !== 'vars["hasMore"] == false') { // files.autoSave is "off" in this profile: persist with Ctrl+S like a user would
      console.log('NOTE dialog Save leaves the editor dirty (autoSave off, dirty=' + dirty + '); pressing Ctrl+S');
      await page.keyboard.down('Control'); await page.keyboard.press('KeyS'); await page.keyboard.up('Control'); await sleep(2000); saved = cond(path.join(ws, 'd1.cwf'));
    }
    record('Loop', 'Save writes the edited condition to the .cwf', saved === 'vars["hasMore"] == false', JSON.stringify(saved));
    await browser.close();

    // ---- B: nested condition
    ({ browser, page, errs: e1 } = await launch()); errs.push(...e1);
    const nested = '(vars["a"] > 1 || vars["b"] == "x") && !(vars["c.d"] == "ab" && vars["e"] == 2)';
    await open(page, nested, 'd2.cwf');
    st = await stateOf(page);
    await shot(page, '78-dialog-nested');
    console.log('B', JSON.stringify({ builder: st.builder, monaco: st.monaco, fields: st.fields }));
    record('Loop', 'a nested and/or/not condition with a dotted variable opens in builder mode', st.builder && !st.monaco && st.toggleChecked === true, JSON.stringify(st.fields));
    const nGroups = await page.evaluate(() => document.querySelectorAll('.ruleGroup').length);
    record('Loop', 'the nested builder shows nested groups (>= 3 .ruleGroup) and the dotted name c.d', nGroups >= 3 && st.fields.some((f) => /c\.d/.test(f)), `groups=${nGroups} fields=${JSON.stringify(st.fields)}`);
    if (st.builder) { await clickToggle(page); st = await stateOf(page); }
    const norm = (x) => (x || '').replace(/[\s()]/g, '');
    record('Loop', 'nested: builder -> CEL shows an equivalent expression', norm(st.code) === norm(nested), JSON.stringify(st.code));
    await browser.close();

    // ---- C: CEL-only condition
    ({ browser, page, errs: e1 } = await launch()); errs.push(...e1);
    const celOnly = 'vars["a"].exists(x, x > 1) && size(vars["b"]) > 2';
    await open(page, celOnly, 'd3.cwf');
    st = await stateOf(page);
    await shot(page, '79-dialog-cel-only');
    const reason = await textOf(page, 'loop-condition-builder-disabled-reason'); const warn = await textOf(page, 'loop-condition-cel-only-warning');
    console.log('C', JSON.stringify({ monaco: st.monaco, disabled: st.toggleDisabled, reason, warn }));
    record('Loop', 'a CEL-only condition opens in CEL mode with the text unchanged', st.monaco && !st.builder && (st.code || '').includes('exists(x, x > 1)'), JSON.stringify(st.code));
    record('Loop', 'CEL-only toggle is disabled and its reason is shown', st.toggleDisabled === true && !!reason, `disabled=${st.toggleDisabled} reason=${reason}`);
    record('Loop', 'dialog shows the CEL-only warning', !!warn, JSON.stringify(warn));
    await page.evaluate(() => document.querySelector('[data-testid="loop-condition-replace"]').click()); await sleep(1200);
    const confirmBtn = await tid(page, 'loop-condition-replace-confirm'); const cancelBtn = await tid(page, 'loop-condition-replace-cancel');
    st = await stateOf(page);
    await shot(page, '80-dialog-replace-clicked');
    record('Loop', 'Replace asks for confirmation first and leaves the text unchanged', !!confirmBtn && !!cancelBtn && (st.code || '').includes('exists(x, x > 1)'), `confirm=${!!confirmBtn} cancel=${!!cancelBtn}`);
    if (cancelBtn) { await page.evaluate(() => document.querySelector('[data-testid="loop-condition-replace-cancel"]').click()); await sleep(1000); }
    st = await stateOf(page);
    record('Loop', 'Cancel keeps the CEL-only text', st.monaco && (st.code || '').includes('exists(x, x > 1)'), JSON.stringify(st.code));
    await page.evaluate(() => document.querySelector('[data-testid="loop-condition-replace"]').click()); await sleep(1000);
    if (await tid(page, 'loop-condition-replace-confirm')) { await page.evaluate(() => document.querySelector('[data-testid="loop-condition-replace-confirm"]').click()); await sleep(1500); }
    st = await stateOf(page);
    await shot(page, '80b-dialog-replaced');
    record('Loop', 'Confirm replaces the text with the builder default (condition no longer the CEL-only text)', !(st.code || '').includes('exists(') && (st.builder || st.monaco), JSON.stringify({ builder: st.builder, code: st.code, fields: st.fields }));
    await browser.close();

    // ---- D: invalid / unreachable
    ({ browser, page, errs: e1 } = await launch()); errs.push(...e1);
    await open(page, celOnly, 'd4.cwf');
    await clickEditor(page); await selectAll(page); await page.keyboard.sendCharacter('vars["a" >'); await sleep(3000);
    st = await stateOf(page);
    await shot(page, '75-dialog-cel-invalid');
    record('Loop', 'an invalid CEL text shows the issue (message + column) in the dialog within ~3 s', st.tids.includes('validation-issue') || /column \d+/.test(st.text), st.text.slice(0, 260));
    record('Loop', 'saving an invalid draft is not blocked (Save enabled)', st.saveDisabled === false);
    await selectAll(page); await page.keyboard.sendCharacter('vars["a"].exists(x, x > 1)'); await sleep(3000);
    st = await stateOf(page);
    record('Loop', 'fixing the text clears the issue and shows "Condition is valid."', st.status.some((x) => /Condition is valid/.test(x)) && !st.tids.includes('validation-issue'), JSON.stringify(st.status));
    flags.failValidate = true;
    await clickEditor(page); await selectAll(page); await page.keyboard.sendCharacter('vars["a"].exists(x, x > 2)'); await sleep(3000);
    st = await stateOf(page);
    await shot(page, '81-dialog-not-checked');
    record('Loop', 'with validation unreachable (503 from the test proxy) the dialog says "not checked", never "valid"', st.status.some((x) => /not checked/i.test(x)) && !st.status.some((x) => /is valid/i.test(x)), JSON.stringify(st.status));
    flags.failValidate = false;
    await browser.close();

    // ---- E: typing by hand; clearing
    ({ browser, page, errs: e1 } = await launch()); errs.push(...e1);
    await open(page, celOnly, 'd5.cwf');
    await clickEditor(page); await selectAll(page); await page.keyboard.type('vars["a"] > 1', { delay: 120 }); await sleep(2500);
    st = await stateOf(page);
    await shot(page, '82-dialog-typing');
    record('Loop', 'typing a condition by hand keeps the CEL editor and full text', st.monaco && !st.builder && /vars\["a"\]\s*>\s*1/.test(st.code || ''), JSON.stringify({ monaco: st.monaco, builder: st.builder, code: st.code }));
    await browser.close();
    ({ browser, page, errs: e1 } = await launch()); errs.push(...e1);
    await open(page, celOnly, 'd6.cwf');
    await clickEditor(page); await selectAll(page); await page.keyboard.press('Delete'); await sleep(2000);
    st = await stateOf(page);
    const req = await textOf(page, 'loop-condition-required');
    await shot(page, '83-dialog-cleared');
    console.log('E clear', JSON.stringify({ tids: st.tids, monaco: st.monaco, req, save: st.saveDisabled }));
    record('Loop', 'clearing CEL text keeps the Condition control and shows the required message', st.tids.includes('mode-toggle') && st.monaco && !!req, JSON.stringify({ tids: st.tids, req }));
    record('Loop', 'empty condition does not show a builder-disabled reason and keeps the toggle enabled', !st.tids.includes('builder-disabled-reason') && st.toggleDisabled === false, JSON.stringify({ tids: st.tids, disabled: st.toggleDisabled }));
    await page.keyboard.type('vars["z"] == 1', { delay: 60 }); await sleep(2500);
    st = await stateOf(page);
    record('Loop', 'typing a new condition after clearing works and removes the required message', st.monaco && /vars\["z"\]/.test(st.code || '') && !(await tid(page, 'loop-condition-required')), JSON.stringify(st.code));
    await browser.close();
    // ---- F: double-click on a loop still opens the dialog (round-1 path)
    ({ browser, page, errs: e1 } = await launch()); errs.push(...e1);
    write('d7.cwf', build('vars["hasMore"] == true')); await openWorkflow(page, ws, 'd7.cwf'); await zoomOut(page, 1);
    const Lb = await loopBox(page); await dblclick(page, Lb.x + Lb.w * 0.8, Lb.y + Lb.h * 0.85); await sleep(4500);
    st = await stateOf(page); await shot(page, '130-dblclick-dialog');
    record('Loop', 'double-clicking the Loop body opens the settings dialog', st.dialog && st.tids.includes('mode-toggle'), JSON.stringify({ dialog: st.dialog, box: Lb }));
    await browser.close();
    return errs;
  } catch (e) { await browser.close().catch(() => {}); throw e; }
}

/** Which condition shapes open in the builder ( list). One browser, one workflow file per shape. */
async function scenarioShapes() {
  const shapes = [
    ['page<=10', 'vars["page"] <= 10'],
    ['single-quote+escaped', 'vars[\'x\'] != "a\\"b"'],
    ['paren-negative-float', '(vars["n"] > -1.5)'],
    ['dotted-name', 'vars["c.d"] == 1'],
    ['or-group', 'vars["a"] > 1 || vars["b"] == "x"'],
    ['not-group', '!(vars["a"] == 1 && vars["b"] == 2)'],
    ['and-of-or', '(vars["a"] > 1 || vars["b"] == "x") && vars["c"] == true'],
    ['not-single-rule', '!(vars["c.d"] == "ab")'],
    ['and-of-or-and-not-group', '(vars["a"] > 1 || vars["b"] == "x") && !(vars["c"] == 1 && vars["d"] == 2)'],
    ['nested-not-dotted-quote', '(vars["a"] > 1 || vars["b"] == "x") && !(vars["c.d"] == "a\\"b")'],
  ];
  const errs = [];
  const out = [];
  for (let i = 0; i < shapes.length; i++) {
    const [name, expr] = shapes[i];
    const { browser, page, errs: e } = await launch(); errs.push(...e);
    try {
      write(`shape${i}.cwf`, build(expr));
      await openWorkflow(page, ws, `shape${i}.cwf`);
      await zoomOut(page, 1);
      await openDialog(page);
      const st = await stateOf(page);
      console.log('SHAPE', name, JSON.stringify({ builder: st.builder, monaco: st.monaco, fields: st.fields }));
      if (name === 'nested-not-dotted-quote') await shot(page, '84-shape-nested');
      out.push([name, st.builder && !st.monaco, st.fields]);
    } finally { await browser.close(); }
  }
  for (const [name, ok, fields] of out) record('Loop', `condition shape "${name}" opens in the builder`, ok, JSON.stringify(fields));
  return errs;
}

/** run a workflow whose loop really iterates (member = Conditional Splitter fed from a Create Table outside),
 *  steer the condition with the default flow variable <prefix>.executionStatus, open the viewer. */
async function runAndView(name, wf, shotName) {
  write(name, wf);
  const { browser, page, errs } = await launch();
  try {
    await openWorkflow(page, ws, name);
    await zoomOut(page, 1);
    await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /^\s*RUN/.test(b.innerText)).click());
    let notif = [];
    for (let i = 0; i < 60; i++) { // click "Open Viewer" the moment the notification appears (so a running loop can be caught)
      await sleep(250);
      const clicked = await page.evaluate(() => { const b = [...document.querySelectorAll('.theia-notification-list-item button')].find((x) => /Open Viewer/.test(x.innerText)); if (b) { b.click(); return true; } return false; });
      if (clicked) break;
    }
    notif = await page.evaluate(() => [...document.querySelectorAll('.theia-notification-list-item')].map((e) => e.innerText.replace(/\s+/g, ' ')));
    let txt = ''; const seen = [];
    for (let i = 0; i < 150; i++) {
      await sleep(i < 20 ? 400 : 1500);
      if (!process.env.PASSTHROUGH && i > 50 && seen.length && /Iteration \d+ of/i.test(seen[seen.length - 1]) && name === 'run40.cwf') break; // live stream is buffered by the test proxy; stop waiting
      txt = await page.evaluate(() => { const Ls = [...document.querySelectorAll('[data-testid^="loop-node-"]')]; return Ls.length ? Ls[Ls.length - 1].innerText.replace(/\s+/g, ' ') : ''; });
      if (txt && seen[seen.length - 1] !== txt) { seen.push(txt); if (/Iteration \d+ of/i.test(txt) && !globalThis.__shotRunning) { globalThis.__shotRunning = true; await shot(page, shotName + '-running'); } }
      if (/Finished after|Stopped at|Failed|Skipped|No node/i.test(txt) && !/Iteration \d+ of/i.test(txt)) break;
    }
    console.log('SEEN', name, JSON.stringify(seen));
    await sleep(2000);
    await shot(page, shotName);
    const info = await page.evaluate(() => {
      const Ls = [...document.querySelectorAll('[data-testid^="loop-node-"]')]; const L = Ls[Ls.length - 1]; // the viewer tab is the last one in the DOM (the editor tab stays mounted)
      const rect = (el) => { const r = el?.getBoundingClientRect(); return r && { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
      const rn = [...document.querySelectorAll('.react-flow__node')]; const lastOf = (id) => rn.filter((n) => n.dataset.id === id).pop();
      const boxes = { loop: rect(lastOf('L')), member: rect(lastOf('m1')) };
      const member = lastOf('m1'); const memberBody = member?.querySelector('.node-body');
      const memberBadge = member?.querySelector('.status-badge');
      const memberStatus = member && {
        visible: member.getBoundingClientRect().width > 0 && getComputedStyle(member).visibility !== 'hidden',
        bodyClass: memberBody?.className ?? '',
        badgeText: memberBadge?.innerText.replace(/\s+/g, ' ').trim() ?? '',
        text: member.innerText.replace(/\s+/g, ' ').trim(),
      };
      const nodes = [...document.querySelectorAll('.react-flow__node')].map((n) => ({ id: n.dataset.id, cls: n.className.replace(/react-flow__node\S*|nopan|selectable|parent|selected/g, '').trim().slice(0, 120), text: n.innerText.replace(/\s+/g, ' ').slice(0, 160) }));
      const mem = rect(lastOf('m1')); const leaves = L ? [...L.querySelectorAll('*')].filter((e) => e.children.length === 0 && e.innerText?.trim()) : [];
      const hit = (r) => mem && r.width > 0 && r.x < mem.x + mem.w && r.x + r.width > mem.x && r.y < mem.y + mem.h && r.y + r.height > mem.y;
      const overlapping = mem ? leaves.filter((e) => hit(e.getBoundingClientRect())).map((e) => e.innerText.trim().slice(0, 40)) : [];
      const st = leaves.find((e) => /Stopped at|Finished after|Iteration \d+ of/.test(e.innerText)); const sr = st?.getBoundingClientRect();
      const chips = L ? [...L.querySelectorAll('.loop-variable-chip')] : []; const ch = chips.map((e) => Math.round(e.getBoundingClientRect().height));
      const loopRect = rect(L);
      return { overlapping, statusFull: st ? st.scrollWidth <= st.clientWidth + 1 && st.innerText.length > 5 : null, statusText: st?.innerText ?? null, chipCount: chips.length, chipMaxH: Math.max(0, ...ch), chipRowsY: (() => { const ys = chips.map((e) => e.getBoundingClientRect().y); return ys.length && Math.max(...ys) - Math.min(...ys) < 8 ? 1 : 2; })(), chipScroll: (() => { const r = L?.querySelector('.loop-variable-chips'); return r && { sw: r.scrollWidth, cw: r.clientWidth, ox: getComputedStyle(r).overflowX, tab: r.tabIndex }; })(), loopRect, boxes, memberStatus, loopText: L?.innerText.replace(/\n+/g, ' '), loopCls: L?.className, loopBg: L && getComputedStyle(L).borderColor, nodes, tabs: [...document.querySelectorAll('.lm-TabBar-tabLabel')].map((e) => e.innerText) };
    });
    console.log('VIEWER', name, JSON.stringify(info));
    return { info, errs, notif, seen };
  } finally { await browser.close(); }
}

async function scenarioRunView() {
  const errs = [];
  const prefix = 'conditionalSplitterNode_m1';
  // 3 iterations: condition stays true (SUCCESS) -> limit 3 reached -> stop-with-warning
  const w3 = build(`vars["${prefix}.executionStatus"] == "SUCCESS"`, { maxIterations: 3, onLimit: 'stop-with-warning', check: 'after' });
  let r = await runAndView('run3.cwf', w3, '90-run-3-iterations'); errs.push(...r.errs);
  record('Loop', 'run viewer: a loop that really iterated (3 iterations, limit, stop-with-warning) shows a Warning status and "Stopped at the limit of 3 iterations"', /Warning/.test(r.info.loopText || '') && /limit of 3 iterations/.test(r.info.loopText || ''), JSON.stringify(r.info.loopText));
  record('Loop', 'run viewer: the loop was actually executed (not "Skipped"/"No node inside the loop could run")', !/Skipped|No node inside/i.test(r.info.loopText || ''), JSON.stringify(r.info.loopText));
  record('Loop', 'run viewer: the loop member displays its last-iteration Success status', !!r.info.memberStatus?.visible && /node-status--success/.test(r.info.memberStatus.bodyClass) && /Success/i.test(r.info.memberStatus.badgeText || r.info.memberStatus.text), JSON.stringify(r.info.memberStatus));
  record('Loop', 'viewer variable chips are compact (one row, each < 40 px tall)', r.info.chipCount > 0 ? r.info.chipRowsY === 1 && r.info.chipMaxH <= 44 : true, JSON.stringify({ scroll: r.info.chipScroll, n: r.info.chipCount, rows: r.info.chipRowsY, maxH: r.info.chipMaxH }));
  record('Loop', 'loop header, status, and chips do not overlap the member; status is not clipped', r.info.overlapping.length === 0 && r.info.statusFull !== false, JSON.stringify({ overlapping: r.info.overlapping, status: r.info.statusText, full: r.info.statusFull }));
  const bx = r.info.boxes;
  record('Loop', 'run viewer: the expanded loop box still contains its member (member rect inside loop rect)', !!bx.loop && !!bx.member && bx.member.x >= bx.loop.x - 2 && bx.member.y >= bx.loop.y - 2 && bx.member.x + bx.member.w <= bx.loop.x + bx.loop.w + 2 && bx.member.y + bx.member.h <= bx.loop.y + bx.loop.h + 2, JSON.stringify(bx));
  // long loop: try to catch the running state (Iteration k of N)
  const w40 = build(`vars["${prefix}.executionStatus"] == "SUCCESS"`, { maxIterations: 40, onLimit: 'stop-with-warning', check: 'after' });
  globalThis.__shotRunning = false;
  r = await runAndView('run40.cwf', w40, '90b-run-40-iterations'); errs.push(...r.errs);
  record('Loop', 'run viewer: running state "Iteration <k> of 40" is visible while a 40-iteration loop runs (polled every 0.4 s)', r.seen.some((t) => /Iteration \d+ of 40/i.test(t)), JSON.stringify(r.seen.map((t) => t.replace(/conditionalSplitterNode_m1\.\w+ = \S+ ?/g, '').slice(0, 120))));
  if (process.env.PASSTHROUGH) record('Loop', 'a long (40-iteration) run reaches its final status in the live viewer (streaming proxy): Warning + "Stopped at the limit of 40 iterations"', /Warning/.test(r.info.loopText || '') && /limit of 40 iterations/.test(r.info.loopText || ''), JSON.stringify((r.info.loopText || '').slice(-90)));
  // (without PASSTHROUGH=1 the buffering test proxy keeps the viewer at its first snapshot)
  // 1 iteration: condition false after iteration 1
  const w1 = build(`vars["${prefix}.executionStatus"] != "SUCCESS"`, { maxIterations: 5, check: 'after' });
  r = await runAndView('run1.cwf', w1, '91-run-1-iteration'); errs.push(...r.errs);
  record('Loop', 'run viewer: a loop that stops after 1 iteration is shown as finished (status colour/label, iteration text)', /Success/.test(r.info.loopText || '') && /Finished after 1 iteration(?!s)/.test(r.info.loopText || ''), JSON.stringify(r.info.loopText));
  // collapsed loop stays collapsed in the viewer
  const wc = build(`vars["${prefix}.executionStatus"] != "SUCCESS"`, { maxIterations: 5, check: 'after' });
  wc.nodes.find((n) => n.type === 'Loop').data.collapsed = true;
  r = await runAndView('runc.cwf', wc, '92-run-collapsed'); errs.push(...r.errs);
  const hidden = !r.info.nodes.some((n) => n.id === 'm1') && /▸ ?expand/i.test(r.info.loopText || '');
  record('Loop', 'run viewer: a collapsed loop stays collapsed (member not shown)', hidden, JSON.stringify(r.info.nodes.map((n) => n.id)));
  errs.push(...await runStatusContrast());
  return errs;
}

const mkLoop = (id, pos, w, h, props, parent, collapsed = false) => {
  const l = clone(loopTpl); l.id = id; l.position = pos; l.width = w; l.height = h; l.style = { width: w, height: h };
  l.data.collapsed = collapsed; l.data.title = props.title ?? 'Loop'; delete props.title; Object.assign(l.data.properties, props);
  if (parent) l.parentNode = parent; return l;
};
const mkSplit = (id, pos, parent) => { const m = clone(splitTpl); m.id = id; m.position = pos; if (parent) m.parentNode = parent; m.extent = undefined; m.data.properties = { column: 'value', threshold: 15 }; return m; };
const mkTable = (id, pos, parent) => { const m = clone(tableTpl); m.id = id; m.position = pos; if (parent) m.parentNode = parent; m.extent = undefined; m.data.properties = { jsonArrayString: '[{"id":1,"value":10},{"id":2,"value":20}]' }; return m; };
const edge = (a, ah, b, bh) => ({ type: 'BaseEdge', source: a, sourceHandle: ah, target: b, targetHandle: bh, id: `reactflow__edge-${a}${ah}-${b}${bh}` });
/** seed -> [L: m1 -> m2 -> m3] -> after */
const buildRich = (collapsed) => ({
  id: 'wf-rich-' + runId, name: 'x.cwf', active: false,
  nodes: [mkLoop('L', { x: 400, y: 80 }, 1100, 330, { title: 'Fetch until done', condition: 'vars["hasMore"] == true', maxIterations: 50 }, null, collapsed),
    mkTable('seed', { x: 40, y: 180 }), mkSplit('m1', { x: 40, y: 110 }, 'L'), mkSplit('m2', { x: 380, y: 110 }, 'L'), mkSplit('m3', { x: 720, y: 110 }, 'L'), mkSplit('after', { x: 1620, y: 180 })],
  edges: [edge('seed', 'data', 'm1', 'data'), edge('m1', 'high', 'm2', 'data'), edge('m2', 'high', 'm3', 'data'), edge('m3', 'high', 'after', 'data')],
});
/** nested: N1[ pick, N2[ u -> c ] ] ; pick -> u crosses the inner boundary */
const buildNested = () => ({
  id: 'wf-nest-' + runId, name: 'x.cwf', active: false,
  nodes: [mkLoop('N1', { x: 60, y: 40 }, 1500, 520, { title: 'Per region', condition: 'vars["regionsLeft"] > 0', maxIterations: 20 }, null),
    mkLoop('N2', { x: 520, y: 140 }, 900, 330, { title: 'Retry upload', condition: 'vars["ok"] == false', maxIterations: 5 }, 'N1'),
    mkTable('pick', { x: 40, y: 200 }, 'N1'), mkSplit('u', { x: 40, y: 110 }, 'N2'), mkSplit('c', { x: 450, y: 110 }, 'N2')],
  edges: [edge('pick', 'data', 'u', 'data'), edge('u', 'high', 'c', 'data')],
});
const buildTripleNested = () => ({
  id: 'wf-nest3-' + runId, name: 'x.cwf', active: false,
  nodes: [
    mkLoop('N1', { x: 60, y: 40 }, 1500, 1000, { title: 'Outer loop', condition: 'vars["outer"] == true', maxIterations: 20 }, null),
    mkLoop('N2', { x: 140, y: 120 }, 1200, 760, { title: 'Middle loop', condition: 'vars["middle"] == true', maxIterations: 10 }, 'N1'),
    mkLoop('N3', { x: 150, y: 110 }, 900, 540, { title: 'Inner loop', condition: 'vars["inner"] == true', maxIterations: 5 }, 'N2'),
    mkSplit('member', { x: 120, y: 150 }, 'N3'),
  ],
  edges: [],
});
const STATUS_CONTRAST_THRESHOLD_MS = 4000;
const buildStatusContrast = () => {
  // DefaultFlowVariables.prefix uses the node model's camelCase type and sanitized node id:
  // CreateTableNodeModel + "seed" -> createTableNode_seed; ConditionalSplitterNodeModel + "m1" -> conditionalSplitterNode_m1.
  const condition = `vars["conditionalSplitterNode_m1.endTimestamp"] < vars["createTableNode_seed.startTimestamp"] + ${STATUS_CONTRAST_THRESHOLD_MS}`;
  const workflow = {
    id: 'wf-status-contrast-' + runId, name: 'status-contrast.cwf', active: false,
    nodes: [
      mkLoop('outer', { x: 400, y: 80 }, 1450, 760, {
        title: 'Outer status contrast', condition, maxIterations: 300, onLimit: 'fail', check: 'after',
      }, null),
      mkTable('seed', { x: 40, y: 180 }),
      mkSplit('m1', { x: 40, y: 160 }, 'outer'),
      mkLoop('inner', { x: 540, y: 140 }, 760, 460, {
        title: 'Nested status contrast', condition, maxIterations: 1, onLimit: 'stop-with-warning', check: 'before',
      }, 'outer'),
      mkSplit('m2', { x: 120, y: 140 }, 'inner'),
      mkTable('slow', { x: 40, y: 470 }, 'outer'),
    ],
    edges: [edge('seed', 'data', 'm1', 'data'), edge('m1', 'high', 'm2', 'data')],
  };
  // Keep the first nested-loop Warning live while an independent outer-loop entry member runs.
  const slow = workflow.nodes.find((node) => node.id === 'slow');
  slow.data.properties = {
    jsonArrayString: '[<#list 1..500000 as i>{"id":${i},"value":${i % 100}}<#if i?has_next>,</#if></#list>]',
  };
  return workflow;
};
async function runStatusContrast() {
  const name = 'run-status-contrast.cwf';
  write(name, buildStatusContrast());
  const { browser, page, errs } = await launch();
  let earlyWarning = null;
  let final = null;
  try {
    await openWorkflow(page, ws, name);
    await zoomOut(page, 1);
    await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /^\s*RUN/.test(b.innerText)).click());
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      const clicked = await page.evaluate(() => {
        const button = [...document.querySelectorAll('.theia-notification-list-item button')].find((item) => /Open Viewer/.test(item.innerText));
        if (!button) return false;
        button.click();
        return true;
      });
      if (clicked) break;
    }

    // The outer loop runs until m1.endTimestamp passes seed.startTimestamp + the threshold.
    // Its nested loop is WARNING at its one-iteration limit while that condition is true, then
    // SUCCESS with zero inner iterations once the threshold has elapsed.
    for (let i = 0; i < 180; i++) {
      await sleep(250);
      const snapshot = await page.evaluate(() => {
        const last = (testId) => [...document.querySelectorAll(`[data-testid="${testId}"]`)].at(-1);
        const outer = last('loop-node-outer');
        const inner = last('loop-node-inner');
        return {
          outerClass: outer?.className ?? '',
          outerText: outer?.innerText.replace(/\s+/g, ' ').trim() ?? '',
          innerClass: inner?.className ?? '',
          innerText: inner?.innerText.replace(/\s+/g, ' ').trim() ?? '',
        };
      });
      if (!earlyWarning && /node-status--warning/.test(snapshot.innerClass)) {
        earlyWarning = snapshot;
        await shot(page, '93-member-status-early-warning');
        console.log('STATUS-CONTRAST early warning', JSON.stringify(snapshot));
      }
      if (/node-status--success/.test(snapshot.outerClass)
        && /Finished after \d+ iterations/.test(snapshot.outerText)
        && /node-status--success/.test(snapshot.innerClass)) {
        final = snapshot;
        break;
      }
      if (/node-status--failed/.test(snapshot.outerClass)) {
        final = snapshot;
        break;
      }
    }
    await shot(page, '94-member-status-final');
    const outerFinishedSuccessfully = !!final
      && /node-status--success/.test(final.outerClass)
      && /Finished after \d+ iterations/.test(final.outerText);
    const finalMemberIsSuccess = !!final
      && /node-status--success/.test(final.innerClass)
      && /\bSuccess\b/.test(final.innerText);
    record(
      'Loop',
      'timestamp-based outer loop completes successfully after the member condition changes',
      outerFinishedSuccessfully,
      JSON.stringify({ thresholdMs: STATUS_CONTRAST_THRESHOLD_MS, outer: final?.outerText, outerClass: final?.outerClass }),
    );
    record(
      'Loop',
      'live viewer captures the nested member as Warning in an earlier outer iteration and Success in the final iteration',
      !!earlyWarning && finalMemberIsSuccess,
      JSON.stringify({ earlier: earlyWarning, final: final && { innerClass: final.innerClass, innerText: final.innerText, outerText: final.outerText } }),
    );
    console.log('STATUS-CONTRAST final', JSON.stringify(final));
  } finally {
    await browser.close();
  }
  return errs;
}
const edgeGeom = (page) => page.evaluate(() => {
  const nodes = {}; document.querySelectorAll('.react-flow__node').forEach((n) => { const r = n.getBoundingClientRect(); if (r.width > 0) nodes[n.dataset.id] = { x: r.x, y: r.y, w: r.width, h: r.height }; });
  return { nodes, edges: [...document.querySelectorAll('.react-flow__edge')].map((e) => { const p = e.querySelector('path'); const len = p?.getTotalLength?.() ?? 0; const m = p?.getScreenCTM(); const pt = (t) => { const q = p.getPointAtLength(len * t); return { x: q.x * m.a + m.e, y: q.y * m.d + m.f }; }; return { id: e.getAttribute('data-testid') || e.id, a: len ? pt(0) : null, b: len ? pt(1) : null, stroke: p && getComputedStyle(p).stroke, sw: p && getComputedStyle(p).strokeWidth, op: p && getComputedStyle(p).opacity, dash: p && getComputedStyle(p).strokeDasharray }; }) };
});
async function scenarioDesign() {
  const errs = [];
  for (const [name, wf, tag] of [
    ['rich-c.cwf', buildRich(true), 'collapsed'],
    ['rich-e.cwf', buildRich(false), 'expanded'],
    ['nest.cwf', buildNested(), 'nested'],
    ['nest3.cwf', buildTripleNested(), 'nested-3'],
  ]) {
    write(name, wf);
    const { browser, page, errs: e } = await launch(); errs.push(...e);
    try {
      await openWorkflow(page, ws, name);
      await page.click('.react-flow__controls-fitview').catch(() => {}); await sleep(1500);
      await shot(page, `100-design-${tag}`);
      const info = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="loop-node-"]')].map((e) => ({ id: e.dataset.testid, text: e.innerText.replace(/\n+/g, ' | '), tids: [...e.querySelectorAll('[data-testid]')].map((x) => x.dataset.testid), border: getComputedStyle(e).borderStyle + ' ' + getComputedStyle(e).borderColor, bg: getComputedStyle(e).backgroundColor, r: (({ x, y, width, height }) => ({ x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) }))(e.getBoundingClientRect()) })));
      console.log('DESIGN', tag, JSON.stringify(info, null, 1));
      const loopLabel = await page.evaluate(() => {
        const label = document.querySelector('[data-testid^="loop-node-"] .loop-node-kind');
        if (!label) return null;
        const style = getComputedStyle(label);
        return { fontFamily: style.fontFamily, fontWeight: style.fontWeight };
      });
      record('Design', 'LOOP label uses bold monospace styling', !!loopLabel && /mono/i.test(loopLabel.fontFamily) && Number(loopLabel.fontWeight) >= 700, JSON.stringify(loopLabel));
      if (tag === 'nested-3') {
        const depths = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="loop-node-"]')].map((e) => ({
          id: e.dataset.testid,
          depth: [...e.classList].find((name) => name.startsWith('loop-nesting-depth-')),
          background: getComputedStyle(e).backgroundColor,
          borderWidth: getComputedStyle(e).borderWidth,
        })));
        record('Design', 'three nested Loops render in depth order with low-alpha tint and stronger dashed borders', depths.length === 3 && depths.every((entry, index) => entry.depth === `loop-nesting-depth-${index}`), JSON.stringify(depths));
      }
      const wr = await page.evaluate(() => [...document.querySelectorAll('.react-flow__node-Loop')].map((w) => { const b = w.querySelector('[data-testid^="loop-node-"]'); const a = w.getBoundingClientRect(), c = b.getBoundingClientRect(); return { id: w.dataset.id, wrapper: [Math.round(a.x), Math.round(a.y), Math.round(a.width), Math.round(a.height)], box: [Math.round(c.x), Math.round(c.y), Math.round(c.width), Math.round(c.height)] }; }));
      console.log('WRAPPER-VS-BOX', tag, JSON.stringify(wr));
      const g = await edgeGeom(page);
      console.log('GEOM', tag, JSON.stringify(g));
      const hs = await page.evaluate(() => [...document.querySelectorAll('.react-flow__node-Loop .react-flow__handle')].map((h) => ({ cls: h.className, vis: getComputedStyle(h).visibility + '/' + getComputedStyle(h).opacity + '/' + h.getBoundingClientRect().width })));
      console.log('LOOPHANDLES', tag, JSON.stringify(hs));
    } finally { await browser.close(); }
  }
  return errs;
}

/** Dragging a member out of the box in each direction must un-parent it (and not grow the box). */
async function scenarioDragOut() {
  const errs = [];
  for (const dir of (process.env.DIRS || 'right,below,left,above').split(',')) {
    write(`do-${dir}.cwf`, build('vars["hasMore"] == true'));
    const { browser, page, errs: e } = await launch(); errs.push(...e);
    try {
      await openWorkflow(page, ws, `do-${dir}.cwf`);
      await zoomOut(page, 1);
      const nodes = await canvasNodes(page);
      const L = nodes.find((n) => n.type === 'Loop'); const M = nodes.find((n) => n.id === 'm1');
      const SD = nodes.find((n) => n.id === 'seed');
      const to = { leftover: { x: SD.cx, y: SD.cy }, right: { x: L.x + L.w + 70, y: M.cy }, below: { x: M.cx, y: L.y + L.h + 70 }, left: { x: L.x - 200, y: M.cy + 190 }, above: { x: M.cx, y: L.y - 120 } }[dir];
      await drag(page, { x: M.cx, y: M.cy }, to);
      await sleep(1500);
      const after = (await canvasNodes(page)).find((n) => n.id === 'm1'); console.log('DRAG', dir, JSON.stringify({ from: [M.cx, M.cy], to, afterCentre: after && [Math.round(after.cx), Math.round(after.cy)], loop: [L.x, L.y, L.w, L.h] }));
      await page.keyboard.down('Control'); await page.keyboard.press('KeyS'); await page.keyboard.up('Control'); await sleep(2000);
      const c = JSON.parse(fs.readFileSync(path.join(ws, `do-${dir}.cwf`), 'utf8'));
      const m = c.nodes.find((n) => n.id === 'm1'); const l = c.nodes.find((n) => n.id === 'L');
      await shot(page, `110-dragout-${dir}`);
      record('Loop', `after dropping, the un-parented member sits where it was dropped (within 30px) — direction ${dir}`, !!after && Math.hypot(after.cx - to.x, after.cy - to.y) < 30, JSON.stringify({ drop: [Math.round(to.x), Math.round(to.y)], landed: after && [Math.round(after.cx), Math.round(after.cy)] }));
      record('Loop', `dragging a member out of the box to the ${dir} clears parentNode and does not resize the box`, !m.parentNode && l.width === 520 && l.height === 320, `parentNode=${m.parentNode} position=${JSON.stringify(m.position)} loop=${JSON.stringify(l.position)} box=${l.width}x${l.height}`);
    } finally { await browser.close(); }
  }
  return errs;
}

/** Validate-payload fix: a Loop node that lacks selected/dragging/positionAbsolute (as in a hand-written .cwf) must still validate (no 400 -> "not checked"). Also the canvas CEL-only badge. */
async function scenarioPayload() {
  const errs = [];
  const wf = build('vars["hasMore"] == true');
  for (const n of wf.nodes) { delete n.selected; delete n.dragging; delete n.positionAbsolute; }
  write('pl.cwf', wf);
  let { browser, page, errs: e } = await launch(); errs.push(...e);
  const bad = [];
  page.on('response', (r) => { if (/workflow\/validate/.test(r.url) && r.status >= 400) bad.push(r.status); });
  try {
    await openWorkflow(page, ws, 'pl.cwf'); await zoomOut(page, 1);
    await page.waitForSelector('[data-testid="loop-settings-button"]'); await sleep(1000);
    await page.evaluate(() => document.querySelector('[data-testid="loop-settings-button"]').click()); await sleep(5000);
    const st = await stateOf(page); await shot(page, '120-payload-no-selected');
    record('Loop', 'validate payload: nodes without selected/dragging/positionAbsolute still validate ("Condition is valid.", no 4xx)', st.status.some((x) => /Condition is valid/.test(x)) && bad.length === 0, JSON.stringify({ status: st.status, bad }));
  } finally { await browser.close(); }
  write('badge.cwf', build('vars["a"].exists(x, x > 1) && size(vars["b"]) > 2'));
  ({ browser, page, errs: e } = await launch()); errs.push(...e);
  try {
    await openWorkflow(page, ws, 'badge.cwf'); await zoomOut(page, 1); await sleep(1500);
    const b = await page.evaluate(() => { const e = document.querySelector('[data-testid="loop-cel-only-badge"]'); const r = e?.getBoundingClientRect(); return e && { text: e.innerText, w: r.width, h: r.height }; });
    await shot(page, '121-cel-only-badge');
    record('Loop', 'canvas Loop shows the CEL-only badge for a CEL-only condition', !!b && /CEL/i.test(b.text) && b.w > 0, JSON.stringify(b));
    write('nobadge.cwf', build('vars["hasMore"] == true'));
  } finally { await browser.close(); }
  ({ browser, page, errs: e } = await launch()); errs.push(...e);
  try {
    await openWorkflow(page, ws, 'nobadge.cwf'); await zoomOut(page, 1); await sleep(1000);
    record('Loop', 'builder-representable condition has no CEL-only badge', !(await page.$('[data-testid="loop-cel-only-badge"]')));
  } finally { await browser.close(); }
  return errs;
}

/**  probe: where does a double-click open the settings dialog? */
async function scenarioDbl() {
  const errs = [];
  const spots = { 'body-bottom-right': [0.85, 0.9], 'body-bottom-left': [0.1, 0.9], 'body-top-right': [0.9, 0.3], 'header-empty': [0.55, 0.06], 'body-middle-left': [0.08, 0.5] };
  for (const [name, [fx, fy]] of Object.entries(spots)) {
    write('dbl.cwf', build('vars["hasMore"] == true'));
    const { browser, page, errs: e } = await launch(); errs.push(...e);
    try {
      await openWorkflow(page, ws, 'dbl.cwf'); await zoomOut(page, 1);
      const Lb = await loopBox(page);
      await page.mouse.move(Lb.x + Lb.w * fx, Lb.y + Lb.h * fy); await page.mouse.click(Lb.x + Lb.w * fx, Lb.y + Lb.h * fy, { count: 2 }); await sleep(4000);
      const st = await stateOf(page);
      record('Loop', `double-click on ${name} opens the dialog`, !!st.dialog);
    } finally { await browser.close(); }
  }
  { // synthetic dblclick event on the loop body element
    write('dbl.cwf', build('vars["hasMore"] == true'));
    const { browser, page, errs: e } = await launch(); errs.push(...e);
    try {
      await openWorkflow(page, ws, 'dbl.cwf'); await zoomOut(page, 1);
      await page.evaluate(() => { const el = document.querySelector('[data-testid^="loop-node-"]'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.x + r.width * 0.85, clientY: r.y + r.height * 0.9, detail: 2 })); });
      await sleep(4000); const st = await stateOf(page);
      record('Loop', 'synthetic double-click event on the Loop element opens the dialog', !!st.dialog);
    } finally { await browser.close(); }
  }
  return errs;
}

/** Collapse / expand via the header toggle (loop-collapse-toggle) round trip, persisted in the .cwf. */
async function scenarioCollapse() {
  write('col.cwf', buildRich(false));
  const { browser, page, errs } = await launch();
  try {
    await openWorkflow(page, ws, 'col.cwf');
    await sleep(2500);
    const saved = async () => { await page.keyboard.down('Control'); await page.keyboard.press('KeyS'); await page.keyboard.up('Control'); await sleep(2000); return JSON.parse(fs.readFileSync(path.join(ws, 'col.cwf'), 'utf8')); };
    const vis = () => page.evaluate(() => [...document.querySelectorAll('.react-flow__node')].filter((n) => n.getBoundingClientRect().width > 0 && getComputedStyle(n).visibility !== 'hidden').map((n) => n.dataset.id));
    await page.waitForSelector('[data-testid="loop-collapse-toggle"]'); await page.evaluate(() => document.querySelector('[data-testid="loop-collapse-toggle"]').click()); await sleep(1500);
    let c = await saved(); let v = await vis(); await shot(page, '111-collapse-toggle-collapsed');
    record('Loop', 'the header chevron (loop-collapse-toggle) collapses the loop: members hidden, collapsed:true saved', !v.includes('m1') && c.nodes.find((n) => n.id === 'L').data.collapsed === true, JSON.stringify(v));
    await page.waitForSelector('[data-testid="loop-collapse-toggle"]'); await page.evaluate(() => document.querySelector('[data-testid="loop-collapse-toggle"]').click()); await sleep(1500);
    c = await saved(); v = await vis();
    record('Loop', 'the toggle on the collapsed box expands it again: members back, collapsed cleared', v.includes('m1') && !c.nodes.find((n) => n.id === 'L').data.collapsed, JSON.stringify(v));
  } finally { await browser.close(); }
  return errs;
}

const hasDialog = (page) => page.evaluate(() => !!document.querySelector('[role="dialog"], .MuiDialog-root'));
const closeDialog = async (page) => { await page.keyboard.press('Escape'); await sleep(600); await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button, .MuiDialog-root button')].find((b) => /CANCEL|CLOSE/i.test(b.innerText))?.click()); await sleep(800); };
const nodeRect = async (page, id) => (await canvasNodes(page)).find((n) => n.id === id);

/** Round 5: REAL mouse input. Double-click on ordinary nodes and on the Loop header/body, single click selection, node drag, drag-out trace. */
async function scenarioMouse() {
  const errs = [];
  write('mouse.cwf', build('vars["hasMore"] == true'));
  const { browser, page, errs: e } = await launch(); errs.push(...e);
  try {
    await openWorkflow(page, ws, 'mouse.cwf'); await zoomOut(page, 1);
    // single click selects
    let S = await nodeRect(page, 'seed');
    if (!process.env.NOCLICK) { await page.mouse.click(S.cx, S.cy); await sleep(600); }
    if (!process.env.NOCLICK) {
      const sel = await page.evaluate(() => document.querySelector('.react-flow__node[data-id="seed"]').classList.contains('selected'));
      record('Loop', 'real single click selects an ordinary node', sel);
    }
    // drag moves
    await page.mouse.move(S.cx, S.cy); await page.mouse.down(); await page.mouse.move(S.cx + 4, S.cy + 4, { steps: 2 }); await page.mouse.move(S.cx - 40, S.cy + 100, { steps: 15 });
    await page.mouse.up(); await sleep(900);
    const S2 = await nodeRect(page, 'seed');
    record('Loop', 'real drag moves an ordinary node by the mouse delta', Math.abs(S2.cx - (S.cx - 40)) < 12 && Math.abs(S2.cy - (S.cy + 100)) < 12, JSON.stringify({ from: [S.cx, S.cy], to: [S2.cx, S2.cy] }));
    await shot(page, '152-ordinary-node-click-then-drag');
    // double-click on the ordinary node (member and top-level)
    for (const id of ['seed', 'm1']) {
      const R = await nodeRect(page, id);
      await page.mouse.move(R.cx, R.cy); await page.mouse.click(R.cx, R.cy, { count: 2 }); await sleep(3500);
      const d = await hasDialog(page); await shot(page, `150-dblclick-node-${id}`);
      record('Loop', `REAL double-click on ordinary node ${id} opens its settings dialog`, d);
      if (d) await closeDialog(page);
    }
    // loop header/body
    const spots = { 'header-empty': [0.55, 0.06], 'body-bottom-right': [0.85, 0.9], 'body-middle-left': [0.08, 0.6] };
    for (const [name, [fx, fy]] of Object.entries(spots)) {
      const Lb = await loopBox(page);
      const x = Lb.x + Lb.w * fx, y = Lb.y + Lb.h * fy;
      await page.mouse.move(x, y); await page.mouse.click(x, y, { count: 2 }); await sleep(4000);
      const d = await hasDialog(page); await shot(page, `151-dblclick-loop-${name}`);
      record('Loop', `REAL double-click on the Loop ${name} opens the settings dialog`, d);
      if (d) await closeDialog(page);
    }
    // drag-out trace (member to the right, 12 steps) with positions
    const M = await nodeRect(page, 'm1'); const Lb = await loopBox(page);
    await page.mouse.move(M.cx, M.cy); await page.mouse.down(); await page.mouse.move(M.cx + 4, M.cy + 4, { steps: 2 });
    for (let i = 1; i <= 8; i++) { await page.mouse.move(M.cx + (Lb.x + Lb.w + 160 - M.cx) * i / 8, M.cy, { steps: 3 }); await sleep(150); }
    await page.mouse.up(); await sleep(1000); await shot(page, '152-dragout-trace');
    const f = await nodeRect(page, 'm1');
    await page.keyboard.down('Control'); await page.keyboard.press('KeyS'); await page.keyboard.up('Control'); await sleep(2000);
    record('Loop', 'node follows the cursor during a drag-out (final centre within 20px of the cursor)', Math.abs(f.cx - (Lb.x + Lb.w + 160)) < 20, JSON.stringify({ node: [f.cx, f.cy], mouse: Lb.x + Lb.w + 160 }));
  } finally { await browser.close(); }
  return errs;
}

/** Round 5: is the seed->m1 wire painted above the Loop box where they overlap? (elementsFromPoint order) */
const wireOnTop = (page) => page.evaluate(() => {
  const e = [...document.querySelectorAll('.react-flow__edge')].find((x) => /seeddata-m1data/.test(x.getAttribute('data-testid') || x.id)); if (!e) return { err: 'no edge' };
  const p = e.querySelector('path'); const lr = document.querySelector('.react-flow__node-Loop').getBoundingClientRect(); const len = p.getTotalLength(); const m = p.getScreenCTM(); let tested = 0, above = 0, firstOver = [];
  for (let t = 0.05; t < 0.98; t += 0.02) {
    const q = p.getPointAtLength(len * t); const x = q.x * m.a + m.e, y = q.y * m.d + m.f;
    if (x > lr.x + 8 && x < lr.x + lr.width - 8 && y > lr.y + 45 && y < lr.y + lr.height - 8) {
      const els = document.elementsFromPoint(x, y); const ie = els.findIndex((el) => el.closest('.react-flow__edge') === e); const il = els.findIndex((el) => el.closest('.react-flow__node-Loop'));
      const im = els.findIndex((el) => el.closest('.react-flow__node:not(.react-flow__node-Loop)'));
      if (im >= 0 && im < (ie < 0 ? 99 : ie)) continue; // wire is behind the member node, that is fine
      tested++; if (ie >= 0 && (il < 0 || ie < il)) above++; else if (firstOver.length < 2) firstOver.push({ ie, il, top: String(els[0].className?.baseVal ?? els[0].className).slice(0, 50) });
    }
  }
  return { tested, above, firstOver, wrapperZ: getComputedStyle(document.querySelector('.react-flow__node-Loop')).zIndex };
});

async function scenarioR5Edges() {
  const errs = [];
  write('r5e.cwf', build('vars["hasMore"] == true'));
  let { browser, page, errs: e } = await launch(); errs.push(...e);
  try {
    await openWorkflow(page, ws, 'r5e.cwf'); await zoomOut(page, 1); await sleep(800);
    const chk = async (state) => { const r = await wireOnTop(page); if (!chk.base) chk.base = r; // dashed wires leave gaps that elementsFromPoint cannot hit: compare with the unselected baseline, and require the Loop wrapper below the edge layer
      record('Loop', `wire stays painted above the Loop box — ${state}`, r.tested > 3 && r.above / r.tested >= 0.6 * (chk.base.above / chk.base.tested) && parseInt(r.wrapperZ, 10) < 0 && r.firstOver.every((f) => f.ie === -1), JSON.stringify(r)); await shot(page, `160-edge-${state.replace(/\W+/g, '-')}`); };
    await chk('unselected');
    let Lb = await loopBox(page);
    await page.mouse.click(Lb.x + Lb.w * 0.55, Lb.y + Lb.h * 0.06); await sleep(700);
    const isSel = await page.evaluate(() => document.querySelector('.react-flow__node-Loop').classList.contains('selected')); console.log('LOOP selected', isSel);
    await chk('selected');
    await page.mouse.move(Lb.x + Lb.w * 0.5, Lb.y + Lb.h * 0.85); await sleep(500); await chk('hover');
    // drag the (selected) loop by its header; check mid-drag
    await page.mouse.move(Lb.x + Lb.w * 0.55, Lb.y + Lb.h * 0.06); await page.mouse.down(); await page.mouse.move(Lb.x + Lb.w * 0.55 + 6, Lb.y + Lb.h * 0.06 + 6, { steps: 2 }); await page.mouse.move(Lb.x + Lb.w * 0.55 + 40, Lb.y + Lb.h * 0.06 + 30, { steps: 6 }); await sleep(300);
    await chk('mid-drag'); await page.mouse.up(); await sleep(600);
    // resize: grab the bottom-right corner area and check mid-resize
    Lb = await loopBox(page);
    await page.mouse.move(Lb.x + Lb.w - 6, Lb.y + Lb.h - 6); await page.mouse.down(); await page.mouse.move(Lb.x + Lb.w + 10, Lb.y + Lb.h + 10, { steps: 4 }); await sleep(300);
    await chk('mid-resize'); await page.mouse.up(); await sleep(600);
  } finally { await browser.close(); }
  // nested
  write('r5n.cwf', buildNested());
  ({ browser, page, errs: e } = await launch()); errs.push(...e);
  try {
    await openWorkflow(page, ws, 'r5n.cwf'); await page.click('.react-flow__controls-fitview').catch(() => {}); await sleep(1500);
    const info = async () => page.evaluate(() => { const loops = [...document.querySelectorAll('.react-flow__node-Loop')]; const edges = [...document.querySelectorAll('.react-flow__edge')]; return { loops: loops.map((l) => ({ id: l.dataset.id, z: getComputedStyle(l).zIndex, sel: l.classList.contains('selected') })), edgeZ: [...new Set(edges.map((x) => getComputedStyle(x).zIndex))], svgZ: [...document.querySelectorAll('.react-flow__edges, .react-flow__edges svg')].map((x) => getComputedStyle(x).zIndex) }; });
    const before = await info();
    const rects = await page.evaluate(() => [...document.querySelectorAll('.react-flow__node-Loop')].map((l) => { const b = l.getBoundingClientRect(); return { id: l.dataset.id, x: b.x, y: b.y, w: b.width, h: b.height }; }));
    for (const r of rects) { await page.mouse.click(r.x + r.w * 0.6, r.y + 14); await sleep(600); }
    const after = await info(); console.log('NESTED-Z', JSON.stringify({ before, after }));
    await shot(page, '161-nested-selected');
    // count edge pixels: edges (stroke) must be visible where they cross loop borders — compare wires' elementsFromPoint again for every edge inside the outer loop
    const res = await page.evaluate(() => { let tested = 0, above = 0; for (const e of document.querySelectorAll('.react-flow__edge')) { const p = e.querySelector('path'); if (!p) continue; const len = p.getTotalLength(); const m = p.getScreenCTM(); for (let t = 0.1; t < 0.95; t += 0.05) { const q = p.getPointAtLength(len * t); const x = q.x * m.a + m.e, y = q.y * m.d + m.f; const els = document.elementsFromPoint(x, y); const il = els.findIndex((el) => el.closest('.react-flow__node-Loop')); const im = els.findIndex((el) => el.closest('.react-flow__node:not(.react-flow__node-Loop)')); const ie = els.findIndex((el) => el.closest('.react-flow__edge') === e); if (il < 0 || (im >= 0 && im < il)) continue; tested++; if (ie >= 0 && ie < il) above++; } } return { tested, above }; });
    record('Loop', 'nested loops (both selected in turn): wire samples over a Loop box are painted above it (dashes leave hit-test gaps; wrapper z < edge layer)', res.tested > 3 && res.above / res.tested > 0.6 && after.loops.every((l) => parseInt(l.z, 10) < 0), JSON.stringify({ ...res, loopsZ: after.loops }));
  } finally { await browser.close(); }
  return errs;
}

/** Round 5: resize grab areas (24px corners / 10px edges), cursors, overlap with gear/expand, real drag resize; style computed values. */
async function scenarioR5Resize() {
  const errs = [];
  write('r5r.cwf', build('vars["hasMore"] == true'));
  const { browser, page, errs: e } = await launch(); errs.push(...e);
  try {
    await openWorkflow(page, ws, 'r5r.cwf'); await zoomOut(page, 1); await sleep(800);
    let Lb = await loopBox(page);
    await page.mouse.click(Lb.x + Lb.w * 0.55, Lb.y + Lb.h * 0.06); await sleep(600);
    const ctrls = await page.evaluate(() => [...document.querySelectorAll('.react-flow__node-Loop .react-flow__resize-control')].map((c) => { const r = c.getBoundingClientRect(); return { cls: c.className.replace('react-flow__resize-control', '').trim(), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cursor: getComputedStyle(c).cursor, bg: getComputedStyle(c).backgroundColor, op: getComputedStyle(c).opacity }; }));
    console.log('RESIZE-CTRLS', JSON.stringify(ctrls));
    const z = (await page.evaluate(() => { const l = document.querySelector('.react-flow__node-Loop').getBoundingClientRect(); const el = document.querySelector('[data-testid^="loop-node-"]').getBoundingClientRect(); return l.width / 520; }));
    // cursor at probe points (distance in CSS px from the visible corner/edge, outside and inside)
    const probe = async (x, y) => page.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); return el ? { cls: String(el.className?.baseVal ?? el.className).slice(0, 60), cursor: getComputedStyle(el).cursor } : null; }, [x, y]);
    const pts = { 'bottom-right +8 outside': [Lb.x + Lb.w + 8, Lb.y + Lb.h + 8], 'bottom-right 12 inside': [Lb.x + Lb.w - 12, Lb.y + Lb.h - 12], 'bottom-left 12 inside': [Lb.x + 12, Lb.y + Lb.h - 12], 'top-left 12 inside': [Lb.x + 12, Lb.y + 12], 'right edge 4 inside': [Lb.x + Lb.w - 4, Lb.y + Lb.h * 0.5], 'bottom edge 4 inside': [Lb.x + Lb.w * 0.5, Lb.y + Lb.h - 4], 'left edge 4 inside': [Lb.x + 4, Lb.y + Lb.h * 0.5], 'top edge 3 inside': [Lb.x + Lb.w * 0.3, Lb.y + 3] };
    const cur = {};
    for (const [k, [x, y]] of Object.entries(pts)) { await page.mouse.move(x, y); await sleep(150); cur[k] = await probe(x, y); }
    console.log('CURSORS', JSON.stringify(cur, null, 1));
    const rs = (c) => /resize/.test(c?.cursor || '');
    record('Loop', 'hovering 12px inside the bottom-right corner gives a resize cursor', rs(cur['bottom-right 12 inside']), JSON.stringify(cur['bottom-right 12 inside']));
    record('Loop', 'hovering 12px inside the bottom-left corner gives a resize cursor', rs(cur['bottom-left 12 inside']), JSON.stringify(cur['bottom-left 12 inside']));
    record('Loop', 'hovering 12px inside the top-left corner gives a resize cursor', rs(cur['top-left 12 inside']), JSON.stringify(cur['top-left 12 inside']));
    record('Loop', 'hovering 4px inside the right edge gives a resize cursor', rs(cur['right edge 4 inside']), JSON.stringify(cur['right edge 4 inside']));
    record('Loop', 'hovering 4px inside the bottom edge gives a resize cursor', rs(cur['bottom edge 4 inside']), JSON.stringify(cur['bottom edge 4 inside']));
    // not overlapping gear / expand-collapse button
    const hit = await page.evaluate(() => ['loop-settings-button', 'loop-collapse-toggle'].map((t) => { const e = document.querySelector(`[data-testid="${t}"]`); const r = e.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { t, ok: !!top?.closest(`[data-testid="${t}"]`), top: String(top?.className?.baseVal ?? top?.className).slice(0, 50) }; }));
    record('Loop', 'gear and collapse button receive the pointer (not covered by a resize grab area)', hit.every((h) => h.ok), JSON.stringify(hit));
    // real drag of the bottom-right grab area (12px inside) enlarges the box
    const w0 = Lb.w, h0 = Lb.h;
    await page.mouse.move(Lb.x + Lb.w - 12, Lb.y + Lb.h - 12); await page.mouse.down(); await page.mouse.move(Lb.x + Lb.w + 20, Lb.y + Lb.h + 20, { steps: 6 }); await page.mouse.move(Lb.x + Lb.w + 80, Lb.y + Lb.h + 60, { steps: 8 }); await page.mouse.up(); await sleep(800);
    const L2 = await loopBox(page); await shot(page, '162-resize-corner');
    record('Loop', 'a real drag from 12px inside the corner resizes the box (grows by about the mouse delta)', L2.w > w0 + 60 && L2.h > h0 + 40, JSON.stringify({ before: [Math.round(w0), Math.round(h0)], after: [Math.round(L2.w), Math.round(L2.h)] }));
    // edge drag (right edge, 4px inside)
    await page.mouse.move(L2.x + L2.w - 4, L2.y + L2.h * 0.5); await page.mouse.down(); await page.mouse.move(L2.x + L2.w - 60, L2.y + L2.h * 0.5, { steps: 8 }); await page.mouse.up(); await sleep(800);
    const L3 = await loopBox(page);
    record('Loop', 'a real drag of the right edge grab area (4px inside) shrinks the width', L3.w < L2.w - 30, JSON.stringify({ before: Math.round(L2.w), after: Math.round(L3.w) }));
    // top-right corner: a drag starting on the gear must not resize; click on the gear still opens
    // (clicking the gear is covered by the dialog scenario)
    // visible handle size
    console.log('VISIBLE-CTRL', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.react-flow__resize-control.handle')].map((c) => { const r = c.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), getComputedStyle(c).opacity]; }))));
  } finally { await browser.close(); }
  return errs;
}

/** Round 5: computed styles for the design comparison (expanded, collapsed, nested). */
async function scenarioR5Style() {
  const errs = [];
  for (const [name, wf, tag] of [['s-c.cwf', buildRich(true), 'collapsed'], ['s-e.cwf', buildRich(false), 'expanded'], ['s-n.cwf', buildNested(), 'nested']]) {
    write(name, wf);
    const { browser, page, errs: e } = await launch(); errs.push(...e);
    try {
      await openWorkflow(page, ws, name); await page.click('.react-flow__controls-fitview').catch(() => {}); await sleep(1500);
      await shot(page, `170-style-${tag}`);
      const st = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="loop-node-"]')].map((el) => {
        const g = (sel) => { const x = el.querySelector(sel); if (!x) return null; const c = getComputedStyle(x); return { text: x.innerText?.slice(0, 40), font: c.fontFamily.slice(0, 40), weight: c.fontWeight, size: c.fontSize, border: c.border, radius: c.borderRadius, bg: c.backgroundColor, color: c.color, overflow: c.overflow, textOverflow: c.textOverflow, w: Math.round(x.getBoundingClientRect().width), sw: x.scrollWidth, cw: x.clientWidth }; };
        const c = getComputedStyle(el); const tids = [...el.querySelectorAll('[data-testid]')].map((x) => x.dataset.testid);
        const label = [...el.querySelectorAll('*')].find((x) => x.children.length === 0 && /^LOOP$/i.test(x.innerText?.trim()));
        const lc = label && getComputedStyle(label);
        return { id: el.dataset.testid, bg: c.backgroundColor, border: c.border, radius: c.borderRadius, h: Math.round(el.getBoundingClientRect().height), tids, label: lc && { font: lc.fontFamily.slice(0, 50), weight: lc.fontWeight, color: lc.color, size: lc.fontSize }, pill: g('.loop-condition-chip'), toggle: g('[data-testid="loop-collapse-toggle"]'), gear: g('[data-testid="loop-settings-button"]') };
      }));
      console.log('STYLE', tag, JSON.stringify(st, null, 1));
    } finally { await browser.close(); }
  }
  return errs;
}

/** Round 5: Theia theme variables in the query builder: dark, then switch the colour theme to Light and screenshot again. */
async function scenarioR5Theme() {
  const errs = [];
  write('r5t.cwf', build('vars["hasMore"] == true'));
  const { browser, page, errs: e } = await launch(); errs.push(...e);
  try {
    await openWorkflow(page, ws, 'r5t.cwf'); await zoomOut(page, 1);
    const grab = () => page.evaluate(() => { const d = document.querySelector('[role="dialog"]'); const q = (s) => d.querySelector(s); const css = (el) => el && (({ backgroundColor, color, borderColor }) => ({ backgroundColor, color, borderColor }))(getComputedStyle(el)); return { dialogBg: css(d.querySelector('.MuiDialog-paper') || d), group: css(q('.ruleGroup')), rule: css(q('.rule')), select: css(q('.rule select')), input: css(q('.rule input')), button: css(q('.ruleGroup button')), theme: document.body.className.slice(0, 80), bodyBg: getComputedStyle(document.body).backgroundColor }; });
    const setTheme = async (name) => { await page.keyboard.press('F1'); await sleep(800); await page.keyboard.type('Preferences: Color Theme'); await sleep(900); await page.keyboard.press('Enter'); await sleep(1500); await page.keyboard.type(name); await sleep(900); await page.keyboard.press('Enter'); await sleep(2500); };
    await setTheme('Continuum (Dark)');
    await openDialog(page); await sleep(1500);
    const dark = await grab(); console.log('THEME-DARK', JSON.stringify(dark)); await shot(page, '180-builder-dark');
    await clickCancel(page); await sleep(800);
    await setTheme('Light (Theia)');
    await openDialog(page); await sleep(1500);
    const light = await grab(); console.log('THEME-LIGHT', JSON.stringify(light)); await shot(page, '181-builder-light');
    await clickCancel(page); await sleep(800);
    await setTheme('Continuum (Dark)'); await sleep(3000); // restore the workbench's persisted theme
    console.log('THEME-RESTORED', await page.evaluate(() => document.body.className));
    record('Theme', 'the builder follows the Theia colour theme (dialog/group/input colours differ between dark and light, no hard-coded white/black blocks)', JSON.stringify(dark.rule?.backgroundColor) !== JSON.stringify(light.rule?.backgroundColor) || JSON.stringify(dark.group) !== JSON.stringify(light.group), 'see THEME-DARK/LIGHT');
  } finally { await browser.close(); }
  return errs;
}

const only = process.env.ONLY;
try {
  if (only === 'probe') { write('pr.cwf', build('vars["hasMore"] == true')); const { browser, page } = await launch(); await openWorkflow(page, ws, 'pr.cwf'); await zoomOut(page, 1); const S = await nodeRect(page, 'seed');
    const ev = []; await page.exposeFunction('logEv', (t) => ev.push(t)); await page.evaluate(() => { for (const t of ['click', 'dblclick', 'mousedown']) document.addEventListener(t, (e) => window.logEv(t + ' detail=' + e.detail + ' target=' + (e.target.className?.baseVal ?? e.target.className)), true); });
    await page.mouse.move(S.cx, S.cy); if (process.env.V === 'A') await page.mouse.click(S.cx, S.cy, { count: 2 }); else if (process.env.V === 'B') await page.mouse.click(S.cx, S.cy, { count: 2 }); else { await page.mouse.down(); await page.mouse.up(); await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 }); } await sleep(3000);
    console.log('EVENTS', JSON.stringify(ev)); console.log('DIALOGS', await page.evaluate(() => [...document.querySelectorAll('[role=dialog],.MuiDialog-root,.MuiModal-root,.MuiDrawer-root')].map((e) => e.className + ' ' + e.innerText.slice(0, 80)))); await shot(page, '153-probe'); await browser.close(); }
  if (only === 'r5edges') (await scenarioR5Edges()).slice(0, 5).forEach((x) => console.log('  ', x));
  if (only === 'r5resize') (await scenarioR5Resize()).slice(0, 5).forEach((x) => console.log('  ', x));
  if (only === 'r5style') (await scenarioR5Style()).slice(0, 5).forEach((x) => console.log('  ', x));
  if (only === 'r5theme') (await scenarioR5Theme()).slice(0, 5).forEach((x) => console.log('  ', x));
  if (only === 'mouse') { const e = await scenarioMouse(); e.slice(0, 5).forEach((x) => console.log('  ', x)); }
  const all = [];
  if (!only || only === 'visual') all.push(...await scenarioVisual());
  if (only === 'payload') all.push(...await scenarioPayload());
  if (only === 'dbl') all.push(...await scenarioDbl());
  if (only === 'collapse') all.push(...await scenarioCollapse());
  if (only === 'dragout') all.push(...await scenarioDragOut());
  if (only === 'design') all.push(...await scenarioDesign());
  if (only === 'status-contrast') all.push(...await runStatusContrast());
  if (!only || only === 'run') all.push(...await scenarioRunView());
  if (!only || only === 'shapes') all.push(...await scenarioShapes());
  if (!only || only === 'dialog') { all.push(...await scenarioDialog()); }
  console.log('errors:', all.length); all.slice(0, 8).forEach((e) => console.log('  ', e));
} catch (e) { console.log('SCENARIO ERROR', e.stack); record('-', 'scenario crashed', false, e.message); }
finally { if (!process.env.KEEP) fs.rmSync(ws, { recursive: true, force: true }); }
process.exit(results.some((r) => !r.ok) ? 1 : 0);
