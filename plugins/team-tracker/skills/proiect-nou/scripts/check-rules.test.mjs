import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, runChecks, splitAstro, tsCommentRanges } from './check-rules.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'check-rules.mjs');
// The generated project resolves `typescript` from its own node_modules; here we
// borrow the team-tracker app's copy (override with TEAM_TRACKER_APP_DIR).
const APP_DIR = process.env.TEAM_TRACKER_APP_DIR || 'C:/Users/Laki Edward/Desktop/team-tracker';
const TYPESCRIPT_DIR = join(APP_DIR, 'node_modules', 'typescript');
const HAS_TYPESCRIPT = existsSync(join(TYPESCRIPT_DIR, 'package.json'));

function write(root, path, content) {
  const file = join(root, ...path.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'check-rules-'));
  write(root, 'package.json', '{ "name": "fixture", "type": "module", "private": true }\n');
  write(root, 'CLAUDE.md', '# Fixture\n\nReguli.\n');
  write(root, 'AGENTS.md', '# Fixture\n\nReguli.\n');
  write(root, 'src/styles/tokens.css', ':root {\n  --color-bg: #ffffff;\n  --space-4: 16px;\n}\n');
  write(root, 'src/components/ui/Button.tsx', [
    'import type { ReactNode } from "react";',
    'export function Button({ children }: { children: ReactNode }) {',
    '  return <button className="bg-[var(--color-bg)] border-[1px] p-0px">{children}</button>;',
    '}',
    '',
  ].join('\n'));
  write(root, 'src/lib/api.ts', 'export const BASE_URL = "https://api.example.com/v1";\nexport const px = 16;\n');
  return root;
}

function run(root, args = [], env = {}) {
  const spawnEnv = { ...process.env, ...env };
  if (HAS_TYPESCRIPT && !('CHECK_RULES_TYPESCRIPT' in env)) spawnEnv.CHECK_RULES_TYPESCRIPT = TYPESCRIPT_DIR;
  return spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8', env: spawnEnv });
}

function lines(output) {
  return output.split(/\r?\n/).filter(Boolean);
}

test('parseArgs applies defaults and rejects unknown checks', () => {
  const args = parseArgs([]);
  assert.equal(args.src, 'src');
  assert.equal(args.maxLines, 600);
  assert.equal(args.maxFiles, 20);
  assert.equal(args.tokens, 'src/styles/tokens.css');
  const custom = parseArgs(['--max-lines', '10', '--skip', 'duplication,docs-mirror', '--src', 'app']);
  assert.equal(custom.maxLines, 10);
  assert.deepEqual([...custom.skip], ['duplication', 'docs-mirror']);
  assert.equal(custom.src, 'app');
  assert.throws(() => parseArgs(['--skip', 'nope']), /unknown check "nope"/);
  assert.throws(() => parseArgs(['--max-lines', 'x']), /--max-lines/);
});

test('splitAstro separates frontmatter from template with the right template line', () => {
  const split = splitAstro('---\nconst a = 1;\nconst b = 2;\n---\n<div>{a}</div>\n');
  assert.equal(split.frontmatter, 'const a = 1;\nconst b = 2;');
  assert.equal(split.template, '<div>{a}</div>\n');
  assert.equal(split.templateLine, 5);
  const plain = splitAstro('<div />\n');
  assert.equal(plain.frontmatter, '');
  assert.equal(plain.templateLine, 1);
});

test('clean project exits 0 with no findings and only the jscpd warning', (context) => {
  if (!HAS_TYPESCRIPT) return context.skip('typescript not found in the app repo');
  const root = makeProject();
  try {
    const result = run(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^warning: duplication: jscpd is not installed/m);
    assert.match(result.stderr, /check:rules: clean \(\d+ files\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the copied tooling scripts pass their own rules', (context) => {
  if (!HAS_TYPESCRIPT) return context.skip('typescript not found in the app repo');
  const root = makeProject();
  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(SCRIPT, join(root, 'scripts', 'check-rules.mjs'));
    const conventions = join(HERE, 'ui-conventions.mjs');
    if (existsSync(conventions)) copyFileSync(conventions, join(root, 'scripts', 'ui-conventions.mjs'));
    const result = run(root, ['--skip', 'duplication']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('comments are found by the TypeScript parser, not by regex', async (context) => {
  if (!HAS_TYPESCRIPT) return context.skip('typescript not found in the app repo');
  const typescript = (await import(pathToFileURL(join(TYPESCRIPT_DIR, 'lib', 'typescript.js')).href)).default;
  const text = [
    '#!/usr/bin/env node',
    '/// <reference types="vite/client" />',
    'const url = "https://example.com"; // trailing',
    '/* block */',
    '/** doc */',
    'export function A() {',
    '  return <a href="https://x.y">Visit https://x.y and don\'t {/* jsx */} stop</a>;',
    '}',
    'const tpl = `a // b`;',
    'const rx = /\\/\\//;',
    '',
  ].join('\n');
  const ranges = tsCommentRanges(typescript, text, typescript.ScriptKind.TSX);
  assert.deepEqual(
    ranges.map((range) => text.slice(range.pos, range.end)),
    ['// trailing', '/* block */', '/** doc */', '/* jsx */'],
  );
});

test('offending project lists one finding per line and exits 1', (context) => {
  if (!HAS_TYPESCRIPT) return context.skip('typescript not found in the app repo');
  const root = makeProject();
  try {
    write(root, 'src/lib/long.ts', `${'export const x = 1;\n'.repeat(12)}`);
    write(root, 'src/lib/commented.ts', [
      'const url = "https://ok";',
      '// explain',
      'export const a = url; /* inline */',
      '/** doc */',
      'export const b = 2;',
      '',
    ].join('\n'));
    write(root, 'src/components/Card.tsx', [
      'export function Card() {',
      '  return <div className="bg-[#fff] p-[12px] rounded-[0px]" style={{ color: "rgb(1, 2, 3)", border: "1px solid" }}>{/* jsx */}Say https://a.b</div>;',
      '}',
      '',
    ].join('\n'));
    write(root, 'src/pages/index.astro', [
      '---',
      'const title = "x"; // frontmatter',
      '---',
      '<!-- html -->',
      '<h1 class="text-[18px]">{title}</h1>',
      '{/* template */}',
      '<style>',
      '  /* css */',
      '  h1 { color: #123456; }',
      '  @media (min-width: 768px) { h1 { margin: 24px; } }',
      '</style>',
      '',
    ].join('\n'));
    write(root, 'src/styles/extra.css', '.a { color: red; }\n/* note */\n.b { margin: 4px; }\n');
    write(root, 'scripts/tool.mjs', '#!/usr/bin/env node\n// tool\nconsole.log(1);\n');
    write(root, 'tests/smoke.test.ts', '// smoke\nexport {};\n');
    for (let index = 0; index < 4; index += 1) write(root, `src/many/f${index}.ts`, 'export {};\n');
    write(root, 'AGENTS.md', '# Fixture\n\nAltceva.\n');
    const result = run(root, ['--max-lines', '10', '--max-files', '3']);
    assert.equal(result.status, 1, result.stderr);
    const out = lines(result.stdout);
    for (const line of out) assert.match(line, /^[^:]+:\d+: [a-z-]+: /, `finding shape: ${line}`);
    const has = (fragment) => assert.ok(out.some((line) => line.includes(fragment)), `expected finding containing ${fragment}\n${out.join('\n')}`);
    const not = (fragment) => assert.ok(!out.some((line) => line.includes(fragment)), `unexpected finding containing ${fragment}\n${out.join('\n')}`);
    has('src/lib/long.ts:11: max-lines: 12 lines (max 10)');
    has('src/lib/commented.ts:2: no-comments: comment is not allowed ("// explain")');
    has('src/lib/commented.ts:3: no-comments: comment is not allowed ("/* inline */")');
    has('src/lib/commented.ts:4: no-comments: comment is not allowed ("/** doc */")');
    not('src/lib/commented.ts:1:');
    not('src/lib/api.ts');
    has('src/components/Card.tsx:2: no-comments: comment is not allowed ("/* jsx */")');
    assert.equal(out.filter((line) => line.startsWith('src/components/Card.tsx:2: no-comments')).length, 1, 'JSX text URL is not a comment');
    has('src/pages/index.astro:2: no-comments: comment is not allowed ("// frontmatter")');
    has('src/pages/index.astro:4: no-comments: comment is not allowed ("<!-- html -->")');
    has('src/pages/index.astro:6: no-comments: comment is not allowed ("{/* template */}")');
    has('src/pages/index.astro:8: no-comments: comment is not allowed ("/* css */")');
    has('src/styles/extra.css:2: no-comments: comment is not allowed ("/* note */")');
    has('scripts/tool.mjs:2: no-comments: comment is not allowed ("// tool")');
    not('scripts/tool.mjs:1:');
    has('tests/smoke.test.ts:1: no-comments');
    has('src/many/:1: max-files: 4 files in folder (max 3)');
    has('AGENTS.md:3: docs-mirror: AGENTS.md differs from CLAUDE.md (first difference at line 3)');
    has('src/components/Card.tsx:2: tokens-only: literal colour "#fff"');
    has('src/components/Card.tsx:2: tokens-only: literal colour "rgb(…)"');
    has('src/components/Card.tsx:2: tokens-only: literal size "12px"');
    not('literal size "0px"');
    not('literal size "1px"');
    has('src/pages/index.astro:5: tokens-only: literal size "18px"');
    has('src/pages/index.astro:9: tokens-only: literal colour "#123456"');
    has('src/pages/index.astro:10: tokens-only: literal size "24px"');
    not('literal size "768px"');
    not('src/styles/tokens.css');
    not('src/styles/extra.css:3: tokens-only');
    not('src/lib/api.ts:2');
    assert.match(result.stderr, /check:rules: \d+ finding\(s\)/);

    const skipped = run(root, ['--max-lines', '10', '--max-files', '3', '--skip', 'no-comments,tokens-only,max-lines,max-files,docs-mirror,duplication']);
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.equal(skipped.stdout, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing typescript in the target repo is a clear exit 2', () => {
  const root = makeProject();
  try {
    const result = run(root, [], { CHECK_RULES_TYPESCRIPT: '' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /cannot resolve "typescript" from /);
    assert.match(result.stderr, /CHECK_RULES_TYPESCRIPT/);
    const skipped = run(root, ['--skip', 'no-comments,duplication'], { CHECK_RULES_TYPESCRIPT: '' });
    assert.equal(skipped.status, 0, skipped.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('typescript resolves from the target repo node_modules (junction)', (context) => {
  if (!HAS_TYPESCRIPT) return context.skip('typescript not found in the app repo');
  const root = makeProject();
  try {
    mkdirSync(join(root, 'node_modules'));
    try {
      symlinkSync(TYPESCRIPT_DIR, join(root, 'node_modules', 'typescript'), 'junction');
    } catch (error) {
      return context.skip(`cannot create junction: ${error.message}`);
    }
    write(root, 'src/lib/c.ts', '// hello\nexport {};\n');
    const result = run(root, ['--skip', 'duplication'], { CHECK_RULES_TYPESCRIPT: '' });
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(lines(result.stdout), ['src/lib/c.ts:1: no-comments: comment is not allowed ("// hello")']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('duplication uses jscpd when installed and parses its JSON report', () => {
  const root = makeProject();
  try {
    write(root, 'node_modules/jscpd/bin/jscpd.js', [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const out = process.argv[process.argv.indexOf("--output") + 1];',
      'fs.mkdirSync(out, { recursive: true });',
      'const clone = { format: "typescript", lines: 9, tokens: 70,',
      '  firstFile: { name: "src/lib/a.ts", start: 3, startLoc: { line: 3, column: 1 } },',
      '  secondFile: { name: "src/lib/b.ts", start: 10, startLoc: { line: 10, column: 1 } } };',
      'fs.writeFileSync(path.join(out, "jscpd-report.json"), JSON.stringify({ duplicates: [clone] }));',
      'console.log("Clone found (typescript): " + JSON.stringify(process.argv.slice(2)));',
      'process.exit(1);',
      '',
    ].join('\n'));
    const result = runChecks({ root, skip: new Set(['no-comments']) });
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.findings, [{
      path: 'src/lib/a.ts',
      line: 3,
      message: 'duplication: 9 lines duplicated with src/lib/b.ts:10 — extract and reuse',
    }]);
    const cli = run(root, ['--skip', 'no-comments'], { CHECK_RULES_TYPESCRIPT: '' });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /--min-lines","8","--min-tokens","60","--threshold","0","--reporters","console,json"/);
    assert.equal(lines(cli.stdout).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
