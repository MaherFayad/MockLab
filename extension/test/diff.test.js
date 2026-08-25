/**
 * Snapshot diff tests (PLAN.md §7.3).
 *
 * OWNER: probe-engineer. Milestone M4 fills this with element-snapshot diff cases.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

test('diff module is present in the tree', async () => {
  const mod = await import('../src/shared/diff.js');
  assert.ok(mod, 'diff.js must be importable');
});
