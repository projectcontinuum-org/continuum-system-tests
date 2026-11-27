// Browser scenarios for the Loop node (CONTNM-180), part 1: palette drop, membership, move, resize.
//
// Run (workbench with the loop changes serving; platform from `make up`):
//   WORKBENCH_URL=http://127.0.0.1:3003 SHOT_DIR=/path/to/screenshots node suites/ui/loops.mjs
// Env: see lib.mjs. Needs Node 20+ and puppeteer (PUPPETEER_PATH). Test data lives in a fresh temp workspace
// `systest-<runId>-loops-*` that is removed at the end. Exit code 1 when any scenario fails.
import fs from 'node:fs';
import path from 'node:path';
import { launch, record, results, shot, sleep, makeWorkspace, openWorkflow, openPalette, dragFromPalette, canvasNodes, zoomOut, drag, readCwf, connect, dblclick, openFile, saveWorkflow } from './lib.mjs';

const runId = Date.now().toString(36);
const ws = makeWorkspace(runId);
const EMPTY = { id: 'e1', name: 'x.cwf', active: false, nodes: [], edges: [] };
const near = (a, b, tol = 6) => Math.abs(a - b) <= tol;
const nodeOf = (cwf, id) => cwf.nodes.find((n) => n.id === id);
const dropAndSave = async (page, label, x, y) => {
  await dragFromPalette(page, label, x, y);
  await saveWorkflow(page);
};
const dragAndSave = async (page, from, to, steps) => {
  await drag(page, from, to, steps);
  await saveWorkflow(page);
};

async function scenarioPaletteAndMembership() {
  const file = path.join(ws, 'drop.cwf');
  fs.writeFileSync(file, JSON.stringify(EMPTY));
  const { browser, page, errs } = await launch();
  try {
    await openWorkflow(page, ws, 'drop.cwf');
    await openPalette(page);
    // drop Loop from the palette
    await dropAndSave(page, 'Loop', 600, 400);
    let cwf = await readCwf(file, (c) => c.nodes.length === 1);
    const loop = cwf.nodes[0];
    record('Loop', 'palette drop creates one node of type Loop', loop?.type === 'Loop', JSON.stringify({ type: loop?.type, w: loop?.width, h: loop?.height }));
    record('Loop', 'default size 520x320, no parent, default condition', loop?.width === 520 && loop?.height === 320 && !loop?.parentNode && loop?.data?.properties?.condition === 'vars["hasMore"] == true');
    record('Loop', 'Loop persisted as data.nodeModel org.projectcontinuum.core.builtin.Loop', loop?.data?.nodeModel === 'org.projectcontinuum.core.builtin.Loop');
    await zoomOut(page, 3);
    const hasTid = await page.$(`[data-testid="loop-node-${loop.id}"]`);
    record('Loop', 'canvas shows data-testid loop-node-<id> with its title + condition', !!hasTid && (await page.evaluate((id) => document.querySelector(`[data-testid="loop-node-${id}"]`).innerText, loop.id)).includes('hasMore'));
    await shot(page, '10-loop-dropped');
    const [L] = await canvasNodes(page);
    // member dropped inside
    await dropAndSave(page, 'Conditional Splitter', L.cx, L.cy + L.h * 0.15);
    cwf = await readCwf(file, (c) => c.nodes.length === 2);
    const inner = cwf.nodes.find((n) => n.type !== 'Loop');
    record('Loop', 'node dropped inside the box gets parentNode = loop id', inner?.parentNode === loop.id, `parentNode=${inner?.parentNode}`);
    record('Loop', 'member position is relative (inside 0..520 x 0..320)', inner && inner.position.x >= -5 && inner.position.x < 520 && inner.position.y >= -5 && inner.position.y < 320, JSON.stringify(inner?.position));
    record('Loop', 'loop is stored before its member', cwf.nodes[0].id === loop.id);
    // member dropped outside
    await shot(page, '11-member-in-loop');
    const L2 = (await canvasNodes(page)).find((n) => n.type === 'Loop');
    await dropAndSave(page, 'Conditional Splitter', Math.max(120, L2.x - 150), L2.cy);
    cwf = await readCwf(file, (c) => c.nodes.length === 3);
    const outer = cwf.nodes.find((n) => n.type !== 'Loop' && n.id !== inner.id);
    record('Loop', 'node dropped outside the box has no parentNode', outer && !outer.parentNode, `parentNode=${outer?.parentNode}`);
    await shot(page, '12-outer-node');

    const box = async (id) => (await canvasNodes(page)).find((n) => n.id === id);
    const loopBeforeIsolation = await box(loop.id);
    const outerBeforeIsolation = await box(outer.id);
    const isolatedDrop = { x: Math.max(160, loopBeforeIsolation.x - outerBeforeIsolation.w / 2 - 60), y: loopBeforeIsolation.cy };
    await dragAndSave(page, { x: outerBeforeIsolation.cx, y: outerBeforeIsolation.cy }, isolatedDrop);
    cwf = await readCwf(file, (c) => !nodeOf(c, outer.id)?.parentNode);

    // z-order / appearance probe (member must not be painted under the loop's translucent body)
    const z = await page.evaluate((ids) => ids.map((id) => { const e = document.querySelector(`.react-flow__node[data-id="${id}"]`); return { id, z: getComputedStyle(e).zIndex }; }), [loop.id, inner.id, outer.id]);
    console.log('z-index', JSON.stringify(z));

    // drag the member out of the box -> parentNode cleared, absolute position kept (it lands where it was dropped)
    let M = await box(inner.id); const Lb = await box(loop.id);
    const target = { x: Lb.x + Lb.w + 220, y: Lb.cy + 120 };
    await dragAndSave(page, { x: M.cx, y: M.cy }, target);
    cwf = await readCwf(file, (c) => !nodeOf(c, inner.id)?.parentNode);
    const out = nodeOf(cwf, inner.id);
    M = await box(inner.id);
    record('Loop', 'dragging a member out of the box clears parentNode', !out?.parentNode, `parentNode=${out?.parentNode}`);
    record('Loop', 'the dragged-out node keeps its absolute position (DOM box moved by the drag delta, saved x,y = absolute)', near(M.cx, target.x, 8) && near(M.cy, target.y, 8) && out.position.x > nodeOf(cwf, loop.id).position.x + 520, `dom centre ${Math.round(M.cx)},${Math.round(M.cy)} want ${Math.round(target.x)},${Math.round(target.y)}; saved ${JSON.stringify(out?.position)}`);
    await shot(page, '13-member-dragged-out');

    // Drag out from every side and over an existing node; the final center must match the pointer drop point.
    let resetBox = await box(loop.id);
    await dragAndSave(page, { x: M.cx, y: M.cy }, { x: resetBox.cx, y: resetBox.cy + resetBox.h * 0.2 });
    cwf = await readCwf(file, (c) => nodeOf(c, inner.id)?.parentNode === loop.id);

    const directionalDrops = [
      ['right', () => ({ x: Lb.x + Lb.w + 90, y: Lb.cy })],
      ['below', () => ({ x: Lb.cx, y: Lb.y + Lb.h + 80 })],
      ['left', () => ({ x: Lb.x - 10, y: Lb.cy })],
      ['above', () => ({ x: Lb.cx, y: Lb.y - 80 })],
    ];
    for (const [direction, pointForTarget] of directionalDrops) {
      M = await box(inner.id);
      const dropPoint = pointForTarget();
      await dragAndSave(page, { x: M.cx, y: M.cy }, dropPoint);
      cwf = await readCwf(file, (c) => !nodeOf(c, inner.id)?.parentNode);
      const finalBox = await box(inner.id);
      record(
        '',
        `dragging a member ${direction} preserves the mouse drop position`,
        !nodeOf(cwf, inner.id)?.parentNode && near(finalBox.cx, dropPoint.x, 5) && near(finalBox.cy, dropPoint.y, 5),
        `drop ${Math.round(dropPoint.x)},${Math.round(dropPoint.y)}; final ${Math.round(finalBox.cx)},${Math.round(finalBox.cy)}; saved ${JSON.stringify(nodeOf(cwf, inner.id)?.position)}`,
      );
      await shot(page, `13-member-dragout-${direction}`);
      const currentLoop = await box(loop.id);
      await dragAndSave(page, { x: finalBox.cx, y: finalBox.cy }, { x: currentLoop.cx, y: currentLoop.cy + currentLoop.h * 0.2 });
      cwf = await readCwf(file, (c) => nodeOf(c, inner.id)?.parentNode === loop.id);
    }

    // drag it back in
    const L3 = await box(loop.id);
    M = await box(inner.id);
    await dragAndSave(page, { x: M.cx, y: M.cy }, { x: L3.cx, y: L3.cy + L3.h * 0.2 });
    cwf = await readCwf(file, (c) => nodeOf(c, inner.id)?.parentNode === loop.id);
    record('Loop', 'dragging a node into the box makes it a member again (parentNode set, relative position)', nodeOf(cwf, inner.id)?.parentNode === loop.id && nodeOf(cwf, inner.id).position.x < 520, JSON.stringify(nodeOf(cwf, inner.id)?.position));
    await shot(page, '14-member-back-in');
    const stack = await page.evaluate(([x, y]) => document.elementsFromPoint(x, y).map((e) => e.closest('.react-flow__node')?.getAttribute('data-id')).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i), [(await box(inner.id)).cx, (await box(inner.id)).cy]);
    const order = await page.evaluate(() => [...document.querySelectorAll('.react-flow__node')].map((n) => n.getAttribute('data-id') + ':' + n.style.zIndex));
    console.log('stack at member centre (top first):', JSON.stringify(stack), 'dom order:', JSON.stringify(order));
    const mbg = await page.evaluate((id) => { const e = document.querySelector(`.react-flow__node[data-id="${id}"] > *`); const cs = getComputedStyle(e); return { opacity: cs.opacity, bg: cs.backgroundColor, filter: cs.filter }; }, inner.id);
    console.log('member root style', JSON.stringify(mbg));
    // members move with the box
    const Lm = await box(loop.id); const Mm = await box(inner.id);
    const dxy = { x: 0, y: -100 };
    await dragAndSave(page, { x: Lm.x + 250, y: Lm.y + 22 }, { x: Lm.x + 250 + dxy.x, y: Lm.y + 22 + dxy.y });
    const Lm2 = await box(loop.id); const Mm2 = await box(inner.id);
    const cwf2 = await readCwf(file, (c) => nodeOf(c, loop.id)?.position.y !== nodeOf(cwf, loop.id)?.position.y);
    record('Loop', 'moving the box moves its members by the same amount (relative position unchanged)',
      near(Lm2.y - Lm.y, dxy.y, 8) && near(Mm2.y - Mm.y, dxy.y, 8) && JSON.stringify(nodeOf(cwf2, inner.id).position) === JSON.stringify(nodeOf(cwf, inner.id).position),
      `box dy=${Math.round(Lm2.y - Lm.y)} member dy=${Math.round(Mm2.y - Mm.y)}`);
    await shot(page, '15-loop-moved');

    // ---- resize : select the box, drag the bottom-right handle
    const sc = (await box(loop.id)).w / 520;
    await page.mouse.click(Lm2.x + 150, Lm2.y + 22);
    await sleep(500);
    const handles = await page.evaluate(() => [...document.querySelectorAll('.loop-resize-handle')].map((h) => { const r = h.getBoundingClientRect(); return { cls: h.className, x: r.x + r.width / 2, y: r.y + r.height / 2 }; }));
    record('Loop', 'selected Loop shows resize handles (.loop-resize-handle) and loop-resize-controls-<id>', handles.length >= 4 && !!(await page.$(`[data-testid="loop-resize-controls-${loop.id}"]`)), `handles=${handles.length}`);
    const cornerState = await page.evaluate((id) => {
      const wrapper = document.querySelector(`.react-flow__node[data-id="${id}"]`);
      const nodeRect = wrapper.getBoundingClientRect();
      const expected = {
        'top left': { x: nodeRect.left, y: nodeRect.top },
        'top right': { x: nodeRect.right, y: nodeRect.top },
        'bottom left': { x: nodeRect.left, y: nodeRect.bottom },
        'bottom right': { x: nodeRect.right, y: nodeRect.bottom },
      };
      return Object.entries(expected).map(([corner, point]) => {
        const handle = [...wrapper.querySelectorAll('.loop-resize-handle')]
          .find((item) => item.className.includes(corner));
        if (!handle) return { corner, found: false };
        const rect = handle.getBoundingClientRect();
        const style = getComputedStyle(handle);
        return {
          corner,
          found: true,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          expected: point,
          width: rect.width,
          height: rect.height,
          opacity: Number.parseFloat(style.opacity),
          color: style.backgroundColor,
        };
      });
    }, loop.id);
    const cornersVisible = cornerState.length === 4 && cornerState.every((h) => h.found
      && h.width >= 7 && h.height >= 7 && h.opacity > 0
      && Math.abs(h.x - h.expected.x) <= 3 && Math.abs(h.y - h.expected.y) <= 3);
    record('Loop', 'selected Loop shows four visible corner resize handles positioned on its corners', cornersVisible, JSON.stringify(cornerState));
    await shot(page, '15-loop-selected-resizer-handles');
    const br = handles.find((h) => /bottom/.test(h.cls) && /right/.test(h.cls)) || handles[handles.length - 1];
    const cornerMetrics = await page.evaluate(() => {
      const handle = [...document.querySelectorAll('.loop-resize-handle')].find((item) => /bottom/.test(item.className) && /right/.test(item.className));
      const rect = handle.getBoundingClientRect();
      const hitArea = getComputedStyle(handle, '::before');
      return {
        x: rect.x + rect.width / 2 + 9,
        y: rect.y + rect.height / 2 + 9,
        visibleWidth: rect.width,
        visibleHeight: rect.height,
        hitWidth: Number.parseFloat(hitArea.width),
        hitHeight: Number.parseFloat(hitArea.height),
      };
    });
    await page.mouse.move(cornerMetrics.x, cornerMetrics.y);
    const cornerTarget = await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      return {
        resizeHandle: target?.classList.contains('loop-resize-handle') ?? false,
        cursor: target ? getComputedStyle(target).cursor : '',
      };
    }, cornerMetrics);
    record('Loop', 'corner resize hit area is larger than its small visible handle and keeps its resize cursor', cornerMetrics.visibleWidth <= 10 && cornerMetrics.visibleHeight <= 10 && cornerMetrics.hitWidth >= 22 && cornerMetrics.hitHeight >= 22 && cornerTarget.resizeHandle && cornerTarget.cursor === 'nwse-resize', JSON.stringify({ ...cornerMetrics, ...cornerTarget }));

    const Lr = await box(loop.id);
    const cornerStart = { x: cornerMetrics.x, y: cornerMetrics.y };
    const cornerSamples = [];
    await page.mouse.down();
    for (const fraction of [0.2, 0.45, 0.7, 1]) {
      await page.mouse.move(cornerStart.x + 120 * fraction, cornerStart.y + 60 * fraction, { steps: 3 });
      await sleep(100);
      const liveBox = await box(loop.id);
      cornerSamples.push({ width: liveBox.w, height: liveBox.h });
    }
    const beforeCornerRelease = await box(loop.id);
    await page.mouse.up();
    await saveWorkflow(page);
    record('Loop', 'Loop width and height follow real mouse movement before release', beforeCornerRelease.w > Lr.w + 30 && beforeCornerRelease.h > Lr.h + 15, JSON.stringify({ before: [Lr.w, Lr.h], samples: cornerSamples, beforeRelease: [beforeCornerRelease.w, beforeCornerRelease.h] }));

    const resizedLoop = await box(loop.id);
    await page.mouse.click(resizedLoop.x + 150, resizedLoop.y + 22);
    await sleep(400);
    const edgeMetrics = await page.evaluate(() => {
      const edge = [...document.querySelectorAll('.loop-resize-line')].find((item) => /bottom/.test(item.className));
      const rect = edge.getBoundingClientRect();
      const hitArea = getComputedStyle(edge, '::before');
      return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2 + 4,
        visibleHeight: rect.height,
        hitHeight: Number.parseFloat(hitArea.height),
      };
    });
    await page.mouse.move(edgeMetrics.x, edgeMetrics.y);
    const edgeTarget = await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      return {
        resizeEdge: target?.classList.contains('loop-resize-line') ?? false,
        cursor: target ? getComputedStyle(target).cursor : '',
      };
    }, edgeMetrics);
    record('Loop', 'edge resize grab zone extends beyond its thin visible line', edgeMetrics.visibleHeight <= 3 && edgeMetrics.hitHeight >= 10 && edgeTarget.resizeEdge && edgeTarget.cursor === 'ns-resize', JSON.stringify({ ...edgeMetrics, ...edgeTarget }));

    const beforeEdgeResize = await box(loop.id);
    await page.mouse.down();
    await page.mouse.move(edgeMetrics.x, edgeMetrics.y + 30, { steps: 6 });
    await sleep(150);
    const beforeEdgeRelease = await box(loop.id);
    await page.mouse.up();
    await saveWorkflow(page);
    record('Loop', 'the invisible edge grab zone starts a real resize drag', beforeEdgeRelease.h > beforeEdgeResize.h + 10, `height ${Math.round(beforeEdgeResize.h)} -> ${Math.round(beforeEdgeRelease.h)} before mouseup`);

    const edgeResizedLoop = await box(loop.id);
    await page.mouse.click(edgeResizedLoop.x + 150, edgeResizedLoop.y + 22);
    await sleep(400);
    cwf = await readCwf(file, (c) => nodeOf(c, loop.id)?.width !== 520);
    const rl = nodeOf(cwf, loop.id);
    const wantW = 520 + 120 / sc, wantH = 320 + 60 / sc + 30 / sc;
    record('Loop', 'resizing the box saves the new width/height (node and style)', near(rl.width, wantW, 12) && near(rl.height, wantH, 12) && rl.style?.width === rl.width && rl.style?.height === rl.height, `saved ${rl.width}x${rl.height} want ~${Math.round(wantW)}x${Math.round(wantH)}`);
    await shot(page, '16-loop-resized');
    // shrinking cannot go below the members (min bounds)
    const Mr = await box(inner.id); const Lr2 = await box(loop.id);
    const br2 = await page.evaluate(() => { const h = [...document.querySelectorAll('.loop-resize-handle')].find((x) => /bottom/.test(x.className) && /right/.test(x.className)); const r = h.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await dragAndSave(page, br2, { x: Lr2.x + 20, y: Lr2.y + 20 }, 16);
    const Ls = await box(loop.id); const Ms = await box(inner.id);
    record('Loop', 'shrinking the box stops at its members (member still fully inside)', Ms.x >= Ls.x - 2 && Ms.y >= Ls.y - 2 && Ms.x + Ms.w <= Ls.x + Ls.w + 2 && Ms.y + Ms.h <= Ls.y + Ls.h + 2, `box ${Math.round(Ls.w)}x${Math.round(Ls.h)} member ${Math.round(Ms.w)}x${Math.round(Ms.h)}`);
    await shot(page, '17-loop-shrunk');

    // ---- edges across the boundary: A(outside) -> B(member); B -> C(outside)
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    const Lc = await box(loop.id);
    const bro = await page.evaluate(() => { const h = [...document.querySelectorAll('.loop-resize-handle')].find((x) => /bottom/.test(x.className) && /right/.test(x.className)); const r = h?.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    if (bro) await dragAndSave(page, bro, { x: bro.x + 260, y: bro.y + 120 }, 16);
    await page.mouse.click(60, 200); await sleep(300); // deselect
    await zoomOut(page, 2);
    const Lz = await box(loop.id);
    await dropAndSave(page, 'Conditional Splitter', Lz.x + Lz.w + 120, Lz.cy); // C outside right
    cwf = await readCwf(file, (c) => c.nodes.length === 4);
    const C = cwf.nodes.find((n) => !['Loop', undefined].includes(n.type) && n.id !== inner.id && n.id !== outer.id);
    await dropAndSave(page, 'Conditional Splitter', Lz.x + Lz.w * 0.2, Lz.y + Lz.h * 0.8); // D member (inside)
    cwf = await readCwf(file, (c) => c.nodes.length === 5);
    const D = cwf.nodes.find((n) => n.parentNode === loop.id && n.id !== inner.id);
    await shot(page, '18-layout-for-edges');
    console.log('nodes', JSON.stringify(cwf.nodes.map((n) => ({ id: n.id, t: n.type, p: n.parentNode }))));

    // edges: outer -> member, member -> outer
    const okA = await connect(page, outer.id, 'high', inner.id, 'data');
    const okB = await connect(page, inner.id, 'high', C.id, 'data');
    await saveWorkflow(page);
    cwf = await readCwf(file, (c) => c.edges.length >= 2);
    const edgeKey = (e) => `${e.source}:${e.sourceHandle}>${e.target}:${e.targetHandle}`;
    record('Loop', 'editor: connecting handles creates edges, including across the loop boundary (outside->member, member->outside)', okA && okB && cwf.edges.length === 2, cwf.edges.map(edgeKey).join(' | '));
    record('Loop', 'stored edges name only ordinary nodes, never the loop', cwf.edges.every((e) => e.source !== loop.id && e.target !== loop.id));
    await shot(page, '19-edges-across-boundary');
    // cycle across the boundary: member -> C -> member2 must be refused
    const okC = await connect(page, C.id, 'high', D.id, 'data');
    await sleep(800);
    await saveWorkflow(page);
    cwf = await readCwf(file, () => true);
    const toast = await page.evaluate(() => [...document.querySelectorAll('.theia-notification-list-item, .theia-notification-message, .MuiSnackbar-root, [role="alert"]')].map((e) => e.innerText.trim()).filter(Boolean));
    record('Loop', 'a connection that makes X1 -> Y -> X2 across the loop boundary (member -> outside -> member) is refused (no edge stored)', okC && cwf.edges.length === 2, `edges=${cwf.edges.length} notifications=${JSON.stringify(toast)}`);
    await shot(page, '20-cycle-refused');

    // ---- collapse / expand 
    const rawBefore = fs.readFileSync(file, 'utf8');
    const edgesBefore = JSON.stringify(JSON.parse(rawBefore).edges);
    const visibleIds = () => page.evaluate(() => [...document.querySelectorAll('.react-flow__node')].filter((n) => getComputedStyle(n).visibility !== 'hidden' && getComputedStyle(n).display !== 'none' && n.getBoundingClientRect().width > 0).map((n) => n.getAttribute('data-id')));
    const edgeEls = () => page.evaluate(() => [...document.querySelectorAll('.react-flow__edge')].map((e) => ({ id: e.getAttribute('data-testid') || e.id, d: e.querySelector('path')?.getAttribute('d') })));
    const edgesDomBefore = await edgeEls();
    await page.evaluate((id) => document.querySelector(`[data-testid="loop-node-${id}"] [data-testid="loop-collapse-toggle"]`).click(), loop.id); // DOM click: the box can extend under the side panel
    await sleep(1200);
    await saveWorkflow(page);
    cwf = await readCwf(file, (c) => nodeOf(c, loop.id)?.data?.collapsed === true);
    const vis = await visibleIds();
    record('Loop', 'collapsing hides the members on the canvas', vis.includes(loop.id) && !vis.includes(inner.id) && !vis.includes(D.id), `visible=${JSON.stringify(vis)}`);
    record('Loop', 'collapsing saves collapsed: true on the loop', nodeOf(cwf, loop.id)?.data?.collapsed === true, `collapsed=${nodeOf(cwf, loop.id)?.data?.collapsed}`);
    record('Loop', 'collapsed: stored edges unchanged (same JSON as before collapsing)', JSON.stringify(cwf.edges) === edgesBefore);
    const edgesCollapsed = await edgeEls();
    const LC = await box(loop.id);
    record('Loop', 'collapsed: both outside edges are still drawn and re-pointed (paths changed, none removed)', edgesCollapsed.length === edgesDomBefore.length && edgesCollapsed.length >= 2 && JSON.stringify(edgesCollapsed.map((e) => e.d)) !== JSON.stringify(edgesDomBefore.map((e) => e.d)), `edges ${edgesDomBefore.length} -> ${edgesCollapsed.length}`);
    record('Loop', 'collapsed box shows condition and expand control (aria-expanded=false)', (await page.evaluate((id) => document.querySelector(`[data-testid="loop-node-${id}"] [data-testid="loop-collapse-toggle"]`)?.getAttribute('aria-expanded'), loop.id)) === 'false');
    await shot(page, '21-collapsed');
    await page.evaluate((id) => document.querySelector(`[data-testid="loop-node-${id}"] [data-testid="loop-collapse-toggle"]`).click(), loop.id); // DOM click: the box can extend under the side panel
    await sleep(1200);
    await saveWorkflow(page);
    cwf = await readCwf(file, (c) => !nodeOf(c, loop.id)?.data?.collapsed);
    const vis2 = await visibleIds();
    record('Loop', 'expanding restores the members and clears collapsed', vis2.includes(inner.id) && vis2.includes(D.id) && !nodeOf(cwf, loop.id)?.data?.collapsed, `collapsed=${nodeOf(cwf, loop.id)?.data?.collapsed}`);
    record('Loop', 'after collapse+expand the saved edges are byte-identical to before', JSON.stringify(cwf.edges) === edgesBefore);
    record('Loop', 'expanded box has its saved size back (width/height unchanged)', nodeOf(cwf, loop.id)?.width === JSON.parse(rawBefore).nodes.find((n) => n.id === loop.id).width);
    await shot(page, '22-expanded');
    // collapse again and leave it collapsed for the reload check
    await page.evaluate((id) => document.querySelector(`[data-testid="loop-node-${id}"] [data-testid="loop-collapse-toggle"]`).click(), loop.id); // DOM click: the box can extend under the side panel
    await sleep(1000);
    await saveWorkflow(page);
    await readCwf(file, (c) => nodeOf(c, loop.id)?.data?.collapsed === true);
    fs.copyFileSync(file, path.join(ws, 'reload.cwf'));

    // Run this last so the exact node overlap cannot block later member drags.
    await page.evaluate((id) => document.querySelector(`[data-testid="loop-node-${id}"] [data-testid="loop-collapse-toggle"]`).click(), loop.id);
    await sleep(1000);
    await saveWorkflow(page);
    const overLoopBox = await box(loop.id);
    const overMemberBox = await box(inner.id);
    const overTargetBox = await box(outer.id);
    const overDropPoint = { x: overTargetBox.cx, y: overTargetBox.cy };
    await dragAndSave(page, { x: overMemberBox.cx, y: overMemberBox.cy }, overDropPoint);
    const overCwf = await readCwf(file, (c) => !nodeOf(c, inner.id)?.parentNode);
    const overFinalBox = await box(inner.id);
    const targetOutsideLoop = overTargetBox.cx < overLoopBox.x || overTargetBox.cx > overLoopBox.x + overLoopBox.w
      || overTargetBox.cy < overLoopBox.y || overTargetBox.cy > overLoopBox.y + overLoopBox.h;
    record(
      'Loop canvas',
      'dragging a member over an existing outside node preserves the mouse drop position',
      targetOutsideLoop && !nodeOf(overCwf, inner.id)?.parentNode
        && near(overFinalBox.cx, overDropPoint.x, 5) && near(overFinalBox.cy, overDropPoint.y, 5),
      `target ${Math.round(overDropPoint.x)},${Math.round(overDropPoint.y)}; final ${Math.round(overFinalBox.cx)},${Math.round(overFinalBox.cy)}; saved ${JSON.stringify(nodeOf(overCwf, inner.id)?.position)}`,
    );
    await shot(page, '13-member-dragout-over-another-node');
    return { file, loopId: loop.id, innerId: inner.id, outerId: outer.id, errs };
  } finally { await browser.close(); }
}

async function scenarioReloadAndDialog() {
  const file = path.join(ws, 'reload.cwf');
  const { browser, page, errs } = await launch();
  try {
    await openWorkflow(page, ws, 'reload.cwf');
    await sleep(1500);
    const cwf = await readCwf(file);
    const loop = cwf.nodes.find((n) => n.type === 'Loop');
    const vis = await page.evaluate(() => [...document.querySelectorAll('.react-flow__node')].filter((n) => n.getBoundingClientRect().width > 0).map((n) => n.getAttribute('data-id')));
    const toggle = await page.evaluate((id) => document.querySelector(`[data-testid="loop-node-${id}"] [data-testid="loop-collapse-toggle"]`)?.getAttribute('aria-expanded'), loop.id);
    record('Loop', 'after closing and reopening the workflow the loop is still collapsed (members hidden)', toggle === 'false' && vis.length === 3, `aria-expanded=${toggle} visible=${JSON.stringify(vis)}`);
    await shot(page, '23-reopened-collapsed');
    // open the properties dialog
    const L = (await canvasNodes(page)).find((n) => n.type === 'Loop');
    await dblclick(page, L.x + L.w * 0.5, L.y + L.h * 0.5);
    await sleep(2500);
    await shot(page, '30-dialog-default');
    const dlg = await page.evaluate(() => { const d = document.querySelector('[role="dialog"], .MuiDialog-root'); return d ? d.innerText.slice(0, 1500) : null; });
    console.log('DIALOG:', JSON.stringify(dlg));
    const tids = await page.evaluate(() => [...document.querySelectorAll('[data-testid]')].map((e) => e.dataset.testid).filter((t) => /loop/.test(t)));
    console.log('loop testids:', JSON.stringify(tids));
    return { errs };
  } finally { await browser.close(); }
}

/** Delete a Loop: the keep / delete / cancel choice . Fixtures are derived from the file scenario 1 saved. */
async function scenarioDelete() {
  const base = JSON.parse(fs.readFileSync(path.join(ws, 'reload.cwf'), 'utf8'));
  const loopId = base.nodes.find((n) => n.type === 'Loop').id;
  for (const n of base.nodes) if (n.id === loopId) n.data.collapsed = false;
  for (const name of ['delcancel', 'delkeep', 'delmembers']) fs.writeFileSync(path.join(ws, name + '.cwf'), JSON.stringify(base));
  let { browser, page, errs } = await launch();
  const out = {};
  try {
    await openWorkflow(page, ws, 'delcancel.cwf');
    const askDelete = async () => {
      const L = (await canvasNodes(page)).find((n) => n.type === 'Loop');
      await page.mouse.click(L.x + L.w * 0.5, L.y + 8); // select the box (its top edge, clear of the members)
      await sleep(400);
      await page.keyboard.press('Delete');
      await sleep(1200);
    };
    const notif = () => page.evaluate(() => [...document.querySelectorAll('.theia-notification-list-item, .theia-notification-toasts')].map((e) => e.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean));
    await askDelete();
    const n1 = await notif();
    console.log('notifications:', JSON.stringify(n1));
    await shot(page, '40-delete-choice');
    record('Loop', 'deleting a Loop asks: Delete members / Keep members / Cancel', n1.some((t) => /Delete members/.test(t) && /Keep members/.test(t) && /Cancel/.test(t)), n1[0]);
    const clickBtn = (label) => page.evaluate((l) => { const b = [...document.querySelectorAll('.theia-notification-list-item button, .theia-notification-toasts button, .theia-notification-center button')].find((x) => x.innerText.trim() === l); if (b) b.click(); return !!b; }, label);
    await clickBtn('Cancel'); await sleep(2500);
    const c = await readCwf(path.join(ws, 'delcancel.cwf'), () => true);
    record('Loop', 'Cancel keeps the loop and all members', c.nodes.length === base.nodes.length, 'nodes=' + c.nodes.length);
    await browser.close();
    ({ browser, page } = await launch());
    await openWorkflow(page, ws, 'delkeep.cwf');
    await askDelete(); await clickBtn('Keep members'); await sleep(3500);
    await saveWorkflow(page);
    await shot(page, '41-delete-keep');
    const k = await readCwf(path.join(ws, 'delkeep.cwf'), (d) => !d.nodes.some((n) => n.type === 'Loop'));
    const members = base.nodes.filter((n) => n.parentNode);
    record('Loop', 'Keep members: loop removed, members stay with no parent at the same absolute position', k && !k.nodes.some((n) => n.type === 'Loop') && k.nodes.length === base.nodes.length - 1 && !k.nodes.some((n) => n.parentNode), k && JSON.stringify(k.nodes.map((n) => [n.id, n.position])));
    await browser.close();
    ({ browser, page } = await launch());
    await openWorkflow(page, ws, 'delmembers.cwf');
    await askDelete(); await clickBtn('Delete members'); await sleep(3500);
    await saveWorkflow(page);
    await shot(page, '42-delete-members');
    const d = await readCwf(path.join(ws, 'delmembers.cwf'), (x) => x.nodes.length < base.nodes.length - 1 || x.nodes.length === base.nodes.length - 1 - members.length);
    record('Loop', 'Delete members: loop and its members removed, outside nodes kept', d && d.nodes.length === base.nodes.length - 1 - members.length, 'nodes=' + (d && d.nodes.map((n) => n.id)));
    return { errs };
  } finally { await browser.close(); }
}

/** a condition the builder cannot represent still shows as CEL text with a warning badge. */
async function scenarioBadge() {
  const base = JSON.parse(fs.readFileSync(path.join(ws, 'reload.cwf'), 'utf8'));
  const loop = base.nodes.find((n) => n.type === 'Loop');
  loop.data.collapsed = false;
  loop.data.properties.condition = 'vars["a"].exists(x, x > 1) && size(vars["b"]) > 2';
  fs.writeFileSync(path.join(ws, 'badge.cwf'), JSON.stringify(base));
  const { browser, page, errs } = await launch();
  try {
    await openWorkflow(page, ws, 'badge.cwf');
    const txt = await page.evaluate((id) => document.querySelector(`[data-testid="loop-node-${id}"]`)?.innerText, loop.id);
    const html = await page.evaluate((id) => [...document.querySelectorAll(`[data-testid="loop-node-${id}"] [title], [data-testid="loop-node-${id}"] svg`)].map((e) => (e.getAttribute('title') || e.getAttribute('data-testid') || e.tagName)).slice(0, 10), loop.id);
    record('Loop', 'a CEL condition the builder cannot represent shows the "CEL-only expression" warning on the loop', /CEL-only expression/.test(txt || ''), JSON.stringify(txt));
    await shot(page, '50-badge');
    return { errs };
  } finally { await browser.close(); }
}

/**  /  probe: a loop-free workflow edits normally and can be run; a looped one is submitted too. */
async function scenarioRun() {
  const mk = (withLoop) => {
    const base = JSON.parse(fs.readFileSync(path.join(ws, 'reload.cwf'), 'utf8'));
    return base;
  };
  const base = mk();
  const plain = JSON.parse(JSON.stringify(base));
  plain.nodes = plain.nodes.map((n) => { delete n.parentNode; delete n.extent; return n; });
  plain.edges = [];
  fs.writeFileSync(path.join(ws, 'plain.cwf'), JSON.stringify(plain));
  const { browser, page, errs } = await launch();
  try {
    await openWorkflow(page, ws, 'plain.cwf');
    const nodes = await canvasNodes(page);
    console.log('PLAIN nodes', JSON.stringify(nodes.map((n) => [n.id, n.type, Math.round(n.w)])));
    await shot(page, '60-plain');
    const a = nodes[0], b = nodes[1];
    const ok = await connect(page, a.id, 'high', b.id, 'data');
    await sleep(1500);
    const c = await readCwf(path.join(ws, 'plain.cwf'), (d) => d.edges.length > 0);
    record('Loop', 'regression: a workflow without a loop still connects nodes and saves the edge', c.edges.length === 1, JSON.stringify(c.edges.map((e) => e.source + '>' + e.target)));
    const runBtn = await page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => /^\s*RUN/.test(b.innerText)).length);
    console.log('RUN buttons', runBtn);
    await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /^\s*RUN/.test(b.innerText)).click());
    await sleep(6000);
    await shot(page, '61-plain-run');
    console.log('AFTER RUN notifs', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.theia-notification-list-item')].map((e) => e.innerText.replace(/\s+/g, ' ')))));
    console.log('RUNS PANEL', JSON.stringify(await page.evaluate(() => document.body.innerText.slice(-600))));
    return { errs };
  } finally { await browser.close(); }
}

async function scenarioLoopRun() {
  fs.copyFileSync('/tmp/dbg/looprun.cwf', path.join(ws, 'looprun.cwf'));
  const { browser, page, errs } = await launch();
  try {
    await openWorkflow(page, ws, 'looprun.cwf');
    await zoomOut(page); await zoomOut(page);
    await sleep(800);
    await shot(page, '62-looprun-open');
    await connect(page, '7', 'high', '8', 'data');
    await sleep(1500);
    await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /^\s*RUN/.test(b.innerText)).click());
    await sleep(5000);
    await shot(page, '63-looprun-started');
    await page.evaluate(() => { const b = [...document.querySelectorAll('.theia-notification-list-item button')].find((x) => /Open Viewer/.test(x.innerText)); if (b) b.click(); });
    await sleep(8000);
    await shot(page, '64-looprun-viewer');
    const txt = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="loop-node-"]')].map((e) => e.innerText.replace(/\s+/g, ' ')));
    console.log('VIEWER loop text', JSON.stringify(txt));
    console.log('tabs', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.lm-TabBar-tabLabel')].map((e) => e.innerText))));
    return { errs };
  } finally { await browser.close(); }
}

if (process.env.ONLY === 'looprun') { const r = await scenarioLoopRun(); process.exit(0); }
if (process.env.ONLY === 'run') {
  fs.copyFileSync('/tmp/dbg/two.cwf', path.join(ws, 'reload.cwf'));
  const r = await scenarioRun(); r.errs.slice(0, 5).forEach((e) => console.log(e));
  process.exit(0);
}
try {
  const s = await scenarioPaletteAndMembership();
  console.log('errors:', s.errs.length); s.errs.slice(0, 10).forEach((e) => console.log('  ', e));
  const s4 = await scenarioBadge();
  const s3 = await scenarioDelete();
  const s2 = await scenarioReloadAndDialog();
  console.log('errors2:', s2.errs.length); s2.errs.slice(0, 10).forEach((e) => console.log('  ', e));
} catch (e) { console.log('SCENARIO ERROR', e.stack); record('Scenario', 'scenario crashed', false, e.message); }
finally { fs.rmSync(ws, { recursive: true, force: true }); }
process.exit(results.some((r) => !r.ok) ? 1 : 0);
