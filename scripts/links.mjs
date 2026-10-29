/**
 * Ticket links that reach a real page, not a 404 (Steve, 2026-10-20: "make
 * sure clicking for tickets got to a real page, not 404"). Run on the final
 * list just before events.json is written:
 *
 *  - cleanUrl: a link with no scheme ("purchase.chautauqua.com/…") resolved
 *    against our own host and 404'd on Pages, so it gets https://; Proofpoint
 *    urldefense wrappers (a venue's mailing list pasted into its calendar) are
 *    unwrapped, and a stray "__;!!…" tail is cut off; anything that is not
 *    http(s) is dropped.
 *  - fixLinks: every upcoming row's link is fetched once (deduped, in
 *    parallel, inside a time budget). A 404/410, or a redirect onto the site's
 *    own 404 page, swaps the link for the venue's events page from city.js
 *    (itself checked), or drops it when that is dead too. Bot walls (401/403,
 *    Ticketmaster's and AXS's) and timeouts are not proof of anything, so
 *    those links stay as they are; hosts that always wall a script are not
 *    asked at all.
 */

// Box offices whose event pages answer a script with a wall (or a JS shell
// with "not found" in its template) whatever the page's real state.
const SKIP_HOSTS = /(^|\.)(ticketmaster\.com|livenation\.com|axs\.com|eventim\.us|tixr\.com|dice\.fm|ticketweb\.com|etix\.com|evenue\.net|mlb\.com|milb\.com|seetickets\.us|eventbrite\.com|ticketera\.com|tusboletos\.mx|universe\.com|strangertickets\.com|merctickets\.com|rollerderbytickets\.com|spektrix\.com|ludus\.com)$/i;
const DEAD_PATH = /(^|\/)(404(-\d+)?(\.aspx|\.html?)?|page-not-found|not-found)(\/|$|\?)/i;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

export function cleanUrl(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  const wrapped = s.match(/^https?:\/\/urldefense\.com\/v3\/__(.+?)__;/i);
  if (wrapped) s = wrapped[1];
  s = s.replace(/__;[!A-Za-z0-9_-]*.*$/, ''); // a urldefense tail left behind on its own
  if (/^\/\//.test(s)) s = 'https:' + s;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/|\?|$)/i.test(s)) s = 'https://' + s; // a bare host, path optional
    else return '';
  }
  return /^https?:\/\//i.test(s) ? s : '';
}

// one fetch: 'dead', 'ok' or 'unknown' (walls, timeouts, network trouble)
async function probe(url, fetchImpl, timeoutMs) {
  try {
    const host = new URL(url).hostname;
    if (SKIP_HOSTS.test(host)) return 'ok';
  } catch { return 'dead'; }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { redirect: 'follow', signal: ctl.signal, headers: { 'user-agent': UA, accept: 'text/html,*/*' }, [Symbol.for('here.events/quiet')]: true }); // a dead ticket link is what this looks for, not a failure (failures.mjs)
    try { await res.body?.cancel(); } catch {}
    if (res.status === 404 || res.status === 410) return 'dead';
    if (res.ok && res.url && res.url !== url && DEAD_PATH.test(new URL(res.url).pathname)) return 'dead';
    return res.ok ? 'ok' : 'unknown';
  } catch { return 'unknown'; }
  finally { clearTimeout(t); }
}

export async function fixLinks(events, { venues = {}, today = '', fetchImpl = globalThis.fetch, budgetMs = 120000, timeoutMs = 10000, concurrency = 10, log = console.log } = {}) {
  for (const e of events) if (e.url !== undefined) e.url = cleanUrl(e.url);
  const venueUrl = (v) => cleanUrl(venues[v] && venues[v].url);
  const live = events.filter((e) => !today || (e.date || '') >= today);
  // soonest first, so a build that runs out of budget has checked the rows people see first
  const queue = [...new Set([...live].sort((a, b) => (a.date || '').localeCompare(b.date || '')).flatMap((e) => [e.url, venueUrl(e.venue)]).filter(Boolean))];
  const seen = new Map();
  const stop = Date.now() + budgetMs;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (next < queue.length && Date.now() < stop) {
      const u = queue[next++];
      seen.set(u, await probe(u, fetchImpl, timeoutMs));
    }
  }));
  const dead = [...seen].filter(([, s]) => s === 'dead').map(([u]) => u);
  let swapped = 0, dropped = 0;
  for (const e of events) {
    if (!e.url || seen.get(e.url) !== 'dead') continue;
    const v = venueUrl(e.venue);
    if (v && v !== e.url && seen.get(v) !== 'dead') { e.url = v; swapped++; } else { e.url = ''; dropped++; }
  }
  log(`Links: ${seen.size} of ${queue.length} checked, ${dead.length} dead${dead.length ? ' (' + dead.slice(0, 8).join(', ') + (dead.length > 8 ? ', …' : '') + ')' : ''}; ${swapped} rows sent to their venue's page, ${dropped} left without a link`);
  return { checked: seen.size, dead, swapped, dropped };
}
