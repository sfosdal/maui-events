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
 *  - formerLinks + repointMoved: a past row keeps the link it was published
 *    with and is never checked again, so when a venue's link changes in
 *    city.js (a lapsed or hijacked domain, a calendar that moved) the rows
 *    that carried the OLD link would point at it forever (Steve, 2026-11-06:
 *    Cancún's archived Tigres games still linked a domain that had become a
 *    porn site). formerLinks reads every committed version of site/city.js
 *    and lists each link a venue has had; repointMoved gives a row whose link
 *    equals one of those exactly the venue's link now, or none. An event's own
 *    page never equals a venue's link, so it is never touched.
 */
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

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

// The record (Steve, 2026-11-03: "keeping the record, but shorten the timeframe from 1 wk to 2 days"): `record`
// is last build's { url: 'YYYY-MM-DD' } of links that answered OK, kept on the archive branch beside
// events-archive.json. A link that answered OK within `maxAgeDays` is trusted without a call; a new link, and
// one that was dead or unclear last time (never written down), is checked every build. The returned `record`
// holds the links of this build only, each with the day it last answered OK.
export async function fixLinks(events, { venues = {}, today = '', fetchImpl = globalThis.fetch, budgetMs = 120000, timeoutMs = 10000, concurrency = 10, log = console.log, record = null, maxAgeDays = 2 } = {}) {
  for (const e of events) if (e.url !== undefined) e.url = cleanUrl(e.url);
  const venueUrl = (v) => cleanUrl(venues[v] && venues[v].url);
  const live = events.filter((e) => !today || (e.date || '') >= today);
  // soonest first, so a build that runs out of budget has checked the rows people see first
  const queue = [...new Set([...live].sort((a, b) => (a.date || '').localeCompare(b.date || '')).flatMap((e) => [e.url, venueUrl(e.venue)]).filter(Boolean))];
  const seen = new Map();
  const day = today || new Date().toISOString().slice(0, 10);
  const since = new Date(Date.parse(day) - maxAgeDays * 86400e3).toISOString().slice(0, 10);
  const next_ = {};
  let trusted = 0;
  if (record) for (const u of queue) if (record[u] && record[u] >= since) { seen.set(u, 'ok'); next_[u] = record[u]; trusted++; }
  const stop = Date.now() + budgetMs;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (next < queue.length && Date.now() < stop) {
      const u = queue[next++];
      if (seen.has(u)) continue; // answered OK within the record's window
      const r = await probe(u, fetchImpl, timeoutMs);
      seen.set(u, r);
      if (r === 'ok' && !SKIP_HOSTS.test(new URL(u).hostname)) next_[u] = day; // walled box offices are never asked, so nothing to write down
    }
  }));
  const dead = [...seen].filter(([, s]) => s === 'dead').map(([u]) => u);
  let swapped = 0, dropped = 0;
  for (const e of events) {
    if (!e.url || seen.get(e.url) !== 'dead') continue;
    const v = venueUrl(e.venue);
    if (v && v !== e.url && seen.get(v) !== 'dead') { e.url = v; swapped++; } else { e.url = ''; dropped++; }
  }
  log(`Links: ${seen.size} of ${queue.length} checked${record ? ` (${trusted} answered OK in the last ${maxAgeDays} days, not asked again)` : ''}, ${dead.length} dead${dead.length ? ' (' + dead.slice(0, 8).join(', ') + (dead.length > 8 ? ', …' : '') + ')' : ''}; ${swapped} rows sent to their venue's page, ${dropped} left without a link`);
  return { checked: seen.size, trusted, dead, swapped, dropped, record: next_ };
}

// ---- venue links that moved (see the head of this file) ----
// The links city.js gives a venue: its own page, Ticketmaster's fallback, and the
// schedule / injected-game link of each club that plays there.
export function venueLinks(city) {
  const out = new Map();
  const add = (v, u) => { const c = cleanUrl(u); if (v && c) (out.get(v) || out.set(v, new Set()).get(v)).add(c); };
  for (const [v, x] of Object.entries((city && (city.venues || city.rooms)) || {})) { add(v, x && x.url); add(v, x && x.tm && x.tm.fallbackUrl); }
  for (const t of (city && city.teams) || []) { add(t.venue, t.inject && t.inject.url); add(t.venue, t.schedule); }
  return out;
}

// Every link each venue has had, from the git history of site/city.js. A shallow
// checkout (Actions) is deepened first; without git, or on any error, nothing moved.
export function formerLinks({ cwd = '.', file = 'site/city.js', git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256e6 }), log = console.log } = {}) {
  const out = new Map();
  let shas = [];
  try {
    if (git(['rev-parse', '--is-shallow-repository']).trim() === 'true') git(['fetch', '--quiet', '--unshallow']);
    shas = git(['log', '--format=%H', '--', file]).split('\n').filter(Boolean);
  } catch (err) { log(`Moved links: no git history (${String(err.message || err).split('\n')[0]})`); return out; }
  let read = 0;
  for (const sha of shas) {
    try {
      const ctx = {}; ctx.globalThis = ctx; ctx.window = ctx; ctx.self = ctx;
      vm.runInNewContext(git(['show', `${sha}:${file}`]), ctx, { timeout: 2000 });
      for (const [v, links] of venueLinks(ctx.LQACity)) for (const u of links) (out.get(v) || out.set(v, new Set()).get(v)).add(u);
      read++;
    } catch { /* a version that does not load (an early layout) adds nothing */ }
  }
  log(`Moved links: ${read} of ${shas.length} versions of ${file} read`);
  return out;
}

// A row whose link is one the venue has had but no longer has gets the venue's link
// now (its own page, else its club's), or none. Rows are changed in place; returns the count.
// the same page written two ways (host case, a trailing slash) compares equal
const linkKey = (u) => { const c = cleanUrl(u); try { const x = new URL(c); return x.protocol + '//' + x.host + x.pathname.replace(/\/+$/, '') + x.search; } catch { return c; } }; // URL() lower-cases the host

export function repointMoved(rows, former, city) {
  if (!former || !former.size) return 0;
  const keys = (m) => new Map([...m].map(([v, set]) => [v, new Set([...set].map(linkKey))]));
  const now = keys(venueLinks(city));
  former = keys(former);
  const target = (v) => { const x = (city.venues || {})[v] || {}; const club = (city.teams || []).find((t) => t.venue === v); return cleanUrl(x.url) || cleanUrl(club && club.inject && club.inject.url) || cleanUrl(club && club.schedule) || ''; };
  let n = 0;
  for (const e of rows) {
    const u = linkKey(e.url);
    if (!u || !(former.get(e.venue) || new Set()).has(u) || (now.get(e.venue) || new Set()).has(u)) continue;
    e.url = target(e.venue); n++;
  }
  return n;
}

// ---- hijacked links (Steve, 2026-11-06: "block porn like tigresqr.com I don't mind strip clubs showing up, but
// the core requirement is that they need to be local events") ----
// A venue's or club's domain that lapses can be bought and turned into porn or gambling spam while still answering
// 200, so fixLinks never sees it. guardLinks reads each link's page and blocks it only on a strong signal: the page's
// TITLE reads as porn or gambling spam, or the link now lands on ANOTHER domain whose page does. A venue's own page
// that mentions a "porn star feature" night or an "XXX" tribute, or a casino's "online casino", is kept; a page that
// cannot be read (a wall, a timeout) is kept too. The same patterns drive the monthly audit (tools/link-audit), which
// reads them from here.
export const HIJACK = {
  porn: String.raw`\b(porn\w*|hentai|xvideos|xhamster|sex (videos?|cams?|chat)|cam ?girls|adult videos?)\b|порн|порево`,
  gambling: String.raw`\b(slot ?gacor|gacor|togel|judi (online|bola|slot)|situs (slot|judi|toto)|maxwin|rtp (live|slot)|sbobet|bandar (togel|judi)|slot ?(online|88|777)|casino online|1xbet|mostbet)\b`,
  parked: String.raw`(this domain (is|may be) for sale|buy this domain|domain is for sale|hugedomains|afternic|sedoparking|parkingcrew|bodis\.com|is parked free)`, // the audit reports these; the build does not block them
};
const BLOCK = new RegExp(`${HIJACK.porn}|${HIJACK.gambling}`, 'i');
const SLD = new Set(['co', 'com', 'org', 'net', 'gov', 'gob', 'edu', 'ac']);
// the registrable domain: www.tigresqr.com → tigresqr.com, teatro.gob.mx → teatro.gob.mx (two-letter country codes)
export function siteOf(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return ''; }
  const p = host.split('.');
  return p.slice(-(p.length >= 3 && SLD.has(p[p.length - 2]) && p[p.length - 1].length === 2 ? 3 : 2)).join('.');
}
const textOf = (html) => html.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// one page: { blocked: 'why' } | { blocked: '' } (clean) | null (not read)
export function hijackVerdict(url, { status, final, html }) {
  if (!status || status >= 400) return null;
  const title = ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
  const refresh = html.slice(0, 20000).match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?\s*\d+\s*;\s*url=([^"'>\s]+)/i);
  let lands = final || url;
  if (refresh) { try { lands = new URL(refresh[1], lands).href; } catch {} }
  if (BLOCK.test(title)) return { blocked: `its title reads “${title.slice(0, 80)}”` };
  if (siteOf(lands) !== siteOf(url) && BLOCK.test(title + ' ' + textOf(html.slice(0, 300000)))) return { blocked: `it now lands on ${siteOf(lands)}, a ${BLOCK.exec(title + ' ' + textOf(html.slice(0, 300000)))[0]} page` };
  return { blocked: '' };
}

// Checks every venue and club link city.js gives, and each other site the rows link to (its home page), skipping the
// walled box offices. A clean answer is trusted for `trustDays` (record: { url-or-host: 'YYYY-MM-DD' }, kept on the
// archive branch in links-checked.json). For each blocked domain: the city's venue and club links on it are blanked
// (in memory — build.mjs blanks the published site/city.js too), and every row linking there gets its venue's page
// when that is clean, else no link. Returns { blocked: [{ url, why, uses }], record }.
export async function guardLinks({ city, rows = [], fetchImpl = globalThis.fetch, record = {}, today = new Date().toISOString().slice(0, 10), trustDays = 3, budgetMs = 90000, timeoutMs = 15000, concurrency = 10, log = console.log, report = globalThis[Symbol.for('here.events/recordFailure')] } = {}) {
  const uses = new Map(); // url → ['venue X (url)', …]
  const use = (u, what) => { const c = cleanUrl(u); if (c) (uses.get(c) || uses.set(c, []).get(c)).push(what); };
  for (const [v, x] of Object.entries(city.venues || {})) { use(x && x.url, `${v} (venue page)`); use(x && x.tm && x.tm.fallbackUrl, `${v} (Ticketmaster fallback)`); }
  for (const t of city.teams || []) { use(t.schedule, `${t.label || t.slug} (schedule)`); use(t.inject && t.inject.url, `${t.label || t.slug} (game link)`); }
  const configSites = new Set([...uses.keys()].map(siteOf));
  const hosts = new Map(); // a site only the rows link to → its home page
  for (const list of rows) for (const e of list) {
    const u = cleanUrl(e.url); if (!u) continue;
    let h; try { h = new URL(u); } catch { continue; }
    if (SKIP_HOSTS.test(h.hostname) || configSites.has(siteOf(u)) || hosts.has(siteOf(u))) continue;
    hosts.set(siteOf(u), `${h.protocol}//${h.host}/`);
  }
  const queue = [...uses.keys(), ...hosts.values()].filter((u) => { try { return !SKIP_HOSTS.test(new URL(u).hostname); } catch { return false; } });
  const since = new Date(Date.parse(today) - trustDays * 86400e3).toISOString().slice(0, 10);
  const next_ = {}, verdicts = new Map();
  let trusted = 0, unread = 0, i = 0;
  for (const u of queue) if (record[u] && record[u] >= since) { next_[u] = record[u]; verdicts.set(u, ''); trusted++; }
  const stop = Date.now() + budgetMs;
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (i < queue.length && Date.now() < stop) {
      const u = queue[i++];
      if (verdicts.has(u)) continue;
      let v = null;
      try {
        const r = await fetchImpl(u, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': UA, accept: 'text/html,*/*' }, [Symbol.for('here.events/quiet')]: true });
        const type = r.headers && r.headers.get ? r.headers.get('content-type') || '' : 'text/html';
        const html = /html|text/i.test(type) && r.text ? await r.text() : '';
        v = hijackVerdict(u, { status: r.status, final: r.url, html });
      } catch { v = null; }
      if (v === null) { unread++; continue; }
      verdicts.set(u, v.blocked);
      if (!v.blocked) next_[u] = today;
    }
  }));
  const blocked = [...verdicts].filter(([, why]) => why).map(([url, why]) => ({ url, why, uses: uses.get(url) || ['links in the listings'] }));
  const bad = new Set(blocked.map((b) => siteOf(b.url)));
  if (bad.size) {
    const off = (u) => u && bad.has(siteOf(cleanUrl(u)));
    for (const x of Object.values(city.venues || {})) { if (!x) continue; if (off(x.url)) x.url = ''; if (x.tm && off(x.tm.fallbackUrl)) x.tm.fallbackUrl = ''; }
    for (const t of city.teams || []) { if (off(t.schedule)) t.schedule = ''; if (t.inject && off(t.inject.url)) t.inject.url = ''; }
    let swapped = 0, dropped = 0;
    for (const list of rows) for (const e of list) {
      if (!off(e.url)) continue;
      const v = cleanUrl(city.venues && city.venues[e.venue] && city.venues[e.venue].url);
      if (v) { e.url = v; swapped++; } else { e.url = ''; dropped++; }
    }
    for (const b of blocked) { log(`BLOCKED link: ${b.url} — ${b.why}; used by ${b.uses.join(', ')}`); if (report) report(`Blocked link ${b.url} (${b.uses.join(', ')})`, `hijacked: ${b.why}`); }
    log(`Blocked links: ${blocked.length} (${[...bad].join(', ')}); ${swapped} rows sent to their venue's page, ${dropped} left without a link`);
  }
  log(`Link guard: ${queue.length} pages (${trusted} clean in the last ${trustDays} days, not asked again), ${unread} not read, ${blocked.length} blocked`);
  return { blocked, record: next_ };
}
