/**
 * The fifteen ops of PLAN.md §12.4, on the extension's side (`wsOps.js`).
 *
 * OWNER: mcp-engineer. Split from `wsClient.test.js` under §17.10, at the same seam the
 * source has: this file drives WHAT MockLab does when an agent asks, with a fake
 * dispatch and a fake `chrome`; that one drives the socket that carries it.
 *
 * The rule every test below is written against: an answer describes what happened. A
 * link state is passed through as stored (§17.4/§17.12), a half that is not built says
 * so rather than answering emptily (§1.1), and a claim MockLab did not check is not made.
 *
 * What CANNOT be proved here — that the real worker answers these messages, that
 * `chrome.scripting` reaches the page agent — is `mcp.browser.test.js`, in real Chromium.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createOps, findTargetInPage, PROBE_POLL_MS, BODY_LIMIT_BYTES, probeMessage } from '../src/background/wsOps.js';
import { MSG, PROBE_MSG, PROBE_PHASE, PROBE_FAIL, CONTENT_GLOBALS } from '../src/background/messages.js';
import { S } from '../src/panel/strings.js';
import { fakeChrome } from '../testlib/fakeChrome.js';

/** A chrome with the four namespaces these ops touch, on top of the shared storage fake. */
function chromeWith(overrides = {}) {
  const base = fakeChrome();
  const calls = [];
  const api = {
    ...base,
    __calls: calls,
    tabs: {
      query: async () => overrides.tabs || [],
      get: async (tabId) => (overrides.tabs || []).find((tab) => tab.id === tabId) || null,
      update: async (tabId, patch) => calls.push(['update', tabId, patch]),
      captureVisibleTab: async (windowId) => {
        calls.push(['capture', windowId]);
        return 'data:image/png;base64,QUJD';
      }
    },
    scripting: {
      executeScript: async (options) => {
        calls.push(['executeScript', options.target.tabId, options.args]);
        return [{ result: overrides.picked === undefined ? { ok: false, reason: 'element-not-found' } : overrides.picked }];
      }
    },
    alarms: { create: (...args) => calls.push(['alarm', ...args]), onAlarm: { addListener: () => {} } }
  };
  return api;
}

/** A dispatch that answers from a table, and records every message it was given. */
function dispatcher(table) {
  const sent = [];
  const dispatch = async (message) => {
    sent.push(message);
    const answer = table[message.type];
    if (answer === undefined) return undefined; // exactly what an unrouted type does
    return typeof answer === 'function' ? answer(message.payload, sent.length) : answer;
  };
  return { dispatch, sent };
}

function opsWith({ table = {}, tabs = [], picked, record = null, chrome: chromeOverride } = {}) {
  const { dispatch, sent } = dispatcher(table);
  const api = chromeOverride || chromeWith({ tabs, picked });
  globalThis.chrome = api;
  const picks = [];
  const ops = createOps({
    dispatch,
    portsFor: (tabId) => (tabs.some((tab) => tab.id === tabId && tab.hasAgent !== false) ? new Set([{}]) : null),
    tabRecord: () => record,
    onPicked: (tabId, payload) => picks.push([tabId, payload]),
    chrome: api
  });
  return { ops, sent, picks, api };
}

/* ───────────────────────────────────────────────── the shape of the surface ─────── */

test('§12.4 the extension implements all fifteen ops and nothing else', () => {
  const { ops } = opsWith({});
  assert.equal(Object.keys(ops).length, 15);
  for (const name of Object.keys(ops)) assert.equal(typeof ops[name], 'function');
});

/* ──────────────────────────────────────────────── §1.1 — a half that is not built ── */

test('§1.1 an op whose worker half does not exist says so, in the panel\'s own words', async () => {
  // The router answers `undefined` for a type nothing handles. Today that is every
  // preset type and HIGHLIGHT: their panel half shipped at M5, their worker half did not.
  const { ops } = opsWith({ table: {} });
  for (const name of ['highlight', 'list_presets', 'apply_preset', 'save_preset', 'delete_preset']) {
    const answer = await ops[name]({ tabId: 1, presetId: 'p', sigId: 's', path: '$.a', name: 'x' });
    assert.equal(answer.ok, false, `${name} must not report success it did not get`);
    assert.equal(answer.reason, 'not-wired');
    assert.equal(answer.message, S.notYet, `${name} says the one true thing (§17.6)`);
  }
});

test('§1.1 an empty list from a REAL handler is an empty list, not "not built"', async () => {
  const { ops } = opsWith({ table: { [MSG.LIST_PRESETS]: { ok: true, origin: 'https://d.test', presets: [] } } });
  const answer = await ops.list_presets({ tabId: 1 });
  assert.deepEqual(answer, { ok: true, origin: 'https://d.test', presets: [] });
});

/* ─────────────────────────────────────────────────────────── the reads ──────────── */

test('§12.4 #2 list_sources is the panel\'s own message, not a second implementation', async () => {
  const { ops, sent } = opsWith({ table: { [MSG.LIST_SOURCES]: { ok: true, sources: [{ sigId: 'a' }] } } });
  const answer = await ops.list_sources({ tabId: 4 });
  assert.deepEqual(sent, [{ type: MSG.LIST_SOURCES, payload: { tabId: 4 } }]);
  assert.equal(answer.sources.length, 1);
});

test('§12.4 #3 a body over 200 KB comes back as keys, and a small one comes back whole', async () => {
  const big = { flights: 'x'.repeat(BODY_LIMIT_BYTES + 10), status: 'ON_TIME' };
  const { ops } = opsWith({ table: { [MSG.GET_RESPONSE]: { ok: true, body: big } } });
  const answer = await ops.get_response({ tabId: 1, sigId: 's' });
  assert.equal(answer.truncated, true);
  assert.deepEqual(answer.topLevelKeys, ['flights', 'status']);
  assert.equal(answer.body, undefined, 'the point of truncating is not to send it');
  assert.ok(answer.bytes > BODY_LIMIT_BYTES);

  const small = opsWith({ table: { [MSG.GET_RESPONSE]: { ok: true, body: { status: 'ON_TIME' } } } });
  const whole = await small.ops.get_response({ tabId: 1, sigId: 's' });
  assert.deepEqual(whole.body, { status: 'ON_TIME' });
  assert.equal(whole.truncated, undefined);
});

test('§12.4 #4 search_value runs §6.3\'s engine over what the tab actually captured', async () => {
  const record = {
    origin: 'https://demo.test',
    sources: new Map([
      ['sig1', { sigId: 'sig1', signature: { method: 'GET', urlPattern: 'https://demo.test/api/trip' }, body: { status: 'ON_TIME', price: { total: 450 } }, ts: 2 }]
    ])
  };
  const { ops } = opsWith({ record });
  const answer = await ops.search_value({ tabId: 1, needle: '450' });
  assert.equal(answer.ok, true);
  const paths = answer.candidates.map((candidate) => candidate.path);
  assert.ok(paths.includes('$.price.total'), `expected $.price.total among ${JSON.stringify(paths)}`);
  for (const candidate of answer.candidates) {
    assert.ok(candidate.score > 0 && candidate.sigId === 'sig1');
    assert.equal('state' in candidate, false, 'a value match is a guess and carries no link state');
  }
});

/* ─────────────────────────────────────── §17.4 / §1.1 — what get_bindings may say ── */

test('§17.4 get_bindings returns the STORED state, untouched', async () => {
  const stored = [
    { id: 'b1', sigId: 'sig1', path: '$.status', state: 'verified', elements: [{ css: '#p' }] },
    { id: 'b2', sigId: 'sig2', path: '$.x', state: 'candidate', elements: [] }
  ];
  const { ops } = opsWith({
    table: {
      [MSG.GET_BINDINGS]: { ok: true, origin: 'https://demo.test', bindings: stored },
      [MSG.LIST_SOURCES]: { ok: true, sources: [{ sigId: 'sig1' }] }
    }
  });
  const answer = await ops.get_bindings({ tabId: 1 });
  assert.deepEqual(answer.bindings.map((binding) => binding.state), ['verified', 'candidate'],
    'neither upgraded nor downgraded — only probe.js may decide this (§17.4)');
  // The stale EVIDENCE the panel draws its chip from, reported beside the state.
  assert.equal(answer.bindings[0].sourceLoadedThisPageLoad, true);
  assert.equal(answer.bindings[1].sourceLoadedThisPageLoad, false);
});

test('§1.1 "I have not seen that data" is not "that data is gone"', async () => {
  const { ops } = opsWith({
    table: {
      [MSG.GET_BINDINGS]: { ok: true, bindings: [{ sigId: 'sig1', path: '$.a', state: 'verified' }] },
      [MSG.LIST_SOURCES]: { ok: true, sources: [] } // nothing captured on this page load
    }
  });
  const answer = await ops.get_bindings({ tabId: 1 });
  assert.equal(answer.bindings[0].sourceLoadedThisPageLoad, null,
    'null, never false: a tab that captured nothing is not evidence that a source is gone');
  assert.equal(answer.bindings[0].state, 'verified');
});

test('get_bindings by origin does not claim anything about a page load it cannot see', async () => {
  const { ops, sent } = opsWith({
    table: { [MSG.GET_BINDINGS]: { ok: true, bindings: [{ sigId: 'sig1', path: '$.a', state: 'candidate' }] } }
  });
  const answer = await ops.get_bindings({ origin: 'https://other.test' });
  assert.equal(answer.bindings[0].sourceLoadedThisPageLoad, null);
  assert.equal(sent.filter((message) => message.type === MSG.LIST_SOURCES).length, 0,
    'no tab was named, so no tab was asked');
});

/* ──────────────────────────────────────────────────────────── the mutations ─────── */

test('§12.4 #8 clear_changes with an id deletes one, without an id resets the site', async () => {
  const { ops, sent } = opsWith({
    table: { [MSG.DELETE_CHANGE]: { ok: true, deleted: 1 }, [MSG.RESET_SITE]: { ok: true, cleared: 3 } }
  });
  await ops.clear_changes({ tabId: 1, changeId: 'c1' });
  await ops.clear_changes({ tabId: 1 });
  assert.deepEqual(sent.map((message) => message.type), [MSG.DELETE_CHANGE, MSG.RESET_SITE]);
});

test('§12.4 #7 set_value is handed straight to the handler the panel uses', async () => {
  const { ops, sent } = opsWith({ table: { [MSG.SET_VALUE]: (payload) => ({ ok: true, change: { ...payload, linkState: 'candidate' }, refreshed: true }) } });
  const answer = await ops.set_value({ tabId: 1, sigId: 's', path: '$.status', value: 'CANCELLED' });
  assert.equal(sent[0].type, MSG.SET_VALUE);
  assert.equal(answer.change.linkState, 'candidate', 'a change proves nothing on its own (§17.4)');
  assert.equal(answer.refreshed, true);
});

/* ────────────────────────────────────────────────────────── chrome-only ops ─────── */

test('§12.4 #1 list_tabs lists only tabs MockLab has a page in, with each site\'s counts', async () => {
  const tabs = [
    { id: 1, url: 'https://demo.test/trip', title: 'Trip', active: true, windowId: 9 },
    { id: 2, url: 'chrome://extensions', title: 'x', active: false, windowId: 9, hasAgent: false }
  ];
  const { ops, api } = opsWith({ tabs });
  await api.storage.local.set({
    'changes:https://demo.test': [{ id: 'c', enabled: true }, { id: 'd', enabled: false }],
    settings: { advancedMode: false, deepModeOrigins: ['https://demo.test'], companionToken: null }
  });
  const answer = await ops.list_tabs({});
  assert.equal(answer.tabs.length, 1, 'a tab with no content script can never answer, so it is not offered');
  assert.deepEqual(answer.tabs[0], {
    tabId: 1, url: 'https://demo.test/trip', title: 'Trip', origin: 'https://demo.test',
    active: true, changesCount: 1, deepMode: true
  });
});

test('§12.4 #14 screenshot activates the tab first and returns base64, not a data URL', async () => {
  const { ops, api } = opsWith({ tabs: [{ id: 5, url: 'https://demo.test/', windowId: 9 }] });
  const answer = await ops.screenshot({ tabId: 5 });
  assert.deepEqual(answer, { ok: true, tabId: 5, mimeType: 'image/png', image: 'QUJD' });
  assert.deepEqual(api.__calls[0], ['update', 5, { active: true }], 'captureVisibleTab captures the ACTIVE tab');
  assert.deepEqual(api.__calls[1], ['capture', 9]);
});

test('§12.4 #15 reload reports the settle checks it made, and does not claim the one it cannot', async () => {
  const tabs = [{ id: 1, url: 'https://demo.test/', status: 'complete', windowId: 9 }];
  const record = { origin: 'https://demo.test', sources: new Map([['a', { ts: 0 }]]) };
  const { ops } = opsWith({ tabs, record, table: { [MSG.REFRESH_TAB]: { ok: true, refreshed: true } } });
  const answer = await ops.reload({ tabId: 1, waitForSettle: true });
  assert.equal(answer.reloaded, true);
  assert.equal(answer.settled, false, '§7.3 needs the page agent for the DOM-quiet half; it was not asked');
  assert.equal(answer.checks.loaded, true);
  assert.equal(answer.checks.networkQuiet, true);
  assert.equal(answer.checks.domQuiet, false, 'reported as unchecked rather than assumed');
});

/* ───────────────────────────────────────────────── §12.4 #5 — the probe ─────────── */

const RUNNING = { ok: true, phase: PROBE_PHASE.RUNNING, state: 'controlA', step: 'control', testing: 0, reload: { index: 1, estimate: 8 } };
const TESTING = { ok: true, phase: PROBE_PHASE.RUNNING, state: 'testing', step: 'testing', testing: 6, reload: { index: 3, estimate: 8 } };

test('§12.4 #5 probe_element picks the element in the page, then runs the panel\'s own probe', async () => {
  const picked = { ok: true, fingerprint: { css: '#status-pill' }, snapshot: { text: 'On time' } };
  const views = [RUNNING, TESTING, {
    ok: true, phase: PROBE_PHASE.DONE, state: 'done', step: '', reload: { index: 8, estimate: 8 },
    binding: { id: 'b1', sigId: 'sig1', path: '$.status', state: 'verified', elements: [{ css: '#status-pill' }, { css: '#alert-banner' }], observedValues: ['ON_TIME', 'CANCELLED'] },
    bindings: [{ id: 'b1', state: 'verified' }], affected: 2
  }];
  let read = 0;
  const { ops, picks, sent, api } = opsWith({
    picked,
    table: {
      [PROBE_MSG.START_PROBE]: { ok: true, tabId: 1 },
      [PROBE_MSG.GET_PROBE]: () => views[Math.min(read++, views.length - 1)]
    }
  });

  const updates = [];
  const answer = await ops.probe_element({ tabId: 1, text: 'On time' }, (update) => updates.push(update));

  assert.deepEqual(picks, [[1, picked]], 'the element goes into the SAME pick record a human click fills');
  assert.equal(sent[0].type, PROBE_MSG.START_PROBE, 'and the SAME probe runs');
  assert.equal(answer.ok, true);
  assert.equal(answer.binding.state, 'verified', 'as stored by probe.js — this file only carries it');
  assert.equal(answer.elements.length, 2, '§7.6: one probe finds every element the field drives');
  assert.deepEqual(answer.observedValues, ['ON_TIME', 'CANCELLED']);
  assert.equal(answer.affected, 2);

  // §12.4 #5: "send MCP progress notifications at each state change".
  assert.ok(updates.length >= 2, `expected progress at each state change, got ${updates.length}`);
  assert.deepEqual(updates[0], { progress: 1, total: 8, message: S.probe.step.control });
  assert.equal(updates[1].message, S.probe.step.testing(6), '§11 writes this sentence, not this file');

  // The page was asked with the content-script contract's real name, from messages.js.
  const script = api.__calls.find((call) => call[0] === 'executeScript');
  assert.deepEqual(script[2], [CONTENT_GLOBALS.element, '', 'On time']);
});

test('§12.4 #5 a probe that proves nothing returns §11\'s sentence for the reason', async () => {
  for (const reason of [PROBE_FAIL.TOO_NOISY, PROBE_FAIL.NONE_CONFIRMED, PROBE_FAIL.ELEMENT_LOST, PROBE_FAIL.TIMEOUT]) {
    const { ops } = opsWith({
      picked: { ok: true, fingerprint: {}, snapshot: {} },
      table: {
        [PROBE_MSG.START_PROBE]: { ok: true },
        [PROBE_MSG.GET_PROBE]: { ok: true, phase: PROBE_PHASE.FAILED, failure: reason, reload: { index: 4, estimate: 8 } }
      }
    });
    const answer = await ops.probe_element({ tabId: 1, selector: '#p' }, () => {});
    assert.equal(answer.ok, false);
    assert.equal(answer.reason, reason);
    assert.equal(answer.message, probeMessage(reason));
    assert.ok(answer.message.length > 20, `§11 wrote a sentence for ${reason} and it is used`);
    assert.equal('binding' in answer, false, 'a failed probe returns no binding at all');
  }
});

test('§12.4 #5 an element the page does not have is said so, before any reload happens', async () => {
  const { ops, sent, picks } = opsWith({ picked: undefined, table: { [PROBE_MSG.START_PROBE]: { ok: true } } });
  const answer = await ops.probe_element({ tabId: 1, text: 'nothing here' }, () => {});
  assert.deepEqual(answer, { ok: false, reason: 'element-not-found' });
  assert.deepEqual(picks, [], 'nothing was picked, so nothing was recorded as picked');
  assert.deepEqual(sent, [], 'and the page was never reloaded to find that out');
});

test('§11 the probe reasons that have a sentence have one, and the rest are not invented', () => {
  assert.equal(probeMessage(PROBE_FAIL.NO_CANDIDATES), S.pick.noCandidates);
  assert.equal(probeMessage(PROBE_FAIL.NOT_REFETCHED), S.probe.notRefetched);
  assert.equal(probeMessage(PROBE_FAIL.INTERNAL), S.errors.pageBroke);
  assert.equal(probeMessage(PROBE_FAIL.CANCELLED), '', '§11 wrote no sentence for this, so none is made up');
  assert.equal(probeMessage('something new'), '');
});

/**
 * The audit `guards.contract.test.js` cannot do for this one function, done here.
 *
 * The method names are READ OUT OF THE SOURCE rather than listed, so a call added to
 * `findTargetInPage` tomorrow is checked without anybody remembering to add it here; and
 * the contract is learned by EVALUATING `element.js`, exactly as that guard does, so no
 * copy of its key list exists to drift. A misspelled method there is silent — it returns
 * undefined inside a try/catch, and every probe an agent asks for answers
 * "element-not-found" with nothing in any console.
 */
test('§17.2 every element-contract method the injected picker calls is one element.js publishes', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const vm = await import('node:vm');
  const { fileURLToPath } = await import('node:url');

  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, '../src/background/wsOps.js'), 'utf8');
  const body = source.slice(source.indexOf('export function findTargetInPage'));
  const called = [...new Set([...body.slice(0, body.indexOf('\n}')).matchAll(/api\.([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))];
  assert.ok(called.length >= 4, `expected several contract calls, found ${JSON.stringify(called)}`);

  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(here, '../src/content/element.js'), 'utf8'), context, { filename: 'element.js' });
  const published = Object.keys(context[CONTENT_GLOBALS.element]);
  for (const method of called) {
    assert.ok(published.includes(method), `findTargetInPage calls ${method}(), which element.js does not publish`);
  }
  // And the audit must be LOOKING at something: an empty page would pass vacuously.
  assert.ok(published.length >= 5);
  assert.equal(typeof findTargetInPage, 'function');
});
