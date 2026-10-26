/**
 * Parsers for the Port of Everett's Revize CMS calendar. The calendar app
 * loads plain XML files from /calendar_app/db/ — an active-month index plus
 * one events file per month. Repeating events carry an explicit <dates>
 * list of occurrences (MM-DD-YYYY), which we expand to one event each.
 */

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

// 'Aug 4, 2026' (or 'August 4, 2026') → '2026-08-04'; '' if unparseable
export function poeDate(s) {
  const m = /^([A-Za-z]{3,})\.?\s+(\d{1,2}),\s*(\d{4})/.exec(String(s).trim());
  if (!m) return '';
  const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
  return mo ? `${m[3]}-${mo}-${m[2].padStart(2, '0')}` : '';
}

// active-month index → ['202608', '202609', ...]
export function parsePoeMonths(xml) {
  return [...String(xml).matchAll(/<month>(\d{6})<\/month>/g)].map((m) => m[1]);
}

// one month's events file → [{title, date, time}], one entry per occurrence.
// Cancellations and the Port's "special event parking rates" notices (which
// shadow the real events) are dropped.
export function parsePoeEvents(xml) {
  const out = [];
  for (const ev of String(xml).match(/<event [\s\S]*?<\/event>/g) || []) {
    const grab = (re) => { const m = ev.match(re); return m ? m[1].trim() : ''; };
    const title = grab(/<name>\s*<!\[CDATA\[([\s\S]*?)\]\]/);
    if (!title || /^CANCEL/i.test(title) || /^Special Event Parking/i.test(title)) continue;
    const rawTime = grab(/<time_begin>([^<]*)<\/time_begin>/);
    const time = /^\d{1,2}:\d{2}$/.test(rawTime) ? `${rawTime.padStart(5, '0')}:00` : '';
    const dates = [];
    const rawDates = grab(/<dates>\s*([^<]*?)\s*<\/dates>/);
    if (rawDates) {
      for (const d of rawDates.split(',')) {
        const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(d.trim());
        if (m) dates.push(`${m[3]}-${m[1]}-${m[2]}`);
      }
    } else {
      const iso = poeDate(grab(/<date_begin>([^<]*)<\/date_begin>/));
      if (iso) dates.push(iso);
    }
    for (const date of dates) out.push({ title, date, time });
  }
  return out;
}

/**
 * Squarespace calendar/event collections (Everett Music Initiative, Late
 * Shift Everett) answer `<page>?format=json` with the same data the page
 * renders: `upcoming` items carrying an epoch-ms startDate, an HTML-escaped
 * title, a site-relative fullUrl and a location.addressTitle venue.
 */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'", nbsp: ' ' };
function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, name) => {
    if (name in ENTITIES) return ENTITIES[name];
    if (/^#x/i.test(name)) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name[0] === '#') return String.fromCodePoint(parseInt(name.slice(1), 10));
    return m;
  });
}

export function parseSquarespaceEvents(data, { base, fallbackVenue = 'Everett', venue } = {}) {
  const tz = data?.website?.timeZone || 'America/Los_Angeles';
  const fmtDate = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, dateStyle: 'short' });
  const fmtTime = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, timeStyle: 'medium' });
  const out = [];
  for (const it of data?.upcoming || []) {
    if (!Number.isFinite(it.startDate)) continue;
    const start = new Date(it.startDate);
    out.push({
      venue: venue || (it.location?.addressTitle || '').trim() || fallbackVenue, // `venue` pins a room's own calendar to its row, whatever each entry's location field says
      title: decodeEntities(it.title || '').replace(/\s+/g, ' ').trim(),
      date: fmtDate.format(start),
      time: fmtTime.format(start),
      url: it.fullUrl ? new URL(it.fullUrl, base).href : base,
    });
  }
  return out;
}

// Church events are never listed (Steve, 2026-10-11: "keep church event 100%
// not listed"): a listing whose venue or title names a church, chapel,
// ministry, worship service, congregation, parish or cathedral is dropped at
// every source and from the archive, before venue folding (so it cannot hide
// in "Elsewhere in Everett"). Tested in sources.test.mjs.
const CHURCH_RE = /\b(?:church(?:es)?|chapel|ministr(?:y|ies)|worship|congregation|parish|cathedral|tabernacle|sermon|bible stud(?:y|ies)|new life center)\b/i;
export function isChurch(e) { return CHURCH_RE.test(e.venue || '') || CHURCH_RE.test(e.title || ''); }

// Secondary sources list shows the primary ones already carry under slightly
// different titles ("… & Lady A" vs "… + Lady A"), so exact-key de-dupe
// misses them. A candidate is dropped when an existing event sits at the
// same venue, date and clock time; untimed events never clash.
export function dropTimeClashes(candidates, existing) {
  // clocks compared to the minute: Ticketmaster writes 19:30:00, the feeds 19:30 (Bend's Tower, 2026-10-21)
  const at = (e) => `${e.venue}|${e.date}|${String(e.time).slice(0, 5)}`;
  const taken = new Set(existing.filter((e) => e.time).map(at));
  return candidates.filter((e) => !e.time || !taken.has(at(e)));
}

/**
 * NWAC (Northwest Athletic Conference) schedules — the Everett Community
 * College Trojans' home games. nwacsports.com runs on PrestoSports, whose
 * schedule pages answer `?print=ical` with the whole conference's season for
 * one sport (the teamId parameter is ignored), so the feed is filtered to
 * the one college here. A VEVENT carries DTSTART (UTC, or ;VALUE=DATE for a
 * day with no time yet), SUMMARY "(Women's Soccer) Northwest University at
 * Everett (6-0)" — the sport in parentheses, "A at B" with B the host or
 * "A vs. B" at a neutral site, a score once final — CATEGORIES the sport,
 * LOCATION the ground ("Everett Memorial Stadium\, 3900 Broadway\, Everett\,
 * WA"), URL the box score's site path. A game is a home game when the
 * LOCATION names Everett (an "Everett vs." friendly at Starfire is not).
 */
const PT_DATE = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Los_Angeles', dateStyle: 'short' });
const PT_TIME = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Los_Angeles', timeStyle: 'medium' });
function icsText(s) { return String(s || '').replace(/\\([,;\\])/g, '$1').replace(/\\n/gi, ' ').trim(); }
export function parseNwacIcal(ics, { team = 'Everett', name = 'Everett CC Trojans', venue = 'Everett Community College', sport = '', base = 'https://nwacsports.com' } = {}) {
  const text = String(ics).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, ''); // unfold continuation lines
  const out = [];
  for (const ev of text.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || []) {
    const grab = (key) => { const m = ev.match(new RegExp(`^${key}(;[^:\\n]*)?:(.*)$`, 'm')); return m ? [m[2].trim(), m[1] || ''] : ['', '']; };
    const [summaryRaw] = grab('SUMMARY'), [location] = grab('LOCATION'), [categories] = grab('CATEGORIES'), [url] = grab('URL'), [dtstart, params] = grab('DTSTART');
    const summary = icsText(summaryRaw);
    const m = summary.match(/^(?:\(([^)]*)\)\s*)?(.*?)(?:\s*\(\d+-\d+\))?$/); // "(sport) A at B (score)"
    const kind = (m && m[1]) || icsText(categories) || sport;
    const matchup = (m && m[2]) || summary;
    const sides = matchup.split(/\s+(?:at|vs\.?)\s+/i);
    if (sides.length !== 2) continue;
    const away = /\s+at\s+/i.test(matchup) ? sides[0] : null;
    const hasTeam = new RegExp(`\\b${team}\\b`, 'i');
    if (!hasTeam.test(sides[0]) && !hasTeam.test(sides[1])) continue;
    const home = /everett/i.test(icsText(location)) || (!icsText(location) && away !== null && hasTeam.test(sides[1]));
    if (!home) continue;
    const opp = hasTeam.test(sides[0]) ? sides[1] : sides[0];
    let date = '', time = '';
    if (/VALUE=DATE/i.test(params)) { const d = dtstart.match(/^(\d{4})(\d{2})(\d{2})/); if (d) date = `${d[1]}-${d[2]}-${d[3]}`; }
    else { const d = dtstart.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/); if (d) { const t = new Date(Date.UTC(+d[1], d[2] - 1, +d[3], +d[4], +d[5], +d[6])); date = PT_DATE.format(t); time = PT_TIME.format(t); } }
    if (!date) continue;
    out.push({ venue, title: `${name} vs ${opp}${kind ? ` (${kind})` : ''}`, date, time, url: url ? new URL(icsText(url), base).href : base, type: 'sports' });
  }
  return out;
}

// --- CivicPlus calendars: the cities (Everett, Marysville, Mukilteo,
//     Snohomish) and the Everett Public Library run CivicPlus, whose
//     RSSFeed.aspx?ModID=58&CID=All-calendar.xml lists the month's events
//     with <calendarEvent:EventDates> "October 13, 2026",
//     <calendarEvent:EventTimes> "10:30 AM - 11:00 AM" and
//     <calendarEvent:Location> an address. Council, board and commission
//     meetings are civic business, not events, and go; Snohomish prefixes
//     permitted events with the permit's status ("APPROVED 2026 River Run"). ---
const MONTH_NO = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
export function civicDate(s) {
  const m = /([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/.exec(String(s || ''));
  const mo = m && MONTH_NO[m[1].toLowerCase()];
  return mo ? `${m[3]}-${String(mo).padStart(2, '0')}-${m[2].padStart(2, '0')}` : '';
}
export function civicTime(s) {
  const m = /(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?[Mm]\.?/.exec(String(s || ''));
  if (!m) return '';
  let h = Number(m[1]) % 12; if (/p/i.test(m[3])) h += 12;
  return `${String(h).padStart(2, '0')}:${m[2] || '00'}:00`;
}
const MEETING_RE = /\b(?:council|commission|committee|board|hearing|work session|study session|meeting|food bank|support group|klatch|office hours|public comment)\b/i;
export function isMeeting(title) { return MEETING_RE.test(title || ''); }
export function parseCivicPlusRss(xml, { venue, strip = /^(?:APPROVED|TENTATIVE|PENDING)\s*[-:]?\s*/i } = {}) {
  const out = [];
  for (const m of String(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = m[1];
    const tag = (n) => { const r = new RegExp(`<${n}>([\\s\\S]*?)</${n}>`).exec(item); return r ? decodeEntities(r[1].replace(/<!\[CDATA\[|\]\]>/g, '')).replace(/\s+/g, ' ').trim() : ''; };
    const title = tag('title').replace(strip, '');
    const date = civicDate(tag('calendarEvent:EventDates'));
    if (!title || !date || isMeeting(title)) continue;
    out.push({ venue, title, date, time: civicTime(tag('calendarEvent:EventTimes')), url: tag('link') });
  }
  return out;
}

// --- Sno-Isle Libraries: the BiblioCommons events gateway
//     (gateway.bibliocommons.com/v2/libraries/sno-isle/events, 100 a page)
//     answers with entities.events, each wrapping a `definition` of title,
//     start/end ("2026-12-16T09:30", local), branchLocationId and
//     isCancelled. The branches a short drive from Everett are kept and
//     named in the title; the rest of the system (Oak Harbor, Sultan, the
//     bookmobile) is not. ---
export function parseBiblioCommonsEvents(data, { venue, branches, base = 'https://sno-isle.bibliocommons.com' }) {
  const out = [];
  for (const [id, ev] of Object.entries(data?.entities?.events || {})) {
    const d = ev?.definition || {};
    const branch = branches[String(d.branchLocationId)];
    if (!branch || d.isCancelled || !/^\d{4}-\d{2}-\d{2}/.test(d.start || '')) continue;
    const title = decodeEntities(d.title || '').replace(/\s+/g, ' ').trim();
    if (isMeeting(title)) continue; // Friends of the Library meetings, the library board
    out.push({ venue, title: `${title} (${branch})`, date: d.start.slice(0, 10), time: /T\d{2}:\d{2}/.test(d.start) ? `${d.start.slice(11, 16)}:00` : '', url: `${base}/events/${id}` });
  }
  return out;
}

// --- JSON-LD events: a page that marks its events up as schema.org Event
//     (Wix event pages — Historic Downtown Snohomish — and Songkick's venue
//     page, the Historic Everett Theatre's stand-in while its own site is
//     down). startDate is the venue's wall-clock time, with or without an
//     offset; `at` keeps only events whose location names the place, since
//     Songkick pads a venue page with other rooms' shows. ---
export function parseJsonLdEvents(html, { venue, at, titleStrip }) {
  const out = [];
  for (const m of String(html || '').matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let j; try { j = JSON.parse(m[1]); } catch { continue; }
    for (const o of (Array.isArray(j) ? j : [j])) {
      if (!o || !/Event/.test(String(o['@type']))) continue;
      const loc = typeof o.location === 'object' ? o.location?.name : o.location;
      if (at && !at.test(loc || '')) continue;
      const sd = String(o.startDate || '');
      if (!/^\d{4}-\d{2}-\d{2}/.test(sd)) continue;
      out.push({ venue, title: decodeEntities(o.name || '').replace(titleStrip || /$^/, '').replace(/\s+/g, ' ').trim(), date: sd.slice(0, 10), time: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(sd) ? `${sd.slice(11, 16)}:00` : '', url: String(o.url || '').split('?')[0] });
    }
  }
  return out;
}

// --- City of Mill Creek: a Drupal events list (millcreekwa.gov/events) of
//     name, "Saturday, October 10, 2026" and location; the clock time sits
//     on each event's own page ("10:30 a.m. - 11:30 a.m."). ---
export function parseMillCreekEvents(html, { venue, base = 'https://millcreekwa.gov' }) {
  const out = [];
  for (const m of String(html || '').matchAll(/event-list__item-name">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?event-list__item-date">\s*([^<]+)</g)) {
    const date = civicDate(m[3]);
    const title = decodeEntities(m[2]).replace(/\s+/g, ' ').trim();
    if (!date || isMeeting(title)) continue;
    out.push({ venue, title, date, time: '', url: new URL(m[1], base).href });
  }
  return out;
}
export function millCreekTime(html) {
  const text = String(html || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ');
  const main = text.slice(Math.max(0, text.search(/event-detail|field--name-field-date|\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?/i)));
  return civicTime(/\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?/i.exec(main)?.[0]);
}
