import assert from 'node:assert/strict';
import { agentCalibration, effectiveParallelism, measuredInterval } from './agent-pace.mjs';
import { calibrateEstimate } from './calibrate-estimate.mjs';

const AGENT = '[pontaj:basis=conversation_estimate]';
const HUMAN = '[pontaj:basis=human_declared]';

function row(id, day, hours, start, end, basis = AGENT) {
  return {
    id,
    project_id: 16,
    member: 'Edy',
    work_date: day,
    hours,
    description: `lucru\n[pontaj:interval=${day}T${start}:00.000Z/${day}T${end}:00.000Z]\n${basis}`,
  };
}

assert.equal(measuredInterval('fără marker'), null);
assert.deepEqual(
  measuredInterval('[pontaj:interval=2026-10-28T12:00:00.000Z/2026-10-28T13:00:00.000Z]'),
  { start: Date.parse('2026-10-28T12:00:00.000Z'), end: Date.parse('2026-10-28T13:00:00.000Z') },
);

// Shape of Motion 26–28.10.2026: parallel threads, each logging its own active
// time, so a day of 3.5–5.4 agent hours fits into 1.5–2.2 hours of clock.
const logs = [
  row(1, '2026-10-26', 0.75, '08:58', '10:10'),
  row(2, '2026-10-26', 0.55, '08:58', '09:59'),
  row(3, '2026-10-26', 0.42, '08:58', '09:58'),
  row(4, '2026-10-26', 0.57, '08:58', '09:58'),
  row(5, '2026-10-27', 0.85, '13:54', '15:02'),
  row(6, '2026-10-27', 0.95, '14:24', '15:23'),
  row(7, '2026-10-27', 0.65, '13:53', '14:49'),
  row(8, '2026-10-28', 0.85, '13:12', '14:13'),
  row(9, '2026-10-28', 1.1, '12:03', '13:25'),
  row(10, '2026-10-28', 0.6, '12:02', '12:46'),
  row(11, '2026-10-28', 0.55, '13:12', '13:51'),
  row(12, '2026-10-28', 3, '09:00', '12:00', HUMAN),
];

const pace = effectiveParallelism(logs);
assert.equal(pace.parallelism_measured, true);
assert.equal(pace.parallelism_days.length, 3);
assert.ok(pace.parallelism > 1.5 && pace.parallelism < 2.5, `parallelism ${pace.parallelism}`);
assert.ok(
  pace.parallelism_days.every((day) => day.day !== '2026-10-28' || day.agent_hours === 3.1),
  'human-declared rows never count as agent time',
);

assert.equal(effectiveParallelism(logs.slice(0, 4)).parallelism, 1, 'one day is not a measurement');
assert.equal(effectiveParallelism(logs.slice(0, 4)).parallelism_measured, false);

const links = [
  { work_log_id: 1, source_type: 'feature', source_id: 554, allocated_hours: 0.75, confidence: 'high' },
  { work_log_id: 2, source_type: 'todo', source_id: 212, allocated_hours: 0.55, confidence: 'high' },
  { work_log_id: 5, source_type: 'todo', source_id: 211, allocated_hours: 0.85, confidence: 'high' },
  { work_log_id: 6, source_type: 'feature', source_id: 443, allocated_hours: 0.95, confidence: 'high' },
  { work_log_id: 8, source_type: 'bug', source_id: 1283, allocated_hours: 0.85, confidence: 'high' },
  { work_log_id: 9, source_type: 'todo', source_id: 218, allocated_hours: 1.1, confidence: 'high' },
  { work_log_id: 10, source_type: 'feature', source_id: 580, allocated_hours: 0.6, confidence: 'high' },
  { work_log_id: 10, source_type: 'feature', source_id: 580, allocated_hours: 0.6, confidence: 'high' },
  { work_log_id: 11, source_type: 'bug', source_id: 1284, allocated_hours: 0.55, confidence: 'low' },
  { work_log_id: 12, source_type: 'bug', source_id: 1284, allocated_hours: 3, confidence: 'high' },
];
const completed = [
  ['feature', 554], ['todo', 212], ['todo', 211], ['feature', 443],
  ['bug', 1283], ['todo', 218], ['feature', 580], ['bug', 1284],
].map(([source_type, source_id]) => ({ source_type, source_id }));
const planned = [
  { plan_id: 175, source_type: 'feature', source_id: 554, estimate_hours_high: 3.5 },
  { plan_id: 175, source_type: 'todo', source_id: 212, estimate_hours_high: 1.5 },
  { plan_id: 179, source_type: 'todo', source_id: 211, estimate_hours_high: 2 },
  { plan_id: 179, source_type: 'feature', source_id: 443, estimate_hours_high: 2.5 },
  { plan_id: 180, source_type: 'bug', source_id: 1283, estimate_hours_high: 3 },
  { plan_id: 180, source_type: 'todo', source_id: 218, estimate_hours_high: 3 },
  { plan_id: 179, source_type: 'feature', source_id: 580, estimate_hours_high: 9 },
  { plan_id: 180, source_type: 'feature', source_id: 580, estimate_hours_high: 1 },
];

const calibration = agentCalibration({ work_logs: logs, links, completed_sources: completed, planned_items: planned });
assert.equal(calibration.calibration_basis, 'agent_measured');
assert.equal(calibration.source_types.feature.sample_items, 3);
assert.equal(calibration.source_types.feature.usable, true);
assert.equal(calibration.source_types.feature.p50_hours_per_item, 0.75, 'a duplicated link counts once');
assert.equal(calibration.source_types.bug.sample_items, 1, 'low-confidence and human rows are not agent samples');
assert.equal(calibration.agent_correction_pairs, 7);
assert.ok(
  calibration.agent_correction_sample.some((pair) => pair.stable_key === 'feature:580' && pair.planned_high === 1),
  'the latest plan estimate is the one compared',
);
assert.ok(calibration.agent_correction_factor > 0.25 && calibration.agent_correction_factor < 0.45);

// A 3h human-sized estimate becomes about one agent hour, which is what the
// measured sessions took, instead of staying at 3h behind a max().
const agent = calibrateEstimate({
  baseLow: 2,
  baseHigh: 3,
  calibrationBasis: 'agent_measured',
  appliedCorrectionFactor: calibration.agent_correction_factor,
  browserRequired: true,
});
assert.equal(agent.executor, 'agent');
assert.ok(agent.estimate_high <= 1.25 && agent.estimate_high >= 0.75, `agent high ${agent.estimate_high}`);
assert.ok(agent.estimate_low <= agent.estimate_high);

const typed = calibrateEstimate({
  baseLow: 2,
  baseHigh: 3,
  calibrationBasis: 'agent_measured',
  sampleItems: 3,
  p50HoursPerItem: 0.75,
  p75HoursPerItem: 0.85,
  riskMultiplier: 1.5,
});
assert.equal(typed.estimate_low, 1.25);
assert.equal(typed.estimate_high, 1.5);

const tiny = calibrateEstimate({
  baseLow: 0.25,
  baseHigh: 0.25,
  calibrationBasis: 'agent_measured',
  appliedCorrectionFactor: 0.01,
});
assert.equal(tiny.estimate_high, 0.25, 'an item never rounds down to nothing');
assert.equal(tiny.applied_correction_factor, 0.1);

assert.throws(() => calibrateEstimate({
  baseLow: 1,
  baseHigh: 2,
  calibrationBasis: 'agent_measured',
}), /agent_measured/);

console.log('plan-deadlines agent pace tests passed');
