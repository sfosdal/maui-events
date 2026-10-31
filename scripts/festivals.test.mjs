import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, issueLine, readAnswers, stampFestivals } from './festivals.mjs';

const row = (date, venue, title, type = 'concert') => ({ date, venue, title, type });
const feed = [
  row('2026-11-11', 'Delmar Hall', 'Dropout Improv, Presented By Flyover Comedy Festival 2026'),
  row('2026-11-12', 'The Pageant', 'Flyover Comedy Festival: Late Show'),
  row('2026-11-14', 'Stifel Theatre', 'Flyover Comedy Festival Gala'),
  row('2026-11-04', 'El Sid', 'Open Mic Night'), row('2026-11-05', 'Lucky Dime', 'Open Mic Night'), row('2026-11-06', 'Bar X', 'Open Mic Night'),
  row('2026-11-07', 'Arena', 'Hall of Fame Series - Session 1', 'sports'), row('2026-11-07', 'Gym', 'Hall of Fame Series - Session 2', 'sports'), row('2026-11-08', 'Arena', 'Hall of Fame Series - Session 3', 'sports'),
  row('2026-10-01', 'Delmar Hall', 'Old Fest Day'),
];

test('detect: a festival word at two venues or more is a find; stock phrases, games and past rows are not', () => {
  const f = detect(feed, { city: 'stlouis', cityName: 'St. Louis', today: '2026-10-30' });
  assert.deepEqual(f.map((x) => x.key), ['stlouis|flyover comedy festival']);
  assert.equal(f[0].name, 'Flyover Comedy Festival'); assert.equal(f[0].start, '2026-11-11'); assert.equal(f[0].end, '2026-11-14'); assert.equal(f[0].venues.length, 3);
  assert.deepEqual(detect(feed, { city: 'stlouis', today: '2026-10-30', decided: new Set(['stlouis|flyover comedy festival']) }).map((x) => x.key).filter((k) => /flyover/.test(k)), [], 'a decided find is not proposed again');
  assert.deepEqual(detect(feed, { city: 'stlouis', today: '2026-10-30', skipVenues: new Set(['Delmar Hall', 'The Pageant']) }), [], 'a festival already on the site (its venues) is no find');
});

test('readAnswers: a ticked box is a yes anywhere; an unticked one is a no once its issue is closed', () => {
  const [a, b] = detect(feed.concat(row('2026-12-01', 'A', 'Snow Week'), row('2026-12-02', 'B', 'Snow Week Party'), row('2026-12-03', 'C', 'Snow Week Finale')), { city: 'x', today: '2026-10-30' });
  const open = issueLine(a), ticked = issueLine(b).replace('- [ ]', '- [x]');
  const r1 = readAnswers([{ state: 'open', body: `intro\n\n### X\n\n${open}\n${ticked}\n` }]);
  assert.deepEqual([...r1.approved.keys()], [b.key]); assert.deepEqual([...r1.pending], [a.key]); assert.equal(r1.rejected.size, 0);
  assert.equal(r1.approved.get(b.key).name, b.name);
  const edited = `${open.replace('**', '**(edited) ')}\n* [X] ${ticked.slice(6)}`; // Steve may edit the text; a capital X or a * bullet still counts
  const r2 = readAnswers([{ state: 'closed', body: edited }]);
  assert.deepEqual([...r2.rejected], [a.key]); assert.deepEqual([...r2.approved.keys()], [b.key]);
  const r3 = readAnswers([{ state: 'closed', body: open }, { state: 'open', body: open.replace('- [ ]', '- [x]') }]);
  assert.deepEqual([...r3.approved.keys()], [a.key], 'a yes later outweighs an earlier no'); assert.equal(r3.rejected.size, 0);
});

test('stampFestivals names this city\'s approved finds, any year, and leaves the build alone when the answers cannot be read', async () => {
  const body = `- [x] **Flyover Comedy Festival** · … <!-- fest stlouis|flyover comedy festival|Flyover Comedy Festival -->\n- [x] **Art Walk** · … <!-- fest seattle|art walk|Art Walk -->`;
  const evs = [row('2027-11-10', 'Delmar Hall', 'Flyover Comedy Festival 2027 Opening'), row('2026-11-05', 'Central Saloon', 'First Thursday Art Walk'), row('2026-11-12', 'The Pageant', 'Flyover Comedy Festivals?')];
  assert.equal(await stampFestivals(evs, { city: 'stlouis', issues: [{ state: 'open', body }] }), 1);
  assert.equal(evs[0].festival, 'Flyover Comedy Festival'); assert.equal(evs[1].festival, undefined, 'another city\'s'); assert.equal(evs[2].festival, undefined, 'whole words only');
  const none = [row('2026-11-11', 'Delmar Hall', 'Flyover Comedy Festival')];
  assert.equal(await stampFestivals(none, { city: 'stlouis', fetchImpl: async () => ({ ok: false, status: 403 }) }), 0); assert.equal(none[0].festival, undefined);
});
