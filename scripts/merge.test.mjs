import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeWithArchive, unionArchives, eventKey } from './merge.mjs';

const TODAY = '2026-08-24';
const CUTOFF = '2025-08-24';
const ev = (date, title, extra) => ({ venue: 'V', title, date, time: '19:00:00', url: 'u', ...extra });

test('archived past events are kept alongside fresh ones', () => {
  const fresh = [ev('2026-08-25', 'Tomorrow Show')];
  const archived = [ev('2026-08-20', 'Last Week Show')];
  const out = mergeWithArchive(fresh, archived, TODAY, CUTOFF);
  assert.deepEqual(out.map((e) => e.title), ['Last Week Show', 'Tomorrow Show']);
});

test('archived FUTURE events not in fresh are dropped (cancellations)', () => {
  const fresh = [ev('2026-08-25', 'Still On')];
  const archived = [ev('2026-08-26', 'Cancelled Show'), ev('2026-08-25', 'Still On')];
  const out = mergeWithArchive(fresh, archived, TODAY, CUTOFF);
  assert.deepEqual(out.map((e) => e.title), ['Still On']);
});

test('a status seen for the first time is stamped now; a repeat keeps the first stamp', () => {
  const fresh = [ev('2026-08-26', 'Off Show', { status: 'cancelled' }), ev('2026-08-27', 'On Show')];
  const first = mergeWithArchive(fresh, [], TODAY, CUTOFF, '2026-08-24T10:00:00.000Z');
  assert.equal(first[0].statusSince, '2026-08-24T10:00:00.000Z');
  assert.equal(first[1].statusSince, undefined);
  const second = mergeWithArchive(fresh, first, TODAY, CUTOFF, '2026-08-24T16:00:00.000Z');
  assert.equal(second[0].statusSince, '2026-08-24T10:00:00.000Z', 'first detection survives later runs');
  // a different status (postponed → cancelled) is a new detection
  const changed = mergeWithArchive([ev('2026-08-26', 'Off Show', { status: 'postponed' })], first, TODAY, CUTOFF, '2026-08-25T00:00:00.000Z');
  assert.equal(changed[0].statusSince, '2026-08-25T00:00:00.000Z');
});

test('a known-cancelled future show stays, marked, after the source drops it; a plain one is dropped', () => {
  const archived = [
    ev('2026-08-26', 'Off Show', { status: 'cancelled', statusSince: '2026-08-20T00:00:00.000Z' }),
    ev('2026-08-26', 'Vanished Show'),
  ];
  const out = mergeWithArchive([], archived, TODAY, CUTOFF);
  assert.deepEqual(out.map((e) => e.title), ['Off Show']);
  assert.equal(out[0].statusSince, '2026-08-20T00:00:00.000Z');
});

test('past events older than the cutoff age out', () => {
  const archived = [ev('2025-08-23', 'Ancient'), ev('2025-08-24', 'Exactly A Year')];
  const out = mergeWithArchive([], archived, TODAY, CUTOFF);
  assert.deepEqual(out.map((e) => e.title), ['Exactly A Year']);
});

test('fresh data wins when a past event is still listed by a source', () => {
  const fresh = [ev('2026-08-20', 'Last Week Show', { url: 'fresh-url' })];
  const archived = [ev('2026-08-20', 'Last Week Show', { url: 'stale-url' })];
  const out = mergeWithArchive(fresh, archived, TODAY, CUTOFF);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'fresh-url');
});

test('two showings of one show on one day are two events: the key carries the clock', () => {
  const six = { ...ev('2026-08-25', 'Show'), time: '18:30' }, nine = { ...ev('2026-08-25', 'Show'), time: '21:00:00' };
  assert.notEqual(eventKey(six), eventKey(nine));
  assert.equal(eventKey(six), eventKey({ ...six, time: '18:30:00' })); // with or without seconds, the same key
  const out = mergeWithArchive([six, nine], [], TODAY, CUTOFF);
  assert.deepEqual(out.map((e) => e.time), ['18:30', '21:00:00']);
  assert.equal(unionArchives([six], [nine]).length, 2);
});

test('result is sorted by date then time', () => {
  const fresh = [ev('2026-08-25', 'B'), { ...ev('2026-08-25', 'A'), time: '10:00:00' }];
  const archived = [ev('2026-08-01', 'Old')];
  const out = mergeWithArchive(fresh, archived, TODAY, CUTOFF);
  assert.deepEqual(out.map((e) => e.title), ['Old', 'A', 'B']);
});

test('unionArchives keeps every event from both copies, the first copy winning a collision', () => {
  const live = [ev('2026-08-20', 'Shared', { url: 'live-url' }), ev('2026-08-21', 'Live Only')];
  const branch = [ev('2026-08-20', 'Shared', { url: 'branch-url' }), ev('2025-01-05', 'Branch Only')];
  const out = unionArchives(live, branch);
  assert.deepEqual(out.map((e) => e.title), ['Branch Only', 'Shared', 'Live Only']);
  assert.equal(out[1].url, 'live-url');
});

test('unionArchives with one empty copy is the other copy (a wiped feed cannot shrink the record)', () => {
  const branch = [ev('2025-01-05', 'Old'), ev('2026-08-20', 'Recent')];
  assert.equal(unionArchives([], branch).length, 2);
  assert.equal(unionArchives(branch, []).length, 2);
});
