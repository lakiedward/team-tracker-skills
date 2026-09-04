#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHECKS = Object.freeze([
  'max-lines', 'no-comments', 'max-files', 'docs-mirror', 'tokens-only', 'duplication',
]);
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.astro', '.css']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.astro']);
const TOKEN_FOLDERS = ['components', 'pages', 'sections'];
const HEX_COLOUR = /(?<![\w&#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const FUNCTION_COLOUR = /\b(?:rgba?|hsla?)\(/g;
const PX_VALUE = /(?<![\w.-])(\d+(?:\.\d+)?)px\b/g;
const QUERY_PRELUDE = /@(?:media|container|supports)\b[^{;]*/g;
const ALLOWED_PX = new Set(['0', '1']);

export function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    src: 'src',
    maxLines: 600,
    maxFiles: 20,
    tokens: 'src/styles/tokens.css',
    skip: new Set(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--root') args.root = value;
    else if (arg === '--src') args.src = value;
    else if (arg === '--max-lines') args.maxLines = Number(value);
    else if (arg === '--max-files') args.maxFiles = Number(value);
    else if (arg === '--tokens') args.tokens = value;
    else if (arg === '--skip') {
      for (const name of String(value || '').split(',')) {
        const check = name.trim();
        if (!check) continue;
        if (!CHECKS.includes(check)) throw new Error(`unknown check "${check}" (known: ${CHECKS.join(', ')})`);
        args.skip.add(check);
      }
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    } else throw new Error(`unknown argument ${arg}`);
    index += 1;
  }
  if (!Number.isInteger(args.maxLines) || args.maxLines <= 0) throw new Error('--max-lines must be a positive integer');
  if (!Number.isInteger(args.maxFiles) || args.maxFiles <= 0) throw new Error('--max-files must be a positive integer');
  args.root = resolve(args.root);
  return args;
}

export function relPath(root, file) {
  return relative(root, file).split(sep).join('/');
}

export function walk(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...walk(join(dir, entry.name)));
    } else if (entry.isFile()) files.push(join(dir, entry.name));
  }
  return files.sort();
}

export function loadTypescript(root) {
  const override = process.env.CHECK_RULES_TYPESCRIPT;
  if (override) return createRequire(import.meta.url)(resolve(override));
  try {
    return createRequire(join(root, 'package.json'))('typescript');
  } catch {
    return null;
  }
}

function countLines(text) {
  if (!text) return 0;
  const newlines = text.split('\n').length - 1;
  return text.endsWith('\n') ? newlines : newlines + 1;
}

function lineAt(text, offset) {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function excerpt(comment) {
  const flat = comment.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
}

export function checkMaxLines(root, files, maxLines) {
  const findings = [];
  for (const file of files) {
    const lines = countLines(readFileSync(file, 'utf8'));
    if (lines > maxLines) {
      findings.push({
        path: relPath(root, file),
        line: maxLines + 1,
        message: `max-lines: ${lines} lines (max ${maxLines}) — split the file`,
      });
    }
  }
  return findings;
}

function scriptKindFor(ts, file) {
  const ext = extname(file);
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.ts') return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

export function tsCommentRanges(ts, text, scriptKind) {
  const source = ts.createSourceFile('check-rules.tsx', text, ts.ScriptTarget.Latest, true, scriptKind);
  const tokens = [];
  const collect = (node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(source);
    if (children.length === 0) {
      tokens.push(node);
      return;
    }
    for (const child of children) collect(child);
  };
  collect(source);
  tokens.push(source.endOfFileToken);
  const jsxTextStarts = new Set(
    tokens.filter((token) => token.kind === ts.SyntaxKind.JsxText).map((token) => token.pos),
  );
  const ranges = new Map();
  for (const token of tokens) {
    if (!jsxTextStarts.has(token.pos)) {
      for (const range of ts.getLeadingCommentRanges(text, token.pos) || []) ranges.set(range.pos, range);
    }
    if (!jsxTextStarts.has(token.end)) {
      for (const range of ts.getTrailingCommentRanges(text, token.end) || []) ranges.set(range.pos, range);
    }
  }
  return [...ranges.values()]
    .sort((left, right) => left.pos - right.pos)
    .filter((range) => !/^\/\/\/\s*<reference\b/.test(text.slice(range.pos, range.end)));
}

function tsFindings(ts, text, scriptKind, path, lineOffset) {
  return tsCommentRanges(ts, text, scriptKind).map((range) => ({
    path,
    line: lineAt(text, range.pos) + lineOffset,
    message: `no-comments: comment is not allowed ("${excerpt(text.slice(range.pos, range.end))}")`,
  }));
}

function regexFindings(text, pattern, path, lineOffset) {
  const findings = [];
  for (const match of text.matchAll(pattern)) {
    findings.push({
      path,
      line: lineAt(text, match.index) + lineOffset,
      message: `no-comments: comment is not allowed ("${excerpt(match[0])}")`,
    });
  }
  return findings;
}

const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;
const TEMPLATE_COMMENT = /<!--[\s\S]*?-->|\{\s*\/\*[\s\S]*?\*\/\s*\}/g;
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

export function splitAstro(text) {
  const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return { frontmatter: '', template: text, templateLine: 1 };
  const frontmatter = match[1];
  return {
    frontmatter,
    template: text.slice(match[0].length),
    templateLine: countLines(match[0]) + 1,
  };
}

function astroFindings(ts, text, path) {
  const { frontmatter, template, templateLine } = splitAstro(text);
  const findings = frontmatter ? tsFindings(ts, frontmatter, ts.ScriptKind.TS, path, 1) : [];
  findings.push(...regexFindings(template, TEMPLATE_COMMENT, path, templateLine - 1));
  for (const block of template.matchAll(STYLE_BLOCK)) {
    const offset = templateLine - 1 + lineAt(template, block.index + block[0].indexOf(block[1])) - 1;
    findings.push(...regexFindings(block[1], CSS_COMMENT, path, offset));
  }
  return findings;
}

export function checkNoComments(root, files, ts) {
  const findings = [];
  for (const file of files) {
    const path = relPath(root, file);
    const text = readFileSync(file, 'utf8');
    const ext = extname(file);
    if (ext === '.css') findings.push(...regexFindings(text, CSS_COMMENT, path, 0));
    else if (ext === '.astro') findings.push(...astroFindings(ts, text, path));
    else findings.push(...tsFindings(ts, text, scriptKindFor(ts, file), path, 0));
  }
  return findings;
}

export function checkMaxFiles(root, srcDir, maxFiles) {
  const findings = [];
  const visit = (dir) => {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
    const entries = readdirSync(dir, { withFileTypes: true });
    const count = entries.filter((entry) => entry.isFile()).length;
    if (count > maxFiles) {
      findings.push({
        path: `${relPath(root, dir)}/`,
        line: 1,
        message: `max-files: ${count} files in folder (max ${maxFiles}) — split it by feature`,
      });
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) visit(join(dir, entry.name));
    }
  };
  visit(srcDir);
  return findings;
}

export function checkDocsMirror(root) {
  const claude = join(root, 'CLAUDE.md');
  const agents = join(root, 'AGENTS.md');
  const hasClaude = existsSync(claude);
  const hasAgents = existsSync(agents);
  if (!hasClaude && !hasAgents) return [];
  if (!hasAgents) return [{ path: 'AGENTS.md', line: 1, message: 'docs-mirror: AGENTS.md is missing — it must be a byte-identical copy of CLAUDE.md' }];
  if (!hasClaude) return [{ path: 'CLAUDE.md', line: 1, message: 'docs-mirror: CLAUDE.md is missing — AGENTS.md mirrors it' }];
  const left = readFileSync(claude);
  const right = readFileSync(agents);
  if (left.equals(right)) return [];
  const leftLines = left.toString('utf8').split('\n');
  const rightLines = right.toString('utf8').split('\n');
  let line = 0;
  while (line < leftLines.length && line < rightLines.length && leftLines[line] === rightLines[line]) line += 1;
  return [{
    path: 'AGENTS.md',
    line: line + 1,
    message: `docs-mirror: AGENTS.md differs from CLAUDE.md (first difference at line ${line + 1}) — copy CLAUDE.md over it`,
  }];
}

function tokensOnlyPatterns(text) {
  const hits = [];
  for (const match of text.matchAll(HEX_COLOUR)) {
    hits.push({ index: match.index, message: `tokens-only: literal colour "${match[0]}" — use a --color-* token from tokens.css` });
  }
  for (const match of text.matchAll(FUNCTION_COLOUR)) {
    hits.push({ index: match.index, message: `tokens-only: literal colour "${match[0]}…)" — use a --color-* token from tokens.css` });
  }
  const queries = [...text.matchAll(QUERY_PRELUDE)].map((match) => [match.index, match.index + match[0].length]);
  for (const match of text.matchAll(PX_VALUE)) {
    if (ALLOWED_PX.has(match[1])) continue;
    if (queries.some(([start, end]) => match.index >= start && match.index < end)) continue;
    hits.push({ index: match.index, message: `tokens-only: literal size "${match[0]}" — use a --space-* / --text-* / --radius-* token` });
  }
  return hits.sort((left, right) => left.index - right.index);
}

export function checkTokensOnly(root, srcDir, tokensFile, files) {
  const findings = [];
  const folders = TOKEN_FOLDERS.map((name) => `${relPath(root, join(srcDir, name))}/`);
  for (const file of files) {
    if (resolve(file) === resolve(tokensFile)) continue;
    const path = relPath(root, file);
    if (!folders.some((folder) => path.startsWith(folder))) continue;
    const text = readFileSync(file, 'utf8');
    for (const hit of tokensOnlyPatterns(text)) {
      findings.push({ path, line: lineAt(text, hit.index), message: hit.message });
    }
  }
  return findings;
}

function jscpdBinary(root) {
  const script = join(root, 'node_modules', 'jscpd', 'bin', 'jscpd.js');
  if (existsSync(script)) return { command: process.execPath, prefix: [script] };
  const shim = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'jscpd.cmd' : 'jscpd');
  if (existsSync(shim)) return { command: shim, prefix: [], shell: process.platform === 'win32' };
  return null;
}

function duplicateLocation(root, side) {
  const name = side?.name || '';
  const path = resolve(name) === name ? relPath(root, name) : name.split(sep).join('/');
  const line = side?.startLoc?.line ?? side?.start ?? 1;
  return { path, line };
}

export function checkDuplication(root, srcDir, warnings) {
  const binary = jscpdBinary(root);
  if (!binary) {
    warnings.push(`duplication: jscpd is not installed in ${root} (npm i -D jscpd) — check skipped`);
    return [];
  }
  const output = mkdtempSync(join(tmpdir(), 'check-rules-jscpd-'));
  try {
    const args = [
      ...binary.prefix, srcDir,
      '--min-lines', '8', '--min-tokens', '60', '--threshold', '0',
      '--reporters', 'console,json', '--output', output,
    ];
    const run = spawnSync(binary.command, args, { cwd: root, encoding: 'utf8', shell: binary.shell === true });
    if (run.error) {
      warnings.push(`duplication: could not run jscpd (${run.error.message}) — check skipped`);
      return [];
    }
    if (run.stdout) process.stderr.write(run.stdout);
    if (run.stderr) process.stderr.write(run.stderr);
    const reportFile = join(output, 'jscpd-report.json');
    if (!existsSync(reportFile)) {
      if (run.status === 0) return [];
      return [{ path: relPath(root, srcDir) || '.', line: 1, message: `duplication: jscpd exited with ${run.status} (see output above)` }];
    }
    const report = JSON.parse(readFileSync(reportFile, 'utf8'));
    return (report.duplicates || []).map((clone) => {
      const first = duplicateLocation(root, clone.firstFile);
      const second = duplicateLocation(root, clone.secondFile);
      return {
        path: first.path,
        line: first.line,
        message: `duplication: ${clone.lines} lines duplicated with ${second.path}:${second.line} — extract and reuse`,
      };
    });
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

export function collectFiles(root, srcDir) {
  const files = [];
  for (const dir of [srcDir, join(root, 'scripts'), join(root, 'tests')]) {
    for (const file of walk(dir)) {
      if (CODE_EXTENSIONS.has(extname(file))) files.push(file);
    }
  }
  return [...new Set(files)];
}

function sortFindings(findings) {
  return findings.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.message.localeCompare(right.message));
}

export function runChecks(options) {
  const args = { ...options, skip: options.skip || new Set() };
  const root = resolve(args.root || process.cwd());
  const srcDir = resolve(root, args.src || 'src');
  const tokensFile = resolve(root, args.tokens || 'src/styles/tokens.css');
  const maxLines = args.maxLines || 600;
  const maxFiles = args.maxFiles || 20;
  const warnings = [];
  const files = collectFiles(root, srcDir);
  const findings = [];
  const enabled = (name) => !args.skip.has(name);
  if (enabled('no-comments')) {
    const ts = args.ts || loadTypescript(root);
    if (!ts) {
      throw Object.assign(
        new Error(`cannot resolve "typescript" from ${root} — run npm i -D typescript, or set CHECK_RULES_TYPESCRIPT=<path to the typescript package>`),
        { exitCode: 2 },
      );
    }
    findings.push(...checkNoComments(root, files, ts));
  }
  if (enabled('max-lines')) findings.push(...checkMaxLines(root, files, maxLines));
  if (enabled('max-files')) findings.push(...checkMaxFiles(root, srcDir, maxFiles));
  if (enabled('docs-mirror')) findings.push(...checkDocsMirror(root));
  if (enabled('tokens-only')) findings.push(...checkTokensOnly(root, srcDir, tokensFile, files));
  if (enabled('duplication')) findings.push(...checkDuplication(root, srcDir, warnings));
  return { findings: sortFindings(findings), warnings, filesChecked: files.length };
}

export function formatFinding(finding) {
  return `${finding.path}:${finding.line}: ${finding.message}`;
}

function usage() {
  return 'Usage: check-rules.mjs [--root <dir>] [--src src] [--max-lines 600] [--max-files 20]\n'
    + '                       [--tokens src/styles/tokens.css] [--skip <check,...>]\n'
    + `  checks: ${CHECKS.join(', ')}\n`
    + '  exit 0 clean · exit 1 findings (one per line: path:line: message) · exit 2 tooling error\n';
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`check:rules: ${error.message}\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  let result;
  try {
    result = runChecks(args);
  } catch (error) {
    process.stderr.write(`check:rules: ${error.message}\n`);
    process.exitCode = error.exitCode || 2;
    return;
  }
  for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
  for (const finding of result.findings) process.stdout.write(`${formatFinding(finding)}\n`);
  if (result.findings.length > 0) {
    process.stderr.write(`check:rules: ${result.findings.length} finding(s) in ${result.filesChecked} files\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`check:rules: clean (${result.filesChecked} files)\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
