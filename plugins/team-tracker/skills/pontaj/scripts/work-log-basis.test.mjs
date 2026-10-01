import test from 'node:test';
import assert from 'node:assert/strict';
import { workLogBasis, summarizeWorkLogs } from './work-log-basis.mjs';

test('provenance recognizes legacy estimates and explicit human reconciliation without guessing history', () => {
  assert.equal(workLogBasis({ description: '[durată activă estimată din conversație]' }), 'conversation_estimate');
  assert.equal(workLogBasis({ description: '[pontaj:basis=conversation_estimate]' }), 'conversation_estimate');
  assert.equal(workLogBasis({ id: -12, description: 'Old log' }), 'unspecified');
  assert.equal(workLogBasis({ description: '[durată activă estimată din conversație] [pontaj:basis=human_declared]' }), 'human_declared');
  for (const description of ['[pontaj:basis=human_declared] [pontaj:basis=conversation_estimate]',
    '[pontaj:basis=wrong]', '[pontaj:basis=human_declared', '[pontaj:basis=human_declared] [pontaj:basis=',
    '[pontaj:basis=human_declared] [pontaj:basis human]', '[pontaj:basis=HUMAN_DECLARED]',
    '[pontaj:basis=human_declared\n]']) {
    assert.equal(workLogBasis({ description }), 'unspecified');
  }
  assert.equal(workLogBasis({ description: '[DURATĂ ACTIVĂ ESTIMATĂ DIN CONVERSAȚIE]' }), 'unspecified');
});
test('summaries deduplicate verified rows, reject contradictory copies and keep every basis separate', () => {
  const human = { id: 1, hours: 2, description: '[pontaj:basis=human_declared]' };
  const estimate = { id: 2, hours: 1, description: '[pontaj:basis=conversation_estimate]' };
  const history = { id: 3, hours: 3, description: 'Old log' };
  assert.deepEqual(summarizeWorkLogs([human, human, estimate, history]), {
    human_declared_hours: 2, conversation_estimate_hours: 1, unspecified_hours: 3, requires_reconciliation: true,
  });
  assert.throws(() => summarizeWorkLogs([human, { ...human, hours: 1 }]), /Conflicting/);
  assert.throws(() => summarizeWorkLogs([{ ...human, hours: null }]), /Invalid/);
});
