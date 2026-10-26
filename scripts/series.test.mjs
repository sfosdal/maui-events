import test from 'node:test';
import assert from 'node:assert/strict';
import '../site/city.js'; // the city, then the rules — both attach to globalThis outside a browser
import '../site/filter.js';

const { findSeries, assignLanes } = globalThis.LQAFilter;
const LQA = globalThis.LQACity.key === 'lqa' ? false : 'Lower Queen Anne data — skipped for another city'; // the city-dependent cases below
const nights = (title, dates, venue = 'Seattle Center') => dates.map((date) => ({ venue, title, date, time: '19:30:00' }));
const day = (n) => { const d = new Date(2026, 8, 1 + n); return d.toISOString().slice(0, 10); };
const range = (n) => Array.from({ length: n }, (_, i) => i);

test('short daily runs keep their lane: a three-game homestand, a week of nights', () => {
  const evs = [...nights('Mariners vs. Rangers', range(3).map(day), 'T-Mobile Park'), ...nights('PAX West', range(7).map(day))];
  const s = findSeries(evs);
  assert.equal(s.length, 2);
  assert.deepEqual(s.map((x) => [x.events.length, x.lane]), [[3, true], [7, true]]);
});

test('a nightly run longer than a week gets no lane, dark Mondays or not', () => {
  const straight = nights('Winterfest', range(8).map(day));
  const darkMondays = nights('Eureka Day', range(35).filter((i) => new Date(2026, 8, 1 + i).getDay() !== 1).map(day));
  const s = findSeries([...straight, ...darkMondays]);
  assert.deepEqual(s.map((x) => [x.events[0].title, x.lane]), [['Winterfest', false], ['Eureka Day', false]]);
  assert.equal(darkMondays[3].series.total, darkMondays.length, 'the n of N label still counts the whole run');
});

test('a run with real gaps keeps its lane however long it is', () => {
  const everyOther = nights('Rep Night', range(11).map((i) => day(i * 2)));
  const s = findSeries(everyOther);
  assert.equal(s.length, 1);
  assert.equal(s[0].events.length, 11);
  assert.equal(s[0].lane, true);
});

test('lanes: first free lane, and past the cap the rest merge into the last lane', () => {
  const items = [{ from: 0, to: 4 }, { from: 1, to: 2 }, { from: 2, to: 6 }, { from: 5, to: 8 }, { from: 7, to: 9 }];
  const free = assignLanes(items.map((i) => ({ ...i })), 0);
  assert.equal(free.length, 3, 'uncapped: three concurrent at row 2');
  const its = items.map((i) => ({ ...i }));
  const capped = assignLanes(its, 2);
  assert.equal(capped.length, 2);
  assert.deepEqual(its.map((i) => [i.lane, !!i.merged]), [[0, false], [1, false], [1, true], [0, false], [1, false]]);
});

test('a festival\'s sets are not a series of their own: the day rows count, the sets carry no n of N', { skip: LQA }, () => {
  const days = range(3).map((i) => ({ venue: 'Capitol Hill Block Party', title: 'Headliners ' + i, date: day(i), time: '14:35' }));
  const sets = range(3).flatMap((i) => [{ venue: 'Capitol Hill Block Party', title: 'Act A', date: day(i), time: '15:15', stage: 'Main Stage', set: true }, { venue: 'Capitol Hill Block Party', title: 'Act B', date: day(i), time: '16:15', stage: 'Main Stage', set: true }]);
  const s = findSeries([...days, ...sets]);
  assert.equal(s.length, 1);
  assert.deepEqual(days.map((d) => d.series.total), [3, 3, 3]);
  assert.ok(sets.every((x) => !x.series));
});
