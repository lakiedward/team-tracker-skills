#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeWorkLogs } from '../../pontaj/scripts/work-log-basis.mjs';

// Values come from fresh tracker reads, never from estimates of completed work.
export function dailyBudget(input) {
  const { mode, planning_date, previous_date, day_limit_hours,
    extra_hours = 0, extra_authorized = false } = input;
  let time;
  if (input.work_logs !== undefined) {
    if (!Array.isArray(input.work_logs)) throw Error('Fresh work log rows required');
    for (const log of input.work_logs) {
      if (log.work_date !== planning_date || log.member !== input.member) throw Error('Same-day work logs for the verified member required');
    }
    if (!input.member?.trim()) throw Error('Verified member required');
    time = summarizeWorkLogs(input.work_logs);
    // An empty ledger is not an explicit declaration of zero human work.
    if (!input.work_logs.length) time.requires_reconciliation = true;
    if (input.spent_hours !== undefined) throw Error('Use work_logs or reconciled spent_hours, not both');
  } else {
    if (input.spent_hours_basis !== 'human_declared') throw Error('Spent hours must be explicitly human-declared or reconciled');
    time = { human_declared_hours: input.spent_hours, conversation_estimate_hours: 0, unspecified_hours: 0, requires_reconciliation: false };
  }
  const spent_hours = time.human_declared_hours;
  const declaredAvailable = input.available_hours_declared;
  if (declaredAvailable !== undefined && (typeof declaredAvailable !== 'number' || !Number.isFinite(declaredAvailable) || declaredAvailable < 0 || declaredAvailable > 24)) throw Error('Invalid declared available hours');
  if (!['new_day', 'continue_day', 'extra_budget', 'close_day'].includes(mode)) throw Error('Unknown planning mode');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(planning_date)) throw Error('Explicit local planning date required');
  if (mode !== 'new_day' && previous_date !== planning_date) throw Error('Same-day baseline required');
  if (mode === 'new_day' && previous_date === planning_date) throw Error('Existing day requires continuation, not a fresh budget');
  if (![day_limit_hours, spent_hours, extra_hours].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)) throw Error('Verified capacity and spent hours required');
  if (extra_hours && (mode !== 'extra_budget' || !extra_authorized)) throw Error('Extra hours require explicit authorization');
  if (mode === 'extra_budget' && (!extra_authorized || extra_hours <= 0)) throw Error('Positive authorized extra budget required');
  const baselineLimit = declaredAvailable === undefined ? day_limit_hours : spent_hours + declaredAvailable;
  const limit = mode === 'extra_budget' ? Math.max(baselineLimit, spent_hours) + extra_hours : baselineLimit;
  if (limit > 24 || spent_hours > 24) throw Error('Invalid daily hours');
  const requires_reconciliation = time.requires_reconciliation && declaredAvailable === undefined;
  const remaining = mode === 'close_day' || requires_reconciliation ? 0
    : declaredAvailable !== undefined ? declaredAvailable + extra_hours : Math.max(0, limit - spent_hours);
  return {
    replan_mode: mode, planning_date, spent_hours_at_planning: spent_hours,
    spent_hours_basis: 'human_declared',
    conversation_estimate_hours_at_planning: time.conversation_estimate_hours,
    unspecified_hours_at_planning: time.unspecified_hours,
    requires_reconciliation,
    available_hours_declared: declaredAvailable ?? null,
    day_stop_hours: limit, extra_authorized_hours: extra_hours,
    gross_daily_hours: remaining,
    committed_target_hours: remaining <= 1 ? remaining : remaining - 1,
    closed: mode === 'close_day',
  };
}

// Reuse only a complete, clean, same-day inventory of exactly the same repo.
// Dirty snapshots are not content hashes; two dirty states can share filenames.
export function inventoryDecision(previous, current, date) {
  const reusable = previous && current
    && previous.planning_date === date
    && previous.repo_path === current.repo_path
    && previous.registry_fingerprint === current.registry_fingerprint
    && previous.instructions_fingerprint === current.instructions_fingerprint
    && typeof current.registry_fingerprint === 'string' && !!current.registry_fingerprint
    && typeof current.instructions_fingerprint === 'string' && !!current.instructions_fingerprint
    && previous.complete === true && current.status_verified === true
    && previous.dirty === false && current.dirty === false
    && !!previous.head_sha && previous.head_sha === current.head_sha;
  return { scan: reusable ? 'reuse' : 'full', refresh_tracker: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    console.log(JSON.stringify({ budget: dailyBudget(input), repositories: (input.repositories || []).map(r => ({
      repo_path: r.current.repo_path, ...inventoryDecision(r.previous, r.current, input.planning_date),
    })) }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
