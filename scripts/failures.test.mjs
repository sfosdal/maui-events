import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCallLog, QUIET } from './failures.mjs';
import { plan, keysIn, TITLE } from './failure-issue.mjs';

const answers = (...seq) => { let n = 0; const calls = []; const f = async (url, init) => { calls.push(url); const a = seq[Math.min(n++, seq.length - 1)]; if (a instanceof Error) throw a; return { ok: a < 400, status: a }; }; f.calls = calls; return f; };
const log = (f) => makeCallLog({ fetchImpl: f, sleep: async () => {}, waits: [1, 1] });

test('a call that fails, then answers on the retry, is not reported', async () => {
  const f = answers(503, 200), l = log(f);
  const r = await l.fetch('https://example.org/events?key=SECRET');
  assert.equal(r.status, 200); assert.equal(f.calls.length, 2); assert.deepEqual(l.list(), []);
});

test('a call still failing after its retries is reported once per URL and status, without the query', async () => {
  const f = answers(503), l = log(f);
  const r = await l.fetch('https://example.org/events?key=SECRET');
  assert.equal(r.status, 503); assert.equal(f.calls.length, 3, 'three tries for a 5xx');
  await l.fetch('https://example.org/events?page=2');
  assert.deepEqual(l.list().map((x) => [x.key, x.count]), [['https://example.org/events HTTP 503', 2]]);
  assert.ok(!JSON.stringify(l.list()).includes('SECRET'));
});

test('a refusal (403/406) is asked once more, then reported; a 404 is not retried', async () => {
  const f = answers(406), l = log(f);
  await l.fetch('https://www.foxtheatre.org/events/rss');
  assert.equal(f.calls.length, 2);
  const g = answers(404), m = log(g);
  await m.fetch('https://example.org/gone');
  assert.equal(g.calls.length, 1); assert.deepEqual(m.list().map((x) => x.key), ['https://example.org/gone HTTP 404']);
});

test('a network error is retried, and reported (and rethrown) when it never clears; the caller\'s own abort is not retried', async () => {
  const f = answers(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })), l = log(f);
  await assert.rejects(l.fetch('https://example.org/x'), /fetch failed/);
  assert.equal(f.calls.length, 3); assert.equal(l.list()[0].error, 'ECONNRESET');
  const ctl = new AbortController(); ctl.abort();
  const g = answers(new DOMException('aborted', 'AbortError')), m = log(g);
  await assert.rejects(m.fetch('https://example.org/slow', { signal: ctl.signal }));
  assert.equal(g.calls.length, 1, 'no retry after the caller gave up');
});

test('not failures: Ticketmaster (tm-fetch.mjs owns it), HEAD probes, quiet calls, ESPN leaders, a missing Wikipedia page', async () => {
  const tm = answers(429), l = log(tm);
  await l.fetch('https://app.ticketmaster.com/discovery/v2/events.json');
  assert.equal(tm.calls.length, 1, 'passed straight through, no retry');
  const f = answers(404), m = log(f);
  await m.fetch('https://a.espncdn.com/crest.png', { method: 'HEAD' });
  await m.fetch('https://tickets.example.org/old', { [QUIET]: true });
  await m.fetch('https://sports.core.api.espn.com/v2/sports/hockey/leagues/x/seasons/2027/types/2/teams/1/leaders');
  await m.fetch('https://en.wikipedia.org/api/rest_v1/page/summary/Nowhere');
  assert.deepEqual(l.list(), []); assert.deepEqual(m.list(), []);
});

test('a "Source failed" with no HTTP status of its own is written down with the last call before it; one with a status is the call\'s', async () => {
  const l = log(answers(200));
  await l.fetch('https://www.example.org/api/events.json');
  l.noteSourceFailed('Unexpected token \'<\', "<html><hea"... is not valid JSON');
  l.noteSourceFailed('HTTP 406 https://www.example.org/x');
  assert.equal(l.list().length, 1); assert.equal(l.list()[0].after, 'https://www.example.org/api/events.json');
  l.recordFailure('Ticketmaster Moda Center', 'HTTP 503');
  assert.equal(l.list()[1].key, 'Ticketmaster Moda Center HTTP 503');
});

test('the issue: opened only when something fails; a comment (a mail) only for new failures; refreshed silently otherwise', () => {
  const a = { key: 'https://a.org/x HTTP 406', count: 1 }, b = { key: 'https://b.org/y HTTP 503', count: 2 };
  assert.deepEqual(plan([], null), {}, 'nothing failing, nothing open: nothing');
  const o = plan([a], null, { at: 't1' }).open;
  assert.equal(o.title, TITLE); assert.deepEqual(o.assignees, ['sfosdal']); assert.deepEqual(keysIn(o.body), [a.key]);
  const issue = { number: 7, body: o.body };
  const same = plan([a], issue, { at: 't2' });
  assert.ok(same.edit && !same.comment, 'the same failure again: no mail');
  const more = plan([a, b], issue, { at: 't3' });
  assert.match(more.comment, /b\.org\/y HTTP 503/); assert.doesNotMatch(more.comment, /a\.org/);
  const clear = plan([], { number: 7, body: more.edit }, { at: 't4' });
  assert.ok(!clear.comment && !clear.close); assert.deepEqual(keysIn(clear.edit), []); assert.match(clear.edit, /Nothing failing/);
  assert.ok(plan([a], { number: 7, body: clear.edit }).comment, 'failing again after a clear build is new again');
});

test('failedHost: a host is failed only when a call to it is still failing after its retries', async () => {
  const l = log(answers(503, 200)); await l.fetch('https://ok.example.org/x');
  const m = log(answers(406)); await m.fetch('https://www.aso.org/events/rss'); m.recordFailure('https://chrome.example.org/p (Chrome-fingerprint fetch)', 'HTTP 403');
  assert.equal(l.failedHost('ok.example.org'), false);
  assert.equal(m.failedHost('www.aso.org'), true); assert.equal(m.failedHost('chrome.example.org'), true); assert.equal(m.failedHost('aso.org'), false);
});

test('a "Source failed" line whose call is already written down is not written twice', async () => {
  const l = log(answers(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })));
  await l.fetch('https://www.centerstage-atlanta.com/wp-json/x/').catch(() => {});
  l.noteSourceFailed('The operation was aborted due to timeout');
  l.recordFailure('Ticketmaster State Farm Arena', 'fetch failed'); l.noteSourceFailed('Ticketmaster State Farm Arena failed after retries (fetch failed)');
  assert.deepEqual(l.list().map((f) => f.key), ['https://www.centerstage-atlanta.com/wp-json/x/ TimeoutError', 'Ticketmaster State Farm Arena fetch failed']);
});
