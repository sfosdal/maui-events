// Every Ticketmaster Discovery call goes through tm-fetch.mjs's one queue (Steve, 2026-11-03, before the
// build read its sources side by side: "would your first suggestion trip the throttling limits on
// ticket master?"). The queue keeps a build to one call at a time, 400 ms apart, however many sources run
// at once; a script that called app.ticketmaster.com with plain fetch would step around it. This test reads
// every script and fails on any app.ticketmaster.com address that is not handed to tmFetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('./', import.meta.url);

test('every app.ticketmaster.com call goes through tmFetch', () => {
  const bad = [];
  for (const name of readdirSync(dir)) {
    if (!/\.mjs$/.test(name) || /\.test\.mjs$/.test(name) || name === 'tm-fetch.mjs') continue;
    const lines = readFileSync(new URL(name, dir), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const code = line.replace(/(^|[^:])\/\/.*$/, '$1'); // a comment that names the host is no call (the // of https:// is kept)
      if (!/app\.ticketmaster\.com/.test(code)) return;
      if (/tmFetch\(\s*[`'"]https:\/\/app\.ticketmaster\.com/.test(code)) return;
      bad.push(`${name}:${i + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  assert.deepEqual(bad, [], `Ticketmaster calls outside tm-fetch.mjs's queue:\n${bad.join('\n')}`);
});
