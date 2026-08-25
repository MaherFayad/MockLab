/**
 * M3 — pick mode's message surface in the service worker (PLAN.md §6.1, §6.3, §10.1).
 *
 * OWNER: probe-engineer.
 *
 * The panel asks for a pick, the worker tells the page's agent to enter pick mode, the
 * agent answers with one element, and this file turns that element into §6.3's ranked
 * list of possible sources. Split out of `background.js` under §17.10, the same way
 * `changesApi.js` was: the worker keeps the wiring, this module keeps the behaviour.
 *
 * §0.2 and §17.4 govern everything here. A candidate is a GUESS — a value match with
 * false positives — so this file writes no Binding, persists nothing, and assigns no
 * link state. Only the §7 probe may turn one of these into a proven link, and only M4
 * may write that word.
 */

import { MSG, PORT_MSG, PHASE } from './messages.js';
import { findCandidates } from './candidates.js';
import { friendlyName } from './signatures.js';

/** Every message type this module answers. background.js routes on this set. */
export const PICK_MESSAGE_TYPES = new Set([
  MSG.START_PICK,
  MSG.CANCEL_PICK,
  MSG.GET_PICK
]);

/**
 * @param {{
 *   resolveTabId: (requested:any) => Promise<number|null>,
 *   portsFor: (tabId:number) => Set<any>|null,
 *   tabRecord: (tabId:number) => {origin:string, sources:Map<string,any>}|null,
 *   notify: (tabId:number, phase:string) => void
 * }} deps
 */
export function createPickApi(deps) {
  const originOf = (tabId) => (deps.tabRecord(tabId) || {}).origin || '';

  /**
   * Everything this tab has captured, newest first, in the shape §6.3 searches.
   * Re-read on every pick rather than cached: a pick is one user click, and a stale
   * source list would answer with a field the page is no longer loading.
   */
  function capturedSources(tabId) {
    const record = deps.tabRecord(tabId);
    if (!record) return [];
    return [...record.sources.values()]
      .sort((a, b) => b.ts - a.ts)
      .map((captured) => ({
        sigId: captured.sigId,
        name: friendlyName(captured.signature),
        body: captured.body,
        ts: captured.ts
      }));
  }

  /** True only when a live Port actually took the message. */
  function sendToTab(tabId, type, payload) {
    const ports = deps.portsFor(tabId);
    if (!ports || !ports.size) return false;
    let delivered = false;
    for (const port of ports) {
      try {
        port.postMessage({ type, payload });
        delivered = true;
      } catch {
        /* the port died between the check and the send */
      }
    }
    return delivered;
  }

  /**
   * @typedef {Object} PickRecord
   * @property {string} phase
   * @property {string} origin
   * @property {any} element      the §7.3 snapshot of what the user clicked, or null
   * @property {any} fingerprint  §6.2, kept for M4's probe — never sent to the panel
   * @property {any[]} candidates §6.3's ranked guesses
   * @property {{sources:number, bounded:number, complete:boolean}} searched how much of
   *   this tab's data the search actually reached (§6.3)
   * @property {number} pickedAt
   * @property {string} [reason]  why a pick ended without a selection
   */

  /** @type {Map<number, PickRecord>} */
  const byTab = new Map();

  const blank = (origin) => ({
    phase: PHASE.IDLE,
    origin: origin || '',
    element: null,
    fingerprint: null,
    candidates: [],
    searched: { sources: 0, bounded: 0, complete: true },
    pickedAt: 0
  });

  function recordFor(tabId) {
    let record = byTab.get(tabId);
    if (!record) {
      record = blank(originOf(tabId));
      byTab.set(tabId, record);
    }
    return record;
  }

  /**
   * What the panel renders (§10.1C): the element the user clicked and the guesses.
   * `fingerprint` stays in the worker — it is a CSS selector and a tree path, which is
   * §10.2's "advanced detail" of no use to the Pick tab and every use to M4's probe.
   */
  function view(tabId, record) {
    return {
      ok: true,
      tabId,
      origin: record.origin,
      phase: record.phase,
      element: record.element ? { ...record.element, label: labelOf(record.element) } : null,
      candidates: record.candidates,
      // §1.1: an empty list is only "nothing is there" when the search reached
      // everywhere. When it did not, the panel must say a different sentence.
      searched: record.searched,
      pickedAt: record.pickedAt,
      ...(record.reason ? { reason: record.reason } : {})
    };
  }

  /**
   * The picked element in one line, for the mini card in §10.1C. Text first, then the
   * accessible name, then the tag — an icon-only button has no text but does have a
   * label, and showing a bare tag name for it would tell the user nothing.
   */
  function labelOf(snapshot) {
    const attrs = (snapshot && snapshot.attrs) || {};
    return (
      String(snapshot.text || '').trim() ||
      String(attrs['aria-label'] || attrs.title || attrs.alt || '').trim() ||
      String(snapshot.tag || '')
    );
  }

  /**
   * The agent answered a PICK_START. Called by background.js from the Port handler.
   *
   * @param {number} tabId
   * @param {{ok?:boolean, reason?:string, fingerprint?:any, snapshot?:any}} payload
   */
  function onPicked(tabId, payload) {
    const record = recordFor(tabId);
    record.origin = originOf(tabId) || record.origin;

    if (!payload || payload.ok !== true || !payload.snapshot) {
      record.phase = PHASE.IDLE;
      record.element = null;
      record.fingerprint = null;
      record.candidates = [];
      record.searched = { sources: 0, bounded: 0, complete: true };
      record.reason = (payload && payload.reason) || 'cancelled';
      deps.notify(tabId, record.phase);
      return;
    }

    const sources = capturedSources(tabId);
    const { candidates, searched } = findCandidates(payload.snapshot, sources);
    record.phase = PHASE.PICKED;
    record.element = payload.snapshot;
    record.fingerprint = payload.fingerprint || null;
    record.candidates = candidates;
    record.searched = searched;
    record.pickedAt = Date.now();
    delete record.reason;
    deps.notify(tabId, record.phase);
  }

  /**
   * A new document loaded in this tab. The worker has just cleared that tab's captured
   * responses, so every candidate now points at a source this page load has not seen —
   * keeping them on screen would be the panel showing the previous page's answer.
   */
  function onNewDocument(tabId) {
    const record = byTab.get(tabId);
    if (!record) return;
    const wasBusy = record.phase !== PHASE.IDLE;
    byTab.set(tabId, blank(originOf(tabId)));
    if (wasBusy) deps.notify(tabId, PHASE.IDLE);
  }

  function forgetTab(tabId) {
    byTab.delete(tabId);
  }

  /** M4's probe reads the picked element back out of here. */
  function pickedElement(tabId) {
    const record = byTab.get(tabId);
    if (!record || record.phase !== PHASE.PICKED) return null;
    return { fingerprint: record.fingerprint, snapshot: record.element, candidates: record.candidates };
  }

  async function handle(message) {
    const payload = (message && message.payload) || {};
    const tabId = await deps.resolveTabId(payload.tabId);
    if (tabId === null) return { ok: false, reason: 'no-tab' };
    const record = recordFor(tabId);

    switch (message.type) {
      case MSG.START_PICK: {
        // A tab MockLab has no agent in (a chrome:// page, or one opened before the
        // extension was installed) can never answer. Say so now rather than leaving
        // the panel on "Click something on the page…" for ever (§1.1).
        if (!sendToTab(tabId, PORT_MSG.PICK_START, {})) {
          return { ok: false, reason: 'no-content-script' };
        }
        record.origin = originOf(tabId) || record.origin;
        record.phase = PHASE.PICKING;
        record.element = null;
        record.fingerprint = null;
        record.candidates = [];
        record.searched = { sources: 0, bounded: 0, complete: true };
        delete record.reason;
        deps.notify(tabId, record.phase);
        return { ok: true, tabId };
      }

      case MSG.CANCEL_PICK: {
        sendToTab(tabId, PORT_MSG.PICK_CANCEL, {});
        record.phase = PHASE.IDLE;
        record.element = null;
        record.fingerprint = null;
        record.candidates = [];
        record.searched = { sources: 0, bounded: 0, complete: true };
        delete record.reason;
        deps.notify(tabId, record.phase);
        return { ok: true, tabId };
      }

      case MSG.GET_PICK:
        return view(tabId, record);

      default:
        return undefined;
    }
  }

  return { handle, onPicked, onNewDocument, forgetTab, pickedElement };
}
