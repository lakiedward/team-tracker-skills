import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeDays, transcriptTimes, prepareRows, workLogSql, run, sourceFromTaskKey, explicitSources, taskSources } from './task-clock.mjs';
import { workLogBasis } from './work-log-basis.mjs';
const stamp = minutes => new Date(Date.parse('2026-09-16T08:00:00Z') + minutes * 60000).toISOString();
test('short tasks retain minutes; idle gaps and explicit user waits are excluded', () => {
  const times = [0, 4, 6, 50, 55].map(m => Date.parse(stamp(m)));
  assert.equal(activeDays(times, stamp(0), stamp(55), [[stamp(4), stamp(6)]])[0].hours, 0.15);
  assert.throws(() => activeDays([times[0]], stamp(0), stamp(1)));
  assert.equal(activeDays(times, stamp(51), stamp(55))[0].hours, 0.066667);
});
test('split records at Bucharest midnight and handle DST day without UTC assumptions', () => {
  const a = '2026-09-16T20:58:00Z', b = '2026-09-16T21:02:00Z';
  assert.deepEqual(activeDays([Date.parse(a),Date.parse(b)], a,b), [{work_date:'2026-09-16',hours:0.033333},{work_date:'2026-09-17',hours:0.033333}]);
  const start='2026-10-25T00:58:00Z', end='2026-10-25T01:02:00Z';
  assert.deepEqual(activeDays([Date.parse(start),Date.parse(end)],start,end), [{work_date:'2026-10-25',hours:0.066667}]);
});
test('task lifecycle freezes retries, rejects other transcripts, overlaps and false acknowledgements', () => {
  const root = mkdtempSync(join(tmpdir(),'tt-clock-'));
  try {
    const transcript = join(root,'session.jsonl');
    writeFileSync(transcript,[{type:'session_meta',payload:{id:'exact'}},...[0,2,4,6].map(m=>({type:'response_item',timestamp:stamp(m)}))].map(e=>JSON.stringify(e)).join('\n'));
    assert.throws(()=>transcriptTimes([transcript],'different'));
    assert.equal(transcriptTimes([transcript,transcript],'exact').length,4);
    const input={session:'exact',task:'bug:12',member:'Edy',project_id:1,source:{type:'bug',id:12,estimated_hours:2}};
    assert.deepEqual(run('start',input,root,stamp(0)),{enabled:false});
    run('enable',{},root,stamp(0));
    const start=run('start',input,root,stamp(0));
    assert.equal(run('start',input,root,stamp(2)).started_at,start.started_at);
    assert.throws(()=>run('start',{...input,task:'bug:13'},root,stamp(2)));
    run('pause',input,root,stamp(2)); run('resume',input,root,stamp(4));
    const prepared=run('prepare',{...input,transcripts:[transcript],category:'Development',description:"Taskul lui O'Brien $verify$"},root,stamp(6));
    assert.equal(prepared.rows[0].hours,0.066667);
    assert.match(prepared.rows[0].description, /\[pontaj:basis=conversation_estimate\]/);
    assert.ok(Number.isSafeInteger(prepared.rows[0].id) && prepared.rows[0].id<0);
    assert.deepEqual(run('prepare',{...input,transcripts:[]},root,stamp(8)),prepared);
    assert.throws(()=>run('ack',{...input,verified_ids:[42]},root,stamp(8)));
    assert.equal(run('ack',{...input,verified_ids:prepared.rows.map(r=>r.id)},root,stamp(8)).status,'recorded');
    assert.deepEqual(run('prepare',input,root,stamp(10)),{status:'recorded',verified_ids:prepared.rows.map(r=>r.id)});
    assert.equal(run('prepare',input,root,stamp(10)).sql,undefined,'acknowledged logs must not be replayed after a human deletes them');
    assert.match(prepared.sql, /'high'/);
    assert.doesNotMatch(prepared.sql, /DO \$verify\$/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
test('source types and estimates cannot inject SQL; same scope gets stable identity',()=>{
  assert.throws(()=>workLogSql([],{type:'bug',id:'1;DROP'}));
  assert.throws(()=>workLogSql([],{type:'bug',id:1,estimated_hours:'2;DROP'}));
  const task={session:'s',task:'feature:3',member:'Edy',project_id:1,started_at:stamp(0),pauses:[]};
  const rows=prepareRows(task,{category:'Development',description:'test',ended_at:stamp(2)},[Date.parse(stamp(0)),Date.parse(stamp(2))]);
  assert.equal(rows[0].hours,0.033333);
  assert.equal(rows[0].id,prepareRows(task,{category:'Development',description:'test',ended_at:stamp(2)},[Date.parse(stamp(0)),Date.parse(stamp(2))])[0].id);
});
test('new automatic descriptions clear conflicting and malformed metadata before stamping estimate authority', () => {
  const task={session:'s',task:'feature:3',member:'Edy',project_id:1,started_at:stamp(0),pauses:[]};
  for (const description of ['Rezultat [pontaj:basis=human_declared]', 'Rezultat [pontaj:basis human]',
    'Rezultat [pontaj:basis=', 'Rezultat [pontaj:basis=human_declared\n]']) {
    const row = prepareRows(task, { category:'Development', description, ended_at:stamp(2) },
      [Date.parse(stamp(0)),Date.parse(stamp(2))])[0];
    assert.equal(workLogBasis(row), 'conversation_estimate');
    assert.equal(row.description.split('[pontaj:basis').length - 1, 1);
  }
});

test('entry verifies identity before any retry and summary never invents a checkpoint', () => {
  const root = mkdtempSync(join(tmpdir(), 'tt-entry-'));
  const input = {session:'codex-exact',task:'request:1',member:'Edy',project_id:2,source:{type:'feature',id:20}};
  try {
    assert.equal(run('summary',input,root).status,'no_checkpoint');
    assert.equal(run('inspect',input,root).tasks[input.task],undefined);
    assert.deepEqual(run('enter',input,root),{enabled:false});
    run('enable',{},root);
    assert.equal(run('enter',input,root,stamp(0)).status,'started');
    assert.equal(run('enter',input,root,stamp(1)).status,'active');
    for (const command of ['enter','start','resume','prepare','ack']) {
      assert.throws(()=>run(command,{...input,project_id:3},root),/identity mismatch/);
      assert.throws(()=>run(command,{...input,member:'Other'},root),/identity mismatch/);
      assert.throws(()=>run(command,{...input,source:{type:'feature',id:21}},root),/source mismatch/);
    }
    run('pause',input,root,stamp(2));
    assert.equal(run('enter',input,root,stamp(3)).status,'paused');
    assert.equal(run('summary',input,root).saved,false);
    run('resume',input,root,stamp(4));
    const transcript=join(root,'transcript.jsonl');
    writeFileSync(transcript,[{type:'session_meta',payload:{id:input.session}},...[0,2,4,6].map(m=>({type:'response_item',timestamp:stamp(m)}))].map(JSON.stringify).join('\n'));
    const prepared=run('prepare',{...input,transcripts:[transcript],category:'Development',description:'Verified entry'},root,stamp(6));
    assert.equal(run('enter',input,root,stamp(7)).status,'pending');
    run('ack',{...input,verified_ids:prepared.rows.map(row=>row.id)},root);
    assert.equal(run('enter',input,root).status,'recorded');
    assert.equal(run('summary',input,root).saved,true);
    assert.equal(run('summary',input,root).sql,undefined);
    assert.throws(()=>run('resume',input,root),/invalid task state/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
test('upgrading does not rewrite a pending receipt prepared by an older clock', () => {
  const root = mkdtempSync(join(tmpdir(), 'tt-upgrade-'));
  const input = { session: 'old-session', task: 'task:1', member: 'Edy', project_id: 1 };
  try {
    const old = { rows: [{ id: -9, description: 'Legacy [durată activă estimată din conversație]', hours: 1 }], sql: 'old immutable SQL', ended_at: stamp(6) };
    run('enable', {}, root);
    run('enter', input, root, stamp(0));
    writeFileSync(join(root, `${createHash('sha256').update(input.session).digest('hex')}.json`), JSON.stringify({
      session: input.session, tasks: { [input.task]: { ...input, status: 'prepared', prepared: old } },
    }));
    assert.deepEqual(run('prepare', { ...input, transcripts: [] }, root, stamp(8)), old);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a task key that names a tracker item links the hours without an explicit source', () => {
  const root = mkdtempSync(join(tmpdir(), 'tt-derive-'));
  try {
    run('enable', {}, root);
    const receipt = run('enter', { session: 's1', task: 'ui_surface:874:approve-spec', member: 'Edy', project_id: 7 }, root, stamp(0));
    assert.deepEqual(receipt.sources, [{ type: 'ui_surface', id: 874 }]);
    for (const [key, expected] of [['bug:640', { type: 'bug', id: 640 }], ['todo:12:retry-2', { type: 'todo', id: 12 }],
      ['proiect:betora:2026-09-22', null], ['feature:culcush:care-library', null], ['bug:0', null], ['bugs:12', null]]) {
      assert.deepEqual(sourceFromTaskKey(key), expected, key);
    }
    // An explicit source wins over the key.
    const explicit = run('enter', { session: 's2', task: 'bug:1', member: 'Edy', project_id: 7, source: { type: 'feature', id: 9 } }, root, stamp(0));
    assert.deepEqual(explicit.sources, [{ type: 'feature', id: 9 }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a thread that works several items links each one before prepare, then the receipt is frozen', () => {
  const root = mkdtempSync(join(tmpdir(), 'tt-link-'));
  const input = { session: 'thread', task: 'proiect:culcush:2026-10-07', member: 'Edy', project_id: 7 };
  try {
    run('enable', {}, root);
    assert.deepEqual(run('enter', input, root, stamp(0)).sources, []);
    assert.throws(() => run('link', input, root), /at least one tracker source/);
    assert.throws(() => run('link', { ...input, source: { type: 'bug', id: '1;DROP' } }, root), /Invalid tracker source/);
    run('link', { ...input, source: { type: 'bug', id: 1006, estimated_hours: 1.5 } }, root);
    const linked = run('link', { ...input, sources: [{ type: 'bug', id: 1006 }, { type: 'feature', id: 275 }] }, root);
    assert.deepEqual(linked.sources, [{ type: 'bug', id: 1006, estimated_hours: 1.5 }, { type: 'feature', id: 275 }], 'duplicates keep the first, verified estimate');
    assert.throws(() => run('link', { ...input, project_id: 8, source: { type: 'bug', id: 2 } }, root), /identity mismatch/);
    // A retry naming a source the checkpoint already has is not a swap.
    assert.equal(run('enter', { ...input, source: { type: 'feature', id: 275 } }, root, stamp(1)).status, 'active');
    assert.throws(() => run('enter', { ...input, source: { type: 'feature', id: 999 } }, root, stamp(1)), /source mismatch/);
    run('pause', input, root, stamp(2));
    run('link', { ...input, source: { type: 'todo', id: 177 } }, root);
    run('resume', input, root, stamp(3));
    const transcript = join(root, 'thread.jsonl');
    writeFileSync(transcript, [{ type: 'session_meta', payload: { id: 'thread' } }, ...[0, 2, 4, 6].map(m => ({ type: 'response_item', timestamp: stamp(m) }))].map(JSON.stringify).join('\n'));
    const prepared = run('prepare', { ...input, transcripts: [transcript], category: 'Development', description: 'Trei iteme Culcush' }, root, stamp(6));
    const links = prepared.sql.split('\n').filter(line => line.startsWith('INSERT INTO public.tt_work_log_items'));
    assert.equal(links.length, 3 * prepared.rows.length);
    assert.match(prepared.sql, /'bug', 1006, 'explicit', 'high', [\d.]+, 'equal', 1\.5 WHERE EXISTS \(SELECT 1 FROM public\.tt_bugs WHERE id = 1006 AND project_id = 7\)/);
    assert.match(prepared.sql, /'todo', 177, 'explicit', 'high'/);
    assert.throws(() => run('link', { ...input, source: { type: 'bug', id: 5 } }, root), /a prepared receipt is immutable/);
    assert.deepEqual(run('prepare', { ...input, transcripts: [] }, root, stamp(8)), prepared, 'retries replay the same SQL');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('several sources split the starting allocation evenly and stay injection-safe', () => {
  const rows = [{ id: -5, member: 'Edy', project_id: 1, category: 'Development', description: 'x', hours: 0.9, work_date: '2026-10-07' }];
  const sql = workLogSql(rows, [{ type: 'bug', id: 1 }, { type: 'feature', id: 2 }, { type: 'todo', id: 3 }]);
  assert.equal((sql.match(/, 0\.3, 'equal'/g) || []).length, 3);
  assert.equal(workLogSql(rows, { type: 'bug', id: 1 }).match(/INSERT INTO public\.tt_work_log_items/g).length, 1, 'the single-source form keeps working');
  assert.throws(() => workLogSql(rows, [{ type: 'bug', id: 1 }, { type: 'x', id: 2 }]), /Invalid tracker source/);
  assert.throws(() => explicitSources({ sources: Array.from({ length: 26 }, (_, i) => ({ type: 'bug', id: i + 1 })) }), /Too many/);
  assert.deepEqual(taskSources({ source: { type: 'bug', id: 4 } }), [{ type: 'bug', id: 4 }], 'ledgers from before multi-source still prepare');
});

test('links survive every intermediate DB split and skip a sliver that could round to zero', () => {
  const row = { id: -7, member: 'Edy', project_id: 1, category: 'Development', description: 'x', hours: 1, work_date: '2026-10-07' };
  const weighted = workLogSql([row], [{ type: 'bug', id: 1, estimated_hours: 3 }, { type: 'feature', id: 2, estimated_hours: 1 }]);
  // The starting value is the smallest share any step can produce; the trigger overwrites it.
  assert.equal((weighted.match(/'explicit', 'high', 0\.25, 'equal'/g) || []).length, 2);
  // The reviewer's case: [0.5, 8, none] — after the 2nd insert the DB splits by
  // estimate (0.5/8.5 of a 2-second sliver rounds to 0), so the row stays unlinked.
  const sliverRow = { ...row, id: -9, hours: 0.000556 };
  const mixed = workLogSql([sliverRow], [{ type: 'bug', id: 1, estimated_hours: 0.5 }, { type: 'feature', id: 2, estimated_hours: 8 }, { type: 'todo', id: 3 }]);
  assert.doesNotMatch(mixed, /INSERT INTO public\.tt_work_log_items/);
  const tiny = workLogSql([{ ...row, id: -8, hours: 0.00004 }, row], [{ type: 'bug', id: 1 }]);
  assert.match(tiny, /INSERT INTO public\.tt_work_logs .*-8,/, 'the sliver itself is still logged');
  assert.doesNotMatch(tiny, /SELECT -8, 'bug'/, 'but not linked');
  assert.match(tiny, /SELECT -7, 'bug', 1, 'explicit', 'high', 1, 'equal', NULL WHERE EXISTS \(SELECT 1 FROM public\.tt_bugs WHERE id = 1 AND project_id = 1\)/);
});

test('a link to an item deleted or moved before the clock closed is skipped, not fatal, and visible at ack', () => {
  const row = { id: -3, member: 'Edy', project_id: 7, category: 'Development', description: 'x', hours: 0.5, work_date: '2026-10-07' };
  const sql = workLogSql([row], [{ type: 'ui_surface', id: 874 }, { type: 'todo', id: 177 }]);
  assert.match(sql, /WHERE EXISTS \(SELECT 1 FROM public\.tt_ui_surfaces WHERE id = 874 AND project_id = 7\)/);
  assert.match(sql, /WHERE EXISTS \(SELECT 1 FROM public\.tt_todos WHERE id = 177 AND project_id = 7\)/);
  assert.match(sql, /json_agg\(json_build_object\('source_type', link\.source_type, 'source_id', link\.source_id, 'allocated_hours', link\.allocated_hours\)/, 'the verification SELECT returns the links that landed');
  assert.throws(() => workLogSql([{ ...row, project_id: '7; DROP' }], [{ type: 'bug', id: 1 }]), /Verified project/);
});

test('retries with an empty source, merged estimates, aliases and estimate precision', () => {
  const root = mkdtempSync(join(tmpdir(), 'tt-review-'));
  try {
    run('enable', {}, root);
    const base = { session: 'r1', task: 'bug:640', member: 'Edy', project_id: 1 };
    assert.deepEqual(run('enter', { ...base, sources: [] }, root, stamp(0)).sources, [{ type: 'bug', id: 640 }]);
    for (const extra of [{ source: null }, { sources: [] }, { source: { type: 'bug', id: 640 } }]) {
      assert.equal(run('enter', { ...base, ...extra }, root, stamp(1)).status, 'active', JSON.stringify(extra));
      run('pause', { ...base, ...extra }, root, stamp(2)); run('resume', { ...base, ...extra }, root, stamp(3));
    }
    // A plan estimate can still reach a key-derived source through `link`.
    assert.deepEqual(run('link', { ...base, source: { type: 'bug', id: 640, estimated_hours: 2 } }, root).sources, [{ type: 'bug', id: 640, estimated_hours: 2 }]);
    assert.throws(() => run('link', { session: 'r1', task: 'bug:640', source: { type: 'bug', id: 1 } }, root), /member and project required/);
    assert.deepEqual(explicitSources({ source: { type: 'bug', id: 1 }, sources: [{ type: 'bug', id: 1, estimated_hours: 2 }] }), [{ type: 'bug', id: 1, estimated_hours: 2 }]);
    assert.deepEqual(explicitSources({ source: { type: 'bug', id: 1, estimated_hours: 1.23456 } }), [{ type: 'bug', id: 1, estimated_hours: 1.2346 }]);
    assert.throws(() => explicitSources({ source: { type: 'bug', id: 1, estimated_hours: 1e-7 } }), /Invalid verified plan estimate/);
    assert.deepEqual(sourceFromTaskKey('test:383'), { type: 'test_plan', id: 383 });
    assert.deepEqual(sourceFromTaskKey('section:1243:spec'), { type: 'ui_surface', id: 1243 });
    assert.equal(sourceFromTaskKey('plan:85'), null, 'a plan id is not an item id');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
