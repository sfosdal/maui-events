// The ESPN canary: the site's live game block talks to ESPN from the
// browser (site/app.js pollLive → the scoreboard, then a game's summary),
// and ESPN changes its API without notice — on 2026-09-18 the scoreboard
// stopped taking a date range and every club's block sat on the pregame
// card through a game in progress, unnoticed until Steve asked. This asks
// for exactly what the site asks for, for every league in site/filter.js,
// and exits 1 when any answer is not what the site expects. The workflow
// runs it as its own job every six hours: a red run and GitHub's mail
// within six hours of the next change, without blocking the publish.
//   node scripts/espn-canary.mjs
import '../site/city.js'; // the city, then the rules — both attach to globalThis outside a browser
import '../site/filter.js';

const TRIES = 2, PAUSE_MS = 30000;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }).replace(/-/g, '');
// the request shape the site uses (app.js scoreboardUrl): a single date — a range is what broke
const scoreboardUrl = (k) => `https://site.api.espn.com/apis/site/v2/sports/${k}/scoreboard?dates=${today}${/college/.test(k) ? '&groups=80&limit=300' : ''}`;
const summaryUrl = (k, id) => `https://site.api.espn.com/apis/site/v2/sports/${k}/summary?event=${id}`;

const leagues = [...new Set(globalThis.LQAFilter.TEAMS.filter((t) => t.espn).map((t) => `${t.espn.sport}/${t.espn.league}`))];

async function check(url, expect) { // expect: a function of the parsed body that names what is missing, or returns '' when all is there
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) return `HTTP ${r.status}`;
  let j; try { j = await r.json(); } catch { return 'not JSON'; }
  return expect(j);
}
async function attempt() {
  const failures = [];
  for (const k of leagues) {
    const url = scoreboardUrl(k);
    let events = null;
    const bad = await check(url, (j) => { if (!Array.isArray(j.events)) return 'no events list'; events = j.events; return ''; }).catch((e) => e.message);
    if (bad) { failures.push(`${url} — ${bad}`); continue; }
    console.log(`ok  ${k} scoreboard: ${events.length} game${events.length === 1 ? '' : 's'} today`);
    const ev = events[0];
    if (!ev) continue;
    // a game's shape, as the site reads it: competitors with team ids and a status state
    const c = ev.competitions && ev.competitions[0];
    if (!c || !Array.isArray(c.competitors) || !c.competitors.every((x) => x.team && x.team.id != null) || !c.status || !c.status.type || !c.status.type.state) { failures.push(`${url} — a game without competitors/team ids/status state`); continue; }
    const sbad = await check(summaryUrl(k, ev.id), (j) => (j.header && j.boxscore ? '' : 'no header/boxscore')).catch((e) => e.message);
    if (sbad) failures.push(`${summaryUrl(k, ev.id)} — ${sbad}`); else console.log(`ok  ${k} summary: event ${ev.id}`);
  }
  return failures;
}

let failures = [];
for (let i = 1; i <= TRIES; i++) {
  failures = await attempt();
  if (!failures.length) break;
  if (i < TRIES) { console.log(`${failures.length} failing — trying once more in ${PAUSE_MS / 1000}s`); await new Promise((r) => setTimeout(r, PAUSE_MS)); }
}
if (failures.length) {
  console.error(`\nESPN canary: ${failures.length} of the site's requests no longer answer as expected:`);
  failures.forEach((f) => console.error(`  ${f}`));
  console.error('\nThe live game block (site/app.js pollLive, fetchNextOdds, fetchLastOut) depends on these. Check https://site.api.espn.com for the new shape.');
  process.exit(1);
}
console.log(`ESPN canary: all ${leagues.length} leagues answer as the site expects`);
