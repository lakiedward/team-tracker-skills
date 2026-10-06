import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { prepareJobs, validateBrief } from './prepare-jobs.mjs';

function fixture(root) {
  return { project: 'Example', repo_path: join(root, 'repo'), revision: 'abc123', url: 'http://localhost:3000/review?demo=1',
    criteria: [{ id: 'open', text: 'Panel opens' }, { id: 'empty', text: 'Empty panel is clear' }],
    scenarios: [{ id: 'panel', title: 'Panel', steps: [{ action: 'Open the panel', expected: 'Panel is visible' }], covers: ['open'] },
      { id: 'empty', title: 'Empty state', steps: [{ action: 'Open the test empty panel', expected: 'Empty label appears' }], covers: ['empty'] }],
    viewports: [{ id: 'desktop', width: 1440, height: 900 }, { id: 'mobile', width: 390, height: 844 }],
    capture: { mode: 'shared-desktop' }, unavailable_states: ['Network error cannot be forced safely'] };
}
function temporary(run) {
  const root = mkdtempSync(join(tmpdir(), 'review-jobs-test-'));
  try { return run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('packs Cartesian jobs with only assigned criteria and truthful capture instructions', () => temporary(root => {
  const brief = fixture(root); const out = join(root, 'jobs');
  const manifest = prepareJobs(brief, { out });
  assert.equal(manifest.jobs.length, 4); assert.equal(manifest.max_workers, 3);
  assert.equal(manifest.capture_parallelism, 1); assert.equal(manifest.helper_records_video, false);
  const job = JSON.parse(readFileSync(join(out, manifest.jobs[0].job_file), 'utf8'));
  assert.deepEqual(job.criteria.map(item => item.id), ['open']);
  assert.equal(job.effort, 'low'); assert.equal(job.model, 'gpt-6.1-sol');
  const prompt = readFileSync(join(out, manifest.jobs[0].prompt_file), 'utf8');
  assert.ok(prompt.includes(job.output_dir)); assert.ok(prompt.includes(job.contract_path));
  assert.equal(existsSync(job.contract_path), true);
  assert.match(prompt, /at most 90 seconds/); assert.match(prompt, /Cursor and every click/);
  assert.match(prompt, /never a fake video or slideshow/); assert.match(prompt, /console status with evidence or explicitly unchecked/);
  assert.match(prompt, /Do not upload to Team Tracker/);
  assert.match(prompt, /No repository scan, code edits, server startup, Pontaj/);
}));

test('resource budget reserves parent slot, caps jobs and never promises isolation', () => temporary(root => {
  const brief = fixture(root); brief.capture.mode = 'isolated';
  let manifest = prepareJobs(brief, { out: join(root, 'isolated'), slots: 10, effort: 'medium', model: 'gpt-6-sol' });
  assert.equal(manifest.max_workers, 4); assert.equal(manifest.capture_parallelism, 4);
  assert.equal(manifest.isolation_requires_verification, true); assert.equal(manifest.effort, 'medium');
  const prompt = readFileSync(join(root, 'isolated', manifest.jobs[0].prompt_file), 'utf8');
  assert.match(prompt, /independently verify both capture and input isolation/);
  brief.capture.mode = 'unavailable';
  manifest = prepareJobs(brief, { out: join(root, 'unavailable'), slots: 2 });
  assert.equal(manifest.max_workers, 1); assert.equal(manifest.capture_parallelism, 0);
  manifest = prepareJobs(brief, { out: join(root, 'parent-only'), slots: 1 });
  assert.equal(manifest.max_workers, 0);
  brief.capture.mode = 'shared-desktop';
  manifest = prepareJobs(brief, { out: join(root, 'occupied'), slots: 4, occupied: 1 });
  assert.equal(manifest.max_workers, 2); assert.equal(manifest.capture_parallelism, 1);
  manifest = prepareJobs(brief, { out: join(root, 'all-occupied'), slots: 4, occupied: 3 });
  assert.equal(manifest.max_workers, 0); assert.equal(manifest.parent_sequential_capture, true);
  assert.equal(manifest.capture_parallelism, 1);
}));

test('context travels into each standalone prompt and job without requiring unrelated optional fields', () => temporary(root => {
  const brief = fixture(root);
  brief.context = { session_hint: 'Use supplied synthetic demo profile', test_data: 'Demo panel is empty', allowed_actions: ['Open panel'], recorder: 'Verify native capture documentation', isolation_evidence: 'Not verified' };
  const out = join(root, 'context'); const manifest = prepareJobs(brief, { out });
  const job = JSON.parse(readFileSync(join(out, manifest.jobs[0].job_file), 'utf8'));
  assert.deepEqual(job.context, brief.context);
  const prompt = readFileSync(join(out, manifest.jobs[0].prompt_file), 'utf8');
  assert.ok(prompt.includes(brief.context.session_hint)); assert.ok(prompt.includes(JSON.stringify(brief.context.allowed_actions)));
  brief.context = { unknown: 'rejected' };
  assert.throws(() => validateBrief(brief), /unknown field unknown/);
  brief.context = { allowed_actions: 'not an array' };
  assert.throws(() => validateBrief(brief), /context.allowed_actions/);
}));

test('unavailable capture jobs forbid new browser control and do not demand invented media evidence', () => temporary(root => {
  const brief = fixture(root); brief.capture.mode = 'unavailable';
  const out = join(root, 'unavailable-directive'); const manifest = prepareJobs(brief, { out });
  const prompt = readFileSync(join(out, manifest.jobs[0].prompt_file), 'utf8');
  assert.ok(prompt.startsWith('Return capture_unavailable with the known reason; do not control the browser or start recording.'));
  assert.match(prompt, /Reuse existing supplied evidence only/);
  assert.match(prompt, /New screenshots and timestamps are not required or permitted/);
  assert.doesNotMatch(prompt, /Produce exactly one review clip|Record the real application|Only when a permitted recorder is confirmed, record/);
  assert.equal(manifest.capture_parallelism, 0);
}));

test('explicit unavailable criteria account for coverage without allowing unknown or contradictory gaps', () => temporary(root => {
  const brief = fixture(root); brief.scenarios.pop();
  brief.unavailable_criteria = [{ id: 'empty', reason: 'No synthetic empty dataset in this session' }];
  const out = join(root, 'gaps'); const manifest = prepareJobs(brief, { out });
  assert.deepEqual(manifest.unavailable_criteria, brief.unavailable_criteria);
  const prompt = readFileSync(join(out, manifest.jobs[0].prompt_file), 'utf8');
  assert.ok(prompt.includes(brief.unavailable_criteria[0].reason));
  brief.unavailable_criteria.push({ id: 'empty', reason: 'duplicate' });
  assert.throws(() => validateBrief(brief), /duplicate criterion empty/);
  brief.unavailable_criteria = [{ id: 'unknown', reason: 'unknown' }];
  assert.throws(() => validateBrief(brief), /unknown criterion unknown/);
  brief.unavailable_criteria = [{ id: 'open', reason: 'contradiction' }];
  assert.throws(() => validateBrief(brief), /both covered and unavailable/);
}));

test('rejects uncovered, unknown and duplicated criterion coverage', () => temporary(root => {
  const brief = fixture(root); brief.scenarios.pop();
  assert.throws(() => validateBrief(brief), /criteria without a scenario: empty/);
  brief.scenarios[0].covers.push('missing');
  assert.throws(() => validateBrief(brief), /unknown criterion missing/);
  brief.scenarios[0].covers = ['open', 'open'];
  assert.throws(() => validateBrief(brief), /duplicate coverage/);
}));

test('rejects invalid shape, path-like ids, unsafe URL credentials and invalid budgets before output', () => temporary(root => {
  const invalid = [
    b => { b.url = 'file:///C:/app'; }, b => { b.url = 'https://user:pass@example.com'; },
    b => { b.url = 'http:example.com'; }, b => { b.url = 'http://example.com/space here'; },
    b => { b.scenarios[0].id = '../escape'; }, b => { b.scenarios[1].id = 'PANEL'; },
    b => { b.viewports[0].width = 0; }, b => { b.viewports[0].height = 900.5; },
    b => { b.scenarios[0].steps = []; }, b => { b.scenarios[0].steps[0].expected = ''; },
    b => { b.capture.mode = 'magic'; }, b => { b.capture.token = 'not-allowed'; },
    b => { b.unavailable_states = 'none'; }, b => { b.repo_path = 'relative'; },
  ];
  for (const mutate of invalid) {
    const brief = fixture(root); mutate(brief);
    assert.throws(() => prepareJobs(brief, { out: join(root, 'invalid') }));
    assert.equal(existsSync(join(root, 'invalid')), false);
  }
  for (const options of [{ slots: 0 }, { slots: 1.5 }, { occupied: -1 }, { occupied: 4 }, { occupied: 1.5 }, { effort: 'high' }, { model: 'arbitrary' }, { model: 'gpt-6-astra' }]) {
    assert.throws(() => prepareJobs(fixture(root), { out: join(root, 'invalid'), ...options }));
  }
}));

test('preserves existing output and refuses source locations; accepts existing empty directory', () => temporary(root => {
  const brief = fixture(root); const out = join(root, 'existing'); mkdirSync(out);
  writeFileSync(join(out, 'keep.txt'), 'keep');
  assert.throws(() => prepareJobs(brief, { out }), /new or empty/);
  assert.equal(readFileSync(join(out, 'keep.txt'), 'utf8'), 'keep');
  assert.throws(() => prepareJobs(brief, { out: join(brief.repo_path, 'videos') }), /outside source/);
  const sourceDir = fileURLToPath(new URL('.', import.meta.url));
  assert.throws(() => prepareJobs(brief, { out: join(sourceDir, 'output') }), /outside source/);
  const empty = join(root, 'empty'); mkdirSync(empty);
  assert.equal(prepareJobs(brief, { out: empty }).jobs.length, 4);
  assert.throws(() => prepareJobs(brief, { out: empty }), /new or empty/);
}));

test('accepts explicitly supplied public URL and does not use secret word heuristics', () => temporary(root => {
  const brief = fixture(root); brief.url = 'https://example.com/demo';
  brief.criteria[0].text = 'The password field remains masked; token label is hidden';
  assert.equal(validateBrief(brief).url, 'https://example.com/demo');
  const manifest = prepareJobs(brief, { out: join(root, 'future-model'), model: 'gpt-12.3-sol' });
  assert.equal(manifest.model, 'gpt-12.3-sol'); assert.equal(manifest.model_requires_catalog_verification, true);
}));

test('CLI accepts BOM JSON and explicit choices, and fails duplicate flags', () => temporary(root => {
  const path = join(root, 'brief.json'); writeFileSync(path, `\uFEFF${JSON.stringify(fixture(root))}`);
  const script = fileURLToPath(new URL('./prepare-jobs.mjs', import.meta.url));
  const args = [script, '--brief', path, '--out', join(root, 'cli'), '--slots', '4', '--occupied', '1', '--effort', 'medium'];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).max_workers, 2);
  const bad = spawnSync(process.execPath, [...args, '--slots', '3'], { encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /duplicate argument/);
}));
