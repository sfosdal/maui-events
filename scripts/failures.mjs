// The build's call log: every outside call the build makes is retried, and
// a call still failing after its retries is written down — failures.json,
// read by scripts/failure-issue.mjs, which mails Steve through a GitHub
// issue only when something NEW fails (Steve, 2026-10-29: "I want a
// notification about failed calls in email, only when a retry hasn't
// resolved it").
//
// Imported first by scripts/fetch-events.mjs, it wraps globalThis.fetch:
//   - a network error, a timeout-free abort, 408/425/429 or a 5xx is tried
//     three times (2 s, then 6 s apart); a 403 or 406 once more after 2 s
//     (a refusal is rarely transient, but a second ask is cheap);
//   - Ticketmaster passes straight through — tm-fetch.mjs paces and
//     retries it, and reports a venue it gave up on (recordFailure);
//   - expected misses are not failures: HEAD probes (crest and link
//     checks), ESPN's per-team leaders (absent for some sports), a
//     Wikipedia page that does not exist, and any call made with
//     { [QUIET]: true } (links.mjs, which probes ticket links on purpose).
// A source that fails for another reason (a page that answered HTML where
// JSON was expected) is caught by the build's own "Source failed:" line,
// written down with the last call made before it.
import { writeFileSync } from 'node:fs';

export const QUIET = Symbol.for('here.events/quiet');
const RETRY = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const REFUSED = new Set([403, 406]);
const PASS = [/(^|\.)ticketmaster\.com$/i]; // tm-fetch.mjs owns these
const EXPECTED = [
  (u) => /(^|\.)espn\.com$/i.test(u.hostname) && /\/leaders$/.test(u.pathname),
  (u, status) => /(^|\.)wikipedia\.org$/i.test(u.hostname) && status === 404,
];

export function makeCallLog({ fetchImpl, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), waits = [2000, 6000] } = {}) {
  const failures = new Map(); // key → { url, status|error, count }
  let lastUrl = '';
  const record = (key, entry) => {
    const had = failures.get(key);
    failures.set(key, { ...entry, count: (had?.count || 0) + 1 });
  };
  async function loggedFetch(input, init = {}) {
    const href = typeof input === 'string' ? input : input?.url || String(input);
    let u; try { u = new URL(href); } catch { return fetchImpl(input, init); }
    if (PASS.some((re) => re.test(u.hostname))) return fetchImpl(input, init);
    const quiet = init?.[QUIET] || String(init?.method || 'GET').toUpperCase() === 'HEAD';
    const clean = `${u.origin}${u.pathname}`; // the query can carry keys and dates — never written down
    lastUrl = clean;
    for (let attempt = 0; ; attempt++) {
      let res, err;
      try { res = await fetchImpl(input, init); } catch (e) { err = e; }
      const aborted = err && init?.signal?.aborted; // the caller's own timeout: a retry would abort at once
      const again = err ? !aborted && attempt < waits.length
        : RETRY.has(res.status) ? attempt < waits.length
        : REFUSED.has(res.status) ? attempt < 1 : false;
      if (again) { await sleep(waits[attempt]); continue; }
      if (!quiet) {
        if (err) record(`${clean} ${err.name || 'Error'}`, { url: clean, error: String(err.cause?.code || err.message || err).slice(0, 160) });
        else if (!res.ok && !EXPECTED.some((f) => f(u, res.status))) record(`${clean} HTTP ${res.status}`, { url: clean, status: res.status });
      }
      if (err) throw err;
      return res;
    }
  }
  return {
    fetch: loggedFetch,
    recordFailure: (what, detail = '') => record(`${what} ${detail}`.trim(), { what, ...(detail ? { error: String(detail).slice(0, 160) } : {}) }),
    // a "Source failed: …" line with no HTTP status of its own (a parse error): the last call before it names the source
    noteSourceFailed: (message) => { if (/HTTP \d{3}/.test(message)) return; record(`source ${message.slice(0, 80)}`, { what: 'Source failed', error: message.slice(0, 160), after: lastUrl }); },
    list: () => [...failures.entries()].map(([key, v]) => ({ key, ...v })),
  };
}

// The build's one log, installed on import unless CALL_LOG=0
// (and never inside `node --test`). Shared scripts that give up on a call of their own (tm-fetch.mjs)
// report it through globalThis[RECORD] — no import, so the sold-out checker, which shares tm-fetch.mjs,
// never installs a log of its own.
export const RECORD = Symbol.for('here.events/recordFailure');
let active = null;
export function installCallLog({ path = 'failures.json', env = process.env } = {}) {
  if (active || env.CALL_LOG === '0' || env.NODE_TEST_CONTEXT) return active;
  active = makeCallLog({ fetchImpl: globalThis.fetch.bind(globalThis) });
  globalThis.fetch = active.fetch;
  globalThis[RECORD] = active.recordFailure;
  const error = console.error.bind(console);
  console.error = (...a) => { // the builds' "Source failed: <message>" lines (and "… sweep failed:")
    if (typeof a[0] === 'string' && /failed:$/i.test(a[0])) try { active.noteSourceFailed(a.slice(1).map(String).join(' ')); } catch { /* the log never breaks the build */ }
    error(...a);
  };
  process.on('exit', () => {
    const failures = active.list();
    try { writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), failures }, null, 1) + '\n'); } catch (e) { error('failures.json:', e.message); }
    if (failures.length) error(`\nCalls still failing after their retries: ${failures.length}\n` + failures.map((f) => `  ${f.key}${f.after ? ` (after ${f.after})` : ''}`).join('\n'));
  });
  return active;
}
installCallLog();
