import assert from 'node:assert/strict';
import { calibrateEstimate } from './calibrate-estimate.mjs';

assert.deepEqual(
  calibrateEstimate({
    baseLow: 1,
    baseHigh: 1.5,
    sampleItems: 5,
    p50HoursPerItem: 0.375,
    p75HoursPerItem: 0.5,
    appliedCorrectionFactor: 0.5,
  }),
  {
    estimate_low: 0.5,
    estimate_high: 0.75,
    calibration_used: true,
    sample_items: 5,
    applied_correction_factor: 0.5,
    complexity_multiplier: 1,
    historical_p50_hours: 0.375,
    historical_p75_hours: 0.5,
  },
);

const browserEstimate = calibrateEstimate({
  baseLow: 0.5,
  baseHigh: 1,
  sampleItems: 5,
  p50HoursPerItem: 0.375,
  p75HoursPerItem: 0.5,
  appliedCorrectionFactor: 0.5,
  browserRequired: true,
});
assert.equal(browserEstimate.estimate_low, 0.5);
assert.equal(browserEstimate.estimate_high, 0.75);
assert.equal(browserEstimate.complexity_multiplier, 1.25);

assert.deepEqual(
  calibrateEstimate({
    baseLow: 1,
    baseHigh: 2,
    sampleItems: 1,
    p50HoursPerItem: 0.25,
    p75HoursPerItem: 0.5,
    appliedCorrectionFactor: 0.25,
  }),
  {
    estimate_low: 1,
    estimate_high: 2,
    calibration_used: false,
    sample_items: 1,
    applied_correction_factor: 1,
    complexity_multiplier: 1,
  },
);

assert.throws(
  () => calibrateEstimate({ baseLow: 2, baseHigh: 1 }),
  /baseLow must not exceed baseHigh/,
);

console.log('plan-deadlines estimate calibration tests passed');
