// Teste pure pentru render-slides.mjs: fără rețea, fără Chromium.
// Rulare: node scripts/render-slides.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAYOUTS,
  assetGeometry,
  assetUrl,
  buildSlideHtml,
  chipsHtml,
  emphasize,
  escapeHtml,
  fillTemplate,
  isMainModule,
  parseArgs,
  parseOnly,
  pickChrome,
  pngSize,
  slideFileName,
  resolveAsset,
  validateDesign,
  validateTheme,
  validateSourceAsset,
} from './render-slides.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(HERE, '..', 'templates');

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

test('escapeHtml escapează < > & " \'', () => {
  assert.equal(escapeHtml(`<a href="x">Tom & Jerry's</a>`), '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(42), '42');
});

test('emphasize: fără asteriscuri rămâne text escapat', () => {
  assert.equal(emphasize('Ship <fast>'), 'Ship &lt;fast&gt;');
});

test('emphasize: un cuvânt marcat devine em.serif', () => {
  assert.equal(emphasize('Ship *faster* today'), 'Ship <em class="serif">faster</em> today');
});

test('emphasize: două cuvinte marcate, fiecare în propriul em', () => {
  assert.equal(
    emphasize('*Less* noise, *more* signal'),
    '<em class="serif">Less</em> noise, <em class="serif">more</em> signal',
  );
});

test('emphasize: conținutul marcat este și el escapat', () => {
  assert.equal(emphasize('*a<b*'), '<em class="serif">a&lt;b</em>');
});

test('fillTemplate înlocuiește toate placeholder-ele și golește necunoscutele', () => {
  const html = '<h1>{{headline}}</h1><p>{{ body }}</p><i>{{unknown}}</i>{{n}}/{{total}}';
  const out = fillTemplate(html, { headline: 'Hi', body: 'B', n: 1, total: 3 });
  assert.equal(out, '<h1>Hi</h1><p>B</p><i></i>1/3');
  assert.ok(!out.includes('{{'));
  assert.equal(fillTemplate('{{x}}', { x: null }), '');
});

test('chipsHtml desparte pe | și escapează', () => {
  assert.equal(
    chipsHtml('Form | Table|<Injuries>'),
    '<span class="chip">Form</span>\n<span class="chip">Table</span>\n<span class="chip">&lt;Injuries&gt;</span>',
  );
  assert.equal(chipsHtml(''), '');
  assert.equal(chipsHtml(undefined), '');
  assert.equal(chipsHtml('a||b|'), '<span class="chip">a</span>\n<span class="chip">b</span>');
});

test('assetUrl produce file:/// cu slash-uri înainte', () => {
  const url = assetUrl('C:\\Users\\Some One\\assets', 'betora/phone-1.webp');
  assert.ok(url.startsWith('file:///'), url);
  assert.ok(!url.includes('\\'), url);
  assert.ok(url.endsWith('/betora/phone-1.webp'), url);
  assert.ok(url.includes('Some%20One'), url);
});

test('slideFileName completează cu zero', () => {
  assert.equal(slideFileName(0, 'html'), 'slide-01.html');
  assert.equal(slideFileName(9, 'png'), 'slide-10.png');
  assert.equal(slideFileName(4, 'png'), 'slide-05.png');
});

test('pngSize citește IHDR dintr-un buffer construit manual', () => {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(1080, 16);
  buffer.writeUInt32BE(1350, 20);
  assert.deepEqual(pngSize(buffer), { width: 1080, height: 1350 });
  assert.throws(() => pngSize(Buffer.from('not a png at all, definitely not')), /PNG/);
});

test('pickChrome alege 1237 numeric, nu lexicografic', () => {
  const base = 'C:\\Users\\x\\AppData\\Local\\ms-playwright';
  const paths = [
    `${base}\\chromium-1194\\chrome-win\\chrome.exe`,
    `${base}\\chromium-1237\\chrome-win64\\chrome.exe`,
    `${base}\\chromium-1234\\chrome-win64\\chrome.exe`,
  ];
  assert.equal(pickChrome(paths), paths[1]);
  // 999 < 1237 numeric, dar "999" > "1237" ca string.
  assert.equal(pickChrome([`${base}\\chromium-999\\chrome-win\\chrome.exe`, paths[1]]), paths[1]);
});

test('pickChrome preferă Chromium complet față de headless shell', () => {
  const full = 'C:\\pw\\chromium-1234\\chrome-win64\\chrome.exe';
  const shell = 'C:\\pw\\chromium_headless_shell-1237\\chrome-headless-shell-win64\\chrome-headless-shell.exe';
  assert.equal(pickChrome([shell, full]), full);
  assert.equal(pickChrome([shell]), shell);
  assert.equal(pickChrome([]), null);
});

test('parseOnly și parseArgs', () => {
  assert.deepEqual([...parseOnly('3,5')], [3, 5]);
  assert.equal(parseOnly(undefined), null);
  assert.throws(() => parseOnly('a'), /--only/);
  const args = parseArgs(['--post', 'p.json', '--assets', 'a', '--out', 'o', '--only', '1']);
  assert.equal(args.post, 'p.json');
  assert.deepEqual([...args.only], [1]);
  assert.throws(() => parseArgs(['--post', 'p.json']), /--assets/);
  assert.throws(() => parseArgs(['--bogus']), /necunoscut/);
});

test('isMainModule este fals când modulul e importat', () => {
  assert.equal(isMainModule('file:///C:/x/render-slides.mjs', 'C:\\x\\render-slides.test.mjs'), false);
  assert.equal(isMainModule('file:///C:/x/render-slides.mjs', 'c:/x/render-slides.mjs'), true);
  assert.equal(isMainModule('file:///C:/x/render-slides.mjs', undefined), false);
});

// Un director temporar cu un asset fals, pentru layout-urile cu imagine.
const assetsDir = mkdtempSync(join(tmpdir(), 'render-slides-assets-'));
writeFileSync(join(assetsDir, 'phone.webp'), Buffer.from('RIFF....WEBP', 'latin1'));

const sampleSlide = (orderIndex, layout) => ({
  order_index: orderIndex,
  layout,
  kicker: 'CASE STUDY · BETORA',
  headline: `Headline for *${layout}* & co`,
  body: 'Body line one.\nBody line two.',
  meta: 'betora.ro · live 2026',
  asset: 'phone.webp',
  inputs: 'Form|Table|Injuries',
  outputs: 'Over 2.5|BTTS',
  stat: '85%',
  disclaimer: 'sample output, not client results',
  cta: 'alkistudio.ro',
  accent: '#C8FF3E',
});

for (const [index, layout] of LAYOUTS.entries()) {
  test(`buildSlideHtml(${layout}) completează șablonul real`, () => {
    const html = buildSlideHtml(sampleSlide(index, layout), { templatesDir: TEMPLATES_DIR, assetsDir, total: 8 });
    assert.ok(html.includes(`Headline for <em class="serif">${layout}</em> &amp; co`), 'headline cu em.serif');
    assert.ok(html.includes('&gt; alki</span><span class="bar">|</span><span class="s">studio'), 'wordmark');
    assert.ok(html.includes(`${index + 1} / 8`), 'contor slide');
    assert.ok(!html.includes('{{'), 'fără placeholder-e rămase');
    assert.ok(html.includes('fonts.googleapis.com'), 'link Google Fonts');
    assert.ok(html.includes('--accent: #C8FF3E'), 'accentul ajunge în CSS');
    assert.ok(html.includes('Body line one.<br>Body line two.'), 'body cu <br>');
  });
}

test('buildSlideHtml pune asset-ul ca file:/// în layout-urile cu imagine', () => {
  const html = buildSlideHtml(sampleSlide(2, 'screenshot_phone'), { templatesDir: TEMPLATES_DIR, assetsDir, total: 3 });
  assert.ok(/src="file:\/\/\/[^"]+\/phone\.webp"/.test(html), html.match(/src="[^"]*"/)?.[0]);
});

test('buildSlideHtml(diagram) produce chips din inputs/outputs', () => {
  const html = buildSlideHtml(sampleSlide(5, 'diagram'), { templatesDir: TEMPLATES_DIR, assetsDir, total: 8 });
  assert.ok(html.includes('<span class="chip">Injuries</span>'));
  assert.ok(html.includes('<span class="chip">Over 2.5</span>'));
});

test('buildSlideHtml(stat) randează cifra și eticheta', () => {
  const html = buildSlideHtml(sampleSlide(6, 'stat'), { templatesDir: TEMPLATES_DIR, assetsDir, total: 8 });
  assert.ok(html.includes('<div class="figure">85%</div>'));
  assert.ok(html.includes('<div class="pill">sample output, not client results</div>'));
});

test('buildSlideHtml aruncă pentru asset inexistent', () => {
  const slide = { ...sampleSlide(0, 'screenshot_phone'), asset: 'betora/nu-exista.webp' };
  assert.throws(() => buildSlideHtml(slide, { templatesDir: TEMPLATES_DIR, assetsDir, total: 1 }), /asset inexistent/);
});

test('buildSlideHtml aruncă pentru layout cu imagine fără asset', () => {
  const slide = { ...sampleSlide(0, 'split'), asset: null };
  assert.throws(() => buildSlideHtml(slide, { templatesDir: TEMPLATES_DIR, assetsDir, total: 1 }), /cere un asset/);
});

test('buildSlideHtml aruncă pentru layout necunoscut sau headline lipsă', () => {
  assert.throws(() => buildSlideHtml({ order_index: 0, layout: 'nope', headline: 'x' }, { templatesDir: TEMPLATES_DIR }), /layout necunoscut/);
  assert.throws(() => buildSlideHtml({ order_index: 0, layout: 'cover', headline: '  ' }, { templatesDir: TEMPLATES_DIR }), /headline lipsă/);
});

test('buildSlideHtml folosește accentul implicit când valoarea nu e hex', () => {
  const html = buildSlideHtml({ order_index: 0, layout: 'cover', headline: 'x', accent: 'red' }, { templatesDir: TEMPLATES_DIR, total: 1 });
  assert.ok(html.includes('--accent: #C8FF3E'));
});

test('project theme overrides every legacy template and slide overrides stay local', () => {
  const visualDirection = { schema_version: 1, theme: { background: '#f6f3ee', text: '#17201a', muted: 'rgba(23,32,26,.7)', accent: '#21834d', fonts: { display: 'Georgia' } }, composition: { align: 'center' } };
  for (const layout of LAYOUTS) {
    const html = buildSlideHtml({ ...sampleSlide(0, layout), design: { theme: { accent: '#ff8800' }, headline_size: 80 } }, { assetsDir, visualDirection });
    assert.ok(html.includes('--bg: #f6f3ee;--ink: #17201a'));
    assert.ok(html.includes('--accent: #ff8800'));
    assert.ok(html.includes('.slide .headline {font-size:80px;}'));
  }
  assert.equal(visualDirection.theme.accent, '#21834d');
});

test('native source assets avoid duplicate frames and retain crop metadata', () => {
  const html = buildSlideHtml({ ...sampleSlide(0, 'screenshot_phone'), source_asset: { width: 400, height: 800, crop: { x0: .1, y0: .2, x1: .9, y1: .8 } } }, { assetsDir });
  assert.ok(html.includes('dynamic-asset frame-none'));
  assert.ok(!html.includes('<div class="phone">'));
  assert.ok(html.includes('data-crop='));
});

test('crop geometry preserves source pixels and never upscales', () => {
  assert.deepEqual(assetGeometry(400, 800, { x0: .1, y0: .25, x1: .9, y1: .75 }, 888, 880), { x: 40, y: 200, cropWidth: 320, cropHeight: 400, width: 320, height: 400, scale: 1 });
  const scaled = assetGeometry(1600, 2400, undefined, 400, 600);
  assert.equal(scaled.scale, .25);
  assert.equal(scaled.width, 400);
  assert.equal(assetGeometry(100, 50, undefined, 800, 800, 'cover').scale, 1);
});

test('CSS injection, invalid crop and unsafe asset references are rejected', () => {
  assert.throws(() => validateDesign({ headline_size: '72px; color:red' }), /headline_size/);
  assert.throws(() => validateDesign({ image_scale: 2 }), /image_scale/);
  assert.throws(() => validateDesign({ css: 'body {}' }), /necunoscut/);
  assert.throws(() => validateTheme({ background: 'red; background:url(x)' }), /culoare/);
  assert.throws(() => validateTheme({ fonts: { display: 'Arial";</style>' } }), /font/);
  assert.throws(() => validateSourceAsset({ width: 400, height: 800, crop: { x0: 1, x1: .5, y0: 0, y1: 1 } }), /crop/);
  assert.throws(() => resolveAsset(assetsDir, '../outside.png'), /relativă/);
  assert.throws(() => resolveAsset(assetsDir, 'C:/private.png'), /relativă/);
  const outside = mkdtempSync(join(tmpdir(), 'marketing-outside-'));
  writeFileSync(join(outside, 'secret.png'), 'private');
  try {
    symlinkSync(outside, join(assetsDir, 'linked'), 'junction');
    assert.throws(() => resolveAsset(assetsDir, 'linked/secret.png'), /afara/);
  } finally { rmSync(outside, { recursive: true, force: true }); }
});

test('background asset uses the same containment rules', () => {
  assert.throws(() => buildSlideHtml(sampleSlide(0, 'cover'), { assetsDir, visualDirection: { schema_version: 1, theme: { background_asset: '../outside.png' } } }), /relativă/);
});

rmSync(assetsDir, { recursive: true, force: true });

if (failures > 0) {
  console.log(`\n${failures} test(e) picate`);
  process.exit(1);
}
console.log('\ntoate testele au trecut');
