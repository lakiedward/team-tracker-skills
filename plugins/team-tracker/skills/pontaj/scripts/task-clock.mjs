#!/usr/bin/env node
// Local opt-in task ledger. Prepares SQL; never opens a database connection.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmdirSync, existsSync } from 'node:fs';
import { CONVERSATION_HOURS_MARKER } from './work-log-basis.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const categories = ['Development', 'Testing', 'Content', 'Design', 'Research', 'Meeting', 'Other'];
const localDate = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
const instant = value => {
  if (typeof value !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw Error('Timestamp with timezone required');
  return Date.parse(value);
};

export function transcriptTimes(paths, session) {
  if (!paths?.length || !session) throw Error('Exact session and transcript files required');
  const times = new Set();
  for (const path of paths) {
    const events = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const ids = events.flatMap(e => [e.type === 'session_meta' ? e.payload?.id : null, e.sessionId, e.session_id].filter(Boolean));
    if (!ids.length || ids.some(id => id !== session)) throw Error('Transcript identity missing or mismatched');
    for (const e of events) {
      if (e.isSidechain || e.type === 'session_meta' || e.type === 'turn_context') continue;
      const timestamp = e.timestamp ?? e.created_at ?? e.createdAt;
      if (timestamp && ['user', 'assistant', 'tool', 'response_item', 'event_msg'].includes(e.type)) times.add(instant(timestamp));
    }
  }
  return [...times].sort((a, b) => a - b);
}

export function activeDays(times, start, end, pauses = [], idleMinutes = 15) {
  const from = instant(start), until = instant(end);
  if (until <= from || !Number.isFinite(idleMinutes) || idleMinutes <= 0) throw Error('Invalid measurement interval');
  const excluded = pauses.map(([a, b]) => [instant(a), instant(b ?? end)]);
  const days = {};
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] > idleMinutes * 60000) continue;
    let pieces = [[Math.max(from, times[i - 1]), Math.min(until, times[i])]].filter(([a,b]) => b > a);
    for (const [p, q] of excluded) pieces = pieces.flatMap(([a, b]) => q <= a || p >= b ? [[a,b]] : [[a, Math.min(b,p)], [Math.max(a,q), b]].filter(([x,y]) => y > x));
    for (let [a, b] of pieces) {
      // Find the exact Bucharest midnight boundary, including DST changes.
      while (a < b) {
        const date = localDate(a);
        let stop = b;
        if (localDate(b - 1) !== date) {
          let low = a, high = b;
          while (high - low > 1) { const mid = Math.floor((low + high) / 2); if (localDate(mid) === date) low = mid; else high = mid; }
          stop = high;
        }
        days[date] = (days[date] || 0) + stop - a;
        a = stop;
      }
    }
  }
  const result = Object.entries(days).map(([work_date, ms]) => ({ work_date, hours: Number((ms / 3600000).toFixed(6)) })).filter(r => r.hours > 0);
  if (!result.length || result.some(r => r.hours > 24)) throw Error('No measurable active interval; leave Pontaj pending');
  return result;
}

export function prepareRows(task, input, times) {
  if (!categories.includes(input.category) || !input.description?.trim()) throw Error('Category and honest task summary required');
  return activeDays(times, task.started_at, input.ended_at, task.pauses).map(day => ({
    // A deterministic negative safe integer uses the existing PK without changing
    // the positive BIGSERIAL sequence. Retry conflicts are verified, never ignored.
    id: -parseInt(hash(`${task.session}\0${task.task}\0${task.member}\0${task.project_id}\0${day.work_date}`).slice(0, 13), 16) - 1,
    member: task.member, project_id: task.project_id, category: input.category,
    description: `${input.description.trim().replace(/\[pontaj:basis[^\]\r\n]*(?:\]|$)/gm, '').trim()} [durată activă estimată din conversație] ${CONVERSATION_HOURS_MARKER}`,
    ...day,
  }));
}

const SOURCE_TYPES = ['bug', 'feature', 'test_plan', 'todo', 'ui_surface'];
const MAX_SOURCES = 25;

const SOURCE_TABLES = { bug: 'tt_bugs', feature: 'tt_features', test_plan: 'tt_test_plans', todo: 'tt_todos', ui_surface: 'tt_ui_surfaces' };

function validSource(source) {
  if (!source || !SOURCE_TYPES.includes(source.type) || !Number.isSafeInteger(source.id) || source.id <= 0) throw Error('Invalid tracker source');
  if (source.estimated_hours == null) return { type: source.type, id: source.id };
  // estimated_hours_snapshot is numeric(10,4) with CHECK > 0: an estimate that
  // rounds to 0 would be rejected by the DB, and the split below must use the
  // same 4-decimal value the trigger will read back.
  const estimate = typeof source.estimated_hours === 'number' && Number.isFinite(source.estimated_hours) ? Number(source.estimated_hours.toFixed(4)) : NaN;
  if (!(estimate >= 0.0001) || estimate > 24) throw Error('Invalid verified plan estimate');
  return { type: source.type, id: source.id, estimated_hours: estimate };
}

// One rule wherever sources meet: deduplicate by type:id, keep the first entry,
// and let a later entry fill in a plan estimate the first one lacked.
export function mergeSources(...lists) {
  const merged = new Map();
  for (const source of lists.flat().map(validSource)) {
    const key = `${source.type}:${source.id}`;
    const known = merged.get(key);
    if (!known) merged.set(key, source);
    else if (known.estimated_hours == null && source.estimated_hours != null) merged.set(key, { ...known, estimated_hours: source.estimated_hours });
  }
  if (merged.size > MAX_SOURCES) throw Error('Too many tracker sources for one checkpoint');
  return [...merged.values()];
}

// `source: null` and `sources: []` name nothing; both are kept for retries of old JSON.
const namedSources = input => [...(input.source ? [input.source] : []), ...(Array.isArray(input.sources) ? input.sources : [])];
export const explicitSources = input => mergeSources(namedSources(input));

// A task key that names a tracker item — `bug:640`, `ui_surface:874:approve-spec`,
// and the Focus/plan aliases `test:<id>` and `section:<id>` — already says where
// the hours belong; an item checkpoint started without `source` used to save no link.
const KEY_ALIASES = { test: 'test_plan', section: 'ui_surface' };
export function sourceFromTaskKey(key) {
  const match = /^(bug|feature|test_plan|todo|ui_surface|test|section):(\d+)(?::|$)/.exec(key || '');
  const id = match ? Number(match[2]) : 0;
  return match && Number.isSafeInteger(id) && id > 0 ? { type: KEY_ALIASES[match[1]] ?? match[1], id } : null;
}

// Ledgers written before multi-source support carry a single `source`.
export const taskSources = task => task?.sources ?? (task?.source ? [task.source] : []);

// The smallest share any link can get while the DB re-splits after each insert:
// an AFTER INSERT trigger runs per link, so every intermediate set matters, not
// only the final one. Weighted while all links so far have estimates, equal
// otherwise — the bound covers both, in any order and for any subset.
function minimumShare(hours, sources) {
  const estimates = sources.filter(source => source.estimated_hours != null).map(source => source.estimated_hours);
  const equal = hours / sources.length;
  if (!estimates.length) return equal;
  return Math.min(equal, hours * Math.min(...estimates) / estimates.reduce((sum, value) => sum + value, 0));
}

export function workLogSql(rows, sourceOrSources) {
  const sources = mergeSources(Array.isArray(sourceOrSources) ? sourceOrSources : sourceOrSources ? [sourceOrSources] : []);
  const statements = ['BEGIN;', 'SET LOCAL standard_conforming_strings = on;'];
  for (const row of rows) {
    if (!Number.isSafeInteger(row.project_id) || row.project_id <= 0 || !Number.isSafeInteger(row.id)) throw Error('Verified project and row ID required');
    const keys = ['id', 'member', 'project_id', 'category', 'description', 'hours', 'work_date'];
    const values = keys.map(k => typeof row[k] === 'number' ? String(row[k]) : quote(row[k]));
    statements.push(`INSERT INTO public.tt_work_logs (${keys.join(', ')}) VALUES (${values.join(', ')}) ON CONFLICT (id) DO NOTHING;`);
    const match = keys.map((k, i) => `${k} = ${values[i]}`).join(' AND ');
    statements.push(`DO ${quote(`BEGIN IF NOT EXISTS (SELECT 1 FROM public.tt_work_logs WHERE ${match}) THEN RAISE EXCEPTION 'Pontaj retry conflict: existing row differs'; END IF; END`)};`);
    // The DB triggers re-split a log's hours across its links after every insert,
    // rounded to allocated_hours' numeric(10,4), which has CHECK > 0. A sliver of a
    // day (tenths of a second at Bucharest midnight) whose share could round to 0
    // at any step is saved without links instead of failing the whole transaction.
    // The trigger overwrites the starting value, which only has to pass the CHECK.
    if (!sources.length) continue;
    const floor = Number(minimumShare(row.hours, sources).toFixed(4));
    if (!(floor >= 0.0001)) continue;
    // Each link lands only if its item still exists in the log's project: an item
    // deleted or moved before the clock closed is skipped, not left to abort the
    // log on every retry of an immutable receipt. The final SELECT shows which landed.
    for (const source of sources) statements.push(`INSERT INTO public.tt_work_log_items (work_log_id, source_type, source_id, link_method, confidence, allocated_hours, allocation_method, estimated_hours_snapshot) SELECT ${row.id}, ${quote(source.type)}, ${source.id}, 'explicit', 'high', ${floor}, 'equal', ${source.estimated_hours ?? 'NULL'} WHERE EXISTS (SELECT 1 FROM public.${SOURCE_TABLES[source.type]} WHERE id = ${source.id} AND project_id = ${row.project_id}) ON CONFLICT (work_log_id, source_type, source_id) DO NOTHING;`);
  }
  statements.push(`SELECT work.id, work.member, work.project_id, work.hours, work.work_date, COALESCE(json_agg(json_build_object('source_type', link.source_type, 'source_id', link.source_id, 'allocated_hours', link.allocated_hours) ORDER BY link.source_type, link.source_id) FILTER (WHERE link.source_id IS NOT NULL), '[]'::json) AS links FROM public.tt_work_logs work LEFT JOIN public.tt_work_log_items link ON link.work_log_id = work.id WHERE work.id IN (${rows.map(r => r.id).join(', ')}) GROUP BY work.id, work.member, work.project_id, work.hours, work.work_date ORDER BY work.work_date;`, 'COMMIT;');
  return statements.join('\n');
}

export function run(command, input = {}, root = join(homedir(), '.claude', 'team-tracker-task-clock'), now = new Date().toISOString()) {
  mkdirSync(root, { recursive: true });
  const configPath = join(root, 'config.json');
  const read = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  const save = (path, data) => { const temp = `${path}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify(data, null, 2)); renameSync(temp, path); };
  if (command === 'enable' || command === 'disable') { const config = { enabled: command === 'enable', updated_at: now }; save(configPath, config); return config; }
  if (command === 'status') return read(configPath) || { enabled: false };
  if (!input.session) throw Error('Exact session ID required');
  const path = join(root, `${hash(input.session)}.json`), lock = `${path}.lock`;
  mkdirSync(lock); // A concurrent writer must retry; never break another process's lock.
  try {
    const ledger = read(path) || { session: input.session, tasks: {} };
    if (command === 'inspect') return ledger;
    if (!input.task || ['__proto__', 'constructor', 'prototype'].includes(input.task)) throw Error('Stable task key required');
    let task = Object.hasOwn(ledger.tasks, input.task) ? ledger.tasks[input.task] : null;
    if (command === 'summary') return {
      status: task?.status ?? 'no_checkpoint',
      saved: task?.status === 'recorded',
      message: task?.status === 'recorded' ? 'Pontaj salvat (confirmat în DB la ack)' : 'Pontaj în așteptare',
      verified_ids: task?.status === 'recorded' ? task.prepared.rows.map(row => row.id) : [],
    };
    if (task) {
      for (const key of ['member', 'project_id']) {
        if (input[key] !== undefined && input[key] !== task[key]) throw Error(`Checkpoint identity mismatch: ${key}`);
      }
      // Outside `link`, a source named on a retry must already belong to the
      // checkpoint: sources are added deliberately, never swapped on a retry.
      const named = command === 'link' ? [] : namedSources(input);
      if (named.length) {
        const known = new Set(taskSources(task).map(s => `${s.type}:${s.id}`));
        if (named.some(s => !known.has(`${s?.type}:${s?.id}`))) throw Error('Checkpoint source mismatch');
      }
    }
    const entering = command === 'enter';
    let created = false;
    if (command === 'start' || entering) {
      if (!read(configPath)?.enabled) return { enabled: false };
      if (!input.member?.trim() || !Number.isSafeInteger(input.project_id) || input.project_id <= 0) throw Error('Verified member and project required');
      if (task) return entering ? { enabled: true, status: task.status === 'prepared' ? 'pending' : task.status, started_at: task.started_at, project_id: task.project_id, member: task.member, sources: taskSources(task) } : task;
      if (Object.values(ledger.tasks).some(t => !['prepared', 'recorded'].includes(t.status))) throw Error('Finish or pause scope reconciliation for the active task first');
      // Validate the sources before starting, not at the end of measured work.
      let sources = explicitSources(input);
      if (!sources.length && sourceFromTaskKey(input.task)) sources = [sourceFromTaskKey(input.task)];
      task = { session: input.session, task: input.task, member: input.member, project_id: input.project_id, sources, started_at: now, pauses: [], status: 'active' };
      ledger.tasks[input.task] = task;
      created = true;
    } else {
      if (!task) throw Error('No start checkpoint; do not backfill guessed hours');
      if (command === 'link') {
        // A thread that works several tracker items under one clock names each
        // item as it is actually worked on; the DB then splits the hours.
        if (!['active', 'paused'].includes(task.status)) throw Error('Link sources before prepare; a prepared receipt is immutable');
        if (input.member === undefined || input.project_id === undefined) throw Error('Verified member and project required');
        const added = explicitSources(input);
        if (!added.length) throw Error('Name at least one tracker source to link');
        task.sources = mergeSources(taskSources(task), added);
        delete task.source;
        save(path, ledger);
        return { status: task.status, sources: task.sources };
      }
      if (command === 'pause' && task.status === 'active') { task.pauses.push([now, null]); task.status = 'paused'; }
      else if (command === 'resume' && task.status === 'paused') { task.pauses.at(-1)[1] = now; task.status = 'active'; }
      else if (command === 'prepare') {
        if (task.status === 'recorded') return { status: 'recorded', verified_ids: task.prepared.rows.map(row => row.id) };
        if (task.prepared) return task.prepared;
        const ended_at = now;
        const times = transcriptTimes(input.transcripts, input.session);
        const rows = prepareRows(task, { ...input, ended_at }, times);
        task.prepared = { rows, sql: workLogSql(rows, taskSources(task)), ended_at };
        task.status = 'prepared';
      } else if (command === 'ack') {
        if (!task.prepared || JSON.stringify([...input.verified_ids || []].sort()) !== JSON.stringify(task.prepared.rows.map(r => r.id).sort())) throw Error('Acknowledge only IDs verified in the database');
        task.status = 'recorded';
      } else throw Error('Unknown command or invalid task state');
    }
    save(path, ledger);
    if (entering) return { enabled: true, status: created ? 'started' : task.status, started_at: task.started_at, project_id: task.project_id, member: task.member, sources: taskSources(task) };
    return command === 'prepare' ? task.prepared : task;
  } finally { rmdirSync(lock); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, inputPath] = process.argv.slice(2);
    console.log(JSON.stringify(run(command, inputPath ? JSON.parse(readFileSync(inputPath, 'utf8')) : {}), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
