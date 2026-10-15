// Writes the 128x128 marketplace icon (a shield with a check mark) as a PNG using only
// node:zlib, so the build needs no image tooling. Usage: node scripts/make-icon.mjs media/icon.png
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const SIZE = 128;
const out = process.argv[2] ?? "media/icon.png";

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
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

// Shield outline: flat top band, straight sides, then a curve to the bottom point.
function insideShield(x, y) {
  const cx = 64;
  const top = 10;
  const bottom = 120;
  if (y < top || y > bottom) return false;
  const shoulder = top + 8 * Math.max(0, 1 - Math.abs(x - cx) / 50);
  if (y < shoulder) return false;
  const half = y < 66 ? 50 : 50 * Math.sqrt(Math.max(0, 1 - ((y - 66) / (bottom - 66)) ** 2));
  return Math.abs(x - cx) <= half;
}
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function onCheck(x, y) {
  return distToSegment(x, y, 40, 64, 57, 81) <= 7 || distToSegment(x, y, 57, 81, 90, 46) <= 7;
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  for (let x = 0; x < SIZE; x += 1) {
    // 4x supersampling for smooth edges.
    let shield = 0;
    let check = 0;
    for (let sy = 0; sy < 4; sy += 1) {
      for (let sx = 0; sx < 4; sx += 1) {
        const fx = x + (sx + 0.5) / 4;
        const fy = y + (sy + 0.5) / 4;
        if (insideShield(fx, fy)) {
          shield += 1;
          if (onCheck(fx, fy)) check += 1;
        }
      }
    }
    const a = shield / 16;
    const c = shield === 0 ? 0 : check / shield;
    const base = [37, 99, 235]; // blue shield
    const mark = [255, 255, 255];
    const px = base.map((v, i) => Math.round(v * (1 - c) + mark[i] * c));
    const o = y * (SIZE * 4 + 1) + 1 + x * 4;
    raw[o] = px[0];
    raw[o + 1] = px[1];
    raw[o + 2] = px[2];
    raw[o + 3] = Math.round(a * 255);
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(out, png);
console.log(`Wrote ${out} (${png.length} bytes)`);
