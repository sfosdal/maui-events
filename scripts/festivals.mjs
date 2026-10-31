// Festivals no single venue names (Steve, 2026-10-30: "once a week, good" + "the github link is fine"): a
// festival or promoter series spread over several venues — Baba Obscura's six stages — shows up in a city's
// feed only as unrelated rows. scripts/festival-finder.mjs (lqa, Mondays) reads every site's live feed, finds
// the same phrase at two or more venues within ten days, and lists the finds as a checklist in one GitHub
// issue in sfosdal/lqa-events (label `festival-finder`), which GitHub mails to Steve. A box he ticks there is
// a yes; a box still unticked when the issue is closed (by the next Monday's) is a no, never proposed again.
// Every city's build (stampFestivals) reads those answers and gives each event of an approved find its
// festival's name — a line on the row and a word the search matches; a filter row of its own is a city.js
// venue and a registry slot, added by hand when Steve asks. Shared: byte-for-byte in every city.

const REPO = 'sfosdal/lqa-events', LABEL = 'festival-finder';
const STOP = new Set('the a an and of at in on with for to from by vs live night tour presents feat ft featuring show concert music party special guest guests tickets event edition day days part vol volume'.split(' '));
const NOISE = /\b(mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|sold|out|new year'?s|christmas|halloween|nye|thanksgiving|anniversary|mens|womens|men's|women's|basketball|football|soccer|hockey|volleyball|baseball|university|state|college|vs|ice|tour)\b|\d/i;
const FEST = /\b(fest(ival)?|crawl|showcase|block party|takeover|art walk|week|weekend|series)\b/i;
const WINDOW_DAYS = 10;
// stock phrases that join unrelated shows (2026-10-30 dry run: "Open Mic", "Hip Hop", "All Ages", "Album Release" …)
const GENERIC = /^(open mic|open house|hip hop|all ages|album release|trick or|year'?s eve|after dark|north america|record release|comedy night|dance party|jam session|happy hour|trivia night|drag brunch|in concert|and friends|tribute to|the music of|a tribute|live on stage|on ice)$/;

export const words = (t) => String(t || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').match(/[a-z0-9'’]+/g) || [];
export const norm = (t) => words(t).join(' ');
function grams(t) {
  const w = words(t), g = new Set();
  for (const n of [2, 3, 4]) for (let i = 0; i + n <= w.length; i++) {
    const x = w.slice(i, i + n);
    if (!STOP.has(x[0]) && !STOP.has(x[n - 1])) g.add(x.join(' '));
  }
  return g;
}
const addDays = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
// the phrase as a title writes it ("Baba Obscura"), else in title case
function nameOf(phrase, titles) {
  for (const t of titles) {
    const re = new RegExp(phrase.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^a-z0-9]+'), 'i');
    const m = re.exec(t); if (m) return m[0];
  }
  return phrase.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// One city's finds: [{ key, city, phrase, name, start, end, venues, count, titles }], the strongest first.
// `skipVenues`: the city's festival venues (city.js `festival: true`) — a festival already on the site is not a find.
// A find is a phrase with a festival word in it ("Flyover Comedy Festival", "Art Walk") at two venues or more, or any
// phrase at three or more; games, and phrases that are part of a venue's or the city's own name, never count.
export function detect(events, { city, cityName = '', today, skipVenues = new Set(), decided = new Set() } = {}) {
  const ev = events.filter((e) => e.date >= today && e.venue && e.title && !skipVenues.has(e.venue) && e.type !== 'sports');
  const names = ` ${[...new Set(events.map((e) => e.venue))].concat(cityName).map(norm).join(' | ')} `;
  const by = new Map();
  for (const e of ev) for (const g of grams(e.title)) { if (!by.has(g)) by.set(g, []); by.get(g).push(e); }
  const found = new Map();
  for (const [g, es] of by) {
    if (NOISE.test(g) || GENERIC.test(g) || names.includes(` ${g} `) || names.includes(` ${g} |`) || decided.has(`${city}|${g}`)) continue;
    for (const d0 of [...new Set(es.map((e) => e.date))].sort()) {
      const win = es.filter((e) => e.date >= d0 && e.date <= addDays(d0, WINDOW_DAYS));
      const vs = new Set(win.map((e) => e.venue));
      const whole = win.filter((e) => { const t = norm(e.title); return t.startsWith(g) && t.length - g.length < 12; }).length;
      if (whole === win.length && !FEST.test(g)) break; // the phrase IS the title: one act or show at two venues, not a series
      if ([...vs].some((v) => /librar|storytime/i.test(v))) break;
      if (vs.size >= (FEST.test(g) ? 2 : 3) && win.length >= 3) {
        if (new Set(es.map((e) => e.date.slice(0, 7))).size > 3 && !FEST.test(g)) break; // a residency or a tour: the phrase on 4+ months
        const k = win.map((e) => `${e.venue}|${e.date}|${e.title}`).sort().join('\n');
        const score = vs.size * 2 + win.length + (FEST.test(g) ? 6 : 0);
        const had = found.get(k);
        if (!had || had.score < score || (had.score === score && g.length > had.phrase.length)) {
          const titles = [...new Set(win.map((e) => e.title))].sort();
          found.set(k, { key: `${city}|${g}`, city, phrase: g, name: nameOf(g, titles), start: d0, end: win.map((e) => e.date).sort().pop(), venues: [...vs].sort(), count: win.length, titles: titles.slice(0, 2), score });
        }
        break;
      }
    }
  }
  const best = new Map(); // the best phrase per (start, venues)
  for (const f of found.values()) {
    const k = f.start + '|' + f.venues.join('|'), had = best.get(k);
    if (!had || f.score > had.score || (f.score === had.score && f.phrase.length > had.phrase.length)) best.set(k, f);
  }
  const seen = new Set(); // one line per phrase
  return [...best.values()].sort((a, b) => b.score - a.score || a.start.localeCompare(b.start)).filter((f) => !seen.has(f.key) && seen.add(f.key));
}

// ---- the issue: one checklist line per find, its key in a comment GitHub keeps when a box is ticked ----
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (d) => `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
const span = (a, b) => a === b ? day(a) : a.slice(0, 7) === b.slice(0, 7) ? `${day(a)}–${Number(b.slice(8, 10))}` : `${day(a)} – ${day(b)}`;
export function issueLine(f) {
  const vs = f.venues.length > 4 ? f.venues.slice(0, 4).join(', ') + ` +${f.venues.length - 4}` : f.venues.join(', ');
  return `- [ ] **${f.name}** · ${span(f.start, f.end)} · ${f.count} events at ${vs} · e.g. “${f.titles[0].slice(0, 90)}” <!-- fest ${f.key}|${f.name.replace(/-->|\|/g, ' ')} -->`;
}
// { approved: Map key → { city, phrase, name }, rejected: Set of keys, pending: Set }
// a ticked box in any issue is a yes; an unticked one is a no once its issue is closed, pending while it is open
export function readAnswers(issues) {
  const approved = new Map(), rejected = new Set(), pending = new Set();
  for (const is of issues) for (const m of String(is.body || '').matchAll(/^\s*[-*] \[( |x|X)\][^\n]*?<!-- fest ([^|\n]+)\|([^|\n]+)\|([^\n]*?) -->/gm)) {
    const key = `${m[2]}|${m[3]}`;
    if (m[1] !== ' ') approved.set(key, { city: m[2], phrase: m[3], name: m[4].trim() });
    else (is.state === 'closed' ? rejected : pending).add(key);
  }
  for (const k of approved.keys()) { rejected.delete(k); pending.delete(k); }
  return { approved, rejected, pending };
}
export async function fetchIssues({ token = process.env.GITHUB_TOKEN, fetchImpl = fetch } = {}) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const r = await fetchImpl(`https://api.github.com/repos/${REPO}/issues?labels=${LABEL}&state=all&per_page=100&page=${page}`, { headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    if (!r.ok) throw new Error(`GitHub issues HTTP ${r.status}`);
    const list = await r.json(); out.push(...list);
    if (list.length < 100) break;
  }
  return out;
}

// The city build's half: every event of an approved find for this city carries `festival` (its name).
// The phrase is matched in the title, any year, so a festival approved once is found again next time it comes round.
export async function stampFestivals(events, { city, issues, fetchImpl } = {}) {
  let answers;
  try { answers = readAnswers(issues || await fetchIssues({ fetchImpl })); } catch (err) { console.error('Festivals: answers not read —', err.message); return 0; }
  const mine = [...answers.approved.values()].filter((a) => a.city === city);
  let n = 0;
  for (const e of events) {
    const t = ` ${norm(e.title)} `;
    const a = mine.find((x) => t.includes(` ${x.phrase} `));
    if (a) { e.festival = a.name; n++; }
  }
  if (mine.length) console.log(`Festivals: ${mine.length} approved, ${n} events named`);
  return n;
}
export { REPO, LABEL };
