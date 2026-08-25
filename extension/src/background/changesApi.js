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
import { friendlyName } from './signatures.js';
import { getByPath } from '../shared/jsonpath.js';
import {
  getChanges,
  getChange,
  addChange,
  updateChange,
  deleteChange,
  clearChanges,
  countActiveChanges,
  getSignatures,
  rememberSignature,
  getBindings,
  noteChangedPath,
  getSettings,
  updateSettings
} from './ruleStore.js';

/** @typedef {import('./messages.js').ChangeSummary} ChangeSummary */

/** Every message type this module answers. background.js routes on this set. */
export const CHANGE_MESSAGE_TYPES = new Set([
  MSG.GET_SITE_STATE,
  MSG.LIST_CHANGES,
  MSG.SET_VALUE,
  MSG.UPDATE_CHANGE,
  MSG.TOGGLE_CHANGE,
  MSG.DELETE_CHANGE,
  MSG.RESET_SITE,
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
 *   reload: (tabId:number|null) => Promise<boolean>
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
        sourceName: signature ? friendlyName(signature) : 'Data',
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

      default:
        return undefined;
    }
  }

  return { handle };
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
