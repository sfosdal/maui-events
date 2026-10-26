// Geometry for the Map view's build (scripts/build-local-map.mjs): the
// OpenStreetMap coastline — open ways with the land on their left — stitched
// into chains, cut at the frame's edge and closed along it into the sea; lakes
// and rivers from natural=water ways and multipolygon relations; roads cut to
// the frame; every line thinned with Douglas–Peucker. Pure functions, tested
// in local-map-geom.test.mjs. Points are [x, y] in frame units (y down).

// ways: [{ nodes: [id…], pts: [[x, y]…] }] → chains: [{ pts, closed }], ways
// joined end to start by their shared node ids (a loop is closed)
export function stitch(ways) {
  const byFirst = new Map(), hasPred = new Set();
  for (const w of ways) { if (w.nodes.length < 2) continue; (byFirst.get(w.nodes[0]) || byFirst.set(w.nodes[0], []).get(w.nodes[0])).push(w); hasPred.add(w.nodes[w.nodes.length - 1]); }
  const used = new Set(), chains = [];
  const follow = (start) => {
    const pts = start.pts.slice(); let cur = start; used.add(cur);
    for (;;) {
      const next = (byFirst.get(cur.nodes[cur.nodes.length - 1]) || []).find(w => !used.has(w));
      if (!next) break;
      used.add(next); pts.push(...next.pts.slice(1)); cur = next;
    }
    const closed = cur.nodes[cur.nodes.length - 1] === start.nodes[0];
    return { pts, closed };
  };
  for (const w of ways) if (!used.has(w) && w.nodes.length >= 2 && !hasPred.has(w.nodes[0])) chains.push(follow(w)); // open chains first, from their heads
  for (const w of ways) if (!used.has(w) && w.nodes.length >= 2) chains.push(follow(w)); // what is left loops
  return chains;
}

// Douglas–Peucker: the points of a polyline no closer than tol to the line between their neighbours
export function simplify(pts, tol) {
  if (pts.length <= 2 || !(tol > 0)) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]], t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop(); let far = -1, fd = t2;
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i]; let d;
      if (L === 0) d = (px - ax) ** 2 + (py - ay) ** 2;
      else { const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)); d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2; }
      if (d > fd) { fd = d; far = i; }
    }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// the frame's edge as one clockwise walk (screen sense): top left → right, right top → bottom, bottom right → left, left bottom → top
export function perimeter(r) { return 2 * (r.x1 - r.x0 + r.y1 - r.y0); }
export function boundaryT(p, r, eps = 1e-6) {
  const W = r.x1 - r.x0, H = r.y1 - r.y0, [x, y] = p;
  if (Math.abs(y - r.y0) < eps) return x - r.x0;
  if (Math.abs(x - r.x1) < eps) return W + (y - r.y0);
  if (Math.abs(y - r.y1) < eps) return W + H + (r.x1 - x);
  if (Math.abs(x - r.x0) < eps) return 2 * W + H + (r.y1 - y);
  return null; // not on the edge
}
export function cornersBetween(ta, tb, r) { // the corners passed walking clockwise from ta to tb (exclusive), in order
  const W = r.x1 - r.x0, H = r.y1 - r.y0, P = perimeter(r);
  const corners = [[W, [r.x1, r.y0]], [W + H, [r.x1, r.y1]], [2 * W + H, [r.x0, r.y1]], [P, [r.x0, r.y0]]];
  const span = ((tb - ta) % P + P) % P || P; // ta === tb: the whole way round
  return corners.map(([t, p]) => [((t - ta) % P + P) % P, p]).filter(([d]) => d > 1e-9 && d < span - 1e-9).sort((a, b) => a[0] - b[0]).map(([, p]) => p);
}

// Liang–Barsky: the part of segment a→b inside r, as [p, q], or null
function clipSeg(a, b, r) {
  let t0 = 0, t1 = 1; const dx = b[0] - a[0], dy = b[1] - a[1];
  for (const [p, q] of [[-dx, a[0] - r.x0], [dx, r.x1 - a[0]], [-dy, a[1] - r.y0], [dy, r.y1 - a[1]]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; } else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return [[a[0] + t0 * dx, a[1] + t0 * dy], [a[0] + t1 * dx, a[1] + t1 * dy], t0, t1];
}
const inside = (p, r) => p[0] >= r.x0 && p[0] <= r.x1 && p[1] >= r.y0 && p[1] <= r.y1;

// a polyline cut to the rectangle: pieces { pts, tIn, tOut } — tIn / tOut the
// edge position where the line came in / went out, null where it started or
// ended inside
export function clipPolyline(pts, r) {
  const pieces = []; let cur = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], c = clipSeg(a, b, r);
    if (!c) { if (cur) { cur.tOut = boundaryT(cur.pts[cur.pts.length - 1], r); pieces.push(cur); cur = null; } continue; }
    const [p, q, t0, t1] = c;
    if (!cur) cur = { pts: [p], tIn: t0 > 0 || !inside(a, r) ? boundaryT(p, r) : (i === 0 ? null : boundaryT(p, r)) };
    else if (t0 > 0) { cur.tOut = boundaryT(cur.pts[cur.pts.length - 1], r); pieces.push(cur); cur = { pts: [p], tIn: boundaryT(p, r) }; } // left and came back within one segment
    cur.pts.push(q);
    if (t1 < 1) { cur.tOut = boundaryT(q, r); pieces.push(cur); cur = null; }
  }
  if (cur) { cur.tOut = null; pieces.push(cur); }
  return pieces;
}

export function signedArea(ring) { let a = 0; for (let i = 0, n = ring.length; i < n; i++) { const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % n]; a += x1 * y2 - x2 * y1; } return a / 2; }

// coastline chains (land on the left, water on the right, as OSM draws them)
// → the sea as rings to fill with the even-odd rule: every piece inside the
// frame, closed along the frame's edge clockwise to the next piece that
// comes in; a loop wholly inside is a ring of its own (an island is a hole
// in the sea round it, a water loop a sea of its own)
export function seaRings(chains, r) {
  const P = perimeter(r), rings = [], pieces = [], notes = [];
  for (const ch of chains) {
    const pts = ch.closed && ch.pts.length > 2 && ch.pts[0] !== ch.pts[ch.pts.length - 1] ? ch.pts.concat([ch.pts[0]]) : ch.pts;
    const cut = clipPolyline(pts, r);
    for (const pc of cut) {
      if (pc.tIn == null && pc.tOut == null) { if (ch.closed) rings.push(pc.pts); else notes.push('an open coastline wholly inside the frame was dropped'); }
      else if (pc.tIn == null || pc.tOut == null) notes.push('a coastline ends inside the frame — dropped');
      else pieces.push(pc);
    }
  }
  const used = new Set();
  for (const s of pieces) {
    if (used.has(s)) continue;
    const ring = []; let cur = s;
    for (let guard = 0; guard <= pieces.length; guard++) {
      used.add(cur); ring.push(...cur.pts);
      let next = null, best = Infinity;
      for (const n of pieces) { if (used.has(n) && n !== s) continue; const d = ((n.tIn - cur.tOut) % P + P) % P; if (d < best) { best = d; next = n; } }
      if (!next) { notes.push('a sea ring could not be closed'); break; }
      ring.push(...cornersBetween(cur.tOut, next.tIn, r));
      if (next === s) break;
      cur = next;
    }
    rings.push(ring);
  }
  return { rings, notes };
}

// multipolygon members ({ role, nodes, pts }) → rings (outer and inner alike; even-odd fill tells them apart)
export function memberRings(members) {
  return stitch(members).filter(c => c.closed || (c.pts.length > 3 && c.pts[0][0] === c.pts[c.pts.length - 1][0] && c.pts[0][1] === c.pts[c.pts.length - 1][1])).map(c => c.pts);
}

export const fmt = v => (Math.round(v * 10) / 10).toString();
export function pathOf(ring, closed = true) { return ring.map((p, i) => (i ? 'L' : 'M') + fmt(p[0]) + ' ' + fmt(p[1])).join('') + (closed ? 'Z' : ''); }
