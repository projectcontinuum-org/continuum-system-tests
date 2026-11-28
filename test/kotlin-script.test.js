import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contextDocument, documentUri, isUnusedBindingWarning, reportedContextFromFeatureSource, userDiagnostics, weaveScript, wrapperFunctionName } from '../lib/kotlin-script.mjs';

// A synthetic context: the model of the header does not depend on which names a node reports.
const CTX = { namespace: 'ctxabc', context: { language: 'kotlin', bindings: [{ name: 'a', type: 'Int' }, { name: 'b', type: 'List<String>' }], declarations: '/** Doc. */\ninterface Thing\n' } };
const HEADER = ['import continuum.ctxabc.*', 'fun continuumScriptk(a: Int, b: List<String>): Any? = run {'];

test('document URIs use the virtual scheme and the key as file name', () => {
  assert.equal(documentUri('abc'), 'continuum-script:/abc.kt');
  assert.equal(documentUri('abc', '.kts'), 'continuum-script:/abc.kts');
});

test('the wrapper function name keeps identifier characters and turns the rest into underscores', () => {
  assert.equal(wrapperFunctionName('systest-abc-1'), 'continuumScriptsystest_abc_1');
  assert.equal(wrapperFunctionName('a_B9'), 'continuumScripta_B9');
});

test('a script without imports gets the header on top and the closing line below', () => {
  const woven = weaveScript('val x: Int = "a"', 'k', '.kt', CTX);
  assert.deepEqual(woven.text.split('\n'), [...HEADER, 'val x: Int = "a"', '}']);
  assert.equal(woven.uri, 'continuum-script:/k.kt');
  assert.equal(woven.headerLine, 0);
  assert.deepEqual(woven.toVirtualPosition({ line: 0, character: 13 }), { line: 2, character: 13 });
  assert.deepEqual(woven.toUserPosition({ line: 2, character: 13 }), { line: 0, character: 13 });
});

test('the header goes after the leading imports; blank and comment lines after them stay in the user text', () => {
  const woven = weaveScript('import a.B\n\n// note\nval x = 1', 'k', '.kt', CTX);
  assert.deepEqual(woven.text.split('\n'), ['import a.B', ...HEADER, '', '// note', 'val x = 1', '}']);
  assert.equal(woven.headerLine, 1);
  assert.deepEqual(woven.toVirtualPosition({ line: 3, character: 4 }), { line: 5, character: 4 });
});

test('a script of imports only gets the header at the end; an empty script is one empty line inside the wrapper', () => {
  assert.deepEqual(weaveScript('import a.B', 'k', '.kt', CTX).text.split('\n'), ['import a.B', ...HEADER, '}']);
  assert.deepEqual(weaveScript('', 'k', '.kt', CTX).text.split('\n'), [...HEADER, '', '}']);
});

test('line breaks of any kind in the user text become \\n', () => {
  assert.deepEqual(weaveScript('val a = 1\r\nval b = 2\rval c = 3', 'k', '.kt', CTX).text.split('\n'), [...HEADER, 'val a = 1', 'val b = 2', 'val c = 3', '}']);
});

test('positions in the hidden header and trailer have no counterpart in the user text', () => {
  const woven = weaveScript('val x = 1', 'k', '.kt', CTX);
  assert.equal(woven.toUserPosition({ line: 0, character: 3 }), undefined);
  assert.equal(woven.toUserPosition({ line: 1, character: 3 }), undefined);
  assert.equal(woven.toUserPosition({ line: 3, character: 0 }), undefined);
});

test('ranges map to the user text; those inside the hidden lines vanish and those touching them are clamped', () => {
  const woven = weaveScript('val x: Int = "a"', 'k', '.kt', CTX); // virtual lines: 0,1 header, 2 user, 3 trailer
  assert.deepEqual(woven.toUserRange({ start: { line: 2, character: 13 }, end: { line: 2, character: 16 } }), { start: { line: 0, character: 13 }, end: { line: 0, character: 16 } });
  assert.equal(woven.toUserRange({ start: { line: 1, character: 0 }, end: { line: 1, character: 40 } }), undefined);
  assert.equal(woven.toUserRange({ start: { line: 0, character: 0 }, end: { line: 1, character: 50 } }), undefined);
  assert.deepEqual(woven.toUserRange({ start: { line: 2, character: 3 }, end: { line: 3, character: 1 } }), { start: { line: 0, character: 3 }, end: { line: 0, character: 16 } });
  assert.deepEqual(woven.toUserRange({ start: { line: 1, character: 5 }, end: { line: 2, character: 4 } }), { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } });
});

test('user diagnostics keep the user-line diagnostics, re-positioned, and drop the hidden-line ones', () => {
  const woven = weaveScript('val x: Int = "a"', 'k', '.kt', CTX);
  const mapped = userDiagnostics(woven, [
    { range: { start: { line: 2, character: 13 }, end: { line: 2, character: 16 } }, severity: 1, code: 'TYPE_MISMATCH', message: 'm' },
    { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 10 } }, severity: 2, message: "Parameter 'row' is never used" },
  ]);
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].code, 'TYPE_MISMATCH');
  assert.deepEqual(mapped[0].range.start, { line: 0, character: 13 });
  assert.deepEqual(userDiagnostics(woven, undefined), []);
});

test('the unused row/flow warnings the editor hides are recognised', () => {
  assert.equal(isUnusedBindingWarning({ severity: 2, message: "Parameter 'row' is never used" }), true);
  assert.equal(isUnusedBindingWarning({ severity: 2, message: "Parameter 'a' is never used" }, ['a', 'b']), true);
  assert.equal(isUnusedBindingWarning({ severity: 2, message: "Parameter 'row' is never used" }, ['a', 'b']), false);
  assert.equal(isUnusedBindingWarning({ severity: 2, message: "Parameter 'flow' is never used, could be renamed to _" }), true);
  assert.equal(isUnusedBindingWarning({ severity: 1, message: "Parameter 'row' is never used" }), false);
  assert.equal(isUnusedBindingWarning({ severity: 2, message: "Variable 'x' is never used" }), false);
});

test('without a context the wrapper has no parameters and nothing is imported', () => {
  assert.deepEqual(weaveScript('val x = 1', 'k').text.split('\n'), ['', 'fun continuumScriptk(): Any? = run {', 'val x = 1', '}']);
});

test('the context document declares the reported declarations in the namespace package', () => {
  const doc = contextDocument(CTX.context, 'ctxabc');
  assert.equal(doc.uri, 'continuum-script:/ctxabc.kt');
  assert.equal(doc.text, 'package continuum.ctxabc\n\n/** Doc. */\ninterface Thing\n');
});

test('the reported context is built from the real source: row then flow, no package line, no imports', (t) => {
  const { context, skip } = reportedContextFromFeatureSource();
  if (skip) return t.skip(skip);
  assert.deepEqual(context.bindings.map((b) => b.name), ['row', 'flow']);
  assert.equal(context.language, 'kotlin');
  assert.doesNotMatch(context.declarations, /^(package|import)\s/m);
  assert.match(context.declarations, /^\/\*\*/);
  assert.match(context.declarations, /interface ScriptFlowVariables/);
});

test('a missing feature source is a skip with a reason, and the package line and leading blank lines are stripped from a given one', () => {
  assert.match(reportedContextFromFeatureSource('/nonexistent-dir').skip, /not there/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-'));
  const target = path.join(dir, 'features', 'continuum-feature-analytics', 'src', 'main', 'kotlin', 'org', 'projectcontinuum', 'feature', 'base', 'analytics', 'node');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'ScriptFlowVariables.kt'), 'package x.y\n\n/** K */\ninterface ScriptFlowVariables\n');
  assert.equal(reportedContextFromFeatureSource(dir).context.declarations, '/** K */\ninterface ScriptFlowVariables\n');
});
