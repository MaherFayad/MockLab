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
import { buildQueue, affectedKeys, allFields, isAncestorOf } from '../src/background/probeQueue.js';

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

test('14b the queue carries BOTH the captured value and the one the page has now', () => {
  // The person set `$.status` to DELAYED from the tree; the site still serves ON_TIME.
  // §7.4's replacement has to move away from what is ON SCREEN, or the probe writes the
  // value the Change is already holding, the element does not move, and the run reports
  // `noneConfirmed` about the field that drives it. §4's `observedValues` are "distinct
  // REAL values", so the captured one has to survive alongside it.
  const sources = new Map([['trip', captured({ status: 'ON_TIME', gate: 'A17' })]]);
  const overlays = new Map([['trip', [{ path: '$.status', value: 'DELAYED' }]]]);
  const { queue } = buildQueue({
    candidates: [
      { sigId: 'trip', path: '$.status', value: 'DELAYED', realValue: 'ON_TIME' },
      { sigId: 'trip', path: '$.gate', value: 'A17' }
    ],
    sources,
    bindings: [],
    overlays,
    nameFor
  });
  const status = queue.find((item) => item.path === '$.status');
  assert.equal(status.real, 'ON_TIME', 'what the site served');
  assert.equal(status.effective, 'DELAYED', 'what the page rendered from');
  assert.deepEqual(status.observed, ['ON_TIME'], 'and the captured value is a §7.4 candidate value');
  assert.equal(probeValueFor(status.effective, { observedValues: status.observed }), 'ON_TIME',
    '§7.4 moves away from the screen, to a value the site is known to render');

  const gate = queue.find((item) => item.path === '$.gate');
  assert.equal(gate.effective, 'A17', 'a field with no Change on it is unchanged in both');
  assert.equal(gate.real, 'A17');
});

test('14c the last Change on a path wins it, and §7.4\'s null rule reads the page too', () => {
  const sources = new Map([['trip', captured({ status: 'ON_TIME', gate: 'A17' })]]);
  const { queue, nullValued } = buildQueue({
    candidates: [
      { sigId: 'trip', path: '$.status', value: 'x' },
      { sigId: 'trip', path: '$.gate', value: 'A17' }
    ],
    sources,
    bindings: [],
    // §5.3: a signature's Changes apply in order, so the body ends up with the last.
    overlays: new Map([['trip', [
      { path: '$.status', value: 'DELAYED' },
      { path: '$.status', value: 'CANCELLED' },
      // A field the page is currently rendering as empty is the site's empty state, and
      // §7.4 refuses to probe one for exactly the reason it refuses a captured null.
      { path: '$.gate', value: null }
    ]]]),
    nameFor
  });
  assert.deepEqual(queue.map((item) => item.effective), ['CANCELLED']);
  assert.deepEqual(nullValued.map((item) => item.path), ['$.gate']);
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
    { key: 'div@1.9', snapshot: { text: 'On time' } },
    { key: 'div@1.0', snapshot: { text: '' } }
  ];
  const mutated = [
    { key: 'div@1.9', snapshot: { text: 'Cancelled' } },
    { key: 'div@1.0', snapshot: { text: 'Your flight was cancelled' } }
  ];
  assert.deepEqual(affectedKeys(control, mutated, new Set(), 'div@1.9'), ['div@1.9', 'div@1.0']);
  assert.deepEqual(affectedKeys(control, mutated, new Set(['div@1.0']), 'div@1.9'), ['div@1.9']);
  assert.deepEqual(affectedKeys(control, control, new Set(), null), [], 'nothing moved, nothing claimed');
});

test('17 a box that merely CONTAINS the picked element is not a place the field affects', () => {
  // §11 promises "This change affects {k} places on the page". Every wrapper around a
  // pill changes when the pill does, because `innerText` is inherited downward — so the
  // honest count excludes them, and the excluded set is decided by the node keys' own
  // tree paths rather than by hoping the sample never contains an ancestor.
  const moved = (key, text) => ({ key, snapshot: { text } });
  const control = [moved('body@1', 'Skyline On time SAR 450'), moved('div@1.0', 'On time'), moved('span@1.0.0', '')];
  const mutated = [moved('body@1', 'Skyline Cancelled SAR 450'), moved('div@1.0', 'Cancelled'), moved('span@1.0.0', 'x')];
  assert.deepEqual(affectedKeys(control, mutated, new Set(), 'div@1.0'), ['div@1.0', 'span@1.0.0'],
    'the wrapper is dropped; the child that changed is kept');
  assert.equal(isAncestorOf('body@1', 'div@1.0'), true);
  assert.equal(isAncestorOf('div@1.0', 'div@1.0'), false, 'a node is not its own ancestor');
  assert.equal(isAncestorOf('div@1.0', 'div@1.01'), false, 'and a shared prefix is not containment');
  assert.equal(isAncestorOf('html@', 'div@1.0'), true, 'the root contains everything but itself');
  assert.equal(isAncestorOf('pill', 'banner'), false, 'a key with no path decides nothing');
});
