import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanUrl, fixLinks } from './links.mjs';

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
