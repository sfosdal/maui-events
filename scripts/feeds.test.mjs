import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapTribeEvents, tribeType, feedSources, emptyListGate, spanishDates, parseTusboletosList, tusboletosTimes, decodeBody, parseJsonLdEvents, parseIcs, icsToTribeRows, ticketeraDates, parseTicketeraList, parseTicketeraDetail, pageRoom, icsStart, mapIcsFile, eventLinks, mapSquarespaceEvents, cardDates, parseCards, mapNpsEvents, cardClock, mapLocalistEvents, parseLudus, parseBoldtypeList, mapSpektrix, parseMecInit, parseMecCards, parseRssEvents, feedFailedVenues } from './feeds.mjs';

const room = 'Field Arts &#038; Events Hall &#8211; Donna M. Morris Theater';
const row = (title, start, extra = {}) => ({ title, start_date: start, status: 'publish', all_day: false, venue: { venue: room }, categories: [], ...extra });

test('a Tribe row becomes a feed event: local date and time, the ticket link, the type from its categories', () => {
  const rows = [row('Afro-Cuban All Stars', '2026-10-16 20:00:00', { website: 'https://bit.ly/4uqyjSk', url: 'https://fieldhallevents.org/event/afro-cuban-all-stars/2026-10-16/', categories: [{ name: 'Field Hall Presents' }, { name: 'Live Music' }] })];
  assert.deepEqual(mapTribeEvents(rows, 'Field Arts & Events Hall'), [
    { venue: 'Field Arts & Events Hall', title: 'Afro-Cuban All Stars', date: '2026-10-16', time: '20:00', url: 'https://bit.ly/4uqyjSk', type: 'concert' },
  ]);
});

test('entities in titles are decoded and the event page stands in when there is no ticket link', () => {
  const [ev] = mapTribeEvents([row('Hot Damn Scandal &#8211; Heebie &#038; the Jeebies', '2026-10-31 20:00:00', { url: 'https://x.org/event/hds/' })], 'Field Hall');
  assert.equal(ev.title, 'Hot Damn Scandal – Heebie & the Jeebies');
  assert.equal(ev.url, 'https://x.org/event/hds/');
});

test('a title repeated on more dates than maxRepeat is a daily row and is left out; drop takes titles by name', () => {
  const rows = [];
  for (let d = 1; d <= 12; d++) rows.push(row('Box Office Open', `2026-11-${String(d).padStart(2, '0')} 10:00:00`));
  for (let d = 1; d <= 3; d++) rows.push(row('Afro-Cuban All Stars', `2026-10-1${5 + d} 20:00:00`));
  rows.push(row('Volunteer Orientation', '2026-11-02 18:00:00'));
  const out = mapTribeEvents(rows, 'Hall', { drop: /volunteer/i });
  assert.deepEqual(out.map((e) => e.title), ['Afro-Cuban All Stars', 'Afro-Cuban All Stars', 'Afro-Cuban All Stars']);
});

test('an all-day row has no time; a hidden or draft row is skipped', () => {
  const out = mapTribeEvents([
    row('Fair Day', '2026-08-01 00:00:00', { all_day: true }),
    row('Secret', '2026-08-02 19:00:00', { hide_from_listings: true }),
    row('Draft', '2026-08-03 19:00:00', { status: 'draft' }),
  ], 'Hall');
  assert.deepEqual(out.map((e) => [e.title, e.time]), [['Fair Day', '']]);
});

test('films are a movie where the city lists that type, arts where it does not; the venue default fills the rest', () => {
  const film = [{ name: 'Films at Field Hall' }, { name: 'Family Friendly' }];
  assert.equal(tribeType(film, new Set(['concert', 'movie'])), 'movie');
  assert.equal(tribeType(film, new Set(['concert', 'arts'])), 'arts');
  assert.equal(tribeType([{ name: 'Guest Presenter' }], new Set(['concert'])), null);
  const [ev] = mapTribeEvents([row('Mystery Night', '2026-12-01 19:00:00', { categories: [{ name: 'Guest Presenter' }] })], 'Hall', { types: ['concert', 'arts'], defaultType: 'arts' });
  assert.equal(ev.type, 'arts');
});

test('a city-wide Tribe feed takes the venue from each row and `rooms` keeps only the rooms wanted', () => {
  const rows = [
    { title: 'Nerd Halen', start_date: '2026-10-17 20:00:00', venue: { venue: 'The Shag Room' }, url: 'https://x/e/1' },
    { title: 'Samantha Fish', start_date: '2026-10-24 19:00:00', venue: { venue: '24 Oxford' }, url: 'https://x/e/2' },
    { title: 'Treaty Oak Revival', start_date: '2026-10-23 19:00:00', venue: { venue: 'The Theater' }, url: 'https://x/e/3' },
  ];
  const all = mapTribeEvents(rows, null, { defaultType: 'concert' });
  assert.deepEqual(all.map((e) => e.venue), ['The Shag Room', '24 Oxford', 'The Theater']);
  assert.equal(all[0].type, 'concert');
  const some = mapTribeEvents(rows, null, { rooms: /shag room|24 oxford/i });
  assert.deepEqual(some.map((e) => e.title), ['Nerd Halen', 'Samantha Fish']);
});

test('a venue sent as a one-element array (B-Town Blog) reads like an object; an empty array is no venue', () => {
  const rows = [row('Poe Night', '2026-10-17 19:30:00', { venue: [{ venue: 'Kennedy Catholic High School' }] }), row('Walk', '2026-10-18 10:00:00', { venue: [] })];
  const out = mapTribeEvents(rows, null, { defaultType: 'community' });
  assert.deepEqual(out.map((e) => e.venue), ['Kennedy Catholic High School', '']);
  assert.deepEqual(mapTribeEvents(rows, null, { rooms: /kennedy/i }).map((e) => e.title), ['Poe Night']);
});

test('feedSources makes one source per venue with a feed and names an unknown kind', async () => {
  const city = { types: [{ key: 'arts' }], venues: { A: { tm: { id: 'x' } }, B: { feed: { kind: 'tribe', url: 'https://x/wp-json/tribe/events/v1/events' } }, C: { feed: { kind: 'nope', url: 'https://x/' } } } };
  const srcs = feedSources(city, 'ua');
  assert.equal(srcs.length, 2);
  assert.deepEqual(await srcs[1](), []); // unknown kind: an empty source, logged
  const wide = feedSources({ types: [], venues: {}, feeds: [{ kind: 'tusboletos', url: 'https://x/eventos', label: 'TusBoletos' }, { kind: 'nope', url: 'https://x/' }] }, 'ua');
  assert.equal(wide.length, 2); // city-wide feeds (cancun-events) make a source each too
  assert.deepEqual(await wide[1](), []);
  const pinned = feedSources({ types: [{ key: 'community' }], venues: { Around: { type: 'community' } }, feeds: [{ kind: 'nope', url: 'https://x/', venue: 'Around' }] }, 'ua');
  assert.equal(pinned.length, 1); // a city-wide feed with a `venue` is a source like a room feed (seattle-events)
  assert.deepEqual(await pinned[0](), []);
});

// ---- TusBoletos (cancun-events, 2026-10-13) ----
const CARD = (title, city, room, date, tag, slug) => `<div class="thumbnail"><img class="imgevento" src="/x.jpg" alt="${title}">
  <div class="intro caption line-bottom"><h4>${title}</h4><p>…</p></div>
  <div class="detail caption">  <p><i class="fa fa-star"></i>&nbsp; <b>${city}</b></p>
    <p class="hidden-xs">&nbsp;<i class="fa fa-map-marker"></i>&nbsp; ${room}</p> <!--<p class="hidden-xs"><i class="fa fa-tag"></i>&nbsp; ${tag}</p>-->
    <p class="fecha"><i class="fa fa-calendar"></i>&nbsp; ${date}</p><a class="btn btn-primary btn-block visible-xs" role="button" href="/evento/${slug}">Ver evento</a>
  </p></div></div>`;
const LIST = CARD('“Una Eva y Tres Galanes” - Cancún', 'Cancún, Quintana Roo', 'Teatro de Cancún', 'Jueves 15 de Octubre del 2026', '“Una Eva y Tres Galanes”', 'una-eva-y-tres-galanes-cancun')
  + CARD('Harlem Globetrotters - Mérida', 'Mérida, Yucatán', 'Poliforum Zamná', 'Miercoles 14 de Octubre del 2026', 'Deportes', 'harlem-globetrotters-merida')
  + CARD('Zenón y sus Amigos "Dance Party Tributo" - Playa de Carmen', 'Playa del Carmen, Quintana Roo', 'Teatro de la Ciudad', 'Martes 20 de Octubre del 2026', 'Concierto', 'zenon-playa-del-carmen')
  + CARD('Insite - Cancún', 'Cancún, Quintana Roo', 'Teatro Alamos Cancún', 'Viernes 09 de Octubre del 2026', 'Concierto', 'insite-cancun');
const CITIES = [{ match: /^canc[uú]n,/i }, { match: /^playa del carmen,/i, suffix: ', Playa del Carmen' }];

test('Spanish dates: a dated day, a range without a year (every day in it), a wrong month', () => {
  assert.deepEqual(spanishDates('Jueves 15 de Octubre del 2026'), ['2026-10-15']);
  assert.deepEqual(spanishDates('Sábado 07 de Noviembre del 2026'), ['2026-11-07']);
  assert.deepEqual(spanishDates('Del miercoles 28 de octubre al jueves 29 de octubre', '2026-10-13'), ['2026-10-28', '2026-10-29']);
  assert.deepEqual(spanishDates('Del viernes 27 de noviembre al domingo 29 de noviembre', '2026-10-13'), ['2026-11-27', '2026-11-28', '2026-11-29']);
  assert.deepEqual(spanishDates('Sábado 9 de enero', '2026-12-20'), ['2027-01-09']); // next January, not last
  assert.deepEqual(spanishDates('el 3 de brumario'), []);
});

test('the TusBoletos list: only the chosen towns, the city suffix off the title, the quotes off a quoted title, the room suffixed for the second town', () => {
  const cards = parseTusboletosList(LIST, { cities: CITIES });
  assert.deepEqual(cards.map((c) => [c.title, c.room, c.dateText, c.tag]), [
    ['Una Eva y Tres Galanes', 'Teatro de Cancún', 'Jueves 15 de Octubre del 2026', '“Una Eva y Tres Galanes”'],
    ['Zenón y sus Amigos "Dance Party Tributo"', 'Teatro de la Ciudad, Playa del Carmen', 'Martes 20 de Octubre del 2026', 'Concierto'],
    ['Insite', 'Teatro Alamos Cancún', 'Viernes 09 de Octubre del 2026', 'Concierto'],
  ]);
  assert.equal(cards[0].href, 'https://www.tusboletos.mx/evento/una-eva-y-tres-galanes-cancun');
  assert.equal(parseTusboletosList(LIST).length, 4); // no cities: every card
});

test('the event page clock: two showings, one, none', () => {
  const page = (t) => `<p><span style="color:#f68428"><i class="fa fa-clock-o"></i></span>&nbsp;\n   ${t}                                        </p>`;
  assert.deepEqual(tusboletosTimes(page('6:30 P.M. y 9:00 P.M.')), ['18:30', '21:00']);
  assert.deepEqual(tusboletosTimes(page('4:00 P.M  y 6:30 P.M')), ['16:00', '18:30']);
  assert.deepEqual(tusboletosTimes(page('8:00 P.M.')), ['20:00']);
  assert.deepEqual(tusboletosTimes(page('12:00 P.M.')), ['12:00']);
  assert.deepEqual(tusboletosTimes(page('11:00 A.M.')), ['11:00']);
  assert.deepEqual(tusboletosTimes('<p>no clock</p>'), []);
});

// ---- schema.org Event markup (eticket.mx) ----
test('a page in ISO-8859-15 is decoded by its declared charset; UTF-8 is the default', () => {
  const latin = new Uint8Array([...new TextEncoder().encode('<meta charset="iso-8859-15"><p>Canc'), 0xfa, ...new TextEncoder().encode('n</p>')]);
  assert.equal(decodeBody(latin.buffer).slice(-13), '<p>Cancún</p>');
  assert.equal(decodeBody(new TextEncoder().encode('<p>Cancún</p>').buffer, 'text/html; charset=utf-8'), '<p>Cancún</p>');
  assert.equal(decodeBody(new TextEncoder().encode('<p>Cancún</p>').buffer), '<p>Cancún</p>');
});

test('schema.org events: the wall-clock start, the room, sold out when every offer is, a cancelled status, the `at` filter', () => {
  const ev = (name, start, loc, avail, status) => ({ '@context': 'https://schema.org', '@type': 'Event', name, startDate: start, endDate: start.slice(0, 10), url: 'https://www.eticket.mx/masinformacion.aspx?idevento=1', eventStatus: status || 'https://schema.org/EventScheduled', location: { '@type': 'Place', name: loc }, offers: avail.map((a) => ({ '@type': 'Offer', availability: 'https://schema.org/' + a })) });
  const html = `<html><script type="application/ld+json"> {"@type":"Organization","name":"eticket"} </script><script type="application/ld+json"> ${JSON.stringify([
    ev('PANTEÓN ROCOCÓ', '2026-11-14T20:30:00-05:00', 'Plaza de Toros Cancún', ['InStock', 'InStock']),
    ev('YURIDIA', '2026-11-26T21:00:00-05:00', 'Plaza de Toros Cancún', ['SoldOut', 'SoldOut']),
    ev('FERIA', '2026-12-02', 'Foro Mérida', ['InStock'], 'https://schema.org/EventCancelled'),
  ])} </script></html>`;
  const out = parseJsonLdEvents(html);
  assert.deepEqual(out.map((e) => [e.title, e.date, e.time, e.venue, !!e.soldOut, e.status || '']), [
    ['PANTEÓN ROCOCÓ', '2026-11-14', '20:30', 'Plaza de Toros Cancún', false, ''],
    ['YURIDIA', '2026-11-26', '21:00', 'Plaza de Toros Cancún', true, ''],
    ['FERIA', '2026-12-02', '', 'Foro Mérida', false, 'cancelled'],
  ]);
  assert.equal(parseJsonLdEvents(html, { at: /canc[uú]n/i }).length, 2);
  assert.equal(parseJsonLdEvents(html, { venue: 'Plaza de Toros Cancún' })[2].venue, 'Plaza de Toros Cancún'); // a per-venue feed pins the row
});

test('the empty-list gate stops a build whose own pull has nothing upcoming, unless allowed', () => {
  const today = '2026-10-13';
  assert.equal(emptyListGate([{ date: '2026-10-20' }], today, 6, {}), true);
  assert.equal(emptyListGate([{ date: '2026-09-01' }], today, 6, {}), false);
  assert.equal(emptyListGate([], today, 6, { ALLOW_EMPTY_LIST: '1' }), true);
  assert.equal(emptyListGate([], today, 0, {}), true); // nothing configured: nothing to judge
});

const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VTIMEZONE', 'TZID:America/Los_Angeles', 'BEGIN:DAYLIGHT', 'DTSTART:20250309T100000', 'END:DAYLIGHT', 'END:VTIMEZONE',
  'BEGIN:VEVENT', 'DTSTART;TZID=America/Los_Angeles:20261014T190000', 'DTEND;TZID=America/Los_Angeles:20261014T210000',
  'UID:10008056-1792004400@fieldhallevents.org', 'SUMMARY:Cozy Comedy Presents: Gary Gulman: The Grandiloquent ', ' Tour',
  'URL:https://fieldhallevents.org/event/gary-gulman/', 'LOCATION:Field Arts &amp; Events Hall – Donna M. Morris Theater\\, 201 W Front Street\\, Port Angeles',
  'CATEGORIES:Comedy,Guest Presenter', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261101', 'UID:2@x', 'SUMMARY:Open House', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;TZID=America/Los_Angeles:20261015T100000', 'UID:3@x', 'SUMMARY:Box Office Open', 'END:VEVENT',
  'END:VCALENDAR'].join('\r\n');

test('a Tribe iCal export reads like its REST rows: folded lines joined, escapes undone, the room from LOCATION, all-day dates', () => {
  const rows = icsToTribeRows(ICS);
  assert.equal(parseIcs(ICS).length, 3); // the VTIMEZONE's DTSTART is not an event
  assert.equal(rows[0].title, 'Cozy Comedy Presents: Gary Gulman: The Grandiloquent Tour');
  assert.equal(rows[0].start_date, '2026-10-14 19:00:00');
  assert.equal(rows[0].venue.venue, 'Field Arts & Events Hall – Donna M. Morris Theater');
  assert.deepEqual(rows[0].categories.map((c) => c.name), ['Comedy', 'Guest Presenter']);
  assert.equal(rows[0].url, 'https://fieldhallevents.org/event/gary-gulman/');
  assert.equal(rows[1].all_day, true);
  assert.equal(rows[1].start_date, '2026-11-01 00:00:00');
  const evs = mapTribeEvents(rows, 'Field Arts & Events Hall', { drop: /^box office open$/i, types: ['arts', 'concert'] });
  assert.deepEqual(evs.map((e) => [e.title, e.date, e.time, e.type || null]), [
    ['Cozy Comedy Presents: Gary Gulman: The Grandiloquent Tour', '2026-10-14', '19:00', 'arts'],
    ['Open House', '2026-11-01', '', null],
  ]);
});

// ---- Ticketera ----
test('ticketeraDates reads single dates, ranges across a month, English series and a year roll-over', () => {
  assert.deepEqual(ticketeraDates('oct. 16, 2026'), ['2026-10-16', '2026-10-16']);
  assert.deepEqual(ticketeraDates('oct. 22 - 23, 2026'), ['2026-10-22', '2026-10-23']);
  assert.deepEqual(ticketeraDates('oct. 30 - nov. 1, 2026'), ['2026-10-30', '2026-11-01']);
  assert.deepEqual(ticketeraDates('Sep. 17, 2026 - Oct. 25, 2026'), ['2026-09-17', '2026-10-25']);
  assert.deepEqual(ticketeraDates('Oct. 1, 2026 - Oct 31, 2026'), ['2026-10-01', '2026-10-31']);
  assert.deepEqual(ticketeraDates('dic. 30 - ene. 2, 2027'), ['2026-12-30', '2027-01-02']);
  assert.deepEqual(ticketeraDates('feb. 18 - 21', '2026-10-15'), ['2027-02-18', '2027-02-21']); // no year: the next one
  assert.deepEqual(ticketeraDates('próximamente'), []);
});

const tkCard = (href, title, room, date) => `<div class="eventItem entry featured clearfix">
  <div class="thumb"><a href="${href}" title="More Info for ${title}" tabindex="-1"><img src="x.jpg"/></a></div>
  <div class="info clearfix"><div class="date">${date}</div>
  <div class="location ">\n\t\t\t\t${room}\t\t\t</div>
  <div class="presented-by">Alexandra, LLC</div>
  <h2 class="title  ">\n\t\t<a href="${href}" title="More Info"> ${title}</a>\t</h2>
  <div class="buttons"><a href="${href}#tickets" class="tickets onsalenow " title="Buy Tickets">Boletos</a></div></div></div>`;
const tkSingle = '<span class="m-date__singleDate"><span class="m-date__month">oct. </span><span class="m-date__day">16</span><span class="m-date__year">, 2026</span></span>';
const tkRange = '<span class="m-date__rangeFirst"><span class="m-date__month">oct. </span><span class="m-date__day">30</span></span><span class="m-date__separator"> - </span><span class="m-date__rangeLast"><span class="m-date__month">nov. </span><span class="m-date__day"> 1</span><span class="m-date__year">, 2026</span></span>';
test('parseTicketeraList reads the listings and skips the Vue search template on the page', () => {
  const html = tkCard('https://www.ticketera.com/events/detail/the-noise-la-ultima-noche', 'The Noise - La &Uacute;ltima Noche', 'Coliseo de Puerto Rico', tkSingle)
    + tkCard('https://www.ticketera.com/events/detail/monster-jam-2026', 'Monster Jam 2026', 'Coliseo de Puerto Rico', tkRange)
    + '<div class="eventItem entry small clearfix"><div class="thumb"><a :href="data.full_url"></a></div><div class="date" v-html="data.date_string"></div><div class="h3 title"><a :href="data.full_url" v-text="data.name"></a></div></div>';
  const cards = parseTicketeraList(html);
  assert.equal(cards.length, 2);
  assert.deepEqual(cards[0], { title: 'The Noise - La Última Noche', room: 'Coliseo de Puerto Rico', dateText: 'oct. 16, 2026', href: 'https://www.ticketera.com/events/detail/the-noise-la-ultima-noche' });
  assert.equal(cards[1].dateText, 'oct. 30 - nov. 1, 2026');
});

const tkShowing = (wd, mo, day, time, extra = '') => `<div class="showings_wrapper"><div id="showing_30${day}" class="listItem  clearfix ">
  <span class="cell showings_date"><span class="m-date__singleDate"><span class="m-date__weekday">${wd}, </span><span class="m-date__month">${mo}. </span><span class="m-date__day">${day}</span></span></span>
  <span class="time cell">\n\t\t${time}\t\t</span><span class="buttons cell"><a href="https://choli.ticketera.com/event/x" class="tickets onsalenow ">Boletos</a>${extra}</span></div></div>`;
test('parseTicketeraDetail reads one showing per date and time, infers the year from the start, and the sidebar clock when there is no list', () => {
  const html = '<div class="event_showings"><div class="list clearfix">' + tkShowing('viernes', 'dic', 30, '8:00 PM') + tkShowing('sábado', 'ene', 2, '1:00 PM', ' <span>Agotado</span>') + '</div></div>';
  assert.deepEqual(parseTicketeraDetail(html, '2026-12-30'), { showings: [{ date: '2026-12-30', time: '20:00' }, { date: '2027-01-02', time: '13:00', soldOut: true }], time: '' });
  const single = '<li class="item sidebar_event_starts"><div class="label">Inicio del Evento</div><span> 8:30<span data-time="p. m.">p. m.</span></span></li><div class="event_showings"><div class="list clearfix"></div></div>';
  assert.deepEqual(parseTicketeraDetail(single, '2026-11-11'), { showings: [], time: '20:30' });
});

test('pageRoom names a venue page by the room most of its cards carry, and nothing for a mixed category page', () => {
  assert.equal(pageRoom([{ room: 'CBA Santurce' }, { room: 'CBA Santurce' }, { room: '' }]), 'CBA Santurce');
  assert.equal(pageRoom([{ room: 'Coliseo' }, { room: 'Bithorn' }, { room: 'Clemente' }, { room: 'Coliseo' }]), '');
  assert.equal(pageRoom([]), '');
});

const vevent = (summary, dtstart, extra = '') => `BEGIN:VEVENT\nUID:${Math.random()}\n${dtstart}\nSUMMARY:${summary}\n${extra}\nEND:VEVENT\n`;
test('a season calendar (Sidearm): UTC starts land on the city clock, rooms keep the home dates, rename tidies the title, the Tickets line is the link', () => {
  const ics = 'BEGIN:VCALENDAR\n' +
    vevent("[W] University of Alaska Anchorage Women's Volleyball vs Western Washington - Kids Free", 'DTSTART:20261106T040000Z', 'LOCATION:\\, Alaska Airlines Center\nDESCRIPTION:UAA vs WWU\\nTickets: https://aac-uaa.evenue.net/list/UAD\\n\nURL:https://goseawolves.com/calendar.aspx?game_id=1&amp;sport_id=9') +
    vevent("University of Alaska Anchorage Women's Volleyball at Central Washington", 'DTSTART:20261107T030000Z', 'LOCATION:Ellensburg\\, Wash.\nURL:https://goseawolves.com/calendar.aspx?game_id=2') +
    vevent("University of Alaska Anchorage Men's Basketball vs Biola", 'DTSTART;VALUE=DATE:20261128', 'LOCATION:Alaska Airlines Center (aux gym)\nURL:https://goseawolves.com/calendar.aspx?game_id=3&amp;sport_id=4') +
    'END:VCALENDAR\n';
  const out = mapIcsFile(ics, { tz: 'America/Anchorage', rooms: /alaska airlines center/i, type: 'sports', types: ['concert', 'sports'], today: '2026-10-15',
    rename: [[/^\[[A-Z]\]\s*/, ''], [/^University of Alaska Anchorage /, 'UAA ']] });
  assert.deepEqual(out, [
    { venue: ', Alaska Airlines Center', title: "UAA Women's Volleyball vs Western Washington - Kids Free", date: '2026-11-05', time: '19:00', url: 'https://aac-uaa.evenue.net/list/UAD', type: 'sports' },
    { venue: 'Alaska Airlines Center (aux gym)', title: "UAA Men's Basketball vs Biola", date: '2026-11-28', time: '', url: 'https://goseawolves.com/calendar.aspx?game_id=3&sport_id=4', type: 'sports' },
  ]);
});

test('a season calendar pinned to a room (PrestoSports): the sport prefix and the score go, past games are left out, a TZID start is read in its zone', () => {
  const ics = vevent('(Baseball) Alaska Goldpanners of Fairbanks at Anchorage Glacier Pilots (1-7)', 'DTSTART:20260602T020000Z', 'LOCATION:Mulcahy Stadium') +
    vevent('(Baseball) Mat-Su Miners at Anchorage Bucs', 'DTSTART:20270612T030000Z', 'LOCATION:Mulcahy Stadium') +
    vevent('(Baseball) Anchorage Bucs at Mat-Su Miners', 'DTSTART:20270613T030000Z', 'LOCATION:Hermon Brothers Field');
  const out = mapIcsFile(ics, { venue: 'Mulcahy Stadium', tz: 'America/Anchorage', rooms: /mulcahy/i, defaultType: 'sports', today: '2026-10-15', rename: [[/^\(Baseball\)\s*/, ''], [/\s*\(\d+-\d+\)\s*$/, '']] });
  assert.deepEqual(out, [{ venue: 'Mulcahy Stadium', title: 'Mat-Su Miners at Anchorage Bucs', date: '2027-06-11', time: '19:00', url: '', type: 'sports' }]);
  assert.deepEqual(icsStart({ value: '20261106T190000', params: { TZID: 'America/New_York' } }, 'America/Anchorage'), ['2026-11-06', '15:00']);
  assert.deepEqual(icsStart({ value: '20261106T190000', params: {} }, 'America/Anchorage'), ['2026-11-06', '19:00']);
  assert.deepEqual(icsStart({ value: '20261106', params: { VALUE: 'DATE' } }, 'America/Anchorage'), ['2026-11-06', '']);
});

test('eventLinks picks the ticket links of a listing page once each, absolute, without their tracking query', () => {
  const html = '<a href="https://www.eventbrite.com/e/parlor-in-the-round-tickets-1994714434570?aff=oddtdtcreator">Buy</a> <a href="/live-events">Learn</a>' +
    '<a href="https://www.eventbrite.com/e/parlor-in-the-round-tickets-1994714434570">Buy</a><a href="https://www.eventbrite.com/e/vitamin-comedy-tickets-1998453361802&amp;x=1">Buy</a>';
  assert.deepEqual(eventLinks(html, /eventbrite\.com\/e\//, 'https://www.beartoothak.com/live-events'),
    ['https://www.eventbrite.com/e/parlor-in-the-round-tickets-1994714434570', 'https://www.eventbrite.com/e/vitamin-comedy-tickets-1998453361802&x=1']);
});

test('a Squarespace collection: upcoming items on the site clock, the room pinned or taken from the entry, drop by title', () => {
  const data = { website: { timeZone: 'America/Los_Angeles' }, upcoming: [
    { startDate: Date.UTC(2026, 9, 21, 2, 30), title: 'Alex Dugdale &amp; Friends', fullUrl: '/events/alex-dugdale', location: { addressTitle: 'Seattle Jazz Fellowship' } },
    { startDate: Date.UTC(2026, 9, 22, 2, 0), title: 'Jam Session', fullUrl: '/events/jam' },
    { startDate: 'tbd', title: 'No date' },
  ] };
  assert.deepEqual(mapSquarespaceEvents(data, { venue: 'Seattle Jazz Fellowship', base: 'https://seattlejazzfellowship.org', drop: /jam session/i, type: 'concert' }), [
    { venue: 'Seattle Jazz Fellowship', title: 'Alex Dugdale & Friends', date: '2026-10-20', time: '19:30', url: 'https://seattlejazzfellowship.org/events/alex-dugdale', type: 'concert' },
  ]);
  assert.equal(mapSquarespaceEvents(data, { base: 'https://x.org' })[1].venue, 'feed'); // no room anywhere → the feed's label
});

test('cardDates reads one date with a clock, a day range as one row per day, and a month-crossing range', () => {
  assert.deepEqual(cardDates('October 15, 2026 | 10:00 AM - 2:00 PM'), [{ date: '2026-10-15', time: '10:00' }]);
  assert.deepEqual(cardDates('December 05-06, 2026 | 10:00 AM - 4:00 PM'), [{ date: '2026-12-05', time: '10:00' }, { date: '2026-12-06', time: '10:00' }]);
  assert.deepEqual(cardDates('October 31 - November 2, 2026').map((d) => d.date), ['2026-10-31', '2026-11-01', '2026-11-02']);
  assert.deepEqual(cardDates('November 1, 2026 | 7 PM'), [{ date: '2026-11-01', time: '19:00' }]);
  assert.deepEqual(cardDates('Every Thursday'), []);
  assert.deepEqual(cardDates('2026-11-14T19:30:00-08:00'), [{ date: '2026-11-14', time: '19:30' }]); // an ISO datetime's own clock (the Symphony's Tessitura page)
  assert.deepEqual(cardDates('2026-10-30 5:00 PM'), [{ date: '2026-10-30', time: '17:00' }]);
  assert.deepEqual(cardDates('October   29 , 2026   at  7:30 PM'), [{ date: '2026-10-29', time: '19:30' }]); // the year in its own span, tags stripped to spaces (Carbonhouse)
});

test('parseCards cuts a listing into cards and keeps the link, the name, the room and every date', () => {
  const html = `<div class="grid-item"><h3><a href="https://psq.org/our-events/flea/">Occidental Square Flea</a></h3>
      <p><strong>December 05-06, 2026 | 10:00 AM - 4:00 PM</strong></p><p>Occidental Square</p></div>
    <div class="grid-item"><h3><a href="/our-events/craft/">Craft Club &amp; Brunch</a></h3><p><strong>October 18, 2026 | 1:00 PM - 4:00 PM</strong></p><p>Asylum Collective</p></div>
    <div class="grid-item"><h3><a href="/x">No date card</a></h3></div>`;
  const out = parseCards(html, { item: /<div class="grid-item">/, title: /<h3><a href="([^"]+)">([^<]+)<\/a>/, when: /<strong>([^<]+)<\/strong>/, place: /<\/strong><\/p>\s*<p>([^<]*)<\/p>/, type: 'community', base: 'https://pioneersquare.org/events/' });
  assert.deepEqual(out, [
    { venue: 'Occidental Square', title: 'Occidental Square Flea', date: '2026-12-05', time: '10:00', url: 'https://psq.org/our-events/flea/', type: 'community' },
    { venue: 'Occidental Square', title: 'Occidental Square Flea', date: '2026-12-06', time: '10:00', url: 'https://psq.org/our-events/flea/', type: 'community' },
    { venue: 'Asylum Collective', title: 'Craft Club & Brunch', date: '2026-10-18', time: '13:00', url: 'https://pioneersquare.org/our-events/craft/', type: 'community' },
  ]);
});

test('cardDates with no year printed takes the nearest year forward, day-first too, and a clock from a second group', () => {
  const today = new Date('2026-10-15T12:00:00Z');
  assert.deepEqual(cardDates('15 Oct 7:00 pm', today), [{ date: '2026-10-15', time: '19:00' }]);
  assert.deepEqual(cardDates('3 Jan 8:00 pm', today), [{ date: '2027-01-03', time: '20:00' }]);
  assert.deepEqual(cardDates('Oct 1', today), [{ date: '2026-10-01', time: '' }]); // last fortnight's row, this year still
  assert.deepEqual(cardDates('Aug 20', today), [{ date: '2027-08-20', time: '' }]);
  const html = '<article class="mec-event-article"><h3 class="mec-event-title"><a href="https://c.com/events/x/">Ska Island</a></h3><span class="mec-start-date-label">17 Oct</span> … <span class="mec-start-time">7:00 pm</span></article>';
  const out = parseCards(html, { item: /<article class="mec-event-article"/, title: /class="mec-event-title"><a[^>]*href="([^"]+)"[^>]*>([^<]+)</, when: /mec-start-date-label">([^<]+)<\/span>[\s\S]{0,800}?mec-start-time">([^<]+)</, venue: 'Central Saloon' });
  assert.equal(out.length, 1); assert.equal(out[0].time, '19:00'); assert.equal(out[0].venue, 'Central Saloon'); assert.equal(out[0].title, 'Ska Island');
});

test('parseCards takes a default clock for listings that print none', () => {
  const html = '<div class="grid-item"><h3><a href="/art-walks/nov/">November First Thursday Art Walk: 11/5</a></h3><p><strong>November 05, 2026</strong></p></div>';
  const out = parseCards(html, { item: /<div class="grid-item"/, title: /<h3><a href="([^"]+)">([^<]+)<\/a>/, when: /<strong>([^<]+)<\/strong>/, type: 'arts', base: 'https://pioneersquare.org/art-walks/', time: '17:00' });
  assert.deepEqual(out, [{ venue: '', title: 'November First Thursday Art Walk: 11/5', date: '2026-11-05', time: '17:00', url: 'https://pioneersquare.org/art-walks/nov/', type: 'arts' }]);
});

test('mapNpsEvents: one row per date at the first start time, the park pinned, all-day when flagged', () => {
  const data = { data: [
    { eventid: 'A1', title: 'Living Voices: Native Vision', dates: ['2026-11-07', '2026-11-08'], times: [{ timestart: '01:00 PM', timeend: '01:45 PM' }, { timestart: '02:00 PM' }], location: '', infourl: '', isallday: 'false' },
    { eventid: 'B2', title: 'Junior Ranger Day', dates: ['2026-12-05'], times: [], location: 'Cadillac Hotel', infourl: 'https://www.nps.gov/klse/x.htm', isallday: 'true' },
  ] };
  assert.deepEqual(mapNpsEvents(data, { venue: 'Klondike Gold Rush NHP', type: 'community' }), [
    { venue: 'Klondike Gold Rush NHP', title: 'Living Voices: Native Vision', date: '2026-11-07', time: '13:00', url: 'https://www.nps.gov/planyourvisit/event-details.htm?id=A1', type: 'community' },
    { venue: 'Klondike Gold Rush NHP', title: 'Living Voices: Native Vision', date: '2026-11-08', time: '13:00', url: 'https://www.nps.gov/planyourvisit/event-details.htm?id=A1', type: 'community' },
    { venue: 'Klondike Gold Rush NHP', title: 'Junior Ranger Day', date: '2026-12-05', time: '', url: 'https://www.nps.gov/klse/x.htm', type: 'community' },
  ]);
});

test('cardClock: a range start without a meridiem borrows the end\'s, flipped when it would follow the end', () => {
  assert.equal(cardClock('5:30‑7 pm'), '17:30');
  assert.equal(cardClock('10 am‑12 pm'), '10:00');
  assert.equal(cardClock('10‑12 pm'), '10:00');
  assert.equal(cardClock('12–8 pm'), '12:00');
  assert.equal(cardClock('11–1 pm'), '11:00');
  assert.equal(cardClock('Doors 7:00 PM'), '19:00');
  assert.equal(cardClock('all day'), '');
  assert.deepEqual(cardDates('Thursday Oct 29 5:30‑7 pm', new Date('2026-10-15')), [{ date: '2026-10-29', time: '17:30' }]);
});

test('parseCards strips tags inside a title and a date (Waterfront Park\'s no-widow spans)', () => {
  const html = '<div class="grid-item" data-id="1"><a href="https://waterfrontparkseattle.org/blog/event/x/?date=202611031000"><div class="inner-wrap"><h3 class="widont ">Tuesday Nov 3,<span class="nbsp">&nbsp;</span>2026</h3><h3 class="widont date-time">10 am‑12 pm</h3><h4 class="widont ">Secrets of Seattle&#8217;s Shoreline Walking<span class="nbsp">&nbsp;</span>Tour</h4></div></a></div>';
  const out = parseCards(html, { item: /<div class="grid-item"/, title: /<a href="([^"]+)">[\s\S]*?<h4 class="widont ">([\s\S]*?)<\/h4>/, when: /<h3 class="widont ">([\s\S]*?)<\/h3><h3 class="widont date-time">([^<]*)<\/h3>/, venue: 'Waterfront Park', type: 'community' });
  assert.deepEqual(out, [{ venue: 'Waterfront Park', title: 'Secrets of Seattle’s Shoreline Walking Tour', date: '2026-11-03', time: '10:00', url: 'https://waterfrontparkseattle.org/blog/event/x/?date=202611031000', type: 'community' }]);
});

test('mapLocalistEvents: one row per instance on the campus clock, the ticket link first, the type from the event_types filter (Arts & Culture outranks Music in the shared bank)', () => {
  const data = { events: [{ event: { title: 'UO Symphony Orchestra', localist_url: 'https://calendar.uoregon.edu/event/uo-symphony-orchestra-1019', ticket_url: 'https://ticket.uoregon.edu/somd27/10578', location_name: 'Beall Concert Hall',
    filters: { event_types: [{ name: 'Arts & Culture' }, { name: 'Music' }, { name: 'Concert' }] },
    event_instances: [{ event_instance: { start: '2026-10-20T19:30:00-07:00', all_day: false } }, { event_instance: { start: '2026-10-21T00:00:00-07:00', all_day: true } }] } },
    { event: { title: 'Box Office Hours', location_name: 'Beall Concert Hall', event_instances: [{ event_instance: { start: '2026-10-22T10:00:00-07:00' } }] } }] };
  assert.deepEqual(mapLocalistEvents(data, { types: ['concert', 'arts'], drop: /box office/i }), [
    { venue: 'Beall Concert Hall', title: 'UO Symphony Orchestra', date: '2026-10-20', time: '19:30', url: 'https://ticket.uoregon.edu/somd27/10578', type: 'arts' },
    { venue: 'Beall Concert Hall', title: 'UO Symphony Orchestra', date: '2026-10-21', time: '', url: 'https://ticket.uoregon.edu/somd27/10578', type: 'arts' },
  ]);
  assert.deepEqual(mapLocalistEvents(data, { venue: 'Beall Concert Hall', type: 'arts', types: ['arts'] }).map((e) => [e.venue, e.type, e.title]), [['Beall Concert Hall', 'arts', 'UO Symphony Orchestra'], ['Beall Concert Hall', 'arts', 'UO Symphony Orchestra'], ['Beall Concert Hall', 'arts', 'Box Office Hours']]);
});

test('parseLudus: one row per upcoming showtime, the show page as the link, the sold-out class → soldOut (the span is in every row), past rows skipped', () => {
  const show = (title, id, times) => `<div class="show_item" data-show-id="${id}"><h2 class="show_item_title"><span class="patron_heading_label">\n ${title} </span></h2>
    <a href="show_page.php?show_id=${id}"><div class="show_about_button learn_more_button">Learn More</div></a>${times}</div>`;
  const when = (d, t, past = 0, sold = false) => `<div class="showtimes_item ${sold ? 'sold-out' : ''}" id="x" data-past-date="${past}" data-manual-soldout="0"><div class="admin_showtimes_item_title"><div class="desktop_copy"><span class="span_link" >\n ${d} <span style="color:#777777;">\n &nbsp; ${t} </span></span></div></div>
    <div class="showtimes_item_get_tickets_button">Get Tickets</div><div class="red_span sold_out_span"><i class="fa"></i> Sold Out </div></div>`;
  const html = show('Night of the Living Dead Live', 200529348, when('Saturday, October 17, 2026', '7:30 PM', 1) + when('Sunday, October 18, 2026', '2:00 PM', 0, true) + when('Friday, October 23, 2026', '7:30 PM'))
    + show('Auditions: Spring Show', 1, when('Monday, November 2, 2026', '6:00 PM'));
  assert.deepEqual(parseLudus(html, { venue: 'Very Little Theatre', base: 'https://thevlt.ludus.com/index.php', type: 'arts', types: ['arts'], drop: /^auditions/i }), [
    { venue: 'Very Little Theatre', title: 'Night of the Living Dead Live', date: '2026-10-18', time: '14:00', url: 'https://thevlt.ludus.com/show_page.php?show_id=200529348', type: 'arts', soldOut: true },
    { venue: 'Very Little Theatre', title: 'Night of the Living Dead Live', date: '2026-10-23', time: '19:30', url: 'https://thevlt.ludus.com/show_page.php?show_id=200529348', type: 'arts' },
  ]);
});

test('parseBoldtypeList: each Browse row → id, show link, title and room; a festival subsite row without a show link is skipped', () => {
  const html = `<table><tbody>
    <tr class="item"><td class="eventTitle"><a href="https://www.strangertickets.com/events/188000001/half-giraffe-ep-release" target="_parent"><img class="eventImg" src="/imager/x.jpg"></a>
      <a href="https://www.strangertickets.com/events/188000001/half-giraffe-ep-release" class="title" target="_parent">
        Half Giraffe EP release<br></a></td>
      <td class="eventTime">Sat, Oct 24 at 8:30pm</td>
      <td class="eventLocation"><a href="/Browse#venue=1-royal-room" target="_parent">Royal Room<br></a> Seattle, WA</td>
      <td class="availability"><a class="btn">Buy Tickets</a></td></tr>
    <tr class="item"><td class="eventTitle"><a href="https://lachocolatefest.strangertickets.com" target="_parent">LA Chocolate Fest</a></td></tr>
    <tr class="item"><td class="eventTitle"><a href="https://www.strangertickets.com/events/188000002/rock-n-roll" class="title" target="_parent">Rock &amp; Roll Night<br></a></td>
      <td class="eventLocation">The Royal Room Seattle, WA</td></tr>
  </tbody></table>`;
  assert.deepEqual(parseBoldtypeList(html), [
    { id: '188000001', url: 'https://www.strangertickets.com/events/188000001/half-giraffe-ep-release', title: 'Half Giraffe EP release', place: 'Royal Room Seattle, WA', room: 'Royal Room' },
    { id: '188000002', url: 'https://www.strangertickets.com/events/188000002/rock-n-roll', title: 'Rock & Roll Night', place: 'The Royal Room Seattle, WA', room: '' },
  ]);
});

test('a Spektrix instance becomes a performance on the theatre clock; cancelled, hidden, dropped and past ones are left out', () => {
  const events = [
    { id: '3201AQVH', name: 'Angel Street (Gaslight) ' },
    { id: '6601AQMN', name: 'Fall 2026 Acting Class' },
    { id: '8201APNK', name: 'Bedroom Farce', attribute_SLExcludeFromViewEventsPage: true },
  ];
  const instances = [
    { id: 'i1', event: { id: '3201AQVH' }, start: '2026-10-21T19:30:00', cancelled: false },
    { id: 'i2', event: { id: '3201AQVH' }, start: '2026-10-25T14:00:00', cancelled: true },
    { id: 'i3', event: { id: '6601AQMN' }, start: '2026-10-22T09:00:00' },
    { id: 'i4', event: { id: '8201APNK' }, start: '2027-05-07T19:30:00' },
    { id: 'i5', event: { id: '3201AQVH' }, start: '2026-10-01T19:30:00' },
  ];
  const evs = mapSpektrix(events, instances, { venue: 'Pentacle Theatre', link: 'https://purchase.example.org/EventAvailability?EventId={id}', drop: /class/i, type: 'arts', types: ['arts'], today: '2026-10-20' });
  assert.deepEqual(evs, [{ venue: 'Pentacle Theatre', title: 'Angel Street (Gaslight)', date: '2026-10-21', time: '19:30', url: 'https://purchase.example.org/EventAvailability?EventId=3201', instance: 'i1', type: 'arts' }]);
});

// ---- Modern Events Calendar list pages (STG, 2026-10-26) ----
const MEC_PAGE = `<div class="mec-wrap mec-skin-list-container  " id="mec_skin_mec1">
<article class="mec-event-article mec-clear mec-divider-toggle mec-toggle-202610-mec1"><div class="mec-event-content"><h3 class="mec-event-title"><a class="mec-color-hover" data-event-id="69810" href="https://www.stgpresents.org/events/dermot-kennedy/" target="_self" rel="noopener">Dermot Kennedy POSTPONED</a><span class="event-color"></span></h3></div>
<div class="mec-date-details"> <span class="mec-event-d"><i class="mec-sl-calendar"></i><span class="mec-start-date-label">Oct 26</span></span></div><div class="mec-time-details"><svg></svg><span class="mec-start-time">7:30 PM</span></div><div class="mec-venue-details"> <svg></svg><span>The Paramount Theatre</span></div></article>
<article class="mec-event-article mec-clear"><h3 class="mec-event-title"><a class="mec-color-hover" href="https://www.stgpresents.org/events/skillet/">Skillet</a></h3><span class="mec-start-date-label">Oct 27</span><span class="mec-start-time">7:00 PM</span><div class="mec-venue-details"><svg></svg><span>The Moore Theatre</span></div></article>
<article class="mec-past-event mec-event-article  mec-clear"><h3 class="mec-event-title"><a class="mec-color-hover" href="https://www.stgpresents.org/events/eric-idle/">An Evening with Eric Idle: Idle in Provence &#8211; CANCELED</a></h3><span class="mec-start-date-label">Oct 29 2026</span><div class="mec-venue-details"><svg></svg><span>The Paramount Theatre</span></div></article>
</div>
<script> jQuery(document).ready(function() { jQuery("#mec_skin_mec1").mecListView( { id: "mec1", start_date: "2026-10-26", end_date: "2026-10-28", offset: "4", limit: "12", pagination: "loadmore", atts: "atts%5Bcategory%5D=234%2C20&atts%5Bid%5D=12133&atts%5Binstance_id%5D=mec1", ajax_url: "https://www.stgpresents.org/wp-admin/admin-ajax.php", sed_method: "0", sf: { container: "", reset: 0, refine: 1, }, }); }); </script>`;

test('parseMecInit reads the list skin\'s load-more parameters off the page', () => {
  assert.deepEqual(parseMecInit(MEC_PAGE), { id: 'mec1', startDate: '2026-10-26', endDate: '2026-10-28', offset: 4, limit: 12, atts: 'atts%5Bcategory%5D=234%2C20&atts%5Bid%5D=12133&atts%5Binstance_id%5D=mec1', ajaxUrl: 'https://www.stgpresents.org/wp-admin/admin-ajax.php' });
  assert.equal(parseMecInit('<html>no calendar</html>'), null);
});

test('parseMecCards: title + link, a yearless or dated label, the clock, the venue; CANCELED / POSTPONED suffixes become the status', () => {
  const today = new Date('2026-10-26T12:00:00Z');
  assert.deepEqual(parseMecCards(MEC_PAGE, today), [
    { title: 'Dermot Kennedy', url: 'https://www.stgpresents.org/events/dermot-kennedy/', date: '2026-10-26', time: '19:30', place: 'The Paramount Theatre', status: 'postponed' },
    { title: 'Skillet', url: 'https://www.stgpresents.org/events/skillet/', date: '2026-10-27', time: '19:00', place: 'The Moore Theatre' },
    { title: 'An Evening with Eric Idle: Idle in Provence', url: 'https://www.stgpresents.org/events/eric-idle/', date: '2026-10-29', time: '', place: 'The Paramount Theatre', status: 'cancelled' },
  ]);
});

test('parseCards `venues` keeps only the cards whose place matches (Lumen Field\'s calendar lists the WAMU Theater too)', () => {
  const html = `<div role="listitem" class="db-ft-events-item w-dyn-item"><a href="/events/boo-seattle" class="ft-card w-inline-block"><div fs-cmssort-field="date, year" class="filter-item-hidden">2026-10-30</div><div fs-cmsfilter-field="event-venue" class="filter-item-hidden">WAMU Theater</div><div class="ft-card-time">5:00 PM</div><h3 class="card-title-h3">BOO Seattle</h3></a></div>
<div role="listitem" class="db-ft-events-item w-dyn-item"><a href="/events/zach-bryan-2027" class="ft-card w-inline-block"><div fs-cmssort-field="date, year" class="filter-item-hidden">2027-05-22</div><div fs-cmsfilter-field="event-venue" class="filter-item-hidden">Lumen Field</div><div class="ft-card-time">7:00 PM</div><h3 class="card-title-h3">Zach Bryan</h3></a></div>`;
  const opts = { item: /<div role="listitem" class="db-ft-events-item w-dyn-item">/, title: /<a href="([^"]+)" class="ft-card[\s\S]*?<h3 class="card-title-h3">([^<]+)</, when: /fs-cmssort-field="date, year" class="filter-item-hidden">(\d{4}-\d{2}-\d{2})<[\s\S]*?(?:ft-card-time">([^<]*)<|card-title-h3)/, place: /fs-cmsfilter-field="event-venue" class="filter-item-hidden">([^<]+)</, base: 'https://www.lumenfield.com/' };
  const all = parseCards(html, opts);
  assert.equal(all.length, 2);
  assert.deepEqual(parseCards(html, { ...opts, venues: /lumen field/i, venue: 'Lumen Field' }), [{ venue: 'Lumen Field', title: 'Zach Bryan', date: '2027-05-22', time: '19:00', url: 'https://www.lumenfield.com/events/zach-bryan-2027' }]);
});

test('mapSquarespaceEvents `venues` keeps only the items at the place wanted (Bayfront Park\'s trust lists Maurice A. Ferré Park too)', () => {
  const data = { website: { timeZone: 'America/New_York' }, upcoming: [
    { startDate: Date.UTC(2026, 9, 29, 23, 0), title: 'Man Alive', fullUrl: '/events/man-alive', location: { addressTitle: 'FPL Amphitheater' } },
    { startDate: Date.UTC(2026, 10, 14, 13, 0), title: 'Give Miami 5K', fullUrl: '/events/give-miami-5k', location: { addressTitle: 'Maurice A. Ferré Park' } },
  ] };
  assert.deepEqual(mapSquarespaceEvents(data, { venue: 'FPL Solar Amphitheater', base: 'https://www.bayfrontparkmiami.com', venues: /fpl|bayfront park/i }).map((e) => e.title), ['Man Alive']);
  assert.equal(mapSquarespaceEvents(data, { venue: 'FPL Solar Amphitheater', base: 'https://www.bayfrontparkmiami.com' }).length, 2);
});

test('parseRssEvents (carbonhouse /events/rss): the UTC start on the city clock, the venue kept or pinned, the type from ev:type, drop, past items and other venues left out', () => {
  const xml = `<rss><channel><item><title>Young Miko</title><link>https://www.kaseyacenter.com/events/detail/young-miko</link><ev:location>Kaseya Center</ev:location><ev:startdate>2026-10-29T00:00:00Z</ev:startdate><ev:type>Concerts</ev:type></item>
<item><title>Kaseya Center All&#45;Access Tour</title><link>https://www.kaseyacenter.com/events/detail/tour</link><ev:location>Kaseya Center</ev:location><ev:startdate>2026-11-01T19:00:00Z</ev:startdate><ev:type>All-Access Tours</ev:type></item>
<item><title>The Carpenters Songbook</title><link>https://www.browardcenter.org/events/detail/carpenters</link><ev:location>The Parker</ev:location><ev:startdate>2026-10-28T23:30:00Z</ev:startdate><ev:type>Music</ev:type></item>
<item><title>Last Spring</title><link>https://www.kaseyacenter.com/events/detail/old</link><ev:location>Kaseya Center</ev:location><ev:startdate>2026-03-01T01:00:00Z</ev:startdate></item>
<item><title>No date</title><link>https://www.kaseyacenter.com/events/detail/nodate</link></item></channel></rss>`;
  const opts = { tz: 'America/New_York', types: ['concert', 'sports', 'arts', 'community'], defaultType: 'sports', today: '2026-10-27', drop: /all-access tour/i };
  assert.deepEqual(parseRssEvents(xml, opts), [
    { venue: 'Kaseya Center', title: 'Young Miko', date: '2026-10-28', time: '20:00', url: 'https://www.kaseyacenter.com/events/detail/young-miko', type: 'concert' },
    { venue: 'The Parker', title: 'The Carpenters Songbook', date: '2026-10-28', time: '19:30', url: 'https://www.browardcenter.org/events/detail/carpenters', type: 'concert' },
  ]);
  assert.deepEqual(parseRssEvents(xml, { ...opts, venue: 'Kaseya Center', venues: /kaseya/i }).map((e) => `${e.venue}|${e.title}`), ['Kaseya Center|Young Miko']);
});

test('parseRssEvents: an XML &apos; in a title becomes an apostrophe', () => {
  const xml = `<rss><channel><item><title>Disney&apos;s Beauty and the Beast</title><link>https://x/y</link><ev:location>The Broward Center</ev:location><ev:startdate>2027-04-06T23:30:00Z</ev:startdate></item></channel></rss>`;
  const [ev] = parseRssEvents(xml, { venue: 'Broward Center', tz: 'America/New_York', today: '2026-10-27' });
  assert.equal(ev.title, "Disney's Beauty and the Beast"); assert.equal(ev.time, '19:30');
  const em = parseRssEvents(xml.replace('Disney&apos;s Beauty and the Beast', 'Handel&apos;s &lt;em&gt;Messiah&lt;/em&gt;'), { venue: 'Broward Center', tz: 'America/New_York', today: '2026-10-27' });
  assert.equal(em[0].title, "Handel's Messiah"); // markup inside a title is dropped
  const gone = parseRssEvents(xml.replace('Disney&apos;s', 'Cancelled: Disney&apos;s'), { venue: 'Broward Center', tz: 'America/New_York', today: '2026-10-27' });
  assert.equal(gone.length, 0);
});

test('feedSources: a leading venue calendar that failed is marked for the safety net; a secondary one, or one whose site answered, is not', async () => {
  const realFetch = globalThis.fetch, K = Symbol.for('here.events/failedHost'), realCheck = globalThis[K];
  globalThis.fetch = async () => ({ ok: false, status: 406, text: async () => '' });
  globalThis[K] = (host) => host === 'www.a.org'; // the call log: only a.org failed after its retries
  const err = console.error; console.error = () => {};
  try {
    const feed = (url, more = {}) => ({ type: 'concert', feed: { kind: 'rss', url, ...more } });
    const city = { types: [], venues: { A: feed('https://www.a.org/events/rss'), B: feed('https://www.b.org/events/rss'), C: feed('https://www.a.org/other', { secondary: true }) } };
    feedFailedVenues.clear();
    for (const t of feedSources(city, 'ua')) assert.deepEqual(await t(), []);
    assert.deepEqual([...feedFailedVenues], ['A']);
  } finally { globalThis.fetch = realFetch; globalThis[K] = realCheck; console.error = err; feedFailedVenues.clear(); }
});
