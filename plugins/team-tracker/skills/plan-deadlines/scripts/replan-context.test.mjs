import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyBudget, inventoryDecision } from './replan-context.mjs';
const input = { mode: 'continue_day', planning_date: '2026-09-16', previous_date: '2026-09-16', day_limit_hours: 5, spent_hours: 3 };
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
test('reuse requires complete unchanged clean repository and instruction evidence from today', () => {
  const repo = { planning_date: input.planning_date, repo_path: '/a', head_sha: 'abc', dirty: false, complete: true, status_verified: true, registry_fingerprint: 'reg', instructions_fingerprint: 'rules' };
  assert.equal(inventoryDecision(repo, repo, input.planning_date).scan, 'reuse');
  for (const patch of [{ dirty: true }, { head_sha: 'def' }, { repo_path: '/b' }, { status_verified: false }, { instructions_fingerprint: 'changed' }, { registry_fingerprint: undefined }]) {
    assert.equal(inventoryDecision(repo, { ...repo, ...patch }, input.planning_date).scan, 'full');
  }
  assert.equal(inventoryDecision({ ...repo, complete: false }, repo, input.planning_date).scan, 'full');
  assert.equal(inventoryDecision(repo, repo, '2026-09-17').scan, 'full');
});
