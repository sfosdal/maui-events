// Writes site/local-map.json — the ground the Map view (site/local-map.js) is
// drawn on, from the `map` block in site/city.js — for every room there that
// carries geo: [lat, lon]. Two kinds of ground:
//
//   kind: 'island' — the island's outline (and faint neighbours) from Natural
//     Earth 1:10m admin-0 countries (public domain), picked by a seed point
//     inside each ring; the frame is the island with a margin. Kona.
//   kind: 'urban'  — a city or a neighbourhood: the shoreline, the named
//     lakes and rivers and the main roads inside `bbox` from OpenStreetMap
//     (© OpenStreetMap contributors, ODbL — the page credits them), read once
//     from the Overpass API; the frame is the bbox. lqa, Seattle.
//   kind: 'world'  — the countries from Natural Earth 1:50m, the great lakes
//     and, for the countries `states` names, their states and provinces as
//     faint lines, on a Miller cylindrical projection inside `bbox`
//     [south, west, north, east]; `home` is the box the view opens on. A site
//     whose events are spread over continents (curling.events, 2026-10-24),
//     whose pins are the places the events name (`pins: 'places'`) rather
//     than rooms — so a room with geo is not required here.
//
// Both read-throughs are cached in .cache/ (gitignored) and the output is
// committed: the Actions build never downloads anything. The labels (towns,
// waters, peaks) are the city's own, in the same block.
//
// Run: node scripts/build-local-map.mjs
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { stitch, simplify, clipPolyline, seaRings, signedArea, memberRings, pathOf, fmt } from './local-map-geom.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cache = path.join(root, '.cache');
const UA = 'here.events local-map build (one read at build time; the output is committed)';

globalThis.window = globalThis; createRequire(import.meta.url)(path.join(root, 'site', 'city.js'));
const CITY = globalThis.LQACity, M = CITY.map;
if (!M) { console.error('city.js has no map block — nothing to draw'); process.exit(1); }
const rooms = Object.keys(CITY.venues).filter(v => CITY.venues[v].geo);
if (!rooms.length && M.pins !== 'places') { console.error('no room in city.js carries geo: [lat, lon]'); process.exit(1); }

async function cached(name, fetcher) {
  await mkdir(cache, { recursive: true });
  const f = path.join(cache, name);
  try { await access(f); return JSON.parse(await readFile(f, 'utf8')); } catch { /* not cached */ }
  const data = await fetcher(); await writeFile(f, JSON.stringify(data)); return data;
}

const W = 1000;
let proj, ground;
const toLabel = px => (l) => ({ name: l.name, kind: l.kind || 'town', anchor: l.anchor || 'start', dy: l.dy, xy: px([l.lon, l.lat]).map(v => +fmt(v)) });
// a Natural Earth layer: the here.events map's copy when this Mac has it, else one download, cached
const SISTER_DIR = path.join(process.env.HOME || '', 'Desktop/projects/here-events/repo/.cache');
const naturalEarth = (NAME) => cached(NAME + '.geojson', async () => {
  try { return JSON.parse(await readFile(path.join(SISTER_DIR, NAME + '.geojson'), 'utf8')); } catch { /* no sister copy */ }
  const r = await fetch('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/' + NAME + '.geojson', { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`Natural Earth download failed: HTTP ${r.status}`);
  return r.json();
});

if (M.kind === 'island') {
  const g = await naturalEarth('ne_10m_admin_0_countries');
  const inside = (ring, x, y) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
  const polys = g.features.filter(f => !M.country || f.properties.ADM0_A3 === M.country).flatMap(f => f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates]);
  const ringAt = ([lat, lon]) => { const p = polys.find(p => inside(p[0], lon, lat)); if (!p) throw new Error(`no land at ${lat}, ${lon}`); return p[0]; };
  const land = M.land.map(ringAt), far = (M.far || []).map(s => { try { return ringAt(s); } catch { return null; } }).filter(Boolean);
  const PAD = M.pad ?? 0.06, all = land.flat();
  const lons = all.map(p => p[0]), lats = all.map(p => p[1]);
  const cx = (Math.min(...lons) + Math.max(...lons)) / 2, cy = (Math.min(...lats) + Math.max(...lats)) / 2, k = Math.cos(cy * Math.PI / 180);
  const spanX = (Math.max(...lons) - Math.min(...lons)) * k, spanY = Math.max(...lats) - Math.min(...lats);
  const s = W * (1 - 2 * PAD) / Math.max(spanX, spanY), H = Math.round(spanY * s + 2 * PAD * W);
  proj = { cx, cy, k, s, w: W, h: H };
  const px = ([lon, lat]) => [(lon - cx) * k * s + W / 2, (cy - lat) * s + H / 2];
  ground = { land: land.map(r => pathOf(r.map(px))), far: far.map(r => pathOf(r.map(px))), labels: (M.labels || []).map(toLabel(px)),
    credit: 'Map outline from Natural Earth, 1:10m, public domain.' };
  console.log(`island: ${land.length} land ring(s), ${far.length} neighbour(s)`);
} else if (M.kind === 'urban') {
  const [S, Wl, N, E] = M.bbox;
  const cx = (Wl + E) / 2, cy = (S + N) / 2, k = Math.cos(cy * Math.PI / 180);
  const s = W / ((E - Wl) * k), H = Math.round((N - S) * s);
  proj = { cx, cy, k, s, w: W, h: H };
  const px = ([lon, lat]) => [(lon - cx) * k * s + W / 2, (cy - lat) * s + H / 2];
  const rect = { x0: 0, y0: 0, x1: W, y1: H }, wide = { x0: -W * .2, y0: -H * .2, x1: W * 1.2, y1: H * 1.2 }; // roads and waters run a little past the frame, for the pan
  const roadsRe = '^(' + (M.roads || ['motorway', 'trunk', 'primary']).join('|') + ')$';
  const bbox = [S, Wl, N, E].join(',');
  const q = `[out:json][timeout:180];(way[natural=coastline](${bbox});way[natural=water][name](${bbox});relation[natural=water][name](${bbox});way[highway~"${roadsRe}"](${bbox}););out geom;`;
  const osm = await cached('osm-' + createHash('sha1').update(q).digest('hex').slice(0, 10) + '.json', async () => {
    console.log('reading OpenStreetMap through Overpass…');
    const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) });
    if (!r.ok) throw new Error(`Overpass failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  });
  const tol = M.tolerance ?? 0.6, minArea = M.minArea ?? 6;
  const wayOf = w => ({ nodes: w.nodes || w.geometry.map((g, i) => `${w.ref || w.id}:${i}`), pts: w.geometry.map(g => px([g.lon, g.lat])) });
  const els = osm.elements;
  const coast = stitch(els.filter(e => e.type === 'way' && e.tags?.natural === 'coastline').map(wayOf)).map(c => ({ ...c, pts: simplify(c.pts, tol) }));
  const sea = seaRings(coast, rect);
  sea.notes.forEach(n => console.log('coastline:', n));
  const waters = [];
  for (const e of els.filter(e => e.tags?.natural === 'water')) {
    if (e.type === 'way') { if (e.nodes[0] === e.nodes[e.nodes.length - 1]) waters.push(wayOf(e).pts); }
    else if (e.type === 'relation') memberRings(e.members.filter(m => m.type === 'way' && m.geometry).map(m => ({ role: m.role, nodes: m.geometry.map(g => g.lat + ',' + g.lon), pts: m.geometry.map(g => px([g.lon, g.lat])) }))).forEach(r => waters.push(r));
  }
  const waterRings = waters.map(r => simplify(r, tol)).filter(r => r.length > 3 && Math.abs(signedArea(r)) >= minArea && r.some(p => p[0] > wide.x0 && p[0] < wide.x1 && p[1] > wide.y0 && p[1] < wide.y1));
  const roads = {};
  for (const e of els.filter(e => e.type === 'way' && e.tags?.highway)) {
    const cls = e.tags.highway, pcs = clipPolyline(wayOf(e).pts, wide);
    for (const pc of pcs) { const pts = simplify(pc.pts, tol); if (pts.length > 1) (roads[cls] = roads[cls] || []).push(pathOf(pts, false)); }
  }
  let home = null;
  if (M.home) { const [hs, hw, hn, he] = M.home, a = px([hw, hn]), b = px([he, hs]); home = [a[0], a[1], b[0] - a[0], b[1] - a[1]].map(v => +fmt(v)); }
  ground = { sea: sea.rings.map(r => pathOf(r)), water: waterRings.map(r => pathOf(r)), roads: Object.fromEntries(Object.entries(roads).map(([c, d]) => [c, d.join('')])), labels: (M.labels || []).map(toLabel(px)), home,
    credit: 'Shoreline, waters and roads © OpenStreetMap contributors, ODbL.' };
  console.log(`urban: ${coast.length} coast chain(s) → ${sea.rings.length} sea ring(s), ${waterRings.length} waters, roads ${Object.entries(roads).map(([c, d]) => c + ' ' + d.length).join(', ')}`);
} else if (M.kind === 'world') {
  const [S, Wl, N, E] = M.bbox;
  const mil = lat => 1.25 * Math.asinh(Math.tan(.8 * lat * Math.PI / 180)) * 180 / Math.PI; // Miller cylindrical, in degree-sized units
  const cx = (Wl + E) / 2, s = W / (E - Wl), my0 = mil(N), H = Math.round((my0 - mil(S)) * s);
  proj = { kind: 'miller', cx, cy: (S + N) / 2, k: 1, s, w: W, h: H, my0 };
  const px = ([lon, lat]) => [(lon - cx) * s + W / 2, (my0 - mil(lat)) * s];
  const wide = { x0: -W * .2, y0: -H * .2, x1: W * 1.2, y1: H * 1.2 };
  const tol = M.tolerance ?? 0.5, minArea = M.minArea ?? 3;
  const inFrame = r => r.some(p => p[0] > wide.x0 && p[0] < wide.x1 && p[1] > wide.y0 && p[1] < wide.y1);
  const rings = f => (f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates]);
  // every polygon of a layer as one path (its holes too, drawn evenodd), simplified, the slivers and the far-off dropped
  const paths = (features) => features.flatMap(f => rings(f).map(poly => poly.map(r => simplify(r.map(px), tol)).filter((r, i) => r.length > 3 && (i === 0 ? inFrame(r) && Math.abs(signedArea(r)) >= minArea : Math.abs(signedArea(r)) >= minArea))).filter(poly => poly.length)).map(poly => poly.map(r => pathOf(r)).join(''));
  const countries = await naturalEarth('ne_50m_admin_0_countries');
  const land = paths(countries.features.filter(f => f.properties.ADM0_A3 !== 'ATA'));
  const lakes = await naturalEarth('ne_50m_lakes');
  const water = paths(lakes.features.filter(f => (f.properties.scalerank ?? 9) <= (M.lakes ?? 1)));
  let borders = '';
  if (M.states && M.states.length) {
    const adm1 = await naturalEarth('ne_50m_admin_1_states_provinces');
    borders = paths(adm1.features.filter(f => M.states.includes(f.properties.adm0_a3))).join('');
  }
  let home = null;
  if (M.home) { const [hs, hw, hn, he] = M.home, a = px([hw, hn]), b = px([he, hs]); home = [a[0], a[1], b[0] - a[0], b[1] - a[1]].map(v => +fmt(v)); }
  ground = { land, water, borders, labels: (M.labels || []).map(toLabel(px)), home, credit: 'Countries, lakes and state lines from Natural Earth, 1:50m, public domain.' };
  console.log(`world: ${land.length} land path(s), ${water.length} lake(s), state lines for ${(M.states || []).join(', ') || 'no one'}`);
} else throw new Error(`map.kind ${M.kind}: island, urban or world`);

const out = { kind: M.kind, proj, ...ground };
const outside = rooms.filter(v => { const [lat, lon] = CITY.venues[v].geo, x = (lon - proj.cx) * proj.k * proj.s + W / 2, y = proj.kind === 'miller' ? (proj.my0 - 1.25 * Math.asinh(Math.tan(.8 * lat * Math.PI / 180)) * 180 / Math.PI) * proj.s : (proj.cy - lat) * proj.s + proj.h / 2; return x < 0 || x > W || y < 0 || y > proj.h; });
if (outside.length) console.log(`off the frame: ${outside.join(', ')}`);
await writeFile(path.join(root, 'site', 'local-map.json'), JSON.stringify(out));
const size = Buffer.byteLength(JSON.stringify(out));
console.log(`local-map.json: frame ${W}×${proj.h}, ${M.pins === 'places' ? 'pins at the places the events name' : rooms.length + ' rooms placed'}, ${(size / 1024).toFixed(0)} KB`);
