/**
 * M2 — the Changes engine, tested without a browser (PLAN.md §1.5, §4, §10.2, §17.4).
 *
 * OWNER: interceptor-engineer.
 *
 * `ruleStore.js` and `changesApi.js` only ever touch `chrome.storage.local` and four
 * injected functions, so the whole message surface runs under `node --test` against the
 * fake below. The browser suite (`e2e.browser.test.js`) then proves the same behaviour
 * end to end in real Chromium; this file is what makes a regression cheap to find.
 *
 * The fake is defined in this file on purpose: `node --test` executes EVERY .js file
 * under `test/`, so a shared helper module would be run as a test file of its own.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/* --------------------------------------------------------------------- the fake */

/**
 * chrome.storage.local, close enough to the real thing to catch real bugs: values are
 * deep-cloned on the way in AND on the way out, so a test that mutates a returned
 * object cannot accidentally "write" to the store the way the real API never would.
 */
function fakeChrome() {
  const data = new Map();
  /** One-shot read delays, so a test can hold a read-modify-write open on purpose. */
  const delays = new Map();
  return {
    __data: data,
    /** Make the NEXT read of `key` take `ms`, then behave normally again. */
    __delayNextGet(key, ms) {
      delays.set(key, ms);
    },
    storage: {
      local: {
        async get(key) {
          if (key === null || key === undefined) {
            return Object.fromEntries([...data].map(([k, v]) => [k, structuredClone(v)]));
          }
          const keys = Array.isArray(key) ? key : [key];
          const out = {};
          for (const k of keys) if (data.has(k)) out[k] = structuredClone(data.get(k));
          // The snapshot is taken FIRST and the delay applied after, because that is
          // the shape of the hazard: a read-modify-write whose read already happened
          // and whose write is still to come.
          for (const k of keys) {
            const wait = delays.get(k);
            if (wait === undefined) continue;
            delays.delete(k);
            await new Promise((resolve) => setTimeout(resolve, wait));
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

const ORIGIN = 'https://demo.test';
const SIG = 'abc123def456';

/**
 * A fresh STORE per test — a new fake `chrome`, not a new module instance.
 *
 * Cache-busting the import looked tidier and was wrong: `changesApi.js` imports
 * `./ruleStore.js` by its own plain specifier, so a busted copy of the store here left
 * the API talking to a DIFFERENT module instance with a DIFFERENT write-lock map. The
 * two shared the fake storage, so every result still looked right — until test 27,
 * which is the one test that can only pass if both halves share one lock.
 */
async function freshModules() {
  globalThis.chrome = fakeChrome();
  const store = await import('../src/background/ruleStore.js');
  const api = await import('../src/background/changesApi.js');
  return { store, api, chrome: globalThis.chrome };
}

/** A worker stand-in: one tab, one captured source, a reload we can count. */
function fakeDeps(overrides = {}) {
  const state = {
    reloads: 0,
    badgeRepaints: 0,
    url: ORIGIN + '/trip',
    record: {
      sigId: SIG,
      signature: { sigId: SIG, method: 'GET', urlPattern: ORIGIN + '/api/trip.json' },
      body: { status: 'ON_TIME', price: { total: 450 } }
    }
  };
  return {
    state,
    deps: {
      async resolveTabId(requested) {
        return typeof requested === 'number' ? requested : 7;
      },
      async tabInfo() {
        return { url: state.url, origin: ORIGIN, faviconUrl: '', captured: true };
      },
      capturedRecord(_tabId, sigId) {
        return sigId === state.record.sigId ? state.record : null;
      },
      async repaintAllBadges() {
        state.badgeRepaints += 1;
      },
      async reload(tabId) {
        // Mirrors background.js: with no tab there is nothing to reload, and the
        // answer says so rather than claiming a refresh that never happened.
        if (tabId === null) return false;
        state.reloads += 1;
        return true;
      },
      ...overrides
    }
  };
}

async function setup(overrides) {
  const { store, api, chrome } = await freshModules();
  const { state, deps } = fakeDeps(overrides);
  await store.rememberSignature(ORIGIN, state.record.signature);
  const { handle } = api.createChangesApi(deps);
  const { MSG } = await import('../src/background/messages.js');
  return { store, chrome, state, handle, MSG };
}

/* ------------------------------------------------------------------- the store */

test('1 a Change is created, then edited in place rather than stacked', async () => {
  const { store } = await freshModules();
  const first = await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.status', value: 'CANCELLED' });
  const second = await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.status', value: 'DELAYED' });
  const list = await store.getChanges(ORIGIN);
  assert.equal(list.length, 1, 'one Change per field');
  assert.equal(list[0].value, 'DELAYED');
  assert.equal(second.id, first.id, 'the id is stable across edits');
});

test('2 a probe Change and a user Change on the same field coexist', async () => {
  const { store } = await freshModules();
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.status', value: 'A' });
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.status', value: 'B', probe: true });
  assert.equal((await store.getChanges(ORIGIN)).length, 2);
});

test('3 the active count is enabled, non-probe Changes only (§1.5)', async () => {
  const { store } = await freshModules();
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.a', value: 1 });
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.b', value: 2, enabled: false });
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.c', value: 3, probe: true });
  assert.equal(await store.countActiveChanges(ORIGIN), 1);
  assert.equal(await store.countActiveChanges(''), 0, 'no origin, no badge');
});

test('4 Reset site removes every Change on that origin and no other', async () => {
  const { store } = await freshModules();
  const other = 'https://other.test';
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.a', value: 1 });
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.b', value: 2, enabled: false });
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.c', value: 3, probe: true });
  await store.addChange({ origin: other, sigId: SIG, path: '$.a', value: 9 });

  assert.equal(await store.clearChanges(ORIGIN), 3, 'disabled and probe Changes go too');
  assert.deepEqual(await store.getChanges(ORIGIN), []);
  assert.equal((await store.getChanges(other)).length, 1, 'another site is untouched');
});

test('5 concurrent writes to one origin do not lose each other', async () => {
  const { store } = await freshModules();
  await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      store.addChange({ origin: ORIGIN, sigId: SIG, path: `$.f${i}`, value: i })
    )
  );
  assert.equal((await store.getChanges(ORIGIN)).length, 25);
});

test('6 §17.4 a Change made without a probe leaves a CANDIDATE link, never verified', async () => {
  const { store } = await freshModules();
  const binding = await store.noteChangedPath(ORIGIN, SIG, '$.status', 'ON_TIME');
  assert.equal(binding.state, 'candidate');
  assert.deepEqual(binding.elements, [], 'nothing has been proved about any element');
  assert.equal(binding.lastVerifiedAt, 0);
  assert.deepEqual(binding.observedValues, ['ON_TIME']);
});

test('7 §17.4 noting a path again never rewrites the state of an existing link', async () => {
  const { store } = await freshModules();
  // Stand in for what the probe will write at M4.
  await store.setBindings(ORIGIN, [
    {
      id: 'b1', origin: ORIGIN, sigId: SIG, path: '$.status', elements: [{ css: '#status-pill' }],
      state: 'verified', lastVerifiedAt: 111, observedValues: ['ON_TIME'], probeMode: 'refresh'
    }
  ]);
  const after = await store.noteChangedPath(ORIGIN, SIG, '$.status', 'DELAYED');
  assert.equal(after.state, 'verified', 'a proved link is never silently downgraded (§1.1)');
  assert.equal(after.lastVerifiedAt, 111);
  assert.deepEqual(after.observedValues, ['DELAYED', 'ON_TIME'], 'the new real value is remembered');
  assert.equal(after.elements.length, 1, 'proved elements survive');
});

test('8 observedValues stay distinct and capped at 10 (§4)', async () => {
  const { store } = await freshModules();
  for (let i = 0; i < 14; i += 1) await store.noteChangedPath(ORIGIN, SIG, '$.n', i);
  await store.noteChangedPath(ORIGIN, SIG, '$.n', 13);
  const binding = await store.findBinding(ORIGIN, SIG, '$.n');
  assert.equal(binding.observedValues.length, 10);
  assert.equal(new Set(binding.observedValues).size, 10, 'no duplicates');
});

test('9 a Change only compiles into a match list once its signature is remembered', async () => {
  const { store } = await freshModules();
  const { parsePath } = await import('../src/shared/jsonpath.js');
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.status', value: 'CANCELLED' });
  assert.deepEqual(await store.groupChangesBySignature(ORIGIN, parsePath), [], 'unknown source: nothing to match');

  await store.rememberSignature(ORIGIN, { sigId: SIG, method: 'GET', urlPattern: ORIGIN + '/api/trip.json' });
  const groups = await store.groupChangesBySignature(ORIGIN, parsePath);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].changes[0].tokens, [{ type: 'key', value: 'status' }], 'the path is pre-parsed for the MAIN world');
});

/* ------------------------------------------------------- the M2 message surface */

test('10 SET_VALUE creates the Change, captures the REAL value, and refreshes', async () => {
  const { handle, state, MSG } = await setup();
  const res = await handle({
    type: MSG.SET_VALUE,
    payload: { tabId: 7, sigId: SIG, path: '$.status', value: 'CANCELLED' }
  });

  assert.equal(res.ok, true);
  assert.equal(res.change.value, 'CANCELLED');
  assert.equal(res.change.originalValue, 'ON_TIME', 'the real value came from the captured body');
  assert.equal(res.change.sourceName, 'Trip', 'named the same way the Sources tab names it');
  assert.equal(res.change.applies, true);
  assert.equal(res.change.linkState, 'candidate', '§10.2 — applied, but not verified');
  assert.equal(res.changeCount, 1);
  assert.equal(res.refreshed, true);
  assert.equal(state.reloads, 1, 'the tab was reloaded exactly once');
});

test('11 SET_VALUE with refresh:false touches the store and nothing else', async () => {
  const { handle, state, MSG } = await setup();
  const res = await handle({
    type: MSG.SET_VALUE,
    payload: { tabId: 7, sigId: SIG, path: '$.status', value: 'DELAYED', refresh: false }
  });
  assert.equal(res.refreshed, false);
  assert.equal(state.reloads, 0);
});

test('12 editing a Change never overwrites the real value with a mocked one', async () => {
  const { handle, MSG } = await setup();
  await handle({ type: MSG.SET_VALUE, payload: { sigId: SIG, path: '$.status', value: 'CANCELLED', refresh: false } });
  const second = await handle({
    type: MSG.SET_VALUE,
    payload: { sigId: SIG, path: '$.status', value: 'DELAYED', refresh: false }
  });
  assert.equal(second.change.originalValue, 'ON_TIME', '"Real value: …" must stay real (§11)');
  assert.equal(second.changeCount, 1, 'still one Change, not two');
});

test('13 a Change on a source this tab never captured is reported as not applying', async () => {
  const { handle, MSG } = await setup();
  const res = await handle({
    type: MSG.SET_VALUE,
    payload: { sigId: 'ffffffffffff', path: '$.status', value: 'X', refresh: false }
  });
  assert.equal(res.ok, true, 'the Change is still stored — it will apply when the request reappears');
  assert.equal(res.change.applies, false, '§1.1 — never report it as applied');
  assert.equal(res.change.originalValue, undefined);
});

test('14 TOGGLE_CHANGE flips, and the badge count follows', async () => {
  const { handle, MSG } = await setup();
  const created = await handle({
    type: MSG.SET_VALUE,
    payload: { sigId: SIG, path: '$.status', value: 'CANCELLED', refresh: false }
  });
  const off = await handle({ type: MSG.TOGGLE_CHANGE, payload: { changeId: created.change.id, refresh: false } });
  assert.equal(off.change.enabled, false);
  assert.equal(off.changeCount, 0, 'a disabled Change is not an active one');

  const on = await handle({ type: MSG.TOGGLE_CHANGE, payload: { changeId: created.change.id, refresh: false } });
  assert.equal(on.change.enabled, true);
  assert.equal(on.changeCount, 1);
});

test('15 UPDATE_CHANGE and DELETE_CHANGE answer honestly for an unknown id', async () => {
  const { handle, MSG } = await setup();
  assert.deepEqual(await handle({ type: MSG.UPDATE_CHANGE, payload: { changeId: 'nope' } }), {
    ok: false, reason: 'no-such-change'
  });
  assert.deepEqual(await handle({ type: MSG.DELETE_CHANGE, payload: { changeId: 'nope' } }), {
    ok: false, reason: 'no-such-change'
  });
});

test('16 DELETE_CHANGE removes one row and refreshes', async () => {
  const { handle, state, MSG } = await setup();
  const a = await handle({ type: MSG.SET_VALUE, payload: { sigId: SIG, path: '$.status', value: 'X', refresh: false } });
  await handle({ type: MSG.SET_VALUE, payload: { sigId: SIG, path: '$.price.total', value: 9, refresh: false } });
  const res = await handle({ type: MSG.DELETE_CHANGE, payload: { changeId: a.change.id } });
  assert.equal(res.deleted, 1);
  assert.equal(res.changeCount, 1);
  assert.equal(state.reloads, 1);
});

test('17 RESET_SITE clears the site and reloads it (§1.5)', async () => {
  const { handle, store, state, MSG } = await setup();
  await handle({ type: MSG.SET_VALUE, payload: { sigId: SIG, path: '$.status', value: 'X', refresh: false } });
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.probe', value: 1, probe: true });

  const res = await handle({ type: MSG.RESET_SITE, payload: { tabId: 7 } });
  assert.equal(res.ok, true);
  assert.equal(res.cleared, 2, 'probe scaffolding goes too');
  assert.equal(res.changeCount, 0);
  assert.equal(res.refreshed, true);
  assert.equal(state.reloads, 1);
  assert.deepEqual(await store.getChanges(ORIGIN), []);
});

test('18 GET_SITE_STATE is one consistent snapshot for the site bar (§10)', async () => {
  const { handle, MSG } = await setup();
  await handle({ type: MSG.SET_VALUE, payload: { sigId: SIG, path: '$.status', value: 'X', refresh: false } });
  await handle({ type: MSG.SET_VALUE, payload: { sigId: SIG, path: '$.price.total', value: 9, refresh: false } });
  const res = await handle({ type: MSG.GET_SITE_STATE, payload: { tabId: 7 } });

  assert.equal(res.origin, ORIGIN);
  assert.equal(res.hostname, 'demo.test');
  assert.equal(res.changeCount, 2);
  assert.equal(res.changes.length, 2);
  assert.ok(res.changes.every((c) => c.linkState === 'candidate'), 'nothing is verified without a probe');
});

test('19 LIST_CHANGES can read a site the tab is not showing', async () => {
  const { handle, store, MSG } = await setup();
  const other = 'https://elsewhere.test';
  await store.addChange({ origin: other, sigId: SIG, path: '$.a', value: 1 });
  const res = await handle({ type: MSG.LIST_CHANGES, payload: { origin: other } });
  assert.equal(res.origin, other);
  assert.equal(res.changes.length, 1);
});

test('20 GET_BINDINGS returns candidate links only, before any probe exists', async () => {
  const { handle, MSG } = await setup();
  await handle({ type: MSG.SET_VALUE, payload: { sigId: SIG, path: '$.status', value: 'X', refresh: false } });
  const res = await handle({ type: MSG.GET_BINDINGS, payload: { tabId: 7 } });
  assert.equal(res.bindings.length, 1);
  assert.equal(res.bindings[0].state, 'candidate');
});

test('21 settings round-trip and merge rather than replace', async () => {
  const { handle, MSG } = await setup();
  const defaults = await handle({ type: MSG.GET_SETTINGS, payload: {} });
  assert.equal(defaults.settings.advancedMode, false);
  const next = await handle({ type: MSG.UPDATE_SETTINGS, payload: { patch: { advancedMode: true } } });
  assert.equal(next.settings.advancedMode, true);
  assert.equal(next.settings.paranoid, false, 'the rest of the settings survive');
});

test('22 REFRESH_TAB reloads without touching the store', async () => {
  const { handle, store, state, MSG } = await setup();
  await handle({ type: MSG.SET_VALUE, payload: { sigId: SIG, path: '$.status', value: 'X', refresh: false } });
  const before = await store.getChanges(ORIGIN);
  const res = await handle({ type: MSG.REFRESH_TAB, payload: { tabId: 7 } });
  assert.equal(res.refreshed, true);
  assert.equal(state.reloads, 1);
  assert.deepEqual(await store.getChanges(ORIGIN), before);
});

test('23 a mutation with no resolvable tab still stores, and says it did not refresh', async () => {
  const { handle, MSG } = await setup({
    async resolveTabId() { return null; },
    async tabInfo() { return { url: '', origin: ORIGIN, faviconUrl: '', captured: false }; }
  });
  const res = await handle({ type: MSG.SET_VALUE, payload: { sigId: SIG, path: '$.status', value: 'X' } });
  assert.equal(res.ok, true);
  assert.equal(res.refreshed, false, '§1.1 — report what happened, not what was asked for');
});

/* ------------------------------------------------- §10.5 danger zone: reset everything */

test('24 RESET_ALL clears Changes, Scenarios and Links on EVERY site', async () => {
  const { handle, store, chrome, state, MSG } = await setup();
  const other = 'https://elsewhere.test';

  await handle({ type: MSG.SET_VALUE, payload: { sigId: SIG, path: '$.status', value: 'X', refresh: false } });
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.probe', value: 1, probe: true });
  await store.addChange({ origin: other, sigId: SIG, path: '$.a', value: 1 });
  await store.addChange({ origin: other, sigId: SIG, path: '$.b', value: 2, enabled: false });
  await store.noteChangedPath(other, SIG, '$.a', 'real');
  await store.setPresets(other, [{ id: 'p1', origin: other, name: 'Cancelled', emoji: '🎬', changes: [], createdAt: 1 }]);

  const res = await handle({ type: MSG.RESET_ALL, payload: { tabId: 7 } });

  assert.equal(res.ok, true);
  assert.equal(res.cleared.changes, 4, 'both sites, disabled and probe Changes included');
  assert.equal(res.cleared.presets, 1);
  assert.equal(res.cleared.bindings, 2, 'the tree-view link and the other site\'s');
  assert.deepEqual(res.cleared.origins.sort(), [ORIGIN, other].sort());
  assert.equal(res.refreshed, true);
  assert.equal(state.badgeRepaints, 1, 'every tab is repainted, not only the ones with Changes');

  for (const origin of [ORIGIN, other]) {
    assert.deepEqual(await store.getChanges(origin), [], `${origin} has no Changes`);
    assert.deepEqual(await store.getBindings(origin), [], `${origin} has no Links`);
    assert.deepEqual(await store.getPresets(origin), [], `${origin} has no Scenarios`);
    assert.equal(await store.countActiveChanges(origin), 0);
  }
  assert.deepEqual(
    [...chrome.__data.keys()].filter((k) => /^(changes|bindings|presets):/.test(k)),
    [],
    'the keys are gone, not merely emptied'
  );
});

test('25 RESET_ALL keeps settings and the derived signature cache', async () => {
  const { handle, store, MSG } = await setup();
  await handle({ type: MSG.UPDATE_SETTINGS, payload: { patch: { advancedMode: true, companionToken: 'tok' } } });
  await handle({ type: MSG.SET_VALUE, payload: { sigId: SIG, path: '$.status', value: 'X', refresh: false } });

  await handle({ type: MSG.RESET_ALL, payload: { tabId: 7, refresh: false } });

  const settings = await store.getSettings();
  assert.equal(settings.advancedMode, true, 'preferences are not user data to wipe');
  assert.equal(settings.companionToken, 'tok', 'a data reset must not silently unpair the AI');
  assert.ok((await store.getSignatures(ORIGIN))[SIG], 'the signature cache is derived, and survives');
});

test('26 RESET_ALL on an empty store is a clean no-op', async () => {
  const { handle, MSG } = await setup();
  const res = await handle({ type: MSG.RESET_ALL, payload: { tabId: 7, refresh: false } });
  assert.deepEqual(res.cleared, { origins: [], changes: 0, presets: 0, bindings: 0 });
  assert.equal(res.refreshed, false);
});

test('27 RESET_ALL is not raced by a Change created while it runs', async () => {
  const { handle, store, chrome, MSG } = await setup();
  await handle({ type: MSG.SET_VALUE, payload: { sigId: SIG, path: '$.status', value: 'X', refresh: false } });

  // Force the dangerous interleaving rather than hoping for it: the create's read is
  // held open for 50 ms, so an UNLOCKED reset would delete the key in the middle of a
  // read-modify-write and the create would then write the pre-reset list straight back.
  // The per-key write lock is the only thing that prevents it — remove the lock in
  // ruleStore.resetEverything and this test fails with `$.status` still standing.
  chrome.__delayNextGet('changes:' + ORIGIN, 50);
  const creating = store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.price.total', value: 9 });
  const resetting = handle({ type: MSG.RESET_ALL, payload: { tabId: 7, refresh: false } });
  await Promise.all([creating, resetting]);

  const left = await store.getChanges(ORIGIN);
  assert.ok(!left.some((c) => c.path === '$.status'), 'nothing from before the reset is left standing');
  assert.ok(left.length <= 1, `at most the late Change survives, never a pre-reset one (${left.length})`);
});
