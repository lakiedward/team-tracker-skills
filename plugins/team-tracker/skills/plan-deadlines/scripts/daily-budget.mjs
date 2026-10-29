#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DAY_MS = 24 * 60 * 60 * 1000;

function parseIsoDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    throw new Error(`${label} must use YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is not a valid date`);
  }
  return date;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function isWorkingDay(date) {
  const day = date.getUTCDay();
  return day !== 0 && day !== 6;
}

export function nextWorkingDay(today) {
  const date = parseIsoDate(today, 'today');
  while (!isWorkingDay(date)) date.setUTCDate(date.getUTCDate() + 1);
  return isoDate(date);
}

export function workingDaysInclusive(from, through) {
  const cursor = parseIsoDate(from, 'from');
  const end = parseIsoDate(through, 'through');
  if (cursor > end) return 0;

  let count = 0;
  while (cursor <= end) {
    if (isWorkingDay(cursor)) count += 1;
    cursor.setTime(cursor.getTime() + DAY_MS);
  }
  return count;
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function calculateDailyBudget({
  today,
  deadline,
  weeklyHours,
  remainingHours,
  parallelism = 1,
}) {
  const weekly = Number(weeklyHours);
  const remaining = Number(remainingHours);
  if (!Number.isFinite(weekly) || weekly <= 0) {
    throw new Error('weeklyHours must be positive');
  }
  if (!Number.isFinite(remaining) || remaining < 0) {
    throw new Error('remainingHours must be zero or positive');
  }
  const lanes = Number(parallelism);
  if (!Number.isFinite(lanes) || lanes < 1) {
    throw new Error('parallelism must be at least 1');
  }

  const planningDate = nextWorkingDay(today);
  const workingDaysLeft = workingDaysInclusive(planningDate, deadline);
  const deadlinePassed = workingDaysLeft === 0;
  const grossDailyHours = weekly / 5;
  const baseCommittedHours = grossDailyHours <= 1
    ? grossDailyHours
    : grossDailyHours - 1;
  // Remaining work is in agent hours; convert it to the human's clock before
  // comparing it with the profile, since parallel threads overlap.
  const requiredDailyHours = deadlinePassed ? null : remaining / lanes / workingDaysLeft;
  const committedTargetHours = deadlinePassed
    ? grossDailyHours
    : Math.min(grossDailyHours, Math.max(baseCommittedHours, requiredDailyHours));
  const bufferHours = Math.max(0, grossDailyHours - committedTargetHours);
  const bufferPercent = grossDailyHours > 0
    ? (bufferHours / grossDailyHours) * 100
    : 0;
  const overloadHoursPerDay = requiredDailyHours === null
    ? null
    : Math.max(0, requiredDailyHours - grossDailyHours);

  return {
    planning_contract_version: 2,
    planning_date: planningDate,
    working_days_left: workingDaysLeft,
    deadline_passed: deadlinePassed,
    gross_daily_hours: round(grossDailyHours),
    base_committed_hours: round(baseCommittedHours),
    committed_target_hours: round(committedTargetHours),
    target_hours: round(committedTargetHours),
    buffer_hours: round(bufferHours),
    buffer_percent: round(bufferPercent),
    required_daily_hours: requiredDailyHours === null ? null : round(requiredDailyHours),
    overload_hours_per_day: overloadHoursPerDay === null ? null : round(overloadHoursPerDay),
    overload_hours_per_week: overloadHoursPerDay === null
      ? null
      : round(overloadHoursPerDay * 5),
    // Every field above is the human's clock. The queue is packed in agent
    // hours, because estimates are calibrated on agent time and parallel
    // threads deliver more than one agent hour per clock hour.
    parallelism: round(lanes),
    agent_daily_hours: round(grossDailyHours * lanes),
    agent_committed_target_hours: round(committedTargetHours * lanes),
  };
}

function readArgument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function main() {
  const request = {
    today: readArgument('today'),
    deadline: readArgument('deadline'),
    weeklyHours: readArgument('weekly-hours'),
    remainingHours: readArgument('remaining-hours'),
  };
  const parallelism = readArgument('parallelism');
  if (Object.values(request).some((value) => value === null)) {
    process.stderr.write(
      'Usage: node daily-budget.mjs --today YYYY-MM-DD --deadline YYYY-MM-DD '
      + '--weekly-hours N --remaining-hours N [--parallelism N]\n',
    );
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${JSON.stringify(calculateDailyBudget({ ...request, parallelism: parallelism ?? 1 }), null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
