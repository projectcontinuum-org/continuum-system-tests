import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_METHODS, advertisedFeatures, workspacePromises, probeParams, promisesBeyond } from '../lib/lsp-capabilities.mjs';

const SERVED = [
  'textDocument/completion', 'textDocument/hover', 'textDocument/signatureHelp', 'textDocument/definition', 'textDocument/typeDefinition',
  'textDocument/references', 'textDocument/documentHighlight', 'textDocument/documentSymbol',
];

test('advertisedFeatures lists only the truthy *Provider keys, with the method each one promises', () => {
  const capabilities = {
    textDocumentSync: { openClose: true, change: 1 },
    completionProvider: { triggerCharacters: ['.'] },
    hoverProvider: true,
    renameProvider: false,
    codeActionProvider: null,
    definitionProvider: {},
    positionEncoding: 'utf-16',
  };
  assert.deepEqual(advertisedFeatures(capabilities), [
    { key: 'completionProvider', method: 'textDocument/completion' },
    { key: 'hoverProvider', method: 'textDocument/hover' },
    { key: 'definitionProvider', method: 'textDocument/definition' },
  ]);
  assert.deepEqual(advertisedFeatures(undefined), []);
});

test('a provider this table does not know is reported with an undefined method', () => {
  assert.deepEqual(advertisedFeatures({ brandNewProvider: true }), [{ key: 'brandNewProvider', method: undefined }]);
});

test('promisesBeyond names the promises outside the accepted methods and the unknown ones', () => {
  const kept = { completionProvider: {}, hoverProvider: true, documentSymbolProvider: true };
  assert.deepEqual(promisesBeyond(kept, SERVED), { unknown: [], unaccepted: [] });
  const wide = { ...kept, renameProvider: { prepareProvider: true }, workspaceSymbolProvider: true, fooProvider: 1 };
  assert.deepEqual(promisesBeyond(wide, SERVED), { unknown: ['fooProvider'], unaccepted: ['renameProvider (textDocument/rename)', 'workspaceSymbolProvider (workspace/symbol)'] });
});

test('workspacePromises spots folder support and file operations, and nothing in an absent or empty workspace section', () => {
  assert.deepEqual(workspacePromises({}), []);
  assert.deepEqual(workspacePromises({ workspace: {} }), []);
  assert.deepEqual(workspacePromises({ workspace: { workspaceFolders: { supported: false } } }), []);
  assert.deepEqual(workspacePromises({ workspace: { workspaceFolders: { supported: true, changeNotifications: true } } }), ['workspace.workspaceFolders']);
  assert.deepEqual(workspacePromises({ workspace: { fileOperations: { didCreate: {} } } }), ['workspace.fileOperations']);
});

test('probeParams builds the shape each method needs', () => {
  const uri = 'continuum-script:/k.kt';
  const position = { line: 2, character: 5 };
  assert.deepEqual(probeParams('textDocument/hover', uri, position), { textDocument: { uri }, position });
  assert.deepEqual(probeParams('textDocument/references', uri, position), { textDocument: { uri }, position, context: { includeDeclaration: true } });
  assert.deepEqual(probeParams('textDocument/documentSymbol', uri, position), { textDocument: { uri } });
  assert.deepEqual(probeParams('textDocument/rename', uri, position), { textDocument: { uri }, position, newName: 'renamed' });
  assert.deepEqual(probeParams('textDocument/codeAction', uri, position).range, { start: position, end: position });
  assert.deepEqual(probeParams('workspace/symbol', uri, position), { query: '' });
  assert.equal(probeParams('workspace/executeCommand', uri, position).command, 'systest.noop');
  assert.deepEqual(probeParams('textDocument/selectionRange', uri, position).positions, [position]);
});

test('every method in the table gets params with something to identify the request (no empty object)', () => {
  for (const method of Object.values(PROVIDER_METHODS)) {
    assert.ok(Object.keys(probeParams(method, 'continuum-script:/k.kt', { line: 0, character: 0 })).length > 0, method);
  }
});
