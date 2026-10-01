import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyBudget, inventoryDecision } from './replan-context.mjs';
const input = { mode: 'continue_day', planning_date: '2026-09-16', previous_date: '2026-09-16', day_limit_hours: 5, spent_hours: 3, spent_hours_basis: 'human_declared' };
test('same-day replans consume only the remaining budget, including overrun and closure', () => {
  assert.equal(dailyBudget(input).gross_daily_hours, 2);
  assert.equal(dailyBudget({ ...input, spent_hours: 6 }).gross_daily_hours, 0);
  assert.equal(dailyBudget({ ...input, spent_hours: 4.5 }).committed_target_hours, 0.5);
  assert.equal(dailyBudget({ ...input, mode: 'close_day' }).gross_daily_hours, 0);
  assert.equal(dailyBudget({ ...input, mode: 'extra_budget', extra_hours: 2, extra_authorized: true }).day_stop_hours, 7);
  assert.throws(() => dailyBudget({ ...input, extra_hours: 2 }));
  assert.throws(() => dailyBudget({ ...input, spent_hours: null }));
  assert.throws(() => dailyBudget({ ...input, previous_date: '2026-09-15' }));
  assert.throws(() => dailyBudget({ ...input, mode: 'new_day' }));
  assert.equal(dailyBudget({ ...input, mode: 'extra_budget', spent_hours: 6, extra_hours: 2, extra_authorized: true }).gross_daily_hours, 2);
});
test('reusing an applied extra-budget baseline never adds the authorization twice', () => {
  const extra = dailyBudget({ ...input, mode: 'extra_budget', extra_hours: 2, extra_authorized: true });
  assert.equal(dailyBudget({ ...input, day_limit_hours: extra.day_stop_hours }).day_stop_hours, 7);
});
test('parallel conversation estimates never become human spent hours or promised capacity', () => {
  const { spent_hours, spent_hours_basis, ...base } = input;
  const logs = [1, 2].map(id => ({ id, member: 'Edy', work_date: input.planning_date, hours: 1,
    description: '[durată activă estimată din conversație]' }));
  const pending = dailyBudget({ ...base, member: 'Edy', work_logs: logs });
  assert.equal(pending.spent_hours_at_planning, 0);
  assert.equal(pending.conversation_estimate_hours_at_planning, 2);
  assert.equal(pending.requires_reconciliation, true);
  assert.equal(pending.gross_daily_hours, 0, 'no capacity promise before reconciliation');
  const declared = dailyBudget({ ...base, member: 'Edy', work_logs: logs, available_hours_declared: 4 });
  assert.equal(declared.gross_daily_hours, 4, 'an existing human availability declaration wins');
  assert.equal(declared.day_stop_hours, 4, 'the stop agrees with declared remaining availability');
  assert.equal(declared.requires_reconciliation, false);
  assert.equal(declared.conversation_estimate_hours_at_planning, 2);
  assert.throws(() => dailyBudget({ ...input, spent_hours_basis: undefined }), /human-declared/);
  assert.throws(() => dailyBudget({ ...base, member: 'Edy', work_logs: [...logs, { ...logs[0], work_date: '2026-09-15' }] }), /Same-day/);
});
test('human reconciliation consumes capacity once and unspecified history stays separate', () => {
  const { spent_hours, spent_hours_basis, ...base } = input;
  const declared = { id: 1, member: 'Edy', work_date: input.planning_date, hours: 2,
    description: 'Verificat de mine [pontaj:basis=human_declared]' };
  assert.equal(dailyBudget({ ...base, member: 'Edy', work_logs: [declared, declared] }).gross_daily_hours, 3);
  const pending = dailyBudget({ ...base, member: 'Edy', work_logs: [{ ...declared, description: 'Istoric fără proveniență' }] });
  assert.equal(pending.unspecified_hours_at_planning, 2);
  assert.equal(pending.spent_hours_at_planning, 0);
  assert.equal(pending.requires_reconciliation, true);
  const extra = dailyBudget({ ...base, member: 'Edy', work_logs: [declared], available_hours_declared: 4,
    mode: 'extra_budget', extra_hours: 2, extra_authorized: true });
  assert.equal(extra.gross_daily_hours, 6);
  assert.equal(extra.day_stop_hours, 8);
});
test('an explicit remaining availability declaration can shrink the previous human stop', () => {
  const declared = dailyBudget({ ...input, day_limit_hours: 10, available_hours_declared: 2 });
  assert.equal(declared.spent_hours_at_planning, 3);
  assert.equal(declared.gross_daily_hours, 2);
  assert.equal(declared.day_stop_hours, 5);
  const extra = dailyBudget({ ...input, day_limit_hours: 10, available_hours_declared: 2,
    mode: 'extra_budget', extra_hours: 1, extra_authorized: true });
  assert.equal(extra.gross_daily_hours, 3);
  assert.equal(extra.day_stop_hours, 6);
  assert.equal(dailyBudget({ ...input, day_limit_hours: extra.day_stop_hours }).day_stop_hours, 6);
});
test('missing work logs never prove zero human work or promise a fresh full budget', () => {
  const { spent_hours, spent_hours_basis, ...base } = input;
  const unknown = { ...base, member: 'Edy', work_logs: [] };
  const pending = dailyBudget(unknown);
  assert.equal(pending.requires_reconciliation, true);
  assert.equal(pending.gross_daily_hours, 0);
  assert.equal(pending.spent_hours_at_planning, 0, 'no invented consumed hours');
  assert.equal(pending.day_stop_hours, 5, 'the previous human cap stays intact');
  const declared = dailyBudget({ ...unknown, available_hours_declared: 4 });
  assert.equal(declared.requires_reconciliation, false);
  assert.equal(declared.gross_daily_hours, 4);
  assert.equal(declared.day_stop_hours, 4);
  const explicitZero = dailyBudget({ ...input, spent_hours: 0 });
  assert.equal(explicitZero.requires_reconciliation, false);
  assert.equal(explicitZero.gross_daily_hours, 5, 'explicit human zero is valid evidence');
  const closure = dailyBudget({ ...unknown, mode: 'close_day' });
  assert.equal(closure.closed, true);
  assert.equal(closure.requires_reconciliation, true);
  assert.equal(closure.gross_daily_hours, 0, 'closure reports the limitation without new capacity');
});
test('reuse requires complete unchanged clean repository and instruction evidence from today', () => {
  const repo = { planning_date: input.planning_date, repo_path: '/a', head_sha: 'abc', dirty: false, complete: true, status_verified: true, registry_fingerprint: 'reg', instructions_fingerprint: 'rules' };
  assert.equal(inventoryDecision(repo, repo, input.planning_date).scan, 'reuse');
  for (const patch of [{ dirty: true }, { head_sha: 'def' }, { repo_path: '/b' }, { status_verified: false }, { instructions_fingerprint: 'changed' }, { registry_fingerprint: undefined }]) {
    assert.equal(inventoryDecision(repo, { ...repo, ...patch }, input.planning_date).scan, 'full');
  }
  assert.equal(inventoryDecision({ ...repo, complete: false }, repo, input.planning_date).scan, 'full');
  assert.equal(inventoryDecision(repo, repo, '2026-09-17').scan, 'full');
});
