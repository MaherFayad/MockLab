/**
 * The fifteen operations behind PLAN.md §12.4's MCP tools, on the extension's side.
 *
 * OWNER: mcp-engineer. Split out of `wsClient.js` under §17.10, at the same seam the
 * companion has on the other end of the socket (`hub.js` carries the transport,
 * `tools.js` carries the tools): everything here is about WHAT MockLab does when an
 * agent asks, and nothing here knows there is a WebSocket. That is why the split is this
 * one and not an arithmetic half — every function below can be called with a fake
 * dispatch and no socket at all, which is how `wsClient.test.js` drives them.
 *
 * ── The one rule this file is built around (§1.6) ───────────────────────────────────
 * "Every action in the panel has an MCP tool equivalent. The rule store is shared."
 * The way that is kept true is that an agent's call goes through the SAME handler the
 * panel's message goes through: `deps.dispatch` is the service worker's own message
 * router, and every op below that has a panel equivalent is one line that hands it a
 * `messages.js` constant. Nothing here reads or writes `chrome.storage` behind that
 * contract, and nothing here decides anything the panel would not decide the same way.
 *
 * Four ops have no panel equivalent and so cannot be a dispatch: `list_tabs` (Chrome's
 * own tab list), `screenshot` (a Chrome capture), `search_value` (§6.3's engine exposed
 * raw, which no screen does) and `reload`'s settle wait. Each is written against the
 * same modules the panel's handlers use, and each says below why it is not a message.
 *
 * ── §17.4 / §17.12 ─────────────────────────────────────────────────────────────────
 * Bindings are passed through as STORED. This file never produces a link state, never
 * upgrades one, and never infers one from the fact that a call succeeded. `get_bindings`
 * adds one observation — whether the source behind a link came back on this page load —
 * as a separate field, because that is the evidence the panel draws its stale chip from
 * (§1.1) and an agent must be able to see the same thing. It is evidence, reported as
 * evidence, beside the state rather than inside it.
 */

import { MSG, PROBE_MSG, PROBE_PHASE, PROBE_FAIL, CONTENT_GLOBALS } from './messages.js';
import { getSettings, originOf, countActiveChanges } from './ruleStore.js';
import { searchValue } from './candidates.js';
import { overlaysFor } from './effectiveBody.js';
import { friendlyName } from './signatures.js';
// §17.6: MockLab's words live in one file. An MCP client reads these sentences exactly
// as a person reads them on the panel, so they are looked up, never rewritten.
import { S } from '../panel/strings.js';

/** How often a running probe is re-read for §12.4 #5's progress notifications. */
export const PROBE_POLL_MS = 400;
/** §12.4 #3: "Bodies > 200 KB: return {truncated:true, topLevelKeys, hint}". */
export const BODY_LIMIT_BYTES = 200 * 1024;
/** §7.3's non-DOM settle conditions, which a worker can observe on its own. */
export const SETTLE = { QUIET_MS: 500, MIN_AFTER_LOAD_MS: 800, CAP_MS: 15000 };

/** An answer that failed, with the §11 sentence for it when §11 wrote one. */
const no = (reason, message) => (message ? { ok: false, reason, message } : { ok: false, reason });

/**
 * MockLab itself threw. Kept here, beside the ops, so the transport half does not have
 * to import the copy table to describe a defect of ours — and so this sentence is the
 * SAME one the panel shows for the same thing (§11 `errors.pageBroke`, §17.6).
 */
export const INTERNAL_FAILURE = Object.freeze(no('internal', S.errors.pageBroke));

/** The §11 sentence for a probe failure, or none — §11 did not write one for all of them. */
export function probeMessage(reason) {
  switch (reason) {
    case PROBE_FAIL.TOO_NOISY: return S.probe.tooNoisy;
    case PROBE_FAIL.NONE_CONFIRMED: return S.probe.noneConfirmed;
    case PROBE_FAIL.ELEMENT_LOST: return S.probe.elementLost;
    case PROBE_FAIL.NOT_REFETCHED: return S.probe.notRefetched;
    case PROBE_FAIL.TIMEOUT: return S.probe.timeout;
    case PROBE_FAIL.NO_CANDIDATES: return S.pick.noCandidates;
    case PROBE_FAIL.INTERNAL: return S.errors.pageBroke;
    default: return '';
  }
}

/**
 * Runs IN THE PAGE (ISOLATED world, via chrome.scripting), so it is serialized and has
 * no closure: everything it needs arrives as an argument, including the name of the
 * content-script contract it calls (§17.8 — the literal lives in `messages.js`).
 *
 * §6.1's smart target walk is applied to whatever is matched, so an agent that names the
 * inner `<span>` of a status pill probes the same element a person's click would select.
 * Without it, `probe_element` and the human picker would disagree about what "that
 * element" means, and §1.6 asks for parity, not for a second behaviour.
 *
 * EXPORTED, and not because anything else calls it. `guards.contract.test.js` audits
 * every call on a content-script contract against the methods that contract really
 * publishes — and it cannot see this one, because the receiver arrives as an argument
 * and this file never names the global. That is a real hole: `api.smartTraget(node)`
 * would return undefined inside the try/catch and `probe_element` would quietly answer
 * "element-not-found" for every element on every page. So the same audit is done for
 * this function in `wsClient.test.js`, by reading the method names back out of this
 * source and checking them against `element.js` — and `mcp.browser.test.js` runs it
 * against the real contract in a real page.
 */
export function findTargetInPage(globalName, selector, text) {
  try {
    var api = globalThis[globalName];
    if (!api) return { ok: false, reason: 'no-content-script' };
    var node = null;
    if (selector) {
      node = document.querySelector(selector);
    } else {
      var wanted = api.normText(String(text));
      var best = null;
      var all = document.body ? document.body.querySelectorAll('*') : [];
      for (var i = 0; i < all.length; i += 1) {
        if (api.normText(api.textOf(all[i])) !== wanted) continue;
        // The SMALLEST element with exactly this text: a parent that contains only this
        // child has the same text, and the child is the element the text belongs to.
        if (!best || best.contains(all[i])) best = all[i];
      }
      node = best;
    }
    if (!node) return { ok: false, reason: 'element-not-found' };
    var target = api.smartTarget(node);
    return { ok: true, fingerprint: api.fingerprint(target), snapshot: api.snapshotElement(target) };
  } catch (err) {
    return { ok: false, reason: 'error' };
  }
}

/**
 * @param {{
 *   dispatch: (message:{type:string, payload:any}) => Promise<any>,
 *   portsFor: (tabId:number) => Set<any>|null,
 *   tabRecord: (tabId:number) => {origin:string, sources:Map<string,any>}|null,
 *   onPicked: (tabId:number, picked:any) => Promise<void>|void,
 *   chrome?: any
 * }} deps
 * @returns {Record<string, (payload:any, progress:(update:any)=>void) => Promise<any>>}
 */
export function createOps(deps) {
  const api = deps.chrome || globalThis.chrome;

  /* ─────────────────────────────────────────────────────── talking to the worker */

  const ask = (type, payload) => deps.dispatch({ type, payload });

  /**
   * A worker answer, or the honest "that half is not built yet".
   *
   * The router returns `undefined` for a message type nothing handles — which is exactly
   * what M5's preset and highlight types do today, because their panel half shipped and
   * their worker half did not. An agent must be told that, in the words the panel uses
   * for the same situation, rather than being handed an empty result that reads like
   * "this site has no scenarios" (§1.1).
   */
  async function relay(type, payload) {
    const answer = await ask(type, payload);
    if (answer === undefined || answer === null) return no('not-wired', S.notYet);
    return answer;
  }

  /* ───────────────────────────────────────────────────────────────── the fifteen */

  /** Everything this tab captured, in the shape §6.3 searches — the pick path's shape. */
  async function searchableSources(tabId) {
    const record = deps.tabRecord(tabId);
    if (!record) return [];
    const overlays = await overlaysFor(record.origin || '');
    return [...record.sources.values()]
      .sort((a, b) => b.ts - a.ts)
      .map((captured) => ({
        sigId: captured.sigId,
        name: friendlyName(captured.signature),
        body: captured.body,
        ts: captured.ts,
        changes: overlays.get(captured.sigId) || null
      }));
  }

  /** §12.4 #1. Chrome's tab list, narrowed to the tabs MockLab actually has a page in. */
  async function listTabs() {
    const [tabs, settings] = await Promise.all([api.tabs.query({}), getSettings()]);
    const deep = new Set(settings.deepModeOrigins || []);
    const out = [];
    for (const tab of tabs) {
      const ports = deps.portsFor(tab.id);
      if (!ports || !ports.size) continue;
      const origin = originOf(tab.url || '');
      out.push({
        tabId: tab.id,
        url: tab.url || '',
        title: tab.title || '',
        origin,
        active: Boolean(tab.active),
        changesCount: await countActiveChanges(origin),
        deepMode: deep.has(origin)
      });
    }
    return { ok: true, tabs: out };
  }

  /** §12.4 #3's truncation. A body that big is not something to push down a socket. */
  function limitBody(answer) {
    if (!answer || answer.ok !== true || answer.body === undefined) return answer;
    let size = 0;
    try {
      size = JSON.stringify(answer.body).length;
    } catch {
      return answer; // not serializable: let the frame writer refuse it, not this
    }
    if (size <= BODY_LIMIT_BYTES) return answer;
    const body = answer.body;
    return {
      ok: true,
      truncated: true,
      bytes: size,
      limit: BODY_LIMIT_BYTES,
      topLevelKeys: body && typeof body === 'object' ? Object.keys(body).slice(0, 200) : [],
      ...(answer.summary ? { summary: answer.summary } : {})
    };
  }

  /**
   * §12.4 #6. The state comes back exactly as stored (§17.4).
   *
   * `sourceLoadedThisPageLoad` is the panel's first stale test (`panel/links.js`), and
   * it is `null` — not false — when MockLab has captured nothing on this tab. "I have
   * not seen that data" and "that data is gone" look identical from here and only one of
   * them is a finding (§1.1). The second half of the panel's test — whether the elements
   * still resolve — is deliberately NOT computed: the only way to learn it is to run a
   * highlight, and drawing overlays on the user's page as a side effect of a read would
   * be MockLab touching a page nobody asked it to touch.
   */
  async function getBindings(payload) {
    const answer = await relay(MSG.GET_BINDINGS, payload);
    if (!answer || answer.ok !== true) return answer;
    let live = null;
    if (payload.tabId !== undefined || payload.origin === undefined) {
      const sources = await ask(MSG.LIST_SOURCES, { tabId: payload.tabId });
      if (sources && sources.ok && sources.sources && sources.sources.length) {
        live = new Set(sources.sources.map((source) => source.sigId));
      }
    }
    return {
      ...answer,
      bindings: (answer.bindings || []).map((binding) => ({
        ...binding,
        sourceLoadedThisPageLoad: live ? live.has(binding.sigId) : null
      }))
    };
  }

  /** §12.4 #14. Activating first is what makes the capture the tab the caller named. */
  async function screenshot(payload) {
    const tab = await api.tabs.get(payload.tabId);
    if (!tab) return no('no-such-tab');
    await api.tabs.update(payload.tabId, { active: true });
    const dataUrl = await api.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const comma = String(dataUrl).indexOf(',');
    return {
      ok: true,
      tabId: payload.tabId,
      mimeType: 'image/png',
      image: comma === -1 ? '' : String(dataUrl).slice(comma + 1)
    };
  }

  /**
   * §12.4 #15.
   *
   * HONEST LIMIT, and it is why `settled` is reported with the checks beside it: three
   * of §7.3's four conditions are observable from the worker — the tab reaching
   * `complete`, no capture for 500 ms, and 800 ms since load. The fourth (two animation
   * frames with no DOM mutation) lives in the page agent, and the worker has no message
   * that asks for it outside a probe. So this waits for the three, reports each, and
   * reports `settled:false` — MockLab did not observe the definition it uses during a
   * probe, and saying otherwise would be a claim about a page it did not watch.
   */
  async function reload(payload) {
    const refreshed = await relay(MSG.REFRESH_TAB, { tabId: payload.tabId });
    if (!refreshed || refreshed.ok !== true) return refreshed;
    const checks = { loaded: false, networkQuiet: false, minDelay: false, domQuiet: false };
    if (payload.waitForSettle === false) return { ok: true, reloaded: true, settled: false, checks };

    const started = Date.now();
    let loadedAt = 0;
    while (Date.now() - started < SETTLE.CAP_MS) {
      const tab = await api.tabs.get(payload.tabId).catch(() => null);
      if (tab && tab.status === 'complete') {
        if (!loadedAt) loadedAt = Date.now();
        checks.loaded = true;
        const record = deps.tabRecord(payload.tabId);
        const lastCapture = record
          ? [...record.sources.values()].reduce((max, source) => Math.max(max, source.ts || 0), 0)
          : 0;
        checks.networkQuiet = Date.now() - lastCapture > SETTLE.QUIET_MS;
        checks.minDelay = Date.now() - loadedAt >= SETTLE.MIN_AFTER_LOAD_MS;
        if (checks.networkQuiet && checks.minDelay) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { ok: true, reloaded: true, settled: false, checks, waitedMs: Date.now() - started };
  }

  /**
   * §12.4 #5 — the only tool that can end in a proved link, and the only one that needs
   * the page to be asked something the panel asks with a click.
   *
   * The element is found in the page and handed to the SAME `pickApi.onPicked` a human
   * pick lands in, and then the SAME probe runs. Two code paths that both ended in a
   * verified Binding would be two chances to write one wrongly (§17.12); there is one.
   */
  async function probeElement(payload, progress) {
    const [found] = await api.scripting.executeScript({
      target: { tabId: payload.tabId },
      args: [CONTENT_GLOBALS.element, payload.selector || '', payload.text || ''],
      func: findTargetInPage
    });
    const picked = found && found.result;
    if (!picked || picked.ok !== true) {
      const reason = (picked && picked.reason) || 'element-not-found';
      return no(reason, reason === PROBE_FAIL.NO_CONTENT_SCRIPT ? S.errors.pageBroke : '');
    }

    await deps.onPicked(payload.tabId, picked);
    const started = await ask(PROBE_MSG.START_PROBE, { tabId: payload.tabId });
    if (!started || started.ok !== true) {
      const reason = (started && started.reason) || PROBE_FAIL.INTERNAL;
      return no(reason, probeMessage(reason));
    }

    let last = '';
    for (;;) {
      const view = await ask(PROBE_MSG.GET_PROBE, { tabId: payload.tabId });
      if (!view || view.ok !== true) return no(PROBE_FAIL.INTERNAL, S.errors.pageBroke);
      if (view.phase === PROBE_PHASE.RUNNING) {
        const key = `${view.state}:${view.reload ? view.reload.index : 0}`;
        if (key !== last) {
          last = key;
          progress({
            progress: (view.reload && view.reload.index) || 0,
            total: (view.reload && view.reload.estimate) || 0,
            message: stepSentence(view)
          });
        }
        await new Promise((resolve) => setTimeout(resolve, PROBE_POLL_MS));
        continue;
      }
      if (view.phase === PROBE_PHASE.DONE) {
        return {
          ok: true,
          binding: view.binding,
          bindings: view.bindings,
          elements: (view.binding && view.binding.elements) || [],
          observedValues: (view.binding && view.binding.observedValues) || [],
          affected: view.affected,
          reloads: view.reload ? view.reload.index : 0
        };
      }
      const reason = view.failure || PROBE_FAIL.INTERNAL;
      return no(reason, probeMessage(reason));
    }
  }

  /** §11's progress line for the state the probe is in — the panel's own sentence. */
  function stepSentence(view) {
    const step = S.probe.step[view.step];
    if (typeof step === 'function') return step(view.testing || 0);
    return step || '';
  }

  /** op -> what it does. The name is §12.4's tool name; there is one vocabulary. */
  const OPS = {
    list_tabs: () => listTabs(),
    list_sources: (payload) => relay(MSG.LIST_SOURCES, payload),
    get_response: async (payload) => limitBody(await relay(MSG.GET_RESPONSE, payload)),
    search_value: async (payload) => ({
      ok: true,
      candidates: searchValue(payload.needle, await searchableSources(payload.tabId))
    }),
    probe_element: (payload, progress) => probeElement(payload, progress),
    get_bindings: (payload) => getBindings(payload),
    set_value: (payload) => relay(MSG.SET_VALUE, payload),
    clear_changes: (payload) =>
      payload.changeId
        ? relay(MSG.DELETE_CHANGE, payload)
        : relay(MSG.RESET_SITE, payload),
    highlight: (payload) => relay(MSG.HIGHLIGHT, payload),
    list_presets: (payload) => relay(MSG.LIST_PRESETS, payload),
    apply_preset: (payload) => relay(MSG.APPLY_PRESET, payload),
    save_preset: (payload) => relay(MSG.SAVE_PRESET, payload),
    delete_preset: (payload) => relay(MSG.DELETE_PRESET, payload),
    screenshot: (payload) => screenshot(payload),
    reload: (payload) => reload(payload)
  };

  return OPS;
}
