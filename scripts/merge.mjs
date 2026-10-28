/**
 * Merge freshly fetched events with the previously published feed so past
 * events survive: sources only list upcoming shows, and the deploy keeps no
 * other state — the live feed IS the archive.
 *
 * Rules: archived events strictly before `todayStr` (and not older than
 * `cutoffStr`) are carried forward; archived events on/after today that the
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

export function mergeWithArchive(fresh, archived, todayStr, cutoffStr, nowISO = new Date().toISOString()) {
  const freshKeys = new Set(fresh.map(key));
  const byKey = new Map(archived.map((e) => [key(e), e]));
  const past = archived.filter((e) =>
    e.date && e.date < todayStr && e.date >= cutoffStr && !freshKeys.has(key(e)));
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
