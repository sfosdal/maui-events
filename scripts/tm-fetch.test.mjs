import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTmFetch } from './tm-fetch.mjs';

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

test('tmFetch: a failed call does not jam the queue', async () => {
  let n = 0;
  const tm = makeTmFetch(async () => { if (++n === 1) throw new Error('boom'); return reply(200); }, { gap: 1 });
  await assert.rejects(tm('a'), /boom/);
  assert.equal((await tm('b')).status, 200);
});
