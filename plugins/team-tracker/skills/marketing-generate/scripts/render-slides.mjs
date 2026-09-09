#!/usr/bin/env node
// Randează slide-urile unui carusel Instagram (1080×1350, 4:5) din șabloanele HTML
// ale studioului, cu Chromium headless. Fără dependențe npm; doar Node 22.
//
// Utilizare:
//   node render-slides.mjs --post <post.json> --assets <dir> --out <dir>
//                          [--chrome <exe>] [--only 3,5] [--templates <dir>]
//
// Manifestul JSON ajunge pe stdout; mesajele de progres pe stderr.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LAYOUTS = Object.freeze([
  'cover', 'statement', 'screenshot_phone', 'screenshot_desktop', 'split', 'diagram', 'stat', 'cta', 'compose',
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

// Check both lexical paths and real paths: a symlink must not escape the asset snapshot.
export function resolveAsset(assetsDir, asset) {
  if (!assetsDir || typeof asset !== 'string' || !asset || isAbsolute(asset)
    || /^[a-z]:|^[\\/]|[\x00-\x1f]/i.test(asset) || asset.split(/[\\/]/).includes('..')) {
    throw new Error('asset trebuie să fie o cale relativă sigură în assetsDir');
  }
  const root = realpathSync(assetsDir);
  const candidate = resolve(root, asset);
  if (!existsSync(candidate) || !statSync(candidate).isFile()) throw new Error(`asset inexistent: ${asset}`);
  const actual = realpathSync(candidate);
  const rel = relative(root, actual);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`asset în afara assetsDir: ${asset}`);
  return actual;
}

const DESIGN_ENUMS = {
  align: ['left', 'center'], image_fit: ['contain', 'cover'], image_position: ['top', 'center', 'bottom'],
  frame: ['none', 'phone', 'browser'], layout_variant: ['stack', 'split', 'full'],
};
const DESIGN_NUMBERS = { headline_size: [36, 120], body_size: [22, 42], image_scale: [0.25, 1], background_opacity: [0, 1], margin: [48, 140], gap: [16, 96] };
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: obiect necesar`);
}
function color(value, label) {
  if (typeof value !== 'string') throw new Error(`${label}: culoare invalidă`);
  if (/^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(value)) return;
  const match = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0?(?:\.\d+)|0|1(?:\.0+)?))?\s*\)$/.exec(value);
  if (!match || match.slice(1, 4).some((v) => Number(v) > 255) || (value.startsWith('rgba') && match[4] === undefined)) {
    throw new Error(`${label}: culoare hex/rgb/rgba invalidă`);
  }
}
export function validateTheme(theme, { assetsDir } = {}) {
  object(theme, 'theme');
  const known = ['name', 'background', 'text', 'muted', 'accent', 'fonts', 'background_asset'];
  for (const key of Object.keys(theme)) if (!known.includes(key)) throw new Error(`theme.${key}: câmp necunoscut`);
  for (const key of ['background', 'text', 'muted', 'accent']) if (theme[key] !== undefined) color(theme[key], `theme.${key}`);
  if (theme.name !== undefined && (typeof theme.name !== 'string' || theme.name.length > 200)) throw new Error('theme.name invalid');
  if (theme.fonts !== undefined) {
    object(theme.fonts, 'theme.fonts');
    for (const [key, value] of Object.entries(theme.fonts)) {
      if (!['display', 'body', 'serif', 'mono'].includes(key) || typeof value !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,79}$/u.test(value)) {
        throw new Error(`theme.fonts.${key}: nume de font invalid`);
      }
    }
  }
  if (theme.background_asset !== undefined && theme.background_asset !== null) resolveAsset(assetsDir, theme.background_asset);
}
export function validateDesign(design, options = {}) {
  if (design === undefined) return;
  object(design, 'design');
  for (const [key, value] of Object.entries(design)) {
    if (key === 'theme') validateTheme(value, options);
    else if (Object.hasOwn(DESIGN_ENUMS, key)) {
      if (!DESIGN_ENUMS[key].includes(value)) throw new Error(`design.${key}: valoare invalidă`);
    } else if (Object.hasOwn(DESIGN_NUMBERS, key)) {
      const [min, max] = DESIGN_NUMBERS[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`design.${key}: permis ${min}–${max}`);
    } else throw new Error(`design.${key}: câmp necunoscut`);
  }
}
export function validateVisualDirection(direction, options = {}) {
  if (direction === undefined || direction === null) return;
  object(direction, 'visual_direction');
  if (direction.schema_version !== 1) throw new Error('visual_direction.schema_version trebuie să fie 1');
  if (direction.theme !== undefined) validateTheme(direction.theme, options);
  validateDesign(direction.composition, options);
}
export function validateSourceAsset(source) {
  if (source === undefined || source === null) return;
  object(source, 'source_asset');
  for (const key of ['width', 'height']) {
    if (!Number.isInteger(source[key]) || source[key] < 1 || source[key] > 50000) throw new Error(`source_asset.${key}: dimensiune invalidă`);
  }
  if (source.crop !== undefined && source.crop !== null) {
    object(source.crop, 'source_asset.crop');
    const { x0, y0, x1, y1 } = source.crop;
    if ([x0, y0, x1, y1].some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) || x1 <= x0 || y1 <= y0) {
      throw new Error('source_asset.crop: coordonate normalizate 0..1, x0<x1 și y0<y1');
    }
  }
}

// Native pixel bounds determine display size. Exported and used verbatim by browser readiness.
export function assetGeometry(width, height, crop = { x0: 0, y0: 0, x1: 1, y1: 1 }, maxWidth = 888, maxHeight = 880, fit = 'contain') {
  crop ??= { x0: 0, y0: 0, x1: 1, y1: 1 };
  const x = Math.floor(width * crop.x0), y = Math.floor(height * crop.y0);
  const cropWidth = Math.max(1, Math.ceil(width * crop.x1) - x);
  const cropHeight = Math.max(1, Math.ceil(height * crop.y1) - y);
  const ratio = Math.min(1, fit === 'cover' ? Math.max(maxWidth / cropWidth, maxHeight / cropHeight) : Math.min(maxWidth / cropWidth, maxHeight / cropHeight));
  return { x, y, cropWidth, cropHeight, width: cropWidth * ratio, height: cropHeight * ratio, scale: ratio };
}

function dynamicMarkup(slide, direction, assetsDir) {
  const design = { ...direction?.composition, ...slide.design };
  const theme = { ...direction?.theme, ...direction?.composition?.theme, ...slide.design?.theme,
    fonts: { ...direction?.theme?.fonts, ...direction?.composition?.theme?.fonts, ...slide.design?.theme?.fonts } };
  const css = [];
  for (const [field, variable] of [['background', 'bg'], ['text', 'ink'], ['muted', 'dim'], ['accent', 'accent']]) {
    if (theme[field]) css.push(`--${variable}: ${theme[field]}`);
  }
  for (const [key, value] of Object.entries(theme.fonts)) css.push(`--font-${key}: "${value}", ${key === 'serif' ? 'serif' : key === 'mono' ? 'monospace' : 'sans-serif'}`);
  if (design.margin !== undefined) css.push(`--margin: ${design.margin}px`);
  css.push(`--line: color-mix(in srgb, var(--ink) 16%, transparent)`);
  let styles = `:root {${css.join(';')};}\n`;
  styles += '.project-background {position:absolute;inset:0;width:1080px;height:1350px;object-fit:cover;pointer-events:none;}\n';
  if (design.align) styles += `.slide {text-align:${design.align};} .body {${design.align === 'center' ? 'margin-left:auto;margin-right:auto;' : ''}}\n`;
  if (design.headline_size) styles += `.slide .headline {font-size:${design.headline_size}px;}\n`;
  if (design.body_size) styles += `.slide .body {font-size:${design.body_size}px;}\n`;
  styles += `.dynamic-asset {position:relative;flex:none;display:block;overflow:hidden;margin:auto;max-width:100%;} .dynamic-asset img {display:block;max-width:none;border-radius:0;}\n`;
  styles += '.dynamic-asset.frame-phone {border:8px solid color-mix(in srgb,var(--ink) 12%,var(--bg));border-radius:32px;} .dynamic-asset.frame-browser {border:1px solid var(--line);border-top-width:28px;border-radius:18px;}\n';
  styles += '.slide .stage {align-items:center;} .slide .col-asset {display:flex;align-items:center;justify-content:center;}\n';
  if (slide.layout === 'compose') {
    const variant = design.layout_variant ?? 'stack';
    styles += `.composition {display:flex;flex:1;min-height:0;gap:${design.gap ?? 40}px;flex-direction:${variant === 'split' ? 'row' : 'column'};align-items:${variant === 'split' ? 'center' : 'stretch'};} .composition .copy {${variant === 'split' ? 'width:48%;flex:none;' : 'flex:none;'}} .composition .stage {margin:0;flex:1;min-width:0;min-height:0;}\n`;
    if (variant === 'full') styles += `.composition .copy {text-align:${design.align ?? 'center'};} ${design.headline_size ? '' : '.composition .headline {font-size:80px;}'} .composition .stage {flex:1;}\n`;
  }
  const background = theme.background_asset ? `<img class="project-background" src="${escapeHtml(pathToFileURL(resolveAsset(assetsDir, theme.background_asset)).href)}" alt="" style="opacity:${design.background_opacity ?? 1}">` : '';
  const systemFonts = ['arial', 'georgia', 'times new roman', 'segoe ui', 'helvetica', 'helvetica neue', 'consolas', 'courier new', 'cascadia mono', 'sans-serif', 'serif', 'monospace', 'system-ui'];
  const fontAxes = { 'Bricolage Grotesque': ':wght@400;700', Sora: ':wght@400;600;700', 'Instrument Serif': ':ital@0;1', 'JetBrains Mono': ':wght@400;700' };
  const fonts = [...new Set(Object.values(theme.fonts))].filter(font => !systemFonts.includes(font.toLowerCase()));
  // Do not request unsupported bold axes for single-weight fonts such as Instrument Serif.
  const fontLink = fonts.length ? `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${fonts.map((font) => `family=${encodeURIComponent(font)}${fontAxes[font] ?? ''}`).join('&amp;')}&amp;display=swap">` : '';
  return { styles, background, fontLink, design };
}

function assetMarkup(slide, assetSrc, design) {
  const crop = slide.source_asset?.crop;
  return `<figure class="dynamic-asset frame-${design.frame ?? 'none'}" data-asset data-fit="${design.image_fit ?? 'contain'}" data-position="${design.image_position ?? 'center'}" data-scale="${design.image_scale ?? 1}"${crop ? ` data-crop="${escapeHtml(JSON.stringify(crop))}"` : ''}><img src="${assetSrc}" alt="${escapeHtml(slide.asset_alt ?? '')}"></figure>`;
}

// Kept in the artifact so a human opening the HTML sees the identical crop and sizing.
const READINESS_SCRIPT = `<script>
window.__marketingReady = (async () => {
  await document.fonts.ready;
  await Promise.all([...document.images].map(image => image.decode()));
  const geometry = ${assetGeometry.toString()};
  for (const frame of document.querySelectorAll('[data-asset]')) {
    const img = frame.querySelector('img');
    const sourceWidth = img.naturalWidth, sourceHeight = img.naturalHeight;
    const crop = frame.dataset.crop ? JSON.parse(frame.dataset.crop) : undefined;
    const bounds = frame.parentElement.getBoundingClientRect();
    const availableHeight = Math.min(bounds.height || 880, 880);
    const scale = Number(frame.dataset.scale);
    const fit = frame.dataset.fit;
    const g = geometry(sourceWidth, sourceHeight, crop, Math.max(1, bounds.width - 16) * scale, Math.max(1, availableHeight - 28) * scale, fit);
    if (crop) {
      const canvas = document.createElement('canvas'); canvas.width = g.cropWidth; canvas.height = g.cropHeight;
      canvas.getContext('2d').drawImage(img, g.x, g.y, g.cropWidth, g.cropHeight, 0, 0, g.cropWidth, g.cropHeight);
      img.src = canvas.toDataURL('image/png'); await img.decode();
    }
    const viewWidth = Math.min(g.width, Math.max(1, bounds.width - 16) * scale);
    const viewHeight = Math.min(g.height, Math.max(1, availableHeight - 28) * scale);
    frame.style.width = viewWidth + 'px'; frame.style.height = viewHeight + 'px'; frame.style.boxSizing = 'content-box';
    img.style.width = g.width + 'px'; img.style.height = g.height + 'px';
    img.style.marginLeft = ((viewWidth - g.width) / 2) + 'px';
    img.style.marginTop = ((viewHeight - g.height) * (frame.dataset.position === 'top' ? 0 : frame.dataset.position === 'bottom' ? 1 : .5)) + 'px';
    frame.dataset.nativeWidth = g.cropWidth; frame.dataset.nativeHeight = g.cropHeight; frame.dataset.renderScale = g.scale;
  }
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  document.documentElement.dataset.renderReady = 'true';
})().catch(error => {window.__renderError = error.message; throw error;});
</script>`;

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
export function buildSlideHtml(slide, { templatesDir = DEFAULT_TEMPLATES_DIR, assetsDir, total, visualDirection } = {}) {
  if (!slide || typeof slide !== 'object') throw new Error('slide invalid');
  if (!Number.isInteger(slide.order_index) || slide.order_index < 0) {
    throw new Error(`${slideLabel(slide)}: order_index trebuie să fie un întreg ≥ 0`);
  }
  if (!LAYOUTS.includes(slide.layout)) {
    throw new Error(`${slideLabel(slide)}: layout necunoscut; cunoscute: ${LAYOUTS.join(', ')}`);
  }
  if (!String(slide.headline ?? '').trim()) throw new Error(`${slideLabel(slide)}: headline lipsă`);
  validateVisualDirection(visualDirection, { assetsDir });
  validateDesign(slide.design, { assetsDir });
  validateSourceAsset(slide.source_asset);

  const templatePath = join(templatesDir, 'slides', `${slide.layout}.html`);
  if (!existsSync(templatePath)) throw new Error(`${slideLabel(slide)}: șablon lipsă: ${templatePath}`);
  const template = readFileSync(templatePath, 'utf8');

  let assetSrc = '';
  if (slide.asset) {
    if (!assetsDir) throw new Error(`${slideLabel(slide)}: are asset, dar nu s-a dat directorul de assets (--assets)`);
    assetSrc = escapeHtml(pathToFileURL(resolveAsset(assetsDir, slide.asset)).href);
  } else if (IMAGE_LAYOUTS.includes(slide.layout)) {
    throw new Error(`${slideLabel(slide)}: layout-ul cere un asset (captură de produs), dar "asset" lipsește`);
  }

  const dynamic = Boolean(visualDirection || slide.design || slide.source_asset || slide.layout === 'compose');
  const { styles, background, fontLink, design } = dynamic ? dynamicMarkup(slide, visualDirection, assetsDir) : { styles: '', background: '', fontLink: '', design: {} };
  const values = {
    kicker: escapeHtml(slide.kicker),
    headline: emphasize(slide.headline),
    body: escapeHtml(slide.body).replace(/\r?\n/g, '<br>'),
    meta: escapeHtml(slide.meta),
    n: String(slide.order_index + 1),
    total: String(total ?? slide.order_index + 1),
    accent: normalizeAccent(slide.accent),
    asset_src: assetSrc,
    asset_html: assetSrc ? assetMarkup(slide, assetSrc, design) : '',
    inputs_html: chipsHtml(slide.inputs),
    outputs_html: chipsHtml(slide.outputs),
    stat: escapeHtml(slide.stat),
    disclaimer: escapeHtml(slide.disclaimer),
    cta: escapeHtml(slide.cta),
  };
  let html = fillTemplate(template, values);
  if (dynamic) {
    html = html.replace('</head>', `${fontLink}<style>${styles}</style></head>`).replace('<body>', `<body>${background}`);
    if (assetSrc && slide.layout !== 'compose') {
      html = html.replace(/<div class="phone"><img[^>]*><\/div>/, assetMarkup(slide, assetSrc, design));
      html = html.replace(/<div class="browser">\s*<div class="bar">[\s\S]*?<\/div>\s*<div class="shot"><img[^>]*><\/div>\s*<\/div>/, assetMarkup(slide, assetSrc, design));
    }
  }
  return html.replace('</body>', `${READINESS_SCRIPT}</body>`);
}

export function chromeArgs(htmlPath, pngPath) {
  return [
    '--headless=new',
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--allow-file-access-from-files',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${SLIDE_WIDTH},${SLIDE_HEIGHT}`,
    `--virtual-time-budget=${VIRTUAL_TIME_BUDGET_MS}`,
    `--screenshot=${pngPath}`,
    pathToFileURL(htmlPath).href,
  ];
}

// Capturează un HTML deja scris pe disc; verifică ieșirea, existența și dimensiunile PNG-ului.
export async function captureSlide({ chrome, htmlPath, pngPath, label = 'slide', timeoutMs = 45000 }) {
  const profile = mkdtempSync(join(tmpdir(), 'marketing-chromium-'));
  const child = spawn(chrome, ['--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader', '--allow-file-access-from-files',
    '--hide-scrollbars', '--force-device-scale-factor=1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let socket;
  const pending = new Map();
  const events = new Map();
  let sequence = 0;
  let timer;
  let diagnostics;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: randarea a depășit ${timeoutMs}ms (fonturi, imagini sau Chromium)`)), timeoutMs); });
  try {
    await Promise.race([timeout, (async () => {
      const endpoint = await new Promise((resolveEndpoint, reject) => {
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk);
          const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
          if (match) resolveEndpoint(match[1]);
        });
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`${label}: Chromium a ieșit (${code})`)));
      });
      socket = new WebSocket(endpoint);
      await new Promise((resolveOpen, reject) => { socket.onopen = resolveOpen; socket.onerror = () => reject(new Error(`${label}: conexiunea CDP a eșuat`)); });
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        const item = pending.get(message.id);
        if (item) { pending.delete(message.id); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result); }
        const listener = events.get(`${message.sessionId}:${message.method}`);
        if (listener) { events.delete(`${message.sessionId}:${message.method}`); listener(message.params); }
      };
      socket.onclose = () => { for (const item of pending.values()) item.reject(new Error(`${label}: Chromium deconectat`)); pending.clear(); };
      const call = (method, params = {}, sessionId) => new Promise((resolveCall, reject) => {
        const id = ++sequence; pending.set(id, { resolve: resolveCall, reject });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
      const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
      const page = (method, params) => call(method, params, sessionId);
      await page('Page.enable');
      await page('Emulation.setDeviceMetricsOverride', { width: SLIDE_WIDTH, height: SLIDE_HEIGHT, deviceScaleFactor: 1, mobile: false });
      const loaded = new Promise((done) => events.set(`${sessionId}:Page.loadEventFired`, done));
      const nav = await page('Page.navigate', { url: pathToFileURL(htmlPath).href });
      if (nav.errorText) throw new Error(`${label}: ${nav.errorText}`);
      await loaded;
      const ready = await page('Runtime.evaluate', { expression: `(async () => {
        if (document.readyState !== 'complete') await new Promise(r => addEventListener('load',r,{once:true}));
        if (window.__marketingReady) await window.__marketingReady;
        await document.fonts.ready; await Promise.all([...document.images].map(image => image.decode()));
        if (window.__renderError) throw new Error(window.__renderError);
        const failedFonts = [...document.fonts].filter(font => font.status === 'error');
        if (failedFonts.length) throw new Error('Fonturi indisponibile: ' + failedFonts.map(f => f.family).join(', '));
        const failures = [];
        for (const el of document.querySelectorAll('.headline,.body,.kicker,.meta,.figure,.pill,.chip,.foot')) {
          if (!el.textContent.trim() || getComputedStyle(el).display === 'none') continue;
          const r = el.getBoundingClientRect();
          const range = document.createRange(); range.selectNodeContents(el);
          const textBounds = range.getBoundingClientRect();
          const footer = document.querySelector('.foot')?.getBoundingClientRect();
          // Display fonts often paint outside a tight line-height. That is safe with visible
          // overflow; measure the text itself instead of treating glyph metrics as clipping.
          if (textBounds.left < -1 || textBounds.top < -1 || textBounds.right > 1081 || textBounds.bottom > 1351 || el.scrollWidth > el.clientWidth + 2
            || (footer && !el.matches('.foot') && textBounds.bottom > footer.top - 12)) failures.push(el.className + ' (text ' +
              [textBounds.left,textBounds.top,textBounds.right,textBounds.bottom].map(Math.round).join(',') + '; box ' +
              [r.left,r.top,r.right,r.bottom].map(Math.round).join(',') + '; width ' + el.scrollWidth + '/' + el.clientWidth + ')');
        }
        if (failures.length) throw new Error('Text depășește zona sigură: ' + failures.join(', '));
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        return { ready: true, theme: { background: getComputedStyle(document.body).backgroundColor, text: getComputedStyle(document.body).color,
          accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), headlineSize: document.querySelector('.headline') ? getComputedStyle(document.querySelector('.headline')).fontSize : null },
          assets: [...document.querySelectorAll('[data-asset]')].map(frame => ({ width: frame.querySelector('img').getBoundingClientRect().width,
            height: frame.querySelector('img').getBoundingClientRect().height, nativeWidth: Number(frame.dataset.nativeWidth), nativeHeight: Number(frame.dataset.nativeHeight), scale: Number(frame.dataset.renderScale) })) };
      })()`, awaitPromise: true, returnByValue: true });
      if (ready.exceptionDetails) throw new Error(`${label}: ${ready.exceptionDetails.exception?.description ?? ready.exceptionDetails.text}`);
      if (!ready.result?.value?.ready) throw new Error(`${label}: documentul nu este pregătit`);
      diagnostics = ready.result.value;
      const screenshot = await page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
      writeFileSync(pngPath, Buffer.from(screenshot.data, 'base64'));
    })()]);
  } finally {
    clearTimeout(timer);
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    child.kill();
    await new Promise((done) => { if (child.exitCode !== null) done(); else { const stop = setTimeout(done, 1500); child.once('exit', () => { clearTimeout(stop); done(); }); } });
    // profile is an absolute unique directory created above under the OS temporary directory.
    if (dirname(profile) === resolve(tmpdir()) && basename(profile).startsWith('marketing-chromium-')) {
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows may release Chromium locks later. */ }
    }
  }
  if (!existsSync(pngPath)) throw new Error(`${label}: Chromium nu a scris ${pngPath}`);
  const buffer = readFileSync(pngPath);
  if (buffer.length < MIN_PNG_BYTES) throw new Error(`${label}: PNG suspect de mic (${buffer.length} B)`);
  const { width, height } = pngSize(buffer);
  if (width !== SLIDE_WIDTH || height !== SLIDE_HEIGHT) {
    throw new Error(`${label}: PNG are ${width}×${height}, aștept ${SLIDE_WIDTH}×${SLIDE_HEIGHT}`);
  }
  return { width, height, bytes: buffer.length, diagnostics };
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
export async function renderPost({ post, assetsDir, outDir, chrome, only = null, templatesDir = DEFAULT_TEMPLATES_DIR, log = () => {} }) {
  mkdirSync(outDir, { recursive: true });
  const reviewedPostPath = resolve(outDir, 'reviewed-post.json');
  const reviewedRenderPath = resolve(outDir, 'reviewed-render.json');
  // Starting another render invalidates the completed recipe, including targeted attempts.
  rmSync(reviewedPostPath, { force: true });
  rmSync(reviewedRenderPath, { force: true });
  const slides = post.slides.slice().sort((a, b) => a.order_index - b.order_index);
  const total = slides.length;
  const manifest = { post_id: post.post_id ?? null, version: post.version ?? null, slides: [] };
  for (const slide of slides) {
    if (only && !only.has(slide.order_index)) continue;
    const label = slideLabel(slide);
    const html = buildSlideHtml(slide, { templatesDir, assetsDir, total, visualDirection: post.visual_direction });
    const htmlPath = resolve(outDir, slideFileName(slide.order_index, 'html'));
    const pngPath = resolve(outDir, slideFileName(slide.order_index, 'png'));
    writeFileSync(htmlPath, html, 'utf8');
    log(`${label}: ${basename(htmlPath)} scris, capturez…`);
    const { width, height } = await captureSlide({ chrome, htmlPath, pngPath, label });
    log(`${label}: ${basename(pngPath)} ${width}×${height}`);
    manifest.slides.push({ order_index: slide.order_index, layout: slide.layout, html: htmlPath, png: pngPath, width, height });
  }
  if (manifest.slides.length === 0) throw new Error('niciun slide de randat (verifică --only)');
  if (!only) {
    const hash = (value) => createHash('sha256').update(value).digest('hex');
    const reviewedRender = { schema_version: 1, post_sha256: hash(JSON.stringify(post)),
      slides: manifest.slides.map(slide => ({ order_index: slide.order_index, sha256: hash(readFileSync(slide.png)) })) };
    writeFileSync(reviewedPostPath, `${JSON.stringify(post, null, 2)}\n`, 'utf8');
    writeFileSync(reviewedRenderPath, `${JSON.stringify(reviewedRender, null, 2)}\n`, 'utf8');
  }
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

async function main() {
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
    const manifest = await renderPost({
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
