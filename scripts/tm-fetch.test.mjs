import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTmFetch, tmFailed, keepFailedVenues } from './tm-fetch.mjs';

const reply = (status, headers = {}) => ({ status, ok: status < 400, headers: { get: (k) => headers[k.toLowerCase()] ?? null } });

test('tmFetch: calls go out one at a time, at least the gap apart', async () => {
  const times = [];
  const tm = makeTmFetch(async () => { times.push(Date.now()); return reply(200); }, { gap: 30 });
  await Promise.all([tm('a'), tm('b'), tm('c')]);
  assert.equal(times.length, 3);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 25, `gap ${times[i] - times[i - 1]} ms`);
});

test('tmFetch: a 429 is retried after Retry-After and the eventual answer returned', async () => {
  let n = 0;
  const logs = [];
  const tm = makeTmFetch(async () => (++n < 3 ? reply(429, { 'retry-after': '0.01' }) : reply(200)), { gap: 1, log: (m) => logs.push(m) });
  const res = await tm('x');
  assert.equal(res.status, 200);
  assert.equal(n, 3);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /retrying in 0.01 s \(1\/5\)/);
});

test('tmFetch: gives up after the retries and hands back the 429', async () => {
  let n = 0;
  const tm = makeTmFetch(async () => { n++; return reply(429, { 'retry-after': '0.001' }); }, { gap: 1, tries: 2, log: () => {} });
  const res = await tm('x');
  assert.equal(res.status, 429);
  assert.equal(n, 3);
});

test('tmFetch: a dropped connection is retried, and the queue keeps moving', async () => {
  let n = 0;
  const tm = makeTmFetch(async () => { if (++n === 1) throw new Error('fetch failed'); return reply(200); }, { gap: 1, log: () => {} });
  assert.equal((await tm('a')).status, 200);
  assert.equal(n, 2);
  assert.equal((await tm('b')).status, 200);
});

test('tmFetch: a 5xx is retried; a 4xx other than 429 is not', async () => {
  let n = 0;
  const tm = makeTmFetch(async () => (++n === 1 ? reply(503) : reply(200)), { gap: 1, log: () => {} });
  assert.equal((await tm('a')).status, 200);
  let m = 0;
  const tm2 = makeTmFetch(async () => { m++; return reply(401); }, { gap: 1, log: () => {} });
  assert.equal((await tm2('a')).status, 401);
  assert.equal(m, 1);
});

test('tmFetch: a connection that never comes back is a failed response, not a throw', async () => {
  const tm = makeTmFetch(async () => { throw new Error('fetch failed'); }, { gap: 1, tries: 1, log: () => {} });
  const res = await tm('a');
  assert.equal(res.ok, false);
  assert.equal(res.status, 0);
  assert.match(tmFailed('Moore Theatre', res).message, /Moore Theatre failed after retries \(fetch failed\)/);
});

test('keepFailedVenues: a failed venue keeps its upcoming rows, not its past ones or what the build already has', () => {
  const failed = new Set(['Moore Theatre']);
  const archived = [
    { venue: 'Moore Theatre', title: 'Old', date: '2026-10-01', time: '19:30' },
    { venue: 'Moore Theatre', title: 'Show A', date: '2026-11-01', time: '19:30' },
    { venue: 'Moore Theatre', title: 'Show B', date: '2026-11-02', time: '20:00' },
    { venue: 'Neptune Theatre', title: 'Other', date: '2026-11-01', time: '20:00' },
  ];
  const fresh = [{ venue: 'Moore Theatre', title: 'Show B (own site)', date: '2026-11-02', time: '20:00:00' }];
  const logs = [];
  const kept = keepFailedVenues(archived, fresh, '2026-10-28', failed, (m) => logs.push(m));
  assert.deepEqual(kept.map((e) => e.title), ['Show A']);
  assert.match(logs[0], /Moore Theatre: failed — kept 1 upcoming rows/);
  assert.deepEqual(keepFailedVenues(archived, fresh, '2026-10-28', new Set()), []);
  keepFailedVenues(archived, fresh, '2026-10-28', failed, (m) => logs.push(m), 'Own calendar');
  assert.match(logs.at(-1), /^Own calendar Moore Theatre: failed — kept 1 upcoming rows/);
});
