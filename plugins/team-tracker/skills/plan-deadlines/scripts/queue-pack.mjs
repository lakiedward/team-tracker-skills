#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EPSILON = 1e-9;
const QUARTER_HOUR = 0.25;

function round(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function floorToQuarter(value) {
  return Math.floor((value + EPSILON) / QUARTER_HOUR) * QUARTER_HOUR;
}

function ceilToQuarter(value) {
  return Math.ceil((value - EPSILON) / QUARTER_HOUR) * QUARTER_HOUR;
}

function positiveNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be positive`);
  }
  return parsed;
}

function nonNegativeNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be zero or positive`);
  }
  return parsed;
}

function normalizeCandidate(candidate, index) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error(`candidate ${index + 1} must be an object`);
  }
  const stableKey = String(candidate.stable_key || '').trim();
  if (!stableKey) throw new Error(`candidate ${index + 1} needs stable_key`);
  const low = positiveNumber(candidate.estimate_hours_low, `${stableKey}.estimate_hours_low`);
  const high = positiveNumber(candidate.estimate_hours_high, `${stableKey}.estimate_hours_high`);
  if (low > high) throw new Error(`${stableKey} low estimate cannot exceed high estimate`);

  return {
    ...candidate,
    stable_key: stableKey,
    estimate_hours_low: round(low),
    estimate_hours_high: round(high),
    dependencies: Array.isArray(candidate.dependencies) ? candidate.dependencies : [],
    dependency_ready: candidate.dependency_ready !== false,
    minimum_slice_hours: ceilToQuarter(
      positiveNumber(candidate.minimum_slice_hours ?? QUARTER_HOUR, `${stableKey}.minimum_slice_hours`),
    ),
    slice_completion_criterion: String(candidate.slice_completion_criterion || '').trim(),
  };
}

function sliceCandidate(candidate, availableHours) {
  const sliceHigh = floorToQuarter(Math.min(candidate.estimate_hours_high, availableHours));
  if (
    sliceHigh + EPSILON < candidate.minimum_slice_hours
    || !candidate.slice_completion_criterion
  ) {
    return null;
  }
  return {
    ...candidate,
    title: candidate.slice_title || candidate.title,
    estimate_hours_low: round(Math.min(candidate.estimate_hours_low, sliceHigh)),
    estimate_hours_high: round(sliceHigh),
    is_slice: true,
    full_estimate_hours_low: candidate.estimate_hours_low,
    full_estimate_hours_high: candidate.estimate_hours_high,
    completion_criterion: candidate.slice_completion_criterion,
  };
}

function packRole(candidates, targetHighHours, queueRole, sequenceStart) {
  const selected = [];
  const usedKeys = new Set();
  let selectedHigh = 0;

  for (const candidate of candidates) {
    if (!candidate.dependency_ready || usedKeys.has(candidate.stable_key)) continue;
    const remaining = targetHighHours - selectedHigh;
    if (remaining + EPSILON < QUARTER_HOUR) break;

    let selectedCandidate = null;
    if (candidate.estimate_hours_high <= remaining + EPSILON) {
      selectedCandidate = { ...candidate, is_slice: false };
    } else {
      selectedCandidate = sliceCandidate(candidate, remaining);
    }
    if (!selectedCandidate) continue;

    selected.push({
      ...selectedCandidate,
      queue_role: queueRole,
      sequence: sequenceStart + selected.length,
    });
    usedKeys.add(candidate.stable_key);
    selectedHigh += selectedCandidate.estimate_hours_high;
  }

  return {
    selected,
    usedKeys,
    selectedHigh: round(selectedHigh),
  };
}

function sum(items, field) {
  return round(items.reduce((total, item) => total + Number(item[field] || 0), 0));
}

export function packDailyQueues({
  grossHours,
  committedTargetHours,
  candidates,
}) {
  const gross = positiveNumber(grossHours, 'grossHours');
  const committedTarget = nonNegativeNumber(committedTargetHours, 'committedTargetHours');
  if (committedTarget > gross + EPSILON) {
    throw new Error('committedTargetHours cannot exceed grossHours');
  }
  if (!Array.isArray(candidates)) throw new Error('candidates must be an array');

  const normalized = candidates.map(normalizeCandidate);
  const keys = new Set();
  for (const candidate of normalized) {
    if (keys.has(candidate.stable_key)) {
      throw new Error(`duplicate stable_key: ${candidate.stable_key}`);
    }
    keys.add(candidate.stable_key);
  }

  const committedPack = packRole(normalized, committedTarget, 'committed', 1);
  const committed = committedPack.selected;
  const committedLow = sum(committed, 'estimate_hours_low');
  const committedHigh = sum(committed, 'estimate_hours_high');
  const reserveTarget = round(Math.max(0, gross - committedLow));
  const remainingCandidates = normalized.filter(
    (candidate) => !committedPack.usedKeys.has(candidate.stable_key),
  );
  const reservePack = packRole(
    remainingCandidates,
    reserveTarget,
    'reserve',
    committed.length + 1,
  );
  const reserve = reservePack.selected;
  const reserveLow = sum(reserve, 'estimate_hours_low');
  const reserveHigh = sum(reserve, 'estimate_hours_high');

  return {
    planning_contract_version: 2,
    gross_daily_hours: round(gross),
    committed_target_hours: round(committedTarget),
    committed_hours_low: committedLow,
    committed_hours_high: committedHigh,
    committed_count: committed.length,
    committed_gap_hours: round(Math.max(0, committedTarget - committedHigh)),
    reserve_target_hours: reserveTarget,
    reserve_hours_low: reserveLow,
    reserve_hours_high: reserveHigh,
    reserve_count: reserve.length,
    reserve_gap_hours: round(Math.max(0, reserveTarget - reserveHigh)),
    queue_hours_total_high: round(committedHigh + reserveHigh),
    committed,
    reserve,
    skipped_blocked_keys: normalized
      .filter((candidate) => !candidate.dependency_ready)
      .map((candidate) => candidate.stable_key),
    stop_rule: `Stop when actual logged work reaches ${round(gross)}h for the planning day.`,
  };
}

function readArgument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function main() {
  const candidatesFile = readArgument('candidates-file');
  const raw = candidatesFile
    ? readFileSync(resolve(candidatesFile), 'utf8')
    : readFileSync(0, 'utf8');
  const payload = JSON.parse(raw);
  const candidates = Array.isArray(payload) ? payload : payload.candidates;
  const result = packDailyQueues({
    grossHours: readArgument('gross-hours') ?? payload.gross_daily_hours,
    committedTargetHours: readArgument('committed-target-hours')
      ?? payload.committed_target_hours,
    candidates,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
