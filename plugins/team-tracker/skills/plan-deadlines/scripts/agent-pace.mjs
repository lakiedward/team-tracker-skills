#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workLogBasis } from '../../pontaj/scripts/work-log-basis.mjs';

const HOUR_MS = 60 * 60 * 1000;
const MIN_PACE_DAYS = 3;
const MIN_FACTOR_PAIRS = 3;
const MIN_TYPE_SAMPLES = 3;
const MAX_PARALLELISM = 4;
const DEFAULT_MAX_THREADS = 4;

function round(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

// The row's interval marker is the only measured clock the ledger carries.
// Rows without it say how long the agent was active, not when.
export function measuredInterval(description) {
  const match = String(description ?? '').match(/\[pontaj:interval=([^/\]]+)\/([^\]]+)\]/);
  if (!match) return null;
  const start = Date.parse(match[1]);
  const end = Date.parse(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

function unionHours(intervals) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let total = 0;
  let current = null;
  for (const interval of sorted) {
    if (!current || interval.start > current.end) {
      if (current) total += current.end - current.start;
      current = { ...interval };
    } else {
      current.end = Math.max(current.end, interval.end);
    }
  }
  if (current) total += current.end - current.start;
  return total / HOUR_MS;
}

function agentRows(workLogs) {
  if (!Array.isArray(workLogs)) throw new Error('work_logs must be an array');
  const seen = new Map();
  for (const log of workLogs) {
    if (!Number.isSafeInteger(log.id)) throw new Error('Verified work log ID required');
    const hours = Number(log.hours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) throw new Error(`Invalid hours on work log ${log.id}`);
    if (workLogBasis(log) !== 'conversation_estimate') continue;
    if (!seen.has(log.id)) seen.set(log.id, { ...log, hours });
  }
  return [...seen.values()];
}

// How many agent-hours one hour of the human's clock delivers. Parallel threads
// overlap and each excludes its own waits, so the sum of their hours divided by
// the union of their intervals is the conversion the daily budget needs.
//
// That ratio describes the days as they were run. Under the conveyor the number
// of threads is chosen, so the planner needs what one thread delivers per hour
// of its own window: thread utilization, the agent hours over the summed
// interval lengths. Lanes for the conveyor are max_threads times that.
export function effectiveParallelism(workLogs, { maxParallelism = MAX_PARALLELISM, maxThreads = DEFAULT_MAX_THREADS } = {}) {
  const threads = Number(maxThreads);
  if (!Number.isInteger(threads) || threads < 1 || threads > 8) throw new Error('max_threads must be an integer between 1 and 8');
  const byDay = new Map();
  for (const log of agentRows(workLogs)) {
    const interval = measuredInterval(log.description);
    if (!interval) continue;
    const key = `${log.project_id ?? ''}|${log.work_date}`;
    if (!byDay.has(key)) byDay.set(key, { hours: 0, intervals: [] });
    const day = byDay.get(key);
    day.hours += log.hours;
    day.intervals.push(interval);
  }
  const measuredDays = [...byDay.entries()].map(([key, day]) => ({
    day: key.split('|')[1],
    agent_hours: round(day.hours),
    clock_hours: round(unionHours(day.intervals)),
    window_hours: round(day.intervals.reduce((total, interval) => total + (interval.end - interval.start), 0) / HOUR_MS),
    rows: day.intervals.length,
  }));
  const days = measuredDays
    .filter((day) => day.rows >= 2 && day.clock_hours >= 0.25)
    .map(({ window_hours: _window, ...day }) => ({ ...day, ratio: round(day.agent_hours / day.clock_hours) }));
  const median = quantile(days.map((day) => day.ratio), 0.5);
  const usable = days.length >= MIN_PACE_DAYS && median !== null;
  const parallelism = usable ? round(Math.min(maxParallelism, Math.max(1, median))) : 1;

  const utilizationDays = measuredDays
    .filter((day) => day.window_hours >= 0.25)
    .map((day) => ({ day: day.day, agent_hours: day.agent_hours, window_hours: day.window_hours,
      utilization: round(Math.min(1, day.agent_hours / day.window_hours)) }));
  const utilization = quantile(utilizationDays.map((day) => day.utilization), 0.5);
  const utilizationUsable = utilizationDays.length >= MIN_PACE_DAYS && utilization !== null;
  return {
    parallelism,
    parallelism_measured: usable,
    parallelism_days: days,
    max_threads: threads,
    thread_utilization: utilizationUsable ? round(utilization) : null,
    thread_utilization_measured: utilizationUsable,
    // Without a measured utilization the historical parallelism is the only
    // honest number; the conveyor and the 1.5x queue absorb the difference.
    conveyor_parallelism: utilizationUsable
      ? round(Math.max(1, Math.min(threads, threads * utilization)))
      : parallelism,
  };
}

function sourceKey(sourceType, sourceId) {
  return `${sourceType}:${sourceId}`;
}

// Agent hours per completed source, allocated across a session's links so a
// multi-item session is never counted in full against each item.
export function agentHoursBySource(workLogs, links) {
  if (!Array.isArray(links)) throw new Error('links must be an array');
  const agentIds = new Set(agentRows(workLogs).map((log) => log.id));
  const seen = new Set();
  const totals = new Map();
  for (const link of links) {
    if (!agentIds.has(link.work_log_id)) continue;
    if (link.confidence && link.confidence !== 'high') continue;
    const allocated = Number(link.allocated_hours);
    if (!Number.isFinite(allocated) || allocated <= 0) continue;
    const key = sourceKey(link.source_type, link.source_id);
    const identity = `${link.work_log_id}|${key}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const entry = totals.get(key) ?? { source_type: link.source_type, source_id: link.source_id, hours: 0 };
    entry.hours += allocated;
    totals.set(key, entry);
  }
  return totals;
}

function snapshotOf(plan) {
  const snapshot = plan?.velocity_snapshot;
  if (typeof snapshot === 'string') {
    try { return JSON.parse(snapshot); } catch { return {}; }
  }
  return snapshot && typeof snapshot === 'object' ? snapshot : {};
}

function positive(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// The factor must compare measured time with the code-evidence estimate it will
// be applied to. Plans since 1.49.0 store the calibrated estimate, so comparing
// against it measures only the leftover error and can never converge. From
// 1.50.0 the plan keeps the raw estimate in velocity_snapshot.raw_estimates; a
// 1.49.0 plan is undone through the factor it recorded; older plans stored raw.
function rawPlannedHigh(item, plans) {
  const direct = positive(item.raw_estimate_hours_high);
  if (direct) return { high: direct, basis: 'raw' };
  const stored = positive(item.estimate_hours_high);
  const snapshot = snapshotOf(plans.get(Number(item.plan_id)));
  const key = sourceKey(item.source_type, item.source_id);
  const raw = Array.isArray(snapshot.raw_estimates)
    ? snapshot.raw_estimates.find((entry) => entry?.stable_key === (item.stable_key ?? key)
      || sourceKey(entry?.source_type, entry?.source_id) === key)
    : null;
  const rawHigh = positive(raw?.raw_estimate_hours_high);
  if (rawHigh) return { high: rawHigh, basis: 'raw' };
  if (!stored) return null;
  const applied = positive(snapshot.agent_calibration?.agent_correction_factor);
  if (applied) return { high: stored / applied, basis: 'derived_from_applied_factor' };
  return { high: stored, basis: 'stored' };
}

export function agentCalibration({
  work_logs: workLogs,
  links,
  completed_sources: completed = [],
  planned_items: planned = [],
  plans: planRows = [],
  max_threads: maxThreads = DEFAULT_MAX_THREADS,
  planning_date: planningDate = null,
}) {
  const totals = agentHoursBySource(workLogs, links);
  const completedKeys = new Set(completed.map((source) => sourceKey(source.source_type, source.source_id)));
  if (!Array.isArray(planRows)) throw new Error('plans must be an array');
  const plans = new Map(planRows.map((plan) => [Number(plan.id), plan]));

  const byType = {};
  for (const entry of totals.values()) {
    if (!completedKeys.has(sourceKey(entry.source_type, entry.source_id))) continue;
    (byType[entry.source_type] ??= []).push(entry.hours);
  }
  const sourceTypes = Object.fromEntries(Object.entries(byType).map(([type, hours]) => [type, {
    sample_items: hours.length,
    usable: hours.length >= MIN_TYPE_SAMPLES,
    p50_hours_per_item: round(quantile(hours, 0.5)),
    p75_hours_per_item: round(quantile(hours, 0.75)),
  }]));

  // Raw planned estimate versus measured agent time on the same completed
  // source. The latest plan's estimate wins, so a re-estimated item is compared once.
  const latestPlanned = new Map();
  for (const item of planned) {
    const key = sourceKey(item.source_type, item.source_id);
    const raw = rawPlannedHigh(item, plans);
    if (!raw) continue;
    const previous = latestPlanned.get(key);
    if (!previous || Number(item.plan_id) > Number(previous.plan_id)) {
      latestPlanned.set(key, { ...item, high: raw.high, basis: raw.basis });
    }
  }
  const pairs = [];
  for (const [key, item] of latestPlanned) {
    const actual = totals.get(key);
    if (!actual || !completedKeys.has(key)) continue;
    pairs.push({
      stable_key: key,
      planned_high: round(item.high),
      planned_basis: item.basis,
      agent_hours: round(actual.hours),
      ratio: actual.hours / item.high,
    });
  }
  const factor = quantile(pairs.map((pair) => pair.ratio), 0.5);
  const factorUsable = pairs.length >= MIN_FACTOR_PAIRS && factor !== null;
  const basisCounts = pairs.reduce((counts, pair) => ({ ...counts, [pair.planned_basis]: (counts[pair.planned_basis] ?? 0) + 1 }), {});

  return {
    calibration_basis: 'agent_measured',
    planning_date: planningDate,
    source_types: sourceTypes,
    agent_correction_factor: factorUsable ? round(factor) : null,
    agent_correction_pairs: pairs.length,
    agent_correction_pair_bases: basisCounts,
    agent_correction_sample: pairs.map((pair) => ({ ...pair, ratio: round(pair.ratio) })),
    ...effectiveParallelism(workLogs, { maxThreads }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    process.stdout.write(`${JSON.stringify(agentCalibration(input), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
