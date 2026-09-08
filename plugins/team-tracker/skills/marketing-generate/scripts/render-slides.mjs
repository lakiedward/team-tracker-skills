#!/usr/bin/env node
// Randează slide-urile unui carusel Instagram (1080×1350, 4:5) din șabloanele HTML
// ale studioului, cu Chromium headless. Fără dependențe npm; doar Node 22.
//
// Utilizare:
//   node render-slides.mjs --post <post.json> --assets <dir> --out <dir>
//                          [--chrome <exe>] [--only 3,5] [--templates <dir>]
//
// Manifestul JSON ajunge pe stdout; mesajele de progres pe stderr.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LAYOUTS = Object.freeze([
  'cover', 'statement', 'screenshot_phone', 'screenshot_desktop', 'split', 'diagram', 'stat', 'cta',
]);
// Layout-urile care nu au sens fără o captură de produs.
export const IMAGE_LAYOUTS = Object.freeze(['screenshot_phone', 'screenshot_desktop', 'split']);
export const SLIDE_WIDTH = 1080;
export const SLIDE_HEIGHT = 1350;
export const DEFAULT_ACCENT = '#C8FF3E';
export const VIRTUAL_TIME_BUDGET_MS = 6000;
// Sub 1 KB nu poate fi un slide 1080×1350 valid (nici măcar unul monocrom).
const MIN_PNG_BYTES = 1024;

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TEMPLATES_DIR = resolve(HERE, '..', 'templates');

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

// `*cuvânt*` → <em class="serif">cuvânt</em>; restul textului este escapat.
export function emphasize(text) {
  return escapeHtml(text).replace(/\*([^*\n]+)\*/g, '<em class="serif">$1</em>');
}

// Înlocuiește fiecare {{nume}}; placeholder-ele necunoscute devin șir gol, niciodată nu rămân în HTML.
export function fillTemplate(html, values) {
  return html.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, key) => {
    const value = Object.hasOwn(values, key) ? values[key] : '';
    return value === null || value === undefined ? '' : String(value);
  });
}

// "Form|Table|Injuries" → un <span class="chip"> pe element, fiecare escapat.
export function chipsHtml(str) {
  return String(str ?? '')
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => `<span class="chip">${escapeHtml(item)}</span>`)
    .join('\n');
}

export function assetUrl(assetsDir, rel) {
  return pathToFileURL(resolve(assetsDir, rel)).href;
}

export function slideFileName(orderIndex, ext) {
  return `slide-${String(Number(orderIndex) + 1).padStart(2, '0')}.${ext}`;
}

// Citește lățimea/înălțimea din antetul PNG (semnătură + IHDR); aruncă dacă nu e PNG.
export function pngSize(buffer) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!buffer || buffer.length < 24 || signature.some((byte, i) => buffer[i] !== byte)) {
    throw new Error('nu este un fișier PNG valid (semnătură lipsă)');
  }
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG fără chunk IHDR');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function chromeVersion(path) {
  const match = /chromium(?:_headless_shell)?-(\d+)/i.exec(path);
  return match ? Number(match[1]) : -1;
}

// Preferă Chromium complet față de headless shell; în fiecare grup, versiunea cea mai mare (sortare numerică).
export function pickChrome(candidatePaths) {
  const paths = (candidatePaths || []).filter(Boolean);
  if (paths.length === 0) return null;
  const isShell = (path) => /chromium_headless_shell-/i.test(path);
  const full = paths.filter((path) => !isShell(path));
  const pool = full.length > 0 ? full : paths;
  return pool.slice().sort((a, b) => chromeVersion(b) - chromeVersion(a))[0];
}

// Ordinea de căutare: --chrome → MARKETING_CHROME → %LOCALAPPDATA%/ms-playwright.
export function findChrome({ explicit, env = process.env } = {}) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`--chrome indică un fișier inexistent: ${explicit}`);
    return explicit;
  }
  if (env.MARKETING_CHROME) {
    if (!existsSync(env.MARKETING_CHROME)) {
      throw new Error(`MARKETING_CHROME indică un fișier inexistent: ${env.MARKETING_CHROME}`);
    }
    return env.MARKETING_CHROME;
  }
  const playwrightDir = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'ms-playwright') : null;
  const candidates = [];
  if (playwrightDir && existsSync(playwrightDir)) {
    // Playwright a schimbat numele subfolderului între versiuni (chrome-win, chrome-win64, chrome-headless-shell-win64).
    const shapes = [
      { dir: /^chromium-\d+$/i, files: ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe'] },
      {
        dir: /^chromium_headless_shell-\d+$/i,
        files: [
          'chrome-win/headless_shell.exe',
          'chrome-headless-shell-win64/chrome-headless-shell.exe',
          'chrome-headless-shell-win/chrome-headless-shell.exe',
        ],
      },
    ];
    for (const entry of readdirSync(playwrightDir)) {
      for (const shape of shapes) {
        if (!shape.dir.test(entry)) continue;
        for (const file of shape.files) {
          const path = join(playwrightDir, entry, ...file.split('/'));
          if (existsSync(path)) candidates.push(path);
        }
      }
    }
  }
  const picked = pickChrome(candidates);
  if (picked) return picked;
  throw new Error(
    'Nu găsesc Chromium. Opțiuni: (1) --chrome <cale către chrome.exe>, (2) variabila de mediu MARKETING_CHROME, '
    + '(3) o instalare Playwright în %LOCALAPPDATA%/ms-playwright (chromium-<N> sau chromium_headless_shell-<N>).',
  );
}

function normalizeAccent(value) {
  const accent = String(value ?? '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(accent) || /^#[0-9a-fA-F]{3}$/.test(accent) ? accent : DEFAULT_ACCENT;
}

function slideLabel(slide) {
  return `slide ${Number(slide?.order_index) + 1} (${slide?.layout ?? 'layout lipsă'})`;
}

// Completează șablonul layout-ului cu valorile slide-ului (toate escapate) și întoarce HTML-ul final.
export function buildSlideHtml(slide, { templatesDir = DEFAULT_TEMPLATES_DIR, assetsDir, total } = {}) {
  if (!slide || typeof slide !== 'object') throw new Error('slide invalid');
  if (!Number.isInteger(slide.order_index) || slide.order_index < 0) {
    throw new Error(`${slideLabel(slide)}: order_index trebuie să fie un întreg ≥ 0`);
  }
  if (!LAYOUTS.includes(slide.layout)) {
    throw new Error(`${slideLabel(slide)}: layout necunoscut; cunoscute: ${LAYOUTS.join(', ')}`);
  }
  if (!String(slide.headline ?? '').trim()) throw new Error(`${slideLabel(slide)}: headline lipsă`);

  const templatePath = join(templatesDir, 'slides', `${slide.layout}.html`);
  if (!existsSync(templatePath)) throw new Error(`${slideLabel(slide)}: șablon lipsă: ${templatePath}`);
  const template = readFileSync(templatePath, 'utf8');

  let assetSrc = '';
  if (slide.asset) {
    if (!assetsDir) throw new Error(`${slideLabel(slide)}: are asset, dar nu s-a dat directorul de assets (--assets)`);
    const absolute = resolve(assetsDir, slide.asset);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      throw new Error(`${slideLabel(slide)}: asset inexistent: ${absolute}`);
    }
    assetSrc = escapeHtml(assetUrl(assetsDir, slide.asset));
  } else if (IMAGE_LAYOUTS.includes(slide.layout)) {
    throw new Error(`${slideLabel(slide)}: layout-ul cere un asset (captură de produs), dar "asset" lipsește`);
  }

  const values = {
    kicker: escapeHtml(slide.kicker),
    headline: emphasize(slide.headline),
    body: escapeHtml(slide.body).replace(/\r?\n/g, '<br>'),
    meta: escapeHtml(slide.meta),
    n: String(slide.order_index + 1),
    total: String(total ?? slide.order_index + 1),
    accent: normalizeAccent(slide.accent),
    asset_src: assetSrc,
    inputs_html: chipsHtml(slide.inputs),
    outputs_html: chipsHtml(slide.outputs),
    stat: escapeHtml(slide.stat),
    disclaimer: escapeHtml(slide.disclaimer),
    cta: escapeHtml(slide.cta),
  };
  return fillTemplate(template, values);
}

export function chromeArgs(htmlPath, pngPath) {
  return [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${SLIDE_WIDTH},${SLIDE_HEIGHT}`,
    `--virtual-time-budget=${VIRTUAL_TIME_BUDGET_MS}`,
    `--screenshot=${pngPath}`,
    pathToFileURL(htmlPath).href,
  ];
}

// Capturează un HTML deja scris pe disc; verifică ieșirea, existența și dimensiunile PNG-ului.
export function captureSlide({ chrome, htmlPath, pngPath, label }) {
  const result = spawnSync(chrome, chromeArgs(htmlPath, pngPath), { encoding: 'utf8', windowsHide: true });
  if (result.error) throw new Error(`${label}: Chromium nu a putut porni: ${result.error.message}`);
  // Chromium scrie avertismente inofensive (sandbox, GPU) pe stderr; contează doar codul de ieșire.
  if (result.status !== 0) {
    const tail = String(result.stderr || '').trim().split('\n').slice(-3).join(' | ');
    throw new Error(`${label}: Chromium a ieșit cu codul ${result.status}${tail ? ` — ${tail}` : ''}`);
  }
  if (!existsSync(pngPath)) throw new Error(`${label}: Chromium nu a scris ${pngPath}`);
  const buffer = readFileSync(pngPath);
  if (buffer.length < MIN_PNG_BYTES) throw new Error(`${label}: PNG suspect de mic (${buffer.length} B)`);
  const { width, height } = pngSize(buffer);
  if (width !== SLIDE_WIDTH || height !== SLIDE_HEIGHT) {
    throw new Error(`${label}: PNG are ${width}×${height}, aștept ${SLIDE_WIDTH}×${SLIDE_HEIGHT}`);
  }
  return { width, height, bytes: buffer.length };
}

export function parseOnly(value) {
  if (value === undefined || value === null || value === '') return null;
  const indices = String(value).split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  if (indices.some((n) => !Number.isInteger(n) || n < 0)) throw new Error(`--only invalid: ${value}`);
  return new Set(indices);
}

export function parseArgs(argv) {
  const args = { post: null, assets: null, out: null, chrome: null, only: null, templates: DEFAULT_TEMPLATES_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    if (arg === '--post') args.post = value;
    else if (arg === '--assets') args.assets = value;
    else if (arg === '--out') args.out = value;
    else if (arg === '--chrome') args.chrome = value;
    else if (arg === '--only') args.only = parseOnly(value);
    else if (arg === '--templates') args.templates = value;
    else throw new Error(`argument necunoscut: ${arg}`);
    i += 1;
  }
  if (args.help) return args;
  for (const key of ['post', 'assets', 'out']) {
    if (!args[key]) throw new Error(`lipsește --${key}`);
  }
  return args;
}

export function loadPost(path) {
  if (!existsSync(path)) throw new Error(`post.json inexistent: ${path}`);
  let post;
  try {
    post = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`post.json nu e JSON valid: ${error.message}`);
  }
  if (!post || !Array.isArray(post.slides) || post.slides.length === 0) {
    throw new Error('post.json trebuie să aibă un array "slides" ne-gol');
  }
  return post;
}

// Randează toate slide-urile (sau doar cele din `only`) și întoarce manifestul.
export function renderPost({ post, assetsDir, outDir, chrome, only = null, templatesDir = DEFAULT_TEMPLATES_DIR, log = () => {} }) {
  mkdirSync(outDir, { recursive: true });
  const slides = post.slides.slice().sort((a, b) => a.order_index - b.order_index);
  const total = slides.length;
  const manifest = { post_id: post.post_id ?? null, version: post.version ?? null, slides: [] };
  for (const slide of slides) {
    if (only && !only.has(slide.order_index)) continue;
    const label = slideLabel(slide);
    const html = buildSlideHtml(slide, { templatesDir, assetsDir, total });
    const htmlPath = resolve(outDir, slideFileName(slide.order_index, 'html'));
    const pngPath = resolve(outDir, slideFileName(slide.order_index, 'png'));
    writeFileSync(htmlPath, html, 'utf8');
    log(`${label}: ${basename(htmlPath)} scris, capturez…`);
    const { width, height } = captureSlide({ chrome, htmlPath, pngPath, label });
    log(`${label}: ${basename(pngPath)} ${width}×${height}`);
    manifest.slides.push({ order_index: slide.order_index, layout: slide.layout, html: htmlPath, png: pngPath, width, height });
  }
  if (manifest.slides.length === 0) throw new Error('niciun slide de randat (verifică --only)');
  return manifest;
}

export function isMainModule(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const normalize = (path) => path.replace(/\\/g, '/').toLowerCase();
  return normalize(resolve(argv1)) === normalize(fileURLToPath(metaUrl));
}

const USAGE = `Utilizare: node render-slides.mjs --post <post.json> --assets <dir> --out <dir> [--chrome <exe>] [--only 3,5] [--templates <dir>]
  --post       fișierul JSON al postării (post_id, version, slides[])
  --assets     directorul cu capturile de produs; "asset" din fiecare slide e relativ la el
  --out        directorul în care se scriu slide-NN.html și slide-NN.png
  --chrome     calea către chrome.exe (altfel MARKETING_CHROME, apoi %LOCALAPPDATA%/ms-playwright)
  --only       doar aceste order_index (0-based), separate prin virgulă
  --templates  directorul cu șabloane (implicit: ../templates față de script)`;

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Eroare: ${error.message}\n${USAGE}`);
    process.exit(1);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  try {
    const post = loadPost(args.post);
    const chrome = findChrome({ explicit: args.chrome });
    console.error(`Chromium: ${chrome}`);
    const manifest = renderPost({
      post,
      assetsDir: resolve(args.assets),
      outDir: resolve(args.out),
      chrome,
      only: args.only,
      templatesDir: resolve(args.templates),
      log: (line) => console.error(line),
    });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    console.error(`Eroare: ${error.message}`);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) main();
