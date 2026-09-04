import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableSurfaceKey } from '../../ui-audit/scripts/audit-contract.mjs';
import {
  platformsFor,
  sitemapToSurfaces,
  surfacesToMarkdown,
  surfacesToSql,
  validateSitemap,
} from './sitemap-to-surfaces.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'sitemap-to-surfaces.mjs');

const SITEMAP = {
  codebase: 'website',
  platform: 'web',
  pages: [
    {
      route: '/',
      label: 'Acasă',
      purpose: 'Prima impresie: ce facem și cum ne contactezi.',
      required_for_launch: true,
      navigation_hint: 'Logo → Acasă',
      sections: [
        { label: 'Header', purpose: 'Logo, meniu, buton de contact.', required_for_launch: true },
        { label: 'Hero', purpose: 'Promisiunea într-o frază.', required_for_launch: true },
        { label: 'Footer', purpose: 'Date de contact și linkuri legale.', importance: 'polish' },
      ],
    },
    {
      route: '/contact',
      label: 'Contact',
      purpose: 'Omul găsește adresa și ne scrie.',
      required_for_launch: true,
      navigation_hint: 'Meniu → Contact',
      importance: 'launch',
      sections: [
        { label: 'Hartă', purpose: 'Unde suntem, cu link spre navigație.', required_for_launch: true },
        { label: 'Formular', purpose: 'Mesaj cu confirmare pe ecran.', required_for_launch: true },
        { label: 'Program', purpose: 'Orele de lucru.', required_for_launch: false },
      ],
    },
  ],
};

// docs/sitemap.md is a snapshot of the same rows the tracker receives, in the
// block format templates/README.md documents; rendering it from the rows is what
// keeps the snapshot's keys identical to the tracker's.
test('--markdown renders one block per page with its sections table', () => {
  const md = surfacesToMarkdown(sitemapToSurfaces(SITEMAP));
  assert.match(md, /^## Acasă — `\/`\n\nStable key: `website:page:\/` · required for launch: \*\*yes\*\*\n\nPurpose: Prima impresie/m);
  assert.match(md, /^## Contact — `\/contact`\n/m);
  assert.match(md, /^\| Section \| Stable key \| Purpose \| Required \|\n\|---\|---\|---\|---\|\n/m);
  assert.match(md, /\| Hartă \| `website:section:harta:website:page:\/contact` \| Unde suntem, cu link spre navigație\. \| yes \|/);
  assert.match(md, /\| Program \| `website:section:program:website:page:\/contact` \| Orele de lucru\. \| no \|/);
  assert.equal(md.split('\n## ').length, 2, 'exactly one block per page');

  const bare = surfacesToMarkdown(sitemapToSurfaces({
    codebase: 'website',
    platform: 'web',
    pages: [{ route: '/x', label: 'A | B', purpose: 'p | q' }],
  }));
  assert.match(bare, /^## A \\\| B — `\/x`/m, 'pipes in labels are escaped so the table survives');
  assert.match(bare, /Purpose: p \\\| q/);
  assert.match(bare, /_Fără secțiuni încă\._/);
  assert.doesNotMatch(bare, /\| Section \|/, 'a page without sections has no empty table');
  assert.throws(() => surfacesToMarkdown([]), /no pages/);
});

test('stable keys are deterministic and match audit-contract', () => {
  const first = sitemapToSurfaces(SITEMAP);
  const second = sitemapToSurfaces(JSON.parse(JSON.stringify(SITEMAP)));
  assert.deepEqual(first, second);
  const keys = first.map((row) => row.stable_key);
  assert.deepEqual(keys, [
    'website:page:/',
    'website:section:header:website:page:/',
    'website:section:hero:website:page:/',
    'website:section:footer:website:page:/',
    'website:page:/contact',
    'website:section:harta:website:page:/contact',
    'website:section:formular:website:page:/contact',
    'website:section:program:website:page:/contact',
  ]);
  assert.equal(
    keys[5],
    stableSurfaceKey({
      codebase: 'website',
      kind: 'section',
      label: 'Hartă',
      parent_stable_key: stableSurfaceKey({ codebase: 'website', kind: 'page', route_pattern: '/contact' }),
    }),
  );
});

test('sections link to their page and carry the planned/manual shape', () => {
  const rows = sitemapToSurfaces(SITEMAP);
  const contact = rows.find((row) => row.stable_key === 'website:page:/contact');
  assert.equal(contact.parent_stable_key, null);
  assert.equal(contact.kind, 'page');
  assert.equal(contact.route_pattern, '/contact');
  assert.equal(contact.navigation_hint, 'Meniu → Contact');
  assert.equal(contact.manual_importance, 'launch');
  const map = rows.find((row) => row.label === 'Hartă');
  assert.equal(map.parent_stable_key, contact.stable_key);
  assert.equal(map.kind, 'section');
  assert.equal(map.route_pattern, null);
  assert.equal(map.codebase_label, 'website');
  assert.deepEqual(map.platforms, ['web']);
  assert.equal(map.purpose, 'Unde suntem, cu link spre navigație.');
  assert.equal(map.required_for_launch, true);
  assert.equal(map.manual_importance, 'launch');
  for (const row of rows) {
    assert.equal(row.inventory_state, 'planned');
    assert.equal(row.inventory_origin, 'manual');
  }
  const program = rows.find((row) => row.label === 'Program');
  assert.equal(program.required_for_launch, false);
  assert.equal(program.manual_importance, 'important', 'default importance when not required');
  const footer = rows.find((row) => row.label === 'Footer');
  assert.equal(footer.required_for_launch, true, 'inherits the page flag when unspecified');
  assert.equal(footer.manual_importance, 'polish', 'explicit importance wins');
});

test('native platform yields app codebase and native platforms', () => {
  assert.deepEqual(platformsFor('app'), ['native']);
  assert.deepEqual(platformsFor('web'), ['web']);
  const rows = sitemapToSurfaces({
    platform: 'app',
    pages: [{ label: 'Profil', navigation_key: 'tab:profile', purpose: 'Datele contului.' }],
  });
  assert.equal(rows[0].stable_key, 'app:page:tab:profile');
  assert.deepEqual(rows[0].platforms, ['native']);
  assert.equal(rows[0].codebase_label, 'app');
});

test('SQL upserts pages, then sections joined on the pages CTE, with quotes escaped', () => {
  const rows = sitemapToSurfaces({
    codebase: 'website',
    pages: [{
      route: '/despre',
      label: "Despre noi — 'echipa'",
      purpose: "Cine suntem; O'Neil e fondatorul.",
      sections: [{ label: 'Echipă', purpose: "Poze și roluri; 'fără' titluri pompoase." }],
    }],
  });
  const sql = surfacesToSql(rows, 42);
  assert.match(sql, /^-- \/proiect-nou: site map/);
  assert.match(sql, /WITH pages AS \(\n {2}INSERT INTO public\.tt_ui_surfaces/);
  assert.match(sql, /\), sections AS \(\n {2}INSERT INTO public\.tt_ui_surfaces/);
  assert.match(sql, /JOIN pages p ON p\.stable_key = v\.parent_stable_key/);
  assert.match(sql, /SELECT v\.project_id, p\.id, v\.stable_key::text/);
  assert.equal(
    (sql.match(/ON CONFLICT \(project_id, stable_key\) DO UPDATE\n {4}SET purpose = EXCLUDED\.purpose, navigation_hint = EXCLUDED\.navigation_hint/g) || []).length,
    2,
  );
  assert.ok(sql.includes("'Despre noi — ''echipa'''"), 'label quotes are doubled');
  assert.ok(sql.includes("'Cine suntem; O''Neil e fondatorul.'"), 'purpose quotes are doubled');
  assert.ok(sql.includes("'Poze și roluri; ''fără'' titluri pompoase.'"));
  assert.ok(sql.includes("'planned', 'manual', NULL, '{}'::text[]"));
  assert.ok(sql.includes("ARRAY['web']::text[]"));
  assert.ok(sql.includes('(42, \'website:page:/despre\''));
  assert.ok(sql.includes("(42, 'website:page:/despre', 'website:section:echipa:website:page:/despre'"));
  assert.ok(!sql.includes('manual_verdict'), 'human gates are never written');
  assert.ok(sql.trimEnd().endsWith('ORDER BY kind, stable_key;'), 'exactly one statement');
  assert.throws(() => surfacesToSql(rows, 'abc'), /positive integer/);
  const pagesOnly = surfacesToSql(sitemapToSurfaces({ pages: [{ route: '/', purpose: 'x' }] }), 7);
  assert.ok(!pagesOnly.includes('sections AS'), 'no empty VALUES list when there are no sections');
  assert.ok(pagesOnly.trimEnd().endsWith('ORDER BY stable_key;'));
});

test('validation flags duplicates as errors and purpose/chrome as warnings', () => {
  const { errors, warnings } = validateSitemap({
    codebase: 'website',
    pages: [
      {
        route: '/',
        label: 'Acasă',
        sections: [
          { label: 'Header', purpose: 'Meniu.' },
          { label: 'Hero', purpose: 'Promisiune.' },
          { label: 'hero', purpose: 'Din nou.' },
        ],
      },
      {
        route: '/contact',
        label: 'Contact',
        purpose: 'Scrie-ne.',
        sections: [{ label: 'Header' }, { label: 'Footer', purpose: 'Linkuri.' }],
      },
      { route: '/contact', label: 'Contact (dublat)', purpose: 'Duplicat.' },
      { route: '/servicii', label: 'Servicii', purpose: 'Lista.', sections: [{ label: 'Footer', purpose: 'Linkuri.' }] },
    ],
  });
  assert.ok(errors.some((message) => message.includes('/contact') && message.includes('rută duplicată')));
  assert.ok(errors.some((message) => message.includes('hero') && message.includes('secțiune duplicată')));
  assert.ok(warnings.some((message) => message.startsWith('/: lipsește purpose')));
  assert.ok(warnings.some((message) => message.startsWith('/contact › Header: lipsește purpose')));
  const header = warnings.find((message) => message.startsWith('„Header" apare pe 2 pagini'));
  assert.ok(header, 'shared chrome on two pages is reported once');
  assert.match(header, /pagina-hub/);
  const footer = warnings.find((message) => message.startsWith('„Footer" apare pe 2 pagini'));
  assert.ok(footer);
  assert.match(footer, /\/contact, \/servicii/);
  assert.deepEqual(validateSitemap(SITEMAP).errors, []);
  assert.equal(validateSitemap(SITEMAP).warnings.length, 0);
  assert.deepEqual(validateSitemap({ pages: [] }).errors, ['pages: site map-ul nu are nicio pagină']);
});

test('CLI prints JSON, or SQL with --sql, and exits 1 on errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sitemap-'));
  try {
    const input = join(dir, 'sitemap.json');
    writeFileSync(input, JSON.stringify(SITEMAP));
    const json = spawnSync(process.execPath, [SCRIPT, '--input', input], { encoding: 'utf8' });
    assert.equal(json.status, 0, json.stderr);
    const rows = JSON.parse(json.stdout);
    assert.equal(rows.length, 8);
    assert.equal(rows[0].stable_key, 'website:page:/');

    const sql = spawnSync(process.execPath, [SCRIPT, '--input', input, '--sql', '--project-id', '9'], { encoding: 'utf8' });
    assert.equal(sql.status, 0, sql.stderr);
    assert.match(sql.stdout, /^-- \/proiect-nou: site map → tt_ui_surfaces for project 9/);
    assert.equal(sql.stderr, '');

    const missingId = spawnSync(process.execPath, [SCRIPT, '--input', input, '--sql'], { encoding: 'utf8' });
    assert.equal(missingId.status, 2);

    const markdown = spawnSync(process.execPath, [SCRIPT, '--input', input, '--markdown'], { encoding: 'utf8' });
    assert.equal(markdown.status, 0, markdown.stderr);
    assert.match(markdown.stdout, /^## Acasă — `\/`\n/);
    assert.match(markdown.stdout, /\| Hartă \| `website:section:harta:website:page:\/contact` \| Unde suntem, cu link spre navigație\. \| yes \|/);

    const both = spawnSync(process.execPath, [SCRIPT, '--input', input, '--sql', '--project-id', '9', '--markdown'], { encoding: 'utf8' });
    assert.equal(both.status, 2, 'two outputs at once is a usage error');
    assert.equal(both.stdout, '');

    const broken = join(dir, 'broken.json');
    writeFileSync(broken, JSON.stringify({
      pages: [
        { route: '/a', purpose: 'x', sections: [{ label: 'Nav', purpose: 'y' }] },
        { route: '/a', sections: [{ label: 'Nav', purpose: 'y' }] },
      ],
    }));
    const failed = spawnSync(process.execPath, [SCRIPT, '--input', broken], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, '', 'nothing is emitted when the site map has errors');
    assert.match(failed.stderr, /^warning: „Nav" apare pe 2 pagini/m);
    assert.match(failed.stderr, /^warning: \/a: lipsește purpose/m);
    assert.match(failed.stderr, /^error: \/a: rută duplicată/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
