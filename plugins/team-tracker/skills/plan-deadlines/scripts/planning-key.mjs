#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const NAMESPACE = 'team-tracker:plan-deadlines:v1';

export function planningKey(projectId, canonicalGapKey) {
  const normalized = String(canonicalGapKey)
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
  if (!Number.isInteger(Number(projectId)) || Number(projectId) <= 0 || !normalized) {
    throw new Error('projectId and canonicalGapKey are required');
  }

  const bytes = createHash('sha1')
    .update(`${NAMESPACE}:${Number(projectId)}:${normalized}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

function main() {
  const [projectId, ...keyParts] = process.argv.slice(2);
  if (!projectId || keyParts.length === 0) {
    process.stderr.write('Usage: node planning-key.mjs <project-id> <canonical-gap-key>\n');
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${planningKey(Number(projectId), keyParts.join(' '))}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
