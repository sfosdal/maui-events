// The LNBP (Liga Nacional de Baloncesto Profesional, Mexico's basketball
// league; El Calor de Cancún at the Poliforum) — its site lnbp.mx is a
// static shell whose calendar and standings pages fill in from a backend,
// lnbpback.truewisdom.co, with jQuery form-encoded POSTs. The backend's
// Mod_Security answers a bare scripted call 406 and the site's own ajax
// headers 200 (Origin + Referer of lnbp.mx, X-Requested-With, a browser
// user-agent; verified 2026-10-14), so every call here sends that set.
//   POST /sports/games/dates   date_start, date_end → { items: [game] }
//   POST /sports/games/single  id → { item: game + round { id_season } }
//   POST /sports/standings/season  id_season → { items_standing: [row] }
// A game: id, score_1/score_2 (0-0 until played), id_team_1 (the home side,
// listed first in name "A vs. B"), id_team_2, team_1/team_2 { id, name,
// website, full_url_logo (relative to the backend) }, event { venue,
// date_start, time_start "HH:MM:SS" — the venue's wall time, shown as-is
// on lnbp.mx }. Every LNBP venue keeps Mexico City time (no DST since 2022)
// but the Soles' in Mexicali, on US Pacific time, so an away tip-off is
// moved onto the city's clock from the opponent's zone.
import { CITY } from './badges.mjs';

export const LNBP_BASE = 'https://lnbpback.truewisdom.co';
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  origin: 'https://lnbp.mx', referer: 'https://lnbp.mx/calendar.html', accept: '*/*',
  'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
};
async function post(path, data = {}) {
  const r = await fetch(LNBP_BASE + path, { method: 'POST', headers: HEADERS, body: new URLSearchParams(data).toString() });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const ZONES = { 13: 'America/Tijuana' }; // Soles de Mexicali (team id 13); every other club keeps Mexico City time
const zoneOfTeam = (id) => ZONES[id] || 'America/Mexico_City';
const DEFAULT_SEASON = 36; // "2026 Varonil", the id the site bundle hard-codes; the build reads the live one from the newest game's round

// A wall-clock date+time in one zone, read on another zone's clock
const wallParts = (ms, zone) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
export function shiftClock(date, time, from, to) {
  const [y, m, d] = date.split('-').map(Number), [h, mi, s] = time.split(':').map(Number);
  let t = Date.UTC(y, m - 1, d, h, mi, s || 0);
  const p = wallParts(t, from);
  t -= Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t; // the wall time in `from` → the instant
  const dt = new Date(t);
  return { date: dt.toLocaleDateString('en-CA', { timeZone: to }), time: dt.toLocaleTimeString('en-GB', { timeZone: to, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }) };
}

// The backend's games → the shared game shape (schedules.mjs): [{ date,
// time, tbd, home, id, opp: { name, short, logo, site }, venue, res? }]
export function normalizeLnbp(items, teamId, { tz = CITY.tz || 'America/Cancun', zoneOf = zoneOfTeam } = {}) {
  return (items || [])
    .filter((g) => g.id_team_1 === teamId || g.id_team_2 === teamId)
    .map((g) => {
      const home = g.id_team_1 === teamId;
      const o = (home ? g.team_2 : g.team_1) || {};
      const ev = g.event || {};
      const when = ev.time_start && !home ? shiftClock(ev.date_start, ev.time_start, zoneOf(o.id), tz) : { date: ev.date_start, time: ev.time_start || null };
      const us = Number(home ? g.score_1 : g.score_2), them = Number(home ? g.score_2 : g.score_1);
      const final = us + them > 0; // 0-0 is the backend's "not played yet"
      return {
        date: when.date, time: when.time, tbd: !ev.time_start, home, id: String(g.id),
        opp: { name: o.name || '?', short: o.name || '?', ...(o.full_url_logo ? { logo: LNBP_BASE + o.full_url_logo } : {}), ...(o.website ? { site: o.website } : {}) },
        venue: ev.venue, ...(final ? { res: { us, them, won: us > them } } : {}),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.time).localeCompare(String(b.time)));
}

// The club's whole season, 240 days either side of today
export async function lnbpSeason(teamId) {
  const day = (off) => new Date(Date.now() + off * 86400e3).toISOString().slice(0, 10);
  const d = await post('/sports/games/dates', { date_start: day(-240), date_end: day(240) });
  return normalizeLnbp(d.items, teamId);
}

const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
// A standings row ({ place, games_won, games_lost, team: { name } }) plus
// the club's played games → the form block
export function lnbpStanding(rows, teamId, games = []) {
  const r = (rows || []).find((x) => Number(x.id_team) === Number(teamId));
  if (!r) throw new Error('team not in standings');
  const played = games.filter((g) => g.home && g.res);
  const home = played.length ? `${played.filter((g) => g.res.won).length}-${played.filter((g) => !g.res.won).length}` : undefined;
  return { record: `${r.games_won}-${r.games_lost}`, standing: r.place ? `${ordinal(Number(r.place))} in the LNBP` : undefined,
    ...(home ? { home } : {}), ...(r.team?.name ? { club: { name: r.team.name } } : {}) };
}
export async function lnbpForm(teamId) {
  const games = await lnbpSeason(teamId);
  let season = DEFAULT_SEASON;
  const newest = games.filter((g) => g.res).pop() || games[0];
  if (newest) { try { season = (await post('/sports/games/single', { id: newest.id })).item?.round?.id_season || season; } catch { /* the hard-coded season stands */ } }
  const d = await post('/sports/standings/season', { id_season: season });
  return lnbpStanding(d.items_standing, teamId, games);
}
