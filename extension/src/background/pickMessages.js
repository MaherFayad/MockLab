/**
 * M3 — the message contract for pick mode (PLAN.md §6.1, §10.1B/C).
 *
 * ⚠ STAGING FILE. Every constant below belongs in `messages.js` beside `MSG` and
 * `PORT_MSG`, and §17.8 wants exactly one home for message types. `messages.js` is
 * owned by another agent and was read-only for this milestone, so the new types live
 * here rather than being invented twice or edited behind its owner's back.
 *
 * TO MERGE (one commit, no behaviour change):
 *   1. move `PICK_MSG`'s entries into `MSG` and `PICK_PORT_MSG`'s into `PORT_MSG`,
 *      keeping the string values byte-for-byte — `agent.js` mirrors them (§17.2) and
 *      `guards.test.js` checks that mirror;
 *   2. repoint the three importers (`background.js`, `pickApi.js`, the Pick tab) at
 *      `messages.js`;
 *   3. delete this file.
 *
 * Until then this is still ONE definition, not a duplicate: nothing re-declares these
 * strings anywhere except agent.js's mirrored block, exactly as `PORT_MSG` already is.
 */

/* ─────────────────────────────────────────── agent.js (ISOLATED) <-> service worker */

export const PICK_PORT_MSG = {
  /**
   * SW -> agent. Enter pick mode (§6.1): crosshair cursor, hover overlay, capture-phase
   * listeners. Payload `{}`. Sending it twice is harmless — the second is ignored.
   */
  PICK_START: 'port:pickStart',

  /** SW -> agent. Leave pick mode and remove every listener and overlay. `{}` */
  PICK_CANCEL: 'port:pickCancel',

  /**
   * agent -> SW. The pick ended.
   *
   * `{ok:true, fingerprint:ElementFingerprint, snapshot:ElementSnapshot}` when the user
   * clicked an element, or `{ok:false, reason:"cancelled"}` when they pressed Escape.
   * A cancel is reported rather than silently dropped: the panel is showing "Click
   * something on the page… (Esc to cancel)" and has to be told to stop.
   */
  PICKED: 'port:picked'
};

/* ─────────────────────────────────────────────────── panel / MCP <-> service worker */

export const PICK_MSG = {
  /**
   * Panel -> SW. "Pick an element" (§10.1A). `{tabId?}` ->
   * `{ok:true, tabId}` | `{ok:false, reason:"no-content-script"}` when MockLab has no
   * live agent in that tab (a chrome:// page, or a tab opened before install) — the
   * panel must say so rather than leaving the button spinning.
   */
  START_PICK: 'msg:startPick',

  /** Panel -> SW. Escape's twin, from the panel side. `{tabId?}` -> `{ok:true}` */
  CANCEL_PICK: 'msg:cancelPick',

  /**
   * Panel -> SW. The whole Pick tab state in one read. `{tabId?}` ->
   * `{ok:true, tabId, origin, phase, element, candidates, searched, pickedAt}`
   *
   * `phase` is "idle" | "picking" | "picked". `element` is the picked element's
   * §7.3 snapshot plus a `label` for the mini card, or null. `candidates` is §6.3's
   * ranked list, `{sigId, sourceName, path, value, score, via, rules}[]`, empty when
   * nothing matched — which the panel renders as `pick.noCandidates` (§11), never as
   * a silent empty list.
   *
   * `searched` is `{sources, bounded, complete}` — how much of this tab's data the
   * search actually reached. A response nests deeper or wider than MockLab enumerates
   * (`candidates.js` MAX_DEPTH / MAX_PATHS) counts in `bounded` and makes `complete`
   * false. It exists because `pick.noCandidates` says "MockLab couldn't find this text
   * in any data the page loaded", which is a claim about the DATA; showing it after a
   * bounded search would state a fact MockLab never established (§1.1). With
   * `complete:false` and no candidates, the panel needs a different sentence — see the
   * note in BUILD_LOG: the string for it is not invented here.
   *
   * Every candidate is a GUESS. §0.2 and §17.4: nothing here is or becomes a link.
   */
  GET_PICK: 'msg:getPick',

  /**
   * SW -> panel broadcast. `{tabId, phase}` — pick mode started, was cancelled, or an
   * element was picked. Data-free beyond the phase, by the same reasoning as
   * `SOURCES_CHANGED` and `CHANGES_CHANGED`: the panel re-reads `GET_PICK`, so the
   * event cannot go stale.
   */
  PICK_CHANGED: 'msg:pickChanged'
};

/**
 * @typedef {Object} ElementSnapshot   PLAN.md §7.3, produced by agent.js
 * @property {string} tag
 * @property {string} text             innerText, trimmed, ≤ 300 chars
 * @property {Record<string,string>} attrs   every attribute except style and class
 * @property {string[]} cls            sorted class list
 * @property {Record<string,string>} style   computed color, backgroundColor,
 *   borderColor, display, visibility, opacity
 * @property {number} childCount
 * @property {string[]} childTexts     first 5 children, ≤ 30 chars each
 */
