/**
 * iCalendar (RFC 5545) generation for the LQA events feed.
 *
 * Events are { venue, title, date: 'YYYY-MM-DD', time: 'HH:MM[:SS]'|'', url }.
 * Timed events are emitted in the city's zone (city.js `tz`) with a 3-hour
 * default duration; time-less events become all-day entries. UIDs hash
 * venue|title|date so subscribers' calendars update in place instead of
 * accumulating duplicates when the feed refreshes.
 */
import { createHash } from 'node:crypto';
import '../site/city.js'; // the calendar's name, PRODID and UID domain are the city's
const CITY = globalThis.LQACity;
import { setTimesText } from './settimes.mjs';

const TZID = CITY.tz || 'America/Los_Angeles'; // the city's zone (chicago-events brought the field, 2026-10-11)
const DEFAULT_DURATION_H = 3;

// Rolling tz definition so clients that ignore IANA names still get the
// zone's standard/daylight names: the US zones, which all change on the
// second Sunday of March and the first of November — bar Hawaii (and
// Arizona), which keep standard time all year (honolulu-events, 2026-10-11),
// and Quintana Roo, on Eastern Standard Time all year since 2015
// (cancun-events, 2026-10-13).
const US_ZONES = {
  'America/Los_Angeles': ['-0800', '-0700', 'PST', 'PDT'],
  'America/Denver': ['-0700', '-0600', 'MST', 'MDT'],
  'America/Phoenix': ['-0700', null, 'MST', null],
  'America/Chicago': ['-0600', '-0500', 'CST', 'CDT'],
  'America/New_York': ['-0500', '-0400', 'EST', 'EDT'],
  'America/Anchorage': ['-0900', '-0800', 'AKST', 'AKDT'],
  'Pacific/Honolulu': ['-1000', null, 'HST', null],
  'America/Cancun': ['-0500', null, 'EST', null],
  'America/Puerto_Rico': ['-0400', null, 'AST', null],
};
const [STD_OFF, DST_OFF, STD_NAME, DST_NAME] = US_ZONES[TZID] || US_ZONES['America/Los_Angeles'];
const VTIMEZONE = DST_OFF ? [
  'BEGIN:VTIMEZONE',
  `TZID:${TZID}`,
  'BEGIN:DAYLIGHT',
  `TZOFFSETFROM:${STD_OFF}`,
  `TZOFFSETTO:${DST_OFF}`,
  `TZNAME:${DST_NAME}`,
  'DTSTART:19700308T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  `TZOFFSETFROM:${DST_OFF}`,
  `TZOFFSETTO:${STD_OFF}`,
  `TZNAME:${STD_NAME}`,
  'DTSTART:19701101T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
] : [ // a zone without daylight time: one standard block, no rule
  'BEGIN:VTIMEZONE',
  `TZID:${TZID}`,
  'BEGIN:STANDARD',
  `TZOFFSETFROM:${STD_OFF}`,
  `TZOFFSETTO:${STD_OFF}`,
  `TZNAME:${STD_NAME}`,
  'DTSTART:19700101T000000',
  'END:STANDARD',
  'END:VTIMEZONE',
];

// The UID hashes venue|title|date (stable across runs, so a subscribed calendar keeps its entries). When two showings
// of one show share a day (the de-dupe key carries the clock since 2026-10-14) every one of them hashes the clock in
// too, so the feed never repeats a UID; a show with one showing keeps the UID it always had.
export function eventUid(e, withTime = false) {
  const base = `${e.venue}|${e.title}|${e.date}`;
  const hash = createHash('sha1').update(withTime ? `${base}|${(e.time || '').slice(0, 5)}` : base).digest('hex');
  return `${hash}@${CITY.ics.uidDomain}`;
}
const dayKey = (e) => `${e.venue}|${e.title}|${e.date}`;

export function escapeText(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// RFC 5545 §3.1: lines over 75 octets fold onto a continuation line that
// starts with a space. Split on character boundaries, counting octets.
export function foldLine(line) {
  const out = [];
  let cur = '';
  let curBytes = 0;
  const limit = () => (out.length === 0 ? 75 : 74); // continuation lines lose 1 octet to the leading space
  for (const ch of line) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (curBytes + b > limit()) {
      out.push(cur);
      cur = ch;
      curBytes = b;
    } else {
      cur += ch;
      curBytes += b;
    }
  }
  out.push(cur);
  return out.map((l, i) => (i === 0 ? l : ' ' + l)).join('\r\n');
}

const pad = (n) => String(n).padStart(2, '0');

function dateDigits(date) {
  return date.replaceAll('-', '');
}

// Local wall-clock arithmetic: add hours to a date+time and return the new
// Y/M/D/H/M components. Date handles day/month rollover for us; the host
// timezone doesn't matter because we construct and read in the same one.
function addHours(date, time, hours) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const t = new Date(y, mo - 1, d, h + hours, mi || 0);
  return `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}T${pad(t.getHours())}${pad(t.getMinutes())}00`;
}

function eventLines(e, dtstamp, twice) {
  const lines = ['BEGIN:VEVENT', `UID:${eventUid(e, twice)}`, `DTSTAMP:${dtstamp}`];
  if (e.time) {
    const [h, m] = e.time.split(':');
    lines.push(`DTSTART;TZID=${TZID}:${dateDigits(e.date)}T${pad(h)}${pad(m)}00`);
    if (e.end && e.end > e.time) {
      // real same-day end time from the source beats the default duration
      const [eh, em] = e.end.split(':');
      lines.push(`DTEND;TZID=${TZID}:${dateDigits(e.date)}T${pad(eh)}${pad(em)}00`);
    } else {
      lines.push(`DTEND;TZID=${TZID}:${addHours(e.date, e.time, DEFAULT_DURATION_H)}`);
    }
  } else {
    lines.push(`DTSTART;VALUE=DATE:${dateDigits(e.date)}`);
    lines.push(`DTEND;VALUE=DATE:${addHours(e.date, '00:00', 24).slice(0, 8)}`);
  }
  // a cancelled/postponed show keeps its slot, marked — calendars vary in
  // how they show STATUS:CANCELLED, so the summary says it too
  const prefix = e.status === 'cancelled' ? 'CANCELLED: ' : e.status === 'postponed' ? 'POSTPONED: ' : '';
  lines.push(`SUMMARY:${prefix}${escapeText(e.title)}${e.dateTbd ? ' (date TBD)' : ''}`);
  if (e.status === 'cancelled') lines.push('STATUS:CANCELLED');
  else if (e.status === 'postponed') lines.push('STATUS:TENTATIVE');
  lines.push(`LOCATION:${escapeText(e.venue)}`);
  if (e.status) {
    const since = e.statusSince ? ` (noticed ${e.statusSince.slice(0, 10)})` : '';
    lines.push(`DESCRIPTION:${escapeText(`This event has been ${e.status}${since}. Check the ticket page for refunds or a new date.`)}`);
  }
  else if (e.dateTbd) lines.push(`DESCRIPTION:${escapeText('Date not final — the league may still move this game. The feed updates within a few hours of a change.')}`);
  else if (Array.isArray(e.sets) && e.sets.length) lines.push(`DESCRIPTION:${escapeText('Set times\n' + setTimesText(e.sets))}`); // a festival day with its grid: a line per stage (Capitol Hill Block Party)
  else if (Array.isArray(e.lineup) && e.lineup.length) lines.push(`DESCRIPTION:${escapeText('Lineup: ' + e.lineup.join(', '))}`); // a festival day: the whole bill
  else if (e.stage) lines.push(`DESCRIPTION:${escapeText(e.stage + (e.end ? '' : ', to close'))}`); // one set of a festival day: its stage (the times are the event's own)
  if (e.url) lines.push(`URL:${escapeText(e.url)}`);
  lines.push('END:VEVENT');
  return lines;
}

export function buildIcs(events, now = new Date(), { calname = CITY.ics.name } = {}) {
  const showings = new Map(); // how many showings each venue|title|date has in this feed
  for (const e of events) showings.set(dayKey(e), (showings.get(dayKey(e)) || 0) + 1);
  const dtstamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${CITY.ics.prodid}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calname)}`,
    `X-WR-CALDESC:${CITY.ics.desc}`,
    `X-WR-TIMEZONE:${TZID}`,
    'REFRESH-INTERVAL;VALUE=DURATION:P1D', // the feed is rebuilt once a day at noon (Steve, 2026-10-11)
    'X-PUBLISHED-TTL:P1D',
    ...VTIMEZONE,
    ...events.flatMap((e) => eventLines(e, dtstamp, showings.get(dayKey(e)) > 1)),
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
