/**
 * Merge freshly fetched events with the previously published feed so past
 * events survive: sources only list upcoming shows, and the deploy keeps no
 * other state — the live feed IS the archive.
 *
 * Rules: archived events strictly before `todayStr` are carried forward,
 * every one of them — nothing ages out (Steve, 2026-10-31: "all old events
 * should be kept"; until then a year, `cutoffStr`, whose slot stays in the
 * signature so the cities' calls need no change); archived events on/after today that the
 * sources no longer list are dropped (a quiet removal) — unless the archive
 * already knows the show is cancelled/postponed, in which case it stays in
 * its slot, marked, until its date passes; on a key collision the fresh
 * event wins, but a status first seen on an earlier run keeps its
 * `statusSince` (when the cancellation was first detected, ISO time) —
 * a status seen for the first time is stamped `nowISO`.
 */
// The event key every de-dupe agrees on (the fresh list in fetch-events.mjs, the archive union and merge here, the
// ICS UID when two showings share a day): venue, title, date AND the clock — a 6:30 and a 9:00 showing of one show
// are two events, not a duplicate (Steve, 2026-10-14: "add the time to the key"; the 9 PM showing of a two-show night
// at the Teatro de Cancún was being folded). The clock is cut to HH:MM, as sources give it with or without seconds.
export const eventKey = (e) => `${e.venue}|${e.title}|${e.date}|${(e.time || '').slice(0, 5)}`;
const key = eventKey;

export function mergeWithArchive(fresh, archived, todayStr, _cutoffStr, nowISO = new Date().toISOString()) {
  const freshKeys = new Set(fresh.map(key));
  const byKey = new Map(archived.map((e) => [key(e), e]));
  const past = archived.filter((e) =>
    e.date && e.date < todayStr && !freshKeys.has(key(e)));
  const knownOff = archived.filter((e) =>
    e.date && e.date >= todayStr && e.status && !freshKeys.has(key(e)));
  const stamped = fresh.map((e) => {
    if (!e.status) return e;
    const prev = byKey.get(key(e));
    const since = prev && prev.status === e.status && prev.statusSince ? prev.statusSince : nowISO;
    return { ...e, statusSince: since };
  });
  return [...past, ...knownOff, ...stamped]
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
}

/**
 * A source that suddenly gives nothing keeps what it gave (Steve, 2026-10-31: "feed source that errors
 * out (or is suddenly empty) should keep last events"). Run on the finished list, after the rows the
 * build writes itself (team home games, weekly tables), so those count as listed. Two nets:
 * - `feeds`: venue → URL(s) of its own calendars, for the ones that answered and listed nothing
 *   (feeds.mjs feedQuietVenues). The rows that calendar gave last time — the venue's upcoming rows
 *   linking to that site — are kept, less any the build already has there (dropClashes). A calendar
 *   that is always empty gave none, so it keeps nothing; Ticketmaster's rows link to Ticketmaster.
 *   Central Saloon, 2026-10-31: its own 9 beside Baba Obscura's 12.
 * - `sites`: city-wide feed URL → label, for the feeds that failed or listed nothing (feeds.mjs feedQuietSites). They name
 *   no venue, so every upcoming row linking to their site is kept, less any the build already has (the Alliance for
 *   Pioneer Square's calendar beside First Thursday's, both on pioneersquare.org, both folded into Around Pioneer Square).
 * - `venues`: the city's own (the city.js names and its grounds venue). One with no upcoming row at
 *   all but upcoming rows in the previous feed keeps them, whatever emptied it — a city-wide feed, a
 *   parser a redesign broke, a page that answers and lists nothing. A venue taken out of city.js is
 *   not in `venues`.
 * The kept rows age into the past as their dates come; once the source lists again, the next build
 * drops any it no longer carries (mergeWithArchive). Errors are the other nets' (feeds.mjs, tm-fetch.mjs).
 */
const siteOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const sameSite = (a, b) => !!a && !!b && (a === b || a.endsWith('.' + b) || b.endsWith('.' + a)); // calendar.thecrocodile.com and thecrocodile.com
export function keepQuietVenues(archived, current, todayStr, { venues = new Set(), feeds = new Map(), sites = new Map() } = {}, log = console.error) {
  const upcoming = archived.filter((e) => e.date >= todayStr);
  const fromFeeds = dropClashes(upcoming.filter((e) => feeds.has(e.venue) && [].concat(feeds.get(e.venue)).some((u) => sameSite(siteOf(e.url), siteOf(u)))), current);
  const quietSites = [...sites].map(([u, label]) => [siteOf(u), label]);
  const siteLabel = (e) => (quietSites.find(([s]) => sameSite(siteOf(e.url), s)) || [])[1];
  const taken = new Set(fromFeeds);
  const fromSites = dropClashes(upcoming.filter((e) => !taken.has(e) && siteLabel(e)), current.concat(fromFeeds));
  const live = new Set(current.concat(fromFeeds, fromSites).filter((e) => e.date >= todayStr).map((e) => e.venue));
  const fromVenues = upcoming.filter((e) => venues.has(e.venue) && !live.has(e.venue));
  const tell = (rows, say) => { const n = new Map(); for (const e of rows) n.set(e.venue, (n.get(e.venue) || 0) + 1); for (const [v, c] of n) log(say(v, c)); };
  tell(fromFeeds, (v, n) => `Own calendar ${v}: answered with nothing — kept ${n} upcoming rows it listed last time`);
  const bySite = new Map(); for (const e of fromSites) { const l = siteLabel(e); bySite.set(l, (bySite.get(l) || 0) + 1); }
  for (const [l, n] of bySite) log(`City-wide calendar ${l}: failed or answered with nothing — kept ${n} upcoming rows from its site`);
  tell(fromVenues, (v, n) => `Venue ${v}: nothing upcoming this build — kept ${n} upcoming rows from the previous feed`);
  return fromFeeds.concat(fromSites, fromVenues);
}

/**
 * The sanity cap on a runaway source, on the upcoming rows only: every past event stays (Steve,
 * 2026-10-31: "all old events should be kept" — the old `.slice(-MAX_EVENTS)` cut the oldest first,
 * and Seattle stood at 3,417 of 4,000). `events` sorted by date, as mergeWithArchive returns them;
 * past the cap the farthest dates go.
 */
export function capUpcoming(events, todayStr, max, log = console.error) {
  const first = events.findIndex((e) => e.date >= todayStr);
  if (first < 0 || events.length - first <= max) return events;
  log(`Cap: ${events.length - first} upcoming rows, ${max} kept — the farthest dates dropped`);
  return events.slice(0, first + max);
}

/**
 * Union of two copies of the archive (the live feed and the `archive`
 * branch's file): every event from either, `primary` winning a key
 * collision, sorted like the feed. The second copy exists so a publish that
 * lost history cannot wipe it — the union can only grow.
 */
export function unionArchives(primary, secondary) {
  const byKey = new Map(secondary.map((e) => [key(e), e]));
  for (const e of primary) byKey.set(key(e), e);
  return [...byKey.values()]
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
}

/**
 * A venue read from two listings — Ticketmaster and its own calendar, the
 * rule for every venue since 2026-10-26 — prints the same show twice, often
 * under two titles ("Derek Hough Dance For The Holidays" / "Derek Hough:
 * Dance for the Holidays"), so eventKey can't fold them. The secondary
 * listing's rows go through here against everything read so far: a
 * candidate is dropped when a row already sits at its venue on its date
 * and either the clocks agree to the minute or the titles do, loosely:
 * letters and digits only, equal or one containing the other, or every
 * word of the shorter title inside the longer ("Washington Huskies vs Penn
 * State Nittany Lions" against Ticketmaster's "Washington Huskies Football
 * vs. Penn State Nittany Lions Football"). A title match with both clocks
 * known needs them within 90 minutes (doors against show time), so an early
 * and a late show of one act both stay. Two different shows on one night at
 * one venue — different titles, different clocks — both stay.
 */
const plain = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/^the\s+/, ''); // "Marcello Hernández" against the venue's "Marcello Hernandez", "Leonid & Friends" against "Leonid and Friends"
const loose = (t) => plain(t).replace(/[^a-z0-9]+/g, '');
const words = (t) => plain(t).match(/[a-z0-9]{3,}/g) || [];
const sameTitle = (a, b) => {
  const x = loose(a), y = loose(b);
  if (!x || !y) return false;
  if (x === y || (x.length >= 6 && y.length >= 6 && (x.includes(y) || y.includes(x)))) return true;
  const [short, long] = words(a).length <= words(b).length ? [words(a), new Set(words(b))] : [words(b), new Set(words(a))];
  return short.length >= 3 && short.every((w) => long.has(w));
};
const minutes = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
export function dropClashes(candidates, existing) {
  const byDay = new Map();
  for (const e of existing) { const k = `${e.venue}|${e.date}`; if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(e); }
  return candidates.filter((c) => {
    const rows = byDay.get(`${c.venue}|${c.date}`) || [];
    const clock = String(c.time || '').slice(0, 5);
    return !rows.some((e) => {
      if (clock && String(e.time || '').slice(0, 5) === clock) return true;
      if (!sameTitle(e.title, c.title)) return false;
      const a = minutes(e.time), b = minutes(c.time);
      return a === null || b === null || Math.abs(a - b) <= 90;
    });
  });
}
