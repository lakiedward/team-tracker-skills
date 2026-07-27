import assert from 'node:assert/strict';
import {
  bufferPercentFor,
  calculateDailyBudget,
  nextWorkingDay,
  workingDaysInclusive,
} from './daily-budget.mjs';

assert.equal(workingDaysInclusive('2026-07-27', '2026-08-02'), 5);
assert.equal(nextWorkingDay('2026-08-01'), '2026-08-03');
assert.equal(bufferPercentFor(16), 20);
assert.equal(bufferPercentFor(15), 10);
assert.equal(bufferPercentFor(5), 0);

assert.deepEqual(
  calculateDailyBudget({
    today: '2026-07-27',
    deadline: '2026-08-28',
    weeklyHours: 25,
    remainingHours: 50,
  }),
  {
    planning_date: '2026-07-27',
    working_days_left: 25,
    deadline_passed: false,
    gross_daily_hours: 5,
    buffer_percent: 20,
    buffered_daily_hours: 4,
    required_daily_hours: 2,
    target_hours: 4,
    overload_hours_per_day: 0,
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
assert.ok(pressured.overload_hours_per_day > 0);

const close = calculateDailyBudget({
  today: '2026-07-27',
  deadline: '2026-07-31',
  weeklyHours: 25,
  remainingHours: 10,
});
assert.equal(close.buffer_percent, 0);
assert.equal(close.target_hours, 5);

console.log('plan-deadlines daily budget tests passed');
