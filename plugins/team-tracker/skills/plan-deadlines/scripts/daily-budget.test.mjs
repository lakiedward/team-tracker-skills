import assert from 'node:assert/strict';
import {
  calculateDailyBudget,
  nextWorkingDay,
  workingDaysInclusive,
} from './daily-budget.mjs';

assert.equal(workingDaysInclusive('2026-07-27', '2026-08-02'), 5);
assert.equal(nextWorkingDay('2026-08-01'), '2026-08-03');

assert.deepEqual(
  calculateDailyBudget({
    today: '2026-07-27',
    deadline: '2026-08-28',
    weeklyHours: 25,
    remainingHours: 50,
  }),
  {
    planning_contract_version: 2,
    planning_date: '2026-07-27',
    working_days_left: 25,
    deadline_passed: false,
    gross_daily_hours: 5,
    base_committed_hours: 4,
    committed_target_hours: 4,
    target_hours: 4,
    buffer_hours: 1,
    buffer_percent: 20,
    required_daily_hours: 2,
    overload_hours_per_day: 0,
    overload_hours_per_week: 0,
  },
);

const pressured = calculateDailyBudget({
  today: '2026-07-27',
  deadline: '2026-09-01',
  weeklyHours: 25,
  remainingHours: 287,
});
assert.equal(pressured.gross_daily_hours, 5);
assert.equal(pressured.target_hours, 5);
assert.equal(pressured.committed_target_hours, 5);
assert.equal(pressured.buffer_hours, 0);
assert.ok(pressured.overload_hours_per_day > 0);

const close = calculateDailyBudget({
  today: '2026-07-27',
  deadline: '2026-07-31',
  weeklyHours: 25,
  remainingHours: 10,
});
assert.equal(close.target_hours, 4);
assert.equal(close.buffer_percent, 20);

const shortDay = calculateDailyBudget({
  today: '2026-07-27',
  deadline: '2026-08-28',
  weeklyHours: 4,
  remainingHours: 1,
});
assert.equal(shortDay.gross_daily_hours, 0.8);
assert.equal(shortDay.base_committed_hours, 0.8);
assert.equal(shortDay.committed_target_hours, 0.8);
assert.equal(shortDay.buffer_hours, 0);

console.log('plan-deadlines daily budget tests passed');
