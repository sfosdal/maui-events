// The city — every fact that makes this calendar Maui's rather than
// another island's, in one place (2026-10-25: built on the Hilo site's
// pattern as an island-wide site — Maui, Lānaʻi and Molokaʻi are one county). The browser (filter.js, app.js) and the build (scripts/*.mjs)
// both read it; nothing else names a venue or a team. The shared files
// (app.js, filter.js, styles.css bar its --v-* hues, scripts/*.mjs bar
// fetch-events.mjs and sources.mjs) are lqa-events' own, byte for byte —
// see README "Sister sites".
//
// Loaded before filter.js (a plain script, so the tests can share it): it
// sets globalThis.LQACity (the name is the shared code's, not the city's).
(function (global) {
  'use strict';

  // The home teams, matched on the event title whatever the venue. Order =
  // the Teams strip, left to right. Maui has no club of its own in a league
  // feed (the Southwest Maui Invitational, three days at the Lahaina Civic
  // Center every November, is a venue row below). These are the state's
  // programs — the University of Hawaiʻi at Mānoa, a hundred miles away on
  // Oʻahu — as a Teams-view-only list, as on the Kona and Hilo sites: their
  // grounds are not venues here and there is no `inject`. Per team:
  //   re        the title match; venue the home building; sport keys the
  //             strip icon and the game clock; colors [primary, accent];
  //   espn      ESPN's sport/league/team id — the university is id 62 in
  //             every college league, so the season, the form block and news
  //             all come from there (schedules.mjs)
  //   club      the program's name on Ticketmaster; wiki the article; opens
  //             when the season usually starts
  var UH_LOGO = 'https://a.espncdn.com/i/teamlogos/ncaa/500/62.png';
  var TEAMS = [
    { slug: 'football', label: 'Warriors Football', name: 'Hawaii Rainbow Warriors', abbr: 'HAW', re: /rainbow warriors football|hawai.i (rainbow warriors )?football/i, sport: 'football', venue: 'Ching Athletics Complex', colors: ['#024731', '#a7a9ac'],
      espn: { sport: 'football', league: 'college-football', id: '62' }, season: { kind: 'espn' }, form: { kind: 'espn' },
      logo: UH_LOGO, schedule: 'https://hawaiiathletics.com/sports/football/schedule',
      club: 'Hawaii Rainbow Warriors Football', opens: 'late August', wiki: { title: 'Hawaii Rainbow Warriors football', startYear: true } },
    { slug: 'basketball', label: 'Warriors Basketball', name: 'Hawaii Rainbow Warriors', abbr: 'HAW', re: /rainbow warriors men'?s basketball|rainbow warriors basketball/i, sport: 'basketball', venue: 'Stan Sheriff Center', colors: ['#024731', '#000000'],
      espn: { sport: 'basketball', league: 'mens-college-basketball', id: '62' }, season: { kind: 'espn' }, form: { kind: 'espn' },
      logo: UH_LOGO, schedule: 'https://hawaiiathletics.com/sports/mens-basketball/schedule',
      club: 'Hawaii Rainbow Warriors Mens Basketball', opens: 'early November', wiki: { title: "Hawaii Rainbow Warriors men's basketball", startYear: true } },
    { slug: 'volleyball', label: 'Wahine Volleyball', name: 'Hawaii Rainbow Wahine', abbr: 'HAW', re: /women'?s volleyball|rainbow wahine volleyball/i, sport: 'volleyball', venue: 'Stan Sheriff Center', colors: ['#024731', '#ffffff'],
      espn: { sport: 'volleyball', league: 'womens-college-volleyball', id: '62' }, season: { kind: 'espn' }, form: { kind: 'espn' },
      logo: UH_LOGO, schedule: 'https://hawaiiathletics.com/sports/womens-volleyball/schedule',
      club: 'Hawaii Rainbow Warriors Womens Volleyball', opens: 'late August', wiki: { title: 'Hawaii Rainbow Wahine volleyball', startYear: true } },
  ];

  // The venues, one record each, by size. Per venue:
  //   capacity how many people the place holds
  //   area     absent = Central Maui (Kahului and Wailuku, the county seat
  //            and the airport town); 'town' = everywhere else — Kīhei,
  //            Wailea and Māʻalaea on the south shore, Lahaina to the west,
  //            Makawao and Haleakalā Upcountry, Lānaʻi City across the channel
  //   type     the event type when the title decides nothing
  //   cssVar   the hue styles.css sets for it (dark block --v-*); color
  //            the same hue as a value, for the series graph
  //   url      the venue's own events listing — not a ticket vendor
  //   icon     a mark for listings without a team crest
  //   tm       its Ticketmaster Discovery listing (fetch-events.mjs reads
  //            the venue by id — every page; several ids comma-joined read as
  //            one). exclude drops the parking, suites, tours and bundles;
  //            secondary: true makes the listing a second source behind the
  //            room's own calendar (the Eugene pattern)
  //   alias    the other spellings the feeds use for it, folded to this name
  //   feed     the room's own calendar, read by scripts/feeds.mjs; the
  //            MACC's "Load More" pages and Da Playground's ticket shop are
  //            parsed in fetch-events.mjs
  //   festival a festival's days are one series (the shared filter puts the
  //            room in the panel's Festivals group)
  // Scouted and left out (README "Sources scouted"): Seabury Hall's and
  // the Maui Academy of Performing Arts' Ludus box offices (Ludus answers 403
  // to GitHub's runners — the Eugene and Kona lesson), the Shops at Wailea
  // and Whalers Village (no listings that read), the Maui Ocean Center (one
  // Fins & Frights night a year, which the Whale Foundation's listing
  // carries), UH Maui College (a Sidearm site without a venue calendar), the
  // county's events RSS (meetings), Molokaʻi (no venue publishes a calendar),
  // and the hand-dated festivals — the Maui County Fair, the Ukulele
  // Festival, the Kapalua Wine & Food Festival (nothing is entered by hand).
  var TM_EXCLUDE = /season tickets?|parking|suite|\btours?\b|ticket packages?|vip (upgrade|package|tailgate)|club (level|seating)|^half price:|\b\d+[- ]day pass|grounds pass|all[- ]session|mini[- ]plan|lawn chair|cabana/i;
  var VENUES = { // geo: [lat, lon] puts the room on the Map view (site/local-map.js); Nominatim once at build time (2026-10-25), four placed by hand
    // --- Central Maui: Kahului and Wailuku ---
    'Maui Arts & Cultural Center': { // the MACC in Kahului — Castle Theater (1,200), the McCoy Studio Theater and the A&B Amphitheater lawn: the island's touring shows, Maui Pops, HIFF Maui, the Made in Maui County Festival; its own listing (fetch-events.mjs parseMacc: the "Load More" pages), Ticketmaster second (it lists two Mulaney rows)
      geo: [20.8927, -156.4804],
      capacity: 5000,
      type: 'arts',
      cssVar: '--v-macc',
      color: '#ea8686',
      url: 'https://mauiarts.org/events',
      icon: 'https://www.google.com/s2/favicons?domain=mauiarts.org&sz=128',
      tm: { id: 'KovZpZA1aEAA', match: '', fallbackUrl: 'https://mauiarts.org/events', exclude: TM_EXCLUDE, secondary: true },
      alias: /maui arts|\bmacc\b|castle theater|mccoy studio|a&b amphitheater/i,
    },
    'ʻĪao Theater': { // Maui OnStage's 1928 house on Market Street, Wailuku, 350 seats — its own shows and the rentals, as text cards on the company's home page, parsed in fetch-events.mjs parseIao (no clocks printed); Ticketmaster second
      geo: [20.88929, -156.50227],
      capacity: 350,
      type: 'arts',
      cssVar: '--v-iao',
      color: '#eac086',
      url: 'https://www.mauionstage.com/',
      icon: 'https://www.google.com/s2/favicons?domain=www.mauionstage.com&sz=128',
      tm: { id: 'KovZ917AVGO', match: '', fallbackUrl: 'https://www.mauionstage.com/', exclude: TM_EXCLUDE, secondary: true },
      alias: /iao theater|maui onstage/i,
    },
    'Hale Hōʻikeʻike': { // the Maui Historical Society's museum at the Bailey House, Wailuku — talks, the Lei Day Heritage Festival, workshops (its public Google Calendar)
      geo: [20.88604, -156.50788],
      capacity: 200,
      type: 'community',
      cssVar: '--v-bailey',
      color: '#e1ea86',
      url: 'https://mauimuseum.org/events',
      icon: 'https://www.google.com/s2/favicons?domain=mauimuseum.org&sz=128',
      feed: { kind: 'icsfile', url: 'https://calendar.google.com/calendar/ical/c_1fc5647f076988d8a12b088af23ee31a9be3fba581a6cac2b4652568ddf94b83@group.calendar.google.com/public/basic.ics', drop: /museum closed|\bclosed\b|birthday|\bholiday\b/i },
      alias: /hale h[oō].?ike.?ike|bailey house|maui historical/i,
    },
    // --- South and West Maui, Upcountry and Lānaʻi (`area: 'town'`) ---
    'ProArts Playhouse': { // the 70-seat black box at the Azeka Shopping Center, Kīhei — comedy nights, plays, John Cruz's Island Style series (The Events Calendar REST)
      area: 'town',
      geo: [20.74933, -156.45697],
      capacity: 70,
      type: 'arts',
      cssVar: '--v-proarts',
      color: '#b8ea86',
      url: 'https://proartsmaui.org/events/',
      icon: 'https://www.google.com/s2/favicons?domain=proartsmaui.org&sz=128',
      feed: { kind: 'tribe', url: 'https://proartsmaui.org/wp-json/tribe/events/v1/events', maxRepeat: 30 },
      alias: /proarts/i,
    },
    'Mulligans on the Blue': { // the pub at the Wailea Blue course — live music, comedy, the Celtic Tigers (The Events Calendar REST)
      area: 'town',
      geo: [20.6898, -156.4393],
      capacity: 200,
      type: 'concert',
      cssVar: '--v-mulligans',
      color: '#86ea86',
      url: 'https://mulligansontheblue.com/events/',
      icon: 'https://www.google.com/s2/favicons?domain=mulligansontheblue.com&sz=128',
      feed: { kind: 'tribe', url: 'https://mulligansontheblue.com/wp-json/tribe/events/v1/events', maxRepeat: 30 },
      alias: /mulligans/i,
    },
    'Da Playground': { // the 500-cap club at Māʻalaea Harbor — reggae tours, DJ nights (its Shopify ticket shop, fetch-events.mjs parseDaPlayground: the cards' dates, the products' sold-out flags)
      area: 'town',
      geo: [20.7905, -156.5125],
      capacity: 500,
      type: 'concert',
      cssVar: '--v-playground',
      color: '#86eadc',
      url: 'https://www.daplaygroundmaui.com/collections/tickets',
      icon: 'https://www.google.com/s2/favicons?domain=www.daplaygroundmaui.com&sz=128',
      alias: /da playground/i,
    },
    'Pacific Whale Foundation': { // the foundation's Māʻalaea harbor shops — volunteer days, talks, the World Whale Day parade and festival in February (its listing's cards; Fins & Frights lands at the Ocean Center next door)
      area: 'town',
      geo: [20.79278, -156.51188],
      capacity: 2000,
      type: 'community',
      cssVar: '--v-pwf',
      color: '#86c0ea',
      url: 'https://pacificwhale.org/how-you-can-help/events/',
      icon: 'https://www.google.com/s2/favicons?domain=pacificwhale.org&sz=128',
      feed: { kind: 'cards', url: 'https://pacificwhale.org/how-you-can-help/events/', item: '<article class="list-item list-item--event', title: /<a href="([^"]+)" class="list-item__link">[\s\S]*?<h1 class="list-item__title[^"]*">\s*([^<]+?)\s*<\/h1>/, when: /<time>([^<]+)<\/time>/, drop: /webinar|\bvolunteer/i },
      alias: /pacific whale|maui whale festival|world whale day/i,
    },
    'Lahaina Civic Center': { // the county's 2,400-seat gym above Lahaina — the Southwest Maui Invitational's three November days (its site's schema.org listing), whatever Ticketmaster lists
      area: 'town',
      geo: [20.9044, -156.68367],
      capacity: 2400,
      type: 'sports',
      cssVar: '--v-civic',
      color: '#86a4ea',
      url: 'https://mauiinvitational.com/',
      icon: 'https://www.google.com/s2/favicons?domain=mauiinvitational.com&sz=128',
      tm: { id: 'Za5ju3rKuqZDenu1kVogavqyiltejGA787', match: '', fallbackUrl: 'https://mauiinvitational.com/', exclude: TM_EXCLUDE },
      feed: { kind: 'jsonld', url: 'https://mauiinvitational.com/' },
      alias: /lahaina civic/i,
    },
    'Lahaina Cannery Mall': { // the mall's free hula shows, keiki days and watch parties — the only West Maui calendar that reads (The Events Calendar REST; its events page itself is gone)
      area: 'town',
      geo: [20.88631, -156.68416],
      capacity: 500,
      type: 'community',
      cssVar: '--v-cannery',
      color: '#a786ea',
      url: 'https://lahainacannerymall.com/',
      icon: 'https://www.google.com/s2/favicons?domain=lahainacannerymall.com&sz=128',
      feed: { kind: 'tribe', url: 'https://lahainacannerymall.com/wp-json/tribe/events/v1/events', maxRepeat: 30 },
      alias: /lahaina cannery/i,
    },
    'Hui Noʻeau': { // the visual arts center at Kaluanui, Makawao — its exhibitions, one row at each opening (a Squarespace collection)
      area: 'town',
      geo: [20.87054, -156.32155],
      capacity: 300,
      type: 'arts',
      cssVar: '--v-hui',
      color: '#d686ea',
      url: 'https://www.huinoeau.com/exhibitions',
      icon: 'https://www.google.com/s2/favicons?domain=www.huinoeau.com&sz=128',
      feed: { kind: 'squarespace', url: 'https://www.huinoeau.com/exhibitions', drop: /call for|proposals/i },
      alias: /hui no.?eau/i,
    },
    'Haleakalā National Park': { // the summit district's ranger hikes and night-sky programmes (the NPS events API; the data.gov demo key when NPS_API_KEY is unset)
      area: 'town',
      geo: [20.71511, -156.24981],
      capacity: 300,
      type: 'community',
      cssVar: '--v-haleakala',
      color: '#ea86d9',
      url: 'https://www.nps.gov/hale/planyourvisit/calendar.htm',
      icon: 'https://www.google.com/s2/favicons?domain=www.nps.gov&sz=128',
      feed: { kind: 'nps', url: 'https://developer.nps.gov/api/v1/events?parkCode=hale', drop: /sunrise orientation/i }, // the summit's daily sunrise talk (every morning of the year) is left out; the hikes and night-sky programmes stay
      alias: /haleakal[aā]/i,
    },
    'Lānaʻi Culture & Heritage Center': { // Lānaʻi City's museum — talks, workshops and heritage days, the island's one calendar that reads (The Events Calendar REST)
      area: 'town',
      geo: [20.82607, -156.91803],
      capacity: 100,
      type: 'community',
      cssVar: '--v-lanai',
      color: '#ea869f',
      url: 'https://lanaichc.org/our-events/',
      icon: 'https://www.google.com/s2/favicons?domain=lanaichc.org&sz=128',
      feed: { kind: 'tribe', url: 'https://lanaichc.org/wp-json/tribe/events/v1/events' },
      alias: /l[aā]na.?i culture/i,
    },
  };

  // City-wide feeds (scripts/feeds.mjs): none — every room is read by its own listing
  var FEEDS = [];

  // The usual view: every room on
  var DEFAULT_ON = ['Maui Arts & Cultural Center', 'ʻĪao Theater', 'Hale Hōʻikeʻike', 'ProArts Playhouse', 'Mulligans on the Blue', 'Da Playground', 'Pacific Whale Foundation', 'Lahaina Civic Center', 'Lahaina Cannery Mall', 'Hui Noʻeau', 'Haleakalā National Park', 'Lānaʻi Culture & Heritage Center'];
  var DEFAULT_OFF = [];
  var PREFS_KNOWN_FROM = null; // no default-off venue yet, so nothing for saved prefs to be told about

  // The kinds of event (badge keys; the filter panel's Event Type column)
  var TYPES = [
    { key: 'concert', label: 'Concerts', title: 'Live music — the MACC’s touring shows, Da Playground, Mulligans' },
    { key: 'sports', label: 'Sports', title: 'The Maui Invitational at the Lahaina Civic Center; the Rainbow Warriors and Wahine in the Teams view' },
    { key: 'arts', label: 'Arts & Theater', title: 'The MACC, the ʻĪao Theater, ProArts and Hui Noʻeau — plays, dance, film, the exhibitions' },
    { key: 'community', label: 'Community', title: 'The museums’ talks and festivals, the whale days, the park’s programmes, the mall’s hula' },
  ];
  var MOVIE_VENUE = null; // no cinema here

  // Share codes (?f=CODE): REGISTRY is every filterable key in a fixed
  // order and a code is a bitmask over it, so the list is APPEND-ONLY —
  // adding an entry adds a bit and every existing code keeps meaning what
  // it meant; removing or reordering one changes every link out there.
  // 23 slots from the first build: five base-36 digits.
  var CODE_LENGTH = 5;
  var REGISTRY = [
    ['venue', 'Maui Arts & Cultural Center'], ['venue', 'ʻĪao Theater'], ['venue', 'Hale Hōʻikeʻike'], ['venue', 'ProArts Playhouse'], ['venue', 'Mulligans on the Blue'], ['venue', 'Da Playground'], ['venue', 'Pacific Whale Foundation'], ['venue', 'Lahaina Civic Center'], ['venue', 'Lahaina Cannery Mall'], ['venue', 'Hui Noʻeau'], ['venue', 'Haleakalā National Park'], ['venue', 'Lānaʻi Culture & Heritage Center'],
    ['badge', 'concert'], ['badge', 'sports'], ['badge', 'arts'], ['badge', 'community'],
    ['team', 'football'], ['team', 'basketball'], ['team', 'volleyball'],
    ['cap', 'stadium'], ['cap', 'arena'], ['cap', 'hall'], ['cap', 'room'],
  ];

  // The words the page uses for the place
  var WORDS = {
    teamCity: 'Hawaii', // the board drops it from the programs' names ("Hawaii Rainbow Warriors Football" → Rainbow Warriors Football)
    presetDefault: 'Every room on the island — Kahului and Wailuku, the south and west shores, Upcountry, Haleakalā and Lānaʻi — every team and type',
    presetNeighborhood: 'Central Maui only — the MACC, the ʻĪao Theater and Hale Hōʻikeʻike',
    presetBig: 'Only the places that hold 2,000 or more — the MACC and the Lahaina Civic Center',
    phrases: { all: 'Showing everything.', none: 'Showing nothing yet — open Filter and pick some venues.', neighborhood: 'Showing Central Maui only — Kahului and Wailuku.', big: 'Showing the big rooms only — the MACC and the Lahaina Civic Center.' },
  };

  // Hawaiʻi's public holidays (app.js holidaysFor reads this instead of its
  // Seattle list): the federal set without Columbus Day and Juneteenth, which
  // the state does not observe, plus its own three — Prince Kūhiō Day, King
  // Kamehameha I Day and Statehood Day — and Good Friday.
  function nthWeekday(y, month, weekday, n) { var d = new Date(y, month, 1); while (d.getDay() !== weekday) d.setDate(d.getDate() + 1); d.setDate(d.getDate() + (n - 1) * 7); return d; }
  function lastMonday(y, month) { var d = new Date(y, month + 1, 0); while (d.getDay() !== 1) d.setDate(d.getDate() - 1); return d; }
  function easter(y) { // Gregorian computus (Meeus/Jones/Butcher)
    var a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    var h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    var month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(y, month - 1, day);
  }
  var HOLIDAYS = function (y) {
    var gf = easter(y); gf.setDate(gf.getDate() - 2);
    return [
      [new Date(y, 0, 1), "New Year's Day"],
      [nthWeekday(y, 0, 1, 3), 'Martin Luther King Jr. Day'],
      [nthWeekday(y, 1, 1, 3), "Presidents' Day"],
      [new Date(y, 2, 26), 'Prince Kūhiō Day'],
      [gf, 'Good Friday'],
      [lastMonday(y, 4), 'Memorial Day'],
      [new Date(y, 5, 11), 'King Kamehameha I Day'],
      [new Date(y, 6, 4), 'Independence Day'],
      [nthWeekday(y, 7, 5, 3), 'Statehood Day'],
      [nthWeekday(y, 8, 1, 1), 'Labor Day'],
      [new Date(y, 10, 11), 'Veterans Day'],
      [nthWeekday(y, 10, 4, 4), 'Thanksgiving'],
      [new Date(y, 11, 25), 'Christmas Day'],
    ];
  };

  global.LQACity = {
    key: 'maui',
    name: 'Maui',
    site: 'https://maui.here.events/',
    userAgent: 'Mozilla/5.0 (compatible; maui-events/1.0; +https://maui.here.events/)',
    tz: 'Pacific/Honolulu', tzName: 'Hawaii', // the island's time zone (no daylight time): the ICS feed's TZID, the game clocks, the poster's footer
    state: 'Hawaii', stateOutline: null, // no state drawing (the masthead's state strip went away 2026-10-13)
    // the calendar feed's header; the UID domain never changes (changing it
    // re-creates every event in subscribers' calendars)
    ics: { name: 'Maui Events', short: 'Maui Events', teams: 'Hawaiʻi teams — every season', prodid: '-//here.events//maui-events//EN', uidDomain: 'fosdal.net', // the UID domain the whole family issues (the shared ics test pins it)
      desc: 'Upcoming events on Maui — the Maui Arts & Cultural Center\, the ʻĪao Theater\, Hale Hōʻikeʻike\, ProArts\, Mulligans\, Da Playground\, the Pacific Whale Foundation\, the Lahaina Civic Center and Cannery Mall\, Hui Noʻeau\, Haleakalā and Lānaʻi' },
    teams: TEAMS,
    // the Map view (site/local-map.js, the Map stop): the ground scripts/build-local-map.mjs draws into site/local-map.json
    // — Maui, Lānaʻi and Molokaʻi from Natural Earth (public domain), Kahoʻolawe faint between them — with a pin on every
    // room above that carries geo: [lat, lon]. The frame is the three islands' extent; the labels a visitor steers by.
    map: {
      kind: 'island',
      country: 'USA',
      land: [[20.8, -156.3], [20.83, -156.92], [21.13, -157.0]], // a point on each ring to draw as land: Maui, Lānaʻi, Molokaʻi
      far: [[20.55, -156.6]], // Kahoʻolawe, faint
      labels: [ // the places a visitor steers by; anchor: which side of the dot the name sits
        { name: 'Kahului', lat: 20.889, lon: -156.474, anchor: 'start', dy: -6 },
        { name: 'Wailuku', lat: 20.891, lon: -156.506, anchor: 'end', dy: -6 },
        { name: 'Kīhei', lat: 20.765, lon: -156.446, anchor: 'end' },
        { name: 'Wailea', lat: 20.69, lon: -156.44, anchor: 'end' },
        { name: 'Māʻalaea', lat: 20.793, lon: -156.512, anchor: 'end', dy: 12 },
        { name: 'Lahaina', lat: 20.878, lon: -156.682, anchor: 'end' },
        { name: 'Kāʻanapali', lat: 20.925, lon: -156.694, anchor: 'end', dy: -4 },
        { name: 'Pāʻia', lat: 20.903, lon: -156.37, anchor: 'start', dy: -6 },
        { name: 'Makawao', lat: 20.857, lon: -156.313, anchor: 'start' },
        { name: 'Hāna', lat: 20.758, lon: -155.99, anchor: 'start' },
        { name: 'Lānaʻi City', lat: 20.828, lon: -156.92, anchor: 'start', dy: 12 },
        { name: 'Kaunakakai', lat: 21.093, lon: -157.023, anchor: 'start', dy: 12 },
        { name: 'Haleakalā', lat: 20.71, lon: -156.253, kind: 'peak' },
        { name: 'Puʻu Kukui', lat: 20.89, lon: -156.587, kind: 'peak' },
      ],
    },
    venues: VENUES,
    feeds: FEEDS,
    defaultOn: DEFAULT_ON,
    defaultOff: DEFAULT_OFF,
    prefsKnownFrom: PREFS_KNOWN_FROM,
    types: TYPES,
    movieVenue: MOVIE_VENUE,
    groundsVenue: null, // every listing is read by room (or pinned to one) or folds by alias (the Vulcans' rows); fetch-events.mjs drops anything that arrives under a name city.js lacks
    codeLength: CODE_LENGTH,
    registry: REGISTRY,
    words: WORDS,
    holidays: HOLIDAYS,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
