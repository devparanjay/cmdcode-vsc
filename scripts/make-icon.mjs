// Generates media/icon.png — original artwork (PRD PD-5), not the vendor mark.
// A minimal 128x128 mark: a rounded-square "window" in the VS Code blue with a
// white chevron + underscore (a terminal prompt), drawn straight into an RGBA
// buffer and encoded as a minimal PNG. Run with: node scripts/make-icon.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 128;
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'media', 'icon.png');

const px = new Uint8Array(SIZE * SIZE * 4);

function set(x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  const na = a / 255;
  px[i] = Math.round(px[i] * (1 - na) + r * na);
  px[i + 1] = Math.round(px[i + 1] * (1 - na) + g * na);
  px[i + 2] = Math.round(px[i + 2] * (1 - na) + b * na);
  px[i + 3] = Math.max(px[i + 3], a);
}

// Colors
const BG = [0, 122, 204, 255]; // VS Code blue
const FG = [255, 255, 255, 255];

// Rounded square background with a 12px corner radius.
const R = 14;
const inset = 8;
const min = inset;
const max = SIZE - inset;
function inRounded(x, y) {
  if (x < min || x > max || y < min || y > max) return false;
  const cx = Math.min(Math.max(x, min + R), max - R);
  const cy = Math.min(Math.max(y, min + R), max - R);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= R * R;
}
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (inRounded(x + 0.5, y + 0.5)) set(x, y, BG);
  }
}

// Terminal chevron ">": two thick strokes forming a right-pointing angle.
function stroke(ax, ay, bx, by, w) {
  const steps = Math.ceil(Math.hypot(bx - ax, by - ay) * 2);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = ax + (bx - ax) * t;
    const y = ay + (by - ay) * t;
    for (let oy = -w; oy <= w; oy++) {
      for (let ox = -w; ox <= w; ox++) {
        if (ox * ox + oy * oy <= w * w) set(Math.round(x + ox), Math.round(y + oy), FG);
      }
    }
  }
}
// ">" chevron
stroke(44, 40, 68, 64, 6);
stroke(68, 64, 44, 88, 6);
// Underscore "_"
stroke(78, 90, 100, 90, 6);

// ─── PNG encoding (RGBA, 8-bit) ───
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
let o = 0;
for (let y = 0; y < SIZE; y++) {
  raw[o++] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    raw[o++] = px[i];
    raw[o++] = px[i + 1];
    raw[o++] = px[i + 2];
    raw[o++] = px[i + 3];
  }
}

function crc32(buf) {
  let c;
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes, ${SIZE}x${SIZE})`);
