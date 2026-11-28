// A small check recorder for the plain-Node suites (the k6 suites use lib/checks.js instead). Every check ends in one of
// four states, and only FAIL makes the run fail:
//   PASS       the behaviour was observed.
//   FAIL       the behaviour was observed to be wrong.
//   SKIP       the check could not run here; it says why ("NOT VERIFIED: <reason>"). Never counted as a pass.
//   KNOWN GAP  behaviour that is wrong today and accepted (the check asserts the desired behaviour, a miss is reported
//              but does not fail the run; remove the gap when it is fixed).
// Pure module (no globals, no process.exit): the suite decides when to print the summary and exit.

export const STATUS = Object.freeze({ pass: 'PASS', fail: 'FAIL', skip: 'SKIP', knownGap: 'KNOWN GAP' });

export function createRecorder({ print = (line) => console.log(line), only = [] } = {}) {
  const results = [];
  const selected = (group) => only.length === 0 || only.includes(group);

  function add(status, group, name, detail = '') {
    const result = { status, group, name, detail };
    results.push(result);
    print(`${status.padEnd(9)} ${group}  ${name}${detail ? `  -- ${detail}` : ''}`);
    return result;
  }

  return {
    results,
    selected,
    record: (group, name, ok, detail = '') => add(ok ? STATUS.pass : STATUS.fail, group, name, detail),
    skip: (group, name, reason) => add(STATUS.skip, group, name, `NOT VERIFIED: ${reason}`),
    knownGap: (group, name, ok, detail = '') => add(ok ? STATUS.pass : STATUS.knownGap, group, name, detail),
    /**
     * Runs `fn`, which returns `true`, a string (the detail; passes), or `{ ok, detail }`; anything else is a FAIL, and so
     * is a throw (with the error message), so one broken check never stops the others.
     */
    async check(group, name, fn) {
      if (!selected(group)) {
        return undefined;
      }
      try {
        const outcome = await fn();
        if (outcome && typeof outcome === 'object') {
          return add(outcome.ok ? STATUS.pass : STATUS.fail, group, name, outcome.detail ?? '');
        }
        if (typeof outcome === 'string') {
          return add(STATUS.pass, group, name, outcome);
        }
        return add(outcome === true ? STATUS.pass : STATUS.fail, group, name);
      } catch (error) {
        return add(STATUS.fail, group, name, `threw: ${error?.message ?? error}`);
      }
    },
    summary() {
      const count = (status) => results.filter((r) => r.status === status).length;
      return { pass: count(STATUS.pass), fail: count(STATUS.fail), skip: count(STATUS.skip), knownGap: count(STATUS.knownGap), total: results.length };
    },
    exitCode: () => (results.some((r) => r.status === STATUS.fail) ? 1 : 0),
  };
}
