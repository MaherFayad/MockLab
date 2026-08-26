/**
 * The fake CDP every deep-mode unit suite drives (PLAN.md §8).
 *
 * OWNER: probe-engineer — this file only. `probeWorld.js` beside it is the same idea for
 * §7, and `audit.js` belongs to interceptor-engineer; they share a directory, not a
 * subject.
 *
 * WHY IT IS HERE AND NOT IN `test/`: `node --test` runs every .js file under a directory
 * called `test`, so a helper there would be reported as a suite containing no tests.
 * `testlib` is outside that glob — see `audit.js` for the fuller note.
 *
 * It is deliberately HOSTILE. Every CDP command can be made to fail, because every one of
 * them does fail in the field: a tab closes mid-flight, DevTools takes the target, a build
 * answers `Fetch.continueResponse` with "not supported". And it fires `onDetach` for a
 * detach the engine ASKED for, which Chrome may or may not do — the pessimistic reading,
 * so the ordering that makes the engine right is under test rather than assumed.
 *
 * Importing this sets `globalThis.chrome`, which every service-worker module reads at
 * call time. It must therefore be imported BEFORE anything that touches storage.
 */
import assert from 'node:assert/strict';

import { fakeChrome } from './fakeChrome.js';

export const store = fakeChrome();
globalThis.chrome = store;

const { createDeepEngine } = await import('../src/background/debuggerEngine.js');
const { updateSettings } = await import('../src/background/ruleStore.js');

export const ORIGIN = 'https://ssr.test';
export const URL = 'https://ssr.test/trip/8842';
export const TAB = 11;
export const OTHER = 'https://elsewhere.test/';

export const page = (status) =>
  '<!doctype html><html><body><span id="pill">On time</span>' +
  `<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"status":"${status}"}}}</script>` +
  '</body></html>';

export const HTML_HEADERS = [
  { name: 'content-type', value: 'text/html; charset=utf-8' },
  { name: 'content-length', value: '512' },
  { name: 'content-encoding', value: 'gzip' },
  { name: 'set-cookie', value: 'sid=1' }
];

/** A paused Response-stage navigation, as CDP hands one over. */
export const pausedEvent = (over = {}) => ({
  requestId: 'req-1',
  resourceType: 'Document',
  responseStatusCode: 200,
  responseHeaders: HTML_HEADERS,
  request: { url: URL },
  ...over
});

/** Console noise belongs in the product's log, not in a test run's output. */
export async function quiet(fn) {
  const real = { warn: console.warn, error: console.error };
  const said = [];
  console.warn = (...args) => said.push(args.join(' '));
  console.error = (...args) => said.push(args.join(' '));
  try {
    return { said, value: await fn() };
  } finally {
    Object.assign(console, real);
  }
}

export const deepOn = (...origins) => updateSettings({ deepModeOrigins: origins });

/**
 * Let the engine's own promise chains run out.
 *
 * Counted in macrotask turns rather than one `await`, and the pause path waits on a
 * CONDITION rather than on a number of turns at all. Deciding about a document crosses
 * `crypto.subtle.digest` (§17.3's sigId) and two storage reads, so a fixed wait passes or
 * fails on machine speed — which it did here, at first, on two subtests out of twenty-one.
 * A flaky test in a suite about a false claim is worse than no test.
 */
export const flush = async (turns = 8) => {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

export async function until(check, turns = 400) {
  for (let i = 0; i < turns; i += 1) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return false;
}

/** Everything the engine touches on `chrome`, recording every call it makes. */
export function world({ tabs = [{ id: TAB, url: URL }], targets = [] } = {}) {
  const calls = [];
  const listeners = { event: [], detach: [], updated: [], removed: [], changed: [], alarm: [] };
  const fail = new Map();
  const captured = [];

  const record = (name, args) => calls.push({ name, args });
  const maybeFail = (name) => {
    const why = fail.get(name);
    if (why) return Promise.reject(new Error(why));
    return null;
  };

  const api = {
    storage: {
      ...store.storage,
      onChanged: { addListener: (fn) => listeners.changed.push(fn) }
    },
    tabs: {
      query: async () => tabs,
      get: async (id) => tabs.find((t) => t.id === id) || Promise.reject(new Error('no tab')),
      onUpdated: { addListener: (fn) => listeners.updated.push(fn) },
      onRemoved: { addListener: (fn) => listeners.removed.push(fn) }
    },
    alarms: {
      create: (name, opts) => record('alarms.create', [name, opts]),
      clear: (name) => record('alarms.clear', [name]),
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) }
    },
    debugger: {
      attach: (target, version) => {
        record('attach', [target.tabId, version]);
        return maybeFail('attach') || Promise.resolve();
      },
      detach: (target) => {
        record('detach', [target.tabId]);
        const failed = maybeFail('detach');
        if (failed) return failed;
        // Pessimistic on purpose. Chrome does not document whether `onDetach` fires for a
        // detach the extension itself asked for, and the answer has moved between
        // versions, so this fake says it does — with the reason that would do the most
        // damage. What keeps the engine right is an ORDERING (a tab is dropped from
        // `attached` before it is released), and firing this here is what puts that
        // ordering under test rather than leaving it to a flag nothing consults.
        listeners.detach.forEach((fn) => fn({ tabId: target.tabId }, 'canceled_by_user'));
        return Promise.resolve();
      },
      getTargets: async () => targets,
      sendCommand: (target, method, params) => {
        record(method, [target.tabId, params]);
        const failed = maybeFail(method);
        if (failed) return failed;
        if (method === 'Fetch.getResponseBody') {
          return Promise.resolve(api.__body);
        }
        return Promise.resolve({});
      },
      onEvent: { addListener: (fn) => listeners.event.push(fn) },
      onDetach: { addListener: (fn) => listeners.detach.push(fn) }
    },
    __body: { body: page('ON_TIME'), base64Encoded: false }
  };

  const engine = createDeepEngine({ chrome: api, captureDocument: (tabId, rec) => captured.push({ tabId, ...rec }) });

  return {
    api,
    engine,
    calls,
    captured,
    fail,
    listeners,
    names: () => calls.map((c) => c.name),
    of: (name) => calls.filter((c) => c.name === name),
    emitPause: (params) => listeners.event.forEach((fn) => fn({ tabId: TAB }, 'Fetch.requestPaused', params)),
    /** Pause one navigation and wait until the engine has answered it, however it does. */
    pause: async (params = pausedEvent()) => {
      const before = engine.counts();
      const answered = () => {
        const now = engine.counts();
        return now.rewritten + now.continued + now.lost > before.rewritten + before.continued + before.lost;
      };
      listeners.event.forEach((fn) => fn({ tabId: TAB }, 'Fetch.requestPaused', params));
      assert.equal(await until(answered), true, 'a paused navigation that is never answered is a tab that never loads');
    },
    emitDetach: (reason, tabId = TAB) => listeners.detach.forEach((fn) => fn({ tabId }, reason)),
    emitUpdated: (url, tabId = TAB) => listeners.updated.forEach((fn) => fn(tabId, { url }, { id: tabId, url })),
    emitRemoved: (tabId = TAB) => listeners.removed.forEach((fn) => fn(tabId)),
    emitSettings: () => listeners.changed.forEach((fn) => fn({ settings: {} }, 'local'))
  };
}
