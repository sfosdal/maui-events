/**
 * Generic venue feeds, keyed from city.js — the non-Ticketmaster counterpart
 * of a venue's `tm` block (shared across the sister sites; lqa-events is the
 * source of truth, copy from there). A venue row carries
 *
 *   feed: { kind: 'tribe', url: 'https://<site>/wp-json/tribe/events/v1/events',
 *           drop: /box office open/i,   // optional: titles that are hours, not events
 *           maxRepeat: 8 }              // optional: a title on more dates than this is a daily row (default 8)
 *
 * and fetch-events.mjs adds `feedSources(CITY, ua)` to its source list; a
 * missed room is then a line in city.js and a rebuild, not a new parser
 * (Steve, 2026-10-13, after Field Arts & Events Hall was missed in Port
 * Angeles: "do 1, 2 & 3").
 *
 * A ticketer that lists a whole town (TusBoletos, eticket in Cancún) is a
 * city-wide feed instead: city.js `feeds: [{ kind, url, label, … }]`, where
 * each listing keeps the room the ticketer names and fetch-events.mjs folds
 * it onto a venue row by `alias`, or into `groundsVenue` (cancun-events,
 * 2026-10-13, the first city without Ticketmaster).
 *
 * Kinds:
 *   tribe      — WordPress + The Events Calendar's REST API (/wp-json/tribe/events/v1/events).
 *                start_date is the venue's wall clock ("YYYY-MM-DD HH:MM:SS"); `website` is the
 *                ticket link when the venue sets one, else the event page; categories give the type.
 *   tusboletos — tusboletos.mx (the Yucatán peninsula's ticketer): the server-rendered /eventos
 *                list, one card per event with the title, the city ("Cancún, Quintana Roo"), the
 *                room, a Spanish date and a commented-out category; the clock sits on the event
 *                page ("6:30 P.M. y 9:00 P.M." = two showings, one listing each). `cities` picks
 *                the towns to keep, each with an optional suffix for its room names.
 *   ics        — The Events Calendar's iCal export (`<list url>?ical=1`) for a site that has shut
 *                its REST API (Field Arts & Events Hall answered 401 to every /wp-json call from
 *                2026-10-14; the export still served). The list view exports the month that
 *                holds `tribe-bar-date`, from that date on, at most 30 events — so the fetch
 *                walks month by month for a year, and again from the day after the last
 *                event when a month came back full. Rows are reshaped like REST rows and mapped
 *                the same way; URL is the event page, LOCATION's first part the room,
 *                CATEGORIES the type.
 *   jsonld     — any page that marks its events up as schema.org Event (eticket.mx's city and
 *                venue listings): name, startDate as the wall clock, url, location.name, the
 *                offers' availability (every one SoldOut = sold out), eventStatus. `at` keeps only
 *                the events whose location matches. The page's charset is honoured (eticket
 *                serves ISO-8859-15, decoded as windows-1252).
 *   ticketera  — ticketera.com (Puerto Rico's ticketer): the rooms' own listing pages, each event's
 *                page for its showings and clock, the category pages for its type — fetched through
 *                scripts/cffi-fetch.py (a Chrome TLS fingerprint, via uv), since its edge refuses
 *                plain clients (San Juan, 2026-10-14).
 *   icsfile    — one whole-season iCalendar file (Sidearm's calendar.ics for a college's teams,
 *                PrestoSports' `?print=ical` for a summer league): one fetch, every VEVENT a row.
 *                DTSTART in UTC becomes the city's wall clock (`tz`), a TZID one is read in its
 *                zone, a floating one as written, VALUE=DATE is an all-day row. `rooms` keeps the
 *                LOCATIONs wanted (a college's calendar lists its away games too), `rename` is a
 *                list of [regex, replacement] applied to the title in order ("[W] University of
 *                Alaska Anchorage Women's Volleyball vs X" → "UAA Women's Volleyball vs X"), the
 *                link is DESCRIPTION's "Tickets: <url>" when there is one, else URL (Anchorage,
 *                2026-10-15).
 *   linked     — a listing page whose events are links to ticket pages that carry schema.org Event
 *                markup (Bear Tooth Theatrepub's Squarespace page: a date, a title and a "Buy
 *                Tickets" link to Eventbrite per show, nothing machine-readable on the page
 *                itself): the links `match` picks (unique, query stripped, at most `max` = 40) are
 *                fetched one by one and read like `jsonld`; `at` keeps those whose location names
 *                the room (Anchorage, 2026-10-15).
 *   squarespace — a Squarespace site's events collection (`<collection page>?format=json`): its
 *                `upcoming` items carry an epoch-ms startDate read on the site's own clock
 *                (website.timeZone), a title, a site-relative fullUrl and, city-wide, a
 *                location.addressTitle room (the Everett pattern, shared 2026-10-15 for the Seattle
 *                Jazz Fellowship and Nordo in Pioneer Square). `drop` takes titles by name.
 *   cards       — a server-rendered listing with no markup to speak of (the Alliance for Pioneer
 *                Square's neighbourhood calendar, 2026-10-15): the page is cut into cards at `item`,
 *                and in each `title` captures the link and the name, `when` the date text ("October
 *                15, 2026 | 10:00 AM - 2:00 PM"; "December 05-06, 2026 | …" is one row per day, up to
 *                a week; "15 Oct" with no year is the nearest one forward; every capture group is
 *                joined, so a date span and a clock span can be two groups) and `place` the room,
 *                which folds by alias or into `groundsVenue` like any city-wide feed; `type` is the
 *                rows' default type. Also a room's own `feed` (the Central Saloon's Modern Events
 *                Calendar list, whose JSON-LD has dates but no clocks).
 *                `time` is the clock for cards that print none. `venues` (a regex on `place`) keeps
 *                only the cards of the venue wanted when the listing covers several (Lumen Field's
 *                calendar lists the WAMU Theater's nights too; the Crocodile's its promotions at
 *                other clubs — 2026-10-26).
 *   mec         — a Modern Events Calendar list page (STG's stgpresents.org/events, 2026-10-26):
 *                the page's first cards plus every "load more" page, POSTed to admin-ajax.php the
 *                way the plugin's own script does (action mec_list_load_more with the skin's
 *                `atts`, the last page's end_date and offset). A card gives the title and link
 *                (a trailing CANCELED / POSTPONED becomes the row's status), "Oct 26" or "Oct 29
 *                2026", a clock and the venue's name; `venues` (a regex on that name) picks the
 *                venue's own cards out of the presenter's whole listing. The list shows a
 *                multi-night run once (its first night).
 *   nps         — the National Park Service events API for one park (`parkCode=`; NPS_API_KEY in
 *                the environment, else the data.gov DEMO_KEY): one row per listed date at the
 *                first start time (Klondike Gold Rush NHP's Seattle unit, Pioneer Square 2026-10-15).
 *   boldtype    — a Bold Type Tickets box office (strangertickets.com, merctickets.com): its Browse
 *                list, POSTed page by page for one `city`, names each show's room; `rooms` (a regex
 *                on that room, required where the city has a groundsVenue) picks the shows, and
 *                each kept show's page is read like `jsonld` for its clock, sold-out offers and
 *                status (the Royal Room via Stranger Tickets, Seattle 2026-10-19).
 *   spektrix    — a Spektrix box office's public API (system.spektrix.com/<client>/api/v3): /events
 *                for the names, /instances for every performance (`start` is the theatre's wall
 *                clock), one row each; cancelled ones and events marked "exclude from the events
 *                page" are left out, `drop` takes classes and auditions by name, and the first
 *                `maxStatus` (default 60) upcoming performances are asked /status — none available
 *                = sold out. `link` is the ticket page, `{id}` filled with the event id's leading
 *                digits — the number the theatre's own purchase site uses (Pentacle Theatre,
 *                Salem 2026-10-20).
 *
 * Also here: the empty-list gate every build runs (`emptyListGate`) — a
 * fresh pull with zero upcoming events is a scouting failure or an outage,
 * never a fact about the town, so the build says so loudly and stops
 * (ALLOW_EMPTY_LIST=1 lets a genuinely empty town through on purpose).
 */

const decode = (s) => String(s || '')
  .replace(/&#8211;/g, '–').replace(/&#8217;/g, '’').replace(/&#8216;/g, '‘').replace(/&#8220;/g, '“').replace(/&#8221;/g, '”')
  .replace(/&#038;|&amp;/g, '&').replace(/&#039;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))) // Webflow writes apostrophes as &#x27; (the Crocodile's calendar)
  .replace(/&([A-Za-z]+);/g, (m, n) => LATIN[n] || m) // the accented letters a Spanish listing spells as entities (Ticketera: "La &Uacute;ltima Noche")
  .replace(/\s+/g, ' ').trim();
const LATIN = { aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü', iquest: '¿', iexcl: '¡', ccedil: 'ç', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…' };

// The Events Calendar's categories → the site's event types. Films are a
// 'movie' only where the city lists that type (lqa does; a town with no
// cinema folds them into arts).
const TRIBE_TYPE = [
  [/sport|game|match/i, 'sports'],
  [/film|movie|cinema/i, 'movie'],
  [/comedy|theat|dance|ballet|opera|musical|drama|storytell|humanities|lecture|talk|science|gallery|art\b|arts\b/i, 'arts'],
  [/music|jazz|concert|rock|country|folk|blues|bluegrass|world|band|singer|open mic/i, 'concert'],
  [/fair|festival|market|community|family|fundrais|food|drink|party|holiday/i, 'community'],
];
export function tribeType(categories, allowed) {
  const names = (categories || []).map((c) => decode(c.name || c)).join(' | ');
  for (const [re, type] of TRIBE_TYPE) {
    if (!re.test(names)) continue;
    if (type === 'movie' && allowed && !allowed.has('movie')) return allowed.has('arts') ? 'arts' : null;
    if (!allowed || allowed.has(type)) return type;
  }
  return null;
}

/**
 * Map The Events Calendar's REST rows to feed events. Daily rows — a title
 * the venue repeats on more than `maxRepeat` dates (box-office hours, an
 * exhibition's run) — are left out, as is anything `drop` matches. A venue
 * feed names its room (`venueLabel`); a city-wide feed (`venueLabel` null —
 * a resort's calendar covering several rooms) takes each row's own venue
 * name, for the aliases to fold, and `rooms` (a regex on that name) keeps
 * only the rooms wanted from it.
 * Returns [{ venue, title, date, time, url, type? }].
 */
export function mapTribeEvents(rows, venueLabel, opts = {}) {
  const { drop, maxRepeat = 8, types, defaultType, rooms, label = venueLabel || 'feed' } = opts;
  const allowed = types ? new Set(types) : null;
  const rowVenue = (e) => { const v = Array.isArray(e.venue) ? e.venue[0] : e.venue; return decode(v?.venue || v?.name || ''); }; // a community calendar (B-Town Blog, Burien) sends `venue` as a one-element array
  const list = (Array.isArray(rows) ? rows : rows?.events || []).filter((e) => e && e.title && e.start_date && e.status !== 'draft' && !e.hide_from_listings)
    .filter((e) => !rooms || rooms.test(rowVenue(e)));
  const dates = new Map();
  for (const e of list) { const t = decode(e.title); if (!dates.has(t)) dates.set(t, new Set()); dates.get(t).add(e.start_date.slice(0, 10)); }
  const out = [];
  let daily = 0;
  for (const e of list) {
    const title = decode(e.title);
    if (drop && drop.test(title)) continue;
    if (dates.get(title).size > maxRepeat) { daily++; continue; }
    const [date, clock] = e.start_date.split(' ');
    const ev = { venue: venueLabel || rowVenue(e), title, date, time: e.all_day || !clock ? '' : clock.slice(0, 5), url: e.website || e.url || '' };
    const type = tribeType(e.categories, allowed) || defaultType;
    if (type) ev.type = type;
    out.push(ev);
  }
  if (daily) console.log(`${label}: ${daily} daily rows (hours, exhibitions) left out`);
  return out;
}

async function fetchTribe(url, ua, label, opts) {
  const today = new Date().toISOString().slice(0, 10);
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const u = new URL(url);
    u.searchParams.set('per_page', '50'); u.searchParams.set('page', String(page)); u.searchParams.set('start_date', today);
    const res = await fetch(u, { headers: { 'User-Agent': ua, Accept: 'application/json' } });
    if (!res.ok) { if (page === 1 || res.status !== 400) console.error(`${label} page ${page} HTTP ${res.status}`); break; } // Tribe answers 400 past the last page
    const data = await res.json();
    all.push(...(data.events || []));
    if (page >= (data.total_pages || 1)) break;
  }
  const evs = mapTribeEvents(all, opts.venue, { ...opts, label });
  console.log(`${label} (Events Calendar): ${evs.length} events from ${all.length} rows`);
  return evs;
}

// ---- The Events Calendar's iCal export ----
/**
 * A minimal iCalendar reader: folded lines joined, VEVENTs as { PROP: { value, params } }
 * with the text escapes (\, \; \\ \n) undone. Enough for a Tribe export; not a full RFC 5545.
 */
export function parseIcs(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const out = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) out.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const [name, ...params] = line.slice(0, i).split(';');
    const value = line.slice(i + 1).replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
    cur[name] = { value, params: Object.fromEntries(params.map((q) => q.split('='))) };
  }
  return out;
}

/** Tribe iCal VEVENTs as rows shaped like its REST rows, for mapTribeEvents. */
export function icsToTribeRows(text) {
  return parseIcs(text).map((v) => {
    const dt = v.DTSTART;
    if (!v.SUMMARY || !dt) return null;
    const m = dt.value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/);
    if (!m) return null;
    const allDay = dt.params.VALUE === 'DATE' || !m[4];
    return {
      title: decode(v.SUMMARY.value), start_date: `${m[1]}-${m[2]}-${m[3]} ${allDay ? '00:00' : `${m[4]}:${m[5]}`}:00`,
      all_day: allDay, status: 'publish', url: (v.URL || {}).value || '',
      venue: { venue: decode(((v.LOCATION || {}).value || '').split(',')[0]) },
      categories: ((v.CATEGORIES || {}).value || '').split(',').map((n) => n.trim()).filter(Boolean).map((name) => ({ name })),
      uid: (v.UID || {}).value || '',
    };
  }).filter(Boolean);
}

const ICS_PAGE = 30; // the export's cap per call
const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const nextMonth = (ymd) => { const d = new Date(`${ymd.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10); };
async function fetchIcs(url, ua, label, opts) {
  const today = new Date().toISOString().slice(0, 10);
  const until = nextMonth(addDays(today, 365)); // a year out, the build's horizon (fetch-events WINDOW_DAYS)
  const rows = [];
  const seen = new Set();
  let bar = today;
  for (let call = 1; call <= 30 && bar < until; call++) {
    const u = new URL(url);
    u.searchParams.set('ical', '1'); u.searchParams.set('tribe-bar-date', bar);
    const res = await fetch(u, { headers: { 'User-Agent': ua, Accept: 'text/calendar,*/*' } });
    if (!res.ok) { console.error(`${label} from ${bar} HTTP ${res.status}`); break; }
    const batch = icsToTribeRows(await res.text()).filter((r) => r.start_date >= today);
    let last = bar;
    for (const r of batch) {
      const k = r.uid || `${r.title}|${r.start_date}`;
      if (seen.has(k)) continue;
      seen.add(k); rows.push(r);
      if (r.start_date.slice(0, 10) > last) last = r.start_date.slice(0, 10);
    }
    // a full page may have cut the month short: go on from the day after its last event; else the next month
    bar = batch.length >= ICS_PAGE && last > bar ? addDays(last, 1) : nextMonth(bar);
  }
  const evs = mapTribeEvents(rows, opts.venue, { ...opts, label });
  console.log(`${label} (iCal): ${evs.length} events from ${rows.length} rows`);
  return evs;
}

// ---- tusboletos.mx ----
const strip = (str) => String(str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const ES_MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
/**
 * A Spanish date to ISO: "Jueves 15 de Octubre del 2026" → "2026-10-15". A range ("Del miercoles 28
 * de octubre al jueves 29 de octubre", no year) gives every day in it; a date with no year is the
 * next one from `today` (this year, or next once it is more than a month past).
 */
export function spanishDates(text, today = new Date().toISOString().slice(0, 10)) {
  const out = [];
  for (const m of strip(text).matchAll(/(\d{1,2})\s+de\s+([a-z]+)(?:\s+del?\s+(\d{4}))?/g)) {
    const mo = ES_MONTHS.indexOf(m[2]); if (mo < 0) continue;
    let y = m[3] ? Number(m[3]) : Number(today.slice(0, 4));
    const iso = (yy) => `${yy}-${String(mo + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    if (!m[3] && iso(y) < new Date(Date.parse(today + 'T12:00:00Z') - 31 * 86400e3).toISOString().slice(0, 10)) y++;
    out.push(iso(y));
  }
  if (out.length === 2 && out[0] < out[1] && /\bal\b/.test(strip(text))) { // a range: every day in it
    const days = []; for (let t = Date.parse(out[0] + 'T12:00:00Z'); t <= Date.parse(out[1] + 'T12:00:00Z'); t += 86400e3) days.push(new Date(t).toISOString().slice(0, 10));
    return days.length <= 14 ? days : [out[0]]; // a season-long run is one listing, not a hundred
  }
  return out.slice(0, 1);
}
const TUS_TYPE = [[/deporte|lucha|box\b|futbol|beisbol/i, 'sports'], [/concierto|musica|festival de rock/i, 'concert'], [/teatro|ballet|danza|comedia|stand ?up|monolog|opera|circo|magia/i, 'arts'], [/infantil|familiar|feria|expo\b|festival/i, 'community']];
/** The /eventos list → cards [{ title, city, room, dateText, tag, href }] (`cities` filters and suffixes the rooms). */
export function parseTusboletosList(html, { cities, base = 'https://www.tusboletos.mx' } = {}) {
  const pick = (c, re) => { const m = re.exec(c); return m ? decode(m[1]) : ''; };
  const out = [];
  for (const c of String(html || '').split('<div class="thumbnail">').slice(1)) {
    const city = pick(c, /<b>([^<]*)<\/b>/);
    const town = cities ? cities.find((t) => t.match.test(city)) : { suffix: '' };
    if (!town) continue;
    const href = pick(c, /href="(\/evento\/[^"]+)"/);
    if (!href) continue;
    let title = pick(c, /<h4>([^<]*)<\/h4>/).replace(/\s*[-–]\s*[^-–]*$/, (m) => strip(m).includes(strip(city.split(',')[0]).slice(0, 5)) ? '' : m); // the city suffix TusBoletos adds ("… - Cancún", "… - Playa de Carmen")
    title = title.replace(/^[“"]\s*(.*?)\s*[”"]$/, '$1').trim(); // a title quoted whole
    out.push({ title, city, room: pick(c, /fa-map-marker"><\/i>&nbsp;\s*([^<]*)<\/p>/) + (town.suffix || ''), dateText: pick(c, /fa-calendar"><\/i>&nbsp;\s*([^<]*)<\/p>/), tag: pick(c, /fa-tag"><\/i>&nbsp;\s*([^<]*)<\/p>/), href: new URL(href, base).href });
  }
  return out;
}
/** The event page's clock line → ['18:30', '21:00'] ("6:30 P.M. y 9:00 P.M."); [] when the page names none. */
export function tusboletosTimes(html) {
  const m = /fa-clock-o"><\/i><\/span>&nbsp;\s*([^<]*)</.exec(String(html || ''));
  if (!m) return [];
  const out = [];
  for (const t of m[1].matchAll(/(\d{1,2})(?::(\d{2}))?\s*([AP])\.?\s*M\b/gi)) {
    let h = Number(t[1]) % 12; if (/p/i.test(t[3])) h += 12;
    out.push(`${String(h).padStart(2, '0')}:${t[2] || '00'}`);
  }
  return out;
}
const listCache = new Map(); // one fetch of a ticketer's list per build, however many rows read it
async function fetchText(url, ua) {
  const res = await fetch(url, { headers: { 'User-Agent': ua, Accept: 'text/html,*/*' }, signal: AbortSignal.timeout(60000) }); // a host that never answers fails the page, not the build
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return decodeBody(await res.arrayBuffer(), res.headers.get('content-type') || '');
}
/** A page's bytes as text, by its declared charset (eticket's ISO-8859-15 reads as windows-1252; everything else is UTF-8). */
export function decodeBody(buf, contentType = '') {
  const head = new TextDecoder('latin1').decode(buf.slice(0, 4096));
  const m = /charset=["']?([\w-]+)/i.exec(contentType) || /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  const cs = m ? m[1].toLowerCase() : 'utf-8';
  return new TextDecoder(/iso-8859|windows-125|latin/.test(cs) ? 'windows-1252' : 'utf-8').decode(buf);
}
async function fetchTusboletos(url, ua, label, opts) {
  const { feed = {}, venue, types } = opts;
  if (!listCache.has(url)) listCache.set(url, fetchText(url, ua));
  const cards = parseTusboletosList(await listCache.get(url), { cities: feed.cities });
  const allowed = types ? new Set(types) : null;
  const out = [];
  let pages = 0;
  for (const c of cards) {
    const dates = spanishDates(c.dateText);
    if (!dates.length) { console.error(`${label}: no date in "${c.dateText}" (${c.title})`); continue; }
    let times = [];
    try { await new Promise((r) => setTimeout(r, 250)); times = tusboletosTimes(await fetchText(c.href, ua)); pages++; } // the clock is on the event page only
    catch (err) { console.error(`${label}: ${c.href} ${err.message} — listed without a time`); }
    const type = (TUS_TYPE.find(([re]) => re.test(strip(c.tag))) || [])[1];
    for (const date of dates) for (const time of (times.length ? times : [''])) {
      const ev = { venue: venue || c.room, title: c.title, date, time, url: c.href };
      if (type && (!allowed || allowed.has(type))) ev.type = type;
      out.push(ev);
    }
  }
  console.log(`${label} (TusBoletos): ${out.length} listings from ${cards.length} cards, ${pages} event pages`);
  return out;
}

// ---- schema.org Event markup (eticket.mx) ----
/** Every schema.org Event in a page's ld+json → feed events; `at` keeps those whose location matches. */
export function parseJsonLdEvents(html, { venue, at, types } = {}) {
  const allowed = types ? new Set(types) : null;
  const out = [];
  for (const m of String(html || '').matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let j; try { j = JSON.parse(m[1]); } catch { continue; }
    const items = Array.isArray(j) ? j : j && j['@graph'] ? j['@graph'] : [j];
    for (const o of items) {
      if (!o || !/Event/.test(String(o['@type']))) continue;
      const loc = typeof o.location === 'object' ? o.location?.name : o.location;
      if (at && !at.test(loc || '')) continue;
      const sd = String(o.startDate || '');
      if (!/^\d{4}-\d{2}-\d{2}/.test(sd)) continue;
      const ev = { venue: venue || decode(loc) || '', title: decode(o.name), date: sd.slice(0, 10), time: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(sd) ? sd.slice(11, 16) : '', url: String(o.url || '') };
      const offers = Array.isArray(o.offers) ? o.offers : o.offers ? [o.offers] : [];
      if (offers.length && offers.every((x) => /SoldOut/i.test(String(x.availability || '')))) ev.soldOut = true;
      const st = String(o.eventStatus || '');
      if (/Cancelled/i.test(st)) ev.status = 'cancelled'; else if (/Postponed|Rescheduled/i.test(st)) ev.status = 'postponed';
      if (o.offers && allowed) { /* the type comes from the row the venue folds onto */ }
      out.push(ev);
    }
  }
  return out;
}
async function fetchJsonLd(url, ua, label, opts) {
  const html = await fetchText(url, ua);
  const drop = opts.drop || opts.feed?.drop;
  const evs = parseJsonLdEvents(html, { venue: opts.venue, at: opts.feed?.at, types: opts.types }).filter((e) => !drop || !drop.test(e.title));
  console.log(`${label} (schema.org events): ${evs.length} events`);
  return evs;
}

// ---- Ticketera (ticketera.com, Puerto Rico's ticketer) ----
/**
 * Ticketera's pages are server-rendered (the Carbonhouse platform), but its
 * Fastly edge answers Node, curl and any "Mozilla" client with HTTP 406 or a
 * "Client Challenge" page, and serves the same URL in full to a Chrome TLS
 * handshake — so the pages come through scripts/cffi-fetch.py (curl_cffi,
 * run by uv, one process per batch); `uv` has to be on PATH where a city
 * configures this kind (its workflow installs it). Without uv the fetch
 * falls back to plain fetch, which may be refused — the build says so.
 *
 *   feeds: [{ kind: 'ticketera', label: 'Ticketera', url: 'https://www.ticketera.com',
 *             pages: ['/events/venue/coliseo-de-puerto-rico', …],  // the rooms' own listings (a category page lists the island)
 *             rooms: /coliseo|music hall/i,   // optional: keep only listings at these rooms (a category page's filter)
 *             drop: /abonados/i }]            // optional: season-ticket packages and the like
 *
 * Each listing names its room (the `location` line), so it folds onto a
 * venue row by alias like TusBoletos's. Dates on the listing are Spanish or
 * English month abbreviations ("oct. 16, 2026", "oct. 30 - nov. 1, 2026",
 * "Sep. 17, 2026 - Oct. 25, 2026"); the clock and the per-date showings
 * are on the event page (a multi-day run lists one showing per date and
 * time; a single date carries "Inicio del Evento 8:30 p. m."). The category
 * pages (/events/category/conciertos …) give each event its type.
 */
const TK_MONTHS = { ene: 0, jan: 0, feb: 1, mar: 2, abr: 3, apr: 3, may: 4, jun: 5, jul: 6, ago: 7, aug: 7, sep: 8, set: 8, oct: 9, nov: 10, dic: 11, dec: 11 };
const tkIso = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
/** A listing's date text → [start, end] as ISO ("oct. 22 - 23, 2026" → ['2026-10-22', '2026-10-23']); [] when unreadable. */
export function ticketeraDates(text, today = new Date().toISOString().slice(0, 10)) {
  const toks = [];
  let mo = null;
  for (const m of strip(text).matchAll(/(?:([a-z]{3})[a-z]*\.?\s+)?\b(\d{1,2})\b(?:\s*,\s*(\d{4}))?/g)) {
    if (m[1] !== undefined) { if (!(m[1] in TK_MONTHS)) continue; mo = TK_MONTHS[m[1]]; }
    if (mo === null) continue;
    toks.push({ mo, day: Number(m[2]), year: m[3] ? Number(m[3]) : null });
  }
  if (!toks.length) return [];
  const [a, b = a] = [toks[0], toks[toks.length - 1]];
  if (b.year === null) { // no year anywhere: the next one from today
    b.year = Number(today.slice(0, 4));
    if (tkIso(b.year, b.mo, b.day) < new Date(Date.parse(today + 'T12:00:00Z') - 31 * 86400e3).toISOString().slice(0, 10)) b.year++;
  }
  if (a.year === null) a.year = a.mo > b.mo ? b.year - 1 : b.year; // "dic. 30 - ene. 2, 2027" starts the year before
  const start = tkIso(a.year, a.mo, a.day), end = tkIso(b.year, b.mo, b.day);
  return end >= start ? [start, end] : [start, start];
}
/** A listing page → cards [{ title, room, dateText, href }] (the Vue search templates on the page are skipped). */
export function parseTicketeraList(html, base = 'https://www.ticketera.com') {
  const pick = (c, re) => { const m = re.exec(c); return m ? decode(m[1]) : ''; };
  const out = [];
  for (const c of String(html || '').split(/<div class="eventItem/).slice(1)) {
    if (/v-html=|v-text=/.test(c.slice(0, 400))) continue; // the search result template, not a listing
    const href = pick(c, /class="title[^"]*">\s*<a href="([^"]+)"/);
    if (!href) continue;
    const dateText = pick(c, /class="date">([\s\S]*?)<\/div>/).replace(/<[^>]+>/g, '');
    out.push({ title: pick(c, /class="title[^"]*">\s*<a href="[^"]+"[^>]*>([\s\S]*?)<\/a>/), room: pick(c, /class="location\s*">([\s\S]*?)<\/div>/), dateText: decode(dateText), href: new URL(href, base).href });
  }
  return out;
}
const tk24 = (h, m, ap) => { let hh = Number(h) % 12; if (/p/i.test(ap)) hh += 12; return `${String(hh).padStart(2, '0')}:${m || '00'}`; };
/**
 * An event page → { showings: [{ date, time, soldOut? }], time } — the showings list (one row
 * per date and time, "viernes, oct. 30 · 8:00 PM"), years inferred from `start` (a month
 * before the start's rolls into the next year), and the sidebar clock for a page with no list.
 */
export function parseTicketeraDetail(html, start) {
  const h = String(html || '');
  const y0 = Number((start || '').slice(0, 4)) || new Date().getFullYear(), m0 = Number((start || '').slice(5, 7)) - 1;
  const showings = [];
  for (const row of h.split(/id="showing_\d+"/).slice(1)) {
    const cell = row; // up to the next showing: its date, clock, ticket link and offers
    const md = /m-date__month">\s*([a-záé]+)\.?\s*<\/span><span class="m-date__day">\s*(\d{1,2})/i.exec(cell);
    const t = /class="time cell">\s*(\d{1,2})(?::(\d{2}))?\s*([AP])M/i.exec(cell);
    if (!md) continue;
    const mo = TK_MONTHS[strip(md[1]).slice(0, 3)];
    if (mo === undefined) continue;
    const y = start && mo < m0 ? y0 + 1 : y0;
    const s = { date: tkIso(y, mo, Number(md[2])), time: t ? tk24(t[1], t[2], t[3]) : '' };
    if (/agotado|sold\s*out/i.test(cell)) s.soldOut = true;
    showings.push(s);
  }
  const st = /sidebar_event_starts[\s\S]*?<span>\s*(\d{1,2})(?::(\d{2}))?\s*<span data-time="([ap])/i.exec(h);
  return { showings, time: st ? tk24(st[1], st[2], st[3]) : '' };
}
/** The room a listing page belongs to: the name most of its cards carry ('' for a category page, which mixes rooms). */
export function pageRoom(cards) {
  const n = new Map();
  for (const c of cards) if (c.room) n.set(c.room, (n.get(c.room) || 0) + 1);
  const top = [...n.entries()].sort((a, b) => b[1] - a[1])[0];
  return top && top[1] * 2 > cards.length ? top[0] : '';
}
const TK_CATEGORY = { conciertos: 'concert', deportes: 'sports', teatros: 'arts', familia: 'community', gastronomico: 'community', conferencias: 'community' };
/** Pages fetched through the Chrome-fingerprint helper (scripts/cffi-fetch.py via uv), url → text; a failure is logged and the URL left out. */
const chromeCache = new Map(); // one fetch of a page per build, however many feed rows ask for it
async function chromeFetch(urls, label) {
  const out = new Map();
  for (const u of urls) if (chromeCache.has(u)) out.set(u, chromeCache.get(u));
  const want = [...new Set(urls.filter((u) => !chromeCache.has(u)))];
  if (!want.length) return out;
  const { spawnSync } = await import('node:child_process');
  const script = new URL('./cffi-fetch.py', import.meta.url);
  const r = spawnSync('uv', ['run', '--quiet', script.pathname, ...want], { encoding: 'utf8', maxBuffer: 256 << 20 });
  if (r.error || r.status !== 0) {
    console.error(`${label}: cffi-fetch.py did not run (${r.error ? r.error.message : `exit ${r.status}: ${(r.stderr || '').trim().slice(-300)}`}) — plain fetch instead, which the site may refuse`);
    for (const u of want) { try { out.set(u, await fetchText(u, '')); chromeCache.set(u, out.get(u)); } catch (err) { console.error(`${label}: ${u} ${err.message}`); } }
    return out;
  }
  for (const [u, v] of Object.entries(JSON.parse(r.stdout))) { if (typeof v === 'string') { out.set(u, v); chromeCache.set(u, v); } else console.error(`${label}: ${u} ${v.error}`); }
  return out;
}
async function fetchTicketera(url, ua, label, opts) {
  const { feed = {}, venue, types } = opts;
  const base = url.replace(/\/$/, '');
  const abs = (p) => new URL(p, base + '/').href;
  const pages = (feed.pages || ['/events']).map(abs);
  const catPages = Object.keys(TK_CATEGORY).map((c) => abs(`/events/category/${c}`));
  const html = await chromeFetch([...pages, ...catPages], label);
  const typeOf = new Map(); // event page → type, from the category listings
  for (const c of Object.keys(TK_CATEGORY)) for (const card of parseTicketeraList(html.get(abs(`/events/category/${c}`)) || '', base)) typeOf.set(card.href, TK_CATEGORY[c]);
  const cards = new Map();
  for (const p of pages) {
    const list = parseTicketeraList(html.get(p) || '', base);
    const room = pageRoom(list); // a room's own page lists the odd event with no location line: it is that room's
    for (const card of list) if (!cards.has(card.href)) cards.set(card.href, card.room || !room ? card : { ...card, room });
  }
  const allowed = types ? new Set(types) : null;
  const keep = [...cards.values()].filter((c) => (!feed.rooms || feed.rooms.test(c.room)) && !(feed.drop && feed.drop.test(c.title)));
  const details = await chromeFetch(keep.map((c) => c.href), label);
  const out = [];
  for (const c of keep) {
    let [start, end] = ticketeraDates(c.dateText);
    if (!start) { const d = spanishDates(c.dateText); if (d.length) [start, end] = [d[0], d[d.length - 1]]; } // the odd listing written out ("4 al 6 de diciembre del 2026")
    if (!start) { console.error(`${label}: no date in "${c.dateText}" (${c.title})`); continue; }
    const d = parseTicketeraDetail(details.get(c.href) || '', start);
    let shows = d.showings.filter((s) => s.date >= start && s.date <= end);
    if (!shows.length) { // no showings list: every day of a short run, the first day of a season-long one
      const days = [];
      for (let t = Date.parse(start + 'T12:00:00Z'); t <= Date.parse(end + 'T12:00:00Z'); t += 86400e3) days.push(new Date(t).toISOString().slice(0, 10));
      shows = (days.length <= 14 ? days : [start]).map((date) => ({ date, time: d.time }));
    }
    const type = typeOf.get(c.href);
    for (const s of shows) {
      const ev = { venue: venue || c.room, title: c.title, date: s.date, time: s.time, url: c.href };
      if (s.soldOut) ev.soldOut = true;
      if (type && (!allowed || allowed.has(type))) ev.type = type;
      out.push(ev);
    }
  }
  console.log(`${label} (Ticketera): ${out.length} listings from ${keep.length} events on ${pages.length} pages, ${details.size} event pages read`);
  return out;
}

// ---- a whole-season iCalendar file (Sidearm, PrestoSports) ----
const ICS_WALL = new Map(); // zone → formatter giving "YYYY-MM-DD HH:MM" on that zone's clock
function wallClock(ms, tz) {
  if (!ICS_WALL.has(tz)) ICS_WALL.set(tz, new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  return ICS_WALL.get(tz).format(new Date(ms)).replace(/‎/g, '').replace(',', '');
}
/** The instant (ms) of a wall-clock reading in a zone: a UTC guess, corrected by the zone's offset at that guess (twice, for a DST edge). */
function zonedInstant(y, mo, d, h, mi, tz) {
  let ms = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const w = wallClock(ms, tz);
    const guess = Date.UTC(+w.slice(0, 4), +w.slice(5, 7) - 1, +w.slice(8, 10), +w.slice(11, 13), +w.slice(14, 16));
    ms -= guess - Date.UTC(y, mo - 1, d, h, mi);
  }
  return ms;
}
/** A VEVENT's DTSTART → ['YYYY-MM-DD', 'HH:MM' | ''] on the city's clock. */
export function icsStart(dt, tz) {
  const m = String(dt.value || '').match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(?:\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, z] = m;
  if (dt.params.VALUE === 'DATE' || !h) return [`${y}-${mo}-${d}`, ''];
  if (z) { const w = wallClock(Date.UTC(+y, +mo - 1, +d, +h, +mi), tz); return [w.slice(0, 10), w.slice(11, 16)]; }
  if (dt.params.TZID && dt.params.TZID !== tz) { const w = wallClock(zonedInstant(+y, +mo, +d, +h, +mi, dt.params.TZID), tz); return [w.slice(0, 10), w.slice(11, 16)]; }
  return [`${y}-${mo}-${d}`, `${h}:${mi}`]; // floating, or already the city's zone
}
/**
 * Every VEVENT of a season calendar → feed events. `venue` pins them to one room; without it each
 * row keeps its LOCATION for the aliases to fold. `rooms` (a regex on LOCATION) keeps the rooms
 * wanted, `drop` (on the title) leaves rows out, `rename` rewrites the title in order.
 */
export function mapIcsFile(text, { venue, tz = 'UTC', rooms, drop, rename = [], type, types, defaultType, label = 'feed', today = '' } = {}) {
  const allowed = types ? new Set(types) : null;
  const out = [];
  const seen = new Set();
  for (const v of parseIcs(text)) {
    if (!v.SUMMARY || !v.DTSTART) continue;
    const where = decode((v.LOCATION || {}).value || '');
    if (rooms && !rooms.test(where)) continue;
    let title = decode(v.SUMMARY.value);
    for (const [re, to] of rename) title = title.replace(re, to);
    title = title.trim();
    if (!title || (drop && drop.test(title))) continue;
    const start = icsStart(v.DTSTART, tz);
    if (!start || start[0] < today) continue;
    const desc = (v.DESCRIPTION || {}).value || '';
    const tickets = /Tickets:\s*(https?:\/\/\S+)/i.exec(desc);
    const ev = { venue: venue || where, title, date: start[0], time: start[1], url: decode(tickets ? tickets[1] : (v.URL || {}).value || '') };
    const t = (type && (!allowed || allowed.has(type)) ? type : null) || tribeType(((v.CATEGORIES || {}).value || '').split(',').filter(Boolean), allowed) || defaultType;
    if (t) ev.type = t;
    const k = `${ev.venue}|${ev.title}|${ev.date}|${ev.time}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push(ev);
  }
  return out;
}
async function fetchIcsFile(url, ua, label, opts) {
  const { feed = {} } = opts;
  const res = await fetch(url, { headers: { 'User-Agent': ua, Accept: 'text/calendar,*/*' } });
  if (!res.ok) { console.error(`${label} HTTP ${res.status}`); return []; }
  const text = await res.text();
  const evs = mapIcsFile(text, { ...opts, rename: feed.rename, type: feed.type, label, today: new Date().toISOString().slice(0, 10) });
  console.log(`${label} (iCal file): ${evs.length} events from ${(text.match(/BEGIN:VEVENT/g) || []).length} rows`);
  return evs;
}

// ---- a listing page whose events are links to pages with schema.org markup ----
/** The links in a page that `match` picks: absolute, query and hash stripped, each once, in page order. */
export function eventLinks(html, match, base) {
  const out = [];
  const seen = new Set();
  for (const m of String(html || '').matchAll(/href=["']([^"']+)["']/g)) {
    let href = decode(m[1]);
    try { href = new URL(href, base).href; } catch { continue; }
    href = href.replace(/[?#].*$/, '');
    if (!match.test(href) || seen.has(href)) continue;
    seen.add(href); out.push(href);
  }
  return out;
}
async function fetchLinked(url, ua, label, opts) {
  const { feed = {}, venue, types, defaultType, drop } = opts;
  const match = feed.match || /eventbrite\.com\/e\//;
  const links = eventLinks(await fetchText(url, ua), match, url).slice(0, feed.max || 40);
  const out = [];
  let pages = 0;
  for (const link of links) {
    try {
      if (pages) await new Promise((r) => setTimeout(r, 400));
      const evs = parseJsonLdEvents(await fetchText(link, ua), { venue, at: feed.at, types });
      pages++;
      for (const ev of evs) {
        if (drop && drop.test(ev.title)) continue;
        if (!ev.url) ev.url = link;
        const t = feed.type || defaultType;
        if (t && (!types || types.includes(t))) ev.type = t;
        out.push(ev);
      }
    } catch (err) { console.error(`${label}: ${link} ${err.message}`); }
  }
  console.log(`${label} (linked pages): ${out.length} events from ${pages} of ${links.length} ticket pages`);
  return out;
}

// ---- a Squarespace events collection ----
/**
 * `<collection page>?format=json` answers with the same data the page renders: `upcoming`
 * items carrying an epoch-ms startDate, an HTML-escaped title, a site-relative fullUrl and a
 * location.addressTitle room. The clock is the site's own (website.timeZone).
 * Returns [{ venue, title, date, time, url, type? }].
 */
export function mapSquarespaceEvents(data, { venue, base = '', drop, type, types, label = 'feed' } = {}) {
  const tz = data?.website?.timeZone || 'UTC';
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const out = [];
  for (const it of data?.upcoming || data?.items || []) {
    if (!Number.isFinite(it.startDate)) continue;
    const title = decode(it.title || '');
    if (!title || (drop && drop.test(title))) continue;
    const [date, time] = fmt.format(new Date(it.startDate)).split(' '); // "2026-10-20 19:30"
    const ev = { venue: venue || decode(it.location?.addressTitle || '') || label, title, date, time: time || '', url: it.fullUrl ? new URL(it.fullUrl, base || 'https://localhost/').href : base };
    if (type && (!types || types.includes(type))) ev.type = type;
    out.push(ev);
  }
  return out;
}
async function fetchSquarespace(url, ua, label, opts) {
  const { feed = {}, venue, types, defaultType, drop } = opts;
  const u = new URL(url); u.searchParams.set('format', 'json');
  const res = await fetch(u, { headers: { 'User-Agent': ua, Accept: 'application/json' } });
  if (!res.ok) { console.error(`${label} HTTP ${res.status}`); return []; }
  const evs = mapSquarespaceEvents(await res.json(), { venue, base: u.origin, drop: drop || feed.drop, type: feed.type || defaultType, types, label });
  console.log(`${label} (Squarespace): ${evs.length} events`);
  return evs;
}

// ---- a server-rendered listing cut into cards ----
const CARD_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/**
 * A card's date text → [{ date, time }]: "October 15, 2026 | 10:00 AM - 2:00 PM" is one row at
 * 10:00; "December 05-06, 2026 | 10:00 AM - 4:00 PM" and "October 31 - November 2, 2026" one per
 * day, at most seven; no clock → an all-day row; "2026-10-30 5:00 PM" (an ISO date) one row. []
 * when there is no readable date.
 */
export function cardDates(text, today = new Date()) {
  const t = decode(text);
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(t); // a hidden sort field already in ISO (Lumen Field's Webflow cards, 2026-10-26)
  if (iso) return [{ date: iso[1], time: cardClock(t.slice(iso.index + iso[0].length)) || cardClock(t) }];
  // "October 15, 2026", "December 05-06, 2026", "October 31 - November 2, 2026", "15 Oct", "15 Oct 2026"
  // month first — not a clock's hour after the month ("Oct 7:00 pm") and not the month of a day-first date ("15 Oct")
  let m = /(?<!\d\s{0,2})([A-Za-z]{3,9})\.?\s+(\d{1,2})(?![:\d])(?:\s*[-–]\s*(?:([A-Za-z]{3,9})\.?\s+)?(\d{1,2}))?(?:,?\s*(\d{4}))?/.exec(t);
  let mon1, d1, mon2, d2, year;
  if (m && CARD_MONTHS[m[1].slice(0, 3).toLowerCase()]) { [mon1, d1, mon2, d2, year] = [m[1], m[2], m[3], m[4], m[5]]; }
  else {
    m = /(\d{1,2})\s+([A-Za-z]{3,9})\.?(?:\s+(\d{4}))?/.exec(t);
    if (!m || !CARD_MONTHS[m[2].slice(0, 3).toLowerCase()]) return [];
    [d1, mon1, year] = [m[1], m[2], m[3]];
  }
  const mo1 = CARD_MONTHS[mon1.slice(0, 3).toLowerCase()];
  const mo2 = mon2 ? CARD_MONTHS[mon2.slice(0, 3).toLowerCase()] : mo1;
  if (!mo1 || !mo2) return [];
  let y = year ? Number(year) : today.getUTCFullYear();
  if (!year) { // no year printed: the nearest one forward, a month of slack for a listing that keeps last week's rows
    const guess = Date.UTC(y, mo1 - 1, Number(d1)); const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    if (guess < now - 31 * 86400e3) y += 1;
  }
  const rest = t.slice(m.index + m[0].length);
  const time = cardClock(rest) || cardClock(t);
  const start = Date.UTC(y, mo1 - 1, Number(d1));
  const end = d2 ? Date.UTC(y, mo2 - 1, Number(d2)) : start;
  const out = [];
  for (let d = start; d <= end && out.length < 7; d += 86400e3) out.push({ date: new Date(d).toISOString().slice(0, 10), time });
  return out;
}
/**
 * The first clock in a card's text, 24-hour. A range whose start carries no meridiem
 * ("5:30‑7 pm", "10‑12 pm", "12–8 pm") borrows the end's, flipped when that would put
 * the start after the end (10‑12 pm is 10 in the morning; 5:30‑7 pm is half past five).
 */
export function cardClock(text) {
  const t = String(text || '');
  const to24 = (h, mm, ap) => `${String((Number(h) % 12) + (ap.toLowerCase() === 'p' ? 12 : 0)).padStart(2, '0')}:${mm || '00'}`;
  const range = /(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?m\.?)?\s*[-–‑—]\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b/i.exec(t);
  const single = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b/i.exec(t);
  if (range && (!single || range.index <= single.index)) {
    const [, h1, m1, ap1, h2, m2, ap2] = range;
    if (ap1) return to24(h1, m1, ap1);
    const end = to24(h2, m2, ap2); let start = to24(h1, m1, ap2);
    if (start > end) start = to24(h1, m1, ap2.toLowerCase() === 'p' ? 'a' : 'p');
    return start;
  }
  return single ? to24(single[1], single[2], single[3]) : '';
}
/** The cards of a listing page → feed events (see the header). */
export function parseCards(html, { item, title, when, place, venue, drop, type, types, base = '', time: defaultTime = '', venues } = {}) {
  const out = [];
  for (const card of String(html || '').split(item).slice(1)) {
    const tm = title.exec(card); const wm = when.exec(card);
    if (!tm || !wm) continue;
    const name = decode(tm[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); const url = decode(tm[1]); // a title may wrap a tag or two (Waterfront Park's no-widow spans)
    if (!name || (drop && drop.test(name))) continue;
    const pm = place && place.exec(card);
    const placeName = pm ? decode(pm[1].replace(/<[^>]+>/g, ' ')) : '';
    if (venues && !venues.test(placeName)) continue; // another venue's card on a shared listing
    const room = venue || placeName;
    let href = url; try { href = new URL(url, base || 'https://localhost/').href; } catch { /* keep as written */ }
    for (const { date, time: clock } of cardDates(wm.slice(1).filter(Boolean).map((x) => x.replace(/<[^>]+>/g, ' ')).join(' '))) { // tags inside a date too ("Jan 2,<span>&nbsp;</span>2027")
      const time = clock || defaultTime; // `time`: the clock a listing never prints (the art walk is 5 to 8 every first Thursday) // every group of `when` — a date and a clock in separate spans
      const ev = { venue: room, title: name, date, time, url: href };
      if (type && (!types || types.includes(type))) ev.type = type;
      out.push(ev);
    }
  }
  return out;
}
async function fetchCards(url, ua, label, opts) {
  const { feed = {}, venue, types, defaultType, drop } = opts;
  const html = await fetchText(url, ua);
  const evs = parseCards(html, { item: feed.item, title: feed.title, when: feed.when, place: feed.place, venue, drop: drop || feed.drop, type: feed.type || defaultType, types, base: url, time: feed.time, venues: opts.venues || feed.venues || opts.rooms || feed.rooms });
  console.log(`${label} (cards): ${evs.length} events from ${Math.max(0, String(html).split(feed.item).length - 1)} cards`);
  return evs;
}

// ---- Modern Events Calendar (the WordPress plugin) list pages ----
/**
 * The list skin's init call on the page — `jQuery("#mec_skin_mec1").mecListView({ id: "mec1",
 * start_date: "2026-10-26", end_date: "2026-10-28", offset: "4", limit: "12", atts: "atts%5B…",
 * ajax_url: "…/admin-ajax.php", … })` — read for what the "load more" request needs. null when
 * the page has no list skin.
 */
export function parseMecInit(html) {
  const m = /mecListView\(\s*\{([\s\S]*?)\}\s*\);/.exec(String(html || ''));
  if (!m) return null;
  const field = (k) => { const f = new RegExp(`\\b${k}:\\s*"([^"]*)"`).exec(m[1]); return f ? f[1] : ''; };
  const init = { id: field('id'), startDate: field('start_date'), endDate: field('end_date'), offset: Number(field('offset')) || 0, limit: Number(field('limit')) || 12, atts: field('atts'), ajaxUrl: field('ajax_url') };
  return init.atts ? init : null;
}
/**
 * The cards of one MEC list page (the page itself or a load-more response's html) →
 * [{ title, url, date, time, place, status? }]. A card: `<article class="… mec-event-article …">`,
 * `.mec-event-title a` (href + name), `.mec-start-date-label` ("Oct 26" on the page, "Oct 29 2026"
 * in a load-more response), `.mec-start-time` ("7:30 PM"), `.mec-venue-details span` (the venue).
 * "… CANCELED" / "… POSTPONED" at the end of a title is the row's status, not its name.
 */
export function parseMecCards(html, today = new Date()) {
  const out = [];
  for (const card of String(html || '').split(/<article\b[^>]*\bmec-event-article\b/).slice(1)) {
    const t = /mec-event-title"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(card);
    const d = /mec-start-date-label"[^>]*>([^<]+)</.exec(card);
    if (!t || !d) continue;
    let title = decode(t[2].replace(/<[^>]+>/g, ' '));
    const st = /\b(CANCELL?ED|POSTPONED)\b\.?$/i.exec(title);
    if (st) title = title.slice(0, st.index).replace(/[\s:–—-]+$/, '').trim();
    const tm = /mec-start-time"[^>]*>([^<]+)</.exec(card);
    const pl = /mec-venue-details"[^>]*>[\s\S]*?<span[^>]*>([^<]+)</.exec(card);
    const [first] = cardDates(decode(d[1]), today);
    if (!first) continue;
    const ev = { title, url: decode(t[1]), date: first.date, time: tm ? cardClock(decode(tm[1])) : '', place: pl ? decode(pl[1]) : '' };
    if (st) ev.status = /^cancel/i.test(st[1]) ? 'cancelled' : 'postponed';
    out.push(ev);
  }
  return out;
}
async function fetchMec(url, ua, label, opts) {
  const { feed = {}, venue, types, defaultType, drop, venues = feed.venues || opts.rooms || feed.rooms } = opts;
  const html = await fetchText(url, ua);
  const init = parseMecInit(html);
  const pages = [html];
  if (!init) console.error(`${label}: no Modern Events Calendar list on the page — first cards only`);
  let { endDate, offset } = init || {};
  for (let page = 0; init && page < 40; page++) { // the plugin's own "load more", page after page
    const body = `action=mec_list_load_more&mec_start_date=${encodeURIComponent(endDate)}&mec_offset=${offset}&apply_sf_date=0&${init.atts}`;
    const res = await fetch(init.ajaxUrl || new URL('/wp-admin/admin-ajax.php', url).href, { method: 'POST', headers: { 'User-Agent': ua, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Accept: 'application/json, text/javascript, */*' }, body, signal: AbortSignal.timeout(60000) });
    if (!res.ok) { console.error(`${label} load more ${page + 1} HTTP ${res.status}`); break; }
    const data = await res.json();
    pages.push(data.html || '');
    if (!data.has_more_event || !data.end_date) break;
    if (data.end_date === endDate && Number(data.offset) === offset) break; // the plugin would loop here too
    endDate = data.end_date; offset = Number(data.offset) || 0;
  }
  const cards = pages.flatMap((h) => parseMecCards(h));
  const evs = [];
  for (const c of cards) {
    if (venues && !venues.test(c.place)) continue;
    if (drop && drop.test(c.title)) continue;
    const ev = { venue: venue || c.place, title: c.title, date: c.date, time: c.time, url: c.url };
    if (c.status) ev.status = c.status;
    const type = feed.type || defaultType;
    if (type && (!types || types.includes(type))) ev.type = type;
    evs.push(ev);
  }
  console.log(`${label} (MEC): ${evs.length} events from ${cards.length} cards on ${pages.length} pages`);
  return evs;
}

// ---- the National Park Service's events API ----
/**
 * developer.nps.gov/api/v1/events?parkCode=…: each item carries `dates` (one or many,
 * ISO), `times` ({ timestart "01:00 PM" }), `location`, `infourl` and an eventid. One row per
 * date at the first start time. The key is NPS_API_KEY in the environment, else the data.gov
 * DEMO_KEY (a few dozen calls a day — one build a day is well inside it).
 */
const clock12 = (t) => { const m = /(\d{1,2}):(\d{2})\s*([AP])M/i.exec(t || ''); return m ? `${String((Number(m[1]) % 12) + (m[3].toUpperCase() === 'P' ? 12 : 0)).padStart(2, '0')}:${m[2]}` : ''; };
export function mapNpsEvents(data, { venue, drop, type, types, label = 'feed' } = {}) {
  const out = [];
  for (const it of data?.data || []) {
    const title = decode(it.title || '');
    if (!title || (drop && drop.test(title))) continue;
    const time = it.isallday === 'true' ? '' : clock12(it.times?.[0]?.timestart);
    const url = it.infourl || `https://www.nps.gov/planyourvisit/event-details.htm?id=${it.eventid || it.id}`;
    for (const date of it.dates || []) {
      const ev = { venue: venue || decode(it.location || '') || label, title, date, time, url };
      if (type && (!types || types.includes(type))) ev.type = type;
      out.push(ev);
    }
  }
  return out;
}
async function fetchNps(url, ua, label, opts) {
  const { feed = {}, venue, types, defaultType, drop } = opts;
  const u = new URL(url); if (!u.searchParams.get('api_key')) u.searchParams.set('api_key', process.env.NPS_API_KEY || 'DEMO_KEY');
  const res = await fetch(u, { headers: { 'User-Agent': ua, Accept: 'application/json' } });
  if (!res.ok) { console.error(`${label} HTTP ${res.status}`); return []; }
  const evs = mapNpsEvents(await res.json(), { venue, drop: drop || feed.drop, type: feed.type || defaultType, types, label });
  console.log(`${label} (NPS events): ${evs.length} events`);
  return evs;
}

// ---- Localist (the university calendars: calendar.uoregon.edu) ----
/**
 * /api/2/events?venue_id=…&days=…&pp=100 (`page=` for the next hundred): events[].event with
 * event_instances[].event_instance.start (ISO on the campus clock), ticket_url / localist_url,
 * location_name and filters.event_types. One row per instance; `venue` pins the rows to a room,
 * else each keeps its location_name for the aliases to fold.
 */
export function mapLocalistEvents(data, { venue, drop, type, types, defaultType, label = 'feed' } = {}) {
  const allowed = types ? new Set(types) : null;
  const out = [];
  for (const { event: e } of data?.events || []) {
    if (!e) continue;
    const title = decode(e.title || '').replace(/\s+/g, ' ').trim();
    if (!title || (drop && drop.test(title))) continue;
    const url = e.ticket_url || e.localist_url || e.url || '';
    const t = (type && (!allowed || allowed.has(type)) ? type : null) || tribeType((e.filters?.event_types || []).map((x) => x.name), allowed) || defaultType;
    for (const { event_instance: inst } of e.event_instances || []) {
      const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(inst?.start || '');
      if (!m) continue;
      const ev = { venue: venue || decode(e.location_name || '') || label, title, date: m[1], time: inst.all_day ? '' : m[2], url };
      if (t) ev.type = t;
      out.push(ev);
    }
  }
  return out;
}
async function fetchLocalist(url, ua, label, opts) {
  const { feed = {}, venue, types, defaultType, drop } = opts;
  const out = [];
  let next = url;
  for (let page = 1; next && page <= (feed.pages || 5); page++) {
    const res = await fetch(next, { headers: { 'User-Agent': ua, Accept: 'application/json' } });
    if (!res.ok) { console.error(`${label} HTTP ${res.status}`); break; }
    const data = await res.json();
    out.push(...mapLocalistEvents(data, { venue, drop: drop || feed.drop, type: feed.type, types, defaultType, label }));
    const u = new URL(next); next = data.page?.next_page ? (u.searchParams.set('page', data.page.next_page), u.href) : null;
  }
  console.log(`${label} (Localist): ${out.length} events`);
  return out;
}

// ---- Ludus box offices (thevlt.ludus.com — community theatres) ----
/**
 * The index page lists every show as a show_item (its name in patron_heading_label, Learn More →
 * show_page.php?show_id=) with one showtimes_item per performance ("Sunday, October 18, 2026
 * &nbsp; 2:00 PM"); data-past-date="1" rows are over and the sold-out class on the row marks a performance
 * sold out (the Sold Out span sits in every row, hidden until then). Ludus sits behind Cloudflare, so the page comes through chromeFetch (cffi-fetch.py).
 */
export function parseLudus(html, { venue, base = '', drop, type, types, label = 'feed' } = {}) {
  const out = [];
  for (const show of String(html || '').split(/<div class="show_item"/).slice(1)) {
    const tm = /patron_heading_label"[^>]*>\s*([\s\S]*?)\s*<\/span>/.exec(show);
    const title = tm ? decode(tm[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
    if (!title || (drop && drop.test(title))) continue;
    const pm = /href="(show_page\.php\?show_id=\d+)"/.exec(show);
    let url = base; try { url = new URL(pm ? pm[1] : '', base || 'https://localhost/').href; } catch { /* keep the base */ }
    for (const st of show.split(/<div class="showtimes_item\b/).slice(1)) { // the class list may go on: "showtimes_item sold-out"
      if (/data-past-date="1"/.test(st)) continue;
      const classes = (/^([^"]*)"/.exec(st) || [, ''])[1];
      const wm = /span_link[^>]*>\s*([A-Za-z]+,\s*[A-Za-z]+\.?\s+\d{1,2},\s*\d{4})\s*<span[^>]*>\s*(?:&nbsp;)?\s*(\d{1,2}:\d{2}\s*[AP]M)/i.exec(st);
      if (!wm) continue;
      for (const { date, time } of cardDates(`${wm[1]} ${wm[2]}`)) {
        const ev = { venue: venue || label, title, date, time, url };
        if (type && (!types || types.includes(type))) ev.type = type;
        if (/\bsold-out\b/.test(classes) || /data-manual-soldout="1"/.test(st)) ev.soldOut = true; // the span is in every row; the class is the state (Ludus's own click handler reads it)
        out.push(ev);
      }
    }
  }
  return out;
}
async function fetchLudus(url, ua, label, opts) {
  const { feed = {}, venue, types, defaultType, drop } = opts;
  const html = (await chromeFetch([url], label)).get(url) || '';
  const evs = parseLudus(html, { venue: venue || label, base: url, drop: drop || feed.drop, type: feed.type || defaultType, types, label });
  console.log(`${label} (Ludus): ${evs.length} performances from ${(html.match(/<div class="show_item"/g) || []).length} shows`);
  return evs;
}

// ---- Bold Type Tickets (strangertickets.com, merctickets.com) ----
/**
 * The Browse page fills itself from POST /Actions/Events/BrowseEvents.html (city, page — every
 * field has to be sent, or the page number is ignored), ten shows a page in a table: the show's
 * link and title, a free-text date ("Wed, Oct 28, 7pm door, 8pm show"), the room with its town.
 * The dates are read from each show's own page instead, whose schema.org Event is exact.
 * Returns [{ id, url, title, place }] in page order.
 */
export function parseBoldtypeList(html) {
  const text = (s) => decode(String(s || '').replace(/<[^>]+>/g, ' '));
  const out = [];
  for (const [, row] of String(html || '').matchAll(/<tr class="item">([\s\S]*?)<\/tr>/g)) {
    const link = /href="(https?:\/\/[^"]+\/events\/(\d+)\/[^"]+)"[^>]*class="title"[^>]*>([\s\S]*?)<\/a>/.exec(row);
    if (!link) continue; // a festival's own subsite, not a show
    const place = /class="eventLocation">([\s\S]*?)<\/td>/.exec(row);
    const room = place && /<a[^>]*>([\s\S]*?)<\/a>/.exec(place[1]);
    out.push({ id: link[2], url: link[1], title: text(link[3]), place: text(place && place[1]), room: text(room && room[1]) });
  }
  return out;
}
const BOLDTYPE_DATE_ONLY = /^\s*(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\s*$/i;
async function fetchBoldtype(url, ua, label, opts) {
  const { feed = {}, venue, types, defaultType, drop } = opts;
  const rooms = feed.rooms || opts.rooms; // tested on the Venue cell, room and town ("El Sid at the APEX Everett, WA"): the city buttons are loose (Everett sits under Seattle), so `city: ''` + a town in `rooms` reads by place
  const seen = new Map();
  for (let page = 1; page <= (feed.maxPages || 30); page++) {
    const body = new URLSearchParams({ page: String(page), terms: '', city: feed.city || '', date: '', end: '', venue: '' });
    let res;
    for (let tries = 1; ; tries++) { // the box office drops a connection, or answers 502, now and then on a long walk
      try { res = await fetch(new URL('/Actions/Events/BrowseEvents.html', url), { method: 'POST', body, headers: { 'User-Agent': ua, Accept: 'text/html,*/*' }, signal: AbortSignal.timeout(30000) }); if (res.status >= 500) throw new Error(`HTTP ${res.status} on page ${page}`); res = { ok: res.ok, status: res.status, html: await res.text() }; break; }
      catch (err) { if (tries >= 4) throw err; await new Promise((r) => setTimeout(r, 2000 * tries)); }
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} on page ${page}`);
    const before = seen.size;
    for (const c of parseBoldtypeList(res.html)) if (!seen.has(c.id)) seen.set(c.id, c);
    if (seen.size === before) break; // past the last page the list repeats
    await new Promise((r) => setTimeout(r, 250));
  }
  const keep = [...seen.values()].filter((c) => (!rooms || rooms.test(c.place)) && !(drop && drop.test(c.title)));
  const out = [];
  let pages = 0;
  for (const c of keep) {
    try {
      if (pages) await new Promise((r) => setTimeout(r, 250));
      const html = await fetchText(c.url, ua).catch(async () => { await new Promise((r) => setTimeout(r, 2000)); return fetchText(c.url, ua); }); // one more try after a dropped connection
      const evs = parseJsonLdEvents(html, { venue, types });
      pages++;
      for (const ev of evs) {
        if (!ev.url) ev.url = c.url;
        const so = /^\s*sold\s*out\b[\s:!-]*/i.exec(ev.title || ''); // "SOLD OUT The Doubleclicks": the box office's tag in the name
        if (so) { ev.title = ev.title.slice(so[0].length); ev.soldOut = true; }
        if (BOLDTYPE_DATE_ONLY.test(ev.title || '')) ev.title = `Show at ${c.room || ev.venue}`; // a run named by its night ("Saturday Oct 31") names nothing
        const t = feed.type || defaultType;
        if (t && (!types || types.includes(t))) ev.type = t;
        out.push(ev);
      }
    } catch (err) { console.error(`${label}: ${c.url} ${err.message}`); }
  }
  console.log(`${label} (Bold Type): ${out.length} events from ${pages} of ${keep.length} kept shows (${seen.size} listed)`);
  return out;
}

// ---- Spektrix box offices (system.spektrix.com/<client>/api/v3 — theatres) ----
/**
 * events: [{ id, name, attribute_SLExcludeFromViewEventsPage }]; instances: [{ id, event: { id },
 * start: "2026-10-21T19:30:00" (the theatre's clock), cancelled }]. One row per instance on or
 * after `today`; `link` is the ticket page with `{id}` = the event id's leading digits.
 */
export function mapSpektrix(events, instances, { venue, link = '', drop, type, types, today = '', label = 'feed' } = {}) {
  const byId = new Map((events || []).map((e) => [e.id, e]));
  const out = [];
  for (const inst of instances || []) {
    const e = byId.get(inst?.event?.id);
    if (!e || inst.cancelled || e.attribute_SLExcludeFromViewEventsPage) continue;
    const title = decode(e.name || '');
    if (!title || (drop && drop.test(title))) continue;
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(inst.start || '');
    if (!m || (today && m[1] < today)) continue;
    const num = (/^\d+/.exec(e.id) || [''])[0];
    const ev = { venue: venue || label, title, date: m[1], time: m[2], url: link.replace('{id}', num), instance: inst.id };
    if (type && (!types || types.includes(type))) ev.type = type;
    out.push(ev);
  }
  return out;
}
async function fetchSpektrix(url, ua, label, opts) {
  const { feed = {}, venue, types, defaultType, drop } = opts;
  const api = url.replace(/\/+$/, '');
  const get = async (path) => { const res = await fetch(`${api}/${path}`, { headers: { 'User-Agent': ua, Accept: 'application/json' }, signal: AbortSignal.timeout(60000) }); if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`); return res.json(); };
  const today = new Date().toISOString().slice(0, 10);
  const [events, instances] = await Promise.all([get('events'), get(`instances?startFrom=${today}`)]);
  const out = mapSpektrix(events, instances, { venue, link: feed.link || '', drop: drop || feed.drop, type: feed.type || defaultType, types, today, label });
  let asked = 0, sold = 0;
  for (const ev of out.slice(0, feed.maxStatus ?? 60)) {
    try {
      if (asked++) await new Promise((r) => setTimeout(r, 200));
      const st = await get(`instances/${ev.instance}/status`);
      if (st && st.capacity > 0 && st.available === 0) { ev.soldOut = true; sold++; }
    } catch (err) { console.error(`${label}: status ${ev.instance} ${err.message}`); }
  }
  for (const ev of out) delete ev.instance;
  console.log(`${label} (Spektrix): ${out.length} performances, ${sold} sold out of ${asked} asked`);
  return out;
}

const KINDS = { tribe: fetchTribe, ics: fetchIcs, tusboletos: fetchTusboletos, jsonld: fetchJsonLd, ticketera: fetchTicketera, icsfile: fetchIcsFile, linked: fetchLinked, squarespace: fetchSquarespace, cards: fetchCards, nps: fetchNps, localist: fetchLocalist, ludus: fetchLudus, boldtype: fetchBoldtype, spektrix: fetchSpektrix, mec: fetchMec };

/**
 * One source thunk per city.js venue with a `feed` (its listings pinned to that row) and one per
 * entry of city.js `feeds` (city-wide: each listing keeps the room the feed names, for the aliases
 * and `groundsVenue` in fetch-events.mjs to fold — unless the entry names a `venue`, which then
 * takes every row, as a room feed does), for fetch-events.mjs's source list.
 */
export function feedSources(city, ua) {
  const types = (city.types || []).map((t) => t.key);
  const run = (feed, label, venue) => () => {
    const fn = KINDS[feed.kind];
    if (!fn) { console.error(`${label}: unknown feed kind "${feed.kind}"`); return []; }
    return fn(feed.url, ua, label, { drop: feed.drop, maxRepeat: feed.maxRepeat, venues: feed.venues, rooms: feed.rooms || feed.venues, types, defaultType: venue ? city.venues[venue].type : feed.type, feed, venue, tz: city.tz });
  };
  return [
    ...Object.entries(city.venues || {}).filter(([, v]) => v.feed).map(([label, v]) => run(v.feed, label, label)),
    ...(city.feeds || []).map((f) => run(f, f.label || f.kind, f.venue || null)), // `venue` pins a city-wide feed's rows to one row (seattle-events: the Alliance calendar → Around Pioneer Square)
  ];
}

/**
 * The empty-list gate. `fresh` is this build's own pull (not the archive);
 * with sources configured and nothing upcoming among them the build is not
 * a picture of the town — a room was missed in scouting, or every source is
 * down — so it stops rather than publish an empty calendar. Returns true
 * when the build may go on.
 */
export function emptyListGate(fresh, today, nSources, env = process.env) {
  const upcoming = fresh.filter((e) => e.date >= today).length;
  if (upcoming > 0 || nSources === 0) return true;
  const line = '!'.repeat(72);
  console.error(`\n${line}\nEMPTY LIST: ${nSources} sources, 0 upcoming events.\nThat is a scouting failure or an outage, not a fact about the town — the\ncity is not done, and not deployed, until Steve has seen this number.\nALLOW_EMPTY_LIST=1 publishes anyway.\n${line}\n`);
  return !!env.ALLOW_EMPTY_LIST;
}
