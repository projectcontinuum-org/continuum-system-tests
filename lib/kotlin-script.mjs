// What the workbench's Kotlin Script editor puts around a user's script before it asks the language server about it,
// re-implemented here from its documented behaviour so the suite stays black-box (it imports no platform code).
//
// The names a script can use are reported by the node (`options.scriptContext` of the field's UI schema: bindings with
// name and type, and the declarations of the types they use). The editor shows the server two documents: a hidden
// context document `continuum-script:/<namespace>.kt` that declares them in package `continuum.<namespace>`, and the
// script itself, the user's lines unchanged, with a two-line hidden header after the user's leading imports (the import
// of that package and the wrapper function whose parameters are the bindings) and one closing line. Header lines are
// whole lines, so a user line keeps its columns; only line numbers shift. The context document has to be open and
// answered (any request on it) before the script is opened, or the script's first diagnostics can be lost.
//
// Pure functions only, except `reportedContextFromFeatureSource`, which reads one file; unit-tested in test/kotlin-script.test.js.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Members of the `flow` binding that completion must offer (name -> signature as the editor documents it). */
export const FLOW_MEMBERS = ['all', 'get', 'set'];

const FEATURE_SOURCE = ['features', 'continuum-feature-analytics', 'src', 'main', 'kotlin', 'org', 'projectcontinuum', 'feature', 'base', 'analytics', 'node', 'ScriptFlowVariables.kt'];

/** The binding types the node reports for `row` (an input row) and `flow` (the flow variables). */
const ROW_TYPE = 'Map<String, Any>';
const FLOW_TYPE = 'ScriptFlowVariables';

/** Where the node's API source is, relative to a `continuum-feature-base` checkout (`baseDir`, else the sibling one). */
export function featureSourceFile(baseDir) {
  const dir = baseDir || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'continuum-feature-base');
  return path.join(dir, ...FEATURE_SOURCE);
}

/**
 * The `scriptContext` the Kotlin Script node reports, built from the real source of its API interface (the sibling repository
 * `continuum-feature-base`, or `FEATURE_BASE_DIR`): bindings `row` then `flow`, declarations = the file without its package line.
 * Returns `{ context }`, or `{ skip }` with the reason when the source is not there.
 */
export function reportedContextFromFeatureSource(baseDir = process.env.FEATURE_BASE_DIR) {
  const file = featureSourceFile(baseDir);
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch {
    return { skip: `the feature source ${file} is not there (clone continuum-feature-base next to this repository or set FEATURE_BASE_DIR)` };
  }
  const declarations = source.replace(/^package .*\r?\n/m, '').replace(/^(\s*\r?\n)+/, '');
  return {
    context: {
      language: 'kotlin',
      bindings: [{ name: 'row', type: ROW_TYPE }, { name: 'flow', type: FLOW_TYPE }],
      declarations,
    },
  };
}

/** The package, and the key of the hidden context document, for a namespace (letters and digits only). */
export const contextPackage = (namespace) => `continuum.${namespace}`;

/** `{ uri, text }` of the hidden context document that declares `context` in package `continuum.<namespace>`. */
export function contextDocument(context, namespace) {
  return { uri: documentUri(namespace), text: `package ${contextPackage(namespace)}\n\n${context.declarations.replace(/\s*$/, '')}\n` };
}

const IMPORT_LINE = /^\s*import\s+\S/;
const SKIPPABLE_LINE = /^\s*(\/\/.*)?$/;
const LINE_BREAK = /\r\n|\r|\n/;

/** `continuum-script:/<key><extension>`, the only document URI scheme the bridge accepts for the Kotlin registration. */
export function documentUri(key, extension = '.kt') {
  return `continuum-script:/${key}${extension}`;
}

/** The wrapper function's name for a document key (anything that is not an identifier character becomes `_`). */
export function wrapperFunctionName(key) {
  return `continuumScript${key.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function lineAfterLeadingImports(userLines) {
  let afterLastImport = 0;
  for (let index = 0; index < userLines.length; index++) {
    if (IMPORT_LINE.test(userLines[index])) {
      afterLastImport = index + 1;
    } else if (!SKIPPABLE_LINE.test(userLines[index])) {
      break;
    }
  }
  return afterLastImport;
}

/**
 * Weaves `userText` into the virtual document for `key`. `scriptContext` is `{ context, namespace }` of an open context
 * document; without it the wrapper has no parameters and imports nothing.
 * Returns `{ uri, text, headerLine, userLineCount, toVirtualPosition, toUserPosition, toUserRange }`:
 * - `text`: what to send in `textDocument/didOpen` (lines joined with `\n`),
 * - `toVirtualPosition({line, character})`: a position of the user's text in the virtual text,
 * - `toUserPosition(position)`: a position of the virtual text in the user's text, `undefined` inside hidden lines,
 * - `toUserRange(range)`: like the editor, hidden-line ends are clamped to the user's text; `undefined` when nothing of
 *   the range lies in the user's text.
 */
export function weaveScript(userText, key, extension = '.kt', scriptContext = undefined) {
  const userLines = userText.split(LINE_BREAK);
  const headerLine = lineAfterLeadingImports(userLines);
  const parameters = (scriptContext?.context.bindings ?? []).map((binding) => `${binding.name}: ${binding.type}`).join(', ');
  const header = [
    scriptContext ? `import ${contextPackage(scriptContext.namespace)}.*` : '',
    `fun ${wrapperFunctionName(key)}(${parameters}): Any? = run {`,
  ];
  const virtualLines = [];
  const virtualToUser = [];
  const userToVirtual = [];
  userLines.forEach((line, index) => {
    if (index === headerLine) {
      header.forEach((hidden) => { virtualLines.push(hidden); virtualToUser.push(undefined); });
    }
    userToVirtual.push(virtualLines.length);
    virtualToUser.push(index);
    virtualLines.push(line);
  });
  if (headerLine === userLines.length) {
    header.forEach((hidden) => { virtualLines.push(hidden); virtualToUser.push(undefined); });
  }
  virtualLines.push('}');
  virtualToUser.push(undefined);

  const nearestUserLine = (virtualLine, direction) => {
    for (let line = virtualLine + direction; line >= 0 && line < virtualToUser.length; line += direction) {
      if (virtualToUser[line] !== undefined) {
        return virtualToUser[line];
      }
    }
    return undefined;
  };

  const toUserPosition = ({ line, character }) => (virtualToUser[line] === undefined ? undefined : { line: virtualToUser[line], character });
  return {
    uri: documentUri(key, extension),
    text: virtualLines.join('\n'),
    headerLine,
    userLineCount: userLines.length,
    toVirtualPosition: ({ line, character }) => ({ line: userToVirtual[Math.min(Math.max(line, 0), userLines.length - 1)], character }),
    toUserPosition,
    toUserRange: ({ start, end }) => {
      let from = toUserPosition(start);
      let to = toUserPosition(end);
      let clamped = false;
      if (!from) {
        const next = nearestUserLine(start.line, 1);
        from = next === undefined ? undefined : { line: next, character: 0 };
        clamped = true;
      }
      if (!to) {
        const previous = nearestUserLine(end.line, -1);
        to = previous === undefined ? undefined : { line: previous, character: userLines[previous].length };
        clamped = true;
      }
      if (!from || !to) {
        return undefined;
      }
      const order = from.line !== to.line ? from.line - to.line : from.character - to.character;
      return order > 0 || (clamped && order === 0) ? undefined : { start: from, end: to };
    },
  };
}

/**
 * The diagnostics of a `publishDiagnostics` notification that lie in the user's text, mapped to the user's positions.
 * Diagnostics inside the hidden header or trailer are dropped, as in the editor.
 */
export function userDiagnostics(woven, diagnostics) {
  const mapped = [];
  for (const diagnostic of diagnostics || []) {
    const range = woven.toUserRange(diagnostic.range);
    if (range) {
      mapped.push({ ...diagnostic, range });
    }
  }
  return mapped;
}

/** True for the warnings the editor hides because a wrapper parameter (one of `names`) is unused when a script reads only some. */
export function isUnusedBindingWarning(diagnostic, names = ['row', 'flow']) {
  return diagnostic.severity === 2 && new RegExp(`^Parameter '(${names.join('|')})' is never used`).test(diagnostic.message || '');
}
