// Read-only views of the Linux process table (`/proc`) for the suites that have to count and measure the processes a
// backend spawns: which process listens on a port, which processes descend from it, a process's command line, working
// directory and resident memory. Node only (node:fs). The parsers are pure and unit-tested in test/proc-info.test.js;
// only the `read*`/`list*`/`find*` functions touch the file system, and they take the proc root as a parameter.
import fs from 'node:fs';
import path from 'node:path';

/** Parses the text of `/proc/<pid>/status`. Sizes are kB as the kernel reports them. */
export function parseStatus(text) {
  const field = (name) => {
    const match = new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(text);
    return match ? match[1].trim() : undefined;
  };
  const kb = (name) => {
    const value = field(name);
    return value === undefined ? undefined : Number.parseInt(value, 10);
  };
  return {
    name: field('Name'),
    pid: Number.parseInt(field('Pid') ?? '', 10),
    ppid: Number.parseInt(field('PPid') ?? '', 10),
    vmRssKb: kb('VmRSS'),
    vmHwmKb: kb('VmHWM'),
  };
}

/** Parses the NUL-separated `/proc/<pid>/cmdline` (empty arguments are dropped). */
export function parseCmdline(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  return text.split('\0').filter((part) => part !== '');
}

/** One process of `proc` (`/proc` by default), or `undefined` when it is gone or not readable. */
export function readProcess(pid, proc = '/proc') {
  try {
    const status = parseStatus(fs.readFileSync(path.join(proc, String(pid), 'status'), 'utf8'));
    let cmdline = [];
    try {
      cmdline = parseCmdline(fs.readFileSync(path.join(proc, String(pid), 'cmdline')));
    } catch {
      // the process vanished between the two reads, or its command line is hidden
    }
    return { ...status, pid, cmdline };
  } catch {
    return undefined;
  }
}

/** Every readable process of `proc`. */
export function listProcesses(proc = '/proc') {
  let entries = [];
  try {
    entries = fs.readdirSync(proc).filter((entry) => /^\d+$/.test(entry));
  } catch {
    return [];
  }
  return entries.map((entry) => readProcess(Number(entry), proc)).filter(Boolean);
}

/** All transitive children of `rootPid` among `processes`, oldest generation first. */
export function descendantsOf(rootPid, processes) {
  const byParent = new Map();
  for (const process_ of processes) {
    byParent.set(process_.ppid, [...(byParent.get(process_.ppid) ?? []), process_]);
  }
  const found = [];
  const queue = [rootPid];
  const seen = new Set(queue);
  while (queue.length > 0) {
    for (const child of byParent.get(queue.shift()) ?? []) {
      if (!seen.has(child.pid)) {
        seen.add(child.pid);
        found.push(child);
        queue.push(child.pid);
      }
    }
  }
  return found;
}

/** True for the Kotlin language server's JVM (`org.javacs.kt.MainKt`) or its start script. */
export function isKotlinLanguageServer(processInfo) {
  const joined = processInfo.cmdline.join(' ');
  return joined.includes('org.javacs.kt.MainKt') || /(^|\/)kotlin-language-server$/.test(processInfo.cmdline[1] ?? processInfo.cmdline[0] ?? '');
}

/** The Kotlin language server processes that descend from `backendPid` right now. */
export function kotlinServersUnder(backendPid, proc = '/proc') {
  return descendantsOf(backendPid, listProcesses(proc)).filter(isKotlinLanguageServer);
}

/** Parses `/proc/net/tcp` or `/proc/net/tcp6` into `{ localPort, state, inode }` rows (`state` is the kernel's hex code, `0A` = LISTEN). */
export function parseTcpTable(text) {
  return text.split('\n').slice(1).map((line) => line.trim().split(/\s+/)).filter((columns) => columns.length >= 10).map((columns) => ({
    localPort: Number.parseInt(columns[1].split(':')[1], 16),
    state: columns[3],
    inode: columns[9],
  }));
}

/** The pid of the process that listens on `port`, or `undefined` (none, or not visible to this user). */
export function findListenerPid(port, proc = '/proc') {
  const inodes = new Set();
  for (const table of ['net/tcp', 'net/tcp6']) {
    try {
      parseTcpTable(fs.readFileSync(path.join(proc, table), 'utf8'))
        .filter((row) => row.state === '0A' && row.localPort === port)
        .forEach((row) => inodes.add(row.inode));
    } catch {
      // no IPv6 table, or no /proc/net
    }
  }
  if (inodes.size === 0) {
    return undefined;
  }
  for (const process_ of listProcesses(proc)) {
    let descriptors = [];
    try {
      descriptors = fs.readdirSync(path.join(proc, String(process_.pid), 'fd'));
    } catch {
      continue;
    }
    for (const descriptor of descriptors) {
      try {
        const target = fs.readlinkSync(path.join(proc, String(process_.pid), 'fd', descriptor));
        const match = /^socket:\[(\d+)\]$/.exec(target);
        if (match && inodes.has(match[1])) {
          return process_.pid;
        }
      } catch {
        // descriptor closed meanwhile
      }
    }
  }
  return undefined;
}

/** The working directory of a process, or `undefined`. */
export function readCwd(pid, proc = '/proc') {
  try {
    return fs.readlinkSync(path.join(proc, String(pid), 'cwd'));
  } catch {
    return undefined;
  }
}
