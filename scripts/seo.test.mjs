import test from 'node:test';
import assert from 'node:assert/strict';
import { tagsOf, STATIC_PER_VENUE, clock, staticAgenda, injectAgenda, injectVenuesLink, VENUES_LINK, buildPages, STATIC_ROWS,
  utcOffset, isoStart, isoEnd, eventLd, pickEvents, jsonLd, sitemapXml, robotsTxt, injectLd, placeFor, injectMapLink, MAP_LINK, EVENT_CAP, localIso, longDate, injectUpdated, revisedDate, canonicalOf, noindexOf, stampRevised, gitDate } from './seo.mjs';

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

test('jsonLd: with a build time, a WebPage with dateModified sits after the WebSite', () => {
  const ld = jsonLd([{ venue: 'V', title: 'A', date: '2026-10-17', time: '19:00:00', url: 'u' }], SEA, { today: '2026-10-16', tz: 'America/Los_Angeles', site: 'https://x.here.events/', name: 'X', modified: '2026-10-16T12:03:11-07:00' });
  assert.deepEqual(ld['@graph'].map((x) => x['@type']), ['WebSite', 'WebPage', 'Event']);
  assert.equal(ld['@graph'][1].dateModified, '2026-10-16T12:03:11-07:00');
  assert.equal(ld['@graph'][1].url, 'https://x.here.events/');
});

test('sitemap lastmod: a page\'s own date, none for a page without one, today only when unset', () => {
  const xml = sitemapXml('https://x.here.events/', [{ path: '', freq: 'daily', lastmod: '2026-11-15' }, { path: 'about.html', freq: 'monthly', lastmod: '2026-11-14' }, { path: 'faq.html', freq: 'monthly', lastmod: '' }, { path: 'old.html', freq: 'monthly' }], '2026-11-16');
  assert.match(xml, /<loc>https:\/\/x\.here\.events\/<\/loc><lastmod>2026-11-15<\/lastmod>/);
  assert.match(xml, /about\.html<\/loc><lastmod>2026-11-14<\/lastmod>/);
  assert.match(xml, /faq\.html<\/loc><changefreq>monthly/);
  assert.match(xml, /old\.html<\/loc><lastmod>2026-11-16<\/lastmod>/);
});

test('localIso and longDate write an instant in the city\'s own time', () => {
  assert.equal(localIso('2026-11-15T20:03:11.000Z', 'America/Los_Angeles'), '2026-11-15T12:03:11-08:00');
  assert.equal(localIso('2026-07-02T03:30:00Z', 'America/Chicago'), '2026-07-01T22:30:00-05:00');
  assert.equal(localIso('2026-11-15T22:00:00Z', 'Pacific/Honolulu'), '2026-11-15T12:00:00-10:00');
  assert.equal(longDate('2026-07-02T03:30:00Z', 'America/Chicago'), 'July 1, 2026');
});

test('injectUpdated: one line before the list, replaced on a rerun, off without a build time', () => {
  const html = '<body><nav></nav>\n<section class="agenda" aria-label="x">\n</section>\n</body>';
  const once = injectUpdated(html, '2026-11-15T20:03:11.000Z', { tz: 'America/Los_Angeles', how: true });
  assert.equal(once, '<body><nav></nav>\n<p class="updated" id="updated">Updated <time datetime="2026-11-15T12:03:11-08:00">November 15, 2026</time> · <a href="how.html">How it’s made</a></p>\n<section class="agenda" aria-label="x">\n</section>\n</body>');
  const next = injectUpdated(once, '2026-11-16T20:00:00.000Z', { tz: 'America/Los_Angeles' });
  assert.equal((next.match(/id="updated"/g) || []).length, 1);
  assert.match(next, /November 16, 2026<\/time><\/p>\n<section class="agenda"/);
  assert.equal(injectUpdated(once, '', {}), html, 'no build time: the old line goes, none is written');
  assert.equal(injectUpdated('<body></body>', '2026-11-15T20:03:11.000Z', { tz: 'UTC' }), '<body></body>', 'no list: left alone');
});

test('revisedDate reads a page\'s Last revised date', () => {
  assert.equal(revisedDate('<main><p class="ad-revised">Last revised <time datetime="2026-11-14">November 14, 2026</time></p></main>'), '2026-11-14');
  assert.equal(revisedDate('<main><p>x</p></main>'), '');
});

test('canonicalOf reads the page\'s one true address', () => {
  assert.equal(canonicalOf('<head><link rel="canonical" href="https://seattle.here.events/how.html"></head>'), 'https://seattle.here.events/how.html');
  assert.equal(canonicalOf('<head></head>'), '');
});

test('a noindex page is recognised, an ordinary one is not', () => {
  assert.equal(noindexOf('<head><meta name="robots" content="noindex"></head>'), true);
  assert.equal(noindexOf('<head><meta name="robots" content="noindex, follow"></head>'), true);
  assert.equal(noindexOf('<head><meta name="description" content="x"></head>'), false);
});

test('stampRevised sets the Last revised line, and leaves a page without one alone', () => {
  const page = '<main><p class="ad-revised">Last revised <time datetime="2026-10-29">October 29, 2026</time></p></main>';
  assert.equal(stampRevised(page, '2026-11-06'), '<main><p class="ad-revised">Last revised <time datetime="2026-11-06">November 6, 2026</time></p></main>');
  assert.equal(revisedDate(stampRevised(page, '2026-12-31')), '2026-12-31');
  assert.equal(stampRevised('<main><p>x</p></main>', '2026-11-06'), '<main><p>x</p></main>');
});

test('gitDate is empty where git has nothing to say', () => {
  assert.equal(gitDate('/', 'no-such-file.html'), '');
});

const ROWS = [
  { venue: 'Timber Arena', title: 'Steelheads vs. <Owls>', date: '2026-11-28', time: '19:05:00', url: 'https://example.com/a?x=1&y=2' },
  { venue: 'Timber Arena', title: 'Ice Show', date: '2026-12-02', time: '', url: '' },
  { venue: 'The Roadhouse', title: 'Julee Cruise Night', date: '2026-11-28', time: '21:00', url: 'https://example.com/b', soldOut: true },
  { venue: 'The Roadhouse', title: 'Gone already', date: '2026-11-01', time: '21:00', url: 'https://example.com/c' },
];
const TP = { name: 'Twin Peaks', venues: { 'Timber Arena': { capacity: 5200, url: 'https://example.com/arena' }, 'The Roadhouse': {}, 'Empty Hall': {}, 'Elsewhere in Twin Peaks': {} }, teams: [{ slug: 'steelheads', label: 'Steelheads', re: /steelheads/i, venue: 'Timber Arena' }, { slug: 'kraken', label: 'Kraken', re: /kraken/i, venue: 'Climate Pledge Arena' }] };

test('clock: 24-hour feed times read as a clock face; no time is All day', () => {
  assert.equal(clock('19:05:00'), '7:05 PM');
  assert.equal(clock('00:30'), '12:30 AM');
  assert.equal(clock('12:00'), '12:00 PM');
  assert.equal(clock(''), 'All day');
});

test('staticAgenda: upcoming rows only, soonest first, grouped by month and day, escaped, capped, hidden venues left out', () => {
  const html = staticAgenda(ROWS, '2026-11-20');
  assert.equal((html.match(/class="ev[ "]/g) || []).length, 3);
  assert.equal((html.match(/class="month-group"/g) || []).length, 2);
  assert.equal((html.match(/class="day-row"/g) || []).length, 2);
  assert.ok(html.indexOf('Steelheads') < html.indexOf('Julee') && html.indexOf('Julee') < html.indexOf('Ice Show'));
  assert.ok(html.includes('Steelheads vs. &lt;Owls&gt;') && html.includes('href="https://example.com/a?x=1&amp;y=2"'));
  assert.ok(!html.includes('Gone already'));
  assert.ok(html.includes('<div class="ev is-allday"><span class="time">All day</span>'));
  assert.ok(!staticAgenda(ROWS, '2026-11-20', ['The Roadhouse']).includes('Julee'));
  assert.equal(staticAgenda(ROWS, '2027-01-01'), '');
  const many = Array.from({ length: 90 }, (_, i) => ({ venue: `V${i % 9}`, title: `t${i}`, date: '2026-12-01', time: '10:00' }));
  assert.equal((staticAgenda(many, '2026-11-20').match(/class="ev"/g) || []).length, STATIC_ROWS);
  const one = many.map((e) => ({ ...e, venue: 'V' }));
  assert.equal((staticAgenda(one, '2026-11-20').match(/class="ev"/g) || []).length, STATIC_PER_VENUE);
});

test('injectAgenda: fills the list, again on a second run; no rows or no list leaves the page alone', () => {
  const page = '<section class="agenda"><ol id="agenda"><li class="empty">Loading events…</li></ol></section>';
  const once = injectAgenda(page, '<li class="month-group">A $1</li>');
  assert.equal(once, '<section class="agenda"><ol id="agenda"><li class="month-group">A $1</li></ol></section>');
  assert.equal(injectAgenda(once, '<li class="month-group">B</li>'), '<section class="agenda"><ol id="agenda"><li class="month-group">B</li></ol></section>');
  assert.equal(injectAgenda(page, ''), page);
  assert.equal(injectAgenda('<p>no list</p>', '<li>x</li>'), '<p>no list</p>');
});

test('injectVenuesLink: after More Cities, once, and gone again when the city has no pages', () => {
  const page = `<div class="foot-links">\n  ${MAP_LINK}\n</div>`;
  const on = injectVenuesLink(page, true);
  assert.ok(on.indexOf(MAP_LINK) < on.indexOf(VENUES_LINK));
  assert.equal(injectVenuesLink(on, true), on);
  assert.equal(injectVenuesLink(on, false), page);
  assert.equal(injectVenuesLink(page, false), page);
});

test('buildPages: an index, a page per venue (the empty one too) and per team, each with its own rows, links and data', () => {
  const pages = buildPages(ROWS, { city: 'Twin Peaks', state: 'WA' }, { today: '2026-11-20', built: '2026-11-20T12:00:00-08:00', city: TP, site: 'https://twinpeaks.here.events/', guides: { venues: { 'Timber Arena': 'A cold barn.\n\nPark on Sparkwood.' } }, has: (f) => f === 'events-venue-timber-arena.ics' });
  assert.deepEqual(pages.map((p) => [p.path, p.count]), [['venues/', 3], ['venues/timber-arena/', 2], ['venues/the-roadhouse/', 1], ['venues/empty-hall/', 0], ['teams/steelheads/', 1]]);
  const arena = pages[1].html;
  assert.ok(arena.includes('<title>Timber Arena Events and Schedule — Twin Peaks, WA</title>'));
  assert.ok(arena.includes('<link rel="canonical" href="https://twinpeaks.here.events/venues/timber-arena/">'));
  assert.ok(arena.includes('2 upcoming events') && arena.includes('<p>A cold barn.</p>') && arena.includes('<p>Park on Sparkwood.</p>') && arena.includes('about 5,200 people'));
  assert.ok(arena.includes('Steelheads vs. &lt;Owls&gt;') && arena.includes('Ice Show') && !arena.includes('Julee'));
  assert.ok(arena.includes('href="../../events-venue-timber-arena.ics"') && arena.includes('href="../../venues/the-roadhouse/"') && arena.includes('href="../../teams/steelheads/"'));
  assert.ok(arena.includes('<h2>November 2026</h2>') && arena.includes('<h2>December 2026</h2>') && arena.includes('Sat, Nov 28 · 7:05 PM'));
  assert.equal(JSON.parse(arena.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1])['@graph'].filter((x) => x['@type'] === 'Event').length, 2);
  assert.ok(!arena.includes('<!--'));
  const road = pages[2].html;
  assert.ok(road.includes('<em>Sold out</em>') && !road.includes('events-venue-') && road.includes('1 upcoming event,'));
  const empty = pages[3].html;
  assert.ok(empty.includes('Nothing is on the calendar at Empty Hall') && !empty.includes('ld+json'));
  const team = pages[4].html;
  assert.ok(team.includes('<title>Steelheads Home Schedule — Timber Arena</title>') && team.includes('1 home game on') && team.includes('href="../../?team=steelheads"') && team.includes('<small>Timber Arena</small>'));
  assert.equal(buildPages(ROWS, { city: 'Twin Peaks', state: 'WA' }, { today: '2026-11-20', city: TP, site: 'https://twinpeaks.here.events/', guides: { skip: ['Empty Hall'] } }).length, 4);
  assert.ok(empty.includes('<meta name="robots" content="noindex">') && !arena.includes('noindex'));
  assert.ok(arena.includes('href="https://here.events/privacy/"') && arena.includes('mailto:hello@here.events') && !arena.includes('about.html'));
  const many = [...ROWS, { venue: 'The Roadhouse', title: 'Steelheads vs. Owls', date: '2026-12-05', time: '19:00' }];
  const solo = buildPages(many.filter((e) => /steelheads/i.test(e.title) || e.venue !== 'Timber Arena').map((e) => ({ ...e, venue: 'Timber Arena' })).filter((e) => /steelheads/i.test(e.title)), { city: 'Twin Peaks', state: 'WA' }, { today: '2026-11-20', city: TP, site: 'https://twinpeaks.here.events/', has: (f) => f === 'about.html' });
  const soloTeam = solo.find((p) => p.path === 'teams/steelheads/');
  assert.equal(soloTeam.count, 0);
  assert.ok(soloTeam.html.includes('<link rel="canonical" href="https://twinpeaks.here.events/venues/timber-arena/">') && soloTeam.html.includes('Visiting: &lt;Owls&gt;, Owls.') && soloTeam.html.includes('href="../../about.html"'));
  assert.ok(pages[0].html.includes('href="../venues/timber-arena/"') && pages[0].html.includes('nothing listed now') && pages[0].html.includes('href="../teams/steelheads/"'));
});

test('tagsOf: the home page\'s Analytics and AdSense tags, carried onto every generated page', () => {
  const head = '<script>var t;</script>\n<script async src="https://www.googletagmanager.com/gtag/js?id=G-TEST12345"></script>\n<script>\n  gtag(\'config\', \'G-TEST12345\');\n</script>\n<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-123" crossorigin="anonymous"></script>\n<title>x</title>';
  const tags = tagsOf(head);
  assert.ok(tags.startsWith('<script async src="https://www.googletagmanager.com') && tags.includes("gtag('config', 'G-TEST12345');") && tags.endsWith('crossorigin="anonymous"></script>') && !tags.includes('var t;'));
  assert.equal(tagsOf('<title>x</title>'), '');
  const pages = buildPages(ROWS, { city: 'Twin Peaks', state: 'WA' }, { today: '2026-11-20', city: TP, site: 'https://twinpeaks.here.events/', tags });
  assert.ok(pages.every((p) => p.html.includes('adsbygoogle.js?client=ca-pub-123') && p.html.indexOf('G-TEST12345') < p.html.indexOf('<title>')));
});
