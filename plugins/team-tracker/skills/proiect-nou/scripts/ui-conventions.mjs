#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.astro', '.css']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.astro']);
export const GROUPS = Object.freeze({
  color: '--color-', space: '--space-', text: '--text-', radius: '--radius-', shadow: '--shadow-',
});
const AA_THRESHOLD = 4.5;
const RULE_WIDTH = 76;
const HEX_COLOUR = /(?<![\w&#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const FUNCTION_COLOUR = /\b(?:rgba?|hsla?|oklch|oklab)\(/g;
const PX_VALUE = /(?<![\w.-])(\d+(?:\.\d+)?)px\b/g;
const SIZE_VALUE = /(?<![\w.-])\d*\.?\d+(?:px|rem)\b/g;
const FONT_DECLARATION = /font-size\s*:\s*[^;}]+|fontSize\s*:\s*(?:'[^']*'|"[^"]*"|[^,}]+)|(?<![\w-])text-\[[^\]]*\]/g;
const RADIUS_DECLARATION = /border-radius\s*:\s*[^;}]+|borderRadius\s*:\s*(?:'[^']*'|"[^"]*"|[^,}]+)|(?<![\w-])rounded(?:-[a-z]+)*-\[[^\]]*\]/g;
const QUERY_PRELUDE = /@(?:media|container|supports)\b[^{;]*/g;
const ALLOWED_PX = new Set(['0', '1']);

export function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    src: 'src',
    tokens: 'src/styles/tokens.css',
    out: 'docs/ui-conventions.md',
    name: '',
    stdout: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--stdout') args.stdout = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (['--root', '--src', '--tokens', '--out', '--name'].includes(arg)) {
      args[arg.slice(2)] = argv[index + 1];
      index += 1;
    } else throw new Error(`unknown argument ${arg}`);
  }
  args.root = resolve(args.root);
  return args;
}

function relPath(root, file) {
  return relative(root, file).split(sep).join('/');
}

function walk(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...walk(join(dir, entry.name)));
    } else if (entry.isFile()) files.push(join(dir, entry.name));
  }
  return files.sort();
}

function matchingBrace(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return text.length;
}

function readBlocks(text, blocks) {
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf('{', cursor);
    if (open === -1) break;
    const selector = text.slice(cursor, open).split(/[;}]/).pop().trim();
    const close = matchingBrace(text, open);
    const body = text.slice(open + 1, close);
    if (selector.startsWith('@')) readBlocks(body, blocks);
    else {
      const declarations = body.replace(/[^;{}]*\{[^{}]*\}/g, '');
      const tokens = new Map();
      for (const match of declarations.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) {
        tokens.set(match[1], match[2].trim());
      }
      if (tokens.size > 0) blocks.push({ selector, tokens });
    }
    cursor = close + 1;
  }
}

export function parseTokens(css) {
  const blocks = [];
  readBlocks(css.replace(/\/\*[\s\S]*?\*\//g, ''), blocks);
  const names = new Map();
  for (const block of blocks) {
    for (const [name, value] of block.tokens) {
      if (!names.has(name)) names.set(name, { value, selector: block.selector });
    }
  }
  const groups = {};
  for (const [group, prefix] of Object.entries(GROUPS)) {
    groups[group] = [...names.keys()].filter((name) => name.startsWith(prefix));
  }
  return { blocks, names, groups };
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function srgbToLinear(channel) {
  const c = clamp01(channel);
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function fromSrgb(r, g, b) {
  return { r: srgbToLinear(r), g: srgbToLinear(g), b: srgbToLinear(b) };
}

function hslToSrgb(h, s, l) {
  const hue = (((h % 360) + 360) % 360) / 360;
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)];
}

function oklabToLinear(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: clamp01(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: clamp01(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: clamp01(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

function numbers(inner) {
  return inner.split('/')[0].trim().split(/[\s,]+/).filter(Boolean);
}

function channel255(raw) {
  return raw.endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw) / 255;
}

function percentOrUnit(raw) {
  return raw.endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw);
}

export function parseColor(value, lookup = () => undefined, depth = 0) {
  const raw = String(value || '').trim();
  if (!raw || depth > 8) return null;
  const alias = raw.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/);
  if (alias) {
    const target = lookup(alias[1]);
    return parseColor(target !== undefined ? target : alias[2], lookup, depth + 1);
  }
  const hex = raw.match(/^#([0-9a-fA-F]{3,8})$/);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3 || digits.length === 4) digits = [...digits].map((d) => d + d).join('');
    if (digits.length !== 6 && digits.length !== 8) return null;
    const part = (offset) => parseInt(digits.slice(offset, offset + 2), 16) / 255;
    return fromSrgb(part(0), part(2), part(4));
  }
  const fn = raw.match(/^(rgba?|hsla?|oklch|oklab)\(([^)]*)\)$/i);
  if (fn) {
    const kind = fn[1].toLowerCase();
    const parts = numbers(fn[2]);
    if (parts.length < 3 || parts.some((part) => Number.isNaN(parseFloat(part)))) return null;
    if (kind.startsWith('rgb')) return fromSrgb(channel255(parts[0]), channel255(parts[1]), channel255(parts[2]));
    if (kind.startsWith('hsl')) {
      const [r, g, b] = hslToSrgb(parseFloat(parts[0]), percentOrUnit(parts[1]), percentOrUnit(parts[2]));
      return fromSrgb(r, g, b);
    }
    const L = percentOrUnit(parts[0]);
    if (kind === 'oklab') return oklabToLinear(L, parseFloat(parts[1]), parseFloat(parts[2]));
    const C = parts[1].endsWith('%') ? parseFloat(parts[1]) / 100 * 0.4 : parseFloat(parts[1]);
    const H = (parseFloat(parts[2]) * Math.PI) / 180;
    return oklabToLinear(L, C * Math.cos(H), C * Math.sin(H));
  }
  const named = { white: [1, 1, 1], black: [0, 0, 0] }[raw.toLowerCase()];
  return named ? fromSrgb(...named) : null;
}

export function relativeLuminance(color) {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

export function contrastRatio(foreground, background) {
  const light = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const dark = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (light + 0.05) / (dark + 0.05);
}

function themes(parsed) {
  if (parsed.blocks.length === 0) return [];
  const base = new Map(parsed.blocks[0].tokens);
  const list = [{ selector: parsed.blocks[0].selector, tokens: base, variant: false }];
  for (const block of parsed.blocks.slice(1)) {
    if (![...block.tokens.keys()].some((name) => name.startsWith(GROUPS.color))) continue;
    list.push({ selector: block.selector, tokens: new Map([...base, ...block.tokens]), variant: true });
  }
  return list;
}

export function contrastPairs(parsed) {
  const pairs = [];
  const unparseable = new Set();
  for (const theme of themes(parsed)) {
    const lookup = (name) => theme.tokens.get(name);
    const resolve = (name) => {
      const color = parseColor(theme.tokens.get(name), lookup);
      if (!color) unparseable.add(name);
      return color;
    };
    const textTokens = [...theme.tokens.keys()].filter((name) => name.startsWith('--color-text'));
    const backgrounds = [...theme.tokens.keys()].filter((name) => /^--color-(?:bg|surface)/.test(name));
    for (const text of textTokens) {
      const foreground = resolve(text);
      for (const background of backgrounds) {
        const back = resolve(background);
        if (!foreground || !back) continue;
        const ratio = Math.round(contrastRatio(foreground, back) * 100) / 100;
        pairs.push({ text, background, ratio, theme: theme.variant ? theme.selector : '' });
      }
    }
  }
  return { pairs, unparseable: [...unparseable] };
}

function ranges(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => [match.index, match.index + match[0].length]);
}

function inside(index, spans) {
  return spans.some(([start, end]) => index >= start && index < end);
}

export function measureFile(text) {
  const fontSpans = ranges(text, FONT_DECLARATION);
  const radiusSpans = ranges(text, RADIUS_DECLARATION);
  const querySpans = ranges(text, QUERY_PRELUDE);
  const countWithin = (spans) => spans.reduce((sum, [start, end]) => sum + (text.slice(start, end).match(SIZE_VALUE) || []).length, 0);
  let space = 0;
  for (const match of text.matchAll(PX_VALUE)) {
    if (ALLOWED_PX.has(match[1])) continue;
    if (inside(match.index, fontSpans) || inside(match.index, radiusSpans) || inside(match.index, querySpans)) continue;
    space += 1;
  }
  return {
    color: (text.match(HEX_COLOUR) || []).length + (text.match(FUNCTION_COLOUR) || []).length,
    space,
    text: countWithin(fontSpans),
    radius: countWithin(radiusSpans),
  };
}

export function scanSources(root, srcDir, tokensFile) {
  return walk(srcDir)
    .filter((file) => SOURCE_EXTENSIONS.has(extname(file)) && resolve(file) !== resolve(tokensFile))
    .map((file) => ({ path: relPath(root, file), text: readFileSync(file, 'utf8') }));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function measureProject(parsed, sources) {
  const measures = {};
  for (const group of Object.keys(GROUPS)) {
    measures[group] = { literals: 0, files: new Map(), used: 0, scanned: sources.length };
  }
  const usage = new Map([...parsed.names.keys()].map((name) => [name, new RegExp(`${escapeRegExp(name)}(?![\\w-])`)]));
  const seen = new Set();
  for (const source of sources) {
    const counts = measureFile(source.text);
    for (const [group, count] of Object.entries(counts)) {
      if (count === 0) continue;
      measures[group].literals += count;
      measures[group].files.set(source.path, count);
    }
    for (const [name, pattern] of usage) {
      if (!seen.has(name) && pattern.test(source.text)) seen.add(name);
    }
  }
  for (const [group, prefix] of Object.entries(GROUPS)) {
    measures[group].used = [...seen].filter((name) => name.startsWith(prefix)).length;
  }
  return measures;
}

function wrap(text, width) {
  const lines = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    if (current && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else current = current ? `${current} ${word}` : word;
  }
  if (current) lines.push(current);
  return lines;
}

function listLines(items, width) {
  return wrap(items.join(', '), width);
}

function fileLines(files) {
  return [...files.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([path, count]) => `${path} (${count})`);
}

function tokenConvention({ name, rule, group, unit, tokensPath, tokens, measure }) {
  const prefix = GROUPS[group];
  const total = tokens.length;
  const filesWithLiterals = measure.files.size;
  const measured = `${measure.literals} ${unit} în ${filesWithLiterals} fișiere, din ${measure.scanned}`;
  if (total === 0) {
    return {
      name,
      state: 'FĂRĂ CANONIC',
      badge: '',
      rule,
      rows: [
        { label: 'canonic', value: '— lipsește —', extra: [] },
        { label: 'măsurat', value: measured, extra: fileLines(measure.files) },
        { label: '→', value: `definește tokeni ${prefix}* în ${tokensPath}; până atunci nimic nu e canonic.`, extra: [] },
      ],
    };
  }
  const rows = [
    { label: 'canonic', value: `${tokensPath} :root — ${total} tokeni ${prefix}*`, extra: listLines(tokens, 64) },
    { label: 'folosit', value: `${measure.used} din ${total} tokeni apar în cod`, extra: [] },
    { label: 'măsurat', value: measured, extra: [] },
  ];
  if (measure.literals === 0) return { name, state: 'RESPECTATĂ', badge: '', rule, rows };
  rows.push({
    label: 'plafon',
    value: `${filesWithLiterals} fișiere cu ${unit}, din ${measure.scanned} — poate doar scădea`,
    extra: fileLines(measure.files),
  });
  return { name, state: 'DERIVĂ', badge: `${filesWithLiterals}/${measure.scanned}`, rule, rows };
}

function pairLine(pair) {
  const suffix = pair.theme ? ` (${pair.theme})` : '';
  return `${pair.text} / ${pair.background} — ${pair.ratio.toFixed(2)}:1${suffix}`;
}

function contrastConvention(tokensPath, parsed) {
  const rule = 'Orice pereche --color-text* / --color-bg*, --color-surface* trece pragul AA: ≥ 4,5:1.';
  const { pairs, unparseable } = contrastPairs(parsed);
  const name = 'Contrast';
  const note = unparseable.length
    ? [{ label: '→', value: `${unparseable.length} tokeni cu valori neconvertibile în sRGB (${unparseable.join(', ')}): perechile lor nu se măsoară.`, extra: [] }]
    : [];
  if (pairs.length === 0) {
    return {
      name,
      state: 'FĂRĂ CANONIC',
      badge: '',
      rule,
      rows: [
        { label: 'canonic', value: '— lipsește —', extra: [] },
        { label: 'măsurat', value: '0 perechi de măsurat', extra: [] },
        { label: '→', value: `definește --color-text* și --color-bg* / --color-surface* în ${tokensPath}; până atunci nu e nimic de măsurat.`, extra: [] },
        ...note,
      ],
    };
  }
  const failing = pairs.filter((pair) => pair.ratio < AA_THRESHOLD);
  const passing = pairs.filter((pair) => pair.ratio >= AA_THRESHOLD);
  const rows = [
    { label: 'canonic', value: `${tokensPath} — perechile --color-text* / --color-bg*, --color-surface*`, extra: passing.map(pairLine) },
    { label: 'măsurat', value: `${failing.length} perechi sub 4,5:1, din ${pairs.length}`, extra: [] },
  ];
  if (failing.length > 0) {
    rows.push({ label: 'excepție', value: `${failing.length} perechi sub prag — de reparat în ${tokensPath}`, extra: failing.map(pairLine) });
  }
  rows.push(...note);
  if (failing.length === 0) return { name, state: 'RESPECTATĂ', badge: '', rule, rows };
  return { name, state: 'DERIVĂ', badge: `${failing.length}/${pairs.length}`, rule, rows };
}

export function buildConventions({ parsed, measures, tokensPath }) {
  const shared = { tokensPath };
  return [
    tokenConvention({
      ...shared, name: 'Culori', group: 'color', unit: 'literale de culoare (hex/rgb/hsl)',
      rule: `Nicio culoare literală în componente; totul prin tokenii --color-* din ${tokensPath}.`,
      tokens: parsed.groups.color, measure: measures.color,
    }),
    tokenConvention({
      ...shared, name: 'Spațiere', group: 'space', unit: 'distanțe literale în px',
      rule: 'Nicio distanță literală în px; spațierea vine din tokenii --space-* (0px și 1px rămân permise pentru borduri).',
      tokens: parsed.groups.space, measure: measures.space,
    }),
    tokenConvention({
      ...shared, name: 'Font', group: 'text', unit: 'mărimi de text literale (px/rem)',
      rule: 'Mărimile de text vin din tokenii --text-*; niciun font-size literal în px sau rem.',
      tokens: parsed.groups.text, measure: measures.text,
    }),
    tokenConvention({
      ...shared, name: 'Raze', group: 'radius', unit: 'raze literale (px/rem)',
      rule: 'Colțurile rotunjite vin din tokenii --radius-*; niciun border-radius literal.',
      tokens: parsed.groups.radius, measure: measures.radius,
    }),
    contrastConvention(tokensPath, parsed),
  ];
}

function renderConvention(convention) {
  const width = Math.max(...convention.rows.map((row) => [...row.label].length));
  const indent = ' '.repeat(4 + width + 2);
  const header = `## ${convention.name}  [${convention.state}${convention.badge ? ` ${convention.badge}` : ''}]`;
  const lines = [header, '', ...wrap(convention.rule, RULE_WIDTH).map((line) => `    ${line}`), ''];
  for (const row of convention.rows) {
    const pad = ' '.repeat(width - [...row.label].length);
    lines.push(`    ${row.label}${pad}  ${row.value}`);
    for (const extra of row.extra) lines.push(`${indent}${extra}`);
  }
  return lines.join('\n');
}

export function renderReport(name, conventions) {
  const count = (state) => conventions.filter((convention) => convention.state === state).length;
  const summary = `${conventions.length} convenții · ${count('RESPECTATĂ')} respectate · ${count('DERIVĂ')} în derivă · ${count('FĂRĂ CANONIC')} fără canonic`;
  return [
    `# Convenții UI — ${name}`,
    '',
    '<!-- GENERAT de scripts/ui-conventions.mjs. Nu edita de mână. -->',
    '',
    'Citește-l înainte de a scrie criteriile unei secțiuni noi.',
    '',
    summary,
    '',
    ...conventions.map((convention) => `${renderConvention(convention)}\n`),
  ].join('\n');
}

function projectName(root, explicit) {
  if (explicit) return explicit;
  const packageFile = join(root, 'package.json');
  if (existsSync(packageFile)) {
    try {
      const name = JSON.parse(readFileSync(packageFile, 'utf8')).name;
      if (typeof name === 'string' && name.trim()) return name.trim();
    } catch {
      return basename(root);
    }
  }
  return basename(root);
}

export function generate(options) {
  const root = resolve(options.root || process.cwd());
  const srcDir = resolve(root, options.src || 'src');
  const tokensFile = resolve(root, options.tokens || 'src/styles/tokens.css');
  const tokensPath = relPath(root, tokensFile);
  const warnings = [];
  let css = '';
  if (existsSync(tokensFile)) css = readFileSync(tokensFile, 'utf8');
  else warnings.push(`${tokensPath} lipsește: nimic nu e canonic până nu există`);
  const parsed = parseTokens(css);
  const sources = scanSources(root, srcDir, tokensFile);
  const measures = measureProject(parsed, sources);
  const conventions = buildConventions({ parsed, measures, tokensPath });
  const markdown = renderReport(projectName(root, options.name), conventions);
  return { markdown, conventions, warnings, sources: sources.length };
}

function usage() {
  return 'Usage: ui-conventions.mjs [--root <dir>] [--src src] [--tokens src/styles/tokens.css]\n'
    + '                          [--out docs/ui-conventions.md] [--name <proiect>] [--stdout]\n';
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`ui-conventions: ${error.message}\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  const result = generate(args);
  for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
  if (args.stdout) {
    process.stdout.write(result.markdown);
    return;
  }
  const outFile = resolve(args.root, args.out);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, result.markdown);
  const summary = result.markdown.split('\n').find((line) => /^\d+ convenții/.test(line));
  process.stderr.write(`ui-conventions: ${relPath(args.root, outFile)} — ${summary} (${result.sources} fișiere scanate)\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
