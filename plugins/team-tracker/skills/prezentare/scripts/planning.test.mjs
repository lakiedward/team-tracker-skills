import test from 'node:test';
import assert from 'node:assert/strict';
import { previousHeldPresentation, carryoverChanges, appendNewCandidates, changeState } from './planning.mjs';

const change = { id: 'a', source_type: 'feature', source_id: 3, selected: true, title: 'Edited', notes: 'Keep', state: 'verified' };
const held = { id: '1', project_id: 16, audience_id: 'client-a', status: 'held', held_at: '2026-09-01T10:00:00Z', closed_snapshot: { presentation: { document: { changes: [change], steps: [{ id: 's1', change_id: 'a' }] } }, run: { results: [{ step_id: 's1', status: 'skipped' }] } } };
test('baseline isolates client/project, ignores draft and requires held snapshot', () => {
  const recent = { ...held, id: '2', held_at: '2026-09-15T10:00:00Z' };
  assert.equal(previousHeldPresentation([held, { ...recent, audience_id: 'other' }, { ...recent, project_id: 7 }, { ...recent, status: 'draft' }], 16, 'client-a', '2026-09-17').id, '1');
  assert.equal(previousHeldPresentation([], 16, 'client-a'), null);
});
test('skipped/unattempted changes carry over; live passed result is required', () => {
  assert.deepEqual(carryoverChanges(held), [change]);
  const passed = structuredClone(held); passed.closed_snapshot.run.results[0].status = 'passed';
  assert.deepEqual(carryoverChanges(passed), []);
  passed.closed_snapshot.presentation.document.steps.push({ id: 's2', change_id: 'a' });
  assert.deepEqual(carryoverChanges(passed), [change]);
});
test('regeneration preserves exact manual edits, exclusions, order, deduplicates sources', () => {
  const edited = { ...change, selected: false };
  const candidates = [{ ...change, title: 'Generated replacement' }, { ...change, id: 'b', source_id: 4 }, { ...change, id: 'c', source_id: 4 }];
  const merged = appendNewCandidates([edited], candidates);
  assert.equal(merged.length, 2); assert.deepEqual(merged[0], edited); assert.equal(merged[1].id, 'b');
});
test('new blocker refreshes machine state/evidence without overwriting human edits', () => {
  const edited = { ...change, selected: false, summary: 'Client wording', evidence: 'Old verified proof' };
  const incoming = { ...change, title: 'Generated title', notes: 'Generated notes', selected: true, state: 'blocked', evidence: 'Current deployed build fails this scenario' };
  assert.deepEqual(appendNewCandidates([edited], [incoming])[0], { ...edited, state: 'blocked', evidence: incoming.evidence });
  const manual = { ...edited, source_type: 'manual', source_id: null };
  assert.deepEqual(appendNewCandidates([manual], [{ ...incoming, source_type: 'manual', source_id: null }])[0], manual);
});
test('updated timestamp, populated state and tests alone cannot prove deployed behavior', () => {
  assert.equal(changeState({ implemented: true, testPassed: true, updated_at: 'now' }, 'sha'), 'in_progress');
  const evidence = { implemented: true, published: true, deployedCommit: 'sha', testPassed: true };
  assert.equal(changeState(evidence, 'sha'), 'unverified');
  assert.equal(changeState({ ...evidence, browserVerified: true, verifiedCommit: 'sha' }, 'sha'), 'verified');
  assert.equal(changeState({ ...evidence, browserVerified: true, verifiedCommit: 'old' }, 'sha'), 'unverified');
  assert.equal(changeState({ ...evidence, blocked: true }, 'sha'), 'blocked');
});
