/**
 * IMPORT_PRESET — the one door in MockLab a document MockLab did not write comes
 * through, and since M6 it is reachable from two sides (PLAN.md §10.4, §12.4, §1.1).
 *
 * OWNER: interceptor-engineer.
 *
 * The panel checks a chosen file with `panel/scenarioFile.js` and the worker checks the
 * PAYLOAD with the same function, so the socket cannot be looser than the file picker.
 * These are the shapes that must not get in — and the two that must: a scenario saved on
 * another site is refused BY NAME, and a value of `null` or `false` is data, not damage.
 *
 * Split from `presets.test.js` at 536 lines under §17.10; the world both suites drive is
 * `testlib/scenarioWorld.js`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { S } from '../src/panel/strings.js';
import { ORIGIN, OTHER, SIG, setup, importable } from '../testlib/scenarioWorld.js';

/* ─────────────────────────────────────────────────────────────────────── import */

test('20 an imported scenario gets a fresh id and this site\'s origin, whatever it carried', async () => {
  const { send } = await setup();
  const res = await send('msg:importPreset', {
    preset: importable({ id: 'id-from-the-file', origin: '', createdAt: 1 })
  });
  assert.equal(res.ok, true);
  assert.notEqual(res.preset.id, 'id-from-the-file', 'a file may never land on top of a Scenario already here');
  assert.equal(res.preset.origin, ORIGIN);
  assert.equal(res.preset.name, 'Flight cancelled');
});

test('21 importing the same payload twice gives two scenarios, not one overwritten', async () => {
  const { send } = await setup();
  const first = await send('msg:importPreset', { preset: importable() });
  const second = await send('msg:importPreset', { preset: importable() });
  assert.notEqual(first.preset.id, second.preset.id);
  assert.equal((await send('msg:listPresets')).presets.length, 2);
});

test('22 a scenario saved on another site is refused BY NAME over the socket too (Deviation 63)', async () => {
  const { send } = await setup();
  const res = await send('msg:importPreset', { preset: importable({ origin: 'https://www.trip.com' }) });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'other-site');
  assert.equal(res.message, S.scenarios.importOtherSite('www.trip.com'));
  assert.match(res.message, /www\.trip\.com/, 'naming the site is the part that lets a person act');
  assert.deepEqual((await send('msg:listPresets')).presets, []);
});

test('22b a tab MockLab cannot name a site for cannot be imported into (Deviation 63)', async () => {
  // The other-site check compares the file's origin against THIS site's. With no origin
  // there is nothing to compare, so every file would pass it — and land under a storage
  // key that is not a site. A tab that is not a tab is the way to reach this.
  const { store, send } = await setup();
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.a', value: 1 });
  const imported = await send('msg:importPreset', { tabId: null, preset: importable({ origin: 'https://www.trip.com' }) });
  assert.equal(imported.ok, false);
  assert.equal(imported.reason, 'no-origin');

  // And the same for saving: a Scenario filed under no site is one no site can find.
  const saved = await send('msg:savePreset', { tabId: null, name: 'Nowhere' });
  assert.equal(saved.ok, false);
  assert.equal(saved.reason, 'no-origin');
  assert.deepEqual(await store.getPresets(''), [], 'and nothing was filed under no site at all');
});

test('23 the worker refuses every damaged shape the file validator refuses', async () => {
  const { send } = await setup();
  const refusals = {
    'not an object': 'a string',
    'an array': [{ sigId: SIG, path: '$.a', value: 1 }],
    'no name': importable({ name: '' }),
    'a name that is not a string': importable({ name: { toString: () => 'x' } }),
    'no changes list': importable({ changes: undefined }),
    'changes that is not a list': importable({ changes: { sigId: SIG } }),
    'a change that is a string': importable({ changes: ['$.status=CANCELLED'] }),
    'a change with no sigId': importable({ changes: [{ path: '$.a', value: 1 }] }),
    'a change with no value KEY': importable({ changes: [{ sigId: SIG, path: '$.a' }] }),
    'a path outside §5.4': importable({ changes: [{ sigId: SIG, path: '$..status', value: 1 }] }),
    'a path with a wildcard': importable({ changes: [{ sigId: SIG, path: '$.a[*]', value: 1 }] }),
    'a path that is not a path': importable({ changes: [{ sigId: SIG, path: 'status', value: 1 }] }),
    'a null in the changes list': importable({ changes: [null] })
  };
  for (const [what, preset] of Object.entries(refusals)) {
    const res = await send('msg:importPreset', { preset });
    assert.equal(res.ok, false, `${what} must be refused`);
    assert.equal(res.message, S.scenarios.importNotScenario, `${what} gets §11's sentence for a file that is not a scenario`);
  }
  assert.deepEqual((await send('msg:listPresets')).presets, [], 'and none of them is half-imported');
});

test('24 an empty scenario and an enormous one each get their own sentence', async () => {
  const { send, presets } = await setup();
  const empty = await send('msg:importPreset', { preset: importable({ changes: [] }) });
  assert.equal(empty.reason, 'empty');
  assert.equal(empty.message, S.scenarios.importEmpty);

  const many = Array.from({ length: 1001 }, (_, i) => ({ sigId: SIG, path: `$.f${i}`, value: i }));
  const big = await send('msg:importPreset', { preset: importable({ changes: many }) });
  assert.equal(big.reason, 'too-big');
  assert.equal(big.message, S.scenarios.importTooBig);
  assert.equal(typeof presets.validateImport, 'function');
});

test('25 a value of null or false survives the round trip — the KEY is what is checked', async () => {
  const { send } = await setup();
  const res = await send('msg:importPreset', {
    preset: importable({
      changes: [
        { sigId: SIG, path: '$.a', value: null },
        { sigId: SIG, path: '$.b', value: false },
        { sigId: SIG, path: '$.c', value: 0 },
        { sigId: SIG, path: '$["odd key"]', value: '' }
      ]
    })
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.preset.changes.map((c) => c.value), [null, false, 0, '']);
});

test('26 nothing the payload carried beyond the known fields reaches the store', async () => {
  const { send } = await setup();
  const res = await send('msg:importPreset', {
    preset: importable({
      evil: 'payload',
      changes: [{ sigId: SIG, path: '$.a', value: 1, probe: true, origin: OTHER, extra: 'x' }]
    })
  });
  assert.equal(res.ok, true);
  assert.equal(res.preset.evil, undefined);
  assert.deepEqual(Object.keys(res.preset.changes[0]).sort(), ['enabled', 'path', 'sigId', 'value']);
  assert.equal(res.preset.changes[0].probe, undefined, 'a file cannot inject probe scaffolding');
});

/* ───────────────────────────────────────────────────────── sites, caps and writes */

