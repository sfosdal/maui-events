import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanUrl, fixLinks, formerLinks, repointMoved, venueLinks } from './links.mjs';

test('cleanUrl gives a bare host a scheme, unwraps urldefense and drops what is not a web link', () => {
  assert.equal(cleanUrl('purchase.chautauqua.com/EventAvailability?WebEventId=CCH102426'), 'https://purchase.chautauqua.com/EventAvailability?WebEventId=CCH102426');
  assert.equal(cleanUrl('www.kcba.org'), 'https://www.kcba.org');
  assert.equal(cleanUrl('//example.org/x'), 'https://example.org/x');
  assert.equal(cleanUrl('https://urldefense.com/v3/__https://www.axs.com/events/1566277/jonas-brothers-tickets?skin=grandgarden__;!!GeIQSb45FBw!abc$'), 'https://www.axs.com/events/1566277/jonas-brothers-tickets?skin=grandgarden');
  assert.equal(cleanUrl('https://centertix.com/events/maria-bamford__;!!GeIQSb45FBw!u2AEgPOSYBw8Ico9k$'), 'https://centertix.com/events/maria-bamford');
  assert.equal(cleanUrl(' https://ok.example/a '), 'https://ok.example/a');
  assert.equal(cleanUrl('mailto:box@office.org'), '');
  assert.equal(cleanUrl('TBA'), '');
  assert.equal(cleanUrl(''), '');
});

function fakeFetch(table) {
  return async (url) => {
    const r = table[url] || { status: 200 };
    return { status: r.status, ok: r.status >= 200 && r.status < 300, url: r.to || url, body: null };
  };
}

test('fixLinks sends a dead link to the venue page, drops it when that is dead too, and leaves walls alone', async () => {
  const venues = { Hall: { url: 'https://hall.example/events' }, Shed: { url: 'https://shed.example/' } };
  const events = [
    { venue: 'Hall', date: '2026-11-01', url: 'https://hall.example/show-gone' },
    { venue: 'Shed', date: '2026-11-02', url: 'https://shed.example/gone' },
    { venue: 'Hall', date: '2026-11-03', url: 'https://club.example/tickets' },
    { venue: 'Hall', date: '2026-11-04', url: 'https://walled.example/e/1' },
    { venue: 'Hall', date: '2026-11-05', url: 'https://www.ticketmaster.com/x/event/1' },
    { venue: 'Hall', date: '2026-01-01', url: 'https://hall.example/old-gone' },
  ];
  const r = await fixLinks(events, {
    venues, today: '2026-10-21', log: () => {},
    fetchImpl: fakeFetch({
      'https://hall.example/show-gone': { status: 404 },
      'https://shed.example/gone': { status: 410 },
      'https://shed.example/': { status: 404 },
      'https://club.example/tickets': { status: 200, to: 'https://club.example/404' },
      'https://walled.example/e/1': { status: 403 },
      'https://www.ticketmaster.com/x/event/1': { status: 404 }, // never asked
    }),
  });
  assert.deepEqual(events.map((e) => e.url), [
    'https://hall.example/events', '', 'https://hall.example/events', 'https://walled.example/e/1', 'https://www.ticketmaster.com/x/event/1', 'https://hall.example/old-gone',
  ]);
  assert.equal(r.swapped, 2);
  assert.equal(r.dropped, 1);
});

test('fixLinks trusts a link that answered OK in the last two days and checks the rest (the record)', async () => {
  const asked = [];
  const fetchImpl = async (u) => { asked.push(u); return { status: u.includes('gone') ? 404 : 200, ok: !u.includes('gone'), url: u, body: null }; };
  const events = [
    { venue: 'A', date: '2026-11-10', url: 'https://a.example/fresh' }, // OK yesterday: trusted
    { venue: 'A', date: '2026-11-11', url: 'https://a.example/old' }, // OK four days ago: asked again
    { venue: 'A', date: '2026-11-12', url: 'https://a.example/new' }, // not in the record: asked
    { venue: 'A', date: '2026-11-13', url: 'https://a.example/gone' }, // dead now: asked, not written down
  ];
  const record = { 'https://a.example/fresh': '2026-11-02', 'https://a.example/old': '2026-10-30', 'https://a.example/elsewhere': '2026-11-03' };
  const r = await fixLinks(events, { today: '2026-11-03', fetchImpl, record, log: () => {} });
  assert.deepEqual(asked.sort(), ['https://a.example/gone', 'https://a.example/new', 'https://a.example/old']);
  assert.equal(r.trusted, 1);
  assert.deepEqual(r.record, { 'https://a.example/fresh': '2026-11-02', 'https://a.example/old': '2026-11-03', 'https://a.example/new': '2026-11-03' });
  assert.equal(events[3].url, ''); // no venue page in `venues`: the dead link is dropped, as before
});

// two versions of a city.js as git would hand them back, newest first
const cityAt = (hallUrl, clubSchedule, extra = '') => `(function (g) { g.LQACity = { venues: { Hall: { url: '${hallUrl}', tm: { fallbackUrl: '${hallUrl}' } }, Field: { url: 'https://field.example/events' }${extra} }, teams: [{ key: 'owls', venue: 'Field', schedule: '${clubSchedule}', inject: { url: '${clubSchedule}' } }] }; })(typeof globalThis !== 'undefined' ? globalThis : window);`;
function fakeGit(versions, { shallow = false } = {}) {
  const calls = [];
  const git = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'rev-parse') return shallow ? 'true\n' : 'false\n';
    if (args[0] === 'fetch') return '';
    if (args[0] === 'log') return versions.map((_, i) => `sha${i}`).join('\n') + '\n';
    if (args[0] === 'show') { const v = versions[+args[1].match(/^sha(\d+):/)[1]]; if (v === null) throw new Error('no such file'); return v; }
    throw new Error('unexpected git ' + args.join(' '));
  };
  return { git, calls };
}

test('formerLinks gathers every link a venue has had across city.js history, deepening a shallow clone first', () => {
  const { git, calls } = fakeGit([cityAt('https://hall.example/calendar', 'https://owls.example/schedule'), 'not a city.js (', null, cityAt('https://hall-old.example/', 'https://owls-old.example/')], { shallow: true });
  const former = formerLinks({ git, log: () => {} });
  assert.deepEqual([...former.get('Hall')].sort(), ['https://hall-old.example/', 'https://hall.example/calendar']);
  assert.deepEqual([...former.get('Field')].sort(), ['https://field.example/events', 'https://owls-old.example/', 'https://owls.example/schedule']);
  assert.ok(calls.includes('fetch --quiet --unshallow'));
});

test('formerLinks with no git (or a failing one) knows of no moves', () => {
  const former = formerLinks({ git: () => { throw new Error('not a git repository'); }, log: () => {} });
  assert.equal(former.size, 0);
});

test('repointMoved gives rows on a dropped venue link the venue link now, and leaves every other link alone', () => {
  const now = { venues: { Hall: { url: 'https://hall.example/calendar' }, Field: { url: 'https://field.example/events' }, Shed: {} }, teams: [{ venue: 'Field', inject: { url: 'https://owls.example/schedule' } }] };
  const former = new Map([
    ['Hall', new Set(['https://hall-old.example/', 'https://hall.example/calendar'])],
    ['Field', new Set(['https://owls-old.example/', 'https://owls.example/schedule', 'https://field.example/events'])],
    ['Shed', new Set(['https://shed-hijacked.example/'])],
  ]);
  const rows = [
    { venue: 'Hall', date: '2025-06-01', url: 'https://hall-old.example/' },             // archived, old venue page → new
    { venue: 'Hall', date: '2026-12-01', url: 'https://hall-old.example' },              // upcoming, same link written without the slash → new
    { venue: 'Hall', date: '2025-06-02', url: 'https://hall-old.example/shows/123' },    // the show's own page on the old host: untouched
    { venue: 'Hall', date: '2025-06-03', url: 'https://hall.example/calendar' },         // already current
    { venue: 'Field', date: '2025-07-01', url: 'https://owls-old.example/' },             // a club's old schedule → the venue page
    { venue: 'Shed', date: '2025-08-01', url: 'https://shed-hijacked.example/' },        // the venue is unlinked now → no link
    { venue: 'Elsewhere', date: '2025-08-02', url: 'https://hall-old.example/' },        // another venue's old link: not this venue's
    { venue: 'Hall', date: '2025-08-03', url: 'https://club.example/tickets' },
  ];
  assert.equal(repointMoved(rows, former, now), 4);
  assert.deepEqual(rows.map((r) => r.url), ['https://hall.example/calendar', 'https://hall.example/calendar', 'https://hall-old.example/shows/123', 'https://hall.example/calendar', 'https://field.example/events', '', 'https://hall-old.example/', 'https://club.example/tickets']);
  assert.equal(repointMoved(rows, new Map(), now), 0);
});

test("venueLinks reads this city's city.js: each venue its page, each club its schedule at its home venue", async () => {
  await import('../site/city.js');
  const city = globalThis.LQACity;
  const links = venueLinks(city);
  for (const [v, x] of Object.entries(city.venues || {})) if (cleanUrl(x.url)) assert.ok(links.get(v).has(cleanUrl(x.url)), v);
  for (const t of (city.teams || []).filter((t) => t.venue && cleanUrl(t.schedule))) assert.ok(links.get(t.venue).has(cleanUrl(t.schedule)), t.slug || t.key);
});
