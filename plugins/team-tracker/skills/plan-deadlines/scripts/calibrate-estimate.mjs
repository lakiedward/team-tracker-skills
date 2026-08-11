#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function nonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function roundUpQuarter(value) {
  return Math.ceil((value - Number.EPSILON) * 4) / 4;
}

// The smallest unit Pontaj records, so a remaining estimate under it could not be
// checked against reality even if it were accurate.
const MIN_REMAINING_HOURS = 0.5;
// The mandatory tail scales with the item rather than being a constant, so the
// floor is a share. A quarter is a judgement call, written down as one.
const REMAINING_FLOOR_RATIO = 0.25;

// Hours already burned on an item that is still open are invisible to planning:
// tt_delivery_calibration samples only completed sources, so a half-finished item
// is queued at its full estimate and the day is booked for work partly done.
//
// Spent time counts as progress only when the tracker says work is actually in
// flight. Hours logged against an item that is not — an investigation, or an
// approach tried and dropped — are sunk, and the work left is unchanged.
// Subtracting those would under-book the day, which is the more expensive of the
// two mistakes here: over-estimating wastes some capacity, under-estimating
// breaks the commitment the daily budget exists to protect.
//
// Even a nearly finished item keeps a tail this flow makes mandatory: browser
// verification, a PR, a clean Bugbot review, the merge. The floor keeps that tail
// on the books instead of letting an item round down towards nothing.
function applySpentHours(low, high, spentHours, inFlight) {
  if (!inFlight || spentHours <= 0) {
    return { low, high, applied: false, floored: false };
  }
  const floorLow = Math.max(MIN_REMAINING_HOURS, low * REMAINING_FLOOR_RATIO);
  const floorHigh = Math.max(MIN_REMAINING_HOURS, high * REMAINING_FLOOR_RATIO);
  const remainingLow = Math.max(low - spentHours, floorLow);
  const remainingHigh = Math.max(high - spentHours, floorHigh);
  return {
    low: Math.min(remainingLow, remainingHigh),
    high: remainingHigh,
    applied: true,
    // Spent time has caught up with the estimate. The number stops being a
    // forecast at that point and becomes a signal that the item is overrunning.
    floored: high - spentHours < floorHigh,
  };
}

export function calibrateEstimate({
  baseLow,
  baseHigh,
  sampleItems = 0,
  p50HoursPerItem = null,
  p75HoursPerItem = null,
  appliedCorrectionFactor = 1,
  browserRequired = false,
  riskMultiplier = 1,
  spentHours = 0,
  inFlight = false,
}) {
  const low = positiveNumber(baseLow, 'baseLow');
  const high = positiveNumber(baseHigh, 'baseHigh');
  if (low > high) throw new Error('baseLow must not exceed baseHigh');

  const spent = nonNegativeNumber(spentHours, 'spentHours');
  const samples = nonNegativeInteger(sampleItems, 'sampleItems');
  const risk = positiveNumber(riskMultiplier, 'riskMultiplier');
  const verificationMultiplier = Math.max(
    1,
    browserRequired ? 1.25 : 1,
    risk,
  );
  const p50 = p50HoursPerItem === null
    ? null
    : positiveNumber(p50HoursPerItem, 'p50HoursPerItem');
  const p75 = p75HoursPerItem === null
    ? null
    : positiveNumber(p75HoursPerItem, 'p75HoursPerItem');
  const hasCalibration = samples >= 2 && p50 !== null && p75 !== null;

  if (!hasCalibration) {
    const remaining = applySpentHours(low, high, spent, inFlight);
    const uncalibratedHigh = roundUpQuarter(remaining.high);
    return {
      estimate_low: Math.min(roundUpQuarter(remaining.low), uncalibratedHigh),
      estimate_high: uncalibratedHigh,
      calibration_used: false,
      sample_items: samples,
      applied_correction_factor: 1,
      complexity_multiplier: verificationMultiplier,
      spent_hours: spent,
      spent_hours_applied: remaining.applied,
      remaining_floor_applied: remaining.floored,
    };
  }

  const factor = Math.max(
    0.25,
    Math.min(2, positiveNumber(appliedCorrectionFactor, 'appliedCorrectionFactor')),
  );
  const calibratedLow = Math.max(
    low * factor,
    p50 * verificationMultiplier,
  );
  const calibratedHigh = Math.max(
    high * factor,
    p75 * verificationMultiplier,
  );
  // Netting comes last. Calibration answers "how big is this kind of work"; the
  // spent hours answer "how much of this one is left", and only the second is
  // specific to the item in hand.
  const remaining = applySpentHours(calibratedLow, calibratedHigh, spent, inFlight);
  const estimateHigh = roundUpQuarter(remaining.high);

  return {
    estimate_low: Math.min(roundUpQuarter(remaining.low), estimateHigh),
    estimate_high: estimateHigh,
    calibration_used: true,
    sample_items: samples,
    applied_correction_factor: factor,
    complexity_multiplier: verificationMultiplier,
    historical_p50_hours: p50,
    historical_p75_hours: p75,
    spent_hours: spent,
    spent_hours_applied: remaining.applied,
    remaining_floor_applied: remaining.floored,
  };
}

function readArgument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function main() {
  const baseLow = readArgument('base-low');
  const baseHigh = readArgument('base-high');
  if (baseLow === null || baseHigh === null) {
    process.stderr.write(
      'Usage: node calibrate-estimate.mjs --base-low N --base-high N '
      + '[--sample-items N --p50-hours N --p75-hours N --factor N '
      + '--browser true|false --risk-multiplier N '
      + '--spent-hours N --in-flight true|false]\n',
    );
    process.exitCode = 2;
    return;
  }

  const browser = readArgument('browser');
  const inFlight = readArgument('in-flight');
  const result = calibrateEstimate({
    baseLow,
    baseHigh,
    sampleItems: readArgument('sample-items') ?? 0,
    p50HoursPerItem: readArgument('p50-hours'),
    p75HoursPerItem: readArgument('p75-hours'),
    appliedCorrectionFactor: readArgument('factor') ?? 1,
    browserRequired: browser === 'true',
    riskMultiplier: readArgument('risk-multiplier') ?? 1,
    spentHours: readArgument('spent-hours') ?? 0,
    inFlight: inFlight === 'true',
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
