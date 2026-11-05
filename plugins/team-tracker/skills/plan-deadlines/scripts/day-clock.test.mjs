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
// instead of ending the day. The reservoir does not start on the list alone:
// its next concrete work goes on one card first (choice of 4.11.2026).
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
]);
assert.deepEqual(midday.new_work_card, {
  post: 'now',
  question: 'Vrei să mă apuc de asta?',
  items: [{
    stable_key: 'reservoir:ui-audit:/cluburi',
    title: 'reservoir:ui-audit:/cluburi',
    estimate_hours_low: 0.5,
    estimate_hours_high: 0.5,
    approved_by: 'setările proiectului, 04.11',
  }],
});
assert.deepEqual(midday.human_only_keys, ['section:4427']);
assert.deepEqual(midday.unapproved_reservoir_keys, ['reservoir:inventat'], 'no invented filler, not even on the card');
assert.equal(midday.next_wake_in_minutes, 30);
assert.equal(midday.next_card_batch.at_local, '2026-11-04 15:00');
assert.equal(midday.send_day_end_report, false);

// While the card waits, the item is neither started nor proposed again.
const pending = conveyorNext({
  now: '2026-11-04T10:40:00Z',
  day_end_at: day.day_end_at,
  running: ['feature:615', 'todo:230'],
  waiting_on_human: ['feature:614', 'todo:248'],
  proposed_keys: ['reservoir:ui-audit:/cluburi'],
  queues,
});
assert.deepEqual(pending.start, []);
assert.equal(pending.new_work_card, null);
assert.deepEqual(pending.awaiting_card_keys, ['reservoir:ui-audit:/cluburi']);

// After the tap the item carries confirmed_by and starts like any other.
const tapped = {
  ...queues,
  reservoir: [{ ...queues.reservoir[0], confirmed_by: 'card 04.11 12:41 „Da, toate”' }, queues.reservoir[1]],
};
const afterTap = conveyorNext({
  now: '2026-11-04T10:42:00Z',
  day_end_at: day.day_end_at,
  running: ['feature:615', 'todo:230'],
  waiting_on_human: ['feature:614', 'todo:248'],
  queues: tapped,
});
assert.deepEqual(afterTap.start.map((item) => [item.stable_key, item.conveyor_source]), [
  ['reservoir:ui-audit:/cluburi', 'reservoir'],
]);
assert.equal(afterTap.new_work_card, null);

// The card waits until nothing from the plan is left to start, and names at most four items.
const reservoirOnly = Array.from({ length: 6 }, (_, index) => ({
  stable_key: `reservoir:tests:${index}`, title: `Teste lipsă ${index}`, estimate_hours_low: 0.5, approved_by: 'setări',
}));
const planLeft = conveyorNext({
  now: '2026-11-04T09:00:00Z',
  day_end_at: day.day_end_at,
  max_threads: 1,
  queues: { committed: [{ stable_key: 'bug:1', estimate_hours_low: 0.5 }, { stable_key: 'bug:2', estimate_hours_low: 0.5 }], reservoir: reservoirOnly },
});
assert.deepEqual(planLeft.start.map((item) => item.stable_key), ['bug:1']);
assert.equal(planLeft.new_work_card, null, 'bug:2 still waits for a thread');
const lastPlanItem = conveyorNext({
  now: '2026-11-04T09:30:00Z',
  day_end_at: day.day_end_at,
  max_threads: 1,
  done_keys: ['bug:1'],
  queues: { committed: [{ stable_key: 'bug:1', estimate_hours_low: 0.5 }, { stable_key: 'bug:2', estimate_hours_low: 0.5 }], reservoir: reservoirOnly },
});
assert.deepEqual(lastPlanItem.start.map((item) => item.stable_key), ['bug:2']);
assert.deepEqual(
  lastPlanItem.new_work_card.items.map((item) => [item.stable_key, item.title]),
  [0, 1, 2, 3].map((index) => [`reservoir:tests:${index}`, `Teste lipsă ${index}`]),
  'the card goes out while the last plan item runs',
);

// With the plan done and the card unanswered, the day does not end: the tap wakes
// the coordinator, and the next wake is the next card batch or the end.
const unanswered = conveyorNext({
  now: '2026-11-04T10:30:00Z',
  day_end_at: day.day_end_at,
  proposed_keys: ['reservoir:tests:0'],
  queues: { reservoir: reservoirOnly },
});
assert.equal(unanswered.continue, true);
assert.equal(unanswered.reason, 'awaiting_new_work_card');
assert.equal(unanswered.new_work_card, null, 'one card at a time');
assert.equal(unanswered.send_day_end_report, false);
assert.equal(unanswered.next_wake_in_minutes, 150, '12:30 local wakes at the 15:00 batch');

// „Nu, nimic nou azi” and items the human left out are not proposed again.
const noNewWork = conveyorNext({
  now: '2026-11-04T10:30:00Z', day_end_at: day.day_end_at, no_new_work: true, queues: { reservoir: reservoirOnly },
});
assert.equal(noNewWork.continue, false);
assert.equal(noNewWork.reason, 'no_executable_work');
assert.equal(noNewWork.new_work_card, null);
const declined = conveyorNext({
  now: '2026-11-04T10:30:00Z',
  day_end_at: day.day_end_at,
  declined_keys: ['reservoir:tests:0', 'reservoir:tests:1'],
  queues: { reservoir: reservoirOnly },
});
assert.deepEqual(declined.new_work_card.items.map((item) => item.stable_key), [
  'reservoir:tests:2', 'reservoir:tests:3', 'reservoir:tests:4', 'reservoir:tests:5',
]);

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

// Betora, 5.11.2026: the day the human chose ran out at 15:50 local with 2h on
// the clock. A plan made after the day conversation asks what comes next
// instead of ending the day or reaching for the reservoir (choice of 5.11.2026).
const betoraDay = { day_end_at: '2026-11-05T16:02:00Z', direction: 'Bug-urile de securitate 1348–1352' };
const directionDone = conveyorNext({
  now: '2026-11-05T13:50:00Z', ...betoraDay, done_keys: ['bug:1348'], queues: { committed: [{ stable_key: 'bug:1348' }] },
});
assert.equal(directionDone.continue, true);
assert.equal(directionDone.reason, 'awaiting_direction_card');
assert.deepEqual(directionDone.direction_card, {
  post: 'now', question: 'Am terminat ce ai ales. Pe ce mai lucrăm până la 18:02?',
});
assert.equal(directionDone.send_day_end_report, false);
assert.equal(directionDone.next_wake_in_minutes, 130, '15:50 local wakes at the 18:00 batch; the tap wakes it sooner');
const directionWaiting = conveyorNext({
  now: '2026-11-05T14:00:00Z', ...betoraDay, direction_card_pending: true, waiting_on_human: ['bug:1348'], queues: {},
});
assert.equal(directionWaiting.reason, 'awaiting_direction_card', 'merge cards waiting do not end a directed day');
assert.equal(directionWaiting.direction_card, null, 'one direction card at a time');
const directionDeclined = conveyorNext({ now: '2026-11-05T14:00:00Z', ...betoraDay, no_new_work: true, queues: {} });
assert.equal(directionDeclined.continue, false);
assert.equal(directionDeclined.reason, 'no_executable_work');
assert.equal(directionDeclined.send_day_end_report, true);
const directionLate = conveyorNext({ now: '2026-11-05T15:50:00Z', ...betoraDay, queues: {} });
assert.equal(directionLate.reason, 'no_executable_work', 'under 15 minutes left the day closes');
assert.equal(directionLate.direction_card, null);
const directionTapped = conveyorNext({
  now: '2026-11-05T14:00:00Z',
  ...betoraDay,
  queues: { reservoir: [{ stable_key: 'reservoir:tests:0', estimate_hours_low: 0.25, approved_by: 'setările proiectului' }] },
});
assert.equal(directionTapped.reason, 'awaiting_new_work_card', 'a reservoir the human allowed still goes on its own card');
assert.equal(directionTapped.direction_card, null);
assert.equal(dry.direction_card, null, 'a plan without a direction keeps the old ending');

assert.throws(() => conveyorNext({ now: '2026-11-04T09:00:00Z', day_end_at: day.day_end_at, max_threads: 9 }));
assert.throws(() => conveyorNext({ now: '2026-11-04T09:00:00Z', day_end_at: day.day_end_at, queues: { filler: [] } }));
assert.throws(() => conveyorNext({ now: '2026-11-04T09:00:00Z', day_end_at: day.day_end_at, queues: { committed: [{}] } }));

// What the conveyor takes beyond the approved queue becomes a reserve row of
// the current plan, so Focus shows it as „Luat de bandă” (choice of 4.11.2026).
const [nextDay] = midday.start;
const [reservoirEntry] = afterTap.start;
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
  'queue_role=reserve; conveyor_source=reservoir; approved_by=setările proiectului, 04.11 · card: card 04.11 12:41 „Da, toate”',
);
assert.throws(
  () => conveyorPlanRow({ plan_id: 187, next_sequence: 15, now: '2026-11-04T10:25:00Z', item: { ...reservoirEntry, confirmed_by: '', source_type: 'todo', source_id: 3, title: 'x' } }),
  /new-work card/,
  'no reservoir row without the tap',
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
