#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.dart_tool',
  '.next',
  '.nuxt',
  '.turbo',
  '.venv',
  'Pods',
  'DerivedData',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'vendor',
]);
const MANIFEST_NAMES = new Set([
  'Cargo.toml',
  'Package.swift',
  'Podfile',
  'composer.json',
  'go.mod',
  'package.json',
  'pubspec.yaml',
  'pyproject.toml',
  'requirements.txt',
]);
const TEXT_EXTENSIONS = new Set([
  '.c',
  '.cpp',
  '.css',
  '.dart',
  '.go',
  '.h',
  '.html',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.md',
  '.mjs',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.scss',
  '.sql',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.vue',
  '.yaml',
  '.yml',
]);
const MAX_FILES = 12_000;
const MAX_DEPTH = 8;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_TODO_MARKERS = 80;

function toPortablePath(path) {
  return path.split(sep).join('/');
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

function walk(root) {
  const files = [];
  const topLevel = [];
  let truncated = false;

  function visit(directory, depth) {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) {
      truncated = true;
      return;
    }

    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        truncated = true;
        break;
      }
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;

      const absolute = join(directory, entry.name);
      const relativePath = toPortablePath(relative(root, absolute));
      if (depth === 0) topLevel.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
      if (entry.isDirectory()) visit(absolute, depth + 1);
      else if (entry.isFile()) files.push({ absolute, relativePath });
    }
  }

  visit(root, 0);
  return { files, topLevel, truncated };
}

function readPackageManifest(path, errors) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return {
      package_name: typeof parsed.name === 'string' ? parsed.name : null,
      scripts: parsed.scripts && typeof parsed.scripts === 'object'
        ? Object.keys(parsed.scripts).sort()
        : [],
      dependencies: parsed.dependencies && typeof parsed.dependencies === 'object'
        ? Object.keys(parsed.dependencies).sort()
        : [],
      dev_dependencies: parsed.devDependencies && typeof parsed.devDependencies === 'object'
        ? Object.keys(parsed.devDependencies).sort()
        : [],
    };
  } catch (error) {
    errors.push(`package.json: ${error.message}`);
    return null;
  }
}

function likelyCommands(manifests) {
  const commands = new Set();
  for (const manifest of manifests) {
    if (manifest.name === 'package.json' && manifest.package) {
      for (const script of manifest.package.scripts) {
        if (['build', 'test', 'lint', 'typecheck', 'check'].includes(script)) {
          commands.add(`npm run ${script}`);
        }
      }
    }
    if (manifest.name === 'pubspec.yaml') {
      commands.add('flutter analyze');
      commands.add('flutter test');
    }
    if (manifest.name === 'Package.swift') commands.add('swift test');
    if (manifest.name === 'Cargo.toml') {
      commands.add('cargo test');
      commands.add('cargo check');
    }
    if (manifest.name === 'pyproject.toml' || manifest.name === 'requirements.txt') {
      commands.add('python -m pytest');
    }
    if (manifest.name === 'go.mod') commands.add('go test ./...');
  }
  return [...commands];
}

function isDocumentation(relativePath) {
  const name = basename(relativePath).toLowerCase();
  return (
    name === 'agents.md'
    || name === 'claude.md'
    || name.startsWith('readme')
    || relativePath.toLowerCase().startsWith('docs/')
  );
}

function isTestFile(relativePath) {
  const normalized = `/${relativePath.toLowerCase()}`;
  const name = basename(normalized);
  return (
    normalized.includes('/test/')
    || normalized.includes('/tests/')
    || normalized.includes('/__tests__/')
    || normalized.includes('/spec/')
    || name.includes('.test.')
    || name.includes('.spec.')
    || name.endsWith('_test.dart')
    || name.endsWith('_test.go')
    || name.startsWith('test_')
  );
}

function scanTodoMarkers(files) {
  const markers = [];
  for (const file of files) {
    if (markers.length >= MAX_TODO_MARKERS) break;
    if (!TEXT_EXTENSIONS.has(extname(file.relativePath).toLowerCase())) continue;
    let size;
    try {
      size = statSync(file.absolute).size;
    } catch {
      continue;
    }
    if (size > MAX_TEXT_BYTES) continue;

    let content;
    try {
      content = readFileSync(file.absolute, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!/\b(TODO|FIXME|HACK|XXX)\b/i.test(lines[index])) continue;
      markers.push({
        path: file.relativePath,
        line: index + 1,
        text: lines[index].trim().slice(0, 240),
      });
      if (markers.length >= MAX_TODO_MARKERS) break;
    }
  }
  return markers;
}

export function inventoryRepository(requestedPath, label = null) {
  const root = resolve(requestedPath);
  const result = {
    schema_version: 1,
    label: label || basename(root),
    root,
    exists: existsSync(root),
    is_directory: false,
    generated_at: new Date().toISOString(),
    git: {
      is_repository: false,
      branch: null,
      head_sha: null,
      dirty: false,
      changed_paths: [],
    },
    structure: [],
    files_scanned: 0,
    truncated: false,
    manifests: [],
    documentation: [],
    tests: { count: 0, paths: [] },
    todo_markers: [],
    likely_validation_commands: [],
    fingerprint: null,
    errors: [],
  };

  if (!result.exists) {
    result.errors.push('repository path does not exist');
    return result;
  }

  try {
    result.is_directory = statSync(root).isDirectory();
  } catch (error) {
    result.errors.push(`stat: ${error.message}`);
    return result;
  }
  if (!result.is_directory) {
    result.errors.push('repository path is not a directory');
    return result;
  }

  const inside = git(root, ['rev-parse', '--is-inside-work-tree']);
  result.git.is_repository = inside.ok && inside.stdout === 'true';
  if (result.git.is_repository) {
    const [branch, head, status] = [
      git(root, ['branch', '--show-current']),
      git(root, ['rev-parse', 'HEAD']),
      git(root, ['status', '--porcelain=v1']),
    ];
    result.git.branch = branch.ok ? branch.stdout || null : null;
    result.git.head_sha = head.ok ? head.stdout || null : null;
    result.git.changed_paths = status.ok
      ? status.stdout.split(/\r?\n/).filter(Boolean).slice(0, 200)
      : [];
    result.git.dirty = result.git.changed_paths.length > 0;
    if (!status.ok && status.stderr) result.errors.push(`git status: ${status.stderr}`);
  }

  const walked = walk(root);
  result.structure = walked.topLevel.slice(0, 100);
  result.files_scanned = walked.files.length;
  result.truncated = walked.truncated;

  for (const file of walked.files) {
    const name = basename(file.relativePath);
    if (MANIFEST_NAMES.has(name) || name.endsWith('.xcodeproj/project.pbxproj')) {
      const manifest = { path: file.relativePath, name, package: null };
      if (name === 'package.json') {
        manifest.package = readPackageManifest(file.absolute, result.errors);
      }
      result.manifests.push(manifest);
    }
  }
  result.manifests = result.manifests.slice(0, 80);
  result.documentation = walked.files
    .map((file) => file.relativePath)
    .filter(isDocumentation)
    .slice(0, 100);
  const testPaths = walked.files
    .map((file) => file.relativePath)
    .filter(isTestFile);
  result.tests = { count: testPaths.length, paths: testPaths.slice(0, 120) };
  result.todo_markers = scanTodoMarkers(walked.files);
  result.likely_validation_commands = likelyCommands(result.manifests);
  result.fingerprint = createHash('sha256').update(JSON.stringify({
    git: result.git,
    manifests: result.manifests,
    documentation: result.documentation,
    tests: result.tests,
    todo_markers: result.todo_markers,
  })).digest('hex');
  return result;
}

function main() {
  const [requestedPath, label] = process.argv.slice(2);
  if (!requestedPath) {
    process.stderr.write('Usage: node repo-inventory.mjs <repo-path> [label]\n');
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${JSON.stringify(inventoryRepository(requestedPath, label), null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
