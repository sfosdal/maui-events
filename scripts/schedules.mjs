// League schedules for the local teams. The leagues know a game's date or
// time is still floating (NFL flex weeks, doubleheader splits, postponements)
// before Ticketmaster does, so after the feed is assembled each team's home
// games are checked against its league's schedule and matching feed events
// pick up dateTbd.
//
// Every adapter yields the team's whole season, home and away — [{ date:
// 'YYYY-MM-DD' (Seattle local), time: 'HH:MM:SS' Seattle local or null,
// tbd: bool, home: bool, opp: { name, short, abbrev, logo, site }, venue,
// watch?: { tv: [...], radio: [...] } }] — and is best-effort: a blocked or
// reshaped API logs one line and that team is skipped for the run. The
// home games flag the feed (the Ticketmaster flag is never cleared here,
// only set); the full list is published as site/teams.json for the site's
// Teams view. `watch` is where to catch the game from Seattle — the
// home-market and national broadcasts the league lists, nothing hardcoded
// — and rides along onto the matching feed event for the pop-up.
import { TEAMS, CITY } from './badges.mjs';
import { cleanMarks } from './marks.mjs';
import { addClips } from './highlights.mjs';
import { lnbpSeason, lnbpForm } from './lnbp.mjs'; // the LNBP backend (El Calor de Cancún)
import { readFileSync } from 'node:fs';

const UA = CITY.userAgent;
const TZ = CITY.tz || 'America/Los_Angeles'; // the city's zone — game clocks are the home city's wall time (named for Seattle; chicago-events made it the city's, 2026-10-11)
const seattleDate = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
const easternTime = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }); // ESPN's other placeholder for a tip-off not yet set: 23:59 Eastern with timeValid still true (college basketball; Honolulu's 6:59 PM clocks, 2026-10-11)
const easternDate = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // ESPN files a kickoff it doesn't know yet (timeValid:false) at midnight Eastern: the day is that one, not the city's, which lands the night before west of there (Pullman's Cougars on Nov 27 beside the listing's Nov 28, 2026-10-11)
const seattleTime = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const htRegular = (x) => /regular season/i.test(x.name) || /^\d{4}-\d{2}$/.test(String(x.name).trim()); // the USHL names its regular seasons by the years alone ("2026-27"; Green Bay's Gamblers, 2026-10-11)
// MLB's team-logos/<id>.svg files are the caps' on-dark variants; all keep
// their colours but the Rockies' (115), whose purple is drawn as black (no
// fill), so it reads grey on the cards — ESPN's mark stands in for it.
const MLB_LOGO_FIX = { 115: 'https://a.espncdn.com/i/teamlogos/mlb/500/col.png' };
// a club's site from its nickname: mlb.com/redsox, nhl.com/mapleleafs
const slugName = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ESPN's site API answers a browser user-agent with 403 (verified
// 2026-09-10: 200 with none, 403 with Chrome's), so it gets a bare fetch.
async function getJson(url, bare) {
  const r = await fetch(url, { headers: bare ? { accept: 'application/json' } : { 'user-agent': UA, accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// From a league's broadcast list — normalized to { kind: 'tv'|'radio',
// name, home: bool, national: bool } — the ones a Seattle viewer can use:
// national first, then our own market (the home feeds for a home game, the
// away feeds when we're the visitors); each name once; the other side's
// market and non-English feeds dropped. Returns undefined when there's nothing.
export function pickBroadcasts(list, ours = true) {
  const out = { tv: [], radio: [] };
  const usable = (list || []).filter((b) => b && b.name && (b.national || b.home === ours));
  for (const b of [...usable.filter((b) => b.national), ...usable.filter((b) => !b.national)]) {
    const arr = out[b.kind];
    if (arr && !arr.includes(b.name)) arr.push(b.name);
  }
  if (!out.tv.length) delete out.tv;
  if (!out.radio.length) delete out.radio;
  return Object.keys(out).length ? out : undefined;
}
const withWatch = (game, list) => { const w = pickBroadcasts(list, game.home); return w ? { ...game, watch: w } : game; };
// a played game's line: { us, them, won, ot?: 'OT'|'SO' } — a draw is
// won:false with equal scores; nothing at all until the game is final
const withResult = (game, res) => (res ? { ...game, res } : game);

// MLB Stats API — official; startTimeTBD is the floating-time marker.
// hydrate=broadcasts lists each game's TV / radio with homeAway + isNational.
// The window runs from well before today so the season's played games are
// in the list too (a schedule page shows the whole season).
// gameType: S spring training (kept, flagged pre); E exhibition and A
// all-star left out; R regular; the rest (F wild card, D division, L
// league, W world series) are playoffs.
// The same API serves the minors (sportId 13 is High-A, the Everett
// AquaSox's league): the crests sit at the same address, the club pages at
// milb.com/<city> (tri-city, not tricity), and the feed's "Audio" entries
// (type INET, the club's own stream) are not broadcasts a listing names.
const slugCity = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export function normalizeMlb(d, teamId, sportId = 1) {
  return (d.dates || []).flatMap((day) => (day.games || [])
    .filter((g) => g.teams?.home?.team?.id === teamId || g.teams?.away?.team?.id === teamId)
    .filter((g) => !/^[EA]$/.test(g.gameType || 'R'))
    .map((g) => {
      const home = g.teams.home.team.id === teamId;
      const o = (home ? g.teams.away : g.teams.home).team || {};
      const tbd = !!g.status?.startTimeTBD;
      const us = home ? g.teams.home : g.teams.away, them = home ? g.teams.away : g.teams.home;
      const final = g.status?.abstractGameState === 'Final' && us.score != null && them.score != null;
      return withResult(withWatch({
        date: g.officialDate || day.date, time: tbd || !g.gameDate ? null : seattleTime(g.gameDate), tbd, home,
        ...(g.gamePk ? { id: String(g.gamePk) } : {}), // MLB's game id: the page fetches the game's highlights by it
        ...(g.gameType === 'S' ? { pre: true } : g.gameType && g.gameType !== 'R' ? { playoff: true } : {}),
        opp: { name: o.name, short: o.teamName || o.clubName || o.name, abbrev: o.abbreviation,
          logo: o.id ? (MLB_LOGO_FIX[o.id] || `https://www.mlbstatic.com/team-logos/${o.id}.svg`) : undefined,
          site: o.teamName ? (sportId === 1 ? `https://www.mlb.com/${slugName(o.teamName)}` : `https://www.milb.com/${slugCity(o.locationName || o.shortName || o.teamName)}`) : undefined },
        venue: g.venue?.name,
      }, (g.broadcasts || []).filter((b) => (!b.language || b.language === 'en') && b.type !== 'INET').map((b) => ({
        kind: b.type === 'TV' ? 'tv' : 'radio', name: b.name, home: b.homeAway === 'home', national: !!b.isNational,
      }))), final ? { us: us.score, them: them.score, won: !!us.isWinner } : null);
    }));
}
async function mlb(teamId, sportId = 1) {
  const start = new Date(Date.now() - 240 * 86400e3).toISOString().slice(0, 10);
  const end = new Date(Date.now() + 240 * 86400e3).toISOString().slice(0, 10);
  const d = await getJson(`https://statsapi.mlb.com/api/v1/schedule?sportId=${sportId}&teamId=${teamId}&startDate=${start}&endDate=${end}&hydrate=broadcasts(all),team`);
  return normalizeMlb(d, teamId, sportId);
}
// A minor-league club's record and standing: the same API's standings by
// league (the AquaSox's Northwest League is 126) — no ESPN coverage to draw
// on, so W-L and the league's own rank, plus the outlets' feeds.
async function milbForm(leagueId, teamId, leagueName, slug, label) {
  const season = new Date().getFullYear();
  const d = await getJson(`https://statsapi.mlb.com/api/v1/standings?leagueId=${leagueId}&season=${season}&standingsTypes=regularSeason&hydrate=team`);
  const rows = (d.records || []).flatMap((r) => r.teamRecords || []);
  const r = rows.find((x) => Number(x.team?.id) === Number(teamId));
  if (!r) throw new Error('team not in standings');
  const n = Number(r.leagueRank || r.divisionRank);
  const news = await clubNews(slug, label, Promise.resolve([]));
  const home = (r.records?.splitRecords || []).find((x) => x.type === 'home');
  return { record: `${r.wins}-${r.losses}`, standing: n ? `${ordinal(n)} in the ${leagueName || 'league'}` : undefined,
    ...(home ? { home: `${home.wins}-${home.losses}` } : {}), ...(news.length ? { news } : {}), ...(r.team?.name ? { club: { name: r.team.name } } : {}) };
}

// NHL api-web — official; gameScheduleState is OK / TBD / PPD / SUSP / CNCL.
// tvBroadcasts carry a market: H (home), A (away), N (national). Each side
// comes with its crest and name parts; the club site is nhl.com/<nickname>.
// gameType: 1 preseason (kept, flagged pre), 2 regular season, 3 playoffs.
export function normalizeNhl(d, abbrev) {
  return (d.games || [])
    .filter((g) => g.homeTeam?.abbrev === abbrev || g.awayTeam?.abbrev === abbrev)
    .map((g) => {
      const home = g.homeTeam?.abbrev === abbrev;
      const o = (home ? g.awayTeam : g.homeTeam) || {};
      const nick = o.commonName?.default, place = o.placeName?.default;
      const tbd = (g.gameScheduleState || 'OK') !== 'OK';
      const us = home ? g.homeTeam : g.awayTeam, them = home ? g.awayTeam : g.homeTeam;
      const final = /^(OFF|FINAL)$/.test(g.gameState || '') && us?.score != null && them?.score != null;
      const ot = g.gameOutcome?.lastPeriodType; // REG, OT or SO
      return withResult(withWatch({
        date: g.gameDate, time: tbd || !g.startTimeUTC ? null : seattleTime(g.startTimeUTC), tbd, home, ...(g.id ? { id: String(g.id) } : {}), // the gamecenter id, for the game's clips (scripts/highlights.mjs)
        ...(g.gameType === 3 ? { playoff: true } : g.gameType === 1 ? { pre: true } : {}),
        opp: { name: [place, nick].filter(Boolean).join(' ') || o.abbrev, short: nick || o.abbrev, abbrev: o.abbrev,
          logo: o.logo, site: nick ? `https://www.nhl.com/${slugName(nick)}` : undefined },
        venue: g.venue?.default,
      }, (g.tvBroadcasts || []).map((b) => ({ kind: 'tv', name: b.network, home: b.market === 'H', national: b.market === 'N' }))),
      final ? { us: us.score, them: them.score, won: us.score > them.score, ...(ot && ot !== 'REG' ? { ot } : {}) } : null);
    });
}
async function nhl(abbrev) {
  const d = await getJson(`https://api-web.nhle.com/v1/club-schedule-season/${abbrev}/now`);
  return normalizeNhl(d, abbrev);
}

// ESPN's site API — undocumented but the only per-team schedule with a TBD
// marker for the NFL, WNBA, MLS and NWSL. timeValid:false is a flexed or
// unannounced kickoff. Some networks get an Akamai 403; that just skips.
// The opponent's "site" is its ESPN clubhouse page (the league sites have
// no single URL pattern across four leagues).
// season.type: 1 preseason (kept, flagged pre), 2 regular season, 3 postseason.
export function normalizeEspn(d, teamId, keepWeek, forcePre) { // forcePre: the whole list is the preseason (ESPN's ?seasontype=1 call carries no season.type) // keepWeek: the NFL's week and season year, which name nfl.com's game page (scripts/highlights.mjs)
  const out = [];
  for (const e of d.events || []) {
    const c = e.competitions?.[0];
    const us = c?.competitors?.find((t) => String(t.team?.id) === String(teamId));
    if (!c || !us) continue;
    const home = us.homeAway === 'home';
    const o = (c.competitors.find((t) => t !== us) || {}).team || {};
    const detail = c.status?.type?.detail || '';
    const placeholder = c.timeValid === false || easternTime(e.date) === '23:59'; // ESPN's two ways of saying the clock is not set yet
    const tbd = placeholder || /\bTB[AD]\b/i.test(detail);
    const them = c.competitors.find((t) => t !== us);
    const score = (t) => { const v = t?.score?.displayValue ?? t?.score?.value ?? t?.score; return v == null || v === '' ? null : Number(v); };
    const final = !!c.status?.type?.completed && score(us) != null && score(them) != null;
    // broadcasts: [{ type: { shortName: 'TV' }, market: { type: 'National' | 'Home' }, media: { shortName } }]
    out.push(withResult(withWatch({
      date: placeholder ? easternDate(e.date) : seattleDate(e.date), time: tbd ? null : seattleTime(e.date), tbd, home,
      ...(e.season?.type === 3 ? { playoff: true } : forcePre || e.season?.type === 1 ? { pre: true } : {}),
      ...(keepWeek && e.week?.number != null && e.season?.year ? { week: e.week.number, season: e.season.year } : {}),
      opp: { name: o.displayName, short: o.shortDisplayName || o.displayName, abbrev: o.abbreviation,
        logo: o.logos?.[0]?.href, site: (o.links || []).find((l) => (l.rel || []).includes('clubhouse'))?.href },
      venue: c.venue?.fullName,
      ...(home && c.venue?.address?.city ? { city: [c.venue.address.city, c.venue.address.state].filter(Boolean).join(', ').replace(/, Washington$/, ', WA') } : {}), // where the home ground is (not assumed to be Seattle: the Huskies are, the Seawolves are not)
    }, (c.broadcasts || []).map((b) => ({
      kind: /radio/i.test(b.type?.shortName || '') ? 'radio' : 'tv', name: b.media?.shortName || b.media?.name,
      home: /home/i.test(b.market?.type || ''), national: /national/i.test(b.market?.type || ''),
    }))), final ? { us: score(us), them: score(them), won: !!us.winner } : null));
  }
  return out;
}
async function espn(sport, league, teamId) {
  const base = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/teams/${teamId}/schedule`;
  const first = await getJson(base, true);
  // the plain call answers with the season type in progress, named only at the
  // top (first.season.type; its events carry none): a 1 is the preseason, so
  // every game in it is flagged pre (the Bulls in October, 2026-10-11)
  const games = normalizeEspn(first, teamId, sport === 'football', first.season?.type === 1);
  if (sport === 'football') { // the NFL's preseason is a season type of its own (the plain call is the regular season): fetched apart, flagged pre
    try {
      const seen = new Set(games.map((g) => g.date));
      for (const g of normalizeEspn(await getJson(base + '?seasontype=1', true), teamId, true, true)) if (!seen.has(g.date)) games.push(g);
      games.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
    } catch (e) { console.error(`schedules: ${league} preseason skipped — ${e.message}`); }
  }
  // the NBA's plain call answers with the season type in progress — in
  // October the preseason (five Bulls games on 2026-10-11, the regular season
  // nowhere): the regular season is asked for by name and merged, de-duped
  // by day; the plain call's preseason games stay, flagged pre above
  // (chicago-events, 2026-10-11)
  if (/^(nba|mens-college-basketball|womens-college-basketball)$/.test(league)) { // college basketball likewise (Gonzaga's and Marquette's plain calls were empty preseasons, 2026-10-11)
    try {
      const seen = new Set(games.map((g) => g.date));
      for (const g of normalizeEspn(await getJson(base + '?seasontype=2', true), teamId)) if (!seen.has(g.date)) games.push(g);
      games.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
    } catch (e) { console.error(`schedules: ${league} regular season skipped — ${e.message}`); }
  }
  // soccer schedules come in two halves: the plain call is results only,
  // ?fixture=true the matches still to play — take both, de-duped by day
  if (sport === 'soccer') {
    const seen = new Set(games.map((g) => g.date + '|' + g.opp.name));
    for (const g of normalizeEspn(await getJson(base + '?fixture=true', true), teamId)) {
      if (!seen.has(g.date + '|' + g.opp.name)) { seen.add(g.date + '|' + g.opp.name); games.push(g); }
    }
    games.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  }
  return games;
}

// The PWHL publishes through HockeyTech's stat feed (the key and client
// code are the ones thepwhl.com's own pages carry). Seasons are separate
// ids — "2025-26 Regular Season", "2026 Playoffs", preseasons — so the
// newest regular season plus any playoffs after it make the schedule, and a
// new season is picked up the run it appears. Times come with the venue's
// timezone in GameDateISO8601; crests are the league's own at
// assets.leaguestat.com. No broadcast data in the feed.
// The same feed serves the junior leagues (the WHL's Everett Silvertips are
// client_code whl, key 41b145a848f4bd67, the one chl.ca's pages carry), so
// the league and key are parameters; only the crest address and the club
// page differ by league (opts.logo / opts.site).
const HT = (league, key) => `https://lscluster.hockeytech.com/feed/index.php?feed=modulekit&key=${key}&fmt=json&client_code=${league}&lang=en`;
const PWHL = HT('pwhl', '446521baf8c38984');
const pwhlSlug = (name) => String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const PWHL_OPTS = { logo: (oid) => `https://assets.leaguestat.com/pwhl/logos/${oid}.png`, site: (oname) => `https://www.thepwhl.com/en/teams/${pwhlSlug(oname)}` };
export function normalizePwhl(games, teamId, playoff, pre, opts = PWHL_OPTS) {
  return (games || []).filter((g) => g.home_team === String(teamId) || g.visiting_team === String(teamId)).map((g) => {
    const home = g.home_team === String(teamId);
    const oid = home ? g.visiting_team : g.home_team;
    const oname = home ? g.visiting_team_name : g.home_team_name;
    const onick = home ? g.visiting_team_nickname : g.home_team_nickname;
    const tbd = g.time_tbd === '1' || g.date_tbd === '1';
    const usG = Number(home ? g.home_goal_count : g.visiting_goal_count), themG = Number(home ? g.visiting_goal_count : g.home_goal_count);
    const final = g.final === '1' && Number.isFinite(usG) && Number.isFinite(themG);
    const ot = /\bSO\b/.test(g.game_status || '') ? 'SO' : /\bOT\b/.test(g.game_status || '') ? 'OT' : null;
    const site = opts.site ? opts.site(oname, oid) : undefined;
    return withResult({
      date: g.date_played, time: tbd || !g.GameDateISO8601 ? null : seattleTime(g.GameDateISO8601), tbd, home,
      ...(playoff ? { playoff: true } : pre ? { pre: true } : {}),
      opp: { name: oname, short: onick || oname, abbrev: home ? g.visiting_team_code : g.home_team_code,
        logo: opts.logo(oid), ...(site ? { site } : {}) },
      venue: String(g.venue_name || '').split(/\s*[|]\s*|\s+-\s+/)[0].trim(), // "Climate Pledge Arena|Seattle" (PWHL) or "Angel of the Winds Arena - Everett, WA" (WHL)
      ...(home && g.venue_location ? { city: String(g.venue_location).trim() } : {}),
    }, final ? { us: usG, them: themG, won: usG > themG, ...(ot ? { ot } : {}) } : null);
  });
}
// No sportsbook or predictor prices the PWHL, so the site's estimate is
// made here for every game still to play: log5 on the two clubs' points
// shares from the standings (this season's once six games are in, else
// last season's), the home side nudged up a little; an opponent with no
// standings row yet (an expansion side) counts as a .500 club. app.js shows
// it as it shows ESPN's, with a tilde. games: normalizePwhl's; rows: the standings
// (team_id, games_played, points); returns the games, odds attached.
export function pwhlOdds(games, rows, teamId, leagueName = 'PWHL', oppId = (g) => (String(g.opp?.logo || '').match(/logos\/(\d+)\.\w+/) || [])[1]) { // oppId: the opponent's standings id from its game (HockeyTech numbers the crests; GameSheet games carry it, see gamesheet())
  const share = {};
  for (const r of rows || []) { const gp = Number(r.games_played); if (gp) share[String(r.team_id)] = Number(r.points) / (2 * gp); }
  const us = share[String(teamId)];
  return (games || []).map((g) => {
    const oid = oppId(g), them = share[oid] ?? 0.5; // a club with no row (an expansion side) is taken as league-average
    if (g.res || us == null) return g;
    const edge = 0.03, a = Math.min(0.97, Math.max(0.03, us + (g.home ? edge : -edge))), b = Math.min(0.97, Math.max(0.03, them + (g.home ? -edge : edge)));
    const p = Math.round((a - a * b) / (a + b - 2 * a * b) * 100);
    return { ...g, odds: { us: p, them: 100 - p, draw: 0, est: true, source: `an estimate from the two clubs' records — no line for the ${leagueName}` } };
  });
}
async function hockeytechSeasons(base) {
  return (await getJson(`${base}&view=seasons`)).SiteKit.Seasons.map((x) => ({ id: Number(x.season_id), name: x.season_name })).sort((a, b) => b.id - a.id);
}
async function hockeytechStandings(base, seasons, teamId) { // the newest regular season with six of the club's games in it, else the one before
  for (const s of seasons.filter(htRegular)) {
    const rows = (await getJson(`${base}&view=statviewtype&type=standings&stat=conference&season_id=${s.id}`)).SiteKit?.Statviewtype || [];
    const mine = rows.find((x) => String(x.team_id) === String(teamId));
    if (mine && Number(mine.games_played) >= 6) return rows;
  }
  return [];
}
// A club's season from a HockeyTech feed: the newest regular season, the
// playoffs after it and that season's (or the next one's) preseason.
async function hockeytech(league, key, teamId, opts, leagueName) {
  const base = HT(league, key);
  const seasons = await hockeytechSeasons(base);
  const reg = seasons.find(htRegular);
  if (!reg) throw new Error('no regular season listed');
  // the playoffs after it, and the preseason of that season or of the next (the same year in the name, or a newer id)
  const runs = [reg, ...seasons.filter((x) => (/playoffs/i.test(x.name) && x.id > reg.id) || (/pre-?season/i.test(x.name) && (x.id > reg.id || x.name.slice(0, 4) === reg.name.slice(0, 4))))];
  const out = [];
  for (const r of runs) {
    const d = await getJson(`${base}&view=schedule&season_id=${r.id}&team_id=${teamId}`);
    out.push(...normalizePwhl(d.SiteKit?.Schedule, teamId, /playoffs/i.test(r.name), /pre-?season/i.test(r.name), opts));
  }
  // the crest host answers 404 for a few WHL clubs' .png (Saskatoon, Brandon,
  // Kelowna, Penticton) but serves the same crest as .jpg
  const crest = new Map();
  for (const g of out) {
    const u = g.opp?.logo;
    if (!u || !/\.png$/.test(u)) continue;
    if (!crest.has(u)) crest.set(u, fetch(u, { method: 'HEAD' }).then((r) => r.ok ? u : fetch(u.replace(/\.png$/, '.jpg'), { method: 'HEAD' }).then((j) => j.ok ? u.replace(/\.png$/, '.jpg') : u)).catch(() => u));
    g.opp.logo = await crest.get(u);
  }
  let rows = [];
  try { rows = await hockeytechStandings(base, seasons, teamId); } catch (e) { console.error(`schedules: ${league} standings skipped — ${e.message}`); }
  return pwhlOdds(out, rows, teamId, leagueName).sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
}
const pwhl = (teamId) => hockeytech('pwhl', '446521baf8c38984', teamId, PWHL_OPTS, 'PWHL');
// The junior leagues' crests are at the same host under the league's code; no
// club page is linked (chl.ca turns scripts away, and the clubs' own sites vary).
const WHL_OPTS = (league) => ({ logo: (oid) => `https://assets.leaguestat.com/${league}/logos/${oid}.png` });

// GameSheet (the NAHL moved its stats there in 2024; HockeyTech's NAHL feed
// is dead): gateway.gamesheet.io/stats with the league site's public partner
// key. /seasons?filter[leagues]= lists the league's seasons (the regular one
// is_active; the Robertson Cup and the exhibition slate are seasons of their
// own), /unifiedschedule?filter[seasons]=&filter[teams]= a club's games —
// timeStampZulu is the true instant, status scheduled|final, home/visitor
// carry title, abbr, logo, goals and result "W"/"L", goalsByPeriod gains
// ot_1 / so keys when it went past regulation — and /standings?filter
// [seasons]=&filter[divisions]= the division table (stats W-L-OTL-SOL in
// GTYPEREC, the home split in HREC, rank by points).
const GS = 'https://gateway.gamesheet.io/stats';
async function gsJson(path, key) {
  const r = await fetch(`${GS}/${path}`, { headers: { 'X-Gamesheet-Partner-ApiKey': key, accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  if (d.status !== 'success') throw new Error(d.errors?.[0]?.message || d.status || 'not a success');
  return d.data;
}
export function normalizeGamesheet(rows, teamId, playoff, pre) {
  return (rows || []).filter((g) => String(g.home?.id) === String(teamId) || String(g.visitor?.id) === String(teamId)).map((g) => {
    const home = String(g.home.id) === String(teamId);
    const us = home ? g.home : g.visitor, them = home ? g.visitor : g.home;
    const tbd = !g.timeStampZulu || /tbd|tba/i.test(g.time || '');
    const final = g.status === 'final' && Number.isFinite(Number(us.goals)) && Number.isFinite(Number(them.goals));
    const periods = Object.keys(us.goalsByPeriod || {});
    const ot = periods.includes('so') ? 'SO' : periods.some((k) => /^ot/.test(k)) ? 'OT' : null;
    return withResult({
      date: tbd ? seattleDate(new Date(g.date + ' 12:00 UTC').toISOString()) : seattleDate(g.timeStampZulu), time: tbd ? null : seattleTime(g.timeStampZulu), tbd, home,
      ...(playoff ? { playoff: true } : pre ? { pre: true } : {}),
      opp: { name: them.title, short: String(them.title || '').split(' ').slice(-1)[0], abbrev: them.abbr, logo: them.logo, id: String(them.id) },
      venue: String(g.location || '').trim(),
    }, final ? { us: Number(us.goals), them: Number(them.goals), won: Number(us.goals) > Number(them.goals), ...(ot ? { ot } : {}) } : null);
  });
}
async function gamesheetSeasons(league, key) { // newest first; the active regular season flagged
  return (await gsJson(`seasons?filter[leagues]=${league}`, key)).map((x) => ({ id: Number(x.id), name: x.title, active: !!x.is_active, start: x.start })).sort((a, b) => b.id - a.id);
}
const gsRegular = (x) => !/exhibition|pre-?season|cup|playoff|prospect|showcase|all-?star/i.test(x.name);
async function gamesheetStandings(league, key, seasonId, division) {
  const d = await gsJson(`standings?filter[seasons]=${seasonId}${division ? `&filter[divisions]=${division}` : ''}`, key);
  return d.flatMap((x) => x.standings || []);
}
async function gamesheet(league, key, teamId, division, leagueName) {
  const seasons = await gamesheetSeasons(league, key);
  const reg = seasons.find((x) => x.active && gsRegular(x)) || seasons.find(gsRegular);
  if (!reg) throw new Error('no regular season listed');
  const runs = [reg, ...seasons.filter((x) => x.id > reg.id && (/cup|playoff/i.test(x.name) || /exhibition|pre-?season/i.test(x.name)))];
  const out = [];
  for (const r of runs) out.push(...normalizeGamesheet(await gsJson(`unifiedschedule?filter[seasons]=${r.id}&filter[teams]=${teamId}`, key), teamId, /cup|playoff/i.test(r.name), /exhibition|pre-?season/i.test(r.name)));
  let rows = [];
  try { rows = (await gamesheetStandings(league, key, reg.id, division)).map((s) => ({ team_id: s.team?.id, games_played: s.stats?.GP, points: s.stats?.PTS })); }
  catch (e) { console.error(`schedules: gamesheet ${league} standings skipped — ${e.message}`); }
  const games = pwhlOdds(out, rows, teamId, leagueName, (g) => g.opp?.id).map((g) => { const { id, ...opp } = g.opp; return { ...g, opp }; }); // the opponent's id served the odds only
  return games.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
}
export function gamesheetForm(s) { // a standings row → the form block (W-L-OTL-SOL, ranked in the division)
  const st = s.stats || {}, n = Number(s.rank);
  const where = s.division?.title ? `the ${String(s.division.title).replace(/^the /i, '')}` : 'the league';
  return { record: st.GTYPEREC || [st.W, st.L, st.OTL, st.SOL].join('-'), standing: n ? `${ordinal(n)} in ${where}` : undefined, ...(st.HREC ? { home: st.HREC } : {}),
    club: { ...(s.team?.title ? { name: s.team.title } : {}), ...(s.team?.abbreviation ? { abbr: s.team.abbreviation } : {}) } };
}
async function gamesheetFormFetch(league, key, teamId, division, slug, label) {
  const seasons = await gamesheetSeasons(league, key);
  const reg = seasons.find((x) => x.active && gsRegular(x)) || seasons.find(gsRegular);
  if (!reg) throw new Error('no regular season listed');
  const s = (await gamesheetStandings(league, key, reg.id, division)).find((x) => String(x.team?.id) === String(teamId));
  if (!s) throw new Error('team not in standings');
  const news = await clubNews(slug, label, Promise.resolve([]));
  return { ...gamesheetForm(s), ...(news.length ? { news } : {}) };
}

// Where each club stands: { record: 'W-L', standing: '3rd in AL West',
// home?: 'W-L' }. ESPN's team endpoint carries a record summary and a
// standing line for every league but the PWHL, whose standings come from
// the same HockeyTech feed as its schedule (PWHL records read RW-OTW-OTL-L).
// The home ground's city and state, as ESPN's schedule lists the club's
// home games (the commonest, for a club with a neutral-site "home" game) —
// for the clubs whose schedules come from their own leagues' feeds (MLB,
// NHL), which carry no venue address.
async function espnHomeCity(sport, league, teamId) {
  const d = await getJson(`https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/teams/${teamId}/schedule`, true);
  const n = {};
  for (const e of d.events || []) {
    const c = e.competitions?.[0], us = c?.competitors?.find((x) => String(x.team?.id) === String(teamId)), a = c?.venue?.address;
    if (!us || us.homeAway !== 'home' || !a?.city) continue;
    const k = [a.city, a.state].filter(Boolean).join(', ').replace(/, Washington$/, ', WA');
    n[k] = (n[k] || 0) + 1;
  }
  return Object.keys(n).sort((a, b) => n[b] - n[a])[0] || null;
}
async function espnForm(sport, league, teamId, name, slug) {
  const [t, news, prev, city, splits, leaders, moves] = await Promise.all([
    getJson(`https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/teams/${teamId}`, true).then((d) => d.team || {}),
    clubNews(slug, name, espnNews(sport, league, teamId, name).catch((e) => { console.error(`news: ${league}/${teamId} skipped — ${e.message}`); return []; })),
    espnPrev(sport, league, teamId).catch((e) => { console.error(`prev: ${league}/${teamId} skipped — ${e.message}`); return null; }),
    espnHomeCity(sport, league, teamId).catch((e) => { console.error(`city: ${league}/${teamId} skipped — ${e.message}`); return null; }),
    espnSplits(sport, league, teamId).catch((e) => { console.error(`splits: ${league}/${teamId} skipped — ${e.message}`); return {}; }),
    espnLeaders(sport, league, teamId).catch((e) => { console.error(`leaders: ${league}/${teamId} skipped — ${e.message}`); return []; }),
    espnMoves(sport, league, teamId).catch((e) => { console.error(`moves: ${league}/${teamId} skipped — ${e.message}`); return []; }),
  ]);
  const items = t.record?.items || [];
  const total = items.find((i) => i.type === 'total') || items[0];
  const home = items.find((i) => i.type === 'home');
  const club = { ...(t.displayName ? { name: t.displayName } : {}), ...(t.abbreviation ? { abbr: t.abbreviation } : {}), ...(city ? { city } : {}) }; // as the league lists them: "Washington Huskies", WASH, Seattle, WA
  return { record: total?.summary, standing: t.standingSummary, ...(home?.summary ? { home: home.summary } : {}), ...splits, ...(leaders.length ? { leaders } : {}), ...(moves.length ? { moves } : {}), ...(news.length ? { news } : {}), ...(prev ? { prev } : {}), ...(Object.keys(club).length ? { club } : {}) };
}
// ESPN names a season by the year it starts in; hockey and football seasons
// start in the autumn, so from January to June the season in progress is
// last year's number. The previous season is the one before that.
export function seasonStartYear(sport, date = new Date()) {
  const y = date.getFullYear();
  return /^(hockey|football)$/.test(sport) && date.getMonth() < 6 ? y - 1 : y;
}
// The number ESPN's core API files the season in progress under: the start
// year, except hockey, which it names by the year the season ends (the
// Kraken's 2026–27 is seasons/2027; seasons/2026 is 2025–26 — verified
// 2026-10-05 against the records).
export function espnSeason(sport, date = new Date()) {
  return seasonStartYear(sport, date) + (sport === 'hockey' ? 1 : 0);
}
// The season's record against the division and the conference, where the
// league has them — ESPN's core record carries "vs. Div." for the NHL and
// NFL, "vs. Conf." for the NFL and college football, neither for MLB (the
// Mariners' comes from the results, divisionRecord below), the WNBA or the
// soccer leagues. { vsDiv?: '16-9-1', vsConf?: '9-3' }
export function pickSplits(items) {
  const out = {};
  for (const i of items || []) {
    if (!i?.summary) continue;
    if (/^vsdiv$/i.test(i.type || '') || /^vs\.? div/i.test(i.name || '')) out.vsDiv = i.summary;
    else if (/^vsconf$/i.test(i.type || '') || /^vs\.? conf/i.test(i.name || '')) out.vsConf = i.summary;
  }
  return out;
}
async function espnSplits(sport, league, teamId) {
  const d = await getJson(`https://sports.core.api.espn.com/v2/sports/${sport}/leagues/${league}/seasons/${espnSeason(sport)}/types/2/teams/${teamId}/record`, true);
  return pickSplits(d.items);
}
// The season's leaders among the club's players, from ESPN's core leaders
// feed — the categories a fan asks after, by sport, each the top player with
// the figure, in words a reader needn't decode: [{ stat: 'Home runs', name:
// 'Randy Arozarena', value: '26', pos?: 'LF' }]. The feed names the player
// only by a link, so each leader's record is fetched once for the name.
export const LEADER_CATS = {
  baseball: [['homeRuns', 'Home runs'], ['RBIs', 'RBI'], ['avg', 'Average'], ['wins', 'Wins'], ['ERA', 'ERA'], ['strikeouts', 'Strikeouts']],
  hockey: [['goals', 'Goals'], ['assists', 'Assists'], ['points', 'Points'], ['savePct', 'Save pct'], ['wins', 'Wins']],
  football: [['passingYards', 'Passing yds'], ['rushingYards', 'Rushing yds'], ['receivingYards', 'Receiving yds'], ['sacks', 'Sacks'], ['interceptions', 'Picks'], ['totalTackles', 'Tackles']],
  basketball: [['pointsPerGame', 'Points'], ['reboundsPerGame', 'Rebounds'], ['assistsPerGame', 'Assists'], ['stealsPerGame', 'Steals'], ['blocksPerGame', 'Blocks']],
  soccer: [['goals', 'Goals'], ['assists', 'Assists'], ['saves', 'Saves']],
};
// the categories picked out of the feed, each with its leader's figure and the link to the player: [{ stat, value, ref }]
export function pickLeaders(sport, categories) {
  const out = [];
  for (const [key, stat] of LEADER_CATS[sport] || []) {
    const c = (categories || []).find((x) => x.name === key), l = c?.leaders?.[0], ref = l?.athlete?.$ref;
    if (!ref || l.displayValue == null || /^[-0.,]*$/.test(String(l.displayValue))) continue; // nothing yet: a dash or a zero before the season
    out.push({ stat, value: String(l.displayValue), ref });
  }
  return out;
}
async function espnLeaders(sport, league, teamId) {
  const d = await getJson(`https://sports.core.api.espn.com/v2/sports/${sport}/leagues/${league}/seasons/${espnSeason(sport)}/types/2/teams/${teamId}/leaders`, true);
  const picked = pickLeaders(sport, d.categories), refs = [...new Set(picked.map((x) => x.ref))], who = {};
  const players = await Promise.all(refs.map((r) => getJson(r.replace(/^http:/, 'https:'), true).catch(() => null)));
  refs.forEach((r, i) => { who[r] = players[i]; });
  return picked.map(({ stat, value, ref }) => {
    const a = who[ref];
    return a?.displayName ? { stat, value, name: a.displayName, ...(a.position?.abbreviation ? { pos: a.position.abbreviation } : {}) } : null;
  }).filter(Boolean);
}
// The record against a set of opponents, from the season's results — the
// Mariners' AL West, which ESPN's record leaves out: 'W-L' (with a third
// figure for the draws where a sport has them), or null with no such game.
export const DIVISION = Object.fromEntries(CITY.teams.filter((t) => t.division).map((t) => [t.slug, t.division])); // the Mariners' AL West, by the abbreviations the schedule carries
export function divisionRecord(games, opps) {
  let w = 0, l = 0, d = 0;
  for (const g of games || []) {
    if (!g.res || g.pre || g.playoff || !opps.includes(g.opp?.abbrev)) continue;
    if (g.res.won) w++; else if (g.res.us === g.res.them) d++; else l++;
  }
  return w + l + d ? [w, l].concat(d ? [d] : []).join('-') : null;
}
// Last season's line: { season: '2025' | '2025–26', record, seed?, rank? }.
// The core API's record has the summary and a playoff seed; the soccer
// leagues have no record there, so their standings table gives rank and
// W-L-D instead.
async function espnPrev(sport, league, teamId) {
  const start = espnSeason(sport) - 1; // the number before the season in progress — hockey's is named by its end year (the Kraken's line read 2024–25's record as 2025–26 until 2026-10-05)
  const season = sport === 'hockey' ? `${start - 1}–${String(start).slice(2)}` : String(start);
  const d = await getJson(`https://sports.core.api.espn.com/v2/sports/${sport}/leagues/${league}/seasons/${start}/types/2/teams/${teamId}/record`, true);
  const total = (d.items || []).find((i) => i.type === 'total') || (d.items || [])[0];
  if (total?.summary) {
    const seed = (total.stats || []).find((x) => x.name === 'playoffSeed')?.value;
    return { season, record: total.summary, ...(seed ? { seed: Number(seed) } : {}) };
  }
  if (sport !== 'soccer') throw new Error('no record');
  const st = await getJson(`https://site.api.espn.com/apis/v2/sports/${sport}/${league}/standings?season=${start}`, true);
  const groups = st.children?.length ? st.children.flatMap((c) => c.standings?.entries || []) : (st.standings?.entries || []);
  const e = groups.find((x) => String(x.team?.id) === String(teamId));
  if (!e) throw new Error('not in standings');
  const stat = (n) => (e.stats || []).find((x) => x.name === n)?.value;
  const rank = stat('rank');
  return { season, record: [stat('wins'), stat('losses'), stat('ties')].map((v) => (v == null ? 0 : v)).join('-'), ...(rank ? { rank: Number(rank) } : {}) };
}
// The club's big moves from the league's transactions feed (ESPN's site
// API lists the whole league, newest first, each tagged with the team):
// only the ones a fan would call news — a manager or coach fired or hired,
// a front-office change, a trade, a free agent signed to the big club, an
// extension, a retirement. The daily traffic (IL, recalls, options, waivers,
// DFA, activations, minor-league deals) is left out, and each kept move is
// cut to its first sentence, a line of four or so words (Steve, 2026-10-05:
// "only huge changes (coaches, records broken????)" — the routine list was
// "too ugly/detailed to read"). [{ date, text }]
const ROUTINE = /\b(injured list|\bIL\b|recalled|optioned|outrighted|waivers|designated .* for assignment|activated|reinstated|hardship|two-way|minor[- ]league|player development|practice squad|reserve\/|exempt list|assigned|loaned|transferred|sent .* to|selected the contract|purchased the contract)\b/i;
const BIG = /\b(fired|dismissed|hired|named|appointed|promoted|trad(ed|es)|acquired|extension|extended|retire[ds]?|free agent|signed .* to a (one|two|three|four|five|six|seven|\d)-year|released (manager|head coach))\b/i;
const STAFF = /\b(manager|head coach|coach|general manager|president|coordinator|director)\b/i;
export function bigMove(text) {
  const t = String(text || '');
  if (!BIG.test(t)) return false;
  if (/\b(fired|dismissed|hired|named|appointed|promoted)\b/i.test(t) && !STAFF.test(t)) return false; // "named to the roster" is not a hiring
  return !ROUTINE.test(t) || /\b(fired|hired|trad(ed|es)|extension|retire)/i.test(t);
}
export function shortMove(text) {
  let t = String(text || '').trim().split(/(?<=[a-z\)])\.\s+(?=[A-Z])/)[0].replace(/\.+$/, ''); // the first sentence
  const coaches = (t.match(/\bcoach\b/gi) || []).length;
  if (coaches >= 2 && /^(Fired|Hired|Named|Promoted)\b/i.test(t)) t = t.replace(/^(\w+)\b.*/s, `$1 ${coaches} coaches`); // "Fired bench coach A, infield coach B, …" → "Fired 4 coaches"
  t = t.replace(/\b(RHP|LHP|SS|1B|2B|3B|OF|RF|LF|CF|DH|C|INF|UTL|G|F|QB|RB|WR|TE|OL|DL|LB|CB|S|K|P|D|LW|RW|RW\/C|C\/RW)\s+(?=[A-Z])/g, ''); // positions out: the name is the news
  return t.length > 60 ? t.slice(0, 57).replace(/[\s,;:]+\S*$/, '') + '…' : t;
}
export function pickMoves(transactions, teamId, n = 3) {
  return (transactions || []).filter((t) => t && t.description && String(t.team?.id) === String(teamId) && bigMove(t.description))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, n).map((t) => {
      const club = (t.team?.links || []).find((l) => (l.rel || []).includes('clubhouse') && (l.rel || []).includes('desktop'))?.href || '';
      const url = club.replace('/team/_/', '/team/transactions/_/'); // the feed has no link per move; ESPN's page of the club's transactions is the source
      return { date: easternDate(t.date), text: shortMove(t.description), ...(url ? { url } : {}) }; // ESPN stamps a move at 07:00Z (the small hours Eastern): the Eastern day is the move's day, the city's would be the night before west of Pacific Daylight Time (Honolulu, 2026-10-11)
    });
}
async function espnMoves(sport, league, teamId) {
  const d = await getJson(`https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/transactions?limit=300`, true);
  return pickMoves(d.transactions, teamId, 3);
}
// ESPN's news feed tagged with the team: the latest few written pieces
// (stories, recaps, previews, headline news — video clips left out), the
// ones that name the club first, newest first. [{ date, headline, text, url }]
// Eight: the page shows three and folds the rest behind an arrow.
export function pickNews(articles, name, n = 8) {
  const re = new RegExp(String(name || '').split(/\s+/).pop() || '.', 'i');
  return (articles || [])
    .filter((a) => a && a.headline && a.links?.web?.href && !/^(Media|Video)$/i.test(a.type || ''))
    .sort((a, b) => (re.test(b.headline + ' ' + (b.description || '')) - re.test(a.headline + ' ' + (a.description || ''))) || String(b.published || '').localeCompare(String(a.published || '')))
    .slice(0, n)
    .map((a) => ({ date: a.published ? seattleDate(a.published) : '', headline: a.headline, text: a.description || '', url: a.links.web.href, source: 'ESPN', at: a.published || '' }));
}
async function espnNews(sport, league, teamId, name) {
  const d = await getJson(`https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/news?team=${teamId}&limit=12`, true);
  return pickNews(d.articles, name);
}
// The other outlets' feeds — RSS 2.0 (the Seattle Times, MLB.com,
// seahawks.com, Sound Of Hockey, Sounder at Heart) or Atom (SB Nation's
// Lookout Landing and Field Gulls) — read with one tolerant parser: an
// <item> or <entry>; the title and summary CDATA or entity-escaped, tags
// stripped; the link as text or as an href; the date as pubDate or
// published, filed under its Seattle day. [{ date, headline, text, url, source }]
const unent = (x) => String(x || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
  .replace(/&#(x[0-9a-f]+|\d+);/gi, (m, c) => String.fromCodePoint(c[0] === 'x' || c[0] === 'X' ? parseInt(c.slice(1), 16) : Number(c)))
  .replace(/&(amp|lt|gt|quot|apos|nbsp|hellip|rsquo|lsquo|rdquo|ldquo|ndash|mdash);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—' })[e])
  .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
export function parseFeed(xml, source, n = 8) {
  const out = [];
  for (const m of String(xml).matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) {
    const it = m[2], tag = (t) => (it.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`)) || [])[1];
    const headline = unent(tag('title'));
    const url = unent(tag('link')) || (it.match(/<link[^>]*\shref="([^"]+)"/) || [])[1];
    if (!headline || !url) continue;
    const when = new Date(unent(tag('pubDate') || tag('published') || tag('updated') || tag('dc:date')));
    const text = unent(tag('description') || tag('summary') || tag('content:encoded') || tag('content'));
    out.push({ date: isNaN(when) ? '' : seattleDate(when.toISOString()), headline, text: text.length > 240 ? text.slice(0, 237).replace(/\s+\S*$/, '') + '…' : text, url: url.replace(/[?&]utm_[^&#]*/g, '').replace(/\?$/, ''), source, at: isNaN(when) ? '' : when.toISOString() });
  }
  return out.slice(0, n);
}
async function feedNews(url, source) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return parseFeed(await r.text(), source);
}
// the outlets per club, beside ESPN (seattlesports.com refuses scripts — 403)
const ST = (path) => [`https://www.seattletimes.com/sports/${path}/feed/`, 'Seattle Times'];
const FEEDS = Object.fromEntries(CITY.teams.filter((t) => t.news).map((t) => [t.slug, t.news]));
// Every source's pieces in one list, newest first by the time of posting
// (`at`, dropped from the output; a tie keeps the order given), each URL
// once, and only the significant ones: a piece has to name the club (the
// nickname, in the headline or the summary) and not be league-wide
// filler — trackers, power rankings, photo galleries, podcasts, charts.
// Eight at most: the page shows what fits beside the game and folds the
// rest behind the arrow.
const FILLER = /^(photos?|video|watch|podcast|listen|gallery)\b|\btracker\b|power rankings|\bchart\b|\bpodcast\b|\bmailbag\b|\bopen thread\b|\bgame thread\b|\bcooler guild\b/i;
export function mergeNews(lists, name, n = 8) {
  const club = new RegExp(String(name || '').split(/\s+/).pop() || '.', 'i');
  const seen = new Set(), all = [];
  for (const a of lists.flat()) {
    const k = a.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
    if (seen.has(k) || FILLER.test(a.headline) || !club.test(a.headline + ' ' + (a.text || ''))) continue;
    seen.add(k); all.push(a);
  }
  return all.sort((a, b) => (b.at || b.date).localeCompare(a.at || a.date) || b.date.localeCompare(a.date)).slice(0, n).map(({ at, ...a }) => a);
}
async function clubNews(slug, name, espn) {
  const lists = await Promise.all([espn, ...(FEEDS[slug] || []).map(([url, source]) => feedNews(url, source).catch((e) => { console.error(`news: ${source} (${slug}) skipped — ${e.message}`); return []; }))]);
  return mergeNews(lists, name);
}
const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
// A HockeyTech standings row → the form block. The PWHL reads its record
// RW-OTW-OTL-L and ranks the whole league; the WHL reads W-L-OTL-SOL and
// ranks within the conference (the row names it: "Western Conference").
export function hockeytechForm(r, league) {
  const whl = league !== 'pwhl';
  const n = Number(r.rank || r.overall_rank);
  const where = whl ? (r.conference_name || 'the league').replace(/^(?!the )/i, 'the ') : 'the PWHL';
  const club = { ...(r.name ? { name: String(r.name).replace(/^[a-z]+ - /i, '') } : {}), ...(r.team_code ? { abbr: r.team_code } : {}) }; // the standings row's name carries a clinch prefix ("x - ") in season
  const record = whl ? [r.wins, r.losses, r.ot_losses, r.shootout_losses].join('-') : [r.regulation_wins, r.non_reg_wins, r.non_reg_losses, r.losses].join('-');
  return { record, standing: n ? `${ordinal(n)} in ${where}` : undefined, ...(whl && r.home_record ? { home: String(r.home_record).replace(/\s+/g, '') } : {}), club };
}
async function hockeytechFormFetch(league, key, teamId, slug, label) {
  const base = HT(league, key);
  const seasons = await hockeytechSeasons(base);
  const reg = seasons.find(htRegular);
  if (!reg) throw new Error('no regular season listed');
  const rows = (await getJson(`${base}&view=statviewtype&type=standings&stat=conference&season_id=${reg.id}`)).SiteKit?.Statviewtype || [];
  const r = rows.find((x) => String(x.team_id) === String(teamId));
  if (!r) throw new Error('team not in standings');
  const news = await clubNews(slug, label, Promise.resolve([]));
  return { ...hockeytechForm(r, league), ...(news.length ? { news } : {}) };
}
const pwhlForm = (teamId, slug, label) => hockeytechFormFetch('pwhl', '446521baf8c38984', teamId, slug, label);

// DigitalShift (the Washington Wolfpack's league, Arena Football One, runs
// its stats there): a login with the site's public client_service_id returns
// a ticket, and /events?team_id= lists the season's games — started_at_tz is
// the true instant (started_at is the local wall clock mislabelled UTC),
// day_class says home or away, name reads "Home vs Away", status "W 33-16"
// (winner's score first). No venue in the feed: the club's own ground stands
// in for home games.
export function normalizeDigitalshift(events, homeVenue, now = Date.now()) {
  return (events || []).filter((g) => g.$type === 'game' && g.started_at_tz).map((g) => {
    const when = new Date(g.started_at_tz);
    const home = g.day_class === 'game-home';
    const oname = String(g.opp_team_name || '').trim();
    const m = String(g.status || '').match(/^([WLT])\s+(\d+)\s*-\s*(\d+)/);
    const res = m ? { us: Number(m[1] === 'L' ? m[3] : m[2]), them: Number(m[1] === 'L' ? m[2] : m[3]), won: m[1] === 'W' } : null;
    const short = oname.split(/\s+/).slice(1).join(' ') || oname;
    return withResult({
      date: seattleDate(when), time: seattleTime(when), tbd: false, home,
      ...(g.playoff || /playoff|championship|semi-?final/i.test(g.name || '') ? { playoff: true } : {}),
      opp: { name: oname, short, abbrev: short.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase(),
        ...(g.opp_team_logo_url?.medium || g.opp_team_logo_url?.full ? { logo: g.opp_team_logo_url.medium || g.opp_team_logo_url.full } : {}) },
      ...(home && homeVenue ? { venue: homeVenue } : {}),
    }, res);
  }).filter((g) => Math.abs(new Date(g.date) - now) < 300 * 86400e3).sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
}
async function digitalshiftEvents(service, teamId) {
  const login = await fetch('https://web.api.digitalshift.ca/login', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA }, body: JSON.stringify({ client_service_id: service }) });
  if (!login.ok) throw new Error(`login HTTP ${login.status}`);
  const hash = (await login.json()).ticket?.hash;
  if (!hash) throw new Error('no ticket');
  const r = await fetch(`https://web.api.digitalshift.ca/events?team_id=${teamId}`, { headers: { authorization: `ticket="${hash}"`, accept: 'application/json', 'user-agent': UA } });
  if (!r.ok) throw new Error(`events HTTP ${r.status}`);
  return (await r.json()).events || [];
}
async function digitalshift(service, teamId, homeVenue) {
  const games = normalizeDigitalshift(await digitalshiftEvents(service, teamId), homeVenue);
  if (!games.length) throw new Error('no games listed');
  return games;
}
async function digitalshiftForm(service, teamId, slug, label) {
  const games = normalizeDigitalshift(await digitalshiftEvents(service, teamId)).filter((g) => g.res && !g.playoff);
  const w = games.filter((g) => g.res.won).length, l = games.length - w;
  const news = await clubNews(slug, label, Promise.resolve([]));
  return { ...(games.length ? { record: `${w}-${l}` } : {}), ...(news.length ? { news } : {}) };
}
// The season's Wikipedia page, whose lead paragraph is the form block's
// summary (CC BY-SA — the site links the page). One page per season:
// "2026 Seattle Mariners season", or "2026–27 Seattle Kraken season" for a
// season that straddles the year end — the years come from the schedule.
// (NFL seasons are titled by the year they start in, though they run into
// January.)
const WIKI = Object.fromEntries(CITY.teams.filter((t) => t.wiki).map((t) => [t.slug, t.wiki.title]));
const WIKI_START_YEAR = Object.fromEntries(CITY.teams.filter((t) => t.wiki && t.wiki.startYear).map((t) => [t.slug, true]));
const WIKI_CLUB = Object.fromEntries(CITY.teams.filter((t) => t.wiki && t.wiki.club).map((t) => [t.slug, t.wiki.title])); // clubs with no season pages: their own article instead
const WIKI_TEAM_PAGE = Object.fromEntries(CITY.teams.filter((t) => t.wiki && t.wiki.teamPage).map((t) => [t.slug, true])); // college seasons are titled "2026 Washington Huskies football team", not "… season"
export function wikiTitle(slug, games) {
  if (WIKI_CLUB[slug]) return WIKI_CLUB[slug];
  if (WIKI_TEAM_PAGE[slug]) return games?.length ? `${games[0].date.slice(0, 4)} ${WIKI[slug]} team` : null;
  if (!WIKI[slug] || !games?.length) return null;
  const y1 = games[0].date.slice(0, 4), y2 = games[games.length - 1].date.slice(0, 4);
  return `${y1 === y2 || WIKI_START_YEAR[slug] ? y1 : `${y1}–${y2.slice(2)}`} ${WIKI[slug]} season`;
}
async function wikiSummary(title) {
  const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`,
    { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  if (d.type !== 'standard' || !d.extract) throw new Error(d.type || 'no extract');
  return { title, text: d.extract, url: d.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}` };
}

// The Seawolves' news page (Next.js, server-rendered): each post is an
// <a href="/news/…"> holding a tag, "SEP 1, 2026", an <h2> headline and a
// line of summary. The latest eight, newest first.
export function parseSeawolvesNews(html, n = 8) {
  const out = [];
  for (const m of String(html).replace(/<!--\s*-->/g, '').matchAll(/<a href="(\/news\/[^"]+)">([\s\S]*?)<\/a>/g)) {
    const inner = m[2];
    const headline = (inner.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) || [])[1];
    const date = (inner.match(/>\s*([A-Z]{3} \d{1,2}, \d{4})\s*</) || [])[1];
    const text = (inner.match(/<\/h2>\s*<p[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '';
    if (!headline) continue;
    const d = date ? new Date(date.replace(/^(\w{3})/, (x) => x[0] + x.slice(1).toLowerCase()) + ' UTC') : null;
    const clean = (x) => x.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;|’/g, "'").replace(/\s+/g, ' ').trim();
    if (out.some((o) => o.url.endsWith(m[1]))) continue;
    out.push({ date: d && !isNaN(d) ? d.toISOString().slice(0, 10) : '', headline: clean(headline), text: clean(text), url: 'https://www.seawolves.rugby' + m[1], source: 'Seawolves' });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date)).slice(0, n);
}
async function seawolvesForm() {
  const r = await fetch('https://www.seawolves.rugby/news', { headers: { 'user-agent': UA, accept: 'text/html' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text(), news = parseSeawolvesNews(html);
  const title = (html.match(/<title>([^<|]+)/) || [])[1] || '', name = title.replace(/\s+Rugby Club.*$/i, '').trim(); // "Seattle Seawolves Rugby Club | …" → Seattle Seawolves
  return { ...(news.length ? { news } : {}), ...(name ? { club: { name } } : {}) };
}

// Each team's record/standing fetcher, by the kind city.js names
const FORM_KINDS = {
  espn: (t) => espnForm(t.espn.sport, t.espn.league, Number(t.espn.id), t.label, t.slug),
  pwhl: (t) => pwhlForm(t.form.id, t.slug, t.label),
  hockeytech: (t) => hockeytechFormFetch(t.form.league, t.form.key, t.form.id, t.slug, t.label),
  gamesheet: (t) => gamesheetFormFetch(t.form.league, t.form.key, t.form.id, t.form.division, t.slug, t.label),
  milb: (t) => milbForm(t.form.league, t.form.id, t.form.leagueName, t.slug, t.label),
  digitalshift: (t) => digitalshiftForm(t.form.service, t.form.id, t.slug, t.label),
  seawolves: () => seawolvesForm(),
  lnbp: (t) => lnbpForm(t.form.id),
};
export const FORM = CITY.teams.filter((t) => t.form && FORM_KINDS[t.form.kind]).map((t) => ({ slug: t.slug, fetch: () => FORM_KINDS[t.form.kind](t) }));

// Seattle Seawolves (Major League Rugby, seawolves.rugby): the schedule
// page is server-rendered — an "Upcoming Matches" list of the season's
// fixtures (one card each: Round N, the two clubs' crests with title="…",
// the ground or "Away", "Sat, Mar 28", "4:00 PM PT") and a "Previous
// Matches" list of results ("34 - 43", Win/Loss). The home side's crest
// comes first. Round 0 is the preseason friendly, kept and flagged pre
// like every other league's preseason. The year is the page's heading.
const SEAWOLVES_URL = 'https://www.seawolves.rugby/schedule';
const SEAWOLVES_HOME = 'Starfire Stadium';
const SEAWOLVES_CITY = 'Tukwila, WA'; // Starfire Sports is in Tukwila, on the Green River just south of Seattle (en.wikipedia.org/wiki/Starfire_Sports, checked 2026-09-14)
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// The MLR clubs of 2026 — six — each with its own site and the crest the
// Seawolves' site carries for it; the names the schedule page uses vary
// ("CA Legion" / "California Legion"), so they are matched loosely.
const MLR_CLUBS = [
  { match: /legion/i, name: 'California Legion', short: 'Legion', abbrev: 'CAL', site: 'https://legion.rugby/', logo: 'https://www.seawolves.rugby/images/teams/legions.png' },
  { match: /hounds/i, name: 'Chicago Hounds', short: 'Hounds', abbrev: 'CHI', site: 'https://chicagohounds.com/', logo: 'https://www.seawolves.rugby/images/teams/Hounds.png' },
  { match: /free jacks|freejacks/i, name: 'New England Free Jacks', short: 'Free Jacks', abbrev: 'NE', site: 'https://freejacks.com/', logo: 'https://www.seawolves.rugby/images/teams/freejacks.png' },
  { match: /old glory/i, name: 'Old Glory DC', short: 'Old Glory', abbrev: 'DC', site: 'https://oldglorydc.com/', logo: 'https://www.seawolves.rugby/images/teams/og.png' },
  { match: /anthem/i, name: 'Anthem Rugby Carolina', short: 'Anthem', abbrev: 'ANT', site: 'https://anthemrc.com/', logo: 'https://www.seawolves.rugby/images/teams/anthem.webp' },
];
export function mlrOpp(name, logo) { // the club for a name the schedule page prints, or a best effort for one not on the list
  const c = MLR_CLUBS.find((x) => x.match.test(name || ''));
  if (c) return { name: c.name, short: c.short, abbrev: c.abbrev, logo: logo || c.logo, site: c.site };
  const opp = String(name || '');
  return { name: opp, short: opp.replace(/^(New England|Old Glory|Anthem Rugby|Anthem|Chicago|California|CA|Hartford)\s+/, '') || opp, abbrev: opp.replace(/[^A-Za-z ]/g, '').split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase(), ...(logo ? { logo } : {}), site: `https://www.majorleague.rugby/teams/${mlrSlug(opp)}` };
}
const mlrSlug = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export function parseSeawolves(html) {
  const h = String(html).replace(/<!--\s*-->/g, '');
  const year = Number((h.match(/<h1[^>]*>\s*(\d{4})\s*Seawolves/) || [])[1]) || new Date().getFullYear();
  const cards = h.split(/<div class="\s*relative mb-4 p-4 shadow-sm rounded-md[^"]*"/).slice(1);
  // the page carries each section twice (once more for hydration): a card
  // belongs to the nearest heading above it, and fixtures are de-duplicated
  const heads = [...h.matchAll(/(Upcoming|Previous) Matches/g)].map((m) => [m.index, m[1]]);
  const sectionAt = (p) => { let t = 'Upcoming'; for (const [i, k] of heads) { if (i < p) t = k; else break; } return t; };
  const dateOf = (l) => { const m = l.match(/^[A-Z][a-z]{2}, ([A-Z][a-z]{2}) (\d{1,2})$/); if (!m || MONTHS[m[1].toLowerCase()] == null) return null; return `${year}-${String(MONTHS[m[1].toLowerCase()] + 1).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`; };
  const timeOf = (l) => { const m = l.match(/^(\d{1,2}):(\d{2}) ([AP])M/); if (!m) return null; let hr = Number(m[1]) % 12; if (m[3] === 'P') hr += 12; return `${String(hr).padStart(2, '0')}:${m[2]}:00`; };
  let pos = 0;
  const games = [], results = {}, played = [];
  for (const c of cards) {
    pos = h.indexOf(c, pos); const previous = sectionAt(pos) === 'Previous';
    const round = Number((c.match(/Round\s*(\d+)/) || [])[1]);
    const teams = [...c.matchAll(/<img title="([^"]+)"/g)].map((m) => m[1].trim());
    const spans = [...c.matchAll(/<(?:span|p)[^>]*>([^<]+)<\/(?:span|p)>/g)].map((m) => m[1].trim()).filter(Boolean);
    const date = spans.map(dateOf).find(Boolean), time = spans.map(timeOf).find(Boolean);
    if (teams.length < 2 || !date) continue;
    const home = /seawolves/i.test(teams[0]);
    const opp = teams.find((t) => !/seawolves/i.test(t)) || '?';
    const venue = spans.find((x) => x !== 'Away' && !/^VS\.?$/i.test(x) && !dateOf(x) && !timeOf(x) && !/^Round/.test(x) && !/^(Win|Loss|Draw)$/.test(x) && !/^\d+ - \d+$/.test(x)) || (home ? SEAWOLVES_HOME : opp);
    if (previous) { // a result: the score reads home - away
      const sc = spans.find((x) => /^\d+ - \d+$/.test(x));
      if (sc) { const [a, b] = sc.split(' - ').map(Number); results[date] = { us: home ? a : b, them: home ? b : a, won: (home ? a : b) > (home ? b : a) }; }
      if (!played.some((p) => p.date === date)) played.push({ date, time: time || null, home, opp, venue, round });
      continue;
    }
    if (games.some((g) => g.date === date && g.opp.name === opp)) continue; // the hydration copy
    games.push({
      date, time: time || null, tbd: !time, home, ...(round === 0 ? { pre: true } : {}),
      opp: mlrOpp(opp, (c.match(/<img title="(?:[^"]+)" src="([^"]+)"[^>]*>\s*<p[^>]*>VS\.<\/p>\s*<img title="[^"]+" src="([^"]+)"/) || [])[home ? 2 : 1]),
      venue, ...(home && venue === SEAWOLVES_HOME ? { city: SEAWOLVES_CITY } : {}),
    });
  }
  // a played match with no fixture in the list (the playoffs are only ever
  // in the results) is a game too, flagged as a playoff when it follows the
  // last listed fixture
  const lastFixture = games.map((g) => g.date).sort().pop() || '';
  played.filter((p) => !games.some((g) => g.date === p.date)).forEach((p) => games.push({
    date: p.date, time: p.time, tbd: !p.time, home: p.home, ...(p.round === 0 ? { pre: true } : p.date > lastFixture ? { playoff: true } : {}),
    opp: mlrOpp(p.opp, p.logo),
    venue: p.venue,
  }));
  games.forEach((g) => { if (results[g.date]) g.res = results[g.date]; });
  games.forEach((g) => { if (g.opp.logo && g.opp.logo.startsWith('/')) g.opp.logo = 'https://www.seawolves.rugby' + g.opp.logo; });
  return games.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
}
async function seawolves() {
  const r = await fetch(SEAWOLVES_URL, { headers: { 'user-agent': UA, accept: 'text/html' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const games = parseSeawolves(await r.text());
  if (!games.length) throw new Error('no matches parsed');
  return games;
}

// Each team's season schedule fetcher, by the kind city.js names
const SEASON_KINDS = {
  mlb: (t) => mlb(t.season.id, t.season.sportId || 1),
  nhl: (t) => nhl(t.season.abbrev),
  espn: (t) => espn(t.espn.sport, t.espn.league, Number(t.espn.id)),
  pwhl: (t) => pwhl(t.season.id),
  hockeytech: (t) => hockeytech(t.season.league, t.season.key, t.season.id, WHL_OPTS(t.season.league), t.season.leagueName || t.season.league.toUpperCase()),
  gamesheet: (t) => gamesheet(t.season.league, t.season.key, t.season.id, t.season.division, t.season.leagueName || 'the league'),
  digitalshift: (t) => digitalshift(t.season.service, t.season.id, t.venue),
  seawolves: () => seawolves(),
  lnbp: (t) => lnbpSeason(t.season.id),
};
export const SOURCES = CITY.teams.filter((t) => t.season && SEASON_KINDS[t.season.kind]).map((t) => ({ slug: t.slug, fetch: () => SEASON_KINDS[t.season.kind](t) }));

// Marks feed events whose team's league lists that home date as TBD, and
// copies the game's broadcasts onto them. bySlug: { mariners: [{date, tbd,
// watch?}], ... } — HOME games only. Returns how many were flagged.
export function applyScheduleFlags(events, bySlug) {
  let flagged = 0;
  for (const e of events) {
    const team = TEAMS.find((t) => t.re.test(e.title || ''));
    const sched = team && bySlug[team.slug];
    if (!sched) continue;
    const game = sched.find((g) => g.date === e.date);
    if (!game) continue;
    if (game.tbd && !e.dateTbd) { e.dateTbd = true; flagged++; }
    if (game.watch) e.watch = game.watch;
  }
  return flagged;
}

// Fetches every team's season, flags the feed from the home games, and
// returns { teams: { mariners: [game, ...], ... }, form: { mariners: {
// record, standing }, ... } } — teams that failed this run left out of
// either map — for site/teams.json.
export async function applySchedules(events) {
  const bySlug = {}, seasons = {}, form = {};
  const [results, forms] = await Promise.all([
    Promise.allSettled(SOURCES.map((s) => s.fetch())),
    Promise.allSettled(FORM.map((s) => s.fetch())),
  ]);
  forms.forEach((r, i) => {
    if (r.status === 'fulfilled' && (r.value.record || r.value.standing || (r.value.news && r.value.news.length))) form[FORM[i].slug] = r.value;
    else console.error(`form: ${FORM[i].slug} skipped — ${r.status === 'rejected' ? (r.reason?.message || r.reason) : 'empty'}`);
  });
  results.forEach((r, i) => {
    const slug = SOURCES[i].slug;
    if (r.status === 'fulfilled') {
      seasons[slug] = r.value;
      bySlug[slug] = r.value.filter((g) => g.home);
      const cities = {}; bySlug[slug].forEach((g) => { if (g.city) cities[g.city] = (cities[g.city] || 0) + 1; }); // the home ground's city, as the league lists it (the commonest, for a club with a neutral-site "home" game)
      const city = Object.keys(cities).sort((a, b) => cities[b] - cities[a])[0];
      if (city) form[slug] = { ...(form[slug] || {}), club: { ...((form[slug] || {}).club || {}), city } };
      const div = DIVISION[slug] && !(form[slug] || {}).vsDiv ? divisionRecord(r.value, DIVISION[slug]) : null; // the division record the league's feed doesn't give, from the results
      if (div) form[slug] = { ...(form[slug] || {}), vsDiv: div };
      const tbd = bySlug[slug].filter((g) => g.tbd).length;
      console.error(`schedules: ${slug} ${r.value.length} games, ${bySlug[slug].length} home, ${tbd} TBD`);
    } else {
      console.error(`schedules: ${slug} skipped — ${r.reason?.message || r.reason}`);
    }
  });
  await cleanMarks(seasons); // the opponents' crests, served locally without their ™ (scripts/marks.mjs)
  // the recent games' highlight clips (scripts/highlights.mjs); the ones on
  // the published file are carried forward, so the last run's stand in
  let prev = {};
  try { prev = JSON.parse(readFileSync(new URL('../site/teams.json', import.meta.url), 'utf8')).teams || {}; } catch (e) { /* first run */ }
  try { await addClips(seasons, prev); } catch (e) { console.error(`clips: skipped — ${e.message}`); }
  // the season's Wikipedia lead, for every team whose season came through
  const slugs = Object.keys(seasons).filter((k) => wikiTitle(k, seasons[k]));
  const wikis = await Promise.allSettled(slugs.map((k) => wikiSummary(wikiTitle(k, seasons[k])).catch((e) => {
    if (WIKI[k] && !WIKI_CLUB[k]) return wikiSummary(WIKI[k]); // no page for the season yet: the club's own article
    throw e;
  })));
  wikis.forEach((r, i) => {
    if (r.status === 'fulfilled') form[slugs[i]] = { ...(form[slugs[i]] || {}), wiki: r.value };
    else console.error(`wiki: ${slugs[i]} skipped — ${r.reason?.message || r.reason}`);
  });
  const n = applyScheduleFlags(events, bySlug);
  const w = events.filter((e) => e.watch).length;
  console.error(`schedules: flagged ${n} feed event${n === 1 ? '' : 's'} as date TBD, ${w} with broadcasts`);
  return { teams: seasons, form };
}
