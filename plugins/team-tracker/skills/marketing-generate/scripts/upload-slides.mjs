#!/usr/bin/env node
// Urcă slide-NN.png dintr-un director în bucket-ul privat Supabase Storage al studioului
// și verifică fiecare obiect cu un GET autentificat. Cheia vine DOAR din SUPABASE_SERVICE_ROLE_KEY
// și nu este niciodată afișată.
//
// Utilizare: node upload-slides.mjs --dir <out> --project 11 --post 12 --version 2
//                                   [--bucket marketing-assets] [--only 3,5]
//   iese cu 2 (înainte de orice apel de rețea) dacă lipsește cheia.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SUPABASE_URL = 'https://ntjzghsbrzkvpkniotaj.supabase.co';
export const DEFAULT_BUCKET = 'marketing-assets';
export const MISSING_KEY_MESSAGE = 'SUPABASE_SERVICE_ROLE_KEY lipsește; nu urc nimic.';
const SLIDE_PNG = /^slide-(\d{2})\.png$/;

export function objectPath(project, post, version, orderIndex) {
  const nn = String(Number(orderIndex) + 1).padStart(2, '0');
  return `${project}/posts/${post}/v${version}/slide-${nn}.png`;
}

export function objectUrl(bucket, path, baseUrl = SUPABASE_URL) {
  return `${baseUrl}/storage/v1/object/${bucket}/${path}`;
}

export function parseOnly(value) {
  if (value === undefined || value === null || value === '') return null;
  const indices = String(value).split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  if (indices.some((n) => !Number.isInteger(n) || n < 0)) throw new Error(`--only invalid: ${value}`);
  return new Set(indices);
}

export function parseArgs(argv) {
  const args = { dir: null, project: null, post: null, version: null, bucket: DEFAULT_BUCKET, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    if (arg === '--dir') args.dir = value;
    else if (arg === '--project') args.project = value;
    else if (arg === '--post') args.post = value;
    else if (arg === '--version') args.version = value;
    else if (arg === '--bucket') args.bucket = value;
    else if (arg === '--only') args.only = parseOnly(value);
    else throw new Error(`argument necunoscut: ${arg}`);
    i += 1;
  }
  if (args.help) return args;
  for (const key of ['dir', 'project', 'post', 'version']) {
    if (args[key] === null || args[key] === undefined || args[key] === '') throw new Error(`lipsește --${key}`);
  }
  for (const key of ['project', 'post', 'version']) {
    if (!/^\d+$/.test(String(args[key]))) throw new Error(`--${key} trebuie să fie un număr întreg`);
  }
  return args;
}

// Toate slide-NN.png din director, sortate după NN; orderIndex este NN-1 (0-based).
export function listSlidePngs(dir) {
  return readdirSync(dir)
    .map((name) => ({ name, match: SLIDE_PNG.exec(name) }))
    .filter(({ match }) => match)
    .map(({ name, match }) => ({ name, file: join(dir, name), orderIndex: Number(match[1]) - 1 }))
    .filter(({ file }) => statSync(file).isFile())
    .sort((a, b) => a.orderIndex - b.orderIndex);
}

function authHeaders(key) {
  return { Authorization: `Bearer ${key}`, apikey: key };
}

async function readBodyText(response) {
  try {
    const text = await response.text();
    return text.slice(0, 300);
  } catch {
    return '';
  }
}

// Urcă și verifică fiecare slide. `fetchImpl` este injectabil ca să poată fi testat fără rețea.
export async function uploadAll(opts, { fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  const { dir, project, post, version, bucket = DEFAULT_BUCKET, only = null, key, baseUrl = SUPABASE_URL } = opts;
  if (!key) {
    const error = new Error(MISSING_KEY_MESSAGE);
    error.exitCode = 2;
    throw error;
  }
  if (typeof fetchImpl !== 'function') throw new Error('fetch indisponibil');

  const slides = listSlidePngs(dir).filter((slide) => !only || only.has(slide.orderIndex));
  if (slides.length === 0) throw new Error(`niciun slide-NN.png de urcat în ${dir}${only ? ' (verifică --only)' : ''}`);

  const uploaded = [];
  for (const slide of slides) {
    const path = objectPath(project, post, version, slide.orderIndex);
    const url = objectUrl(bucket, path, baseUrl);
    const body = readFileSync(slide.file);
    log(`${slide.name} → ${bucket}/${path} (${body.length} B)`);

    const put = await fetchImpl(url, {
      method: 'POST',
      headers: { ...authHeaders(key), 'Content-Type': 'image/png', 'x-upsert': 'true' },
      body,
    });
    if (!put.ok) {
      throw new Error(`${slide.name}: upload eșuat (HTTP ${put.status}) ${await readBodyText(put)}`.trim());
    }

    const check = await fetchImpl(url, { method: 'GET', headers: authHeaders(key) });
    if (check.status !== 200) {
      throw new Error(`${slide.name}: verificarea după upload a eșuat (HTTP ${check.status}) ${await readBodyText(check)}`.trim());
    }
    uploaded.push({ order_index: slide.orderIndex, path, bytes: body.length });
  }
  return { bucket, uploaded };
}

export function isMainModule(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const normalize = (path) => path.replace(/\\/g, '/').toLowerCase();
  return normalize(resolve(argv1)) === normalize(fileURLToPath(metaUrl));
}

const USAGE = `Utilizare: node upload-slides.mjs --dir <out> --project <id> --post <id> --version <n> [--bucket ${DEFAULT_BUCKET}] [--only 3,5]
  Cheia se citește din variabila de mediu SUPABASE_SERVICE_ROLE_KEY (niciodată din argumente).`;

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
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    console.error(MISSING_KEY_MESSAGE);
    process.exit(2);
  }
  try {
    const result = await uploadAll(
      { dir: resolve(args.dir), project: args.project, post: args.post, version: args.version, bucket: args.bucket, only: args.only, key },
      { log: (line) => console.error(line) },
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(`Eroare: ${error.message}`);
    process.exit(error.exitCode ?? 1);
  }
}

if (isMainModule(import.meta.url)) main();
