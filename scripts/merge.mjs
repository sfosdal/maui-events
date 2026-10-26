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
