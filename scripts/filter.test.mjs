import test from 'node:test';
import assert from 'node:assert/strict';
import '../site/city.js'; // the city, then the rules — both attach to globalThis outside a browser
import '../site/filter.js';

const F = globalThis.LQAFilter;
const TP = globalThis.LQACity.key === 'twinpeaks' ? false : 'Twin Peaks data (here-core) — a real city keeps its own in scripts/city.test.mjs'; // the city-dependent cases below run on here-core's made-up town
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

const tpGame = { venue: 'Packard Field', type: 'sports', title: 'Twin Peaks Timbermen vs. Spokane Indians', date: '2026-04-10' };
test('a team row names the game exactly, so it beats its venue either way', { skip: TP }, () => {
  assert.equal(F.matchesFilter(tpGame, { teamMode: { timbermen: 'in' }, venueMode: { 'Packard Field': 'ex' } }), true);
  assert.equal(F.matchesFilter(tpGame, { teamMode: { timbermen: 'ex' }, venueMode: { 'Packard Field': 'in' } }), false);
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

test('share codes: the city\'s length, a round trip, and bit 0 is the first registry entry in every code', { skip: TP }, () => {
  const m = { venueMode: { 'Miss Twin Peaks': 'ex', 'Roadhouse': 'in', 'Expo Barn': 'in' }, badgeMode: {}, teamMode: {}, capMode: {} };
  const code = F.encodeFilterCode(m);
  assert.equal(code.split('.')[0].length, 6);
  assert.deepEqual(F.parseFilterCode(code).venueMode, m.venueMode);
  assert.equal(F.parseFilterCode('000001').venueMode['Timber Arena'], 'ex');
  assert.equal(F.parseFilterCode('00001').venueMode['Timber Arena'], 'ex'); // a code from before the registry grew a digit still parses
});

// A 94-entry registry like Seattle's (2026-10-31): filter.js run again in
// its own context over a stand-in city, so the test holds whatever city
// this copy belongs to.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const FILTER_SRC = readFileSync(new URL('../site/filter.js', import.meta.url), 'utf8');
function filterFor(registry, codeLength, noBigInt) {
  const city = { ...globalThis.LQACity, registry, codeLength };
  const ctx = vm.createContext({ LQACity: city, ...(noBigInt ? { BigInt: undefined } : {}) });
  vm.runInContext(FILTER_SRC, ctx);
  return ctx.LQAFilter;
}
const BIG_REG = Array.from({ length: 94 }, (_, i) => ['venue', 'Venue ' + i]);

test('share codes past 53 entries keep every bit: a link hiding all 94 venues, or every other one, comes back whole', () => {
  const F94 = filterFor(BIG_REG, 19);
  const all = { venueMode: Object.fromEntries(BIG_REG.map(([, v]) => [v, 'ex'])) };
  const code = F94.encodeFilterCode(all);
  assert.equal(code, '_' + (2n ** 94n - 1n).toString(36).toUpperCase().padStart(19, '0')); // past 2^53: the exact form
  assert.equal(Object.keys(F94.parseFilterCode(code).venueMode).length, 94);
  const mixed = { venueMode: Object.fromEntries(BIG_REG.map(([, v], i) => [v, i % 2 ? 'in' : 'ex'])) };
  assert.deepEqual({ ...F94.parseFilterCode(F94.encodeFilterCode(mixed)).venueMode }, mixed.venueMode);
  const low = { venueMode: { 'Venue 0': 'ex', 'Venue 93': 'ex' } }; // bit 0 is the one the floats lost
  assert.deepEqual({ ...F94.parseFilterCode(F94.encodeFilterCode(low)).venueMode }, low.venueMode);
});

test('share codes: every code the float version wrote still parses to the same entries', () => {
  const F94 = filterFor(BIG_REG, 19);
  const floatEncode = (bits) => { let m = 0; for (const i of bits) m += Math.pow(2, i); return m.toString(36).toUpperCase(); };
  const floatParse = (code) => { const m = parseInt(code, 36); return BIG_REG.map((_, i) => Math.floor(m / Math.pow(2, i)) % 2 === 1); };
  let seed = 7; const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let t = 0; t < 200; t++) {
    const bits = BIG_REG.map((_, i) => i).filter(() => rand() < 0.3);
    const code = floatEncode(bits);
    const got = F94.parseFilterCode(code).venueMode;
    assert.deepEqual(BIG_REG.map(([, v]) => got[v] === 'ex'), floatParse(code), code);
  }
  assert.equal(F94.parseFilterCode('zz!').venueMode['Venue 0'], 'ex'); // parseInt's leading-run rule: 'zz' = 1295, bit 0 set
  assert.equal(F94.parseFilterCode('-1'), null);
  assert.equal(F94.parseFilterCode(''), null);
  assert.equal(F94.parseFilterCode('1.'), null);
  assert.equal(F94.encodeFilterCode({ venueMode: { 'Venue 52': 'ex' } }), (2 ** 52).toString(36).toUpperCase().padStart(19, '0')); // under 2^53: written as always
  assert.equal(F94.parseFilterCode('_zz!').venueMode['Venue 0'], 'ex');
  assert.equal(F94.parseFilterCode('_'), null);
});

test('share codes without BigInt (a pre-2020 browser): the float arithmetic, as before', () => {
  const F = filterFor(BIG_REG.slice(0, 40), 8, true);
  const m = { venueMode: { 'Venue 3': 'ex', 'Venue 39': 'in' } };
  const code = F.encodeFilterCode(m);
  assert.deepEqual({ ...F.parseFilterCode(code).venueMode }, m.venueMode);
});

// Venue marks are files in this repo, never loaded from another site at view time (Steve, 2026-11-06, after the
// hijacked tigresqr.com: a lapsed domain can serve anything). tools/venue-marks.mjs in here-core vendors them.
test('every venue mark is a file in this repo, not a link to another site', async () => {
  const { existsSync } = await import('node:fs');
  for (const [venue, icon] of Object.entries(F.VENUE_ICON || {})) {
    if (!icon) continue;
    assert.doesNotMatch(icon, /^(https?:)?\/\//i, `${venue}: ${icon}`);
    assert.ok(existsSync(new URL('../site/' + icon, import.meta.url)), `${venue}: ${icon} is missing`);
  }
});
