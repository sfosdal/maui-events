// Sold-out status for the Ticketmaster venues — a LOCAL job, not part of the
// Actions build. Ticketmaster's public APIs carry no availability (the
// Inventory Status API needs an entitlement this key lacks), and the calls
// the event pages make (the "facets" call on offeradapter.ticketmaster.com or
// services.ticketmaster.com — two hosts, one API) are bot-walled
// for curl and headless browsers alike. A real Chrome gets through: this
// script launches a separate, headed Chrome with its own profile, drives it
// over the DevTools protocol, opens each event's page, and asks — from inside
// that page, as the page itself does — for the inventory facets. A facet is
// a block of tickets on sale (its inventory type "primary" from the box
// office, "resale" from other fans, with a count). No primary block while
// the event is on sale = sold out (resale only). Writes scripts/data/soldout.json;
// scripts/soldout-run.sh (launchd, every six hours) runs this through the
// Chromium container in docker/soldout-browser/ and commits the file, and the
// Actions build stamps each event's counts and soldOut flag onto the feed.
// The Crocodile sells through TicketWeb, whose event pages answer a plain
// fetch (no browser): scripts/ticketweb.mjs reads the page's status and ticket
// types — a sold-out night, or on sale with availability letters, no counts.
//
//   node scripts/soldout-check.mjs            # every on-sale event at the venues below
//   node scripts/soldout-check.mjs --limit 5  # a quick run
//   node scripts/soldout-check.mjs --ticketweb # just the TicketWeb rooms, no browser
//   CDP_URL=http://127.0.0.1:9222 node scripts/soldout-check.mjs
//       # drive a Chrome that is already running with --remote-debugging-port
//       # (e.g. the Chromium-on-Xvfb container in docker/soldout-browser/)
//       # instead of launching one here
//
// Needs TICKETMASTER_API_KEY (.env) for the event list (Discovery API) and
// Google Chrome in /Applications. Takes a few seconds per event.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readTicketWeb, ticketWebId } from './ticketweb.mjs';
import { CITY } from './badges.mjs';
import { tmFetch } from './tm-fetch.mjs'; // paced, and a 429, 5xx or dropped connection retried (Steve, 2026-10-28: "I want ticketmaster calls to not fail")

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'scripts', 'data', 'soldout.json'); // committed — the build (fetch-events.mjs) stamps it onto the feed
// The venues checked (city.js): soldOut 'tm' = Ticketmaster event pages
// read in Chrome; 'ticketweb' = Discovery lists the room with
// ticketweb.com links, read with a plain fetch, keyed TW<id> (the
// Crocodile — Steve, 2026-10-06: "for croc, yeah"; the Showboxes are AXS,
// no key and no readable page, left alone).
const tmVenues = (kind) => Object.entries(CITY.venues).filter(([, v]) => v.tm && v.soldOut === kind).map(([label, v]) => ({ id: v.tm.id, match: v.tm.match, label }));
const VENUES = tmVenues('tm');
const TICKETWEB = tmVenues('ticketweb');
const UA = CITY.userAgent;
const SKIP = /parking|parkwhiz|arena tours?|all access pass|stadium tour|ballpark tour|theatre tours?|notification list|flex membership/i;
// the home teams' AWAY games too (Steve, 2026-09-16): the host club's Ticketmaster
// listing, found by the club's name within the window; only a primary listing
// (a 16-hex event id in its URL — the resale-only listings Ticketmaster carries
// for MLB and some WNBA hosts have another id and are skipped, so those games
// show nothing rather than a false sold-out). Matched to teams.json by club,
// date and opponent; the build stamps the counts onto the schedule.
const AWAY_DAYS = 45;
const CLUBS = Object.fromEntries(CITY.teams.filter((t) => t.club).map((t) => [t.slug, t.club]));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = path.join(os.homedir(), 'Library', 'Application Support', 'lqa-events-soldout'); // its own profile: never the everyday one
const PORT = 9333;
const CDP_URL = (process.env.CDP_URL || '').replace(/\/$/, ''); // an already-running browser's DevTools endpoint; empty = launch our own
const PAGE_WAIT_MS = 20000;
const limit = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || (process.argv.includes('--limit') ? Number(process.argv[process.argv.indexOf('--limit') + 1]) : 0);

if (!process.env.TICKETMASTER_API_KEY) {
  try { const m = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^TICKETMASTER_API_KEY=(.+)$/m); if (m) process.env.TICKETMASTER_API_KEY = m[1].trim(); } catch { /* no .env */ }
}
const KEY = process.env.TICKETMASTER_API_KEY;
if (!KEY) { console.error('No TICKETMASTER_API_KEY'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the events to check: on sale now, by the public (Discovery) ----
// a Discovery list read that failed after tmFetch's retries: the run is then partial, and every event it
// could not list keeps the last run's answer (until 2026-10-28 a dropped connection crashed the run instead)
let listFailed = false;
async function listEvents(venues = VENUES, idOf = (url) => { const m = (url || '').match(/\/event\/([0-9A-F]{16})/i); return m && m[1].toUpperCase(); }) {
  const out = [];
  const now = Date.now();
  for (const v of venues) {
    for (let page = 0; page < 5; page++) {
      const res = await tmFetch(`https://app.ticketmaster.com/discovery/v2/events.json?apikey=${KEY}&venueId=${v.id}&sort=date,asc&size=200&page=${page}`);
      if (!res.ok) { console.warn(v.label, 'discovery failed', res.status || res.statusText); listFailed = true; break; }
      const data = await res.json();
      const evs = (data._embedded && data._embedded.events) || [];
      for (const e of evs) {
        const id = idOf(e.url);
        if (!id || SKIP.test(e.name)) continue;
        if (v.match && !(((e._embedded || {}).venues || [{}])[0].name || '').toLowerCase().includes(v.match)) continue;
        const status = e.dates && e.dates.status && e.dates.status.code;
        const start = e.sales && e.sales.public && e.sales.public.startDateTime;
        const onsale = status === 'onsale' && start && Date.parse(start) <= now;
        out.push({ id, url: e.url, name: e.name, date: e.dates.start.localDate, venue: v.label, status, onsale });
      }
      if (!data.page || page + 1 >= data.page.totalPages) break;
    }
  }
  return out;
}

async function listAwayGames() {
  const out = [];
  let teams;
  try { teams = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'teams.json'), 'utf8')).teams || {}; } catch { return out; }
  const today = new Date(), until = new Date(today.getTime() + AWAY_DAYS * 864e5);
  const ymd = (d) => d.toISOString().slice(0, 10);
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const ours = new Set(VENUES.map((v) => v.id));
  for (const [slug, name] of Object.entries(CLUBS)) {
    const games = (teams[slug] || []).filter((g) => !g.home && g.date >= ymd(today) && g.date <= ymd(until));
    if (!games.length) continue;
    let evs = [];
    try {
      const res = await tmFetch(`https://app.ticketmaster.com/discovery/v2/events.json?apikey=${KEY}&keyword=${encodeURIComponent(name)}&startDateTime=${ymd(today)}T00:00:00Z&endDateTime=${ymd(until)}T23:59:59Z&sort=date,asc&size=100`); // no country: the Kraken's Canadian hosts list on Ticketmaster Canada
      if (!res.ok) { console.warn(slug, 'discovery failed', res.status || res.statusText); listFailed = true; continue; }
      evs = ((await res.json())._embedded || {}).events || [];
    } catch (e) { console.warn(slug, 'discovery failed', String(e).slice(0, 60)); listFailed = true; continue; }
    await sleep(250); // Discovery's rate limit: five a second
    for (const g of games) {
      const opp = [g.opp && g.opp.name, g.opp && g.opp.short].filter(Boolean).map(norm);
      const e = evs.find((x) => {
        const v = ((x._embedded || {}).venues || [])[0] || {};
        if (ours.has(v.id) || SKIP.test(x.name) || /half price|\bpromo\b|\bpresale\b/i.test(x.name) || !x.dates || !x.dates.start || x.dates.start.localDate !== g.date) return false; // not a promo's own listing ("HALF PRICE: …" — its page reads as sold out once the offer ends)
        const n = norm(x.name);
        return n.includes(norm(name).replace(/^seattle |^washington /, '')) && opp.some((o) => n.includes(o));
      });
      const m = e && (e.url || '').match(/\/event\/([0-9A-F]{16})/i);
      if (!m) continue; // not listed, or resale only
      const status = e.dates.status && e.dates.status.code, start = e.sales && e.sales.public && e.sales.public.startDateTime;
      const venue = (((e._embedded || {}).venues || [])[0] || {}).name || g.venue;
      out.push({ id: m[1].toUpperCase(), url: e.url, name: e.name, date: g.date, venue, status, onsale: status === 'onsale' && start && Date.parse(start) <= Date.now(), club: slug, away: true });
    }
  }
  return out;
}

// ---- Chrome over the DevTools protocol (no packages: Node's own WebSocket) ----
function launchChrome() {
  fs.mkdirSync(PROFILE, { recursive: true });
  const child = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check',
    '--window-size=1200,900', '--window-position=1400,80', 'about:blank',
  ], { env: { HOME: os.homedir(), PATH: '/usr/bin:/bin', TMPDIR: os.tmpdir() }, stdio: 'ignore', detached: false }); // a clean environment: nothing of this shell's leaks into the browser
  return child;
}
async function connect() {
  let targets = null;
  const base = CDP_URL || `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 60 && !targets; i++) { try { targets = await (await fetch(`${base}/json`)).json(); } catch { await sleep(500); } }
  if (!targets) throw new Error('Chrome did not answer at ' + base);
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map(); const listeners = [];
  // a socket that dies mid-run (the Mac slept, 2026-10-06; the container went
  // away) used to leave every send waiting for ever — the Oct 8 run hung two
  // days on one — so a close answers them all with an error and is remembered
  let closed = false;
  const fail = (why) => { closed = true; for (const res of pending.values()) res({ error: { message: why } }); pending.clear(); };
  ws.onclose = () => fail('socket closed'); ws.onerror = () => fail('socket error');
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result || { error: d.error }); pending.delete(d.id); return; }
    listeners.forEach((fn) => fn(d));
  };
  const send = (method, params = {}) => closed ? Promise.resolve({ error: { message: 'socket closed' } }) : new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
  await send('Network.enable'); await send('Page.enable');
  // the page's own facets response is read as it arrives (Fetch domain, response stage) — surer than asking again from inside the page
  await send('Fetch.enable', { patterns: [{ urlPattern: '*.ticketmaster.com/api/ismds/event/*/facets*', requestStage: 'Response' }, { urlPattern: '*.ticketmaster.ca/api/ismds/event/*/facets*', requestStage: 'Response' }] }); // the same call comes from offeradapter.ticketmaster.com on some pages and services.ticketmaster.com on others
  return { send, on: (fn) => listeners.push(fn), off: (fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }, close: () => ws.close(), closed: () => closed };
}

// ---- one event: its page, then its facets, asked from inside the page ----
async function checkEvent(cdp, ev) {
  let body = null, facetsUrl = null;
  const want = new RegExp('/event/' + ev.id + '/facets\\?.*by=inventorytypes%20offertypes', 'i'); // this event's own inventory call (a late one from the page before is not it)
  const seen = async (d) => {
    if (d.method !== 'Fetch.requestPaused') return;
    const p = d.params;
    if (p.responseStatusCode && p.request.method === 'GET' && want.test(p.request.url) && !body) { // the CORS preflight (OPTIONS) answers first, with no body worth reading
      facetsUrl = p.request.url;
      const r = await cdp.send('Fetch.getResponseBody', { requestId: p.requestId });
      if (r && r.body) body = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
    }
    cdp.send('Fetch.continueRequest', { requestId: p.requestId });
  };
  cdp.on(seen);
  const t0 = Date.now();
  try {
    await cdp.send('Page.navigate', { url: ev.url });
    while (Date.now() - t0 < PAGE_WAIT_MS && !body) await sleep(250);
  } finally { cdp.off(seen); }
  if (!body && facetsUrl) { // seen but not read: ask again from inside the page, as the page itself does
    const r = await cdp.send('Runtime.evaluate', { expression: `fetch(${JSON.stringify(facetsUrl)}, { headers: { accept: 'application/json' } }).then((r) => r.text().then((t) => r.status + ' ' + t)).catch((e) => 'ERR ' + e)`, awaitPromise: true, returnByValue: true });
    const text = (r.result && r.result.value) || '';
    if (text.slice(0, 3) === '200') body = text.slice(4); else return { status: 'unknown', note: 'facets ' + text.slice(0, 80) };
  }
  if (!body) { // no inventory call (an older page layout lists tickets without it): read the list — box-office rows ("Standard Admission … $50.55"), resale rows, or Ticketmaster's own "sold out" wording
    const r = await cdp.send('Runtime.evaluate', { expression: '(document.body && document.body.innerText || "").replace(/\\s+/g, " ").slice(0, 60000)', returnByValue: true });
    const text = (r.result && r.result.value) || '';
    const prices = (re) => [...text.matchAll(re)].map((m) => Number(m[1].replace(/,/g, '')));
    const std = prices(/(?:Standard Admission|Official Platinum|General Admission)[^$]{0,80}?\$([\d,]+(?:\.\d+)?)/g);
    const rs = prices(/Verified Resale[^$]{0,80}?\$([\d,]+(?:\.\d+)?)/g);
    if (std.length) return { status: 'available', primary: null, resale: 0, fromPrimary: Math.min(...std), note: `${std.length} box-office listed on the page, no count` };
    if (rs.length) return { status: 'soldout', primary: 0, resale: 0, fromResale: Math.min(...rs), note: `${rs.length} resale listed on the page` };
    if (/tickets are sold out now|sold out/i.test(text)) return { status: 'soldout', primary: 0, resale: 0, note: 'page says sold out' };
    if (/on sale (soon|starts)|presale/i.test(text) && !/find tickets|standard admission|verified resale/i.test(text)) return { status: 'presale', note: 'page says not on sale yet' };
    return { status: 'unknown', note: 'no inventory call' };
  }
  let j; try { j = JSON.parse(body); } catch { return { status: 'unknown', note: 'facets unparsable' }; }
  const facets = j.facets || [];
  const sum = (type) => facets.filter((f) => (f.inventoryTypes || []).includes(type)).reduce((n, f) => n + (f.count || 0), 0);
  const primary = sum('primary'), resale = sum('resale');
  const price = (type) => facets.filter((f) => (f.inventoryTypes || []).includes(type)).flatMap((f) => f.listPriceRange || []).reduce((m, p) => (m == null || p.min < m ? p.min : m), null);
  if (primary === 0 && resale === 0) {
    // the inventory call counted nothing, yet the page may still list resale
    // (the NHL and NFL games do: their resale comes through another channel)
    // — a box office with nothing left and fans reselling is sold out; a
    // listing with nothing at all is 'none'
    // the inventory answer lands before the page has drawn its list — give it a moment, twice
    let text = '';
    for (let i = 0; i < 3 && !/Verified Resale Ticket|Standard Admission|sold out/i.test(text); i++) {
      await sleep(2500);
      const r = await cdp.send('Runtime.evaluate', { expression: '(document.body && document.body.innerText || "").replace(/\\s+/g, " ").slice(0, 60000)', returnByValue: true });
      text = (r.result && r.result.value) || '';
    }
    const prices = (re) => [...text.matchAll(re)].map((m) => Number(m[1].replace(/,/g, '')));
    const std = prices(/(?:Standard Admission|Official Platinum|General Admission)[^$]{0,80}?\$([\d,]+(?:\.\d+)?)/g);
    const rs = prices(/Verified Resale[^$]{0,80}?\$([\d,]+(?:\.\d+)?)/g);
    if (std.length) return { status: 'available', primary: null, resale: 0, fromPrimary: Math.min(...std), note: `${std.length} box-office listed on the page, no count` };
    if (rs.length) return { status: 'soldout', primary: 0, resale: 0, fromResale: Math.min(...rs), note: `${rs.length} resale listed on the page` };
    if (/tickets are sold out now|sold out/i.test(text)) return { status: 'soldout', primary: 0, resale: 0, note: 'page says sold out' };
  }
  return { status: primary > 0 ? 'available' : resale > 0 ? 'soldout' : 'none', primary, resale, fromPrimary: price('primary'), fromResale: price('resale') };
}

// ---- a TicketWeb event: its page, fetched plainly ----
async function checkTicketWeb(ev) {
  const res = await fetch(ev.url, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow' });
  if (!res.ok) return { status: 'unknown', note: `HTTP ${res.status}` };
  return readTicketWeb(await res.text());
}

const home = await listEvents(), tw = await listEvents(TICKETWEB, (url) => { const id = ticketWebId(url); return id && 'TW' + id; }), away = await listAwayGames();
const events = home.concat(tw, away.filter((a) => !home.some((h) => h.id === a.id)));
if (process.argv.includes('--list')) { // just the list, no browser: what a run would check
  for (const e of events) console.log(`${e.date}  ${e.away ? 'AWAY ' + e.club.padEnd(9) : 'home '.padEnd(14)} ${e.onsale ? 'onsale ' : (e.status || '?').padEnd(7)} ${e.name.slice(0, 50).padEnd(50)} ${e.venue}`);
  process.exit(0);
}
const onlyAway = process.argv.includes('--away'), onlyTw = process.argv.includes('--ticketweb'); // just the away games / just the TicketWeb rooms (a partial run keeps the rest of the last one)
const isTw = (e) => /^TW\d+$/.test(e.id);
const todo = onlyTw ? [] : events.filter((e) => e.onsale && !isTw(e) && (!onlyAway || e.away)).slice(0, limit || undefined); // the browser's list
const todoTw = onlyAway ? [] : events.filter((e) => e.onsale && isTw(e));
console.log(`${home.length} events at ${VENUES.length} venues + ${tw.length} at ${TICKETWEB.length} TicketWeb room${TICKETWEB.length === 1 ? '' : 's'} + ${away.length} away games, ${events.filter((e) => e.onsale).length} on sale, checking ${todo.length} in the browser and ${todoTw.length} by fetch`);
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')).events || {} : {};
const results = {};
function record(ev, res, t0) {
  // a run that saw nothing (the page gave no answer, or nothing either way)
  // doesn't erase a real answer from the run before: keep it, with its own
  // check time, so the site's "checked Sep 15" stays honest (Steve, 2026-09-15)
  const last = prev[ev.id];
  if (/^(none|unknown)$/.test(res.status) && last && /^(available|soldout)$/.test(last.status)) {
    res = { ...last, note: `kept from ${last.checked.slice(0, 10)}: this run ${res.status}${res.note ? ' (' + res.note + ')' : ''}` };
    results[ev.id] = { ...res, name: ev.name, date: ev.date, venue: ev.venue, ...(ev.away ? { club: ev.club, away: true } : {}) };
  } else {
    results[ev.id] = { ...res, name: ev.name, date: ev.date, venue: ev.venue, ...(ev.away ? { club: ev.club, away: true } : {}), checked: new Date().toISOString() };
  }
  console.log(`${ev.date}  ${ev.name.slice(0, 44).padEnd(44)}  ${res.status.padEnd(9)} primary ${String(res.primary ?? '-').padStart(5)}  resale ${String(res.resale ?? '-').padStart(5)}  ${res.note || ''}  (${Date.now() - t0}ms)`);
}
for (const ev of todoTw) { // the fetch-only rooms first: no browser to keep waiting
  const t0 = Date.now();
  let res;
  try { res = await checkTicketWeb(ev); } catch (e) { res = { status: 'unknown', note: String(e).slice(0, 80) }; }
  record(ev, res, t0);
  await sleep(400);
}
const EVENT_TIMEOUT_MS = 90000; // the slowest honest page answers in ~20 s; one silent for this long is given up, not waited on
const giveUp = (ms) => new Promise((r) => setTimeout(r, ms).unref()); // unref: the losing timer must not keep the process alive after the run
const chrome = todo.length && !CDP_URL ? launchChrome() : null;
let aborted = false; // the browser stopped answering: the rest of the list keeps the last run's answers
try {
  const cdp = todo.length ? await connect() : null;
  let stalls = 0;
  for (const ev of todo) {
    const t0 = Date.now();
    let res;
    try { res = await Promise.race([checkEvent(cdp, ev), giveUp(EVENT_TIMEOUT_MS).then(() => ({ status: 'unknown', note: `no answer in ${EVENT_TIMEOUT_MS / 1000} s`, stalled: true }))]); } catch (e) { res = { status: 'unknown', note: String(e).slice(0, 80) }; }
    stalls = res.stalled ? stalls + 1 : 0; delete res.stalled;
    record(ev, res, t0);
    if (cdp.closed() || stalls >= 3) { aborted = true; console.log(`browser ${cdp.closed() ? 'connection lost' : 'not answering'} after ${ev.date} ${ev.name.slice(0, 40)} — giving up the rest of this run; the last run's answers stand for it`); break; }
  }
  if (cdp) cdp.close();
} finally {
  if (chrome) chrome.kill();
}
for (const ev of events) if (!ev.onsale) results[ev.id] = { status: 'presale', name: ev.name, date: ev.date, venue: ev.venue, ...(ev.away ? { club: ev.club, away: true } : {}), checked: new Date().toISOString() }; // not yet on public sale: nothing to be sold out of
if (listFailed) console.log('a Discovery list read failed — the events it could not list keep the last run\'s answers');
if (limit || onlyAway || onlyTw || aborted || listFailed) for (const k of Object.keys(prev)) if (!results[k]) results[k] = prev[k]; // a partial run keeps the rest of the last one
fs.writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), _: 'scripts/soldout-check.mjs (a local run — Ticketmaster inventory as a real Chrome sees it, TicketWeb pages (TW… keys, the Crocodile) by plain fetch; committed by scripts/soldout-run.sh). status: available = box-office tickets on sale; soldout = only resale left; none = the inventory call and the page both showed nothing (not treated as sold out); presale = public sale not started; unknown = the page gave no answer; a none/unknown run keeps the last real answer, its own checked time, note says so.', events: results }, null, 1) + '\n');
const tally = {}; for (const r of Object.values(results)) tally[r.status] = (tally[r.status] || 0) + 1;
console.log('wrote', path.relative(ROOT, OUT), JSON.stringify(tally));
