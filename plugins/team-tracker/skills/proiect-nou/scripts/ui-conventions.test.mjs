import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  contrastRatio,
  generate,
  measureFile,
  parseColor,
  parseTokens,
} from './ui-conventions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'ui-conventions.mjs');
// The real parser lives in the team-tracker app (TypeScript). When the app repo
// and its `tsx` are present we run it for real; the JS port below is the
// fallback so the grammar is still checked on a machine without the app.
const APP_DIR = process.env.TEAM_TRACKER_APP_DIR || 'C:/Users/Laki Edward/Desktop/team-tracker';
const APP_PARSER = join(APP_DIR, 'src', 'lib', 'uiConventions.ts');
const TSX_CLI = join(APP_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const HAS_APP_PARSER = existsSync(APP_PARSER) && existsSync(TSX_CLI);

const STATE_BY_LABEL = { RESPECTATĂ: 'respectata', DERIVĂ: 'deriva', 'FĂRĂ CANONIC': 'fara_canonic' };
const ROW_LABELS = new Set(['canonic', 'plafon', 'blocat', 'folosit', 'măsurat', 'excepție', '→']);

// Line-for-line port of parseUiConventions from src/lib/uiConventions.ts.
function parseLikeApp(markdown) {
  if (typeof markdown !== 'string' || !markdown.includes('# Convenții UI')) return null;
  const conventions = [];
  let current = null;
  let block = [];
  let blocks = [];
  const closeBlock = () => {
    if (block.length) blocks.push(block);
    block = [];
  };
  const closeConvention = () => {
    if (!current) return;
    closeBlock();
    const [rule, ...rest] = blocks;
    current.rule = (rule ?? []).join(' ').replace(/\s+/g, ' ').trim();
    for (const row of rest.flat()) {
      const match = row.match(/^\s*(\S+)\s{2,}(.+?)\s*$/);
      const label = match?.[1] ?? '';
      if (match && ROW_LABELS.has(label)) current.rows.push({ label, value: match[2], extra: [] });
      else if (current.rows.length) current.rows[current.rows.length - 1].extra.push(row.trim());
    }
    conventions.push(current);
    current = null;
    blocks = [];
  };
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      closeConvention();
      const heading = line.slice(3);
      const withState = heading.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
      const stateLabel = withState ? withState[2].trim() : '';
      const [word, ...restLabel] = stateLabel.split(/\s+/);
      const key = STATE_BY_LABEL[stateLabel] ? stateLabel : word;
      current = {
        name: (withState ? withState[1] : heading).trim(),
        state: STATE_BY_LABEL[key] ?? 'necunoscuta',
        stateLabel,
        badge: STATE_BY_LABEL[stateLabel] ? '' : restLabel.join(' '),
        rule: '',
        rows: [],
      };
      continue;
    }
    if (!current) continue;
    if (!line.trim()) {
      closeBlock();
      continue;
    }
    if (/^\s/.test(line)) block.push(line);
  }
  closeConvention();
  if (!conventions.length) return null;
  return {
    conventions,
    respectate: conventions.filter((c) => c.state === 'respectata').length,
    derive: conventions.filter((c) => c.state === 'deriva').length,
    faraCanonic: conventions.filter((c) => c.state === 'fara_canonic').length,
  };
}

function parseWithApp(markdownFile) {
  const dir = mkdtempSync(join(tmpdir(), 'ui-conventions-harness-'));
  try {
    const harness = join(dir, 'harness.ts');
    writeFileSync(harness, [
      "import { readFileSync } from 'node:fs';",
      `import { parseUiConventions } from '${pathToFileURL(APP_PARSER).href}';`,
      "process.stdout.write(JSON.stringify(parseUiConventions(readFileSync(process.argv[2], 'utf8'))));",
      '',
    ].join('\n'));
    const run = spawnSync(process.execPath, [TSX_CLI, harness, markdownFile], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function write(root, path, content) {
  const file = join(root, ...path.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

const TOKENS = [
  ':root {',
  '  --color-bg: #ffffff;',
  '  --color-surface: #f5f5f4;',
  '  --color-text: #1c1917;',
  '  --color-text-muted: #57534e;',
  '  --color-primary: oklch(55% 0.2 260);',
  '  --color-on-primary: var(--color-bg);',
  '  --space-1: 4px;',
  '  --space-2: 8px;',
  '  --space-4: 16px;',
  '  --text-sm: 0.875rem;',
  '  --text-md: 1rem;',
  '  --radius-sm: 4px;',
  '  --radius-md: 8px;',
  '  --shadow-sm: 0 1px 2px rgb(0 0 0 / 0.05);',
  '}',
  '.dark {',
  '  --color-bg: #0c0a09;',
  '  --color-surface: #1c1917;',
  '  --color-text: #fafaf9;',
  '  --color-text-muted: #a8a29e;',
  '}',
  '',
].join('\n');

function freshProject() {
  const root = mkdtempSync(join(tmpdir(), 'ui-conventions-'));
  write(root, 'package.json', '{ "name": "atelier-site", "type": "module" }\n');
  write(root, 'src/styles/tokens.css', TOKENS);
  write(root, 'src/components/ui/Button.tsx', [
    'export function Button({ children }: { children: string }) {',
    '  return <button className="bg-(--color-primary) text-(--color-on-primary) px-(--space-4) rounded-(--radius-md) text-(--text-md)">{children}</button>;',
    '}',
    '',
  ].join('\n'));
  write(root, 'src/pages/index.astro', '---\nconst title = "Acasă";\n---\n<h1 class="text-(--text-md)">{title}</h1>\n');
  return root;
}

test('parseTokens groups custom properties by prefix, through @media and theme blocks', () => {
  const parsed = parseTokens(`${TOKENS}@media (prefers-color-scheme: dark) { :root { --color-extra: #000; } }\n`);
  assert.deepEqual(parsed.groups.color, [
    '--color-bg', '--color-surface', '--color-text', '--color-text-muted',
    '--color-primary', '--color-on-primary', '--color-extra',
  ]);
  assert.deepEqual(parsed.groups.space, ['--space-1', '--space-2', '--space-4']);
  assert.deepEqual(parsed.groups.text, ['--text-sm', '--text-md']);
  assert.deepEqual(parsed.groups.radius, ['--radius-sm', '--radius-md']);
  assert.deepEqual(parsed.groups.shadow, ['--shadow-sm']);
  assert.equal(parsed.blocks[1].selector, '.dark');
  assert.equal(parsed.names.get('--color-on-primary').value, 'var(--color-bg)');
});

test('parseColor and contrastRatio follow WCAG', () => {
  assert.equal(Math.round(contrastRatio(parseColor('#000'), parseColor('#fff')) * 100) / 100, 21);
  assert.equal(Math.round(contrastRatio(parseColor('rgb(255, 255, 255)'), parseColor('hsl(0 0% 0%)'))), 21);
  assert.ok(Math.abs(contrastRatio(parseColor('#767676'), parseColor('white')) - 4.54) < 0.02);
  const white = parseColor('oklch(100% 0 0)');
  assert.ok(white.r > 0.99 && white.g > 0.99 && white.b > 0.99);
  const lookup = (name) => ({ '--a': 'var(--b)', '--b': '#1c1917' })[name];
  assert.deepEqual(parseColor('var(--a)', lookup), parseColor('#1c1917'));
  assert.equal(parseColor('var(--missing, #fff)', lookup).r, 1);
  assert.equal(parseColor('transparent'), null);
  assert.equal(parseColor('url(x)'), null);
});

test('measureFile separates font and radius sizes from spacing and ignores 0px/1px', () => {
  const counts = measureFile([
    '.a { font-size: 14px; padding: 16px 8px; border-radius: 6px 6px 0 0; border: 1px solid; margin: 0px; }',
    'const s = { fontSize: "0.875rem", borderRadius: "4px", gap: 12 };',
    '<div class="text-[13px] rounded-[10px] p-[20px] bg-[#fff] text-[rgb(1,2,3)]" />',
    '@media (min-width: 768px) { .b { gap: 24px; } }',
    '@container card (width > 375px) { .c { inset: 0px; } }',
    '',
  ].join('\n'));
  assert.deepEqual(counts, { color: 2, space: 4, text: 3, radius: 4 }, 'breakpoints are not spacing');
});

test('a fresh project yields five RESPECTATĂ conventions with măsurat 0, parseable by the app', (context) => {
  const root = freshProject();
  try {
    const cli = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stderr, /^ui-conventions: docs\/ui-conventions\.md — 5 convenții · 5 respectate · 0 în derivă · 0 fără canonic/);
    const file = join(root, 'docs', 'ui-conventions.md');
    const markdown = readFileSync(file, 'utf8');
    assert.match(markdown, /^# Convenții UI — atelier-site\n\n<!-- GENERAT de scripts\/ui-conventions\.mjs\. Nu edita de mână\. -->\n/);
    assert.equal((markdown.match(/^## /gm) || []).length, 5);
    assert.equal((markdown.match(/\[RESPECTATĂ\]$/gm) || []).length, 5);
    assert.equal((markdown.match(/^ {4}măsurat {2}0 /gm) || []).length, 5);

    const check = (report) => {
      assert.ok(report);
      assert.equal(report.respectate, 5);
      assert.equal(report.derive, 0);
      assert.equal(report.faraCanonic, 0);
      assert.deepEqual(report.conventions.map((c) => c.name), ['Culori', 'Spațiere', 'Font', 'Raze', 'Contrast']);
      const colours = report.conventions[0];
      assert.equal(colours.state, 'respectata');
      assert.equal(colours.badge, '');
      assert.match(colours.rule, /^Nicio culoare literală în componente; totul prin tokenii --color-\* din src\/styles\/tokens\.css\.$/);
      assert.deepEqual(colours.rows.map((row) => row.label), ['canonic', 'folosit', 'măsurat']);
      assert.equal(colours.rows[0].value, 'src/styles/tokens.css :root — 6 tokeni --color-*');
      assert.deepEqual(colours.rows[0].extra, [
        '--color-bg, --color-surface, --color-text, --color-text-muted,',
        '--color-primary, --color-on-primary',
      ]);
      assert.equal(colours.rows[1].value, '2 din 6 tokeni apar în cod');
      assert.equal(colours.rows[2].value, '0 literale de culoare (hex/rgb/hsl) în 0 fișiere, din 2');
      assert.deepEqual(colours.rows[2].extra, []);
      const contrast = report.conventions[4];
      assert.equal(contrast.state, 'respectata');
      assert.equal(contrast.rows[0].label, 'canonic');
      assert.equal(contrast.rows[0].extra.length, 8, 'four pairs per theme, two themes');
      assert.match(contrast.rows[0].extra[0], /^--color-text \/ --color-bg — 17\.\d\d:1$/);
      assert.match(contrast.rows[0].extra[4], /^--color-text \/ --color-bg — 18\.\d\d:1 \(\.dark\)$/);
      assert.equal(contrast.rows[1].label, 'măsurat');
      assert.equal(contrast.rows[1].value, '0 perechi sub 4,5:1, din 8');
      assert.ok(!contrast.rows.some((row) => row.label === 'excepție'));
      for (const convention of report.conventions) {
        assert.ok(convention.rows.every((row) => ROW_LABELS.has(row.label)));
      }
    };
    check(parseLikeApp(markdown));
    if (!HAS_APP_PARSER) return context.diagnostic('app parser not available: only the JS port was checked');
    check(parseWithApp(file));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('drift is measured from code: DERIVĂ n/m with files, FĂRĂ CANONIC without tokens, excepție for contrast', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'ui-conventions-'));
  try {
    write(root, 'src/styles/tokens.css', [
      ':root {',
      '  --color-bg: #ffffff;',
      '  --color-text: #1c1917;',
      '  --color-text-muted: #999999;',
      '  --color-accent: var(--brand);',
      '  --space-2: 8px;',
      '  --text-md: 1rem;',
      '}',
      '',
    ].join('\n'));
    write(root, 'src/components/Card.tsx', [
      'export function Card() {',
      '  return <div className="bg-[#fff] p-[12px] text-[14px] rounded-[8px]" style={{ color: "rgb(1, 2, 3)", marginTop: "4px" }} />;',
      '}',
      '',
    ].join('\n'));
    write(root, 'src/components/Hero.tsx', 'export const hero = { background: "#ff0000", padding: "24px" };\n');
    write(root, 'src/lib/clean.ts', 'export const url = "https://ok/#anchor";\n');
    const result = generate({ root, name: 'Drift' });
    assert.deepEqual(result.warnings, []);
    const [colours, spacing, font, radius, contrast] = result.conventions;
    assert.equal(colours.state, 'DERIVĂ');
    assert.equal(colours.badge, '2/3');
    assert.equal(colours.rows.find((row) => row.label === 'măsurat').value, '3 literale de culoare (hex/rgb/hsl) în 2 fișiere, din 3');
    const ceiling = colours.rows.find((row) => row.label === 'plafon');
    assert.equal(ceiling.value, '2 fișiere cu literale de culoare (hex/rgb/hsl), din 3 — poate doar scădea');
    assert.deepEqual(ceiling.extra, ['src/components/Card.tsx (2)', 'src/components/Hero.tsx (1)']);
    assert.equal(spacing.state, 'DERIVĂ');
    assert.equal(spacing.rows.find((row) => row.label === 'măsurat').value, '3 distanțe literale în px în 2 fișiere, din 3');
    assert.equal(font.state, 'DERIVĂ');
    assert.equal(font.badge, '1/3');
    assert.equal(radius.state, 'FĂRĂ CANONIC');
    assert.equal(radius.badge, '');
    assert.equal(radius.rows[0].value, '— lipsește —');
    assert.equal(radius.rows[1].label, 'măsurat');
    assert.deepEqual(radius.rows[1].extra, ['src/components/Card.tsx (1)']);
    assert.equal(radius.rows[2].label, '→');
    assert.equal(contrast.state, 'DERIVĂ');
    assert.equal(contrast.badge, '1/2');
    const exception = contrast.rows.find((row) => row.label === 'excepție');
    assert.equal(exception.value, '1 perechi sub prag — de reparat în src/styles/tokens.css');
    assert.deepEqual(exception.extra, ['--color-text-muted / --color-bg — 2.85:1']);
    assert.deepEqual(contrast.rows[0].extra, ['--color-text / --color-bg — 17.49:1']);
    assert.ok(!result.markdown.includes('--brand'), 'unresolved aliases outside text/bg pairs are not reported');

    const file = write(root, 'docs/ui-conventions.md', result.markdown);
    const check = (report) => {
      assert.ok(report);
      assert.equal(report.respectate, 0);
      assert.equal(report.derive, 4);
      assert.equal(report.faraCanonic, 1);
      const parsedColours = report.conventions[0];
      assert.equal(parsedColours.state, 'deriva');
      assert.equal(parsedColours.badge, '2/3');
      assert.deepEqual(parsedColours.rows.map((row) => row.label), ['canonic', 'folosit', 'măsurat', 'plafon']);
      assert.deepEqual(parsedColours.rows[3].extra, ['src/components/Card.tsx (2)', 'src/components/Hero.tsx (1)']);
      const parsedRadius = report.conventions[3];
      assert.equal(parsedRadius.state, 'fara_canonic');
      assert.equal(parsedRadius.rows[0].value, '— lipsește —');
      assert.equal(parsedRadius.rows.at(-1).label, '→');
      const parsedContrast = report.conventions[4];
      assert.equal(parsedContrast.state, 'deriva');
      assert.equal(parsedContrast.badge, '1/2');
      assert.deepEqual(parsedContrast.rows.map((row) => row.label), ['canonic', 'măsurat', 'excepție']);
      assert.deepEqual(parsedContrast.rows[2].extra, ['--color-text-muted / --color-bg — 2.85:1']);
      assert.deepEqual(parsedContrast.rows[1].extra, [], 'the exception does not leak into the row above');
    };
    check(parseLikeApp(result.markdown));
    if (!HAS_APP_PARSER) return context.diagnostic('app parser not available: only the JS port was checked');
    check(parseWithApp(file));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing tokens.css is a warning and every convention is FĂRĂ CANONIC', () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-conventions-'));
  try {
    write(root, 'src/lib/a.ts', 'export {};\n');
    const result = generate({ root });
    assert.deepEqual(result.warnings, ['src/styles/tokens.css lipsește: nimic nu e canonic până nu există']);
    assert.ok(result.conventions.every((convention) => convention.state === 'FĂRĂ CANONIC'));
    const report = parseLikeApp(result.markdown);
    assert.equal(report.faraCanonic, 5);
    const stdout = spawnSync(process.execPath, [SCRIPT, '--root', root, '--stdout'], { encoding: 'utf8' });
    assert.equal(stdout.status, 0);
    assert.equal(stdout.stdout, result.markdown);
    assert.ok(!existsSync(join(root, 'docs', 'ui-conventions.md')), '--stdout does not write the file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
