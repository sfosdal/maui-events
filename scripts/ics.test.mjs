import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIcs, eventUid, foldLine } from './ics.mjs';

const TZ = globalThis.LQACity.tz || 'America/Los_Angeles'; // the city's zone, as ics.mjs names it

const NOW = new Date(Date.UTC(2026, 7, 24, 12, 0, 0)); // fixed DTSTAMP for tests

const timed = {
  venue: 'Climate Pledge Arena',
  title: 'The Strokes - Reality Awaits North America',
  date: '2026-08-28',
  time: '19:00:00',
  url: 'https://example.com/strokes',
};
const allDay = {
  venue: 'McCaw Hall',
  title: 'Peter Pan: Ready to Rise',
  date: '2026-08-29',
  time: '',
  url: 'https://example.com/peterpan',
};

test('calendar skeleton and metadata', () => {
  const ics = buildIcs([timed], NOW);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.match(ics, /VERSION:2\.0/);
  assert.match(ics, /X-WR-CALNAME:/);
  assert.match(ics, /X-PUBLISHED-TTL:P1D/); // the feed is rebuilt daily
  assert.match(ics, /BEGIN:VTIMEZONE/);
  assert.ok(ics.includes(`TZID:${TZ}`), 'VTIMEZONE in the city zone');
});

test('timed event gets local DTSTART and a 3h DTEND', () => {
  const ics = buildIcs([timed], NOW);
  assert.ok(ics.includes(`DTSTART;TZID=${TZ}:20260828T190000`), 'DTSTART 20260828T190000');
  assert.ok(ics.includes(`DTEND;TZID=${TZ}:20260828T220000`), 'DTEND 20260828T220000');
});

test('a cancelled event is marked in its summary and STATUS', () => {
  const ics = buildIcs([{ ...timed, status: 'cancelled' }], NOW);
  assert.match(ics, /SUMMARY:CANCELLED: The Strokes - Reality Awaits North America/);
  assert.match(ics, /STATUS:CANCELLED/);
  assert.match(ics, /DESCRIPTION:This event has been cancelled\. Check/);
  assert.match(buildIcs([{ ...timed, status: 'cancelled', statusSince: '2026-09-05T18:00:00.000Z' }], NOW), /has been cancelled \(noticed 2026-09-05\)/);
  const post = buildIcs([{ ...timed, status: 'postponed' }], NOW);
  assert.match(post, /SUMMARY:POSTPONED: /);
  assert.match(post, /STATUS:TENTATIVE/);
  assert.ok(!buildIcs([timed], NOW).includes('STATUS:'));
});

test('a dateTbd event flags its summary and carries a description', () => {
  const ics = buildIcs([{ ...timed, dateTbd: true }], NOW);
  assert.match(ics, /SUMMARY:The Strokes - Reality Awaits North America \(date TBD\)/);
  assert.match(ics, /DESCRIPTION:Date not final/);
  const plain = buildIcs([timed], NOW);
  assert.ok(!plain.includes('date TBD'));
  assert.ok(!plain.includes('DESCRIPTION:'));
});

test('a real same-day end time overrides the default 3h duration', () => {
  const ics = buildIcs([{ ...timed, end: '22:30:00' }], NOW);
  assert.ok(ics.includes(`DTEND;TZID=${TZ}:20260828T223000`), 'DTEND 20260828T223000');
});

test('DTEND rolls over midnight correctly', () => {
  const late = { ...timed, time: '22:30:00' };
  const ics = buildIcs([late], NOW);
  assert.ok(ics.includes(`DTSTART;TZID=${TZ}:20260828T223000`), 'DTSTART 20260828T223000');
  assert.ok(ics.includes(`DTEND;TZID=${TZ}:20260829T013000`), 'DTEND 20260829T013000');
});

test('time-less event becomes all-day (DATE value, exclusive DTEND next day)', () => {
  const ics = buildIcs([allDay], NOW);
  assert.match(ics, /DTSTART;VALUE=DATE:20260829/);
  assert.match(ics, /DTEND;VALUE=DATE:20260830/);
});

test('UID is stable across runs and unique per venue|title|date', () => {
  assert.equal(eventUid(timed), eventUid({ ...timed, url: 'https://other.example' }));
  assert.notEqual(eventUid(timed), eventUid({ ...timed, date: '2026-08-29' }));
  assert.match(eventUid(timed), /^[0-9a-f]{40}@fosdal\.net$/);
});

test('a second showing on the same day gets its own UID; a lone showing keeps the old one', () => {
  const six = { ...timed, time: '18:30' }, nine = { ...timed, time: '21:00' };
  const ics = buildIcs([six, nine], NOW);
  const uids = [...ics.matchAll(/^UID:(.+)$/gm)].map((m) => m[1]);
  assert.equal(uids.length, 2); assert.notEqual(uids[0], uids[1]);
  assert.match(buildIcs([six], NOW), new RegExp('UID:' + eventUid(six).replace('.', '\\.')));
});

test('text fields are escaped per RFC 5545', () => {
  const tricky = { ...allDay, title: 'A, B; C\\D\nE' };
  const ics = buildIcs([tricky], NOW);
  assert.match(ics, /SUMMARY:A\\, B\\; C\\\\D\\nE/);
});

test('long lines are folded at 75 octets with continuation space', () => {
  const folded = foldLine('SUMMARY:' + 'x'.repeat(200));
  for (const part of folded.split('\r\n')) {
    assert.ok(Buffer.byteLength(part, 'utf8') <= 75, `line too long: ${part.length}`);
  }
  assert.match(folded, /\r\n x/);
});

test('DTSTAMP uses the provided generation time in UTC', () => {
  const ics = buildIcs([timed], NOW);
  assert.match(ics, /DTSTAMP:20260824T120000Z/);
});
