import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeWithArchive, unionArchives, eventKey, dropClashes, keepQuietVenues, capUpcoming } from './merge.mjs';

const TODAY = '2026-08-24';
const CUTOFF = '2025-08-24';
const ev = (date, title, extra) => ({ venue: 'V', title, date, time: '19:00:00', url: 'u', ...extra });

test('archived past events are kept alongside fresh ones', () => {
  const fresh = [ev('2026-08-25', 'Tomorrow Show')];
  const archived = [ev('2026-08-20', 'Last Week Show')];
  const out = mergeWithArchive(fresh, archived, TODAY, CUTOFF);
  assert.deepEqual(out.map((e) => e.title), ['Last Week Show', 'Tomorrow Show']);
});

test('archived FUTURE events not in fresh are dropped (cancellations)', () => {
  const fresh = [ev('2026-08-25', 'Still On')];
  const archived = [ev('2026-08-26', 'Cancelled Show'), ev('2026-08-25', 'Still On')];
  const out = mergeWithArchive(fresh, archived, TODAY, CUTOFF);
  assert.deepEqual(out.map((e) => e.title), ['Still On']);
});

test('a status seen for the first time is stamped now; a repeat keeps the first stamp', () => {
  const fresh = [ev('2026-08-26', 'Off Show', { status: 'cancelled' }), ev('2026-08-27', 'On Show')];
  const first = mergeWithArchive(fresh, [], TODAY, CUTOFF, '2026-08-24T10:00:00.000Z');
  assert.equal(first[0].statusSince, '2026-08-24T10:00:00.000Z');
  assert.equal(first[1].statusSince, undefined);
  const second = mergeWithArchive(fresh, first, TODAY, CUTOFF, '2026-08-24T16:00:00.000Z');
  assert.equal(second[0].statusSince, '2026-08-24T10:00:00.000Z', 'first detection survives later runs');
  // a different status (postponed → cancelled) is a new detection
  const changed = mergeWithArchive([ev('2026-08-26', 'Off Show', { status: 'postponed' })], first, TODAY, CUTOFF, '2026-08-25T00:00:00.000Z');
  assert.equal(changed[0].statusSince, '2026-08-25T00:00:00.000Z');
});

test('a known-cancelled future show stays, marked, after the source drops it; a plain one is dropped', () => {
  const archived = [
    ev('2026-08-26', 'Off Show', { status: 'cancelled', statusSince: '2026-08-20T00:00:00.000Z' }),
    ev('2026-08-26', 'Vanished Show'),
  ];
  const out = mergeWithArchive([], archived, TODAY, CUTOFF);
  assert.deepEqual(out.map((e) => e.title), ['Off Show']);
  assert.equal(out[0].statusSince, '2026-08-20T00:00:00.000Z');
});

test('past events never age out (Steve, 2026-10-31: "all old events should be kept")', () => {
  const archived = [ev('2023-01-05', 'Ancient'), ev('2025-08-23', 'A Year And A Day'), ev('2025-08-24', 'Exactly A Year')];
  const out = mergeWithArchive([], archived, TODAY, CUTOFF);
  assert.deepEqual(out.map((e) => e.title), ['Ancient', 'A Year And A Day', 'Exactly A Year']);
});

const at = (venue, date, title, url = 'u') => ({ venue, title, date, time: '19:00', url });
const VENUES = new Set(['Central Saloon', 'Highline PAC', 'Paramount', 'Around Pioneer Square', "Owl 'n Thistle"]);
const quiet = (archived, current, feeds = new Map()) => keepQuietVenues(archived, current, TODAY, { venues: VENUES, feeds }, () => {});

test('keepQuietVenues: a venue with nothing upcoming keeps its upcoming rows, not its past ones', () => {
  const archived = [at('Central Saloon', '2026-08-20', 'Past Night'), at('Central Saloon', '2026-08-28', 'Blues Jam'), at('Central Saloon', '2026-09-02', 'Open Mic'),
    at('Around Pioneer Square', '2026-09-03', 'First Thursday'), at('Paramount', '2026-08-30', 'Hamilton')];
  const current = [at('Paramount', '2026-08-30', 'Hamilton')];
  assert.deepEqual(quiet(archived, current).map((e) => `${e.venue}|${e.title}`), ['Central Saloon|Blues Jam', 'Central Saloon|Open Mic', 'Around Pioneer Square|First Thursday']);
  const lines = []; keepQuietVenues(archived, current, TODAY, { venues: VENUES }, (l) => lines.push(l));
  assert.deepEqual(lines, ['Venue Central Saloon: nothing upcoming this build — kept 2 upcoming rows from the previous feed', 'Venue Around Pioneer Square: nothing upcoming this build — kept 1 upcoming rows from the previous feed']);
});

test('keepQuietVenues: an always-empty venue resurrects nothing; a venue with any upcoming row drops its others as before; a venue not in city.js is not kept', () => {
  assert.deepEqual(quiet([at('Highline PAC', '2026-08-20', 'Last Spring')], []), []); // Ticketmaster watched, never anything upcoming
  const archived = [at('Paramount', '2026-08-30', 'Hamilton'), at('Paramount', '2026-09-01', 'Cancelled Quietly'), at('Old Name Hall', '2026-09-05', 'Ghost')];
  assert.deepEqual(quiet(archived, [at('Paramount', '2026-08-30', 'Hamilton')]), []);
});

test('keepQuietVenues: rows the build wrote itself (a weekly table, a home game) count as listed — run on the finished list', () => {
  const archived = [at("Owl 'n Thistle", '2026-08-25', 'Aqualizer')];
  assert.deepEqual(quiet(archived, [at("Owl 'n Thistle", '2026-08-25', 'New Tuesday Act')]), []);
});

test('keepQuietVenues: a calendar that answered with nothing keeps the rows it gave (links on its own site), beside another source that still lists', () => {
  const own = (d, t) => at('Central Saloon', d, t, `https://centralsaloon.com/events/${t}`), baba = (d, t) => ({ ...at('Central Saloon', d, t, 'https://babaobscura.com/tickets'), time: '21:00' });
  const archived = [own('2026-08-26', 'Blues Jam'), own('2026-08-27', 'Metal Night'), baba('2026-08-28', 'Baba Show'), own('2026-08-20', 'Past')];
  const feeds = new Map([['Central Saloon', 'https://centralsaloon.com/events/']]);
  assert.deepEqual(quiet(archived, [baba('2026-08-28', 'Baba Show')], feeds).map((e) => e.title), ['Blues Jam', 'Metal Night']);
  const lines = []; keepQuietVenues(archived, [baba('2026-08-28', 'Baba Show')], TODAY, { venues: VENUES, feeds }, (l) => lines.push(l));
  assert.deepEqual(lines, ['Own calendar Central Saloon: answered with nothing — kept 2 upcoming rows it listed last time']);
  // a subdomain is the same site; Ticketmaster's rows are not the calendar's; an always-empty calendar gave nothing
  const croc = new Map([['Paramount', 'https://www.stgpresents.org/events/']]);
  const pa = [at('Paramount', '2026-09-01', 'STG Only', 'https://www.stgpresents.org/events/x'), at('Paramount', '2026-09-02', 'TM Dropped', 'https://www.ticketmaster.com/event/1')];
  assert.deepEqual(quiet(pa, [at('Paramount', '2026-09-03', 'Hamilton', 'https://www.ticketmaster.com/event/2')], croc).map((e) => e.title), ['STG Only']);
  assert.deepEqual(quiet([at('Paramount', '2026-09-02', 'TM Dropped', 'https://www.ticketmaster.com/event/1')], [at('Paramount', '2026-09-03', 'H', 'https://www.ticketmaster.com/event/2')], croc), []);
  // a row the build already has (same venue, day and clock) is not kept twice
  assert.deepEqual(quiet([own('2026-08-26', 'Blues Jam')], [own('2026-08-26', 'Blues Jam')], feeds), []);
});

test('keepQuietVenues: a city-wide feed that failed or listed nothing keeps the upcoming rows on its site, beside a feed on the same site that still lists', () => {
  const alliance = (d, t) => ({ ...at('Around Pioneer Square', d, t, `https://pioneersquare.org/our-events/${t}`), time: '' });
  const walk = { ...at('Around Pioneer Square', '2026-09-03', 'First Thursday Art Walk', 'https://pioneersquare.org/art-walks/sept'), time: '17:00' };
  const archived = [alliance('2026-08-29', 'Trick or Treat'), alliance('2026-08-31', 'Craft Club'), walk, alliance('2026-08-20', 'Past Fair'),
    at('Lumen Field', '2026-08-30', 'Sounders', 'https://www.ticketmaster.com/event/9')];
  const current = [walk, at('Lumen Field', '2026-08-30', 'Sounders', 'https://www.ticketmaster.com/event/9')];
  const sites = new Map([['https://pioneersquare.org/events/', 'Alliance for Pioneer Square']]);
  const lines = [];
  const kept = keepQuietVenues(archived, current, TODAY, { venues: VENUES, sites }, (l) => lines.push(l));
  assert.deepEqual(kept.map((e) => e.title), ['Trick or Treat', 'Craft Club']); // the walk is listed already; the past fair stays in the past
  assert.deepEqual(lines, ['City-wide calendar Alliance for Pioneer Square: failed or answered with nothing — kept 2 upcoming rows from its site']);
  assert.deepEqual(quiet(archived, current), []); // without the site net: Around Pioneer Square still has the walk, so nothing was kept
});

test('capUpcoming: past events all stay; past the cap the farthest upcoming dates go', () => {
  const evs = [at('V', '2020-01-01', 'Old'), at('V', '2026-08-01', 'Recent'), at('V', '2026-08-25', 'U1'), at('V', '2026-09-01', 'U2'), at('V', '2026-10-01', 'U3')];
  const lines = [];
  assert.deepEqual(capUpcoming(evs, TODAY, 2, (l) => lines.push(l)).map((e) => e.title), ['Old', 'Recent', 'U1', 'U2']);
  assert.deepEqual(lines, ['Cap: 3 upcoming rows, 2 kept — the farthest dates dropped']);
  assert.equal(capUpcoming(evs, TODAY, 3), evs);
  assert.equal(capUpcoming(evs.slice(0, 2), TODAY, 1).length, 2); // all past: nothing to cap
});

test('fresh data wins when a past event is still listed by a source', () => {
  const fresh = [ev('2026-08-20', 'Last Week Show', { url: 'fresh-url' })];
  const archived = [ev('2026-08-20', 'Last Week Show', { url: 'stale-url' })];
  const out = mergeWithArchive(fresh, archived, TODAY, CUTOFF);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'fresh-url');
});

test('two showings of one show on one day are two events: the key carries the clock', () => {
  const six = { ...ev('2026-08-25', 'Show'), time: '18:30' }, nine = { ...ev('2026-08-25', 'Show'), time: '21:00:00' };
  assert.notEqual(eventKey(six), eventKey(nine));
  assert.equal(eventKey(six), eventKey({ ...six, time: '18:30:00' })); // with or without seconds, the same key
  const out = mergeWithArchive([six, nine], [], TODAY, CUTOFF);
  assert.deepEqual(out.map((e) => e.time), ['18:30', '21:00:00']);
  assert.equal(unionArchives([six], [nine]).length, 2);
});

test('result is sorted by date then time', () => {
  const fresh = [ev('2026-08-25', 'B'), { ...ev('2026-08-25', 'A'), time: '10:00:00' }];
  const archived = [ev('2026-08-01', 'Old')];
  const out = mergeWithArchive(fresh, archived, TODAY, CUTOFF);
  assert.deepEqual(out.map((e) => e.title), ['Old', 'A', 'B']);
});

test('unionArchives keeps every event from both copies, the first copy winning a collision', () => {
  const live = [ev('2026-08-20', 'Shared', { url: 'live-url' }), ev('2026-08-21', 'Live Only')];
  const branch = [ev('2026-08-20', 'Shared', { url: 'branch-url' }), ev('2025-01-05', 'Branch Only')];
  const out = unionArchives(live, branch);
  assert.deepEqual(out.map((e) => e.title), ['Branch Only', 'Shared', 'Live Only']);
  assert.equal(out[1].url, 'live-url');
});

test('unionArchives with one empty copy is the other copy (a wiped feed cannot shrink the record)', () => {
  const branch = [ev('2025-01-05', 'Old'), ev('2026-08-20', 'Recent')];
  assert.equal(unionArchives([], branch).length, 2);
  assert.equal(unionArchives(branch, []).length, 2);
});

test('dropClashes: a secondary listing\'s row goes when a row at its venue and date shares the clock or the title, loosely; different shows stay', () => {
  const existing = [
    { venue: 'McCaw Hall', title: 'Derek Hough: Dance for the Holidays', date: '2026-11-09', time: '19:30:00' },
    { venue: 'Paramount Theatre', title: 'Dermot Kennedy', date: '2026-10-26', time: '20:00' },
    { venue: 'T-Mobile Park', title: 'Seattle Mariners Gift Cards', date: '2026-10-21', time: '' },
  ];
  const kept = dropClashes([
    { venue: 'McCaw Hall', title: 'Derek Hough Dance For The Holidays', date: '2026-11-09', time: '19:30' }, // same show, Ticketmaster's spelling
    { venue: 'Paramount Theatre', title: 'Dermot Kennedy POSTPONED', date: '2026-10-26', time: '' }, // same show, no clock on the venue's card
    { venue: 'Paramount Theatre', title: 'Late Show: Something Else', date: '2026-10-26', time: '23:00' }, // a second show that night
    { venue: 'T-Mobile Park', title: 'Banana Ball', date: '2027-04-23', time: '' }, // nothing on that date
    { venue: 'Lumen Field', title: 'Dermot Kennedy', date: '2026-10-26', time: '20:00' }, // another venue
  ], existing);
  assert.deepEqual(kept.map((e) => e.title), ['Late Show: Something Else', 'Banana Ball', 'Dermot Kennedy']);
});

test('dropClashes: every word of the shorter title inside the longer is a clash; a title match needs the clocks within 90 minutes when both are known', () => {
  const existing = [
    { venue: 'Husky Stadium', title: 'Washington Huskies vs Penn State Nittany Lions', date: '2026-11-07', time: '' },
    { venue: 'The Crocodile', title: 'Ray Lau', date: '2027-01-29', time: '19:00' },
    { venue: 'The Crocodile', title: 'Jalen Ngonda', date: '2026-11-28', time: '19:00' },
  ];
  const out = dropClashes([
    { venue: 'Husky Stadium', title: 'Washington Huskies Football vs. Penn State Nittany Lions Football', date: '2026-11-07', time: '' }, // the parser's row, worded by Ticketmaster
    { venue: 'The Crocodile', title: 'Ray Lau', date: '2027-01-29', time: '21:30' }, // the late show stays
    { venue: 'The Crocodile', title: 'Jalen Ngonda: Doctrine of Love Tour w/ Brooke Combe', date: '2026-11-28', time: '18:00' }, // doors an hour before the show: the same night
  ], existing);
  assert.deepEqual(out.map((r) => r.title), ['Ray Lau']);
});

test('dropClashes: a loose title folds accents and reads & as "and" (the venue\'s "Marcello Hernandez" against Ticketmaster\'s "Marcello Hernández")', () => {
  const existing = [
    { venue: 'Hard Rock Live', title: 'Marcello Hernández', date: '2026-11-27', time: '20:00:00' },
    { venue: 'Pompano Beach Amphitheater', title: 'Leonid and Friends', date: '2027-04-17', time: '20:00:00' },
  ];
  const out = dropClashes([
    { venue: 'Hard Rock Live', title: 'Marcello Hernandez', date: '2026-11-27', time: '19:00' },
    { venue: 'Pompano Beach Amphitheater', title: 'Leonid & Friends', date: '2027-04-17', time: '19:00' },
    { venue: 'Hard Rock Live', title: 'Grupo Niche', date: '2026-11-27', time: '21:30' },
  ], existing);
  assert.deepEqual(out.map((e) => e.title), ['Grupo Niche']);
});
