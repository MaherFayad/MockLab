/**
 * M5's Scenarios in the worker, tested without a browser — PLAN.md §10.4, §4, §12.4
 * #10–#13, and the two rules that shape every answer below (§1.1, §17.4).
 *
 * OWNER: interceptor-engineer.
 *
 * The Scenario CRUD: what a save snapshots, what a rename may move, what an apply
 * really did. Its twin `presets.import.test.js` drives the import door, and the world
 * both run in is `testlib/scenarioWorld.js` — see that file for why it is shared and
 * why every message goes through the worker's real router.
 *
 * Split from one file at 536 lines under §17.10, along the seam `scenarioFile.test.js`
 * already has: a document MockLab did not write is a different subject from a Scenario
 * MockLab made.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { S } from '../src/panel/strings.js';
import { ORIGIN, OTHER, SIG, UNKNOWN_SIG, setup, seedChanges, importable } from '../testlib/scenarioWorld.js';

/* ─────────────────────────────────────────────────────────────────────── routing */

test('1 every preset type the panel and the MCP tools send is routed', async () => {
  const { presets, api, MSG, send } = await setup();
  for (const type of presets.PRESET_MESSAGE_TYPES) {
    assert.ok(api.CHANGE_MESSAGE_TYPES.has(type), `${type} must be in the set background.js routes on`);
  }
  assert.equal(presets.PRESET_MESSAGE_TYPES.size, 6, 'six: §12.4 #10–#13 plus §10.4 Rename and Import');
  // And the router really answers them — `undefined` is what six milestones of "not
  // ready yet" looked like from both callers.
  for (const type of presets.PRESET_MESSAGE_TYPES) {
    assert.notEqual(await send(type, { presetId: 'nope', name: 'x', preset: importable() }), undefined, type);
  }
  assert.equal(MSG.LIST_PRESETS, 'msg:listPresets');
});

/* ──────────────────────────────────────────────────────────────────────── saving */

test('2 an empty site lists no scenarios, and says which site it means', async () => {
  const { send } = await setup();
  assert.deepEqual(await send('msg:listPresets'), { ok: true, origin: ORIGIN, presets: [] });
});

test('3 saving with nothing turned on is refused with the sentence that says what to do', async () => {
  const { send } = await setup();
  const res = await send('msg:savePreset', { name: 'Nothing' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-changes');
  assert.equal(res.message, S.scenarios.nothingToSave);
  assert.deepEqual((await send('msg:listPresets')).presets, [], 'and nothing was stored');
});

test('4 saving snapshots the enabled, non-probe Changes only (§7.1, §10.4)', async () => {
  const { store, send } = await setup();
  await seedChanges(store);
  const res = await send('msg:savePreset', { name: 'Flight cancelled', emoji: '🚩' });
  assert.equal(res.ok, true);
  assert.equal(res.preset.name, 'Flight cancelled');
  assert.equal(res.preset.emoji, '🚩');
  assert.equal(res.preset.origin, ORIGIN);
  assert.deepEqual(
    res.preset.changes.map((c) => c.path).sort(),
    ['$.price.total', '$.status'],
    'the disabled one and the probe scaffolding are not the user\'s work'
  );
  const status = res.preset.changes.find((c) => c.path === '$.status');
  assert.deepEqual(
    Object.keys(status).sort(),
    ['enabled', 'note', 'path', 'sigId', 'value'],
    'the same five fields the file format writes — no id, so a Scenario cannot alias a live Change'
  );
});

test('5 the embedded copy is a COPY: later edits to the Change do not reach into it (§4)', async () => {
  const { store, send } = await setup();
  await seedChanges(store);
  const saved = await send('msg:savePreset', { name: 'Before' });
  const live = (await store.getChanges(ORIGIN)).find((c) => c.path === '$.status');
  await store.updateChange(ORIGIN, live.id, { value: 'DELAYED' });
  const after = (await send('msg:listPresets')).presets[0];
  assert.equal(after.changes.find((c) => c.path === '$.status').value, 'CANCELLED');
  assert.equal(saved.preset.changes.find((c) => c.path === '$.status').value, 'CANCELLED');
});

test('6 a name is trimmed, an empty one refused, a very long one cut rather than refused', async () => {
  const { store, send } = await setup();
  await seedChanges(store);
  assert.equal((await send('msg:savePreset', { name: '   ' })).reason, 'bad-name');
  assert.equal((await send('msg:savePreset', { name: 42 })).message, S.scenarios.nameEmpty);
  assert.equal((await send('msg:savePreset', { name: '  Spaced  ' })).preset.name, 'Spaced');
  const long = await send('msg:savePreset', { name: 'x'.repeat(400) });
  assert.equal(long.ok, true);
  assert.equal(long.preset.name.length, 120, 'the bound an imported scenario has to satisfy');
});

test('7 no symbol picked means §11\'s default, never an empty card', async () => {
  const { store, send } = await setup();
  await seedChanges(store);
  assert.equal((await send('msg:savePreset', { name: 'A' })).preset.emoji, S.scenarios.defaultSymbol);
  assert.equal((await send('msg:savePreset', { name: 'B', emoji: '  ' })).preset.emoji, S.scenarios.defaultSymbol);
  assert.equal((await send('msg:savePreset', { name: 'C', emoji: '🚩🚩🚩🚩🚩🚩🚩' })).preset.emoji.length, 8);
});

/* ────────────────────────────────────────────────────────────── rename and delete */

test('8 Rename changes the name and the symbol, and NOTHING else (§10.4)', async () => {
  const { store, send } = await setup();
  await seedChanges(store);
  const made = (await send('msg:savePreset', { name: 'Old' })).preset;
  const res = await send('msg:updatePreset', {
    presetId: made.id,
    name: 'New',
    emoji: '💥',
    // The two a caller must not be able to move. Re-snapshotting under an existing name
    // is §1.1's lie in Scenario form; re-pointing the origin is Deviation 63 by the back
    // door.
    changes: [{ sigId: 'evil', path: '$.x', value: 1 }],
    origin: undefined
  });
  assert.equal(res.ok, true);
  assert.equal(res.preset.name, 'New');
  assert.equal(res.preset.emoji, '💥');
  assert.deepEqual(res.preset.changes, made.changes);
  assert.equal(res.preset.id, made.id);
  assert.equal(res.preset.createdAt, made.createdAt);
});

test('9 renaming a scenario that is not there says so instead of creating one', async () => {
  const { send } = await setup();
  const res = await send('msg:updatePreset', { presetId: 'ghost', name: 'New' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-such-preset');
  assert.deepEqual((await send('msg:listPresets')).presets, []);
});

test('10 an empty rename is refused, and the stored name survives it', async () => {
  const { store, send } = await setup();
  await seedChanges(store);
  const made = (await send('msg:savePreset', { name: 'Keep' })).preset;
  assert.equal((await send('msg:updatePreset', { presetId: made.id, name: '' })).reason, 'bad-name');
  assert.equal((await send('msg:listPresets')).presets[0].name, 'Keep');
});

test('11 Delete removes exactly one, and an unknown id is not a success', async () => {
  const { store, send } = await setup();
  await seedChanges(store);
  const one = (await send('msg:savePreset', { name: 'One' })).preset;
  await send('msg:savePreset', { name: 'Two' });
  assert.deepEqual(await send('msg:deletePreset', { presetId: one.id }), { ok: true, origin: ORIGIN, deleted: 1 });
  assert.deepEqual((await send('msg:listPresets')).presets.map((p) => p.name), ['Two']);
  assert.equal((await send('msg:deletePreset', { presetId: one.id })).reason, 'no-such-preset');
});

/* ───────────────────────────────────────────────────────────────────── applying */

test('12 Apply writes the scenario\'s changes and refreshes the page (§10.4)', async () => {
  const { store, send, state } = await setup();
  await seedChanges(store);
  const made = (await send('msg:savePreset', { name: 'Cancelled' })).preset;
  await store.clearChanges(ORIGIN);

  const res = await send('msg:applyPreset', { presetId: made.id });
  assert.equal(res.ok, true);
  assert.equal(res.applied, 2);
  assert.equal(res.unapplied, 0);
  assert.equal(res.refreshed, true);
  assert.equal(state.reloads, 1);
  const live = await store.getChanges(ORIGIN);
  assert.deepEqual(live.map((c) => c.path).sort(), ['$.price.total', '$.status']);
  assert.equal(live.find((c) => c.path === '$.status').value, 'CANCELLED');
});

test('13 a change whose source this site has never loaded is stored and reported UNAPPLIED (§1.1)', async () => {
  const { store, send } = await setup();
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.status', value: 'CANCELLED' });
  await store.addChange({ origin: ORIGIN, sigId: UNKNOWN_SIG, path: '$.name', value: 'Nobody' });
  const made = (await send('msg:savePreset', { name: 'Mixed' })).preset;
  await store.clearChanges(ORIGIN);

  const res = await send('msg:applyPreset', { presetId: made.id });
  assert.equal(res.applied, 1);
  assert.equal(res.unapplied, 1, 'the panel renders §11\'s appliedPartly from this number');
  assert.equal((await store.getChanges(ORIGIN)).length, 2, 'stored anyway — it applies the day that request happens');
});

test('14 a change saved switched OFF is applied switched off, and counted apart', async () => {
  const { store, send } = await setup();
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.a', value: 1 });
  const made = (await send('msg:importPreset', {
    preset: importable({ changes: [{ sigId: SIG, path: '$.a', value: 1, enabled: true }, { sigId: SIG, path: '$.b', value: 2, enabled: false }] })
  })).preset;
  await store.clearChanges(ORIGIN);

  const res = await send('msg:applyPreset', { presetId: made.id });
  assert.deepEqual([res.applied, res.unapplied, res.disabled], [1, 0, 1]);
  const off = (await store.getChanges(ORIGIN)).find((c) => c.path === '$.b');
  assert.equal(off.enabled, false, 'a Scenario means what it said when it was saved');
});

test('15 Apply upserts: the field it names moves, a field it does not name stays', async () => {
  const { store, send } = await setup();
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.status', value: 'DELAYED' });
  const made = (await send('msg:savePreset', { name: 'Delayed' })).preset;
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.status', value: 'ON_TIME' });
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.gate', value: 'B4' });

  await send('msg:applyPreset', { presetId: made.id });
  const live = await store.getChanges(ORIGIN);
  assert.equal(live.find((c) => c.path === '$.status').value, 'DELAYED', 'the scenario wins on its own field');
  assert.equal(live.find((c) => c.path === '$.gate').value, 'B4', 'and takes nothing else away');
});

test('16 Apply writes NO link state — not verified, not candidate (§17.4, Deviation 65)', async () => {
  const { store, send } = await setup();
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.status', value: 'CANCELLED' });
  const made = (await send('msg:savePreset', { name: 'Cancelled' })).preset;
  await send('msg:applyPreset', { presetId: made.id });
  assert.deepEqual(await store.getBindings(ORIGIN), [], 'nobody picked anything and nothing was probed');
});

test('17 Apply records when it was last used, and never touches what it does', async () => {
  const { store, send } = await setup();
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.status', value: 'CANCELLED' });
  const made = (await send('msg:savePreset', { name: 'Cancelled' })).preset;
  assert.equal(made.lastAppliedAt, undefined);
  await send('msg:applyPreset', { presetId: made.id });
  const after = (await send('msg:listPresets')).presets[0];
  assert.ok(after.lastAppliedAt >= made.createdAt);
  assert.deepEqual(after.changes, made.changes);
});

test('18 refresh:false is honoured, and the answer says what happened, not what was asked', async () => {
  const { store, send, state } = await setup();
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.status', value: 'CANCELLED' });
  const made = (await send('msg:savePreset', { name: 'Cancelled' })).preset;
  const res = await send('msg:applyPreset', { presetId: made.id, refresh: false });
  assert.equal(res.refreshed, false);
  assert.equal(state.reloads, 0);
});

test('19 applying a scenario that is not there changes nothing', async () => {
  const { store, send, state } = await setup();
  const res = await send('msg:applyPreset', { presetId: 'ghost' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-such-preset');
  assert.equal(state.reloads, 0, 'and the page is not refreshed for nothing');
  assert.deepEqual(await store.getChanges(ORIGIN), []);
});

/* ─────────────────────────────────────────────────────────────────────── import */

test('27 scenarios are per site, and the tab decides which unless told otherwise', async () => {
  const { store, send } = await setup();
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.a', value: 1 });
  await send('msg:savePreset', { name: 'Here' });
  await send('msg:importPreset', { origin: OTHER, preset: { name: 'There', changes: [{ sigId: SIG, path: '$.a', value: 1 }] } });

  assert.deepEqual((await send('msg:listPresets')).presets.map((p) => p.name), ['Here']);
  assert.deepEqual((await send('msg:listPresets', { origin: OTHER })).presets.map((p) => p.name), ['There']);
});

test('28 one site cannot fill this browser\'s storage with scenarios', async () => {
  const { store, presets, send } = await setup();
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.a', value: 1 });
  const full = Array.from({ length: presets.MAX_PRESETS_PER_ORIGIN }, (_, i) => ({
    id: `p${i}`, origin: ORIGIN, name: `S${i}`, emoji: '🎬', changes: [], createdAt: 1
  }));
  await store.setPresets(ORIGIN, full);
  const res = await send('msg:savePreset', { name: 'One too many' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'too-many');
  assert.equal(res.message, S.errors.storageFull);
});

test('29 a write chrome.storage refused is never reported as a save (§1.1)', async () => {
  const { store, send, chrome } = await setup();
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.a', value: 1 });
  // The disk fills between the work and the save, which is when it really happens.
  chrome.__refuseWrites();
  const res = await send('msg:savePreset', { name: 'Doomed' });
  assert.equal(res.ok, false);
  assert.equal(res.message, S.errors.storageFull);
});

test('30 two saves in flight at once both land (the write lock is shared)', async () => {
  const { store, send } = await setup();
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.a', value: 1 });
  const [a, b] = await Promise.all([send('msg:savePreset', { name: 'A' }), send('msg:savePreset', { name: 'B' })]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual((await send('msg:listPresets')).presets.map((p) => p.name).sort(), ['A', 'B']);
});

test('31 every mutation tells the open panels, and a read tells nobody (§1.6)', async () => {
  const { store, send, chrome } = await setup();
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.a', value: 1 });
  const made = (await send('msg:savePreset', { name: 'A' })).preset;
  await send('msg:updatePreset', { presetId: made.id, name: 'B' });
  await send('msg:applyPreset', { presetId: made.id });
  await send('msg:importPreset', { preset: importable() });
  await send('msg:deletePreset', { presetId: made.id });
  const before = chrome.__broadcasts.length;
  await send('msg:listPresets');

  assert.equal(before, 5, 'save, rename, apply, import, delete');
  assert.equal(chrome.__broadcasts.length, before, 'reading is not a change');
  for (const message of chrome.__broadcasts) {
    assert.equal(message.type, 'msg:presetsChanged');
    assert.equal(message.payload.origin, ORIGIN);
    assert.deepEqual(Object.keys(message.payload), ['origin'], 'data-free: the panel re-reads, so it cannot go stale');
  }
});

test('32 a rejected broadcast — no panel open — never loses the write that preceded it', async () => {
  // The fake's sendMessage REJECTS, which is what Chrome really does with no receiver.
  const { store, send } = await setup();
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.a', value: 1 });
  const res = await send('msg:savePreset', { name: 'Saved anyway' });
  assert.equal(res.ok, true);
  assert.equal((await send('msg:listPresets')).presets.length, 1);
});
