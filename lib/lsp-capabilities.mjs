// Judging what an LSP `initialize` answer promises, from outside. A server (or a bridge in front of it) that advertises a
// feature the next layer refuses breaks every client that trusts the advertisement: the editor offers rename or format,
// the user picks it and gets an error. These helpers turn an answer's `capabilities` into the list of methods a client may
// now call and into well-formed probe parameters for each of them, so a suite can call every promised method on a document
// it owns and see that none is refused. Pure functions, no I/O; unit-tested in test/lsp-capabilities.test.js.

/** Capability key -> the request method it promises (the LSP 3.17 names). */
export const PROVIDER_METHODS = Object.freeze({
  completionProvider: 'textDocument/completion',
  hoverProvider: 'textDocument/hover',
  signatureHelpProvider: 'textDocument/signatureHelp',
  declarationProvider: 'textDocument/declaration',
  definitionProvider: 'textDocument/definition',
  typeDefinitionProvider: 'textDocument/typeDefinition',
  implementationProvider: 'textDocument/implementation',
  referencesProvider: 'textDocument/references',
  documentHighlightProvider: 'textDocument/documentHighlight',
  documentSymbolProvider: 'textDocument/documentSymbol',
  codeActionProvider: 'textDocument/codeAction',
  codeLensProvider: 'textDocument/codeLens',
  documentLinkProvider: 'textDocument/documentLink',
  colorProvider: 'textDocument/documentColor',
  documentFormattingProvider: 'textDocument/formatting',
  documentRangeFormattingProvider: 'textDocument/rangeFormatting',
  documentOnTypeFormattingProvider: 'textDocument/onTypeFormatting',
  renameProvider: 'textDocument/rename',
  foldingRangeProvider: 'textDocument/foldingRange',
  selectionRangeProvider: 'textDocument/selectionRange',
  executeCommandProvider: 'workspace/executeCommand',
  workspaceSymbolProvider: 'workspace/symbol',
  semanticTokensProvider: 'textDocument/semanticTokens/full',
  inlayHintProvider: 'textDocument/inlayHint',
  callHierarchyProvider: 'textDocument/prepareCallHierarchy',
  typeHierarchyProvider: 'textDocument/prepareTypeHierarchy',
  linkedEditingRangeProvider: 'textDocument/linkedEditingRange',
  diagnosticProvider: 'textDocument/diagnostic',
});

const isPromised = (value) => value !== undefined && value !== null && value !== false;

/**
 * Every feature the capabilities promise: the truthy `*Provider` keys, as `{ key, method }`. `method` is undefined for a
 * provider this table does not know (a suite reports those instead of silently trusting them).
 */
export function advertisedFeatures(capabilities) {
  return Object.entries(capabilities ?? {})
    .filter(([key, value]) => /Provider$/.test(key) && isPromised(value))
    .map(([key]) => ({ key, method: PROVIDER_METHODS[key] }));
}

/** Workspace-level promises a bridge with one private workspace cannot keep: folders changes and file operations. */
export function workspacePromises(capabilities) {
  const workspace = capabilities?.workspace ?? {};
  const promises = [];
  if (isPromised(workspace.workspaceFolders?.supported) || isPromised(workspace.workspaceFolders?.changeNotifications)) {
    promises.push('workspace.workspaceFolders');
  }
  if (workspace.fileOperations && Object.keys(workspace.fileOperations).length > 0) {
    promises.push('workspace.fileOperations');
  }
  return promises;
}

/** Well-formed parameters for a request of `method` on the document `uri`, at `position` (a zero-width range there). */
export function probeParams(method, uri, position) {
  const textDocument = { uri };
  const range = { start: position, end: position };
  const options = { tabSize: 4, insertSpaces: true };
  switch (method) {
    case 'textDocument/references':
      return { textDocument, position, context: { includeDeclaration: true } };
    case 'textDocument/documentSymbol':
    case 'textDocument/foldingRange':
    case 'textDocument/codeLens':
    case 'textDocument/documentLink':
    case 'textDocument/documentColor':
    case 'textDocument/semanticTokens/full':
    case 'textDocument/diagnostic':
      return { textDocument };
    case 'textDocument/codeAction':
      return { textDocument, range, context: { diagnostics: [] } };
    case 'textDocument/formatting':
      return { textDocument, options };
    case 'textDocument/rangeFormatting':
      return { textDocument, range, options };
    case 'textDocument/onTypeFormatting':
      return { textDocument, position, ch: '}', options };
    case 'textDocument/rename':
      return { textDocument, position, newName: 'renamed' };
    case 'textDocument/inlayHint':
      return { textDocument, range };
    case 'textDocument/selectionRange':
      return { textDocument, positions: [position] };
    case 'workspace/symbol':
      return { query: '' };
    case 'workspace/executeCommand':
      return { command: 'systest.noop', arguments: [] };
    default:
      return { textDocument, position };
  }
}

/**
 * Compares what an answer promises with the methods a layer accepts: `{ unknown, unaccepted }`, the keys that map to no
 * known method and the ones whose method is outside `accepted` (an empty list for both: the promise can be kept).
 */
export function promisesBeyond(capabilities, accepted) {
  const allowed = new Set(accepted);
  const features = advertisedFeatures(capabilities);
  return {
    unknown: features.filter((feature) => feature.method === undefined).map((feature) => feature.key),
    unaccepted: features.filter((feature) => feature.method !== undefined && !allowed.has(feature.method)).map((feature) => `${feature.key} (${feature.method})`),
  };
}
