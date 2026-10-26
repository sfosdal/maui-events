// The opponents' crests, served from site/marks/opp/ with the trademark
// marks taken off. The leagues' own files all carry one — MLB's SVGs draw
// the ™ as a small subpath at the lower right, the NHL's an ® as the first
// path, ESPN's PNGs have it in the pixels — and the page wants the plain
// mark. Each file is fetched once (kept a week), cleaned, and the schedule's
// logo URL becomes the local path. An SVG loses every tiny subpath (and
// <text>) sitting at the bottom or the right edge; a PNG (8-bit RGBA, the
// ESPN kind) loses every tiny connected blob of pixels there. Anything else
// is served as it came.
import fs from 'node:fs';
import { CITY } from './badges.mjs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, '..', 'site', 'marks', 'opp');
const UA = CITY.userAgent;
const KEEP_MS = 7 * 864e5;
// a shape this small (both ways, as a share of the image) at the bottom or
// the right edge is a ™ / ®, not the mark
const TINY = 0.12;
const isMark = (x0, y0, w, h, W, H) => w < TINY * W && h < TINY * H && (y0 > 0.8 * H || x0 > 0.8 * W || (x0 > 0.55 * W && y0 > 0.6 * H));

// ---- SVG: split each path into subpaths, drop the tiny cornered ones ----
const NUM = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;
function subpaths(d) { // [{ text, x0, y0, x1, y1, sx, sy }] with absolute starts
  const toks = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || [];
  const out = []; let cur = null, cmd = null, x = 0, y = 0, sx = 0, sy = 0, i = 0;
  const N = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  const pt = (px, py) => { cur.x0 = Math.min(cur.x0, px); cur.y0 = Math.min(cur.y0, py); cur.x1 = Math.max(cur.x1, px); cur.y1 = Math.max(cur.y1, py); };
  while (i < toks.length) {
    let t = toks[i];
    if (/[A-Za-z]/.test(t)) { cmd = t; i++; } else if (cmd === null) { i++; continue; }
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    if (C === 'Z') { x = sx; y = sy; if (cur) cur.text += 'Z'; if (i < toks.length && !/[A-Za-z]/.test(toks[i])) cmd = rel ? 'l' : 'L'; continue; }
    const n = N[C]; const args = toks.slice(i, i + n).map(Number); if (args.length < n) break; i += n;
    if (C === 'M') { // a new subpath, written with an absolute start
      const nx = rel ? x + args[0] : args[0], ny = rel ? y + args[1] : args[1];
      x = nx; y = ny; sx = x; sy = y;
      cur = { text: 'M' + fmt(x) + ' ' + fmt(y), x0: x, y0: y, x1: x, y1: y }; out.push(cur);
      cmd = rel ? 'l' : 'L'; continue;
    }
    cur.text += cmd + args.map(fmt).join(' ');
    if (C === 'L' || C === 'T') { x = rel ? x + args[0] : args[0]; y = rel ? y + args[1] : args[1]; pt(x, y); }
    else if (C === 'H') { x = rel ? x + args[0] : args[0]; pt(x, y); }
    else if (C === 'V') { y = rel ? y + args[0] : args[0]; pt(x, y); }
    else if (C === 'C' || C === 'S' || C === 'Q') { let ax = x, ay = y; for (let k = 0; k < n; k += 2) { ax = rel ? x + args[k] : args[k]; ay = rel ? y + args[k + 1] : args[k + 1]; pt(ax, ay); } x = ax; y = ay; }
    else if (C === 'A') { x = rel ? x + args[5] : args[5]; y = rel ? y + args[6] : args[6]; pt(x, y); }
  }
  return out;
}
const fmt = (v) => String(Math.round(v * 1000) / 1000);
export function cleanSvg(svg) {
  const vb = (svg.match(/viewBox="([^"]+)"/) || [])[1];
  if (!vb) return svg;
  const [vx, vy, W, H] = vb.trim().split(/[\s,]+/).map(Number);
  let dropped = 0;
  let out = svg.replace(/<text\b[^>]*>[\s\S]*?<\/text>/g, (m) => (/™|®|\bTM\b/i.test(m) ? (dropped++, '') : m));
  out = out.replace(/<path\b([^>]*?)\sd="([^"]+)"([^>]*)>(\s*<\/path>)?/g, (m, pre, d, post, close) => {
    const parts = subpaths(d);
    const keep = parts.filter((p) => !isMark(p.x0 - vx, p.y0 - vy, p.x1 - p.x0, p.y1 - p.y0, W, H));
    dropped += parts.length - keep.length;
    if (!keep.length) return ''; // the whole element (its closing tag too) was the mark
    return keep.length === parts.length ? m : `<path${pre} d="${keep.map((p) => p.text).join('')}"${post}>${close || ''}`;
  });
  return tightenViewBox(out);
}
// The leagues' SVGs sit the mark in a wide box (the NHL's 960×640, the mark
// in the middle third) so it draws small beside a crest that fills its
// file. When the file is paths alone, untransformed, the viewBox is
// redrawn as a square just around the paths' bounds (a 3% margin).
const MARGIN = 0.03;
export function tightenViewBox(svg) {
  if (/transform=|<(circle|rect|ellipse|polygon|polyline|line|use|image|text|g)\b/i.test(svg)) return svg;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
  for (const m of svg.matchAll(/<path\b[^>]*?\sd="([^"]+)"/g)) {
    for (const p of subpaths(m[1])) { x0 = Math.min(x0, p.x0); y0 = Math.min(y0, p.y0); x1 = Math.max(x1, p.x1); y1 = Math.max(y1, p.y1); n++; }
  }
  if (!n || !(x1 > x0) || !(y1 > y0)) return svg;
  const side = Math.max(x1 - x0, y1 - y0) * (1 + 2 * MARGIN), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return svg.replace(/viewBox="[^"]+"/, `viewBox="${fmt(cx - side / 2)} ${fmt(cy - side / 2)} ${fmt(side)} ${fmt(side)}"`).replace(/\s(width|height)="[^"]*"/g, '');
}

// ---- PNG: 8-bit RGBA, non-interlaced (ESPN's); the rest untouched ----
function crc32(buf) { return zlib.crc32 ? zlib.crc32(buf) : crcSlow(buf); }
function crcSlow(buf) { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; }
function chunks(buf) {
  const out = []; let p = 8;
  while (p + 8 <= buf.length) { const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8); out.push({ type, data: buf.subarray(p + 8, p + 8 + len) }); p += 12 + len; }
  return out;
}
const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
export function cleanPng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504E47) return null;
  const cs = chunks(buf), ihdr = cs.find((c) => c.type === 'IHDR');
  if (!ihdr) return null;
  const W = ihdr.data.readUInt32BE(0), H = ihdr.data.readUInt32BE(4), depth = ihdr.data[8], ctype = ihdr.data[9], inter = ihdr.data[12];
  if (depth !== 8 || ctype !== 6 || inter !== 0) return null; // only the straightforward kind
  const raw = zlib.inflateSync(Buffer.concat(cs.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const bpp = 4, stride = W * bpp, px = Buffer.alloc(W * H * bpp);
  for (let y = 0; y < H; y++) { // unfilter
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), o = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[o + i - bpp] : 0, b = y > 0 ? px[o - stride + i] : 0, c = y > 0 && i >= bpp ? px[o - stride + i - bpp] : 0;
      let v = row[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1; else if (f === 4) v += paeth(a, b, c);
      px[o + i] = v & 255;
    }
  }
  // connected blobs of visible pixels; the tiny cornered ones are erased
  const seen = new Uint8Array(W * H); let erased = 0;
  const stack = [];
  for (let s = 0; s < W * H; s++) {
    if (seen[s] || px[s * 4 + 3] < 16) continue;
    let x0 = W, y0 = H, x1 = 0, y1 = 0; const blob = [];
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const i = stack.pop(), x = i % W, y = (i - x) / W; blob.push(i);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) if (j >= 0 && !seen[j] && px[j * 4 + 3] >= 16) { seen[j] = 1; stack.push(j); }
    }
    if (blob.length < W * H * 0.5 && isMark(x0, y0, x1 - x0 + 1, y1 - y0 + 1, W, H)) { for (const i of blob) px[i * 4 + 3] = 0; erased++; }
  }
  if (!erased) return buf;
  const out = Buffer.alloc(H * (stride + 1)); // re-encode, no filtering
  for (let y = 0; y < H; y++) { out[y * (stride + 1)] = 0; px.copy(out, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  const chunk = (type, data) => { const t = Buffer.from(type, 'latin1'), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
  return Buffer.concat([buf.subarray(0, 8), chunk('IHDR', ihdr.data), chunk('IDAT', zlib.deflateSync(out, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---- the pass over the schedules ----
const nameFor = (url) => url.replace(/^https?:\/\//, '').replace(/[?#].*$/, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
async function cleanOne(url) {
  const ext = /\.svg(\?|$)/i.test(url) ? '.svg' : /\.png(\?|$)/i.test(url) ? '.png' : null;
  if (!ext) return null;
  const file = path.join(DIR, nameFor(url).replace(/\.(svg|png)$/i, '') + ext), rel = 'marks/opp/' + path.basename(file);
  try { if (Date.now() - fs.statSync(file).mtimeMs < KEEP_MS) return rel; } catch (e) { /* not yet */ }
  const r = await fetch(url, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const cleaned = ext === '.svg' ? Buffer.from(cleanSvg(buf.toString('utf8')), 'utf8') : cleanPng(buf);
  if (!cleaned) return null; // a kind we don't touch: leave the URL as it was
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file, cleaned);
  return rel;
}
// every distinct opponent logo across the seasons, fetched once; the games
// point at the local copy (a failure leaves that one URL as it was)
export async function cleanMarks(seasons) {
  const urls = new Map();
  for (const games of Object.values(seasons)) for (const g of games) if (g.opp?.logo && /^https?:/.test(g.opp.logo)) urls.set(g.opp.logo, null);
  await Promise.all([...urls.keys()].map(async (u) => { try { urls.set(u, await cleanOne(u)); } catch (e) { console.error(`marks: ${u} left as is — ${e.message}`); } }));
  let n = 0;
  for (const games of Object.values(seasons)) for (const g of games) { const local = g.opp?.logo && urls.get(g.opp.logo); if (local) { g.opp.logo = local; n++; } }
  console.error(`marks: ${[...urls.values()].filter(Boolean).length} of ${urls.size} crests served locally without their ™ (${n} games)`);
}
