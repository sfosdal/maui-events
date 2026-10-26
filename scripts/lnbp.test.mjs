import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLnbp, lnbpStanding, shiftClock, LNBP_BASE } from './lnbp.mjs';

const CAL = { id: 47, name: 'El Calor', website: 'https://www.facebook.com/profile.php?id=61557431365955', full_url_logo: '/uploads/team/logo/e9.png' };
const FR = { id: 4, name: 'Fuerza Regia', website: 'https://www.fuerzaregia.com.mx/', full_url_logo: '/uploads/team/logo/fr.png' };
const SOL = { id: 13, name: 'Soles', website: '', full_url_logo: '/uploads/team/logo/so.png' };
const game = (id, t1, t2, venue, date, time, s1 = 0, s2 = 0) => ({ id, score_1: s1, score_2: s2, id_team_1: t1.id, id_team_2: t2.id, name: `${t1.name} vs. ${t2.name}`, team_1: t1, team_2: t2, event: { venue, date_start: date, date_end: date, time_start: time } });
const items = [
  game(3914, FR, CAL, 'Arena Mobil', '2026-09-26', '16:15:00', 95, 89), // away, lost, Monterrey time
  game(3935, CAL, SOL, 'Poliforum Cancún', '2026-10-06', '19:15:00'),   // home, not played
  game(3900, SOL, CAL, 'Auditorio PSF', '2026-09-12', '21:00:00', 70, 80), // away at Mexicali, won
  game(3800, FR, SOL, 'Arena Mobil', '2026-09-20', '20:15:00', 1, 2),     // not ours
];

test('LNBP games: ours only, home from the first-listed side, opponent with the backend crest', () => {
  const g = normalizeLnbp(items, 47, { tz: 'America/Cancun' });
  assert.deepEqual(g.map((x) => x.id), ['3900', '3914', '3935']);
  const home = g.find((x) => x.id === '3935');
  assert.equal(home.home, true);
  assert.deepEqual({ date: home.date, time: home.time, tbd: home.tbd, venue: home.venue }, { date: '2026-10-06', time: '19:15:00', tbd: false, venue: 'Poliforum Cancún' });
  assert.deepEqual(home.opp, { name: 'Soles', short: 'Soles', logo: LNBP_BASE + '/uploads/team/logo/so.png' });
  assert.equal(home.res, undefined); // 0-0 is "not played yet"
});

test('LNBP away games read on the city clock: Mexico City +1, Mexicali +2 in September', () => {
  const g = normalizeLnbp(items, 47, { tz: 'America/Cancun' });
  const mty = g.find((x) => x.id === '3914'), mxl = g.find((x) => x.id === '3900');
  assert.deepEqual({ home: mty.home, date: mty.date, time: mty.time, res: mty.res, site: mty.opp.site }, { home: false, date: '2026-09-26', time: '17:15:00', res: { us: 89, them: 95, won: false }, site: 'https://www.fuerzaregia.com.mx/' });
  assert.deepEqual({ date: mxl.date, time: mxl.time, res: mxl.res }, { date: '2026-09-12', time: '23:00:00', res: { us: 80, them: 70, won: true } });
  assert.deepEqual(shiftClock('2026-12-05', '21:00:00', 'America/Tijuana', 'America/Cancun'), { date: '2026-12-06', time: '00:00:00' }); // three hours once US DST ends
});

test('LNBP standings row → the form block, home record from the played home games', () => {
  const rows = [{ id_team: 4, place: 1, games_won: 25, games_lost: 3, team: { name: 'Fuerza Regia' } }, { id_team: 47, place: 13, games_won: 9, games_lost: 19, team: { name: 'El Calor' } }];
  const games = [{ home: true, res: { won: true } }, { home: true, res: { won: false } }, { home: true, res: { won: false } }, { home: false, res: { won: true } }, { home: true }];
  assert.deepEqual(lnbpStanding(rows, 47, games), { record: '9-19', standing: '13th in the LNBP', home: '1-2', club: { name: 'El Calor' } });
  assert.deepEqual(lnbpStanding(rows, 4), { record: '25-3', standing: '1st in the LNBP', club: { name: 'Fuerza Regia' } });
  assert.throws(() => lnbpStanding(rows, 99), /not in standings/);
});
