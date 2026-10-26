import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poeDate, parsePoeMonths, parsePoeEvents, parseNwacIcal, isChurch } from './sources.mjs';

test('isChurch drops church events by venue or title and nothing else', () => {
  assert.ok(isChurch({ venue: 'New Life Church', title: 'Steven Curtis Chapman: Speechless 25th Anniversary Tour' }));
  assert.ok(isChurch({ venue: 'New Life Center', title: 'Christmas Concert' }));
  assert.ok(isChurch({ venue: 'Everett', title: 'Worship Night with Phil Wickham' }));
  assert.ok(isChurch({ venue: 'Angel of the Winds Arena', title: 'Harvest Ministries Crusade' }));
  assert.ok(isChurch({ venue: 'Our Lady of Perpetual Help Parish', title: 'Spaghetti Dinner' }));
  assert.ok(!isChurch({ venue: 'Angel of the Winds Arena', title: 'Everett Silvertips vs Spokane Chiefs' }));
  assert.ok(!isChurch({ venue: 'Village Theatre', title: 'Ragtime The Musical' }));
  assert.ok(!isChurch({ venue: 'El Sid', title: 'Gospel Brunch' })); // a bar's brunch is a bar event
  assert.ok(!isChurch({ venue: 'Funko Field', title: 'Faith & Family Night' })); // a ballpark promotion stays
  assert.ok(isChurch({ venue: 'APEX Everett', title: 'Church of Misery' })); // a band with "church" in its name goes too: the rule errs toward dropping ("100% not listed")
});

test('poeDate parses the Port calendar date style', () => {
  assert.equal(poeDate('Aug 4, 2026'), '2026-08-04');
  assert.equal(poeDate('August 22, 2026'), '2026-08-22');
  assert.equal(poeDate('Dec 31, 2026'), '2026-12-31');
  assert.equal(poeDate('not a date'), '');
});

test('parsePoeMonths reads the active-month index', () => {
  assert.deepEqual(
    parsePoeMonths('<months><month>202608</month><month>202609</month></months>'),
    ['202608', '202609'],
  );
});

const SAMPLE = `
<events format="3.2">
  <event id="1" calendarid="1">
    <name><![CDATA[Music at the Marina]]></name>
    <date_begin>Jul 2, 2026</date_begin>
    <time_begin>18:00</time_begin>
    <repeat>weekly</repeat>
    <dates>08-06-2026,08-13-2026</dates>
  </event>
  <event id="2" calendarid="1">
    <name><![CDATA[Wheels on the Waterfront Car Show]]></name>
    <date_begin>Aug 22, 2026</date_begin>
    <time_begin></time_begin>
    <repeat />
    <dates />
  </event>
  <event id="3" calendarid="1">
    <name><![CDATA[CANCELED: Commission Meeting]]></name>
    <date_begin>Aug 20, 2026</date_begin>
    <time_begin>12:00</time_begin>
    <dates />
  </event>
  <event id="4" calendarid="1">
    <name><![CDATA[Special Event Parking Rates in Effect: Music at the Marina]]></name>
    <date_begin>Aug 6, 2026</date_begin>
    <time_begin></time_begin>
    <dates />
  </event>
</events>`;

test('parsePoeEvents expands repeats and drops noise', () => {
  const evs = parsePoeEvents(SAMPLE);
  assert.deepEqual(evs, [
    { title: 'Music at the Marina', date: '2026-08-06', time: '18:00:00' },
    { title: 'Music at the Marina', date: '2026-08-13', time: '18:00:00' },
    { title: 'Wheels on the Waterfront Car Show', date: '2026-08-22', time: '' },
  ]);
});

import { parseSquarespaceEvents, dropTimeClashes } from './sources.mjs';

// Trimmed from lateshifteverett.com/eventscalendar?format=json — startDate is
// epoch ms; the site's time zone is America/Los_Angeles.
const SQ_SAMPLE = {
  website: { timeZone: 'America/Los_Angeles' },
  upcoming: [
    {
      title: 'Leroy Bell &amp; His Only Friends + Lady A',
      startDate: 1789178400694, // 2026-09-11 19:00 PDT
      fullUrl: '/shows/2026/9/11/leroy-bell',
      location: { addressTitle: 'Kings Hall at APEX Everett' },
    },
    {
      title: 'And Then There Were None',
      startDate: 1798929000337, // 2027-01-02 14:30 PST
      fullUrl: '/eventscalendar/and-then',
      location: {},
    },
    { title: 'No date, skipped', fullUrl: '/x', location: { addressTitle: 'Lucky Dime' } },
  ],
};

test('parseSquarespaceEvents maps items to local date/time, decoded title, absolute url', () => {
  const evs = parseSquarespaceEvents(SQ_SAMPLE, { base: 'https://www.example.com', fallbackVenue: 'Everett' });
  assert.deepEqual(evs, [
    { venue: 'Kings Hall at APEX Everett', title: 'Leroy Bell & His Only Friends + Lady A',
      date: '2026-09-11', time: '19:00:00', url: 'https://www.example.com/shows/2026/9/11/leroy-bell' },
    { venue: 'Everett', title: 'And Then There Were None',
      date: '2027-01-02', time: '14:30:00', url: 'https://www.example.com/eventscalendar/and-then' },
  ]);
});

test('dropTimeClashes drops candidates already covered at the same venue, date and time', () => {
  const existing = [
    { venue: 'APEX Everett', date: '2026-09-11', time: '19:00:00', title: 'Leroy Bell & His Only Friends & Lady A' },
    { venue: 'Port of Everett', date: '2026-09-11', time: '', title: 'Jetty Island Days' },
  ];
  const candidates = [
    { venue: 'APEX Everett', date: '2026-09-11', time: '19:00:00', title: 'Leroy Bell + Lady A' }, // clash
    { venue: 'APEX Everett', date: '2026-09-11', time: '21:00:00', title: 'Late show' },           // different time
    { venue: 'Port of Everett', date: '2026-09-11', time: '', title: 'Untimed thing' },            // no time: never a clash
  ];
  assert.deepEqual(dropTimeClashes(candidates, existing).map((e) => e.title), ['Late show', 'Untimed thing']);
});

test('parseNwacIcal: the one college\'s home games — "at Everett" or an Everett ground — in Pacific time, with the sport; friendlies elsewhere and other colleges\' games dropped', () => {
  const ics = [
    'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'DTSTART:20260903T020000Z', 'SUMMARY:(Women\'s Soccer) Northwest University at Everett (6-0)', 'CATEGORIES:Women\'s Soccer',
    'LOCATION:Everett Memorial Stadium\\, 3900 Broadway\\, Everett\\,', ' WA', 'URL:/sports/wsoc/2026-27/boxscores/20260902_iapq.xml', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20260818T220000Z', 'SUMMARY:(Women\'s Soccer) Everett vs. Blue Mountain (1-2)', 'LOCATION:Starfire Sports Complex', 'END:VEVENT', // a neutral-site friendly in Tukwila
    'BEGIN:VEVENT', 'DTSTART:20260910T010000Z', 'SUMMARY:(Women\'s Soccer) Everett at Skagit Valley', 'LOCATION:Skagit Valley College\\, Mount Vernon\\, WA', 'END:VEVENT', // away
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261121', 'SUMMARY:(Men\'s Basketball) Bellevue at Everett', 'LOCATION:Everett Community College', 'END:VEVENT', // no time yet
    'BEGIN:VEVENT', 'DTSTART:20260910T010000Z', 'SUMMARY:(Women\'s Soccer) Peninsula at Olympic', 'LOCATION:Bremerton\\, WA', 'END:VEVENT', // another college's
    'END:VCALENDAR',
  ].join('\r\n');
  const out = parseNwacIcal(ics);
  assert.deepEqual(out, [
    { venue: 'Everett Community College', title: 'Everett CC Trojans vs Northwest University (Women\'s Soccer)', date: '2026-09-02', time: '19:00:00', url: 'https://nwacsports.com/sports/wsoc/2026-27/boxscores/20260902_iapq.xml', type: 'sports' },
    { venue: 'Everett Community College', title: 'Everett CC Trojans vs Bellevue (Men\'s Basketball)', date: '2026-11-21', time: '', url: 'https://nwacsports.com', type: 'sports' },
  ]);
});

// --- the 2026-10-11 round: the cities, the libraries, the Schack, Snohomish, Mill Creek, the theatre ---
import { civicDate, civicTime, isMeeting, parseCivicPlusRss, parseBiblioCommonsEvents, parseJsonLdEvents, parseMillCreekEvents, millCreekTime } from './sources.mjs';

test('civicDate and civicTime read the CivicPlus wording', () => {
  assert.equal(civicDate('October 13, 2026'), '2026-10-13');
  assert.equal(civicDate('Saturday, October 10, 2026'), '2026-10-10');
  assert.equal(civicDate('October 13, 2026 - October 15, 2026'), '2026-10-13');
  assert.equal(civicDate('TBA'), '');
  assert.equal(civicTime('10:30 AM - 11:00 AM'), '10:30:00');
  assert.equal(civicTime('7 PM'), '19:00:00');
  assert.equal(civicTime('12:15 pm'), '12:15:00');
  assert.equal(civicTime('12:00 AM'), '00:00:00');
  assert.equal(civicTime('10:30 a.m. - 11:30 a.m.'), '10:30:00');
  assert.equal(civicTime(''), '');
});

test('parseCivicPlusRss keeps events, drops meetings, strips permit prefixes', () => {
  const xml = `<rss><channel>
    <item><title>Toddler Storytime (Main Library)</title><link>https://www.epls.org/Calendar.aspx?EID=8198</link><calendarEvent:EventDates> October 13, 2026 </calendarEvent:EventDates><calendarEvent:EventTimes>10:30 AM - 11:00 AM</calendarEvent:EventTimes></item>
    <item><title>City Council Regular Meeting</title><link>x</link><calendarEvent:EventDates>October 12, 2026</calendarEvent:EventDates><calendarEvent:EventTimes>7:00 PM - 9:00 PM</calendarEvent:EventTimes></item>
    <item><title>APPROVED 2026 Snohomish River Run</title><link>https://www.snohomishwa.gov/Calendar.aspx?EID=1</link><calendarEvent:EventDates>October 18, 2026</calendarEvent:EventDates><calendarEvent:EventTimes>8:00 AM - 12:00 PM</calendarEvent:EventTimes></item>
    <item><title>Rock &amp; Roll Trivia</title><link>y</link><calendarEvent:EventDates>Someday</calendarEvent:EventDates></item>
  </channel></rss>`;
  const evs = parseCivicPlusRss(xml, { venue: 'City of Snohomish' });
  assert.deepEqual(evs, [
    { venue: 'City of Snohomish', title: 'Toddler Storytime (Main Library)', date: '2026-10-13', time: '10:30:00', url: 'https://www.epls.org/Calendar.aspx?EID=8198' },
    { venue: 'City of Snohomish', title: '2026 Snohomish River Run', date: '2026-10-18', time: '08:00:00', url: 'https://www.snohomishwa.gov/Calendar.aspx?EID=1' },
  ]);
  assert.ok(isMeeting('Planning Commission'));
  assert.ok(isMeeting('Coffee Klatch with Lakewood School District'));
  assert.ok(!isMeeting('Boo Bash'));
});

test('parseBiblioCommonsEvents keeps the near branches, names them, skips cancellations', () => {
  const data = { entities: { events: {
    a1: { id: 'a1', definition: { title: 'Preschool  Storytime', start: '2026-12-16T09:30', end: '2026-12-16T10:00', branchLocationId: '23', isCancelled: false } },
    a2: { id: 'a2', definition: { title: 'Book Club', start: '2026-12-17T18:00', branchLocationId: '24', isCancelled: false } },
    a3: { id: 'a3', definition: { title: 'Cancelled Thing', start: '2026-12-18T18:00', branchLocationId: '23', isCancelled: true } },
    a4: { id: 'a4', definition: { title: 'All-day Sale', start: '2026-12-19', branchLocationId: '29' } },
    a5: { id: 'a5', definition: { title: 'Friends of the Mukilteo Library Meeting', start: '2026-12-20T11:00', branchLocationId: '23' } },
  } } };
  const evs = parseBiblioCommonsEvents(data, { venue: 'Sno-Isle Libraries', branches: { 23: 'Mukilteo', 29: 'Mariner' } });
  assert.deepEqual(evs, [
    { venue: 'Sno-Isle Libraries', title: 'Preschool Storytime (Mukilteo)', date: '2026-12-16', time: '09:30:00', url: 'https://sno-isle.bibliocommons.com/events/a1' },
    { venue: 'Sno-Isle Libraries', title: 'All-day Sale (Mariner)', date: '2026-12-19', time: '', url: 'https://sno-isle.bibliocommons.com/events/a4' },
  ]);
});

test('parseJsonLdEvents reads schema.org events, filters by place, strips the venue from the title', () => {
  const html = `<script type="application/ld+json">[{"@type":"MusicEvent","name":"Queen Nation @ Historic Everett Theatre","startDate":"2026-11-07T19:30:00","url":"https://www.songkick.com/concerts/43139019?utm_medium=organic","location":{"@type":"Place","name":"Historic Everett Theatre"}},{"@type":"MusicEvent","name":"Night Lovell","startDate":"2026-11-08T20:00:00","url":"https://www.songkick.com/concerts/1","location":{"name":"Showbox SoDo"}}]</script>
    <script type="application/ld+json">{"@type":"Event","name":"Snohomish Tree Lighting","startDate":"2026-11-28T15:00:00-08:00","endDate":"2026-11-28T17:00:00-08:00","url":"https://www.historicdowntownsnohomish.org/event-details/snohomish-tree-lighting-2","location":{"name":"Snohomish Carnegie Building"}}</script>
    <script type="application/ld+json">{not json</script>`;
  assert.deepEqual(parseJsonLdEvents(html, { venue: 'Historic Everett Theatre', at: /historic everett/i, titleStrip: /\s*@\s*Historic Everett Theatre\s*$/i }), [
    { venue: 'Historic Everett Theatre', title: 'Queen Nation', date: '2026-11-07', time: '19:30:00', url: 'https://www.songkick.com/concerts/43139019' },
  ]);
  assert.deepEqual(parseJsonLdEvents(html, { venue: 'Historic Downtown Snohomish' }).map((e) => e.title), ['Queen Nation @ Historic Everett Theatre', 'Night Lovell', 'Snohomish Tree Lighting']);
  assert.equal(parseJsonLdEvents(html, { venue: 'x' })[2].time, '15:00:00');
});

test('parseMillCreekEvents reads the Drupal list and millCreekTime the event page', () => {
  const html = `<div class="event-list__item"><div class="event-list__item-name"> <a href="/events/dog-walker-watch-autumn" hreflang="en">Dog Walker Watch - Autumn</a> </div><div class="event-list__item-content"><div class="event-list__item-date"> Saturday, October 10, 2026 </div></div></div>
    <div class="event-list__item"><div class="event-list__item-name"><a href="/events/trunk-or-treat-main">Trunk or Treat</a></div><div class="event-list__item-date">Saturday, October 31, 2026</div></div>
    <div class="event-list__item"><div class="event-list__item-name"><a href="/events/council">City Council Meeting</a></div><div class="event-list__item-date">Tuesday, November 3, 2026</div></div>`;
  assert.deepEqual(parseMillCreekEvents(html, { venue: 'City of Mill Creek' }), [
    { venue: 'City of Mill Creek', title: 'Dog Walker Watch - Autumn', date: '2026-10-10', time: '', url: 'https://millcreekwa.gov/events/dog-walker-watch-autumn' },
    { venue: 'City of Mill Creek', title: 'Trunk or Treat', date: '2026-10-31', time: '', url: 'https://millcreekwa.gov/events/trunk-or-treat-main' },
  ]);
  assert.equal(millCreekTime('<html><body><h1>Dog Walker Watch</h1><div class="field--name-field-date">Saturday, October 10, 2026, 10:30 a.m. - 11:30 a.m.</div></body></html>'), '10:30:00');
  assert.equal(millCreekTime('<p>no time here</p>'), '');
});

test('parseSquarespaceEvents pins a room\'s own calendar to its row when asked', () => {
  const data = { website: { timeZone: 'America/Los_Angeles' }, upcoming: [{ title: 'TRIVIA NIGHT', startDate: Date.UTC(2026, 9, 14, 2, 0), fullUrl: '/events/trivia', location: { addressTitle: 'Taproom' } }] };
  assert.equal(parseSquarespaceEvents(data, { base: 'https://www.scuttlebuttbrewing.com', venue: 'Scuttlebutt Brewing' })[0].venue, 'Scuttlebutt Brewing');
  assert.equal(parseSquarespaceEvents(data, { base: 'https://www.scuttlebuttbrewing.com' })[0].venue, 'Taproom');
});
