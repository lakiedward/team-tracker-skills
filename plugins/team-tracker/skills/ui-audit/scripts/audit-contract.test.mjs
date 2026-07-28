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
import {
  diffSurfaceInventories,
  findingFingerprint,
  fingerprintFiles,
  scoreDimensions,
  stableSurfaceKey,
  validateAuditPayload,
} from './audit-contract.mjs';
import { inventoryUiSurfaces } from './surface-inventory.mjs';

const fixture = mkdtempSync(join(tmpdir(), 'ui-audit-'));
try {
  mkdirSync(join(fixture, 'src'));
  writeFileSync(join(fixture, 'src', 'App.tsx'), `
    import { Routes, Route } from 'react-router-dom';
    export function App() {
      const [activeTab] = useState<'home' | 'settings'>('home');
      return <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/account" element={<Account />} />
      </Routes>;
    }
  `);
  const before = readFileSync(join(fixture, 'src', 'App.tsx'), 'utf8');
  const inventory = inventoryUiSurfaces(fixture, 'web');
  const after = readFileSync(join(fixture, 'src', 'App.tsx'), 'utf8');
  assert.equal(before, after, 'inventory must not change source');
  assert.deepEqual(inventory.routes.map((route) => route.route_pattern), ['/', '/account']);
  assert.deepEqual(
    inventory.stateful_surfaces.map((state) => state.state_value),
    ['home', 'settings'],
  );

  const pageKey = stableSurfaceKey({ codebase: 'web', kind: 'page', route_pattern: '/checkout' });
  assert.equal(pageKey, 'web:page:/checkout');
  assert.equal(
    fingerprintFiles(fixture, ['src/App.tsx']),
    fingerprintFiles(fixture, ['src/App.tsx']),
  );
  assert.equal(
    findingFingerprint({
      surface_stable_key: pageKey,
      category: 'Accessibility',
      nature: 'objective',
      title: ' Focus missing ',
      verification: 'Tab',
    }),
    findingFingerprint({
      surface_stable_key: pageKey,
      category: 'accessibility',
      nature: 'objective',
      title: 'focus missing',
      verification: 'Tab',
    }),
  );
  assert.equal(scoreDimensions({
    layout_responsive: 90,
    consistency_design_system: 80,
    states_completeness: 70,
    usability_accessibility: 100,
    interaction_runtime: 60,
  }), 81.5);

  const payload = {
    surfaces: [{
      stable_key: pageKey,
      kind: 'page',
      label: 'Checkout',
      fingerprint: 'sha',
    }],
    items: [{
      surface_stable_key: pageKey,
      audit_status: 'pass',
      ai_score: 100,
      dimensions: {
        layout_responsive: 100,
        consistency_design_system: 100,
        states_completeness: 100,
        usability_accessibility: 100,
        interaction_runtime: 100,
      },
      browser_scenarios: [{ viewport: '1440x900' }, { viewport: '390x844' }],
    }],
    findings: [],
  };
  assert.deepEqual(validateAuditPayload(payload), { valid: true, errors: [] });
  assert.equal(validateAuditPayload({
    ...payload,
    items: [{ ...payload.items[0], browser_scenarios: [{ viewport: '1440x900' }] }],
  }).valid, false);
  assert.equal(validateAuditPayload({
    ...payload,
    items: [{
      surface_stable_key: pageKey,
      audit_status: 'blocked',
      ai_score: 20,
      browser_scenarios: [],
    }],
  }).valid, false);

  assert.deepEqual(diffSurfaceInventories(
    [
      { stable_key: 'a', fingerprint: '1', inventory_state: 'active' },
      { stable_key: 'b', fingerprint: '1', inventory_state: 'active' },
      { stable_key: 'c', fingerprint: '1', inventory_state: 'missing' },
    ],
    [
      { stable_key: 'a', fingerprint: '2' },
      { stable_key: 'c', fingerprint: '1' },
      { stable_key: 'd', fingerprint: '1' },
    ],
  ), {
    new: ['d'],
    missing: ['b'],
    changed: ['a'],
    unchanged: [],
    reappeared: ['c'],
  });

  const culcushPath = 'C:/Users/lakie/Desktop/culcus.ro/culcus.ro';
  if (readFileSync) {
    const culcush = inventoryUiSurfaces(culcushPath, 'website');
    assert.equal(culcush.routes.some((route) => route.route_pattern === '/checkout'), true);
    assert.equal(culcush.routes.some((route) => route.route_pattern === '/admin'), true);
  }

  const betroPath = 'C:/Users/lakie/Desktop/BETRO';
  const betro = inventoryUiSurfaces(betroPath, 'app');
  assert.equal(
    betro.stateful_surfaces.some((state) => state.state_value === 'matches'),
    true,
  );
  assert.equal(
    betro.stateful_surfaces.some((state) => state.state_value === 'profile'),
    true,
  );

  console.log('ui-audit contract and inventory tests passed');
} finally {
  const resolved = resolve(fixture);
  if (resolved.startsWith(resolve(tmpdir())) && basename(resolved).startsWith('ui-audit-')) {
    rmSync(resolved, { recursive: true, force: true });
  }
}
