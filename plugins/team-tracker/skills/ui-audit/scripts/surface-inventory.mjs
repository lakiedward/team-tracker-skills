#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableSurfaceKey } from './audit-contract.mjs';

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const IGNORED = new Set([
  '.git', '.next', '.turbo', 'build', 'coverage', 'dist', 'node_modules', 'vendor',
]);
const MAX_FILES = 4_000;
const MAX_DEPTH = 8;
const MAX_BYTES = 768 * 1024;

function portable(path) {
  return path.split(sep).join('/');
}

function sourceFiles(root) {
  const files = [];
  let truncated = false;
  function visit(directory, depth) {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) {
      truncated = true;
      return;
    }
    let entries = [];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && IGNORED.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, depth + 1);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        try {
          if (statSync(absolute).size <= MAX_BYTES) {
            files.push({ absolute, relative: portable(relative(root, absolute)) });
          }
        } catch {
          // A file that disappears during a read-only scan is simply skipped.
        }
      }
      if (files.length >= MAX_FILES) {
        truncated = true;
        break;
      }
    }
  }
  visit(root, 0);
  return { files, truncated };
}

function lineNumber(content, offset) {
  return content.slice(0, offset).split(/\r?\n/).length;
}

function routeCandidates(content, path, codebase) {
  const routes = [];
  const routePattern = /<Route\b([^>]*?)\bpath\s*=\s*["']([^"']+)["']([^>]*)>/g;
  let match;
  while ((match = routePattern.exec(content))) {
    const attributes = `${match[1]} ${match[3]}`;
    const component = attributes.match(/\belement\s*=\s*\{\s*<([A-Za-z0-9_.]+)/)?.[1] || null;
    const route = match[2];
    routes.push({
      stable_key: stableSurfaceKey({ codebase, kind: 'page', route_pattern: route }),
      kind: 'page',
      route_pattern: route,
      component,
      code_ref: path,
      line: lineNumber(content, match.index),
      protected_hint: /admin|account|profile/i.test(route) || /Protected|Auth/.test(attributes),
    });
  }
  const objectPattern = /\bpath\s*:\s*["']([^"']+)["'][\s\S]{0,180}?\belement\s*:\s*(?:<|\b)([A-Z][A-Za-z0-9_.]*)?/g;
  while ((match = objectPattern.exec(content))) {
    const route = match[1];
    routes.push({
      stable_key: stableSurfaceKey({ codebase, kind: 'page', route_pattern: route }),
      kind: 'page',
      route_pattern: route,
      component: match[2] || null,
      code_ref: path,
      line: lineNumber(content, match.index),
      protected_hint: /admin|account|profile/i.test(route),
    });
  }
  return routes;
}

function stateCandidates(content, path, codebase) {
  const states = [];
  const useStatePattern = /const\s*\[\s*([A-Za-z0-9_]*active[A-Za-z0-9_]*|activeTab)\s*(?:,[^\]]+)?\]\s*=\s*useState\s*<([^>]{1,500})>/gi;
  let match;
  while ((match = useStatePattern.exec(content))) {
    const stateName = match[1];
    const values = [...match[2].matchAll(/["']([^"']+)["']/g)].map((entry) => entry[1]);
    for (const value of values) {
      states.push({
        stable_key: stableSurfaceKey({
          codebase,
          kind: 'state',
          navigation_key: `${path}:${stateName}:${value}`,
          label: value,
        }),
        kind: 'state',
        state_name: stateName,
        state_value: value,
        code_ref: path,
        line: lineNumber(content, match.index),
      });
    }
  }
  if (/activeTab|activeView|selectedTab/.test(content)) {
    const keyPattern = /\{\s*(?:key|id)\s*:\s*["']([^"']+)["']\s*,\s*label\s*:/g;
    while ((match = keyPattern.exec(content))) {
      const value = match[1];
      states.push({
        stable_key: stableSurfaceKey({
          codebase,
          kind: 'state',
          navigation_key: `${path}:tab:${value}`,
          label: value,
        }),
        kind: 'state',
        state_name: 'tab',
        state_value: value,
        code_ref: path,
        line: lineNumber(content, match.index),
      });
    }
  }
  return states;
}

function dedupe(candidates) {
  const byKey = new Map();
  for (const candidate of candidates) {
    const existing = byKey.get(candidate.stable_key);
    if (!existing || candidate.line < existing.line) byKey.set(candidate.stable_key, candidate);
  }
  return [...byKey.values()].sort((a, b) => a.stable_key.localeCompare(b.stable_key));
}

export function inventoryUiSurfaces(repoPath, codebase = 'app') {
  const root = resolve(repoPath);
  const result = {
    schema_version: 1,
    root,
    codebase,
    exists: existsSync(root),
    files_scanned: 0,
    truncated: false,
    routes: [],
    stateful_surfaces: [],
    errors: [],
  };
  if (!result.exists) {
    result.errors.push('repository path does not exist');
    return result;
  }
  const walked = sourceFiles(root);
  result.files_scanned = walked.files.length;
  result.truncated = walked.truncated;
  const routes = [];
  const states = [];
  for (const file of walked.files) {
    let content;
    try {
      content = readFileSync(file.absolute, 'utf8');
    } catch (error) {
      result.errors.push(`${file.relative}: ${error.message}`);
      continue;
    }
    routes.push(...routeCandidates(content, file.relative, codebase));
    states.push(...stateCandidates(content, file.relative, codebase));
  }
  result.routes = dedupe(routes);
  result.stateful_surfaces = dedupe(states);
  return result;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    args[argv[index].slice(2)] = argv[index + 1];
    index += 1;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.repo) {
    process.stderr.write('Usage: surface-inventory.mjs --repo <path> [--codebase <label>]\n');
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${JSON.stringify(inventoryUiSurfaces(args.repo, args.codebase || 'app'), null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
