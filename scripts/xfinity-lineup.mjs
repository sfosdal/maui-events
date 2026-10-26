// Xfinity numbers for site/channels.json, from a real lineup rather than
// memory: scripts/data/xfinity-98109.json holds the "Xfinity King County
// South" lineup (tvtv.us, ZIP 98109) as call sign -> basic channel number.
//
// tvtv.us is behind Cloudflare (curl and node get a 403), so the lineup is
// refreshed from a browser. On https://www.tvtv.us/wa/seattle/98109/luUSA-WA63873-X
// run this in the console and paste the result into the data file's "lineup":
//
//   const t = await (await fetch('/partial/lineup/USA-WA63873-X', { headers: { 'HX-Request': 'true' } })).text();
//   const doc = new DOMParser().parseFromString(t, 'text/html'), first = {};
//   for (const a of doc.querySelector('#channels-template').content.querySelectorAll('a[data-ch]')) {
//     const cs = a.querySelector('img')?.title || a.getAttribute('href').split('-').slice(2).join('-');
//     if (cs && !(cs in first)) first[cs] = +a.dataset.ch;
//   }
//   copy(JSON.stringify(first));   // then keep the call signs named in CALL_SIGNS below
//
// Then `node scripts/xfinity-lineup.mjs` writes the numbers into channels.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// channels.json "match" pattern -> the lineup's call sign for that network
export const CALL_SIGNS = {
  '^ESPN2$': 'ESPN2',
  '^ESPNU$': 'ESPNU',
  '^ESPN(/ESPN App)?$|^ESPN Deportes$': 'ESPN',
  '^ABC$|KOMO': 'KOMO',
  '^NBC(/Peacock)?$|^KING( 5)?$': 'KING',
  '^CBS$|KIRO': 'KIRO',
  '^FOX( / FOX ONE)?$|KCPQ': 'KCPQ',
  '^CNBC$': 'CNBC',
  'CW Seattle|KUNS': 'KUNS',
  'FOX 13\\+|KZJO': 'KZJO',
  '^KONG': 'KONG',
  'Kraken Hockey Network|KHN': 'KONG',
  '^USA Net(work)?$': 'USAP',
  '^FS1$|Fox Sports 1': 'FS1',
  '^FS2$|Fox Sports 2': 'FS2',
  '^BTN$|Big Ten Network': 'BIGTEN', // Big Ten Network — most Husky home games
  '^TNT$|^HBO MAX$|^Max$': 'TNTP',
  '^TBS$': 'TBSP',
  '^truTV$': 'TRUTVP',
  'NFL Network': 'NFLNET',
  'MLB Network|^MLBN$': 'MLBN',
  'NHL Network': 'NHLNET',
  'NBA TV': 'NBATV',
  'CBS Sports Network|CBSSN': 'CBSSN',
  '^ION$': 'KWPX',
  'Root Sports': 'RSNW',
  'Mariners\\.TV': 'SEAM', // Mariners TV, the cable channel carrying the MLB-produced local telecast
};
// the numbers applied: every channels.json entry with a known call sign gets
// the lineup's number, or loses its stale one when the lineup lacks the station
export function applyLineup(channels, lineup) {
  const out = [];
  for (const c of channels.channels) {
    const cs = CALL_SIGNS[c.match];
    if (!cs) { out.push(c); continue; }
    const n = lineup[cs];
    const next = { ...c };
    if (n != null) next.xfinity = String(n); else delete next.xfinity;
    out.push(next);
  }
  return { ...channels, channels: out };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dataPath = join(here, 'data', 'xfinity-98109.json'), chPath = join(here, '..', 'site', 'channels.json');
  const data = JSON.parse(readFileSync(dataPath, 'utf8')), channels = JSON.parse(readFileSync(chPath, 'utf8'));
  const next = applyLineup(channels, data.lineup);
  writeFileSync(chPath, JSON.stringify(next, null, 1) + '\n');
  const changed = channels.channels.map((c, i) => [c, next.channels[i]]).filter(([a, b]) => a.xfinity !== b.xfinity).map(([a, b]) => `${a.match}: ${a.xfinity ?? '—'} -> ${b.xfinity ?? '—'}`);
  console.log(`channels.json: ${changed.length} Xfinity numbers changed (lineup of ${data.fetched})`);
  changed.forEach((l) => console.log('  ' + l));
}
