// Teste pentru asset-inventory.mjs cu antete construite manual. Rulare: node scripts/asset-inventory.test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, imageSize, inventory, parseArgs, summarize } from './asset-inventory.mjs';

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`not ok - ${name}\n    ${String(error.stack || error).split('\n').join('\n    ')}`);
  }
}

// --- Constructori de antete minimale -------------------------------------------------

function pngHeader(width, height) {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

// SOI, un segment APP0 de umplutură, apoi SOF0 cu înălțime/lățime.
function jpegHeader(width, height) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof0 = Buffer.alloc(2 + 2 + 1 + 2 + 2 + 1 + 9);
  sof0[0] = 0xff; sof0[1] = 0xc0;
  sof0.writeUInt16BE(sof0.length - 2, 2);
  sof0[4] = 8;
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0]);
}

function riff(chunkType, payload) {
  const header = Buffer.alloc(20);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(4 + 8 + payload.length, 4);
  header.write('WEBP', 8, 'ascii');
  header.write(chunkType, 12, 'ascii');
  header.writeUInt32LE(payload.length, 16);
  return Buffer.concat([header, payload]);
}

function webpVp8x(width, height) {
  const payload = Buffer.alloc(10);
  payload[0] = 0x10; // flags: alpha
  const w = width - 1;
  const h = height - 1;
  payload[4] = w & 0xff; payload[5] = (w >> 8) & 0xff; payload[6] = (w >> 16) & 0xff;
  payload[7] = h & 0xff; payload[8] = (h >> 8) & 0xff; payload[9] = (h >> 16) & 0xff;
  return riff('VP8X', payload);
}

function webpVp8l(width, height) {
  const payload = Buffer.alloc(10);
  payload[0] = 0x2f;
  const w = width - 1;
  const h = height - 1;
  // 14 biți lățime, 14 biți înălțime, 1 bit alpha, 3 biți versiune — împachetate little-endian.
  const bits = BigInt(w) | (BigInt(h) << 14n) | (1n << 28n);
  for (let i = 0; i < 4; i += 1) payload[1 + i] = Number((bits >> BigInt(8 * i)) & 0xffn);
  return riff('VP8L', payload);
}

function webpVp8(width, height) {
  const payload = Buffer.alloc(14);
  payload[0] = 0x10; payload[1] = 0x02; payload[2] = 0x00; // frame tag
  payload[3] = 0x9d; payload[4] = 0x01; payload[5] = 0x2a;
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  return riff('VP8 ', payload);
}

// --- Teste ------------------------------------------------------------------------------

test('imageSize PNG', () => {
  assert.deepEqual(imageSize(pngHeader(1600, 924), '.png'), { width: 1600, height: 924 });
  assert.equal(imageSize(Buffer.from('nu e png'), 'png'), null);
});

test('imageSize JPEG (SOF0 după un APP0)', () => {
  assert.deepEqual(imageSize(jpegHeader(1440, 900), '.jpg'), { width: 1440, height: 900 });
  assert.deepEqual(imageSize(jpegHeader(300, 700), 'jpeg'), { width: 300, height: 700 });
  assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), '.jpg'), null);
});

test('imageSize WebP VP8X', () => {
  assert.deepEqual(imageSize(webpVp8x(1080, 2210), '.webp'), { width: 1080, height: 2210 });
  assert.deepEqual(imageSize(webpVp8x(70000, 3), '.webp'), { width: 70000, height: 3 });
});

test('imageSize WebP VP8L', () => {
  assert.deepEqual(imageSize(webpVp8l(1014, 2082), '.webp'), { width: 1014, height: 2082 });
  assert.deepEqual(imageSize(webpVp8l(1, 1), '.webp'), { width: 1, height: 1 });
  assert.deepEqual(imageSize(webpVp8l(16384, 16384), '.webp'), { width: 16384, height: 16384 });
});

test('imageSize WebP VP8 (lossy)', () => {
  assert.deepEqual(imageSize(webpVp8(1600, 924), '.webp'), { width: 1600, height: 924 });
  assert.equal(imageSize(Buffer.from('RIFF....WEBPXXXX' + 'x'.repeat(20)), '.webp'), null);
});

test('imageSize ignoră extensiile necunoscute', () => {
  assert.equal(imageSize(pngHeader(1, 1), '.mp4'), null);
  assert.equal(imageSize(pngHeader(1, 1), undefined), null);
});

test('classify: portret = phone, peisaj = desktop, video după extensie, altfel other', () => {
  assert.equal(classify({ ext: '.webp', width: 1080, height: 2210 }), 'phone');
  assert.equal(classify({ ext: '.webp', width: 1600, height: 924 }), 'desktop');
  assert.equal(classify({ ext: 'png', width: 500, height: 500 }), 'other');
  assert.equal(classify({ ext: '.webp', width: null, height: null }), 'other');
  assert.equal(classify({ ext: '.mp4' }), 'video');
  assert.equal(classify({ ext: '.webm', width: 1920, height: 1080 }), 'video');
  assert.equal(classify({ ext: '.txt' }), 'other');
});

test('summarize: numărători și carousel_ready la ≥ 4 imagini statice', () => {
  const three = [
    { rel: 'p/1.webp', kind: 'phone', width: 1, height: 2 },
    { rel: 'p/2.webp', kind: 'phone', width: 1, height: 2 },
    { rel: 'p/d.webp', kind: 'desktop', width: 2, height: 1 },
    { rel: 'p/v.mp4', kind: 'video', width: null, height: null },
    { rel: 'p/x.webp', kind: 'other', width: null, height: null },
  ];
  assert.deepEqual(summarize(three), { counts: { phone: 2, desktop: 1, video: 1, other: 1 }, carousel_ready: false });
  const four = [...three, { rel: 'p/3.webp', kind: 'phone', width: 1, height: 2 }];
  assert.equal(summarize(four).carousel_ready, true);
  assert.deepEqual(summarize([]), { counts: { phone: 0, desktop: 0, video: 0, other: 0 }, carousel_ready: false });
});

test('inventory pe un director temporar', () => {
  const root = mkdtempSync(join(tmpdir(), 'asset-inventory-'));
  mkdirSync(join(root, 'betora'));
  mkdirSync(join(root, 'amos'));
  writeFileSync(join(root, 'betora', 'phone-1.webp'), webpVp8x(1080, 2210));
  writeFileSync(join(root, 'betora', 'phone-2.webp'), webpVp8l(1014, 2082));
  writeFileSync(join(root, 'betora', 'desktop-1.png'), pngHeader(1600, 924));
  writeFileSync(join(root, 'betora', 'desktop-2.jpg'), jpegHeader(1440, 900));
  writeFileSync(join(root, 'betora', 'site.mp4'), Buffer.alloc(32));
  writeFileSync(join(root, 'amos', 'site.webm'), Buffer.alloc(32));
  writeFileSync(join(root, 'logo.webp'), webpVp8(200, 200));

  const result = inventory(root);
  const betora = result.projects.betora;
  assert.deepEqual(betora.counts, { phone: 2, desktop: 2, video: 1, other: 0 });
  assert.equal(betora.carousel_ready, true);
  assert.deepEqual(betora.files.map((f) => f.rel), ['betora/desktop-1.png', 'betora/desktop-2.jpg', 'betora/phone-1.webp', 'betora/phone-2.webp', 'betora/site.mp4']);
  const video = betora.files.find((f) => f.rel === 'betora/site.mp4');
  assert.deepEqual(video, { rel: 'betora/site.mp4', bytes: 32, width: null, height: null, kind: 'video' });
  const phone = betora.files.find((f) => f.rel === 'betora/phone-2.webp');
  assert.equal(phone.width, 1014);
  assert.equal(phone.height, 2082);
  assert.equal(phone.kind, 'phone');
  assert.deepEqual(result.projects.amos.counts, { phone: 0, desktop: 0, video: 1, other: 0 });
  assert.equal(result.projects.amos.carousel_ready, false);
  assert.equal(result.projects._root.files[0].kind, 'other', 'logo pătrat = other');

  const only = inventory(root, { project: 'amos' });
  assert.deepEqual(Object.keys(only.projects), ['amos']);
  assert.throws(() => inventory(root, { project: 'nope' }), /proiectul "nope" nu există/);
  rmSync(root, { recursive: true, force: true });
});

test('parseArgs', () => {
  assert.deepEqual(parseArgs(['--assets', 'a', '--project', 'betora']), { assets: 'a', project: 'betora' });
  assert.throws(() => parseArgs([]), /--assets/);
  assert.throws(() => parseArgs(['--x']), /necunoscut/);
});

if (failures > 0) {
  console.log(`\n${failures} test(e) picate`);
  process.exit(1);
}
console.log('\ntoate testele au trecut');
