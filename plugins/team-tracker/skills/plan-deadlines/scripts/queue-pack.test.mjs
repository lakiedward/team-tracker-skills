import assert from 'node:assert/strict';
import { packDailyQueues } from './queue-pack.mjs';

const fullDay = packDailyQueues({
  grossHours: 5,
  committedTargetHours: 4,
  candidates: [
    {
      stable_key: 'bug:1',
      title: 'Task principal',
      estimate_hours_low: 2.5,
      estimate_hours_high: 4,
      dependencies: [],
    },
    {
      stable_key: 'feature:2',
      title: 'Rezervă unu',
      estimate_hours_low: 1,
      estimate_hours_high: 1.5,
      dependencies: [],
    },
    {
      stable_key: 'todo:3',
      title: 'Rezervă doi',
      estimate_hours_low: 0.5,
      estimate_hours_high: 1,
      dependencies: [],
    },
  ],
});

assert.equal(fullDay.committed_target_hours, 4);
assert.equal(fullDay.committed_count, 1);
assert.equal(fullDay.committed_hours_low, 2.5);
assert.equal(fullDay.committed_hours_high, 4);
assert.equal(fullDay.reserve_target_hours, 2.5);
assert.equal(fullDay.reserve_count, 2);
assert.equal(fullDay.reserve_hours_high, 2.5);
assert.equal(fullDay.reserve_gap_hours, 0);
assert.match(fullDay.stop_rule, /5h/);
assert.deepEqual(
  [...fullDay.committed, ...fullDay.reserve].map((item) => item.sequence),
  [1, 2, 3],
);

const sliced = packDailyQueues({
  grossHours: 5,
  committedTargetHours: 4,
  candidates: [
    {
      stable_key: 'feature:large',
      title: 'Task mare',
      estimate_hours_low: 6,
      estimate_hours_high: 8,
      slice_title: 'Închide primul checkpoint',
      slice_completion_criterion: 'Primul checkpoint este verificat.',
    },
    {
      stable_key: 'bug:reserve',
      title: 'Rezervă',
      estimate_hours_low: 1,
      estimate_hours_high: 1,
    },
  ],
});
assert.equal(sliced.committed[0].is_slice, true);
assert.equal(sliced.committed[0].estimate_hours_high, 4);
assert.equal(sliced.committed[0].full_estimate_hours_high, 8);
assert.equal(sliced.committed[0].completion_criterion, 'Primul checkpoint este verificat.');

const noFiller = packDailyQueues({
  grossHours: 5,
  committedTargetHours: 4,
  candidates: [{
    stable_key: 'bug:only',
    title: 'Singurul task',
    estimate_hours_low: 1,
    estimate_hours_high: 1,
  }],
});
assert.equal(noFiller.committed_gap_hours, 3);
assert.equal(noFiller.reserve_count, 0);
assert.equal(noFiller.reserve_gap_hours, 4);

const blocked = packDailyQueues({
  grossHours: 5,
  committedTargetHours: 4,
  candidates: [
    {
      stable_key: 'bug:blocked',
      title: 'Blocat',
      estimate_hours_low: 1,
      estimate_hours_high: 1,
      dependency_ready: false,
    },
    {
      stable_key: 'bug:ready',
      title: 'Pregătit',
      estimate_hours_low: 1,
      estimate_hours_high: 1,
    },
  ],
});
assert.deepEqual(blocked.skipped_blocked_keys, ['bug:blocked']);
assert.equal(blocked.committed[0].stable_key, 'bug:ready');

assert.throws(
  () => packDailyQueues({
    grossHours: 5,
    committedTargetHours: 4,
    candidates: [
      { stable_key: 'bug:1', estimate_hours_low: 1, estimate_hours_high: 1 },
      { stable_key: 'bug:1', estimate_hours_low: 1, estimate_hours_high: 1 },
    ],
  }),
  /duplicate stable_key/,
);

console.log('plan-deadlines queue packing tests passed');
