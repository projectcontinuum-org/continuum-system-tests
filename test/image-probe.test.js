import test from 'node:test';
import assert from 'node:assert/strict';
import {
  megabytes, parseJavaVersion, parseModules, parseDu, parseMarker, parsePin, parseSummary, parseResultLines, groupTotals,
  ownedName, isOwnedName, describeImage, startDifferences, addedEnvironment, hasKotlinSupport, lineChanges, seededSettingsProblems,
  stdlibVersion, mavenStdlibPath, parseMemoryStat, parseUid, configurationDirectory, compareFailures, serverErrorSummary,
} from '../lib/image-probe.mjs';

test('megabytes rounds to whole MiB', () => {
  assert.equal(megabytes(1048576), 1);
  assert.equal(megabytes(4788550192), 4567);
  assert.equal(megabytes(0), 0);
});

test('parseJavaVersion reads the modern and the legacy format, and nothing from other text', () => {
  const modern = 'openjdk version "21.0.13.1" 2026-11-17 LTS\nOpenJDK Runtime Environment Temurin-21.0.13.1+11 (build 21.0.13.1+11-LTS)\nOpenJDK 64-Bit Server VM Temurin-21.0.13.1+11 (build 21.0.13.1+11-LTS, mixed mode, sharing)\n';
  assert.deepEqual(parseJavaVersion(modern), { version: '21.0.13.1', major: 21, runtime: 'OpenJDK Runtime Environment Temurin-21.0.13.1+11 (build 21.0.13.1+11-LTS)' });
  assert.equal(parseJavaVersion('openjdk version "17.0.2" 2022-01-18').major, 17);
  assert.equal(parseJavaVersion('java version "1.8.0_392"').major, 8);
  assert.equal(parseJavaVersion('bash: java: command not found'), undefined);
  assert.equal(parseJavaVersion(undefined), undefined);
});

test('parseModules strips versions and keeps only module names', () => {
  const text = 'java.base@21.0.13.1\njava.desktop@21.0.13.1\n  jdk.unsupported@21.0.13.1  \n\nWARNING: something odd\n';
  assert.deepEqual(parseModules(text), ['java.base', 'java.desktop', 'jdk.unsupported']);
  assert.deepEqual(parseModules(''), []);
});

test('parseDu maps paths to megabytes, paths with spaces included', () => {
  assert.deepEqual(parseDu('149\t/opt/continuum/kotlin-ls\n57\t/opt/continuum/kotlin-ls/jre\n3\t/a dir/with space\n'), {
    '/opt/continuum/kotlin-ls': 149, '/opt/continuum/kotlin-ls/jre': 57, '/a dir/with space': 3,
  });
  assert.deepEqual(parseDu('du: cannot access /nope: No such file or directory\n'), {});
});

test('parseMarker needs a version and a 64-digit lowercase hex checksum', () => {
  const sha = '4fe7d71d087b307c7869036171bd9d8c6a4284cd7c25b89098b0a24eb2d9b6d2';
  assert.deepEqual(parseMarker(`1.3.13 ${sha}\n`), { version: '1.3.13', sha256: sha });
  assert.equal(parseMarker('1.3.13 abc'), undefined);
  assert.equal(parseMarker(`1.3.13 ${sha.toUpperCase()}`), undefined);
  assert.equal(parseMarker(''), undefined);
});

test('parsePin reads VERSION and SHA256 from the download script and ignores other assignments', () => {
  const script = '#!/usr/bin/env bash\nset -euo pipefail\n\nVERSION="1.3.13"\nSHA256="4fe7d71d087b307c7869036171bd9d8c6a4284cd7c25b89098b0a24eb2d9b6d2"\nURL="${KOTLIN_LS_URL:-x}"\n  VERSION="indented is not the pin"\n';
  assert.deepEqual(parsePin(script), { version: '1.3.13', sha256: '4fe7d71d087b307c7869036171bd9d8c6a4284cd7c25b89098b0a24eb2d9b6d2' });
  assert.equal(parsePin('VERSION="1"\n'), undefined);
  assert.equal(parsePin(undefined), undefined);
});

test('parseSummary reads the suite summary line', () => {
  assert.deepEqual(parseSummary('x\n\n48 passed, 2 failed, 3 skipped (NOT VERIFIED), 1 known gaps, 54 checks\n'), { pass: 48, fail: 2, skip: 3, knownGap: 1, total: 54 });
  assert.equal(parseSummary('no summary'), undefined);
});

const OUTPUT = [
  'kotlin-lsp-bridge  http://127.0.0.1:8080  run abc  (offline)  backend pid 1  idle timeout 15 s',
  'PASS      handshake  the bridge refuses a connection without the token  -- HTTP 400',
  'FAIL      diagnostics  typing `flow.` offers get, set and all  -- 7 items, first: get',
  'SKIP      offline  precondition  -- NOT VERIFIED: x',
  'KNOWN GAP lifecycle  a known thing  -- detail  -- with a second separator',
  'PASS      diagnostics  name without a detail',
  '',
  '1 passed, 1 failed, 1 skipped (NOT VERIFIED), 1 known gaps, 4 checks',
].join('\n');

test('parseResultLines reads status, group, name and detail, and skips headers and the summary', () => {
  const results = parseResultLines(OUTPUT);
  assert.equal(results.length, 5);
  assert.deepEqual(results[0], { status: 'PASS', group: 'handshake', name: 'the bridge refuses a connection without the token', detail: 'HTTP 400' });
  assert.deepEqual(results[1], { status: 'FAIL', group: 'diagnostics', name: 'typing `flow.` offers get, set and all', detail: '7 items, first: get' });
  assert.equal(results[2].status, 'SKIP');
  assert.equal(results[3].status, 'KNOWN GAP');
  assert.equal(results[3].detail, 'detail  -- with a second separator');
  assert.deepEqual(results[4], { status: 'PASS', group: 'diagnostics', name: 'name without a detail', detail: '' });
});

test('groupTotals counts each status per group in order of appearance and lists the failing names', () => {
  const totals = groupTotals(parseResultLines(OUTPUT));
  assert.deepEqual(totals.map((t) => t.group), ['handshake', 'diagnostics', 'offline', 'lifecycle']);
  const diagnostics = totals.find((t) => t.group === 'diagnostics');
  assert.equal(diagnostics.pass, 1);
  assert.equal(diagnostics.fail, 1);
  assert.deepEqual(diagnostics.failing, ['typing `flow.` offers get, set and all']);
  assert.equal(totals.find((t) => t.group === 'offline').skip, 1);
  assert.equal(totals.find((t) => t.group === 'lifecycle').knownGap, 1);
});

test('ownedName builds <prefix>-<runId>-<role> and refuses anything that could name a foreign resource', () => {
  assert.equal(ownedName('kotlin-lsp-systest', 'mwz88jo1', 'asis'), 'kotlin-lsp-systest-mwz88jo1-asis');
  assert.throws(() => ownedName('kotlin-lsp-systest', 'RUN', 'asis'));
  assert.throws(() => ownedName('kotlin-lsp-systest', 'abc', 'a b'));
  assert.throws(() => ownedName('', 'abc', 'asis'));
  assert.throws(() => ownedName('x;rm', 'abc', 'asis'));
});

test('isOwnedName accepts only names of this run, so a docker rm can never reach another container', () => {
  const name = ownedName('kotlin-lsp-systest', 'abc123', 'asis');
  assert.equal(isOwnedName(name, 'kotlin-lsp-systest', 'abc123'), true);
  assert.equal(isOwnedName('kotlin-lsp-systest-abc123-', 'kotlin-lsp-systest', 'abc123'), false);
  assert.equal(isOwnedName('kotlin-lsp-systest-other-asis', 'kotlin-lsp-systest', 'abc123'), false);
  assert.equal(isOwnedName('continuum-api-server', 'kotlin-lsp-systest', 'abc123'), false);
  assert.equal(isOwnedName('kotlin-lsp-systest-abc123-a b', 'kotlin-lsp-systest', 'abc123'), false);
  assert.equal(isOwnedName(undefined, 'kotlin-lsp-systest', 'abc123'), false);
});

const inspect = (overrides = {}) => [{
  Size: 4788550192,
  Config: {
    Entrypoint: ['continuum-entrypoint.sh'],
    Cmd: ['lib/backend/main.js', '/home/continuum/workspace', '-p', '8080'],
    WorkingDir: '/app',
    User: 'root',
    ExposedPorts: { '8080/tcp': {} },
    Env: ['PATH=/usr/bin', 'NODE_VERSION=24', 'CONTINUUM_KOTLIN_LS_HOME=/opt/continuum/kotlin-ls', 'FLAG'],
    ...overrides,
  },
}];

test('describeImage reads the start configuration, env as a map, and the size', () => {
  const image = describeImage(inspect());
  assert.deepEqual(image.entrypoint, ['continuum-entrypoint.sh']);
  assert.equal(image.workingDir, '/app');
  assert.deepEqual(image.ports, ['8080/tcp']);
  assert.equal(image.env.CONTINUUM_KOTLIN_LS_HOME, '/opt/continuum/kotlin-ls');
  assert.equal(image.env.FLAG, '');
  assert.equal(image.sizeBytes, 4788550192);
  assert.deepEqual(describeImage({}), { entrypoint: [], cmd: [], workingDir: '', user: '', ports: [], env: {}, sizeBytes: 0 });
});

test('startDifferences is empty for alike images and names each changed setting', () => {
  const image = describeImage(inspect());
  assert.deepEqual(startDifferences(image, describeImage(inspect())), []);
  const changed = describeImage(inspect({ Entrypoint: ['other.sh'], WorkingDir: '/srv' }));
  const differences = startDifferences(changed, image);
  assert.equal(differences.length, 2);
  assert.match(differences[0], /^entrypoint: .*continuum-entrypoint\.sh.* -> .*other\.sh/);
  assert.match(differences[1], /^workingDir: "\/app" -> "\/srv"/);
});

test('addedEnvironment lists only variables the baseline lacks, ignoring PATH', () => {
  const baseline = describeImage(inspect({ Env: ['PATH=/a', 'NODE_VERSION=24'] }));
  const image = describeImage(inspect({ Env: ['PATH=/b', 'NODE_VERSION=24', 'CONTINUUM_JAVA_HOME=/j'] }));
  assert.deepEqual(addedEnvironment(image, baseline), { CONTINUUM_JAVA_HOME: '/j' });
});

test('hasKotlinSupport tells a release from before the feature from an image that already carries it', () => {
  assert.equal(hasKotlinSupport(describeImage(inspect())), true);
  assert.equal(hasKotlinSupport(describeImage(inspect({ Env: ['PATH=/a', 'NODE_VERSION=24'] }))), false);
  assert.equal(hasKotlinSupport(describeImage(inspect({ Env: ['CONTINUUM_KOTLIN_LS_HOME='] }))), false);
  assert.equal(hasKotlinSupport(describeImage({})), false);
  assert.equal(hasKotlinSupport(undefined), false);
});

test('lineChanges reports added and removed lines regardless of order and blank lines', () => {
  const before = '#!/bin/sh\nset -eu\n\nmkdir -p x\nexec run "$@"\n';
  const after = '#!/bin/sh\nset -eu\n\nmkdir -p x\n# Point the extension at the bundled server\nnode /opt/seed.js || echo failed >&2\n\nexec run "$@"\n';
  assert.deepEqual(lineChanges(before, after), { added: ['# Point the extension at the bundled server', 'node /opt/seed.js || echo failed >&2'], removed: [] });
  assert.deepEqual(lineChanges(after, before).removed, ['# Point the extension at the bundled server', 'node /opt/seed.js || echo failed >&2']);
  assert.deepEqual(lineChanges('a\na\nb\n', 'a\nb\nb\n'), { added: ['b'], removed: ['a'] });
  assert.deepEqual(lineChanges('same\n', 'same\n'), { added: [], removed: [] });
});

const GOOD_SETTINGS = {
  'editor.fontSize': 20,
  'kotlin.languageServer.enabled': true,
  'kotlin.languageServer.path': '/opt/continuum/kotlin-ls/bin/kotlin-language-server',
  'kotlin.java.home': '/opt/continuum/kotlin-ls/jre',
  'kotlin.java.opts': '-Xmx512m -XX:+UseSerialGC',
  'kotlin.scripts.enabled': true,
  'kotlin.debugAdapter.enabled': false,
};

test('seededSettingsProblems accepts the seeded settings and names every wrong or missing key', () => {
  assert.deepEqual(seededSettingsProblems(GOOD_SETTINGS, '/opt/continuum/kotlin-ls'), []);
  const broken = { ...GOOD_SETTINGS, 'kotlin.java.home': '', 'kotlin.java.opts': 'stale' };
  delete broken['kotlin.scripts.enabled'];
  const problems = seededSettingsProblems(broken, '/opt/continuum/kotlin-ls');
  assert.equal(problems.length, 3);
  assert.ok(problems.some((p) => p.startsWith('kotlin.java.home is ""')));
  assert.ok(problems.some((p) => p.startsWith('kotlin.scripts.enabled is undefined')));
  assert.ok(problems.some((p) => p.startsWith('kotlin.java.opts has no -Xmx')));
  assert.deepEqual(seededSettingsProblems(null, '/x'), ['settings.json is not a JSON object']);
  assert.ok(seededSettingsProblems(GOOD_SETTINGS, '/elsewhere').length >= 2);
});

test('seededSettingsProblems wants the launcher, not the server\'s own start script, as the server command', () => {
  const direct = { ...GOOD_SETTINGS, 'kotlin.languageServer.path': '/opt/continuum/kotlin-ls/server/bin/kotlin-language-server' };
  const problems = seededSettingsProblems(direct, '/opt/continuum/kotlin-ls');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^kotlin\.languageServer\.path is .*server\/bin.*expected .*\/opt\/continuum\/kotlin-ls\/bin\/kotlin-language-server/);
});

test('stdlibVersion finds the plain stdlib jar and ignores the variants', () => {
  const listing = 'kotlin-stdlib-jdk8-1.8.0.jar\nkotlin-stdlib-common-1.9.0.jar\nkotlin-stdlib-2.1.0-sources.jar\nkotlin-stdlib-2.1.0.jar\nserver-1.3.13.jar\n';
  assert.equal(stdlibVersion(listing), '2.1.0');
  assert.equal(stdlibVersion('server-1.3.13.jar\n'), undefined);
  assert.equal(mavenStdlibPath('/opt/continuum/kotlin-ls/m2', '2.1.0'), '/opt/continuum/kotlin-ls/m2/org/jetbrains/kotlin/kotlin-stdlib/2.1.0/kotlin-stdlib-2.1.0.jar');
});

test('parseMemoryStat reads anon and file from a cgroup v2 memory.stat', () => {
  assert.deepEqual(parseMemoryStat('anon 612368384\nfile 405528576\nkernel_stack 1\n'), { anon: 612368384, file: 405528576 });
  assert.deepEqual(parseMemoryStat(''), { anon: undefined, file: undefined });
});

test('parseUid reads the real uid of /proc/<pid>/status', () => {
  assert.equal(parseUid('Name:\tnode\nUmask:\t0022\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\n'), 1000);
  assert.equal(parseUid('Uid:\t0\t0\t0\t0'), 0);
  assert.equal(parseUid('nothing'), undefined);
});

test('configurationDirectory reads the folder Theia says it uses', () => {
  assert.equal(configurationDirectory("2026-11-27 info Configuration directory URI: 'file:///home/continuum/.continuum'\nother"), '/home/continuum/.continuum');
  assert.equal(configurationDirectory("Configuration directory URI: '/tmp/x'"), '/tmp/x');
  assert.equal(configurationDirectory('no such line'), undefined);
});

test('serverErrorSummary counts each distinct internal error once with its root cause, and the out-of-memory mentions', () => {
  const log = [
    '2026-11-27T16:30:27.406Z root INFO [language-server] [server stderr] Nov 27, 2026 10:00:27 PM org.eclipse.lsp4j.jsonrpc.RemoteEndpoint fallbackResponseError',
    'SEVERE: Internal error: java.lang.RuntimeException: Reached end of file before reaching char 5',
    'java.util.concurrent.CompletionException: java.lang.RuntimeException: Reached end of file before reaching char 5',
    '\tat java.base/java.util.concurrent.CompletableFuture.encodeThrowable(CompletableFuture.java:315)',
    'Caused by: java.lang.RuntimeException: Reached end of file before reaching char 5',
    '\tat org.javacs.kt.position.PositionKt.offset(Position.kt:54)',
    '\t... 3 more',
    '2026-11-27T16:30:29.506Z root INFO [language-server] [server stderr] Nov 27, 2026 10:00:29 PM org.eclipse.lsp4j.jsonrpc.RemoteEndpoint fallbackResponseError',
    'SEVERE: Internal error: java.lang.RuntimeException: Reached end of file before reaching char 5',
    'Caused by: java.lang.RuntimeException: Reached end of file before reaching char 5',
    'SEVERE: Internal error: java.util.concurrent.CompletionException: java.lang.OutOfMemoryError: Java heap space',
    'Caused by: java.lang.OutOfMemoryError: Java heap space',
    '\tat java.base/java.util.Arrays.copyOf(Arrays.java:3481)',
    '',
    'Caused by: not part of the earlier trace',
  ].join('\n');
  const summary = serverErrorSummary(log);
  assert.equal(summary.outOfMemory, 2);
  assert.deepEqual(summary.errors, [
    { message: 'java.lang.RuntimeException: Reached end of file before reaching char 5', count: 2, cause: 'java.lang.RuntimeException: Reached end of file before reaching char 5' },
    { message: 'java.util.concurrent.CompletionException: java.lang.OutOfMemoryError: Java heap space', count: 1, cause: 'java.lang.OutOfMemoryError: Java heap space' },
  ]);
  assert.deepEqual(serverErrorSummary(''), { outOfMemory: 0, errors: [] });
  assert.deepEqual(serverErrorSummary(undefined), { outOfMemory: 0, errors: [] });
});

test('compareFailures separates what a second run fixed, what persists and what it newly breaks', () => {
  const run = (...failing) => failing.map(([group, name]) => ({ status: 'FAIL', group, name })).concat([{ status: 'PASS', group: 'g', name: 'fine' }]);
  const first = run(['diagnostics', 'a'], ['diagnostics', 'b'], ['lifecycle', 'c']);
  const second = run(['lifecycle', 'c'], ['memory', 'd']);
  assert.deepEqual(compareFailures(first, second), {
    fixed: ['diagnostics: a', 'diagnostics: b'],
    persisting: ['lifecycle: c'],
    introduced: ['memory: d'],
  });
  assert.deepEqual(compareFailures([], []), { fixed: [], persisting: [], introduced: [] });
});
