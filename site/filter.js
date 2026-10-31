// LQA Events — shared filter/classification logic.
//
// Single source of truth for "does this event survive the filter", used by
// the main calendar (app.js) and by other sites that render a filtered
// slice of the feed (e.g. the river site's Neighborhood section). Keeping
// this in one file means a change to team regexes or event-type rules can't
// silently drift between the sites that consume it.
//
// Filter state shape: { venueMode, badgeMode, teamMode } — each a map of
// key -> 'ex' for excluded; a key absent from the map means included. Venue
// keys are the raw venue name as it appears in events.json (e.g. "The Vera
// Project"); badge keys are the TYPE_LIST keys (concert/sports/arts/movie/
// community); team keys are TEAMS[].slug.
(function (global) {
  'use strict';

  // The home teams and the venues are the city's (city.js, loaded first):
  // every field is described there. One table per venue field here, so the
  // rules below read as they always did.
  var CITY = global.LQACity;
  if (!CITY) throw new Error('city.js must load before filter.js');
  var TEAMS = CITY.teams;
  var TEAM_BY_SLUG = {};
  TEAMS.forEach(function (t) { TEAM_BY_SLUG[t.slug] = t; });
  function venueTable(field) {
    var out = {};
    Object.keys(CITY.venues).forEach(function (v) { if (CITY.venues[v][field] !== undefined) out[v] = CITY.venues[v][field]; });
    return out;
  }

  var TYPE_VENUE_DEFAULT = venueTable('type'); // the type when the title decides nothing
  var TYPE_KEYS_OK = { concert: 1, sports: 1, arts: 1, movie: 1, community: 1, expo: 1, bar: 1 };
  // Order: the movie flag and a home team / "vs" are certain. Then the
  // source's own classification (feed `type`: Ticketmaster segment, DICE
  // type tags, Seattle Center facility/type tags — scripts/sources.mjs),
  // except that a source's "community" is coarse (Seattle Center tags all
  // of Winterfest "Festivals", movie nights and comedy included), so a
  // concrete movie/arts word in the title beats it. Then title rules, then
  // what the venue usually hosts.
  function eventType(e) {
    var title = e.title || '';
    if (e.type === 'bar') return 'bar'; // a bar's night is a bar night, trivia or watch party or band
    if (e.movie) return 'movie';
    if (TEAMS.some(function (t) { return t.re.test(title); }) || /\bvs\.?\s/i.test(title)) return 'sports';
    var src = e.type && TYPE_KEYS_OK[e.type] ? e.type : '';
    if (src && src !== 'community') return src;
    if (/movie night|\bfilm\b|screening/i.test(title)) return 'movie';
    if (/ballet|opera|symphon|orchestra|philharmon|theatre|theater|musical|broadway|shakespeare|comedy|stand-?up|improv|dance|cirque|on ice|preview performance|opening night|matinee|open caption|sensory-friendly|audio described/i.test(title)) return 'arts';
    if (src) return src;
    if (/convention|\bexpo\b|\bcon\b|trade ?show|home show|boat show|card show|record show|book fair|gem & jewelry|bridal|craft (fair|show|uprising)|comic ?con/i.test(title)) return 'expo';
    if (/workshop|\bclass(es)?\b|intro to|open session|\b[A-Z]{2}\s?\d{3}:|festival|fest[aá]l|\bfair\b|\bexpo\b|market|convention|summit|celebration|ceremony|\bwalk\b|\brun\b|parade/i.test(title)) return 'community';
    if (/concert|\btour\b|live music|\bdj\b|\blive\b/i.test(title)) return 'concert';
    return TYPE_VENUE_DEFAULT[e.venue] || 'community';
  }

  var VENUE_ICON = venueTable('icon'); // marks for listings without a team crest
  var VENUE_COLOR = venueTable('color'); // hues for dark backgrounds — the same values styles.css sets as --v-*; keep the two in step

  var VENUE_CAPACITY = venueTable('capacity'); // how many people each place holds — the one measure of an event's size the sources agree on

  // Ticket state from the feed's `tickets` and `soldOut`: 'soldout' (the box
  // office has nothing left), 'nearly' (what's left is 5% of the house or
  // less — a night's worth of returns, at an arena and a ballpark alike; 100
  // tickets where the venue has no capacity on file), '' otherwise.
  function ticketState(e) {
    if (e.soldOut) return 'soldout';
    var t = e.tickets;
    if (!t || t.box == null || t.box <= 0) return '';
    var cap = e.capacity || VENUE_CAPACITY[e.venue]; // the night's own house first
    return t.box <= (cap ? Math.ceil(cap * 0.05) : 100) ? 'nearly' : '';
  }

  // Capacity bands (Steve, 2026-09-20): four house-size ranges over
  // VENUE_CAPACITY, a filter option each. A venue with no capacity on file
  // counts as a small room.
  var CAP_BANDS = [
    { key: 'stadium', label: 'Stadiums', note: '40K+', min: 40000, max: Infinity },
    { key: 'arena', label: 'Arenas & Grounds', note: '5K\u201340K', min: 5000, max: 40000 },
    { key: 'hall', label: 'Halls', note: '800\u20135K', min: 800, max: 5000 },
    { key: 'room', label: 'Small Venues', note: 'under 800', min: 0, max: 800 },
  ];
  function bandOf(venue) {
    var c = VENUE_CAPACITY[venue] || 0;
    for (var i = 0; i < CAP_BANDS.length; i++) if (c >= CAP_BANDS[i].min && c < CAP_BANDS[i].max) return CAP_BANDS[i].key;
    return 'room';
  }

  // 'town' = a bus ride away (the stadiums, the Convention Center, the
  // music rooms downtown); a venue missing here is campus. A festival's
  // rows sit together in the panel's Festivals group whatever its area,
  // and its days are one series.
  var VENUE_AREA = venueTable('area');
  var VENUE_FESTIVAL = venueTable('festival');

  function slugify(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  // Three states per option (Steve, 2026-09-22): Show = 'in', Hide = 'ex',
  // absent = no preference. The row that names the thing wins (Steve,
  // 2026-10-05: "I want show to always show, and hide to always hide" — a
  // Show on the Block Party with Concerts hidden showed nothing): a team row
  // names a game exactly, a venue row names its place, and either one's
  // Show or Hide is final for its events, the team's first. The general
  // rows — event types, capacity bands — only decide the events no specific
  // row has spoken for. Shows still narrow: once any venue or team is on
  // Show, only the Shown ones' events show; once any type (or band) is, the
  // undecided events narrow to those kinds. Nothing on Show anywhere =
  // everything but the Hides. No option ever changes another.
  function matchesFilter(e, mode) {
    mode = mode || {};
    var venueMode = mode.venueMode || {}, badgeMode = mode.badgeMode || {}, teamMode = mode.teamMode || {}, capMode = mode.capMode || {};
    var band = bandOf(e.venue), type = eventType(e), title = e.title || '';
    if (mode.soldOnly && !ticketState(e)) return false; // the "Only Sold Out" switch: only those
    var k, anySpecific = false, anyType = false, anyBand = false;
    // the specific rows: the team that plays, then the venue — a Hide or a Show on one is the answer
    for (k in teamMode) {
      if (teamMode[k] === 'in') anySpecific = true;
      if (teamMode[k] && TEAM_BY_SLUG[k] && TEAM_BY_SLUG[k].re.test(title)) return teamMode[k] === 'in';
    }
    for (k in venueMode) if (venueMode[k] === 'in') anySpecific = true;
    if (venueMode[e.venue]) return venueMode[e.venue] === 'in';
    if (anySpecific) return false; // a Show on a venue or a team: only theirs
    // the general rows, for an event no specific row spoke for: the kind and the band
    if (badgeMode[type] === 'ex' || capMode[band] === 'ex') return false;
    for (k in badgeMode) if (badgeMode[k] === 'in') anyType = true;
    for (k in capMode) if (capMode[k] === 'in') anyBand = true;
    return (!anyType || badgeMode[type] === 'in') && (!anyBand || capMode[band] === 'in');
  }

  // Compact filter code <-> filter state, for share links (?f=CODE).
  // REGISTRY (city.js) is every filterable key in a fixed, append-only
  // order; the code is the set of EXCLUDED (X) entries as a bitmask
  // written in upper-case base 36, zero-padded to CODE_LENGTH characters
  // ("000000" means everything shown); parsing accepts either case. Since
  // the three-state panel (2026-09-22) a view with checked entries writes
  // a second mask after a dot — "EX.IN" — and a code without the dot is
  // the old kind, X's only. Old, shorter codes still parse.
  var CODE_LENGTH = CITY.codeLength;
  var REGISTRY = CITY.registry;
  var GROUP_MAP = { venue: 'venueMode', badge: 'badgeMode', team: 'teamMode', cap: 'capMode' };
  function maskOf(mode, which) {
    var mask = 0;
    REGISTRY.forEach(function (entry, i) {
      var map = mode[GROUP_MAP[entry[0]]] || {};
      if (map[entry[1]] === which) mask += Math.pow(2, i);
    });
    var code = mask.toString(36).toUpperCase();
    while (code.length < CODE_LENGTH) code = '0' + code;
    return code;
  }
  function encodeFilterCode(mode) {
    var ex = maskOf(mode, 'ex'), inn = maskOf(mode, 'in');
    return /^0+$/.test(inn) ? ex : ex + '.' + inn;
  }
  function parseFilterCode(code) {
    var mode = { venueMode: {}, badgeMode: {}, teamMode: {}, capMode: {} };
    var parts = String(code).split('.');
    var masks = [parseInt(parts[0], 36), parts.length > 1 ? parseInt(parts[1], 36) : 0];
    if (masks.some(function (m) { return isNaN(m) || m < 0; })) return null;
    REGISTRY.forEach(function (entry, i) {
      if (Math.floor(masks[0] / Math.pow(2, i)) % 2 === 1) mode[GROUP_MAP[entry[0]]][entry[1]] = 'ex';
      else if (Math.floor(masks[1] / Math.pow(2, i)) % 2 === 1) mode[GROUP_MAP[entry[0]]][entry[1]] = 'in';
    });
    return mode;
  }

  // ---- search ----
  // Every whitespace-separated word must appear somewhere in the event's
  // venue, title, type words, or the home team's name — so "kraken",
  // "climate", "arts", "home game" and "vera concert" all do the obvious.
  var TYPE_WORDS = {
    concert: 'concert concerts music show', sports: 'sports game games home game',
    arts: 'arts art theater theatre', movie: 'movie movies film cinema',
    community: 'community festival festivals fair',
    expo: 'expo expos convention conventions conference trade show',
    bar: 'bar bars pub nightlife trivia karaoke happy hour watch party',
  };
  // each team's sport and league, so "baseball" finds the Mariners
  var SPORT_WORDS = {
    mariners: 'baseball mlb', storm: 'basketball wnba', seahawks: 'football nfl',
    reign: 'soccer nwsl', sounders: 'soccer mls', kraken: 'hockey nhl', torrent: 'hockey pwhl',
  };
  function matchesSearch(e, q) {
    var words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    var title = e.title || '';
    var hay = [e.venue || '', title, TYPE_WORDS[eventType(e)] || '', e.festival || '']; // an approved festival's name (scripts/festivals.mjs)
    TEAMS.forEach(function (t) {
      if (t.re.test(title)) hay.push(t.label + ' home game ' + (SPORT_WORDS[t.slug] || ''));
    });
    hay = hay.join(' ').toLowerCase();
    return words.every(function (w) { return hay.indexOf(w) !== -1; });
  }
  // The search term travels in share links as ?s=CODE: UTF-8 bytes, each
  // XOR-ed with a rolling key, in URL-safe base64 — unreadable in the URL bar
  // but fully reversible, so the link opens with the same search applied.
  var S_KEY = [0x4c, 0x51, 0x41, 0x21, 0x37, 0x6b];
  function encodeSearch(q) {
    var bytes = unescape(encodeURIComponent(String(q || '')));
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes.charCodeAt(i) ^ S_KEY[i % S_KEY.length]);
    return btoa(out).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decodeSearch(code) {
    try {
      var bytes = atob(String(code || '').replace(/-/g, '+').replace(/_/g, '/'));
      var out = '';
      for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes.charCodeAt(i) ^ S_KEY[i % S_KEY.length]);
      return decodeURIComponent(escape(out));
    } catch (e) { return ''; }
  }

  // Event-type hues for dark backgrounds — same values as the calendar's
  // dark --t-* variables; keep in step.
  var TYPE_COLOR = { concert: '#f0806a', sports: '#f2d21b', arts: '#d63a4f', movie: '#8b9db0', community: '#e660a8', expo: '#4fd1c5', bar: '#e3ad3c' };

  // ---- series: the same event on nearby days — a homestand, a two-night
  // stand, an opera run. Same venue + same title, occurrences within 2 days
  // of each other. Movies sit this out: SIFF's daily showtimes would make
  // everything a series. Returns the series (sorted by start, with ids) and
  // stamps each member event with e.series = { s, n, total }.
  // s.lane says whether the gutter graph draws it: a run that is on day
  // after day for longer than a week (a theatre run, a seasonal village —
  // dark Mondays included, "day after day" is at least 4 dates in 7) is
  // wallpaper, not something a reader traces, and only clutters the
  // gutter; its "n of N" label under the time still says it's a run. ----
  function parseYmd(s) { var p = String(s).split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }
  // a Rep performance's title carries its keywords after a colon ("Eureka
  // Day: Preview Performance", "…: Opening Night", "…: Open Captioning");
  // the run is one series, so the key is the show alone (Steve, 2026-09-16:
  // the previews, opening night and run were three lines in one lane)
  function seriesBase(e) { var t = String(e.title || ''); return VENUE_FESTIVAL[e.venue] ? e.venue : e.venue === 'Seattle Rep' ? t.split(':')[0] : t; } // a festival's days are titled by their headliners; the festival is the series
  function seriesKey(e) { return e.venue + '|' + seriesBase(e).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function seriesLabel(s) {
    var f = function (d) { return parseYmd(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
    return seriesBase(s.events[0]).trim() + ' — ' + s.events.length + ' ' + (eventType(s.events[0]) === 'sports' ? 'games' : 'nights') + ' · ' + f(s.start) + ' – ' + f(s.end);
  }
  function findSeries(list) {
    var groups = {};
    list.forEach(function (e) {
      delete e.series;
      if (e.movie || e.set) return; // a festival's sets are the day's, not a series of their own (the day rows are the festival's "n of N")
      var k = seriesKey(e);
      (groups[k] = groups[k] || []).push(e);
    });
    var all = [];
    var flush = function (run) {
      if (run.length < 2) return;
      var s = { venue: run[0].venue, start: run[0].date, end: run[run.length - 1].date, events: run };
      var span = Math.round((parseYmd(s.end) - parseYmd(s.start)) / 86400e3); // days between first and last
      var daily = run.length / (span + 1) >= 4 / 7;
      s.lane = !(daily && span >= 7);
      run.forEach(function (e, i) { e.series = { s: s, n: i + 1, total: run.length }; });
      all.push(s);
    };
    Object.keys(groups).forEach(function (k) {
      var evs = groups[k].sort(function (a, b) { return (a.date + (a.time || '')) < (b.date + (b.time || '')) ? -1 : 1; });
      var run = [evs[0]];
      for (var i = 1; i < evs.length; i++) {
        var gap = Math.round((parseYmd(evs[i].date) - parseYmd(evs[i - 1].date)) / 86400e3);
        // a run's dates are consecutive or every other day; a class that
        // meets weekly or Wed/Sat (3–4 apart) must not chain into one
        if (gap <= 2) run.push(evs[i]); else { flush(run); run = [evs[i]]; }
      }
      flush(run);
    });
    all.sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });
    all.forEach(function (s, i) { s.id = i; });
    return all;
  }

  // Lanes are assigned on row order, not pixels, so the gutter can be
  // sized before anything is measured: each series takes the first free
  // lane whose last series ended above it. With maxLanes, anything that
  // would need a lane past the cap is merged into the last lane instead
  // (it.merged), and the graph draws that lane as one shared trunk with
  // each series' own coloured branches into its cards, git-client style.
  // items: [{ from, to, ... }] sorted by from; returns laneEnd (its length
  // is the lane count) and sets it.lane / it.merged on each.
  function assignLanes(items, maxLanes) {
    var laneEnd = [];
    var cap = maxLanes > 0 ? maxLanes : Infinity;
    items.forEach(function (it) {
      for (var l = 0; ; l++) {
        if (l >= cap) { it.lane = cap - 1; it.merged = true; laneEnd[it.lane] = Math.max(laneEnd[it.lane], it.to); break; }
        if (laneEnd[l] == null || laneEnd[l] < it.from) { laneEnd[l] = it.to; it.lane = l; break; }
      }
    });
    return laneEnd;
  }

  // The series graph: a vertical line per series in a gutter to the right
  // of the rows, git-client style; at each of its rows the lane swings over
  // to touch the row's right edge and swings back (an incoming curve from
  // above and its mirror below). The first row of a series has only the
  // outgoing half, the last only the incoming; the lane runs off the top or
  // bottom edge when the series continues on another page.
  //   container: positioned element the rows sit in (gets the <svg>)
  //   rows: [{ el, series }] in document order, only rows in a series
  //   opts: firstDate/lastDate of the page, laneWidth (px), bend (px),
  //         dot (px radius; 0 or unset for none) drawn where the line meets
  //         each row, onLanes(n) called before measuring so the caller can
  //         size its gutter, gutterX(containerBox) → x of the first lane's
  //         left edge relative to the container, color(series), label(series)
  // Returns the number of lanes used.
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function drawSeriesGraph(container, rows, opts) {
    var old = container.querySelector('.series-graph');
    if (old) old.remove();
    var byId = {};
    rows.forEach(function (r, i) {
      var k = r.series.id;
      if (!byId[k]) byId[k] = { s: r.series, els: [], idx: [] };
      byId[k].els.push(r.el); byId[k].idx.push(i);
    });
    // lanes are assigned on row order, not pixels, so the gutter can be
    // sized before anything is measured: the first free lane whose last
    // series ended above this one
    var items = Object.keys(byId).map(function (k) {
      var it = byId[k], s = it.s;
      it.before = s.start < opts.firstDate; it.after = s.end > opts.lastDate;
      it.from = it.before ? -1 : it.idx[0]; it.to = it.after ? rows.length : it.idx[it.idx.length - 1];
      return it;
    }).sort(function (a, b) { return a.from - b.from; });
    var laneEnd = assignLanes(items, opts.maxLanes);
    if (opts.onLanes) opts.onLanes(laneEnd.length);
    if (!items.length) return 0;
    var box = container.getBoundingClientRect(); // after the caller sized its gutter
    var gx = typeof opts.gutterX === 'function' ? opts.gutterX(box) : opts.gutterX;
    var laneW = opts.laneWidth, b = opts.bend || 24, h = opts.hug || 0;
    var top = h + b, bot = h + b; // a join's reach above and below the row's centre
    var f = function (v) { return Math.round(v * 10) / 10; };
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'series-graph');
    svg.setAttribute('width', box.width);
    svg.setAttribute('height', box.height);
    svg.setAttribute('aria-hidden', 'true');
    var defs = null;
    var trunk = {}; // lane -> [[top, bottom], ...] the stretch of the lane each merged-lane series occupies
    var merged = {};
    items.forEach(function (it) { if (it.merged) merged[it.lane] = true; });
    items.forEach(function (it, idx) {
      var pts = it.els.map(function (el) { var r = el.getBoundingClientRect(); return { x: r.right - box.left - 1, y: r.top + r.height / 2 - box.top }; });
      var x = f(gx + it.lane * laneW + laneW / 2);
      var n = pts.length;
      // one continuous path per series, top to bottom: the pen starts at
      // the page edge (or the first row's edge), and for each row runs the
      // straight lane down to the row's entry, curves in, and curves back out.
      // A series whose earlier dates aren't listed (they're in the past)
      // arrives as a lead that fades in, 0% at the top of the first listed
      // row's day group → 100% at the curve into the row, so it reads as
      // "continues from earlier" without dead-ending against anything.
      var d = '';
      if (it.before) {
        var leadEnd = f(pts[0].y - top);
        var group = it.els[0].closest(opts.groupSelector || '.day-row');
        var leadStart = group ? f(Math.max(0, group.getBoundingClientRect().top - box.top)) : 0;
        if (leadEnd > leadStart) {
          if (!defs) { defs = document.createElementNS(SVG_NS, 'defs'); svg.appendChild(defs); }
          var gid = 'sg-fade-' + idx + '-' + Math.round(Math.random() * 1e6);
          var grad = document.createElementNS(SVG_NS, 'linearGradient');
          grad.setAttribute('id', gid);
          grad.setAttribute('gradientUnits', 'userSpaceOnUse');
          grad.setAttribute('x1', 0); grad.setAttribute('x2', 0);
          grad.setAttribute('y1', leadStart); grad.setAttribute('y2', leadEnd);
          [[0, 0], [1, 1]].forEach(function (s) {
            var stop = document.createElementNS(SVG_NS, 'stop');
            stop.setAttribute('offset', s[0]);
            stop.style.stopColor = opts.color(it.s); // a style, so a CSS var works
            stop.setAttribute('stop-opacity', s[1]);
            grad.appendChild(stop);
          });
          defs.appendChild(grad);
          var lead = document.createElementNS(SVG_NS, 'path');
          lead.setAttribute('class', 'sg-line');
          lead.setAttribute('d', 'M' + x + ' ' + leadStart + ' L' + x + ' ' + leadEnd);
          lead.style.stroke = 'url(#' + gid + ')';
          svg.appendChild(lead);
        }
        d = 'M' + x + ' ' + Math.max(leadStart, leadEnd);
      }
      // Each join is a merge, not a hairpin: an S-curve from the lane that
      // arrives running along the card's edge, a short straight hug of the
      // edge either side of the row's centre, and an S-curve back out — so
      // the tangent is the edge's own at the join and nothing kinks.
      pts.forEach(function (p, i) {
        var starts = i === 0 && !it.before, ends = i === n - 1 && !it.after;
        var px = f(p.x), py = f(p.y);
        var hi = f(py - h), lo = f(py + h);
        if (starts) d += 'M' + px + ' ' + py + ' L' + px + ' ' + lo;
        else d += ' L' + x + ' ' + f(py - top) + ' C' + x + ' ' + f(py - h - b / 2) + ' ' + px + ' ' + f(py - h - b / 2) + ' ' + px + ' ' + hi
          + ' L' + px + ' ' + (ends ? py : lo);
        if (!ends) d += ' C' + px + ' ' + f(py + h + b / 2) + ' ' + x + ' ' + f(py + h + b / 2) + ' ' + x + ' ' + f(py + bot);
      });
      if (it.after) d += ' L' + x + ' ' + f(box.height);
      if (d.indexOf('C') < 0 && d.indexOf('L') < 0) return; // a lone row with nothing to connect
      if (merged[it.lane]) { // where this series runs along the lane: from its first curve out to its last curve in
        var t0 = it.before ? 0 : pts[0].y + bot, t1 = it.after ? box.height : pts[n - 1].y - top;
        if (t1 > t0) (trunk[it.lane] = trunk[it.lane] || []).push([t0, t1]);
      }
      var path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('class', 'sg-line');
      path.setAttribute('d', d);
      path.style.stroke = opts.color(it.s);
      // with an edge colour, the stroke fades across the bend from the lane's
      // colour to the card's own, so at the join it dissolves into the card
      if (opts.edgeColor) {
        if (!defs) { defs = document.createElementNS(SVG_NS, 'defs'); svg.appendChild(defs); }
        var eid = 'sg-edge-' + idx + '-' + Math.round(Math.random() * 1e6);
        var eg = document.createElementNS(SVG_NS, 'linearGradient');
        eg.setAttribute('id', eid);
        eg.setAttribute('gradientUnits', 'userSpaceOnUse');
        eg.setAttribute('x1', f(pts[0].x)); eg.setAttribute('x2', x); eg.setAttribute('y1', 0); eg.setAttribute('y2', 0);
        [[0, opts.edgeColor(it.s)], [1, opts.color(it.s)]].forEach(function (st) {
          var stop = document.createElementNS(SVG_NS, 'stop');
          stop.setAttribute('offset', st[0]);
          stop.style.stopColor = st[1];
          eg.appendChild(stop);
        });
        defs.appendChild(eg);
        path.style.stroke = 'url(#' + eid + ')';
      }
      if (opts.label) {
        var tip = document.createElementNS(SVG_NS, 'title');
        tip.textContent = opts.label(it.s);
        path.appendChild(tip);
      }
      svg.appendChild(path);
    });
    // merged lanes: where two or more series run along the lane at once, a
    // neutral trunk is drawn over their verticals so the stretch reads as
    // shared; a series alone in the lane keeps its colour, and only the
    // branches into the cards are ever coloured on a shared stretch
    Object.keys(trunk).forEach(function (l) {
      var x = f(gx + Number(l) * laneW + laneW / 2);
      var edges = [];
      trunk[l].forEach(function (iv) { edges.push([iv[0], 1]); edges.push([iv[1], -1]); });
      edges.sort(function (a, b) { return a[0] - b[0] || b[1] - a[1]; }); // a start before an end at the same y
      var depth = 0, from = null;
      edges.forEach(function (e) {
        var was = depth; depth += e[1];
        if (was < 2 && depth >= 2) from = e[0];
        else if (was >= 2 && depth < 2 && from != null) {
          var t = document.createElementNS(SVG_NS, 'path');
          t.setAttribute('class', 'sg-line sg-trunk');
          t.setAttribute('d', 'M' + x + ' ' + f(from) + ' L' + x + ' ' + f(e[0]));
          svg.appendChild(t);
          from = null;
        }
      });
    });
    container.appendChild(svg);
    return laneEnd.length;
  }

  // Which page numbers a pager shows: always the first, last and current,
  // then the current's neighbors outward until the slots run out (a …
  // between non-adjacent numbers takes a slot too).
  function pagesToShow(total, page, slots) {
    var i, all = [];
    if (total <= slots) { for (i = 0; i < total; i++) all.push(i); return all; }
    var shown = {};
    shown[0] = shown[total - 1] = shown[page] = true;
    var keys = function () { return Object.keys(shown).map(Number).sort(function (a, b) { return a - b; }); };
    var rendered = function () {
      var k = keys(), n = k.length;
      for (var j = 1; j < k.length; j++) if (k[j] - k[j - 1] > 1) n++;
      return n;
    };
    for (var r = 1; r < total; r++) {
      var added = false;
      [page - r, page + r].forEach(function (p) {
        if (p <= 0 || p >= total - 1 || shown[p]) return;
        shown[p] = true;
        if (rendered() > slots) delete shown[p]; else added = true;
      });
      if (!added) break;
    }
    return keys();
  }

  global.LQAFilter = {
    TYPE_COLOR: TYPE_COLOR,
    findSeries: findSeries,
    assignLanes: assignLanes,
    seriesLabel: seriesLabel,
    drawSeriesGraph: drawSeriesGraph,
    pagesToShow: pagesToShow,
    TEAMS: TEAMS,
    TEAM_BY_SLUG: TEAM_BY_SLUG,
    VENUE_ICON: VENUE_ICON,
    VENUE_COLOR: VENUE_COLOR,
    VENUE_CAPACITY: VENUE_CAPACITY,
    CAP_BANDS: CAP_BANDS,
    bandOf: bandOf,
    VENUE_AREA: VENUE_AREA,
    VENUE_FESTIVAL: VENUE_FESTIVAL,
    slugify: slugify,
    eventType: eventType,
    matchesFilter: matchesFilter,
    ticketState: ticketState,
    matchesSearch: matchesSearch,
    encodeSearch: encodeSearch,
    decodeSearch: decodeSearch,
    encodeFilterCode: encodeFilterCode,
    parseFilterCode: parseFilterCode,
  };
})(typeof window !== 'undefined' ? window : globalThis); // globalThis: the node tests
