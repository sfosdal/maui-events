import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, endEstimate, isDay, BADGE_FEEDS, TEAMS } from './badges.mjs';
const LQA = globalThis.LQACity.key === 'lqa' ? false : 'Lower Queen Anne data — skipped for another city'; // the city-dependent cases below

test('slugify matches the browser-side rule', () => {
  assert.equal(slugify('The Vera Project'), 'the-vera-project');
  assert.equal(slugify('Bagley Wright Theatre Poncho Forum'), 'bagley-wright-theatre-poncho-forum');
  assert.equal(slugify('Grounds / Public Space'), 'grounds-public-space');
});

test('endEstimate prefers a real end, else start+3h, else empty', () => {
  assert.equal(endEstimate({ time: '13:00:00', end: '15:30:00' }), '15:30:00');
  assert.equal(endEstimate({ time: '13:00:00' }), '16:00:00');
  assert.equal(endEstimate({ time: '22:00:00' }), '');   // estimate would cross midnight
  assert.equal(endEstimate({ time: '' }), '');            // all-day: unknown
});

test('isDay means done by 4pm', () => {
  assert.equal(isDay({ time: '12:00:00' }), true);          // est. end 15:00
  assert.equal(isDay({ time: '14:00:00', end: '15:00:00' }), true);
  assert.equal(isDay({ time: '14:00:00' }), false);         // est. end 17:00
  assert.equal(isDay({ time: '' }), false);                 // all-day: unknown
});

test('team matchers hit real game titles, not concerts', { skip: LQA }, () => {
  const match = (title) => TEAMS.filter((t) => t.re.test(title)).map((t) => t.slug);
  assert.deepEqual(match('Seattle Kraken vs. Vancouver Canucks'), ['kraken']);
  assert.deepEqual(match('Seattle Mariners vs. Houston Astros'), ['mariners']);
  assert.deepEqual(match('Seattle Storm vs. Las Vegas Aces'), ['storm']);
  assert.deepEqual(match('Seattle Reign FC vs. Portland Thorns'), ['reign']);
  assert.deepEqual(match('Seattle Sounders FC vs. LAFC'), ['sounders']);
  assert.deepEqual(match('Seattle Seahawks vs. San Francisco 49ers'), ['seahawks']);
  // bare "storm"/"reign" in a show title must not match
  assert.deepEqual(match('Storm Large: Holiday Ordeal'), []);
  assert.deepEqual(match('Purple Reign — The Prince Tribute Show'), []);
});

test('badge predicates', () => {
  assert.equal(BADGE_FEEDS['21plus'][1]({ age21: true }), true);
  assert.equal(BADGE_FEEDS['soldout'][1]({}), false);
  assert.equal(BADGE_FEEDS['free'][1]({ free: true }), true);
  assert.equal(BADGE_FEEDS['day'][1]({ time: '11:00:00' }), true);   // ends 14:00
  assert.equal(BADGE_FEEDS['day'][1]({ time: '19:00:00' }), false);  // ends 22:00
  assert.equal(BADGE_FEEDS['movie'][1]({ movie: true }), true);
  assert.equal(BADGE_FEEDS['movie'][1]({}), false);
  assert.equal(BADGE_FEEDS['siffevent'][1]({ venue: 'SIFF Cinema Uptown' }), true);
  assert.equal(BADGE_FEEDS['siffevent'][1]({ venue: 'SIFF Cinema Uptown', movie: true }), false);
  assert.equal(BADGE_FEEDS['siffevent'][1]({ venue: 'McCaw Hall' }), false);
});
