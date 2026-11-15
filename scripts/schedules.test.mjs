import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYoutube, matchYoutube, parseNflPage, titleDate } from './highlights.mjs';
import { pickMoves, bigMove, shortMove, applyScheduleFlags, pickBroadcasts, normalizeMlb, normalizeNhl, normalizeEspn, normalizePwhl, htRegular, pwhlOdds, hockeytechForm, normalizeGamesheet, gamesheetForm, normalizeDigitalshift, wikiTitle, pickNews, seasonStartYear, espnSeason, pickSplits, pickLeaders, divisionRecord, parseSeawolves, parseSeawolvesNews, seawolvesClubName, parseFeed, mergeNews } from './schedules.mjs';
const TP = globalThis.LQACity.key === 'twinpeaks' ? false : 'Twin Peaks data (here-core) — a real city keeps its own in scripts/city.test.mjs'; // the city-dependent cases below run on here-core's made-up town
// The fixtures' expected clocks are written in Seattle wall time; a sister
// city in another zone (city.js `tz`) reads the same instant on its own clock.
const TZ = globalThis.LQACity.tz || 'America/Los_Angeles';
function clock(date, time) {
  if (TZ === 'America/Los_Angeles') return { date, time };
  const [y, m, d] = date.split('-').map(Number), [h, mi, sec] = time.split(':').map(Number);
  let t = Date.UTC(y, m - 1, d, h, mi, sec);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  t -= Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - t; // Pacific wall → instant
  const dt = new Date(t);
  return { date: dt.toLocaleDateString('en-CA', { timeZone: TZ }), time: dt.toLocaleTimeString('en-GB', { timeZone: TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }) };
}

const feed = () => [
  { venue: 'Packard Field', title: 'Twin Peaks Loggers vs. Yakima Fir', date: '2026-12-07', time: '13:00:00' },
  { venue: 'Packard Field', title: 'Twin Peaks Loggers vs. Ellensburg Pines', date: '2026-12-25', time: '13:00:00' },
  { venue: 'Timber Arena', title: 'Twin Peaks Steelheads vs. Spokane Chiefs', date: '2026-12-07', time: '19:05:00' },
  { venue: 'Roadhouse', title: 'Chromatics', date: '2026-12-07', time: '21:00:00' },
];

test('a league TBD on the matching home date flags that game only', { skip: TP }, () => {
  const events = feed();
  const n = applyScheduleFlags(events, { loggers: [{ date: '2026-12-07', tbd: true }, { date: '2026-12-25', tbd: false }] });
  assert.equal(n, 1);
  assert.equal(events[0].dateTbd, true);
  assert.equal(events[1].dateTbd, undefined);
  assert.equal(events[2].dateTbd, undefined, 'same date, other team');
  assert.equal(events[3].dateTbd, undefined, 'same date, not a game');
});

test('teams with no schedule this run are left alone; an existing flag is kept', () => {
  const events = feed();
  events[1].dateTbd = true;
  const n = applyScheduleFlags(events, { mariners: [{ date: '2026-12-07', tbd: false }] });
  assert.equal(n, 0);
  assert.equal(events[1].dateTbd, true);
  assert.equal(events[2].dateTbd, undefined);
});

test('broadcasts: national first, then the home market; away feeds dropped; names once', () => {
  const w = pickBroadcasts([
    { kind: 'tv', name: 'Rangers Sports Network', home: false, national: false },
    { kind: 'tv', name: 'Mariners.TV', home: true, national: false },
    { kind: 'radio', name: 'Seattle Sports (710 AM)', home: true, national: false },
    { kind: 'tv', name: 'FOX', home: false, national: true },
    { kind: 'tv', name: 'Mariners.TV', home: true, national: false },
    { kind: 'radio', name: '105.3 The Fan', home: false, national: false },
  ]);
  assert.deepEqual(w, { tv: ['FOX', 'Mariners.TV'], radio: ['Seattle Sports (710 AM)'] });
  // on the road our feeds are the away-market ones; the hosts' regional network is the one to drop
  const away = pickBroadcasts([
    { kind: 'tv', name: 'NBC Sports CA', home: true, national: false },
    { kind: 'tv', name: 'Mariners.TV', home: false, national: false },
    { kind: 'radio', name: 'Seattle Sports (710 AM)', home: false, national: false },
    { kind: 'radio', name: "Talk 650 KSTE", home: true, national: false },
  ], false);
  assert.deepEqual(away, { tv: ['Mariners.TV'], radio: ['Seattle Sports (710 AM)'] });
});

test('broadcasts: nothing usable means no watch at all, and a missing kind is left out', () => {
  assert.equal(pickBroadcasts([]), undefined);
  assert.equal(pickBroadcasts([{ kind: 'tv', name: 'NBCSCA', home: false, national: false }]), undefined);
  assert.deepEqual(pickBroadcasts([{ kind: 'tv', name: 'KING 5', home: true, national: false }]), { tv: ['KING 5'] });
});

test('a game\'s broadcasts land on the matching feed event only', { skip: TP }, () => {
  const events = feed();
  applyScheduleFlags(events, { steelheads: [{ date: '2026-12-07', tbd: false, watch: { tv: ['TPTV 4'], radio: ['KTWP 1240 AM'] } }] });
  assert.deepEqual(events[2].watch, { tv: ['TPTV 4'], radio: ['KTWP 1240 AM'] });
  assert.equal(events[0].watch, undefined, 'same date, other team');
  assert.equal(events[3].watch, undefined, 'same date, not a game');
});

// ---- the season normalizers: one home and one away game per league ----
test('MLB: home and away games, Seattle times, the opponent\'s crest and club site', () => {
  const sea = { id: 136, name: 'Seattle Mariners', teamName: 'Mariners', abbreviation: 'SEA' };
  const bos = { id: 111, name: 'Boston Red Sox', teamName: 'Red Sox', abbreviation: 'BOS' };
  const games = normalizeMlb({ dates: [
    { date: '2026-09-01', games: [{ gameDate: '2026-09-01T22:45:00Z', officialDate: '2026-09-01', venue: { name: 'Fenway Park' },
      status: { startTimeTBD: false }, teams: { away: { team: sea }, home: { team: bos } } }] },
    { date: '2026-09-11', games: [{ gameDate: '2026-09-12T01:40:00Z', officialDate: '2026-09-11', venue: { name: 'T-Mobile Park' },
      status: { startTimeTBD: true }, teams: { away: { team: bos }, home: { team: sea } },
      broadcasts: [{ type: 'TV', name: 'Mariners.TV', homeAway: 'home', isNational: false, language: 'en' }] }] },
    { date: '2026-09-12', games: [{ gameDate: '2026-09-12T20:00:00Z', officialDate: '2026-09-12', teams: { away: { team: bos }, home: { team: { id: 147 } } } }] },
    { date: '2026-03-01', games: [{ gameDate: '2026-03-01T20:00:00Z', officialDate: '2026-03-01', gameType: 'S', teams: { away: { team: bos }, home: { team: sea } } }] },
    { date: '2026-10-01', games: [{ gameDate: '2026-10-02T02:00:00Z', officialDate: '2026-10-01', gameType: 'F', teams: { away: { team: bos }, home: { team: sea } } }] },
  ] }, 136);
  assert.equal(games.length, 4, 'only our games, spring training kept');
  assert.equal(games.filter((g) => g.pre).length, 1, 'spring training flagged pre'); assert.equal(games.find((g) => g.pre).date, '2026-03-01');
  assert.equal(games[3].playoff, true, 'a wild-card game is a playoff'); assert.equal(games[2].playoff, undefined, 'spring training is not one');
  assert.equal(games[0].playoff, undefined);
  assert.deepEqual(games[0], { ...clock('2026-09-01', '15:45:00'), tbd: false, home: false, venue: 'Fenway Park',
    opp: { name: 'Boston Red Sox', short: 'Red Sox', abbrev: 'BOS', logo: 'https://www.mlbstatic.com/team-logos/111.svg', site: 'https://www.mlb.com/redsox' } });
  assert.equal(games[1].home, true);
  assert.equal(games[1].date, '2026-09-11', 'the official (local) date, not the UTC one');
  assert.equal(games[1].time, null, 'a TBD start has no time');
  assert.deepEqual(games[1].watch, { tv: ['Mariners.TV'] });
});

test('NHL: home and away, opponent from place + nickname, nhl.com/<nickname>', () => {
  const games = normalizeNhl({ games: [
    { gameDate: '2026-10-08', startTimeUTC: '2026-10-09T02:00:00Z', gameScheduleState: 'OK', venue: { default: 'Rogers Arena' },
      awayTeam: { abbrev: 'SEA', commonName: { default: 'Kraken' }, placeName: { default: 'Seattle' } },
      homeTeam: { abbrev: 'VAN', commonName: { default: 'Canucks' }, placeName: { default: 'Vancouver' }, logo: 'https://assets.nhle.com/logos/nhl/svg/VAN_light.svg' } },
    { gameDate: '2026-10-11', startTimeUTC: '2026-10-12T00:00:00Z', gameScheduleState: 'TBD', venue: { default: 'Climate Pledge Arena' },
      homeTeam: { abbrev: 'SEA' }, awayTeam: { abbrev: 'TOR', commonName: { default: 'Maple Leafs' }, placeName: { default: 'Toronto' } },
      tvBroadcasts: [{ network: 'KING 5', market: 'H' }] },
    { gameDate: '2026-09-25', gameType: 1, startTimeUTC: '2026-09-26T02:00:00Z', homeTeam: { abbrev: 'SEA' }, awayTeam: { abbrev: 'VAN' } },
    { gameDate: '2027-04-20', gameType: 3, startTimeUTC: '2027-04-21T02:00:00Z', homeTeam: { abbrev: 'SEA' }, awayTeam: { abbrev: 'VAN' } },
  ] }, 'SEA');
  assert.equal(games.length, 4, 'preseason kept');
  assert.equal(games[2].pre, true, 'flagged pre'); assert.equal(games[2].playoff, undefined);
  assert.equal(games[3].playoff, true);
  assert.deepEqual(games[0], { ...clock('2026-10-08', '19:00:00'), tbd: false, home: false, venue: 'Rogers Arena',
    opp: { name: 'Vancouver Canucks', short: 'Canucks', abbrev: 'VAN', logo: 'https://assets.nhle.com/logos/nhl/svg/VAN_light.svg', site: 'https://www.nhl.com/canucks' } });
  assert.equal(games[1].home, true);
  assert.equal(games[1].tbd, true);
  assert.equal(games[1].time, null);
  assert.equal(games[1].opp.site, 'https://www.nhl.com/mapleleafs');
  assert.deepEqual(games[1].watch, { tv: ['KING 5'] });
});

test('ESPN: home and away from homeAway, opponent crest + clubhouse link, flexed kickoff is TBD', () => {
  const sea = { id: '26', displayName: 'Seattle Seahawks', shortDisplayName: 'Seahawks', abbreviation: 'SEA' };
  const ne = { id: '17', displayName: 'New England Patriots', shortDisplayName: 'Patriots', abbreviation: 'NE',
    logos: [{ href: 'https://a.espncdn.com/i/teamlogos/nfl/500/ne.png' }],
    links: [{ rel: ['roster', 'desktop'], href: 'https://www.espn.com/nfl/team/roster/_/name/ne' }, { rel: ['clubhouse', 'desktop', 'team'], href: 'https://www.espn.com/nfl/team/_/name/ne/new-england-patriots' }] };
  const games = normalizeEspn({ events: [
    { date: '2026-09-10T00:20Z', competitions: [{ venue: { fullName: 'Lumen Field' }, timeValid: true, status: { type: { detail: 'Wed, September 9th at 8:20 PM EDT' } },
      competitors: [{ homeAway: 'home', team: sea }, { homeAway: 'away', team: ne }] }] },
    { date: '2026-12-20T18:00Z', competitions: [{ venue: { fullName: 'Gillette Stadium' }, timeValid: false, status: { type: { detail: 'TBD' } },
      competitors: [{ homeAway: 'home', team: ne }, { homeAway: 'away', team: sea }] }] },
    { date: '2026-08-10T00:00Z', season: { type: 1 }, competitions: [{ competitors: [{ homeAway: 'home', team: ne }, { homeAway: 'away', team: sea }] }] },
    { date: '2027-01-10T00:00Z', season: { type: 3 }, competitions: [{ competitors: [{ homeAway: 'home', team: ne }, { homeAway: 'away', team: sea }] }] },
  ] }, 26);
  assert.equal(games.length, 4, 'preseason kept');
  assert.equal(games[2].pre, true, 'flagged pre'); assert.equal(games[2].playoff, undefined);
  assert.equal(games[3].playoff, true);
  assert.deepEqual(games[0], { ...clock('2026-09-09', '17:20:00'), tbd: false, home: true, venue: 'Lumen Field',
    opp: { name: 'New England Patriots', short: 'Patriots', abbrev: 'NE', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/ne.png', site: 'https://www.espn.com/nfl/team/_/name/ne/new-england-patriots' } });
  assert.equal(games[1].home, false);
  assert.equal(games[1].tbd, true);
  assert.equal(games[1].time, null);
  assert.equal(games[1].venue, 'Gillette Stadium');
});

test('PWHL: home and away from the team ids, venue-zone time to Seattle, league crest + club page', () => {
  const games = [
    { home_team: '9', visiting_team: '8', date_played: '2025-11-21', GameDateISO8601: '2025-11-21T22:00:00-05:00', schedule_time: '22:00:00',
      home_team_name: 'Vancouver Goldeneyes', home_team_nickname: 'Goldeneyes', home_team_code: 'VAN', visiting_team_name: 'Seattle Torrent',
      venue_name: 'Pacific Coliseum | Vancouver', date_tbd: '0', time_tbd: '0' },
    { home_team: '8', visiting_team: '3', date_played: '2025-12-05', GameDateISO8601: '2025-12-05T19:00:00-08:00', schedule_time: '19:00:00',
      home_team_name: 'Seattle Torrent', visiting_team_name: 'Montréal Victoire', visiting_team_nickname: 'Victoire', visiting_team_code: 'MTL',
      venue_name: 'Climate Pledge Arena | Seattle', date_tbd: '0', time_tbd: '1' },
    { home_team: '1', visiting_team: '2', date_played: '2025-12-06', home_team_name: 'Boston Fleet', visiting_team_name: 'Minnesota Frost' },
  ];
  const out = normalizePwhl(games, 8, true);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { ...clock('2025-11-21', '19:00:00'), tbd: false, home: false, playoff: true,
    opp: { name: 'Vancouver Goldeneyes', short: 'Goldeneyes', abbrev: 'VAN', logo: 'https://assets.leaguestat.com/pwhl/logos/9.png', site: 'https://www.thepwhl.com/en/teams/vancouver-goldeneyes' },
    venue: 'Pacific Coliseum' });
  assert.equal(out[1].home, true);
  assert.equal(out[1].time, null); // time TBD
  assert.equal(out[1].opp.site, 'https://www.thepwhl.com/en/teams/montreal-victoire'); // accent folded
  assert.equal(out[1].venue, 'Climate Pledge Arena');
});

// ---- results: a final game carries its line, an unplayed one nothing ----
test('results: MLB final → us/them/won; NHL OT and PWHL SO marked; ESPN draw is won:false; unplayed games have no res', () => {
  const mlb = normalizeMlb({ dates: [{ date: '2026-09-08', games: [
    { gamePk: 1, gameType: 'R', officialDate: '2026-09-08', gameDate: '2026-09-09T02:10:00Z', status: { abstractGameState: 'Final' },
      teams: { home: { team: { id: 136, name: 'Seattle Mariners' }, score: 2, isWinner: false }, away: { team: { id: 140, name: 'Texas Rangers', teamName: 'Rangers', abbreviation: 'TEX' }, score: 6, isWinner: true } }, venue: { name: 'T-Mobile Park' } },
    { gamePk: 2, gameType: 'R', officialDate: '2026-09-10', gameDate: '2026-09-10T20:10:00Z', status: { abstractGameState: 'Preview' },
      teams: { home: { team: { id: 136, name: 'Seattle Mariners' } }, away: { team: { id: 140, name: 'Texas Rangers', teamName: 'Rangers', abbreviation: 'TEX' } } }, venue: { name: 'T-Mobile Park' } },
  ] }] }, 136);
  assert.deepEqual(mlb[0].res, { us: 2, them: 6, won: false });
  assert.equal(mlb[1].res, undefined);
  const nhl = normalizeNhl({ games: [{ gameType: 2, gameDate: '2026-04-16', startTimeUTC: '2026-04-17T02:00:00Z', gameState: 'OFF', gameOutcome: { lastPeriodType: 'OT' },
    homeTeam: { abbrev: 'SEA', score: 3 }, awayTeam: { abbrev: 'COL', score: 2, commonName: { default: 'Avalanche' }, placeName: { default: 'Colorado' } }, venue: { default: 'Climate Pledge Arena' } }] }, 'SEA');
  assert.deepEqual(nhl[0].res, { us: 3, them: 2, won: true, ot: 'OT' });
  const espn = normalizeEspn({ events: [{ date: '2026-08-30T21:00Z', season: { type: 2 }, competitions: [{ status: { type: { completed: true } }, venue: { fullName: 'Lumen Field' },
    competitors: [{ team: { id: '9726', displayName: 'Seattle Sounders FC' }, homeAway: 'home', score: { displayValue: '1' }, winner: false },
      { team: { id: '1', displayName: 'LA Galaxy' }, homeAway: 'away', score: { displayValue: '1' }, winner: false }] }] }] }, 9726);
  assert.deepEqual(espn[0].res, { us: 1, them: 1, won: false });
  const pwhl = normalizePwhl([{ home_team: '8', visiting_team: '3', home_team_name: 'Seattle Torrent', visiting_team_name: 'Montréal Victoire', date_played: '2026-04-25',
    GameDateISO8601: '2026-04-25T19:00:00-07:00', final: '1', game_status: 'Final SO', home_goal_count: '1', visiting_goal_count: '2', venue_name: 'Climate Pledge Arena' }], 8, false);
  assert.deepEqual(pwhl[0].res, { us: 1, them: 2, won: false, ot: 'SO' });
});

// ---- the other cities' leagues: MiLB (the same API as MLB), the WHL (the same feed as the PWHL), DigitalShift (Arena Football One) ----
test('normalizeMlb: sportId 13 → milb.com club pages by city, the clubs own INET streams dropped from the broadcasts', () => {
  const out = normalizeMlb({ dates: [{ date: '2026-07-04', games: [
    { gamePk: 7, gameType: 'R', officialDate: '2026-07-04', gameDate: '2026-07-05T02:05:00Z', status: {},
      teams: { home: { team: { id: 403, name: 'Everett AquaSox' } }, away: { team: { id: 461, name: 'Tri-City Dust Devils', teamName: 'Dust Devils', locationName: 'Tri-City', shortName: 'Tri-City', abbreviation: 'TRI' } } },
      venue: { name: 'Everett Memorial Stadium' },
      broadcasts: [{ type: 'TV', name: 'MiLB.TV', homeAway: 'home', language: 'en' }, { type: 'INET', name: 'Audio', homeAway: 'home', language: 'en' }] },
  ] }] }, 403, 13);
  assert.equal(out[0].opp.site, 'https://www.milb.com/tri-city');
  assert.equal(out[0].opp.logo, 'https://www.mlbstatic.com/team-logos/461.svg');
  assert.deepEqual(out[0].watch, { tv: ['MiLB.TV'] }); // the Audio (INET) entry gone
});

test('normalizePwhl with WHL options: league crest, no club page, venue cut before " - City, ST"; pwhlOdds reads the id from a .png or .jpg crest', () => {
  const whl = { logo: (id) => `https://assets.leaguestat.com/whl/logos/${id}.png` };
  const out = normalizePwhl([{ home_team: '226', visiting_team: '218', home_team_name: 'Everett Silvertips', visiting_team_name: 'Seattle Thunderbirds', visiting_team_nickname: 'Thunderbirds', visiting_team_code: 'SEA',
    date_played: '2026-10-11', GameDateISO8601: '2026-10-11T18:05:00-07:00', venue_name: 'Angel of the Winds Arena - Everett, WA', venue_location: 'Everett, WA', date_tbd: '0', time_tbd: '0', final: '0' }], 226, false, false, whl);
  assert.deepEqual(out[0], { ...clock('2026-10-11', '18:05:00'), tbd: false, home: true,
    opp: { name: 'Seattle Thunderbirds', short: 'Thunderbirds', abbrev: 'SEA', logo: 'https://assets.leaguestat.com/whl/logos/218.png' }, venue: 'Angel of the Winds Arena', city: 'Everett, WA' });
  const odds = pwhlOdds(out, [{ team_id: '226', games_played: '10', points: '14' }, { team_id: '218', games_played: '10', points: '6' }], 226, 'WHL');
  assert.ok(odds[0].odds.us > 60 && odds[0].odds.est && /no line for the WHL/.test(odds[0].odds.source));
});

test('hockeytechForm: WHL rows read W-L-OTL-SOL and rank in the conference with a home split; PWHL rows RW-OTW-OTL-L in the league', () => {
  assert.deepEqual(hockeytechForm({ name: 'x - Everett Silvertips', team_code: 'EVT', wins: '40', losses: '20', ot_losses: '5', shootout_losses: '3', rank: '2', overall_rank: '4', conference_name: 'Western Conference', home_record: '22-9-2-1' }, 'whl'),
    { record: '40-20-5-3', standing: '2nd in the Western Conference', home: '22-9-2-1', club: { name: 'Everett Silvertips', abbr: 'EVT' } });
  assert.deepEqual(hockeytechForm({ name: 'Seattle Torrent', team_code: 'SEA', regulation_wins: '10', non_reg_wins: '2', non_reg_losses: '3', losses: '5', rank: '3' }, 'pwhl'),
    { record: '10-2-3-5', standing: '3rd in the PWHL', club: { name: 'Seattle Torrent', abbr: 'SEA' } });
});

test('normalizeDigitalshift: games only, Seattle wall clock from started_at_tz, home from day_class, the result from "W 33-16" / "L 33-16", the home ground supplied', () => {
  const now = Date.parse('2026-06-01T00:00:00Z');
  const ev = [
    { $type: 'game', id: 'g-1', name: 'Washington Wolfpack vs Oregon Lightning', started_at: '2026-04-12T15:00:00.000+00:00', started_at_tz: '2026-04-12T22:00:00.000Z', day_class: 'game-home', opp_team_name: 'Oregon Lightning', opp_team_logo_url: { medium: 'https://x/or.png' }, status: 'L 33-16 ' },
    { $type: 'game', id: 'g-2', name: 'Nashville Kats vs Washington Wolfpack', started_at_tz: '2026-04-19T23:00:00.000Z', day_class: 'game-away', opp_team_name: 'Nashville Kats', status: 'W 41-27' },
    { $type: 'game', id: 'g-3', name: 'Washington Wolfpack vs Billings Outlaws', started_at_tz: '2026-07-11T22:00:00.000Z', day_class: 'game-home', opp_team_name: 'Billings Outlaws', status: '' },
    { $type: 'practice', id: 'p-1', started_at_tz: '2026-04-10T22:00:00.000Z' },
    { $type: 'game', id: 'g-0', name: 'old', started_at_tz: '2024-04-10T22:00:00.000Z', day_class: 'game-home', opp_team_name: 'Old Team', status: 'W 1-0' },
  ];
  const out = normalizeDigitalshift(ev, 'Angel of the Winds Arena', now);
  assert.deepEqual(out.map((g) => g.date), ['2026-04-12', '2026-04-19', '2026-07-11']);
  assert.deepEqual(out[0], { ...clock('2026-04-12', '15:00:00'), tbd: false, home: true, opp: { name: 'Oregon Lightning', short: 'Lightning', abbrev: 'LIG', logo: 'https://x/or.png' }, venue: 'Angel of the Winds Arena', res: { us: 16, them: 33, won: false } });
  assert.deepEqual(out[1].res, { us: 41, them: 27, won: true });
  assert.equal(out[1].venue, undefined);
  assert.equal(out[2].res, undefined);
});

test('wikiTitle: one year for a summer season, en-dash span for one that straddles the new year, null with nothing', { skip: TP }, () => {
  assert.equal(wikiTitle('timbermen', [{ date: '2026-03-26' }, { date: '2026-09-27' }]), '2026 Twin Peaks Timbermen season');
  assert.equal(wikiTitle('steelheads', [{ date: '2026-10-01' }, { date: '2027-04-10' }]), '2026–27 Twin Peaks Steelheads season');
  assert.equal(wikiTitle('steelheads', [{ date: '2025-11-21' }, { date: '2026-04-25' }]), '2025–26 Twin Peaks Steelheads season');
  assert.equal(wikiTitle('loggers', [{ date: '2026-09-09' }, { date: '2027-01-09' }]), '2026 Twin Peaks Loggers season'); // a football season is named by its first year
  assert.equal(wikiTitle('steelheads', []), null);
});

test('pickNews: written pieces only, the ones naming the club first, newest first, eight at most', () => {
  const art = (type, headline, published, description = '') => ({ type, headline, published, description, links: { web: { href: 'https://espn.com/' + headline.replace(/\W+/g, '-') } } });
  const out = pickNews([
    art('Media', 'Seahawks clip', '2026-09-10T12:00Z'),
    art('Story', 'What is the oldest NFL stadium?', '2026-09-10T10:00Z'),
    art('Story', 'Seahawks lose Darnold', '2026-09-09T10:00Z'),
    art('Recap', 'Seahawks beat Patriots', '2026-09-08T10:00Z'),
    art('Story', 'League power rankings', '2026-09-07T10:00Z', 'Seahawks up to fourth'),
    art('Story', 'No link', '2026-09-11T10:00Z'),
  ].map((a) => (a.headline === 'No link' ? { ...a, links: {} } : a)), 'Seahawks');
  assert.deepEqual(out.map((a) => a.headline), ['Seahawks lose Darnold', 'Seahawks beat Patriots', 'League power rankings', 'What is the oldest NFL stadium?']);
  assert.equal(pickNews(Array.from({ length: 12 }, (_, i) => art('Story', 'Seahawks ' + i, '2026-09-' + String(10 + i))), 'Seahawks').length, 8);
  assert.equal(out[0].date, '2026-09-09');
  assert.equal(out[0].url, 'https://espn.com/Seahawks-lose-Darnold');
});

test('seasonStartYear: summer leagues take the calendar year; hockey and football take last year until July', () => {
  assert.equal(seasonStartYear('baseball', new Date(2026, 2, 1)), 2026);
  assert.equal(seasonStartYear('hockey', new Date(2026, 8, 10)), 2026);
  assert.equal(seasonStartYear('hockey', new Date(2027, 2, 1)), 2026);
  assert.equal(seasonStartYear('football', new Date(2027, 0, 9)), 2026);
});


// The card markup of seawolves.rugby since the club moved to Envorso Sports
// (2026-11): a Home/Away badge, the day, the clock, the ground, each side's
// crest + name (the home side first), "Round N" and "34 – 25" on a played
// match. A home match is listed twice — a ticket card ("Result to come", no
// round) and the match card. Month headings ("April 2026") carry the year.
const swCard = ({ side, day, time, ground, a, b, round, score, status = 'Result to come' }) => {
  const crest = (t) => `<div class="flex"><div class="c"><img alt="" loading="lazy" src="${t.logo}"/></div><span class="font-heading">${t.name}</span>${score ? `<span class="tabular-nums">${score[t === a ? 0 : 1]}</span>` : ''}</div>`;
  return `<li class="grid overflow-hidden rounded-lg"><div><span>${side}</span></div><div><div><span>${side}</span><span class="text-primary">${status}</span></div><p>Sunday</p><div><p class="font-display">${day}</p><p class="text-base">${time}</p></div><div><p><svg viewBox="0 0 24 24"><path d="M1 1"></path></svg>${ground}</p></div></div><div>${crest(a)}${crest(b)}${round != null ? `<p>Round <!-- -->${round}</p>` : ''}${score ? `<div><p>${score[0]}<!-- --> – <!-- -->${score[1]}</p><p>${status}</p></div>` : ''}</div></li>`;
};
const SW = { name: 'Seattle Seawolves Rugby', logo: 'https://storage.googleapis.com/content-public-staging/tenant/x/pages/y/seawolves-logo-1.webp' };
const LEGION = { name: 'California Legion', logo: 'https://storage.googleapis.com/inventory-production/tenant/1/team-profiles/2/logo-5e6f829a.png' };
const LEGION_TIX = { ...LEGION, name: 'California Legion Rugby' };
const ANTHEM = { name: 'Anthem RC', logo: 'https://storage.googleapis.com/inventory-production/tenants/2/team-profiles/1/logo.webp' };
const HARTFORD = { name: 'Hartford Harpooners', logo: 'https://storage.googleapis.com/inventory-production/tenants/2/team-profiles/11/logo.webp' };
const swMonth = (m) => `<h3 class="mb-3 font-heading text-xl">${m}</h3>`;

test('Seawolves: one game a date from the ticket + match cards, Home/Away from the badge, results, crests, ground; community events skipped', () => {
  const html = swMonth('June 2026') +
    swCard({ side: 'Home', day: 'Jun 14', time: '7:30 PM PDT', ground: 'Starfire Sports Complex', a: SW, b: LEGION_TIX }) +
    swCard({ side: 'Home', day: 'Jun 14', time: '7:30 PM PDT', ground: 'Starfire Stadium', a: SW, b: LEGION, round: 12, score: [34, 43], status: 'Final · Loss' }) +
    '<li class="grid overflow-hidden rounded-lg"><div><span>Regular Season</span></div><div><p>Jun 9</p><p>7:00 PM PDT</p><p>Starfire Sports Complex</p></div><div><span>USA Military vs British Army</span></div></li>' +
    swMonth('April 2026') +
    swCard({ side: 'Away', day: 'Apr 12', time: '1:00 PM PDT', ground: 'American Legion Memorial Stadium', a: ANTHEM, b: SW, round: 3, score: [34, 25], status: 'Final · Loss' }) +
    swMonth('March 2026') +
    swCard({ side: 'Home', day: 'Mar 28', time: '7:42 PM PDT', ground: 'Starfire Sports Complex', a: SW, b: HARTFORD }) +
    '<li class="grid overflow-hidden rounded-lg"><div><span>Community</span></div><div><p>Mar 2</p><p>9:00 AM PST</p><p>Starfire Sports Complex</p></div><div><img alt="" src="' + SW.logo + '"/><span>Seawolves Youth Rugby Camp</span></div></li>';
  const g = parseSeawolves(html, { pre: new Set(['2026-03-28']), playoff: new Set(['2026-06-14']) });
  assert.deepEqual(g.map((x) => x.date), ['2026-03-28', '2026-04-12', '2026-06-14']);
  assert.deepEqual(g[0], { date: '2026-03-28', time: '19:42:00', tbd: false, home: true, pre: true, opp: { name: 'Hartford Harpooners', short: 'Harpooners', abbrev: 'HH', logo: HARTFORD.logo }, venue: 'Starfire Stadium', city: 'Tukwila, WA' });
  assert.deepEqual(g[1], { date: '2026-04-12', time: '13:00:00', tbd: false, home: false, opp: { name: 'Anthem Rugby Carolina', short: 'Anthem', abbrev: 'ANT', logo: 'marks/mlr/anthem.png', site: 'https://anthemrc.com/' }, venue: 'American Legion Memorial Stadium', res: { us: 25, them: 34, won: false } });
  assert.deepEqual({ playoff: g[2].playoff, res: g[2].res, opp: g[2].opp.name, logo: g[2].opp.logo, venue: g[2].venue }, { playoff: true, res: { us: 34, them: 43, won: false }, opp: 'California Legion', logo: 'marks/mlr/legion.png', venue: 'Starfire Stadium' });
});

test('Seawolves: a fixture not yet played has no result; no flags, no year heading and a /_next/image crest still read', () => {
  const nx = '/_next/image?url=' + encodeURIComponent('https://storage.googleapis.com/inventory-production/tenant/1/team-profiles/99/logo-new.png') + '&amp;w=640&amp;q=75';
  const g = parseSeawolves(swMonth('March 2027') + swCard({ side: 'Away', day: 'Mar 6', time: '4:00 PM PST', ground: 'SeatGeek Stadium', a: { name: 'Expansion FC', logo: nx }, b: SW, round: 1 }));
  assert.equal(g.length, 1);
  assert.deepEqual(g[0], { date: '2027-03-06', time: '16:00:00', tbd: false, home: false, opp: { name: 'Expansion FC', short: 'Expansion FC', abbrev: 'EF', logo: 'https://storage.googleapis.com/inventory-production/tenant/1/team-profiles/99/logo-new.png' }, venue: 'SeatGeek Stadium' });
  assert.deepEqual(parseSeawolves('<h3>November 2026</h3><li class="grid overflow-hidden"><div><span>Other</span></div><p>Nov 23</p><span>Seawolves Thanksgiving Youth Rugby Camp</span></li>'), []);
});

test('Seawolves news (Envorso Sports page): date, headline and summary per post, newest first, eight at most, one entry a link', () => {
  const post = (h, iso, d, t, p) => `<a class="group block overflow-hidden rounded-lg" href="/news/${h}"><div class="relative"><img alt="${t}" loading="lazy" src="/_next/image?url=x&amp;w=3840&amp;q=75"/></div><div class="p-4"><p class="text-xs"><time dateTime="${iso}">${d}</time><span aria-hidden="true">·</span><span>News</span></p><h2 class="font-heading">${t}</h2><p class="text-sm">${p}</p></div></a>`;
  const html = post('old', '2026-07-21T18:00:00.000Z', 'Jul 21, 2026', 'Old', 'x') +
    post('grosse', '2026-11-04T22:35:02.844Z', 'Nov 4, 2026', 'Seattle Seawolves Sign Back Row Collin Grosse for 2027', 'Washington native Collin Grosse returns home') +
    post('pb', '2026-10-29T22:05:59.134Z', 'Oct 29, 2026', 'What’s Your PB? Club &amp; Community', 'Rugby&#x27;s personal bests') +
    post('grosse', '2026-11-04T22:35:02.844Z', 'Nov 4, 2026', 'Seattle Seawolves Sign Back Row Collin Grosse for 2027', 'the same card again, from a second list') +
    post('late', '2026-11-06T06:30:00.000Z', 'Nov 5, 2026', 'Posted late in the evening', 'y'); // UTC is the next day; the page's own date wins
  const out = parseSeawolvesNews(html);
  assert.deepEqual(out.map((a) => a.date), ['2026-11-05', '2026-11-04', '2026-10-29', '2026-07-21']);
  assert.deepEqual(out[1], { date: '2026-11-04', headline: 'Seattle Seawolves Sign Back Row Collin Grosse for 2027', text: 'Washington native Collin Grosse returns home', url: 'https://seawolves.rugby/news/grosse', source: 'Seawolves' });
  assert.deepEqual([out[2].headline, out[2].text], ["What's Your PB? Club & Community", "Rugby's personal bests"]);
  assert.equal(parseSeawolvesNews(html.repeat(3).replace(/news\/old/g, 'news/o'), 2).length, 2);
});

test('Seawolves club name: og:site_name less " Rugby", else the old "… Rugby Club |" title, else none', () => {
  assert.equal(seawolvesClubName('<title>News | Seawolves</title><meta property="og:site_name" content="Seattle Seawolves Rugby"/>'), 'Seattle Seawolves');
  assert.equal(seawolvesClubName('<title>Seattle Seawolves Rugby Club | News</title>'), 'Seattle Seawolves');
  assert.equal(seawolvesClubName('<title>News | Seawolves</title>'), '');
});

test('RSS and Atom feeds: title, link, Seattle day, one line of summary, the source; utm stripped', () => {
  const rss = `<rss><channel><item><title>Julio&#8217;s homer &amp; more</title><link>https://www.seattletimes.com/sports/mariners/x/?utm_source=RSS&amp;utm_medium=Referral</link><pubDate>Thu, 10 Sep 2026 15:52:03 -0700</pubDate><description><![CDATA[<img src="a.jpg"><br/>Julio Rodríguez found some answers.]]></description></item>
    <item><title><![CDATA[Late one]]></title><link>https://www.mlb.com/mariners/news/y</link><pubDate>Fri, 11 Sep 2026 00:38:41 GMT</pubDate></item><item><title>No link</title></item></channel></rss>`;
  const out = parseFeed(rss, 'Seattle Times');
  assert.deepEqual(out.map(({ at, ...a }) => a), [
    { date: '2026-09-10', headline: 'Julio’s homer & more', text: 'Julio Rodríguez found some answers.', url: 'https://www.seattletimes.com/sports/mariners/x/', source: 'Seattle Times' },
    { date: '2026-09-10', headline: 'Late one', text: '', url: 'https://www.mlb.com/mariners/news/y', source: 'Seattle Times' },
  ]);
  const atom = `<feed><entry><title type="html"><![CDATA[Mad Hatters]]></title><link rel="alternate" type="text/html" href="https://www.lookoutlanding.com/a/1" /><published>2026-09-10T20:07:41-04:00</published><summary type="html"><![CDATA[So often <b>duels</b> fizzle.]]></summary></entry></feed>`;
  assert.deepEqual(parseFeed(atom, 'Lookout Landing').map(({ at, ...a }) => a), [{ date: '2026-09-10', headline: 'Mad Hatters', text: 'So often duels fizzle.', url: 'https://www.lookoutlanding.com/a/1', source: 'Lookout Landing' }]);
  assert.equal(parseFeed(`<rss><item><title>T</title><link>u</link><description>${'word '.repeat(60)}</description></item></rss>`, 'x')[0].text.length <= 240, true);
});

test('merged news: newest first by the time posted, ties keep the given order, each URL once, only pieces naming the club, no filler, eight at most', () => {
  const a = (d, u, s, at, h) => ({ date: d, headline: h || 'Mariners ' + u, text: '', url: u, source: s, ...(at ? { at } : {}) });
  const out = mergeNews([[a('2026-09-11', 'https://espn.com/1', 'ESPN', '2026-09-11T05:00:00Z'), a('2026-09-09', 'https://espn.com/2', 'ESPN')], [a('2026-09-10', 'https://st.com/1', 'ST'), a('2026-09-11', 'https://espn.com/1/', 'ST'), a('2026-09-11', 'https://st.com/2', 'ST', '2026-09-11T09:00:00Z')]], 'Seattle Mariners');
  assert.deepEqual(out.map((x) => x.url), ['https://st.com/2', 'https://espn.com/1', 'https://st.com/1', 'https://espn.com/2']);
  assert.equal('at' in out[0], false);
  assert.equal(mergeNews([Array.from({ length: 20 }, (_, i) => a('2026-09-01', 'https://x/' + i, 'x'))], 'Mariners').length, 8);
  const junk = [a('2026-09-01', 'https://x/t', 'x', null, '2026 MLB ABS challenge system tracker: Team rankings'), a('2026-09-01', 'https://x/p', 'x', null, 'Photos: Seattle Mariners at Rangers'),
    a('2026-09-01', 'https://x/o', 'x', null, 'Burning questions for all 32 NHL teams'), { date: '2026-09-01', headline: 'Julio homers', text: 'The Mariners won 4-3', url: 'https://x/ok', source: 'x' }];
  assert.deepEqual(mergeNews([junk], 'Mariners').map((x) => x.url), ['https://x/ok']);
});

test('highlights: a YouTube upload from the game\'s window naming the opponent, reels first, pressers left out', () => {
  const xml = ['HIGHLIGHTS: LA Galaxy vs. Seattle Sounders FC | September 12, 2026~a1~2026-09-13T05:58:22+00:00',
    'Press Conference: Brian Schmetzer post-match vs LA Galaxy~a2~2026-09-13T05:58:17+00:00',
    'Interview: Andrew Thomas on facing LA Galaxy~a3~2026-09-11T20:01:15+00:00',
    'Jordan Morris goal vs. LA Galaxy~a4~2026-09-13T06:10:00+00:00',
    'HIGHLIGHTS: Seattle Sounders FC vs. Portland Timbers | August 30, 2026~a5~2026-08-31T05:00:00+00:00',
  ].map((l) => { const [t, id, at] = l.split('~'); return `<entry><title>${t}</title><yt:videoId>${id}</yt:videoId><published>${at}</published></entry>`; }).join('');
  const got = matchYoutube(parseYoutube(xml), { date: '2026-09-12', opp: { name: 'LA Galaxy', short: 'LA Galaxy' } }, 'sounders');
  assert.deepEqual(got.map((c) => c.url.slice(-2)), ['a1', 'a4']);
  assert.equal(got[0].title, 'HIGHLIGHTS: LA Galaxy vs. Seattle Sounders FC | September 12, 2026');
});

test('highlights: nfl.com\'s game page yields the reel first, then the can\'t-miss plays, each once', () => {
  const html = '{\\"title\\":\\"Derick Hall sack\\",\\"videos\\":[],\\"webLink\\":\\"https://www.nfl.com/videos/hall-sack\\"}' +
    '{\\"title\\":\\"Can\'t-Miss Play: Jobe INT\\",\\"videos\\":[],\\"webLink\\":\\"https://www.nfl.com/videos/jobe-int\\"}' +
    '{\\"title\\":\\"Patriots vs. Seahawks highlights | Week 1\\",\\"videos\\":[],\\"webLink\\":\\"https://www.nfl.com/videos/pats-sea-x1\\"}' +
    '{\\"title\\":\\"Derick Hall sack\\",\\"videos\\":[],\\"webLink\\":\\"https://www.nfl.com/videos/hall-sack\\"}';
  assert.deepEqual(parseNflPage(html).map((c) => c.url.split('/').pop()), ['pats-sea-x1', 'jobe-int', 'hall-sack']);
});

test('highlights: a title dated another day of the series is not this game\'s', () => {
  assert.equal(titleDate('Rangers vs. Mariners Full Game Highlights (9/10/26)'), '2026-09-10');
  assert.equal(titleDate('HIGHLIGHTS: LA Galaxy vs. Seattle Sounders FC | September 12, 2026'), '2026-09-12');
  assert.equal(titleDate('MLS NEXT PRO: Chattanooga FC vs Atlanta United FC | Sept 13, 2026'), '2026-09-13');
  assert.equal(titleDate('Jordan Morris goal vs. LA Galaxy'), null);
  const xml = ['Rangers vs. Mariners Full Game Highlights (9/10/26)~b1~2026-09-11T05:00:00+00:00', 'Rangers vs. Mariners Full Game Highlights (9/9/26)~b2~2026-09-10T05:00:00+00:00']
    .map((l) => { const [t, id, at] = l.split('~'); return `<entry><title>${t}</title><yt:videoId>${id}</yt:videoId><published>${at}</published></entry>`; }).join('');
  assert.deepEqual(matchYoutube(parseYoutube(xml), { date: '2026-09-09', opp: { name: 'Texas Rangers', short: 'Rangers' } }, 'mariners').map((c) => c.url.slice(-2)), ['b2']);
});

test('PWHL odds: log5 on points shares with a home nudge, played games and unknown opponents left alone', () => {
  const rows = [{ team_id: '8', games_played: '30', points: '30' }, { team_id: '3', games_played: '30', points: '45' }];
  const games = [
    { date: '2026-11-29', home: false, opp: { logo: 'https://assets.leaguestat.com/pwhl/logos/3.png' } },
    { date: '2026-11-30', home: true, opp: { logo: 'https://assets.leaguestat.com/pwhl/logos/3.png' } },
    { date: '2026-12-02', home: true, opp: { logo: 'https://assets.leaguestat.com/pwhl/logos/99.png' } },
    { date: '2026-01-05', home: true, opp: { logo: 'https://assets.leaguestat.com/pwhl/logos/3.png' }, res: { us: 2, them: 1, won: true } },
  ];
  const out = pwhlOdds(games, rows, 8);
  assert.equal(out[0].odds.us + out[0].odds.them, 100);
  assert.ok(out[0].odds.us < 50 && out[1].odds.us > out[0].odds.us, 'the weaker club, better at home'); // .5 vs .75: away 0.47/0.78 → 26%, home 0.53/0.72 → 30%
  assert.equal(out[0].odds.est, true);
  assert.ok(out[2].odds && out[2].odds.us === 56, 'no standings row for the opponent: taken as .500 (home: .53 vs .47 → 56%)');
  assert.equal(out[3].odds, undefined, 'a played game');
  assert.deepEqual(pwhlOdds(games, [], 8).map((g) => g.odds), [undefined, undefined, undefined, undefined]);
});

test('espnSeason: ESPN files hockey under the year the season ends, every other sport under its start year', () => {
  assert.equal(espnSeason('hockey', new Date(2026, 9, 5)), 2027); // the Kraken's 2026–27
  assert.equal(espnSeason('hockey', new Date(2027, 2, 1)), 2027);
  assert.equal(espnSeason('football', new Date(2026, 9, 5)), 2026);
  assert.equal(espnSeason('baseball', new Date(2026, 9, 5)), 2026);
});

test('pickSplits: the division and conference records out of the core record items', () => {
  const items = [{ name: 'overall', type: 'total', summary: '14-3' }, { name: 'Home', type: 'home', summary: '6-2' }, { name: 'vs. Div.', type: 'vsdiv', summary: '4-2' }, { name: 'vs. Conf.', type: 'vsconf', summary: '9-3' }];
  assert.deepEqual(pickSplits(items), { vsDiv: '4-2', vsConf: '9-3' });
  assert.deepEqual(pickSplits([{ name: 'overall', summary: '76-86' }]), {});
  assert.deepEqual(pickSplits(undefined), {});
});

test('pickLeaders: the sport\'s categories in order, in words, each with its leader\'s figure and link; empty ones skipped', () => {
  const cats = [
    { name: 'avg', leaders: [{ displayValue: '.281', athlete: { $ref: 'http://x/a/1' } }] },
    { name: 'homeRuns', leaders: [{ displayValue: '26', athlete: { $ref: 'http://x/a/1' } }] },
    { name: 'ERA', leaders: [{ displayValue: '3.73', athlete: { $ref: 'http://x/a/2' } }] },
    { name: 'saves', leaders: [{ displayValue: '28', athlete: { $ref: 'http://x/a/3' } }] }, // not one the tile shows
    { name: 'wins', leaders: [] },
    { name: 'strikeouts', leaders: [{ displayValue: '-', athlete: { $ref: 'http://x/a/4' } }] }, // nothing yet
  ];
  assert.deepEqual(pickLeaders('baseball', cats), [
    { stat: 'Home runs', value: '26', ref: 'http://x/a/1' },
    { stat: 'Average', value: '.281', ref: 'http://x/a/1' },
    { stat: 'ERA', value: '3.73', ref: 'http://x/a/2' },
  ]);
  assert.deepEqual(pickLeaders('rugby', cats), []);
});

test('divisionRecord: the results against the division, the preseason and playoffs left out', () => {
  const g = (abbrev, us, them, extra) => ({ opp: { abbrev }, res: { us, them, won: us > them }, ...extra });
  const games = [g('HOU', 5, 3), g('HOU', 1, 2), g('TEX', 4, 4), g('NYY', 9, 0), g('LAA', 2, 1, { pre: true }), g('ATH', 0, 1, { playoff: true }), { opp: { abbrev: 'ATH' } }];
  assert.equal(divisionRecord(games, ['HOU', 'LAA', 'ATH', 'TEX']), '1-1-1');
  assert.equal(divisionRecord([g('NYY', 9, 0)], ['HOU']), null);
});

test('pickMoves: only the big moves, newest first, cut to a short line', () => {
  const tr = (date, id, description) => ({ date, team: { id: String(id), links: [{ rel: ['clubhouse', 'desktop', 'team'], href: 'https://www.espn.com/mlb/team/_/name/sea/seattle-mariners' }] }, description });
  const feed = [
    tr('2026-10-02T07:00Z', 12, 'Claimed 1B Michael Toglia off waivers from Cincinnati.'),
    tr('2026-09-28T07:00Z', 12, 'Fired bench coach Manny Acta, infield coach Perry Hill, hitting coach Kevin Seitzer and first base coach Eric Young Jr..'),
    tr('2026-09-27T07:00Z', 12, 'Fired Head Coach Dan Wilson.'),
    tr('2026-09-25T07:00Z', 12, 'Placed RHP Andrés Muñoz on the 15-day IL. Recalled RHP Troy Taylor from Tacoma (PCL).'),
    tr('2026-09-24T07:00Z', 12, 'Placed SS Brock Rodden on the 10-day IL, retroactive to Sept. 23. Recalled 3B Leo Rivas from Tacoma (PCL).'),
    tr('2026-09-20T07:00Z', 12, 'Signed RHP Luis Castillo to a three-year contract extension.'),
    tr('2026-09-19T07:00Z', 12, 'Traded OF Dominic Canzone to Pittsburgh for cash considerations.'),
    tr('2026-09-18T07:00Z', 12, 'Named OF Julio Rodríguez to the roster.'),
    tr('2026-09-30T07:00Z', 25, 'Fired manager Someone Else.'),
  ];
  assert.deepEqual(pickMoves(feed, 12), [
    { date: '2026-09-28', text: 'Fired 4 coaches', url: 'https://www.espn.com/mlb/team/transactions/_/name/sea/seattle-mariners' },
    { date: '2026-09-27', text: 'Fired Head Coach Dan Wilson', url: 'https://www.espn.com/mlb/team/transactions/_/name/sea/seattle-mariners' },
    { date: '2026-09-20', text: 'Signed Luis Castillo to a three-year contract extension', url: 'https://www.espn.com/mlb/team/transactions/_/name/sea/seattle-mariners' },
  ]); // linked to ESPN's page of the club's moves
  assert.deepEqual(pickMoves(feed, 12, 5).map((m) => m.text)[3], 'Traded Dominic Canzone to Pittsburgh for cash considerations');
  assert.equal(pickMoves(feed, 12, 5).length, 4); // the roster naming, the IL moves and the waiver claim are not news
  assert.deepEqual(pickMoves([], 12), []);
});

test('ESPN: a kickoff not yet known (timeValid:false) keeps ESPN\'s Eastern day, not the night before in the city\'s zone', () => {
  const [g] = normalizeEspn({ events: [{ date: '2026-11-28T05:00Z', competitions: [{ venue: { fullName: 'Martin Stadium' }, timeValid: false, status: { type: { detail: 'TBD' } },
    competitors: [{ team: { id: '265' }, homeAway: 'home' }, { team: { id: '70', displayName: 'Washington Huskies' }, homeAway: 'away' }] }] }] }, '265');
  assert.equal(g.date, '2026-11-28'); assert.equal(g.time, null); assert.equal(g.tbd, true);
});

test('htRegular: a HockeyTech season named "Regular Season" or by its years alone is the regular season; playoffs and preseason are not', () => {
  assert.ok(htRegular({ name: '2026-27 Regular Season' })); assert.ok(htRegular({ name: '2026-27' }));
  assert.ok(!htRegular({ name: '2026-27 Playoffs' })); assert.ok(!htRegular({ name: '2026 Preseason' }));
});

test('ESPN: a 23:59 Eastern clock with timeValid still true is a placeholder too — TBD, on ESPN\'s Eastern day', () => {
  const [g] = normalizeEspn({ events: [{ date: '2026-11-03T04:59Z', competitions: [{ venue: { fullName: 'Stan Sheriff Center' }, timeValid: true, status: { type: { detail: 'Mon, November 2nd at 11:59 PM EST' } },
    competitors: [{ team: { id: '62' }, homeAway: 'home' }, { team: { id: '2567', displayName: 'Seattle U Redhawks' }, homeAway: 'away' }] }] }] }, '62');
  assert.equal(g.date, '2026-11-02'); assert.equal(g.time, null); assert.equal(g.tbd, true);
});

test('normalizeGamesheet: a GameSheet row → the game shape in the city zone, OT/SO read from the period keys, the opponent id kept for the odds', () => {
  const side = (id, title, abbr, goals, periods) => ({ id, title, abbr, logo: `https://img/${id}`, goals, result: null, goalsByPeriod: periods, overallRecord: '0-0-0-0' });
  const rows = [
    { gameId: 1, date: 'Sep 18, 2026', time: '7:05 PM', status: 'final', location: 'Nelson Center', timeStampZulu: '2026-09-19T00:05:00Z', gameType: 'regular_season',
      home: side(1, 'Springfield Jr. Blues', 'SPR', 4, { 1: 0, 2: 2, 3: 2, final: 4 }), visitor: side(523270, 'Anchorage Wolverines', 'ANC', 7, { 1: 3, 2: 2, 3: 2, final: 7 }) },
    { gameId: 2, date: 'Sep 23, 2026', time: '7:00 PM', status: 'final', location: 'Sullivan Arena', timeStampZulu: '2026-09-24T03:00:00Z',
      home: side(523270, 'Anchorage Wolverines', 'ANC', 3, { 1: 1, 2: 0, 3: 1, ot_1: 0, so: 2, final: 3 }), visitor: side(9, 'Iowa Falls Pistol Shrimp', 'IF', 2, { 1: 1, 2: 1, 3: 0, ot_1: 0, so: 1, final: 2 }) },
    { gameId: 3, date: 'Nov 6, 2026', time: '7:00 PM', status: 'scheduled', location: 'Sullivan Arena', timeStampZulu: '2026-11-07T04:00:00Z',
      home: side(523270, 'Anchorage Wolverines', 'ANC', null, {}), visitor: side(7, 'Fairbanks Ice Dogs', 'FAI', null, {}) },
    { gameId: 4, date: 'Nov 8, 2026', time: '7:00 PM', status: 'scheduled', location: 'Elsewhere', timeStampZulu: '2026-11-09T04:00:00Z', home: side(7, 'Fairbanks Ice Dogs', 'FAI', null, {}), visitor: side(8, 'Kenai River Brown Bears', 'KEN', null, {}) },
  ];
  const g = normalizeGamesheet(rows, 523270);
  assert.equal(g.length, 3); // the fourth game is two other clubs'
  const zone = (iso) => ({ date: new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ }), time: new Date(iso).toLocaleTimeString('en-GB', { timeZone: TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }) });
  assert.deepEqual(g[0], { ...zone('2026-09-19T00:05:00Z'), tbd: false, home: false, opp: { name: 'Springfield Jr. Blues', short: 'Blues', abbrev: 'SPR', logo: 'https://img/1', id: '1' }, venue: 'Nelson Center', res: { us: 7, them: 4, won: true } });
  assert.deepEqual(g[1].res, { us: 3, them: 2, won: true, ot: 'SO' });
  assert.equal(g[1].home, true);
  assert.equal(g[2].res, undefined);
  assert.deepEqual(normalizeGamesheet(rows.slice(2, 3), 523270, true)[0].playoff, true);
});
test('gamesheetForm: a standings row reads W-L-OTL-SOL, ranks in the division, keeps the home split and the club name', () => {
  assert.deepEqual(gamesheetForm({ rank: 2, division: { id: 81371, title: 'Midwest Division' }, team: { id: 523270, title: 'Anchorage Wolverines', abbreviation: 'ANC' }, stats: { W: 6, L: 3, OTL: 0, SOL: 1, GP: 10, PTS: 13, GTYPEREC: '6-3-0-1', HREC: '3-1-0-0' } }),
    { record: '6-3-0-1', standing: '2nd in the Midwest Division', home: '3-1-0-0', club: { name: 'Anchorage Wolverines', abbr: 'ANC' } });
});
