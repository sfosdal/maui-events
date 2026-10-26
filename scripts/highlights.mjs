// Each recent game's highlight clips, from the league where it publishes a
// feed and from the club's and the league's official YouTube channels
// otherwise, attached to the game as clips: [{ title, url }] for the Teams
// view's news column (the Mariners' come from MLB's statsapi in the
// browser; these stand behind them).
//   NHL  api-web.nhle.com gamecenter landing (each goal's clip on nhl.com)
//        and right-rail (the three-minute recap) — no CORS, so only here
//   NFL  nfl.com's game page, which embeds the game highlights and the
//        can't-miss plays as title/webLink pairs (no public video API)
//   all  the club's and the league's YouTube uploads feed (Atom, no key,
//        the last fifteen uploads): a video published from the game's day
//        to two days after that names the opponent and isn't a presser,
//        interview or preview
// Only games of the last few days are fetched; clips already on the
// published teams.json are carried forward, since YouTube's feed forgets a
// game within days on the busier channels.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36';
const DAYS = 4; // played games this many days back are looked up
const MAX = 6; // clips kept per game
import { CITY } from './badges.mjs';
export const CHANNELS = Object.fromEntries(CITY.teams.filter((t) => t.youtube).map((t) => [t.slug, t.youtube])); // YouTube channel ids: the club's, then the league's
const LABEL = Object.fromEntries(CITY.teams.map((t) => [t.slug, t.label]));
const unesc = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(n));
const seattleDay = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: CITY.tz || 'America/Los_Angeles' }); // the city's day
const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function getText(url, headers = { 'user-agent': UA }) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
const getJson = async (url) => JSON.parse(await getText(url, { accept: 'application/json' }));

// ---- YouTube ----
export function parseYoutube(xml) { // [{ title, url, at }] newest first, as the feed lists them
  const out = [];
  for (const m of String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const title = unesc((e.match(/<title>([^<]*)<\/title>/) || [])[1]);
    const id = (e.match(/<yt:videoId>([^<]*)<\/yt:videoId>/) || [])[1];
    const at = (e.match(/<published>([^<]*)<\/published>/) || [])[1] || '';
    if (title && id) out.push({ title, url: `https://www.youtube.com/watch?v=${id}`, at });
  }
  return out;
}
const NOT = /press conference|presser|interview|post-?game sound|postgame sound|camp sound|preview|podcast|reaction|ticket|shorts?\b|behind the scenes|mic'?d up/i;
const HL = /highlight|recap|condensed|full match|full game|top plays|extended|every goal|all goals|goals? (?:vs|against|@)|scores|save/i;
const nick = (opp) => String(opp?.name || '').trim().split(/\s+/).pop() || '';
// a date in a title — "(9/10/26)", "September 12, 2026", "Sept 13, 2026" — as YYYY-MM-DD; a series' games are a day apart, so the title's date decides
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function titleDate(title) {
  const t = String(title || '');
  let m = t.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i);
  if (m) return `${m[3]}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}
export function matchYoutube(entries, game, slug) { // the game's videos from a channel's feed, highlight reels first
  const from = game.date, to = addDays(game.date, 2);
  const names = [game.opp?.short, nick(game.opp), game.opp?.name].filter((n) => n && n.length >= 4).map((n) => n.toLowerCase());
  const us = (LABEL[slug] || '').toLowerCase();
  const hits = entries.filter((v) => {
    if (!v.at) return false;
    const day = seattleDay(v.at);
    if (day < from || day > to) return false;
    const t = v.title.toLowerCase();
    if (NOT.test(t)) return false;
    const td = titleDate(v.title);
    if (td && td !== game.date) return false; // a title dated another day of the series
    const them = names.some((n) => t.includes(n)), ours = us && t.includes(us);
    return them && (ours || HL.test(t) || !us);
  });
  return [...hits.filter((v) => HL.test(v.title)), ...hits.filter((v) => !HL.test(v.title))].map((v) => ({ title: v.title, url: v.url }));
}

// ---- NHL ----
async function nhlClips(g) {
  const [land, rail] = await Promise.all([getJson(`https://api-web.nhle.com/v1/gamecenter/${g.id}/landing`), getJson(`https://api-web.nhle.com/v1/gamecenter/${g.id}/right-rail`).catch(() => ({}))]);
  const out = [];
  const vid = rail.gameVideo || {};
  if (vid.threeMinRecap) out.push({ title: 'Three-minute recap', url: `https://www.nhl.com/redirect/video/${vid.threeMinRecap}` });
  if (vid.condensedGame) out.push({ title: 'Condensed game', url: `https://www.nhl.com/redirect/video/${vid.condensedGame}` });
  for (const p of land.summary?.scoring || []) {
    for (const goal of p.goals || []) {
      const url = goal.highlightClipSharingUrl || (goal.highlightClip ? `https://www.nhl.com/redirect/video/${goal.highlightClip}` : null);
      if (!url) continue;
      const who = goal.name?.default || [goal.firstName?.default, goal.lastName?.default].filter(Boolean).join(' ');
      const per = p.periodDescriptor?.periodType === 'OT' ? 'OT' : p.periodDescriptor?.periodType === 'SO' ? 'SO' : `P${p.periodDescriptor?.number}`;
      out.push({ title: `${goal.teamAbbrev?.default || ''} goal: ${who} (${per} ${goal.timeInPeriod || ''})`.replace(/\s+\)/, ')'), url });
    }
  }
  return out;
}

// ---- NFL ----
export function parseNflPage(html) { // the game page's clips: the highlights reel first, then the can't-miss plays, then the rest
  const h = String(html).replace(/\\"/g, '"');
  const seen = new Set(), out = [];
  for (const m of h.matchAll(/"title":"([^"]+)","videos":\[\],"webLink":"(https:\/\/www\.nfl\.com\/videos\/[^"]+)"/g)) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]); out.push({ title: unesc(m[1]).replace(/\\u0026/g, '&'), url: m[2] });
  }
  const rank = (c) => (/\bhighlights\b/i.test(c.title) ? 0 : /can'?t-miss/i.test(c.title) ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b));
}
const nflSlug = (name) => nick({ name }).toLowerCase().replace(/[^a-z0-9]/g, '');
async function nflClips(g) {
  if (!g.week || !g.season) return [];
  const kind = g.playoff ? 'post' : 'reg';
  const path = g.home ? `${nflSlug(g.opp.name)}-at-seahawks` : `seahawks-at-${nflSlug(g.opp.name)}`;
  return parseNflPage(await getText(`https://www.nfl.com/games/${path}-${g.season}-${kind}-${g.week}`));
}

// ---- the pass over the schedules ----
const key = (g) => `${g.date}|${g.opp?.name || ''}`;
export async function addClips(seasons, prev = {}, today = seattleDay(new Date().toISOString())) {
  const since = addDays(today, -DAYS);
  const feeds = new Map(); // channel id -> promise of its entries
  const feed = (id) => { if (!feeds.has(id)) feeds.set(id, getText(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`).then(parseYoutube).catch((e) => { console.error(`clips: youtube ${id} — ${e.message}`); return []; })); return feeds.get(id); };
  let kept = 0, found = 0;
  for (const [slug, games] of Object.entries(seasons)) {
    const before = new Map((prev[slug] || []).filter((g) => g.clips?.length).map((g) => [key(g), g.clips]));
    for (const g of games) if (before.has(key(g))) { g.clips = before.get(key(g)).filter((c) => !titleDate(c.title) || titleDate(c.title) === g.date); if (g.clips.length) kept++; else delete g.clips; }
    const recent = games.filter((g) => g.res && g.date >= since && g.date <= today);
    await Promise.all(recent.map(async (g) => {
      const clips = [];
      try {
        if (slug === 'kraken' && g.id) clips.push(...await nhlClips(g));
        else if (slug === 'seahawks') clips.push(...await nflClips(g));
      } catch (e) { console.error(`clips: ${slug} ${g.date} league feed — ${e.message}`); }
      for (const id of CHANNELS[slug] || []) clips.push(...matchYoutube(await feed(id), g, slug));
      const seen = new Set(g.clips?.map((c) => c.url) || []), fresh = clips.filter((c) => !seen.has(c.url) && seen.add(c.url));
      if (fresh.length) { g.clips = [...(g.clips || []), ...fresh].slice(0, MAX); found += fresh.length; }
    }));
  }
  console.error(`clips: ${found} new highlight clip${found === 1 ? '' : 's'} found, ${kept} game${kept === 1 ? '' : 's'} carried forward`);
}
