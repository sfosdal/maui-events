/**
 * Search plumbing for a city site, written at build time after fetch-events
 * (Steve, 2026-10-16: "queue site maps and structured data"):
 *   site/robots.txt   — allow everything, name the sitemap
 *   site/sitemap.xml  — the page (and advertise.html / faq.html when the city has them)
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

export function jsonLd(events, place, { today, tz = CITY.tz, site = CITY.site, name = CITY.name } = {}) {
  const graph = [
    { '@type': 'WebSite', name: `${name} Events`, url: site, inLanguage: 'en', publisher: { '@type': 'Organization', name: 'Ghostwood Sites', url: 'https://here.events/' } },
    ...pickEvents(events, today).map((e) => eventLd(e, place, tz)),
  ];
  return { '@context': 'https://schema.org', '@graph': graph };
}

export function sitemapXml(site, pages, today) {
  const url = (p) => `  <url><loc>${site}${p.path}</loc><lastmod>${today}</lastmod><changefreq>${p.freq}</changefreq></url>`;
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
  const { events } = JSON.parse(read('events.json'));
  const ld = jsonLd(events, place, { today, site });
  writeFileSync(new URL('index.html', siteDir), injectLd(injectMapLink(read('index.html')), ld));
  const pages = [{ path: '', freq: 'daily' }];
  if (existsSync(new URL('advertise.html', siteDir))) pages.push({ path: 'advertise.html', freq: 'monthly' });
  if (existsSync(new URL('faq.html', siteDir))) pages.push({ path: 'faq.html', freq: 'monthly' });
  writeFileSync(new URL('sitemap.xml', siteDir), sitemapXml(site, pages, today));
  writeFileSync(new URL('robots.txt', siteDir), robotsTxt(site));
  console.log(`seo: ${ld['@graph'].length - 1} events as JSON-LD (${place.city}, ${place.state}), More Cities link in the footer, sitemap ${pages.length} url(s), robots.txt → ${site}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.env.SITE_DIR ? new URL(process.env.SITE_DIR.replace(/\/?$/, '/'), `file://${process.cwd()}/`) : undefined);
