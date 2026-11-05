/**
 * The build every city shares (Steve, 2026-11-03: "move everything every city does the same way into one
 * scripts/build.mjs"). A city's scripts/fetch-events.mjs imports ./failures.mjs first, then calls
 * build({ feedUrl, archiveUrl, … }) with its own readers; everything below — the Ticketmaster reads, a
 * venue's two sources merged, venue naming, the church and closure-notice filters, the date window and
 * de-duping, the empty-list gate, past events carried forward, a quiet venue's last events, team
 * schedules, link checks and every file written — is the same for every city. This file is lqa-events'
 * and is copied to each city by sync-shared.sh; never edit a city's copy.
 *
 * Each source is an async function returning [{ venue, title, date, time, url }]. Ticketmaster needs a
 * Discovery API key in env TICKETMASTER_API_KEY (repo secret of the same name; locally an untracked .env
 * at the repo root); with no key it is skipped. Every venue is read by its Ticketmaster venue id
 * (city.js `tm`), one call at a time (tm-fetch.mjs paces them; the key is shared by every city's build).
 *
 * Hooks (all optional; each default is what most cities do):
 *   sessionVenues       venues that sell timed entry (one Ticketmaster listing per session): one row a day, at
 *                       the first session's clock (Bend's Redmond expo, Salem's State Fairgrounds)
 *   primary(s)          → the leading sources, in order (default [...s.tmFirst, ...s.feedsFirst])
 *   secondary(s)        → sources that fill in behind them (default [...s.tmSecond, ...s.feedsSecond])
 *                         s = { tmFirst, tmSecond, feedsFirst, feedsSecond, ticketmasterVenue, tmPages, tmEvent, normalizeVenue, BROWSER_UA }
 *   cityFeedsSecond     true: the city-wide `feeds` fill in behind the venues' own reads instead of leading (Portland)
 *   church              false: no church filter at all (lqa and Seattle, which have never had one)
 *   afterPrimary(all)   → the leading sources' rows, still under their own venue names, before anything is folded
 *                       to city.js's names and before the secondary sources (lqa's Seattle Center sweep reads them)
 *   secondaryRows(rows, all)  → the rows kept from one secondary source (default merge.mjs dropClashes)
 *   normalizeVenue(e, std)    → a row's venue as city.js spells it (default: alias, name in title, groundsVenue)
 *   afterSources(all)   → the source rows before the window (a city-wide sweep's corrections, strays logged)
 *   listedVenuesOnly    true: only the venues city.js lists (a row under any other is dropped and counted), a
 *                       secondary row only on a date its venue doesn't have yet, and an untimed row dropped
 *                       beside a timed one for the same page (the Hawaiʻi sites)
 *   decodeEntities      true: every HTML entity in a title decoded, not only the hex ones (the Hawaiʻi sites)
 *   keepRow(e)          → false drops a row, from every source and the archive (the islands keep only venues they list)
 *   fixTitle(t)         → a city's own title clean-up, before calmTitle
 *   gateSources(n)      → the source count the empty-list gate reports (default primary + secondary)
 *   archiveRow(e)       → an archived row's correction (a venue renamed since it was published)
 *   afterMerge(merged, ctx)   → runs after the archive merge, before festivals and the schedules
 *   afterInject(merged, ctx)  → runs after the teams' home games are written in
 *   injectVenue(t, g)   → a home game's ground (default t.inject.venue || t.venue || g.venue)
 *   feedUrlOld          the live feed's address before here.events, read when the current one fails
 *   soldoutUrl          read the sold-out checker's soldout.json from here instead of scripts/data/ (Seattle reads lqa's)
 *   moreFeeds(merged)   → [[file, rows, calname], …]: extra subscribe feeds written beside the filtered ones (lqa's no-movies)
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { buildIcs } from './ics.mjs';
import * as citySources from './sources.mjs'; // each city's own file: isChurch where the city filters church bookings (not lqa, Seattle)
import { mergeWithArchive, unionArchives, eventKey, dropClashes, keepQuietVenues, capUpcoming } from './merge.mjs';
import { fixLinks } from './links.mjs';
import { calmTitle, isNotice } from './titles.mjs';
import { applySchedules } from './schedules.mjs';
import { slugify, BADGE_FEEDS, TEAMS, CITY } from './badges.mjs';
import { feedSources, emptyListGate, feedFailedVenues, feedQuietVenues, feedQuietSites } from './feeds.mjs';
import { tmFetch, tmFailed, keepFailedVenues, pickVenueRows, reportRenamed } from './tm-fetch.mjs';
import { callScope } from './failures.mjs';
import { stampFestivals } from './festivals.mjs';
import { ticketWebId } from './ticketweb.mjs';

const JSON_OUT = new URL('../site/events.json', import.meta.url);
const ICS_OUT = new URL('../site/events.ics', import.meta.url);
// A full year each way: venues announce whole seasons ahead, and past events are kept for good (carried
// forward from the previously published feed — see mergeWithArchive; Steve, 2026-10-31: "all old events
// should be kept"). The window only bounds what a source adds.
export const WINDOW_DAYS = 365;
const ARCHIVE_OUT = new URL('../events-archive.json', import.meta.url); // repo root, ignored; the workflow commits it to the archive branch
const LINKS_OUT = new URL('../links-checked.json', import.meta.url); // repo root, ignored; the workflow commits it to the archive branch
const MAX_EVENTS = 4000; // sanity cap on the UPCOMING rows (merge.mjs capUpcoming): past events are never trimmed

export const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Local runs: when the environment doesn't provide TICKETMASTER_API_KEY (CI passes it as a repo secret),
// pick it up from an untracked repo-root .env so the localhost preview gets the arena listings too.
if (!process.env.TICKETMASTER_API_KEY) {
  try {
    const m = readFileSync(new URL('../.env', import.meta.url), 'utf8').match(/^TICKETMASTER_API_KEY=(.+)$/m);
    if (m) process.env.TICKETMASTER_API_KEY = m[1].trim();
  } catch { /* no .env — Ticketmaster sources warn and skip */ }
}

// --- Ticketmaster Discovery API ---
// Ticketmaster's resale marketplace (source "tmr": an id starting "Z7r9j", a ticketmaster.com/event/ link)
// lists shows whose box office is elsewhere, a second listing beside the primary, titled differently so the
// duplicate guard can't fold them. A resale listing is kept only when no primary one shares its date, and it
// links to the box office the listing names or the venue's own page, never to the resale offer.
const isResale = (e) => /^Z7r9j/.test(e.id || '');
export function tmEvent(e, venue, fallbackUrl) {
  const boxOffice = (e.outlets || []).find((o) => o.type === 'venueBoxOffice')?.url;
  const ev = {
    venue,
    title: e.name,
    date: e.dates?.start?.localDate || '',
    time: e.dates?.start?.localTime || '',
    url: isResale(e) ? (boxOffice || fallbackUrl) : (e.url || fallbackUrl),
  };
  if (e.ageRestrictions?.legalAgeEnforced) ev.age21 = true;
  const seg = e.classifications?.[0]?.segment?.name || '';
  const type = /sports/i.test(seg) ? 'sports' : /music/i.test(seg) ? 'concert' : /arts|theat/i.test(seg) ? 'arts' : /film/i.test(seg) ? 'movie' : null;
  if (type) ev.type = type;
  if (e.dates?.start?.dateTBD || e.dates?.start?.dateTBA) ev.dateTbd = true; // a placeholder date the promoter may still move
  // a cancelled or postponed show stays in Ticketmaster's listing for a while, marked in dates.status — pass
  // that on rather than list it as if it were still happening (the merge step drops it once it vanishes)
  const code = e.dates?.status?.code;
  if (code === 'cancelled' || code === 'postponed') ev.status = code;
  return ev;
}
export function keepPrimary(rows) {
  const primaryDates = new Set(rows.filter((e) => !isResale(e)).map((e) => e.dates?.start?.localDate));
  return rows.filter((e) => !isResale(e) || !primaryDates.has(e.dates?.start?.localDate));
}
export async function tmPages(params, label) {
  const key = process.env.TICKETMASTER_API_KEY;
  if (!key) { console.warn('No TICKETMASTER_API_KEY set — skipping Ticketmaster.'); return []; }
  const all = [];
  for (let page = 0; page < 5; page++) {
    const q = new URLSearchParams({ apikey: key, sort: 'date,asc', size: '200', page: String(page), ...params });
    const res = await tmFetch(`https://app.ticketmaster.com/discovery/v2/events.json?${q}`);
    if (!res.ok) throw tmFailed(label, res); // every retry spent (tm-fetch.mjs): the venue keeps its previous rows, not an empty or half list
    const data = await res.json();
    all.push(...(data?._embedded?.events || []));
    if (page + 1 >= (data?.page?.totalPages || 1)) break;
  }
  console.log(`Ticketmaster ${label}: ${all.length} events`);
  return all;
}
// by venue id (every page), for the venues city.js names; `tm.ids` reads several ids as one venue
export async function ticketmasterVenue({ venueIds, venueMatch, label, fallbackUrl, exclude }) {
  const pages = [];
  for (const venueId of venueIds) pages.push(...await tmPages({ venueId }, label)); // a building that is several Ticketmaster venues (city.js tm.ids) is read id by id
  const { rows, renamed } = pickVenueRows(pages, { venueIds, venueMatch, exclude }); // a venue Ticketmaster renamed keeps its shows (tm-fetch.mjs)
  reportRenamed(label, venueMatch, renamed);
  return keepPrimary(rows).map((e) => tmEvent(e, label, fallbackUrl));
}
const tmVenue = ([label, v]) => () => ticketmasterVenue({ venueIds: v.tm.ids || [v.tm.id], venueMatch: v.tm.match, label, fallbackUrl: v.tm.fallbackUrl, exclude: v.tm.exclude });
const firstSessionOnly = (venues) => (fn) => async () => {
  const seen = new Set();
  return (await fn()).filter((e) => {
    if (!venues.has(e.venue)) return true;
    const k = `${e.venue}|${e.title}|${e.date}`;
    return !seen.has(k) && seen.add(k);
  });
};
const splitVenues = (keep) => Object.fromEntries(Object.entries(CITY.venues).filter(([, v]) => keep(v)));

// Venue names as city.js spells them: a venue listed under other spellings (`alias`) folds to its one
// name; `groundsVenue`, when a city sets one, takes the venues city.js doesn't list.
const CANONICAL_VENUES = new Set(Object.keys(CITY.venues));
const ALIASES = Object.entries(CITY.venues).filter(([, v]) => v.alias).map(([label, v]) => [label, v.alias]);
export const aliasHit = (s) => { const hit = ALIASES.find(([, re]) => re.test(s || '')); return hit ? hit[0] : null; };
const aliasVenue = (name) => aliasHit(name) || name;
// A listing whose venue field is just the city names its venue at the end of the title ("X live at The Vic").
const venueInTitle = (title) => { const m = /\b(?:at|@)\s+(.+)$/i.exec(title || ''); return m ? aliasHit(m[1]) : null; };
export const normalizeVenue = (e) => {
  const byName = aliasVenue(e.venue);
  const venue = CANONICAL_VENUES.has(byName) ? byName : (venueInTitle(e.title) || byName);
  if (CITY.groundsVenue && !CANONICAL_VENUES.has(venue)) return { ...e, venue: CITY.groundsVenue };
  return venue === e.venue ? e : { ...e, venue };
};

// the shared title clean-up: hex entities a Webflow page writes (&#x27;) decoded, then shouted titles down
// to Title Case; "– Sold Out!" written into a title becomes the soldOut tag, not words
// every HTML entity a page leaves in a title
export const unent = (t) => String(t || '').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#?039;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const dropDateClashes = (rows, all) => { const taken = new Set(all.map((e) => `${e.venue}|${e.date}`)); return rows.filter((e) => !taken.has(`${e.venue}|${e.date}`)); };
const SOLD_OUT_SUFFIX = /\s*[-–—]\s*sold out!?\s*$/i;
const hexDecode = (t) => t.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));

// Run the sources `limit` at a time; answers come back in the sources' order. Each runs in its own call scope
// (failures.mjs), so a "Source failed" line is pinned to that source's own last call.
export async function readAll(fns, limit = 8) {
  const out = new Array(fns.length).fill(null), times = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, fns.length) }, async () => {
    while (next < fns.length) {
      const i = next++, t = Date.now();
      out[i] = await callScope(async (sc) => {
        try { return await fns[i](); }
        catch (err) { console.error('Source failed:', err.message); return null; }
        finally { // how long each source took, named by its function or the last address it asked
          let host = ''; try { host = new URL(sc.last).host; } catch {}
          times.push({ s: (Date.now() - t) / 1000, name: fns[i].name || host || `source ${i + 1}` });
        }
      });
    }
  }));
  out.times = times.sort((a, b) => b.s - a.s);
  return out;
}

export async function build(cfg = {}) {
  const isChurch = cfg.church === false ? () => false : citySources.isChurch;
  if (!isChurch) throw new Error('scripts/sources.mjs has no isChurch: pass church: false or add it');
  const FEED_URL = process.env.FEED_URL || cfg.feedUrl; // the live feed, read from the site's own domain
  const ARCHIVE_URL = process.env.ARCHIVE_URL || cfg.archiveUrl; // the second copy: every past event, on the orphan `archive` branch
  const strays = new Map();
  const knownVenue = (e) => { if (CANONICAL_VENUES.has(e.venue)) return true; strays.set(e.venue, (strays.get(e.venue) || 0) + 1); return false; };
  const keep = cfg.keepRow || (cfg.listedVenuesOnly ? knownVenue : () => true);
  const secondaryRows = cfg.secondaryRows || (cfg.listedVenuesOnly ? dropDateClashes : dropClashes);
  const fixTitle = cfg.fixTitle || (cfg.decodeEntities ? unent : (t) => t);
  const norm = cfg.normalizeVenue ? (e) => cfg.normalizeVenue(e, normalizeVenue) : normalizeVenue;

  const s = {
    tmFirst: Object.entries(CITY.venues).filter(([, v]) => v.tm && !v.tm.secondary).map(tmVenue).map(cfg.sessionVenues ? firstSessionOnly(new Set(cfg.sessionVenues)) : (f) => f),
    // venues whose own calendar is the voice of record (city.js tm.secondary): Ticketmaster fills only the dates that calendar lacks
    tmSecond: Object.entries(CITY.venues).filter(([, v]) => v.tm && v.tm.secondary).map(tmVenue),
    // venues whose own calendar leads (city.js `feed`) + the city-wide `feeds`
    feedsFirst: feedSources({ ...CITY, venues: splitVenues((v) => !v.feed?.secondary), ...(cfg.cityFeedsSecond ? { feeds: [] } : {}) }, BROWSER_UA),
    // venues whose own calendar fills in behind Ticketmaster
    feedsSecond: feedSources({ ...CITY, venues: splitVenues((v) => v.feed?.secondary), ...(cfg.cityFeedsSecond ? {} : { feeds: [] }) }, BROWSER_UA),
    ticketmasterVenue, tmPages, tmEvent, normalizeVenue: norm, BROWSER_UA,
  };
  const sources = cfg.primary ? cfg.primary(s) : [...s.tmFirst, ...s.feedsFirst];
  // Secondary sources re-list shows the primaries carry under other titles; anything at an already-taken
  // venue/date/time is dropped.
  const secondary = cfg.secondary ? cfg.secondary(s) : [...s.tmSecond, ...s.feedsSecond];

  // Church events never make the listing (Steve, 2026-10-11), judged on the source's own venue name and
  // title before anything folds into a catch-all row; the count is logged so a new church booking is visible.
  let churchDropped = 0;
  const noChurch = (rows) => (cfg.church === false ? rows : rows.filter((e) => { if (isChurch(e)) { churchDropped++; return false; } return true; }));

  // Every source is read side by side, SOURCE_CONCURRENCY at a time (Steve, 2026-11-03: "is there anyway to
  // speed up seattle"), and the answers are then taken in the listed order, so which source wins a clash is
  // what it was when they ran one after another. Ticketmaster stays one call at a time: every Discovery read
  // goes through tm-fetch.mjs's single queue. A source that throws counts as failed (null) and adds nothing.
  const t0 = Date.now();
  const got = await readAll([...sources, ...secondary], Number(process.env.SOURCE_CONCURRENCY) || 8);
  console.log(`Sources: ${sources.length + secondary.length} read in ${Math.round((Date.now() - t0) / 1000)} s; slowest ${got.times.slice(0, 5).map((x) => `${x.name} ${Math.round(x.s)} s`).join(', ')}; ${Math.round(got.times.reduce((a, x) => a + x.s, 0))} s summed`);
  let all = [];
  for (const raw of got.slice(0, sources.length)) if (raw) all = all.concat(noChurch(raw));
  if (cfg.afterPrimary) all = (await cfg.afterPrimary(all)) || all;
  all = all.map(norm).filter(keep);
  for (const raw of got.slice(sources.length)) {
    if (!raw) continue;
    const rows = noChurch(raw).map(norm).filter(keep).map((r) => ({ ...r, type: r.type || CITY.venues[r.venue]?.type || r.type })); // a typeless Ticketmaster row takes its venue's type
    const kept = secondaryRows(rows, all); // nothing already at that venue on that date with the same clock or title (merge.mjs)
    if (rows.length) console.log(`  secondary ${rows[0].venue}: ${kept.length} of ${rows.length} rows new`);
    all = all.concat(kept);
  }
  if (churchDropped) console.log(`Church events dropped: ${churchDropped}`);
  if (cfg.listedVenuesOnly) { const timed = new Set(all.filter((e) => e.time).map((e) => `${e.venue}|${e.url}|${e.date}`)); all = all.filter((e) => e.time || !timed.has(`${e.venue}|${e.url}|${e.date}`)); }
  if (strays.size) console.log(`Rows under venues city.js lacks, dropped: ${[...strays].map(([v, n]) => `${v} (${n})`).join(', ')}`);
  if (cfg.afterSources) all = (await cfg.afterSources(all)) || all;

  // window, de-dupe
  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + WINDOW_DAYS * 86400e3).toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 86400e3).toISOString().slice(0, 10);
  const seen = new Set();
  const fresh = all
    .filter((e) => e.date && e.date >= cutoff && e.date <= horizon)
    .filter((e) => !isNotice(e.title)) // a closure or construction notice is information, not an event
    .map((e) => ({ ...e, title: calmTitle(hexDecode(fixTitle(e.title))) }))
    .map((e) => (SOLD_OUT_SUFFIX.test(e.title) ? { ...e, title: e.title.replace(SOLD_OUT_SUFFIX, ''), soldOut: true } : e))
    .filter((e) => { const k = eventKey(e); if (seen.has(k)) return false; seen.add(k); return true; }); // venue|title|date|clock (merge.mjs): a second showing on one day is kept

  // the empty-list gate (feeds.mjs): nothing upcoming in this build's own pull means a venue was missed in
  // scouting or every source is down — not a fact about the town. ALLOW_EMPTY_LIST=1 overrides.
  const nSources = sources.length + secondary.length;
  if (!emptyListGate(fresh, today, cfg.gateSources ? cfg.gateSources(sources.length, secondary.length) : nSources)) process.exit(1);

  // carry past events forward. Two copies of the archive: the live feed and the `archive` branch's file
  // (every past event ever published; the workflow rewrites it after each build). Each is fetched with three
  // tries; the build goes on with the union of whatever it got and stops only when it got neither. Since the
  // union can only grow, a publish that lost history can no longer shrink the record.
  const cleanArchive = (d) => (Array.isArray(d) ? d : (d.events || []))
    .map((e) => (cfg.archiveRow ? cfg.archiveRow(e) : e))
    .filter((e) => cfg.church === false || !isChurch(e)) // past church events leave the record too
    .map(norm) // past events published under other spellings fold onto the one name
    .filter(keep)
    .filter((e) => !isNotice(e.title)).map((e) => ({ ...e, title: calmTitle(e.title) })); // the same title hygiene as fresh events, so the merge keys agree
  async function fetchArchive(url, what) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return cleanArchive(await r.json());
      } catch (err) {
        console.error(`${what} fetch (try ${attempt} of 3) failed: ${err.message}`);
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 20000));
      }
    }
    return null;
  }
  const [liveArchive, branchArchive] = await Promise.all([
    fetchArchive(FEED_URL, 'Live feed').then((a) => (a !== null || process.env.FEED_URL || !cfg.feedUrlOld ? a : fetchArchive(cfg.feedUrlOld, 'Live feed (old address)'))), // `feedUrlOld`: the site's address before here.events, read when the new one fails
    fetchArchive(ARCHIVE_URL, 'Archive branch'),
  ]);
  if (liveArchive === null && branchArchive === null && !process.env.ALLOW_NO_ARCHIVE) {
    console.error('No archive from either copy — not publishing (ALLOW_NO_ARCHIVE=1 to override for a first build)');
    process.exit(1);
  }
  if (liveArchive === null) console.error('Live feed unreadable — building on the archive branch copy');
  if (branchArchive === null) console.error('Archive branch unreadable — building on the live feed alone');
  const archived = unionArchives(liveArchive || [], branchArchive || []);
  console.log(`Archive: ${(liveArchive || []).length} events in the live feed, ${(branchArchive || []).length} on the archive branch, ${archived.length} in the union`);

  // venues whose read failed keep their upcoming rows: Ticketmaster's (tm-fetch.mjs), then a leading own calendar's (feeds.mjs)
  const keptFailed = () => { const tm = keepFailedVenues(archived, fresh, today); return tm.concat(keepFailedVenues(archived, fresh.concat(tm), today, feedFailedVenues, console.error, 'Own calendar')); };
  let merged = capUpcoming(mergeWithArchive(fresh.concat(keptFailed()), archived, today, cutoff), today, MAX_EVENTS);
  const ctx = { today, cutoff, horizon, archived, fresh };
  if (cfg.afterMerge) merged = (await cfg.afterMerge(merged, ctx)) || merged;
  await stampFestivals(merged, { city: CITY.key }); // the festivals Steve approved from the weekly list (scripts/festivals.mjs)

  // League schedules flag floating dates Ticketmaster doesn't know yet, and the full seasons (home and away)
  // feed the site's Teams view
  let seasons = {}, form = {};
  try { ({ teams: seasons, form } = await applySchedules(merged)); } catch (err) { console.error('Schedules step failed:', err.message); }
  ctx.seasons = seasons;
  // The clubs whose home games have no ticket feed here (city.js `inject`) enter the listing from the
  // league's schedule — typed sports, the club's ticket page as the link — unless the feed already has that
  // day at that ground (city.js teams, not badges' TEAMS, which carries only slug/label/re). schedules.mjs
  // already dates an ESPN placeholder on the Eastern day, so no day is shifted here.
  for (const t of CITY.teams.filter((x) => x.inject)) {
    for (const g of (seasons[t.slug] || []).filter((x) => x.home && x.date >= today)) { // from today: a written row is not a record of a past event (the archive keeps only what was listed)
      const ground = cfg.injectVenue ? cfg.injectVenue(t, g) : (t.inject.venue || t.venue || g.venue);
      const venue = CITY.venues[ground];
      if (g.venue && venue && venue.alias && !venue.alias.test(g.venue)) continue; // a neutral-site game ESPN flags as home (Creighton v Michigan at T-Mobile Arena, 2026-11-24) stays off the home ground
      const listed = merged.find((e) => e.date === g.date && (e.venue === ground || e.venue === g.venue));
      if (listed) { if (!listed.time && g.time && !g.tbd) listed.time = g.time; continue; } // the feed's listing stands; the league's first pitch fills a time it lacks
      merged.push({ venue: ground, title: `${t.inject.name || t.name || t.label} vs ${g.opp.name}`, date: g.date, time: g.time, url: t.inject.url, type: 'sports', ...(g.tbd ? { dateTbd: true } : {}), ...(g.watch ? { watch: g.watch } : {}) });
    }
  }
  if (cfg.afterInject) merged = (await cfg.afterInject(merged, ctx)) || merged;

  // Ticket availability for the Ticketmaster venues, from the sold-out checker (scripts/soldout-check.mjs →
  // scripts/data/soldout.json, which only lqa-events' launchd job writes; empty elsewhere unless `soldoutUrl`
  // reads lqa's): each on-sale event's box-office and resale counts and lowest price, and soldOut when the box
  // office has nothing left.
  try {
    let so = null;
    if (cfg.soldoutUrl) { // never a copy here, which froze on 2026-10-15 and kept calling games sold out (Kraken–Red Wings, 2026-10-20)
      for (let tries = 1; !so; tries++) {
        try {
          const r = await fetch(cfg.soldoutUrl, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          so = await r.json();
        } catch (err) { if (tries >= 3) throw err; await new Promise((r) => setTimeout(r, tries * 5000)); }
      }
    } else so = JSON.parse(readFileSync(new URL('./data/soldout.json', import.meta.url), 'utf8'));
    let n = 0, s = 0;
    for (const e of merged) {
      const m = (e.url || '').match(/\/event\/([0-9A-F]{16})/i), tw = ticketWebId(e.url); // Ticketmaster's 16-hex id, or TW<id> for a TicketWeb page (the Crocodile)
      const r = (m || tw) && (so.events || {})[m ? m[1].toUpperCase() : 'TW' + tw];
      if (!r || !/^(available|soldout)$/.test(r.status)) continue; // 'none' (nothing seen either way) and 'unknown' say nothing
      const out = r.status === 'soldout';
      e.tickets = { box: out ? 0 : (r.primary == null ? null : r.primary), resale: r.resale || 0, checked: r.checked }; // box null: on sale, count unknown (an older page layout)
      const from = out ? r.fromResale : r.fromPrimary;
      if (from != null) e.tickets.from = from;
      if (out) { e.soldOut = true; s++; }
      n++;
    }
    // the home teams' away games (the checker finds the host's listing by club and date): the same counts onto the season schedule
    let a = 0;
    for (const r of Object.values(so.events || {})) {
      if (!r.away || !r.club || !/^(available|soldout)$/.test(r.status) || /half price|\bpromo\b|\bpresale\b/i.test(r.name || '')) continue; // a promo's own listing ("HALF PRICE: …") never speaks for the game
      const g = (seasons[r.club] || []).find((x) => !x.home && x.date === r.date);
      if (!g) continue;
      const out = r.status === 'soldout';
      g.tickets = { box: out ? 0 : (r.primary == null ? null : r.primary), resale: r.resale || 0, checked: r.checked };
      const from = out ? r.fromResale : r.fromPrimary; if (from != null) g.tickets.from = from; if (out) g.soldOut = true;
      a++;
    }
    if (n || a) console.log(`soldout: ${n} events with ticket counts (checked ${so.generated}), ${s} sold out, ${a} away games`);
  } catch (err) { console.error('soldout.json:', err.message); }
  // A source that suddenly gives nothing keeps what it gave last time. Run on the finished list, so the rows
  // written above (team home games, weekly tables) count as listed (merge.mjs keepQuietVenues; Steve,
  // 2026-10-31: "feed source that errors out (or is suddenly empty) should keep last events")
  merged.push(...keepQuietVenues(archived, merged, today, { venues: new Set([...Object.keys(CITY.venues || {}), CITY.groundsVenue].filter(Boolean)), feeds: feedQuietVenues, sites: feedQuietSites }));
  merged.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  if (Object.keys(seasons).length) {
    const postseason = JSON.parse(readFileSync(new URL('./data/postseason.json', import.meta.url), 'utf8')); // each league's playoff rounds (hand-kept), shown until the real games land
    delete postseason._;
    writeFileSync(new URL('../site/teams.json', import.meta.url), JSON.stringify({ generated: new Date().toISOString(), teams: seasons, form, postseason }, null, 1) + '\n');
  } else {
    console.error('teams.json: no season fetched this run, the last one stands');
  }

  // ticket links that reach a real page: no scheme-less or wrapped links, a 404 goes to the venue's page (scripts/links.mjs);
  // a link that answered OK in the last two days (the record on the archive branch) is not asked again
  const linksRecordUrl = process.env.LINKS_RECORD_URL || (ARCHIVE_URL ? ARCHIVE_URL.replace(/events-archive\.json$/, 'links-checked.json') : '');
  let linksRecord = null;
  if (linksRecordUrl && process.env.LINKS_RECORD !== '0') {
    try { const r = await fetch(linksRecordUrl, { cache: 'no-store', signal: AbortSignal.timeout(15000), [Symbol.for('here.events/quiet')]: true }) /* a missing record (the first build) is no failure */; if (r.ok) linksRecord = (await r.json()).links || null; else if (r.status !== 404) console.log(`Links record: HTTP ${r.status} — every link checked`); }
    catch (err) { console.log(`Links record: ${err.message} — every link checked`); }
  }
  const links = await fixLinks(merged, { venues: CITY.venues, today, record: linksRecord || {} });
  writeFileSync(LINKS_OUT, JSON.stringify({ links: Object.fromEntries(Object.entries(links.record).sort()) }, null, 1) + '\n'); // the workflow commits it to the archive branch beside the archive
  writeFileSync(JSON_OUT, JSON.stringify({ generated: new Date().toISOString(), events: merged }, null, 2) + '\n');
  // the archive record: this build's past events on top of everything already recorded, never pruned
  const record = unionArchives(merged.filter((e) => e.date < today), archived.filter((e) => e.date < today));
  writeFileSync(ARCHIVE_OUT, JSON.stringify({ events: record }, null, 1) + '\n'); // no timestamp: the branch commits only when the events change
  console.log(`Archive record: ${record.length} past events`);
  writeFileSync(ICS_OUT, buildIcs(merged));

  // Filtered subscribe feeds, one per venue and one per badge, so the site's filter chips can offer a
  // matching calendar subscription.
  const siteDir = new URL('../site/', import.meta.url);
  let nFeeds = 0;
  for (const venue of new Set(merged.map((e) => e.venue))) {
    writeFileSync(new URL(`events-venue-${slugify(venue)}.ics`, siteDir), buildIcs(merged.filter((e) => e.venue === venue), new Date(), { calname: `${CITY.ics.short} — ${venue}` }));
    nFeeds++;
  }
  for (const [slug, [label, pred]] of Object.entries(BADGE_FEEDS)) {
    writeFileSync(new URL(`events-${slug}.ics`, siteDir), buildIcs(merged.filter(pred), new Date(), { calname: `${CITY.ics.short} — ${label}` }));
    nFeeds++;
  }
  // Exclusion feeds, one per local team: everything except that team's games.
  for (const t of TEAMS) {
    writeFileSync(new URL(`events-no-${t.slug}.ics`, siteDir), buildIcs(merged.filter((e) => !t.re.test(e.title || '')), new Date(), { calname: `${CITY.ics.short} — no ${t.label}` }));
    nFeeds++;
  }
  // a city's own extra feeds (lqa's and Seattle's default view hides SIFF's daily showings: events-no-movies.ics)
  for (const [file, rows, calname] of cfg.moreFeeds ? cfg.moreFeeds(merged) : []) {
    writeFileSync(new URL(file, siteDir), buildIcs(rows, new Date(), { calname }));
    nFeeds++;
  }
  // Season feeds for the Teams view: each club's whole season, home and away (team-<slug>.ics), and every
  // club's in one (teams.ics). Each game links to the club's page on the site.
  const seasonEvents = (slug, label, games) => games.map((g) => ({
    title: `${label} ${g.home ? 'vs' : 'at'} ${g.opp.name}${g.pre ? ' (preseason)' : g.playoff ? ' (playoff)' : ''}`,
    venue: g.venue || (g.home ? '' : g.opp.name), date: g.date, time: g.tbd ? null : g.time, ...(g.tbd ? { dateTbd: true } : {}),
    url: `${CITY.site}?team=${slug}`,
  }));
  const allSeasons = [];
  for (const t of TEAMS) {
    if (!seasons[t.slug]) continue;
    const evs = seasonEvents(t.slug, t.label, seasons[t.slug]);
    allSeasons.push(...evs);
    writeFileSync(new URL(`team-${t.slug}.ics`, siteDir), buildIcs(evs, new Date(), { calname: `${t.label} season` }));
    nFeeds++;
  }
  allSeasons.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  writeFileSync(new URL('teams.ics', siteDir), buildIcs(allSeasons, new Date(), { calname: CITY.ics.teams }));
  nFeeds++;

  const nPast = merged.filter((e) => e.date < today).length;
  console.log(`Wrote ${merged.length} events (${nPast} past, ${merged.length - nPast} upcoming) + ${nFeeds} filtered feeds`);
  return merged;
}
