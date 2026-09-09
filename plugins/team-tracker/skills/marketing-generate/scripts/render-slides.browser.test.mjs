// Optional integration tests: local Chromium, no network and no npm dependencies.
// node --test scripts/render-slides.browser.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { buildSlideHtml, captureSlide, DEFAULT_TEMPLATES_DIR, findChrome, renderPost } from './render-slides.mjs';

let chrome;
try { chrome = findChrome(); } catch { /* The pure test suite remains runnable without Chromium. */ }

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(width, height) {
  const chunk = (name, data) => {
    const type = Buffer.from(name); const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height, 140);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
function offline(html) { return html.replace(/<link\b[^>]*>/g, ''); }

test('Chromium applies project colors and native crop size with no added frame', { skip: !chrome }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-render-browser-'));
  try {
    writeFileSync(join(dir, 'product.png'), png(400, 200));
    const html = offline(buildSlideHtml({ order_index: 0, layout: 'compose', headline: 'Made for your day', body: 'Clear product. Simple story.', asset: 'product.png',
      source_asset: { width: 400, height: 200, crop: { x0: .25, y0: .25, x1: .75, y1: .75 } }, design: { headline_size: 60, layout_variant: 'split' } },
    { assetsDir: dir, total: 3, visualDirection: { schema_version: 1, theme: { background: '#f0eee6', text: '#17331f', muted: '#45654a', accent: '#278850', fonts: { display: 'Arial', body: 'Arial', mono: 'Arial', serif: 'Georgia' } } } }));
    writeFileSync(join(dir, 'slide.html'), html);
    const result = await captureSlide({ chrome, htmlPath: join(dir, 'slide.html'), pngPath: join(dir, 'slide.png') });
    assert.equal(result.diagnostics.theme.background, 'rgb(240, 238, 230)');
    assert.equal(result.diagnostics.theme.text, 'rgb(23, 51, 31)');
    assert.equal(result.diagnostics.theme.accent, '#278850');
    assert.equal(result.diagnostics.theme.headlineSize, '60px');
    assert.deepEqual(result.diagnostics.assets, [{ width: 200, height: 100, nativeWidth: 200, nativeHeight: 100, scale: 1 }]);
    assert.equal(result.width, 1080); assert.equal(result.height, 1350);
    assert.ok(readFileSync(join(dir, 'slide.png')).length > 1024);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Chromium refuses overflowing text and broken image decode', { skip: !chrome }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-render-errors-'));
  try {
    const htmlPath = join(dir, 'slide.html'); const pngPath = join(dir, 'slide.png');
    writeFileSync(htmlPath, offline(buildSlideHtml({ order_index: 0, layout: 'cover', headline: 'Too much text '.repeat(100) })));
    await assert.rejects(captureSlide({ chrome, htmlPath, pngPath }), /depășește/);
    writeFileSync(htmlPath, '<!doctype html><html><body><img src="file:///missing-marketing-image.png"></body></html>');
    await assert.rejects(captureSlide({ chrome, htmlPath, pngPath }), /decode|decoded|EncodingError/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('only complete renders bind the exact recipe and PNG bytes for publication', { skip: !chrome }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-render-binding-'));
  try {
    const templatesDir = join(dir, 'templates'); mkdirSync(join(templatesDir, 'slides'), { recursive: true });
    writeFileSync(join(templatesDir, 'slides', 'cover.html'), offline(readFileSync(join(DEFAULT_TEMPLATES_DIR, 'slides', 'cover.html'), 'utf8')));
    const post = { caption: 'Original caption', slides: [{ order_index: 0, layout: 'cover', headline: 'A clear idea' }] };
    const options = { post, templatesDir, outDir: dir, assetsDir: dir, chrome };
    await renderPost(options);
    const marker = JSON.parse(readFileSync(join(dir, 'reviewed-render.json'), 'utf8'));
    const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
    assert.equal(marker.post_sha256, hash(JSON.stringify(post)));
    assert.equal(marker.slides[0].sha256, hash(readFileSync(join(dir, 'slide-01.png'))));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'reviewed-post.json'), 'utf8')), post);
    await renderPost({ ...options, only: new Set([0]) });
    assert.equal(existsSync(join(dir, 'reviewed-render.json')), false);
    assert.equal(existsSync(join(dir, 'reviewed-post.json')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
