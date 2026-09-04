#!/usr/bin/env node

// Site map JSON (pages + sections, in the human's words) → tt_ui_surfaces rows
// with the exact stable keys /ui-audit would derive, so the audit recognises a
// planned surface once it shows up in code instead of creating a duplicate.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableSurfaceKey } from '../../ui-audit/scripts/audit-contract.mjs';

const IMPORTANCES = new Set(['launch', 'important', 'polish']);
const NATIVE_PLATFORMS = new Set(['native', 'app', 'mobile', 'ios', 'android', 'capacitor']);
// Shared chrome is inventoried once, as a canonical unit on the layout's hub
// page — the same rule /ui-audit applies when it reads the code.
const CHROME_WORDS = new Set([
  'header', 'footer', 'nav', 'navbar', 'navigation', 'navigatie', 'meniu', 'menu',
  'antet', 'subsol', 'sidebar',
]);

function text(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
}

function normalizeLabel(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export function platformsFor(platform) {
  return NATIVE_PLATFORMS.has(String(platform || 'web').toLowerCase()) ? ['native'] : ['web'];
}

function codebaseFor(sitemap) {
  const explicit = text(sitemap.codebase);
  if (explicit) return explicit;
  return platformsFor(sitemap.platform)[0] === 'native' ? 'app' : 'website';
}

function importanceFor(entry, required) {
  if (IMPORTANCES.has(entry.importance)) return entry.importance;
  return required ? 'launch' : 'important';
}

function isChrome(label) {
  const words = normalizeLabel(label).split(/[^a-z0-9]+/).filter(Boolean);
  return words.length > 0 && words.every((word) => CHROME_WORDS.has(word));
}

function pageIdentity(page, index) {
  return text(page.route) || text(page.label) || `pagina #${index + 1}`;
}

function surfaceRow(base) {
  return {
    stable_key: base.stable_key,
    parent_stable_key: base.parent_stable_key,
    kind: base.kind,
    label: base.label,
    codebase_label: base.codebase_label,
    route_pattern: base.route_pattern,
    navigation_hint: base.navigation_hint,
    platforms: base.platforms,
    purpose: base.purpose,
    required_for_launch: base.required_for_launch,
    manual_importance: base.manual_importance,
    inventory_state: 'planned',
    inventory_origin: 'manual',
  };
}

/** Site map JSON → flat list of tt_ui_surfaces rows, pages before their sections. */
export function sitemapToSurfaces(sitemap) {
  if (!sitemap || !Array.isArray(sitemap.pages)) {
    throw new Error('sitemap.pages must be an array');
  }
  const codebase = codebaseFor(sitemap);
  const platforms = platformsFor(sitemap.platform);
  const rows = [];
  sitemap.pages.forEach((page, index) => {
    const route = text(page.route);
    const label = text(page.label) || route;
    if (!label) throw new Error(`${pageIdentity(page, index)}: page needs a label or a route`);
    const pageKey = stableSurfaceKey({
      codebase,
      kind: 'page',
      route_pattern: route,
      navigation_key: text(page.navigation_key),
      label,
    });
    const pageRequired = Boolean(page.required_for_launch);
    rows.push(surfaceRow({
      stable_key: pageKey,
      parent_stable_key: null,
      kind: 'page',
      label,
      codebase_label: codebase,
      route_pattern: route,
      navigation_hint: text(page.navigation_hint),
      platforms,
      purpose: text(page.purpose) || '',
      required_for_launch: pageRequired,
      manual_importance: importanceFor(page, pageRequired),
    }));
    for (const section of Array.isArray(page.sections) ? page.sections : []) {
      const sectionLabel = text(section.label);
      if (!sectionLabel) throw new Error(`${label}: every section needs a label`);
      const required = typeof section.required_for_launch === 'boolean'
        ? section.required_for_launch
        : pageRequired;
      rows.push(surfaceRow({
        stable_key: stableSurfaceKey({
          codebase,
          kind: 'section',
          label: sectionLabel,
          parent_stable_key: pageKey,
        }),
        parent_stable_key: pageKey,
        kind: 'section',
        label: sectionLabel,
        codebase_label: codebase,
        route_pattern: null,
        navigation_hint: text(section.navigation_hint),
        platforms,
        purpose: text(section.purpose) || '',
        required_for_launch: required,
        manual_importance: importanceFor(section, required),
      }));
    }
  });
  return rows;
}

/** Errors block the output; warnings go to stderr and let the human decide. */
export function validateSitemap(sitemap) {
  const errors = [];
  const warnings = [];
  if (!sitemap || !Array.isArray(sitemap.pages) || sitemap.pages.length === 0) {
    errors.push('pages: site map-ul nu are nicio pagină');
    return { errors, warnings };
  }
  const routes = new Map();
  const chrome = new Map();
  sitemap.pages.forEach((page, index) => {
    const where = pageIdentity(page, index);
    const route = text(page.route);
    if (!route && !text(page.label)) errors.push(`${where}: pagina are nevoie de label sau route`);
    if (route) {
      if (routes.has(route)) errors.push(`${route}: rută duplicată (apare și la „${routes.get(route)}")`);
      routes.set(route, text(page.label) || route);
    }
    if (!text(page.purpose)) {
      warnings.push(`${where}: lipsește purpose — scrie ce trebuie să facă pagina, în cuvintele omului`);
    }
    const labels = new Set();
    for (const section of Array.isArray(page.sections) ? page.sections : []) {
      const label = text(section.label);
      if (!label) {
        errors.push(`${where}: o secțiune nu are label`);
        continue;
      }
      const key = normalizeLabel(label);
      if (labels.has(key)) errors.push(`${where} › ${label}: secțiune duplicată pe aceeași pagină`);
      labels.add(key);
      if (!text(section.purpose)) warnings.push(`${where} › ${label}: lipsește purpose`);
      if (isChrome(label)) {
        if (!chrome.has(key)) chrome.set(key, { label, pages: [] });
        chrome.get(key).pages.push(where);
      }
    }
  });
  for (const { label, pages } of chrome.values()) {
    if (pages.length < 2) continue;
    warnings.push(
      `„${label}" apare pe ${pages.length} pagini (${pages.join(', ')}): chrome-ul partajat se `
      + 'inventariază o singură dată, ca unitate canonică pe pagina-hub a layout-ului '
      + '(de regulă „/"). Păstreaz-o pe hub și scoate-o de pe celelalte pagini.',
    );
  }
  if (errors.length === 0) {
    try {
      const seen = new Set();
      for (const row of sitemapToSurfaces(sitemap)) {
        if (seen.has(row.stable_key)) errors.push(`${row.stable_key}: cheie stabilă duplicată`);
        seen.add(row.stable_key);
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  return { errors, warnings };
}

function literal(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function textArray(values) {
  return `ARRAY[${values.map(literal).join(', ')}]::text[]`;
}

const PAGE_COLUMNS = [
  'project_id', 'stable_key', 'label', 'codebase_label', 'route_pattern', 'navigation_hint',
  'platforms', 'purpose', 'required_for_launch', 'manual_importance',
];
const SECTION_COLUMNS = [
  'project_id', 'parent_stable_key', 'stable_key', 'label', 'kind', 'codebase_label',
  'navigation_hint', 'platforms', 'purpose', 'required_for_launch', 'manual_importance',
];
const UPSERT = 'ON CONFLICT (project_id, stable_key) DO UPDATE\n'
  + '    SET purpose = EXCLUDED.purpose, navigation_hint = EXCLUDED.navigation_hint';

/**
 * One re-runnable statement: pages first, then sections whose parent_id comes
 * from the pages CTE (ON CONFLICT ... RETURNING yields ids for updated rows
 * too, so a second run resolves parents the same way).
 */
export function surfacesToSql(rows, projectId) {
  const id = Number(projectId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('--project-id must be a positive integer');
  const pages = rows.filter((row) => row.kind === 'page');
  const sections = rows.filter((row) => row.kind !== 'page');
  if (pages.length === 0) throw new Error('nothing to write: the site map has no pages');
  const pageValues = pages.map((row) => `(${[
    id, literal(row.stable_key), literal(row.label), literal(row.codebase_label),
    literal(row.route_pattern), literal(row.navigation_hint), textArray(row.platforms),
    literal(row.purpose), row.required_for_launch ? 'true' : 'false',
    literal(row.manual_importance),
  ].join(', ')})`);
  const sectionValues = sections.map((row) => `(${[
    id, literal(row.parent_stable_key), literal(row.stable_key), literal(row.label),
    literal(row.kind), literal(row.codebase_label), literal(row.navigation_hint),
    textArray(row.platforms), literal(row.purpose),
    row.required_for_launch ? 'true' : 'false', literal(row.manual_importance),
  ].join(', ')})`);
  const lines = [
    `-- /proiect-nou: site map → tt_ui_surfaces for project ${id} (re-runnable)`,
    'WITH pages AS (',
    '  INSERT INTO public.tt_ui_surfaces (',
    '    project_id, stable_key, label, kind, codebase_label, route_pattern, navigation_hint,',
    '    platforms, purpose, required_for_launch, manual_importance,',
    '    inventory_state, inventory_origin, inventory_fingerprint, code_refs',
    '  )',
    '  SELECT v.project_id, v.stable_key::text, v.label::text, \'page\', v.codebase_label::text,',
    '    v.route_pattern::text, v.navigation_hint::text, v.platforms, v.purpose::text,',
    '    v.required_for_launch, v.manual_importance::text,',
    '    \'planned\', \'manual\', NULL, \'{}\'::text[]',
    `  FROM (VALUES\n    ${pageValues.join(',\n    ')}\n  ) AS v(${PAGE_COLUMNS.join(', ')})`,
    `  ${UPSERT}`,
    '  RETURNING id, stable_key',
  ];
  if (sections.length > 0) {
    lines.push(
      '), sections AS (',
      '  INSERT INTO public.tt_ui_surfaces (',
      '    project_id, parent_id, stable_key, label, kind, codebase_label, navigation_hint,',
      '    platforms, purpose, required_for_launch, manual_importance,',
      '    inventory_state, inventory_origin, inventory_fingerprint, code_refs',
      '  )',
      '  SELECT v.project_id, p.id, v.stable_key::text, v.label::text, v.kind::text,',
      '    v.codebase_label::text, v.navigation_hint::text, v.platforms, v.purpose::text,',
      '    v.required_for_launch, v.manual_importance::text,',
      '    \'planned\', \'manual\', NULL, \'{}\'::text[]',
      `  FROM (VALUES\n    ${sectionValues.join(',\n    ')}\n  ) AS v(${SECTION_COLUMNS.join(', ')})`,
      '  JOIN pages p ON p.stable_key = v.parent_stable_key',
      `  ${UPSERT}`,
      '  RETURNING id, stable_key',
      ')',
      'SELECT kind, stable_key, id FROM (',
      '  SELECT \'page\' AS kind, stable_key, id FROM pages',
      '  UNION ALL',
      '  SELECT \'section\' AS kind, stable_key, id FROM sections',
      ') AS written ORDER BY kind, stable_key;',
    );
  } else {
    lines.push(')', 'SELECT \'page\' AS kind, stable_key, id FROM pages ORDER BY stable_key;');
  }
  return `${lines.join('\n')}\n`;
}

function cell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/**
 * The {{SITEMAP_PAGES}} blocks of docs/sitemap.md, in the format documented in
 * templates/README.md — rendered from the same rows that go into the database,
 * so the snapshot can never disagree with the keys the tracker holds.
 */
export function surfacesToMarkdown(rows) {
  const pages = rows.filter((row) => row.kind === 'page');
  if (pages.length === 0) throw new Error('nothing to render: the site map has no pages');
  const blocks = pages.map((page) => {
    const sections = rows.filter((row) => (
      row.kind !== 'page' && row.parent_stable_key === page.stable_key
    ));
    const lines = [
      `## ${cell(page.label)} — \`${page.route_pattern || page.stable_key}\``,
      '',
      `Stable key: \`${page.stable_key}\` · required for launch: **${page.required_for_launch ? 'yes' : 'no'}**`,
      '',
      `Purpose: ${cell(page.purpose) || '_lipsește_'}`,
      '',
    ];
    if (sections.length === 0) {
      lines.push('_Fără secțiuni încă._');
    } else {
      lines.push('| Section | Stable key | Purpose | Required |', '|---|---|---|---|');
      for (const section of sections) {
        lines.push(`| ${cell(section.label)} | \`${section.stable_key}\` | ${cell(section.purpose)} | ${section.required_for_launch ? 'yes' : 'no'} |`);
      }
    }
    return lines.join('\n');
  });
  return `${blocks.join('\n\n')}\n`;
}

function parseArgs(argv) {
  const args = { sql: false, markdown: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--sql') args.sql = true;
    else if (arg === '--markdown') args.markdown = true;
    else if (arg === '--input' || arg === '--project-id') {
      args[arg.slice(2).replace('-id', 'Id')] = argv[index + 1];
      index += 1;
    } else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return args;
}

function usage() {
  return 'Usage: sitemap-to-surfaces.mjs --input sitemap.json [--sql --project-id <id> | --markdown]\n'
    + '  stdout: JSON rows for tt_ui_surfaces; with --sql, one re-runnable INSERT statement;\n'
    + '          with --markdown, the {{SITEMAP_PAGES}} blocks for docs/sitemap.md.\n'
    + '  stderr: warnings (purpose lipsă, chrome repetat) and errors (exit 1).\n';
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  if (args.help || !args.input) {
    process.stderr.write(usage());
    process.exitCode = args.help ? 0 : 2;
    return;
  }
  const source = args.input === '-' ? '/dev/stdin' : args.input;
  const sitemap = JSON.parse(readFileSync(source === '/dev/stdin' ? 0 : source, 'utf8'));
  const { errors, warnings } = validateSitemap(sitemap);
  for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);
  for (const error of errors) process.stderr.write(`error: ${error}\n`);
  if (errors.length > 0) {
    process.exitCode = 1;
    return;
  }
  const rows = sitemapToSurfaces(sitemap);
  if (args.sql && args.markdown) {
    process.stderr.write('error: --sql and --markdown are two outputs; ask for one at a time\n');
    process.exitCode = 2;
    return;
  }
  if (args.markdown) {
    process.stdout.write(surfacesToMarkdown(rows));
    return;
  }
  if (args.sql) {
    if (!args.projectId) {
      process.stderr.write('error: --sql needs --project-id <id>\n');
      process.exitCode = 2;
      return;
    }
    process.stdout.write(surfacesToSql(rows, args.projectId));
    return;
  }
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
