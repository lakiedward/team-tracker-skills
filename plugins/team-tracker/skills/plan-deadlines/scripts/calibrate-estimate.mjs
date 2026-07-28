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

export function calibrateEstimate({
  baseLow,
  baseHigh,
  sampleItems = 0,
  p50HoursPerItem = null,
  p75HoursPerItem = null,
  appliedCorrectionFactor = 1,
  browserRequired = false,
  riskMultiplier = 1,
}) {
  const low = positiveNumber(baseLow, 'baseLow');
  const high = positiveNumber(baseHigh, 'baseHigh');
  if (low > high) throw new Error('baseLow must not exceed baseHigh');

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
    return {
      estimate_low: roundUpQuarter(low),
      estimate_high: roundUpQuarter(high),
      calibration_used: false,
      sample_items: samples,
      applied_correction_factor: 1,
      complexity_multiplier: verificationMultiplier,
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
  const estimateHigh = roundUpQuarter(calibratedHigh);

  return {
    estimate_low: Math.min(roundUpQuarter(calibratedLow), estimateHigh),
    estimate_high: estimateHigh,
    calibration_used: true,
    sample_items: samples,
    applied_correction_factor: factor,
    complexity_multiplier: verificationMultiplier,
    historical_p50_hours: p50,
    historical_p75_hours: p75,
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
      + '--browser true|false --risk-multiplier N]\n',
    );
    process.exitCode = 2;
    return;
  }

  const browser = readArgument('browser');
  const result = calibrateEstimate({
    baseLow,
    baseHigh,
    sampleItems: readArgument('sample-items') ?? 0,
    p50HoursPerItem: readArgument('p50-hours'),
    p75HoursPerItem: readArgument('p75-hours'),
    appliedCorrectionFactor: readArgument('factor') ?? 1,
    browserRequired: browser === 'true',
    riskMultiplier: readArgument('risk-multiplier') ?? 1,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
