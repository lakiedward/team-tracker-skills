#!/usr/bin/env node
// Validează un post.json înainte de randare: număr de slide-uri, hashtag-uri, caption,
// layout-uri cunoscute, assets existente, eticheta obligatorie pentru cifrele de mockup.
//
// Utilizare: node validate-post.mjs --post post.json --assets <dir>
//   afișează erorile și iese cu 1, sau afișează "ok" și iese cu 0.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE_LAYOUTS, LAYOUTS, resolveAsset, validateDesign, validateSourceAsset, validateVisualDirection } from './render-slides.mjs';

export const DEFAULT_LIMITS = Object.freeze({ maxSlides: 10, minSlides: 3, maxHashtags: 5, maxCaption: 2200 });
// Cifre care arată a rezultat: „85%”, „+27”, „3x”. Pe site-ul studioului sunt numere din mockup-uri.
const FIGURE_PATTERNS = [/\d+\s?%/, /\+\d/, /\b\d+x\b/i];
// Cuvinte care marchează cifra ca ilustrativă.
const SAMPLE_WORDS = ['sample', 'demo', 'mock', 'illustrative'];

export function hasFigure(text) {
  const value = String(text ?? '');
  return FIGURE_PATTERNS.some((pattern) => pattern.test(value));
}

export function isLabelledSample(...texts) {
  const haystack = texts.map((t) => String(t ?? '').toLowerCase()).join(' ');
  return SAMPLE_WORDS.some((word) => haystack.includes(word));
}

function slideLabel(slide, index) {
  const order = Number.isInteger(slide?.order_index) ? slide.order_index + 1 : `#${index + 1}`;
  return `slide ${order}`;
}

export function validatePost(post, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options };
  const { assetsDir } = options;
  const errors = [];

  if (!post || typeof post !== 'object') return { ok: false, errors: ['post lipsă sau invalid'] };
  try { validateVisualDirection(post.visual_direction, { assetsDir }); } catch (error) { errors.push(error.message); }

  const slides = Array.isArray(post.slides) ? post.slides : [];
  if (!Array.isArray(post.slides)) errors.push('"slides" trebuie să fie un array');
  else if (slides.length < limits.minSlides || slides.length > limits.maxSlides) {
    errors.push(`număr de slide-uri ${slides.length}, permis între ${limits.minSlides} și ${limits.maxSlides}`);
  }

  const hashtags = post.hashtags ?? [];
  if (!Array.isArray(hashtags)) errors.push('"hashtags" trebuie să fie un array de string-uri');
  else {
    if (hashtags.length > limits.maxHashtags) errors.push(`${hashtags.length} hashtag-uri, maxim ${limits.maxHashtags}`);
    for (const tag of hashtags) {
      if (typeof tag !== 'string' || !tag.trim() || /\s/.test(tag.trim())) {
        errors.push(`hashtag invalid (un singur token, fără spații): ${JSON.stringify(tag)}`);
      }
    }
  }

  const caption = typeof post.caption === 'string' ? post.caption : '';
  if (!caption.trim()) errors.push('caption gol');
  else if (caption.length > limits.maxCaption) errors.push(`caption are ${caption.length} caractere, maxim ${limits.maxCaption}`);

  const seenOrder = new Set();
  slides.forEach((slide, index) => {
    const label = slideLabel(slide, index);
    if (!slide || typeof slide !== 'object') {
      errors.push(`${label}: nu este un obiect`);
      return;
    }
    if (!Number.isInteger(slide.order_index) || slide.order_index < 0) errors.push(`${label}: order_index lipsă sau invalid`);
    else if (seenOrder.has(slide.order_index)) errors.push(`${label}: order_index duplicat`);
    else seenOrder.add(slide.order_index);

    if (!String(slide.headline ?? '').trim()) errors.push(`${label}: headline gol`);
    if (!LAYOUTS.includes(slide.layout)) {
      errors.push(`${label}: layout necunoscut "${slide.layout}"; cunoscute: ${LAYOUTS.join(', ')}`);
    }
    try { validateDesign(slide.design, { assetsDir }); validateSourceAsset(slide.source_asset); } catch (error) { errors.push(`${label}: ${error.message}`); }
    if (IMAGE_LAYOUTS.includes(slide.layout) && !slide.asset) errors.push(`${label}: layout-ul cere un asset`);

    if (slide.asset) {
      if (!assetsDir) errors.push(`${label}: are asset "${slide.asset}", dar nu s-a dat assetsDir`);
      else {
        try { resolveAsset(assetsDir, slide.asset); } catch (error) { errors.push(`${label}: ${error.message}`); }
      }
    }

    if (slide.layout === 'stat' && !String(slide.disclaimer ?? '').trim()) {
      errors.push(`${label}: layout-ul "stat" cere un disclaimer ne-gol (ex. "sample output, not client results")`);
    }

    const figureFields = ['headline', 'body', 'stat'].filter((field) => hasFigure(slide[field]));
    if (figureFields.length > 0 && !isLabelledSample(slide.disclaimer, slide.body)) {
      errors.push(
        `${label}: conține o cifră care arată a rezultat (${figureFields.join(', ')}) fără etichetă; `
        + 'cifrele din mockup-uri nu sunt rezultate ale clienților — pune "sample"/"demo"/"mock"/"illustrative" în disclaimer sau în body',
      );
    }
  });

  return { ok: errors.length === 0, errors };
}

export function parseArgs(argv) {
  const args = { post: null, assets: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    if (arg === '--post') args.post = value;
    else if (arg === '--assets') args.assets = value;
    else throw new Error(`argument necunoscut: ${arg}`);
    i += 1;
  }
  if (!args.help && !args.post) throw new Error('lipsește --post');
  return args;
}

export function isMainModule(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const normalize = (path) => path.replace(/\\/g, '/').toLowerCase();
  return normalize(resolve(argv1)) === normalize(fileURLToPath(metaUrl));
}

const USAGE = 'Utilizare: node validate-post.mjs --post post.json [--assets <dir>]';

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
  let post;
  try {
    post = JSON.parse(readFileSync(args.post, 'utf8'));
  } catch (error) {
    console.error(`Eroare: nu pot citi ${args.post}: ${error.message}`);
    process.exit(1);
  }
  const { ok, errors } = validatePost(post, { assetsDir: args.assets ? resolve(args.assets) : undefined });
  if (!ok) {
    for (const line of errors) console.error(`- ${line}`);
    process.exit(1);
  }
  console.log('ok');
}

if (isMainModule(import.meta.url)) main();
