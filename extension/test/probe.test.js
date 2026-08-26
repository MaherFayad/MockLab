/**
 * The probe state machine (PLAN.md §7), driven end to end against a fake page and a
 * fake store — no browser, no Playwright, every reload deterministic.
 *
 * OWNER: probe-engineer.
 *
 * The browser suite (`probe.browser.test.js`) proves the same protocol against the real
 * demo site in real Chromium; this file makes each of its outcomes cheap to reproduce,
 * and it reaches states the demo cannot produce at all — a source that never comes back,
 * an element that never re-resolves, a pair of fields that only drive an element
 * together.
 *
 * The fake page below is the demo's own logic: an enum that becomes a label AND a
 * colour, a banner that exists for two of the values, a tip box that changes on every
 * load, a wrapper whose text contains its children's, and a second source nothing on the
 * card reads. Both halves are asserted — what must be verified, and what must NOT be.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { setByPath } from '../src/shared/jsonpath.js';

/* --------------------------------------------------------------------- the fake */

/** chrome.storage.local, deep-cloning both ways like the real one does. */
function fakeChrome() {
  const data = new Map();
  return {
    __data: data,
    storage: {
      local: {
        async get(key) {
          if (key === null || key === undefined) {
            return Object.fromEntries([...data].map(([k, v]) => [k, structuredClone(v)]));
          }
          const out = {};
          for (const k of Array.isArray(key) ? key : [key]) {
            if (data.has(k)) out[k] = structuredClone(data.get(k));
          }
          return out;
        },
        async set(bag) {
          for (const [k, v] of Object.entries(bag)) data.set(k, structuredClone(v));
        },
        async remove(key) {
          for (const k of Array.isArray(key) ? key : [key]) data.delete(k);
        }
      }
    }
  };
}

globalThis.chrome = fakeChrome();

const { createProbeApi } = await import('../src/background/probe.js');
const { PROBE_MSG, PROBE_PHASE, PROBE_STATE, PROBE_FAIL } = await import('../src/background/probeMessages.js');
const { sweepProbeChanges } = await import('../src/background/probeChanges.js');
const { getChanges, getEnabledChanges, getBindings, addChange, updateSettings } = await import(
  '../src/background/ruleStore.js'
);

const TAB = 7;
const ORIGIN = 'https://demo.test';

/** The demo's own rendering, as a keyed §7.3 sample (see `content/agent.js`). */
const LABEL = { ON_TIME: 'On time', DELAYED: 'Delayed', CANCELLED: 'Cancelled' };
const COLOUR = { ON_TIME: 'rgb(30, 142, 62)', DELAYED: 'rgb(178, 106, 0)', CANCELLED: 'rgb(217, 48, 37)' };
const BANNER = { DELAYED: 'Your flight is delayed.', CANCELLED: 'Your flight was cancelled' };

const node = (text, colour) => ({
  tag: 'div',
  text: String(text),
  attrs: {},
  cls: [],
  style: { color: colour || 'rgb(30, 30, 36)', display: 'block', visibility: 'visible', opacity: '1' },
  childCount: 0,
  childTexts: []
});

function demoPage(bodies, load) {
  const trip = bodies.trip || {};
  const status = String(trip.status);
  const nodes = [{ key: 'div@1.0.1', snapshot: node(LABEL[status] || status, COLOUR[status]) }];
  if (BANNER[status]) nodes.push({ key: 'div@1.2', snapshot: node(BANNER[status]) });
  // Deliberate noise: a different tip on every load, exactly like the demo's tip box.
  nodes.push({ key: 'div@1.3', snapshot: node(`Gate ${trip.flight.gate} · tip ${load}`) });
  nodes.push({ key: 'div@1.4', snapshot: node(`SAR ${Number(trip.price.total).toFixed(2)}`) });
  nodes.push({ key: 'div@1.5', snapshot: node(String(bodies.user.user.displayName)) });
  return nodes;
}

/** Keys the tests name, so an assertion reads as something other than an index path. */
const KEY = { pill: 'div@1.0.1', banner: 'div@1.2', tip: 'div@1.3', dot: 'span@1.0.0', card: 'div@1.0' };

const DEMO_BODIES = {
  trip: {
    booking: { reference: 'MKL8842', status: 'ON_TIME' },
    flight: { number: 'SV 1042', gate: 'A17', origin: { code: 'RUH' }, destination: { code: 'JED' } },
    status: 'ON_TIME',
    price: { currency: 'SAR', total: 450, taxRate: 0.15 }
  },
  user: { user: { displayName: 'Nora Al-Amri', tier: 'GOLD', status: 'ACTIVE' } }
};

/** §6.3's ranked guesses for the demo pill, as `candidates.js` really produces them. */
const PILL_CANDIDATES = [
  { sigId: 'trip', path: '$.status', value: 'ON_TIME', sourceName: 'Trip' },
  { sigId: 'trip', path: '$.booking.status', value: 'ON_TIME', sourceName: 'Trip' },
  { sigId: 'trip', path: '$.flight.origin.code', value: 'RUH', sourceName: 'Trip' },
  { sigId: 'trip', path: '$.flight.destination.code', value: 'JED', sourceName: 'Trip' }
];

/**
 * One tab, one page, one probe. `render` receives the bodies the page would have been
 * served — the real ones with every enabled Change applied, which is what the in-page
 * patch does — so the fake page is driven by the same mechanism a site is.
 */
function makeWorld(options = {}) {
  chrome.__data.clear();
  const bodies = structuredClone(options.bodies || DEMO_BODIES);
  const missing = new Set(options.missingSources || []);
  const sources = new Map(
    Object.keys(bodies)
      .filter((sigId) => !missing.has(sigId))
      .map((sigId) => [sigId, { sigId, body: structuredClone(bodies[sigId]), signature: { method: 'GET', urlPattern: `${ORIGIN}/api/${sigId}` } }])
  );

  const world = {
    loads: 0, states: [], batches: [],
    render: options.render || demoPage,
    pickedKey: options.pickedKey || KEY.pill,
    confidence: options.confidence === undefined ? 1 : options.confidence
  };

  async function served() {
    const out = structuredClone(bodies);
    for (const change of await getEnabledChanges(ORIGIN)) {
      if (out[change.sigId]) setByPath(out[change.sigId], change.path, change.value);
    }
    return out;
  }

  const port = {
    postMessage(message) {
      setTimeout(async () => {
        const payload = message.payload || {};
        if (message.type === 'port:probeFingerprints') {
          api.onProbeResult(TAB, {
            requestId: payload.requestId,
            ok: true,
            fingerprints: (payload.keys || []).map((key) => ({
              key,
              fingerprint: { key, css: `#${key}`, textAnchor: key, attrAnchors: [], treePath: [] }
            }))
          });
          return;
        }
        const nodes = world.render(await served(), world.loads);
        const picked = nodes.find((entry) => entry.key === world.pickedKey);
        // §7.2's region: the picked element's ancestors and siblings. Two of them matter
        // and neither is in §7.6's page sample. `card` is the wrapper whose text is its
        // children's concatenated (the demo's `.card__body`) — it must never be counted
        // as a place the field affects. `dot` is a status dot with no text at all, whose
        // colour follows the same field — it must be, and only the region carries it.
        const status = String((await served()).trip.status);
        const region = nodes.concat(
          { key: KEY.card, snapshot: node(nodes.filter((e) => e.key !== KEY.tip).map((e) => e.snapshot.text).join(' ')) },
          { key: KEY.dot, snapshot: node('', COLOUR[status]) }
        );
        api.onProbeResult(TAB, {
          requestId: payload.requestId,
          ok: true,
          settled: true,
          confidence: world.confidence,
          elementKey: picked ? picked.key : null,
          element: picked ? picked.snapshot : null,
          region,
          page: payload.page === false ? [] : nodes
        });
      }, 0);
    }
  };

  const api = createProbeApi({
    resolveTabId: async () => TAB,
    portsFor: () => new Set([port]),
    tabRecord: () => { if (world.breakQueue) throw new Error('a bug of ours'); return { origin: ORIGIN, sources }; },
    pickedElement: () => ({
      fingerprint: { css: `#${world.pickedKey}`, textAnchor: world.pickedKey, attrAnchors: [], treePath: [] },
      snapshot: node('picked'),
      candidates: options.candidates === undefined ? PILL_CANDIDATES : options.candidates
    }),
    async reload() {
      world.loads += 1;
      world.batches.push((await getEnabledChanges(ORIGIN)).filter((c) => c.probe).map((c) => `${c.path}=${c.value}`));
      api.onNewDocument(TAB);
      return true;
    },
    notify: (_tabId, state) => world.states.push(state)
  });

  world.api = api;
  world.start = (payload = {}) => api.handle({ type: PROBE_MSG.START_PROBE, payload });
  world.view = () => api.handle({ type: PROBE_MSG.GET_PROBE, payload: {} });
  world.stop = () => api.handle({ type: PROBE_MSG.CANCEL_PROBE, payload: {} });
  return world;
}

/** Run to completion, or fail loudly rather than hanging the suite. */
async function finish(world, budgetMs = 5000) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const view = await world.view();
    if (view.phase !== PROBE_PHASE.RUNNING) return view;
    if (Date.now() > deadline) {
      assert.fail(`the probe never finished — state ${view.state}, ${view.reload.index} reloads`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const probeChanges = async () => (await getChanges(ORIGIN)).filter((change) => change.probe === true);

/** Wait until the run has really mocked the site; a cancel before that proves nothing. */
async function untilApplied(world, budgetMs = 3000) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const applied = await probeChanges();
    if (applied.length) return applied;
    assert.ok(Date.now() < deadline, `the probe never applied anything (state ${(await world.view()).state})`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** A probe api with one dependency replaced — for the answers that never start a run. */
const bespoke = (over) =>
  createProbeApi({
    resolveTabId: async () => TAB,
    portsFor: () => new Set([{ postMessage() {} }]),
    tabRecord: () => ({ origin: ORIGIN, sources: new Map() }),
    pickedElement: () => ({ fingerprint: { css: '#pill' }, snapshot: node('x'), candidates: PILL_CANDIDATES }),
    reload: async () => true,
    notify: () => {},
    ...over
  });

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

  // §16 M4: "elements[] contains BOTH the pill and the derived banner" — and neither
  // the wrapper whose text merely CONTAINS the pill's (§7.6 samples elements with a
  // direct text node) nor the tip box, which the noise mask took out.
  // …plus the text-less status dot beside it, which only §7.2's region can carry, and
  // NOT the wrapper whose text merely contains the pill's, nor the masked tip box.
  assert.deepEqual(view.binding.elements.map((fp) => fp.key), [KEY.pill, KEY.dot, KEY.banner]);
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
  assert.deepEqual(await getBindings(ORIGIN), [], 'and nothing was written to the store');
  assert.equal(view.reload.index, 2, 'the control runs alone are enough to refuse it');
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

/* ══════════════════════════════ §16 M4 DoD 3 — cancel ══════════════ */
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
