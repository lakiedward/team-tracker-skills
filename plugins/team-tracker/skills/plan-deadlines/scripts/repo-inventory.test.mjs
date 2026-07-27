import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { inventoryRepository } from './repo-inventory.mjs';
import { planningKey } from './planning-key.mjs';

const fixture = mkdtempSync(join(tmpdir(), 'plan-deadlines-inventory-'));
try {
  mkdirSync(join(fixture, 'src'));
  mkdirSync(join(fixture, 'tests'));
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({
    name: 'fixture',
    scripts: { build: 'vite build', test: 'node --test', dev: 'vite' },
  }));
  writeFileSync(join(fixture, 'README.md'), '# Fixture\n');
  writeFileSync(join(fixture, 'src', 'index.ts'), '// TODO: wire delivery\nexport const ready = false;\n');
  writeFileSync(join(fixture, 'tests', 'index.test.ts'), 'export {};\n');

  const before = readFileSync(join(fixture, 'src', 'index.ts'), 'utf8');
  const inventory = inventoryRepository(fixture, 'fixture');
  const after = readFileSync(join(fixture, 'src', 'index.ts'), 'utf8');

  assert.equal(inventory.exists, true);
  assert.equal(inventory.is_directory, true);
  assert.equal(inventory.manifests[0].name, 'package.json');
  assert.deepEqual(inventory.manifests[0].package.scripts, ['build', 'dev', 'test']);
  assert.equal(inventory.tests.count, 1);
  assert.equal(inventory.todo_markers.length, 1);
  assert.equal(before, after, 'inventory must not change source files');

  const missing = inventoryRepository(join(fixture, 'missing'));
  assert.equal(missing.exists, false);
  assert.match(missing.errors[0], /does not exist/);

  assert.equal(
    planningKey(18, 'launch-checklist'),
    planningKey(18, ' Launch Checklist '),
    'planning keys must be deterministic after normalization',
  );
  assert.notEqual(planningKey(18, 'launch-checklist'), planningKey(1, 'launch-checklist'));

  console.log('plan-deadlines inventory tests passed');
} finally {
  const resolvedFixture = resolve(fixture);
  if (
    resolvedFixture.startsWith(resolve(tmpdir()))
    && basename(resolvedFixture).startsWith('plan-deadlines-inventory-')
  ) {
    rmSync(resolvedFixture, { recursive: true, force: true });
  }
}
