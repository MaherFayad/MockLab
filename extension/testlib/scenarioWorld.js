/**
 * The world M5's two Scenario suites drive: a fake `chrome`, and the worker's message
 * surface wired to it exactly as `background.js` wires it.
 *
 * OWNER: interceptor-engineer.
 *
 * WHY THIS DIRECTORY AND NOT `test/`: `node --test` executes every .js file under a
 * directory called `test`, so a helper module living there would run as a suite
 * containing no tests. `testlib` is outside that glob — `audit.js` carries the fuller
 * note, including why a helper directory is not a blind spot (§17.10's line audit and
 * the ISOLATED-world global scan both derive their file lists from `package.json`'s
 * workspaces, so this file is audited like any other the day it appears).
 *
 * WHY IT IS SHARED at all, when `changes.test.js` deliberately keeps its own copy: these
 * two suites are one subject split by §17.10's line budget, not two owners' fixtures.
 * `presets.test.js` drives the Scenario CRUD; `presets.import.test.js` drives the one
 * door a document MockLab did not write comes through. A drift between their worlds
 * would be a drift inside a single test subject, which is the thing the split must not
 * cost.
 *
 * Everything both suites send goes through `changesApi.handle` and never through
 * `presets.js` directly: `background.js` routes on the set `changesApi.js` exports, and
 * the MCP bridge is handed the SAME router (`wsClient` -> `routeMessage`). A preset type
 * that answers when imported directly but is not routed is exactly the gap M6 closed —
 * the panel and the agent both got a silent `undefined` for six milestones.
 */

export const ORIGIN = 'https://demo.test';
export const OTHER = 'https://other.test';
export const SIG = 'abc123def456';
export const UNKNOWN_SIG = '0000deadbeef';

/** chrome.storage.local + the one runtime call a preset mutation makes (PRESETS_CHANGED). */
export function fakeChrome() {
  const data = new Map();
  const broadcasts = [];
  const refuse = { writes: false };
  return {
    __data: data,
    __broadcasts: broadcasts,
    /** Storage that starts working and stops, which is how a quota is really reached. */
    __refuseWrites() { refuse.writes = true; },
    runtime: {
      sendMessage(message) {
        broadcasts.push(message);
        // The real one rejects when no panel is open, which is the NORMAL case. A handler
        // that does not swallow it loses the write it has already made.
        return Promise.reject(new Error('Could not establish connection'));
      }
    },
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
          if (refuse.writes) throw new Error('QUOTA_BYTES quota exceeded');
          for (const [k, v] of Object.entries(bag)) data.set(k, structuredClone(v));
        },
        async remove(key) {
          for (const k of Array.isArray(key) ? key : [key]) data.delete(k);
        }
      }
    }
  };
}

/**
 * A fresh STORE per test, not a fresh module: `changes.test.js` records why a
 * cache-busted import is wrong here — the two halves would hold different write locks.
 */
export async function setup({ signatures = [SIG] } = {}) {
  globalThis.chrome = fakeChrome();
  const store = await import('../src/background/ruleStore.js');
  const presets = await import('../src/background/presets.js');
  const api = await import('../src/background/changesApi.js');
  const { MSG } = await import('../src/background/messages.js');

  const state = { reloads: 0, origin: ORIGIN };
  const { handle } = api.createChangesApi({
    // `null` is what background.js's resolveTabId answers when there is no tab at all.
    resolveTabId: async (requested) => (requested === null ? null : typeof requested === 'number' ? requested : 7),
    tabInfo: async (tabId) =>
      tabId === null
        ? { url: '', origin: '', faviconUrl: '', captured: false }
        : { url: state.origin + '/trip', origin: state.origin, faviconUrl: '', captured: true },
    capturedRecord: () => null,
    repaintAllBadges: async () => {},
    reload: async (tabId) => {
      if (tabId === null) return false;
      state.reloads += 1;
      return true;
    }
  });

  for (const sigId of signatures) {
    await store.rememberSignature(ORIGIN, { sigId, method: 'GET', urlPattern: ORIGIN + '/api/trip.json' });
  }
  const send = (type, payload = {}) => handle({ type, payload });
  return { store, presets, api, MSG, state, handle, send, chrome: globalThis.chrome };
}

/** Two enabled Changes, one disabled, one probe — the shape SAVE has to filter. */
export async function seedChanges(store) {
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.status', value: 'CANCELLED', originalValue: 'ON_TIME', note: 'Flight cancelled' });
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.price.total', value: 999 });
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.hidden', value: 1, enabled: false });
  await store.addChange({ origin: ORIGIN, sigId: SIG, path: '$.probe', value: 2, probe: true });
}

/** A §4 Preset as a file/socket payload: what IMPORT_PRESET is handed. */
export const importable = (over = {}) => ({
  name: 'Flight cancelled',
  emoji: '🚩',
  changes: [{ sigId: SIG, path: '$.status', value: 'CANCELLED', enabled: true }],
  ...over
});

