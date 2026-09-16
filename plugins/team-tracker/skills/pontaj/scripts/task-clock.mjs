#!/usr/bin/env node
// Local opt-in task ledger. Prepares SQL; never opens a database connection.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmdirSync, existsSync } from 'node:fs';

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
    description: `${input.description.trim()} [durată activă estimată din conversație]`,
    ...day,
  }));
}

export function workLogSql(rows, source) {
  if (source && (!['bug', 'feature', 'test_plan', 'todo', 'ui_surface'].includes(source.type) || !Number.isSafeInteger(source.id) || source.id <= 0)) throw Error('Invalid tracker source');
  if (source?.estimated_hours != null && (typeof source.estimated_hours !== 'number' || !Number.isFinite(source.estimated_hours) || !(source.estimated_hours > 0) || source.estimated_hours > 24)) throw Error('Invalid verified plan estimate');
  const statements = ['BEGIN;', 'SET LOCAL standard_conforming_strings = on;'];
  for (const row of rows) {
    const keys = ['id', 'member', 'project_id', 'category', 'description', 'hours', 'work_date'];
    const values = keys.map(k => typeof row[k] === 'number' ? String(row[k]) : quote(row[k]));
    statements.push(`INSERT INTO public.tt_work_logs (${keys.join(', ')}) VALUES (${values.join(', ')}) ON CONFLICT (id) DO NOTHING;`);
    const match = keys.map((k, i) => `${k} = ${values[i]}`).join(' AND ');
    statements.push(`DO ${quote(`BEGIN IF NOT EXISTS (SELECT 1 FROM public.tt_work_logs WHERE ${match}) THEN RAISE EXCEPTION 'Pontaj retry conflict: existing row differs'; END IF; END`)};`);
    if (source) statements.push(`INSERT INTO public.tt_work_log_items (work_log_id, source_type, source_id, link_method, confidence, allocated_hours, allocation_method, estimated_hours_snapshot) VALUES (${row.id}, ${quote(source.type)}, ${source.id}, 'explicit', 'high', ${row.hours}, 'equal', ${source.estimated_hours ?? 'NULL'}) ON CONFLICT (work_log_id, source_type, source_id) DO NOTHING;`);
  }
  statements.push(`SELECT id, member, project_id, hours, work_date FROM public.tt_work_logs WHERE id IN (${rows.map(r => r.id).join(', ')});`, 'COMMIT;');
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
    if (command === 'start') {
      if (!read(configPath)?.enabled) return { enabled: false };
      if (task) return task;
      if (Object.values(ledger.tasks).some(t => !['prepared', 'recorded'].includes(t.status))) throw Error('Finish or pause scope reconciliation for the active task first');
      if (!input.member?.trim() || !Number.isSafeInteger(input.project_id) || input.project_id <= 0) throw Error('Verified member and project required');
      task = { session: input.session, task: input.task, member: input.member, project_id: input.project_id, source: input.source || null, started_at: now, pauses: [], status: 'active' };
      ledger.tasks[input.task] = task;
    } else {
      if (!task) throw Error('No start checkpoint; do not backfill guessed hours');
      if (command === 'pause' && task.status === 'active') { task.pauses.push([now, null]); task.status = 'paused'; }
      else if (command === 'resume' && task.status === 'paused') { task.pauses.at(-1)[1] = now; task.status = 'active'; }
      else if (command === 'prepare') {
        if (task.status === 'recorded') return { status: 'recorded', verified_ids: task.prepared.rows.map(row => row.id) };
        if (task.prepared) return task.prepared;
        const ended_at = now;
        const times = transcriptTimes(input.transcripts, input.session);
        const rows = prepareRows(task, { ...input, ended_at }, times);
        task.prepared = { rows, sql: workLogSql(rows, task.source), ended_at };
        task.status = 'prepared';
      } else if (command === 'ack') {
        if (!task.prepared || JSON.stringify([...input.verified_ids || []].sort()) !== JSON.stringify(task.prepared.rows.map(r => r.id).sort())) throw Error('Acknowledge only IDs verified in the database');
        task.status = 'recorded';
      } else throw Error('Unknown command or invalid task state');
    }
    save(path, ledger);
    return command === 'prepare' ? task.prepared : task;
  } finally { rmdirSync(lock); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, inputPath] = process.argv.slice(2);
    console.log(JSON.stringify(run(command, inputPath ? JSON.parse(readFileSync(inputPath, 'utf8')) : {}), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
