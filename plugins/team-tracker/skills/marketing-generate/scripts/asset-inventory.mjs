#!/usr/bin/env node
// Inventarul capturilor de produs: pentru fiecare folder-proiect din --assets, fișierele cu
// dimensiuni (citite din antet, fără biblioteci), clasificate phone / desktop / video / other.
//
// Utilizare: node asset-inventory.mjs --assets <dir> [--project betora]

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm']);
export const MIN_CAROUSEL_IMAGES = 4;
// Citim doar începutul fișierului; antetele stau în primii câțiva KB (JPEG poate avea EXIF mai lung).
const HEADER_BYTES = 64 * 1024;

function pngSize(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47 || buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// Parcurge segmentele JPEG până la un marker SOF (C0–CF, fără C4/C8/CC), unde stau înălțimea și lățimea.
function jpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    if (marker === 0xff) { offset += 1; continue; }
    // Markere fără lungime (RSTn, TEM, SOI) — sărim doar cei doi octeți.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { offset += 2; continue; }
    const length = buffer.readUInt16BE(offset + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS fără SOF
    offset += 2 + length;
  }
  return null;
}

// WebP: RIFF....WEBP + primul chunk VP8 (lossy), VP8L (lossless) sau VP8X (extins).
function webpSize(buffer) {
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
    const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
    return { width, height };
  }
  if (chunk === 'VP8L') {
    if (buffer[20] !== 0x2f) return null;
    const b0 = buffer[21];
    const b1 = buffer[22];
    const b2 = buffer[23];
    const b3 = buffer[24];
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | (b1 >> 6));
    return { width, height };
  }
  if (chunk === 'VP8 ') {
    // Frame tag (3 octeți) + start code 9D 01 2A, apoi lățimea și înălțimea pe 14 biți fiecare (LE).
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) return null;
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

// Dimensiunile unei imagini din antet; null dacă formatul nu e recunoscut sau antetul e corupt.
export function imageSize(buffer, ext) {
  const type = String(ext ?? '').toLowerCase().replace(/^\./, '');
  if (type === 'png') return pngSize(buffer);
  if (type === 'jpg' || type === 'jpeg') return jpegSize(buffer);
  if (type === 'webp') return webpSize(buffer);
  return null;
}

// phone = portret, desktop = peisaj; video după extensie; restul (pătrat, necunoscut) = other.
export function classify({ ext, width, height }) {
  const type = String(ext ?? '').toLowerCase();
  const normalized = type.startsWith('.') ? type : `.${type}`;
  if (VIDEO_EXTENSIONS.has(normalized)) return 'video';
  if (!IMAGE_EXTENSIONS.has(normalized)) return 'other';
  if (Number.isFinite(width) && Number.isFinite(height)) {
    if (height > width) return 'phone';
    if (width > height) return 'desktop';
  }
  return 'other';
}

// Numărători pe tip + carousel_ready (cel puțin 4 imagini statice distincte).
export function summarize(files) {
  const counts = { phone: 0, desktop: 0, video: 0, other: 0 };
  const stills = new Set();
  for (const file of files) {
    counts[file.kind] = (counts[file.kind] ?? 0) + 1;
    if (file.kind !== 'video' && Number.isFinite(file.width) && Number.isFinite(file.height)) stills.add(file.rel);
  }
  return { counts, carousel_ready: stills.size >= MIN_CAROUSEL_IMAGES };
}

function readHeader(file) {
  const size = statSync(file).size;
  const buffer = Buffer.alloc(Math.min(size, HEADER_BYTES));
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    closeSync(fd);
  }
  return buffer;
}

export function inventoryFile(assetsDir, rel) {
  const file = join(assetsDir, ...rel.split('/'));
  const ext = extname(rel).toLowerCase();
  const bytes = statSync(file).size;
  let width = null;
  let height = null;
  if (IMAGE_EXTENSIONS.has(ext)) {
    const size = imageSize(readHeader(file), ext);
    if (size) ({ width, height } = size);
  }
  return { rel, bytes, width, height, kind: classify({ ext, width, height }) };
}

// Fiecare subfolder direct din assetsDir este un proiect; fișierele de la rădăcină intră în "_root".
export function inventory(assetsDir, { project = null } = {}) {
  const root = resolve(assetsDir);
  const projects = {};
  const groups = new Map();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      const files = readdirSync(join(root, entry.name), { withFileTypes: true })
        .filter((f) => f.isFile() && !f.name.startsWith('.'))
        .map((f) => `${entry.name}/${f.name}`);
      groups.set(entry.name, files);
    } else if (entry.isFile()) {
      if (!groups.has('_root')) groups.set('_root', []);
      groups.get('_root').push(entry.name);
    }
  }
  if (project && !groups.has(project)) {
    throw new Error(`proiectul "${project}" nu există în ${root}; cunoscute: ${[...groups.keys()].filter((k) => k !== '_root').join(', ')}`);
  }
  for (const [name, rels] of groups) {
    if (project && name !== project) continue;
    const files = rels.sort().map((rel) => inventoryFile(root, rel));
    projects[name] = { files, ...summarize(files) };
  }
  return { projects };
}

export function parseArgs(argv) {
  const args = { assets: null, project: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    if (arg === '--assets') args.assets = value;
    else if (arg === '--project') args.project = value;
    else throw new Error(`argument necunoscut: ${arg}`);
    i += 1;
  }
  if (!args.help && !args.assets) throw new Error('lipsește --assets');
  return args;
}

export function isMainModule(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const normalize = (path) => path.replace(/\\/g, '/').toLowerCase();
  return normalize(resolve(argv1)) === normalize(fileURLToPath(metaUrl));
}

const USAGE = 'Utilizare: node asset-inventory.mjs --assets <dir> [--project betora]';

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
    const result = inventory(args.assets, { project: args.project });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(`Eroare: ${error.message}`);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) main();
