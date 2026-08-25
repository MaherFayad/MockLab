/**
 * JSONPath subset tests (PLAN.md §5.4).
 *
 * OWNER: interceptor-engineer. Milestone M1 fills this with the >=30 cases §5.4
 * requires, including unicode keys, keys containing dots (must round-trip via the
 * bracket form) and arrays of objects.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

test('jsonpath module is present in the tree', async () => {
  const mod = await import('../src/shared/jsonpath.js');
  assert.ok(mod, 'jsonpath.js must be importable');
});
