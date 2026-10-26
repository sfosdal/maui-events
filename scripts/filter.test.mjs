import test from 'node:test';
import assert from 'node:assert/strict';
import '../site/city.js'; // the city, then the rules — both attach to globalThis outside a browser
import '../site/filter.js';

const F = globalThis.LQAFilter;
const LQA = globalThis.LQACity.key === 'lqa' ? false : 'Lower Queen Anne data — skipped for another city'; // the city-dependent cases below
const party = { venue: 'Capitol Hill Block Party', type: 'concert', title: 'MUNA, Magdalena Bay', date: '2026-08-07' };
const kexp = { venue: 'KEXP', type: 'concert', title: 'Live on KEXP', date: '2026-10-10' };
const game = { venue: 'T-Mobile Park', type: 'sports', title: 'Mariners vs Astros', date: '2026-04-10' };
const film = { venue: 'SIFF Cinema Uptown', type: 'movie', title: 'A film', date: '2026-10-10' };

test('the row that names the thing wins: a venue on Show shows its events whatever the event type says', () => {
  const m = { venueMode: { 'Capitol Hill Block Party': 'in' }, badgeMode: { concert: 'ex', sports: 'ex', movie: 'ex' } };
  assert.equal(F.matchesFilter(party, m), true);
  assert.equal(F.matchesFilter(kexp, m), false); // a Show narrows to the Shown
  assert.equal(F.matchesFilter(game, m), false);
});

test('a venue on Hide hides its events whatever is Shown among the types', () => {
  assert.equal(F.matchesFilter(kexp, { venueMode: { KEXP: 'ex' }, badgeMode: { concert: 'in' } }), false);
  assert.equal(F.matchesFilter(party, { venueMode: { KEXP: 'ex' }, badgeMode: { concert: 'in' } }), true);
});

test('a team row names the game exactly, so it beats its venue either way', { skip: LQA }, () => {
  assert.equal(F.matchesFilter(game, { teamMode: { mariners: 'in' }, venueMode: { 'T-Mobile Park': 'ex' } }), true);
  assert.equal(F.matchesFilter(game, { teamMode: { mariners: 'ex' }, venueMode: { 'T-Mobile Park': 'in' } }), false);
});

test('the general rows decide only the events no specific row spoke for', () => {
  const def = { badgeMode: { movie: 'ex' } }; // the usual view
  assert.equal(F.matchesFilter(film, def), false);
  assert.equal(F.matchesFilter(kexp, def), true);
  assert.equal(F.matchesFilter(film, { venueMode: { 'SIFF Cinema Uptown': 'in' }, badgeMode: { movie: 'ex' } }), true); // the cinema on Show brings its films
  const sports = { badgeMode: { sports: 'in' } };
  assert.equal(F.matchesFilter(game, sports), true);
  assert.equal(F.matchesFilter(kexp, sports), false); // a type on Show narrows the undecided to that kind
  assert.equal(F.matchesFilter(kexp, { badgeMode: { sports: 'in' }, venueMode: { KEXP: 'in' } }), true); // but not the Shown venue's
});

test('nothing on Show anywhere: everything but the Hides; the Only Sold switch applies throughout', () => {
  assert.equal(F.matchesFilter(party, {}), true);
  assert.equal(F.matchesFilter(party, { soldOnly: true, venueMode: { 'Capitol Hill Block Party': 'in' } }), false);
});

test('share codes: nine digits since the music rooms around town (2026-10-05); the new venues round-trip and an old eight-digit code still parses', { skip: LQA }, () => {
  const m = { venueMode: { 'The Crocodile': 'ex', 'Paramount Theatre': 'in', 'Showbox SoDo': 'in' }, badgeMode: {}, teamMode: {}, capMode: {} };
  const code = F.encodeFilterCode(m);
  assert.equal(code.split('.')[0].length, 9);
  assert.deepEqual(F.parseFilterCode(code).venueMode, m.venueMode);
  assert.equal(F.parseFilterCode('00000001').venueMode['Climate Pledge Arena'], 'ex'); // bit 0, as every code since the first
});
