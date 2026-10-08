/**
 * Rasterizes the radar icon (concentric circles + sweep) to PNGs.
 * Dependency-free: pure-JS renderer + minimal PNG encoder (node:zlib).
 *
 * Output:
 *   public/icons/icon16.png, icon32.png, icon48.png, icon128.png (manifest icons)
 *   store/assets/logo-300.png                         (Partner Center store logo, 300x300)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- tiny PNG encoder (RGBA, 8-bit) ---
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([td, data])));
  return Buffer.concat([len, td, data, crc]);
}

function encodePng(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// --- radar icon renderer (unit space: 128x128) ---
const BLUE = [37, 99, 235];
const WHITE = [255, 255, 255];
const GREEN = [34, 197, 94];

function inRoundedRect(x, y, s, r) {
  // Signed distance to a centered rounded rect; inside when <= 0.
  const qx = Math.abs(x - s / 2) - (s / 2 - r);
  const qy = Math.abs(y - s / 2) - (s / 2 - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r <= 0;
}

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.min(1, Math.max(0, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function samplePixel(x, y, s) {
  // background
  let col = null; // transparent outside rounded rect
  if (inRoundedRect(x, y, s, (24 / 128) * s)) col = BLUE;

  const cx = s / 2;
  const cy = s / 2;
  const d = Math.hypot(x - cx, y - cy);
  const w = (3.2 / 128) * s; // half stroke width
  for (const r of [40, 27, 14]) {
    if (Math.abs(d - (r / 128) * s) <= w) col = WHITE;
  }
  // sweep line center -> upper right
  if (segDist(x, y, cx, cy, (93 / 128) * s, (35 / 128) * s) <= w) col = WHITE;
  // blips
  if (Math.hypot(x - cx, y - cy) <= (6 / 128) * s) col = GREEN;
  if (Math.hypot(x - (84 / 128) * s, y - (78 / 128) * s) <= (5 / 128) * s) col = WHITE;
  return col;
}

function render(size) {
  const SS = size <= 48 ? 8 : 4; // supersample factor
  const big = size * SS;
  const acc = new Float32Array(size * size * 4);
  for (let by = 0; by < big; by++) {
    for (let bx = 0; bx < big; bx++) {
      const col = samplePixel(((bx + 0.5) / SS / size) * 128, ((by + 0.5) / SS / size) * 128, 128);
      const idx = (Math.floor(by / SS) * size + Math.floor(bx / SS)) * 4;
      if (col) {
        acc[idx] += col[0];
        acc[idx + 1] += col[1];
        acc[idx + 2] += col[2];
        acc[idx + 3] += 255;
      }
    }
  }
  const out = Buffer.alloc(size * size * 4);
  const n = SS * SS;
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = Math.round(acc[i * 4] / n);
    out[i * 4 + 1] = Math.round(acc[i * 4 + 1] / n);
    out[i * 4 + 2] = Math.round(acc[i * 4 + 2] / n);
    out[i * 4 + 3] = Math.round(acc[i * 4 + 3] / n);
  }
  return out;
}

for (const [size, dest] of [
  [16, 'public/icons/icon16.png'],
  [32, 'public/icons/icon32.png'],
  [48, 'public/icons/icon48.png'],
  [128, 'public/icons/icon128.png'],
  [300, 'store/assets/logo-300.png'],
]) {
  const png = encodePng(render(size), size, size);
  const file = join(root, dest);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, png);
  console.log(`wrote ${dest} (${png.length} bytes)`);
}
