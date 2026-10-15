// Generates the toolbar icons (monochrome shield with a check mark on a dark rounded square)
// as PNG files using only node:zlib. Run by build.mjs; no image dependencies needed.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
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
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function inRoundedSquare(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inShield(x, y) {
  const top = 0.17;
  const shoulder = 0.5;
  const bottom = 0.88;
  const half = 0.31;
  if (y < top || y > bottom) return false;
  // Slight concave dip in the top edge.
  if (y < top + 0.04 * (1 - ((x - 0.5) / half) ** 2) && Math.abs(x - 0.5) < half) return false;
  const hw = y <= shoulder ? half : half * Math.sqrt(Math.max(0, 1 - ((y - shoulder) / (bottom - shoulder)) ** 2));
  return Math.abs(x - 0.5) <= hw;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function inCheck(x, y) {
  const w = 0.055;
  return distToSegment(x, y, 0.37, 0.5, 0.465, 0.6) <= w || distToSegment(x, y, 0.465, 0.6, 0.64, 0.38) <= w;
}

const BG = [13, 17, 23];
const FG = [230, 237, 243];

/** Renders the icon at any square size and returns PNG bytes (also used for the store logo). */
export function render(size) {
  const ss = 4; // supersampling for smooth edges
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          if (!inRoundedSquare(x, y, 0.2)) continue;
          if (inShield(x, y) && !inCheck(x, y)) fg++;
          else bg++;
        }
      }
      const n = ss * ss;
      const alpha = (bg + fg) / n;
      const i = (py * size + px) * 4;
      if (alpha === 0) continue;
      const f = fg / (bg + fg);
      out[i] = Math.round(BG[0] * (1 - f) + FG[0] * f);
      out[i + 1] = Math.round(BG[1] * (1 - f) + FG[1] * f);
      out[i + 2] = Math.round(BG[2] * (1 - f) + FG[2] * f);
      out[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, out);
}

export function writeIcons(dir) {
  mkdirSync(dir, { recursive: true });
  for (const size of [16, 48, 128]) writeFileSync(join(dir, `icon${size}.png`), render(size));
}
