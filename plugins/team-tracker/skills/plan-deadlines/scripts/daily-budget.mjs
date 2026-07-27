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

export function bufferPercentFor(workingDaysLeft) {
  if (workingDaysLeft <= 5) return 0;
  if (workingDaysLeft <= 15) return 10;
  return 20;
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function calculateDailyBudget({
  today,
  deadline,
  weeklyHours,
  remainingHours,
}) {
  const weekly = Number(weeklyHours);
  const remaining = Number(remainingHours);
  if (!Number.isFinite(weekly) || weekly <= 0) {
    throw new Error('weeklyHours must be positive');
  }
  if (!Number.isFinite(remaining) || remaining < 0) {
    throw new Error('remainingHours must be zero or positive');
  }

  const planningDate = nextWorkingDay(today);
  const workingDaysLeft = workingDaysInclusive(planningDate, deadline);
  const deadlinePassed = workingDaysLeft === 0;
  const grossDailyHours = weekly / 5;
  const bufferPercent = bufferPercentFor(workingDaysLeft);
  const bufferedDailyHours = grossDailyHours * (1 - bufferPercent / 100);
  const requiredDailyHours = deadlinePassed ? null : remaining / workingDaysLeft;
  const targetHours = deadlinePassed
    ? grossDailyHours
    : Math.min(grossDailyHours, Math.max(bufferedDailyHours, requiredDailyHours));
  const overloadHoursPerDay = requiredDailyHours === null
    ? null
    : Math.max(0, requiredDailyHours - grossDailyHours);

  return {
    planning_date: planningDate,
    working_days_left: workingDaysLeft,
    deadline_passed: deadlinePassed,
    gross_daily_hours: round(grossDailyHours),
    buffer_percent: bufferPercent,
    buffered_daily_hours: round(bufferedDailyHours),
    required_daily_hours: requiredDailyHours === null ? null : round(requiredDailyHours),
    target_hours: round(targetHours),
    overload_hours_per_day: overloadHoursPerDay === null ? null : round(overloadHoursPerDay),
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
  if (Object.values(request).some((value) => value === null)) {
    process.stderr.write(
      'Usage: node daily-budget.mjs --today YYYY-MM-DD --deadline YYYY-MM-DD '
      + '--weekly-hours N --remaining-hours N\n',
    );
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${JSON.stringify(calculateDailyBudget(request), null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
