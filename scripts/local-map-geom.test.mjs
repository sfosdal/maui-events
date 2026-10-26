import test from 'node:test';
import assert from 'node:assert/strict';
import { stitch, simplify, boundaryT, cornersBetween, clipPolyline, seaRings, signedArea, memberRings } from './local-map-geom.mjs';

const R = { x0: 0, y0: 0, x1: 100, y1: 50 };

test('stitch joins ways end to start and tells a loop from an open chain', () => {
  const chains = stitch([
    { nodes: [1, 2], pts: [[0, 0], [1, 0]] }, { nodes: [2, 3], pts: [[1, 0], [2, 0]] }, // one open chain of two ways
    { nodes: [7, 8], pts: [[5, 5], [6, 5]] }, { nodes: [8, 9], pts: [[6, 5], [6, 6]] }, { nodes: [9, 7], pts: [[6, 6], [5, 5]] }, // a loop
  ]);
  assert.equal(chains.length, 2);
  assert.deepEqual(chains[0], { pts: [[0, 0], [1, 0], [2, 0]], closed: false });
  assert.equal(chains[1].closed, true); assert.equal(chains[1].pts.length, 4);
});

test('simplify keeps the corners and drops the points on the line', () => {
  assert.deepEqual(simplify([[0, 0], [1, 0.01], [2, 0], [2, 1], [2, 2]], 0.1), [[0, 0], [2, 0], [2, 2]]);
  assert.deepEqual(simplify([[0, 0], [1, 1]], 5), [[0, 0], [1, 1]]);
});

test('boundaryT walks the frame clockwise from the top-left corner', () => {
  assert.equal(boundaryT([30, 0], R), 30);
  assert.equal(boundaryT([100, 20], R), 120);
  assert.equal(boundaryT([40, 50], R), 210);
  assert.equal(boundaryT([0, 10], R), 290);
  assert.equal(boundaryT([50, 25], R), null);
});

test('cornersBetween lists the corners passed, in walking order, wrapping past the start', () => {
  assert.deepEqual(cornersBetween(30, 120, R), [[100, 0]]);
  assert.deepEqual(cornersBetween(210, 30, R), [[0, 50], [0, 0]]);
  assert.deepEqual(cornersBetween(120, 120, R), [[100, 50], [0, 50], [0, 0], [100, 0]]); // all the way round
});

test('clipPolyline cuts a line to the frame and notes where it crossed the edge', () => {
  const pcs = clipPolyline([[-10, 25], [50, 25], [50, 60]], R);
  assert.equal(pcs.length, 1);
  assert.deepEqual(pcs[0].pts, [[0, 25], [50, 25], [50, 50]]);
  assert.equal(pcs[0].tIn, boundaryT([0, 25], R)); assert.equal(pcs[0].tOut, boundaryT([50, 50], R));
  const twice = clipPolyline([[-10, 10], [110, 10], [110, 40], [-10, 40]], R); // in, out, in again
  assert.equal(twice.length, 2);
  const inner = clipPolyline([[10, 10], [20, 20]], R);
  assert.deepEqual(inner, [{ pts: [[10, 10], [20, 20]], tIn: null, tOut: null }]);
});

test('seaRings closes a coast that crosses the frame into the sea on its right-hand side', () => {
  // the coast runs south down the middle of the frame: land on its left (east), water on its right (west)
  const { rings, notes } = seaRings([{ pts: [[50, -10], [50, 60]], closed: false }], R);
  assert.deepEqual(notes, []);
  assert.equal(rings.length, 1);
  const a = signedArea(rings[0]);
  assert.ok(Math.abs(Math.abs(a) - 50 * 50) < 1e-6, 'half the frame is sea: ' + a);
  const xs = rings[0].map(p => p[0]);
  assert.equal(Math.min(...xs), 0); assert.equal(Math.max(...xs), 50); // the western half
});

test('seaRings keeps an island inside the sea as a ring of its own (a hole under even-odd)', () => {
  const coast = { pts: [[50, -10], [50, 60]], closed: false };
  const island = { pts: [[10, 10], [10, 20], [20, 20], [20, 10]], closed: true };
  const { rings } = seaRings([coast, island], R);
  assert.equal(rings.length, 2);
});

test('memberRings assembles a multipolygon relation from its member ways', () => {
  const rings = memberRings([
    { role: 'outer', nodes: [1, 2, 3], pts: [[0, 0], [10, 0], [10, 10]] }, { role: 'outer', nodes: [3, 4, 1], pts: [[10, 10], [0, 10], [0, 0]] },
    { role: 'inner', nodes: [5, 6, 7, 5], pts: [[2, 2], [4, 2], [4, 4], [2, 2]] },
  ]);
  assert.equal(rings.length, 2);
});
