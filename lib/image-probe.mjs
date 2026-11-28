// Pure helpers of suites/api/kotlin-lsp-image.mjs: parsers and comparisons over the text that docker, the JVM and the
// shell print. Nothing here touches a process, a file or the network, so the unit tests need only node.

export const megabytes = (bytes) => Math.round(Number(bytes) / (1024 * 1024));

/** `java -version` output (stderr): `openjdk version "21.0.13.1" 2026-11-17 LTS` or the old `java version "1.8.0_392"`. */
export function parseJavaVersion(text) {
  const match = /(?:openjdk|java) version "([^"]+)"/.exec(text ?? '');
  if (!match) {
    return undefined;
  }
  const version = match[1];
  const parts = version.split(/[._+-]/);
  const major = parts[0] === '1' ? Number(parts[1]) : Number(parts[0]);
  const runtime = /^(.*Runtime Environment.*)$/m.exec(text)?.[1]?.trim();
  return { version, major, runtime };
}

/** `java --list-modules` output -> the module names without their `@version`. */
export function parseModules(text) {
  return (text ?? '').split('\n').map((line) => line.trim().split('@')[0]).filter((name) => /^[a-z][\w.]*$/.test(name));
}

/** `du -sm <paths>` output -> megabytes per path (`149<TAB>/opt/continuum/kotlin-ls`). */
export function parseDu(text) {
  const sizes = {};
  for (const line of (text ?? '').split('\n')) {
    const match = /^(\d+)\s+(\S.*)$/.exec(line.trim());
    if (match) {
      sizes[match[2]] = Number(match[1]);
    }
  }
  return sizes;
}

/** The installer's marker file `<version> <sha256>`. */
export function parseMarker(text) {
  const match = /^(\S+) ([0-9a-f]{64})\s*$/.exec((text ?? '').trim());
  return match ? { version: match[1], sha256: match[2] } : undefined;
}

/** The pin in scripts/download-kotlin-ls.sh: the `VERSION="…"` and `SHA256="…"` assignments. */
export function parsePin(scriptText) {
  const version = /^VERSION="([^"]+)"/m.exec(scriptText ?? '')?.[1];
  const sha256 = /^SHA256="([0-9a-f]{64})"/m.exec(scriptText ?? '')?.[1];
  return version && sha256 ? { version, sha256 } : undefined;
}

/** The bridge suite's summary line: `48 passed, 2 failed, 3 skipped (NOT VERIFIED), 0 known gaps, 53 checks`. */
export function parseSummary(output) {
  const match = /(\d+) passed, (\d+) failed, (\d+) skipped \(NOT VERIFIED\), (\d+) known gaps, (\d+) checks/.exec(output ?? '');
  return match ? { pass: Number(match[1]), fail: Number(match[2]), skip: Number(match[3]), knownGap: Number(match[4]), total: Number(match[5]) } : undefined;
}

/**
 * The result lines of a plain-Node suite run (lib/runner.mjs prints `<STATUS padded to 9> <group>  <name>  -- <detail>`):
 * `[{ status, group, name, detail }]`. Lines that are not results (headers, the summary) are ignored.
 */
export function parseResultLines(output) {
  const results = [];
  for (const line of (output ?? '').split('\n')) {
    const match = /^(PASS|FAIL|SKIP|KNOWN GAP) +(\S+) {2}(.*)$/.exec(line.trimEnd());
    if (!match) {
      continue;
    }
    const [name, ...detail] = match[3].split('  -- ');
    results.push({ status: match[1], group: match[2], name, detail: detail.join('  -- ') });
  }
  return results;
}

/** Per group: how many checks passed, failed, were skipped or are known gaps, and the names of the failing ones. */
export function groupTotals(results) {
  const groups = new Map();
  for (const result of results) {
    const group = groups.get(result.group) ?? { group: result.group, pass: 0, fail: 0, skip: 0, knownGap: 0, failing: [] };
    if (result.status === 'PASS') { group.pass++; }
    if (result.status === 'FAIL') { group.fail++; group.failing.push(result.name); }
    if (result.status === 'SKIP') { group.skip++; }
    if (result.status === 'KNOWN GAP') { group.knownGap++; }
    groups.set(result.group, group);
  }
  return [...groups.values()];
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** The only names this suite creates (containers, volumes): `<prefix>-<runId>-<role>`; anything else throws. */
export function ownedName(prefix, runId, role) {
  if (!NAME.test(prefix) || !/^[a-z0-9]+$/.test(runId) || !NAME.test(role)) {
    throw new Error(`not a valid resource name: ${prefix}/${runId}/${role}`);
  }
  return `${prefix}-${runId}-${role}`;
}

/** True only for names made by ownedName with this prefix and run id: the guard before every `docker rm`. */
export function isOwnedName(name, prefix, runId) {
  const start = `${prefix}-${runId}-`;
  return typeof name === 'string' && name.length > start.length && name.startsWith(start) && NAME.test(name);
}

/** The start configuration and size of an image from `docker image inspect` (the array or its first element). */
export function describeImage(inspect) {
  const image = Array.isArray(inspect) ? inspect[0] : inspect;
  const config = image?.Config ?? {};
  const env = {};
  for (const entry of config.Env ?? []) {
    const at = entry.indexOf('=');
    env[at < 0 ? entry : entry.slice(0, at)] = at < 0 ? '' : entry.slice(at + 1);
  }
  return {
    entrypoint: config.Entrypoint ?? [],
    cmd: config.Cmd ?? [],
    workingDir: config.WorkingDir ?? '',
    user: config.User ?? '',
    ports: Object.keys(config.ExposedPorts ?? {}).sort(),
    env,
    sizeBytes: image?.Size ?? 0,
  };
}

/** How two described images start differently (entrypoint, command, working directory, user, ports); `[]` when alike. */
export function startDifferences(image, baseline) {
  const differences = [];
  for (const key of ['entrypoint', 'cmd', 'workingDir', 'user', 'ports']) {
    if (JSON.stringify(image[key]) !== JSON.stringify(baseline[key])) {
      differences.push(`${key}: ${JSON.stringify(baseline[key])} -> ${JSON.stringify(image[key])}`);
    }
  }
  return differences;
}

/** The environment variables `image` defines that `baseline` does not (or defines differently). */
export function addedEnvironment(image, baseline) {
  return Object.fromEntries(Object.entries(image.env).filter(([name, value]) => baseline.env[name] !== value && !/^(PATH|HOSTNAME|HOME)$/.test(name)));
}

/**
 * Whether a described image already contains the Kotlin support (the Dockerfile sets `CONTINUUM_KOTLIN_LS_HOME`). Such an image
 * is not a release from before the feature, so it cannot be the baseline of "what did the feature change": a local rebuild
 * that reuses the released tag looks exactly like this.
 */
export function hasKotlinSupport(image) {
  return typeof image?.env?.CONTINUUM_KOTLIN_LS_HOME === 'string' && image.env.CONTINUUM_KOTLIN_LS_HOME !== '';
}

/** Lines added to and removed from a text, compared as multisets of non-blank lines (their order is not compared). */
export function lineChanges(before, after) {
  const lines = (text) => (text ?? '').split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '');
  const tally = (list) => list.reduce((counts, line) => counts.set(line, (counts.get(line) ?? 0) + 1), new Map());
  const was = tally(lines(before));
  const is = tally(lines(after));
  const surplus = (from, other) => [...from].flatMap(([line, count]) => Array(Math.max(0, count - (other.get(line) ?? 0))).fill(line));
  return { added: surplus(is, was), removed: surplus(was, is) };
}

/**
 * Problems with the seeded extension settings (`settings.json` object) for an install directory; `[]` when they are right.
 * The extension must start the install's launcher (`<install>/bin/kotlin-language-server`, which adds the standard library
 * repository to the server's environment), not the server's own start script.
 */
export function seededSettingsProblems(settings, installDirectory) {
  if (settings === null || typeof settings !== 'object') {
    return ['settings.json is not a JSON object'];
  }
  const problems = [];
  const expected = {
    'kotlin.languageServer.enabled': true,
    'kotlin.languageServer.path': `${installDirectory}/bin/kotlin-language-server`,
    'kotlin.java.home': `${installDirectory}/jre`,
    'kotlin.scripts.enabled': true,
    'kotlin.debugAdapter.enabled': false,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (settings[key] !== value) {
      problems.push(`${key} is ${JSON.stringify(settings[key])}, expected ${JSON.stringify(value)}`);
    }
  }
  if (!/-Xmx\d+m/.test(String(settings['kotlin.java.opts'] ?? ''))) {
    problems.push(`kotlin.java.opts has no -Xmx (${JSON.stringify(settings['kotlin.java.opts'])})`);
  }
  return problems;
}

/** `kotlin-stdlib-2.1.0.jar` in an `ls` listing -> `2.1.0` (the plain jar; `-sources` and `-jdk8` variants do not count). */
export function stdlibVersion(listing) {
  for (const line of (listing ?? '').split('\n')) {
    const match = /^kotlin-stdlib-(\d[\w.]*)\.jar$/.exec(line.trim());
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

/** The Maven-layout path of the stdlib jar below a repository root, as the language server looks for it. */
export const mavenStdlibPath = (root, version) => `${root}/org/jetbrains/kotlin/kotlin-stdlib/${version}/kotlin-stdlib-${version}.jar`;

/** cgroup v2 `memory.stat` -> `{ anon, file }` in bytes (anonymous memory is what an OOM kill is about; `file` is page cache). */
export function parseMemoryStat(text) {
  const stat = {};
  for (const line of (text ?? '').split('\n')) {
    const match = /^(\w+) (\d+)$/.exec(line.trim());
    if (match) {
      stat[match[1]] = Number(match[2]);
    }
  }
  return { anon: stat.anon, file: stat.file };
}

/** The real uid of a process from `/proc/<pid>/status`. */
export function parseUid(statusText) {
  const match = /^Uid:\s+(\d+)/m.exec(statusText ?? '');
  return match ? Number(match[1]) : undefined;
}

/** The configuration directory Theia reports in its start-up log: `Configuration directory URI: 'file:///home/x/.continuum'`. */
export function configurationDirectory(logText) {
  const match = /Configuration directory URI: '(?:file:\/\/)?([^']+)'/.exec(logText ?? '');
  return match ? match[1] : undefined;
}

/**
 * What a language server complained about in its own error stream, as the backend's log shows it: each distinct
 * `SEVERE: Internal error: <message>` line with how often it occurred and the last `Caused by:` line of its first stack trace,
 * plus how many lines mention an OutOfMemoryError.
 */
export function serverErrorSummary(logText) {
  const lines = String(logText ?? '').split('\n');
  const found = new Map();
  let outOfMemory = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/OutOfMemoryError/.test(lines[i])) { outOfMemory++; }
    const severe = /^SEVERE: Internal error: (.*)$/.exec(lines[i]);
    if (!severe) { continue; }
    const message = severe[1].trim();
    const known = found.get(message);
    if (known) { known.count++; continue; }
    let cause;
    for (let j = i + 1; j < lines.length && j < i + 80; j++) {
      if (/^\d{4}-\d{2}-\d{2}T/.test(lines[j]) || /^(SEVERE|WARNING|INFO):/.test(lines[j]) || lines[j].trim() === '') { break; }
      if (lines[j].startsWith('Caused by: ')) { cause = lines[j].slice('Caused by: '.length).trim(); }
    }
    found.set(message, { message, count: 1, cause });
  }
  return { outOfMemory, errors: [...found.values()].sort((a, b) => b.count - a.count) };
}

/**
 * Compares two runs of the same suite. `fixed` fails in the first run only, `persisting` in both, `introduced` in the second only.
 * Names are compared as `<group>: <name>`.
 */
export function compareFailures(first, second) {
  const failing = (results) => new Set(results.filter((r) => r.status === 'FAIL').map((r) => `${r.group}: ${r.name}`));
  const a = failing(first);
  const b = failing(second);
  return {
    fixed: [...a].filter((name) => !b.has(name)),
    persisting: [...a].filter((name) => b.has(name)),
    introduced: [...b].filter((name) => !a.has(name)),
  };
}
