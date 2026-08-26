/**
 * Every way a probe run ends WITHOUT a proof, and every way it is stopped (PLAN.md §7.1,
 * §11's failure copy, §17.5's cleanup).
 *
 * OWNER: probe-engineer. Split from `probe.test.js` under §17.10 — that file is the
 * protocol, this one is its refusals. The seam is the one §17.12 cares about: a probe
 * that cannot prove something has to SAY so, in the right sentence, having left the site
 * exactly as it found it, and there are eleven distinct ways for that to be wrong.
 *
 * Test 0 is what keeps this file honest about its own scope. The set of failures the
 * demo cannot produce used to be a sentence in a header, and QA's verdict on that was
 * right: convenient, not complete. It is a checked classification now.
 *
 * Both halves share `testlib/probeWorld.js`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fakeChrome } from '../testlib/fakeChrome.js';

globalThis.chrome = fakeChrome();

const { ORIGIN, TAB, KEY, LABEL, node, makeWorld, finish, probeChanges, untilApplied, bespoke } =
  await import('../testlib/probeWorld.js');
const { PROBE_LIMITS } = await import('../src/background/probeLink.js');
const { PROBE_MSG, PROBE_PHASE, PROBE_FAIL } = await import('../src/background/messages.js');
const { sweepProbeChanges } = await import('../src/background/probeChanges.js');
const { getChanges, getBindings, addChange } = await import('../src/background/ruleStore.js');

/* ═════════════ every way a probe can fail, and where each one is proved ══════════
 *
 * The header used to describe this in prose — "a source that never comes back, an
 * element that never re-resolves" — and QA's verdict on that was right: convenient, not
 * complete. The INTERNAL value was in neither list and in no test at all, so the one
 * failure that is MockLab's own fault was the one nothing exercised. (Written without
 * its `PROBE_FAIL.` prefix on purpose: the check below counts mentions, and a mention in
 * the prose that describes the check would be coverage claiming itself.) A prose list cannot
 * be complete, because nothing makes it so. This can: adding a twelfth failure without
 * classifying it fails the build, and so does classifying one nothing asserts about.
 *
 * Three kinds, and the difference is what a FIXTURE can produce, not what a site can:
 *   • the demo really produces it (`probe.browser.test.js` reaches two of these);
 *   • the demo cannot produce it — it settles in under a second, always re-resolves its
 *     own pill, re-fetches both sources on every load, never loses its content script,
 *     and never makes MockLab throw. These need the fake page below or `probeLink`'s
 *     fake port, which is exactly why both files exist;
 *   • it is about the REQUEST rather than the page, so it does not depend on a site at
 *     all and no browser suite reaches it either.
 * ═══════════════════════════════════════════════════════════════════════════════════ */
/* failure-coverage:begin */
const DEMO_PRODUCES = new Set([
  PROBE_FAIL.TOO_NOISY,        // the rotating tip box (browser DoD 2, test 3 here)
  PROBE_FAIL.NONE_CONFIRMED,   // pick something the data does not drive
  PROBE_FAIL.CANCELLED,        // "Stop checking" (browser DoD 3, tests 5 and 21 here)
  PROBE_FAIL.NO_CANDIDATES     // pick text that appears in neither demo response
]);
const DEMO_CANNOT_PRODUCE = new Set([
  PROBE_FAIL.ELEMENT_LOST,
  PROBE_FAIL.NOT_REFETCHED,
  PROBE_FAIL.TIMEOUT,
  PROBE_FAIL.NO_CONTENT_SCRIPT,
  PROBE_FAIL.INTERNAL
]);
const NOT_ABOUT_THE_PAGE = new Set([PROBE_FAIL.NO_PICK, PROBE_FAIL.BUSY]);
/* failure-coverage:end */

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SUITES = ['probe.test.js', 'probe.failures.test.js', 'probeLink.test.js'];
const readSuite = (name) => fs.readFileSync(path.join(HERE, name), 'utf8');

/** All three probe suites, with the classification above cut out of them. */
function assertionText() {
  return SUITES.map((name) => {
    const text = readSuite(name);
    const begin = text.indexOf('/* failure-coverage:begin */');
    if (begin === -1) return text;
    const end = text.indexOf('/* failure-coverage:end */');
    assert.notEqual(end, -1, 'the classification block must stay delimited at both ends');
    return text.slice(0, begin) + text.slice(end);
  }).join('\n');
}

const mentions = (text) => (text.match(/PROBE_FAIL\.[A-Z_]+/g) || []).length;

test('0 every way a probe can fail is classified, and asserted about by name', () => {
  const all = Object.entries(PROBE_FAIL);
  assert.ok(all.length >= 11, `PROBE_FAIL should not shrink silently — ${all.length} values`);

  for (const [name, value] of all) {
    const homes = [DEMO_PRODUCES, DEMO_CANNOT_PRODUCE, NOT_ABOUT_THE_PAGE].filter((set) => set.has(value));
    assert.equal(homes.length, 1,
      `PROBE_FAIL.${name} is in ${homes.length} of the three groups above. Put it in exactly one — ` +
      'a failure nobody classified is a failure nobody looked for a test for.');
  }

  // And the half QA found missing: classified is not covered.
  const text = assertionText();
  for (const [name] of all) {
    assert.ok(
      new RegExp(`PROBE_FAIL\\.${name}\\b`).test(text),
      `nothing in probe.test.js, probe.failures.test.js or probeLink.test.js asserts PROBE_FAIL.${name}. ` +
      'It is reachable in production and untested here.'
    );
  }

  // The exclusion must really exclude, or the classification would count as its own
  // coverage and the loop above would prove nothing at all. Exactly the classification
  // is removed: one mention per value, no more and no fewer.
  const whole = SUITES.map(readSuite).join('\n');
  assert.equal(mentions(whole) - mentions(text), all.length,
    'the classification block — and only it — is cut out before coverage is counted');
});/* ══════════════════════════════ §16 M4 DoD 3 — cancel ══════════════ */
test('5 cancelling mid-probe leaves zero probe changes in storage', async () => {
  const world = makeWorld();
  await world.start();

  // Stop it while a batch is on the page — the only moment a cancel can leave a mock.
  await untilApplied(world);
  assert.deepEqual(await world.stop(), { ok: true, tabId: TAB, cancelled: true });
  const view = await finish(world);
  assert.equal(view.phase, PROBE_PHASE.FAILED);
  assert.equal(view.failure, PROBE_FAIL.CANCELLED);
  assert.deepEqual(await probeChanges(), [], '§16 M4: 0 probe changes in storage');
  assert.deepEqual(await getBindings(ORIGIN), []);
});

test('6 §17.5 — a probe Change is exactly the shape the startup sweep deletes', async () => {
  const world = makeWorld();
  await world.start();
  const applied = await untilApplied(world);
  assert.equal(applied[0].probe, true, 'the flag the sweep and the badge both read');
  assert.equal(applied[0].enabled, true);
  await world.stop();
  await finish(world);

  // §17.5's other half on the same store: a crash leaves scaffolding behind, and the
  // next service-worker start removes it with no run left to clean up after itself.
  const real = await addChange({ origin: ORIGIN, sigId: 'trip', path: '$.status', value: 'CANCELLED' });
  await addChange({ origin: ORIGIN, sigId: 'trip', path: '$.price.total', value: 1, probe: true });
  assert.equal((await probeChanges()).length, 1);
  assert.equal(await sweepProbeChanges(), 1);
  assert.deepEqual(await probeChanges(), []);
  assert.deepEqual((await getChanges(ORIGIN)).map((c) => c.id), [real.id], 'the user\'s own Change survives');
});

/* ══════════════════════════════ honest failures ════════════════════ */
test('7 candidates that drive nothing are reported as driving nothing', async () => {
  const world = makeWorld({
    candidates: [
      { sigId: 'user', path: '$.user.tier', value: 'GOLD', sourceName: 'User' },
      { sigId: 'trip', path: '$.booking.reference', value: 'MKL8842', sourceName: 'Trip' }
    ]
  });
  await world.start();
  const view = await finish(world);
  assert.equal(view.phase, PROBE_PHASE.FAILED);
  assert.equal(view.failure, PROBE_FAIL.NONE_CONFIRMED);
  assert.deepEqual(await getBindings(ORIGIN), []);
  assert.deepEqual(await probeChanges(), []);
});

test('8 an element that cannot be re-resolved aborts rather than diffing a stranger', async () => {
  // §6.2: confidence below 0.8 means the node on screen may not be the one picked.
  const world = makeWorld({ confidence: 0.5 });
  await world.start();
  const view = await finish(world);
  assert.equal(view.failure, PROBE_FAIL.ELEMENT_LOST);
  assert.equal(view.reload.index, 1, 'the very first control run refuses to compare');

  const fine = makeWorld({ confidence: 0.8 });
  await fine.start();
  assert.equal((await finish(fine)).phase, PROBE_PHASE.DONE, '0.8 exactly is the floor, and it passes');
});

test('9 a source the page never asks for again is said so, not silently dropped', async () => {
  const world = makeWorld({
    missingSources: ['user'],
    candidates: [{ sigId: 'user', path: '$.user.displayName', value: 'Nora Al-Amri', sourceName: 'User' }]
  });
  await world.start();
  const view = await finish(world);
  assert.equal(view.failure, PROBE_FAIL.NOT_REFETCHED);
  assert.deepEqual(view.notRefetched, [{ sigId: 'user', path: '$.user.displayName' }]);
});

test('10 a change that does not change BACK is not a proof', async () => {
  // The page renders differently once it has ever been mocked — a session flag, a cache,
  // a site that re-orders on a second visit. VERIFY_ON passes, VERIFY_OFF does not
  // return to the control snapshot, and the run must refuse.
  let touched = false;
  const world = makeWorld({
    render: (bodies, load) => {
      if (bodies.trip.status !== 'ON_TIME') touched = true;
      const label = LABEL[bodies.trip.status] || bodies.trip.status;
      return [
        { key: KEY.pill, snapshot: node(touched ? `${label}!` : label) },
        { key: KEY.tip, snapshot: node(`tip ${load}`) }
      ];
    }
  });
  await world.start();
  const view = await finish(world);
  assert.equal(view.phase, PROBE_PHASE.FAILED);
  assert.equal(view.failure, PROBE_FAIL.TOO_NOISY);
  assert.match(view.detail, /did not return to the control state/);
  assert.deepEqual(await getBindings(ORIGIN), []);
});

/* ══════════════════════════════ the message surface ════════════════ */
test('14 the view says what is happening, and refuses a second run while one is live', async () => {
  const idle = makeWorld();
  const before = await idle.view();
  assert.equal(before.phase, PROBE_PHASE.IDLE);
  assert.equal(before.binding, null);
  assert.equal(before.reload, null);

  await idle.start();
  const running = await idle.view();
  assert.equal(running.phase, PROBE_PHASE.RUNNING);
  assert.equal(running.step, 'control', 'the key of §11\'s probe.step.control');
  assert.deepEqual(await idle.start(), { ok: false, reason: PROBE_FAIL.BUSY });
  await finish(idle);

  // A probe with nothing picked never starts at all.
  const unpicked = bespoke({ pickedElement: () => null });
  assert.deepEqual(await unpicked.handle({ type: PROBE_MSG.START_PROBE, payload: {} }), {
    ok: false, reason: PROBE_FAIL.NO_PICK
  });
});

test('15 a defect of ours is reported as one, not as a fact about the page', async () => {
  // An exception with no §11 reason behind it is MockLab breaking. Reporting it as
  // `timeout` or `noneConfirmed` would be a statement about the SITE that nothing
  // established — §17.12's lie told about a failure instead of a success.
  const world = makeWorld();
  await world.start();
  world.breakQueue = true;   // the next thing the run asks the worker for throws
  const view = await finish(world);
  assert.equal(view.phase, PROBE_PHASE.FAILED);
  assert.equal(view.failure, PROBE_FAIL.INTERNAL);
  assert.deepEqual(await probeChanges(), [], 'and CLEANUP still ran');
});

test('16 a tab with no page agent is told so, and nothing is applied to it', async () => {
  const deaf = bespoke({ portsFor: () => null });
  assert.deepEqual(await deaf.handle({ type: PROBE_MSG.START_PROBE, payload: {} }), {
    ok: false, reason: PROBE_FAIL.NO_CONTENT_SCRIPT
  });
  assert.deepEqual(await probeChanges(), []);
});

test('17 the three-minute cap belongs to the run, and it says so itself', async () => {
  // No page can be slow enough to reach this on the demo, and a real one can: ten
  // reloads that each settle in twenty seconds. The cap belongs to the RUN — the
  // per-reload budget in `probeLink.js` is a different limit with a different sentence.
  const world = makeWorld();
  const saved = PROBE_LIMITS.TOTAL_MS;
  PROBE_LIMITS.TOTAL_MS = -1;
  await world.start();
  const view = await finish(world);
  PROBE_LIMITS.TOTAL_MS = saved;
  assert.equal(view.failure, PROBE_FAIL.TIMEOUT);
  assert.equal(view.reload.index, 0, 'it stopped before touching the site at all');
  assert.deepEqual(await probeChanges(), []);
});

/* ═══════════════════════ "Stop checking" after the proof is complete ══════════════ */

test('20 a cancel that arrives after the proof is refused, and says so', async () => {
  // The window: VERIFY_OFF has answered and matched the control, so every experiment
  // §7.1 asks for has happened; §7.6's fingerprint round trip and the store write are
  // all that remain, and neither can reach another conclusion.
  //
  // Racing it was wrong in both directions at once — `link.abort` killed the round trip,
  // so `elements[]` fell back to the picked element and the panel said "affects 1 place"
  // about a proof that had found three, WHILE the run still wrote a verified Binding the
  // panel had already reported as stopped. Delete `if (run.proved)` from `cancel` and
  // both halves of this test fail.
  const world = makeWorld();
  world.holdFingerprints = true;
  await world.start();

  const deadline = Date.now() + 5000;
  while (!world.releaseFingerprints) {
    assert.ok(Date.now() < deadline, `§7.6's round trip never opened (state ${(await world.view()).state})`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(await world.stop(), { ok: true, tabId: TAB, cancelled: false },
    'there is no experiment left to stop, and the panel is told that rather than "stopped"');

  world.releaseFingerprints();
  const view = await finish(world);
  assert.equal(view.phase, PROBE_PHASE.DONE);
  assert.equal(view.failure, '', 'a run that finished is not reported as cancelled');
  assert.equal(view.binding.state, 'verified');
  assert.deepEqual(view.binding.elements.map((fp) => fp.key), [KEY.pill, KEY.banner, KEY.dot],
    '§7.6 is not truncated by a cancel it does not apply to');
  assert.equal(view.affected, 3, 'so "affects {k} places" is the count that was proved');
  assert.deepEqual(await probeChanges(), [], 'CLEANUP still ran');
});

test('21 a cancel one step EARLIER still stops the run and proves nothing', async () => {
  // The other side of the same line: VERIFY_ON is an experiment, and stopping one is
  // the person’s right. `proved` must not be a licence to ignore Stop checking.
  const world = makeWorld();
  await world.start();
  await untilApplied(world);
  assert.deepEqual(await world.stop(), { ok: true, tabId: TAB, cancelled: true });
  const view = await finish(world);
  assert.equal(view.failure, PROBE_FAIL.CANCELLED);
  assert.deepEqual(await getBindings(ORIGIN), [], 'and no Link appears in Sources');
});

/* ══════════════ the false Verified §7.1's own paranoid cycle exists for ═══════════ */

test('22 a rhythm two control runs cannot see is confirmed — and the third cycle refuses it', async () => {
  // Recorded rather than fixed, because the fix is already in §7.1 and is opt-in.
  //
  // An element driven by nothing but the load counter, whose period happens to line up
  // with the probe's own schedule: X X Y Y Y X. CONTROL_A and CONTROL_B both see X, so
  // §7.2's mask — which is two samples wide — cannot know it moves at all. Every later
  // step then reads exactly as proof: the batch changes it, the single field changes it,
  // VERIFY_ON changes it, VERIFY_OFF puts it back. Nothing in §7 is skipped and the
  // answer is still wrong. Two samples cannot detect a period of three; only more
  // samples can, and §7.1's "[optional 3rd cycle if settings.paranoid]" is the spec's
  // own answer. This asserts BOTH halves, so neither can rot: the default run really is
  // fooled, and the paranoid run really does refuse.
  const RHYTHM = ['X', 'X', 'Y', 'Y', 'Y', 'X'];
  const rhythm = (_bodies, load) => [{ key: KEY.pill, snapshot: node(RHYTHM[(load - 1) % RHYTHM.length]) }];

  const fooled = makeWorld({ render: rhythm });
  await fooled.start();
  const view = await finish(fooled);
  assert.equal(view.phase, PROBE_PHASE.DONE, `got ${view.failure} ${view.detail || ''}`);
  assert.equal(view.binding.state, 'verified', 'spec-conformant, and wrong — this is the known hole');
  assert.equal(view.reload.index, 6, 'X X Y Y Y X, one value per reload');
  assert.deepEqual(await probeChanges(), []);

  // The same page, the same rhythm, with §10.5's "Extra-careful checking" on. The second
  // VERIFY_ON lands on load 7, which is X again — equal to the control, so the element
  // did NOT change, and a run that cannot repeat its own result proves nothing.
  const { updateSettings } = await import('../src/background/ruleStore.js');
  const careful = makeWorld({ render: rhythm });
  await updateSettings({ paranoid: true });
  await careful.start();
  const refused = await finish(careful);
  await updateSettings({ paranoid: false });
  assert.equal(refused.phase, PROBE_PHASE.FAILED);
  assert.equal(refused.failure, PROBE_FAIL.NONE_CONFIRMED);
  assert.deepEqual(await getBindings(ORIGIN), [], '§17.12: nothing was proved, so nothing is stored');
  assert.deepEqual(await probeChanges(), []);
});
