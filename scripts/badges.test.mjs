import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, endEstimate, isDay, BADGE_FEEDS, TEAMS } from './badges.mjs';
const TP = globalThis.LQACity.key === 'twinpeaks' ? false : 'Twin Peaks data (here-core) — a real city keeps its own in scripts/city.test.mjs'; // the city-dependent cases below run on here-core's made-up town

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

test('team matchers hit real game titles, not concerts', { skip: TP }, () => {
  const match = (title) => TEAMS.filter((t) => t.re.test(title)).map((t) => t.slug);
  assert.deepEqual(match('Twin Peaks Steelheads vs. Spokane Chiefs'), ['steelheads']);
  assert.deepEqual(match('Twin Peaks Timbermen vs. Spokane Indians'), ['timbermen']);
  assert.deepEqual(match('Twin Peaks Loggers vs. Yakima Fir'), ['loggers']);
  assert.deepEqual(match('Twin Peaks Owls vs. Tacoma Defiance'), ['owls']);
  // a bare "owls" in a show title must not match
  assert.deepEqual(match('The Owls Are Not What They Seem'), []);
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
