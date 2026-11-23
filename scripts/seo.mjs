/**
 * Search plumbing for a city site, written at build time after fetch-events
 * (Steve, 2026-10-16: "queue site maps and structured data"):
 *   site/robots.txt   — allow everything, name the sitemap
 *   site/index.html   — the first STATIC_ROWS upcoming rows written into the list as plain HTML (app.js
 *                       replaces them when the feed arrives), so the served page carries its events
 *   site/venues/, site/teams/ — only in a city that keeps a guides.json beside site/: a page per venue and
 *                       per home team, an index at venues/, a Venues link in the footer, all in the sitemap
 *   site/sitemap.xml  — the page (and advertise.html / about.html / faq.html / sources.html / how.html when the city
 *                       has them). lastmod is the truth: the feed's own build time for the calendar, each
 *                       other page's "Last revised" date (its <p class="ad-revised"><time datetime>; in the Action that
 *                       line is first set to the day git last saw the page change), none
 *                       for a page that carries no date
 *   site/index.html   — a visible "Updated <date>" line under the toolbar, the date the feed was built, with a
 *                       link to how.html where the city has that page; the same instant is the WebPage's
 *                       dateModified in the JSON-LD (Steve, 2026-11-15, after Google asked for "ongoing
 *                       curation and structural maintenance" to show)
 *   site/index.html   — one <script type="application/ld+json"> block at the end
 *                       of <body> (parsers reach the visible page first; Google
 *                       reads it anywhere): the WebSite plus an Event per upcoming row
 *                       (the next EVENT_DAYS days, at most EVENT_CAP rows), so
 *                       Google can show the event rich results. Rewritten on
 *                       every run (the block is found by its id), never
 *                       committed — like the __V__ stamp.
 *   site/index.html   — a static More Cities link to https://here.events/ as the
 *                       first footer link (the crawlable path to the map, which
 *                       links on to every city; the sheet itself is JavaScript).
 * Everything comes from city.js (site, name, tz), site/cities.js (the city and
 * state behind this key, for the venues' postal address) and events.json.
 * Shared: lives in lqa, copied to every city by sync-shared.sh.
 * Run: node scripts/seo.mjs      (SITE_DIR=… to write elsewhere, for tests)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import '../site/city.js';

const CITY = globalThis.LQACity;
export const EVENT_DAYS = 60; // what Google can usefully show; 400 rows over 90 days weighed 250 KB
export const EVENT_CAP = 200;
const COUNTRY = { PR: 'US', QR: 'MX' }; // state codes that are not a US state

/** '-07:00' — the city's UTC offset on that local date/time (DST follows the date). */
export function utcOffset(date, time, tz = CITY.tz) {
  const probe = new Date(`${date}T${(time || '12:00').slice(0, 5)}:00Z`); // close enough: the offset only flips at 2 AM local
  const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(probe).find((p) => p.type === 'timeZoneName').value;
  return part === 'GMT' ? '+00:00' : part.replace('GMT', '');
}

/** schema.org dateTime for a row: date only when the row has no clock. */
export function isoStart(e, tz = CITY.tz) {
  if (!/^\d\d:\d\d/.test(e.time || '')) return e.date;
  const t = e.time.length === 5 ? e.time + ':00' : e.time;
  return `${e.date}T${t}${utcOffset(e.date, t, tz)}`;
}

export function isoEnd(e, tz = CITY.tz) {
  if (!e.end || !/^\d\d:\d\d/.test(e.end) || !/^\d\d:\d\d/.test(e.time || '')) return undefined;
  const t = e.end.length === 5 ? e.end + ':00' : e.end;
  let date = e.date;
  if (t < e.time) { const d = new Date(`${e.date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); date = d.toISOString().slice(0, 10); } // past midnight
  return `${date}T${t}${utcOffset(date, t, tz)}`;
}

const STATUS = { cancelled: 'https://schema.org/EventCancelled', postponed: 'https://schema.org/EventPostponed' };

/** One schema.org Event for a listing row. `place` = { city, state } from cities.js. */
export function eventLd(e, place, tz = CITY.tz) {
  const ld = {
    '@type': 'Event',
    name: e.title,
    startDate: isoStart(e, tz),
    eventStatus: STATUS[e.status] || 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: { '@type': 'Place', name: e.venue, address: { '@type': 'PostalAddress', addressLocality: place.city, addressRegion: place.state, addressCountry: COUNTRY[place.state] || 'US' } },
    url: e.url,
  };
  const end = isoEnd(e, tz); if (end) ld.endDate = end;
  if (e.free) ld.isAccessibleForFree = true;
  if (e.url) ld.offers = { '@type': 'Offer', url: e.url, availability: e.soldOut ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock' };
  if (e.type === 'movie' || e.movie) ld.description = `Screening at ${e.venue}`;
  return ld;
}

/** The upcoming rows that go on the page: from today, EVENT_DAYS ahead, soonest first, capped. */
export function pickEvents(events, today) {
  const last = new Date(`${today}T12:00:00Z`); last.setUTCDate(last.getUTCDate() + EVENT_DAYS);
  const until = last.toISOString().slice(0, 10);
  return events
    .filter((e) => e.date >= today && e.date <= until && e.title && e.venue && !e.dateTbd)
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')))
    .slice(0, EVENT_CAP);
}

export function jsonLd(events, place, { today, tz = CITY.tz, site = CITY.site, name = CITY.name, modified } = {}) {
  const graph = [
    { '@type': 'WebSite', name: `${name} Events`, url: site, inLanguage: 'en', publisher: { '@type': 'Organization', name: 'Ghostwood Sites', url: 'https://here.events/' } },
    ...(modified ? [{ '@type': 'WebPage', url: site, name: `${name} Events`, isPartOf: { '@type': 'WebSite', url: site }, dateModified: modified }] : []),
    ...pickEvents(events, today).map((e) => eventLd(e, place, tz)),
  ];
  return { '@context': 'https://schema.org', '@graph': graph };
}

export function sitemapXml(site, pages, today) {
  const mod = (p) => (p.lastmod === undefined ? today : p.lastmod);
  const url = (p) => `  <url><loc>${site}${p.path}</loc>${mod(p) ? `<lastmod>${mod(p)}</lastmod>` : ''}<changefreq>${p.freq}</changefreq></url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map(url).join('\n')}\n</urlset>\n`;
}

export function robotsTxt(site) { return `User-agent: *\nAllow: /\n\nSitemap: ${site}sitemap.xml\n`; }

/** A static More Cities link to the map in the footer: the one crawlable link
 *  between the sites. app.js builds the same link at runtime (and opens the
 *  More Cities sheet on click), but a link that exists only in JavaScript is
 *  no path for a crawler — on 2026-10-18 every city was "Discovered - currently
 *  not indexed", referring page "None detected". The map's static city list
 *  links on to every city. A visible row of all the cities was tried first and
 *  dropped (Steve, 2026-10-19: "not needed on neighborhood or city pages"). */
export const MAP_LINK = '<a class="foot-link" id="moreCities" href="https://here.events/" title="Every city on here.events">More Cities</a>';
export function injectMapLink(html) {
  const stripped = html.replace(/<nav class="city-links" id="city-links"[\s\S]*?<\/nav>\n?/, '');
  if (/id="moreCities"/.test(stripped)) return stripped;
  const m = stripped.match(/<div class="foot-links">[^\n]*\n/);
  if (!m) throw new Error('index.html has no <div class="foot-links">');
  return stripped.replace(m[0], `${m[0]}  ${MAP_LINK}\n`);
}

/** '2026-11-15T12:03:11-08:00' — an instant written as the city's own local time. */
export function localIso(instant, tz = CITY.tz) {
  const d = new Date(instant);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`, time = `${p.hour}:${p.minute}:${p.second}`;
  return `${date}T${time}${utcOffset(date, time, tz)}`;
}

/** 'November 15, 2026' — the day of that instant in the city. */
export function longDate(instant, tz = CITY.tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(instant));
}

/** The visible Updated line: one paragraph between the toolbar and the list, replaced on every run (found by its
 *  id). Not at the page's foot: the list runs to 100,000 px and nobody reaches its end. */
export function injectUpdated(html, instant, { tz = CITY.tz, how = false } = {}) {
  const stripped = html.replace(/<p class="updated" id="updated">[\s\S]*?<\/p>\n?/, '');
  if (!instant || !/\n<section class="agenda"/.test(stripped)) return stripped;
  const line = `<p class="updated" id="updated">Updated <time datetime="${localIso(instant, tz)}">${longDate(instant, tz)}</time>${how ? ' · <a href="how.html">How it’s made</a>' : ''}</p>`;
  return stripped.replace(/\n<section class="agenda"/, `\n${line}\n<section class="agenda"`);
}

/** The day a file was last changed in git ('2026-11-14'), '' when git cannot say: no repository, no commit for the
 *  file, or a shallow clone (there every file looks as new as the one commit fetched). */
export function gitDate(dir, file) {
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (git('rev-parse', '--is-shallow-repository') !== 'false') return '';
    const day = git('log', '-1', '--format=%cs', '--', file);
    return /^\d{4}-\d\d-\d\d$/.test(day) ? day : '';
  } catch { return ''; }
}

/** A page with its "Last revised" line set to a day ('2026-11-14' → November 14, 2026); unchanged when it has no such line. */
export function stampRevised(html, day) {
  const [y, m, d] = day.split('-').map(Number);
  const long = `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${d}, ${y}`;
  return html.replace(/(<p class="ad-revised">[^<]*<time datetime=")\d{4}-\d\d-\d\d(">)[^<]*(<\/time>)/, `$1${day}$2${long}$3`);
}

/** A page's own "Last revised" date ('2026-11-14'), '' when it carries none. */
export function revisedDate(html) {
  const m = html.match(/<p class="ad-revised">[^<]*<time datetime="(\d{4}-\d\d-\d\d)"/);
  return m ? m[1] : '';
}

/** Where a page says its one true copy lives ('' when it names none). A page shared word for word by every city
 *  (how.html) names one copy, so the others stay out of their city's sitemap. */
export function canonicalOf(html) {
  const m = html.match(/<link rel="canonical" href="([^"]+)"/);
  return m ? m[1] : '';
}

/** True when a page asks search engines to leave it out (advertise.html): such a page stays out of the sitemap. */
export function noindexOf(html) {
  return /<meta name="robots" content="[^"]*noindex/.test(html);
}

/** Put (or replace) the ld+json block right before </body>. */
export function injectLd(html, ld) {
  const tag = `<script type="application/ld+json" id="events-ld">${JSON.stringify(ld).replace(/<\//g, '<\\/')}</script>`;
  const stripped = html.replace(/<script type="application\/ld\+json" id="events-ld">[\s\S]*?<\/script>\n?/, '');
  if (!/<\/body>/.test(stripped)) throw new Error('index.html has no </body>');
  return stripped.replace('</body>', `${tag}\n</body>`);
}

/** The city + state behind this site's key, from the generated cities.js (falls back to the city's own name). */
export function placeFor(citiesJs, key, fallback) {
  const m = citiesJs.match(/window\.LQACities = (\{[\s\S]*\});\s*$/);
  const c = m && JSON.parse(m[1]).cities.find((x) => x.key === key);
  return c ? { city: c.city, state: c.state } : fallback;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtDay = (date, opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).format(new Date(`${date}T12:00:00Z`));
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); // the rule badges.mjs names the venue feeds by
const soonest = (a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''));
const upcoming = (events, today) => events.filter((e) => e.date >= today && e.title && e.venue && !e.dateTbd).sort(soonest);

/** '19:30:00' → '7:30 PM'; a row with no clock is 'All day'. */
export function clock(time) {
  const m = /^(\d\d):(\d\d)/.exec(time || '');
  if (!m) return 'All day';
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

/** The first rows of the list as plain HTML, in app.js's own markup, so the page carries its events before any
 *  script runs (Steve, 2026-11-23: the served page said only "Loading events…"). app.js replaces it when the feed
 *  arrives. `off` = the venues the usual view hides. */
export const STATIC_ROWS = 60, STATIC_PER_VENUE = 10; // one busy venue (a library system's storytimes) must not be the whole list
export function staticAgenda(events, today, off = []) {
  const seen = {};
  const rows = upcoming(events, today).filter((e) => !off.includes(e.venue) && (seen[e.venue] = (seen[e.venue] || 0) + 1) <= STATIC_PER_VENUE).slice(0, STATIC_ROWS);
  let out = '', month = '', day = '';
  for (const e of rows) {
    if (e.date !== day) {
      if (day) out += '</div></div>';
      if (e.date.slice(0, 7) !== month) {
        if (month) out += '</li>';
        month = e.date.slice(0, 7);
        out += `<li class="month-group"><div class="month-row"><span>${fmtDay(e.date, { month: 'long' })}</span></div>`;
      }
      day = e.date;
      out += `<div class="day-row" data-date="${e.date}"><div class="date-rail"><span class="dnum">${Number(e.date.slice(8))}</span><span class="dmeta">${fmtDay(e.date, { weekday: 'long' })}</span></div><div class="day-events">`;
    }
    const title = e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a>` : esc(e.title);
    out += `<div class="ev${e.time ? '' : ' is-allday'}"><span class="time">${clock(e.time)}</span><div class="ev-body"><span class="ev-title">${title}</span><span class="venue">${esc(e.venue)}</span></div></div>`;
  }
  return rows.length ? `${out}</div></div></li>` : '';
}

/** Put the static rows in the list; a page without the list, or a feed with nothing upcoming, is left as it is. */
export function injectAgenda(html, rows) {
  return rows ? html.replace(/<ol id="agenda">[\s\S]*?<\/ol>/, () => `<ol id="agenda">${rows}</ol>`) : html;
}

/** A static Venues link in the footer, after More Cities: the crawlable path to the venue and team pages. */
export const VENUES_LINK = '<a class="foot-link" id="venuesLink" href="venues/" title="Every venue and home team, a page each"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21V9l8-5 8 5v12"/><path d="M9 21v-6h6v6"/><path d="M3 21h18"/></svg><span>Venues</span></a>';
export function injectVenuesLink(html, on) {
  const stripped = html.replace(/\s*<a class="foot-link" id="venuesLink"[\s\S]*?<\/a>/, '');
  return on && stripped.includes(MAP_LINK) ? stripped.replace(MAP_LINK, `${MAP_LINK}\n  ${VENUES_LINK}`) : stripped;
}

export const PAGE_ROWS = 150;

function shell({ title, desc, canonical, eyebrow, h1, body, ld, up, v, foot = '', noindex = false }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#edf1f4">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#141a20">
<script>
  try {
    var t = localStorage.getItem('lqa-theme');
    var PHONE = '(max-width: 640px), (pointer: coarse) and (max-height: 500px)';
    if ((t === 'light' || t === 'dark') && !matchMedia(PHONE).matches) document.documentElement.dataset.theme = t;
  } catch (e) {}
</script>
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
${noindex ? '<meta name="robots" content="noindex">\n' : ''}<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(canonical)}">
<link rel="icon" href="${up}favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Big+Shoulders:opsz,wght@10..72,500;10..72,700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${up}styles.css?v=${v}">
</head>
<body>
<header class="masthead">
  <div class="masthead-text">
    <p class="eyebrow"><a href="${up}">${esc(eyebrow)}</a></p>
    <h1>${esc(h1)}</h1>
  </div>
</header>
<main class="ad-page vp-page">
${body}
${foot}</main>
${ld ? `<script type="application/ld+json">${JSON.stringify(ld).replace(/<\//g, '<\\/')}</script>\n` : ''}</body>
</html>
`;
}

function rowsHtml(rows, { venue = false } = {}) {
  let out = '', month = '';
  for (const e of rows) {
    if (e.date.slice(0, 7) !== month) {
      if (month) out += '  </ul>\n';
      month = e.date.slice(0, 7);
      out += `  <h2>${fmtDay(e.date, { month: 'long', year: 'numeric' })}</h2>\n  <ul class="vp-list">\n`;
    }
    const title = e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a>` : esc(e.title);
    const note = e.status === 'cancelled' ? ' <em>Cancelled</em>' : e.status === 'postponed' ? ' <em>Postponed</em>' : e.soldOut ? ' <em>Sold out</em>' : '';
    out += `    <li><time datetime="${isoStart(e)}">${fmtDay(e.date, { weekday: 'short', month: 'short', day: 'numeric' })} · ${clock(e.time)}</time><span>${title}${note}${venue ? ` <small>${esc(e.venue)}</small>` : ''}</span></li>\n`;
  }
  return month ? `${out}  </ul>\n` : '';
}

const links = (items, up) => items.map((x) => `<a href="${up}${x.path}">${esc(x.name)}</a>`).join(' · ');
const paras = (text) => String(text || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => `  <p>${esc(p)}</p>\n`).join('');
const pageLd = (name, url, rows, place, built) => ({
  '@context': 'https://schema.org',
  '@graph': [{ '@type': 'WebPage', url, name, ...(built ? { dateModified: built } : {}) }, ...rows.slice(0, EVENT_CAP).map((e) => eventLd(e, place))],
});

/** The venue and team pages of a city that keeps a guides.json beside site/ (Steve, 2026-11-23: one page per venue
 *  and per home team, each with its upcoming list in plain HTML, so a search for "<venue> events" has a page to
 *  land on). guides = { venues: { '<name>': 'your own words' }, teams: { '<slug>': '…' }, skip: ['<venue name>'] }, all optional.
 *  Returns [{ path, html, count }]; path is relative to site/ and ends in '/'. */
export function buildPages(events, place, { today, guides = {}, built = '', has = () => false, city = CITY, site = CITY.site } = {}) {
  const base = site.endsWith('/') ? site : `${site}/`;
  const up2 = '../../', where = [place.city, place.state].filter(Boolean).join(', ');
  const v = (built || today).replace(/\D/g, '').slice(0, 12);
  const all = upcoming(events, today);
  const names = [...new Set([...Object.keys(city.venues || {}), ...all.map((e) => e.venue)])];
  const venues = names.map((name) => ({ name, slug: slugify(name), path: `venues/${slugify(name)}/`, rows: all.filter((e) => e.venue === name), info: (city.venues || {})[name] || {} })).filter((x) => x.slug && !(guides.skip || []).includes(x.name) && !/^(elsewhere in|around) /i.test(x.name)); // a catch-all row ("Elsewhere in Everett") is not a place
  const teams = (city.teams || []).filter((t) => t.venue && names.includes(t.venue)).map((t) => ({ ...t, name: t.name || t.label, path: `teams/${t.slug}/`, rows: all.filter((e) => e.venue === t.venue && t.re.test(e.title || '')) })); // a club that plays in another city (the Kraken on Everett's list) gets no page here
  const updated = built ? `  <p class="ad-revised">Updated <time datetime="${built}">${longDate(built)}</time></p>\n` : '';
  const more = (self, up) => `${venues.length > 1 ? `  <h2>Venues in ${esc(city.name)}</h2>\n  <p class="vp-links">${links(venues.filter((x) => x !== self), up)}</p>\n` : ''}${teams.length ? `  <h2>Home teams</h2>\n  <p class="vp-links">${links(teams.filter((x) => x !== self), up)}</p>\n` : ''}`;
  const count = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
  // every page reaches who runs the site, how it is made and the privacy page (an ad reviewer looks for these)
  const foot = (up) => `  <p class="vp-foot">${[['about.html', 'About'], ['faq.html', 'FAQ'], ['how.html', 'How It’s Made'], ['sources.html', 'Sources']].filter(([f]) => has(f)).map(([f, n]) => `<a href="${up}${f}">${n}</a>`).concat(['<a href="https://here.events/privacy/">Privacy</a>', '<a href="mailto:hello@here.events">Contact</a>', '<a href="https://here.events/">More Cities</a>']).join(' · ')}</p>\n  <p class="vp-foot">A <a href="https://ghostwoodlabs.com/" target="_blank" rel="noopener">Ghostwood Sites</a> calendar.</p>\n`;
  // "Home vs. Away" titles, counted by visitor: the one thing a team's page says that its venue's page does not
  const opponents = (rows) => { const n = {}; for (const e of rows) { const m = /\bvs?\.? (.+)$/i.exec(e.title || ''); if (m) n[m[1].trim()] = (n[m[1].trim()] || 0) + 1; } return Object.entries(n).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])); };
  const pages = [];

  for (const x of venues) {
    const shown = x.rows.slice(0, PAGE_ROWS), feed = `events-venue-${x.slug}.ics`;
    const lead = x.rows.length
      ? `What’s on at ${esc(x.name)} in ${esc(where)}: ${count(x.rows.length, 'upcoming event', 'upcoming events')}, read from the venue’s own calendar and its ticket seller once a day.`
      : `Nothing is on the calendar at ${esc(x.name)} in ${esc(where)} right now. The calendar is read again every day, and new dates appear here as the venue announces them.`;
    const tools = [
      x.info.url ? `<a href="${esc(x.info.url)}" target="_blank" rel="noopener">The venue’s own site</a>` : '',
      has(feed) ? `<a href="${up2}${feed}">Add these to your calendar</a>` : '',
      `<a href="${up2}">The full ${esc(city.name)} calendar</a>`,
    ].filter(Boolean).join(' · ');
    const body = `  <p class="ad-lead">${lead}</p>\n${paras((guides.venues || {})[x.name])}${x.info.capacity ? `  <p>It holds about ${Number(x.info.capacity).toLocaleString('en-US')} people.</p>\n` : ''}  <p class="vp-links">${tools}</p>\n${rowsHtml(shown)}${x.rows.length > shown.length ? `  <p>And ${count(x.rows.length - shown.length, 'more', 'more')} on <a href="${up2}">the full calendar</a>.</p>\n` : ''}${more(x, up2)}${updated}  <a class="ad-back" href="${up2}">← The full ${esc(city.name)} calendar</a>`;
    const title = `${x.name} Events and Schedule — ${where}`;
    const desc = x.rows.length ? `Upcoming events at ${x.name} in ${where}, updated daily. Next: ${x.rows.slice(0, 2).map((e) => `${e.title} (${fmtDay(e.date, { month: 'short', day: 'numeric' })})`).join('; ')}.` : `Events at ${x.name} in ${where}, updated daily.`;
    pages.push({ path: x.path, count: x.rows.length, html: shell({ title, desc, canonical: base + x.path, eyebrow: `${city.name} Events`, h1: x.name, body, ld: x.rows.length ? pageLd(title, base + x.path, x.rows, place, built) : null, up: up2, v, foot: foot(up2), noindex: !x.rows.length }) });
  }

  for (const t of teams) {
    const shown = t.rows.slice(0, PAGE_ROWS), home = venues.find((x) => x.name === t.venue);
    const same = Boolean(home && t.rows.length && home.rows.length === t.rows.length); // the venue's page is this list and nothing else: that page is the one copy
    const opp = opponents(t.rows);
    const lead = t.rows.length
      ? `The ${esc(t.name)} at home${t.venue ? ` at ${esc(t.venue)}` : ''} in ${esc(where)}: ${count(t.rows.length, 'home game', 'home games')} on the calendar, read from the league’s schedule once a day.`
      : `No ${esc(t.name)} home games are on the calendar right now. They appear here when the league publishes the schedule.`;
    const tools = [
      home ? `<a href="${up2}${home.path}">Everything at ${esc(home.name)}</a>` : '',
      `<a href="${up2}?team=${esc(t.slug)}">The whole season, away games too</a>`,
      `<a href="${up2}">The full ${esc(city.name)} calendar</a>`,
    ].filter(Boolean).join(' · ');
    const body = `  <p class="ad-lead">${lead}</p>\n${paras((guides.teams || {})[t.slug])}${opp.length > 1 ? `  <p>Visiting: ${opp.map(([n, c]) => `${esc(n)}${c > 1 ? ` (${c})` : ''}`).join(', ')}.</p>\n` : ''}  <p class="vp-links">${tools}</p>\n${rowsHtml(shown, { venue: true })}${more(t, up2)}${updated}  <a class="ad-back" href="${up2}">← The full ${esc(city.name)} calendar</a>`;
    const title = `${t.name} Home Schedule${t.venue ? ` — ${t.venue}` : ''}`;
    const desc = t.rows.length ? `${t.name} home games${t.venue ? ` at ${t.venue}` : ''} in ${where}, updated daily. Next: ${t.rows.slice(0, 2).map((e) => `${e.title} (${fmtDay(e.date, { month: 'short', day: 'numeric' })})`).join('; ')}.` : `${t.name} home games in ${where}, updated daily.`;
    pages.push({ path: t.path, count: same ? 0 : t.rows.length, html: shell({ title, desc, canonical: base + (same ? home.path : t.path), eyebrow: `${city.name} Events`, h1: t.name, body, ld: t.rows.length && !same ? pageLd(title, base + t.path, t.rows, place, built) : null, up: up2, v, foot: foot(up2), noindex: !t.rows.length }) });
  }

  const li = (x, up, word) => `    <li><a href="${up}${x.path}">${esc(x.name)}</a><span>${x.rows.length ? count(x.rows.length, word, `${word}s`) : 'nothing listed now'}</span></li>\n`;
  const body = `  <p class="ad-lead">Every venue on the ${esc(city.name)} calendar has a page of its own, with what is on there next.</p>\n  <h2>Venues</h2>\n  <ul class="vp-list vp-index">\n${[...venues].sort((a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name)).map((x) => li(x, '../', 'event')).join('')}  </ul>\n${teams.length ? `  <h2>Home teams</h2>\n  <ul class="vp-list vp-index">\n${teams.map((t) => li(t, '../', 'home game')).join('')}  </ul>\n` : ''}${updated}  <a class="ad-back" href="../">← The full ${esc(city.name)} calendar</a>`;
  pages.unshift({ path: 'venues/', count: all.length, html: shell({ title: `${city.name} Venues and Home Teams — ${where}`, desc: `Every venue and home team on the ${city.name} events calendar, each with its upcoming events, updated daily.`, canonical: `${base}venues/`, eyebrow: `${city.name} Events`, h1: 'Venues', body, ld: null, up: '../', v, foot: foot('../') }) });
  return pages;
}

export function main(siteDir = new URL('../site/', import.meta.url), today = new Date().toISOString().slice(0, 10)) {
  const read = (f) => readFileSync(new URL(f, siteDir), 'utf8');
  const site = CITY.site.endsWith('/') ? CITY.site : CITY.site + '/';
  const place = existsSync(new URL('cities.js', siteDir)) ? placeFor(read('cities.js'), CITY.key, { city: CITY.name, state: '' }) : { city: CITY.name, state: '' };
  const { events, generated } = JSON.parse(read('events.json'));
  const built = generated && !Number.isNaN(Date.parse(generated)) ? generated : '';
  const ld = jsonLd(events, place, { today, site, modified: built ? localIso(built) : undefined });
  const how = existsSync(new URL('how.html', siteDir));
  const guidesFile = new URL('../guides.json', siteDir);
  const made = existsSync(guidesFile) ? buildPages(events, place, { today, guides: JSON.parse(readFileSync(guidesFile, 'utf8')), built: built ? localIso(built) : '', has: (f) => existsSync(new URL(f, siteDir)), site }) : [];
  for (const pg of made) { mkdirSync(new URL(pg.path, siteDir), { recursive: true }); writeFileSync(new URL(`${pg.path}index.html`, siteDir), pg.html); }
  const home = injectVenuesLink(injectUpdated(injectMapLink(read('index.html')), built, { how }), made.length > 0);
  writeFileSync(new URL('index.html', siteDir), injectLd(injectAgenda(home, staticAgenda(events, today, CITY.defaultOff || [])), ld));
  const stamp = process.env.GITHUB_ACTIONS === 'true' || process.env.STAMP_REVISED === '1';
  const pages = [{ path: '', freq: 'daily', lastmod: built ? localIso(built).slice(0, 10) : today }];
  for (const page of ['advertise.html', 'about.html', 'faq.html', 'sources.html', 'how.html']) {
    if (!existsSync(new URL(page, siteDir))) continue;
    const canon = canonicalOf(read(page));
    if (canon && canon !== site + page) continue;
    if (noindexOf(read(page))) continue;
    const changed = stamp ? gitDate(fileURLToPath(siteDir), page) : '';
    if (changed && revisedDate(read(page)) && revisedDate(read(page)) !== changed) writeFileSync(new URL(page, siteDir), stampRevised(read(page), changed));
    pages.push({ path: page, freq: 'monthly', lastmod: changed || revisedDate(read(page)) });
  }
  for (const pg of made) if (pg.count) pages.push({ path: pg.path, freq: 'daily', lastmod: built ? localIso(built).slice(0, 10) : today });
  writeFileSync(new URL('sitemap.xml', siteDir), sitemapXml(site, pages, today));
  writeFileSync(new URL('robots.txt', siteDir), robotsTxt(site));
  console.log(`seo: ${ld['@graph'].filter((x) => x['@type'] === 'Event').length} events as JSON-LD (${place.city}, ${place.state}), More Cities link in the footer, Updated ${built ? longDate(built) : 'line off (the feed has no build time)'}, ${made.length ? `${made.length} venue and team pages, ` : ''}sitemap ${pages.length} url(s), robots.txt → ${site}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.env.SITE_DIR ? new URL(process.env.SITE_DIR.replace(/\/?$/, '/'), `file://${process.cwd()}/`) : undefined);
