#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DIMENSION_WEIGHTS = Object.freeze({
  layout_responsive: 25,
  consistency_design_system: 20,
  states_completeness: 20,
  usability_accessibility: 20,
  interaction_runtime: 15,
});

function normalize(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9/:*._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function stableSurfaceKey(surface) {
  const codebase = normalize(surface.codebase || surface.codebase_label || 'app');
  const kind = normalize(surface.kind || 'page');
  const identity = surface.route_pattern
    || surface.navigation_key
    || surface.label;
  if (!identity) throw new Error('surface route/navigation/label is required');
  const parent = surface.parent_stable_key ? `:${normalize(surface.parent_stable_key)}` : '';
  return `${codebase}:${kind}:${normalize(identity)}${parent}`;
}

export function findingFingerprint(finding) {
  const material = [
    finding.surface_stable_key,
    normalize(finding.category),
    normalize(finding.nature),
    normalize(finding.title),
    normalize(finding.verification),
  ].join('\n');
  return sha256(material);
}

export function fingerprintFiles(repoPath, files) {
  const root = resolve(repoPath);
  const unique = [...new Set(files)].sort();
  if (unique.length === 0) throw new Error('at least one relevant file is required');
  const hash = createHash('sha256');
  for (const requested of unique) {
    const absolute = resolve(root, requested);
    const rel = relative(root, absolute);
    if (!rel || rel.startsWith('..') || rel.split(sep).includes('node_modules')) {
      throw new Error(`unsafe fingerprint path: ${requested}`);
    }
    if (!existsSync(absolute)) throw new Error(`fingerprint file missing: ${requested}`);
    hash.update(rel.split(sep).join('/'));
    hash.update('\0');
    hash.update(readFileSync(absolute));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function scoreDimensions(dimensions) {
  let total = 0;
  for (const [key, weight] of Object.entries(DIMENSION_WEIGHTS)) {
    const value = dimensions?.[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error(`dimension ${key} must be a number from 0 to 100`);
    }
    total += value * weight;
  }
  return Math.round((total / 100) * 100) / 100;
}

function scenarioHasViewport(scenarios, pattern) {
  return scenarios.some((scenario) => pattern.test(JSON.stringify(scenario)));
}

export function validateAuditPayload(payload) {
  const errors = [];
  const surfaces = Array.isArray(payload?.surfaces) ? payload.surfaces : [];
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const findings = Array.isArray(payload?.findings) ? payload.findings : [];
  const keys = new Set();
  for (const surface of surfaces) {
    if (!surface.stable_key) errors.push('surface stable_key is required');
    if (keys.has(surface.stable_key)) errors.push(`duplicate surface ${surface.stable_key}`);
    keys.add(surface.stable_key);
    if (!['page', 'section', 'state'].includes(surface.kind)) {
      errors.push(`invalid surface kind for ${surface.stable_key}`);
    }
    if (surface.kind === 'page' && surface.parent_stable_key) {
      errors.push(`page ${surface.stable_key} cannot have parent`);
    }
    if (surface.kind !== 'page' && !surface.parent_stable_key) {
      errors.push(`child ${surface.stable_key} requires parent`);
    }
  }
  for (const surface of surfaces) {
    if (surface.parent_stable_key && !keys.has(surface.parent_stable_key)) {
      errors.push(`missing parent ${surface.parent_stable_key}`);
    }
  }
  const itemSurfaces = new Set();
  for (const item of items) {
    if (!keys.has(item.surface_stable_key)) {
      errors.push(`audit item has unknown surface ${item.surface_stable_key}`);
    }
    if (itemSurfaces.has(item.surface_stable_key)) {
      errors.push(`duplicate audit item ${item.surface_stable_key}`);
    }
    itemSurfaces.add(item.surface_stable_key);
    if (!['pass', 'needs_attention', 'blocked', 'static_only'].includes(item.audit_status)) {
      errors.push(`invalid audit status ${item.audit_status}`);
    }
    const hasScore = typeof item.ai_score === 'number' && Number.isFinite(item.ai_score);
    if (item.audit_status === 'blocked' || item.audit_status === 'static_only') {
      if (item.ai_score !== null) errors.push(`${item.audit_status} item must not have score`);
    } else {
      if (!hasScore) errors.push(`${item.audit_status} item requires score`);
      try {
        const calculated = scoreDimensions(item.dimensions);
        if (hasScore && Math.abs(calculated - item.ai_score) > 0.01) {
          errors.push(`score mismatch for ${item.surface_stable_key}: ${item.ai_score} != ${calculated}`);
        }
      } catch (error) {
        errors.push(`${item.surface_stable_key}: ${error.message}`);
      }
      const scenarios = Array.isArray(item.browser_scenarios) ? item.browser_scenarios : [];
      if (!scenarioHasViewport(scenarios, /1440|desktop/i)) {
        errors.push(`${item.surface_stable_key} missing 1440x900 browser scenario`);
      }
      if (!scenarioHasViewport(scenarios, /768|tablet/i)) {
        errors.push(`${item.surface_stable_key} missing 768x1024 browser scenario`);
      }
      if (!scenarioHasViewport(scenarios, /390|375|mobile|phone/i)) {
        errors.push(`${item.surface_stable_key} missing phone (375x812) browser scenario`);
      }
    }
  }
  for (const finding of findings) {
    if (!keys.has(finding.surface_stable_key)) {
      errors.push(`finding has unknown surface ${finding.surface_stable_key}`);
    }
    if (!['objective', 'subjective_suggestion'].includes(finding.nature)) {
      errors.push(`invalid finding nature ${finding.nature}`);
    }
    if (!['critical', 'high', 'medium', 'low'].includes(finding.severity)) {
      errors.push(`invalid finding severity ${finding.severity}`);
    }
    if (finding.nature === 'subjective_suggestion' && finding.blocks_launch === true) {
      errors.push(`subjective finding cannot block launch: ${finding.title}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function diffSurfaceInventories(previous, current) {
  const before = new Map(previous.map((surface) => [surface.stable_key, surface]));
  const after = new Map(current.map((surface) => [surface.stable_key, surface]));
  const result = { new: [], missing: [], changed: [], unchanged: [], reappeared: [] };
  for (const [key, surface] of after) {
    const old = before.get(key);
    if (!old) result.new.push(key);
    else if (old.inventory_state === 'missing') result.reappeared.push(key);
    else if (old.fingerprint !== surface.fingerprint) result.changed.push(key);
    else result.unchanged.push(key);
  }
  for (const key of before.keys()) {
    if (!after.has(key)) result.missing.push(key);
  }
  for (const values of Object.values(result)) values.sort();
  return result;
}

function parseArgs(argv) {
  const [action, ...rest] = argv;
  const args = { action };
  for (let index = 0; index < rest.length; index += 1) {
    if (!rest[index].startsWith('--')) continue;
    args[rest[index].slice(2)] = rest[index + 1];
    index += 1;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let result;
  if (args.action === 'stable-key') {
    result = { stable_key: stableSurfaceKey(JSON.parse(args.surface || '{}')) };
  } else if (args.action === 'finding-key') {
    result = { stable_key: findingFingerprint(JSON.parse(args.finding || '{}')) };
  } else if (args.action === 'fingerprint') {
    result = {
      fingerprint: fingerprintFiles(
        args.repo,
        String(args.files || '').split(',').map((value) => value.trim()).filter(Boolean),
      ),
    };
  } else if (args.action === 'validate') {
    const validation = validateAuditPayload(JSON.parse(readFileSync(args.input, 'utf8')));
    result = validation;
    if (!validation.valid) process.exitCode = 1;
  } else {
    process.stderr.write('Usage: audit-contract.mjs stable-key|finding-key|fingerprint|validate ...\n');
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
