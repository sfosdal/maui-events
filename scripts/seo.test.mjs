import test from 'node:test';
import assert from 'node:assert/strict';
import { utcOffset, isoStart, isoEnd, eventLd, pickEvents, jsonLd, sitemapXml, robotsTxt, injectLd, placeFor, injectMapLink, MAP_LINK, EVENT_CAP } from './seo.mjs';

const SEA = { city: 'Seattle', state: 'WA' };

test('utcOffset follows the date (PDT in October, PST in December) and other zones', () => {
  assert.equal(utcOffset('2026-10-20', '19:00:00', 'America/Los_Angeles'), '-07:00');
  assert.equal(utcOffset('2026-12-20', '19:00:00', 'America/Los_Angeles'), '-08:00');
  assert.equal(utcOffset('2026-12-20', '19:00:00', 'America/Cancun'), '-05:00');
  assert.equal(utcOffset('2026-07-04', '19:00:00', 'Pacific/Honolulu'), '-10:00');
});

test('isoStart: clock rows carry the offset, HH:MM is padded, no clock → date only', () => {
  assert.equal(isoStart({ date: '2026-10-20', time: '19:30:00' }, 'America/Los_Angeles'), '2026-10-20T19:30:00-07:00');
  assert.equal(isoStart({ date: '2026-10-20', time: '19:30' }, 'America/Los_Angeles'), '2026-10-20T19:30:00-07:00');
  assert.equal(isoStart({ date: '2026-10-20', time: '' }, 'America/Los_Angeles'), '2026-10-20');
  assert.equal(isoStart({ date: '2026-10-20' }, 'America/Los_Angeles'), '2026-10-20');
});

test('isoEnd rolls past midnight to the next day, and is absent without a start clock', () => {
  assert.equal(isoEnd({ date: '2026-10-31', time: '22:00:00', end: '01:00:00' }, 'America/Los_Angeles'), '2026-11-01T01:00:00-07:00');
  assert.equal(isoEnd({ date: '2026-10-20', time: '19:00:00', end: '23:00:00' }, 'America/Los_Angeles'), '2026-10-20T23:00:00-07:00');
  assert.equal(isoEnd({ date: '2026-10-20', time: '', end: '23:00:00' }, 'America/Los_Angeles'), undefined);
});

test('eventLd: the Google-required fields, status, sold out, free, country by state', () => {
  const e = { venue: 'Climate Pledge Arena', title: 'Kraken vs Oilers', date: '2026-10-20', time: '19:00:00', url: 'https://t.example/1', soldOut: true, status: 'postponed' };
  const ld = eventLd(e, SEA, 'America/Los_Angeles');
  assert.equal(ld['@type'], 'Event');
  assert.equal(ld.name, 'Kraken vs Oilers');
  assert.equal(ld.startDate, '2026-10-20T19:00:00-07:00');
  assert.equal(ld.location.name, 'Climate Pledge Arena');
  assert.deepEqual(ld.location.address, { '@type': 'PostalAddress', addressLocality: 'Seattle', addressRegion: 'WA', addressCountry: 'US' });
  assert.equal(ld.eventStatus, 'https://schema.org/EventPostponed');
  assert.equal(ld.offers.availability, 'https://schema.org/SoldOut');
  assert.equal(ld.isAccessibleForFree, undefined);
  const free = eventLd({ ...e, soldOut: false, status: undefined, free: true }, { city: 'Cancún', state: 'QR' }, 'America/Cancun');
  assert.equal(free.eventStatus, 'https://schema.org/EventScheduled');
  assert.equal(free.isAccessibleForFree, true);
  assert.equal(free.location.address.addressCountry, 'MX');
  assert.equal(eventLd(e, { city: 'San Juan', state: 'PR' }).location.address.addressCountry, 'US');
});

test('pickEvents: from today, 60 days ahead, soonest first, TBD rows out, capped', () => {
  const rows = [
    { venue: 'V', title: 'past', date: '2026-10-15', time: '19:00:00', url: 'u' },
    { venue: 'V', title: 'tonight late', date: '2026-10-16', time: '21:00:00', url: 'u' },
    { venue: 'V', title: 'tonight early', date: '2026-10-16', time: '18:00:00', url: 'u' },
    { venue: 'V', title: 'far', date: '2026-12-16', time: '19:00:00', url: 'u' },
    { venue: 'V', title: 'tbd', date: '2026-10-20', time: '', url: 'u', dateTbd: true },
    { venue: 'V', title: 'edge', date: '2026-12-15', time: '19:00:00', url: 'u' },
  ];
  assert.deepEqual(pickEvents(rows, '2026-10-16').map((e) => e.title), ['tonight early', 'tonight late', 'edge']);
  const many = Array.from({ length: EVENT_CAP + 50 }, (_, i) => ({ venue: 'V', title: 't' + i, date: '2026-10-17', time: '19:00:00', url: 'u' }));
  assert.equal(pickEvents(many, '2026-10-16').length, EVENT_CAP);
});

test('jsonLd: a @graph with the WebSite first, then the events', () => {
  const ld = jsonLd([{ venue: 'V', title: 'A', date: '2026-10-17', time: '19:00:00', url: 'u' }], SEA, { today: '2026-10-16', tz: 'America/Los_Angeles', site: 'https://x.here.events/', name: 'X' });
  assert.equal(ld['@context'], 'https://schema.org');
  assert.equal(ld['@graph'][0]['@type'], 'WebSite');
  assert.equal(ld['@graph'][0].url, 'https://x.here.events/');
  assert.equal(ld['@graph'][1].name, 'A');
});

test('sitemap and robots name the site', () => {
  const xml = sitemapXml('https://x.here.events/', [{ path: '', freq: 'daily' }, { path: 'advertise.html', freq: 'monthly' }], '2026-10-16');
  assert.match(xml, /<loc>https:\/\/x\.here\.events\/<\/loc><lastmod>2026-10-16<\/lastmod><changefreq>daily<\/changefreq>/);
  assert.match(xml, /<loc>https:\/\/x\.here\.events\/advertise\.html<\/loc>/);
  assert.equal(robotsTxt('https://x.here.events/'), 'User-agent: *\nAllow: /\n\nSitemap: https://x.here.events/sitemap.xml\n');
});

test('injectLd puts one block before </body>, replaces an old one, escapes </script>', () => {
  const html = '<html><head><title>t</title>\n</head><body><p>x</p>\n</body></html>';
  const once = injectLd(html, { a: 1 });
  assert.match(once, /<p>x<\/p>\n<script type="application\/ld\+json" id="events-ld">\{"a":1\}<\/script>\n<\/body>/);
  const twice = injectLd(once, { name: 'x</script>' });
  assert.equal((twice.match(/id="events-ld"/g) || []).length, 1);
  assert.match(twice, /x<\\\/script>/);
  assert.throws(() => injectLd('<html></html>', {}), /no <\/body>/);
});

test('placeFor reads the city and state behind a key from cities.js', () => {
  const js = '// header\nwindow.LQACities = { "map": "https://here.events/", "cities": [ { "key": "lqa", "name": "Lower Queen Anne", "city": "Seattle", "state": "WA" } ] };\n';
  assert.deepEqual(placeFor(js, 'lqa', null), { city: 'Seattle', state: 'WA' });
  assert.deepEqual(placeFor(js, 'nope', { city: 'F', state: '' }), { city: 'F', state: '' });
});

test('injectMapLink: one static More Cities link to the map as the first footer link; idempotent; strips the old city-links nav', () => {
  const html = '<body><main></main>\n<footer>\n  <div class="foot-links"> <!-- c -->\n  <a class="foot-link" id="advertise" href="advertise.html">A</a>\n  </div>\n</footer>\n</body>';
  const once = injectMapLink(html);
  assert.equal(once, `<body><main></main>\n<footer>\n  <div class="foot-links"> <!-- c -->\n  ${MAP_LINK}\n  <a class="foot-link" id="advertise" href="advertise.html">A</a>\n  </div>\n</footer>\n</body>`);
  assert.equal(injectMapLink(once), once, 'a second run adds nothing');
  const old = html.replace('<footer>', '<nav class="city-links" id="city-links" aria-label="x"><a href="https://here.events/">All</a></nav>\n<footer>');
  assert.equal(injectMapLink(old), once, 'the 2026-10-18 nav row is removed');
  assert.throws(() => injectMapLink('<body></body>'), /no <div class="foot-links">/);
});
