#!/usr/bin/env node
/**
 * Aggregates upcoming events across Maui County — Maui, Lānaʻi and Molokaʻi —
 * into site/events.json and site/events.ics. Runs in CI (see
 * .github/workflows/events.yml) and locally for preview. The pipeline is
 * lqa-events' (scripts/*.mjs are its files, byte for byte); only the sources
 * below and site/city.js are Maui's.
 *
 * Each source returns [{ venue, title, date, time, url }]. Ticketmaster lists
 * almost nothing on Maui (two rows at the MACC, one at the ʻĪao Theater — both
 * rooms read their own calendars first, `tm.secondary`), so the island runs on
 * venue calendars: most through scripts/feeds.mjs (city.js `feed`), two parsed
 * here — the MACC's "Load More" pages and Da Playground's Shopify ticket shop.
 * The Rainbow Warriors' seasons come from ESPN (scripts/schedules.mjs).
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { buildIcs } from './ics.mjs';
import { isChurch } from './sources.mjs';
import { mergeWithArchive, unionArchives, eventKey } from './merge.mjs';
import { fixLinks } from './links.mjs';
import { calmTitle, isNotice } from './titles.mjs';
import { applySchedules } from './schedules.mjs';
import { slugify, BADGE_FEEDS, TEAMS, CITY } from './badges.mjs';
import { feedSources, emptyListGate, parseCards, cardDates } from './feeds.mjs';
import { tmFetch } from './tm-fetch.mjs';

const JSON_OUT = new URL('../site/events.json', import.meta.url);
const ICS_OUT = new URL('../site/events.ics', import.meta.url);
// A full year each way: venues announce whole seasons ahead, and past events
// are kept for a year (carried forward from the previously published feed —
// see mergeWithArchive).
const WINDOW_DAYS = 365;
// The live feed is read from the site's own domain (a build that reads
// neither copy of the archive refuses to publish — see mergeWithArchive;
// ALLOW_NO_ARCHIVE=1 lets the very first build through).
const FEED_URL = process.env.FEED_URL || 'https://maui.here.events/events.json';
// the second copy of the archive: every past event ever published, kept on
// the orphan `archive` branch by the workflow after each successful build
const ARCHIVE_URL = process.env.ARCHIVE_URL || 'https://raw.githubusercontent.com/sfosdal/maui-events/archive/events-archive.json';
const ARCHIVE_OUT = new URL('../events-archive.json', import.meta.url); // repo root, ignored; the workflow commits it to the branch
const MAX_EVENTS = 4000; // sanity cap, not a display cap

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Local runs: when the environment doesn't provide TICKETMASTER_API_KEY (CI
// passes it as a repo secret), pick it up from an untracked repo-root .env so
// the localhost preview gets the arena listings too.
if (!process.env.TICKETMASTER_API_KEY) {
  try {
    const m = readFileSync(new URL('../.env', import.meta.url), 'utf8')
      .match(/^TICKETMASTER_API_KEY=(.+)$/m);
    if (m) process.env.TICKETMASTER_API_KEY = m[1].trim();
  } catch { /* no .env — Ticketmaster sources warn and skip */ }
}

// --- Ticketmaster Discovery API ---
// Ticketmaster's resale marketplace (source "tmr": an id starting "Z7r9j", a
// ticketmaster.com/event/ link) lists shows whose box office is elsewhere, a
// second listing beside the primary, titled differently so the duplicate
// guard can't fold them. A resale listing is kept only when no primary one
// shares its date, and it links to the box office the listing names or the
// venue's own page, never to the resale offer.
const isResale = (e) => /^Z7r9j/.test(e.id || '');
function tmEvent(e, venue, fallbackUrl) {
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
  // a cancelled or postponed show stays in Ticketmaster's listing for a
  // while, marked in dates.status — pass that on rather than list it as if
  // it were still happening (the merge step drops it once it vanishes)
  const code = e.dates?.status?.code;
  if (code === 'cancelled' || code === 'postponed') ev.status = code;
  return ev;
}
function keepPrimary(rows) {
  const primaryDates = new Set(rows.filter((e) => !isResale(e)).map((e) => e.dates?.start?.localDate));
  return rows.filter((e) => !isResale(e) || !primaryDates.has(e.dates?.start?.localDate));
}
async function tmPages(params, label) {
  const key = process.env.TICKETMASTER_API_KEY;
  if (!key) { console.warn('No TICKETMASTER_API_KEY set — skipping Ticketmaster.'); return []; }
  const all = [];
  for (let page = 0; page < 5; page++) {
    const q = new URLSearchParams({ apikey: key, sort: 'date,asc', size: '200', page: String(page), ...params });
    const res = await tmFetch(`https://app.ticketmaster.com/discovery/v2/events.json?${q}`);
    if (!res.ok) { console.error(`Ticketmaster ${label} page ${page} HTTP ${res.status}`); break; }
    const data = await res.json();
    all.push(...(data?._embedded?.events || []));
    if (page + 1 >= (data?.page?.totalPages || 1)) break;
  }
  console.log(`Ticketmaster ${label}: ${all.length} events`);
  return all;
}
// by venue id (every page), for the rooms city.js names
async function ticketmasterVenue({ venueId, venueMatch, label, fallbackUrl, exclude }) {
  const rows = (await tmPages({ venueId }, label))
    .filter((e) => (e._embedded?.venues?.[0]?.name || '').toLowerCase().includes(venueMatch))
    .filter((e) => !exclude || !exclude.test(e.name || ''));
  return keepPrimary(rows).map((e) => tmEvent(e, label, fallbackUrl));
}
const tmRoom = ([label, v]) => () => ticketmasterVenue({ venueId: v.tm.id, venueMatch: v.tm.match, label, fallbackUrl: v.tm.fallbackUrl, exclude: v.tm.exclude });
const ticketmasterRooms = Object.entries(CITY.venues).filter(([, v]) => v.tm && !v.tm.secondary).map(tmRoom);
// Rooms whose own calendar is the voice of record (city.js tm.secondary): Ticketmaster fills only
// the dates that calendar lacks
const ticketmasterSecond = Object.entries(CITY.venues).filter(([, v]) => v.tm && v.tm.secondary).map(tmRoom);

// Rooms with their own calendar (city.js `feed`: the Palace's Events Calendar, ʻImiloa's Squarespace
// collection, the park's NPS listing, Honokaʻa's Eventbrite links) and the Vulcans' season iCal (city.js
// HTML entities in feed titles, decoded before the shared Title Case pass
const unent = (t) => String(t || '').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#?039;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// A room's own listing can also be the SECONDARY voice (city.js `feed.secondary`) behind
// Ticketmaster's timed rows — none here yet, the hook kept with the pipeline (Honolulu's Hawaii
// Theatre uses it). feeds.mjs reads one city object, so the venues are split in two.
const splitVenues = (keep) => Object.fromEntries(Object.entries(CITY.venues).filter(([, v]) => keep(v)));
const feedsFirst = feedSources({ ...CITY, venues: splitVenues((v) => !v.feed?.secondary) }, BROWSER_UA);
const feedsSecond = feedSources({ ...CITY, venues: splitVenues((v) => v.feed?.secondary), feeds: [] }, BROWSER_UA);
// A schema.org listing (the Maui Invitational's) names no type; such a row takes its room's
const roomType = (rows) => rows.map((e) => (e.type || !CITY.venues[e.venue] ? e : { ...e, type: CITY.venues[e.venue].type }));

// --- The Maui Arts & Cultural Center: its events listing ---
// mauiarts.org/events renders nine cards and loads the rest from
// /show-filtered-results?p=N — a plain GET answering { status, newHtml, lastPage } — so the
// pages are read one after another and cut into cards (feeds.mjs parseCards): <h2 class="show-title">
// under the show-details link, the date and clock in <div class="show-date"> ("October 28, 2026 at
// 7:00 pm"). The room (Castle, McCoy, the Amphitheater) is only on the detail page and is not read.
const MACC_URL = 'https://mauiarts.org/show-filtered-results';
const MACC_CARD = { item: '<div class="show-item"', title: /<a\s+href="([^"]+)">\s*<h2 class="show-title">([^<]+)<\/h2>/, when: /<div class="show-date">\s*<p>(?:<i[^>]*><\/i>)?\s*([^<]+?)\s*<\/p>/ };
export function parseMaccPage(html) {
  return parseCards(html, { ...MACC_CARD, venue: 'Maui Arts & Cultural Center', type: 'arts', base: 'https://mauiarts.org/' });
}
async function maccListing() {
  const out = [];
  let pages = 0;
  for (let page = 1; page <= 12; page++) {
    const res = await fetch(`${MACC_URL}?p=${page}`, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } }); // `p`, as the page's Load More button sends it (`page` is ignored and answers the first nine every time)
    if (!res.ok) throw new Error(`MACC page ${page} HTTP ${res.status}`);
    const data = await res.json();
    out.push(...parseMaccPage(data.newHtml || '')); pages++;
    if (page >= Number(data.lastPage || 1)) break;
  }
  console.log(`Maui Arts & Cultural Center: ${out.length} events from ${pages} pages`);
  return out;
}

// --- The ʻĪao Theater: Maui OnStage's home page ---
// mauionstage.com lists the season as text cards (a Divi builder page): a date line in a <span>
// ("Oct 23", "Feb 14, 2027", "*NEW DATE – Nov 21"), the title in <b> inside an <h3> or a <p>, then
// a TICKETS link (ThunderTix, Ticketmaster, the First Friday site) — or "Tickets available SOON!"
// and no link, which goes in pointing at the home page. A card without a date (the donation and
// gift-certificate panels, "Ongoing") is skipped. No clock is printed; the rows go in as all-day.
const IAO_URL = 'https://www.mauionstage.com/';
export function parseIao(html) {
  const out = [];
  for (const card of String(html || '').split('<div class="et_pb_text_inner">').slice(1)) {
    const d = /<span[^>]*>(?:[^<]*?(?:&#8211;|–|-)\s*)?([A-Z][a-z]{2,8}\.? \d{1,2}(?:,? \d{4})?)\s*<\/span>/.exec(card);
    const t = /<(?:h3|p)[^>]*>(?:<span[^>]*>)*<b[^>]*>([^<]+)<\/b>/.exec(card);
    if (!d || !t) continue;
    const dates = cardDates(d[1]); if (!dates.length) continue;
    const a = /<a href=['"]([^'"]+)['"][^>]*>\s*TICKETS/i.exec(card);
    const title = unent(t[1]).replace(/\s+/g, ' ').trim();
    for (const { date } of dates) out.push({ venue: 'ʻĪao Theater', title, date, time: '', url: a ? unent(a[1]) : IAO_URL, type: 'arts' }); // cardDates gives { date, time }; no clock is printed
  }
  return out;
}
async function iaoListing() {
  const res = await fetch(IAO_URL, { headers: { 'User-Agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`ʻĪao Theater HTTP ${res.status}`);
  const evs = parseIao(await res.text());
  console.log(`ʻĪao Theater: ${evs.length} events`);
  return evs;
}

// --- Da Playground: its Shopify ticket shop ---
// daplaygroundmaui.com/collections/tickets lists each show as a product card — the title in
// <h3 class="card__heading"> over a caption "Friday - 10/30/2026" — and /collections/tickets/
// products.json carries the same products with their variants' `available` flags, so a show whose
// every variant is gone is sold out. No clock is printed (the body copy names one in prose); the
// rows go in as all-day.
const DPG_BASE = 'https://www.daplaygroundmaui.com';
export function parseDaPlayground(html, products = []) {
  const gone = new Set(products.filter((p) => Array.isArray(p.variants) && p.variants.length && p.variants.every((v) => v.available === false)).map((p) => p.handle));
  const out = [];
  const seen = new Set();
  for (const card of String(html || '').split('<div class="card__content">').slice(1)) { // each product's text block: the heading's link, then the caption
    const a = /<h3[^>]*class="card__heading[^"]*"[^>]*>\s*<a\s+href="(\/products\/([^"?#]+))"[^>]*>\s*([\s\S]*?)\s*<\/a>/.exec(card);
    const d = /caption-large light">\s*(?:[A-Za-z]+\s*-\s*)?(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(card);
    if (!a || !d) continue;
    const handle = a[2]; if (seen.has(handle)) continue; seen.add(handle);
    const title = unent(a[3].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); if (!title) continue;
    const ev = { venue: 'Da Playground', title, date: `${d[3]}-${d[1].padStart(2, '0')}-${d[2].padStart(2, '0')}`, time: '', url: DPG_BASE + a[1], type: 'concert' };
    if (gone.has(handle)) ev.soldOut = true;
    out.push(ev);
  }
  return out;
}
async function daPlayground() {
  const res = await fetch(`${DPG_BASE}/collections/tickets`, { headers: { 'User-Agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`Da Playground HTTP ${res.status}`);
  const html = await res.text();
  let products = [];
  try { const r = await fetch(`${DPG_BASE}/collections/tickets/products.json?limit=250`, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } }); if (r.ok) products = (await r.json()).products || []; }
  catch (err) { console.error(`Da Playground products.json: ${err.message}`); }
  const evs = parseDaPlayground(html, products);
  console.log(`Da Playground: ${evs.length} events, ${evs.filter((e) => e.soldOut).length} sold out`);
  return evs;
}

const sources = [...ticketmasterRooms, ...feedsFirst, maccListing, iaoListing, daPlayground].map((fn) => async () => roomType(await fn())); // a row Ticketmaster or a schema.org listing files under no type takes its room's
// Secondary sources re-list shows the primaries carry under other titles — Ticketmaster's rows for
// the rooms whose own calendar is read first. Clocks differ between listings, so the secondary rows
// are dropped by venue and date rather than by the shared dropTimeClashes.
const secondary = [...ticketmasterSecond, ...feedsSecond];
const dropDateClashes = (rows, all) => { const taken = new Set(all.map((e) => `${e.venue}|${e.date}`)); return rows.filter((e) => !taken.has(`${e.venue}|${e.date}`)); };

// Venue names as city.js spells them: a venue listed under other spellings
// (`alias` — "Bankoh Arena at the Stan Sheriff Center", "Hawaii Theatre")
// folds to its one name; Honolulu sets no `groundsVenue`, so a row that
// still arrives under a name city.js lacks is dropped (and counted) rather
// than listed under a stray name.
const CANONICAL_VENUES = new Set(Object.keys(CITY.venues));
const ALIASES = Object.entries(CITY.venues).filter(([, v]) => v.alias).map(([label, v]) => [label, v.alias]);
const aliasHit = (s) => { const hit = ALIASES.find(([, re]) => re.test(s || '')); return hit ? hit[0] : null; };
const aliasVenue = (name) => aliasHit(name) || name;
// A listing whose venue field is just the city names its room at the end of
// the title ("X live at The Vic").
const roomInTitle = (title) => { const m = /\b(?:at|@)\s+(.+)$/i.exec(title || ''); return m ? aliasHit(m[1]) : null; };
const normalizeVenue = (e) => {
  const byName = aliasVenue(e.venue);
  const venue = CANONICAL_VENUES.has(byName) ? byName : (roomInTitle(e.title) || byName);
  if (CITY.groundsVenue && !CANONICAL_VENUES.has(venue)) return { ...e, venue: CITY.groundsVenue };
  return venue === e.venue ? e : { ...e, venue };
};
const strays = new Map();
const knownVenue = (e) => { if (CANONICAL_VENUES.has(e.venue)) return true; strays.set(e.venue, (strays.get(e.venue) || 0) + 1); return false; };

// Church events never make the listing (Steve, 2026-10-11, for Everett;
// the same here), judged on the
// source's own venue name and title before anything folds into the
// Elsewhere row; the count is logged so a new church booking is visible.
let churchDropped = 0;
const noChurch = (rows) => rows.filter((e) => { if (isChurch(e)) { churchDropped++; return false; } return true; });

let all = [];
for (const src of sources) {
  try { all = all.concat(noChurch(await src()).map(normalizeVenue).filter(knownVenue)); }
  catch (err) { console.error('Source failed:', err.message); }
}
for (const src of secondary) {
  try { all = all.concat(dropDateClashes(noChurch(await src()).map(normalizeVenue).filter(knownVenue), all)); }
  catch (err) { console.error('Source failed:', err.message); }
}
if (churchDropped) console.log(`Church events dropped: ${churchDropped}`);
// A listing that prints a show twice — once with a clock, once without (the Palace's all-day film
// rows beside its timed ones): when a timed row shares a venue, link and date with an untimed one,
// the untimed one goes
{ const timed = new Set(all.filter((e) => e.time).map((e) => `${e.venue}|${e.url}|${e.date}`)); all = all.filter((e) => e.time || !timed.has(`${e.venue}|${e.url}|${e.date}`)); }
if (strays.size) console.log(`Rows under venues city.js lacks, dropped: ${[...strays].map(([v, n]) => `${v} (${n})`).join(', ')}`);

// window, de-dupe, sort
const today = new Date().toISOString().slice(0, 10);
const horizon = new Date(Date.now() + WINDOW_DAYS * 86400e3).toISOString().slice(0, 10);
const cutoff = new Date(Date.now() - WINDOW_DAYS * 86400e3).toISOString().slice(0, 10);
const seen = new Set();
const fresh = all
  .filter((e) => e.date && e.date >= cutoff && e.date <= horizon)
  .filter((e) => !isNotice(e.title)) // a closure or construction notice is information, not an event
  .map((e) => ({ ...e, title: calmTitle(unent(e.title)) })) // shouted titles (the Concert Society's season page) come down to Title Case, entities decoded first
  .map((e) => (/\s*[-–—]\s*sold out!?\s*$/i.test(e.title) ? { ...e, title: e.title.replace(/\s*[-–—]\s*sold out!?\s*$/i, ''), soldOut: true } : e)) // a "– Sold Out!" title suffix is the tag, not the words
  .filter((e) => { const k = eventKey(e); if (seen.has(k)) return false; seen.add(k); return true; }); // venue|title|date|clock (merge.mjs): a second showing on one day is kept

// the empty-list gate (feeds.mjs): nothing upcoming in this build's own pull means a room was
// missed in scouting or every source is down — not a fact about the town. ALLOW_EMPTY_LIST=1 overrides.
if (!emptyListGate(fresh, today, sources.length)) process.exit(1);

// carry past events forward. Two copies of the archive: the live feed and
// the `archive` branch's file (every past event ever published; the workflow
// rewrites it after each build). Each is fetched with three tries; the build
// goes on with the union of whatever it got and stops only when it got
// neither. Since the union can only grow, a publish that lost history can no
// longer shrink the record.
const cleanArchive = (d) => (Array.isArray(d) ? d : (d.events || []))
  .filter((e) => !isChurch(e)) // past church events leave the record too
  .map(normalizeVenue).filter(knownVenue) // past events published under other spellings fold onto the one name
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
  fetchArchive(FEED_URL, 'Live feed'),
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

const merged = mergeWithArchive(fresh, archived, today, cutoff).slice(-MAX_EVENTS);

// League schedules flag floating dates Ticketmaster doesn't know yet, and
// the full seasons (home and away) feed the site's Teams view
let seasons = {}, form = {};
try { ({ teams: seasons, form } = await applySchedules(merged)); } catch (err) { console.error('Schedules step failed:', err.message); }
// The clubs whose home games have no ticket feed here (city.js `inject`: the
// none here — the Vulcans' dates come as listings from their season calendar) enter the listing from the league's schedule —
// typed sports, the club's ticket page as the link — unless the feed already
// has that day at that ground
// (city.js teams, not badges' TEAMS, which carries only slug/label/re — the
// loop was a no-op until 2026-10-11; the game takes the club's own ground name)
for (const t of CITY.teams.filter((x) => x.inject)) {
  for (const g of (seasons[t.slug] || []).filter((x) => x.home && x.date >= today)) { // from today: a written row is not a record of a past event (the archive keeps only what was listed)
    const ground = t.inject.venue || t.venue || g.venue;
    const room = CITY.venues[ground];
    if (g.venue && room && room.alias && !room.alias.test(g.venue)) continue; // a neutral-site game ESPN flags as home (Creighton v Michigan at T-Mobile Arena, 2026-11-24) stays off the home ground
    const listed = merged.find((e) => e.date === g.date && (e.venue === ground || e.venue === g.venue));
    if (listed) { if (!listed.time && g.time && !g.tbd) listed.time = g.time; continue; } // the feed's listing stands; the league's first pitch fills a time it lacks
    merged.push({ venue: ground, title: `${t.inject.name || t.name || t.label} vs ${g.opp.name}`, date: g.date, time: g.time, url: t.inject.url, type: 'sports', ...(g.tbd ? { dateTbd: true } : {}), ...(g.watch ? { watch: g.watch } : {}) });
  }
}
// Ticket availability for the Ticketmaster venues, from a local checker
// (scripts/data/soldout.json — empty until one runs for Honolulu): counts and
// lowest price, and soldOut when the box office has nothing left.
try {
  const so = JSON.parse(readFileSync(new URL('./data/soldout.json', import.meta.url), 'utf8'));
  let n = 0, s = 0;
  for (const e of merged) {
    const m = (e.url || '').match(/\/event\/([0-9A-F]{16})/i); // Ticketmaster's 16-hex id
    const r = m && (so.events || {})[m[1].toUpperCase()];
    if (!r || !/^(available|soldout)$/.test(r.status)) continue;
    const out = r.status === 'soldout';
    e.tickets = { box: out ? 0 : (r.primary == null ? null : r.primary), resale: r.resale || 0, checked: r.checked };
    const from = out ? r.fromResale : r.fromPrimary;
    if (from != null) e.tickets.from = from;
    if (out) { e.soldOut = true; s++; }
    n++;
  }
  if (n) console.log(`soldout: ${n} events with ticket counts (checked ${so.generated}), ${s} sold out`);
} catch (err) { console.error('soldout.json:', err.message); }
merged.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
if (Object.keys(seasons).length) {
  const postseason = JSON.parse(readFileSync(new URL('./data/postseason.json', import.meta.url), 'utf8')); // each league's playoff rounds (hand-kept), shown until the real games land
  delete postseason._;
  writeFileSync(new URL('../site/teams.json', import.meta.url), JSON.stringify({ generated: new Date().toISOString(), teams: seasons, form, postseason }, null, 1) + '\n');
} else {
  console.error('teams.json: no season fetched this run, the last one stands');
}

await fixLinks(merged, { venues: CITY.venues, today }); // ticket links that reach a real page: no scheme-less or wrapped links, a 404 goes to the venue's page (scripts/links.mjs)
writeFileSync(JSON_OUT, JSON.stringify({ generated: new Date().toISOString(), events: merged }, null, 2) + '\n');
// the archive record: this build's past events on top of everything already
// recorded, never pruned (the feed keeps a year; the branch keeps it all)
const record = unionArchives(merged.filter((e) => e.date < today), archived.filter((e) => e.date < today));
writeFileSync(ARCHIVE_OUT, JSON.stringify({ events: record }, null, 1) + '\n'); // no timestamp: the branch commits only when the events change
console.log(`Archive record: ${record.length} past events`);
writeFileSync(ICS_OUT, buildIcs(merged));

// Filtered subscribe feeds, one per venue and one per badge, so the site's
// filter chips can offer a matching calendar subscription.
const siteDir = new URL('../site/', import.meta.url);
let nFeeds = 0;
for (const venue of new Set(merged.map((e) => e.venue))) {
  const evs = merged.filter((e) => e.venue === venue);
  writeFileSync(new URL(`events-venue-${slugify(venue)}.ics`, siteDir),
    buildIcs(evs, new Date(), { calname: `${CITY.ics.short} — ${venue}` }));
  nFeeds++;
}
for (const [slug, [label, pred]] of Object.entries(BADGE_FEEDS)) {
  writeFileSync(new URL(`events-${slug}.ics`, siteDir),
    buildIcs(merged.filter(pred), new Date(), { calname: `${CITY.ics.short} — ${label}` }));
  nFeeds++;
}
// Exclusion feeds, one per local team: everything except that team's games.
for (const t of TEAMS) {
  writeFileSync(new URL(`events-no-${t.slug}.ics`, siteDir),
    buildIcs(merged.filter((e) => !t.re.test(e.title || '')), new Date(), { calname: `${CITY.ics.short} — no ${t.label}` }));
  nFeeds++;
}
// Season feeds for the Teams view: each club's whole season, home and away
// (team-<slug>.ics), and every club's in one (teams.ics). Each game links to
// the club's page on the site.
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
writeFileSync(new URL('teams.ics', siteDir), buildIcs(allSeasons, new Date(), { calname: CITY.ics.teams }));
nFeeds++;

const nPast = merged.filter((e) => e.date < today).length;
console.log(`Wrote ${merged.length} events (${nPast} past, ${merged.length - nPast} upcoming) + ${nFeeds} filtered feeds`);
