/**
 * M2 — the Changes engine's message surface (PLAN.md §1.5, §10.1D, §10.2, §12.4).
 *
 * OWNER: interceptor-engineer.
 *
 * Every handler here answers one `MSG.*` constant from `messages.js`, which is the
 * contract the side panel and (from M6) the MCP tools are written against. Two rules
 * shape all of them:
 *
 *   §17.4 — nothing in this file may put a Binding into the verified state. A Change
 *           created from the tree view is APPLIED, but nothing has been proved about
 *           what it renders, so its link stays `candidate` and the panel says so.
 *   §1.1  — the answer describes what actually happened. `refreshed` is false when no
 *           tab was reloaded, and `applies` is false when MockLab has never seen the
 *           request the Change targets, so it cannot take effect yet.
 *
 * Split out of `background.js` under §17.10 (keep files under ~500 lines); the worker
 * keeps the wiring, this module keeps the behaviour.
 */

import { MSG } from './messages.js';
import { createPresetsApi, PRESET_MESSAGE_TYPES } from './presets.js';
import { createHighlightApi, HIGHLIGHT_MESSAGE_TYPES } from './highlight.js';
import { friendlyName } from './signatures.js';
import { getByPath } from '../shared/jsonpath.js';
// §17.6: `sourceName` is read by a human (the source card heading, §10.2) and by an AI
// agent (`ChangeSummary.sourceName`, §12.4), so its fallback word is translated in one
// file like every other. `strings.js` is data-only and read-only here — see the note at
// the top of signatures.js for why a worker module may import it.
import { S } from '../panel/strings.js';
import {
  getChanges,
  getChange,
  addChange,
  updateChange,
  deleteChange,
  clearChanges,
  resetEverything,
  countActiveChanges,
  getSignatures,
  rememberSignature,
  getBindings,
  noteChangedPath,
  getSettings,
  updateSettings
} from './ruleStore.js';

/** @typedef {import('./messages.js').ChangeSummary} ChangeSummary */

/**
 * Every message type this module answers, and — since M6's gap-closing — every type the
 * two modules it composes answer: M5's six Scenario types (`presets.js`) and §10.3's
 * highlight (`highlight.js`).
 *
 * They hang off this set rather than off two more `if` clauses in `routeMessage` because
 * `background.js` belongs to another agent this milestone and the two callers that
 * matter both go through this set: the panel's `onMessage` listener AND, since M6, the
 * MCP bridge, which is handed the same router (`wsClient` -> `routeMessage`). One set,
 * one handler per action, §1.6's parity kept structurally rather than promised.
 *
 * The NAME is now narrower than the contents. Renaming it to something like
 * `WORKER_MESSAGE_TYPES` means editing `background.js`, which is why it has not happened
 * here; it is owed, and written down rather than left to be noticed.
 */
export const CHANGE_MESSAGE_TYPES = new Set([
  ...PRESET_MESSAGE_TYPES,
  ...HIGHLIGHT_MESSAGE_TYPES,
  MSG.GET_SITE_STATE,
  MSG.LIST_CHANGES,
  MSG.SET_VALUE,
  MSG.UPDATE_CHANGE,
  MSG.TOGGLE_CHANGE,
  MSG.DELETE_CHANGE,
  MSG.RESET_SITE,
  MSG.RESET_ALL,
  MSG.REFRESH_TAB,
  MSG.GET_BINDINGS,
  MSG.GET_SETTINGS,
  MSG.UPDATE_SETTINGS
]);

/**
 * @param {{
 *   resolveTabId: (requested:any) => Promise<number|null>,
 *   tabInfo: (tabId:number|null) => Promise<{url:string, origin:string, faviconUrl:string, captured:boolean}>,
 *   capturedRecord: (tabId:number|null, sigId:string) => any,
 *   reload: (tabId:number|null) => Promise<boolean>,
 *   repaintAllBadges: () => Promise<void>
 * }} deps
 */
export function createChangesApi(deps) {
  /**
   * Decorate stored Changes with the three facts only the worker knows: the friendly
   * source name, whether the Change can actually compile into a match list, and the
   * state of the link — which is never verified here (§17.4).
   *
   * @param {string} origin
   * @param {import('./messages.js').Change[]} changes
   * @returns {Promise<ChangeSummary[]>}
   */
  async function summarize(origin, changes) {
    const [signatures, bindings] = await Promise.all([getSignatures(origin), getBindings(origin)]);
    return changes.map((change) => {
      const signature = signatures[change.sigId];
      const binding = bindings.find((b) => b && b.sigId === change.sigId && b.path === change.path);
      return {
        ...change,
        sourceName: signature ? friendlyName(signature) : S.sources.fallbackName,
        linkState: binding ? binding.state : null,
        applies: Boolean(signature)
      };
    });
  }

  /** Newest first, exactly as the panel lists them. */
  async function listFor(origin) {
    const changes = (await getChanges(origin)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return summarize(origin, changes);
  }

  /**
   * Resolve which site a message is about. An explicit `origin` wins (the Scenarios tab
   * reads a site it is not looking at); otherwise the tab's own URL decides.
   * @returns {Promise<{tabId:number|null, origin:string, info:any}>}
   */
  async function target(payload) {
    const tabId = await deps.resolveTabId(payload.tabId);
    const info = await deps.tabInfo(tabId);
    const origin = typeof payload.origin === 'string' && payload.origin ? payload.origin : info.origin;
    return { tabId, origin, info };
  }

  /** §12.4: every mutation defaults `refresh:true`, and reports what really happened. */
  async function maybeReload(tabId, payload) {
    if (payload.refresh === false) return false;
    return deps.reload(tabId);
  }

  /** One shared shape for every mutation's answer. */
  async function mutated(origin, tabId, payload, extra) {
    const refreshed = await maybeReload(tabId, payload);
    return { ok: true, origin, refreshed, changeCount: await countActiveChanges(origin), ...extra };
  }

  /**
   * M5's Scenarios (§10.4) and §10.3's highlight, composed here so `background.js` — this
   * milestone another agent's file — needs no line for either. See CHANGE_MESSAGE_TYPES.
   *
   * Both get `target` rather than reimplementing it: the Scenarios tab reads a site the
   * tab is not on (§10.4), and a highlight is always about the tab in front of the
   * person, and one function deciding which is which is what keeps them agreeing.
   */
  const presetsApi = createPresetsApi({ target, reload: maybeReload, notify: announcePresets });
  const highlightApi = createHighlightApi({ target, capturedRecord: deps.capturedRecord });

  /**
   * @param {{type:string, payload?:any}} message
   * @returns {Promise<any>}
   */
  async function handle(message) {
    const payload = (message && message.payload) || {};

    switch (message.type) {
      case MSG.GET_SITE_STATE: {
        const { tabId, origin, info } = await target(payload);
        const changes = await listFor(origin);
        return {
          ok: true,
          tabId,
          url: info.url,
          origin,
          hostname: hostnameOf(info.url),
          faviconUrl: info.faviconUrl,
          captured: info.captured,
          changeCount: await countActiveChanges(origin),
          changes
        };
      }

      case MSG.LIST_CHANGES: {
        const { origin } = await target(payload);
        return { ok: true, origin, changes: await listFor(origin), changeCount: await countActiveChanges(origin) };
      }

      case MSG.SET_VALUE: {
        const { tabId, origin, info } = await target(payload);
        if (!origin) return { ok: false, reason: 'no-origin' };
        if (typeof payload.sigId !== 'string' || typeof payload.path !== 'string') {
          return { ok: false, reason: 'bad-request' };
        }

        // The REAL value, read from the captured body — never from a previous Change,
        // so "Real value: …" (§11 editor.original) cannot drift into a mock.
        const record = deps.capturedRecord(tabId, payload.sigId);
        const realValue = record ? getByPath(record.body, payload.path) : undefined;

        // Belt and braces: a Change is useless without a remembered signature, and the
        // capture path is the only other place that stores one. Re-storing it here is a
        // no-op when nothing moved and costs one storage read.
        if (record && record.signature) await rememberSignature(origin, record.signature);

        const existing = (await getChanges(origin)).find(
          (c) => c && c.sigId === payload.sigId && c.path === payload.path && c.probe !== true
        );

        const change = await addChange({
          origin,
          sigId: payload.sigId,
          path: payload.path,
          value: payload.value,
          // Keep the first real value ever seen. A later edit must not overwrite it with
          // whatever the page is showing now, which may itself be mocked.
          originalValue: existing && existing.originalValue !== undefined ? existing.originalValue : realValue,
          enabled: payload.enabled !== false,
          ...(payload.note ? { note: payload.note } : {})
        });

        // §10.2: applied, but NOT proved. `noteChangedPath` only ever writes
        // "candidate" and never touches the state of a binding that already exists.
        await noteChangedPath(origin, payload.sigId, payload.path, realValue);

        const [summary] = await summarize(origin, [change]);
        return mutated(origin, tabId, payload, { change: summary, captured: Boolean(record), url: info.url });
      }

      case MSG.UPDATE_CHANGE: {
        const { tabId, origin } = await target(payload);
        /** @type {any} */
        const patch = {};
        if ('value' in payload) patch.value = payload.value;
        if ('note' in payload) patch.note = payload.note;
        if ('enabled' in payload) patch.enabled = payload.enabled !== false;
        const change = await updateChange(origin, payload.changeId, patch);
        if (!change) return { ok: false, reason: 'no-such-change' };
        const [summary] = await summarize(origin, [change]);
        return mutated(origin, tabId, payload, { change: summary });
      }

      case MSG.TOGGLE_CHANGE: {
        const { tabId, origin } = await target(payload);
        const current = await getChange(origin, payload.changeId);
        if (!current) return { ok: false, reason: 'no-such-change' };
        const enabled = 'enabled' in payload ? payload.enabled !== false : current.enabled === false;
        const change = await updateChange(origin, payload.changeId, { enabled });
        const [summary] = await summarize(origin, [change]);
        return mutated(origin, tabId, payload, { change: summary });
      }

      case MSG.DELETE_CHANGE: {
        const { tabId, origin } = await target(payload);
        const deleted = await deleteChange(origin, payload.changeId);
        if (!deleted) return { ok: false, reason: 'no-such-change' };
        return mutated(origin, tabId, payload, { deleted });
      }

      case MSG.RESET_SITE: {
        const { tabId, origin } = await target(payload);
        if (!origin) return { ok: false, reason: 'no-origin' };
        // §1.5 "removes every active Change for the current site": everything goes —
        // disabled ones and probe scaffolding included. Bindings are knowledge, not
        // modification, so they stay; nothing about the page is changed by them.
        const cleared = await clearChanges(origin);
        return mutated(origin, tabId, payload, { cleared });
      }

      case MSG.RESET_ALL: {
        // §10.5 danger zone, "Reset everything". Scoped wider than RESET_SITE and
        // nothing else: settings and the derived signature cache survive (see
        // resetEverything). Exposed as a message rather than left to the panel poking
        // at storage, so an MCP agent can do it too (§1.6).
        const cleared = await resetEverything();
        // The storage listener repaints the origins it sees change; this covers a tab
        // whose site had only Scenarios or Links, and costs one tabs.query.
        await deps.repaintAllBadges();
        const tabId = await deps.resolveTabId(payload.tabId);
        return { ok: true, cleared, refreshed: await maybeReload(tabId, payload) };
      }

      case MSG.REFRESH_TAB: {
        const tabId = await deps.resolveTabId(payload.tabId);
        return { ok: true, refreshed: await deps.reload(tabId) };
      }

      case MSG.GET_BINDINGS: {
        const { origin } = await target(payload);
        return { ok: true, origin, bindings: await getBindings(origin) };
      }

      case MSG.GET_SETTINGS:
        return { ok: true, settings: await getSettings() };

      case MSG.UPDATE_SETTINGS:
        return { ok: true, settings: await updateSettings(payload.patch || {}) };

      default: {
        if (PRESET_MESSAGE_TYPES.has(message.type)) return presetsApi.handle(message);
        if (HIGHLIGHT_MESSAGE_TYPES.has(message.type)) return highlightApi.handle(message);
        return undefined;
      }
    }
  }

  return { handle };
}

/**
 * "A Scenario was saved, renamed, imported, deleted or applied" — data-free, exactly
 * like `background.js`'s three other panel broadcasts and for the same reason: the panel
 * re-reads `LIST_PRESETS`, so the event cannot go stale.
 *
 * It reaches for `chrome` directly rather than through an injected dep because the four
 * deps this module takes are the ones a unit test has to fake to drive BEHAVIOUR, and a
 * broadcast is not behaviour — nobody listening is the normal case (no panel open), and
 * `chrome.runtime` is absent entirely under `node --test`. Both are non-events here and
 * neither may throw into a handler that has already written to storage.
 *
 * @param {string} origin
 */
function announcePresets(origin) {
  try {
    const api = globalThis.chrome;
    if (!api || !api.runtime || typeof api.runtime.sendMessage !== 'function') return;
    const sent = api.runtime.sendMessage({ type: MSG.PRESETS_CHANGED, payload: { origin } });
    if (sent && typeof sent.catch === 'function') sent.catch(() => {});
  } catch {
    /* no receiver — expected, not an error */
  }
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
