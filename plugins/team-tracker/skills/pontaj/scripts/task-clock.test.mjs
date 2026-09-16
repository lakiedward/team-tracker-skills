import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeDays, transcriptTimes, prepareRows, workLogSql, run } from './task-clock.mjs';
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
