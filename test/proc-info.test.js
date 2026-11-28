import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  descendantsOf, findListenerPid, isKotlinLanguageServer, kotlinServersUnder, listProcesses, parseCmdline, parseStatus, parseTcpTable,
  readCwd, readProcess,
} from '../lib/proc-info.mjs';

const STATUS_TEXT = [
  'Name:\tjava',
  'Umask:\t0022',
  'State:\tS (sleeping)',
  'Tgid:\t4242',
  'Pid:\t4242',
  'PPid:\t77',
  'VmPeak:\t 5000000 kB',
  'VmHWM:\t  954000 kB',
  'VmRSS:\t  901234 kB',
  'Threads:\t30',
].join('\n');

test('the status parser reads name, pid, parent and the resident-memory sizes in kB', () => {
  assert.deepEqual(parseStatus(STATUS_TEXT), { name: 'java', pid: 4242, ppid: 77, vmRssKb: 901234, vmHwmKb: 954000 });
});

test('a status without memory lines (a kernel thread) has undefined sizes, not NaN', () => {
  const parsed = parseStatus('Name:\tkthreadd\nPid:\t2\nPPid:\t0\n');
  assert.equal(parsed.vmRssKb, undefined);
  assert.equal(parsed.vmHwmKb, undefined);
  assert.equal(parsed.ppid, 0);
});

test('the status parser does not mistake VmRSS-like names (RssAnon) for VmRSS', () => {
  assert.equal(parseStatus('Pid:\t1\nPPid:\t0\nRssAnon:\t 10 kB\n').vmRssKb, undefined);
});

test('the command line parser splits on NUL and drops empty arguments', () => {
  assert.deepEqual(parseCmdline(Buffer.from('java\0-Xmx512m\0-cp\0a:b\0org.javacs.kt.MainKt\0')), ['java', '-Xmx512m', '-cp', 'a:b', 'org.javacs.kt.MainKt']);
  assert.deepEqual(parseCmdline(Buffer.alloc(0)), []);
});

test('the Kotlin language server is recognised by its main class or by its start script', () => {
  assert.equal(isKotlinLanguageServer({ cmdline: ['/usr/bin/java', '-Xmx512m', 'org.javacs.kt.MainKt'] }), true);
  assert.equal(isKotlinLanguageServer({ cmdline: ['/bin/sh', '/opt/continuum/kotlin-ls/server/bin/kotlin-language-server'] }), true);
  assert.equal(isKotlinLanguageServer({ cmdline: ['/opt/x/bin/kotlin-language-server'] }), true);
  assert.equal(isKotlinLanguageServer({ cmdline: ['node', 'lib/backend/main.js'] }), false);
  assert.equal(isKotlinLanguageServer({ cmdline: ['/usr/bin/vim', 'my-kotlin-language-server.txt'] }), false);
  assert.equal(isKotlinLanguageServer({ cmdline: [] }), false);
});

test('descendants are found transitively and not from unrelated trees', () => {
  const processes = [
    { pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 12, ppid: 11 }, { pid: 13, ppid: 10 },
    { pid: 20, ppid: 1 }, { pid: 21, ppid: 20 },
  ];
  assert.deepEqual(descendantsOf(10, processes).map((p) => p.pid).sort(), [11, 12, 13]);
  assert.deepEqual(descendantsOf(20, processes).map((p) => p.pid), [21]);
  assert.deepEqual(descendantsOf(99, processes), []);
});

test('a parent loop in the process table does not make the walk run forever', () => {
  const loop = [{ pid: 5, ppid: 6 }, { pid: 6, ppid: 5 }];
  assert.deepEqual(descendantsOf(5, loop).map((p) => p.pid), [6]);
});

test('the TCP table parser keeps port, state and inode (the port is hexadecimal)', () => {
  const table = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 555 1 0000 100 0 0 10 0',
    '   1: 0100007F:BB6E 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 556 1 0000 20 4 30 10 -1',
    '',
  ].join('\n');
  assert.deepEqual(parseTcpTable(table), [
    { localPort: 8080, state: '0A', inode: '555' },
    { localPort: 0xbb6e, state: '01', inode: '556' },
  ]);
});

// A fake /proc on disk: two processes, one listening socket, to cover the readers that touch the file system.
function fakeProc() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'systest-proc-'));
  const add = (pid, status, cmdline) => {
    fs.mkdirSync(path.join(root, String(pid), 'fd'), { recursive: true });
    fs.writeFileSync(path.join(root, String(pid), 'status'), status);
    fs.writeFileSync(path.join(root, String(pid), 'cmdline'), cmdline);
  };
  add(100, 'Name:\tnode\nPid:\t100\nPPid:\t1\nVmRSS:\t 1000 kB\n', 'node\0lib/backend/main.js\0');
  add(101, 'Name:\tjava\nPid:\t101\nPPid:\t100\nVmRSS:\t 900000 kB\n', 'java\0-Xmx512m\0org.javacs.kt.MainKt\0');
  fs.mkdirSync(path.join(root, 'net'));
  fs.writeFileSync(path.join(root, 'net', 'tcp'), [
    'header',
    '   0: 00000000:0BBE 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 9001 1 0',
  ].join('\n'));
  fs.symlinkSync('socket:[9001]', path.join(root, '100', 'fd', '7'));
  fs.symlinkSync('/tmp/somewhere', path.join(root, '100', 'cwd'));
  fs.writeFileSync(path.join(root, 'not-a-pid'), 'x');
  return root;
}

test('readers work on a /proc tree: one process, the list, the listener of a port, the Kotlin servers, the working directory', () => {
  const root = fakeProc();
  try {
    assert.deepEqual(readProcess(101, root), { name: 'java', pid: 101, ppid: 100, vmRssKb: 900000, vmHwmKb: undefined, cmdline: ['java', '-Xmx512m', 'org.javacs.kt.MainKt'] });
    assert.equal(readProcess(999, root), undefined);
    assert.deepEqual(listProcesses(root).map((p) => p.pid).sort(), [100, 101]);
    assert.equal(findListenerPid(3006, root), 100);
    assert.equal(findListenerPid(3007, root), undefined);
    assert.deepEqual(kotlinServersUnder(100, root).map((p) => p.pid), [101]);
    assert.deepEqual(kotlinServersUnder(101, root), []);
    assert.equal(readCwd(100, root), '/tmp/somewhere');
    assert.equal(readCwd(101, root), undefined);
    assert.deepEqual(listProcesses(path.join(root, 'missing')), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
