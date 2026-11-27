// Shared helpers for the browser (puppeteer) suites in suites/ui/. Not a suite itself.
//
// Env: WORKBENCH_URL (default http://127.0.0.1:3002), API_SERVER_URL (default http://127.0.0.1:8080),
// CREDENTIALS_URL (default http://127.0.0.1:8083), PUPPETEER_PATH (module dir of puppeteer),
// SHOT_DIR (where screenshots go; default ./screenshots).
//
// The workbench reaches the platform through same-origin paths `/api-server/...` and `/credentials-server/...`
// (an ingress rewrites them in a real deployment). A bare `theia start` has no such proxy, so `launch` answers
// those paths itself by forwarding them to the stack from `make up` (request interception in the test browser only;
// nothing in the product is touched).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const WORKBENCH_URL = process.env.WORKBENCH_URL || 'http://127.0.0.1:3002';
export const API = process.env.API_SERVER_URL || 'http://127.0.0.1:8080';
export const CRED = process.env.CREDENTIALS_URL || 'http://127.0.0.1:8083';
export const SHOT_DIR = process.env.SHOT_DIR || path.resolve('screenshots');
const PPATH = process.env.PUPPETEER_PATH || '../../../.factory/tools/node_modules/puppeteer';
export const puppeteer = createRequire(import.meta.url)(path.resolve(path.dirname(new URL(import.meta.url).pathname), PPATH));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(SHOT_DIR, { recursive: true });

export const results = [];
/** Test switches read by the platform proxy: failValidate makes `*validat*` calls answer 503 (simulates an unreachable validation service). */
export const flags = { failValidate: false };
export function record(ac, name, ok, detail = '') {
  results.push({ ac, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${ac}  ${name}${detail ? '  -- ' + detail : ''}`);
}

/** Start a headless browser with the platform proxy; collects console errors and failed requests in `errs`. */
export async function launch() {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1700, height: 1000 } });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror ' + e.message.split('\n')[0].slice(0, 200)));
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push('console ' + m.text().split('\n')[0].slice(0, 200));
  });
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('favicon')) errs.push(`http ${r.status()} ${r.request().method()} ${r.url().slice(0, 140)}`); });
  if (process.env.NETLOG) page.on('response', async (r) => { if (new RegExp(process.env.NETLOG, 'i').test(r.url())) console.log('NET', r.status(), r.request().method(), r.url(), (await r.text().catch(() => '')).slice(0, 300), '| REQ', (process.env.NETFULL ? (r.request().postData() || '') : (r.request().postData() || '').slice(0, 200))); });
  const wb = new URL(WORKBENCH_URL);
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const u = new URL(req.url());
    if (flags.failValidate && u.pathname.startsWith('/api-server/') && /validat/i.test(u.pathname)) {
      return req.respond({ status: 503, body: 'unavailable' });
    }
    if (process.env.PASSTHROUGH) return req.continue();
    const m = u.pathname.match(/^\/(api-server|credentials-server)(\/.*)$/);
    if (!m || u.host !== wb.host) return req.continue();
    const target = (m[1] === 'api-server' ? API : CRED) + m[2] + u.search;
    try {
      const h = { ...req.headers() };
      for (const k of ['host', 'origin', 'referer', 'content-length']) delete h[k];
      const r = await fetch(target, { method: req.method(), headers: h, body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postData() });
      const body = Buffer.from(await r.arrayBuffer());
      const rh = {};
      r.headers.forEach((v, k) => { if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(k)) rh[k] = v; });
      req.respond({ status: r.status, headers: rh, body });
    } catch (e) { req.respond({ status: 502, body: String(e) }); }
  });
  return { browser, page, errs };
}

export const shot = (page, name) => page.screenshot({ path: path.join(SHOT_DIR, name + '.png') });

export function makeWorkspace(runId) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `systest-${runId}-loops-`));
}

/** Open the workspace folder, trust it, and open `file` (Ctrl+P) until the React Flow canvas shows. */
export async function openWorkflow(page, dir, file) {
  await page.goto(WORKBENCH_URL + '/#' + dir, { waitUntil: 'networkidle2', timeout: 90000 });
  await sleep(6000);
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((x) => x.innerText.includes('Yes, I trust'))?.click(); });
  await sleep(2500);
  await page.keyboard.down('Control'); await page.keyboard.press('KeyP'); await page.keyboard.up('Control');
  await sleep(800);
  await page.keyboard.type(file);
  await sleep(1200);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.react-flow', { timeout: 40000 });
  await sleep(2500);
}

/** Open the Node Explorer (right side bar) and expand "Flow Control". */
export async function openPalette(page) {
  await page.mouse.click(1673, 108);
  await sleep(2500);
  const h = await page.evaluateHandle(() => [...document.querySelectorAll('.theia-TreeNode')].find((e) => e.innerText.trim() === 'Flow Control'));
  const bx = await h.asElement().boundingBox();
  await page.mouse.click(bx.x + 40, bx.y + 8);
  await sleep(1200);
}

/** Drag a palette entry (by its label) onto canvas screen position (x, y). The palette uses mouse tracking, not HTML5 DnD. */
export async function dragFromPalette(page, label, x, y) {
  // A leftover text selection turns the next mouse-down into a native text drag, which swallows the mouse events.
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  const h = await page.evaluateHandle((t) => [...document.querySelectorAll('.theia-TreeNode')].find((e) => e.innerText.trim() === t), label);
  const bx = await h.asElement().boundingBox();
  await page.mouse.move(bx.x + 40, bx.y + 8);
  await page.mouse.down();
  await page.mouse.move(bx.x + 10, bx.y + 30, { steps: 3 });
  await page.mouse.move(x, y, { steps: 15 });
  await page.mouse.up();
  await sleep(1000);
}

/** Canvas nodes as seen in the DOM: id, React Flow type, screen box. */
export const canvasNodes = (page) => page.evaluate(() => [...document.querySelectorAll('.react-flow__node')].map((n) => {
  const r = n.getBoundingClientRect();
  return { id: n.dataset.id || n.getAttribute('data-id'), type: (n.className.match(/react-flow__node-(\w+)/) || [])[1], x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
}));

export const zoomOut = async (page, n = 2) => { for (let i = 0; i < n; i++) { await page.click('.react-flow__controls-zoomout'); await sleep(300); } await sleep(500); };

/** Mouse drag in small steps (React Flow needs intermediate moves). */
export async function drag(page, from, to, steps = 12) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 4, from.y + 4, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
  await sleep(900);
}

/** Save the currently open workflow through the editor's normal keyboard command. */
export async function saveWorkflow(page) {
  const pane = await page.$('.react-flow__pane');
  const bounds = await pane?.boundingBox();
  if (bounds) await page.mouse.click(bounds.x + 12, bounds.y + 12);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyS');
  await page.keyboard.up('Control');
  await sleep(2000);
}

/** Read the saved .cwf, waiting up to 8s for `pred` to hold. */
export async function readCwf(file, pred = () => true) {
  let last;
  for (let i = 0; i < 40; i++) {
    try { last = JSON.parse(fs.readFileSync(file, 'utf8')); if (pred(last)) return last; } catch { /* partial write */ }
    await sleep(200);
  }
  return last;
}

/** Drag from a source handle to a target handle (by node id + data-handleid); returns false when a handle is not on screen. */
export async function connect(page, src, srcHandle, dst, dstHandle) {
  const pos = (id, kind, hid) => page.evaluate(([id, kind, hid]) => {
    const h = document.querySelector(`.react-flow__node[data-id="${id}"] .react-flow__handle.${kind}[data-handleid="${hid}"]`);
    if (!h) return null; const r = h.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, [id, kind, hid]);
  const a = await pos(src, 'source', srcHandle); const b = await pos(dst, 'target', dstHandle);
  if (!a || !b) return false;
  await drag(page, a, b, 20);
  return true;
}

/** Real double click: `count: 2` makes puppeteer send both press/release pairs with clickCount 1 then 2. */
export async function dblclick(page, x, y) {
  await page.mouse.click(x, y, { count: 2 });
  await sleep(1500);
}

/** Open another file of the already-open workspace (Ctrl+P) and wait for its canvas. */
export async function openFile(page, file) {
  await page.keyboard.down('Control'); await page.keyboard.press('KeyP'); await page.keyboard.up('Control');
  await sleep(800);
  await page.keyboard.type(file);
  await sleep(1200);
  await page.keyboard.press('Enter');
  await sleep(3500);
  await page.waitForSelector('.react-flow', { timeout: 30000 });
  await sleep(1500);
}
