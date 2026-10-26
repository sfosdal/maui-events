// The share card: site/share.png, the 1200×630 Open Graph image a link to the
// city's site shows in a message or a feed. One template for every city (Steve,
// 2026-10-14: "make it #12" — shared, no masthead drawing): the city's eyebrow and
// name from site/index.html, its description line from the og:description tag,
// its address from city.js, and a soft glow in the city's first venue hue from
// styles.css, over the family's dark #141a20, with the Ghostwood Sites lockup.
// Run from a city repo:  node scripts/share-card.mjs
// Rebuild after a masthead, description or palette change. Renders with headless
// Chrome in a scratch profile (never the real one); the fonts are the site's own
// Google Fonts, fetched at render time only (the PNG is what ships).
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import '../site/city.js';

const CITY = globalThis.LQACity;
const site = resolve('site');
const html = readFileSync(join(site, 'index.html'), 'utf8');
const css = readFileSync(join(site, 'styles.css'), 'utf8');
const text = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const eyebrow = text((html.match(/<p class="eyebrow"[^>]*>([\s\S]*?)<\/p>/) || [, ''])[1]);
const name = text((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [, CITY.name])[1]);
const line = text((html.match(/<meta property="og:description" content="([^"]*)"/) || [, ''])[1]);
const hue = (css.match(/--v-[\w-]+:\s*(#[0-9a-fA-F]{6})/) || [, '#e8791d'])[1];
const mark = (html.match(/<symbol id="gw-mark"[\s\S]*?<\/symbol>/) || [''])[0];
const host = CITY.site.replace(/^https?:\/\//, '').replace(/\/$/, '');
if (!eyebrow || !name || !line || !mark) throw new Error(`share card: missing ${!eyebrow ? 'eyebrow' : !name ? 'h1' : !line ? 'og:description' : 'gw-mark'} in site/index.html`);
const h1Size = name.length > 18 ? 92 : name.length > 13 ? 110 : 132;

const page = `<!DOCTYPE html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Big+Shoulders:opsz,wght@10..72,500;10..72,700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; }
  body { position: relative; background: #141a20; color: #e8edf1; font-family: 'Big Shoulders', 'Big Shoulders Display', Impact, 'Arial Narrow', sans-serif; }
  .glow { position: absolute; inset: 0; background: radial-gradient(720px 480px at 86% 14%, ${hue}2e, transparent 72%), radial-gradient(520px 360px at 8% 100%, ${hue}14, transparent 70%); }
  .rule { position: absolute; left: 72px; top: 198px; width: 72px; height: 3px; background: #e8791d; }
  .text { position: absolute; left: 72px; top: 222px; right: 72px; }
  .eyebrow { font-family: 'IBM Plex Mono', Menlo, monospace; font-size: 26px; font-weight: 500; letter-spacing: .2em; text-transform: uppercase; color: #e8791d; margin: 0 0 10px; line-height: 1; }
  h1 { font-size: ${h1Size}px; font-weight: 700; line-height: .9; text-transform: uppercase; letter-spacing: .005em; margin: 0; color: #fff; white-space: nowrap; }
  .line { font-family: 'IBM Plex Mono', Menlo, monospace; font-size: 25px; line-height: 1.4; color: #9aa7b2; margin: 26px 0 0; max-width: 820px; }
  .url { position: absolute; left: 72px; bottom: 52px; font-family: 'IBM Plex Mono', Menlo, monospace; font-size: 28px; font-weight: 500; letter-spacing: .12em; text-transform: uppercase; color: #e8791d; }
  .gw { position: absolute; right: 72px; bottom: 48px; display: flex; align-items: center; gap: 14px; }
  .gw svg { width: 40px; height: 40px; color: #fff; }
  .gw span { font-family: 'IBM Plex Mono', Menlo, monospace; font-size: 17px; letter-spacing: .14em; text-transform: uppercase; color: #9aa7b2; }
</style></head><body>
<div class="glow"></div><div class="rule"></div>
<div class="text"><p class="eyebrow">${esc(eyebrow)}</p><h1>${esc(name)}</h1><p class="line">${esc(line)}</p></div>
<div class="url">${esc(host)}</div>
<div class="gw"><svg width="0" height="0" style="position:absolute">${mark}</svg><svg aria-hidden="true"><use href="#gw-mark"/></svg><span>Ghostwood Sites</span></div>
</body></html>`;

const work = join(tmpdir(), `share-card-${CITY.key}`);
rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true });
writeFileSync(join(work, 'card.html'), page);
const out = join(site, 'share.png');
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const r = spawnSync(chrome, ['--headless=new', `--user-data-dir=${join(work, 'profile')}`, '--window-size=1200,630', '--force-device-scale-factor=1', '--hide-scrollbars', '--virtual-time-budget=9000', `--screenshot=${out}`, 'file://' + join(work, 'card.html')], { stdio: 'ignore' });
if (r.status !== 0) throw new Error(`Chrome exited ${r.status} (${r.error?.message || ''})`);
const png = readFileSync(out);
const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
if (w !== 1200 || h !== 630) throw new Error(`share.png is ${w}×${h}, not 1200×630`);
console.log(`share.png: ${eyebrow} / ${name} — ${host}, glow ${hue}, ${(png.length / 1024).toFixed(0)} KB`);
