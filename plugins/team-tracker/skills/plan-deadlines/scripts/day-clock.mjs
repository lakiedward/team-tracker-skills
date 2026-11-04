#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A plan of N hours is a clock contract: it runs until the moment it was applied
// plus N hours, and the conveyor keeps threads busy until then. The queue's size
// no longer decides when the day ends; an empty queue is refilled from the next
// source in CONVEYOR_ORDER.

const HOUR_MS = 60 * 60 * 1000;
const EPSILON = 1e-9;
const TIME_ZONE = 'Europe/Bucharest';
export const DEFAULT_MAX_THREADS = 4;
const MAX_THREADS_LIMIT = 8;
const WAKE_MINUTES = 30;
const DEFAULT_ITEM_HOURS = 0.5;
export const DEFAULT_CARD_BATCHES = ['12:00', '15:00', '18:00'];
export const CONVEYOR_ORDER = ['committed', 'reserve', 'next_days', 'reservoir'];

function round(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function instant(value, label) {
  const parsed = Date.parse(value);
  if (typeof value !== 'string' || !Number.isFinite(parsed)) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return parsed;
}

function maxThreads(value) {
  const parsed = Number(value ?? DEFAULT_MAX_THREADS);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_THREADS_LIMIT) {
    throw new Error(`max_threads must be an integer between 1 and ${MAX_THREADS_LIMIT}`);
  }
  return parsed;
}

function zonedParts(ms, timeZone = TIME_ZONE) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    utcGuess: Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second),
    ),
  };
}

// Local wall time to an instant, correct across the DST switch.
function zonedInstant(date, time, timeZone = TIME_ZONE) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wall;
  for (let pass = 0; pass < 2; pass += 1) {
    const offset = zonedParts(guess, timeZone).utcGuess - guess;
    guess = wall - offset;
  }
  return guess;
}

function localLabel(ms) {
  const { date, time } = zonedParts(ms);
  return `${date} ${time}`;
}

function nextLocalDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

export function dayEndAt({ applied_at: appliedAt, hours }) {
  const start = instant(appliedAt, 'applied_at');
  const clockHours = Number(hours);
  if (!Number.isFinite(clockHours) || clockHours <= 0 || clockHours > 24) {
    throw new Error('hours must be between 0 and 24');
  }
  const end = start + clockHours * HOUR_MS;
  return {
    applied_at: new Date(start).toISOString(),
    clock_hours: clockHours,
    day_end_at: new Date(end).toISOString(),
    day_end_local: localLabel(end),
    crosses_midnight: zonedParts(start).date !== zonedParts(end).date,
    time_zone: TIME_ZONE,
  };
}

// The next fixed moment at which merge/publish cards are put to the human
// together. Cards collected after the last batch go out with the day-end report.
export function nextCardBatch({ now, day_end_at: dayEnd, batches = DEFAULT_CARD_BATCHES }) {
  const nowMs = instant(now, 'now');
  const endMs = instant(dayEnd, 'day_end_at');
  if (!Array.isArray(batches) || batches.some((time) => !/^\d{2}:\d{2}$/.test(time))) {
    throw new Error('batches must be HH:MM local times');
  }
  const today = zonedParts(nowMs).date;
  const candidates = [today, nextLocalDate(today)]
    .flatMap((date) => batches.map((time) => zonedInstant(date, time)))
    .filter((ms) => ms > nowMs + EPSILON && ms < endMs)
    .sort((a, b) => a - b);
  const at = candidates[0] ?? endMs;
  return {
    at: new Date(at).toISOString(),
    at_local: localLabel(at),
    with_day_end_report: candidates.length === 0,
  };
}

function itemKey(item, label) {
  const key = String(item?.stable_key ?? '').trim();
  if (!key) throw new Error(`${label} needs stable_key`);
  return key;
}

function keySet(list, label) {
  if (!Array.isArray(list)) throw new Error(`${label} must be an array`);
  return new Set(list.map((entry) => (typeof entry === 'string' ? entry : itemKey(entry, label))));
}

const NEW_WORK_CARD_ITEMS = 4;
const NEW_WORK_QUESTION = 'Vrei să mă apuc de asta?';

function cardItem(item, key) {
  const title = String(item.title ?? '').trim();
  return {
    stable_key: key,
    title: title || key,
    estimate_hours_low: Number(item.estimate_hours_low ?? DEFAULT_ITEM_HOURS),
    estimate_hours_high: Number(item.estimate_hours_high ?? item.estimate_hours_low ?? DEFAULT_ITEM_HOURS),
    approved_by: String(item.approved_by).trim(),
  };
}

function idleReason(humanCount, tooLongCount) {
  if (humanCount) return 'only_human_work_left';
  if (tooLongCount) return 'remaining_items_exceed_clock';
  return 'no_executable_work';
}

// What the coordinator starts now. A thread that finished its agent part and
// waits for a merge or verdict card frees its slot: the card is batched, the
// thread does not hold the conveyor.
export function conveyorNext({
  now,
  day_end_at: dayEnd,
  max_threads: threadsInput,
  running = [],
  waiting_on_human: waiting = [],
  done_keys: done = [],
  blocked_keys: blocked = [],
  queues = {},
  stop_requested: stopRequested = false,
  card_batches: batches = DEFAULT_CARD_BATCHES,
  proposed_keys: proposed = [],
  declined_keys: declined = [],
  no_new_work: noNewWork = false,
}) {
  const nowMs = instant(now, 'now');
  const endMs = instant(dayEnd, 'day_end_at');
  const threads = maxThreads(threadsInput);
  if (!queues || typeof queues !== 'object' || Array.isArray(queues)) {
    throw new Error('queues must be an object');
  }
  const unknown = Object.keys(queues).filter((role) => !CONVEYOR_ORDER.includes(role));
  if (unknown.length) throw new Error(`unknown queue: ${unknown.join(', ')}`);

  const runningKeys = keySet(running, 'running');
  const waitingKeys = keySet(waiting, 'waiting_on_human');
  const proposedKeys = keySet(proposed, 'proposed_keys');
  const excluded = new Set([
    ...runningKeys, ...waitingKeys, ...keySet(done, 'done_keys'), ...keySet(blocked, 'blocked_keys'),
    ...keySet(declined, 'declined_keys'),
  ]);
  const remainingHours = Math.max(0, (endMs - nowMs) / HOUR_MS);
  const base = {
    now: new Date(nowMs).toISOString(),
    day_end_at: new Date(endMs).toISOString(),
    day_end_local: localLabel(endMs),
    clock_hours_left: round(remainingHours),
    max_threads: threads,
    running_count: runningKeys.size,
    waiting_on_human_count: waitingKeys.size,
  };

  if (stopRequested) {
    return { ...base, continue: false, reason: 'stop_requested', start: [], send_day_end_report: true };
  }
  if (remainingHours <= EPSILON) {
    return { ...base, continue: false, reason: 'day_end_reached', start: [], send_day_end_report: true };
  }

  const slots = Math.max(0, threads - runningKeys.size);
  const start = [];
  const humanOnly = [];
  const tooLongForClock = [];
  const unapproved = [];
  const cardCandidates = [];
  const awaitingCard = [];
  let backlog = 0;
  for (const role of CONVEYOR_ORDER) {
    for (const item of queues[role] ?? []) {
      const key = itemKey(item, `${role} item`);
      if (excluded.has(key)) continue;
      if (item.executor === 'human' || item.waits_on_human === true) {
        humanOnly.push(key);
        excluded.add(key);
        continue;
      }
      if (item.dependency_ready === false) continue;
      // The planner never invents filler: a reservoir entry can reach the card
      // only when it names the list approval it comes from.
      if (role === 'reservoir' && !String(item.approved_by ?? '').trim()) {
        unapproved.push(key);
        excluded.add(key);
        continue;
      }
      const lowHours = Number(item.estimate_hours_low ?? DEFAULT_ITEM_HOURS);
      if (Number.isFinite(lowHours) && lowHours > remainingHours + EPSILON) {
        tooLongForClock.push(key);
        continue;
      }
      // The list approves what may be proposed; the human's tap on the new-work
      // card approves what starts (choice of 4.11.2026). Nothing from the
      // reservoir runs on the list alone.
      if (role === 'reservoir' && !String(item.confirmed_by ?? '').trim()) {
        excluded.add(key);
        if (noNewWork) continue;
        if (proposedKeys.has(key)) awaitingCard.push(key);
        else cardCandidates.push(cardItem(item, key));
        continue;
      }
      if (start.length < slots) {
        start.push({ ...item, stable_key: key, conveyor_source: role });
        excluded.add(key);
      } else {
        backlog += 1;
      }
    }
  }

  // One card at a time, posted as soon as nothing is left waiting to start, so
  // the human can answer while the last threads still run.
  const newWorkCard = !awaitingCard.length && backlog === 0 && cardCandidates.length
    ? { post: 'now', question: NEW_WORK_QUESTION, items: cardCandidates.slice(0, NEW_WORK_CARD_ITEMS) }
    : null;
  const idle = runningKeys.size === 0 && start.length === 0;
  const awaitingNewWork = idle && Boolean(newWorkCard || awaitingCard.length);
  const batch = waitingKeys.size || awaitingNewWork ? nextCardBatch({ now, day_end_at: dayEnd, batches }) : null;
  const wakeMinutes = awaitingNewWork
    ? Math.max(1, Math.ceil((Date.parse(batch.at) - nowMs) / 60000))
    : Math.max(1, Math.min(WAKE_MINUTES, Math.ceil(remainingHours * 60)));
  return {
    ...base,
    continue: !idle || awaitingNewWork,
    reason: awaitingNewWork ? 'awaiting_new_work_card'
      : idle ? idleReason(waitingKeys.size + humanOnly.length, tooLongForClock.length)
        : start.length ? 'slots_filled' : 'threads_busy',
    slots_free: slots,
    start,
    new_work_card: newWorkCard,
    awaiting_card_keys: awaitingCard,
    human_only_keys: humanOnly,
    too_long_for_clock_keys: tooLongForClock,
    unapproved_reservoir_keys: unapproved,
    next_wake_in_minutes: idle && !awaitingNewWork ? null : wakeMinutes,
    next_card_batch: waitingKeys.size ? batch : null,
    send_day_end_report: idle && !awaitingNewWork,
  };
}

const APPENDED_SOURCES = new Set(['next_days', 'reservoir']);
const PLAN_SOURCE_TYPES = new Set(['bug', 'feature', 'test_plan', 'todo', 'ui_surface']);
const CONFIDENCE = new Set(['high', 'medium', 'low']);

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

// Work the conveyor takes beyond the approved queue is appended to the current
// plan as a reserve row marked conveyor_source=, so Focus and Productivitate
// show it as „Luat de bandă” and its copied prompt says where it came from.
// Committed and reserve items are already rows of the plan; they are refused.
export function conveyorPlanRow({ plan_id: planId, next_sequence: nextSequence, now, item }) {
  const source = item?.conveyor_source;
  if (!APPENDED_SOURCES.has(source)) {
    throw new Error('only next_days and reservoir items are appended; committed and reserve are already plan rows');
  }
  const nowMs = instant(now, 'now');
  const sequence = Number(nextSequence);
  if (!Number.isInteger(sequence) || sequence < 0) throw new Error('next_sequence must be a non-negative integer');
  const approvedBy = String(item.approved_by ?? '').trim();
  const confirmedBy = String(item.confirmed_by ?? '').trim();
  if (source === 'reservoir' && !approvedBy) throw new Error('a reservoir entry needs approved_by');
  if (source === 'reservoir' && !confirmedBy) {
    throw new Error('a reservoir entry starts only after the human tapped it on the new-work card (confirmed_by)');
  }
  if (!PLAN_SOURCE_TYPES.has(item.source_type) || item.source_id == null) {
    throw new Error(source === 'reservoir'
      ? 'create the tracker item for this reservoir entry first (todo_create), then pass its source_type and source_id'
      : 'source_type and source_id are required');
  }
  const sourceId = positiveInteger(item.source_id, 'source_id');
  // A reservoir entry is keyed by its work type until the To-Do exists; the row
  // is keyed by the tracker item, like every other plan row.
  const stableKey = source === 'reservoir'
    ? `${item.source_type}:${sourceId}`
    : itemKey(item, 'next_days item');
  const title = String(item.title ?? '').trim();
  if (!title) throw new Error('title is required');
  const low = Number(item.estimate_hours_low ?? DEFAULT_ITEM_HOURS);
  const high = Number(item.estimate_hours_high ?? low);
  if (!Number.isFinite(low) || low <= 0 || !Number.isFinite(high) || high < low) {
    throw new Error('estimates must satisfy 0 < estimate_hours_low <= estimate_hours_high');
  }
  const confidence = CONFIDENCE.has(item.confidence) ? item.confidence : 'medium';
  const scope = String(item.scope_reason ?? '')
    .replace(/(?:^|;)\s*(?:queue_role|conveyor_source|approved_by)=[^;]*/g, '')
    .trim()
    .replace(/^;\s*|;\s*$/g, '');
  const scopeReason = [
    scope,
    'queue_role=reserve',
    `conveyor_source=${source}`,
    // Focus labels approved_by „Aprobat prin”; the tap goes in the same field so
    // the row shows both approvals without a new key.
    ...(source === 'reservoir' ? [`approved_by=${`${approvedBy} · card: ${confirmedBy}`.replace(/;/g, ',')}`] : []),
  ].filter(Boolean).join('; ');
  return {
    table: 'tt_delivery_plan_items',
    values: {
      plan_id: positiveInteger(planId, 'plan_id'),
      stable_key: stableKey,
      source_type: item.source_type,
      source_id: sourceId,
      title_snapshot: title,
      description_snapshot: String(item.description ?? ''),
      phase: String(item.phase ?? '').trim() || 'Livrare',
      sequence,
      planned_due_date: zonedParts(nowMs).date,
      estimate_hours_low: low,
      estimate_hours_high: high,
      confidence,
      dependencies: Array.isArray(item.dependencies) ? item.dependencies.map(String) : [],
      required_for_deadline: false,
      queue_role: 'reserve',
      scope_reason: scopeReason,
      launch_outcome_keys: Array.isArray(item.launch_outcome_keys) ? item.launch_outcome_keys.map(String) : [],
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const modes = { day_end: dayEndAt, conveyor: conveyorNext, card_batch: nextCardBatch, plan_row: conveyorPlanRow };
    if (!modes[input.mode]) throw new Error('mode must be day_end, conveyor, card_batch or plan_row');
    const result = modes[input.mode](input);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
