// Lower Queen Anne Events — calendar UI over events.json.
(function () {
  'use strict';

  // The city (city.js, loaded first): the teams, the venues and the words
  // for the place. One table per venue field, as the code always read them.
  var CITY = LQACity;
  function venueTable(field) {
    var out = {};
    Object.keys(CITY.venues).forEach(function (v) { if (CITY.venues[v][field] !== undefined) out[v] = CITY.venues[v][field]; });
    return out;
  }
  // Venue hue assignment: marquee venues keep curated colors (styles.css
  // --v-* variables); every other venue gets a hue hashed from its name, so
  // colors stay stable no matter which venues the feed contains.
  var VENUE_VARS = venueTable('cssVar');
  // Unexpected venues draw from the same cool, web-safe family as the
  // curated ones, hashed from the name so the pick is stable day to day.
  var VENUE_FALLBACK = ['#66ccff', '#9999ff', '#66ffff', '#cc66cc', '#3399ff', '#ff99ff', '#00cccc', '#6666ff'];
  function venueColor(v) {
    if (VENUE_VARS[v]) return 'var(' + VENUE_VARS[v] + ')';
    var h = 0;
    for (var i = 0; i < v.length; i++) h = (h * 31 + v.charCodeAt(i)) % 360;
    return VENUE_FALLBACK[h % VENUE_FALLBACK.length];
  }
  // Each venue's own events listing — not a ticket vendor. An event's own
  // link (the agenda row's title) still goes to wherever tickets are
  // sold; this is for the venue name in the panel and the agenda. A venue
  // with no entry stays plain text.
  var VENUE_URL = venueTable('url');

  // Venue list order = how big a crowd the place can hold (LQAFilter.
  // VENUE_CAPACITY), biggest first; a venue the table doesn't know sorts
  // after the known ones, busiest first.
  var VENUE_CAPACITY = LQAFilter.VENUE_CAPACITY;
  var CAP_BANDS = LQAFilter.CAP_BANDS;
  function venueOrder(counts) {
    return function (a, b) {
      var ca = VENUE_CAPACITY[a] || 0, cb = VENUE_CAPACITY[b] || 0;
      if (ca !== cb) return cb - ca;
      if (counts[a] !== counts[b]) return counts[b] - counts[a];
      return a < b ? -1 : 1;
    };
  }

  // Team roster, event-type classification, venue slugs, and filter
  // matching are shared with other sites that render a filtered slice of
  // this feed (see filter.js) — this is a thin alias, not a second copy.
  var TEAMS = LQAFilter.TEAMS;
  var TEAM_BY_SLUG = LQAFilter.TEAM_BY_SLUG;
  var slugify = LQAFilter.slugify;
  var eventType = LQAFilter.eventType;
  function teamFor(title) {
    for (var i = 0; i < TEAMS.length; i++) if (TEAMS[i].re.test(title || '')) return TEAMS[i];
    return null;
  }

  // Three-state boxes (Steve, 2026-09-22): each filter map holds name → 'in'
  // (checked: show these) | 'ex' (X: hide these); absent = no preference.
  // The rule is LQAFilter.matchesFilter; no box ever changes another. The
  // usual view starts with the small rooms and movies X'd — applyDefaultFilters.
  var MODE_MAPS = ['venueMode', 'badgeMode', 'teamMode', 'capMode'];
  var state = { events: [], byDate: {}, venues: [], venueMode: {}, badgeMode: {}, teamMode: {}, capMode: {}, q: '', holidays: false, soldOnly: false, month: null, showPast: false, pastFrom: null, series: [] };

  function modeKeys(map, mode) {
    return Object.keys(map).filter(function (k) { return map[k] === mode; });
  }
  function setMode(map, key, mode) { // 'in' | 'ex' | null (no preference)
    if (mode) map[key] = mode; else delete map[key];
  }
  function currentModes() { return { venueMode: state.venueMode, badgeMode: state.badgeMode, teamMode: state.teamMode, capMode: state.capMode }; }
  function anyIncluded() { return MODE_MAPS.some(function (m) { return modeKeys(state[m], 'in').length > 0; }); }

  var $ = function (id) { return document.getElementById(id); };
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };

  // "2026-09-05T18:27:23.798Z" → "Sep 5"
  function fmtSince(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function parseDate(s) {
    var p = s.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }
  function ymd(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function todayStr() { return ymd(new Date()); }
  // Clocks are the city's wall time (city.js tz). A viewer whose own zone
  // keeps a different clock on that day sees the time on theirs, with the
  // zone's short name after the AM/PM ("5:00 PM PDT" for a 7:00 PM Chicago
  // show read from Seattle; Steve, 2026-10-11: "times for all event listings
  // should be in timezone of the viewer … if event tz is diff from viewer
  // tz"). Zones are compared by their offset on the day, not by name, so a
  // viewer in Vancouver reads Seattle's clocks untouched. Day shifts across
  // midnight keep the city's day in the list; only the clock moves.
  var CITY_TZ = CITY.tz || 'America/Los_Angeles';
  var VIEWER_TZ = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } })();
  var zoneSame = {}; // by date: does the viewer's zone keep the city's clock that day
  function wallOffset(zone, ms) { // minutes the zone's wall clock is ahead of UTC at that instant
    var p = {};
    new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - ms) / 60000);
  }
  function viewerClock(date, t) { // the viewer's "5:00 PM PDT" for the city's date + time, or '' when their clock is the city's
    if (!VIEWER_TZ || VIEWER_TZ === CITY_TZ || !date || !/^\d\d?:\d\d/.test(t)) return '';
    try {
      var ymd = date.split('-'), hm = t.split(':');
      var guess = Date.UTC(+ymd[0], +ymd[1] - 1, +ymd[2], +hm[0], +hm[1]);
      var ms = guess - wallOffset(CITY_TZ, guess) * 60000; // the city's wall time as an instant
      if (zoneSame[date] === undefined) zoneSame[date] = wallOffset(VIEWER_TZ, ms) === wallOffset(CITY_TZ, ms);
      if (zoneSame[date]) return '';
      return new Date(ms).toLocaleTimeString('en-US', { timeZone: VIEWER_TZ, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).replace(/\u202f/g, ' ');
    } catch (e) { return ''; }
  }
  function fmtTime(t, date) { // date: the city's day the time belongs to, for the viewer's-zone clock
    if (!t) return 'all day';
    var v = viewerClock(date, t);
    if (v) return v;
    var hm = t.split(':');
    var h = Number(hm[0]), m = hm[1] || '00';
    var ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + ':' + m + ' ' + ap;
  }

  // ---- data ----
  // ---- series (detection, labels and the gutter graph live in filter.js,
  // shared with other sites that list the feed) ----
  var seriesLabel = LQAFilter.seriesLabel;
  function findSeries(list) {
    state.series = LQAFilter.findSeries(list);
  }
  // The gutter column right of the cards is sized per page for the lanes
  // the graph needs; lines take their series' venue colour and merge into
  // each card's right edge, running along it briefly at the join.
  // The date rail centres on the day's first event: the rail gets that row's
  // height (a row is two or three lines) and centres its number and weekday
  // in it. Desktop only — on phones the rail is a line above the events.
  function alignRails() {
    var phone = matchMedia('(max-width: 640px)').matches;
    document.querySelectorAll('.day-row').forEach(function (li) {
      var rail = li.querySelector('.date-rail'), first = li.querySelector('.day-events > .ev');
      if (!rail) return;
      rail.style.height = phone || !first ? '' : first.offsetHeight + 'px';
    });
  }
  function drawSeriesGraph() {
    var ol = $('agenda');
    var layout = document.querySelector('.agenda-layout');
    if (!state.series.length || !matchMedia('(min-width: 641px)').matches) {
      var old = ol.querySelector('.series-graph');
      if (old) old.remove();
      layout.classList.remove('has-series');
      layout.style.removeProperty('--gutter');
      return;
    }
    var rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    var de = ol.querySelector('.day-events');
    // only the series that get a lane (filter.js: not the long nightly runs)
    var rows = Array.from(ol.querySelectorAll('.ev[data-series]')).map(function (el) {
      return { el: el, series: state.series[Number(el.dataset.series)] };
    }).filter(function (r) { return r.series.lane; });
    var dates = Array.from(ol.querySelectorAll('.day-row')).map(function (li) { return li.dataset.date; });
    LQAFilter.drawSeriesGraph(ol, rows, {
      firstDate: dates[0], lastDate: dates[dates.length - 1],
      laneWidth: 0.5 * rem, // narrow lanes: uncapped, a busy page needs five or six
      bend: 16, // the S-curve's height between the lane and the card's edge
      hug: 5,   // how far the line runs along the edge either side of the row's centre
      maxLanes: 0, // no cap: every concurrent series keeps its own lane (Steve, 2026-09-10 — a shared grey trunk hid them)
      // the gutter column exists only while a lane needs it: no lanes on
      // this page, no column, and the cards take the width. The lanes start
      // half a rem past the cards, inside the grid's 1rem gap, so the column
      // only has to hold what runs past the gap.
      onLanes: function (n) {
        layout.classList.toggle('has-series', n > 0);
        if (n > 0) layout.style.setProperty('--gutter', Math.max(0.3, n * 0.5 - 0.3) + 'rem'); else layout.style.removeProperty('--gutter');
      },
      gutterX: function (box) { return de.getBoundingClientRect().right - box.left + rem / 2; },
      // each series in its venue's colour, keyed like the card's venue label
      // (pure in dark mode, pulled toward ink in light), so the line reads
      // as part of the listing it runs into
      color: function (s) { return 'color-mix(in srgb, ' + venueColor(s.events[0].venue) + ' var(--venue-text), var(--ink))'; },
      // …and fades to the card's own face colour (its venue wash over the
      // page) across the bend, so the join dissolves into the listing
      edgeColor: function (s) { return 'color-mix(in srgb, ' + venueColor(s.events[0].venue) + ' var(--tint), var(--sky))'; },
      label: seriesLabel,
    });
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { drawSeriesGraph(); });

  function load() {
    fetch('events.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        var list = Array.isArray(data) ? data : (data.events || []);
        state.events = list;
        findSeries(list);
        state.byDate = {};
        var vs = {};
        list.forEach(function (e) {
          (state.byDate[e.date] = state.byDate[e.date] || []).push(e);
          vs[e.venue] = (vs[e.venue] || 0) + 1;
        });
        // within a day: all-day items first, then by clock time (a stable
        // sort keeps the feed's order among equals)
        Object.keys(state.byDate).forEach(function (dt) {
          state.byDate[dt].sort(function (a, b) {
            var ta = a.time || '', tb = b.time || '';
            return (ta ? 1 : 0) - (tb ? 1 : 0) || (ta < tb ? -1 : ta > tb ? 1 : 0);
          });
        });
        // Bars (every event typed 'bar') stay out of the venue list: the one
        // "Local Bars" type switch covers them all, so they're never in
        // venueMode and the venue presets and "only" links don't see them.
        var barOnly = {};
        list.forEach(function (e) { barOnly[e.venue] = (barOnly[e.venue] !== false) && e.type === 'bar'; });
        state.venues = Object.keys(vs).filter(function (v) { return !barOnly[v]; }).sort(venueOrder(vs));
        var now = new Date();
        state.month = new Date(now.getFullYear(), now.getMonth(), 1);
        // forget saved venues that no longer appear in the feed
        Object.keys(state.venueMode).forEach(function (v) {
          if (state.venues.indexOf(v) === -1) delete state.venueMode[v];
        });
        renderFilters(); renderCal(); renderAgenda(); renderBoard(); updateSubscribe(); if (window.LQAMap) LQAMap.render(); // a cold ?view=map load drew the map before the feed: again, with the counts (Steve, 2026-10-26: '0 upcoming at 0 of 22 places')
        if (!$('teamsView').hidden && teamView.slug !== undefined) renderTeams(teamView.slug); // a ?team= open drew the season before the feed arrived: again, with ticket links and counts
      })
      .catch(function (err) {
        $('agenda').innerHTML = '';
        var li = document.createElement('li');
        li.className = 'empty';
        li.textContent = 'The event feed did not load (' + err.message + '). Reload the page to try again.';
        $('agenda').appendChild(li);
      });
  }

  // Event type is inferred, not sourced: every event lands in exactly one
  // bucket, from its flags, title, then venue. The rows, in order, are the
  // city's (city.js TYPES).
  var TYPE_LIST = CITY.types;
  // Type hues mirror the venue hues: a dot on the filter rows.
  var TYPE_VARS = {
    concert: '--t-concert', sports: '--t-sports', arts: '--t-arts',
    movie: '--t-movie', community: '--t-community', expo: '--t-expo', bar: '--t-bar',
  };
  function typeColor(k) { return 'var(' + TYPE_VARS[k] + ')'; }
  var TYPE_KEYS = {};
  TYPE_LIST.forEach(function (t) { TYPE_KEYS[t.key] = true; });
  // The baseline every visitor starts from (and "Reset filters" returns to):
  // SIFF's daily movie showings unchecked, everything else checked.
  function venueArea(v) { return LQAFilter.VENUE_AREA[v] || 'campus'; }
  function venueGroup(v) { return LQAFilter.VENUE_FESTIVAL[v] ? 'fest' : venueArea(v); } // the panel's group: Lower Queen Anne | Around Town | Festivals
  // Presets: each names what's OFF in every group; `holidays` (when given)
  // sets the switch too, and the search box is left alone. Venue lists that
  // depend on the feed are functions of the venues present. `teamsOff`
  // unchecks every team (only Hide All does; the rest leave teams checked).
  // The default view (Steve's pick, 2026-09-10) is the city's: what's on
  // and what starts unchecked (city.js). Bars aren't venues here, so
  // they're untouched. The Teams view is never filtered — every game shows.
  var DEFAULT_VENUES_ON = CITY.defaultOn.slice();
  var DEFAULT_VENUES_OFF = CITY.defaultOff.slice();
  var VENUES_BEFORE_KNOWN = DEFAULT_VENUES_OFF.slice(0, DEFAULT_VENUES_OFF.indexOf(CITY.prefsKnownFrom)); // the default-off venues every saved pref set already knew before prefs recorded `known` (2026-10-05, with the Block Party)
  // Capacity bands: LQAFilter.CAP_BANDS, a filter option each (2026-09-22:
  // no longer a switch over the venue rows — nothing changes another box)
  var BAND_BY_KEY = {};
  CAP_BANDS.forEach(function (b) { BAND_BY_KEY[b.key] = b; });
  var BIG_NIGHT_SEATS = 2000; // the Capacity preset's floor; McCaw Hall (2,900) is the smallest venue in
  var PRESETS = [
    { key: 'default', label: 'Default', title: CITY.words.presetDefault,
      venuesOff: function () { return DEFAULT_VENUES_OFF.slice(); }, typesOff: ['movie'], holidays: false },
    { key: 'all', label: 'Show All', title: 'Every venue, type and team, holidays too', venuesOff: function () { return []; }, typesOff: [], holidays: true }, // the same words as the groups' Show All · Hide All (Steve, 2026-10-12: "Everything and Nothing … is incongruous")
    { key: 'none', label: 'Hide All', title: 'Everything off — build your own view from scratch',
      venuesOff: function () { return state.venues.slice(); }, typesOff: TYPE_LIST.map(function (t) { return t.key; }), teamsOff: true, holidays: false },
    { key: 'neighborhood', label: 'Neighborhood', title: CITY.words.presetNeighborhood,
      venuesOff: function () { return DEFAULT_VENUES_OFF.concat(state.venues.filter(function (v) { return venueArea(v) === 'town' && DEFAULT_VENUES_OFF.indexOf(v) < 0; })); }, typesOff: ['movie'] },
    { key: 'big', label: 'Capacity > 2K', title: CITY.words.presetBig,
      venuesOff: function () { return state.venues.filter(function (v) { return (VENUE_CAPACITY[v] || 0) < BIG_NIGHT_SEATS; }); }, typesOff: ['bar'] },
  ];
  function applyPreset(p) { // a preset is X's only — nothing checked
    state.venueMode = {}; state.badgeMode = {}; state.teamMode = {}; state.capMode = {};
    p.venuesOff().forEach(function (v) { state.venueMode[v] = 'ex'; });
    p.typesOff.forEach(function (t) { state.badgeMode[t] = 'ex'; });
    if (p.teamsOff) groupInfo('team').keys.forEach(function (t) { state.teamMode[t] = 'ex'; });
    if (p.holidays !== undefined) state.holidays = p.holidays;
    state.soldOnly = false; // a preset is a whole state: the Only Sold Out switch goes off with it (Steve, 2026-09-15)
  }
  // Does the panel's current state equal this preset? Compares what's off in
  // each group against the preset's lists (only keys the panel shows count,
  // so a saved exclusion for a venue that left the feed can't spoil a match).
  function presetMatches(p) {
    if (anyIncluded() || modeKeys(state.capMode, 'ex').length) return false; // presets X things; a check or a band anywhere is a view of its own
    var off = function (g) {
      var gi = groupInfo(g);
      return gi.keys.filter(function (k) { return gi.map[k] === 'ex'; }).sort().join('|');
    };
    var sorted = function (a) { return a.slice().sort().join('|'); };
    if (off('team') !== (p.teamsOff ? sorted(groupInfo('team').keys) : '')) return false;
    if (p.holidays !== undefined && state.holidays !== p.holidays) return false;
    if (state.soldOnly) return false; // no preset keeps the switch on
    var shown = groupInfo('venue').keys;
    return off('venue') === sorted(p.venuesOff().filter(function (v) { return shown.indexOf(v) >= 0; })) && off('badge') === sorted(p.typesOff);
  }
  function renderPresets() {
    var box = $('fpPresets');
    box.innerHTML = '';
    var hasTown = Object.keys(CITY.venues).some(function (v) { return CITY.venues[v].area === 'town'; }); // a city with nothing a bus ride away has no Neighborhood preset (it would equal Default)
    PRESETS.filter(function (p) { return p.key !== 'neighborhood' || hasTown; }).forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'chip fp-preset'; b.textContent = p.label; b.title = p.title; b.dataset.preset = p.key;
      b.addEventListener('click', function () { applyPreset(p); applyFilters(); });
      box.appendChild(b);
    });
  }
  function syncPresets() {
    document.querySelectorAll('.fp-preset').forEach(function (b) {
      var p = PRESETS.filter(function (x) { return x.key === b.dataset.preset; })[0];
      b.classList.toggle('is-on', !!p && presetMatches(p));
      b.setAttribute('aria-pressed', String(!!p && presetMatches(p)));
    });
  }
  function applyDefaultFilters() {
    state.badgeMode = { movie: 'ex' };
    state.venueMode = {}; state.teamMode = {}; state.capMode = {};
    DEFAULT_VENUES_OFF.forEach(function (v) { state.venueMode[v] = 'ex'; });
  }
  // The one test of "the usual view" — the funnel chip, the Default chip
  // and the view note all use it, so they can't disagree (2026-09-20).
  function isDefaultState() {
    return !state.q && presetMatches(PRESETS[0]);
  }
  // Matching itself lives in filter.js so other sites filtering this feed
  // (e.g. river's Neighborhood section) can't drift from these rules.
  function filtered(list) {
    return list.filter(function (e) {
      return LQAFilter.matchesFilter(e, Object.assign(currentModes(), { soldOnly: state.soldOnly }))
        && LQAFilter.matchesSearch(e, state.q);
    });
  }

  // ---- holidays (off by default, a switch in the filter panel) ----
  // Computed from the rules, no feed needed; the actual date, not the
  // observed weekday shift. One merged list of what the US, Washington and
  // the City of Seattle observe: the federal set, Indigenous Peoples' Day
  // (Seattle's name for the October Monday) and the Friday after
  // Thanksgiving (WA's Native American Heritage Day). Shown as divider rows
  // in the listing, right above the day's first event.
  function nthWeekday(y, m, wd, n) { // n-th (1-based) weekday wd of month m; n < 0 counts from the end
    var d = n > 0 ? new Date(y, m, 1) : new Date(y, m + 1, 0);
    var step = n > 0 ? 1 : -1;
    while (d.getDay() !== wd) d.setDate(d.getDate() + step);
    d.setDate(d.getDate() + (Math.abs(n) - 1) * 7 * step);
    return d;
  }
  function holidaysFor(y) {
    if (CITY.holidays) return CITY.holidays(y).map(function (h) { return { date: ymd(h[0]), title: h[1] }; }); // a city outside the US brings its own list (cancun-events, 2026-10-13: city.js holidays(y) → [[Date, name], …])
    var thanks = nthWeekday(y, 10, 4, 4);
    var friday = new Date(thanks); friday.setDate(thanks.getDate() + 1);
    return [
      [new Date(y, 0, 1), "New Year's Day"],
      [nthWeekday(y, 0, 1, 3), 'Martin Luther King Jr. Day'], // a day of service
      [nthWeekday(y, 1, 1, 3), "Presidents' Day"],
      [nthWeekday(y, 4, 1, -1), 'Memorial Day'], // the poppy
      [new Date(y, 5, 19), 'Juneteenth'],
      [new Date(y, 6, 4), 'Independence Day'],
      [nthWeekday(y, 8, 1, 1), 'Labor Day'],
      [nthWeekday(y, 9, 1, 2), "Indigenous Peoples' Day"],
      [new Date(y, 10, 11), 'Veterans Day'],
      [thanks, 'Thanksgiving'],
      [friday, 'Native American Heritage Day'], // the harvest
      [new Date(y, 11, 25), 'Christmas Day'],
    ].map(function (h) { return { date: ymd(h[0]), title: h[1] }; });
  }
  var holidayCache = {}; // year -> map date -> [rows]
  function holidayMap() {
    if (!state.holidays) return {};
    var years = {};
    var now = new Date().getFullYear();
    years[now] = years[now + 1] = true;
    Object.keys(state.byDate).forEach(function (d) { years[Number(d.slice(0, 4))] = true; });
    var map = {};
    Object.keys(years).forEach(function (y) {
      if (!holidayCache[y]) holidayCache[y] = holidaysFor(Number(y));
      holidayCache[y].forEach(function (h) { (map[h.date] = map[h.date] || []).push(h); });
    });
    return map;
  }
  // the feed's events for a day that survive the filter and the search
  function dayItems(date) { return filtered(state.byDate[date] || []); }

  // ---- filter panel ----
  // Kayak-style groups of checkbox rows, dropped open under the bar by the
  // funnel chip and closed by it or a click anywhere else.
  // One panel row: name  count [Show|Hide]. The two words at the row's end
  // are a pair of buttons (Steve, 2026-09-22, third pass): Show pressed =
  // show these, Hide pressed = never these, neither = no preference. A
  // press on a lit word clears it; a tap on the name works Show.
  function filterRow(group, key, nameEl, count, title) {
    var row = document.createElement('div');
    row.className = 'fp-row';
    var lab = document.createElement('span');
    lab.className = 'fp-check';
    if (title) lab.title = title;
    var name = nameEl.textContent;
    lab.appendChild(nameEl);
    var seg = document.createElement('span');
    seg.className = 'fp-seg'; seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', name);
    seg.dataset.group = group; seg.dataset.key = key; seg.dataset[group] = key;
    [['in', 'Show'], ['ex', 'Hide']].forEach(function (m) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'fp-seg-b'; b.dataset.mode = m[0]; b.textContent = m[1];
      b.setAttribute('aria-pressed', 'false'); b.setAttribute('aria-label', m[1] + ' ' + name);
      seg.appendChild(b);
    });
    row.appendChild(lab); row.appendChild(seg); // no counts on the rows (Steve, 2026-09-22: "drop the counts")
    return row;
  }
  // A neighbourhood's row: a chevron that unfolds its rooms, the name, and
  // the Show | Hide pair that sets all of them (city.js `hoods`).
  var HOOD_ROOMS = {}; // label → the rooms under it, in panel order
  function hoodRow(label, n, key, cls) {
    var row = filterRow('hood', key || label, plainName(label), n, n + (n === 1 ? ' room' : ' rooms'));
    row.classList.add(cls || 'fp-hood');
    var fold = document.createElement('button');
    fold.type = 'button'; fold.className = 'fp-fold'; fold.setAttribute('aria-expanded', 'false'); fold.setAttribute('aria-label', 'The rooms in ' + label);
    fold.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
    row.insertBefore(fold, row.firstChild);
    return row;
  }
  // every room Show → 'in', every room Hide → 'ex', otherwise no mark
  function hoodMode(label) {
    var rooms = HOOD_ROOMS[label] || [], first = rooms.length ? state.venueMode[rooms[0]] || '' : '';
    return rooms.every(function (v) { return (state.venueMode[v] || '') === first; }) ? first : '';
  }
  function setFold(row, open) {
    var fold = row.querySelector('.fp-fold'), sub = row.nextElementSibling;
    if (!fold || !sub || !sub.classList.contains('fp-sub')) return;
    sub.hidden = !open; fold.setAttribute('aria-expanded', String(open));
  }
  // Panel rows are plain text: the venue / type / team colours show on the
  // calendar and agenda, not here.
  function plainName(label) {
    var name = document.createElement('span'), text = document.createElement('span');
    name.className = 'fp-name';
    text.textContent = label; name.appendChild(text); // in a span of its own so a too-long name clips with an ellipsis like a linked one
    return name;
  }
  // A name that links out (venue events page, team schedule) — or plain text
  // when there's nowhere to send it. Filter rows sit inside a <label> that
  // toggles the checkbox on any click; native label activation already
  // skips a nested link, and stopPropagation keeps the delegated handlers
  // out of it too.
  function extLink(text, url, title) {
    if (!url) return document.createTextNode(text);
    var a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener';
    if (title) a.title = title;
    a.textContent = text;
    a.addEventListener('click', function (e) { e.stopPropagation(); });
    return a;
  }
  function venueName(v) {
    var name = document.createElement('span');
    name.className = 'fp-name';
    name.appendChild(extLink(v, VENUE_URL[v], "See " + v + "’s own events list"));
    return name;
  }
  function renderFilters() {
    renderPresets();
    // Counts play the role of Kayak's price column: upcoming events each row
    // would govern, unaffected by the current filter so they stay stable.
    var today = todayStr();
    var upcoming = state.events.filter(function (e) { return e.date >= today; });
    var pv = $('panelVenues'), pt = $('panelVenuesTown'), pf = $('panelFestivals');
    pv.innerHTML = ''; pt.innerHTML = ''; pf.innerHTML = '';
    // a team's row
    function teamRow(t) {
      var name = document.createElement('span');
      name.className = 'fp-name';
      name.appendChild(extLink(t.label, t.schedule, t.label + ' schedule'));
      var n = upcoming.filter(function (e) { return t.re.test(e.title || ''); }).length;
      return filterRow('team', t.slug, name, n, t.label + ' home games');
    }
    var cityRows = [], townRows = [], festRows = []; // [venue, row] pairs per group; the city column folds by neighbourhood below when the city asks
    HOOD_ROOMS = {};
    state.venues.forEach(function (v) {
      var n = upcoming.filter(function (e) { return e.venue === v; }).length;
      var cap = VENUE_CAPACITY[v];
      var row = filterRow('venue', v, venueName(v), n, cap ? 'Holds about ' + cap.toLocaleString('en-US') : undefined);
      var g = venueGroup(v); // the festivals keep together, whatever their area
      (g === 'fest' ? festRows : g === 'town' ? townRows : cityRows).push([v, row]);
    });
    // The long tail (Steve, 2026-10-18: "even neighborhoods are getting
    // complicated"): a group lists the rooms the usual view shows; the rooms
    // it starts with hidden go behind one "More rooms" row at its foot — a
    // chevron to open them, and a Show | Hide pair that works them all, like
    // a neighbourhood's. A room the reader has turned on (a saved pref, a
    // share code) is listed in the open part, so a row in use never folds.
    function appendRooms(list, rows, key) {
      var open = rows.filter(function (r) { return DEFAULT_VENUES_OFF.indexOf(r[0]) < 0 || state.venueMode[r[0]] === 'in'; });
      var tail = rows.filter(function (r) { return open.indexOf(r) < 0; });
      open.forEach(function (r) { list.appendChild(r[1]); });
      if (!tail.length) return;
      HOOD_ROOMS[key] = tail.map(function (r) { return r[0]; });
      list.appendChild(hoodRow('More rooms', tail.length, key, 'fp-tail'));
      var sub = document.createElement('div'); sub.className = 'fp-sub'; sub.hidden = true;
      tail.forEach(function (r) { sub.appendChild(r[1]); });
      list.appendChild(sub);
    }
    appendRooms(pt, townRows, 'tail:town');
    appendRooms(pf, festRows, 'tail:fest');
    // A city-wide site folds its column by neighbourhood (city.js `hoods`;
    // seattle-events, 2026-10-18 — Steve: the panel "is getting too big"):
    // one row per neighbourhood whose Show | Hide sets every room in it, the
    // rooms themselves behind a chevron. A room in no list goes under
    // `hoodsRest`. A neighbourhood whose rooms disagree shows neither word
    // lit; the chevron is the way to see which room is which.
    if (CITY.hoods && cityRows.length) {
      var hoodOf = {}, byHood = {}, labels = [];
      CITY.hoods.forEach(function (h) { labels.push(h.label); h.venues.forEach(function (v) { hoodOf[v] = h.label; }); });
      var rest = CITY.hoodsRest || 'Elsewhere';
      cityRows.forEach(function (r) { var h = hoodOf[r[0]] || rest; (byHood[h] = byHood[h] || []).push(r); });
      if (byHood[rest]) labels.push(rest);
      labels.forEach(function (label) {
        var rows = byHood[label];
        if (!rows) return;
        HOOD_ROOMS[label] = rows.map(function (r) { return r[0]; });
        pv.appendChild(hoodRow(label, rows.length));
        var sub = document.createElement('div'); sub.className = 'fp-sub'; sub.hidden = true;
        appendRooms(sub, rows, 'tail:' + label); // the neighbourhood's own long tail folds inside it
        pv.appendChild(sub);
      });
    } else appendRooms(pv, cityRows, 'tail:city');
    // capacity bands keep their state, rule and share-code slots but no panel rows (Steve, 2026-09-22: "we do not need a specific capacity section")
    var pt = $('panelTeams');
    pt.innerHTML = '';
    TEAMS.forEach(function (t) { pt.appendChild(teamRow(t)); });
    var pb = $('panelBadges');
    pb.innerHTML = '';
    TYPE_LIST.forEach(function (t) {
      var n = upcoming.filter(function (e) { return eventType(e) === t.key; }).length;
      pb.appendChild(filterRow('badge', t.key, plainName(t.label), n, t.title));
    });
    // a group with no rows in this city (no Around Town, no festivals) folds away with its heading
    document.querySelectorAll('#filterPanel .fp-list').forEach(function (l) {
      var empty = !l.children.length, h = l.previousElementSibling;
      l.hidden = empty;
      if (h && h.tagName === 'H3') h.hidden = empty;
    });
    syncFilters();
    syncPresets(); // the chips are new; light the one that matches
  }
  // Every box in the panel syncs from state in one pass, so presets, the
  // sheet's chips and Undo all land in the same place. Each row shows its
  // own state and nothing else: no dashes, no greying (Steve, 2026-09-22).
  function syncFilters() {
    syncPresets();
    document.querySelectorAll('#filterPanel .fp-seg[data-group]').forEach(function (seg) {
      var hood = seg.dataset.group === 'hood';
      var mode = hood ? hoodMode(seg.dataset.key) : state[GROUP_MAP[seg.dataset.group]][seg.dataset.key] || '';
      seg.dataset.mode = mode;
      seg.querySelectorAll('.fp-seg-b').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.mode === mode ? 'true' : 'false'); });
    });
    $('holidaysToggle').checked = state.holidays;
    $('soldOnlyToggle').checked = state.soldOnly;
    if ($('searchBox').value.trim() !== state.q) $('searchBox').value = state.q;
    if (state.q) document.querySelector('.filterbar .search-wrap').classList.add('is-open'); // a phone's search chip stays open while it holds a query
    var any = !isDefaultState();
    $('filterToggle').classList.toggle('is-on', any);
  }
  // Filter choices persist per-browser (no login — just localStorage).
  function saveFilters() {
    try {
      localStorage.setItem('lqa-filters', JSON.stringify({ v: 4, venues: state.venueMode, badges: state.badgeMode, teams: state.teamMode, caps: state.capMode, hol: state.holidays, so: state.soldOnly, known: state.venues }));
    } catch (e) { /* private mode etc. — filters just won't persist */ }
  }
  function loadFilters() {
    var raw = null;
    try { raw = localStorage.getItem('lqa-filters'); } catch (e) { /* unreadable storage */ }
    if (raw == null) { applyDefaultFilters(); return; } // first visit
    try {
      var s = JSON.parse(raw);
      if (s.v === 4 || s.v === 3 || s.v === 2) {
        // v4 is the three-state panel; v3 (two-state) and v2 (the first
        // tri-state) hold the same 'in' / 'ex' words, so all three load alike
        var ok = function (m) { return m === 'in' || m === 'ex' ? m : null; };
        Object.keys(s.venues || {}).forEach(function (v) { if (ok(s.venues[v])) state.venueMode[v] = s.venues[v]; });
        // a default-off venue added after these prefs were saved starts off,
        // as it would for a first visit (saved prefs can't tell "cleared" from
        // "never seen", so `known` lists the venues the panel had at save time;
        // prefs older than that list predate the Block Party, 2026-10-05)
        var known = Array.isArray(s.known) ? s.known : VENUES_BEFORE_KNOWN;
        DEFAULT_VENUES_OFF.forEach(function (v) { if (!(v in (s.venues || {})) && known.indexOf(v) < 0) state.venueMode[v] = 'ex'; });
        Object.keys(s.badges || {}).forEach(function (k) { if (TYPE_KEYS[k] && ok(s.badges[k])) state.badgeMode[k] = s.badges[k]; });
        Object.keys(s.teams || {}).forEach(function (k) { if (TEAM_BY_SLUG[k] && ok(s.teams[k])) state.teamMode[k] = s.teams[k]; });
        Object.keys(s.caps || {}).forEach(function (k) { if (BAND_BY_KEY[k] && ok(s.caps[k])) state.capMode[k] = s.caps[k]; });
        // a ?h=1 / ?so=1 link sets these before the saved prefs load — keep them
        state.holidays = state.holidays || !!s.hol;
        state.soldOnly = state.soldOnly || !!s.so;
      } else {
        // v1 arrays: only its team exclusions survive the checkbox model
        (s.teams || []).forEach(function (k) { if (TEAM_BY_SLUG[k]) state.teamMode[k] = 'ex'; });
      }
    } catch (e) { applyDefaultFilters(); } // unreadable storage — start at the baseline
  }
  // A link built from "Copy filter link" takes over the initial view instead
  // of your saved prefs — open it, and you see exactly what was shared.
  // Interacting with the panel from there saves normally, like any visit.
  // ?f=CODE carries the checkboxes, ?s=CODE the (encoded) search term, and
  // ?h=1 the holidays switch.
  function loadFiltersFromURL() {
    var params = new URLSearchParams(location.search);
    if (params.get('s')) state.q = LQAFilter.decodeSearch(params.get('s')).trim();
    if (params.get('h') === '1') state.holidays = true;
    if (params.get('so') === '1') state.soldOnly = true;
    var code = params.get('f');
    var parsed = code == null ? null : LQAFilter.parseFilterCode(code);
    if (!parsed) return false;
    state.venueMode = parsed.venueMode;
    state.badgeMode = parsed.badgeMode;
    state.teamMode = parsed.teamMode;
    state.capMode = parsed.capMode || {};
    return true;
  }
  // a filter change also rewinds the agenda to its first page
  function applyFilters() { syncFilters(); renderViewNote(); renderCal(); renderAgenda(); renderBoard(); updateSubscribe(); saveFilters(); if (window.LQAMap) LQAMap.render(); } // the Map view's pins follow the filters (local-map.js, in a city that has one)
  // ---- the view note (2026-09-20, for readers who never open the panel) ----
  // One plain line above the list while the view is not the usual one: the
  // preset's name when one matches, else what is hidden or added compared
  // with the usual view ("Also hiding Kraken games and McCaw Hall · Also
  // showing MoPOP"), the search and the sold-out switch named too. A button
  // takes the view back. Nothing shows in the usual view.
  var PRESET_PHRASE = CITY.words.phrases;
  function listWords(items) { // "a", "a and b", "a, b and c", "a, b and 3 more"
    if (items.length <= 3) return items.length < 2 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
    return items.slice(0, 2).join(', ') + ' and ' + (items.length - 2) + ' more';
  }
  function describeView() {
    var parts = [];
    var preset = PRESETS.filter(function (p) { return p.key !== 'default' && presetMatches(p); })[0];
    if (preset) parts.push(PRESET_PHRASE[preset.key] || 'Showing ' + preset.label + '.');
    else {
      // the checks: what the view is narrowed to
      var only = [], kinds = [];
      state.venues.forEach(function (v) { if (state.venueMode[v] === 'in') only.push(v); });
      CAP_BANDS.forEach(function (b) { if (state.capMode[b.key] === 'in') only.push(b.label.toLowerCase()); });
      TEAMS.forEach(function (t) { if (state.teamMode[t.slug] === 'in') only.push(t.label + ' games'); });
      TYPE_LIST.forEach(function (t) { if (state.badgeMode[t.key] === 'in') kinds.push(t.label.toLowerCase()); });
      if (only.length) parts.push('Only ' + listWords(only) + '.');
      if (kinds.length) parts.push('Just ' + listWords(kinds) + '.');
      // the X's, compared with the usual view
      var hiding = [], showing = [];
      state.venues.forEach(function (v) {
        var off = state.venueMode[v] === 'ex', usual = DEFAULT_VENUES_OFF.indexOf(v) < 0;
        if (off && usual) hiding.push(v); else if (!off && !usual && !only.length) showing.push(v);
      });
      CAP_BANDS.forEach(function (b) { if (state.capMode[b.key] === 'ex') hiding.push(b.label.toLowerCase()); });
      TEAMS.forEach(function (t) { if (state.teamMode[t.slug] === 'ex') hiding.push(t.label + ' games'); });
      TYPE_LIST.forEach(function (t) {
        var off = state.badgeMode[t.key] === 'ex';
        if (off && t.key !== 'movie') hiding.push(t.label.toLowerCase()); else if (!off && t.key === 'movie' && !kinds.length && !only.length) showing.push('movies');
      });
      if (hiding.length) parts.push((only.length || kinds.length ? 'Hiding ' : 'Also hiding ') + listWords(hiding) + '.');
      if (showing.length) parts.push('Also showing ' + listWords(showing) + '.');
    }
    if (state.soldOnly) parts.push('Sold out and nearly sold out only.');
    if (state.q) parts.push('Matching \u201c' + state.q + '\u201d.');
    return parts.join(' ');
  }
  function renderViewNote() {
    var note = $('viewNote'), text = describeView();
    var usual = isDefaultState() || (!text);
    note.hidden = usual;
    if (!usual) $('viewNoteText').textContent = text;
  }
  $('viewNoteReset').addEventListener('click', function () {
    applyPreset(PRESETS[0]); state.q = ''; $('searchBox').value = '';
    applyFilters();
  });
  // ---- the toast: a word after hiding something from the sheet, with Undo ----
  var toastTimer = null, toastUndo = null;
  function showToast(text, undo) {
    var t = $('toast'); $('toastText').textContent = text; toastUndo = undo || null;
    $('toastUndo').hidden = !undo;
    t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, 7000);
  }
  function hideToast() { $('toast').hidden = true; toastUndo = null; clearTimeout(toastTimer); }
  $('toastUndo').addEventListener('click', function () { if (toastUndo) toastUndo(); hideToast(); });
  // a snapshot of the three maps, for Undo
  function filterSnapshot() {
    var snap = {};
    MODE_MAPS.forEach(function (m) { snap[m] = JSON.parse(JSON.stringify(state[m])); });
    return snap;
  }
  function restoreSnapshot(snap) { MODE_MAPS.forEach(function (m) { state[m] = snap[m] || {}; }); applyFilters(); }

  // Each group's map and full key list, for the presets and All / None.
  var GROUP_MAP = { venue: 'venueMode', badge: 'badgeMode', team: 'teamMode', cap: 'capMode' };
  function groupInfo(g) {
    if (g === 'venue') return { map: state.venueMode, keys: state.venues.slice() };
    if (g === 'team') return { map: state.teamMode, keys: TEAMS.map(function (t) { return t.slug; }) };
    if (g === 'cap') return { map: state.capMode, keys: CAP_BANDS.map(function (b) { return b.key; }) };
    return { map: state.badgeMode, keys: TYPE_LIST.map(function (t) { return t.key; }) };
  }
  // The sheet's Only Venue: this venue checked and no other check in the
  // "where" groups, every event type welcome — so the list is exactly what's
  // on there. X's on other venues stay (they hide nothing here anyway).
  function onlyVenue(v) {
    ['venueMode', 'teamMode', 'capMode'].forEach(function (m) { modeKeys(state[m], 'in').forEach(function (k) { delete state[m][k]; }); });
    state.badgeMode = {};
    state.venueMode[v] = 'in';
  }
  // A press on a row's Show or Hide sets that one option to it, or clears
  // it if it was already lit; a tap on the name works Show. Nothing else
  // moves (Steve, 2026-09-22: "don't auto check or uncheck any filters").
  // The name's outbound link still just follows the link.
  document.addEventListener('click', function (e) {
    var sb = e.target.closest('#filterPanel .fp-seg-b'), want = 'in', seg;
    if (sb) { seg = sb.closest('.fp-seg'); want = sb.dataset.mode; }
    else {
      var chk = e.target.closest('#filterPanel .fp-check');
      if (chk && !e.target.closest('a')) seg = chk.closest('.fp-row').querySelector('.fp-seg[data-group]');
    }
    if (seg && seg.dataset.group === 'hood') { // the neighbourhood's pair: every room in it to Show or Hide, or cleared when that word was already lit
      var next = hoodMode(seg.dataset.key) === want ? null : want;
      (HOOD_ROOMS[seg.dataset.key] || []).forEach(function (v) { setMode(state.venueMode, v, next); });
      applyFilters();
      return;
    }
    if (seg) {
      var map = state[GROUP_MAP[seg.dataset.group]];
      setMode(map, seg.dataset.key, map[seg.dataset.key] === want ? null : want);
      applyFilters();
      return;
    }
    var fb = e.target.closest('#filterPanel .fp-fold'); // the chevron: the neighbourhood's rooms, open or folded
    if (fb) { setFold(fb.closest('.fp-row'), fb.getAttribute('aria-expanded') !== 'true'); return; }
    var ab = e.target.closest('.fp-set[data-scope]'); // a group's Show All / Hide All (Steve, 2026-09-14): every row in it set to Show, or every one to Hide
    if (ab) {
      var mode = ab.dataset.on === '1' ? 'in' : 'ex', scope = ab.dataset.scope;
      if (scope === 'campus' || scope === 'town' || scope === 'fest') state.venues.forEach(function (v) { if (venueGroup(v) === scope) setMode(state.venueMode, v, mode); });
      else if (scope === 'team') TEAMS.forEach(function (t) { setMode(state.teamMode, t.slug, mode); });
      else if (scope === 'cap') CAP_BANDS.forEach(function (b) { setMode(state.capMode, b.key, mode); });
      else TYPE_LIST.forEach(function (t) { setMode(state.badgeMode, t.key, mode); });
      applyFilters();
      return;
    }
  });
  function setPanelOpen(open) {
    $('filterPanel').hidden = !open;
    $('filterToggle').setAttribute('aria-expanded', String(open));
    if (open) { fitPops(true); presetEdge(); }
  }
  function togglePanel() { setPanelOpen($('filterPanel').hidden); }
  $('filterToggle').addEventListener('click', togglePanel);
  // a click anywhere outside the panel or its chip closes it
  document.addEventListener('click', function (e) {
    if (!$('filterPanel').hidden && !e.target.closest('#filterPanel, #filterToggle')) {
      setPanelOpen(false);
    }
  });
  $('holidaysToggle').addEventListener('change', function () {
    state.holidays = this.checked;
    applyFilters();
  });
  $('soldOnlyToggle').addEventListener('change', function () {
    state.soldOnly = this.checked;
    applyFilters();
  });
  // the search applies as you type, a beat after the last keystroke
  var searchTimer = null;
  // phones: the search box is an icon chip until tapped; it stays open while
  // it holds a query (CSS .search-wrap.is-open, ≤640px only)
  (function () {
    var wrap = document.querySelector('.filterbar .search-wrap'), box = $('searchBox');
    function open() { wrap.classList.add('is-open'); }
    function settle() { if (!box.value.trim()) wrap.classList.remove('is-open'); }
    box.addEventListener('focus', open);
    box.addEventListener('blur', function () { setTimeout(settle, 120); });
    box.addEventListener('input', function () { if (box.value.trim()) open(); });
    if (state.q) open();
  })();
  $('searchBox').addEventListener('input', function () {
    var v = this.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      if (v === state.q) return;
      state.q = v;
      applyFilters();
    }, 180);
  });
  // ---- light / dark pill ----
  // The head script already applied a saved choice; nothing saved means the
  // page follows prefers-color-scheme. The knob sits under the stop that's
  // in effect, so with nothing saved it shows the system's side.
  var darkQuery = matchMedia('(prefers-color-scheme: dark)');
  function currentTheme() {
    var t = document.documentElement.dataset.theme;
    return t === 'light' || t === 'dark' ? t : (darkQuery.matches ? 'dark' : 'light');
  }
  // The theme pill (Steve, 2026-09-15): light, dark, or system.
  function applyTheme(t, persist) {
    var stop = t === 'light' || t === 'dark' ? t : 'system';
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme; // follow the system
    $('themeToggle').dataset.active = stop;
    $('themeToggle').querySelectorAll('button').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.dataset.theme === stop));
    });
    t = stop;
    // only a click saves: the load-time call mirrors what the head script
    // applied (on phones that's always the system setting, and must not
    // erase a choice)
    if (persist) {
      try { localStorage.setItem('lqa-theme', t); } catch (e) { /* no storage */ }
    }
    // browser chrome follows: both theme-color metas take the chosen shade,
    // or go back to their own light/dark values while following the system
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (m) {
      m.content = t === 'dark' ? '#141a20' : t === 'light' ? '#edf1f4' : (m.dataset.light || m.dataset.dark);
    });
  }
  applyTheme(document.documentElement.dataset.theme);
  // A press anywhere on a pill moves it (Steve, 2026-09-15): a stop that
  // isn't lit becomes the choice; the lit stop, the knob or the rim step to
  // the next stop round the ring.
  function nextStop(toggle, attr, cur) {
    var stops = Array.prototype.map.call(toggle.querySelectorAll('button[' + attr + ']'), function (b) { return b.getAttribute(attr); });
    return stops[(stops.indexOf(cur) + 1) % stops.length];
  }
  $('themeToggle').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-theme]'), cur = $('themeToggle').dataset.active;
    applyTheme(b && b.dataset.theme !== cur ? b.dataset.theme : nextStop($('themeToggle'), 'data-theme', cur), true);
  });
  // following the system: the browser chrome tracks the OS setting as it changes
  darkQuery.addEventListener('change', function () {
    if (!document.documentElement.dataset.theme) applyTheme();
  });

  // ---- the way to the other cities (Steve, 2026-10-12) ----
  // A "More Cities" pill before the theme pill, to the map of every city
  // ("See All" until 2026-10-13, "Other Places" until 2026-10-18 — Steve: the pill
  // and the footer's More Cities "should be named identically"). The strip of state
  // outlines drifting after the eyebrow, built the same day, went away on
  // 2026-10-13 (Steve: "this needs to go away"); the city's `state` and
  // `stateOutline` in city.js and scripts/state-outline.mjs stay for a revisit.
  var CITIES_URL = 'https://here.events/';
  // Since 2026-10-14 the pill (and a More Cities link in the footer) opens a
  // sheet of every city on here.events, grouped by state, from cities.js
  // (generated in lqa by scripts/cities-list.mjs from the map's cities.json;
  // Steve: "city switcher: add it"); without cities.js the pill is a plain link
  // to the map, as before.
  var CITIES = window.LQACities, citySheet = null;
  function buildCitySheet() {
    var sh = document.createElement('div'); sh.id = 'citySheet'; sh.className = 'sheet city-sheet'; sh.hidden = true;
    var back = document.createElement('div'); back.className = 'sheet-back'; sh.appendChild(back);
    var card = document.createElement('div'); card.className = 'sheet-card'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-labelledby', 'citySheetTitle'); card.tabIndex = -1; sh.appendChild(card);
    var eyebrow = document.createElement('p'); eyebrow.className = 'sheet-venue'; eyebrow.textContent = 'here.events'; card.appendChild(eyebrow);
    var h = document.createElement('h2'); h.className = 'sheet-title'; h.id = 'citySheetTitle'; h.textContent = 'More Cities'; card.appendChild(h);
    var map = document.createElement('a'); map.className = 'city-map'; map.href = CITIES.map || CITIES_URL;
    map.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/></svg><span>The map — every city on here.events</span>';
    card.appendChild(map);
    var groups = document.createElement('div'); groups.className = 'city-groups'; card.appendChild(groups);
    var byState = {}, order = [];
    (CITIES.cities || []).forEach(function (c) { if (!byState[c.stateName]) { byState[c.stateName] = []; order.push(c.stateName); } byState[c.stateName].push(c); });
    order.forEach(function (st) {
      var sec = document.createElement('section'); var h3 = document.createElement('h3'); h3.textContent = st; sec.appendChild(h3);
      var ul = document.createElement('ul');
      byState[st].forEach(function (c) {
        var li = document.createElement('li'), here = c.key === CITY.key;
        var a = document.createElement(here || !c.live ? 'span' : 'a'); a.textContent = c.name;
        if (here) { li.className = 'is-here'; a.setAttribute('aria-current', 'page'); a.title = 'This site'; }
        else if (!c.live) { li.className = 'is-soon'; a.title = 'Coming soon'; }
        else a.href = c.url;
        li.appendChild(a);
        if (c.city && c.name.indexOf(c.city) < 0) { var n = document.createElement('small'); n.textContent = c.city; li.appendChild(n); } // Lower Queen Anne · Seattle
        if (!c.live) { var soon = document.createElement('small'); soon.textContent = 'soon'; li.appendChild(soon); }
        ul.appendChild(li);
      });
      sec.appendChild(ul); groups.appendChild(sec);
    });
    var close = document.createElement('button'); close.type = 'button'; close.className = 'chip city-close'; close.textContent = 'Close'; card.appendChild(close);
    function off() { sh.hidden = true; document.body.classList.remove('sheet-open'); document.removeEventListener('keydown', esc); }
    function esc(e) { if (e.key === 'Escape') off(); }
    back.addEventListener('click', off); close.addEventListener('click', off);
    sh.open = function () { sh.hidden = false; document.body.classList.add('sheet-open'); document.addEventListener('keydown', esc); card.focus(); };
    document.body.appendChild(sh);
    return sh;
  }
  function openCitySheet(e) {
    if (!CITIES || !CITIES.cities || !CITIES.cities.length) return; // no list: the link goes to the map
    e.preventDefault();
    if (!citySheet) citySheet = buildCitySheet();
    citySheet.open();
  }
  function mountCityLinks() {
    var tools = document.querySelector('.masthead-tools'), tt = $('themeToggle');
    if (tools && tt) {
      var pill = document.createElement('a'); pill.className = 'chip see-all'; pill.href = CITIES_URL; pill.title = CITIES ? 'Every city on here.events' : 'Every city on here.events (the map)';
      pill.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/></svg><span>More Cities</span>';
      pill.addEventListener('click', openCitySheet);
      tools.insertBefore(pill, tt);
    }
    // the footer: a More Cities link ahead of Advertise, the same sheet
    var links = document.querySelector('footer .foot-links');
    if (links) {
      // seo.mjs writes this link into the HTML at build (a crawlable path to the
      // map); reuse it when it is there, else make it
      var more = document.getElementById('moreCities');
      if (!more) { more = document.createElement('a'); more.className = 'foot-link'; more.id = 'moreCities'; links.insertBefore(more, links.firstChild); }
      more.href = CITIES_URL; more.title = 'Every city on here.events';
      more.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/></svg><span>More Cities</span>';
      more.addEventListener('click', openCitySheet);
    }
  }
  mountCityLinks();

  // ---- the mini calendar: docked or floating ----
  // Wide layout (the page at its full width): docked beside the list, always
  // shown, no toggle. Narrower: never docked — beside the list it would
  // squeeze the cards to a sliver — so a handle at the list's top-right
  // opens it as a floating panel over the list, and it closes again on a
  // day pick or a tap elsewhere (transient, so nothing is stored).
  var STACKED = '(max-width: 1023px)';
  var calFloatOpen = false;
  var calWasStacked = null;
  function syncCal() {
    var stacked = matchMedia(STACKED).matches;
    if (stacked !== calWasStacked) { calWasStacked = stacked; renderCal(); } // one month floating, two docked
    var open = !stacked || calFloatOpen;
    $('calBox').hidden = !open;
    document.querySelector('.cal-side').classList.toggle('is-float', stacked && open);
    if (stacked && open) fitPops(true);
    var t = $('calToggle');
    t.hidden = !stacked;
    t.setAttribute('aria-expanded', String(open));
    t.title = open ? 'Hide calendar' : 'Show calendar';
    t.querySelector('span').textContent = t.title;
  }
  $('calToggle').addEventListener('click', function () {
    calFloatOpen = $('calBox').hidden;
    syncCal();
  });
  function closeFloatCal() { if (calFloatOpen) { calFloatOpen = false; syncCal(); } }
  $('calGrid').addEventListener('click', function (e) {
    if (e.target.closest('button.cal-day')) closeFloatCal();
  });
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.cal-side, #calToggle')) closeFloatCal();
  });
  syncCal();
  window.addEventListener('resize', syncCal);

  // ---- the Month view: the month's events on one calendar ----
  // The switch's middle stop (List · Month · Teams, Steve 2026-09-14): the
  // current month, as the filters leave it, on a full-width calendar with
  // ‹ › paging (renderBoard); the list and its mini calendar step aside
  // (styles.css html.month-open). Opens on the current month every time.
  // The choice is kept per browser (lqa-view); ?view=month opens it for
  // one visit. On phones the days carry ticks and a tapped day's events
  // list under the grid.
  // The board (Steve, 2026-09-15): one continuous grid of weeks from this
  // month on — square days, the events' names only — with no last month:
  // as the sentinel under the grid nears the window another month is
  // appended (appendMonth). The sticky ‹ MONTH › header names the month at
  // the top of the window (syncBoardHead) and its arrows, the picker and
  // the TODAY tab scroll the page to a month (boardGo). A tapped day opens
  // a card over it listing everything on that day (openDayPop).
  var boardEnd = null; // the first of the last month on the grid
  function monthOpen() { return document.documentElement.classList.contains('month-open'); }
  function placeKnob() { // the ink knob measured under the lit stop: the stops are as wide as their words, when shown (styles.css .vt-label; Steve, 2026-10-24)
    var t = $('viewToggle'), b = t && t.querySelector('button[aria-checked="true"]');
    if (!b) return;
    t.style.setProperty('--knob-x', b.offsetLeft + 'px'); t.style.setProperty('--knob-w', b.offsetWidth + 'px');
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(placeKnob); // the words' width settles when the face loads
  function syncViewSwitch() { // the knob and the stops follow the view on show
    var v = (window.LQAMap && LQAMap.isOpen()) ? 'map' : !$('teamsView').hidden ? 'teams' : monthOpen() ? 'month' : 'events'; // the Map view (local-map.js) is a fourth stop in a city that has one
    $('viewToggle').dataset.active = v;
    $('viewToggle').querySelectorAll('button[data-view]').forEach(function (b) { b.setAttribute('aria-checked', String(b.dataset.view === v)); });
    placeKnob();
  }
  // the TODAY tab hangs from the mini calendar's foot; in the month view, from the sticky header's
  // the TODAY tab hangs from the mini calendar's foot; in the month view it rises from the sticky header — or, on a centred board with no header, floats as a chip under the filter bar
  function placeTodayTab() { (monthOpen() ? ($('monthBoard').classList.contains('is-narrow') ? $('mbSticky') : $('mbSticky').querySelector('.mb-head')) : $('calBox')).appendChild($('calToday')); }
  function setMonthView(on, remember) {
    document.documentElement.classList.toggle('month-open', on);
    $('monthBoard').hidden = !on;
    placeTodayTab();
    closeDayPop();
    if (remember) { try { localStorage.setItem('lqa-view', on ? 'month' : 'list'); } catch (e) { /* no storage */ } }
    if (on) {
      var now = new Date();
      state.month = new Date(now.getFullYear(), now.getMonth(), 1);
      boardEnd = null;
      closeFloatCal();
      renderCal(); renderBoard();
    }
    syncViewSwitch();
    if (remember) syncTodayFloat(); // by hand: the floater re-judged (at load the list isn't in yet)
  }
  function boardEntry(e, full) {
    var b = document.createElement('button'); b.type = 'button';
    b.className = 'mb-ev' + (e.status ? ' is-off' : '');
    b.style.setProperty('--dot', venueColor(e.venue));
    b.textContent = boardTitle(e.title);
    if (full) { var sub = document.createElement('span'); sub.className = 'mb-sub'; sub.textContent = fmtTime(e.time, e.date) + ' · ' + e.venue + (e.status ? ' · ' + e.status : ''); b.appendChild(sub); }
    else b.title = fmtTime(e.time, e.date) + ' · ' + e.venue + (e.status ? ' (' + e.status + ')' : '');
    b.addEventListener('click', cardTap(e), true);
    return b;
  }
  // the home teams by their short names in this view (Steve, 2026-09-15: "just use Kraken instead of Seattle Kraken")
  // the board drops the home city from a club's name ("Seattle Kraken" → Kraken): the city is city.js's words.teamCity, the clubs the team labels
  var BOARD_CITY_RE = CITY.words.teamCity ? new RegExp('\\b' + CITY.words.teamCity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' (' + TEAMS.map(function (t) { return t.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')\\b', 'g') : null;
  function boardTitle(t) { return BOARD_CITY_RE ? t.replace(BOARD_CITY_RE, '$1') : t; }
  // the club's statistical leaders and its injured, from ESPN's matchup page
  // (digestMatchup): a line each for the block's column (Steve, 2026-09-16:
  // "why limited stats here" — the Seahawks' block after one game)
  function leaderLines(leaders, injured) {
    var esc = function (x) { return String(x).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); };
    var out = [];
    // one figure per leader: of a compound value ("16/22, 187 YDS, 1 TD") the yards, else its first piece; the unit shortened ("pass yds" → "pass")
    var fig = function (st) { var parts = String(st.v || '').split(', '), pick = parts.filter(function (x) { return /\bYDS\b/.test(x); })[0] || parts[0] || ''; return pick.replace(/\s*YDS\b/, '').trim() + ' ' + String(st.a || '').replace(/ yds$/, ''); };
    if (leaders && leaders.length) out.push({ cls: 'tf-leaders', html: '<b>Leaders</b> ' + esc(leaders.slice(0, 3).map(function (l) { return String(l.name).replace(/^[A-Z]\. /, '') + (l.stats[0] ? ' ' + fig(l.stats[0]) : ''); }).join(' · ')) });
    if (injured && injured.length) {
      var top = injured.slice(0, 2).map(function (i) { return i.name + (i.pos ? ' ' + i.pos : ''); });
      out.push({ cls: 'tf-injured', html: '<b>Injured</b> ' + esc(injured.length + ' · ' + top.join(', ') + (injured.length > 2 ? ', …' : '')) });
    }
    return out;
  }
  function boardFirst() { var now = new Date(); return new Date(now.getFullYear(), now.getMonth(), 1); }
  function boardCell(d, hols, today) {
    var key = ymd(d), evs = dayItems(key);
    var cell = document.createElement('div');
    cell.className = 'cal-day' + (key === today ? ' is-today' : '') + (key < today ? ' is-past' : '') + (evs.length ? '' : ' is-empty');
    cell.dataset.date = key;
    var num = document.createElement('span'); num.className = 'num'; num.textContent = d.getDate(); cell.appendChild(num);
    (hols[key] || []).forEach(function (h) { var s = document.createElement('span'); s.className = 'hol'; s.textContent = h.title; cell.appendChild(s); });
    if (evs.length) { // the phone's ticks: three at most, then a "+" for the rest, as on the mini calendar
      var ticks = document.createElement('span'); ticks.className = 'ticks';
      evs.slice(0, 3).forEach(function (e) { var t = document.createElement('i'); t.style.setProperty('--dot', venueColor(e.venue)); ticks.appendChild(t); });
      if (evs.length > 3) { var more = document.createElement('b'); more.className = 'tick-more'; more.textContent = '+'; more.title = (evs.length - 3) + ' more'; ticks.appendChild(more); }
      cell.appendChild(ticks);
    }
    evs.forEach(function (e) { cell.appendChild(boardEntry(e)); });
    if (evs.length) { var fold = document.createElement('button'); fold.type = 'button'; fold.className = 'mb-more'; fold.hidden = true; cell.appendChild(fold); } // "+N more", set by fitBoardCells
    return cell;
  }
  // appends one month as its own block (Steve, 2026-09-15: every month its
  // own month): a framed grid of its days padded to whole weeks with blank
  // slots, and beside it, when the board stands in from the page's edges,
  // its name as tall vertical text (the picker's button there)
  function appendMonth(m) {
    var hols = state.holidays ? holidayMap() : {}, today = todayStr();
    var block = document.createElement('section'); block.className = 'mb-month'; block.dataset.month = ymd(m).slice(0, 7);
    var name = m.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    block.setAttribute('aria-label', name);
    var label = document.createElement('button'); label.type = 'button'; label.className = 'mb-mname'; label.textContent = name; label.title = 'Pick a month and year';
    label.addEventListener('click', function () { openMonthPick(label); });
    block.appendChild(label);
    var wd = document.createElement('div'); wd.className = 'mb-wdays'; wd.setAttribute('aria-hidden', 'true'); // the weekday row goes with each month (Steve, 2026-09-15)
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(function (d) { var sp = document.createElement('span'); sp.textContent = d; wd.appendChild(sp); });
    block.appendChild(wd);
    var grid = document.createElement('div'); grid.className = 'cal-days mb-days';
    var last = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate(), cells = Math.ceil((m.getDay() + last) / 7) * 7;
    for (var i = 0; i < cells; i++) {
      var dn = i - m.getDay() + 1;
      if (dn < 1 || dn > last) { var blank = document.createElement('div'); blank.className = 'cal-day is-blank'; grid.appendChild(blank); continue; }
      grid.appendChild(boardCell(new Date(m.getFullYear(), m.getMonth(), dn), hols, today));
    }
    block.appendChild(grid);
    $('mbGrid').appendChild(block);
    boardEnd = m;
  }
  // the squares' size: the page's width, or less when the whole of this
  // month would not show at the top of the page — the window's height less
  // the board's top there, the header and the footer, over the month's rows
  // (Steve, 2026-09-15: the full month in a single window); the board is
  // then centred, and the months' names stand in the left gutter, as big
  // as the gutter and the block allow. Never under 3.4rem a square: a tiny
  // window scrolls the month instead.
  // what the first block adds above its grid (its heading on a centred board, the weekday row, the gap and the frame) — measured once it exists
  function boardExtras() {
    var b = $('mbGrid').firstElementChild, g = b && b.querySelector('.mb-days');
    return b && g ? b.offsetHeight - g.offsetHeight + parseFloat(getComputedStyle(b).marginTop) : 2.7 * parseFloat(getComputedStyle(document.documentElement).fontSize);
  }
  function sizeBoard() {
    if (!monthOpen()) return;
    var board = $('monthBoard'), first = boardFirst(), rows = Math.ceil((first.getDay() + new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()) / 7);
    board.style.width = ''; board.classList.remove('is-short'); board.style.removeProperty('--cellh');
    var top = $('mbGrid').getBoundingClientRect().top + window.scrollY, foot = document.querySelector('footer').offsetHeight;
    var rem = parseFloat(getComputedStyle(document.documentElement).fontSize), room = window.innerHeight - top - foot - boardExtras() - 4;
    var page = board.clientWidth, cell = Math.max(3.4 * rem, Math.min(page / 7, room / rows));
    if (cell * 7 < page - 1) board.style.width = Math.floor(cell * 7 + 4) + 'px'; // + the frame's two 2px sides
    else if (room / rows < page / 7 - 1 && window.matchMedia('(min-width: 641px)').matches) { // width alone would run the month past the window: the days give up height, to 60% of their width (Steve's review, 2026-09-16)
      board.classList.add('is-short'); board.style.setProperty('--cellh', Math.max(0.6 * page / 7, room / rows) + 'px');
    }
    var gutter = (page - board.offsetWidth) / 2, narrow = gutter >= 3 * rem;
    board.classList.toggle('is-narrow', narrow);
    placeTodayTab();
    board.style.setProperty('--mname', narrow ? Math.min(4.2 * rem, gutter - 1.4 * rem, rows * cell / 8.5) + 'px' : '');
  }
  function renderBoard() {
    if (!monthOpen()) return;
    sizeBoard();
    var grid = $('mbGrid'), first = boardFirst(), bounds = monthBounds();
    // through the feed's last month at least, and as far as the grid already ran (a rebuild on a filter change keeps the page's place)
    var end = boardEnd || (bounds ? new Date(bounds.max.getFullYear(), bounds.max.getMonth(), 1) : first);
    if (end < first) end = first;
    grid.innerHTML = '';
    for (var m = first; m <= end; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) appendMonth(m);
    sizeBoard(); // again, now the first block's extras can be measured
    fitBoardCells();
    feedBoard();
    syncBoardHead();
    closeDayPop();
  }
  // as many names as fit a day, the rest folded into "+N more" (the fold takes the last fitting row)
  function fitCell(cell) {
    var evs = Array.from(cell.querySelectorAll('.mb-ev')), fold = cell.querySelector('.mb-more');
    if (!evs.length) return;
    evs.forEach(function (b) { b.hidden = false; }); fold.hidden = true;
    var floor = cell.clientHeight - parseFloat(getComputedStyle(cell).paddingBottom), top = cell.getBoundingClientRect().top;
    var fit = evs.filter(function (b) { return b.getBoundingClientRect().bottom - top <= floor + .5; }).length;
    if (fit >= evs.length) return;
    var show = Math.max(0, fit - 1);
    evs.forEach(function (b, n) { b.hidden = n >= show; });
    fold.textContent = '+' + (evs.length - show) + ' more'; fold.hidden = false;
  }
  function fitBoardCells(from) { // from: only the month blocks appended since (the rest are settled)
    if (!monthOpen() || window.matchMedia('(max-width: 640px)').matches) return;
    var blocks = $('mbGrid').children;
    for (var i = from || 0; i < blocks.length; i++) blocks[i].querySelectorAll('.cal-day:not(.is-blank)').forEach(fitCell);
  }
  var boardFitPending = false;
  window.addEventListener('resize', function () { if (!boardFitPending) { boardFitPending = true; requestAnimationFrame(function () { boardFitPending = false; sizeBoard(); fitBoardCells(); feedBoard(); closeDayPop(); }); } });
  // more months as the foot of the board nears the window — no last month
  function growBoard(m) { var before = $('mbGrid').children.length; appendMonth(m); fitBoardCells(before); }
  function feedBoard() {
    if (!monthOpen()) return;
    var n = 0;
    while (n++ < 12 && $('mbSentinel').getBoundingClientRect().top < window.innerHeight + 900) growBoard(new Date(boardEnd.getFullYear(), boardEnd.getMonth() + 1, 1));
  }
  if ('IntersectionObserver' in window) new IntersectionObserver(function (es) { if (es.some(function (x) { return x.isIntersecting; })) feedBoard(); }, { rootMargin: '900px 0px' }).observe($('mbSentinel'));
  // the header names the month whose block sits under it: the block that
  // holds the point half a row down from the header, else the first block
  // not yet scrolled past
  function boardTop() { return $('mbSticky').getBoundingClientRect().bottom; }
  function boardBlock(m) { return $('mbGrid').querySelector('.mb-month[data-month="' + ymd(m).slice(0, 7) + '"]'); }
  function syncBoardHead() {
    if (!monthOpen()) return;
    var blocks = Array.from($('mbGrid').children); if (!blocks.length) return;
    var y = boardTop() + $('monthBoard').offsetWidth / 14, block = null;
    for (var i = 0; i < blocks.length; i++) { var r = blocks[i].getBoundingClientRect(); if (r.bottom > y) { block = blocks[i]; break; } }
    block = block || blocks[blocks.length - 1];
    var m = new Date(Number(block.dataset.month.slice(0, 4)), Number(block.dataset.month.slice(5, 7)) - 1, 1);
    if (!state.month || !sameMonth(m, state.month)) { state.month = m; renderCal(); }
    $('mbCur').textContent = m.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    $('mbPrev').disabled = m <= boardFirst();
    $('mbNext').disabled = false;
    syncTodayFloat();
  }
  var boardHeadPending = false;
  window.addEventListener('scroll', function () { if (monthOpen() && !boardHeadPending) { boardHeadPending = true; requestAnimationFrame(function () { boardHeadPending = false; syncBoardHead(); }); } }, { passive: true });
  // the page scrolls so a month's block sits right under the header
  function boardScrollTo(block) {
    if (!block) return;
    var st = $('mbSticky'), off = parseFloat(getComputedStyle(st).top) + st.offsetHeight;
    window.scrollTo({ top: block.getBoundingClientRect().top + window.scrollY - off - 6, behavior: 'instant' }); // instant, like the list's jumps (a smooth scroll needs frames, which a background tab never gets — seen while testing 2026-09-15)
    syncBoardHead();
  }
  function boardGo(m) {
    if (!monthOpen()) return;
    if (m < boardFirst()) m = boardFirst();
    while (boardEnd < m) growBoard(new Date(boardEnd.getFullYear(), boardEnd.getMonth() + 1, 1));
    boardScrollTo(boardBlock(m));
  }
  // the day's card: over the tapped day, the day grown to hold all of its events
  function closeDayPop() { var old = document.querySelector('.mb-pop'); if (old) old.remove(); document.removeEventListener('click', dayPopOff, true); document.removeEventListener('keydown', dayPopOff); window.removeEventListener('scroll', closeDayPop); }
  function dayPopOff(e) { if (e.type === 'keydown' ? e.key !== 'Escape' : e.target.closest('.mb-pop')) return; closeDayPop(); }
  function openDayPop(cell) {
    var was = document.querySelector('.mb-pop'), key = cell.dataset.date;
    closeDayPop();
    if (was && was.dataset.date === key) return; // the same day again: closed
    var pop = document.createElement('div'); pop.className = 'mb-pop'; pop.setAttribute('role', 'dialog'); pop.dataset.date = key;
    var list = dayItems(key), h = document.createElement('h3');
    h.textContent = parseDate(key).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    if (list.length) { var n = document.createElement('span'); n.className = 'mb-pop-n'; n.textContent = list.length + (list.length === 1 ? ' event' : ' events'); h.appendChild(n); }
    pop.setAttribute('aria-label', h.textContent); pop.appendChild(h);
    if (!list.length) { var none = document.createElement('p'); none.className = 'mb-none'; none.textContent = 'Nothing listed'; pop.appendChild(none); }
    list.forEach(function (e) { pop.appendChild(boardEntry(e, true)); });
    document.body.appendChild(pop);
    if (window.matchMedia('(max-width: 640px)').matches) { setTimeout(function () { document.addEventListener('click', dayPopOff, true); document.addEventListener('keydown', dayPopOff); window.addEventListener('scroll', closeDayPop, { passive: true }); }, 0); return; } // a phone: a sheet from the foot (styles.css), nothing to place
    var r = cell.getBoundingClientRect(), g = $('mbGrid').getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
    var w = Math.max(r.width, Math.min(20 * 16, g.width)), left = Math.min(r.left, vw - w - 8, g.right - w); left = Math.max(8, left);
    pop.style.width = w + 'px'; pop.style.left = left + 'px';
    var foot = document.querySelector('footer'), floor = foot ? Math.min(vh, foot.getBoundingClientRect().top) : vh; // the footer is pinned at the foot: the card stays clear of it (Steve, 2026-09-18)
    var hgt = pop.offsetHeight, top = r.top; if (top + hgt > floor - 8) top = Math.max(8, floor - 8 - hgt);
    pop.style.top = top + 'px';
    setTimeout(function () { document.addEventListener('click', dayPopOff, true); document.addEventListener('keydown', dayPopOff); window.addEventListener('scroll', closeDayPop, { passive: true }); }, 0);
  }
  $('mbGrid').addEventListener('click', function (e) { // a day tapped (an entry on it opens the event itself)
    var cell = e.target.closest('.cal-day'); if (!cell || !cell.dataset.date || e.target.closest('.mb-ev')) return;
    openDayPop(cell);
  });
  $('mbPrev').addEventListener('click', function () { boardGo(new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1)); });
  $('mbNext').addEventListener('click', function () { boardGo(new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1)); });
  (function () {
    var want = new URLSearchParams(location.search).get('view'), saved = null;
    try { saved = localStorage.getItem('lqa-view'); } catch (e) { /* unreadable storage */ }
    setMonthView(want ? want === 'month' : saved === 'month', false);
  })();

  // ---- the filter bar folds Reset / Copy to icons only when it must ----
  // Measured with the labels shown: if the row would overflow its box, the
  // labels go (see .filterbar.is-tight). Re-checked on resize.
  function fitFilterBar() {
    var bar = document.querySelector('.filterbar');
    if (document.documentElement.classList.contains('teams-open')) { fitTeamStrip(); return; } // the Teams view folds in its own order (the strip scrolls, so the bar never measures as tight)
    bar.classList.remove('is-tight');
    if (bar.scrollWidth > bar.clientWidth + 1) bar.classList.add('is-tight');
    placeKnob(); // the stops words come and go with is-tight
  }
  fitFilterBar();
  window.addEventListener('resize', fitFilterBar);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitFilterBar);


  // ---- Teams: each home team's season, home and away ----
  // The Teams chip swaps the agenda (list and calendar) for a schedule view:
  // a strip of the home teams' crests, then the chosen team's whole season
  // from teams.json (scripts/schedules.mjs, home and away, never filtered).
  // Rows reuse the agenda's day/card markup. Each opponent's crest is a
  // button: tap it and only that opponent's games stay lit, a bar above the
  // list names them (with the club's own site for more) and the page jumps
  // to the next one; tap again, or the bar's ✕, for the whole season. The
  // view is linkable (?team=mariners) and lives in history like a page.
  var teamsData = null, teamsLoading = null;
  var teamView = { slug: null, slugs: [], opp: null, showPast: false, cal: false }; // slug: the URL key ('all', 'kraken', 'kraken,mariners'); slugs: the clubs picked, in the strip's order // played games fold away behind a button; cal = the season calendar in place of the list
  function loadTeams() {
    if (teamsData) return Promise.resolve(teamsData);
    if (!teamsLoading) {
      teamsLoading = fetch('teams.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : { teams: {} }; })
        .catch(function () { return { teams: {} }; })
        .then(function (d) { teamsData = d; return d; });
    }
    return teamsLoading;
  }
  function teamsUrl(slug) {
    var params = new URLSearchParams(location.search);
    if (slug) params.set('team', slug); else params.delete('team');
    var q = params.toString();
    return location.pathname + (q ? '?' + q : '') + location.hash;
  }
  // open (slug) or close (null) the view; push = a history entry (a chip
  // tap), else the URL is only kept in step (load, back/forward). 'all' is
  // every club's schedule in one list; 'auto' is the view's own choice
  // (defaultTeamSlug), made once the schedules are in.
  function setTeamsView(slug, push) {
    if (slug && window.LQAMap && LQAMap.isOpen()) LQAMap.open(false, false); // a ?team= link or popstate opens Teams over the map
    var open = !!slug;
    document.documentElement.classList.toggle('teams-open', open);
    var bn = document.querySelector('.bar-name'), h1 = document.querySelector('.masthead h1'); // the masthead and the pinned bar's title name the view: the events, or the clubs
    if (bn) { if (!bn.dataset.events) bn.dataset.events = bn.textContent; bn.textContent = open ? 'Hometown Teams' : bn.dataset.events; }
    if (h1) { if (!h1.dataset.events) h1.dataset.events = h1.innerHTML; h1.innerHTML = open ? 'Hometown Teams' : h1.dataset.events; }
    // the eyebrow over it: the city alone over the neighbourhood, "City, WA" (data-teams) over Hometown Teams (Steve, 2026-10-11); a city with no neighbourhood keeps it empty and hidden on the list
    document.querySelectorAll('.masthead .eyebrow, .bar-title .bar-eyebrow[data-teams]').forEach(function (el) {
      if (!('events' in el.dataset)) el.dataset.events = el.textContent;
      var t = open ? (el.dataset.teams || el.dataset.events) : el.dataset.events;
      el.textContent = t; el.hidden = !t;
    });
    if (open) fitTeamStrip(); else fitFilterBar(); // back to the list: the bar measured its own way (a fold left from the Teams view would stick)
    $('teamsView').hidden = !open;
    document.querySelector('.agenda').hidden = open;
    syncViewSwitch(); // the switch's knob slides to the view on show
    if (push) history.pushState(null, '', teamsUrl(slug === 'auto' ? 'all' : slug));
    if (open) {
      applyTeamView();
      // the floating panels close: they belong to the agenda
      $('filterPanel').hidden = true; $('filterToggle').setAttribute('aria-expanded', 'false');
      if (!$('subscribePop').hidden) setSubscribeOpen(false);
      teamView.opp = null;
      loadTeams().then(function () {
        if ($('teamsView').hidden) return;
        if (slug === 'auto') { slug = defaultTeamSlug(); history.replaceState(null, '', teamsUrl(slug)); }
        renderTeams(slug);
        warmTeams(); // every club's crests and odds fetched now, so a switch draws its block whole the first time
      });
    } else {
      teamView.slug = null;
      document.documentElement.classList.remove('teams-all');
      clearTimeout(live.timer);
    }
    fitFilterBar();
    updateSubscribe();
  }
  function teamGames(slug) { return (teamsData && teamsData.teams && teamsData.teams[slug]) || null; }
  // The strip's pills pick one club or several (Steve, 2026-09-15): a tap
  // adds or drops a club, the last one picked can't be dropped. The list
  // merges the picked clubs' seasons; the head shows each club's block, or
  // — with several picked and a game in progress — only the clubs playing.
  function selectedTeams() { return LQAFilter.TEAMS.filter(function (t) { return teamView.slugs.indexOf(t.slug) >= 0; }); }
  function teamSelected(slug) { return teamView.slugs.indexOf(slug) >= 0; }
  function teamStage(slug) { var ev = live.events[slug]; return (ev && ev.competitions[0].status.type.state) || null; } // pre | in | post | null, from the last poll
  // The club as its league lists it — name, abbreviation, the home
  // ground's city — from the build (teams.json form[slug].club, read from
  // the league's own feed each run), else filter.js's fallback. Nothing is
  // assumed to be Seattle's.
  function clubInfo(t) { var f = teamsData && teamsData.form && teamsData.form[t.slug]; return (f && f.club) || {}; }
  function clubName(t) { return clubInfo(t).name || t.name || t.label; }
  function clubAbbr(t) { return clubInfo(t).abbr || t.abbr || t.label.slice(0, 3).toUpperCase(); }
  function clubCity(t) { return clubInfo(t).city || t.city || ''; }
  // Which clubs are in season: a game within the last three weeks or the
  // next six (a preseason counts, a postseason too). The rest — off-season,
  // or a season just over — show in the strip as a crest alone, at its
  // right end (styles.css .team-tab.is-off).
  var ACTIVE_BACK = 21, ACTIVE_AHEAD = 45;
  function teamActive(slug) {
    var gs = teamGames(slug) || [], today = todayStr(), lo = dayAfter(today, -ACTIVE_BACK), hi = dayAfter(today, ACTIVE_AHEAD);
    return gs.some(function (g) { return g.date >= lo && g.date <= hi; });
  }
  // The view's own choice on open: a club with a game on today — one in
  // progress first, then one still to come — taking the strip's order (left
  // to right) between two; with nobody playing, every club's schedule in one
  // list. A game's stage comes from the feed once it has been asked (pollLive),
  // until then from the clock: on from the start time for about a game's length.
  var GAME_HOURS = { football: 3.5, baseball: 3.5, hockey: 3, basketball: 2.5, soccer: 2.25, rugby: 2 };
  function gameStage(team, g) { // 'pre' | 'in' | 'post'
    var ev = live.events[team.slug];
    if (ev && seattleDay(ev.date) === g.date && ev.competitions[0].status.type.state) return ev.competitions[0].status.type.state;
    if (g.res) return 'post';
    var start = new Date(g.date + 'T' + (g.tbd || !g.time ? '23:59:59' : g.time)).getTime(), now = Date.now();
    if (now < start) return 'pre';
    return now < start + (GAME_HOURS[team.sport] || 3) * 3600000 ? 'in' : 'post';
  }
  function defaultTeamSlug() {
    var today = todayStr(), pick = null;
    ['in', 'pre'].forEach(function (want) {
      LQAFilter.TEAMS.forEach(function (t) {
        if (pick) return;
        var g = (teamGames(t.slug) || []).filter(function (g) { return g.date === today; })[0];
        if (g && gameStage(t, g) === want) pick = t.slug;
      });
    });
    return pick || 'all';
  }
  function oppKey(g) { return g.opp && (g.opp.abbrev || g.opp.name) || '?'; }
  // simple line icons for the strip: the sport, after the team's name
  var SPORT_ICONS = {
    football: '<ellipse cx="12" cy="12" rx="10" ry="6" transform="rotate(-45 12 12)"/><path d="M9.5 14.5l5-5M10.5 11.5l2 2M11.5 10.5l2 2M9.5 12.5l2 2"/>',
    baseball: '<circle cx="12" cy="12" r="9"/><path d="M6.2 5.6c2.3 2.2 2.3 10.6 0 12.8M17.8 5.6c-2.3 2.2-2.3 10.6 0 12.8"/>',
    hockey: '<ellipse cx="12" cy="9" rx="8" ry="3.2"/><path d="M4 9v5.5c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2V9"/>',
    basketball: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3v18M5.6 5.6c3.5 3.5 3.5 9.3 0 12.8M18.4 5.6c-3.5 3.5-3.5 9.3 0 12.8"/>',
    rugby: '<ellipse cx="12" cy="12" rx="10" ry="6" transform="rotate(-45 12 12)"/><path d="M8.5 15.5l7-7M10 13l1.5 1.5M12 11l1.5 1.5M14 9l1.5 1.5"/>',
    soccer: '<circle cx="12" cy="12" r="9"/><path d="M12 8.2l3.8 2.8-1.5 4.5h-4.6l-1.5-4.5z"/><path d="M12 8.2V3.4M15.8 11l4.2-1.4M14.3 15.5l2.6 3.6M9.7 15.5l-2.6 3.6M8.2 11L4 9.6"/>',
  };
  function sportIcon(sport) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'sport'); svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    svg.innerHTML = SPORT_ICONS[sport] || '';
    return svg;
  }
  function renderTeams(slug) {
    // every home team from the filter gets a tab, schedule loaded or not
    var teams = LQAFilter.TEAMS.filter(function (t) { return t.strip !== false; }); // a club with no season feed (strip: false in city.js) has a filter row but no tab
    var strip = $('teamStrip');
    var list = $('teamSched'); list.innerHTML = '';
    var allMode = !slug || slug === 'all'; // every club's games in one list: no chip pressed, no form block, no calendar
    var picked = allMode ? [] : teams.filter(function (t) { return String(slug).split(',').indexOf(t.slug) >= 0; }).map(function (t) { return t.slug; }); // the strip's order, unknown names dropped
    if (!allMode && !picked.length) picked = [teams[0].slug];
    teamView.slugs = picked;
    teamView.slug = slug = allMode ? 'all' : picked.join(',');
    var sel = selectedTeams(), single = picked.length === 1, team = single ? sel[0] : null, multi = !single; // multi: several clubs in the list (or every club) — rows name their club
    document.documentElement.classList.toggle('teams-all', allMode);
    updateSubscribe(); // the calendar chip offers this club's season
    $('teamPdfBtn').disabled = allMode; // no poster for every club's list; the chip stays in place, dimmed
    applyTeamView();
    // The strip is built once and kept: a switch only moves the pressed
    // state (and refreshes the game counts), so the crests never reload or
    // shift under the pointer.
    if (!strip.children.length) {
      teams.forEach(function (t) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'team-tab'; b.dataset.slug = t.slug;
        if (t.logo) { var img = document.createElement('img'); img.src = t.logo; img.alt = ''; img.width = 40; img.height = 40; b.appendChild(img); }
        var l = document.createElement('span'); l.textContent = t.label; b.appendChild(l); // no sport icon (Steve, 2026-09-15)
        b.addEventListener('click', function () { // a tap picks that club alone (Steve, 2026-09-16: one at a time — several clubs at once only by ?team=a,b)
          if (teamView.slugs.length === 1 && teamView.slugs[0] === t.slug) return;
          teamView.opp = null; teamView.showPast = false; history.replaceState(null, '', teamsUrl(t.slug)); renderTeams(t.slug);
        });
        strip.appendChild(b);
      });
    }
    teams.forEach(function (t) {
      var b = strip.querySelector('.team-tab[data-slug="' + t.slug + '"]');
      var n = (teamGames(t.slug) || []).length;
      b.setAttribute('aria-pressed', String(teamSelected(t.slug)));
      b.classList.toggle('is-off', !teamActive(t.slug)); // out of season: the crest alone, after the clubs that are playing
      b.title = t.label + (n ? ' — ' + n + ' games' : ' — schedule not loaded yet');
    });
    fitTeamStrip();
    if (single && !teamGames(team.slug)) { // no season data for this one (yet): say so, point at the club's own schedule
      var none = document.createElement('li'); none.className = 'empty';
      none.appendChild(document.createTextNode('No ' + team.label + ' schedule loaded yet' + (team.schedule ? ' — ' : '.')));
      if (team.schedule) { var a = document.createElement('a'); a.href = team.schedule; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'their schedule ↗'; none.appendChild(a); }
      list.appendChild(none);
      renderTeamFocus(null); $('teamCal').innerHTML = ''; $('teamHead').innerHTML = ''; return;
    }
    // the rows: this club's season, or (all) every club's, each game with its club
    var items = [];
    (allMode ? teams : sel).forEach(function (t) { (teamGames(t.slug) || []).forEach(function (g) { items.push({ g: g, team: t }); }); });
    items.sort(function (a, b) { return (a.g.date + (a.g.time || '')) < (b.g.date + (b.g.time || '')) ? -1 : 1; });
    var all = items.map(function (it) { return it.g; });
    var today = todayStr(), lastMonth = null, group = null, dayBox = null, lastDate = null, lastPhase = null;
    // the season so far folds away: a line at the top says how many games
    // have been played and opens them (this team, this visit)
    var played = all.filter(function (g) { return g.date < today; });
    var shown = teamView.showPast ? items : items.filter(function (it) { return it.g.date >= today; });
    var games = shown.map(function (it) { return it.g; });
    if (played.length) {
      var fold = document.createElement('li'); fold.className = 'team-fold';
      var fb = document.createElement('button'); fb.type = 'button'; fb.className = 'chip';
      var nReg = played.filter(function (g) { return !g.pre; }).length; // the count the record counts: spring training and preseason games fold away with them but are not "played games" (Steve, 2026-09-18: 184 over a 71-82 record)
      fb.textContent = (teamView.showPast ? 'Hide the ' : 'Show the ') + nReg + ' played game' + (nReg === 1 ? '' : 's');
      fb.addEventListener('click', function () { teamView.showPast = !teamView.showPast; renderTeams(teamView.slug); });
      fold.appendChild(fb); list.appendChild(fold);
    }
    if (!games.length && single) list.appendChild(renderSeasonNext(team, all)); // nothing left to play: a look at the season past and the one ahead
    // the feed's own listing for a home game, when it has one: its ticket link (per club)
    var feedByDate = {};
    (allMode ? teams : sel).forEach(function (t) {
      feedByDate[t.slug] = {};
      state.events.forEach(function (e) { if (t.re.test(e.title || '') && e.venue === t.venue) feedByDate[t.slug][e.date] = e; });
    });
    shown.forEach(function (it) {
      var g = it.g, tm = it.team;
      var month = g.date.slice(0, 7);
      if (month !== lastMonth) {
        lastMonth = month;
        group = document.createElement('li'); group.className = 'month-group';
        var mr = document.createElement('div'); mr.className = 'month-row';
        var ms = document.createElement('span'); ms.textContent = parseDate(g.date).toLocaleDateString('en-US', { month: 'long' });
        mr.appendChild(ms); group.appendChild(mr); list.appendChild(group);
        lastDate = null;
      }
      // the season's phases, each announced like the postseason (Steve, 2026-09-16): PRESEASON, then "2026–27 REGULAR SEASON", then POSTSEASON once its games are real — one club's list only
      var phase = g.playoff ? 'post' : g.pre ? 'pre' : 'regular';
      if (single && phase !== lastPhase) {
        var announce = phase !== 'regular' || lastPhase === 'pre'; // the regular season is announced only after a preseason on the same list (Steve, 2026-09-16: once the preseason is over — unless the past is shown — the heading says nothing)
        lastPhase = phase;
        if (!announce) { /* the regular season simply begins */ } else {
        var ph = document.createElement('div'); ph.className = 'month-row is-phase'; var phs = document.createElement('span');
        phs.textContent = phase === 'pre' ? 'Preseason' : phase === 'post' ? 'Postseason' : seasonLabel(team, all) + ' Regular Season';
        ph.appendChild(phs); group.appendChild(ph);
        lastDate = null; // the day's rail again under the new heading, even mid-month
        }
      }
      if (g.date !== lastDate) {
        lastDate = g.date;
        var d = parseDate(g.date);
        var li = document.createElement('div');
        li.className = 'day-row' + (g.date === today ? ' is-today' : '') + (g.date < today ? ' is-past' : '');
        li.dataset.date = g.date;
        var rail = document.createElement('div');
        rail.className = 'date-rail';
        rail.innerHTML = '<span class="dnum">' + d.getDate() + '</span><span class="dmeta">' + d.toLocaleDateString('en-US', { weekday: 'long' }) + '</span>';
        li.appendChild(rail);
        dayBox = document.createElement('div'); dayBox.className = 'day-events';
        li.appendChild(dayBox); group.appendChild(li);
      }
      var row = document.createElement('div');
      row.className = 'ev' + (g.home ? ' is-home' : ' is-away');
      row.dataset.opp = (multi ? tm.slug + ':' : '') + oppKey(g); // with several clubs listed an opponent is one club's opponent
      // the home building's wash for a home game; away games stay on the page
      if (g.home) row.style.background = 'color-mix(in srgb, ' + venueColor(tm.venue) + ' var(--tint), transparent)';
      var time = document.createElement('span'); time.className = 'time';
      if (g.tbd || !g.time) time.textContent = 'TBD';
      else clockCell(time, fmtTime(g.time, g.date));
      row.appendChild(time);
      var body = document.createElement('div'); body.className = 'ev-body';
      var where = document.createElement('span'); where.className = 'venue' + (g.home ? '' : ' is-away');
      if (g.home) { where.style.setProperty('--dot', venueColor(tm.venue)); where.textContent = tm.venue; }
      else where.textContent = '@ ' + (g.venue || g.opp.name);
      body.appendChild(where);
      var title = document.createElement('span'); title.className = 'ev-title';
      var a = document.createElement('a');
      var feed = g.home && feedByDate[tm.slug][g.date];
      a.href = feed && feed.url ? feed.url : (g.home ? tm.schedule : (g.opp.site || tm.schedule));
      a.target = '_blank'; a.rel = 'noopener';
      a.textContent = (multi ? tm.label + ' ' : '') + (g.home ? 'vs ' : 'at ') + g.opp.name; // several clubs listed: each row names its club
      a.title = g.home ? (feed && feed.url ? 'Tickets' : tm.label + ' schedule') : (g.opp.site ? g.opp.name + ' — their site' : tm.label + ' schedule');
      title.appendChild(a);
      if (g.playoff && !single) { var pb = document.createElement('span'); pb.className = 'badge b-playoff'; pb.textContent = 'playoff'; title.appendChild(pb); } // several clubs' lists carry no phase headings: the badges say it
      if (g.pre && !single) { var pr = document.createElement('span'); pr.className = 'badge b-pre'; pr.textContent = 'preseason'; title.appendChild(pr); }
      if (g.tbd) { var tb = document.createElement('span'); tb.className = 'badge b-tbd'; tb.textContent = 'time tbd'; title.appendChild(tb); }
      // a home game's ticket state (the feed's Ticketmaster counts): frame + badge like the list
      var tk = feed || (g.tickets || g.soldOut ? g : null); // a home game's counts come with the feed's listing; an away game's ride on the schedule itself (the checker reads the host's page — Steve, 2026-09-16)
      var ts = tk ? LQAFilter.ticketState(tk) : '';
      if (ts) ticketTab(row, ts, tk);
      body.appendChild(title);
      // the foot line: tickets at the left, TV / radio at the right
      var tix = tk ? ticketsLine(tk) : '';
      var hasWatch = g.watch && ((g.watch.tv || []).length || (g.watch.radio || []).length);
      if (tix || hasWatch) {
        var foot = document.createElement('span'); foot.className = 'ev-foot';
        if (tix) { var tl = document.createElement('span'); tl.className = 'ev-tix'; tl.textContent = tix; tl.title = inventoryName(tk) + ' inventory' + (tk.tickets && tk.tickets.checked ? ', checked ' + fmtSince(tk.tickets.checked) : ''); foot.appendChild(tl); }
        if (hasWatch) {
          // the strip's marks, small: streaming (cast), TV, radio — the names after each (Steve, 2026-09-15)
          var w = document.createElement('span'); w.className = 'ev-watch';
          var parts = splitWatch(g.watch.tv || []);
          var tvLower = parts.tv.map(function (n) { return String(n).toLowerCase(); });
          var streamOnly = parts.stream.map(function (s) { return s.name; }).filter(function (n) { return tvLower.indexOf(String(n).toLowerCase()) < 0; }); // a channel that also streams (Mariners.TV) is named once, under the TV mark
          [['Streaming', CAST_SVG, streamOnly], ['TV', TV_SVG, parts.tv], ['Radio', RADIO_SVG, g.watch.radio || []]].forEach(function (k) {
            if (!k[2].length) return;
            if (w.childNodes.length) w.appendChild(document.createTextNode(' \u00b7 '));
            var ic = document.createElement('i'); ic.className = 'ev-watch-ico'; ic.innerHTML = k[1]; ic.title = k[0]; ic.setAttribute('aria-label', k[0]);
            w.appendChild(ic);
            k[2].forEach(function (name, i) { if (i) w.appendChild(document.createTextNode(', ')); var nm = document.createElement('span'); nm.className = 'ev-watch-name'; nm.textContent = name; w.appendChild(nm); }); // each outlet unbreakable ("Seattle Sports (710 AM)" had split at the bracket on phones)
          });
          foot.appendChild(w);
        }
        body.appendChild(foot);
      }
      row.appendChild(body);
      // the opponent's crest: a button that lights up just their games
      var ob = document.createElement('button');
      ob.type = 'button'; ob.className = 'opp-btn'; ob.title = 'Just the games against the ' + (g.opp.short || g.opp.name);
      if (g.opp.logo) { var om = document.createElement('img'); om.className = 'team-mark opp-mark'; om.src = g.opp.logo; om.alt = ''; om.width = 46; om.height = 46; ob.appendChild(om); }
      else { var ot = document.createElement('span'); ot.className = 'opp-abbr'; ot.textContent = g.opp.abbrev || '?'; ob.appendChild(ot); }
      var key = row.dataset.opp;
      ob.addEventListener('click', function () { focusOpp(teamView.opp === key ? null : key, g.opp); });
      row.appendChild(ob); // just the opponent's crest: ours is in the bar and the block already
      dayBox.appendChild(row);
    });
    // the postseason's rounds, at the foot of the list: a row each, dashed, until the club is in and the real games take their place
    var rounds = single ? teamPostseason(team.slug) : [];
    if (rounds.length) {
      var pg = document.createElement('li'); pg.className = 'month-group is-post';
      var pr = document.createElement('div'); pr.className = 'month-row'; var pspan = document.createElement('span'); pspan.textContent = 'Postseason'; pr.appendChild(pspan); pg.appendChild(pr);
      rounds.forEach(function (r) {
        var d = parseDate(r.start), li = document.createElement('div'); li.className = 'day-row is-post'; li.dataset.date = r.start;
        var rail = document.createElement('div'); rail.className = 'date-rail';
        var e = parseDate(r.end); // the rail: the first day large, then the span ("Oct 3–10", "Sep 29 – Oct 1") or the weekday
        rail.innerHTML = '<span class="dnum">' + d.getDate() + '</span><span class="dmeta">' + (r.start === r.end ? d.toLocaleDateString('en-US', { weekday: 'short' }) + ', ' + d.toLocaleDateString('en-US', { month: 'short' }) : d.getMonth() === e.getMonth() ? d.toLocaleDateString('en-US', { month: 'short' }) + ' ' + d.getDate() + '–' + e.getDate() : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' – ' + e.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) + '</span>';
        li.appendChild(rail);
        var pbox = document.createElement('div'); pbox.className = 'day-events'; li.appendChild(pbox);
        var prow = document.createElement('div'); prow.className = 'ev is-post'; pbox.appendChild(prow);
        var ptime = document.createElement('span'); ptime.className = 'time'; ptime.textContent = r.tbd ? 'TBA' : ''; prow.appendChild(ptime);
        var pbody = document.createElement('div'); pbody.className = 'ev-body'; prow.appendChild(pbody);
        if (r.site) { var pwhere = document.createElement('span'); pwhere.className = 'venue is-away'; pwhere.textContent = r.site; pbody.appendChild(pwhere); } // the dates are the rail's; repeating them in the card said it twice (Steve, 2026-09-18)
        var ptitle = document.createElement('span'); ptitle.className = 'ev-title'; ptitle.textContent = r.name + ' '; pbody.appendChild(ptitle);
        if (r.tbd) { var badge = document.createElement('span'); badge.className = 'badge b-post'; badge.textContent = 'Dates TBA'; ptitle.appendChild(badge); } // a round whose dates are the usual calendar, not yet announced (Steve, 2026-09-14: no "if they qualify")
        pg.appendChild(li);
      });
      list.appendChild(pg);
    }
    renderTeamFocus(null);
    if (allMode) { // no club's block or calendar; the strip's pills still pulse for a game on
      $('teamCal').innerHTML = ''; $('teamHead').innerHTML = ''; $('teamHead').classList.remove('is-compact', 'is-multi'); $('teamHead').style.marginBottom = '';
      lastHeadH = ''; $('teamsView').style.removeProperty('--head-h');
    } else {
      renderHead(); // the picked clubs' blocks
      if (single) renderTeamCal(team, all, today); else $('teamCal').innerHTML = ''; // the poster calendar is one club's
    }
    pollLive();
    // land on the next game, under the bar (with the played games folded
    // that is the top of the list)
    alignRails(); // the date rails, now that the season's rows are laid out
    var next = list.querySelector('.day-row:not(.is-past)');
    if (next && teamView.showPast) next.scrollIntoView({ block: 'start', behavior: 'instant' });
    else if (!teamView.showPast) window.scrollTo({ top: 0, behavior: 'instant' });
  }
  // The season calendar beside the list, in the style of the schedule
  // posters: one card per month from the first game's to the last's, every
  // game day a solid cell (home) or a pale one (away) with the opponent's
  // abbreviation and the start time. A cell jumps the list to that day.
  function lum(hex) { // relative luminance of a #rrggbb
    var n = parseInt(hex.slice(1), 16), c = [n >> 16 & 255, n >> 8 & 255, n & 255].map(function (v) {
      v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function teamCalTime(g) {
    if (g.tbd || !g.time) return 'TBD';
    var hm = g.time.split(':'), h = Number(hm[0]);
    return (h % 12 || 12) + ':' + (hm[1] || '00') + (h < 12 ? 'a' : ''); // mornings marked; the rest are evenings, like the posters
  }
  // The crest at the row's far end: the opponent's mark, or, for a club
  // with no mark on file (some rugby sides), a disc with its abbreviation.
  function oppCrest(logo, name, abbr, title, site) {
    var el;
    if (logo) { el = document.createElement('img'); el.className = 'tf-opp'; el.src = logo; el.alt = name || ''; el.width = 96; el.height = 96; }
    else { el = document.createElement('span'); el.className = 'tf-opp tf-opp-abbr'; el.textContent = String(abbr || '?').slice(0, 3).toUpperCase(); }
    el.title = title || name || '';
    return crestLink(el, site, name);
  }
  // a crest opens its club's site in a new tab (the image itself is the control, so the row's layout is untouched)
  function crestLink(el, site, name) {
    if (!site) return el;
    el.classList.add('is-link'); el.setAttribute('role', 'link'); el.tabIndex = 0; el.title = (el.title ? el.title + ' — ' : '') + 'their site';
    el.setAttribute('aria-label', (name || 'the club') + ', their site');
    function go() { window.open(site, '_blank', 'noopener'); }
    el.addEventListener('click', go);
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    return el;
  }
  function teamSite(team) { return team.site || (team.schedule ? team.schedule.replace(/\/(schedule|fixtures)[^]*$/i, '') : null); } // the club's home page: its schedule page's parent
  // ---- the postseason, until the real games arrive ----
  // The league's rounds for the season (teams.json postseason, hand-kept in
  // scripts/data/postseason.json): the ones still ahead, minus any round
  // the schedule already carries a real playoff game for.
  function teamPostseason(slug) {
    var ps = teamsData && teamsData.postseason && teamsData.postseason[slug];
    if (!ps || !ps.rounds) return [];
    var today = todayStr(), games = teamGames(slug) || [];
    return ps.rounds.filter(function (r) { return r.end >= today && !games.some(function (g) { return g.playoff && g.date >= r.start && g.date <= r.end; }); });
  }
  function roundSpan(r) { // "Sep 29 – Oct 1", or the one day
    var a = parseDate(r.start), b = parseDate(r.end), f = { month: 'short', day: 'numeric' };
    return r.start === r.end ? a.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : a.toLocaleDateString('en-US', f) + ' – ' + b.toLocaleDateString('en-US', f);
  }
  // ---- between seasons: in place of the empty list ----
  // The season just gone in numbers — the record and the standing, the home
  // record, the last five, when it ran — and what the next one holds: the
  // hand-written outlook (outlook.json) and when it opens, from the league's
  // usual calendar until the schedule itself arrives.
  var OPENS = {};
  TEAMS.forEach(function (t) { if (t.opens) OPENS[t.slug] = t.opens; });
  function renderSeasonNext(team, all) {
    function esc(x) { return String(x).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
    var form = (teamsData && teamsData.form && teamsData.form[team.slug]) || {};
    var played = all.filter(function (g) { return g.res && !g.pre; });
    var li = document.createElement('li'); li.className = 'season-next';
    var head = document.createElement('h3'); head.className = 'sn-title'; head.textContent = 'Next season'; li.appendChild(head);
    var blurb = document.createElement('p'); blurb.className = 'sn-blurb'; li.appendChild(blurb);
    loadOutlook().then(function (d) { if (d[team.slug]) blurb.textContent = d[team.slug]; else blurb.remove(); });
    var facts = document.createElement('div'); facts.className = 'sn-facts'; li.appendChild(facts);
    function fact(html) { var p = document.createElement('p'); p.innerHTML = html; facts.appendChild(p); }
    var record = form.record && !/^0-0(-0)?$/.test(form.record) ? form.record : played.length ? recordFrom(played) : null;
    var standing = (form.standing || '').replace(/ Conference Division$/, ' Conference');
    if (record) fact('<b>The season</b> ' + esc(record) + (standing ? ' · ' + esc(standing) : ''));
    var homeG = played.filter(function (g) { return g.home; });
    if (homeG.length) {
      var p = document.createElement('p'); p.innerHTML = '<b>At ' + esc(team.venue) + '</b> ' + esc(form.home && !/^0-0(-0)?$/.test(form.home) ? form.home : recordFrom(homeG));
      var five = played.slice(-5);
      if (five.length) { p.appendChild(document.createTextNode(' · ')); var b = document.createElement('b'); b.textContent = 'Last ' + five.length + ' '; p.appendChild(b); var run = document.createElement('span'); run.className = 'tf-run'; five.forEach(function (g) { var i = document.createElement('i'); i.className = 'r-' + resLetter(g); i.textContent = resLetter(g); i.title = gameLine(g) + ' ' + g.res.us + '–' + g.res.them; run.appendChild(i); }); p.appendChild(run); }
      facts.appendChild(p);
    }
    if (all.length) {
      var fmtD = function (d) { return parseDate(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
      fact('<b>Ran</b> ' + esc(fmtD(all[0].date) + ' – ' + fmtD(all[all.length - 1].date)) + ' · ' + all.length + ' games, ' + all.filter(function (g) { return g.home; }).length + ' at home');
    }
    if (form.prev && form.prev.record) fact('<b>' + esc(form.prev.season) + '</b> ' + esc(form.prev.record) + esc(form.prev.seed ? (form.prev.seed <= 8 ? ' · playoff seed ' + form.prev.seed : ' · missed the playoffs') : form.prev.rank ? ' · ' + ordinal(form.prev.rank) + ' in the table' : ''));
    if (OPENS[team.slug]) fact('<b>Opens</b> ' + esc(OPENS[team.slug]) + ' <span class="sn-soft">(the usual; the schedule fills in here once the league publishes it)</span>');
    return li;
  }
  // ---- the form block at the top of the calendar view ----
  // What the club is doing, by where the season stands: before it starts, the
  // opener and the outlook blurb; in season, the record, the standing, the
  // last five and the next game; just over, the final line; long over, the
  // outlook again. Records and standings come with teams.json (form), the
  // blurbs from outlook.json (hand-written).
  var outlookData = null, outlookLoading = null;
  function loadOutlook() {
    if (outlookData) return Promise.resolve(outlookData);
    if (!outlookLoading) outlookLoading = fetch('outlook.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; }).then(function (d) { outlookData = d; return d; });
    return outlookLoading;
  }
  function ordinal(n) { var s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  // "2026" or "2026–27": the years the regular season's games span (football's one year, hockey's two)
  function seasonLabel(team, games) {
    var reg = (games || []).filter(function (g) { return !g.pre && !g.playoff; }), y1 = reg.length ? reg[0].date.slice(0, 4) : String(new Date().getFullYear()), y2 = reg.length ? reg[reg.length - 1].date.slice(0, 4) : y1;
    return y1 === y2 ? y1 : y1 + '\u2013' + y2.slice(2);
  }
  function gameLine(g) { // "Thu Sep 11 at Athletics"
    return parseDate(g.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' + (g.home ? 'vs ' : 'at ') + (g.opp.short || g.opp.name);
  }
  function resLetter(g) { return g.res.won ? 'W' : g.res.us === g.res.them ? 'D' : 'L'; }
  function recordFrom(games) { // W-L(-D) from the results, for a club with no standings line; hockey's overtime losses as the third figure (W-L-OTL), as the standings count them
    var w = 0, l = 0, d = 0, o = 0;
    games.forEach(function (g) { var r = resLetter(g); if (r === 'W') w++; else if (r === 'D') d++; else if (g.res.ot) o++; else l++; });
    return w + '-' + l + (d ? '-' + d : o ? '-' + o : '');
  }
  // Two more lines for the column, from the results the schedule already
  // holds (no fetch, nothing to go stale — Steve, 2026-09-16: the next best
  // stats that fit the space): the streak, the last ten and the road record;
  // then the scoring rate for and against, and the season's margin. From
  // three results on.
  function formLines(team, played, done) { // `done`: the season is played out — the streak is how it closed, not where it stands
    var esc = function (x) { return String(x).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); };
    var out = [];
    if (!played.length) return out;
    if (played.length >= 3) { // a streak and a "last N" mean something from the third game (Steve, 2026-09-16: the Seahawks' block looked bare after one game — the scoring line comes from the first)
      var last = resLetter(played[played.length - 1]), n = 0;
      for (var i = played.length - 1; i >= 0 && resLetter(played[i]) === last; i--) n++;
      var away = played.filter(function (g) { return !g.home; });
      out.push({ cls: 'tf-form tf-streak', html: '<b>' + (done ? 'Finish' : 'Form') + '</b> ' + esc(last + n + (done ? ' to close · ' : ' streak · ') + recordFrom(played.slice(-10)) + ' last ' + Math.min(10, played.length) + (away.length ? ' · ' + recordFrom(away) + ' away' : '')) });
    }
    var us = 0, them = 0;
    played.forEach(function (g) { us += g.res.us; them += g.res.them; });
    var unit = { baseball: 'runs', hockey: 'goals', soccer: 'goals' }[team.sport] || 'points';
    var diff = us - them, per = function (v) { return (v / played.length).toFixed(1); };
    out.push({ cls: 'tf-form tf-scoring', html: '<b>' + esc(unit.charAt(0).toUpperCase() + unit.slice(1)) + '</b> ' + esc(per(us) + ' for · ' + per(them) + ' against · ' + (diff > 0 ? '+' : diff < 0 ? '\u2212' : '') + Math.abs(diff)) }); // per game, and the season's margin — kept short so it never wraps (Steve's review, 2026-09-16) // short enough for the column at three figures (the Storm's −206)
    return out;
  }
  // The season's wrap, in the block once the last game is played (Steve,
  // 2026-10-05: with no game ahead the watch strip and the next opponent's
  // crest go, and the block says more about the season — drawn, not listed:
  // "the season stats can be more graphical"). All from the results the
  // schedule holds — nothing fetched, nothing to go stale. seasonStats
  // works the numbers out; buildSeasonWrap draws them under the crest and
  // the bug, the block's width (Steve, 2026-10-05, second round: "move this
  // to this section … and improve the graphics"): the season game by game
  // as a tick chart with the months and their records along it and the
  // longest runs bracketed, then a row of bar tiles — the record split
  // (home, away, the one-score games, the playoffs), the scoring, the best
  // win and worst loss by margin, this season's wins against last season's.
  function seasonStats(team, played, form) {
    var reg = played.filter(function (g) { return !g.playoff; }), po = played.filter(function (g) { return g.playoff; });
    var base = reg.length >= 3 ? reg : played; // the season proper; the playoffs get their own bar
    var st = { base: base, po: po, months: [], close: [], unit: { baseball: 'runs', hockey: 'goals', soccer: 'goals' }[team.sport] || 'points' };
    var best = null, worst = null, cur = null; // the longest winning and losing runs (a draw ends either)
    base.forEach(function (g) {
      var r = resLetter(g);
      if (r === 'D') { cur = null; return; }
      if (cur && cur.r === r) { cur.n++; cur.to = g; } else cur = { r: r, n: 1, from: g, to: g };
      if (r === 'W' && (!best || cur.n > best.n)) best = cur;
      if (r === 'L' && (!worst || cur.n > worst.n)) worst = cur;
    });
    st.runs = [best, worst].filter(function (x) { return x && x.n >= 2; });
    base.forEach(function (g) { var m = g.res.us - g.res.them; if (m > 0 && (!st.bw || m > st.bw.res.us - st.bw.res.them)) st.bw = g; if (m < 0 && (!st.wl || m < st.wl.res.us - st.wl.res.them)) st.wl = g; }); // by margin
    var months = {};
    base.forEach(function (g) { var k = g.date.slice(0, 7); (months[k] = months[k] || []).push(g); });
    Object.keys(months).sort().forEach(function (k) { var w = 0, l = 0, d = 0; months[k].forEach(function (g) { var r = resLetter(g); if (r === 'W') w++; else if (r === 'D') d++; else l++; }); st.months.push({ key: k, games: months[k], w: w, l: l, d: d, pct: months[k].length ? w / months[k].length : 0 }); });
    var full = st.months.filter(function (m) { return m.games.length >= 5; }); // the best and the worst, from months of five games or more
    if (full.length >= 2) { var byPct = full.slice().sort(function (a, b) { return b.pct - a.pct; }); st.bestMonth = byPct[0]; st.worstMonth = byPct[byPct.length - 1]; }
    st.one = { baseball: 1, hockey: 1, soccer: 1, basketball: 3, football: 3, rugby: 7 }[team.sport] || 1; // one score's margin
    st.close = base.filter(function (g) { var m = Math.abs(g.res.us - g.res.them); return m > 0 && m <= st.one; });
    st.home = base.filter(function (g) { return g.home; }); st.away = base.filter(function (g) { return !g.home; });
    st.ot = base.filter(function (g) { return g.res.ot; }); // hockey: the games that went past regulation (overtime or the shootout)
    // against the division (ESPN's record for the NHL and NFL, the results for the Mariners), else the conference (college football); the
    // group named as the standing line names it ("2nd in Pacific Division" → Pacific)
    var grp = String(form.standing || '').replace(/^\d+(st|nd|rd|th) in (the )?/i, '').replace(/ (Division|Conference)$/i, '');
    if (form.vsDiv) st.group = { label: grp || 'Division', record: form.vsDiv }; else if (form.vsConf) st.group = { label: grp || 'Conference', record: form.vsConf };
    var us = 0, them = 0; base.forEach(function (g) { us += g.res.us; them += g.res.them; });
    st.us = us; st.them = them; st.diff = us - them;
    st.wins = 0; reg.forEach(function (g) { if (g.res.won) st.wins++; });
    var pw = form.prev && form.prev.record && /^(\d+)-/.exec(form.prev.record);
    if (pw && reg.length >= 3) { st.prevWins = Number(pw[1]); st.prevSeason = form.prev.season; }
    return st;
  }
  function buildSeasonWrap(team, played, form) {
    var esc = function (x) { return String(x).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); };
    var st = seasonStats(team, played, form);
    var wrap = document.createElement('div'); wrap.className = 'tf-wrap';
    var short = function (g) { return parseDate(g.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
    var opp = function (g) { return (g.home ? 'vs ' : 'at ') + (g.opp.short || g.opp.name); };
    var score = function (g) { return g.res.us + '–' + g.res.them; };
    var pctOf = function (games) { var w = 0; games.forEach(function (g) { if (g.res.won) w++; }); return games.length ? w / games.length : 0; };
    function tile(cls, label, html) { var t = document.createElement('div'); t.className = 'tw ' + cls; t.innerHTML = '<b class="tw-l">' + esc(label) + '</b>' + html; wrap.appendChild(t); return t; }
    // a bar: the label, the fill, the figure at the end — the fill is a share (a win share, with a tick at .500, or a rate against the larger of two)
    function bar(label, share, figure, cls, title, mid) { return '<div class="tw-bar' + (cls ? ' ' + cls : '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '><span>' + esc(label) + '</span><i>' + (mid ? '<s></s>' : '') + '<b style="width:' + (Math.max(0, Math.min(1, share)) * 100).toFixed(1) + '%"></b></i><span class="tw-n">' + esc(figure) + '</span></div>'; }
    // 1. the months: a stacked column each, wins up from the floor in the club's colour, losses (and draws) on top in grey;
    // the best month's name in the colour, the worst's dimmed, both spelled out under the chart (a game-by-game tick strip
    // the block's width came first and went the same hour — Steve: "this long bar chart is too much")
    if (st.months.length >= 2) {
      var most = Math.max.apply(null, st.months.map(function (m) { return m.games.length; }));
      var mn = function (m) { return parseDate(m.key + '-01').toLocaleDateString('en-US', { month: 'short' }); };
      tile('tw-months-tile', 'By month', '<div class="tw-months">' + st.months.map(function (m) {
        var h = function (k) { return (k / most * 100).toFixed(1) + '%'; };
        return '<span class="tw-col' + (m === st.bestMonth ? ' is-best' : m === st.worstMonth ? ' is-worst' : '') + '" title="' + esc(mn(m) + ' ' + recordFrom(m.games)) + '"><span class="tw-stack"><i class="tw-x" style="height:' + h(m.l + m.d) + '"></i><i class="tw-w" style="height:' + h(m.w) + '"></i></span><em>' + esc(mn(m)) + '</em></span>';
      }).join('') + '</div>' + (st.bestMonth ? '<p class="tw-foot">' + esc('best ' + mn(st.bestMonth) + ' ' + recordFrom(st.bestMonth.games) + ' · worst ' + mn(st.worstMonth) + ' ' + recordFrom(st.worstMonth.games)) + '</p>' : ''));
    }
    // 2. the record split: home, away, the one-score games, the playoffs — each a win share, a tick at .500
    var split = '';
    if (st.home.length) split += bar('Home', pctOf(st.home), recordFrom(st.home), '', st.home.length + ' at home', true);
    if (st.away.length) split += bar('Away', pctOf(st.away), recordFrom(st.away), '', st.away.length + ' on the road', true);
    if (st.close.length >= 3) split += bar(st.one === 1 ? 'One-' + st.unit.replace(/s$/, '') : 'Close', pctOf(st.close), recordFrom(st.close), '', st.close.length + ' games decided by ' + (st.one === 1 ? 'one' : st.one + ' or less'), true);
    if (st.group) { var gp = /^(\d+)-(\d+)(?:-(\d+))?/.exec(st.group.record); if (gp) split += bar(st.group.label, Number(gp[1]) / (Number(gp[1]) + Number(gp[2]) + Number(gp[3] || 0)), st.group.record, '', 'against the ' + st.group.label, true); } // the division (or conference) record, as a win share like the rest
    if (st.ot.length >= 2) split += bar('Overtime', pctOf(st.ot), recordFrom(st.ot), '', st.ot.length + ' games past regulation, the shootout included', true);
    if (st.po.length) split += bar('Playoffs', pctOf(st.po), recordFrom(st.po), '', gameLine(st.po[st.po.length - 1]) + ' ' + resLetter(st.po[st.po.length - 1]) + ' ' + score(st.po[st.po.length - 1]), true);
    if (split) tile('tw-split', 'Record', split);
    // 3. the scoring: for and against per game, against the larger; the season's margin at the foot
    if (st.base.length) {
      var per = function (v) { return (v / st.base.length).toFixed(1); }, top = Math.max(st.us, st.them, 1);
      tile('tw-runs', st.unit.charAt(0).toUpperCase() + st.unit.slice(1) + ' a game', bar('For', st.us / top, per(st.us), '', st.us + ' ' + st.unit) + bar('Against', st.them / top, per(st.them), 'is-them', st.them + ' ' + st.unit) + '<p class="tw-foot">' + esc((st.diff > 0 ? '+' : st.diff < 0 ? '−' : '') + Math.abs(st.diff) + ' on the season') + '</p>');
    }
    // 4. the longest runs: a square a game (ten at most — the figure says the length), the dates after
    if (st.runs.length) tile('tw-streaks', 'Streaks', st.runs.map(function (x) {
      var dates = short(x.from) + (x.n > 1 ? '\u2013' + (x.from.date.slice(0, 7) === x.to.date.slice(0, 7) ? x.to.date.slice(8).replace(/^0/, '') : short(x.to)) : '');
      var sq = ''; for (var i = 0; i < Math.min(x.n, 10); i++) sq += '<i></i>';
      return '<p title="' + esc(gameLine(x.from) + ' to ' + gameLine(x.to)) + '"><b>' + x.r + x.n + '</b><span class="tw-sq is-' + x.r + '">' + sq + '</span>' + esc(dates) + '</p>';
    }).join(''));
    // 5. the best win and the worst loss, by margin — a line each (a margin bar beside them left no room for the opponent in a tile this wide)
    if (st.bw || st.wl) {
      var gl = function (g, cls) { return '<p class="' + cls + '" title="' + esc(gameLine(g)) + '"><b>' + esc(score(g)) + '</b> ' + esc(opp(g) + ', ' + short(g)) + '</p>'; };
      tile('tw-games', 'Best win, worst loss', (st.bw ? gl(st.bw, '') : '') + (st.wl ? gl(st.wl, 'is-them') : ''));
    }
    // 6. the wins against last season's (ESPN's record for the season before)
    if (st.prevWins != null) {
      var mx = Math.max(st.wins, st.prevWins, 1), d = st.wins - st.prevWins;
      tile('tw-prev', 'Wins on ' + st.prevSeason, bar(seasonLabel(team, played), st.wins / mx, String(st.wins), '', 'this season') + bar(st.prevSeason, st.prevWins / mx, String(st.prevWins), 'is-them', form.prev.record) + '<p class="tw-foot">' + esc(d === 0 ? 'the same wins' : (d > 0 ? '+' : '−') + Math.abs(d) + ' wins') + '</p>');
    }
    // 7. the season's leaders (the build, from ESPN's leaders feed: a stat and the player who led the club in it) — a tall tile at
    // the right of the wrap, the stat, the name and the figure on a line each (Steve, 2026-10-05: "#1, yes")
    if (form.leaders && form.leaders.length) {
      tile('tw-leaders', 'Season leaders', form.leaders.map(function (l) {
        return '<div class="tw-lead"' + (l.pos ? ' title="' + esc(l.name + ', ' + l.pos) + '"' : '') + '><span>' + esc(l.stat) + '</span><span class="tw-who">' + esc(l.name) + '</span><b class="tw-n">' + esc(l.value) + '</b></div>';
      }).join(''));
      wrap.classList.add('has-leaders');
    }
    return wrap;
  }
  // The club's big moves, beside the bug once the season is played out — a
  // manager fired, a trade, an extension, a line apiece (teams.json
  // form.moves: the league's transactions feed, sifted and shortened at build;
  // the full list was "too ugly/detailed to read", Steve, 2026-10-05). The opener and the preseason's date were
  // here first and went the same evening (Steve, 2026-10-05: "the next
  // season start date is of low value"; a "not published yet" line "the most
  // useless thing"); the hand-written outlook sits in the panel below. With
  // no moves, no block.
  function buildMoves(form) {
    var moves = (form.moves || []).slice(0, 3);
    if (!moves.length) return null;
    var box = document.createElement('div'); box.className = 'tf-ahead'; // no heading: the lines say what they are (Steve, 2026-10-05)
    moves.forEach(function (m) {
      var p = document.createElement('p'); p.className = 'tf-move';
      var a = document.createElement(m.url ? 'a' : 'span'); a.textContent = m.text;
      if (m.url) { a.href = m.url; a.target = '_blank'; a.rel = 'noopener'; a.title = 'The club’s transactions on ESPN'; }
      var d = document.createElement('span'); d.className = 'tf-move-day'; d.textContent = parseDate(m.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' '; p.appendChild(d); // the day first, so a long line wraps in its words, never leaving the day alone on a line
      p.appendChild(a);
      box.appendChild(p);
    });
    return box;
  }
  function renderTeamForm(team, games, today) {
    function esc(x) { return String(x).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
    var form = (teamsData && teamsData.form && teamsData.form[team.slug]) || {};
    var played = games.filter(function (g) { return g.date < today && g.res && !g.pre; }); // the record and the last five: the season proper, not the preseason
    var upcoming = games.filter(function (g) { return g.date >= today; });
    var last = games[games.length - 1], next = upcoming[0] || null;
    var daysOver = upcoming.length ? 0 : last ? Math.round((parseDate(today) - parseDate(last.date)) / 864e5) : 9999; // no games at all (a club whose feed is empty before its season): the off-season block
    var stage = !played.length && upcoming.length ? 'pre' : upcoming.length ? 'in' : daysOver <= 60 ? 'over' : 'off';
    var record = played.length ? (form.record && !/^0-0(-0)?$/.test(form.record) ? form.record : recordFrom(played)) : null;
    var standing = (form.standing || '').replace(/ Conference Division$/, ' Conference');
    var homeRec = played.length ? (form.home && !/^0-0(-0)?$/.test(form.home) ? form.home : recordFrom(played.filter(function (g) { return g.home; }))) : null;
    var five = played.slice(-5);
    // the same skeleton as a game: our crest, the season's bug, the column
    // beside it, the next opponent's crest, the news; the watch strip along
    // the foot for the next game
    var box = document.createElement('div'); box.className = 'team-form is-live is-season has-bug is-' + stage;
    var main = document.createElement('div'); main.className = 'tf-main'; box.appendChild(main);
    var row = document.createElement('div'); row.className = 'tf-row'; main.appendChild(row);
    if (team.logo) { var im = document.createElement('img'); im.src = team.logo; im.alt = ''; im.width = 56; im.height = 56; im.title = clubName(team); row.appendChild(crestLink(im, teamSite(team), clubName(team))); }
    var body = document.createElement('div'); body.className = 'tf-body'; row.appendChild(body);
    var inner = document.createElement('div'); inner.className = 'tf-inner'; body.appendChild(inner);
    var cluster = document.createElement('div'); cluster.className = 'tf-cluster'; inner.appendChild(cluster);
    var head = document.createElement('div'); head.className = 'tf-head'; cluster.appendChild(head); // the compact bar's line: the record and the standing
    if (stage === 'pre') head.innerHTML = '<span class="tf-title">Season ahead</span>';
    else if (stage === 'off') head.innerHTML = '<span class="tf-title">Off-season</span>' + (record ? '<span class="tf-standing">' + esc(record) + '</span>' : '');
    else head.innerHTML = '<span class="tf-record">' + esc(record) + '</span>' + (standing ? '<span class="tf-standing">' + esc(standing) + '</span>' : '');
    var home = document.createElement('p'); home.className = 'tf-where'; cluster.appendChild(home); // the home ground along the top of the bug
    var bugwrap = document.createElement('div'); bugwrap.className = 'tf-bugwrap'; cluster.appendChild(bugwrap);
    // the frame: the next game's win chance (the pregame's bug — the day and time along the top, a row per side, the ring) as soon as
    // the odds are in (fetchNextOdds); until then, and with no game ahead, the season's numbers. With the odds up, the season's numbers
    // move to a line in the column beside (record, standing, home record, the last five)
    var od = next && team.espn ? live.odds[team.slug] : next && next.odds ? { date: next.date, chance: next.odds, them: null } : null; // ESPN's (fetched) or the schedule's own (the build prices the PWHL)
    var odds = od && od.date === next.date && od.chance ? od : null;
    if (odds) {
      var oppT = { abbreviation: (odds.them && odds.them.abbr) || next.opp.abbrev || '', color: odds.them && odds.them.color, alternateColor: odds.them && odds.them.alt, name: next.opp.short || next.opp.name, displayName: next.opp.name, shortDisplayName: next.opp.short || next.opp.name };
      var usS = { team: { abbreviation: clubAbbr(team), color: String((team.colors || [])[0] || '555').replace(/^#/, '') }, homeAway: next.home ? 'home' : 'away', isUs: true };
      var themS = { team: oppT, homeAway: next.home ? 'away' : 'home' };
      var rel = parseDate(next.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      bugwrap.appendChild(buildPregameBug(team, null, usS, themS, { chance: odds.chance }, rel, next.time && !next.tbd ? next.date + 'T' + next.time : null));
      box.classList.add('has-odds');
    } else bugwrap.appendChild(buildSeasonBug(team, stage, record, standing, homeRec, five, played, upcoming, form));
    var lines = document.createElement('div'); lines.className = 'tf-lines'; cluster.appendChild(lines);
    // the top of the news column: the next game (or the last), last season, the outlook
    var lead = document.createElement('div'); lead.className = 'tf-lines tf-lead';
    var hl = document.createElement('a'); hl.textContent = team.venue; hl.target = '_blank'; hl.rel = 'noopener'; hl.title = 'On Google Maps';
    hl.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(team.venue + (clubCity(team) ? ', ' + clubCity(team) : '')); home.appendChild(hl); // the ground's own city, from the league (Tukwila for the Seawolves)
    function line(cls, html) { var p = document.createElement('p'); p.className = cls; p.innerHTML = html; lead.appendChild(p); return p; }
    if (next) line('tf-next', '<b>' + (stage === 'pre' ? (next.pre ? 'Preseason' : 'Opens') : 'Next') + '</b> ' + esc(gameLine(next)) + (next.time && !next.tbd ? ', ' + esc(fmtTime(next.time, next.date)) : '')); // before the season: the next game, named for what it is (a preseason game, or the opener)
    if (next && team.espn) { // the series so far, under the next game's line, once it has come (fetchNextOdds redraws the block quietly when the odds and the series land)
      if (od && od.date === next.date && seriesText(od.series)) line('tf-series', '<b>Series</b> ' + esc(seriesText(od.series)));
      fetchNextOdds(team, next);
    }
    if (odds && record) { // the season's numbers, out of the frame: the record and the standing, the home record, the last five
      var runHtml = five.length ? ' <span class="tf-run">' + five.map(function (g) { return '<i class="r-' + resLetter(g) + '" title="' + esc(gameLine(g) + ' ' + g.res.us + '–' + g.res.them) + '">' + resLetter(g) + '</i>'; }).join('') + '</span>' : '';
      line('tf-season', '<b>' + esc(record) + '</b> ' + esc((standing ? standing + ' · ' : '') + (homeRec ? homeRec + ' at home' : '')) + runHtml);
    }
    else if (last && last.res) line('tf-next', '<b>Last game</b> ' + esc(gameLine(last)) + ', ' + (last.res.won ? 'won ' : last.res.us === last.res.them ? 'drew ' : 'lost ') + last.res.us + '–' + last.res.them);
    if (next && stage === 'in') formLines(team, played, false).forEach(function (f) { line(f.cls, f.html); }); // the streak, the last ten, the road record; the scoring (with the season played out the wrap's tiles say it instead)
    if (od && next && od.date === next.date) leaderLines(od.leaders && od.leaders.us, od.injured && od.injured.us).forEach(function (f) { line(f.cls, f.html); }); // the leaders and the injured, once the matchup page is in
    if (next && form.prev && form.prev.record) { // last season, from ESPN's record for the season before (its "playoff seed" runs past the bracket for the clubs that missed it); with the season over it is on the bug's top line and in the wrap
      var pv = form.prev, tail = pv.seed ? (pv.seed <= 8 ? ' · playoff seed ' + pv.seed : ' · missed the playoffs') : pv.rank ? ' · ' + ordinal(pv.rank) + ' in the table' : '';
      line('tf-series tf-prev', '<b>' + esc(pv.season) + '</b> ' + esc(pv.record) + esc(tail));
    }
    if (stage === 'pre') { // the hand-written outlook (once a season is over it sits in the panel below the block instead)
      var blurb = document.createElement('p'); blurb.className = 'tf-blurb'; lead.appendChild(blurb);
      loadOutlook().then(function (d) { if (d[team.slug]) blurb.textContent = d[team.slug]; else blurb.remove(); foldNews(); });
    }
    var oppG = next; // the crest at the other end: the next opponent's; with the season played out, none (Steve, 2026-10-05: "the last game crest … isn't needed") — the wrap takes that room
    if (oppG && oppG.opp) { row.appendChild(vsLine(team.label, oppG.home, oppG.opp.short || oppG.opp.name)); row.appendChild(oppCrest(oppG.opp.logo, oppG.opp.name, oppG.opp.abbrev || oppG.opp.short || oppG.opp.name, 'Next: ' + (oppG.opp.name || ''), oppG.opp.site)); } // the compact bar's "at"/"vs" and the opponent's crest
    if (!next && played.length >= 3) { main.appendChild(buildSeasonWrap(team, played, form)); box.classList.add('has-wrap'); }
    if (!next) { var mv = buildMoves(form); if (mv) row.appendChild(mv); } // the season played out: the latest moves at the row's right end (Steve, 2026-10-05: "this space is under utilized when the season is over") // the season played out: its wrap, drawn under the crest and the bug where the watch strip was, the block growing to hold it; the news column goes (the lead's last-game line still feeds the pinned bar)
    var side = next ? buildFormSide(form, lead.childNodes.length ? lead : null) : null;
    if (side) box.appendChild(side);
    var strip = next ? buildWatchStrip(next.watch ? next.watch.tv || [] : [], next.watch ? next.watch.radio : null, '', team) : null; // the strip while a game is ahead; with the season played out it goes, and its room goes to the column's wrap (Steve, 2026-10-05: "removing the how to watch/listen section")
    if (strip) box.appendChild(strip); else { box.classList.add('no-watch'); var sb = buildSchedButton(); sb.classList.add('is-loose'); box.appendChild(sb); } // the season played out: no strip, the button alone at the block's foot
    inner.appendChild(buildBrief(lead, strip)); // the pinned bar's run
    return box;
  }
  // The season in the scorebug's frame: the standing along the top (last
  // season's record at the right, while the season runs); a SEASON row —
  // the record, the last five — and a HOME row — the home record, the last
  // game played — each cell labelled in words; before a season, the opener
  // and the home opener instead.
  function buildSeasonBug(team, stage, record, standing, homeRec, five, played, upcoming, form) {
    function esc(x) { return String(x).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
    var col = '#' + String((team.colors || [])[0] || '555').replace(/^#/, '');
    var top = stage === 'pre' ? 'Season ahead' : stage === 'off' ? 'Off-season' : stage === 'over' ? seasonLabel(team, played) + ' season over' : (standing || 'This season'); // the season named by its year(s) once it is done (Steve, 2026-10-05)
    var right = stage === 'over' ? (standing || '') : form.prev && form.prev.record ? 'Last season ' + form.prev.record : ''; // said in words; with the season over the standing sits at the right end of the line (Steve, 2026-10-05: "3rd in AL West should still be right justified") and the wrap's tile beneath has last season
    var r1 = '', r2 = '', s1 = record || '–', s2 = homeRec || '–';
    // every cell says what it is (Steve, 2026-10-05: "don't know what all this means" of SEA 76-86 / HOME 43-38 / W L L W W / a bare game line)
    var done = stage === 'over' || stage === 'off'; // the season played out: the record and the home record alone — the last five and the last game are trivia then (Steve, 2026-10-05: "when the season is over, it should not care about the last five or last game")
    if (five.length && !done) r1 = '<b class="bug-lbl">Last 5</b><span class="tf-run">' + five.map(function (g) { return '<i class="r-' + resLetter(g) + '" title="' + esc(gameLine(g) + ' ' + g.res.us + '–' + g.res.them) + '">' + resLetter(g) + '</i>'; }).join('') + '</span>';
    var last = played[played.length - 1];
    if (last && !done) r2 = '<b class="bug-lbl">Last game</b>' + esc(gameLine(last) + ' ' + (last.res.won ? 'W' : last.res.us === last.res.them ? 'D' : 'L') + ' ' + last.res.us + '–' + last.res.them);
    if (stage === 'pre' && upcoming.length) { var reg = upcoming.filter(function (g) { return !g.pre; }), ho = reg.filter(function (g) { return g.home; })[0]; r1 = 'Opens ' + esc(gameLine(reg[0] || upcoming[0])); r2 = ho ? 'Home opener ' + esc(gameLine(ho)) : ''; } // the season proper opens after any preseason
    var b = document.createElement('div'); b.className = 'tf-bug is-generic is-season-bug' + (done ? ' is-final' : '');
    b.innerHTML = '<div class="bug-top"><span class="bug-pitcher">' + esc(top) + '</span>' + (right ? '<span class="bug-pc">' + esc(right) + '</span>' : '') + '</div>' +
      '<div class="bug-grid bug-grid-2' + (done ? ' no-ev' : '') + '">' +
      '<span class="bug-team" style="--cell:' + col + '">SEASON<small>every game</small></span><span class="bug-score">' + esc(s1) + '</span><span class="bug-ev">' + r1 + '</span>' + // each row says what it counts (Steve, 2026-10-05: "define season v. home")
      '<span class="bug-team bug-team-soft">HOME<small>' + esc(team.venue && team.venue.length <= 22 ? 'at ' + team.venue : 'at home') + '</small></span><span class="bug-score">' + esc(s2) + '</span><span class="bug-ev">' + r2 + '</span></div>';
    return b;
  }
  // The block's right column: the latest written pieces from ESPN's team
  // feed (recent and newsy); a club ESPN doesn't cover gets the season's
  // Wikipedia lead instead. Shared by the season and the live blocks.
  // The pieces come from several outlets (ESPN, the Seattle Times, the
  // club's own site, the fan sites), each tagged with its source. The fold:
  // as many as fit beside the crests (foldNews measures once the block is
  // on the page; three until then), the rest behind the arrow at the lower
  // right (open stays open across redraws). `lead` is a block for the top of
  // the column — the pregame's starters and the leaders out.
  // The fold: beside the crests every story shows and the column scrolls
  // inside the block; under the row (a narrow desktop) three show, on a
  // phone two, the rest behind a labelled button under the list (open
  // stays open across redraws).
  var NEWS_SHOWN = 3, NEWS_SHOWN_NARROW = 2, newsOpen = false;
  function buildFormSide(form, lead) {
    if (lead || (form.news && form.news.length) || (form.wiki && form.wiki.text)) {
      var side = document.createElement('div'); side.className = 'tf-wiki';
      var cols = document.createElement('div'); cols.className = 'tf-cols'; side.appendChild(cols); // the lead and the news: one column beside the crests, two once the column wraps under the row
      if (lead) cols.appendChild(lead);
      if (form.news && form.news.length) {
        var ul = document.createElement('ul'); ul.className = 'tf-news';
        form.news.forEach(function (n, i) {
          var li = document.createElement('li');
          if (i >= NEWS_SHOWN) li.className = 'is-more';
          var a = document.createElement('a'); a.href = n.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = n.headline; li.appendChild(a);
          var meta = [n.source, n.date && parseDate(n.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })].filter(Boolean);
          if (meta.length) { var dt = document.createElement('span'); dt.className = 'tf-date'; dt.textContent = meta.join(' · '); li.appendChild(dt); }
          if (n.text) { var p = document.createElement('p'); p.textContent = n.text; li.appendChild(p); }
          ul.appendChild(li);
        });
        cols.appendChild(ul);
        if (form.news.length > 1) { // the button under the list: "3 more stories" / "Fewer" (foldNews shows it only while some are folded, and words it)
          var more = document.createElement('button'); more.type = 'button'; more.className = 'chip tf-more';
          more.innerHTML = '<span></span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
          function setOpen(open) { newsOpen = open; side.classList.toggle('is-open', open); more.setAttribute('aria-expanded', open ? 'true' : 'false'); foldNews(side); }
          setOpen(newsOpen);
          more.addEventListener('click', function () { setOpen(!newsOpen); });
          side.appendChild(more);
        }
        side.addEventListener('scroll', function () { side.classList.toggle('is-at-end', side.scrollTop + side.clientHeight >= side.scrollHeight - 2); }); // the fade at the foot lifts at the end
      } else if (form.wiki && form.wiki.text) {
        var wp = document.createElement('p'); wp.textContent = form.wiki.text; side.appendChild(wp);
      }
      return side;
    }
    return null;
  }
  // The fold, by layout: beside the crests (the wide layout) nothing folds —
  // the column is as tall as the row and scrolls, a fade at its foot while
  // there is more below; under the row (the block wrapped, a narrow
  // desktop) three stories show; on a phone two. The button under the list
  // opens the rest and says how many. Called once a block is on the page
  // and again when the window is resized.
  function foldNews(side) {
    side = side || document.querySelector('#teamHead .tf-wiki');
    if (!side || !side.isConnected || $('teamHead').classList.contains('is-compact')) return;
    var items = side.querySelectorAll('.tf-news li');
    if (!items.length) return;
    var box = side.parentNode, narrow = window.matchMedia('(max-width: 760px)').matches;
    var mainEl = box.querySelector(':scope > .tf-main');
    var wrapped = !!mainEl && side.getBoundingClientRect().top >= mainEl.getBoundingClientRect().bottom - 1; // the column under the row rather than beside the crests
    box.classList.toggle('is-wrapped', wrapped);
    var shown = narrow ? NEWS_SHOWN_NARROW : wrapped ? NEWS_SHOWN : Infinity;
    var more = Math.max(0, items.length - shown);
    items.forEach(function (li, i) { li.classList.toggle('is-more', i >= shown); });
    side.classList.toggle('has-more', more > 0);
    var btn = side.querySelector('.tf-more');
    if (btn) { var open = side.classList.contains('is-open'); btn.querySelector('span').textContent = open ? 'Fewer' : more + ' more ' + (more === 1 ? 'story' : 'stories'); btn.title = open ? 'Fewer stories' : 'The rest of the stories'; }
    var scrolls = !narrow && !wrapped && side.scrollHeight > side.clientHeight + 1; // beside the crests, with more than the row's height holds
    side.classList.toggle('is-scroll', scrolls);
    if (scrolls) side.classList.toggle('is-at-end', side.scrollTop + side.clientHeight >= side.scrollHeight - 2);
  }
  // The crests either side of a game sit level with the scorebug, not with
  // the cluster as a whole (the venue line above it and the lines below
  // would pull them down): measured once the block is on the page, set as
  // a top margin on the row. Redone with the fold on every redraw and resize.
  function alignCrests() {
    var row = document.querySelector('#teamHead .team-form.is-live .tf-row'), bug = row && row.querySelector('.tf-bug');
    if (!row || !row.isConnected || $('teamHead').classList.contains('is-compact')) return;
    if (!bug) { row.style.removeProperty('--crest-top'); return; }
    row.style.removeProperty('--crest-top'); // measure from the plain layout
    var rr = row.getBoundingClientRect(), br = bug.getBoundingClientRect(), centre = br.top - rr.top + br.height / 2;
    var imgs = row.querySelectorAll(':scope > img'), tallest = 0;
    imgs.forEach(function (i) { tallest = Math.max(tallest, i.offsetHeight); });
    row.style.setProperty('--crest-top', Math.max(0, Math.round(centre - tallest / 2)) + 'px');
  }
  // the watch strip keeps to one line: when the ways to watch run past it, the chevron at its right end shows (and unfolds them)
  function foldWatch() {
    document.querySelectorAll('#teamHead .tf-watch').forEach(function (w) {
      if (w.classList.contains('is-open')) return;
      var more = Array.prototype.some.call(w.querySelectorAll('.tf-channels'), function (ch) { return ch.scrollHeight > ch.clientHeight + 2 || ch.scrollWidth > ch.clientWidth + 2; }); // wrapped past its line, or (a phone's one row) clipped at its end — the chevron only then (Steve, 2026-09-19: all three sections stay, the arrow only when it gets noisy)
      w.classList.toggle('has-more', more);
    });
  }
  // The scorebug is drawn at its natural width and never wider than the
  // block gives it: measured, if its grid runs past the frame the ring's
  // label goes and the desktop's zoom with it (styles.css .tf-bug.is-tight)
  function fitBug() {
    document.querySelectorAll('#teamHead .tf-bug').forEach(function (b) {
      b.classList.remove('is-tight');
      var over = function (el) { return el.scrollWidth > el.clientWidth + 1; };
      // the grid past the frame, or a trimming cell (the run of results, the top row's pieces) with more than it can show
      if (over(b) || Array.prototype.some.call(b.querySelectorAll('.bug-ev, .bug-top > span'), over)) b.classList.add('is-tight');
      // the ODDS tab under the pregame bug sits exactly under the percentages' column: measured here, handed to styles.css as --tab-l / --tab-w (in the tab's own zoomed pixels)
      var cell = b.querySelector('.bug-odds'), wrap = b.parentNode;
      if (cell && wrap) {
        var z = parseFloat(getComputedStyle(b).zoom) || 1, wr = wrap.getBoundingClientRect(), cr = cell.getBoundingClientRect();
        wrap.style.setProperty('--tab-l', ((cr.left - wr.left) / z).toFixed(1) + 'px');
        wrap.style.setProperty('--tab-w', (cr.width / z).toFixed(1) + 'px');
      }
    });
  }
  // The column's lines, by priority: when they run past the room the column
  // has (beside the crests, the row's height; under them, four lines) the
  // least important go first — the injured, the leaders, last season, the
  // streak, the scoring, the series — never the next game or the record
  // (Steve, 2026-09-16: keep the block to its height).
  var LEAD_DROP = ['.tf-injured', '.tf-leaders', '.tf-blurb', '.tf-prev', '.tf-streak', '.tf-scoring', '.tf-series:not(.tf-prev)'];
  function fitLead() {
    document.querySelectorAll('#teamHead .tf-wiki .tf-lead').forEach(function (lead) {
      var wiki = lead.closest('.tf-wiki');
      lead.querySelectorAll('p[hidden]').forEach(function (p) { p.hidden = false; });
      var over = function () { return lead.scrollHeight > lead.clientHeight + 1 || wiki.scrollHeight > wiki.clientHeight + 1; };
      for (var i = 0; i < LEAD_DROP.length && over(); i++) { var p = lead.querySelector(LEAD_DROP[i]); if (p) p.hidden = true; }
    });
  }
  function settleBlock() { fitBug(); foldNews(); alignCrests(); foldWatch(); fitLead(); foldNews(); } // foldNews again once fitLead has trimmed the lead: the column may no longer scroll, and its fade would otherwise stay over the last line (seen 2026-10-05 on the Mariners' season wrap)
  var foldPending = false;
  window.addEventListener('resize', function () { if (!foldPending) { foldPending = true; requestAnimationFrame(function () { foldPending = false; settleBlock(); }); } });
  // ---- where to watch: the networks ESPN names, looked up in channels.json ----
  var CAST_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/><path d="M2 12a9 9 0 0 1 8 8"/><path d="M2 16a5 5 0 0 1 4 4"/><path d="M2 20h.01"/></svg>';
  var channelsData = null, channelsLoading = null;
  function loadChannels() {
    if (channelsData) return Promise.resolve(channelsData);
    if (!channelsLoading) channelsLoading = fetch('channels.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : { channels: [] }; }).catch(function () { return { channels: [] }; }).then(function (d) { channelsData = d; return d; });
    return channelsLoading;
  }
  function channelInfo(name) {
    var list = (channelsData && channelsData.channels) || [];
    for (var i = 0; i < list.length; i++) { try { if (new RegExp(list[i].match, 'i').test(name)) return list[i]; } catch (e) { /* bad pattern: skip */ } }
    return null;
  }
  // an entry's link: the longest name in channels.json's links the text contains
  function watchLink(text) {
    var links = (channelsData && channelsData.links) || {}, best = null, t = String(text).toLowerCase();
    Object.keys(links).forEach(function (k) { if (k !== '_' && t.indexOf(k.toLowerCase()) >= 0 && (!best || k.length > best.length)) best = k; });
    return best ? links[best] : null;
  }
  function watchEntry(tag, text) {
    var el = document.createElement(tag), href = watchLink(text);
    if (href) { var a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = text; el.appendChild(a); }
    else el.textContent = text;
    return el;
  }
  // The pinned bar's run: copies of the lines that lead the news column (the
  // next game, the series, last season, the last out) and the strip's
  // networks and radio in short — shown only while the block is compact.
  function buildBrief(lead, watch) {
    var brief = document.createElement('div'); brief.className = 'tf-brief'; brief.setAttribute('aria-hidden', 'true');
    if (lead) { var nx = lead.querySelector('.tf-next, .tf-state'); if (nx) brief.appendChild(nx.cloneNode(true)); } // the next game (or the game's state) only: eight lines ellipsised to a few letters each said nothing (Steve, 2026-09-18); the record and standing are the bar's head
    if (watch) {
      var tv = [], radio = [];
      watch.querySelectorAll('.tf-channels[data-kind="tv"] > li > b').forEach(function (b) { tv.push(b.textContent); });
      if (!tv.length) watch.querySelectorAll('.tf-channels[data-kind="stream"] > li > b').forEach(function (b) { tv.push(b.textContent); }); // streaming only: the services stand in
      watch.querySelectorAll('.tf-channels[data-kind="radio"] span').forEach(function (sp) { radio.push(sp.textContent); });
      if (tv.length) { var t = document.createElement('p'); t.className = 'tf-brief-watch'; t.innerHTML = '<b>TV</b> '; t.appendChild(document.createTextNode(tv.join(' · '))); brief.appendChild(t); }
      if (radio.length) { var r = document.createElement('p'); r.className = 'tf-brief-watch'; r.innerHTML = '<b>Radio</b> '; r.appendChild(document.createTextNode(radio.join(' · '))); brief.appendChild(r); }
    }
    return brief;
  }
  // The strip along the block's foot, in every state: streaming, TV and
  // radio, each behind its own mark. Three sections sit left, centre and
  // right; two sit at the ends; one sits centred (Steve, 2026-09-14) —
  // app.js hands styles.css the count (has-1/2/3) and each section its
  // place (at-l/at-c/at-r). The schedule's networks for a game not yet on
  // ESPN's board; a note when none are known yet. `label` names whose game
  // it is when it isn't the one shown ("Next game").
  function buildWatchStrip(names, radio, label, team) {
    // the club's standing outlets (channels.json clubs): its radio network and local streams, beside whatever the league listed; the feeds a Seattle viewer can't use left out
    var club = (channelsData && channelsData.clubs && team && channelsData.clubs[team.slug]) || {};
    names = (names || []).filter(function (n) { var i = channelInfo(n); return !(i && i.hide); });
    (club.tv || []).forEach(function (n) { if (names.indexOf(n) < 0) names.push(n); });
    radio = (radio || []).slice();
    (club.radio || []).forEach(function (r) { if (radio.indexOf(r) < 0) radio.push(r); });
    var wl = document.createElement('div'); wl.className = 'tf-watch';
    wl.appendChild(buildSchedButton());
    if (label) { var lb = document.createElement('b'); lb.className = 'tf-watch-label'; lb.textContent = label; wl.appendChild(lb); }
    var parts = splitWatch(names);
    var sections = [
      watchSection('stream', CAST_SVG, 'Streaming', parts.stream.length ? buildStreamList(parts.stream) : null),
      watchSection('tv', TV_SVG, 'TV', parts.tv.length ? buildWatchList(parts.tv, null, 'tv') : null),
      watchSection('radio', RADIO_SVG, 'Radio', radio && radio.length ? buildWatchList([], radio, 'radio') : null)
    ].filter(function (sec) { return !sec.classList.contains('is-empty'); });
    if (!sections.length) { var none = document.createElement('span'); none.className = 'tf-watch-none'; none.textContent = 'Broadcast to be announced'; wl.appendChild(none); }
    wl.classList.add('has-' + sections.length);
    var places = sections.length === 3 ? ['at-l', 'at-c', 'at-r'] : sections.length === 2 ? ['at-l', 'at-r'] : ['at-c'];
    sections.forEach(function (sec, i) { sec.classList.add(places[i]); wl.appendChild(sec); });
    var more = document.createElement('button'); more.type = 'button'; more.className = 'tf-wmore'; // the rest of the ways, when one line can't hold them (foldWatch shows the chevron)
    more.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
    function setWatchOpen(open) { wl.classList.toggle('is-open', open); more.title = open ? 'Fewer' : 'More ways to watch'; more.setAttribute('aria-label', more.title); more.setAttribute('aria-expanded', open ? 'true' : 'false'); }
    setWatchOpen(false);
    more.addEventListener('click', function () { setWatchOpen(!wl.classList.contains('is-open')); settleBlock(); });
    wl.appendChild(more);
    if (!channelsData) loadChannels().then(function () { // once the table has loaded: the numbers, the links, the club's own outlets (the countdown carries over)
      var fresh = buildWatchStrip(names, radio, label, team); fresh.className = fresh.className.replace(/\bis-open\b/, '') + (wl.classList.contains('is-open') ? ' is-open' : ''); fresh.style.cssText = wl.style.cssText;
      if (wl.parentNode) wl.parentNode.replaceChild(fresh, wl); foldNews(); foldWatch();
      var box = fresh.closest('.team-form'), old = box && box.querySelector('.tf-brief');
      if (old) old.replaceWith(buildBrief(box.querySelector('.tf-lead'), fresh));
    });
    return wl;
  }
  // The league's names sorted into the strip's sections. A network that
  // reaches a set (an antenna, DirecTV, Dish, Xfinity) is TV; a name with
  // no set behind it (Peacock, NWSL+, MLB.TV) is streaming itself. The
  // streaming section is a list of groups, each a name and the ways to it:
  // a service the league named, with its own ways (free at…, the app on…);
  // then each TV network with the services that carry it ("BTN via Fox One
  // · YouTube TV"), so a carrier is never mistaken for a channel of its own.
  function splitWatch(names) {
    var tv = [], stream = [], seen = {};
    // two names for one thing (KHN/Prime, Kraken Hockey Network, KONG — the same set and the same services) show once, under the first
    names.forEach(function (n) {
      var info = channelInfo(n), set = info && (info.ota || info.directv || info.dish || info.xfinity);
      var k = set ? JSON.stringify([info.ota, info.directv, info.dish, info.xfinity]) : String(n).toLowerCase();
      if (seen[k]) return; seen[k] = true;
      if (set || !info) tv.push(n);
      else stream.push({ name: n, ways: (info.stream || []).filter(function (x) { return x.toLowerCase() !== String(n).toLowerCase(); }), apps: info.apps || null, bars: info.bars || null, via: false });
    });
    tv.forEach(function (n) { // the networks' carriers, after the services named outright — one group per distinct set of carriers
      var info = channelInfo(n), k = info && JSON.stringify(info.stream || []);
      if (info && (info.stream || []).length && !seen[k]) { seen[k] = true; stream.push({ name: n, ways: info.stream.slice(), apps: null, via: true }); }
    });
    return { tv: tv, stream: stream };
  }
  var TV_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M8 21h8M12 18v3M8 3l4 3 4-3"/></svg>';
  var RADIO_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="9" width="18" height="12" rx="2"/><circle cx="8.5" cy="15" r="2.5"/><path d="M14 13h4M14 17h4M6 9l12-6"/></svg>';
  function watchSection(kind, svg, title, list) { // a section: its mark, then its list — marked empty (and left out of the strip) when the game has none of that kind
    var sec = document.createElement('div'); sec.className = 'tf-sect tf-sect-' + kind; sec.dataset.kind = kind;
    if (!list) { sec.classList.add('is-empty'); return sec; }
    var ico = document.createElement('span'); ico.className = 'tf-ico'; ico.title = title; ico.innerHTML = svg + '<span class="sr-only">' + title + '</span>'; sec.appendChild(ico);
    sec.appendChild(list);
    return sec;
  }
  // a list for a section — TV: each network with the ways to a set (the
  // antenna, DirecTV, Xfinity); radio: the stations. Every entry a link
  // where the table has one.
  function buildWatchList(names, radio, kind) {
    var ul = document.createElement('ul'); ul.className = 'tf-channels'; ul.dataset.kind = kind || 'tv';
    names.forEach(function (n) {
      var li = document.createElement('li'), info = channelInfo(n);
      li.appendChild(watchEntry('b', n));
      var how = [];
      if (info && kind === 'tv') {
        if (info.ota) how.push('over the air ' + info.ota);
        if (info.directv) how.push('DirecTV ' + info.directv);
        if (info.xfinity) how.push('Xfinity ' + info.xfinity);
      }
      how.forEach(function (h) { li.appendChild(watchEntry('span', h)); });
      ul.appendChild(li);
    });
    if (radio && radio.length) {
      var rl = document.createElement('li');
      radio.forEach(function (r) { rl.appendChild(watchEntry('span', r)); }); ul.appendChild(rl);
    }
    return ul;
  }
  // the streaming section's list: a group per name — its ways, dot-
  // separated, the carriers of a network behind "via"; then the group's
  // apps (channels.json apps: device → its install page), "app on Apple TV
  // · Fire TV · Roku", each device a link to install it
  function buildStreamList(groups) {
    var ul = document.createElement('ul'); ul.className = 'tf-channels'; ul.dataset.kind = 'stream';
    groups.forEach(function (g) {
      var li = document.createElement('li');
      li.appendChild(watchEntry('b', g.name));
      g.ways.forEach(function (w, i) {
        var sp = watchEntry('span', w);
        if (g.via && i === 0) sp.insertBefore(document.createTextNode('via '), sp.firstChild);
        li.appendChild(sp);
      });
      if (g.bars) { var bs = document.createElement('span'); bs.appendChild(document.createTextNode('bars: ')); g.bars.forEach(function (b, i) { if (i) bs.appendChild(document.createTextNode(' · ')); var e = watchEntry('span', b); while (e.firstChild) bs.appendChild(e.firstChild); }); li.appendChild(bs); } // the commercial service a venue subscribes to for it (channels.json bars)
      if (g.apps) Object.keys(g.apps).forEach(function (dev, i) {
        var sp = document.createElement('span'), a = document.createElement('a');
        a.href = g.apps[dev]; a.target = '_blank'; a.rel = 'noopener'; a.textContent = dev; a.title = 'Install the ' + g.name + ' app on ' + dev;
        if (i === 0) sp.appendChild(document.createTextNode('app on '));
        sp.appendChild(a); li.appendChild(sp);
      });
      ul.appendChild(li);
    });
    return ul;
  }
  // ---- a live game: the block becomes the game ----
  // While the club has a game on today, ESPN's scoreboard is asked every
  // minute (the page visible, the Teams view open); once the game is in
  // progress the season block gives way to the score, the situation and
  // where to watch, and once it's final the result stays until the next
  // visit. The feed is ESPN's because it answers from the browser.
  var POLL_MS = 30000; // the scoreboard is asked this often while a game is on (styles.css tf-tick counts it down — keep the two in step)
  var live = { slug: null, event: null, events: {}, shown: null, shownBy: {}, timer: null, at: null, busy: false, lastOut: {}, matchup: {}, pitches: {}, lastPitch: {}, highlights: {}, odds: {}, polled: {}, hockey: {} }; // hockey: per club, what the game summary adds to the bug (the shots, the power plays) // polled: the clubs a scoreboard poll has answered for (the first draw waits for it)
  // MLB's clips for the game (statsapi's content feed, open to the browser),
  // newest first, a few of them: linked to their pages on mlb.com. Fetched
  // with each poll while the game is on, once it is over, and kept by game.
  function fetchHighlights(team, g, hold) { // hold: the caller redraws the block once everything is in (pollLive) — no redraw from here
    if (!g || !g.id) return Promise.resolve();
    var have = live.highlights[team.slug];
    if (have && have.id === g.id && have.final && Date.now() - have.at < 600000) return Promise.resolve(); // a final's clips: refreshed every ten minutes
    return fetch('https://statsapi.mlb.com/api/v1/game/' + g.id + '/content', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (c) {
        var items = ((((c || {}).highlights || {}).highlights || {}).items) || [];
        var clips = items.filter(function (i) { return i.slug && i.title; }).map(function (i) { return { title: i.title, url: 'https://www.mlb.com/video/' + i.slug, date: i.date || '' }; });
        clips.sort(function (a, b) { return b.date.localeCompare(a.date); });
        var was = live.highlights[team.slug];
        live.highlights[team.slug] = { id: g.id, at: Date.now(), final: !!(g.res), clips: clips.slice(0, 5), n: clips.length };
        if (!hold && teamSelected(team.slug) && (!was || was.id !== g.id || was.n !== clips.length)) swapFormBlock(team, true);
      })
      .catch(function () { /* no clips: the column stands without them */ });
  }
  // the game the block follows: today's if there is one, else yesterday's
  // (its final stays up through the following day), else the next one if
  // it is within two days (the pregame — the odds, the starters — from
  // two days out until it starts)
  var AHEAD_DAYS = 2;
  function dayBefore(s) { var d = parseDate(s); d.setDate(d.getDate() - 1); return ymd(d); }
  function dayAfter(s, n) { var d = parseDate(s); d.setDate(d.getDate() + (n || 1)); return ymd(d); }
  function liveGameToday(slug) {
    var today = todayStr(), yday = dayBefore(today), horizon = dayAfter(today, AHEAD_DAYS);
    var gs = teamGames(slug) || [];
    return gs.filter(function (g) { return g.date === today; })[0] || gs.filter(function (g) { return g.date === yday; })[0] ||
      gs.filter(function (g) { return g.date > today && g.date <= horizon; })[0];
  }
  // A club ESPN doesn't cover (the Torrent, the Seawolves) gets the same
  // block from the schedule alone: the game ahead, and the final once the
  // feed's next run brings the result — no live score, no odds.
  function synthEvent(team, g) {
    var when = new Date(g.date + 'T' + (g.tbd || !g.time ? '12:00:00' : g.time));
    var us = { team: { id: 'us', abbreviation: clubAbbr(team), displayName: clubName(team), shortDisplayName: team.label, color: String((team.colors || [])[0] || '').replace('#', '') }, score: g.res ? String(g.res.us) : '', homeAway: g.home ? 'home' : 'away' };
    var them = { team: { id: 'them', abbreviation: g.opp.abbrev || String(g.opp.short || g.opp.name).slice(0, 3).toUpperCase(), displayName: g.opp.name, shortDisplayName: g.opp.short || g.opp.name, name: g.opp.short || g.opp.name, logo: g.opp.logo }, score: g.res ? String(g.res.them) : '', homeAway: g.home ? 'away' : 'home' };
    var detail = g.res ? 'Final' + (g.res.ot ? '/' + g.res.ot : '') : '';
    return { id: 'sched-' + g.date, date: when.toISOString(), links: [], competitions: [{ competitors: [us, them], status: { type: { state: g.res ? 'post' : 'pre', detail: detail, shortDetail: detail } }, venue: { fullName: g.home ? team.venue : (g.venue || '') }, broadcasts: g.watch && g.watch.tv ? [{ market: 'national', names: g.watch.tv }] : [], details: [] }] };
  }
  // ?team=x&demo=live (or pre, final): the block as a game — a made-up
  // one on the club's next (or last) fixture, no feed asked — so its look
  // can be worked on when nothing is being played. Local use only.
  var DEMO = (new URLSearchParams(location.search).get('demo') || '').toLowerCase();
  if (DEMO && !/^(live|pre|final)$/.test(DEMO)) DEMO = 'live';
  // &inning=4: a baseball demo starts at the top of that inning and moves a
  // half-inning on every poll (30 s), runs trickling in, to the final after
  // the 9th — a game that plays out, for watching the block change state
  // (Steve, 2026-09-15). Without it: bottom of the 7th, standing still.
  // &period=N (or inning / quarter / half, whichever the sport calls it):
  // the demo starts at that period and plays a step on every poll — a half-
  // inning, a quarter of a quarter, a sixth of a half — to the final; the
  // final stands for a minute, then the game starts over from the FIRST
  // period (Steve, 2026-09-17). Without it: a still frame mid-game.
  var DEMO_CLOCK = { baseball: { periods: 9, ticks: 2 }, football: { periods: 4, ticks: 4, len: 15 }, basketball: { periods: 4, ticks: 4, len: 10 }, hockey: { periods: 3, ticks: 4, len: 20 }, soccer: { periods: 2, ticks: 6, len: 45 }, rugby: { periods: 2, ticks: 6, len: 40 } };
  // any word for it works for any sport (Steve, 2026-09-17): &inning=7 on a
  // football page is folded into the sport's count — 7 mod 4 quarters = the 3rd
  var demoQ = new URLSearchParams(location.search);
  var DEMO_START = ['period', 'inning', 'quarter', 'half', 'frame', 'round', 'set', 'stage', 'start'].map(function (k) { return Number(demoQ.get(k)) || 0; }).filter(Boolean)[0] || 0;
  var demoStart = DEMO_START; // the period this run began at (1 once the game has looped)
  var demoTicks = 0; // polls so far in this run
  function demoEvent(team) {
    var today = todayStr(), gs = teamGames(team.slug) || [];
    var g = gs.filter(function (x) { return x.date === today; })[0] || gs.filter(function (x) { return x.date > today; })[0] || gs[gs.length - 1];
    if (!g) return null;
    var sport = team.espn ? team.espn.sport : team.sport, state = DEMO === 'pre' ? 'pre' : DEMO === 'final' ? 'post' : 'in';
    var ev = synthEvent(team, Object.assign({}, g, { res: null, date: today }));
    ev.id = 'demo-' + team.slug;
    var c = ev.competitions[0], us = c.competitors[0], them = c.competitors[1], st = c.status; c.id = ev.id; // the league's competitions carry the event's id; the bug looks its extras up by it
    var ourId = team.espn ? team.espn.id : 'us'; us.team.id = ourId; // the block finds us by the feed's id
    if (state === 'pre') { st.type = { state: 'pre', detail: '7:10 PM PT', shortDetail: '7:10 PM PT' }; live.matchup[team.slug] = { id: ev.id, stage: 'pre', at: Date.now(), data: { chance: { us: 36, them: 64 }, series: null, starters: {}, leaders: {}, injured: {} } }; return ev; } // made-up odds: the ring shows
    us.score = '4'; them.score = '3';
    if (state === 'post') { st.type = { state: 'post', detail: 'Final', shortDetail: 'Final', completed: true }; us.winner = true; return ev; }
    // the clock: how far the game has run, in steps (DEMO_CLOCK) — from the chosen period, else a still frame past the middle
    var ck = DEMO_CLOCK[sport] || DEMO_CLOCK.hockey, total = ck.periods * ck.ticks;
    var startAt = ((Math.max(1, demoStart) - 1) % ck.periods) + 1; // folded into the sport's count: inning 7 on a football page is the 3rd quarter
    var t = DEMO_START ? (startAt - 1) * ck.ticks + demoTicks : Math.round(total * 0.7);
    if (t >= total) { // the game has played out
      us.score = String(sport === 'baseball' ? 5 : sport === 'football' ? 27 : sport === 'basketball' ? 84 : sport === 'rugby' ? 24 : 3);
      them.score = String(sport === 'baseball' ? 3 : sport === 'football' ? 17 : sport === 'basketball' ? 79 : sport === 'rugby' ? 19 : 2);
      st.type = { state: 'post', detail: 'Final', shortDetail: 'Final', completed: true }; us.winner = true; return ev;
    }
    var period = Math.floor(t / ck.ticks) + 1, k = t % ck.ticks, frac = t / total;
    var ORD = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'];
    st.period = period;
    if (sport === 'baseball') {
      var bottom = k === 1, played = t;
      var half = (bottom ? 'Bottom ' : 'Top ') + ORD[period], short = (bottom ? 'Bot ' : 'Top ') + ORD[period];
      // runs trickle in as the innings go: 0-0 at the start, 4-3 late, 5-3 at the end
      us.score = String(Math.min(5, Math.floor(played * 4 / 13))); them.score = String(Math.min(3, Math.floor(played * 3 / 13)));
      st.type = { state: 'in', detail: half, shortDetail: short };
      var outs = played % 3, onBase = played % 4;
      c.situation = { balls: played % 4, strikes: played % 3, outs: outs, onFirst: onBase >= 1, onSecond: onBase === 2, onThird: onBase >= 3,
        pitcher: { athlete: { id: 'demo-p', displayName: bottom ? 'José Ryan' : 'Bryan Woo', shortName: bottom ? 'J. Ryan' : 'B. Woo' } },
        batter: { athlete: { id: 'demo-b', displayName: bottom ? 'Julio Rodríguez' : 'Mike Trout', shortName: bottom ? 'J. Rodríguez' : 'M. Trout' }, summary: bottom ? '1-3, HR, 2 RBI' : '0-2, BB' } };
      live.pitches[team.slug] = { 'demo-p': 40 + played * 6 };
      live.lastPitch[team.slug] = { mph: 94 + (played % 4), type: ['Four-seam FB', 'Slider', 'Changeup', 'Sweeper'][played % 4], result: ['Strike Looking', 'Ball', 'Foul', 'Swinging Strike'][played % 4] };
      live.lastOut[team.slug] = { id: 'demo-out-' + played, text: bottom ? 'Raleigh grounded out to second.' : 'Trout flied out to center.', batter: bottom ? 'C. Raleigh' : 'M. Trout', pitcher: bottom ? 'J. Ryan' : 'B. Woo', when: half };
    } else if (sport === 'soccer' || sport === 'rugby') { // halves, the minute counting up
      var minute = Math.round((period - 1) * ck.len + k * ck.len / ck.ticks), clock = minute + "'";
      st.type = { state: 'in', detail: clock, shortDetail: clock }; st.displayClock = clock;
      var goals = sport === 'soccer'
        ? [{ min: 23, us: true, who: 'J. Morris', how: 'Goal' }, { min: 41, us: false, who: 'D. Bouanga', how: 'Penalty - Scored' }, { min: 58, us: true, who: 'P. Arriola', how: 'Goal' }, { min: 77, us: true, who: 'A. Roldan', how: 'Goal' }]
        : [{ min: 12, us: true, who: 'J. Prat', how: 'Try' }, { min: 31, us: false, who: 'T. Bell', how: 'Try' }, { min: 55, us: true, who: 'M. Hill', how: 'Penalty' }, { min: 68, us: true, who: 'D. Sáyalo', how: 'Try' }];
      var so = goals.filter(function (x) { return x.min <= minute; });
      us.score = String(so.filter(function (x) { return x.us; }).length * (sport === 'rugby' ? 5 : 1)); them.score = String(so.filter(function (x) { return !x.us; }).length * (sport === 'rugby' ? 7 : 1));
      us.statistics = [{ name: 'possessionPct', displayValue: String(52 + (t % 3) * 3) }, { name: 'totalShots', displayValue: String(3 + t) }, { name: 'shotsOnTarget', displayValue: String(1 + (t >> 1)) }]; them.statistics = [{ name: 'possessionPct', displayValue: String(48 - (t % 3) * 3) }, { name: 'totalShots', displayValue: String(2 + (t >> 1)) }, { name: 'shotsOnTarget', displayValue: '1' }];
      us.records = [{ type: 'total', summary: sport === 'soccer' ? '11-4-9' : '9-4' }]; them.records = [{ type: 'total', summary: sport === 'soccer' ? '8-8-8' : '6-7' }];
      c.details = so.map(function (x) { return { scoringPlay: true, team: { id: x.us ? ourId : 'them' }, athletesInvolved: [{ shortName: x.who }], clock: { displayValue: x.min + "'" }, type: { text: x.how } }; });
      if (minute >= 30) c.details.push({ team: { id: 'them' }, type: { text: 'Yellow Card' } }); if (minute >= 50) c.details.push({ team: { id: 'them' }, type: { text: 'Yellow Card' } }); if (minute >= 70) c.details.push({ team: { id: ourId }, type: { text: 'Red Card' } }); // the bookings, as the match wears on
      c.situation = { lastPlay: { text: ['Corner, Seattle. Conceded by the visitors.', 'Throw-in, visitors, in their own half.', 'Free kick, Seattle, 30 yards out.', 'Substitution, Seattle.'][t % 4] } };
    } else { // football, basketball, hockey: periods with a clock counting down
      var left = ck.len - k * ck.len / ck.ticks, mm = Math.floor(left), ss = Math.round((left - mm) * 60), clockDown = (k === 0 ? ck.len + ':00' : mm + ':' + (ss < 10 ? '0' : '') + ss);
      var label = clockDown + ' - ' + ORD[period];
      st.type = { state: 'in', detail: label, shortDetail: label }; st.displayClock = clockDown;
      var finalUs = sport === 'football' ? 27 : sport === 'basketball' ? 84 : 3, finalThem = sport === 'football' ? 17 : sport === 'basketball' ? 79 : 2;
      us.score = String(Math.floor(finalUs * frac / (sport === 'hockey' ? 1 : 7)) * (sport === 'hockey' ? 1 : 7)); them.score = String(Math.floor(finalThem * frac / (sport === 'hockey' ? 1 : 7)) * (sport === 'hockey' ? 1 : 7)); // in sevens for the ball games, whole goals for hockey
      us.records = [{ type: 'total', summary: sport === 'hockey' ? '3-1-0' : sport === 'basketball' ? '8-33' : '2-0' }]; them.records = [{ type: 'total', summary: sport === 'hockey' ? '2-2-1' : sport === 'basketball' ? '30-11' : '1-2' }]; // the records beside the names, as on a broadcast
      if (sport === 'hockey') { us.statistics = [{ name: 'saves', displayValue: String(9 + t) }]; them.statistics = [{ name: 'saves', displayValue: String(12 + t) }]; // the other side's saves make the shots on goal
        var hs = {}; hs[ourId] = 12 + t; hs.them = 9 + t; var hpp = {}; hpp[ourId] = (t > 4 ? 1 : 0) + '/' + Math.min(3, 1 + (t >> 2)); hpp.them = '0/' + Math.min(2, t >> 2);
        live.hockey[team.slug] = { id: ev.id, at: Date.now(), sog: hs, pp: hpp, powerPlay: t % 3 === 1 ? { team: ourId, short: 'them', left: 83, two: false } : t % 3 === 2 ? { team: 'them', short: ourId, left: 41, two: t % 6 === 5 } : null }; } // the summary's extras, as the poll would set them
      if (sport === 'basketball') { us.leaders = [{ name: 'points', leaders: [{ displayValue: String(9 + t * 2), athlete: { shortName: 'N. Diggins-Smith' } }] }]; them.leaders = [{ name: 'points', leaders: [{ displayValue: String(7 + t * 2), athlete: { shortName: 'L. Amihere' } }] }]; us.statistics = [{ name: 'fieldGoalPct', displayValue: '47.1' }]; them.statistics = [{ name: 'fieldGoalPct', displayValue: '38.5' }]; }
      if (sport === 'football') c.situation = { downDistanceText: ['1st & 10 at SEA 25', '2nd & 7 at SEA 42', '3rd & 3 at ARI 38', '1st & goal at ARI 6'][t % 4], possession: t % 2 ? 'them' : ourId, shortDownDistanceText: ['1st & 10', '2nd & 7', '3rd & 3', '1st & Goal'][t % 4], isRedZone: t % 4 === 3, homeTimeouts: 3 - (period > 2 ? 1 : 0), awayTimeouts: 3 - (t % 3), lastPlay: { text: ['K. Walker III rushed for 5 yards to the SEA 42.', 'S. Darnold pass complete to J. Smith-Njigba for 14 yards.', 'Incomplete pass intended for T. Lockett.', 'J. Myers 44-yard field goal is good.'][t % 4] } };
      if (sport === 'hockey') {
        var hg = [{ p: 1, at: 4.2, us: true, who: 'J. Eberle' }, { p: 2, at: 15.8, us: false, who: 'N. MacKinnon' }, { p: 2, at: 6.5, us: true, who: 'M. Beniers' }, { p: 3, at: 11.1, us: true, who: 'J. Schwartz' }, { p: 3, at: 2.2, us: false, who: 'C. Makar' }];
        var seen = hg.filter(function (x) { return x.p < period || (x.p === period && x.at >= left); }); // clocks count down: a goal "at 4.2" came with 4:12 left
        us.score = String(seen.filter(function (x) { return x.us; }).length); them.score = String(seen.filter(function (x) { return !x.us; }).length);
        c.details = seen.map(function (x) { var m = Math.floor(x.at), sx = Math.round((x.at - m) * 60); return { scoringPlay: true, team: { id: x.us ? ourId : 'them' }, athletesInvolved: [{ shortName: x.who }], clock: { displayValue: m + ':' + (sx < 10 ? '0' : '') + sx }, period: { number: x.p }, type: { text: 'Goal' } }; });
      }
      if (sport !== 'football') c.situation = { lastPlay: { text: sport === 'basketball' ? ['N. Diggins-Smith makes 3-pt jump shot', 'N. Ogwumike makes layup', 'E. Magbegor defensive rebound', 'J. Loyd misses free throw'][t % 4] : ['Shot on goal by Beniers, saved.', 'Penalty: hooking, 2 minutes.', 'Faceoff won by Wright.', 'Grubauer with the glove save.'][t % 4], probability: sport === 'basketball' ? { homeWinPercentage: 0.38 + frac * 0.2, awayWinPercentage: 0.62 - frac * 0.2 } : undefined } };
    }
    var titles = sport === 'baseball' ? ['Rodríguez launches a two-run homer to left', 'Raleigh guns down a runner at second', 'Woo strikes out the side in the 4th', 'Crawford\'s diving stop saves a run', 'Arozarena doubles off the wall'] :
      sport === 'football' ? ['Smith-Njigba takes a slant 45 yards to the house', 'Love goes airborne for the interception', 'Walker III bounces outside for 18', 'Williams sacks the quarterback on third down', 'Myers drills a 52-yard field goal'] :
      sport === 'soccer' ? ['Morris heads home the opener', 'Bouanga converts from the spot', 'Arriola finishes a sweeping move', 'Frei denies a point-blank header', 'Roldan clips the crossbar from 25 yards'] :
      sport === 'hockey' ? ['Eberle opens the scoring on the power play', 'MacKinnon answers with a wrist shot', 'Grubauer robs a breakaway', 'Beniers rings the post', 'Three-minute recap'] :
      ['Diggins-Smith drains a step-back three', 'Ogwumike finishes through contact', 'A chase-down block to end the quarter', 'Fast-break dunk off the steal', 'Game highlights'];
    live.highlights[team.slug] = { id: ev.id, at: Date.now(), final: false, n: 5, clips: titles.map(function (t) { return { title: t, url: '#' }; }) };
    return ev;
  }
  // the demo's club: the one the address named when the page opened (?team=mariners&demo=live) — only that one plays;
  // switching pills shows the other clubs as they are (Steve, 2026-09-16: "in demo mode multiple teams seem live")
  var DEMO_SLUG = ((new URLSearchParams(location.search).get('team') || '').split(',')[0] || '').trim();
  function demoPoll() { // the demo's poll: no feed — the same made-up game again, so the ring and the redraw behave as they do live
    var t = LQAFilter.TEAMS.filter(function (x) { return x.slug === DEMO_SLUG; })[0] || selectedTeams()[0];
    if (!t) return;
    if (!DEMO_SLUG) DEMO_SLUG = t.slug; // no club in the address: the first one picked is the demo's from here on
    live.at = new Date();
    var ev = demoEvent(t);
    demoTicks++; // the next poll is the next half-inning
    Object.keys(live.events).forEach(function (k) { if (k !== t.slug) delete live.events[k]; }); // no other club is playing
    live.events[t.slug] = ev; live.event = ev; live.slug = t.slug;
    var state = ev && ev.competitions[0].status.type.state;
    $('teamStrip').querySelectorAll('.team-tab').forEach(function (pill) { pill.classList.toggle('is-live', pill.dataset.slug === t.slug && state === 'in'); });
    live.shown = state || null; live.shownBy[t.slug] = state || null;
    if (teamSelected(t.slug)) { if (teamView.slugs.length > 1) syncHead(t); else swapFormBlock(t); } // its block only while it is the club on show
    // a played-out game loops (Steve, 2026-09-16): the final stands for two polls, then the game starts over from the chosen inning
    if (state === 'post' && DEMO_START) { demoTicks = 0; demoStart = 1; live.timer = setTimeout(pollLive, 2 * POLL_MS); return; } // the next poll draws the start of the 1st period
    live.timer = setTimeout(pollLive, state === 'in' ? POLL_MS : 10 * POLL_MS);
  }
  // Every club with a game on today is checked (one scoreboard call per
  // league): the strip's pill pulses for a game in progress, and the
  // selected club's block becomes its game.
  function pollLive(force) {
    clearTimeout(live.timer);
    if ($('teamsView').hidden) return;
    if (DEMO) { demoPoll(); return; }
    var playing = LQAFilter.TEAMS.filter(function (t) { return t.espn && liveGameToday(t.slug); });
    if (!playing.length) return;
    if (document.hidden && !force) { live.timer = setTimeout(pollLive, POLL_MS); return; }
    live.busy = true; $('teamHead').querySelectorAll('.tf-refresh').forEach(function (b) { b.classList.add('is-busy'); });
    var today = todayStr();
    var anyIn = false; // a game in progress somewhere: the quick poll; otherwise every few minutes
    // a league's board: the day of each of its clubs' wanted game (liveGameToday) and the day after — ESPN files a game under its
    // Eastern date, so a late Seattle start can sit on the next day's board — asked for a day at a time (ESPN's scoreboard stopped
    // taking a range on 2026-09-18: dates=A-B answers 400, every league). Any day that fails fails the league's board: a partial
    // board once read as "no game today" and the block flipped to the season card between polls (Steve's recording, 2026-09-18)
    var dates = {};
    playing.forEach(function (t) { var k = t.espn.sport + '/' + t.espn.league, g = liveGameToday(t.slug); var ds = dates[k] = dates[k] || {}; ds[g.date] = true; ds[dayAfter(g.date, 1)] = true; });
    Promise.all(Object.keys(dates).map(function (k) {
      return Promise.all(Object.keys(dates[k]).sort().map(function (d) {
        return fetch(scoreboardUrl(k, d.replace(/-/g, '')), { cache: 'no-store' })
          .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
      })).then(function (boards) { // the days' boards as one, each event once
        if (boards.some(function (b) { return !b || !Array.isArray(b.events); })) return [k, null];
        var seen = {}, events = [];
        boards.forEach(function (j) { j.events.forEach(function (e) { if (!seen[e.id]) { seen[e.id] = true; events.push(e); } }); });
        return [k, { events: events }];
      });
    })).then(function (pairs) {
      var boards = {};
      pairs.forEach(function (p) { boards[p[0]] = p[1]; });
      live.at = new Date();
      playing.forEach(function (t) {
        var j = boards[t.espn.sport + '/' + t.espn.league];
        if (!j) { if (waitingBlock(t.slug)) { live.polled[t.slug] = true; swapFormBlock(t, true); } return; } // that league's board didn't come: leave what we had (a placeholder gives way to the season card)
        live.polled[t.slug] = true;
        var want = liveGameToday(t.slug), ours = (j.events || []).filter(function (e) {
          return (e.competitions[0].competitors || []).some(function (c) { return String(c.team.id) === t.espn.id; });
        });
        // the event on the game's day (today's game first, else yesterday's)
        var ev = ours.filter(function (e) { return seattleDay(e.date) === want.date; })[0] || ours[ours.length - 1];
        live.events[t.slug] = ev || null;
        var state = ev && ev.competitions[0].status.type.state; // pre, in, post
        if (state === 'in') anyIn = true;
        var pill = $('teamStrip').querySelector('.team-tab[data-slug="' + t.slug + '"]');
        if (pill) pill.classList.toggle('is-live', state === 'in');
        if (teamSelected(t.slug)) {
          var want = state || null; // the game block all game day: before, during and after — and the day after
          var one = teamView.slugs.length === 1;
          if (one) { live.event = ev || null; live.slug = t.slug; }
          // re-drawn while live (the score moves) and whenever the stage changes
          var prev = one ? live.shown : live.shownBy[t.slug];
          // one redraw, with the play-by-play (the last out, the pitch count) and the clips already in: drawn as each landed, the block
          // showed three different things in its first second after a reload — the season card, the news column, then the highlights
          // (Steve's recording, 2026-09-18). A first draw (the placeholder from teamBlock) always goes ahead, whatever the state.
          var waits = [];
          if (want === 'in' && t.espn.sport === 'baseball') waits.push(fetchLastOut(t, ev, true)); // the play-by-play, for the last out
          if (want === 'in' && t.espn.sport === 'hockey') waits.push(fetchHockey(t, ev, true)); // the box score's shots and the penalties, for the power play
          if ((want === 'in' || want === 'post') && t.espn.sport === 'baseball') waits.push(fetchHighlights(t, liveGameToday(t.slug), true)); // the game's clips
          var redraw = want === 'in' || want !== prev || waitingBlock(t.slug);
          if (want === 'pre' || want === 'post') { var mp = fetchMatchup(t, ev, want, redraw); if (redraw) waits.push(mp); } // the matchup before the game; the series line after — held for the draw below when there is one
          if (redraw) {
            live.shownBy[t.slug] = want; if (one) live.shown = want;
            Promise.all(waits).then(function () { if (one) swapFormBlock(t); else syncHead(t); });
          }
        }
      });
    }).then(function () {
      live.busy = false; $('teamHead').querySelectorAll('.tf-refresh').forEach(function (b) { b.classList.remove('is-busy'); });
      live.timer = setTimeout(pollLive, anyIn ? POLL_MS : 10 * POLL_MS);
    });
  }
  function seattleDay(iso) { return new Date(iso).toLocaleDateString('en-CA', { timeZone: CITY.tz || 'America/Los_Angeles' }); } // the city's day (city.js tz)
  // a league's scoreboard for a day or a span (college football's lists every FBS game only when asked for the group, and enough of them)
  function scoreboardUrl(k, dates) { return 'https://site.api.espn.com/apis/site/v2/sports/' + k + '/scoreboard?dates=' + dates + (/college/.test(k) ? '&groups=80&limit=300' : ''); }
  function swapFormBlock(team, quiet) {
    var old = $('teamHead').querySelector('.team-form[data-slug="' + team.slug + '"]');
    if (!old) return;
    var games = teamGames(team.slug) || [], ev = live.events[team.slug];
    var fresh = teamStage(team.slug) ? renderTeamLive(team, ev) : renderTeamForm(team, games, todayStr());
    fresh.dataset.slug = team.slug;
    if (!quiet && old.classList.contains('is-live') && fresh.classList.contains('is-live')) fresh.classList.add('is-flash'); // a fresh score: the block glows for a beat
    old.replaceWith(fresh);
    settleBlock();
  }
  // Baseball's most recent out, from ESPN's game summary: the last at-bat
  // that ended in one (its "Play Result" line names the batter and whoever
  // made the play), with the batter and the pitcher looked up in the rosters.
  function fetchLastOut(team, ev, hold) { // hold: as fetchHighlights
    return fetch('https://site.api.espn.com/apis/site/v2/sports/' + team.espn.sport + '/' + team.espn.league + '/summary?event=' + ev.id, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        if (!s || !s.plays) return;
        var names = {}, pitches = {}; // the rosters carry one side; the box score has both — and each pitcher's pitch count (PC)
        function learn(a) { if (a && a.id && !names[a.id]) names[a.id] = a.shortName || a.displayName; }
        (s.rosters || []).forEach(function (r) { (r.roster || []).forEach(function (p) { learn(p.athlete); }); });
        ((s.boxscore && s.boxscore.players) || []).forEach(function (t) { (t.statistics || []).forEach(function (st) {
          var pc = (st.labels || []).indexOf('PC');
          (st.athletes || []).forEach(function (p) { learn(p.athlete); if (pc >= 0 && p.athlete && p.stats && p.stats[pc] != null) pitches[p.athlete.id] = p.stats[pc]; });
        }); });
        live.pitches[team.slug] = pitches;
        // the last pitch thrown: its speed, its type and what came of it (Ball, Strike Swinging, Fly Out…)
        var pitchPlays = s.plays.filter(function (p) { return p.pitchVelocity && p.summaryType === 'P'; }), lastPitch = pitchPlays[pitchPlays.length - 1];
        live.lastPitch[team.slug] = lastPitch ? { mph: lastPitch.pitchVelocity, type: lastPitch.pitchType && lastPitch.pitchType.text, result: lastPitch.type && lastPitch.type.text, count: lastPitch.resultCount } : null;
        var results = s.plays.filter(function (p) { return p.type && p.type.text === 'Play Result' && p.text; });
        var out = null;
        for (var i = results.length - 1; i >= 0; i--) {
          if (/\b(out|struck out|strikes out|double play|triple play|caught stealing|picked off)\b/i.test(results[i].text)) { out = results[i]; break; }
        }
        var was = live.lastOut[team.slug] && live.lastOut[team.slug].id;
        if (!out) { delete live.lastOut[team.slug]; return; }
        var who = {};
        (out.participants || []).forEach(function (x) { if (x.athlete && names[x.athlete.id]) who[x.type] = names[x.athlete.id]; });
        live.lastOut[team.slug] = {
          id: out.id, text: out.text.replace(/\s+/g, ' ').trim(), batter: who.batter || null, pitcher: who.pitcher || null,
          when: out.period ? (out.period.type === 'Top' ? 'Top ' : out.period.type === 'Bottom' ? 'Bot ' : '') + ordinal(out.period.number) : '',
        };
        if (!hold && teamSelected(team.slug) && teamStage(team.slug) === 'in') swapFormBlock(team, true); // the box score landed (a new out, a new pitch count): redraw without the flash
      })
      .catch(function () { /* the play-by-play didn't come: the line just stays off */ });
  }
  // ---- hockey's extras, from ESPN's game summary (the scoreboard carries neither) ----
  // The box score's shots on goal and power-play line per side, and the
  // penalties from the play list, from which the power play on right now
  // is worked out: a penalty called at 7:55 in the 1st runs to 5:55, so
  // while the clock is between them the other side is up a skater;
  // coincidental penalties cancel, a double minor runs four, a major five,
  // misconducts (10) bench nobody's side; a power-play goal ends a minor.
  function fetchHockey(team, ev, hold) { // hold: as fetchHighlights
    return fetch('https://site.api.espn.com/apis/site/v2/sports/' + team.espn.sport + '/' + team.espn.league + '/summary?event=' + ev.id, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        if (!s) return;
        var out = { id: ev.id, at: Date.now(), sog: {}, pp: {}, powerPlay: null };
        ((s.boxscore && s.boxscore.teams) || []).forEach(function (t) {
          var st = {}; (t.statistics || []).forEach(function (x) { st[x.name] = x.displayValue; });
          if (st.shotsTotal != null) out.sog[t.team.id] = +st.shotsTotal;
          if (st.powerPlayOpportunities != null) out.pp[t.team.id] = (st.powerPlayGoals || 0) + '/' + st.powerPlayOpportunities;
        });
        var c = ev.competitions[0], stt = c.status, per = stt.period || 0;
        var secs = function (clock) { var m = /(\d+):(\d+)/.exec(String(clock || '')); return m ? +m[1] * 60 + +m[2] : null; };
        var plen = function (n) { return n > 3 && !/playoff/i.test(String(ev.season && ev.season.type || '')) ? 300 : 1200; }; // regulation periods 20 minutes, the regular season's OT 5
        var at = function (n, clock) { var t = 0; for (var i = 1; i < n; i++) t += plen(i); var left = secs(clock); return left == null ? null : t + plen(n) - left; }; // game seconds elapsed
        var now = at(per, stt.displayClock);
        var pens = [], goals = [];
        (s.plays || []).forEach(function (p) {
          var mins = p.type && +p.type.penaltyMinutes, pn = p.period && p.period.number, t0 = pn ? at(pn, p.clock && p.clock.displayValue) : null;
          if (t0 == null) return;
          if (mins && mins !== 10 && p.team) pens.push({ team: String(p.team.id), start: t0, end: t0 + mins * 60, minor: mins < 5 });
          if (p.scoringPlay && p.team) goals.push({ team: String(p.team.id), t: t0 });
        });
        if (now != null) {
          var active = pens.filter(function (q) { return q.start <= now && now < q.end; });
          active.forEach(function (q) { if (q.minor) goals.forEach(function (g) { if (g.team !== q.team && g.t > q.start && g.t < q.end && g.t <= now) q.end = g.t; }); }); // a power-play goal ends a minor
          active = active.filter(function (q) { return now < q.end; });
          var ids = c.competitors.map(function (x) { return String(x.team.id); });
          var n = {}; ids.forEach(function (id) { n[id] = active.filter(function (q) { return q.team === id; }).length; });
          if (n[ids[0]] !== n[ids[1]]) {
            var short = n[ids[0]] > n[ids[1]] ? ids[0] : ids[1], up = short === ids[0] ? ids[1] : ids[0];
            var theirs = active.filter(function (q) { return q.team === short; }).sort(function (a, b) { return a.end - b.end; });
            out.powerPlay = { team: up, short: short, left: theirs[0].end - now, two: Math.abs(n[ids[0]] - n[ids[1]]) >= 2 };
          }
        }
        live.hockey[team.slug] = out;
        if (!hold && teamSelected(team.slug) && teamStage(team.slug) === 'in') swapFormBlock(team, true);
      })
      .catch(function () { /* the summary didn't come: the derived shots stay */ });
  }
  // ---- the matchup, from ESPN's game summary ----
  // Before the game: ESPN's matchup predictor, the season series and the
  // last meeting, the probable starters, each side's statistical leaders
  // (flagged when hurt) and the injured lists. After it: the series, now
  // including this game. Fetched once per event and stage, and again
  // after ten minutes (the lists move on game day); the block is redrawn
  // quietly when it lands.
  var STAT_ABBR = { avg: 'avg', homeRuns: 'HR', RBIs: 'RBI', ERA: 'ERA', wins: 'W', strikeouts: 'K', saves: 'SV', goals: 'G', assists: 'A', points: 'PTS', plusMinus: '+/−', goalsAgainstAverage: 'GAA', savePct: 'SV%', passingYards: 'pass yds', rushingYards: 'rush yds', receivingYards: 'rec yds', passingTouchdowns: 'pass TD', rushingTouchdowns: 'rush TD', receivingTouchdowns: 'rec TD', rebounds: 'REB', totalShots: 'shots', accuratePasses: 'passes', defensiveInterventions: 'def. plays', saves_soccer: 'saves' };
  function fetchMatchup(team, ev, stage, hold) { // hold: as fetchHighlights — the first draw waits for the matchup too (the estimate, slower, still lands on its own)
    var have = live.matchup[team.slug];
    if (have && have.id === ev.id && have.stage === stage && Date.now() - have.at < 600000) return Promise.resolve();
    return fetch('https://site.api.espn.com/apis/site/v2/sports/' + team.espn.sport + '/' + team.espn.league + '/summary?event=' + ev.id, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        if (!s) return;
        live.matchup[team.slug] = { id: ev.id, stage: stage, at: Date.now(), data: digestMatchup(s, team, ev) };
        if (!hold && teamSelected(team.slug) && teamStage(team.slug) === stage) swapFormBlock(team, true);
        if (stage === 'pre' && !live.matchup[team.slug].data.chance) estimateChance(team, ev).then(function (ch) { // nothing priced it: the estimate
          var m = live.matchup[team.slug];
          if (!ch || !m || m.id !== ev.id || m.data.chance) return;
          m.data.chance = ch;
          if (teamSelected(team.slug) && teamStage(team.slug) === stage) swapFormBlock(team, true);
        });
      })
      .catch(function () { /* the summary didn't come: the block stands without it */ });
  }
  // ---- the odds for the next game, on the season block ----
  // ESPN posts its matchup predictor days ahead for some leagues (a week
  // for the NFL, the WNBA; the NHL and MLS only on the day): the scoreboard
  // for the game's day names the event, its summary carries the projection.
  // Asked once an hour per club, for a game inside the next two weeks; the
  // season block is redrawn quietly when the odds land.
  var ODDS_DAYS = 14;
  // Warming, on opening the Teams view: every club's crest and its next
  // opponent's, and the odds for every club's next game (fetchNextOdds keeps
  // them an hour), so switching clubs draws the block complete at once
  // instead of once for the season bug and again when the odds land.
  var warmed = [];
  function warmTeams() {
    var today = todayStr();
    LQAFilter.TEAMS.forEach(function (t) {
      var gs = teamGames(t.slug) || [], next = gs.filter(function (g) { return g.date >= today; })[0];
      [t.logo, next && next.opp && next.opp.logo].forEach(function (src) { if (src) { var im = new Image(); im.src = src; warmed.push(im); } });
      if (next && t.espn) fetchNextOdds(t, next);
    });
  }
  function fetchNextOdds(team, g) {
    if (!team.espn || !g || g.date > dayAfter(todayStr(), ODDS_DAYS)) return;
    var have = live.odds[team.slug];
    if (have && have.date === g.date && Date.now() - have.at < 3600000) return;
    var keep = have && have.date === g.date ? have : {};
    live.odds[team.slug] = { date: g.date, at: Date.now(), chance: keep.chance || null, series: keep.series || null, them: keep.them || null }; // claimed: one fetch at a time
    var base = 'https://site.api.espn.com/apis/site/v2/sports/' + team.espn.sport + '/' + team.espn.league;
    fetch(scoreboardUrl(team.espn.sport + '/' + team.espn.league, g.date.replace(/-/g, '')), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var ev = ((j && j.events) || []).filter(function (e) { return (e.competitions[0].competitors || []).some(function (c) { return String(c.team.id) === team.espn.id; }); })[0];
        if (!ev) return null;
        var them = ev.competitions[0].competitors.filter(function (c) { return String(c.team.id) !== team.espn.id; })[0];
        return fetch(base + '/summary?event=' + ev.id, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; })
          .then(function (s) { var d = digestMatchup(s || {}, team, ev); return { chance: d.chance, series: d.series, leaders: d.leaders, injured: d.injured, them: them ? { abbr: them.team.abbreviation, color: them.team.color, alt: them.team.alternateColor } : null }; }) // no summary: the book's line still stands
          .then(function (o) { if (o.chance) return o; return estimateChance(team, ev).then(function (ch) { o.chance = ch; return o; }); }); // nothing priced it: the estimate
      })
      .then(function (o) {
        if (!o || !(o.chance || seriesText(o.series))) return;
        live.odds[team.slug] = { date: g.date, at: Date.now(), chance: o.chance, series: o.series, them: o.them, leaders: o.leaders, injured: o.injured }; // the leaders and the injured ride along for the block's column
        if (teamSelected(team.slug) && !teamStage(team.slug) && !waitingBlock(team.slug)) swapFormBlock(team, true); // the season block is up: redraw it with the ring (not the placeholder — the poll draws that)
      })
      .catch(function () { /* no odds: the block stands without them */ });
  }
  // one line on the series: its state, and how the last meeting went
  function seriesText(ser) {
    if (!ser || !(ser.text || ser.played)) return '';
    var sl = ser.last;
    var lastTxt = sl && (sl.us !== sl.them || sl.us) ? ' · last met ' + parseDate(sl.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + (sl.won ? 'won ' : sl.us === sl.them ? 'drew ' : 'lost ') + sl.us + '–' + sl.them + (sl.home ? ' at home' : ' away') : '';
    return (ser.text || (ser.played ? ser.played + ' played' : 'first meeting this season')) + lastTxt;
  }
  // The sportsbook's moneyline, carried on ESPN's scoreboard (DraftKings)
  // for nearly every game, turned into chances: each side's implied
  // probability, the bookmaker's margin taken out (they sum to 100). A
  // draw price (soccer) becomes a third share. Where ESPN's own predictor
  // is missing — the NHL, MLS, the NWSL — this stands in for it.
  function impliedChance(c, team) {
    var o = ((c && c.odds) || []).filter(Boolean)[0];
    if (!o) return null;
    function amer(x) { // an American price: "-114", "+100", "EVEN", or a number
      if (x == null) return NaN;
      if (typeof x === 'object') x = (x.close && x.close.odds) != null ? x.close.odds : x.open && x.open.odds;
      if (x == null) return NaN;
      if (/^even$/i.test(String(x).trim())) return 100;
      return parseFloat(String(x).replace('+', ''));
    }
    var ml = o.moneyline || {}, home = amer(ml.home), away = amer(ml.away);
    if (isNaN(home) && o.homeTeamOdds) home = amer(o.homeTeamOdds.moneyLine);
    if (isNaN(away) && o.awayTeamOdds) away = amer(o.awayTeamOdds.moneyLine);
    var draw = o.drawOdds ? amer(o.drawOdds.moneyLine != null ? o.drawOdds.moneyLine : o.drawOdds) : NaN;
    if (isNaN(home) || isNaN(away)) return null;
    function prob(a) { return a < 0 ? -a / (-a + 100) : 100 / (a + 100); }
    var ph = prob(home), pa = prob(away), pd = isNaN(draw) ? 0 : prob(draw), tot = ph + pa + pd;
    var usHome = (c.competitors || []).some(function (x) { return String(x.team.id) === team.espn.id && x.homeAway === 'home'; });
    var us = Math.round((usHome ? ph : pa) / tot * 100), dr = pd ? Math.round(pd / tot * 100) : 0;
    return { us: us, them: 100 - us - dr, draw: dr, source: ((o.provider || {}).name || 'the sportsbook') + ' line, via ESPN' };
  }
  // ---- an estimate, when no one has priced the game ----
  // Nobody posts a line for a preseason game, or for some leagues until
  // game day. Then: log5 on the two clubs' points percentages — this
  // season's once six games are in, else last season's, from ESPN's team
  // records — with the home side nudged up a little. Marked with a tilde
  // wherever it shows, and named as an estimate in the ring's title; a
  // real line replaces it on the next check.
  function estimateChance(team, ev) {
    var c = ev.competitions[0], sport = team.espn.sport;
    var usC = (c.competitors || []).filter(function (x) { return String(x.team.id) === team.espn.id; })[0];
    var themC = (c.competitors || []).filter(function (x) { return String(x.team.id) !== team.espn.id; })[0];
    if (!usC || !themC) return Promise.resolve(null);
    var base = 'https://sports.core.api.espn.com/v2/sports/' + sport + '/leagues/' + team.espn.league + '/seasons/';
    var year = (ev.season && ev.season.year) || new Date().getFullYear(), pre = !!(ev.season && ev.season.type === 1);
    function rec(id, y) { // the season's overall record: the regular season is type 2 in most leagues, 1 in soccer — the one with games in it wins
      return Promise.all([2, 1].map(function (t) {
        return fetch(base + y + '/types/' + t + '/teams/' + id + '/record', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
      })).then(function (rs) {
        var best = null;
        rs.forEach(function (j) {
          var it = j && (j.items || []).filter(function (i) { return i.name === 'overall' || i.type === 'total'; })[0];
          if (!it) return;
          var st = {}; (it.stats || []).forEach(function (x) { st[x.name] = x.value; });
          if (st.gamesPlayed && (!best || st.gamesPlayed > best.gamesPlayed)) best = st;
        });
        return best;
      });
    }
    function pct(st) { // points share: hockey two a win and one an overtime loss; soccer three and one; a tie half a win elsewhere
      var gp = st.gamesPlayed, w = st.wins || 0, l = st.losses || 0;
      if (!gp) return null;
      if (sport === 'hockey') return (2 * w + (gp - w - l)) / (2 * gp);
      if (sport === 'soccer') return st.points != null ? st.points / (3 * gp) : (3 * w + (gp - w - l)) / (3 * gp);
      return (w + (gp - w - l) / 2) / gp;
    }
    function season(id) { return (pre ? Promise.resolve(null) : rec(id, year)).then(function (st) { return st && st.gamesPlayed >= 6 ? st : rec(id, year - 1); }); }
    return Promise.all([season(team.espn.id), season(themC.team.id)]).then(function (r) {
      var a = r[0] && pct(r[0]), b = r[1] && pct(r[1]);
      if (a == null || b == null) return null;
      var usHome = usC.homeAway === 'home', edge = 0.03;
      a = Math.min(0.97, Math.max(0.03, a + (usHome ? edge : -edge))); b = Math.min(0.97, Math.max(0.03, b + (usHome ? -edge : edge)));
      var p = (a - a * b) / (a + b - 2 * a * b), draw = sport === 'soccer' ? 25 : 0, us = Math.round(p * (100 - draw));
      return { us: us, them: 100 - us - draw, draw: draw, est: true, source: 'an estimate from the two clubs\' records — no line yet' };
    }).catch(function () { return null; });
  }
  function digestMatchup(s, team, ev) { // ev: the scoreboard's event, for the book's line when the predictor is missing
    var mine = function (id) { return String(id) === team.espn.id; };
    var out = { chance: null, series: null, starters: {}, leaders: {}, injured: {} };
    var p = s.predictor;
    if (p && p.homeTeam && p.awayTeam) {
      var usP = mine(p.homeTeam.id) ? p.homeTeam : p.awayTeam, themP = usP === p.homeTeam ? p.awayTeam : p.homeTeam;
      if (usP.gameProjection) { var usR = Math.round(+usP.gameProjection); out.chance = { us: usR, them: 100 - usR, draw: 0, source: 'ESPN Matchup Predictor' }; } // one side rounded, the other its complement: 76 and 25 read as a mistake (Steve, 2026-09-18)
    }
    if (!out.chance && ev) out.chance = impliedChance(ev.competitions[0], team);
    // the series: the regular season's (or the head-to-head), its last completed meeting
    var ser = (s.seasonseries || []).filter(function (x) { return x.type !== 'preseason'; });
    ser = ser.filter(function (x) { return x.type === 'season'; })[0] || ser[ser.length - 1];
    if (ser) {
      var done = (ser.events || []).filter(function (e) { return e.status === 'post' || (e.statusType && e.statusType.completed); });
      var lastE = done[done.length - 1], lastM = null;
      if (lastE) {
        var cu = (lastE.competitors || []).filter(function (c) { return mine(c.team.id); })[0], ct = (lastE.competitors || []).filter(function (c) { return !mine(c.team.id); })[0];
        if (cu && ct) lastM = { date: seattleDay(lastE.date), us: +cu.score, them: +ct.score, won: cu.winner === true, home: cu.homeAway === 'home' };
      }
      out.series = { text: String(ser.summary || '').replace(/\bseries\b\s*/i, '').replace(/(\d)-(\d)/g, '$1–$2').trim(), played: done.length, last: lastM };
    }
    // each side: starters, leaders (hurt ones flagged), the injured
    var hurt = {}; // athlete id -> the injury, by team
    (s.injuries || []).forEach(function (t) {
      var key = mine(t.team.id) ? 'us' : 'them', list = [];
      (t.injuries || []).forEach(function (i) {
        if (!i.athlete) return;
        var d = i.details || {}, st = String(i.status || ''), what = String(d.type || d.detail || '').toLowerCase();
        var short = /\bIL\b/i.test(st) ? 'IL' : /injured reserve|^IR\b/i.test(st) ? 'IR' : /day.to.day/i.test(st) ? 'day-to-day' : st.toLowerCase();
        var inj = { name: i.athlete.shortName || i.athlete.displayName, pos: i.athlete.position && i.athlete.position.abbreviation, what: what, status: short, back: d.returnDate || '' };
        hurt[i.athlete.id] = inj; list.push(inj);
      });
      out.injured[key] = list;
    });
    (s.leaders || []).forEach(function (t) {
      var key = mine(t.team.id) ? 'us' : 'them', by = {}, order = [];
      (t.leaders || []).forEach(function (cat) {
        var x = cat.leaders && cat.leaders[0];
        if (!x || !x.athlete) return;
        var id = x.athlete.id, abbr = STAT_ABBR[cat.name] || (cat.shortDisplayName || cat.displayName || cat.name || '').toLowerCase();
        if (!by[id]) { by[id] = { name: x.athlete.shortName || x.athlete.displayName, pos: x.athlete.position && x.athlete.position.abbreviation, stats: [], hurt: hurt[id] || null }; order.push(id); }
        by[id].stats.push({ v: x.displayValue, a: abbr }); // the value as ESPN prints it ("16/22, 187 YDS, 1 TD") and the category's short name
      });
      out.leaders[key] = order.map(function (id) { return by[id]; });
    });
    var comps = (s.header && s.header.competitions && s.header.competitions[0] && s.header.competitions[0].competitors) || [];
    comps.forEach(function (c) {
      var pr = (c.probables || [])[0];
      if (!pr || !pr.athlete) return;
      var cats = {}; (((pr.statistics || {}).splits || {}).categories || []).forEach(function (k) { cats[k.name] = k.displayValue; });
      var line = pr.athlete.shortName || pr.athlete.displayName;
      if (cats.wins != null && cats.losses != null) line += ' ' + cats.wins + '-' + cats.losses;
      if (cats.ERA != null) line += ', ' + cats.ERA + ' ERA';
      out.starters[mine(c.team.id) ? 'us' : 'them'] = line;
    });
    return out;
  }
  // the pregame: ESPN's predictor as a ring split in the two clubs' colours
  // (ours from the top, clockwise, as much of the ring as our chance), the
  // percentages either side; then the starters, and the leaders on the IL
  function buildPredictor(m, team, us, them, cols) { // cols: the two colours to use as given (the scoreboard's cells), else each side's brighter one
    function esc(s) { return String(s).replace(/[&<>]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]; }); }
    if (!m.chance) return null;
    // each side's colour is whichever of its two stands off the card: the
    // brighter on the dark theme (navies and forest greens sink), the darker on the light
    var bg = (getComputedStyle(document.body).backgroundColor.match(/\d+/g) || [255, 255, 255]).map(Number);
    var dark = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 < 0.5;
    function pick(cols) {
      cols = cols.filter(Boolean).map(function (c) { return '#' + String(c).replace(/^#/, ''); });
      if (!cols.length) return '#8a97a4';
      cols.sort(function (x, y) { return dark ? lum(y) - lum(x) : lum(x) - lum(y); });
      return cols[0];
    }
    var ours = cols && cols.us ? cols.us : pick([team.colors && team.colors[0], team.colors && team.colors[1], us.team.color, us.team.alternateColor]);
    var theirs = cols && cols.them ? cols.them : pick([them.team.color, them.team.alternateColor]);
    var draw = m.chance.draw || 0, src = m.chance.source || 'ESPN Matchup Predictor';
    var box = document.createElement('div'); box.className = 'tf-pred'; box.title = 'Win chance — ' + src + (draw ? ' · draw ' + draw + '%' : '');
    // the ring: theirs all round, ours from the top clockwise as much as our chance, then the draw's share (grey) after ours
    box.innerHTML = '<span class="tp-side"><b>' + m.chance.us + '%</b>' + esc(us.team.abbreviation || team.label) + '</span>' + // the numbers in the page's ink: a navy on the dark card would vanish
      // a disc all but a pinhole (the band runs from 4 to 19.4 of 21); pathLength 100 so the dashes are percentages whatever the radius
      '<span class="tp-ring"><svg viewBox="0 0 42 42" aria-hidden="true"><circle cx="21" cy="21" r="11.7" pathLength="100" fill="none" stroke="' + theirs + '" stroke-width="15.4"/>' +
      '<circle cx="21" cy="21" r="11.7" pathLength="100" fill="none" stroke="' + ours + '" stroke-width="15.4" stroke-dasharray="' + m.chance.us + ' ' + (100 - m.chance.us) + '" transform="rotate(-90 21 21)"/>' +
      (draw ? '<circle cx="21" cy="21" r="11.7" pathLength="100" fill="none" stroke="#8a8f95" stroke-width="15.4" stroke-dasharray="' + draw + ' ' + (100 - draw) + '" transform="rotate(' + (-90 + m.chance.us * 3.6) + ' 21 21)"/>' : '') +
      '<circle cx="21" cy="21" r="20.1" fill="none" stroke="#f4f4f4" stroke-width="1"/><circle cx="21" cy="21" r="3.6" fill="none" stroke="#f4f4f4" stroke-width="1"/></svg>' + // a hairline either side of the band
      (draw ? '<i>draw ' + draw + '%</i>' : '') + '</span>' +
      '<span class="tp-side"><b>' + m.chance.them + '%</b>' + esc(them.team.abbreviation || them.team.shortDisplayName) + '</span>';
    return box;
  }
  // A baseball game in progress, drawn the way a broadcast draws it: the
  // pitcher and his pitch count along the top; a row per side — the
  // visitors first — the abbreviation on the club's colour and the score on
  // white; the inning between arrows (the filled one says which half); the
  // bases as three diamonds, lit when a runner is on; the outs as two
  // lamps (the third ends the half); the count beside them.
  function buildScorebug(team, c, us, them) {
    function esc(x) { return String(x).replace(/[&<>]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]; }); }
    var s = c.situation || {}, st = c.status, detail = String(st.type.shortDetail || st.type.detail || '');
    var half = /^(top)/i.test(detail) ? 'top' : /^(bot)/i.test(detail) ? 'bot' : ''; // Mid / End: between halves, neither arrow lit
    var inning = st.period || (detail.match(/\d+/) || [''])[0];
    var pitcher = s.pitcher && s.pitcher.athlete, batter = s.batter && s.batter.athlete, pcs = live.pitches[team.slug] || {};
    var pc = pitcher && pcs[pitcher.id] != null ? pcs[pitcher.id] : null;
    var surname = function (a) { return a ? String(a.displayName || a.shortName || '').trim().split(/\s+/).pop() : ''; };
    var last = surname(pitcher), lp = live.lastPitch[team.slug]; // the last pitch, as of the last box-score fetch
    var col = function (side) { return sideColor(side, us, team); }; // the club's primary; ours from filter.js, theirs from ESPN
    var order = us.homeAway === 'home' ? [them, us] : [us, them]; // visitors on top
    var rows = order.map(function (side) {
      return teamCell(side, team, col(side)) + '<span class="bug-score">' + esc(side.score || 0) + '</span>';
    });
    var b = document.createElement('div'); b.className = 'tf-bug'; b.title = detail;
    b.innerHTML = '<div class="bug-top"><span class="bug-pitcher">' + esc(last || detail) + '</span>' + (pc != null ? '<span class="bug-pc">P: ' + esc(pc) + '</span>' : '') + '</div>' +
      (batter ? '<div class="bug-top bug-bat"><span class="bug-batter">' + esc(surname(batter)) + '</span>' + (s.batter.summary ? '<span class="bug-pc">' + esc(s.batter.summary) + '</span>' : '') + '</div>' : '') +
      (lp ? '<div class="bug-top bug-pitch"><span>' + esc(lp.mph + ' mph' + (lp.type ? ' ' + lp.type : '')) + '</span>' + (lp.result ? '<span class="bug-pc">' + esc(lp.result) + '</span>' : '') + '</div>' : '') +
      '<div class="bug-grid">' + rows[0] +
      '<span class="bug-inn"><i class="bug-up' + (half === 'top' ? ' is-on' : '') + '"></i><b>' + esc(inning) + '</b><i class="bug-dn' + (half === 'bot' ? ' is-on' : '') + '"></i></span>' +
      '<span class="bug-field">' + // as the broadcast draws it: the count large with the outs beneath, the bases beside
      '<span class="bug-count">' + (s.balls != null && s.strikes != null ? '<b>' + s.balls + '-' + s.strikes + '</b>' : '<b>&nbsp;</b>') +
      '<span class="bug-outs"><i class="' + (s.outs >= 1 ? 'is-on' : '') + '"></i><i class="' + (s.outs >= 2 ? 'is-on' : '') + '"></i></span></span>' +
      '<svg class="bug-bases" viewBox="0 0 40 24" aria-hidden="true">' + // three diamonds set apart, second on top
      '<polygon class="' + (s.onSecond ? 'is-on' : '') + '" points="20,1 26,7 20,13 14,7"/>' +
      '<polygon class="' + (s.onThird ? 'is-on' : '') + '" points="11,9 17,15 11,21 5,15"/>' +
      '<polygon class="' + (s.onFirst ? 'is-on' : '') + '" points="29,9 35,15 29,21 23,15"/></svg></span>' +
      rows[1] + '</div>';
    var sr = document.createElement('span'); sr.className = 'sr-only';
    sr.textContent = detail + ', ' + (s.outs || 0) + ' out' + (pitcher ? ', pitching ' + (pitcher.shortName || '') : '');
    b.appendChild(sr);
    return b;
  }
  // The other sports' scorebug, in the same style: the clock along the top
  // (the half or the period, the down and distance in football, the
  // possession in soccer); a row per side — the visitors first — with the
  // score and, beside it, that side's goals (the scorer and the minute,
  // penalties and own goals marked) or, in football, the ball.
  function buildGenericBug(team, c, us, them) {
    function esc(x) { return String(x).replace(/[&<>]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]; }); }
    var s = c.situation || {}, st = c.status, type = st.type, sport = team.espn ? team.espn.sport : team.sport;
    var detail = String(type.shortDetail || type.detail || ''), final = type.state === 'post';
    var top = final ? (/^final/i.test(detail) ? detail.replace(/^final/i, 'Final') : 'Final' + (detail && !/^FT$/i.test(detail) ? ' · ' + detail : '')) : detail, right = '';
    if (final) { /* the result stands alone on the top row */ }
    else if (sport === 'football') { if (s.downDistanceText) right = s.downDistanceText; }
    else if (sport === 'soccer') {
      var poss = (us.statistics || []).filter(function (x) { return x.name === 'possessionPct'; })[0];
      if (poss && poss.displayValue) right = 'Possession ' + esc(us.team.abbreviation) + ' ' + Math.round(+poss.displayValue) + '%';
    }
    if (!right && st.displayClock && detail.indexOf(st.displayClock) < 0 && !/^(HT|FT|Final)/i.test(detail)) right = st.displayClock;
    var redZone = sport === 'football' && !final && !!s.isRedZone; // the broadcast turns the down and distance red inside the 20
    var stat = function (side, name) { var x = (side.statistics || []).filter(function (q) { return q.name === name; })[0]; return x && x.displayValue != null && x.displayValue !== '' ? +x.displayValue : null; };
    var abbr = function (side) { return (side === us && clubAbbr(team)) || side.team.abbreviation || side.team.shortDisplayName; };
    var hk = sport === 'hockey' && live.hockey[team.slug] && String(live.hockey[team.slug].id) === String(c.id) ? live.hockey[team.slug] : null; // the summary's extras for this game, once fetched
    var foot = null; // in play, every sport: the period, the clock and the sport's own state on a tab under the rows, as a broadcast draws it (the top row is left off)
    if (!final) {
      var ORD = ['', '1st', '2nd', '3rd', '4th'], p = st.period || 0, per = '';
      if (sport === 'hockey') per = p > 3 ? (/shootout|\bSO\b/i.test(detail) ? 'SO' : 'OT' + (p > 4 ? p - 3 : '')) : ORD[p] || '';
      else if (sport === 'soccer') per = p === 1 ? '1st half' : p === 2 ? '2nd half' : p ? 'Extra time' : '';
      else per = p > 4 ? 'OT' + (p > 5 ? p - 4 : '') : ORD[p] || '';
      var pause = /half|end of|delay|intermission|break|postpon|suspend/i.test(detail) && !/^\d/.test(detail) ? detail : ''; // Halftime, End of 3rd, Delay: the tab says so instead of a clock
      var third = '';
      if (sport === 'football') third = s.shortDownDistanceText || s.downDistanceText || '';
      else if (sport === 'soccer') { var pu = stat(us, 'possessionPct'); if (pu) third = 'Poss ' + abbr(us) + ' ' + Math.round(pu) + '%'; }
      else if (sport === 'basketball') { var pr = s.lastPlay && s.lastPlay.probability, w = pr ? (us.homeAway === 'home' ? pr.homeWinPercentage : pr.awayWinPercentage) : null; if (typeof w === 'number') third = abbr(us) + ' win ' + Math.round(w * 100) + '%'; } // ESPN's live win probability
      else if (sport === 'hockey' && hk && hk.powerPlay) { var pp = hk.powerPlay, upSide = String(us.team.id) === pp.team ? us : them, mm = Math.floor(pp.left / 60), ss = pp.left % 60; third = abbr(upSide) + (pp.two ? ' 5-on-3 ' : ' PP ') + mm + ':' + (ss < 10 ? '0' : '') + ss; } // the power play on right now, from the penalties
      var clock = sport === 'soccer' && /'/.test(detail) ? detail : (st.displayClock || ''); // soccer's clock is the minute ESPN prints: 45'+2
      foot = pause ? [pause] : [per, clock, third];
      right = ''; top = '';
    }
    var col = function (side) { return sideColor(side, us, team); };
    var goals = {}, cards = {}; // team id -> [text]; team id -> { y, r }
    (c.details || []).forEach(function (d) {
      var kind = String((d.type && d.type.text) || '');
      if (d.team && /card/i.test(kind)) { var cc = cards[d.team.id] = cards[d.team.id] || { y: 0, r: 0 }; if (/red/i.test(kind)) cc.r++; else cc.y++; }
      if (!d.scoringPlay || !d.team) return;
      var who = (d.athletesInvolved || [])[0], t = String((d.type && d.type.text) || '');
      var mark = /own goal/i.test(t) ? ' (og)' : /penalty/i.test(t) ? ' (pen)' : '';
      (goals[d.team.id] = goals[d.team.id] || []).push(esc((who ? who.shortName || who.displayName : 'Goal') + (d.clock && d.clock.displayValue ? ' ' + d.clock.displayValue : '') + mark));
    });
    var order = us.homeAway === 'home' ? [them, us] : [us, them];
    var timeouts = function (side) { return side.homeAway === 'home' ? s.homeTimeouts : s.awayTimeouts; }; // the league's count, when its feed carries the situation
    var record = function (side) { var r = (side.records || []).filter(function (x) { return x.type === 'total' || /^overall$/i.test(x.name || ''); })[0] || (side.records || [])[0]; return r && r.summary; };
    var evs = [];
    var rows = order.map(function (side) {
      var ev = goals[side.team.id] ? goals[side.team.id].join(', ') : '', extra = '', lead = '';
      if (!final) { // as a broadcast draws it: the record with the name; beside the score what the sport counts, then the scorers
        var rec = record(side), other = side === us ? them : us;
        if (rec) extra = '<small class="bug-rec">' + esc(rec) + '</small>';
        if (sport === 'football') {
          var to = timeouts(side);
          if (typeof to === 'number') { var pips = ''; for (var i = 0; i < 3; i++) pips += '<b' + (i < to ? ' class="on"' : '') + '></b>'; lead = '<i class="bug-to" title="' + to + ' timeout' + (to === 1 ? '' : 's') + ' left">' + pips + '</i>'; }
          if (s.possession && String(s.possession) === String(side.team.id)) extra = BALL_SVG + extra; // the ball at the left edge of the name cell (styles.css .bug-poss)
        } else if (sport === 'hockey') { // shots on goal from the box score, else the other side's saves plus what went in; the power-play line when the box score has it
          var sog = hk && hk.sog[side.team.id] != null ? hk.sog[side.team.id] : null, sv = stat(other, 'saves');
          if (sog == null && sv != null) sog = sv + (+side.score || 0);
          var hp = []; if (sog != null) hp.push(sog + ' SOG'); if (hk && hk.pp[side.team.id]) hp.push(hk.pp[side.team.id] + ' PP');
          lead = hp.join(' · ');
          if (hk && hk.powerPlay && hk.powerPlay.short === String(side.team.id)) extra = '<small class="bug-sh" title="Short-handed">SH</small>' + extra;
        } else if (sport === 'soccer') { // the shots (on target) and the cards
          var sh = stat(side, 'totalShots'), ot = stat(side, 'shotsOnTarget'), cd = cards[side.team.id];
          if (sh != null) lead = sh + ' shot' + (sh === 1 ? '' : 's') + (ot != null ? ' (' + ot + ' on)' : '');
          if (cd) { var cm = ''; for (var y = 0; y < cd.y; y++) cm += '<i class="bug-card is-y" title="Yellow card"></i>'; for (var r = 0; r < cd.r; r++) cm += '<i class="bug-card is-r" title="Red card"></i>'; lead = cm + lead; }
        } else if (sport === 'basketball') { // the points leader and the shooting
          var pl = (side.leaders || []).filter(function (l) { return l.name === 'points'; })[0], l0 = pl && (pl.leaders || [])[0], fg = stat(side, 'fieldGoalPct');
          var parts = []; if (l0 && l0.athlete) parts.push(esc(l0.athlete.shortName || l0.athlete.displayName) + ' ' + esc(l0.displayValue)); if (fg != null) parts.push(Math.round(fg) + '% FG');
          lead = parts.join(' · ');
        }
      }
      if (lead && ev) ev = lead + ' · ' + ev; else ev = lead || ev;
      evs.push(!!ev);
      return teamCell(side, team, col(side), extra) + '<span class="bug-score">' + esc(side.score || 0) + '</span><span class="bug-ev">' + ev + '</span>';
    });
    var b = document.createElement('div'); b.className = 'tf-bug is-generic'; b.title = detail;
    var anyEv = evs.some(Boolean); // nothing to put beside the scores: the bug is just the rows
    b.innerHTML = (foot ? '' : '<div class="bug-top"><span class="bug-pitcher">' + esc(top) + '</span>' + (right ? '<span class="bug-pc">' + esc(right) + '</span>' : '') + '</div>') +
      '<div class="bug-grid bug-grid-2' + (anyEv ? '' : ' no-ev') + '">' + rows.join('') + '</div>' +
      (foot ? '<div class="bug-foot' + (foot.length === 1 ? ' is-pause' : '') + '">' + foot.map(function (x, i) { return '<span class="' + ['bug-per', 'bug-clock', 'bug-dd' + (redZone ? ' is-redzone' : '')][foot.length === 1 ? 0 : i] + '"' + (i === 2 && redZone ? ' title="Red zone"' : '') + '>' + esc(x) + '</span>'; }).join('') + '</div>' : '');
    return b;
  }
  // Before the game, in the same frame: the day and the start along the
  // top, a row per side with ESPN's chance of winning where the score will
  // go, and the predictor ring beside them (the odds, from two days out)
  function buildPregameBug(team, c, us, them, mu, rel, when) {
    function esc(x) { return String(x).replace(/[&<>]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]; }); }
    var sport = team.espn ? team.espn.sport : team.sport;
    // the top row: the day and the time, nothing else
    var start = (rel || 'Today') + (when ? ' · ' + new Date(when).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '');
    var col = function (side) { return sideColor(side, us, team); }; // the rows' colours: the clubs' primaries, kept apart and off black
    var order = us.homeAway === 'home' ? [them, us] : [us, them];
    var chance = mu && mu.chance ? mu.chance : null;
    var rows = order.map(function (side) {
      var rec = (side.records || []).filter(function (r) { return !r.type || r.type === 'total'; })[0]; // no odds yet: each side's season record where the chance would go
      var pct = chance ? (side === us ? chance.us : chance.them) + '%' : (rec && rec.summary) || '–';
      return teamCell(side, team, col(side)) + '<span class="bug-score bug-odds">' + esc(pct) + '</span>';
    });
    var ring = '';
    if (chance) { // the ring: ours from the top, clockwise, as much of it as our chance
      var pg = buildPredictor(mu, team, us, them, { us: col(us), them: col(them) }), svg = pg && pg.querySelector('svg'); // the ring in the rows' own colours
      if (svg) ring = '<span class="bug-ring" title="' + esc(pg.title) + '">' + svg.outerHTML + '</span>'; // the ring alone: the rows' colours say whose share is whose (the title names the source and any draw share) // the label sits with the ring, in the room beside it, not in the top row
    }
    var b = document.createElement('div'); b.className = 'tf-bug is-generic is-pregame' + (ring ? '' : ' no-ev'); b.title = 'Before the game'; // the tab under the bug says ODDS whatever priced the game (Steve, 2026-09-15: no ESTIMATE label)
    b.innerHTML = '<div class="bug-top"><span class="bug-pitcher">' + esc(start) + '</span></div>' +
      '<div class="bug-grid bug-grid-2' + (ring ? ' has-ring' : ' no-ev') + '">' + rows[0] + ring + rows[1] + '</div>';
    return b;
  }
  // "at" or "vs" between the crests on the compact bar
  function vsLine(ours, home, theirs) { // just the word: the crests either side say who
    var p = document.createElement('p'); p.className = 'tf-vs'; p.textContent = home ? 'vs' : 'at'; p.title = ours + (home ? ' vs ' : ' at ') + (theirs || '');
    return p;
  }
  // a club's nickname for the compact bar: ESPN's name field where it is one
  // (Seahawks, Kraken), else the display name without its city (Wave FC,
  // Courage) — and the whole name where nothing but a suffix would be left
  // (Toronto FC, Atlanta United FC, Angel City FC)
  var CLUB_CITY_RE = /^(San Diego|San Jose|San Francisco|Los Angeles|LA|Las Vegas|New York City|New York|New England|New Jersey|North Carolina|Kansas City|Salt Lake|St\. Louis|Tampa Bay|Green Bay|Golden State|Portland|Orlando|Houston|Chicago|Washington|Seattle|Utah|Louisville|Denver|Boston|Colorado|Columbus|Nashville|Atlanta|Austin|Charlotte|Cincinnati|Dallas|Minnesota|Montr[ée]al|Philadelphia|Vancouver|Toronto|Miami|Calgary|Edmonton|Anaheim|Winnipeg|Ottawa|Detroit|Pittsburgh|Buffalo|Carolina|Florida|Arizona|Phoenix|Indiana|Connecticut|Oakland|Sacramento|Cleveland|Baltimore|Milwaukee|Texas|Kansas|Oklahoma City|Memphis|Brooklyn|Bay Area)\s+/i;
  function nickname(t) {
    if (!t) return '';
    if (t.name && t.name !== t.displayName && !/^[A-Z]{2,4}$/.test(t.name)) return t.name;
    var full = t.displayName || t.shortDisplayName || t.name || '', rest = full.replace(CLUB_CITY_RE, '');
    return rest && rest !== full && !/^(FC|SC|CF|United|City|United FC|City FC|City SC)$/i.test(rest) ? rest : full;
  }
  // a row's colour in the bug: the club's primary — ours from filter.js, theirs from ESPN — unless that is near black
  // (Angel City, the Aces), which reads as a black bar on the dark frame: then the alternate, when it is lighter
  function sideColor(side, us, team) {
    var t = side.team || {}, c0 = side === us ? (team.colors && team.colors[0]) || t.color : t.color, c1 = side === us ? null : t.alternateColor;
    var hex = function (c) { return c ? '#' + String(c).replace(/^#/, '') : null; }, ok = function (c) { return !!c && /^#[0-9a-f]{6}$/i.test(c); };
    var rgb = function (c) { var n = parseInt(c.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
    var dist = function (a, b) { a = rgb(a); b = rgb(b); return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]); };
    var lighten = function (c, k) { return '#' + rgb(c).map(function (v) { return ('0' + Math.round(v + (255 - v) * k).toString(16)).slice(-2); }).join(''); };
    var darken = function (c, k) { return '#' + rgb(c).map(function (v) { return ('0' + Math.round(v * (1 - k)).toString(16)).slice(-2); }).join(''); };
    var LIGHT = 0.3; // white text needs a face darker than this (3:1 against #fff, the floor for the row's bold display size; Sporting KC's sky blue sits near 0.5, the Sounders' green just under)
    c0 = hex(c0); c1 = hex(c1);
    var pick = c0, ours = side !== us ? sideColor(us, us, team) : null;
    if (ok(c0) && ok(c1) && lum(c0) < 0.03 && lum(c1) > lum(c0)) pick = c1;
    if (side !== us && ok(pick)) { // theirs too close to ours (the Kraken and the Canucks, two navies): the alternate if it stands apart, else theirs lightened
      if (ok(ours) && dist(pick, ours) < 140) pick = ok(c1) && dist(c1, ours) >= 140 ? c1 : lighten(pick, 0.4);
    }
    if (ok(pick) && lum(pick) > LIGHT) { // a pale face (Sporting KC, the Storm's gold) loses the white name: the alternate when it is dark enough and still stands apart from ours, else the face itself darkened until the name reads
      var alt = ok(c1) && lum(c1) <= LIGHT && lum(c1) >= 0.03 && (!ok(ours) || dist(c1, ours) >= 140) ? c1 : null;
      pick = alt || darken(pick, 0.4);
      if (lum(pick) > LIGHT) pick = darken(pick, 0.3);
    }
    return pick || '#555';
  }
  var BALL_SVG = '<svg class="bug-poss" viewBox="0 0 24 16" aria-hidden="true"><title>Possession</title><ellipse cx="12" cy="8" rx="11" ry="6" transform="rotate(-25 12 8)" fill="#b5652a" stroke="#f4f4f4" stroke-width="1.2"/><path d="M8.5 9.8 15.5 6.2M10 7.4l1 2M11.8 6.6l1 2M13.6 5.8l1 2" stroke="#f4f4f4" stroke-width="1.1" stroke-linecap="round"/></svg>'; // the football that marks possession
  function teamCell(side, team, color, extra) { // the abbreviation on the block, the nickname on the compact bar (styles.css .bug-abbr / .bug-nick); extra: markup that rides with the abbreviation (the record) and goes with it on the compact bar
    function esc(x) { return String(x).replace(/[&<>]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]; }); }
    var abbr = (side.isUs && clubAbbr(team)) || side.team.abbreviation || side.team.shortDisplayName, nick = side.isUs ? team.label : nickname(side.team); // our side as the league lists it
    return '<span class="bug-team" style="--cell:' + color + '"><i class="bug-abbr">' + (extra ? '<b class="bug-ab">' + esc(abbr) + '</b><span class="bug-xtra">' + extra + '</span>' : esc(abbr)) + '</i><i class="bug-nick">' + esc(nick || abbr) + '</i></span>';
  }
  function renderTeamLive(team, ev) {
    function esc(s) { return String(s).replace(/[&<>]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]; }); }
    var c = ev.competitions[0], st = c.status, type = st.type, sport = team.espn ? team.espn.sport : team.sport, ourId = team.espn ? team.espn.id : 'us';
    var us = c.competitors.filter(function (x) { return String(x.team.id) === ourId; })[0];
    var them = c.competitors.filter(function (x) { return x !== us; })[0];
    if (us) us.isUs = true; // the bugs name our side by the club's label
    var final = type.state === 'post', pre = type.state === 'pre';
    var today = todayStr(), gameDay = seattleDay(ev.date);
    var rel = gameDay === today ? 'Today' : gameDay === dayBefore(today) ? 'Yesterday' : gameDay === dayAfter(today, 1) ? 'Tomorrow' : parseDate(gameDay).toLocaleDateString('en-US', { weekday: 'long' });
    var inGame = !pre && !final; // the refresh control (and the strip's room for it) only while the game is on
    var box = document.createElement('div'); box.className = 'team-form is-live' + (final ? ' is-final' : pre ? ' is-pre' : ' has-refresh');
    // the left section: the crests either side of the cluster, then the venue line and the watch strip across it, centred; the news column beside
    var main = document.createElement('div'); main.className = 'tf-main'; box.appendChild(main);
    var row = document.createElement('div'); row.className = 'tf-row'; main.appendChild(row);
    if (team.logo) { var im = document.createElement('img'); im.src = team.logo; im.alt = ''; im.width = 56; im.height = 56; im.title = clubName(team); row.appendChild(crestLink(im, teamSite(team), clubName(team))); }
    var body = document.createElement('div'); body.className = 'tf-body'; row.appendChild(body);
    var inner = document.createElement('div'); inner.className = 'tf-inner'; body.appendChild(inner); // the cluster (the score) beside a column of the rest, all within the crests' height
    var cluster = document.createElement('div'); cluster.className = 'tf-cluster'; inner.appendChild(cluster);
    var head = document.createElement('div'); head.className = 'tf-head'; cluster.appendChild(head);
    var tag = document.createElement('span'); tag.className = 'tf-live'; tag.textContent = final ? 'Final' + (rel === 'Yesterday' ? ' · yesterday' : '') : pre ? rel : 'Live'; head.appendChild(tag);
    // refresh now (the score also refreshes itself every half minute) — a game in progress only; before and after, the block has nothing to refresh
    var rw = null;
    if (inGame) {
      rw = document.createElement('span'); rw.className = 'tf-refresh-wrap'; // the block's lower right corner
      var rb = document.createElement('button'); rb.type = 'button'; rb.className = 'tf-refresh' + (live.busy ? ' is-busy' : '');
      rb.title = 'Refresh the score'; rb.setAttribute('aria-label', 'Refresh the score');
      rb.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/></svg>';
      rb.addEventListener('click', function () { if (!live.busy) pollLive(true); });
      rw.appendChild(rb);
    }
    var score = document.createElement('span'); score.className = 'tf-score';
    if (pre) score.innerHTML = '<b>' + esc(us.team.abbreviation || team.label) + '</b><span class="tf-dash">' + (us.homeAway === 'home' ? 'vs' : 'at') + '</span>' + esc(them.team.abbreviation || them.team.shortDisplayName);
    else score.innerHTML = '<b>' + esc(us.team.abbreviation || team.label) + ' ' + (us.score || 0) + '</b><span class="tf-dash">–</span>' + (them.score || 0) + ' ' + esc(them.team.abbreviation || them.team.shortDisplayName);
    head.appendChild(score);
    var bugwrap = null; // the scorebug: baseball's while it plays, the general one for the other sports and for every final (the head and the state line stay, for the compact block)
    var mu0 = live.matchup[team.slug]; mu0 = mu0 && mu0.id === ev.id ? mu0.data : null;
    box.classList.add('has-bug'); bugwrap = document.createElement('div'); bugwrap.className = 'tf-bugwrap'; cluster.appendChild(bugwrap);
    bugwrap.appendChild(pre ? buildPregameBug(team, c, us, them, mu0, rel, ev.date) : sport === 'baseball' && !final ? buildScorebug(team, c, us, them) : buildGenericBug(team, c, us, them));
    var lines = document.createElement('div'); lines.className = 'tf-lines'; cluster.appendChild(lines);
    function line(txt, cls) { var p = document.createElement('p'); if (cls) p.className = cls; p.textContent = txt; lines.appendChild(p); return p; }
    // the state of play: inning / period / clock, then the sport's situation
    var detail = type.shortDetail || type.detail || '';
    var s = c.situation || {}, bits = [pre ? (ev.date ? new Date(ev.date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + (sport === 'baseball' ? ' first pitch' : sport === 'hockey' ? ' puck drop' : sport === 'basketball' ? ' tip-off' : ' kickoff') : '') : final && /^final$/i.test(detail) ? '' : detail]; // the tag already says Final; the line keeps only more (Final/OT, Final/10)
    if (!final && sport === 'baseball') {
      if (s.outs != null) bits.push(s.outs + ' out');
      var on = [s.onFirst && '1st', s.onSecond && '2nd', s.onThird && '3rd'].filter(Boolean);
      if (on.length) bits.push((on.length > 1 ? 'runners on ' : 'runner on ') + on.join(' & '));
      if (s.balls != null && s.strikes != null) bits.push(s.balls + '-' + s.strikes + ' count');
    } else if (!final && sport === 'football') {
      if (s.downDistanceText) bits.push(s.downDistanceText);
      if (s.possession) bits.push((String(s.possession) === ourId ? team.label : them.team.shortDisplayName) + ' ball');
    }
    if (bits.filter(Boolean).length) line(bits.filter(Boolean).join(' · '), 'tf-state');
    var lead = null; // the top of the news column: the last out (baseball) or the last play; before the game, the starters and the leaders out
    var hl = live.highlights[team.slug], sg0 = liveGameToday(team.slug);
    // the game's highlights: MLB's clips fetched here, else the ones the build found (the league's feed, the club's and the league's YouTube — teams.json clips)
    var clips = !pre && (hl && (hl.id === ev.id || (sg0 && hl.id === sg0.id)) && hl.clips.length ? hl.clips : (sg0 && sg0.clips && sg0.clips.length ? sg0.clips : null));
    if (clips) { // a short list of links to the clips
      lead = document.createElement('div'); lead.className = 'tf-lines tf-lead';
      var hh = document.createElement('p'); hh.className = 'tf-hl-head'; hh.innerHTML = '<b>Highlights</b>'; lead.appendChild(hh);
      var hul = document.createElement('ul'); hul.className = 'tf-hl'; lead.appendChild(hul);
      clips.slice(0, 5).forEach(function (cl) { var li = document.createElement('li'); var a = document.createElement('a'); a.href = cl.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = cl.title; li.appendChild(a); hul.appendChild(li); });
    }
    var lo = !final && live.lastOut[team.slug];
    if (lo) { // the most recent out: batter vs pitcher, then the play as called
      if (!lead) { lead = document.createElement('div'); lead.className = 'tf-lines tf-lead'; }
      var lp = document.createElement('p'); lp.className = 'tf-out'; lead.insertBefore(lp, lead.firstChild);
      lp.innerHTML = '<b>Last out' + (lo.when ? ' · ' + esc(lo.when) : '') + '</b> ' + (lo.batter || lo.pitcher ? esc((lo.batter || '?') + ' vs ' + (lo.pitcher || '?')) + ' — ' : '') + esc(lo.text);
    } else if (!final && s.lastPlay && s.lastPlay.text && sport !== 'baseball') {
      if (!lead) { lead = document.createElement('div'); lead.className = 'tf-lines tf-lead'; }
      var lq = document.createElement('p'); lq.className = 'tf-out'; lead.appendChild(lq);
      lq.innerHTML = '<b>Last play</b> ' + esc(s.lastPlay.text);
    }
    // the venue: the top of the column beside the score, a link to it on the map
    var where = document.createElement('p'); where.className = 'tf-where';
    var vn = (c.venue && c.venue.fullName) || them.team.displayName, va = c.venue && c.venue.address;
    var vl = document.createElement('a'); vl.textContent = vn; vl.target = '_blank'; vl.rel = 'noopener'; vl.title = 'On Google Maps';
    vl.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([vn, va && va.city, va && va.state].filter(Boolean).join(', '));
    where.appendChild(vl);
    var mu = live.matchup[team.slug]; mu = mu && mu.id === ev.id ? mu.data : null;
    if (final) { // the next game, after the final
      var upcoming = (teamGames(team.slug) || []).filter(function (g) { return g.date > gameDay; })[0];
      if (upcoming) line('', 'tf-next').innerHTML = '<b>Next</b> ' + esc(gameLine(upcoming)) + (upcoming.time && !upcoming.tbd ? ', ' + esc(fmtTime(upcoming.time, upcoming.date)) : '');
    }
    if (mu && seriesText(mu.series)) line('', 'tf-series').innerHTML = '<b>Series</b> ' + esc(seriesText(mu.series)); // the season series, and how the last meeting went
    if (pre) formLines(team, (teamGames(team.slug) || []).filter(function (g) { return g.date < todayStr() && g.res && !g.pre; })).forEach(function (f) { line('', f.cls).innerHTML = f.html; }); // before the game: the streak and the scoring, with the next game and the series
    if (pre && mu) {
      lead = document.createElement('div'); lead.className = 'tf-lines tf-lead';
      function leadLine(cls, html) { var p = document.createElement('p'); p.className = cls; p.innerHTML = html; lead.appendChild(p); }
      leaderLines(mu.leaders.us, mu.injured.us).forEach(function (f) { leadLine(f.cls, f.html); });
      if (mu.starters.us || mu.starters.them) leadLine('tf-starters', '<b>Starters</b> ' + esc(mu.starters.us || '?') + ' <span class="tf-dash">vs</span> ' + esc(mu.starters.them || '?'));
      var hurt = []; // the leaders on the IL, by side — the one injury note that matters
      [['us', us.team.abbreviation || team.label], ['them', them.team.abbreviation || them.team.shortDisplayName]].forEach(function (k) {
        var hs = (mu.leaders[k[0]] || []).filter(function (l) { return l.hurt; });
        if (hs.length) hurt.push(esc(k[1]) + ' ' + hs.map(function (l) { return esc(l.name + (l.hurt.what ? ' (' + l.hurt.what + ')' : '')); }).join(', '));
      });
      if (hurt.length) leadLine('tf-hurt', '<b>Leaders out</b> ' + hurt.join(' · '));
      if (!lead.childNodes.length) lead = null;
    }
    // no link out to ESPN, during the game or after it — the block says it all (Steve's call, three times over)
    var watch = null;
    if (final) { // after the final: where to watch the next game, from the schedule
      var nxt = (teamGames(team.slug) || []).filter(function (g) { return g.date > gameDay; })[0];
      watch = buildWatchStrip(nxt && nxt.watch ? nxt.watch.tv || [] : [], nxt && nxt.watch ? nxt.watch.radio : null, '', team);
    } else { // where to watch (before and during): the national and home-market networks (the other side's regional feed left out), the radio from the schedule
      var names = [], side = us.homeAway; // national feeds, plus our own market's — not the other side's regional network
      (c.broadcasts || []).forEach(function (b) {
        var mk = String(b.market || '').toLowerCase();
        if (mk && mk !== 'national' && mk !== side) return;
        (b.names || []).forEach(function (n) { if (n && names.indexOf(n) < 0) names.push(n); });
      });
      var g = liveGameToday(team.slug), radio = g && g.watch && g.watch.radio;
      if (!names.length && g && g.watch && g.watch.tv) names = g.watch.tv.slice(); // ESPN names none: the schedule's
      watch = buildWatchStrip(names, radio, '', team);
    }
    // the ring around the refresh button is the countdown to the next fetch: it fills clockwise over the half-minute, picked up mid-way when the block is redrawn
    // only while the game is on: a final is asked about every five minutes, not thirty seconds, and nothing counts down
    if (rw && live.at) { rw.classList.add('is-ticking'); rw.style.setProperty('--tick-delay', -Math.min(POLL_MS, Date.now() - live.at.getTime()) + 'ms'); }
    cluster.insertBefore(where, bugwrap); // the venue along the top of the bug
    var vs = vsLine(team.label, us.homeAway === 'home', them.team.shortDisplayName || them.team.displayName); // the compact bar: "at" or "vs" between the two crests, the nicknames either side when the bar has room
    row.appendChild(vs); // in the row, so the compact bar (the row's children laid in the block's own row) can seat it between the crests
    lines.querySelectorAll('.tf-next, .tf-series, .tf-form').forEach(function (p) { // the next game and the season series: the top of the news column, with the starters or the last out
      if (!lead) { lead = document.createElement('div'); lead.className = 'tf-lines tf-lead'; }
      lead.appendChild(p);
    });
    if (rw) inner.appendChild(rw); // the corner
    var sg = liveGameToday(team.slug), oppLogo = (sg && sg.opp && sg.opp.logo) || them.team.logo; // the schedule's crest (served without its ™) before ESPN's
    var oppSite = (sg && sg.opp && sg.opp.site) || ((them.team.links || []).filter(function (l) { return (l.rel || []).indexOf('clubhouse') >= 0; })[0] || {}).href || null;
    row.appendChild(oppCrest(oppLogo, them.team.displayName, them.team.abbreviation || them.team.shortDisplayName, them.team.displayName || '', oppSite)); // the opponent's crest, the same size as ours, at the other end of the row
    var form = (teamsData && teamsData.form && teamsData.form[team.slug]) || {};
    var side = buildFormSide(form, lead);
    if (side) box.appendChild(side);
    if (watch) box.appendChild(watch); // the strip along the foot, under both columns, as in every state
    inner.insertBefore(buildBrief(lead, watch), rw); // the pinned bar's run (before the corner, or last)
    return box;
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && !$('teamsView').hidden) pollLive(); });
  // The head: a block per picked club — its record and news, or its game
  // today — or, with several picked and a game in progress, only the clubs
  // playing (Steve, 2026-09-15). Each block carries its club's slug so a
  // poll can redraw just that one (swapFormBlock).
  function renderHead() {
    var head = $('teamHead'); head.innerHTML = '';
    var sel = selectedTeams(); if (!sel.length) return;
    var today = todayStr();
    var playing = sel.filter(function (t) { return teamStage(t.slug) === 'in'; });
    var show = sel.length > 1 && playing.length ? playing : sel;
    show.forEach(function (t) { head.appendChild(teamBlock(t, today)); });
    head.classList.toggle('is-multi', show.length > 1);
    settleBlock();
  }
  function waitingBlock(slug) { return $('teamHead').querySelector('.team-form.is-wait[data-slug="' + slug + '"]'); } // the placeholder still up
  function teamBlock(t, today) {
    if (!t.espn) { // no feed: the block from the schedule, and its odds (the build's estimate) as the matchup
      var sg = liveGameToday(t.slug); live.events[t.slug] = sg ? synthEvent(t, sg) : null;
      if (sg && sg.odds && !sg.res) live.matchup[t.slug] = { id: 'sched-' + sg.date, stage: 'pre', at: Date.now(), data: { chance: sg.odds, series: null, starters: {}, leaders: {}, injured: {} } };
    }
    var ev = live.events[t.slug] || null, stage = teamStage(t.slug);
    if (teamView.slugs.length === 1) { live.slug = t.slug; live.event = ev; live.shown = stage; } // one club picked: its game is the live game, as before
    if (t.espn && !ev && !live.polled[t.slug] && liveGameToday(t.slug)) { // a game near and no poll yet: an empty frame of the block's height, the first poll fills it (or the season card, if the board never comes)
      var w = document.createElement('div'); w.className = 'team-form is-wait'; w.setAttribute('aria-busy', 'true'); w.dataset.slug = t.slug;
      setTimeout(function () { if (waitingBlock(t.slug)) { live.polled[t.slug] = true; swapFormBlock(t, true); } }, 3000);
      return w;
    }
    var b = stage ? renderTeamLive(t, ev) : renderTeamForm(t, teamGames(t.slug) || [], today);
    b.dataset.slug = t.slug;
    return b;
  }
  // with several clubs picked, a poll's news for one of them: its block
  // redrawn in place, or the whole head when the clubs shown should change
  // (a game started, or ended)
  function syncHead(team) {
    var head = $('teamHead'), sel = selectedTeams();
    var playing = sel.filter(function (t) { return teamStage(t.slug) === 'in'; });
    var want = (sel.length > 1 && playing.length ? playing : sel).map(function (t) { return t.slug; }).join(',');
    var have = Array.prototype.map.call(head.querySelectorAll('.team-form'), function (b) { return b.dataset.slug; }).join(',');
    if (want !== have) renderHead(); else swapFormBlock(team, true);
  }
  function renderTeamCal(team, games, today) {
    var box = $('teamCal'); box.innerHTML = '';
    if (!games.length) return;
    // the club's colours dress the cards (styles.css .team-cal): home cells
    // in the primary, frames and headers in the accent
    var cols = team.colors || [];
    [box, $('teamsView')].forEach(function (el) { // the section too: the printed banner and legend sit outside the calendar
      el.style.setProperty('--team', cols[0] || 'var(--ink)');
      el.style.setProperty('--team-2', cols[1] || 'var(--ink-soft)');
    });
    // the dark palette paints home cells in the accent (the primaries are
    // navies that sink into the card); its text is dark or white by how
    // light the accent is
    box.style.setProperty('--team-2-on', cols[1] && lum(cols[1]) > 0.35 ? '#0b1620' : '#fff');
    $('teamsView').style.setProperty('--team-2-on', box.style.getPropertyValue('--team-2-on'));
    var byDate = {};
    games.forEach(function (g) { (byDate[g.date] = byDate[g.date] || []).push(g); });
    var rounds = teamPostseason(team.slug), lastRound = rounds.length ? parseDate(rounds[rounds.length - 1].end) : null; // the postseason's rounds shade their days, and the cards run to the final's month
    var first = parseDate(games[0].date), last = parseDate(games[games.length - 1].date);
    if (lastRound && lastRound > last) last = lastRound;
    var m = new Date(first.getFullYear(), first.getMonth(), 1);
    var end = new Date(last.getFullYear(), last.getMonth(), 1);
    // a card gets as many week rows as its month needs, or as its neighbour
    // in the same row of the grid needs (two cards to a row, styles.css) —
    // so the pair lines up and no row of cards carries a spare blank week
    var need = [];
    for (var w = new Date(m); w <= end; w = new Date(w.getFullYear(), w.getMonth() + 1, 1)) {
      need.push(Math.ceil((w.getDay() + new Date(w.getFullYear(), w.getMonth() + 1, 0).getDate()) / 7));
    }
    var idx = 0;
    while (m <= end) {
      var weeks = Math.max(need[idx], need[idx % 2 === 0 ? idx + 1 : idx - 1] || 0);
      idx++;
      var sec = document.createElement('section');
      sec.className = 'cal-month';
      sec.dataset.month = m.getMonth() + 1;
      var h = document.createElement('h3');
      h.className = 'cal-mname';
      // the year only where it changes hands (the first card and each January)
      if (team.logo) { var crest = document.createElement('img'); crest.src = team.logo; crest.alt = ''; crest.width = 28; crest.height = 28; h.appendChild(crest); }
      h.appendChild(document.createTextNode(m.toLocaleDateString('en-US', (m.getTime() === new Date(first.getFullYear(), first.getMonth(), 1).getTime() || m.getMonth() === 0) ? { month: 'long', year: 'numeric' } : { month: 'long' })));
      if (team.sport && SPORT_ICONS[team.sport]) h.appendChild(sportIcon(team.sport)); // crest · name · sport, like the strip's pills
      sec.appendChild(h);
      var wd = document.createElement('div'); wd.className = 'cal-wd'; // the weekday row: print only
      ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(function (d) { var x = document.createElement('span'); x.textContent = d; wd.appendChild(x); });
      sec.appendChild(wd);
      var days = document.createElement('div');
      days.className = 'cal-days';
      var lastDay = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
      var cells = weeks * 7;
      for (var i = 0; i < cells; i++) {
        var dayN = i - m.getDay() + 1;
        if (dayN < 1 || dayN > lastDay) {
          var blank = document.createElement('div');
          blank.className = 'cal-day is-blank';
          days.appendChild(blank);
          continue;
        }
        var key = ymd(new Date(m.getFullYear(), m.getMonth(), dayN));
        var gs = byDate[key] || [];
        var cell = document.createElement(gs.length ? 'button' : 'div');
        cell.className = 'cal-day' + (key === today ? ' is-today' : '') + (key < today ? ' is-past' : '');
        var num = document.createElement('span'); num.className = 'num'; num.textContent = dayN; cell.appendChild(num);
        if (!gs.length) { // a postseason day: shaded, named on hover
          var rd = rounds.filter(function (r) { return key >= r.start && key <= r.end; })[0];
          if (rd) { cell.className += ' is-post' + (rd.final ? ' is-final' : ''); cell.title = rd.name + (rd.tbd ? ' — dates TBA' : ''); }
        }
        if (gs.length) {
          var g = gs[0];
          cell.type = 'button'; cell.dataset.date = key;
          cell.className += (g.home ? ' is-home' : ' is-away') + (g.pre ? ' is-pre' : '');
          cell.title = gs.map(function (x) { return (x.home ? 'vs ' : 'at ') + x.opp.name + ', ' + (x.tbd || !x.time ? 'time TBD' : fmtTime(x.time, x.date)); }).join(' · ');
          var ab = document.createElement('span'); ab.className = 'abbr'; ab.textContent = g.opp.abbrev || (g.opp.short || g.opp.name).slice(0, 3).toUpperCase(); cell.appendChild(ab);
          var tm = document.createElement('span'); tm.className = 'gtime'; var tt = gs.length > 1 ? '×' + gs.length : teamCalTime(g); tm.textContent = tt.replace(/a$/, ''); cell.appendChild(tm);
          if (/a$/.test(tt)) { var am = document.createElement('i'); am.textContent = 'a'; tm.appendChild(am); } // the morning marker: on screen only — the printed cell has no room beside the day number, and the posters print bare times
          cell.addEventListener('click', jumpToTeamDate);
        }
        days.appendChild(cell);
      }
      sec.appendChild(days);
      box.appendChild(sec);
      m = new Date(m.getFullYear(), m.getMonth() + 1, 1);
    }
  }
  // the season calendar is the poster's layout only (the in-page toggle was
  // removed 2026-09-14): prepPrint turns it on for the print, off after
  function applyTeamView() {
    var cal = teamView.cal && teamView.slugs.length === 1; // the poster calendar is one club's
    $('teamsView').classList.toggle('is-cal', cal);
    $('teamCal').hidden = !cal;
  }
  // PDF: the browser's own print-to-PDF of the calendar view alone (styles.css
  // @media print, html.print-team). The list view is switched to the calendar
  // for the print and back after; the document title names the file.
  // prepPrint sets the page up as the poster (also from ?print=1 on a
  // ?team= link, for a headless print-to-PDF); it hands back the undo
  function prepPrint(team) {
    function esc(x) { return String(x).replace(/[&<>]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]; }); }
    var games = teamGames(team.slug) || [];
    if (!games.length) return null;
    var wasCal = teamView.cal, title = document.title;
    var y1 = games[0].date.slice(0, 4), y2 = games[games.length - 1].date.slice(0, 4);
    // a season is named by its span — but football by the year it starts in
    var season = y1 === y2 || (team.espn && team.espn.sport === 'football') ? y1 : y1 + '–' + y2.slice(2);
    document.title = team.label + ' ' + season + ' schedule';
    // the poster's banner and legend (print only, styles.css)
    var ph = $('printHead'); ph.innerHTML = '';
    if (team.logo) { var pi = document.createElement('img'); pi.src = team.logo; pi.alt = ''; ph.appendChild(pi); }
    var pt = document.createElement('div'); pt.className = 'ph-text';
    var played = games.filter(function (g) { return g.res; });
    var rec = played.length ? recordFrom(played) : '';
    pt.innerHTML = '<span class="ph-team">' + esc(clubName(team)) + '</span><span class="ph-season">' + season + ' season' + (rec ? ' · ' + rec : '') + '</span>';
    ph.appendChild(pt);
    // the legend: home, away, then the hatched cells — the playoff windows and the final — when the league's rounds are on the calendar
    var rounds = teamPostseason(team.slug), fin = rounds.filter(function (r) { return r.final; })[0];
    var pf = $('printFoot'); pf.innerHTML = '<span class="pf-home">Home</span><span class="pf-away">Away</span>' +
      (rounds.length ? '<span class="pf-post">Playoffs</span>' : '') + (fin ? '<span class="pf-final">' + esc(fin.name) + (fin.site ? ' · ' + esc(fin.site) : '') + '</span>' : '') +
      '<span>Start times ' + esc(CITY.tzName || 'Pacific') + ', subject to change</span><span>' + esc(CITY.site.replace(/^https?:\/\//, '').replace(/\/$/, '')) + '</span>';
    // the sheet: square months on one portrait page (like the wall posters),
    // two, three or four across — whichever leaves them biggest. Letter
    // less 8mm margins is 200 × 263mm; the banner and legend take ~36mm.
    var months = $('teamCal').querySelectorAll('.cal-month').length, best = null;
    [2, 3, 4].forEach(function (cols) {
      var gap = cols === 2 ? 5 : 4, rows = Math.ceil(months / cols);
      var card = Math.min((200 - gap * (cols - 1)) / cols, (224 - gap * (rows - 1)) / rows);
      if (!best || card > best.card + 0.5) best = { cols: cols, gap: gap, card: card };
    });
    document.documentElement.style.setProperty('--pcard', best.card.toFixed(1) + 'mm');
    document.documentElement.style.setProperty('--pgap', best.gap + 'mm');
    teamView.cal = true; applyTeamView();
    document.documentElement.classList.add('print-team');
    return function () {
      document.documentElement.classList.remove('print-team');
      document.documentElement.style.removeProperty('--pcard'); document.documentElement.style.removeProperty('--pgap');
      document.title = title;
      teamView.cal = wasCal; applyTeamView();
    };
  }
  // one club picked: its poster. Several: a chooser under the chip — one of
  // them, or All, which prints them one after another (Steve, 2026-09-15)
  function openSeasonCalendar(anchor) { // the bar's Season Calendar chip, and the Season Schedule button in every game block's footer strip (Steve, 2026-10-26)
    var sel = selectedTeams();
    if (!sel.length) return;
    if (sel.length === 1) { printTeams(sel); return; }
    var old = document.querySelector('.pdf-pick'); if (old) { old.remove(); return; }
    var pick = document.createElement('div'); pick.className = 'pdf-pick'; pick.setAttribute('role', 'menu');
    var lbl = document.createElement('span'); lbl.className = 'pdf-pick-label'; lbl.textContent = 'Season calendar for'; pick.appendChild(lbl);
    sel.forEach(function (t) { // one club per row, no All (Steve, 2026-09-15)
      var b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = t.label;
      if (t.logo) { var im = document.createElement('img'); im.src = t.logo; im.alt = ''; im.width = 18; im.height = 18; b.insertBefore(im, b.firstChild); }
      b.addEventListener('click', function () { pick.remove(); printTeams([t]); });
      pick.appendChild(b);
    });
    var r = (anchor || $('teamPdfBtn')).getBoundingClientRect(); // its left edge on the chip's
    pick.style.top = (r.bottom + 6) + 'px'; pick.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - 12 * 16)) + 'px';
    document.body.appendChild(pick);
    setTimeout(function () { // outside tap or Esc closes it
      var off = function (e) { if (e.type === 'keydown' && e.key !== 'Escape') return; if (e.type === 'click' && e.target.closest('.pdf-pick')) return; pick.remove(); document.removeEventListener('click', off, true); document.removeEventListener('keydown', off); };
      document.addEventListener('click', off, true); document.addEventListener('keydown', off);
    }, 0);
  }
  $('teamPdfBtn').addEventListener('click', function () { openSeasonCalendar($('teamPdfBtn')); });
  function buildSchedButton() { // "Season Schedule", the calendar icon and the words, at the strip's left end
    var b = document.createElement('button'); b.type = 'button'; b.className = 'tf-sched'; b.title = 'Season schedule — the whole season as a calendar';
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4M8 13h3M13 13h3M8 17h3M13 17h3"/></svg><span>Season Schedule</span>';
    b.addEventListener('click', function (e) { e.stopPropagation(); openSeasonCalendar(b); });
    return b;
  }
  function printTeams(list) { // a print dialog per club, each with its own calendar drawn for the sheet
    var i = 0;
    (function next() {
      if (i >= list.length) return;
      var team = list[i++];
      if (!(teamView.slugs.length === 1 && teamView.slugs[0] === team.slug)) renderTeamCal(team, teamGames(team.slug) || [], todayStr());
      var undo = prepPrint(team);
      if (!undo) { next(); return; }
      var done = function () { undo(); window.removeEventListener('afterprint', done); if (i < list.length) setTimeout(next, 400); };
      window.addEventListener('afterprint', done);
      window.print();
    })();
  }
  // a cell: over to the list, on that day (a played game opens the past first)
  function jumpToTeamDate(e) {
    var date = e.currentTarget.dataset.date;
    if (date < todayStr() && !teamView.showPast) { teamView.showPast = true; renderTeams(teamView.slug); }
    teamView.cal = false; applyTeamView();
    var row = $('teamSched').querySelector('.day-row[data-date="' + date + '"]');
    if (row) row.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
  // one opponent: dim every other row, name them above the list, jump to the
  // next meeting. null lights the whole season again.
  function focusOpp(key, opp) {
    teamView.opp = key;
    var rows = $('teamSched').querySelectorAll('.ev');
    var first = null;
    Array.prototype.forEach.call(rows, function (r) {
      var on = !key || r.dataset.opp === key;
      r.classList.toggle('is-dim', !on);
      if (on && key && !first && !r.closest('.day-row').classList.contains('is-past')) first = r;
    });
    renderTeamFocus(key ? opp : null, key);
    if (first) first.closest('.day-row').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  function renderTeamFocus(opp, key) {
    var bar = $('teamFocus'); bar.innerHTML = '';
    bar.hidden = !opp;
    if (!opp) { $('teamsView').style.removeProperty('--focus-h'); return; }
    var n = $('teamSched').querySelectorAll('.ev[data-opp="' + key + '"]').length;
    if (opp.logo) { var im = document.createElement('img'); im.src = opp.logo; im.alt = ''; im.width = 28; im.height = 28; bar.appendChild(im); }
    var t = document.createElement('span'); t.className = 'focus-name'; t.textContent = opp.name; bar.appendChild(t);
    var c = document.createElement('span'); c.className = 'focus-n'; c.textContent = n + ' game' + (n === 1 ? '' : 's'); bar.appendChild(c);
    if (opp.site) { var a = document.createElement('a'); a.className = 'chip'; a.href = opp.site; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Their site ↗'; bar.appendChild(a); }
    var x = document.createElement('button'); x.type = 'button'; x.className = 'chip'; x.textContent = '✕ All games'; x.title = 'Back to the whole season';
    x.addEventListener('click', function () { focusOpp(null); });
    bar.appendChild(x);
    $('teamsView').style.setProperty('--focus-h', (bar.offsetHeight + 8) + 'px'); // the month rows stick below it
  }
  $('viewToggle').addEventListener('click', function (e) { // the stop tapped is the view: List, Month (the list with the calendar), Teams — a press on the lit stop, the knob or the rim steps to the next
    if (e.target.closest('#filterToggle')) return; // the Filter button rides in the pill but is not a stop (its own click opens the panel)
    var b = e.target.closest('button[data-view]'), cur = $('viewToggle').dataset.active;
    var view = b && b.dataset.view !== cur ? b.dataset.view : nextStop($('viewToggle'), 'data-view', cur);
    b = $('viewToggle').querySelector('button[data-view="' + view + '"]');
    if (!b) return;
    if (window.LQAMap) { // the Map stop, in a city that has one: Map in, or out of, the cycle
      if (b.dataset.view === 'map') { if (!$('teamsView').hidden) setTeamsView(null, true); setMonthView(false, true); LQAMap.open(true, true); return; }
      if (LQAMap.isOpen()) LQAMap.open(false, true);
    }
    if (b.dataset.view === 'teams') { if ($('teamsView').hidden) setTeamsView(teamView.slug || new URLSearchParams(location.search).get('team') || 'auto', true); return; }
    if (!$('teamsView').hidden) setTeamsView(null, true);
    setMonthView(b.dataset.view === 'month', true);
  });
  window.addEventListener('popstate', function () {
    var slug = new URLSearchParams(location.search).get('team');
    if (!!slug !== !$('teamsView').hidden || (slug && slug !== teamView.slug)) setTeamsView(slug, false);
  });

  // ---- the event sheet ----
  // A click anywhere on a card opens it (capture phase, so it wins over the
  // venue link's own handler): the details plus the two real choices, the
  // ticket page and the venue's own list. On phones it's a bottom sheet; on
  // wider screens the same element is a pop hung under the card (styles.css
  // ≥641px), placed here and re-placed as the page scrolls. Modifier and
  // middle clicks on the inline links still open them directly.
  var sheetTouch = '(max-width: 640px)';
  var sheetAnchor = null, sheetPoint = null; // the card, and where on it the click landed (the pop centres there; a keyboard opening has no point and hangs under the card)
  function placeSheet() {
    var sheet = $('sheet');
    if (sheet.hidden || !sheetAnchor || matchMedia(sheetTouch).matches) return;
    if (!document.body.contains(sheetAnchor)) { closeSheet(); return; } // the list re-rendered
    var card = sheetAnchor.getBoundingClientRect();
    var pop = sheet.querySelector('.sheet-card').getBoundingClientRect();
    var gap = 6, pad = 8;
    var barBottom = document.querySelector('.filter-area').getBoundingClientRect().bottom + gap;
    var left, top;
    if (sheetPoint) { // centred on the click, kept on screen and under the bar
      left = sheetPoint.x - pop.width / 2; top = sheetPoint.y - pop.height / 2;
      left = Math.max(pad, Math.min(left, window.innerWidth - pop.width - pad));
      top = Math.max(barBottom, Math.min(top, window.innerHeight - pop.height - pad));
    } else {
      left = Math.max(pad, Math.min(card.left, window.innerWidth - pop.width - pad));
      top = card.bottom + gap;
      if (top + pop.height > window.innerHeight - pad) top = card.top - pop.height - gap; // no room below: above
      if (top < barBottom) top = Math.max(pad, window.innerHeight - pop.height - pad); // nor above: keep it on screen, over the card if it must
    }
    sheet.style.left = Math.round(left) + 'px';
    sheet.style.top = Math.round(top) + 'px';
  }
  window.addEventListener('resize', placeSheet);
  // "272 of 18,100 tickets left · 614 resale · from $25" — the box-office
  // count against the venue's seats, then resale, then the lowest price
  // (resale's when the box office is out); '' when the feed has no counts
  // The time cell as a scoreboard clock (Steve, 2026-09-15): the digits as
  // big as the column allows, in green, "PM" centred beneath, the whole thing
  // centred on the row — the events list and the Teams view alike. Fills the
  // given span; an all-day or TBD cell is left to the caller.
  function clockCell(time, clock) {
    var parts = clock.split(' '); // "7:00 PM", or "5:00 PM PDT" on a viewer's clock
    time.classList.add('t-clock');
    var big = document.createElement('b'); big.className = 't-big'; big.textContent = parts[0];
    var tf = document.createElement('span'); tf.className = 't-foot'; tf.textContent = parts.slice(1).join(' '); if (parts[2]) tf.classList.add('t-zone');
    time.appendChild(big); time.appendChild(tf);
  }
  // a sold-out or nearly-sold-out card: the red frame, and a small tab out of
  // its foot saying which (styles.css .ev.is-soldout::after reads data-tab),
  // like the ODDS tab under the odds bug
  function ticketTab(row, ts, e) {
    row.classList.add('is-soldout');
    row.dataset.tab = ts === 'soldout' ? 'SOLD OUT' : 'NEARLY SOLD OUT';
    row.title = ts === 'soldout' ? 'The box office has no tickets left' + (e.tickets && e.tickets.resale ? ' — resale only' : '')
      : 'Five percent of the house or less is left at the box office';
  }
  // A festival day's set times (feed `sets`: a stage, its acts in order with
  // their times). Short, on the card: a line per stage, "Main 3:15 Avery
  // Cochrane · 4:15 …"; full, in the sheet: the stage over its sets, each
  // with its start and end (Steve, 2026-10-05: "switching to the detailed line up").
  function shortClock(t) { if (!/^\d\d?:\d\d$/.test(t || '')) return t || ''; var hm = t.split(':'); return (Number(hm[0]) % 12 || 12) + ':' + hm[1]; }
  function setTimesBlock(sets) { // the day card's grid: a stage, then its sets with their times
    var box = document.createElement('div'); box.className = 'sheet-sets';
    sets.forEach(function (s) {
      var h = document.createElement('p'); h.className = 'ss-stage'; h.textContent = s.stage; box.appendChild(h);
      var ul = document.createElement('ul');
      s.acts.forEach(function (a) {
        var li = document.createElement('li');
        var t = document.createElement('span'); t.className = 'ss-time'; t.textContent = shortClock(a.start) + '\u2013' + shortClock(a.end); li.appendChild(t);
        li.appendChild(document.createTextNode(a.act));
        ul.appendChild(li);
      });
      box.appendChild(ul);
    });
    return box;
  }
  function inventoryName(e) { return /ticketweb\.com\//.test(e.url || '') ? 'TicketWeb' : 'Ticketmaster'; } // whose box office the checker read (the Crocodile's is TicketWeb)
  function ticketsLine(e) {
    var t = e.tickets;
    var n = function (x) { return Number(x).toLocaleString('en-US'); };
    var cap = e.capacity || VENUE_CAPACITY[e.venue]; // the night's own house (Ticketmaster's seat map, scripts/capacity.mjs) before the venue's usual one
    // a source that only says sold out (the Rep's feed, DICE): the fact and the house
    if (!t) return e.soldOut ? 'Sold out' + (cap ? ' \u00b7 ' + n(cap) + ' seats' : '') : '';
    var parts = [];
    if (e.soldOut) parts.push('Sold out at the box office');
    else if (t.box != null) parts.push(n(t.box) + (cap ? ' of ' + n(cap) : '') + ' tickets left');
    else parts.push('On sale'); // the checker saw tickets listed but no count
    if (t.resale) parts.push(n(t.resale) + ' resale');
    if (t.from != null && Math.round(t.from) > 0) parts.push('from $' + Math.round(t.from)); // a $0 floor reads as free; say nothing (Steve, 2026-09-18)
    return parts.join(' \u00b7 ');
  }
  function openSheet(e, anchor, point) {
    $('sheetVenue').textContent = e.venue;
    $('sheetTitle').textContent = e.title;
    var when = parseDate(e.date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) + ' · ' + fmtTime(e.time, e.date);
    if (e.series) when += ' · ' + e.series.n + ' of ' + e.series.total;
    if (e.status) when += ' · ' + e.status.toUpperCase() + (e.statusSince ? ' (noticed ' + fmtSince(e.statusSince) + ')' : '');
    if (e.dateTbd) when += ' · date TBD';
    $('sheetWhen').textContent = when + (e.stage ? ' \u00b7 ' + e.stage + (e.end ? ', until ' + fmtTime(e.end, e.date) : ', to close') : ''); // one set of a festival day: its stage and end
    var tix = ticketsLine(e);
    var st = $('sheetTix'); st.hidden = !tix;
    st.textContent = tix ? tix + (e.tickets && e.tickets.checked ? ' \u00b7 checked ' + fmtSince(e.tickets.checked) : '') : '';
    // a home game's TV / radio, when its league listed them
    var w = $('sheetWatch'); w.innerHTML = '';
    var watch = e.watch || {};
    [['tv', 'TV'], ['radio', 'Radio']].forEach(function (k) {
      if (!watch[k[0]] || !watch[k[0]].length) return;
      if (w.childNodes.length) w.appendChild(document.createTextNode(' \u00b7 '));
      var b = document.createElement('b'); b.textContent = k[1];
      w.appendChild(b); w.appendChild(document.createTextNode(watch[k[0]].join(', ')));
    });
    w.hidden = !w.childNodes.length;
    var ss = $('sheetSets'); ss.innerHTML = ''; ss.hidden = !(Array.isArray(e.sets) && e.sets.length); // a festival day: the whole set-times grid, stage by stage
    if (!ss.hidden) ss.appendChild(setTimesBlock(e.sets));
    // Tickets — only where there are tickets to buy. A bar night's link is the
    // bar's events page (the venue chip below already goes there), so no chip;
    // a free event's link is its details page, so the chip says so (Steve, 2026-09-21)
    var t = $('sheetTickets'); t.href = e.url || '#'; t.hidden = !e.url || eventType(e) === 'bar';
    t.textContent = e.free ? 'Details \u00b7 Free' : 'Tickets';
    var v = $('sheetVenueLink'); v.href = VENUE_URL[e.venue] || '#'; v.hidden = !VENUE_URL[e.venue]; v.textContent = 'Venue Site \u2197'; v.title = 'What\u2019s on at ' + e.venue; // the venue's own calendar (short: the name is the sheet's eyebrow — Steve, 2026-09-21)
    var ov = $('sheetOnlyVenue'); ov.textContent = 'Only Venue'; ov.title = 'Only ' + e.venue; ov.hidden = state.venues.indexOf(e.venue) < 0 || eventType(e) === 'bar'; ov.dataset.venue = e.venue; // the filter, narrowed to this venue (bars are a type, not a venue)
    var team = TEAMS.filter(function (t) { return t.re.test(e.title || '') && t.venue === e.venue && t.strip !== false; })[0]; // a home game: the club's season, in the Teams view (a club with no tab there has no Season button)
    var tb = $('sheetTeam'); tb.hidden = !team; if (team) { tb.textContent = 'Season'; tb.title = team.label + ' season, in the Teams view'; tb.dataset.slug = team.slug; }
    var hv = $('sheetHideVenue'); hv.textContent = 'Hide Venue'; hv.title = 'Hide ' + e.venue; hv.hidden = ov.hidden; hv.dataset.venue = e.venue;
    var ht = $('sheetHideTeam'); ht.hidden = !team; if (team) { ht.textContent = 'Hide ' + team.label; ht.title = 'Hide ' + team.label + ' home games'; ht.dataset.slug = team.slug; }
    var phone = matchMedia(sheetTouch).matches;
    var sheet = $('sheet');
    sheetAnchor = anchor || null; sheetPoint = point && (point.x || point.y) ? point : null;
    sheet.hidden = false;
    sheet.querySelector('.sheet-card').setAttribute('aria-modal', String(phone));
    if (phone) {
      sheet.style.left = sheet.style.top = '';
      document.body.classList.add('sheet-open');
      $('sheetClose').focus();
    } else {
      placeSheet();
      sheet.querySelector('.sheet-card').focus();
    }
  }
  function closeSheet() {
    $('sheet').hidden = true; sheetAnchor = null; sheetPoint = null;
    document.body.classList.remove('sheet-open');
  }
  $('sheetClose').addEventListener('click', closeSheet);
  $('sheetOnlyVenue').addEventListener('click', function () { // the events list, narrowed to this venue with everything at it showing — with a way back, like Hide
    var v = this.dataset.venue, snap = filterSnapshot(); closeSheet();
    if (!$('teamsView').hidden) setTeamsView(null, true);
    onlyVenue(v); applyFilters();
    showToast('Only ' + v, function () { restoreSnapshot(snap); });
  });
  $('sheetTeam').addEventListener('click', function () { var slug = this.dataset.slug; closeSheet(); setTeamsView(slug, true); });
  $('sheetHideVenue').addEventListener('click', function () { // this venue off, with a way back
    var v = this.dataset.venue, snap = filterSnapshot(); closeSheet();
    setMode(state.venueMode, v, 'ex'); applyFilters();
    showToast(v + ' hidden', function () { restoreSnapshot(snap); });
  });
  $('sheetHideTeam').addEventListener('click', function () { // this club's home games off (the venue stays), with a way back
    var t = TEAM_BY_SLUG[this.dataset.slug], snap = filterSnapshot(); closeSheet();
    if (!t) return;
    setMode(state.teamMode, t.slug, 'ex'); applyFilters();
    showToast(t.label + ' games hidden', function () { restoreSnapshot(snap); });
  });
  $('sheetBack').addEventListener('click', closeSheet);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('sheet').hidden) closeSheet(); });
  // a click anywhere outside the pop closes it (the opening click never gets
  // here — cardTap stops it in the capture phase)
  document.addEventListener('click', function (e) {
    if (!$('sheet').hidden && !e.target.closest('.sheet-card')) closeSheet();
  });
  function cardTap(e) {
    return function (ev) {
      // let a deliberate new-tab / middle click on an inline link through
      if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      ev.preventDefault(); ev.stopPropagation();
      openSheet(e, ev.currentTarget, { x: ev.clientX, y: ev.clientY });
    };
  }
  // copy to the clipboard; falls back to a selection + execCommand where the
  // async API is missing (older browsers, or the site opened over plain http)
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('copy failed'));
    });
  }
  $('copyFilterLink').addEventListener('click', function () {
    var code = LQAFilter.encodeFilterCode(currentModes());
    var url = location.origin + location.pathname + '?f=' + code;
    if (state.q) url += '&s=' + LQAFilter.encodeSearch(state.q);
    if (state.holidays) url += '&h=1';
    if (state.soldOnly) url += '&so=1';
    var label = $('copyFilterLabel');
    var original = label.textContent;
    copyText(url).then(function () {
      label.textContent = 'Copied!';
      // hold, fade out, then bring the normal label back in
      setTimeout(function () {
        label.classList.add('is-fading');
        setTimeout(function () {
          label.textContent = original;
          label.classList.remove('is-fading');
        }, 400);
      }, 1200);
    });
  });

  // ---- month grid ----
  function monthBounds() {
    var dates = Object.keys(state.byDate).sort();
    if (!dates.length) return null;
    return {
      min: parseDate(dates[0]),
      max: parseDate(dates[dates.length - 1]),
    };
  }
  function sameMonth(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
  }
  function renderCal() {
    var m = state.month;
    if (!m) return;
    var bounds = monthBounds();
    var next = new Date(m.getFullYear(), m.getMonth() + 1, 1);
    var single = true; // one month, docked or floating (Steve's call 2026-09-08)
    var last = single ? m : next; // the last month shown; › stops when it reaches the feed's last month
    $('calPrev').disabled = !bounds || sameMonth(m, new Date(bounds.min.getFullYear(), bounds.min.getMonth(), 1));
    $('calNext').disabled = !bounds ||
      last.getFullYear() * 12 + last.getMonth() >= bounds.max.getFullYear() * 12 + bounds.max.getMonth();

    var box = $('calGrid');
    box.innerHTML = '';
    var today = todayStr();
    // the month's name sits in the card's header between ‹ and ›
    $('calHead').querySelector('.cal-cur').textContent = m.toLocaleDateString('en-US', { month: 'long' });
    // One month at a time; the ‹ Today › bar above pages by one. The card
    // (name, grid) holds only its own days.
    (single ? [m] : [m, next]).forEach(function (first) {
      var sec = document.createElement('section');
      sec.className = 'cal-month';
      sec.dataset.month = first.getMonth() + 1; // styles.css tints the name row by season
      var h = document.createElement('h3');
      h.className = 'cal-mname';
      h.textContent = first.toLocaleDateString('en-US', { month: 'long' }); // month only, like the list's dividers
      sec.appendChild(h); // no weekday row: the name sits where it was, and the grid starts on Sunday
      var days = document.createElement('div');
      days.className = 'cal-days';
      var last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
      var cells = Math.ceil((first.getDay() + last) / 7) * 7;
      for (var i = 0; i < cells; i++) {
        var dayN = i - first.getDay() + 1;
        if (dayN < 1 || dayN > last) { // pad to whole weeks, but no neighbor-month days
          var blank = document.createElement('div');
          blank.className = 'cal-day is-blank';
          days.appendChild(blank);
          continue;
        }
        var d = new Date(first.getFullYear(), first.getMonth(), dayN);
        var key = ymd(d);
        var evs = dayItems(key);
        // every real day is a button: one with nothing on jumps the list to
        // the next listed day (a past one opens the past from there)
        var cell = document.createElement('button');
        cell.type = 'button';
        cell.dataset.date = key;
        cell.setAttribute('aria-label', d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' }) + ', ' + (evs.length ? evs.length + ' event' + (evs.length > 1 ? 's' : '') : 'nothing listed'));
        cell.className = 'cal-day' + (evs.length ? '' : ' is-empty');
        if (key === today) cell.className += ' is-today';
        if (key < today) cell.className += ' is-past';
        var num = document.createElement('span');
        num.className = 'num';
        num.textContent = dayN;
        cell.appendChild(num);
        if (evs.length) {
          var ticks = document.createElement('span');
          ticks.className = 'ticks';
          // three dots at most, then a "+" for the rest (Steve, 2026-09-15)
          evs.slice(0, 3).forEach(function (e) {
            var t = document.createElement('i');
            t.style.setProperty('--dot', venueColor(e.venue));
            ticks.appendChild(t);
          });
          if (evs.length > 3) { var more = document.createElement('b'); more.className = 'tick-more'; more.textContent = '+'; more.title = (evs.length - 3) + ' more'; ticks.appendChild(more); }
          cell.appendChild(ticks);
        }
        days.appendChild(cell);
      }
      sec.appendChild(days);
      box.appendChild(sec);
    });
  }
  $('calPrev').addEventListener('click', function () { shiftMonth(-1); });
  $('calNext').addEventListener('click', function () { shiftMonth(1); });
  // TODAY (the floater at the lower right): back to the current month, past
  // days put away, the list on its first page and scrolled to its first
  // (= nearest) day. It only shows while there is somewhere to come back
  // from — see syncTodayFloat.
  $('calToday').addEventListener('click', function () {
    var now = new Date();
    state.month = new Date(now.getFullYear(), now.getMonth(), 1);
    state.showPast = false; state.pastFrom = null;
    renderCal();
    renderAgenda();
    if (monthOpen()) boardGo(state.month); else scrollToDate(todayStr());
    syncTodayFloat(); // no scroll event if the list was already there
  });
  function shiftMonth(dir) {
    state.month = new Date(state.month.getFullYear(), state.month.getMonth() + dir, 1);
    if (monthOpen()) { boardGo(state.month); return; }
    swapCal(dir);
    jumpToMonth();
  }
  // The month name in either calendar's header opens a month / year picker
  // (Steve, 2026-09-15): ‹ year › over a grid of the twelve months, those
  // outside the feed's span dimmed; a month goes straight there.
  function openMonthPick(anchor) {
    var old = document.querySelector('.cal-pick');
    if (old) { old.remove(); if (old.dataset.for === anchor.id) return; }
    var bounds = monthBounds();
    if (!bounds || !state.month) return;
    var lo = bounds.min.getFullYear() * 12 + bounds.min.getMonth(), hi = bounds.max.getFullYear() * 12 + bounds.max.getMonth();
    if (monthOpen()) lo = Math.max(lo, boardFirst().getFullYear() * 12 + boardFirst().getMonth()); // the board runs from this month
    var year = state.month.getFullYear();
    var pick = document.createElement('div'); pick.className = 'cal-pick'; pick.setAttribute('role', 'dialog'); pick.setAttribute('aria-label', 'Pick a month'); pick.dataset.for = anchor.id;
    function close() { pick.remove(); document.removeEventListener('click', off, true); document.removeEventListener('keydown', off); }
    function off(e) { if (e.type === 'keydown' ? e.key !== 'Escape' : e.target.closest('.cal-pick')) return; close(); }
    function draw() {
      pick.innerHTML = '';
      var head = document.createElement('div'); head.className = 'cp-head';
      var prev = document.createElement('button'); prev.type = 'button'; prev.textContent = '\u2039'; prev.setAttribute('aria-label', 'Previous year');
      var next = document.createElement('button'); next.type = 'button'; next.textContent = '\u203a'; next.setAttribute('aria-label', 'Next year'); next.disabled = year >= bounds.max.getFullYear();
      prev.disabled = year <= bounds.min.getFullYear();
      var y = document.createElement('span'); y.className = 'cp-year'; y.textContent = String(year);
      prev.addEventListener('click', function () { year--; draw(); });
      next.addEventListener('click', function () { year++; draw(); });
      head.appendChild(prev); head.appendChild(y); head.appendChild(next); pick.appendChild(head);
      var grid = document.createElement('div'); grid.className = 'cp-grid';
      for (var mi = 0; mi < 12; mi++) {
        (function (mi) {
          var b = document.createElement('button'); b.type = 'button';
          b.textContent = new Date(year, mi, 1).toLocaleDateString('en-US', { month: 'short' });
          var key = year * 12 + mi;
          b.disabled = key < lo || key > hi;
          if (year === state.month.getFullYear() && mi === state.month.getMonth()) b.className = 'is-on';
          b.addEventListener('click', function () {
            state.month = new Date(year, mi, 1);
            close();
            renderCal();
            if (monthOpen()) boardGo(state.month); else jumpToMonth();
          });
          grid.appendChild(b);
        })(mi);
      }
      pick.appendChild(grid);
    }
    draw();
    var r = anchor.getBoundingClientRect();
    document.body.appendChild(pick);
    var w = pick.offsetWidth, left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)), top = r.bottom + 6;
    if (r.height > r.width * 2) { left = r.right + 8; top = r.top; } // a month's standing name (the month view): beside it, from its top
    top = Math.max(8, Math.min(window.innerHeight - pick.offsetHeight - 8, top));
    pick.style.top = top + 'px'; pick.style.left = left + 'px';
    setTimeout(function () { document.addEventListener('click', off, true); document.addEventListener('keydown', off); }, 0);
  }
  $('calCur').addEventListener('click', function () { openMonthPick(this); });
  $('mbCur').addEventListener('click', function () { openMonthPick(this); });
  // The bar's team pills carry names while the row has room for them and
  // fall back to crests alone when it doesn't (re-checked on resize).
  function fitTeamStrip() {
    var strip = $('teamStrip'), bar = document.querySelector('.filterbar');
    if (!strip.children.length || !document.documentElement.classList.contains('teams-open')) return;
    // the row gives way in this order (Steve, 2026-09-15 / 16): the off-season
    // clubs down to their crests first; then the bar's chip labels (Add To My
    // Calendar) fold to icons; only then every club a crest. The strip scrolls
    // inside the bar, so it — not the bar — is what's measured.
    var over = function () { return strip.scrollWidth > strip.clientWidth + 1; };
    strip.classList.remove('is-crests', 'is-offcrests'); bar.classList.remove('is-tight');
    if (over()) strip.classList.add('is-offcrests');
    if (over()) bar.classList.add('is-tight');
    if (over()) strip.classList.add('is-crests');
    stripEdge();
    placeKnob();
  }
  // more crests beyond the strip's right edge: a fade says so, lifted once scrolled to the end
  // the preset strip's own fade (same rule as the team strip's)
  function presetEdge() { var el = document.querySelector('#filterPanel .fp-presets'); if (el) el.classList.toggle('is-more-right', el.scrollLeft + el.clientWidth < el.scrollWidth - 2); }
  document.querySelector('#filterPanel .fp-presets').addEventListener('scroll', presetEdge, { passive: true });
  window.addEventListener('resize', presetEdge);
  function stripEdge() { var strip = $('teamStrip'); strip.classList.toggle('is-more-right', strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 2); }
  $('teamStrip').addEventListener('scroll', stripEdge, { passive: true });
  // Re-render the month cards with a reel move: forward (dir > 0) the top
  // card scrolls up and out and the new one rises in from below; backward is
  // the mirror. The outgoing card rides along for the run, then goes.
  var calSwapRun = 0;
  function swapCal(dir) {
    var box = $('calGrid');
    var old = Array.from(box.children);
    renderCal();
    if (!old.length || !dir || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var run = ++calSwapRun;
    var exiting = dir > 0 ? old[0] : old[old.length - 1];
    box.style.height = box.offsetHeight + 'px'; box.style.overflow = 'hidden'; // clip to the two-card stack
    if (dir > 0) box.insertBefore(exiting, box.firstChild); else box.appendChild(exiting);
    var gap = parseFloat(getComputedStyle(box).rowGap) || 0;
    var shift = (dir > 0 ? exiting : box.firstChild).offsetHeight + gap; // one card's worth
    var from = dir > 0 ? 0 : -shift, to = dir > 0 ? -shift : 0;
    var DUR = 340;
    var anims = Array.from(box.children).map(function (c) {
      return c.animate([{ transform: 'translateY(' + from + 'px)' }, { transform: 'translateY(' + to + 'px)' }],
        { duration: DUR, easing: 'cubic-bezier(.2, .7, .2, 1)', fill: 'both' });
    });
    // clean up on a timer rather than onfinish (a newer swap will have
    // re-rendered everything already, so it only runs for the latest run)
    setTimeout(function () {
      if (run !== calSwapRun) return;
      anims.forEach(function (a) { a.cancel(); });
      exiting.remove(); box.style.height = ''; box.style.overflow = '';
    }, DUR + 30);
  }
  // Scroll the list to a day: its own row, or the first listed day after it.
  function scrollToDate(date) {
    var rows = Array.from(document.querySelectorAll('.day-row'));
    var row = rows.filter(function (r) { return r.dataset.date >= date; })[0] || rows[rows.length - 1];
    if (row) row.scrollIntoView({ block: 'start' });
  }
  // The listing follows the calendar: scroll to the shown month's first
  // listed day (a fully past month opens the past list first).
  // While a jump's smooth scroll is in flight the calendar must not follow
  // the list (it would turn back to each month passed on the way): the
  // follow pauses until the scroll ends, or a beat later if scrollend never
  // fires. Resuming doesn't re-sync — if the scroll didn't happen (a hidden
  // tab, nowhere left to scroll) the month you chose stays chosen, and the
  // next real scroll syncs as usual.
  var calFollowPaused = false, calFollowTimer = null;
  function pauseCalFollow() {
    calFollowPaused = true;
    clearTimeout(calFollowTimer);
    calFollowTimer = setTimeout(resumeCalFollow, 1200);
  }
  function resumeCalFollow() {
    calFollowPaused = false; clearTimeout(calFollowTimer);
  }
  window.addEventListener('scrollend', resumeCalFollow);
  function jumpToMonth() {
    var target = ymd(state.month);
    if (target < todayStr() && !sameMonth(state.month, new Date())) {
      state.showPast = true;
      state.pastFrom = target; // nothing older than that month
      renderAgenda();
    }
    pauseCalFollow();
    scrollToDate(target);
  }
  $('calGrid').addEventListener('click', function (e) {
    var cell = e.target.closest('button.cal-day');
    if (!cell || !cell.dataset.date) return;
    var date = cell.dataset.date;
    if (date < todayStr()) {
      // past days are hidden until asked for — and a clicked day is where
      // the past list starts, not the whole year of history
      state.showPast = true;
      state.pastFrom = date;
      renderAgenda();
    }
    scrollToDate(date);
  });

  // ---- agenda ----
  // One continuous list of every upcoming day (the calendar is the way
  // around it). Past days are hidden until asked for — from the calendar (a
  // past day, or ‹ into a past month); TODAY puts them away again.
  function renderAgenda() {
    var ol = $('agenda');
    ol.innerHTML = '';
    var dates = Object.keys(state.byDate).sort();
    var today = todayStr();
    var pastCount = 0;
    var inPast = function (d) { return d < today && (!state.pastFrom || d >= state.pastFrom); };
    dates.forEach(function (date) { if (date < today) pastCount += dayItems(date).length; });
    var shown = 0;
    var visible = dates.filter(function (d) {
      return dayItems(d).length && (d >= today || (state.showPast && inPast(d)));
    });
    // A month divider opens each month; it sticks to the top until the next
    // one pushes it out — which needs each month's rows in their own group
    // (a sticky element only sticks within its parent), so the list is
    // <li class="month-group"> per month holding the divider and its days.
    var lastMonth = null, group = null;
    function ordinal(n) { var t = n % 100; return n + (t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'); }
    // text is the label; a holiday passes { title, date } and reads just
    // "Labor Day" on its own row (its day is right below), "New Year's Day –
    // 1st" when it joins the month's row
    function divider(cls, text) {
      if (cls === 'month-row') {
        group = document.createElement('li');
        group.className = 'month-group';
        ol.appendChild(group);
      }
      var s = document.createElement('span');
      // A holiday falling on a month's first listed day would put two
      // dividers back to back; instead its pill joins the month's row (and
      // hides while that row is stuck, so the sticky header stays the month).
      var joinMonth = cls === 'holiday-row' && group && group.children.length === 1 && group.lastChild.classList.contains('month-row');
      var li = joinMonth ? group.lastChild : document.createElement('div');
      if (!joinMonth) li.className = cls; else { s.className = 'hol-pill'; li.classList.add('has-hol'); } // has-hol: the month oval to the left of the centre line, the holidays stacked to its right (styles.css)
      if (typeof text !== 'string') {
        text = joinMonth ? text.title + ' – ' + ordinal(parseDate(text.date).getDate()) : text.title;
      }
      s.appendChild(document.createTextNode(text));
      li.appendChild(s);
      if (joinMonth) li.style.setProperty('--hols', li.querySelectorAll('.hol-pill').length); // the month oval spans exactly the pills' rows (styles.css)
      if (!joinMonth) (group || ol).appendChild(li);
    }
    function ensureMonth(dateStr) {
      var month = dateStr.slice(0, 7);
      if (month === lastMonth) return;
      lastMonth = month;
      divider('month-row', parseDate(dateStr).toLocaleDateString('en-US', { month: 'long' }));
    }
    // Holidays (when switched on) are plain dividers — "Labor Day – September
    // 7" — placed right above the day's first event, and they scroll past.
    // One that falls on a day with nothing listed still shows, between its
    // neighbors.
    var holDates = Object.keys(holidayMap()).sort();
    var dayBefore = function (s) { var d = parseDate(s); d.setDate(d.getDate() - 1); return ymd(d); };
    var prevDate = state.showPast ? (state.pastFrom ? dayBefore(state.pastFrom) : '') : dayBefore(today);
    function holidaysThrough(dateStr) {
      holDates.forEach(function (hd) {
        if (hd <= prevDate || hd > dateStr) return;
        ensureMonth(hd);
        holidayMap()[hd].forEach(function (h) {
          divider('holiday-row', { title: h.title, date: hd });
        });
      });
      prevDate = dateStr;
    }
    visible.forEach(function (date) {
      var evs = dayItems(date);
      shown += evs.length;
      var d = parseDate(date);
      holidaysThrough(date);
      ensureMonth(date);
      var li = document.createElement('div');
      li.className = 'day-row' + (date === today ? ' is-today' : '') + (date < today ? ' is-past' : '');
      li.dataset.date = date;

      var rail = document.createElement('div');
      rail.className = 'date-rail';
      rail.innerHTML =
        '<span class="dnum">' + d.getDate() + '</span>' +
        '<span class="dmeta">' + d.toLocaleDateString('en-US', { weekday: 'long' }) + '</span>';
      li.appendChild(rail);

      var wrap = document.createElement('div');
      wrap.className = 'day-events';
      evs.forEach(function (e) {
        var row = document.createElement('div');
        row.className = 'ev' + (e.time ? '' : ' is-allday');
        row.addEventListener('click', cardTap(e), true);
        // rows alternate light and dark grey (styles.css --row-a/--row-b, per
        // theme); only a series keeps its venue's hue, at --tint, so the colour
        // means "one of a run" (Steve, 2026-10-20)
        if (e.series) { row.classList.add('is-series'); row.style.background = 'color-mix(in srgb, ' + venueColor(e.venue) + ' var(--tint), transparent)'; }
        var time = document.createElement('span');
        time.className = 'time';
        clockCell(time, e.time ? fmtTime(e.time, e.date) : 'ALL DAY'); // an all-day row reads ALL over DAY in the clock face, like a timed one (Steve, 2026-10-14); the word was "all day" before
        var sn = null;
        if (e.series) {
          // "2 of 4" after the title (Steve, 2026-09-15 — it sat under the time); the gutter graph picks the row up by id
          sn = document.createElement('span');
          sn.className = 'series-n';
          sn.textContent = e.series.n + ' of ' + e.series.total;
          sn.title = seriesLabel(e.series.s);
          row.dataset.series = e.series.s.id;
        }
        // time keeps its own column; everything else stacks left-aligned:
        // venue, then title, then tags
        var body = document.createElement('div');
        body.className = 'ev-body';
        var venue = document.createElement('span');
        venue.className = 'venue';
        venue.appendChild(extLink(e.venue, VENUE_URL[e.venue], "See " + e.venue + "’s own events list"));
        venue.style.setProperty('--dot', venueColor(e.venue));
        var a = document.createElement('a');
        if (e.url) { a.href = e.url; a.target = '_blank'; a.rel = 'noopener'; } // no link (scripts/links.mjs found it dead, venue page too): plain title, never '#'
        a.textContent = e.title;
        var titleLine = document.createElement('span');
        titleLine.className = 'ev-title';
        var team = teamFor(e.title);
        // a home game's crest; a local bar's night carries the bar's own logo
        // the same way (other venues carry no mark)
        var mark = (team && team.logo) || (eventType(e) === 'bar' && LQAFilter.VENUE_ICON[e.venue]) || '';
        if (mark) {
          var logo = document.createElement('img');
          logo.className = 'team-mark' + (team ? '' : ' venue-mark'); // a bar's logo keeps its colors, muted
          logo.src = mark;
          logo.alt = ''; // decorative — the row already names the team/venue
          row.appendChild(logo);
        }
        titleLine.appendChild(a);
        if (sn) row.appendChild(sn); // lower right of the card (CSS)
        body.appendChild(venue); body.appendChild(titleLine);
        // a festival day with its set times: a line saying how much is on (the sets follow as rows of their own; the day card has
        // the grid); one of its sets: the stage and when it ends (Steve, 2026-10-05: the grid on the day's row "look[ed] bad")
        if (Array.isArray(e.sets) && e.sets.length) { var ns = 0; e.sets.forEach(function (st) { ns += st.acts.length; }); var sl = document.createElement('span'); sl.className = 'ev-stage'; sl.textContent = e.sets.length + ' stages \u00b7 ' + ns + ' sets, each listed below'; body.appendChild(sl); }
        else if (e.stage) { var sg = document.createElement('span'); sg.className = 'ev-stage'; sg.textContent = e.stage + (e.end ? ' \u00b7 until ' + fmtTime(e.end, e.date) : ' \u00b7 to close'); body.appendChild(sg); }
        // a show that's off: struck through, with a third line saying so
        // (and when we noticed, if the feed knows)
        if (e.status) {
          row.classList.add('is-off');
          // the card's wash goes gray so only the note has color
          row.style.background = 'color-mix(in srgb, var(--ink-soft) 14%, transparent)';
          var off = document.createElement('span');
          off.className = 'ev-note';
          off.textContent = e.status.charAt(0).toUpperCase() + e.status.slice(1) + (e.statusSince ? ' ' + fmtSince(e.statusSince) : '');
          off.title = 'This event has been ' + e.status + ' — check the ticket page for refunds or a new date';
          body.appendChild(off);
        }
        // Ticketmaster inventory (feed `tickets`, from the local checker):
        // a third line — "272 of 18,100 tickets left · 614 resale · from $25";
        // a sold-out show gets a red frame and a badge
        var ts = LQAFilter.ticketState(e);
        if (ts) ticketTab(row, ts, e); // the red frame and the tab out of the card's foot, sold out and nearly alike (Steve, 2026-09-15)
        var tix = ticketsLine(e);
        if (tix) {
          var tl = document.createElement('span');
          tl.className = 'ev-tix';
          tl.textContent = tix;
          tl.title = e.tickets ? inventoryName(e) + ' inventory' + (e.tickets.checked ? ', checked ' + fmtSince(e.tickets.checked) : '') : 'Sold out, per the venue\u2019s own listing';
          body.appendChild(tl);
        }
        // a game the league may still move
        if (e.dateTbd) {
          var tbd = document.createElement('span');
          tbd.className = 'badge b-tbd';
          tbd.textContent = 'date tbd';
          tbd.title = 'Date not final — the league may still move this game';
          titleLine.appendChild(tbd);
        }
        row.appendChild(time); row.appendChild(body);
        wrap.appendChild(row);
      });
      li.appendChild(wrap);
      (group || ol).appendChild(li);
    });
    // holidays after the last listed day (or all of them, when the filter
    // leaves nothing) — the year ahead, so the switch shows something even
    // with every venue cleared
    var yearOut = new Date(); yearOut.setFullYear(yearOut.getFullYear() + 1);
    holidaysThrough(ymd(yearOut));
    // nothing listed at all (a venue whose dates have all passed, say — the
    // Block Party in October): say so, instead of a bare column; past events
    // put away don't count as something to look at (2026-10-10)
    if (!shown) {
      var li = document.createElement('li');
      li.className = 'empty';
      li.textContent = (pastCount ? 'Nothing coming up in this view — only past events, which are put away. ' : 'Nothing coming up in this view. ') + 'Open Filter to show more, or go back to the usual view.';
      ol.appendChild(li);
    }
    drawSeriesGraph();
    alignRails();
    syncTodayFloat();
  }
  // the series graph is measured from the rows, so it follows the window
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { drawSeriesGraph(); alignRails(); fitTeamStrip(); }, 150);
  });

  // The month divider that's currently stuck (just under the pinned filter
  // bar) gets a shadow: the last one whose top has reached the bar's bottom
  // edge (rAF-throttled scroll).
  // The floating panels (filter panel, Add To Calendar pop, the phone's
  // calendar) hang off the pinned bar, but before the page has scrolled the
  // bar still sits under the masthead — so a stylesheet max-height measured
  // from the top of the viewport can run past its bottom. Cap each open
  // panel at the room it actually has; re-measured as the bar rides up.
  // On open (opening = true) a panel with almost no room — a landscape phone
  // with the masthead still on screen — first scrolls the page until the bar
  // is pinned, which is where the panel would end up anyway.
  function fitPops(opening) {
    [$('filterPanel'), $('subscribePop'), $('calBox')].forEach(function (el) {
      if (el.hidden) return;
      if (el === $('calBox') && !document.querySelector('.cal-side.is-float')) { el.style.maxHeight = ''; return; }
      var room = window.innerHeight - el.getBoundingClientRect().top - 12;
      if (opening && room < 240) {
        var bar = document.querySelector('.filter-area').getBoundingClientRect();
        if (bar.top > 0) {
          window.scrollTo({ top: window.scrollY + bar.top, behavior: 'instant' });
          room = window.innerHeight - el.getBoundingClientRect().top - 12;
        }
      }
      el.style.maxHeight = Math.max(200, Math.round(room)) + 'px';
    });
  }
  window.addEventListener('resize', fitPops);
  // The Today floater shows only when it would do something: past days are
  // open, the calendar is on another month, or the list has scrolled off the
  // day Today would return to (the nearest listed day from today on).
  function syncTodayFloat() {
    var btn = $('calToday');
    var today = todayStr();
    if (monthOpen()) { btn.hidden = !state.month || sameMonth(state.month, new Date()); return; } // the board: shown while the header names another month (Steve, 2026-09-15)
    var edge = document.querySelector('.filter-area').getBoundingClientRect().bottom + 1;
    var rows = Array.from(document.querySelectorAll('#agenda .day-row'));
    var home = rows.filter(function (r) { return r.dataset.date >= today; })[0] || rows[rows.length - 1];
    var first = rows.filter(function (r) { return r.getBoundingClientRect().bottom > edge; })[0];
    var away = state.showPast ||
      (state.month && !sameMonth(state.month, new Date())) ||
      (home && first && first !== home);
    btn.hidden = !away;
  }
  var stuckPending = false, lastHeadH = '', lastFullH = 0;
  var lastBarH = ''; // the measured --barh while the bar is pinned (markStuck)
  var COMPACT_BELOW = 0.75; // the pinned block goes compact once the list below it runs longer than this share of the window
  function markStuck() {
    stuckPending = false;
    // the Back-to-top floater (lower right, above the footer) shows once the
    // page has scrolled a way; the bar's title line the moment the masthead
    // itself is out of view (and goes the moment it's back)
    var atTop = document.scrollingElement.scrollTop < 240;
    if ($('toTop').hidden !== atTop) $('toTop').hidden = atTop;
    var mastOff = document.querySelector('.masthead').getBoundingClientRect().bottom <= 0;
    var bt = document.querySelector('.bar-title');
    if (bt.hidden === mastOff) {
      bt.hidden = !mastOff;
      document.documentElement.classList.toggle('is-scrolled', mastOff); // raises --barh by the title line
      // the masthead's tools (Add To Calendar, the poster chip, the theme pill) ride along: into the title line's right end while the masthead is off, back home when it returns (Steve, 2026-09-14)
      var tools = document.querySelector('.masthead-tools');
      if (tools) (mastOff ? bt : document.querySelector('.masthead')).appendChild(tools);
    }
    fitPops();
    // the Teams block: pinned under the bar once the page has scrolled past
    // its place, and compact while it is — small crests floating at the top
    // with the record or the score, the rest of it folded away. The sentinel
    // is the block's own spot in the flow (it never moves when the block shrinks).
    // (reads only, and a write only when the value moves: a style write
    // between the reads would force a fresh layout on every scroll frame)
    var th = $('teamHead'), teamsOn = !$('teamsView').hidden;
    if (teamsOn && th.firstChild) {
      // the whole block scrolls away with the page like anything else; once it has gone under the bar — and there is a real run of list below to scroll through (a short page, an off-season, keeps nothing pinned) — the compact bar takes its place, pinned under the bar (styles.css: #teamHead is sticky only while compact)
      if (!th.classList.contains('is-compact')) lastFullH = th.offsetHeight;
      var spotTop = $('teamHeadTop').getBoundingClientRect().top, barBottom = document.querySelector('.filter-area').getBoundingClientRect().bottom;
      var se = document.scrollingElement, below = se.scrollHeight - (se.scrollTop + spotTop) - lastFullH; // the page below the block's spot
      var compact = spotTop + lastFullH <= barBottom && below > window.innerHeight * COMPACT_BELOW;
      if (th.classList.contains('is-compact') !== compact) {
        // going compact the block gives up height; that height goes into its bottom margin so the page keeps its length — otherwise a short page shrinks under the scroll, the block unpins, grows, pins again, and loops
        var fullH = compact ? th.offsetHeight : 0;
        th.classList.toggle('is-compact', compact);
        th.style.marginBottom = compact ? 'calc(1.1rem + ' + Math.max(0, fullH - th.offsetHeight) + 'px)' : '';
        if (!compact) settleBlock();
      }
      var headH = compact ? th.offsetHeight + 'px' : ''; // the opponent bar and the month rows pin below the compact bar (the bar's top padding is the gap under the filter bar)
      if (headH !== lastHeadH) { lastHeadH = headH; if (headH) $('teamsView').style.setProperty('--head-h', headH); else $('teamsView').style.removeProperty('--head-h'); }
    }
    var faRect = document.querySelector('.filter-area').getBoundingClientRect();
    if (faRect.top === 0 && document.scrollingElement.scrollTop > 0) { // pinned: its real height is what the sticky rows below offset by — the rem estimate ran 9px long and a sliver of list showed between the bar and the month rule (Steve, 2026-09-18)
      var bh = Math.round(faRect.bottom) + 'px';
      if (bh !== lastBarH) { lastBarH = bh; document.documentElement.style.setProperty('--barh', bh); }
    } else if (lastBarH) { lastBarH = ''; document.documentElement.style.removeProperty('--barh'); }
    var edge = faRect.bottom + 1;
    var rows = document.querySelectorAll('section:not([hidden]) .month-row'); // the list on show: agenda or Teams
    var stuck = null;
    rows.forEach(function (r) { if (r.getBoundingClientRect().top <= edge) stuck = r; });
    rows.forEach(function (r) { r.classList.toggle('is-stuck', r === stuck && document.scrollingElement.scrollTop > 0); });
    // and the mini calendar follows the list: its first month is the month
    // of the first day still in view under the bar
    var first = null;
    if (state.month && !calFollowPaused && !teamsOn && !document.documentElement.classList.contains('teams-open')) { // the agenda only; the first row still under the bar, by bisection (the rows are in order)
      var days = document.querySelectorAll('.agenda .day-row'), lo = 0, hi = days.length - 1;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (days[mid].getBoundingClientRect().bottom > edge) hi = mid; else lo = mid + 1; }
      if (days.length && days[lo].getBoundingClientRect().bottom > edge) first = days[lo];
    }
    if (first) {
      var ym = first.dataset.date.slice(0, 7);
      var cur = ymd(state.month).slice(0, 7);
      if (ym !== cur) {
        state.month = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1);
        swapCal(ym > cur ? 1 : -1); // the reel turns the way the list moved
      }
    }
    syncTodayFloat();
  }
  window.addEventListener('scroll', function () {
    placeSheet(); // the event pop rides with its card, same frame as the scroll
    if (!stuckPending) { stuckPending = true; requestAnimationFrame(markStuck); setTimeout(function () { if (stuckPending) markStuck(); }, 150); } // a hidden tab gets no frames: the timer keeps the pin state in step with the scroll
  }, { passive: true });
  $('toTop').addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });

  // The footer keeps to one line: when it wouldn't fit, Sources, Embed and
  // Advertise drop to their icons; if it still doesn't fit, the credit drops
  // to its mark. (The Updated stamp, which used to go first, was removed
  // 2026-10-05 — Steve.)
  function fitFooter() {
    var inner = document.querySelector('.foot-inner');
    inner.classList.remove('is-tight', 'is-tighter');
    if (inner.scrollWidth > inner.clientWidth + 1) inner.classList.add('is-tight');
    if (inner.scrollWidth > inner.clientWidth + 1) inner.classList.add('is-tighter');
  }
  fitFooter();
  window.addEventListener('resize', fitFooter);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitFooter);

  // the footer's Sources and Embed panels float open over the list; a click
  // anywhere else folds them back
  document.addEventListener('click', function (e) {
    document.querySelectorAll('footer details[open]').forEach(function (d) {
      if (!d.contains(e.target)) d.open = false;
    });
  });

  // ---- subscribe popover ----
  // The feed follows the active filter where a pre-built file exists: the
  // default no-movies view, one hidden team, or "only" one venue. Anything
  // else falls back to the full feed.
  var icsHref = '';
  function updateSubscribe() {
    if (document.documentElement.classList.contains('teams-open')) { // Teams mode: the club's season (home and away), or every club's
      $('subFilterRow').hidden = true;
      setSubscribeFile(teamView.slugs.length === 1 ? 'team-' + teamView.slugs[0] + '.ics' : 'teams.ics');
      return;
    }
    var filteredFile = null;
    if (anyIncluded() || modeKeys(state.capMode, 'ex').length) { $('subFilterRow').hidden = true; setSubscribeFile('events.ics'); return; } // a checked box or an X'd band: no ready-made feed matches
    var vEx = modeKeys(state.venueMode, 'ex');
    var bEx = modeKeys(state.badgeMode, 'ex');
    var tEx = modeKeys(state.teamMode, 'ex');
    var vOn = state.venues.filter(function (v) { return state.venueMode[v] !== 'ex'; });
    var movieOnly = bEx.length === 1 && bEx[0] === 'movie';
    if (!vEx.length && !tEx.length && movieOnly) {
      filteredFile = 'events-no-movies.ics'; // the default view
    } else if (!vEx.length && !bEx.length && tEx.length === 1) {
      filteredFile = 'events-no-' + tEx[0] + '.ics';
    } else if (vOn.length === 1 && !tEx.length &&
        (!bEx.length || (movieOnly && vOn[0] !== CITY.movieVenue))) {
      // a lone remaining venue is "only that venue"; the baseline movie
      // exclusion changes nothing unless that venue is the cinema itself
      filteredFile = 'events-venue-' + slugify(vOn[0]) + '.ics';
    }
    $('subFilterRow').hidden = !filteredFile;
    setSubscribeFile((filteredFile && $('subUseFilter').checked) ? filteredFile : 'events.ics');
  }
  function setSubscribeFile(file) {
    icsHref = new URL(file, location.href).href;
    var webcal = icsHref.replace(/^https?:/, 'webcal:');
    $('webcalLink').href = webcal;
    $('gcalLink').href = 'https://calendar.google.com/calendar/r?cid=' + encodeURIComponent(webcal);
    $('outlookLink').href = 'https://outlook.live.com/calendar/0/addfromweb?url=' +
      encodeURIComponent(icsHref) + '&name=' + encodeURIComponent(CITY.ics.short);
    if (!$('qrPanel').hidden) renderQr();
  }
  // QR of the webcal link (scanning it on iOS subscribes directly), rendered
  // locally by the vendored qrcode.js — no third-party service involved.
  function renderQr() {
    var qr = qrcode(0, 'L');
    qr.addData(icsHref.replace(/^https?:/, 'webcal:'));
    qr.make();
    $('qrImg').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }
  $('qrBtn').addEventListener('click', function (ev) {
    ev.preventDefault();
    var p = $('qrPanel');
    p.hidden = !p.hidden;
    this.setAttribute('aria-expanded', String(!p.hidden));
    if (!p.hidden) renderQr();
  });
  $('subUseFilter').addEventListener('change', updateSubscribe);
  updateSubscribe();
  // the pop floats over the docked mini calendar and is shorter than it,
  // so while it's open the calendar fades out (styles.css: html.pop-open)
  // rather than showing a strip of days under the pop's bottom edge
  // The pop hangs from the Add To My Calendar button itself (fixed, under
  // its right edge), wherever the button is — the masthead, or the pinned
  // title line once the page has scrolled — instead of from the bar, which
  // in the Teams view put it under the club strip, over the score block
  // (Steve, 2026-09-15). Re-placed as the page scrolls or resizes.
  function placeSubscribePop() {
    var p = $('subscribePop');
    if (p.hidden) return;
    var r = $('subscribeBtn').getBoundingClientRect();
    p.style.position = 'fixed'; p.style.left = 'auto';
    p.style.top = (r.bottom + 8) + 'px';
    p.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    // right edges aligned — unless the pop then runs off the left edge (a phone, where the button sits mid-line beside More Cities since 2026-10-26): then it spans the screen with 8px margins
    if (p.getBoundingClientRect().left < 8) { p.style.left = '8px'; p.style.right = '8px'; }
  }
  function setSubscribeOpen(open) {
    $('subscribePop').hidden = !open;
    $('subscribeBtn').setAttribute('aria-expanded', String(open));
    document.documentElement.classList.toggle('pop-open', open);
    if (open) { $('qrPanel').hidden = true; $('qrBtn').setAttribute('aria-expanded', 'false'); placeSubscribePop(); fitPops(true); }
  }
  window.addEventListener('scroll', placeSubscribePop, { passive: true });
  window.addEventListener('resize', placeSubscribePop);
  $('subscribeBtn').addEventListener('click', function () { setSubscribeOpen($('subscribePop').hidden); });
  document.addEventListener('click', function (e) {
    if (!e.target.closest('#subscribeBtn, #subscribePop') && !$('subscribePop').hidden) setSubscribeOpen(false);
  });
  $('copyIcs').addEventListener('click', function (ev) {
    ev.preventDefault();
    var chip = this;
    copyText(icsHref).then(function () {
      chip.classList.add('is-done'); // the chip shows a check for a moment
      setTimeout(function () { chip.classList.remove('is-done'); }, 1500);
    });
  });

  if (!loadFiltersFromURL()) loadFilters();
  load();
  // ?team=…&print=1: the page as the poster, ready for a headless print-to-PDF
  if (new URLSearchParams(location.search).get('print') === '1') {
    var printWait = setInterval(function () {
      var slug = new URLSearchParams(location.search).get('team');
      var t = LQAFilter.TEAMS.filter(function (x) { return x.slug === slug; })[0];
      if (!t || !teamGames(slug) || !$('teamCal').querySelector('.cal-month')) return;
      clearInterval(printWait); prepPrint(t);
      document.documentElement.classList.add('print-ready');
    }, 200);
  }
  // a ?team= link opens the Teams view straight away
  if (new URLSearchParams(location.search).get('team')) setTeamsView(new URLSearchParams(location.search).get('team'), false);
  window.LQAHooks = { dayItems: dayItems, byDate: function () { return state.byDate; }, boardEntry: boardEntry, closeDayPop: closeDayPop, syncViewSwitch: syncViewSwitch, fitFilterBar: fitFilterBar, todayStr: todayStr, venueColor: venueColor }; // what local-map.js borrows
})();
