// One Ticketmaster Discovery call at a time, paced, and a 429 retried after a
// wait. Discovery allows about five calls a second per key, and the key is
// shared by every sister city's build: a run that read its rooms back to back
// (or landed beside another city's run) drew 429s, and a 429 used to publish
// the room empty until the next day's run. Every app.ticketmaster.com read in
// fetch-events.mjs goes through tmFetch instead of fetch.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// gap: ms between calls (~2.5 a second); tries: 429 retries before giving up;
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
        const res = await fetchImpl(url, init);
        if (res.status !== 429 || attempt >= tries) return res;
        const after = Number(res.headers?.get?.('retry-after'));
        const delay = after > 0 ? after * 1000 : Math.min(2000 * 2 ** attempt, 30000);
        log(`Ticketmaster 429 — retrying in ${delay / 1000} s (${attempt + 1}/${tries})`);
        await sleep(delay);
      }
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  };
}

export const tmFetch = makeTmFetch((...a) => fetch(...a), { gap: Number(process.env.TM_GAP_MS) || 400 });
