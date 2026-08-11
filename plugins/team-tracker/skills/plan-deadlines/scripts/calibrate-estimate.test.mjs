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
    spent_hours: 0,
    spent_hours_applied: false,
    remaining_floor_applied: false,
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
    spent_hours: 0,
    spent_hours_applied: false,
    remaining_floor_applied: false,
  },
);

assert.throws(
  () => calibrateEstimate({ baseLow: 2, baseHigh: 1 }),
  /baseLow must not exceed baseHigh/,
);

// Hours burned on an item the tracker does not show as in flight are sunk: an
// investigation, or an approach tried and dropped. The work left is unchanged, so
// subtracting them would under-book the day.
const sunk = calibrateEstimate({
  baseLow: 2,
  baseHigh: 4,
  spentHours: 3,
  inFlight: false,
});
assert.equal(sunk.estimate_low, 2, 'a stalled item keeps its full estimate');
assert.equal(sunk.estimate_high, 4);
assert.equal(sunk.spent_hours, 3, 'the hours are still reported, just not applied');
assert.equal(sunk.spent_hours_applied, false);

// In flight means there is a branch with work on it, so the spent time bought
// progress and the item is cheaper to finish than to start.
const partlyDone = calibrateEstimate({
  baseLow: 2,
  baseHigh: 4,
  spentHours: 1,
  inFlight: true,
});
assert.equal(partlyDone.estimate_low, 1);
assert.equal(partlyDone.estimate_high, 3);
assert.equal(partlyDone.spent_hours_applied, true);
assert.equal(partlyDone.remaining_floor_applied, false);

// Browser verification, a PR, a clean Bugbot review and the merge are still owed
// however much of the build is done, so the remainder never rounds towards zero.
const overrun = calibrateEstimate({
  baseLow: 2,
  baseHigh: 4,
  spentHours: 5,
  inFlight: true,
});
assert.equal(overrun.estimate_high, 1, 'the floor is a quarter of the estimate');
assert.equal(overrun.estimate_low, 0.5, 'and never below the 0.5h Pontaj unit');
assert.equal(
  overrun.remaining_floor_applied,
  true,
  'spent time reaching the estimate is an overrun signal, not a forecast',
);
assert.ok(overrun.estimate_low <= overrun.estimate_high);

// A small item must not have its floor rounded up past its own remainder.
const tiny = calibrateEstimate({
  baseLow: 0.5,
  baseHigh: 0.5,
  spentHours: 10,
  inFlight: true,
});
assert.equal(tiny.estimate_low, 0.5);
assert.equal(tiny.estimate_high, 0.5);

// Netting applies after calibration: history sizes the kind of work, spent hours
// size what is left of this one.
const calibratedAndPartlyDone = calibrateEstimate({
  baseLow: 4,
  baseHigh: 8,
  sampleItems: 12,
  p50HoursPerItem: 1,
  p75HoursPerItem: 2,
  appliedCorrectionFactor: 1,
  spentHours: 2,
  inFlight: true,
});
assert.equal(calibratedAndPartlyDone.calibration_used, true);
assert.equal(calibratedAndPartlyDone.estimate_low, 2, '4 calibrated, less 2 spent');
assert.equal(calibratedAndPartlyDone.estimate_high, 6, '8 calibrated, less 2 spent');

assert.throws(
  () => calibrateEstimate({ baseLow: 1, baseHigh: 2, spentHours: -1 }),
  /spentHours must be zero or positive/,
);

console.log('plan-deadlines estimate calibration tests passed');
