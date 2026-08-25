/**
 * JSONPath subset tests (PLAN.md §5.4).
 *
 * OWNER: interceptor-engineer. §5.4 requires 30+ cases "including unicode keys, keys
 * with dots (must round-trip via bracket form), arrays of objects".
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  enumeratePaths,
  findByValue,
  formatPath,
  getByPath,
  joinPath,
  parsePath,
  setByPath
} from '../src/shared/jsonpath.js';

const trip = () => ({
  status: 'ON_TIME',
  flight: {
    number: 'SV 1042',
    origin: { code: 'RUH', city: 'Riyadh' },
    legs: [
      { code: 'RUH', seats: 12, open: true },
      { code: 'JED', seats: 0, open: false }
    ]
  },
  price: { currency: 'SAR', total: 450, taxRate: 0.15 },
  notes: null
});

/* ------------------------------------------------------------------ parsePath */

test('01 parses the bare root', () => {
  assert.deepEqual(parsePath('$'), []);
});

test('02 parses a dot key', () => {
  assert.deepEqual(parsePath('$.status'), [{ type: 'key', value: 'status' }]);
});

test('03 parses nested dot keys', () => {
  assert.deepEqual(parsePath('$.price.total'), [
    { type: 'key', value: 'price' },
    { type: 'key', value: 'total' }
  ]);
});

test('04 parses a numeric index', () => {
  assert.deepEqual(parsePath('$.legs[2]'), [
    { type: 'key', value: 'legs' },
    { type: 'index', value: 2 }
  ]);
});

test('05 parses a double-quoted bracket key', () => {
  assert.deepEqual(parsePath('$["any key"]'), [{ type: 'key', value: 'any key' }]);
});

test('06 parses a single-quoted bracket key', () => {
  assert.deepEqual(parsePath("$['any key']"), [{ type: 'key', value: 'any key' }]);
});

test('07 parses an escaped quote inside a bracket key', () => {
  assert.deepEqual(parsePath('$["say \\"hi\\""]'), [{ type: 'key', value: 'say "hi"' }]);
});

test('08 parses keys with $ and _ in dot form', () => {
  assert.deepEqual(parsePath('$.$ref._id'), [
    { type: 'key', value: '$ref' },
    { type: 'key', value: '_id' }
  ]);
});

test('09 rejects a path that does not start at the root', () => {
  assert.equal(parsePath('status'), null);
  assert.equal(parsePath('.status'), null);
  assert.equal(parsePath(''), null);
  assert.equal(parsePath(null), null);
});

test('10 rejects a dot key that is not an identifier', () => {
  assert.equal(parsePath('$.a b'), null);
  assert.equal(parsePath('$.1abc'), null);
  assert.equal(parsePath('$.'), null);
});

test('11 rejects unterminated or malformed brackets', () => {
  assert.equal(parsePath('$["oops'), null);
  assert.equal(parsePath('$[1'), null);
  assert.equal(parsePath('$[a]'), null);
  assert.equal(parsePath('$["k"x]'), null);
});

test('12 rejects the unsupported grammar §5.4 deliberately omits', () => {
  assert.equal(parsePath('$..status'), null, 'no recursive descent');
  assert.equal(parsePath('$.legs[*]'), null, 'no wildcards');
  assert.equal(parsePath('$.legs[?(@.open)]'), null, 'no filters');
  assert.equal(parsePath('$.legs[-1]'), null, 'no negative indexes');
});

/* --------------------------------------------------------- formatPath / joinPath */

test('13 formatPath prefers dot form for identifier keys', () => {
  assert.equal(formatPath([{ type: 'key', value: 'price' }, { type: 'key', value: 'total' }]), '$.price.total');
});

test('14 formatPath uses bracket form for a key containing a dot', () => {
  assert.equal(formatPath([{ type: 'key', value: 'a.b' }]), '$["a.b"]');
});

test('15 a key containing a dot round-trips through the bracket form', () => {
  const obj = { 'a.b': { 'c.d': 7 } };
  const path = joinPath(joinPath('$', 'a.b'), 'c.d');
  assert.equal(path, '$["a.b"]["c.d"]');
  assert.deepEqual(parsePath(path), [{ type: 'key', value: 'a.b' }, { type: 'key', value: 'c.d' }]);
  assert.equal(getByPath(obj, path), 7);
});

test('16 unicode keys round-trip through the bracket form', () => {
  const obj = { 'مدينة': 'الرياض', '航班': { '状态': 'ON_TIME' }, 'naïve': 1 };
  assert.equal(getByPath(obj, joinPath('$', 'مدينة')), 'الرياض');
  assert.equal(joinPath('$', 'مدينة'), '$["مدينة"]');
  const deep = joinPath(joinPath('$', '航班'), '状态');
  assert.equal(deep, '$["航班"]["状态"]');
  assert.equal(getByPath(obj, deep), 'ON_TIME');
  assert.equal(getByPath(obj, '$["naïve"]'), 1);
});

test('17 keys with quotes and backslashes round-trip', () => {
  const obj = { 'say "hi"': 1, 'back\\slash': 2 };
  const quoted = joinPath('$', 'say "hi"');
  const slashed = joinPath('$', 'back\\slash');
  assert.equal(getByPath(obj, quoted), 1);
  assert.equal(getByPath(obj, slashed), 2);
  assert.equal(formatPath(parsePath(quoted)), quoted);
  assert.equal(formatPath(parsePath(slashed)), slashed);
});

test('18 joinPath appends numeric indexes without quoting', () => {
  assert.equal(joinPath('$.legs', 0), '$.legs[0]');
  assert.equal(joinPath('$', 'legs'), '$.legs');
  assert.equal(joinPath('$', 'a b'), '$["a b"]');
});

/* ------------------------------------------------------------------- getByPath */

test('19 reads a top-level scalar', () => {
  assert.equal(getByPath(trip(), '$.status'), 'ON_TIME');
});

test('20 reads a nested scalar', () => {
  assert.equal(getByPath(trip(), '$.flight.origin.city'), 'Riyadh');
});

test('21 reads through arrays of objects', () => {
  assert.equal(getByPath(trip(), '$.flight.legs[1].code'), 'JED');
  assert.equal(getByPath(trip(), '$.flight.legs[0].seats'), 12);
  assert.equal(getByPath(trip(), '$.flight.legs[1].open'), false);
});

test('22 returns the whole subtree when the path points at a container', () => {
  assert.deepEqual(getByPath(trip(), '$.price'), { currency: 'SAR', total: 450, taxRate: 0.15 });
  assert.equal(getByPath(trip(), '$').status, 'ON_TIME');
});

test('23 distinguishes a real null from a missing key', () => {
  assert.equal(getByPath(trip(), '$.notes'), null);
  assert.equal(getByPath(trip(), '$.missing'), undefined);
});

test('24 returns undefined for out-of-range indexes and non-array indexing', () => {
  assert.equal(getByPath(trip(), '$.flight.legs[9].code'), undefined);
  assert.equal(getByPath(trip(), '$.price[0]'), undefined);
  assert.equal(getByPath(trip(), '$.status.deeper'), undefined);
});

test('25 returns undefined for an invalid path instead of throwing', () => {
  assert.equal(getByPath(trip(), '$..status'), undefined);
  assert.equal(getByPath(trip(), 'nonsense'), undefined);
});

test('26 does not walk into inherited properties', () => {
  const obj = Object.create({ inherited: 'nope' });
  obj.own = 'yes';
  assert.equal(getByPath(obj, '$.own'), 'yes');
  assert.equal(getByPath(obj, '$.inherited'), undefined);
});

/* ------------------------------------------------------------------- setByPath */

test('27 writes a top-level scalar and reports success', () => {
  const obj = trip();
  assert.equal(setByPath(obj, '$.status', 'CANCELLED'), true);
  assert.equal(obj.status, 'CANCELLED');
});

test('28 writes a nested scalar', () => {
  const obj = trip();
  assert.equal(setByPath(obj, '$.price.total', 1357), true);
  assert.equal(obj.price.total, 1357);
});

test('29 writes into an array of objects', () => {
  const obj = trip();
  assert.equal(setByPath(obj, '$.flight.legs[1].code', 'DMM'), true);
  assert.equal(obj.flight.legs[1].code, 'DMM');
  assert.equal(obj.flight.legs[0].code, 'RUH');
});

test('30 replaces an array element wholesale', () => {
  const obj = trip();
  assert.equal(setByPath(obj, '$.flight.legs[0]', { code: 'X' }), true);
  assert.deepEqual(obj.flight.legs[0], { code: 'X' });
});

test('31 CREATES NOTHING: a missing final key is refused', () => {
  const obj = trip();
  assert.equal(setByPath(obj, '$.price.discount', 10), false);
  assert.equal('discount' in obj.price, false);
});

test('32 CREATES NOTHING: a missing intermediate step is refused', () => {
  const obj = trip();
  assert.equal(setByPath(obj, '$.meta.deep.value', 1), false);
  assert.equal('meta' in obj, false);
});

test('33 CREATES NOTHING: an out-of-range index is refused', () => {
  const obj = trip();
  assert.equal(setByPath(obj, '$.flight.legs[5].code', 'X'), false);
  assert.equal(obj.flight.legs.length, 2);
});

test('34 refuses the bare root and invalid paths', () => {
  const obj = trip();
  assert.equal(setByPath(obj, '$', { replaced: true }), false);
  assert.equal(setByPath(obj, '$..status', 'X'), false);
  assert.equal(setByPath(obj, 'status', 'X'), false);
  assert.equal(obj.status, 'ON_TIME');
});

test('35 writes null and false without being mistaken for a failure', () => {
  const obj = trip();
  assert.equal(setByPath(obj, '$.status', null), true);
  assert.equal(obj.status, null);
  assert.equal(setByPath(obj, '$.flight.legs[0].open', false), true);
  assert.equal(obj.flight.legs[0].open, false);
});

/* -------------------------------------------------------------- enumeratePaths */

test('36 enumerates every leaf scalar, and only leaves', () => {
  const leaves = enumeratePaths(trip());
  const paths = leaves.map((l) => l.path);
  assert.ok(paths.includes('$.status'));
  assert.ok(paths.includes('$.flight.origin.city'));
  assert.ok(paths.includes('$.flight.legs[0].seats'));
  assert.ok(paths.includes('$.flight.legs[1].open'));
  assert.ok(paths.includes('$.notes'), 'null is a leaf');
  assert.ok(!paths.includes('$.price'), 'containers are not leaves');
  assert.equal(leaves.length, 14);
});

test('37 every enumerated path reads back to its value', () => {
  const obj = { 'a.b': [{ 'مدينة': 1 }], plain: 'x' };
  for (const leaf of enumeratePaths(obj)) {
    assert.deepEqual(getByPath(obj, leaf.path), leaf.value, leaf.path);
  }
  assert.deepEqual(
    enumeratePaths(obj).map((l) => l.path).sort(),
    ['$.plain', '$["a.b"][0]["مدينة"]']
  );
});

test('38 respects maxDepth and maxPaths', () => {
  const deep = { a: { b: { c: { d: 'too deep' } } } };
  assert.equal(enumeratePaths(deep, 2).length, 0);
  assert.equal(enumeratePaths(deep, 4).length, 1);
  const wide = { list: Array.from({ length: 100 }, (_, i) => i) };
  assert.equal(enumeratePaths(wide, 12, 10).length, 10);
});

test('39 survives cycles instead of hanging', () => {
  const obj = { name: 'loop' };
  obj.self = obj;
  const leaves = enumeratePaths(obj);
  assert.ok(leaves.some((l) => l.path === '$.name'));
});

/* ----------------------------------------------------------------- findByValue */

test('40 finds an exact string leaf, case-insensitively', () => {
  const hits = findByValue(trip(), 'on_time');
  assert.deepEqual(hits, [{ path: '$.status', value: 'ON_TIME', kind: 'exact' }]);
});

test('41 finds a number by its rendered text, and by a formatted variant', () => {
  assert.deepEqual(findByValue(trip(), '450'), [{ path: '$.price.total', value: 450, kind: 'exact' }]);
  // "SAR 1,450" style needles reach the leaf through numeric equality, not text.
  assert.deepEqual(findByValue({ total: 1450 }, '1,450'), [{ path: '$.total', value: 1450, kind: 'numeric' }]);
  assert.deepEqual(findByValue({ total: 450 }, '450.00'), [{ path: '$.total', value: 450, kind: 'numeric' }]);
});

test('42 finds a substring inside a longer leaf', () => {
  const hits = findByValue(trip(), 'SV');
  assert.deepEqual(hits, [{ path: '$.flight.number', value: 'SV 1042', kind: 'substring' }]);
});

test('43 finds every element of an array of objects that matches', () => {
  const hits = findByValue(trip(), 'RUH');
  assert.deepEqual(hits.map((h) => h.path), ['$.flight.origin.code', '$.flight.legs[0].code']);
});

test('44 ignores null leaves and empty needles', () => {
  assert.deepEqual(findByValue(trip(), ''), []);
  assert.deepEqual(findByValue(trip(), null), []);
  assert.deepEqual(findByValue({ a: null }, 'null'), []);
});

test('45 does not confuse booleans with numbers', () => {
  assert.deepEqual(findByValue({ open: true, count: 1 }, '1'), [
    { path: '$.count', value: 1, kind: 'exact' }
  ]);
  assert.deepEqual(findByValue({ open: true }, 'true'), [
    { path: '$.open', value: true, kind: 'exact' }
  ]);
  assert.deepEqual(findByValue({ open: true }, '1'), [], 'true must never match 1');
});
