/**
 * Search plumbing for a city site, written at build time after fetch-events
 * (Steve, 2026-10-16: "queue site maps and structured data"):
 *   site/robots.txt   — allow everything, name the sitemap
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
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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

export function main(siteDir = new URL('../site/', import.meta.url), today = new Date().toISOString().slice(0, 10)) {
  const read = (f) => readFileSync(new URL(f, siteDir), 'utf8');
  const site = CITY.site.endsWith('/') ? CITY.site : CITY.site + '/';
  const place = existsSync(new URL('cities.js', siteDir)) ? placeFor(read('cities.js'), CITY.key, { city: CITY.name, state: '' }) : { city: CITY.name, state: '' };
  const { events, generated } = JSON.parse(read('events.json'));
  const built = generated && !Number.isNaN(Date.parse(generated)) ? generated : '';
  const ld = jsonLd(events, place, { today, site, modified: built ? localIso(built) : undefined });
  const how = existsSync(new URL('how.html', siteDir));
  writeFileSync(new URL('index.html', siteDir), injectLd(injectUpdated(injectMapLink(read('index.html')), built, { how }), ld));
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
  writeFileSync(new URL('sitemap.xml', siteDir), sitemapXml(site, pages, today));
  writeFileSync(new URL('robots.txt', siteDir), robotsTxt(site));
  console.log(`seo: ${ld['@graph'].filter((x) => x['@type'] === 'Event').length} events as JSON-LD (${place.city}, ${place.state}), More Cities link in the footer, Updated ${built ? longDate(built) : 'line off (the feed has no build time)'}, sitemap ${pages.length} url(s), robots.txt → ${site}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.env.SITE_DIR ? new URL(process.env.SITE_DIR.replace(/\/?$/, '/'), `file://${process.cwd()}/`) : undefined);
