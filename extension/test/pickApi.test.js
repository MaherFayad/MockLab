/**
 * Pick mode's service-worker glue (PLAN.md §6.1, §6.3, §10.1C) — `pickApi.js`.
 *
 * OWNER: probe-engineer.
 *
 * `candidates.test.js` proves the §6.3 scorer against bodies handed to it directly. It
 * cannot prove the thing this file is for: WHICH bodies get handed over. That decision
 * is the whole of the defect QA reproduced — the search was fed the captured responses
 * while the person was looking at a page rendered from something else — and it survived
 * every existing suite, because nothing anywhere called `onPicked`.
 *
 * So the rule these tests hold is narrow and worth stating: an assertion about the
 * scorer is not an assertion about what the scorer is asked. Cutting `source.changes`
 * out of `capturedSources` used to leave the entire build green.
 *
 * Nothing here may produce a link state (§17.4): a pick emits guesses and nothing else.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeChrome } from '../testlib/fakeChrome.js';

globalThis.chrome = fakeChrome();

const { createPickApi } = await import('../src/background/pickApi.js');
const { MSG, PHASE } = await import('../src/background/messages.js');
const { addChange, updateChange } = await import('../src/background/ruleStore.js');

const TAB = 4;
const ORIGIN = 'https://demo.test';

/** The demo's trip response, as the worker holds it: what the SERVER sent (§5.1.2). */
const TRIP = {
  booking: { reference: 'MKL8842', status: 'ON_TIME' },
  flight: { number: 'SV 1042', gate: 'A17' },
  status: 'ON_TIME',
  price: { currency: 'SAR', total: 450 }
};

const snapshot = (text) => ({ tag: 'div', text, attrs: { id: 'status-pill' }, cls: [], style: {} });

function makeApi(options = {}) {
  chrome.__data.clear();
  const sources = new Map([
    ['trip', {
      sigId: 'trip',
      ts: 2000,
      body: structuredClone(options.body || TRIP),
      signature: { method: 'GET', urlPattern: `${ORIGIN}/api/trip` }
    }]
  ]);
  const phases = [];
  const api = createPickApi({
    resolveTabId: async () => TAB,
    portsFor: () => new Set([{ postMessage() {} }]),
    tabRecord: () => ({ origin: ORIGIN, sources }),
    notify: (_tabId, phase) => phases.push(phase)
  });
  return { api, phases, sources, view: () => api.handle({ type: MSG.GET_PICK, payload: {} }) };
}

/** `onPicked` does one store read now, so the answer lands a tick later. */
async function picked(world, text) {
  world.api.onPicked(TAB, { ok: true, snapshot: snapshot(text), fingerprint: { css: '#status-pill' } });
  const deadline = Date.now() + 2000;
  for (;;) {
    const view = await world.view();
    if (view.phase === PHASE.PICKED || view.reason) return view;
    assert.ok(Date.now() < deadline, 'the pick never resolved');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/* ══════════════ what the page rendered from, not what the server sent ═════════════ */

test('1 QA\'s journey — a changed value is found from the text the page shows', async () => {
  // set_value $.status = "DELAYED" -> the pill renders "Delayed" -> pick #status-pill.
  // Against the captured body alone this answered `candidates: []`, and §11's
  // `pick.noCandidates` told the person their data was absent. Cut `changes` out of
  // `capturedSources` and this test fails with an empty list.
  const world = makeApi();
  await addChange({ origin: ORIGIN, sigId: 'trip', path: '$.status', value: 'DELAYED' });

  const view = await picked(world, 'Delayed');
  assert.equal(view.phase, PHASE.PICKED);
  const hit = view.candidates.find((c) => c.path === '$.status');
  assert.ok(hit, `\$.status must be offered — got ${JSON.stringify(view.candidates.map((c) => c.path))}`);
  assert.equal(hit.value, 'DELAYED', 'the value the page received');
  assert.equal(hit.realValue, 'ON_TIME', 'and the one the site served, beside it');
  assert.equal(view.searched.complete, true, 'so the empty-list sentence is not needed at all');
});

test('2 an un-changed site is searched exactly as before', async () => {
  const world = makeApi();
  const view = await picked(world, 'On time');
  const hit = view.candidates.find((c) => c.path === '$.status');
  assert.ok(hit);
  assert.equal(hit.mocked, undefined, 'no Change, no claim that one is in force');
  assert.equal(hit.realValue, undefined);
});

test('3 a DISABLED Change is not in force, so it is not searched', async () => {
  // §1.1 both ways: the page is not rendering from it, so offering the field for text
  // only that Change contains would be a candidate MockLab invented.
  const world = makeApi();
  const change = await addChange({ origin: ORIGIN, sigId: 'trip', path: '$.status', value: 'DELAYED' });
  await updateChange(ORIGIN, change.id, { enabled: false });

  const view = await picked(world, 'Delayed');
  assert.deepEqual(view.candidates, []);
  assert.equal(view.searched.complete, true, 'and that emptiness IS a fact about the data');
});

test('4 probe scaffolding is never treated as something the person asked for', async () => {
  // A `probe:true` Change is §17.5's internal scaffolding. It comes and goes between
  // reloads, and a pick that happened to land while one was applied must not describe
  // the site by it. (A pick cannot run mid-probe today; this holds if that ever changes.)
  const world = makeApi();
  await addChange({ origin: ORIGIN, sigId: 'trip', path: '$.status', value: 'DELAYED', probe: true });
  const view = await picked(world, 'Delayed');
  assert.deepEqual(view.candidates, []);
});

/* ═══════════════════════════ the pick still answers, always ═══════════════════════ */

test('5 the probe reads the same candidates the panel was shown', async () => {
  const world = makeApi();
  await addChange({ origin: ORIGIN, sigId: 'trip', path: '$.status', value: 'DELAYED' });
  const view = await picked(world, 'Delayed');
  const forProbe = world.api.pickedElement(TAB);
  assert.deepEqual(forProbe.candidates, view.candidates,
    '§7 probes exactly what §10.1C offered — one list, or the panel is describing another run');
  assert.equal(forProbe.fingerprint.css, '#status-pill');
});

test('6 a pick that throws ENDS, rather than leaving the panel waiting for ever', async () => {
  // The search does a store read now, so it can fail in ways it could not before. §1.1's
  // rule for that is the same as everywhere else: say something. A panel left on §11's
  // `pick.picking` — "Click something on the page…" — over a pick that already died is
  // the one outcome that is worse than an error.
  //
  // The read itself cannot throw today: `ruleStore.read` swallows a storage failure and
  // answers with an empty list, which is why this drives the failure in through
  // `tabRecord` instead. That boundary is recorded at the call site in `pickApi.js`.
  chrome.__data.clear();
  const sources = new Map();
  let breaking = false;
  const api = createPickApi({
    resolveTabId: async () => TAB,
    portsFor: () => new Set([{ postMessage() {} }]),
    tabRecord: () => {
      if (breaking) throw new Error('a bug of ours');
      return { origin: ORIGIN, sources };
    },
    notify: () => {}
  });

  assert.deepEqual(await api.handle({ type: MSG.START_PICK, payload: {} }), { ok: true, tabId: TAB });
  assert.equal((await api.handle({ type: MSG.GET_PICK, payload: {} })).phase, PHASE.PICKING);

  breaking = true;
  api.onPicked(TAB, { ok: true, snapshot: snapshot('Delayed'), fingerprint: { css: '#status-pill' } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  breaking = false;

  const view = await api.handle({ type: MSG.GET_PICK, payload: {} });
  assert.equal(view.phase, PHASE.IDLE, 'the panel is not still waiting for a click');
  assert.equal(view.reason, 'error');
  assert.equal(api.pickedElement(TAB), null, 'and the probe has nothing to start on');
});

test('7 a cancelled pick clears the record and says why', async () => {
  const world = makeApi();
  world.api.onPicked(TAB, { ok: false, reason: 'escape' });
  const deadline = Date.now() + 2000;
  for (;;) {
    const view = await world.view();
    if (view.reason) {
      assert.equal(view.phase, PHASE.IDLE);
      assert.equal(view.reason, 'escape');
      assert.equal(world.api.pickedElement(TAB), null, 'and the probe has nothing to start on');
      return;
    }
    assert.ok(Date.now() < deadline, 'the cancel never landed');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
});

test('8 a document that navigated away mid-search does not get the old page\'s answer', async () => {
  // The store read is async now, so a reload can land inside it. `onNewDocument` clears
  // the tab; a result written after that would be the previous page's candidates shown
  // against the new one.
  const world = makeApi();
  await addChange({ origin: ORIGIN, sigId: 'trip', path: '$.status', value: 'DELAYED' });
  world.api.onPicked(TAB, { ok: true, snapshot: snapshot('Delayed'), fingerprint: { css: '#status-pill' } });
  world.api.onNewDocument(TAB);

  await new Promise((resolve) => setTimeout(resolve, 20));
  const view = await world.view();
  assert.equal(view.phase, PHASE.IDLE);
  assert.deepEqual(view.candidates, []);
  assert.equal(world.api.pickedElement(TAB), null);
});
