import assert from 'node:assert/strict';
import { conveyorNext, conveyorPlanRow, dayEndAt, nextCardBatch } from './day-clock.mjs';

// Motion, 4.11.2026: plan v41 applied at 10:22 local for 10 hours.
const day = dayEndAt({ applied_at: '2026-11-04T08:22:05Z', hours: 10 });
assert.equal(day.day_end_at, '2026-11-04T18:22:05.000Z');
assert.equal(day.day_end_local, '2026-11-04 20:22');
assert.equal(day.crosses_midnight, false);
assert.equal(dayEndAt({ applied_at: '2026-11-04T16:00:00Z', hours: 10 }).crosses_midnight, true);
assert.throws(() => dayEndAt({ applied_at: 'azi', hours: 10 }));
assert.throws(() => dayEndAt({ applied_at: '2026-11-04T08:00:00Z', hours: 0 }));

// Summer time: 12:00 in Bucharest is 09:00Z, in winter 10:00Z.
assert.equal(
  nextCardBatch({ now: '2026-07-01T07:00:00Z', day_end_at: '2026-07-01T18:00:00Z' }).at,
  '2026-07-01T09:00:00.000Z',
);
const winterBatch = nextCardBatch({ now: '2026-11-04T10:30:00Z', day_end_at: '2026-11-04T18:22:05Z' });
assert.equal(winterBatch.at, '2026-11-04T13:00:00.000Z', '12:30 local waits for the 15:00 batch');
assert.equal(winterBatch.with_day_end_report, false);
const lateBatch = nextCardBatch({ now: '2026-11-04T16:30:00Z', day_end_at: '2026-11-04T18:22:05Z' });
assert.equal(lateBatch.at, '2026-11-04T18:22:05.000Z', 'after 18:00 the cards go with the day-end report');
assert.equal(lateBatch.with_day_end_report, true);

const queues = {
  committed: [
    { stable_key: 'feature:614', estimate_hours_low: 0.5 },
    { stable_key: 'feature:615', estimate_hours_low: 0.5 },
    { stable_key: 'section:4427', executor: 'human' },
  ],
  reserve: [
    { stable_key: 'todo:248', estimate_hours_low: 0.25 },
    { stable_key: 'bug:1309', estimate_hours_low: 0.5, dependency_ready: false },
  ],
  next_days: [{ stable_key: 'todo:230', estimate_hours_low: 1 }],
  reservoir: [
    { stable_key: 'reservoir:ui-audit:/cluburi', estimate_hours_low: 0.5, approved_by: 'setările proiectului, 04.11' },
    { stable_key: 'reservoir:inventat', estimate_hours_low: 0.25 },
  ],
};

// 12:25 local, the moment the coordinator stopped on 4.11: committed and reserve
// are running or waiting on cards, so the conveyor reaches into the next days
// and the approved reservoir instead of ending the day.
const midday = conveyorNext({
  now: '2026-11-04T10:25:00Z',
  day_end_at: day.day_end_at,
  running: ['feature:615'],
  waiting_on_human: ['feature:614', 'todo:248'],
  queues,
});
assert.equal(midday.continue, true);
assert.equal(midday.max_threads, 4);
assert.equal(midday.slots_free, 3);
assert.deepEqual(midday.start.map((item) => [item.stable_key, item.conveyor_source]), [
  ['todo:230', 'next_days'],
  ['reservoir:ui-audit:/cluburi', 'reservoir'],
]);
assert.deepEqual(midday.human_only_keys, ['section:4427']);
assert.deepEqual(midday.unapproved_reservoir_keys, ['reservoir:inventat'], 'no invented filler');
assert.equal(midday.next_wake_in_minutes, 30);
assert.equal(midday.next_card_batch.at_local, '2026-11-04 15:00');
assert.equal(midday.send_day_end_report, false);

// Slots are filled in conveyor order and never beyond max_threads.
const morning = conveyorNext({ now: '2026-11-04T08:30:00Z', day_end_at: day.day_end_at, max_threads: 2, queues });
assert.deepEqual(morning.start.map((item) => item.stable_key), ['feature:614', 'feature:615']);
assert.equal(morning.reason, 'slots_filled');

const busy = conveyorNext({
  now: '2026-11-04T08:30:00Z', day_end_at: day.day_end_at, max_threads: 1, running: ['feature:614'], queues,
});
assert.equal(busy.continue, true);
assert.equal(busy.reason, 'threads_busy');
assert.deepEqual(busy.start, []);

// Near the end only items that can still finish are started, and the wake lands on the end.
const lastMinutes = conveyorNext({
  now: '2026-11-04T18:00:00Z',
  day_end_at: day.day_end_at,
  queues: { next_days: [{ stable_key: 'todo:230', estimate_hours_low: 1 }, { stable_key: 'todo:231', estimate_hours_low: 0.25 }] },
});
assert.deepEqual(lastMinutes.start.map((item) => item.stable_key), ['todo:231']);
assert.deepEqual(lastMinutes.too_long_for_clock_keys, ['todo:230']);
assert.equal(lastMinutes.next_wake_in_minutes, 23);

// The day ends early only when everything left needs the human; then one card with all of it.
const humanOnly = conveyorNext({
  now: '2026-11-04T12:00:00Z',
  day_end_at: day.day_end_at,
  waiting_on_human: ['feature:614'],
  done_keys: ['feature:615', 'todo:248', 'todo:230', 'reservoir:ui-audit:/cluburi'],
  queues,
});
assert.equal(humanOnly.continue, false);
assert.equal(humanOnly.reason, 'only_human_work_left');
assert.equal(humanOnly.send_day_end_report, true);

const ended = conveyorNext({ now: '2026-11-04T18:30:00Z', day_end_at: day.day_end_at, queues });
assert.equal(ended.continue, false);
assert.equal(ended.reason, 'day_end_reached');

const stopped = conveyorNext({ now: '2026-11-04T09:00:00Z', day_end_at: day.day_end_at, queues, stop_requested: true });
assert.equal(stopped.reason, 'stop_requested');

const dry = conveyorNext({ now: '2026-11-04T09:00:00Z', day_end_at: day.day_end_at, queues: {} });
assert.equal(dry.reason, 'no_executable_work');

assert.throws(() => conveyorNext({ now: '2026-11-04T09:00:00Z', day_end_at: day.day_end_at, max_threads: 9 }));
assert.throws(() => conveyorNext({ now: '2026-11-04T09:00:00Z', day_end_at: day.day_end_at, queues: { filler: [] } }));
assert.throws(() => conveyorNext({ now: '2026-11-04T09:00:00Z', day_end_at: day.day_end_at, queues: { committed: [{}] } }));

// What the conveyor takes beyond the approved queue becomes a reserve row of
// the current plan, so Focus shows it as „Luat de bandă” (choice of 4.11.2026).
const [nextDay, reservoirEntry] = midday.start;
const nextDayRow = conveyorPlanRow({
  plan_id: 187,
  next_sequence: 13,
  now: '2026-11-04T10:25:00Z',
  item: {
    ...nextDay,
    source_type: 'todo',
    source_id: 230,
    title: 'Pregătește fișa Google Play',
    description: 'Din planul de joi.',
    estimate_hours_high: 1.5,
    scope_reason: 'why_now=Următorul în clasament; queue_role=committed; change_kind=data',
  },
});
assert.equal(nextDayRow.table, 'tt_delivery_plan_items');
assert.deepEqual(nextDayRow.values, {
  plan_id: 187,
  stable_key: 'todo:230',
  source_type: 'todo',
  source_id: 230,
  title_snapshot: 'Pregătește fișa Google Play',
  description_snapshot: 'Din planul de joi.',
  phase: 'Livrare',
  sequence: 13,
  planned_due_date: '2026-11-04',
  estimate_hours_low: 1,
  estimate_hours_high: 1.5,
  confidence: 'medium',
  dependencies: [],
  required_for_deadline: false,
  queue_role: 'reserve',
  scope_reason: 'why_now=Următorul în clasament; change_kind=data; queue_role=reserve; conveyor_source=next_days',
  launch_outcome_keys: [],
});
const reservoirRow = conveyorPlanRow({
  plan_id: 187,
  next_sequence: 14,
  now: '2026-11-04T22:30:00Z',
  item: { ...reservoirEntry, source_type: 'todo', source_id: 251, title: 'Audit UI pe /cluburi' },
});
assert.equal(reservoirRow.values.stable_key, 'todo:251', 'the row is keyed by the To-Do, not by the reservoir entry');
assert.equal(reservoirRow.values.planned_due_date, '2026-11-05', 'the planned date is the Bucharest day of the start');
assert.equal(
  reservoirRow.values.scope_reason,
  'queue_role=reserve; conveyor_source=reservoir; approved_by=setările proiectului, 04.11',
);
assert.throws(
  () => conveyorPlanRow({ plan_id: 187, next_sequence: 15, now: '2026-11-04T10:25:00Z', item: reservoirEntry }),
  /create the tracker item/,
  'a reservoir entry is a tracker item before it is a plan row',
);
assert.throws(
  () => conveyorPlanRow({ plan_id: 187, next_sequence: 15, now: '2026-11-04T10:25:00Z', item: { ...reservoirEntry, approved_by: '', source_type: 'todo', source_id: 3, title: 'x' } }),
  /approved_by/,
);
assert.throws(
  () => conveyorPlanRow({ plan_id: 187, next_sequence: 15, now: '2026-11-04T10:25:00Z', item: { stable_key: 'todo:248', conveyor_source: 'reserve', source_type: 'todo', source_id: 248, title: 'x' } }),
  /already plan rows/,
);
assert.throws(
  () => conveyorPlanRow({ plan_id: 187, next_sequence: 15, now: '2026-11-04T10:25:00Z', item: { ...nextDay, source_type: 'todo', source_id: 230, title: 'x', estimate_hours_low: 2, estimate_hours_high: 1 } }),
  /estimates/,
);

console.log('day-clock tests passed');
