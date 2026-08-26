/**
 * Deep mode: `chrome.debugger` + the CDP Fetch domain (PLAN.md §8, §16 M7).
 *
 * OWNER: probe-engineer. Deep mode is three files, split by what can go wrong in each:
 * `documentData.js` is pure text and JSON and is tested exhaustively without a browser;
 * `deepFetch.js` is one paused request, which must always be released; and this file is
 * the attachment itself, which must never be left standing. Together they are the only
 * code in MockLab that can change something the MAIN-world patch cannot reach (§17.1:
 * "Only the MAIN-world patch and CDP Fetch can").
 *
 * ══ WHAT THIS COSTS THE USER, SAID FIRST ═══════════════════════════════════════════
 *
 * Attaching the debugger shows a bar across the top of their browser saying Chrome is
 * being debugged. They did not ask for it, they cannot dismiss it without also dismissing
 * MockLab, and it stays for as long as this is attached. It can also break the page:
 * every navigation is PAUSED mid-flight and resumes only when this code answers, so a bug
 * here is not a wrong value on a screen — it is a tab that never loads. That is why §8
 * makes it opt-in per site, and the reason for every defensive line below.
 *
 * Three rules follow from it, and none of them is negotiable:
 *
 *   1. OFF BY DEFAULT. Nothing here attaches until an origin is in `deepModeOrigins`
 *      (§4's settings key), which only the person can put it in.
 *   2. NEVER SILENTLY ATTACHED. Every paused request is settled exactly once, by fulfil
 *      or by continue, including on a thrown error and including when this code takes too
 *      long to decide. The worker detaches from everything at startup before it attaches
 *      to anything, because an evicted service worker leaves the attachment standing and
 *      its own memory of it gone.
 *   3. NEVER SILENTLY *NOT* ATTACHED EITHER. A detach this code did not ask for — Cancel
 *      on Chrome's bar, DevTools taking the target, a renderer crash — turns the setting
 *      OFF for that origin. The alternative is a checkbox that says deep mode is on while
 *      nothing is intercepting: a false statement about MockLab's own state, which is
 *      what §17.12 is about. DEVIATION 3 below says what is still missing on the panel.
 *
 * ══ DEVIATIONS FROM §8, EACH WITH ITS REASON ═══════════════════════════════════════
 *
 * 1. FETCH PATTERNS ARE DOCUMENT-ONLY. §8 lists Document, XHR and Fetch, and then makes
 *    a rule to stop the double-application that XHR and Fetch would cause: "in Deep
 *    mode, interceptor.js is told to only CAPTURE, never MODIFY". Interception here is
 *    narrowed to Documents instead, which removes the double-application at its root:
 *      • §5.1's in-page patch — the path every milestone since M1 was tested against —
 *        keeps XHR and fetch, so turning deep mode on changes nothing else about how
 *        MockLab behaves and §7's probe goes on working unchanged.
 *      • The alternative fails in the direction §17.12 forbids: mute the interceptor
 *        whenever the setting is on, and any detach leaves a site where the setting says
 *        deep mode is on, nothing is attached, and NO Change applies, silently.
 *      • Every paused request can hang a tab. One navigation per load rather than every
 *        request is the smaller blast radius, and it is all §10.5's copy promised:
 *        "needed only when a site shows data before any loading happens".
 *    The cost, honestly: a response the MAIN world cannot rewrite (a stream already
 *    consumed by the site, §5.1.4) stays un-rewritable. Deep mode does not rescue it.
 *
 * 2. PROBE SCAFFOLDING IS NEVER APPLIED HERE. `overlaysFor()` excludes `probe:true`
 *    Changes, so §7's experiment cannot run through this path: a document-embedded field
 *    is editable but never provable, and a probe over one ends in §11's
 *    `probe.noneConfirmed`, whose words are exactly true of it — "its content may be
 *    built into the page itself rather than loaded as data". Conservative on purpose. A
 *    field this engine does not mutate cannot make an element move, so it can only be
 *    DISCARDED by bisection or fail VERIFY_ON — a refusal, never a false confirmation.
 *    Deep mode adds no second road to `state: 'verified'`, which stays where §17.4 puts
 *    it: one assignment, in probe.js.
 *
 * 3. `deep.devtoolsConflict` (§11) HAS NO SURFACE. The string exists; showing it needs a
 *    message type, and `messages.js` belongs to another owner. Rule 3 above happens
 *    instead — the setting is cleared, so the checkbox is right the next time it is read.
 *    Reported rather than papered over: a person watching the panel at that moment sees
 *    the tick disappear with no sentence beside it.
 *
 * ══ WHEN INTERCEPTION STARTS ═══════════════════════════════════════════════════════
 * At the NEXT load of a tab, never the first one. `chrome.tabs.onUpdated` delivers
 * `changeInfo.url` when a navigation COMMITS, which is after the response has arrived —
 * measured in Chromium at M7, where the attach itself took 6 ms and still landed after
 * the document. No trigger available under §3's permissions fires earlier. So a tab
 * opened fresh on a deep-mode site shows the site's own data until it is refreshed,
 * which is what the product asks for anyway (turn it on, then "Apply & refresh page").
 * The honest half is that nothing claims otherwise in between: no document source is
 * reported for that first load, so no field is offered that could not have been changed.
 *
 * ══ THE STATE NO FIXTURE REACHES ═══════════════════════════════════════════════════
 * A service worker evicted WHILE attached. The attachment survives the worker; the map
 * below does not. Chrome then has a Fetch domain enabled whose listener lives in a
 * sleeping process, and a navigation can pause with nobody to answer it. The keepalive
 * alarm and the startup detach are mitigations, not proofs. No test here can produce it
 * — the unit suite has no worker lifetime, and a browser suite cannot make Chrome evict
 * on command. It needs a person, a real Chrome and five idle minutes.
 */

import { getSettings, updateSettings, originOf } from './ruleStore.js';
import { createInterceptor } from './deepFetch.js';

/** §8: the protocol version to attach with. */
export const CDP_VERSION = '1.3';

/**
 * §8's patterns, narrowed to Documents — see DEVIATION 1. `requestStage: "Response"` is
 * what makes `Fetch.getResponseBody` legal: at the Request stage there is no body yet.
 */
export const FETCH_PATTERNS = Object.freeze([
  Object.freeze({ urlPattern: '*', requestStage: 'Response', resourceType: 'Document' })
]);

/**
 * §2's `chrome.alarms` heartbeat trick, for the same reason, running ONLY while something
 * is attached. Chrome's floor for a periodic alarm is 30 s and the worker's idle timeout
 * is 30 s, so this shortens the eviction window rather than closing it — said plainly
 * because the header above promises not to pretend otherwise.
 */
export const KEEPALIVE_ALARM = 'mocklab-deep-keepalive';
export const KEEPALIVE_MINUTES = 0.5;

/** Why this engine let go of a tab. Reported by `status()`; never shown to a user. */
export const LET_GO = Object.freeze({
  OFF: 'setting-off',
  TAB_GONE: 'tab-closed',
  NAVIGATED: 'left-origin',
  TAKEN: 'detached-elsewhere',
  FAILED: 'attach-failed'
});

/* ------------------------------------------------------------------- the engine */

/**
 * @param {{
 *   chrome?: any,
 *   captureDocument: (tabId:number, record:any) => void,
 *   onStatus?: (tabId:number, status:any) => void
 * }} deps
 */
export function createDeepEngine(deps) {
  const api = deps.chrome || globalThis.chrome;
  const capture = deps.captureDocument || (() => {});
  const announce = deps.onStatus || (() => {});

  /** @type {Map<number, {origin:string, attached:boolean, since:number}>} */
  const attached = new Map();
  /** One in-flight attach per tab, so two triggers cannot both call `attach`. */
  const pending = new Map();
  const debug = () => (api && api.debugger) || null;

  /** One CDP command. Rejections are the caller's business; nothing is swallowed here. */
  function send(tabId, method, params) {
    return debug().sendCommand({ tabId }, method, params || {});
  }

  /**
   * What to do with a paused navigation, in `deepFetch.js`. It is handed the two things
   * it may know about this engine and nothing else: how to talk CDP, and whether a tab
   * is still held — so a request paused on a tab this engine has already let go of is
   * released rather than rewritten.
   */
  const fetching = createInterceptor({
    send,
    capture: (tabId, record) => capture(tabId, record),
    heldFor: (tabId) => attached.get(tabId) || null
  });

  /**
   * Let a target go. Every `chrome.debugger.detach` in this file goes through here, and
   * every caller has ALREADY removed the tab from `attached` — which is what lets
   * `onDetach` below tell a detach we asked for from one done to us, with no flag to
   * keep in step. That ordering is the invariant; `deepMode.test.js` mutates it (the
   * delete moved after the release) and subtest 9 is what fails.
   *
   * A flag was written here first and was dead code: by the time any release ran, no
   * path still held the tab, so the flag was never once consulted. Found by mutating it
   * away and watching every test stay green.
   */
  async function release(tabId) {
    try {
      await debug().detach({ tabId });
    } catch {
      /* the tab is gone, or the session was never ours */
    }
  }

  /* -------------------------------------------------------------- attach / detach */

  /**
   * Attach to one tab and enable Fetch. Either both happen or neither does: an attach
   * that succeeds followed by an `Fetch.enable` that fails would leave the user's browser
   * wearing the debugging bar for an engine that intercepts nothing.
   */
  async function attach(tabId, origin) {
    if (!debug()) return false;
    if (attached.has(tabId)) return true;
    if (pending.has(tabId)) return pending.get(tabId);

    const work = (async () => {
      try {
        await debug().attach({ tabId }, CDP_VERSION);
      } catch (err) {
        await standDown(origin, tabId, LET_GO.FAILED, err);
        return false;
      }
      try {
        await send(tabId, 'Fetch.enable', { patterns: FETCH_PATTERNS.map((p) => ({ ...p })) });
      } catch (err) {
        await release(tabId);
        await standDown(origin, tabId, LET_GO.FAILED, err);
        return false;
      }
      attached.set(tabId, { origin, attached: true, since: Date.now() });
      keepalive(true);
      announce(tabId, status(tabId));
      return true;
    })();

    pending.set(tabId, work);
    try {
      return await work;
    } finally {
      pending.delete(tabId);
    }
  }

  /**
   * Give a tab back. `Fetch.disable` first, because detaching with requests still paused
   * relies on Chrome releasing them for us — true today, and not a thing to depend on
   * when the failure mode is a hung tab. Best-effort: a closed tab answers neither.
   */
  async function detach(tabId, why) {
    if (!attached.has(tabId)) return false;
    attached.delete(tabId);
    await send(tabId, 'Fetch.disable').catch(() => {});
    await release(tabId);
    keepalive(attached.size > 0);
    announce(tabId, { ...status(tabId), why });
    return true;
  }

  /**
   * Deep mode could not be honoured for this origin, so the SETTING stops claiming it is.
   * Rule 3 in the header: a tick that means nothing is worse than a tick that vanishes.
   */
  async function standDown(origin, tabId, why, err) {
    console.warn('[MockLab] deep mode off for', origin, '—', why, err ? String(err.message || err) : '');
    try {
      const settings = await getSettings();
      const kept = (settings.deepModeOrigins || []).filter((entry) => entry !== origin);
      if (kept.length !== (settings.deepModeOrigins || []).length) {
        await updateSettings({ deepModeOrigins: kept });
      }
    } catch (storeErr) {
      console.error('[MockLab] could not clear deep mode', storeErr);
    }
    announce(tabId, { ...status(tabId), why });
  }

  function keepalive(on) {
    if (!api || !api.alarms) return;
    if (on) api.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_MINUTES });
    else api.alarms.clear(KEEPALIVE_ALARM);
  }

  /* ------------------------------------------------------------------- the policy */

  /** Should this tab be intercepted right now? One place decides, so nothing can drift. */
  async function syncTab(tabId, url) {
    if (typeof tabId !== 'number') return false;
    let settings;
    try {
      settings = await getSettings();
    } catch {
      return false;
    }
    const wanted = new Set(settings.deepModeOrigins || []);
    let origin = originOf(url || '');
    if (!url) {
      try {
        const tab = await api.tabs.get(tabId);
        origin = originOf((tab && tab.url) || '');
      } catch {
        origin = '';
      }
    }

    const held = attached.get(tabId);
    if (held && held.origin !== origin) {
      // §8: detach on navigation to a different origin. The person turned deep mode on
      // for ONE site; carrying the debugging bar onto the next one is not what they said.
      await detach(tabId, LET_GO.NAVIGATED);
    }
    if (origin && wanted.has(origin)) return attach(tabId, origin);
    if (attached.has(tabId)) await detach(tabId, LET_GO.OFF);
    return false;
  }

  /** Every open tab, on startup and whenever the settings move. */
  async function syncAll() {
    let tabs = [];
    try {
      tabs = (await api.tabs.query({})) || [];
    } catch {
      return;
    }
    for (const tab of tabs) {
      if (typeof tab.id === 'number') await syncTab(tab.id, tab.url || '');
    }
  }

  /* --------------------------------------------------------------- the interception */

  /* ---------------------------------------------------------------------- wiring */

  function status(tabId) {
    const held = attached.get(tabId);
    return { tabId, attached: Boolean(held), origin: held ? held.origin : '', since: held ? held.since : 0 };
  }

  let started = false;

  return {
    /** Exposed for the wiring and for tests; every trigger below funnels into these. */
    syncTab,
    syncAll,
    status,
    detach,
    attachedTabs: () => [...attached.keys()],
    counts: () => ({ ...fetching.tally }),

    /**
     * Register the listeners. SYNCHRONOUSLY, before the first await: a service worker
     * that is woken by an event it registered in a previous life must have the listener
     * back on the object before the event loop turns, or the event is delivered to
     * nobody. Everything asynchronous happens after they are on.
     */
    start() {
      if (started || !debug()) return Promise.resolve();
      started = true;

      debug().onEvent.addListener((source, method, params) => {
        if (!source || typeof source.tabId !== 'number') return;
        if (method !== 'Fetch.requestPaused') return;
        try {
          fetching.onPaused(source.tabId, params || {});
        } catch (err) {
          console.error('[MockLab] deep mode event failed', err);
        }
      });

      debug().onDetach.addListener((source, reason) => {
        const tabId = source && source.tabId;
        if (typeof tabId !== 'number') return;
        const held = attached.get(tabId);
        // A detach WE asked for has already dropped this tab from `attached` (see
        // `release`), so `held` is empty and there is nothing to do. Anything else —
        // Cancel on Chrome's bar, DevTools taking the target, a crashed renderer — means
        // deep mode is not happening, so the setting stops saying that it is.
        //
        // KNOWN LIMIT, stated rather than engineered around: an `onDetach` for a session
        // this engine closed, delivered LATE — after the same tab has been attached again
        // for another deep-mode origin — reads as a loss and switches that origin off.
        // The person sees the checkbox unticked and can tick it again; deep mode never
        // claims to be running when it is not, which is the direction that matters.
        if (!held) return;
        attached.delete(tabId);
        keepalive(attached.size > 0);
        void standDown(held.origin, tabId, reason === 'target_closed' ? LET_GO.TAB_GONE : LET_GO.TAKEN);
      });

      if (api.tabs && api.tabs.onUpdated) {
        api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
          if (!changeInfo || !changeInfo.url) return;
          void syncTab(tabId, changeInfo.url || (tab && tab.url) || '');
        });
      }
      if (api.tabs && api.tabs.onRemoved) {
        api.tabs.onRemoved.addListener((tabId) => {
          attached.delete(tabId);
          keepalive(attached.size > 0);
        });
      }
      if (api.storage && api.storage.onChanged) {
        api.storage.onChanged.addListener((changes, area) => {
          if (area === 'local' && changes && changes.settings) void syncAll();
        });
      }
      if (api.alarms && api.alarms.onAlarm) {
        // The alarm's only job is to have woken the worker. Re-reading the world while
        // it is awake is free and repairs any drift the sleep introduced.
        api.alarms.onAlarm.addListener((alarm) => {
          if (alarm && alarm.name === KEEPALIVE_ALARM && attached.size) void syncAll();
        });
      }

      return resume();
    }
  };

  /**
   * What a cold worker does: let go of everything first, then re-attach from the
   * settings. The worker may have been evicted while attached — the attachment outlives
   * it, this map does not — so anything still held is held by nobody, and detaching also
   * releases any navigation left paused with no listener to answer it.
   */
  async function resume() {
    try {
      const targets = (await debug().getTargets()) || [];
      for (const target of targets) {
        if (!target || target.type !== 'page' || !target.attached || typeof target.tabId !== 'number') continue;
        // A target attached to DevTools or to another extension refuses this, which is
        // the answer we wanted: there is no way to ask "is it mine" before trying.
        await release(target.tabId);
      }
    } catch (err) {
      console.warn('[MockLab] deep mode could not survey debugger targets', err);
    }
    attached.clear();
    keepalive(false);
    await syncAll();
  }
}
