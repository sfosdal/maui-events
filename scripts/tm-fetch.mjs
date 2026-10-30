// One Ticketmaster Discovery call at a time, paced, and a failed call retried
// after a wait. Discovery allows about five calls a second per key, and the
// key is shared by every sister city's build: a run that read its rooms back
// to back (or landed beside another city's run) drew 429s, and a 429 used to
// publish the room empty until the next day's run. Every app.ticketmaster.com
// read in fetch-events.mjs goes through tmFetch instead of fetch.
//
// Steve, 2026-10-28: "I want ticketmaster calls to not fail". So a 429, a
// 5xx and a dropped connection are all retried; a call that still fails
// after the last try comes back as a response with ok false (status 0 for a
// dropped connection) rather than a throw, and the build's !res.ok line hands
// it to tmFailed, which names the venue; keepFailedVenues then carries that
// venue's upcoming rows over from the previous feed instead of publishing it
// empty.
import { dropClashes } from './merge.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const retryable = (status) => status === 429 || status >= 500;

// gap: ms between calls (~2.5 a second); tries: retries before giving up;
// the wait honours Retry-After when Ticketmaster sends one, else 2 s, 4 s, 8 s …
export function makeTmFetch(fetchImpl, { gap = 400, tries = 5, log = console.warn } = {}) {
  let last = 0;
  let queue = Promise.resolve();
  return function tmFetch(url, init) {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        const wait = last + gap - Date.now();
        if (wait > 0) await sleep(wait);
        last = Date.now();
        let res;
        try { res = await fetchImpl(url, init); }
        catch (err) { res = { ok: false, status: 0, statusText: err.message, headers: { get: () => null }, json: async () => ({}) }; }
        if (!retryable(res.status) && res.status !== 0) return res;
        if (attempt >= tries) return res;
        const after = Number(res.headers?.get?.('retry-after'));
        const delay = after > 0 ? after * 1000 : Math.min(2000 * 2 ** attempt, 30000);
        log(`Ticketmaster ${res.status || res.statusText} — retrying in ${delay / 1000} s (${attempt + 1}/${tries})`);
        await sleep(delay);
      }
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  };
}

export const tmFetch = makeTmFetch((...a) => fetch(...a), { gap: Number(process.env.TM_GAP_MS) || 400 });

// The venues whose read failed after every retry, by the build's label.
export const tmFailedVenues = new Set();
export function tmFailed(label, res) {
  tmFailedVenues.add(label);
  globalThis[Symbol.for('here.events/recordFailure')]?.(`Ticketmaster ${label}`, res.status ? `HTTP ${res.status}` : res.statusText || 'no answer'); // the build's call log (failures.mjs), when one is installed
  return new Error(`Ticketmaster ${label} failed after retries (${res.status ? 'HTTP ' + res.status : res.statusText || 'no answer'})`);
}

// A failed venue's upcoming rows from the previous feed, minus any that
// clash with what this build already has there (merge.mjs dropClashes: the
// same clock, or the same show within 90 minutes — a venue's own calendar
// lists the doors where Ticketmaster lists the show).
export function keepFailedVenues(archived, fresh, today, failed = tmFailedVenues, log = console.error, what = 'Ticketmaster') { // what: 'Ticketmaster', or 'Own calendar' for a venue feed (feeds.mjs feedFailedVenues)
  if (!failed.size) return [];
  const kept = dropClashes(archived.filter((e) => failed.has(e.venue) && e.date >= today), fresh);
  for (const v of failed) log(`${what} ${v}: failed — kept ${kept.filter((e) => e.venue === v).length} upcoming rows from the previous feed`);
  return kept;
}
