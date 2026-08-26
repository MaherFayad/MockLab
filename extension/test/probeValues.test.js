/**
 * §7.4's probe values and §7.2/§7.5's queue selection, tested as the pure functions
 * they are.
 *
 * OWNER: probe-engineer.
 *
 * Why these matter as much as the state machine: a probe value that does not exercise
 * the site's real rendering path changes the element for the wrong reason, and a
 * candidate silently dropped from the queue is a field the probe reports as "not the
 * one". Both produce a confident answer that is wrong, which is §17.12's whole subject.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { probeValueFor, expectedReloads } from '../src/background/probeValues.js';
import { buildQueue, affectedKeys, allFields } from '../src/background/probeQueue.js';

/* ───────────────────────────────────────────────────────── §7.4 probe values */

test('1 a number is multiplied by 3 and 7 added, keeping integer-ness', () => {
  assert.equal(probeValueFor(450), 1357);
  assert.equal(probeValueFor(0), 7);
  assert.equal(probeValueFor(-2), 1);
  assert.equal(probeValueFor(0.15), 7.45);
  assert.equal(Number.isInteger(probeValueFor(1)), true);
});

test('2 a boolean flips, both ways', () => {
  assert.equal(probeValueFor(true), false);
  assert.equal(probeValueFor(false), true);
});

test('3 null is never probed — §7.4 says skip it', () => {
  assert.equal(probeValueFor(null), undefined);
  assert.equal(probeValueFor(undefined), undefined);
  assert.equal(probeValueFor({ nested: 1 }), undefined, 'nor a container');
  assert.equal(probeValueFor([1, 2]), undefined);
});

test('4 an enum flips inside its own family, so the site renders a state it knows', () => {
  assert.equal(probeValueFor('ON_TIME'), 'DELAYED');
  assert.equal(probeValueFor('DELAYED'), 'ON_TIME');
  assert.equal(probeValueFor('IN_STOCK'), 'OUT_OF_STOCK');
  assert.equal(probeValueFor('ACTIVE'), 'INACTIVE');
  // §7.4's enum test is `/^[A-Z0-9_]{2,30}$/` — UPPER case only. A lowercase
  // `on_time` is free text as far as the spec is concerned, and it is treated as free
  // text rather than quietly widened: the same string could be a display label.
  assert.equal(probeValueFor('on_time'), 'on_time ●');
  // It becomes enum-like the moment the site is known to put another value there, and
  // then the family flip is written in the case the field actually uses.
  assert.equal(probeValueFor('on_time', { observedValues: ['on_time'] }), 'delayed');
});

test('5 `avoid` is what makes VERIFY_ON a second experiment, not a repeat', () => {
  assert.equal(probeValueFor('ON_TIME', { avoid: 'DELAYED' }), 'CANCELLED');
  assert.equal(probeValueFor(450, { avoid: 1357 }), 4078);
  const marked = probeValueFor('Nora Al-Amri');
  assert.notEqual(probeValueFor('Nora Al-Amri', { avoid: marked }), marked);
});

test('6 a value really seen at the path beats anything invented', () => {
  assert.equal(probeValueFor('ON_TIME', { observedValues: ['CANCELLED', 'ON_TIME'] }), 'CANCELLED');
  assert.equal(
    probeValueFor('SILVER', { observedValues: ['GOLD'] }),
    'GOLD',
    'an enum with no known family still has the site\'s own other value'
  );
  assert.equal(
    probeValueFor('GOLD', { observedValues: ['GOLD'] }),
    'gold',
    'and an observed value equal to the current one is no use — fall through to the case flip'
  );
});

test('7 an unknown enum reverses case rather than inventing a constant', () => {
  // A made-up constant exercises the site's default branch, which changes the element
  // for a reason that says nothing about the field.
  assert.equal(probeValueFor('SEAT_2A'), 'seat_2a');
  assert.equal(probeValueFor('RUH'), 'ruh');
});

test('8 free text gets a visible glyph, and only one', () => {
  assert.equal(probeValueFor('Nora Al-Amri'), 'Nora Al-Amri ●');
  assert.equal(probeValueFor('Gate A17 · check in early'), 'Gate A17 · check in early ●');
  assert.notEqual(probeValueFor('x ●', { avoid: 'x ● ●' }), 'x ● ●');
});

test('9 every probe value really differs from the value it replaces', () => {
  // The property, over every shape the demo and the tests use. A probe value equal to
  // the original would produce a reload in which nothing was actually tried, and the
  // field would be discarded as "not the driver".
  for (const value of ['ON_TIME', 'GOLD', 'Nora', 'a', '', 'RUH', 450, 0, -1, 0.5, true, false]) {
    const probed = probeValueFor(value, { observedValues: [] });
    assert.notEqual(probed, value, `probing ${JSON.stringify(value)} produced the same value`);
    assert.notEqual(probed, undefined, `probing ${JSON.stringify(value)} produced nothing`);
  }
});

test('10 the reload estimate grows with the log of the queue, and never lies downward', () => {
  assert.equal(expectedReloads(1, false), 7);
  assert.equal(expectedReloads(4, false), 8);
  assert.equal(expectedReloads(12, false), 10);
  assert.equal(expectedReloads(12, true), 11, 'paranoid buys a third cycle');
  assert.ok(expectedReloads(400, false) < 16, 'even "check all fields" is a bounded promise');
});

/* ──────────────────────────────────────────── §7.2 / §7.5 the candidate queue */

const captured = (body) => ({ body, signature: { method: 'GET', urlPattern: 'https://demo.test/api/trip' } });
const nameFor = () => 'Trip';

test('11 a candidate whose source did not come back cannot be probed by refreshing', () => {
  const sources = new Map([['trip', captured({ status: 'ON_TIME' })]]);
  const { queue, notRefetched } = buildQueue({
    candidates: [
      { sigId: 'trip', path: '$.status', value: 'ON_TIME' },
      { sigId: 'session', path: '$.user.tier', value: 'GOLD' }
    ],
    sources,
    bindings: [],
    nameFor
  });
  assert.deepEqual(queue.map((item) => item.path), ['$.status']);
  assert.deepEqual(notRefetched, [{ sigId: 'session', path: '$.user.tier' }]);
});

test('12 a null-valued or absent field is skipped, and counted separately', () => {
  const sources = new Map([['trip', captured({ status: null, gate: 'A17' })]]);
  const { queue, nullValued } = buildQueue({
    candidates: [
      { sigId: 'trip', path: '$.status', value: null },
      { sigId: 'trip', path: '$.missing', value: 'x' },
      { sigId: 'trip', path: '$.gate', value: 'A17' }
    ],
    sources,
    bindings: [],
    nameFor
  });
  assert.deepEqual(queue.map((item) => item.path), ['$.gate']);
  assert.deepEqual(nullValued.map((item) => item.path), ['$.status', '$.missing']);
});

test('13 the queue reads the REAL value from the response, not the one the pick saw', () => {
  // A pick happened before two control reloads. If the site's value moved in between,
  // the probe must revert to what the site is serving NOW, or VERIFY_OFF would compare
  // against a page that never existed.
  const sources = new Map([['trip', captured({ status: 'DELAYED' })]]);
  const { queue } = buildQueue({
    candidates: [{ sigId: 'trip', path: '$.status', value: 'ON_TIME' }],
    sources,
    bindings: [],
    nameFor
  });
  assert.equal(queue[0].real, 'DELAYED');
  assert.deepEqual(queue[0].observed, ['ON_TIME'], 'and the older value becomes a §7.4 candidate value');
  assert.equal(queue[0].sourceName, 'Trip');
});

test('14 a Binding\'s observed values reach §7.4, without duplicates or the current one', () => {
  const sources = new Map([['trip', captured({ status: 'ON_TIME' })]]);
  const { queue } = buildQueue({
    candidates: [{ sigId: 'trip', path: '$.status', value: 'ON_TIME' }],
    sources,
    bindings: [
      { sigId: 'trip', path: '$.status', observedValues: ['ON_TIME', 'CANCELLED', 'CANCELLED'] },
      { sigId: 'trip', path: '$.other', observedValues: ['NOISE'] }
    ],
    nameFor
  });
  assert.deepEqual(queue[0].observed, ['CANCELLED']);
});

test('15 "check all fields" enumerates every leaf of every captured response', () => {
  const sources = new Map([
    ['trip', captured({ status: 'ON_TIME', price: { total: 450, taxRate: null } })],
    ['user', captured({ user: { displayName: 'Nora' } })],
    ['blob', captured({ __unparsed: true, preview: 'binary' })]
  ]);
  const fields = allFields({ sources });
  assert.deepEqual(fields.map((f) => f.path).sort(), ['$.price.total', '$.status', '$.user.displayName']);
  assert.equal(fields.every((f) => f.value !== null), true, 'a null leaf is not offered (§7.4)');
  assert.equal(allFields({ sources, max: 2 }).length, 2, 'and the walk is bounded');
});

/* ─────────────────────────────────────────────────── §7.6 affected elements */

test('16 the picked element leads the affected list, whatever the key order says', () => {
  const control = [
    { key: 'z-pill', snapshot: { text: 'On time' } },
    { key: 'a-banner', snapshot: { text: '' } }
  ];
  const mutated = [
    { key: 'z-pill', snapshot: { text: 'Cancelled' } },
    { key: 'a-banner', snapshot: { text: 'Your flight was cancelled' } }
  ];
  assert.deepEqual(affectedKeys(control, mutated, new Set(), 'z-pill'), ['z-pill', 'a-banner']);
  assert.deepEqual(affectedKeys(control, mutated, new Set(['a-banner']), 'z-pill'), ['z-pill']);
  assert.deepEqual(affectedKeys(control, control, new Set(), null), [], 'nothing moved, nothing claimed');
});
