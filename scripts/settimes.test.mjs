import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { applySetTimes, setTimesText, shortClock, stagesFrom } from './settimes.mjs';

const table = {
  days: {
    '2026-08-07': {
      'Main Stage': [['15:15', '15:45', 'Avery Cochrane'], ['22:40', 'close', 'MUNA']],
      'Daydream Stage': [['14:35', '15:05', 'Girl Parallel']],
      'Neumos Stage': [],
    },
  },
};
const day = { venue: 'Capitol Hill Block Party', type: 'concert', title: 'MUNA, Avery Cochrane', date: '2026-08-07', time: '', lineup: ['MUNA', 'Avery Cochrane'] };

test('a festival day with set times gets the grid and the first start as its time; the title stays; then an event per set', () => {
  const [out, ...sets] = applySetTimes([day], table);
  assert.equal(out.title, 'MUNA, Avery Cochrane');
  assert.equal(out.time, '14:35');
  assert.deepEqual(out.lineup, ['MUNA', 'Avery Cochrane']); // the website's bill stays
  assert.deepEqual(out.sets, [
    { stage: 'Main Stage', acts: [{ act: 'Avery Cochrane', start: '15:15', end: '15:45' }, { act: 'MUNA', start: '22:40', end: 'close' }] },
    { stage: 'Daydream Stage', acts: [{ act: 'Girl Parallel', start: '14:35', end: '15:05' }] },
  ]); // an empty stage is dropped
  assert.deepEqual(sets, [ // in order of the day, the act as the title, its stage, its end unless the poster says close
    { venue: 'Capitol Hill Block Party', type: 'concert', date: '2026-08-07', title: 'Girl Parallel', time: '14:35', end: '15:05', stage: 'Daydream Stage', set: true },
    { venue: 'Capitol Hill Block Party', type: 'concert', date: '2026-08-07', title: 'Avery Cochrane', time: '15:15', end: '15:45', stage: 'Main Stage', set: true },
    { venue: 'Capitol Hill Block Party', type: 'concert', date: '2026-08-07', title: 'MUNA', time: '22:40', stage: 'Main Stage', set: true },
  ]);
});

test('a day the table does not know, and other venues, pass through untouched', () => {
  const other = { ...day, date: '2026-08-08' };
  const bar = { venue: 'The Traveling Goat', title: 'Trivia', date: '2026-08-07', time: '19:00' };
  assert.deepEqual(applySetTimes([other, bar], table), [other, bar]);
  assert.deepEqual(applySetTimes([day], {}), [day]);
});

test('the feed text lists each stage on its own line with short clocks', () => {
  const out = applySetTimes([day], table)[0];
  assert.equal(setTimesText(out.sets), 'Main Stage: 3:15 Avery Cochrane, 10:40 MUNA\nDaydream Stage: 2:35 Girl Parallel');
  assert.equal(shortClock('close'), 'close');
  assert.equal(shortClock('00:05'), '12:05');
});

test('the committed table is well formed: every row a start, an end and an act, starts in order per stage', { skip: !existsSync(new URL('./data/chbp-settimes.json', import.meta.url)) && 'no festival table in this city' }, () => {
  const real = JSON.parse(readFileSync(new URL('./data/chbp-settimes.json', import.meta.url), 'utf8'));
  const dates = Object.keys(real.days);
  assert.ok(dates.length >= 1);
  for (const d of dates) {
    assert.match(d, /^\d{4}-\d\d-\d\d$/);
    for (const s of stagesFrom(real.days[d])) {
      let prev = '';
      for (const a of s.acts) {
        assert.match(a.start, /^\d\d:\d\d$/, `${d} ${s.stage} ${a.act}`);
        assert.ok(/^\d\d:\d\d$/.test(a.end) || a.end === 'close', `${d} ${s.stage} ${a.act} end`);
        assert.ok(a.act.length > 1);
        assert.ok(a.start >= prev, `${d} ${s.stage}: ${a.act} out of order`);
        prev = a.start;
      }
    }
  }
});
