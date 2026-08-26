/**
 * §10.3's highlight, on the worker's side — PLAN.md §10.3, §10.2, §12.4 #9.
 *
 * OWNER: interceptor-engineer.
 *
 * WHAT THIS FILE CAN AND CANNOT SEE. The drawing itself runs in the page and is DOM
 * behaviour end to end — a rect, a shadow root a site's CSS cannot reach, a listener
 * that has to come off. None of that is visible here, and a fake DOM would only prove
 * the fake works; `highlight.browser.test.js` runs it against a real page in real
 * Chromium and is listed in CI beside the other browser suites.
 *
 * What IS here is everything that decides WHAT to draw and WHAT TO CLAIM about it: which
 * of §10.3's two overlays, what the guess looks for, and — the half §17.12 is about —
 * that `verified` is never true for a highlight that drew a guess.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { fieldLabel, needleFor, MIN_CONFIDENCE, drawHighlightsInPage } from '../src/background/highlight.js';
import { CONTENT_GLOBALS, MSG } from '../src/background/messages.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'https://demo.test';
const SIG = 'abc123def456';

/** One fingerprint, in the §4 shape the probe stores. */
const fp = (css, text) => ({ css, textAnchor: text, attrAnchors: [], treePath: [1, 0] });

function fakeChrome({ result = { ok: true, drawn: 1, resolved: 1, offscreen: 0, lowConfidence: 0 }, throws = false } = {}) {
  const data = new Map();
  const calls = [];
  return {
    __data: data,
    __calls: calls,
    scripting: {
      async executeScript(options) {
        calls.push(options);
        if (throws) throw new Error('Cannot access contents of the page');
        return [{ result }];
      }
    },
    storage: {
      local: {
        async get(key) {
          const out = {};
          for (const k of Array.isArray(key) ? key : [key]) if (data.has(k)) out[k] = structuredClone(data.get(k));
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

async function setup(options = {}) {
  globalThis.chrome = fakeChrome(options);
  const store = await import('../src/background/ruleStore.js');
  const { createHighlightApi } = await import('../src/background/highlight.js');
  const record = options.record === undefined ? { sigId: SIG, body: { status: 'ON_TIME', price: { total: 450 } } } : options.record;
  const { handle } = createHighlightApi({
    target: async (payload) => ({ tabId: payload.tabId === null ? null : 7, origin: ORIGIN, info: {} }),
    capturedRecord: (_tabId, sigId) => (record && record.sigId === sigId ? record : null)
  });
  const ask = (payload) => handle({ type: MSG.HIGHLIGHT, payload });
  return { store, ask, chrome: globalThis.chrome };
}

/** The spec the last injection was handed. */
const lastSpec = (chrome) => chrome.__calls[chrome.__calls.length - 1].args[2];

/* ─────────────────────────────────────────────────────── the two pure functions */

test('1 the chip shows the field\'s own name, and invents nothing when it has none', () => {
  assert.equal(fieldLabel('$.status'), 'status');
  assert.equal(fieldLabel('$.data.flights[0].status'), 'status');
  assert.equal(fieldLabel('$.data.flights[0]'), 'flights', 'the last NAME, not the index');
  assert.equal(fieldLabel('$["odd key"]'), 'odd key');
  assert.equal(fieldLabel('$'), '');
  assert.equal(fieldLabel('$[0]'), '');
  assert.equal(fieldLabel('$..status'), '', 'outside §5.4 — nothing to show');
  assert.equal(fieldLabel(''), '');
});

test('2 a guess looks for rendered text, and gives up on what cannot be rendered', () => {
  assert.equal(needleFor('CANCELLED'), 'CANCELLED');
  assert.equal(needleFor(450), '450');
  assert.equal(needleFor(false), 'false');
  assert.equal(needleFor('  spaced  '), 'spaced');
  assert.equal(needleFor(null), '', 'null renders as nothing at all');
  assert.equal(needleFor(undefined), '');
  assert.equal(needleFor({ a: 1 }), '', 'an object has no text on the page');
  assert.equal(needleFor([1, 2]), '');
  assert.equal(needleFor('x'), '', 'one character matches half the document');
  assert.equal(needleFor(7), '', 'and so does one digit');
});

/* ────────────────────────────────────────────────────────── which overlay, and why */

test('3 a proved Link draws its own elements and says so (§10.3)', async () => {
  const { store, ask, chrome } = await setup({ result: { ok: true, drawn: 2, resolved: 2, offscreen: 0, lowConfidence: 0 } });
  await store.setBindings(ORIGIN, [
    {
      id: 'b1', origin: ORIGIN, sigId: SIG, path: '$.status',
      elements: [fp('#pill', 'On time'), fp('#banner', 'Cancelled')],
      state: 'verified', lastVerifiedAt: 1, observedValues: ['ON_TIME'], probeMode: 'refresh'
    }
  ]);
  const res = await ask({ tabId: 7, sigId: SIG, path: '$.status' });
  assert.deepEqual(res, { ok: true, verified: true, elements: 2, resolved: 2, offscreen: 0, lowConfidence: 0 });
  const spec = lastSpec(chrome);
  assert.equal(spec.mode, 'proved');
  assert.equal(spec.elements.length, 2);
  assert.equal(spec.label, 'status');
});

test('4 an unproved link draws a GUESS, and never claims otherwise (§17.12)', async () => {
  const { store, ask, chrome } = await setup();
  await store.noteChangedPath(ORIGIN, SIG, '$.status', 'ON_TIME');
  const res = await ask({ tabId: 7, sigId: SIG, path: '$.status' });
  assert.equal(res.ok, true);
  assert.equal(res.verified, false);
  assert.equal(lastSpec(chrome).mode, 'guess');
  assert.equal(lastSpec(chrome).needle, 'ON_TIME');
});

test('5 a proved Link with no elements left to point at is drawn as a guess, not as proof', async () => {
  const { store, ask, chrome } = await setup();
  await store.setBindings(ORIGIN, [
    { id: 'b1', origin: ORIGIN, sigId: SIG, path: '$.status', elements: [], state: 'verified', lastVerifiedAt: 1, observedValues: [], probeMode: 'refresh' }
  ]);
  const res = await ask({ tabId: 7, sigId: SIG, path: '$.status' });
  assert.equal(res.verified, false, 'what is on the screen is a guess whatever the store says');
  assert.equal(lastSpec(chrome).mode, 'guess');
});

test('5b a CANDIDATE link with elements on it still draws a guess (§17.12)', async () => {
  // The §17.4 mutation this is here for: dropping `state === 'verified'` from the test
  // that chooses the overlay. A candidate Binding CAN hold elements — `noteChangedPath`
  // creates it empty, but a Link the probe proved and something later downgraded, or one
  // restored from an older store, is the same shape with the same fingerprints. Only the
  // browser suite caught this before, and a browser suite skips on a machine with no
  // Playwright (README Deviation 40), so the rule is pinned here too.
  const { store, ask, chrome } = await setup();
  await store.setBindings(ORIGIN, [
    {
      id: 'b1', origin: ORIGIN, sigId: SIG, path: '$.status',
      elements: [fp('#pill', 'On time')],
      state: 'candidate', lastVerifiedAt: 0, observedValues: ['ON_TIME'], probeMode: 'refresh'
    }
  ]);
  const res = await ask({ tabId: 7, sigId: SIG, path: '$.status' });
  assert.equal(res.verified, false, 'a stored candidate may not produce the solid overlay');
  assert.equal(lastSpec(chrome).mode, 'guess');
  assert.equal(lastSpec(chrome).elements.length, 0, 'and it does not point at the fingerprints either');
});

test('6 the guess looks for what the page IS showing, not for what the server sent', async () => {
  const { store, ask, chrome } = await setup();
  // A Change is in force on that field, so the page renders the mocked value; searching
  // for the captured one looks for text the site stopped showing (README Deviation 32).
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.status', value: 'CANCELLED' });
  await ask({ tabId: 7, sigId: SIG, path: '$.status' });
  assert.equal(lastSpec(chrome).needle, 'CANCELLED');

  // A DISABLED Change is not in force, so the captured value is what is on screen.
  const [change] = await store.getChanges(ORIGIN);
  await store.updateChange(ORIGIN, change.id, { enabled: false });
  await ask({ tabId: 7, sigId: SIG, path: '$.status' });
  assert.equal(lastSpec(chrome).needle, 'ON_TIME');
});

test('7 nothing to look for is answered honestly, without touching the page at all', async () => {
  // No binding, and this tab has never captured that source.
  const { ask, chrome } = await setup({ record: null });
  const res = await ask({ tabId: 7, sigId: SIG, path: '$.status' });
  assert.deepEqual(res, { ok: true, elements: 0, verified: false, resolved: 0, offscreen: 0, lowConfidence: 0 });
  assert.equal(chrome.__calls.length, 0, 'a highlight is a side effect — no reason to run one for nothing');
});

test('8 a field whose value cannot be rendered draws nothing rather than everything', async () => {
  const { ask, chrome } = await setup({ record: { sigId: SIG, body: { price: { total: 450 }, seats: null } } });
  assert.equal((await ask({ tabId: 7, sigId: SIG, path: '$.price' })).elements, 0, 'an object');
  assert.equal((await ask({ tabId: 7, sigId: SIG, path: '$.seats' })).elements, 0, 'a null');
  assert.equal((await ask({ tabId: 7, sigId: SIG, path: '$.nope' })).elements, 0, 'a path that is not there');
  assert.equal(chrome.__calls.length, 0);
});

/* ──────────────────────────────────────────────────────────── what is reported back */

test('9 `elements` is what was DRAWN, never what was asked for', async () => {
  const { store, ask } = await setup({ result: { ok: true, drawn: 0, resolved: 1, offscreen: 0, lowConfidence: 1 } });
  await store.setBindings(ORIGIN, [
    {
      id: 'b1', origin: ORIGIN, sigId: SIG, path: '$.status',
      elements: [fp('#pill', 'On time'), fp('#banner', 'Cancelled'), fp('#gate', 'B4')],
      state: 'verified', lastVerifiedAt: 1, observedValues: [], probeMode: 'refresh'
    }
  ]);
  const res = await ask({ tabId: 7, sigId: SIG, path: '$.status' });
  assert.equal(res.elements, 0, 'three fingerprints, one resolved, none drawn well enough to show');
  assert.equal(res.lowConfidence, 1);
  assert.equal(res.verified, true, 'the Link IS proved — it is its elements that are gone');
  // This zero is what turns the panel's chip to Stale for this page load (Deviation 65).
});

test('10 a page MockLab cannot reach is a failure, never a count of elements', async () => {
  const { store, ask } = await setup({ throws: true });
  await store.noteChangedPath(ORIGIN, SIG, '$.status', 'ON_TIME');
  const res = await ask({ tabId: 7, sigId: SIG, path: '$.status' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-content-script');
  assert.equal(res.elements, undefined, '"I could not look" and "there is nothing there" are different answers');
});

test('11 an injected draw that failed is not read as a draw of zero', async () => {
  const { store, ask } = await setup({ result: { ok: false, reason: 'error' } });
  await store.noteChangedPath(ORIGIN, SIG, '$.status', 'ON_TIME');
  const res = await ask({ tabId: 7, sigId: SIG, path: '$.status' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'error');
});

test('12 a malformed ask is refused before anything is drawn', async () => {
  const { ask, chrome } = await setup();
  assert.equal((await ask({ tabId: 7, sigId: SIG })).reason, 'bad-request');
  assert.equal((await ask({ tabId: 7, path: '$.status' })).reason, 'bad-request');
  assert.equal((await ask({ tabId: null, sigId: SIG, path: '$.status' })).reason, 'no-tab');
  assert.equal(chrome.__calls.length, 0);
});

test('13 §10.3\'s own numbers reach the page, and §6.2\'s confidence floor with them', async () => {
  const { store, ask, chrome } = await setup();
  await store.noteChangedPath(ORIGIN, SIG, '$.status', 'ON_TIME');
  await ask({ tabId: 7, sigId: SIG, path: '$.status' });
  const spec = lastSpec(chrome);
  assert.equal(spec.dismissMs, 4000, '§10.3: "auto-dismiss after 4 s"');
  assert.equal(spec.staggerMs, 60, '§10.3: "stagger pop-ins 60ms apart"');
  assert.equal(spec.minConfidence, MIN_CONFIDENCE);
  assert.equal(MIN_CONFIDENCE, 0.8, '§6.2: below this the element was found by position alone');
  assert.equal(spec.max, 12, '§6.3\'s ceiling: a guess that matches half the page is not a highlight');
  assert.match(spec.css, /\.box\.proved\{border:2px solid/, '§10.3: solid for proved');
  assert.match(spec.css, /\.box\.guess\{border:2px dashed/, '§10.3: dashed for a guess');

  const call = chrome.__calls[chrome.__calls.length - 1];
  assert.deepEqual(call.target, { tabId: 7 });
  assert.equal(call.args[0], CONTENT_GLOBALS.element);
  assert.equal(call.args[1], CONTENT_GLOBALS.highlightId);
  assert.equal(typeof call.func, 'function');
});

/* ───────────────────────────────────────────────────────────────── the audits */

test('14 §17.2 every element-contract method the injected drawer calls is one element.js publishes', () => {
  // The same audit `wsOps.test.js` runs over `findTargetInPage`, and for the same reason:
  // `guards.contract.test.js` cannot see these calls, because the receiver arrives as an
  // argument and this file never names the global. A misspelled method returns undefined
  // inside a try/catch and the highlight silently draws nothing.
  const source = fs.readFileSync(path.join(HERE, '../src/background/highlight.js'), 'utf8');
  const body = source.slice(source.indexOf('export function drawHighlightsInPage'));
  const called = [...new Set([...body.matchAll(/api\.([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))];
  assert.ok(called.length >= 3, `expected several contract calls, found ${JSON.stringify(called)}`);

  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(HERE, '../src/content/element.js'), 'utf8'), context, { filename: 'element.js' });
  const published = Object.keys(context[CONTENT_GLOBALS.element]);
  assert.ok(published.length >= 5, 'and the audit is looking at a real contract');
  for (const method of called) {
    assert.ok(published.includes(method), `drawHighlightsInPage calls ${method}(), which element.js does not publish`);
  }
});

test('15 the injected drawer cannot break the page it is injected into (§17.2)', () => {
  // No contract, no document, a spec full of nonsense: every one of these is a page
  // MockLab arrived in too early or a tab it may not touch, and none of them may throw.
  assert.deepEqual(drawHighlightsInPage('__nothing_here', 'x', { mode: 'guess' }), { ok: false, reason: 'no-content-script' });
  // Set through the constant, never by spelling the name: a hand-written copy of it in
  // this file would be a fifth "mirror" of the element contract, and
  // `guards.contract.test.js` audits that list exactly (it fails on a new file appearing
  // in it — which is how this line was found).
  const previous = globalThis[CONTENT_GLOBALS.element];
  globalThis[CONTENT_GLOBALS.element] = { normText: String, textOf: String, resolveFingerprint: () => null };
  try {
    // No `document` at all in this runtime — the reference throws and is caught.
    const answer = drawHighlightsInPage(CONTENT_GLOBALS.element, CONTENT_GLOBALS.highlightId, { mode: 'proved', elements: [] });
    assert.equal(answer.ok, false);
    assert.ok(['error', 'no-content-script'].includes(answer.reason));
  } finally {
    if (previous === undefined) delete globalThis[CONTENT_GLOBALS.element];
    else globalThis[CONTENT_GLOBALS.element] = previous;
  }
});

test('16 the highlight type is routed with the rest of the worker\'s message surface', async () => {
  const { CHANGE_MESSAGE_TYPES } = await import('../src/background/changesApi.js');
  const { HIGHLIGHT_MESSAGE_TYPES } = await import('../src/background/highlight.js');
  assert.equal(HIGHLIGHT_MESSAGE_TYPES.size, 1);
  assert.ok(CHANGE_MESSAGE_TYPES.has(MSG.HIGHLIGHT), 'the panel and the MCP bridge both reach it through this set');
});
