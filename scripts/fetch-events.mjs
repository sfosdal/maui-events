#!/usr/bin/env node
/**
 * Aggregates upcoming events across Maui County — Maui, Lānaʻi and Molokaʻi —
 * into site/events.json and site/events.ics. Runs in CI (see
 * .github/workflows/events.yml) and locally for preview. The pipeline is
 * lqa-events' (scripts/*.mjs are its files, byte for byte); only the sources
 * below and site/city.js are Maui's.
 *
 * Each source returns [{ venue, title, date, time, url }]. Ticketmaster lists
 * almost nothing on Maui (two rows at the MACC, one at the ʻĪao Theater — both
 * rooms read their own calendars first, `tm.secondary`), so the island runs on
 * venue calendars: most through scripts/feeds.mjs (city.js `feed`), two parsed
 * here — the MACC's "Load More" pages and Da Playground's Shopify ticket shop.
 * The Rainbow Warriors' seasons come from ESPN (scripts/schedules.mjs).
 */
import './failures.mjs'; // first: every outside call retried, the ones still failing written to failures.json (Steve, 2026-10-29)
import { build, BROWSER_UA, unent } from './build.mjs';
import { CITY } from './badges.mjs';
import { parseCards, cardDates } from './feeds.mjs';

const venueType = (rows) => rows.map((e) => (e.type || !CITY.venues[e.venue] ? e : { ...e, type: CITY.venues[e.venue].type })); // a typeless row takes its venue's type

// --- The Maui Arts & Cultural Center: its events listing ---
// mauiarts.org/events renders nine cards and loads the rest from
// /show-filtered-results?p=N — a plain GET answering { status, newHtml, lastPage } — so the
// pages are read one after another and cut into cards (feeds.mjs parseCards): <h2 class="show-title">
// under the show-details link, the date and clock in <div class="show-date"> ("October 28, 2026 at
// 7:00 pm"). The room (Castle, McCoy, the Amphitheater) is only on the detail page and is not read.
const MACC_URL = 'https://mauiarts.org/show-filtered-results';
const MACC_CARD = { item: '<div class="show-item"', title: /<a\s+href="([^"]+)">\s*<h2 class="show-title">([^<]+)<\/h2>/, when: /<div class="show-date">\s*<p>(?:<i[^>]*><\/i>)?\s*([^<]+?)\s*<\/p>/ };
export function parseMaccPage(html) {
  return parseCards(html, { ...MACC_CARD, venue: 'Maui Arts & Cultural Center', type: 'arts', base: 'https://mauiarts.org/' });
}
async function maccListing() {
  const out = [];
  let pages = 0;
  for (let page = 1; page <= 12; page++) {
    const res = await fetch(`${MACC_URL}?p=${page}`, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } }); // `p`, as the page's Load More button sends it (`page` is ignored and answers the first nine every time)
    if (!res.ok) throw new Error(`MACC page ${page} HTTP ${res.status}`);
    const data = await res.json();
    out.push(...parseMaccPage(data.newHtml || '')); pages++;
    if (page >= Number(data.lastPage || 1)) break;
  }
  console.log(`Maui Arts & Cultural Center: ${out.length} events from ${pages} pages`);
  return out;
}

// --- The ʻĪao Theater: Maui OnStage's home page ---
// mauionstage.com lists the season as text cards (a Divi builder page): a date line in a <span>
// ("Oct 23", "Feb 14, 2027", "*NEW DATE – Nov 21"), the title in <b> inside an <h3> or a <p>, then
// a TICKETS link (ThunderTix, Ticketmaster, the First Friday site) — or "Tickets available SOON!"
// and no link, which goes in pointing at the home page. A card without a date (the donation and
// gift-certificate panels, "Ongoing") is skipped. No clock is printed; the rows go in as all-day.
const IAO_URL = 'https://www.mauionstage.com/';
export function parseIao(html) {
  const out = [];
  for (const card of String(html || '').split('<div class="et_pb_text_inner">').slice(1)) {
    const d = /<span[^>]*>(?:[^<]*?(?:&#8211;|–|-)\s*)?([A-Z][a-z]{2,8}\.? \d{1,2}(?:,? \d{4})?)\s*<\/span>/.exec(card);
    const t = /<(?:h3|p)[^>]*>(?:<span[^>]*>)*<b[^>]*>([^<]+)<\/b>/.exec(card);
    if (!d || !t) continue;
    const dates = cardDates(d[1]); if (!dates.length) continue;
    const a = /<a href=['"]([^'"]+)['"][^>]*>\s*TICKETS/i.exec(card);
    const title = unent(t[1]).replace(/\s+/g, ' ').trim();
    for (const { date } of dates) out.push({ venue: 'ʻĪao Theater', title, date, time: '', url: a ? unent(a[1]) : IAO_URL, type: 'arts' }); // cardDates gives { date, time }; no clock is printed
  }
  return out;
}
async function iaoListing() {
  const res = await fetch(IAO_URL, { headers: { 'User-Agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`ʻĪao Theater HTTP ${res.status}`);
  const evs = parseIao(await res.text());
  console.log(`ʻĪao Theater: ${evs.length} events`);
  return evs;
}

// --- Da Playground: its Shopify ticket shop ---
// daplaygroundmaui.com/collections/tickets lists each show as a product card — the title in
// <h3 class="card__heading"> over a caption "Friday - 10/30/2026" — and /collections/tickets/
// products.json carries the same products with their variants' `available` flags, so a show whose
// every variant is gone is sold out. No clock is printed (the body copy names one in prose); the
// rows go in as all-day.
const DPG_BASE = 'https://www.daplaygroundmaui.com';
export function parseDaPlayground(html, products = []) {
  const gone = new Set(products.filter((p) => Array.isArray(p.variants) && p.variants.length && p.variants.every((v) => v.available === false)).map((p) => p.handle));
  const out = [];
  const seen = new Set();
  for (const card of String(html || '').split('<div class="card__content">').slice(1)) { // each product's text block: the heading's link, then the caption
    const a = /<h3[^>]*class="card__heading[^"]*"[^>]*>\s*<a\s+href="(\/products\/([^"?#]+))"[^>]*>\s*([\s\S]*?)\s*<\/a>/.exec(card);
    const d = /caption-large light">\s*(?:[A-Za-z]+\s*-\s*)?(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(card);
    if (!a || !d) continue;
    const handle = a[2]; if (seen.has(handle)) continue; seen.add(handle);
    const title = unent(a[3].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); if (!title) continue;
    const ev = { venue: 'Da Playground', title, date: `${d[3]}-${d[1].padStart(2, '0')}-${d[2].padStart(2, '0')}`, time: '', url: DPG_BASE + a[1], type: 'concert' };
    if (gone.has(handle)) ev.soldOut = true;
    out.push(ev);
  }
  return out;
}
async function daPlayground() {
  const res = await fetch(`${DPG_BASE}/collections/tickets`, { headers: { 'User-Agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`Da Playground HTTP ${res.status}`);
  const html = await res.text();
  let products = [];
  try { const r = await fetch(`${DPG_BASE}/collections/tickets/products.json?limit=250`, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } }); if (r.ok) products = (await r.json()).products || []; }
  catch (err) { console.error(`Da Playground products.json: ${err.message}`); }
  const evs = parseDaPlayground(html, products);
  console.log(`Da Playground: ${evs.length} events, ${evs.filter((e) => e.soldOut).length} sold out`);
  return evs;
}

await build({
  feedUrl: 'https://maui.here.events/events.json',
  archiveUrl: 'https://raw.githubusercontent.com/sfosdal/maui-events/archive/events-archive.json',
  listedVenuesOnly: true, decodeEntities: true,
  gateSources: (primary) => primary, // the empty-list gate counts the leading sources
  primary: (s) => [...s.tmFirst, ...s.feedsFirst, maccListing, iaoListing, daPlayground].map((fn) => async () => venueType(await fn())),
});
