/**
 * The probe state machine (PLAN.md §7), driven end to end against a fake page and a fake
 * store — no browser, no Playwright, every reload deterministic.
 *
 * OWNER: probe-engineer.
 *
 * This half is the PROTOCOL: what §7.1 does when it CAN prove something, and the two
 * bodies it has to reason about while doing it. `probe.failures.test.js` is the other
 * half — every way a run ends without a proof, and every way it is stopped. They share
 * `testlib/probeWorld.js`, which is the demo's own rendering as a keyed §7.3 sample.
 *
 * The browser suite (`probe.browser.test.js`) proves the same protocol against the real
 * demo site in real Chromium; these two files make each of its outcomes cheap to
 * reproduce, and reach states the demo cannot produce at all. That set is not described
 * in prose anywhere — it is the three named groups in `probe.failures.test.js`, checked
 * against `PROBE_FAIL` itself. The prose version of it was wrong: it named three
 * examples and read as a list, and the value it left out (INTERNAL, MockLab's own fault)
 * was also the only one no test anywhere exercised.
 *
 * Both halves are asserted throughout — what must be verified, and what must NOT be.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeChrome } from '../testlib/fakeChrome.js';

globalThis.chrome = fakeChrome();

const { ORIGIN, TAB, KEY, LABEL, DEMO_BODIES, node, makeWorld, finish, probeChanges } =
  await import('../testlib/probeWorld.js');
const { PROBE_PHASE, PROBE_STATE, PROBE_FAIL } = await import('../src/background/messages.js');
const { getBindings, getChanges, addChange, updateSettings } = await import(
  '../src/background/ruleStore.js'
);

/* ══════════════════════════════ §16 M4 DoD 1 — the demo pill ═══════ */
test('1 the demo pill is proved to be driven by $.status, and both its elements found', async () => {
  const world = makeWorld();
  assert.deepEqual(await world.start(), { ok: true, tabId: TAB });

  const view = await finish(world);
  assert.equal(view.phase, PROBE_PHASE.DONE);
  assert.equal(view.failure, '');
  assert.equal(view.binding.path, '$.status');
  assert.equal(view.binding.sourceName, 'Trip');
  assert.equal(view.binding.state, 'verified', 'the §17.4 word, only ever from CONFIRMED');
  assert.equal(view.value, 'ON_TIME', 'State D shows the REAL value, not the probe value');

  // §16 M4: "elements[] contains BOTH the pill and the derived banner", plus the
  // text-less status dot beside it that only §7.2's region can carry — and NOT the
  // wrapper whose text merely contains the pill's, nor the masked tip box.
  assert.deepEqual(view.binding.elements.map((fp) => fp.key), [KEY.pill, KEY.banner, KEY.dot]);
  assert.equal(view.affected, 3);

  // §16 M4: "in ≤ 8 reloads" — six, and named so a regression says which one grew.
  assert.equal(view.reload.index, 6, 'two control runs, two bisection batches, verify on and off');

  const stored = await getBindings(ORIGIN);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].probeMode, 'refresh');
  assert.deepEqual(stored[0].observedValues, ['ON_TIME']);
  assert.deepEqual(await probeChanges(), [], '§7.1 / §17.5: nothing of the probe\'s is left behind');
});

test('2 a batch can never confirm — the §7.1 states are all walked, in order', async () => {
  const world = makeWorld();
  await world.start();
  await finish(world);
  const order = world.states.filter((state, index) => state !== world.states[index - 1]);
  assert.deepEqual(order, [
    PROBE_STATE.CONTROL_A, PROBE_STATE.CONTROL_B, PROBE_STATE.TESTING,
    PROBE_STATE.VERIFY_ON, PROBE_STATE.VERIFY_OFF, PROBE_STATE.CONFIRMED,
    PROBE_STATE.CLEANUP, PROBE_STATE.DONE
  ]);

  // What was on the page at each reload: nothing, nothing, the top half, the single
  // field, the single field again with a DIFFERENT value, then nothing again.
  assert.deepEqual(world.batches, [
    [],
    [],
    ['$.status=DELAYED', '$.booking.status=DELAYED'],
    ['$.status=DELAYED'],
    ['$.status=CANCELLED'],
    []
  ]);
});

/* ══════════════════════════════ §16 M4 DoD 2 — the noisy box ═══════ */
test('3 an element that changes on its own is refused, not confirmed', async () => {
  // The tip box: different text on every load, and it carries the gate number, so a
  // value match really does offer `$.flight.gate` as a candidate for it.
  const world = makeWorld({
    pickedKey: KEY.tip,
    candidates: [{ sigId: 'trip', path: '$.flight.gate', value: 'A17', sourceName: 'Trip' }]
  });
  await world.start();
  const view = await finish(world);

  assert.equal(view.phase, PROBE_PHASE.FAILED);
  assert.equal(view.failure, PROBE_FAIL.TOO_NOISY);
  assert.equal(view.binding, null);
  assert.equal(view.reload.index, 2, 'the control runs alone are enough to refuse it');
  assert.deepEqual(await getBindings(ORIGIN), [], 'and nothing was written to the store');
  assert.deepEqual(await probeChanges(), []);
});

test('4 the gate really does drive that box — the refusal is about noise, not the field', async () => {
  // The negative control for test 3: with the tip's rotating half held still, the SAME
  // element and candidate ARE confirmed — `tooNoisy` is a fact about the page, not a
  // probe that can never find anything.
  const steady = (bodies) => [
    { key: KEY.tip, snapshot: node(`Gate ${bodies.trip.flight.gate}`) },
    { key: KEY.pill, snapshot: node(LABEL[bodies.trip.status]) }
  ];
  const world = makeWorld({
    pickedKey: KEY.tip,
    render: steady,
    candidates: [{ sigId: 'trip', path: '$.flight.gate', value: 'A17', sourceName: 'Trip' }]
  });
  await world.start();
  const view = await finish(world);
  assert.equal(view.phase, PROBE_PHASE.DONE);
  assert.equal(view.binding.path, '$.flight.gate');
});

/* ══════════════════════════════ the states no demo can reach ═══════ */
test('11 §7.5 — two fields that only drive an element together are found as a pair', async () => {
  // No demo fixture can produce this: it needs an element whose text depends on TWO
  // fields, such that changing either alone does nothing. Every single-field probe
  // fails, and §7.5's pair search is the only thing that can answer.
  const world = makeWorld({
    candidates: [
      { sigId: 'trip', path: '$.status', value: 'ON_TIME', sourceName: 'Trip' },
      { sigId: 'trip', path: '$.booking.status', value: 'ON_TIME', sourceName: 'Trip' },
      { sigId: 'trip', path: '$.flight.gate', value: 'A17', sourceName: 'Trip' }
    ],
    render: (bodies) => {
      const both = bodies.trip.status !== 'ON_TIME' && bodies.trip.booking.status !== 'ON_TIME';
      return [{ key: KEY.pill, snapshot: node(both ? 'Both moved' : 'On time') }];
    }
  });
  await world.start();
  const view = await finish(world);
  assert.equal(view.phase, PROBE_PHASE.DONE);
  assert.deepEqual(view.bindings.map((b) => b.path).sort(), ['$.booking.status', '$.status']);
  assert.equal(view.bindings.every((b) => b.state === 'verified'), true, '§7.5: one Binding per path');
  const stored = await getBindings(ORIGIN);
  assert.equal(stored.length, 2);
});

test('12 "check all fields" probes every leaf, with no candidate list at all', async () => {
  const world = makeWorld({ candidates: [] });
  assert.deepEqual(await world.start(), { ok: false, reason: PROBE_FAIL.NO_CANDIDATES }, 'nothing to rank');
  const exhaustive = makeWorld({ candidates: [] });
  assert.deepEqual(await exhaustive.start({ exhaustive: true }), { ok: true, tabId: TAB });
  const view = await finish(exhaustive, 10000);
  assert.equal(view.phase, PROBE_PHASE.DONE);
  assert.equal(view.binding.path, '$.status');
  assert.ok(view.reload.index <= 12, `${view.reload.index} reloads for 15 fields — §7.5's log2`);
});

test('13 the paranoid setting buys a third cycle, and it is really run', async () => {
  // After makeWorld, which clears the store the settings live in.
  const world = makeWorld();
  await updateSettings({ paranoid: true });
  await world.start();
  const view = await finish(world);
  await updateSettings({ paranoid: false });
  assert.equal(view.phase, PROBE_PHASE.DONE);
  assert.equal(view.reload.index, 8, 'six, plus the extra on/off pair');
  assert.equal(world.batches.filter((batch) => batch.length === 1).length, 3, 'the field was mutated alone three times');
  assert.deepEqual(world.batches[world.batches.length - 1], [], 'and the last load the user sees is the real site');
});

/* ═══════════════ the page as the person left it — §6.3, §7.4 and the divergence ═══ */

test('18 a field the person has ALREADY changed is still proved, and their Change survives', async () => {
  // M4's most natural journey, and the one QA reproduced as broken: change a value from
  // the tree, watch the page change, then ask MockLab to prove which field did it.
  //
  // This probe's control runs deliberately keep the person's Changes ON (see `protocol`),
  // so the page renders "Delayed" throughout. §7.4 must therefore move away from DELAYED,
  // not from the ON_TIME the SERVER sent. Basing it on the captured value writes DELAYED
  // over a Change already holding DELAYED: nothing moves, and the run reports
  // `noneConfirmed` about the field that drives the element. That is the mutation — put
  // `item.real` back into `applyProbeChanges` and this test fails with noneConfirmed.
  const world = makeWorld();
  const mine = await addChange({
    origin: ORIGIN, sigId: 'trip', path: '$.status', value: 'DELAYED', originalValue: 'ON_TIME'
  });
  await world.start();

  const view = await finish(world);
  assert.equal(view.phase, PROBE_PHASE.DONE, `probe failed: ${view.failure} ${view.detail || ''}`);
  assert.equal(view.binding.path, '$.status');
  assert.equal(view.binding.state, 'verified');
  assert.equal(view.value, 'ON_TIME', '§10.1D still names the value the SITE serves');
  assert.deepEqual(view.binding.elements.map((fp) => fp.key), [KEY.pill, KEY.banner, KEY.dot]);

  const stored = await getBindings(ORIGIN);
  assert.deepEqual(stored[0].observedValues, ['ON_TIME'],
    '§4: observedValues are "distinct REAL values ever seen", never one the person typed');

  assert.deepEqual(await probeChanges(), [], '§17.5');
  assert.deepEqual((await getChanges(ORIGIN)).map((c) => c.id), [mine.id],
    "and the person's own Change is exactly where they left it");
});

test('19 every probe value the run wrote differed from what the page was showing', async () => {
  // The general form of 18: whatever the queue holds, a batch that writes the value
  // already on screen tests nothing and DISCARDS a field that drives the element.
  const world = makeWorld();
  await addChange({ origin: ORIGIN, sigId: 'trip', path: '$.status', value: 'DELAYED' });
  await addChange({ origin: ORIGIN, sigId: 'trip', path: '$.booking.status', value: 'DELAYED' });
  await world.start();
  await finish(world);

  const written = world.batches.flat().filter(Boolean);
  assert.ok(written.length >= 3, `the run really wrote batches — ${JSON.stringify(world.batches)}`);
  for (const entry of written) {
    assert.notEqual(entry, '$.status=DELAYED', 'never the value the page was already rendering');
    assert.notEqual(entry, '$.booking.status=DELAYED');
  }
});
