// The Map view — the fourth stop of the view toolbar, in a city whose city.js
// carries a `map` block and `geo: [lat, lon]` on its rooms (Steve, 2026-10-24,
// "local map view for event locations": Kona first, then lqa and Seattle).
// Shared: synced from lqa by sync-shared.sh; a city without a map simply does
// not load it (no Map stop in its index.html), and app.js's hooks stay quiet.
//
// The ground is local-map.json (scripts/build-local-map.mjs — an island's
// outline from Natural Earth, or a city's shoreline, lakes and main roads
// from OpenStreetMap, read once at build time and committed), drawn as one
// SVG with a pin on every room that has geo. A pin is sized by the room's
// upcoming events under the filters in force and opens a card of them (the
// month view's day card) with the room's own site at its foot. Wheel, pinch,
// drag and the +/−/fit buttons zoom and pan; two rooms on one spot are nudged
// apart so both can be tapped. app.js lends what it needs via window.LQAHooks.
// A site whose rows are circuits and regions rather than rooms (curling.events)
// sets map.pins: 'places' — then a pin is a place the events name (each event's
// `place` and `geo`, written by its build), on a world ground (map.kind 'world').
// A neighbourhood site (map.city) also draws the rest of its city: the city's
// rooms and their upcoming events, read from the city site's feed at build
// time into city-map.json (scripts/city-map.mjs) — "maps for neighborhoods
// should include events from the entire city" (Steve, 2026-10-25). A city's
// ground (kind 'urban') is a rectangle of data, so the view never leaves it:
// zoomed right out the frame is still full (same day, "the map should fill
// the area"). A trackpad pinch or scroll zooms by the wheel's delta, not a
// fixed step per event (same day, "way sensitive"). The crosshair button asks
// the browser for the visitor's position and marks it (no service involved).
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var CITY = window.LQACity, H = window.LQAHooks, svg = $('lmSvg');
  if (!CITY || !H || !svg) return;
  var VENUES = CITY.venues, ROOMS = Object.keys(VENUES).filter(function (v) { return VENUES[v].geo; });
  var BY_PLACE = !!(CITY.map && CITY.map.pins === 'places'); // the pins are the places the events name, not the rooms
  var data = null, view = null, FRAME = { w: 1000, h: 1000 }, u = 1; // view: the viewBox in frame units; u: frame units per CSS pixel
  var CITYMAP = null, CITY_ROOMS = []; // a neighbourhood site: the rest of the city's rooms (city-map.json) — those its own city.js does not carry
  var me = null; // the visitor's own spot, once asked for: { x, y, acc } in frame units, and when
  var NS = 'http://www.w3.org/2000/svg';
  var openVenue = null, rafId = 0;

  function el(tag, attrs, parent) { var e = document.createElementNS(NS, tag); for (var k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }
  function px(lat, lon) { var p = data.proj; if (p.kind === 'miller') return [(lon - p.cx) * p.s + p.w / 2, (p.my0 - 1.25 * Math.asinh(Math.tan(.8 * lat * Math.PI / 180)) * 180 / Math.PI) * p.s]; return [(lon - p.cx) * p.k * p.s + p.w / 2, (p.cy - lat) * p.s + p.h / 2]; } // a world ground is Miller cylindrical; a city's is flat
  function version() { var s = document.querySelector('script[src*="local-map.js"]'); var m = s && /[?&]v=([^&]+)/.exec(s.getAttribute('src')); return m ? m[1] : ''; }
  function load() {
    if (data) return Promise.resolve(data);
    return fetch('local-map.json' + (version() ? '?v=' + version() : '')).then(function (r) { return r.json(); }).then(function (d) {
      data = d; FRAME = { w: d.proj.w, h: d.proj.h };
      svg.parentElement.style.setProperty('--lm-ar', FRAME.w / FRAME.h); // the frame takes the ground's shape
      if (!view) home(false);
      if (!(CITY.map && CITY.map.city)) return d;
      return fetch('city-map.json' + (version() ? '?v=' + version() : '')).then(function (r) { return r.ok ? r.json() : null; }).then(function (c) {
        CITYMAP = c && c.venues ? c : null;
        CITY_ROOMS = CITYMAP ? Object.keys(CITYMAP.venues).filter(function (v) { return !VENUES[v] && CITYMAP.venues[v].geo; }) : []; // a room the neighbourhood lists itself keeps its own, filtered pin
        return d;
      }, function () { return d; }); // no city file (a build that could not read the city's feed): the neighbourhood alone
    });
  }
  // a neighbourhood site (`map.focus: 'hood'`) opens on its own rooms — those
  // without `area: 'town'` — with room round them for the discs and names
  // (Steve, 2026-10-24: "focus to contain the URLs in that neighboorhood")
  function hoodBox() {
    if (!data || !CITY.map || CITY.map.focus !== 'hood') return null;
    var pts = ROOMS.filter(function (v) { return VENUES[v].area !== 'town'; }).map(function (v) { return px(VENUES[v].geo[0], VENUES[v].geo[1]); });
    if (!pts.length) return null;
    var xs = pts.map(function (p) { return p[0]; }), ys = pts.map(function (p) { return p[1]; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    var pad = Math.max((x1 - x0) * .35, (y1 - y0) * .35, FRAME.w * .03);
    return [x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad];
  }
  // the view at first: the neighbourhood's rooms, else the city's `home` box (a wider frame holds the out-of-town rooms), else the whole frame
  var atHome = true; // the view is still the opening one (no zoom or pan yet): it follows the frame's shape when that changes
  function home(draw) {
    atHome = true; var hb = hoodBox();
    if (hb || (data && data.home)) { var h = hb || data.home, a = ar(), w = Math.max(h[2], h[3] / a); view = { x: h[0] + h[2] / 2 - w / 2, y: h[1] + h[3] / 2 - w * a / 2, w: w, h: w * a }; }
    else fit(false);
    if (draw !== false) render();
  }
  function fit(draw) { atHome = false; var a = ar(), w = COVER() ? MAX_W() : Math.max(FRAME.w, FRAME.h / a); view = { x: (FRAME.w - w) / 2, y: (FRAME.h - w * a) / 2, w: w, h: w * a }; if (draw !== false) render(); } // a city ground: as far out as still fills the frame; an island or the world: the whole ground
  // the frame's own proportions (height over width): it fills the content's width and the height the window leaves,
  // whatever the ground's shape — the viewBox follows the frame, not the other way round (Steve, 2026-10-24)
  function ar() { var r = svg.parentElement.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? r.height / r.width : FRAME.h / FRAME.w; }
  function size() { // as tall as the window leaves between the frame's top and the pinned footer, less the caption under it (never under 18rem, or half the window on a short phone)
    var fr = svg.parentElement, cap = $('lmCaption'), foot = document.querySelector('footer');
    var top = fr.getBoundingClientRect().top + window.scrollY, floor = window.innerHeight - (foot ? foot.offsetHeight : 0);
    var h = Math.floor(floor - top - (cap ? cap.offsetHeight + 10 : 0) - 8), rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    var min = Math.min(18 * rem, window.innerHeight * .5); fr.style.height = Math.max(h, min) + 'px';
    var over = document.documentElement.scrollHeight - window.innerHeight; if (over > 0 && h - over >= min) fr.style.height = (h - over) + 'px'; // whatever the estimate missed (a caption that wrapped), once
  }
  function reshape() { if (!view) return; var cy = view.y + view.h / 2; view.h = view.w * ar(); view.y = cy - view.h / 2; } // the frame changed shape: keep the centre, follow the new proportions
  function unit() { var r = svg.getBoundingClientRect(); return r.width ? view.w / r.width : 1; }
  function isOpen() { return document.documentElement.classList.contains('map-open'); }

  // the rooms' upcoming events under the filters, per room, in date order — or per place, where the pins are places
  // (every upcoming place is a pin, filtered out or not, so a filtered-out one shows as a hollow ring like an empty room)
  function tally() {
    var today = H.todayStr(), by = H.byDate(), n = {}, next = {}, geo = {}, color = {};
    Object.keys(by).sort().forEach(function (d) {
      if (d < today) return;
      if (BY_PLACE) by[d].forEach(function (e) { if (e.geo && e.place && !geo[e.place]) { geo[e.place] = e.geo; color[e.place] = e.venue; } });
      H.dayItems(d).forEach(function (e) { var k = BY_PLACE ? e.place : e.venue; if (BY_PLACE && !e.geo) return; n[k] = (n[k] || 0) + 1; (next[k] = next[k] || []).push(e); });
    });
    CITY_ROOMS.forEach(function (v) { // the rest of the city: the room's upcoming count as of the build, no filter but the date (the panel's rows are the neighbourhood's own); the card gets the first few
      var cm = CITYMAP.venues[v], list = (cm.next || []).filter(function (e) { return e.date >= today; });
      if (cm.n) { n[v] = Math.max(cm.n - ((cm.next || []).length - list.length), list.length); next[v] = list; } // less whatever of the kept few has passed since the build
    });
    return { n: n, next: next, geo: geo, color: color };
  }

  // pins closer than a tap apart are pushed off each other (a few iterations
  // of pairwise repulsion), but never farther than their own radius from the
  // true spot (p.cap) — the venue stays under its disc; where a city's rooms
  // sit closer than that, the discs overlap, and a zoom in parts them
  function spread(pins, gap) {
    for (var it = 0; it < 40; it++) {
      var moved = false;
      for (var i = 0; i < pins.length; i++) for (var j = i + 1; j < pins.length; j++) {
        var a = pins[i], b = pins[j], dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || .001, want = a.r + b.r + gap; // the discs clear each other by a hair
        if (d >= want) continue;
        var push = (want - d) / 2, ux = dx / d, uy = dy / d;
        if (d < .01) { ux = 1; uy = 0; }
        a.x -= ux * push; a.y -= uy * push; b.x += ux * push; b.y += uy * push; moved = true;
      }
      pins.forEach(function (p) { var ex = p.x - p.ox, ey = p.y - p.oy, e = Math.sqrt(ex * ex + ey * ey); if (e > p.cap) { p.x = p.ox + ex / e * p.cap; p.y = p.oy + ey / e * p.cap; } });
      if (!moved) break;
    }
  }
  // labels: right of the pin first, then left, below, above — the first spot
  // clear of every label already placed (and the frame's edge); none, if none
  function placeLabels(pins, fs, seed) {
    var boxes = (seed || []).slice(), cw = fs * .58, lh = fs * 1.25;
    function free(bx, self) { if (bx.x < view.x || bx.x + bx.w > view.x + view.w || bx.y < view.y || bx.y + bx.h > view.y + view.h) return false; return !boxes.some(function (o) { return o.pin !== self && bx.x < o.x + o.w && bx.x + bx.w > o.x && bx.y < o.y + o.h && bx.y + bx.h > o.y; }); }
    function disc(p) { boxes.push({ x: p.x - p.r, y: p.y - p.r, w: 2 * p.r, h: 2 * p.r, pin: p }); } // a square round the disc; a pin's own square is skipped for its own label (the diagonal spots clear the circle, not the square)
    pins.filter(function (p) { return p.n; }).forEach(disc); // the counted discs first; an empty pin's disc only after the counted names are placed (a name beats a hollow ring)
    pins.slice().sort(function (a, b) { return b.n - a.n || a.y - b.y; }).forEach(function (p, i, all) {
      if (!p.n && (i === 0 || all[i - 1].n)) pins.filter(function (q) { return !q.n; }).forEach(disc);
      var w = p.name.length * cw + fs * .3, g = p.r + fs * .35;
      var spots = [
        { x: p.x + g, y: p.y - lh / 2, anchor: 'start', tx: p.x + g, ty: p.y },
        { x: p.x - g - w, y: p.y - lh / 2, anchor: 'end', tx: p.x - g, ty: p.y },
        { x: p.x - w / 2, y: p.y + g, anchor: 'middle', tx: p.x, ty: p.y + g + lh / 2 },
        { x: p.x - w / 2, y: p.y - g - lh, anchor: 'middle', tx: p.x, ty: p.y - g - lh / 2 },
        // then the diagonals, for a pin hemmed in on its four sides
        { x: p.x + g * .75, y: p.y - g * .75 - lh, anchor: 'start', tx: p.x + g * .75, ty: p.y - g * .75 - lh / 2 },
        { x: p.x + g * .75, y: p.y + g * .75, anchor: 'start', tx: p.x + g * .75, ty: p.y + g * .75 + lh / 2 },
        { x: p.x - g * .75 - w, y: p.y - g * .75 - lh, anchor: 'end', tx: p.x - g * .75, ty: p.y - g * .75 - lh / 2 },
        { x: p.x - g * .75 - w, y: p.y + g * .75, anchor: 'end', tx: p.x - g * .75, ty: p.y + g * .75 + lh / 2 },
      ];
      for (var k = 0; k < spots.length; k++) { var bx = { x: spots[k].x, y: spots[k].y, w: w, h: lh }; if (free(bx, p)) { boxes.push(bx); p.label = spots[k]; return; } }
      p.label = null;
    });
    return boxes;
  }

  function render() {
    if (!data || !isOpen()) return;
    size(); if (atHome) home(false); else reshape(); clamp(); // the frame may have changed shape since the view was set
    u = unit();
    svg.setAttribute('viewBox', [view.x, view.y, view.w, view.h].map(function (v) { return v.toFixed(2); }).join(' '));
    svg.style.setProperty('--u', u);
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var zoom = FRAME.w / view.w; // 1 = the whole frame
    // ---- the ground ----
    if (data.kind === 'urban') { // land everywhere inside the frame, the sea and the lakes over it, then the roads
      el('rect', { x: -FRAME.w, y: -FRAME.h, width: FRAME.w * 3, height: FRAME.h * 3, 'class': 'lm-land' }, svg); // land everywhere the view can reach (it stays inside the frame — a sliver past the edge, if any, is land too)
      (data.sea || []).forEach(function (d) { el('path', { d: d, 'class': 'lm-sea', 'fill-rule': 'evenodd' }, svg); });
      (data.water || []).forEach(function (d) { el('path', { d: d, 'class': 'lm-water', 'fill-rule': 'evenodd' }, svg); });
      ['secondary', 'primary', 'trunk', 'motorway'].forEach(function (c) { if (data.roads && data.roads[c]) el('path', { d: data.roads[c], 'class': 'lm-road lm-road-' + c }, svg); });
    } else if (data.kind === 'world') { // the ocean everywhere, the countries over it, the state lines and the great lakes over those
      el('rect', { x: -FRAME.w, y: -FRAME.h, width: FRAME.w * 3, height: FRAME.h * 3, 'class': 'lm-ocean' }, svg);
      (data.land || []).forEach(function (d) { el('path', { d: d, 'class': 'lm-island', 'fill-rule': 'evenodd' }, svg); });
      if (data.borders) el('path', { d: data.borders, 'class': 'lm-border' }, svg);
      (data.water || []).forEach(function (d) { el('path', { d: d, 'class': 'lm-water', 'fill-rule': 'evenodd' }, svg); });
    } else {
      (data.far || data.neighbours || []).forEach(function (d) { el('path', { d: d, 'class': 'lm-far' }, svg); });
      (data.land || [data.island]).forEach(function (d) { el('path', { d: d, 'class': 'lm-island' }, svg); });
    }
    // ---- the rooms: size by count, then nudged apart, then labelled ----
    var t = tally(), fs = 12.5 * u, total = 0, cityTotal = 0, keys = (BY_PLACE ? Object.keys(t.geo) : ROOMS).concat(CITY_ROOMS);
    var pins = keys.map(function (v) {
      var cm = !VENUES[v] && CITYMAP && CITYMAP.venues[v]; // one of the city's rooms beyond the neighbourhood
      var g = cm ? cm.geo : BY_PLACE ? t.geo[v] : VENUES[v].geo, p = px(g[0], g[1]), n = t.n[v] || 0; if (cm) cityTotal += n; else total += n;
      var room = cm || VENUES[v] || {};
      return { v: v, city: !!cm, name: BY_PLACE && !cm ? v.split(',')[0] : (room.short || v.replace(/ National Historic(al)? (Park|Site)$/, '')), ox: p[0], oy: p[1], x: p[0], y: p[1], n: n, r: (n ? 7 + 2.2 * Math.sqrt(n) : 5) * u, color: cm ? (cm.color || '#8899aa') : H.venueColor(BY_PLACE ? t.color[v] : v) }; // a place takes the hue of its first event's row; a city room its own
    });
    // crowding: the discs in view may cover about a sixth of it; past that every disc shrinks alike (a dense city at the whole-frame zoom), never below half
    var area = 0; pins.forEach(function (p) { if (p.ox > view.x - p.r && p.ox < view.x + view.w + p.r && p.oy > view.y - p.r && p.oy < view.y + view.h + p.r) area += Math.PI * p.r * p.r; });
    var shrink = Math.min(1, Math.max(.5, Math.sqrt(.16 * view.w * view.h / (area || 1))));
    pins.forEach(function (p) { p.r *= shrink; p.cap = Math.max(p.r * .9, 10 * u); });
    spread(pins, 3 * u);
    // ---- the other cities on here.events nearby, as highway mileage signs (Steve, 2026-10-26: "add labels for nearby locations … more like these, including distance"):
    // one green sign per edge the cities lie beyond, a row each — name left, distance right — and a one-row sign beside the dot of a city inside the view.
    // Laid out before the labels, which keep clear of the boards; drawn on top of everything (the layer is re-appended at the end) ----
    var ctl = $('mapView').querySelector('.lm-zoom'), ctlBottom = 0, keepOut = []; if (ctl) { var cr = ctl.getBoundingClientRect(), sr = svg.getBoundingClientRect(); ctlBottom = view.y + (cr.bottom - sr.top) * u; keepOut.push({ x: view.x + (cr.left - sr.left) * u - 6 * u, y: view.y, w: (cr.width + 6) * u + 6 * u, h: ctlBottom - view.y + 6 * u }); } // the zoom buttons' column: no sign under it
    var sf = 15 * u, sPad = sf * 1.02, capH = sf * .72, sRow = sf * 1.45, inset = 12 * u, bySide = { top: [], bottom: [], left: [], right: [] }, signLayer = el('g', { 'class': 'lm-signs' }, svg), signBoxes = [];
    var dUnit = CITY.distanceUnit === 'km' ? 'km' : 'mi'; // city.js distanceUnit: 'km' where the roads are signed in kilometres (Steve, 2026-10-26: "mi for countries that support it or km for the others")
    function overlaps(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }
    function inView(bx) { return bx.x >= view.x + inset && bx.x + bx.w <= view.x + view.w - inset && bx.y >= view.y + inset && bx.y + bx.h <= view.y + view.h - inset; }
    function cover(a, b) { return Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)); }
    function crowding(bx) { var c = 0; pins.forEach(function (p) { c += cover(bx, { x: p.x - p.r, y: p.y - p.r, w: 2 * p.r, h: 2 * p.r }); }); signBoxes.concat(keepOut).forEach(function (o) { c += cover(bx, o) * 1000; }); return c; } // how much of the board lies over rooms (and, far worse, over another sign or the buttons)
    function clearOfRooms(bx) { return crowding(bx) === 0; }
    function sign(rows, placeAt) { // rows: [{name, dist, url}]; placeAt(w, h) names the board's top-left once the words are measured (a width guessed from the letter count ran "Spokane223" together)
      var g = el('g', { 'class': 'lm-sign' }, signLayer), board = el('rect', { rx: sf * .5, 'class': 'lm-sign-board' }, g); // one white line, the board's own edge (Steve, 2026-10-26: 'the white border should actually be the border')
      var items = rows.map(function (r) {
        var a = el('a', { href: cityLink(r), 'class': 'lm-city' }, g), ttl = el('title', {}, a); ttl.textContent = r.name + "'s calendar on here.events — about " + r.dist + (dUnit === 'km' ? ' km' : ' miles');
        var hit = el('rect', { height: sRow, 'class': 'lm-sign-hit' }, a);
        var t1 = el('text', { 'text-anchor': 'start', 'font-size': sf, 'class': 'lm-sign-name' }, a); t1.textContent = r.name;
        var t2 = el('text', { 'text-anchor': 'end', 'font-size': sf, 'class': 'lm-sign-mi' }, a); t2.textContent = r.dist + ' ' + dUnit;
        return { hit: hit, t1: t1, t2: t2 };
      });
      var nameW = 0, miW = 0; items.forEach(function (it) { nameW = Math.max(nameW, it.t1.getComputedTextLength()); miW = Math.max(miW, it.t2.getComputedTextLength()); });
      var w = sPad * 2 + nameW + sf * 2 + miW, h = sPad * 2 + capH + (rows.length - 1) * sRow; // the block of words, the capitals' top to the last baseline, inside the same margin on every side (Steve, 2026-10-26: "the margins must be nice")
      var at = placeAt(w, h); if (!at) { g.remove(); return null; }
      var x0 = Math.min(view.x + view.w - inset - w, Math.max(view.x + inset, at.x)), y0 = Math.min(view.y + view.h - inset - h, Math.max(view.y + inset, at.y)); // inside the view whatever it measured
      board.setAttribute('x', x0); board.setAttribute('y', y0); board.setAttribute('width', w); board.setAttribute('height', h);
      items.forEach(function (it, i) {
        var base = y0 + sPad + capH + i * sRow;
        it.hit.setAttribute('x', x0); it.hit.setAttribute('width', w); it.hit.setAttribute('y', base - capH - (sRow - capH) / 2); // the whole row taps
        it.t1.setAttribute('x', x0 + sPad); it.t1.setAttribute('y', base); it.t2.setAttribute('x', x0 + w - sPad); it.t2.setAttribute('y', base);
      });
      var bx = { x: x0, y: y0, w: w, h: h }; signBoxes.push(bx); return bx;
    }
    function settle(bx, axis) { // the board slid along its edge (x for a top/bottom sign, y for a side one) to the nearest clear spot — failing one, the least crowded
      var step = (axis === 'x' ? bx.w : bx.h) * .5, lim = axis === 'x' ? [view.x + inset, view.x + view.w - inset - bx.w] : [view.y + inset, view.y + view.h - inset - bx.h], best = null, bestC = Infinity;
      for (var k = 0; k < 24; k++) {
        var off = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * step, v = Math.min(lim[1], Math.max(lim[0], (axis === 'x' ? bx.x : bx.y) + off));
        var t = axis === 'x' ? { x: v, y: bx.y, w: bx.w, h: bx.h } : { x: bx.x, y: v, w: bx.w, h: bx.h }, c = crowding(t);
        if (c === 0) return t;
        if (c < bestC) { bestC = c; best = t; }
      }
      return best || bx;
    }
    nearbyCities(100).forEach(function (c) {
      var p = px(c.lat, c.lon), row = { name: c.name, key: c.key, dist: Math.max(1, Math.round(dUnit === 'km' ? c.km : c.km * .621371)), url: c.url, x: p[0], y: p[1] };
      if (p[0] > view.x + inset && p[0] < view.x + view.w - inset && p[1] > view.y + inset && p[1] < view.y + view.h - inset) { // inside the view: its dot, the sign beside it where the rooms leave room
        el('circle', { cx: p[0], cy: p[1], r: 3.5 * u, 'class': 'lm-city-dot' }, signLayer);
        var probe = sign([row], function (w, h) { // right of the dot, then left, below, above, the diagonals, then the same a step farther — the first spot in view and clear of the rooms' discs (Steve, 2026-10-26: "too much overlap")
          var gap = 8 * u, spots = [];
          [1, 2.2].forEach(function (m) { var g = gap * m; spots.push({ x: p[0] + g, y: p[1] - h / 2 }, { x: p[0] - g - w, y: p[1] - h / 2 }, { x: p[0] - w / 2, y: p[1] + g }, { x: p[0] - w / 2, y: p[1] - g - h }, { x: p[0] + g, y: p[1] + g }, { x: p[0] - g - w, y: p[1] + g }, { x: p[0] + g, y: p[1] - g - h }, { x: p[0] - g - w, y: p[1] - g - h }); });
          for (var k = 0; k < spots.length; k++) { var bx = { x: spots[k].x, y: spots[k].y, w: w, h: h }; if (inView(bx) && clearOfRooms(bx)) return spots[k]; }
          return null; // hemmed in: the sign goes to the edge instead, like a city beyond the view
        });
        if (probe) return;
      }
      var cx = view.x + view.w / 2, cy = view.y + view.h / 2, dx = (p[0] - cx) / view.w, dy = (p[1] - cy) / view.h; // which edge: the one its direction leaves by first
      bySide[Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top')].push(row);
    });
    Object.keys(bySide).forEach(function (side) {
      var rows = bySide[side]; if (!rows.length) return;
      rows.sort(function (p, q) { return p.dist - q.dist; });
      var mx = rows.reduce(function (t, r) { return t + r.x; }, 0) / rows.length, my = rows.reduce(function (t, r) { return t + r.y; }, 0) / rows.length; // where they lie, on average: the sign sits at that point of the edge
      sign(rows, function (w, h) {
        var y = Math.min(view.y + view.h - inset - h, Math.max(view.y + inset, my - h / 2)), x = Math.min(view.x + view.w - inset - w, Math.max(view.x + inset, mx - w / 2));
        if (side === 'right' && ctlBottom && y < ctlBottom + inset) y = Math.min(view.y + view.h - inset - h, ctlBottom + inset); // not under the zoom buttons
        if (side === 'top') return settle({ x: x, y: view.y + inset, w: w, h: h }, 'x');
        if (side === 'bottom') return settle({ x: x, y: view.y + view.h - inset - h, w: w, h: h }, 'x');
        if (side === 'left') return settle({ x: view.x + inset, y: y, w: w, h: h }, 'y');
        return settle({ x: view.x + view.w - inset - w, y: y, w: w, h: h }, 'y');
      });
    });
    var boxes = placeLabels(pins, fs, signBoxes); // the labels keep clear of the signs
    // ---- the places a visitor steers by, where a pin's label has not taken the spot ----
    var tfs = 10.5 * u;
    function labelFree(x, y, w, anchor) { var bx = { x: anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x, y: y - tfs, w: w, h: tfs * 1.3 }; if (bx.x < view.x || bx.x + bx.w > view.x + view.w || bx.y < view.y || bx.y + bx.h > view.y + view.h) return false; return !boxes.some(function (o) { return bx.x < o.x + o.w && bx.x + bx.w > o.x && bx.y < o.y + o.h && bx.y + bx.h > o.y; }) && (boxes.push(bx), true); }
    (data.labels || []).forEach(function (L) {
      var x = L.xy[0], y = L.xy[1], tx;
      if (L.kind === 'peak') {
        var s = 5 * u;
        el('path', { d: 'M' + (x - s) + ' ' + (y + s * .8) + 'L' + x + ' ' + (y - s) + 'L' + (x + s) + ' ' + (y + s * .8) + 'Z', 'class': 'lm-peak' }, svg);
        if (zoom >= .9 && labelFree(x, y + s * 2.6, L.name.length * tfs * .62, 'middle')) { tx = el('text', { x: x, y: y + s * 2.6, 'text-anchor': 'middle', 'font-size': tfs * .92, 'class': 'lm-peak-name' }, svg); tx.textContent = L.name; }
      } else if (L.kind === 'water') {
        if (labelFree(x, y, L.name.length * tfs * .6, 'middle')) { tx = el('text', { x: x, y: y, 'text-anchor': 'middle', 'font-size': tfs * .95, 'class': 'lm-water-name' }, svg); tx.textContent = L.name; }
      } else {
        var dx = (L.anchor === 'end' ? -1 : L.anchor === 'middle' ? 0 : 1) * 6 * u, dy = (L.dy || 4) * u;
        el('circle', { cx: x, cy: y, r: 2.2 * u, 'class': 'lm-town-dot' }, svg);
        if (labelFree(x + dx, y + dy, L.name.length * tfs * .68, L.anchor)) { tx = el('text', { x: x + dx, y: y + dy, 'text-anchor': L.anchor, 'font-size': tfs, 'class': 'lm-town' }, svg); tx.textContent = L.name; }
      }
    });
    pins.forEach(function (p) {
      if (Math.abs(p.x - p.ox) + Math.abs(p.y - p.oy) > 1.5 * u) el('path', { d: 'M' + p.ox + ' ' + p.oy + 'L' + p.x + ' ' + p.y, 'class': 'lm-leader' }, svg);
    });
    pins.slice().sort(function (a, b) { return b.r - a.r; }).forEach(function (p) { // the big discs first, so a small one overlapped stays on top
      var g = el('g', { 'class': 'lm-pin' + (p.n ? '' : ' is-empty') + (p.city ? ' is-city' : '') + (openVenue === p.v ? ' is-open' : ''), role: 'button', tabindex: '0', 'data-venue': p.v }, svg);
      g.style.setProperty('--pin', p.color);
      var title = el('title', {}, g); title.textContent = p.v + ' — ' + (p.n ? p.n + ' upcoming' : 'nothing upcoming under these filters');
      el('circle', { cx: p.x, cy: p.y, r: p.r, fill: p.color }, g);
      if (p.n) { var n = el('text', { x: p.x, y: p.y + p.r * .36, 'font-size': Math.max(9 * u, p.r * .95), 'class': 'lm-n' }, g); n.textContent = p.n; }
      if (p.label) { var l = el('text', { x: p.label.tx, y: p.label.ty + fs * .36, 'text-anchor': p.label.anchor, 'font-size': fs, 'class': 'lm-name' }, g); l.textContent = p.name; }
    });
    if (me) { // the visitor: a ring the size of the fix's uncertainty, a dot at its centre
      var mg = el('g', { 'class': 'lm-me' }, svg);
      el('circle', { cx: me.x, cy: me.y, r: Math.max(me.acc, 6 * u), 'class': 'lm-me-acc' }, mg);
      el('circle', { cx: me.x, cy: me.y, r: 5 * u, 'class': 'lm-me-dot' }, mg);
      var mt = el('title', {}, mg); mt.textContent = 'You are here';
    }
    svg.appendChild(signLayer); // the signs over everything
    var cap = $('lmCaption'), own = keys.filter(function (v) { return VENUES[v] && t.n[v]; }).length, ownAll = keys.length - CITY_ROOMS.length;
    if (cap) cap.firstElementChild.textContent = total + ' upcoming at ' + own + ' of ' + ownAll + ' places' + (CITY_ROOMS.length ? ' · ' + cityTotal + ' more across ' + (CITYMAP.city || 'the city') : '');
  }
  function schedule() { if (!rafId) rafId = requestAnimationFrame(function () { rafId = 0; render(); }); }

  // ---- zoom and pan ----
  var MIN_W = function () { return FRAME.w / (data && data.kind === 'urban' ? 24 : data && data.kind === 'world' ? 120 : 16); }; // a city zooms a little deeper: its rooms sit a block apart; the world much deeper, down to a state's towns
  var COVER = function () { return !!data && data.kind === 'urban'; }; // a city's ground is a rectangle of data, so the view stays inside it and the frame is always full (Steve, 2026-10-25); an island sits in open sea, the world in ocean — those run on past the data
  var MAX_W = function () { var a = ar(); return COVER() ? Math.min(FRAME.w, FRAME.h / a) : Math.max(FRAME.w, FRAME.h / a) * 1.3; }; // out to the whole ground (plus a margin) in the frame's own shape — or, covered, as far as still fills it
  function clamp() {
    view.w = Math.min(MAX_W(), Math.max(MIN_W(), view.w)); view.h = view.w * ar();
    var m = COVER() ? 0 : .15; // the margin the view may show past the ground
    var lo = -FRAME.w * m, hi = FRAME.w * (1 + m) - view.w; view.x = hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, view.x)); // wider than the ground: centred on it
    lo = -FRAME.h * m; hi = FRAME.h * (1 + m) - view.h; view.y = hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, view.y));
  }
  function zoomAt(cx, cy, f) { // cx, cy: client coordinates the zoom keeps still
    var r = svg.getBoundingClientRect(), k = view.w / r.width, fx = (cx - r.left) * k + view.x, fy = (cy - r.top) * k + view.y;
    atHome = false; var w = view.w / f; w = Math.min(MAX_W(), Math.max(MIN_W(), w)); var ff = view.w / w;
    view.x = fx - (fx - view.x) / ff; view.y = fy - (fy - view.y) / ff; view.w = w; view.h = w * ar();
    clamp(); closePop(); schedule();
  }
  var pts = {}, drag = null, pinch = null;
  svg.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest && e.target.closest('.lm-city')) return; // a sign is a plain link: no capture, or the click lands on the svg and the link never fires (Steve, 2026-10-26: 'the click to everett from Seattle isn't working')
    pts[e.pointerId] = { x: e.clientX, y: e.clientY }; svg.setPointerCapture(e.pointerId);
    var ids = Object.keys(pts);
    if (ids.length === 1) drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, target: e.target.closest('.lm-pin') };
    else if (ids.length === 2) { var a = pts[ids[0]], b = pts[ids[1]]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), w: view.w, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; drag = null; }
  });
  svg.addEventListener('pointermove', function (e) {
    if (!pts[e.pointerId]) return;
    pts[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = Object.keys(pts);
    if (pinch && ids.length === 2) {
      var a = pts[ids[0]], b = pts[ids[1]], d = Math.hypot(a.x - b.x, a.y - b.y), f = d / (pinch.d || 1);
      view.w = pinch.w; view.h = view.w * ar(); zoomAt(pinch.mx, pinch.my, f); return;
    }
    if (!drag) return;
    var k = view.w / svg.getBoundingClientRect().width, dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true; atHome = false; svg.classList.add('is-dragging'); closePop();
    view.x = drag.vx - dx * k; view.y = drag.vy - dy * k; clamp();
    svg.setAttribute('viewBox', [view.x, view.y, view.w, view.h].join(' '));
  });
  function up(e) {
    delete pts[e.pointerId];
    if (drag && !drag.moved && drag.target) toggleVenue(drag.target.dataset.venue, drag.target);
    else if (drag && !drag.moved && !drag.target) closePop();
    if (drag && drag.moved) schedule(); // the labels re-fitted to the new frame
    drag = null; if (Object.keys(pts).length < 2) pinch = null; svg.classList.remove('is-dragging');
  }
  svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
  svg.addEventListener('wheel', function (e) { // by the delta's size, never a fixed step per event: a trackpad pinch (ctrlKey, small deltas, dozens a second) or two-finger scroll lands many events per gesture, a mouse notch one of ±100 or so (≈ 1.2×)
    e.preventDefault();
    var d = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1), f = Math.exp(-d * (e.ctrlKey ? .01 : .002));
    zoomAt(e.clientX, e.clientY, Math.min(1.5, Math.max(1 / 1.5, f)));
  }, { passive: false });
  svg.addEventListener('dblclick', function (e) { e.preventDefault(); zoomAt(e.clientX, e.clientY, 2); });
  svg.addEventListener('keydown', function (e) { var g = e.target.closest && e.target.closest('.lm-pin'); if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleVenue(g.dataset.venue, g); } });
  $('mapView').querySelector('.lm-zoom').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-z]'); if (!b) return;
    var r = svg.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (b.dataset.z === 'in') zoomAt(cx, cy, 1.6); else if (b.dataset.z === 'out') zoomAt(cx, cy, 1 / 1.6); else if (b.dataset.z === 'me') locate(b); else { closePop(); fit(); } // fit: the whole frame, out-of-town rooms included
  });

  // ---- the visitor's own spot (Steve, 2026-10-25: "find my location") ----
  // the browser's Geolocation API, on the visitor's say-so each time (its own permission prompt); nothing leaves the page
  function note(text, link, keep) { // a line under the frame, for a moment — with a link it stays until the next note
    var cap = $('lmCaption'); if (!cap) return;
    var n = cap.querySelector('.lm-note'); if (!n) { n = document.createElement('span'); n.className = 'lm-note'; cap.appendChild(n); }
    n.textContent = text; clearTimeout(note.t);
    if (link) { var a = document.createElement('a'); a.href = link.url; a.textContent = link.text; n.appendChild(a); }
    if (!keep) note.t = setTimeout(function () { n.textContent = ''; }, 6000);
  }
  // the nearest other city on here.events to a spot (great-circle, km) — for a visitor off this map's ground; a
  // neighbourhood site's own city (map.city) is not "another city", its rooms are on this map already
  function nearestCity(lat, lon, within) {
    var list = (window.LQACities && window.LQACities.cities) || [], own = CITY.key, cityKey = CITY.map && CITY.map.city && CITY.map.city.key, best = null;
    list.forEach(function (c) {
      if (!c.live || c.lat == null || c.key === own || c.key === cityKey || c.name !== c.city) return; // city-wide sites only: a neighbourhood's rooms are on its city's map
      var dLat = (c.lat - lat) * Math.PI / 180, dLon = (c.lon - lon) * Math.PI / 180, a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat * Math.PI / 180) * Math.cos(c.lat * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
      var km = 2 * 6371 * Math.asin(Math.sqrt(a));
      if (km <= within && (!best || km < best.km)) best = { city: c, km: km };
    });
    return best;
  }
  var PREVIEW = (new URLSearchParams(location.search).get('preview') || ''); // a local demo: ?preview=seattle:8120,everett:8088 sends a city's sign or jump to that preview port instead of its live host, and carries the list along (nothing of it in production links)
  var PREVIEW_PORT = {}; PREVIEW.split(',').forEach(function (kv) { var m = /^([\w-]+):(\d+)$/.exec(kv); if (m) PREVIEW_PORT[m[1]] = m[2]; });
  function cityLink(c) { return (PREVIEW_PORT[c.key] ? 'http://localhost:' + PREVIEW_PORT[c.key] + '/repo/site/' : c.url) + '?view=map&from=' + encodeURIComponent(CITY.key) + (PREVIEW ? '&preview=' + encodeURIComponent(PREVIEW) : ''); }
  var FROM = new URLSearchParams(location.search).get('from') || ''; // the city whose sign or location jump brought the visitor here: its sign is drawn however far it lies, so there is a way back (Steve, 2026-10-26)
  function nearbyCities(within) { // the other city-wide sites within `within` km of this ground's centre, nearest first
    var b = (CITY.map && CITY.map.home) || (CITY.map && CITY.map.bbox); if (!data || !b) return []; // [S, W, N, E] — miles are from the home box (downtown) when the city has one
    var lat = (b[0] + b[2]) / 2, lon = (b[1] + b[3]) / 2, list = (window.LQACities && window.LQACities.cities) || [], own = CITY.key, cityKey = CITY.map && CITY.map.city && CITY.map.city.key, out = [];
    list.forEach(function (c) {
      if (!c.live || c.lat == null || c.key === own || c.key === cityKey || c.name !== c.city) return;
      var dLat = (c.lat - lat) * Math.PI / 180, dLon = (c.lon - lon) * Math.PI / 180, a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat * Math.PI / 180) * Math.cos(c.lat * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
      var km = 2 * 6371 * Math.asin(Math.sqrt(a)); if (km <= within || c.key === FROM) out.push({ key: c.key, name: c.name, url: c.url, lat: c.lat, lon: c.lon, km: km });
    });
    return out.sort(function (p, q) { return p.km - q.km; });
  }
  function goTo(m) { // centre on the spot, in as far as a few blocks if the view is wider than that
    atHome = false; var w = Math.min(view.w, MIN_W() * 4); view = { x: m.x - w / 2, y: m.y - w * ar() / 2, w: w, h: w * ar() }; clamp(); closePop(); schedule();
  }
  function place(c, b) { // a fix in hand (the browser's, or the test harness's): on this ground → the dot; off it → the nearest city on here.events
    var p = px(c.latitude, c.longitude), m = { x: p[0], y: p[1], acc: (c.accuracy || 0) / 111320 * data.proj.s, at: Date.now() }; // metres → degrees of latitude → frame units
    var slack = FRAME.w * .02;
    if (p[0] < -slack || p[0] > FRAME.w + slack || p[1] < -slack || p[1] > FRAME.h + slack) { // off this ground: offer the nearest city instead (Steve, 2026-10-26: "take me to the everett page")
      me = null; schedule();
      var near = nearestCity(c.latitude, c.longitude, 80);
      if (near) { note('You are near ' + near.city.name + ' — opening its calendar…', null, true); location.assign(cityLink(near.city) + '&me=' + [c.latitude.toFixed(4), c.longitude.toFixed(4), Math.round(c.accuracy || 0)].join(',')); } // the fix rides along, so the next site marks the spot too ("the next site should still highlight your location") // "it should jump" (Steve, 2026-10-26)
      else note('You are outside this map');
      return;
    }
    me = m; goTo(m); if (b) b.setAttribute('aria-pressed', 'true');
  }
  function locate(b) {
    if (!navigator.geolocation) { note('This browser gives no location'); return; }
    if (me && Date.now() - me.at < 60000) { goTo(me); return; } // a fresh fix: just go there again
    if (b) b.classList.add('is-busy');
    navigator.geolocation.getCurrentPosition(function (pos) {
      if (b) b.classList.remove('is-busy');
      place(pos.coords, b);
    }, function (err) {
      if (b) b.classList.remove('is-busy');
      note(err && err.code === 1 ? 'Location permission was declined' : 'Your location could not be found');
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
  }

  // ---- the pin's card ----
  function closePop() {
    var old = document.querySelector('.lm-pop'); if (old) old.remove();
    openVenue = null; svg.querySelectorAll('.lm-pin.is-open').forEach(function (g) { g.classList.remove('is-open'); });
    document.removeEventListener('click', popOff, true); document.removeEventListener('keydown', popOff); window.removeEventListener('scroll', closePop);
  }
  function popOff(e) { if (e.type === 'keydown' ? e.key === 'Escape' : !e.target.closest('.lm-pop')) closePop(); }
  function cardDate(iso) { var m = /^(\d{4})-(\d\d)-(\d\d)/.exec(iso || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''; } // "Oct 29": the city's calendar day as written, no zone shift
  function toggleVenue(v, g) {
    if (openVenue === v) { closePop(); return; }
    H.closeDayPop(); closePop();
    openVenue = v; g.classList.add('is-open');
    var t = tally(), list = t.next[v] || [], room = VENUES[v] || (CITYMAP && CITYMAP.venues[v]) || {}; // a place has no row of its own, so no site link; a city room's site is in the city file
    var pop = document.createElement('div'); pop.className = 'mb-pop lm-pop'; pop.setAttribute('role', 'dialog'); pop.dataset.venue = v;
    var h = document.createElement('h3'); h.textContent = v;
    var n = document.createElement('span'); n.className = 'mb-pop-n'; n.textContent = list.length ? list.length + ' upcoming' : 'nothing upcoming'; h.appendChild(n);
    pop.setAttribute('aria-label', v); pop.appendChild(h);
    if (!list.length) { var none = document.createElement('p'); none.className = 'mb-none'; none.textContent = 'Nothing listed under these filters'; pop.appendChild(none); }
    list.slice(0, 6).forEach(function (e) {
      var tail = BY_PLACE && e.place ? ' — ' + e.place : '';
      var row = H.boardEntry(tail && e.title.slice(-tail.length) === tail ? Object.assign({}, e, { title: e.title.slice(0, -tail.length) }) : e, true);
      // the day at the row's right end, month and day only (Steve, 2026-10-26: "add dates here (just day/month, no year)") — the day card has its day for a heading, this card spans weeks
      var d = document.createElement('span'); d.className = 'lm-date'; d.textContent = cardDate(e.date); row.appendChild(d);
      pop.appendChild(row);
    }); // a place's card already names the place: the titles' "— Town, State" tail goes
    var cityRoom = !VENUES[v] && CITYMAP && CITYMAP.venues[v], count = cityRoom ? (t.n[v] || 0) : list.length;
    if (count > 6) { var more = document.createElement('p'); more.className = 'lm-more'; if (cityRoom) { more.textContent = '+ ' + (count - 6) + ' more on '; var ml = document.createElement('a'); ml.href = CITYMAP.url; ml.target = '_blank'; ml.rel = 'noopener'; ml.textContent = CITYMAP.url.replace(/^https?:\/\//, '').replace(/\/$/, ''); more.appendChild(ml); } else more.textContent = '+ ' + (count - 6) + ' more in the list'; pop.appendChild(more); }
    if (room.url) { var a = document.createElement('a'); a.className = 'lm-site'; a.href = room.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = (room.festival ? 'Festival site' : 'Venue site') + ' ↗'; pop.appendChild(a); }
    document.body.appendChild(pop);
    if (!window.matchMedia('(max-width: 640px)').matches) { // a phone takes the sheet from the foot (styles.css); here the card sits beside the pin
      var r = g.querySelector('circle').getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight, w = Math.min(22 * 16, vw - 16);
      pop.style.width = w + 'px';
      var left = r.right + 10; if (left + w > vw - 8) left = r.left - 10 - w; if (left < 8) left = Math.max(8, Math.min(r.left, vw - w - 8));
      var foot = document.querySelector('footer'), floor = foot ? Math.min(vh, foot.getBoundingClientRect().top) : vh;
      var hgt = pop.offsetHeight, top = r.top - 8; if (top + hgt > floor - 8) top = Math.max(8, floor - 8 - hgt);
      pop.style.left = left + 'px'; pop.style.top = top + 'px';
    }
    setTimeout(function () { document.addEventListener('click', popOff, true); document.addEventListener('keydown', popOff); window.addEventListener('scroll', closePop, { passive: true }); }, 0);
  }

  // ---- the view itself ----
  function open(on, remember) {
    if (on === isOpen()) { if (on) render(); return; }
    document.documentElement.classList.toggle('map-open', on);
    $('mapView').hidden = !on;
    var ag = document.querySelector('.agenda'); if (ag && $('teamsView').hidden) ag.hidden = on;
    closePop();
    if (remember) { try { localStorage.setItem('lqa-map', on ? '1' : '0'); if (on) localStorage.setItem('lqa-view', 'list'); } catch (e) { /* no storage */ } } // app.js restores List; this file then opens the map over it
    H.syncViewSwitch(); H.fitFilterBar();
    if (on) load().then(function () { size(); home(false); render(); }); // size first: home() reads the frame's shape
  }
  window.LQAMap = { open: open, isOpen: isOpen, render: schedule, locate: function (lat, lon, acc) { me = null; place({ latitude: lat, longitude: lon, accuracy: acc || 0 }); } }; // locate(): a spot given outright — the test harness's stand-in for the browser's fix, through the same path
  window.addEventListener('resize', function () { if (isOpen()) schedule(); });
  // at load: ?view=map, or the remembered choice — unless a ?team= link or a saved Month view got there first
  (function () {
    var q = new URLSearchParams(location.search), saved = null;
    try { saved = localStorage.getItem('lqa-map'); } catch (e) { /* unreadable storage */ }
    if (q.get('team') || document.documentElement.classList.contains('month-open')) { if (saved === '1') try { localStorage.setItem('lqa-map', '0'); } catch (e) { /* */ } return; }
    var carried = /^(-?[\d.]+),(-?[\d.]+)(?:,(\d+))?$/.exec(q.get('me') || ''); // a fix the last site passed on when it sent the visitor here
    if (q.get('view') === 'map' || (!q.get('view') && saved === '1')) {
      open(true, false);
      if (carried) load().then(function () { size(); place({ latitude: +carried[1], longitude: +carried[2], accuracy: +carried[3] || 0 }); });
    } else load(); // warm, so the first tap draws at once
  })();
})();
