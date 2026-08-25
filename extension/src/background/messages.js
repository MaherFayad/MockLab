/**
 * ALL message type constants + JSDoc payload typedefs (PLAN.md §2.1, §4, §17.8).
 *
 * OWNER: interceptor-engineer. Read-only for every other agent — if you need a new
 * message type, request it through the orchestrator.
 *
 * Rule §17.8: all async messaging uses these constants. No magic strings anywhere.
 * The typedefs below are the source of truth for the shapes in PLAN.md §4.
 *
 * ── The one place §17.8 cannot reach ────────────────────────────────────────────
 * `src/content/interceptor.js` runs in the MAIN world and `src/content/agent.js` runs
 * as a classic (non-module) content script. Neither has a module graph, so neither can
 * import this file — see PLAN.md §17.2 and the M0 contract note in BUILD_LOG.md. Both
 * duplicate the handful of literals they need, each marked with a comment pointing
 * back here. If you change a value in the MIRRORED block below, change it in those two
 * files in the same commit. Do NOT "fix" this with an import: it silently kills the
 * MAIN-world patch and the page keeps working, so nothing fails loudly.
 */

/* ─────────────────────────────────────────────────────── data models (PLAN.md §4) */

/**
 * @typedef {Object} RequestSignature
 * @property {string} method
 * @property {string} urlPattern
 * @property {string} [gqlOperation]
 * @property {string} [bodyShape]
 * @property {string} sigId
 */

/**
 * @typedef {Object} CapturedRequest
 * @property {string} sigId
 * @property {RequestSignature} signature
 * @property {string} url
 * @property {number} status
 * @property {string} contentType
 * @property {any} body
 * @property {number} bodyBytes
 * @property {number} ts
 * @property {"fetch"|"xhr"|"document"|"other"} via
 * @property {boolean} mocked
 */

/**
 * @typedef {Object} Change
 * @property {string} id
 * @property {string} origin
 * @property {string} sigId
 * @property {string} path
 * @property {any} value
 * @property {any} originalValue
 * @property {boolean} enabled
 * @property {number} createdAt
 * @property {string} [note]
 * @property {boolean} [probe]
 */

/**
 * @typedef {Object} ElementFingerprint
 * @property {string} css
 * @property {string} textAnchor
 * @property {string[]} attrAnchors
 * @property {number[]} treePath
 */

/**
 * @typedef {Object} Binding
 * @property {string} id
 * @property {string} origin
 * @property {string} sigId
 * @property {string} path
 * @property {ElementFingerprint[]} elements
 * @property {"verified"|"candidate"|"stale"} state
 * @property {number} lastVerifiedAt
 * @property {string[]} observedValues
 * @property {"replace"|"refresh"} probeMode
 */

/**
 * @typedef {Object} Preset
 * @property {string} id
 * @property {string} origin
 * @property {string} name
 * @property {string} emoji
 * @property {Change[]} changes
 * @property {number} createdAt
 * @property {number} [lastAppliedAt]
 */

/* ────────────────────────────────────────────────── transport-level payload shapes */

/**
 * What the MAIN world reports for one intercepted response. Deliberately RAW: no
 * sigId, no hash, no normalization — §17.3 keeps all of that in signatures.js.
 *
 * @typedef {Object} RawCapture
 * @property {string} method
 * @property {string} url                absolute
 * @property {number} status
 * @property {string} contentType
 * @property {any}    body               parsed JSON, or {__unparsed:true, preview:string}
 * @property {number} bodyBytes
 * @property {"fetch"|"xhr"|"document"|"other"} via
 * @property {string[]} [requestBodyKeys] sorted top-level keys of a JSON request body
 * @property {string} [gqlOperation]      operationName read out of the request body
 * @property {boolean} mocked
 * @property {boolean} [changeDropped]   a Change matched, but the body did not arrive
 *   within the in-page read deadline, so the page received the REAL response. Surfaced
 *   so the panel can say the edit did not apply (PLAN.md §1 — never lie).
 * @property {number} ts
 */

/**
 * One entry of the compiled match list the SW hands to the MAIN world (§5.2 final
 * paragraph). `urlRegex` is a RegExp SOURCE string — RegExp objects are not worth
 * pushing through two structured clones.
 *
 * @typedef {Object} MatchEntry
 * @property {string} sigId
 * @property {string} method
 * @property {string} urlRegex          anchored, matched against origin + pathname
 * @property {[string,string|null][]} params required query params; a null value means
 *   "any value" (the volatile sentinel). A literal "*" is an ordinary literal.
 * @property {string} [gqlOperation]
 * @property {{path:string, tokens:{type:"key"|"index", value:string|number}[], value:any}[]} changes
 */

/* ───────────────────────────────────────── MIRRORED in both content scripts (see top) */

/** Tag on every MAIN <-> ISOLATED postMessage frame (PLAN.md §2). */
export const MOCKLAB_TAG = '__mocklab';

/** DOM attribute used once, at document_start, to hand the page token to MAIN world. */
export const TOKEN_ATTRIBUTE = 'data-mocklab-token';

/** Name of the chrome.runtime Port that agent.js opens to the service worker. */
export const PORT_NAME = 'mocklab';

/**
 * Frames exchanged between the MAIN world (interceptor.js) and the ISOLATED world
 * (agent.js) via window.postMessage. Every frame is
 * `{ [MOCKLAB_TAG]: token, type, payload }` and anything without the exact token is
 * ignored outright — the page is a hostile environment (PLAN.md §2).
 */
export const PAGE = {
  /** MAIN -> ISOLATED. The patch is installed and wants the current match list. */
  HELLO: 'page:hello',
  /** MAIN -> ISOLATED. One RawCapture. */
  CAPTURED: 'page:captured',
  /** MAIN -> ISOLATED. history.pushState/replaceState/popstate fired. `{url}` */
  SOFT_NAV: 'page:softNav',
  /** ISOLATED -> MAIN. `{entries: MatchEntry[]}` — replaces the in-page table wholesale. */
  MATCH_LIST: 'page:matchList'
};

/* ───────────────────────────────── agent.js (ISOLATED) <-> service worker, over Port */

export const PORT_MSG = {
  /**
   * agent -> SW. A document_start for this frame. `{url, origin, loadId}`.
   * `loadId` is random per page load: the worker clears that tab's captured requests
   * only when it changes, so a Port reconnect after service-worker eviction does not
   * throw away everything the page already loaded.
   */
  HELLO: 'port:hello',
  /** agent -> SW. One RawCapture, relayed verbatim from the MAIN world. */
  CAPTURED: 'port:captured',
  /** agent -> SW. `{url}` */
  SOFT_NAV: 'port:softNav',
  /** SW -> agent. `{entries: MatchEntry[]}` — forwarded straight into the MAIN world. */
  MATCH_LIST: 'port:matchList'
};

/* ───────────────────────────────────────── panel / MCP <-> service worker, one-shot */

export const MSG = {
  /**
   * Panel -> SW. `{tabId}` -> `{ok:true, tabId, url, origin, softNavs, sources:SourceSummary[]}`
   * Sources are ordered newest-first. This is what the Sources tab lists (§10.2) and
   * what the MCP `list_sources` tool returns (§12.4 #2) — one code path, one naming.
   */
  LIST_SOURCES: 'msg:listSources',

  /**
   * Panel -> SW. `{tabId, sigId, path?}` -> `{ok:true, body, summary?}` — the whole
   * parsed body, or the subtree at `path`. Feeds the tree view in §10.2.
   *
   * `ok:false` with `reason:"not-captured"` means this tab has not seen that source on
   * the current page load. With a `path` that does not exist, `ok` is false and `body`
   * is undefined — an absent field and a field whose value IS undefined are the same
   * thing in JSON, so there is nothing to distinguish.
   */
  GET_RESPONSE: 'msg:getResponse',

  /**
   * SW -> panel broadcast (throttled). `{tabId, reason:"captured"|"softNav"|"reset"}`
   * The panel re-reads with LIST_SOURCES; the event itself carries no data so it can
   * never go stale.
   */
  SOURCES_CHANGED: 'msg:sourcesChanged',

  /* ═══════════════════════════════ M2 — Changes engine (§1.5, §10.1D, §10.2) ══════
   *
   * Every mutation below is honest about two things and the panel must show both:
   *   - `change.linkState` is NEVER "verified" here. A Change made from the tree view
   *     applies, but nothing has PROVED which elements it drives (§10.2, §17.4). Only
   *     the probe (M4) may ever raise a link to verified.
   *   - `change.applies` is false when MockLab has never seen the request this Change
   *     targets on this origin, so it cannot be compiled into the in-page match list
   *     yet. Saying "applied" then would be a lie (§1.1).
   *
   * Every mutation takes `refresh` and DEFAULTS IT TO TRUE, matching §12.4's rule for
   * the MCP tools, and answers with `refreshed:boolean` — what actually happened, not
   * what was asked for.
   * ═══════════════════════════════════════════════════════════════════════════════ */

  /**
   * Panel -> SW. Everything the persistent site bar (§10) needs in one round trip, so
   * the bar never renders a hostname from one tab beside a count from another.
   *
   * `{tabId?}` -> `{ok:true, tabId, url, origin, hostname, faviconUrl, changeCount,
   *                 changes:ChangeSummary[], captured:boolean}`
   *
   * `changeCount` is the number of ENABLED, non-probe Changes on the origin — the exact
   * number the toolbar badge shows (§1.5). `changes` is the full list including disabled
   * ones. `captured` says whether this tab has any captured sources yet.
   * `faviconUrl` is Chrome's own cached favicon for the tab, or '' when there is none.
   */
  GET_SITE_STATE: 'msg:getSiteState',

  /**
   * Panel -> SW. `{tabId?} | {origin}` -> `{ok:true, origin, changes:ChangeSummary[],
   * changeCount}`. Ordered newest-first. Pass `origin` to read a site other than the
   * one in the tab (the Scenarios tab does this at M5).
   */
  LIST_CHANGES: 'msg:listChanges',

  /**
   * Panel -> SW. Create or replace the Change at one field of one source — the "✏️
   * Change this value" action in the tree view (§10.2) and the editor's "Apply &
   * refresh page" (§10.1D). Also the MCP `set_value` tool (§12.4 #7).
   *
   * `{tabId?, sigId, path, value, note?, refresh?:true}`
   *   -> `{ok:true, change:ChangeSummary, refreshed:boolean}`
   *
   * One Change per (sigId, path): editing a field that already has one UPDATES it
   * rather than stacking a second. `originalValue` is filled in from the captured
   * response when this tab has it, and is never overwritten by a later edit — it is the
   * REAL value, which is what "Real value: …" in §11 promises.
   */
  SET_VALUE: 'msg:setValue',

  /**
   * Panel -> SW. Edit an existing Change by id.
   * `{tabId?|origin, changeId, value?, note?, enabled?, refresh?:true}`
   *   -> `{ok:true, change:ChangeSummary, refreshed:boolean}` | `{ok:false, reason:"no-such-change"}`
   */
  UPDATE_CHANGE: 'msg:updateChange',

  /**
   * Panel -> SW. The per-row on/off switch in §10.2. `enabled` absent = flip it.
   * `{tabId?|origin, changeId, enabled?, refresh?:true}`
   *   -> `{ok:true, change:ChangeSummary, refreshed:boolean}`
   */
  TOGGLE_CHANGE: 'msg:toggleChange',

  /**
   * Panel -> SW. The per-row trash button in §10.2, and the MCP `clear_changes` tool
   * with an id (§12.4 #8).
   * `{tabId?|origin, changeId, refresh?:true}` -> `{ok:true, deleted:number, refreshed:boolean}`
   */
  DELETE_CHANGE: 'msg:deleteChange',

  /**
   * Panel -> SW. "Reset site" (§1.5, §10 site bar): remove EVERY Change on this origin
   * — enabled, disabled and probe scaffolding alike — and reload the tab.
   * `{tabId?, refresh?:true}` -> `{ok:true, cleared:number, origin, refreshed:boolean}`
   */
  RESET_SITE: 'msg:resetSite',

  /**
   * Panel -> SW. "Reset everything" — §10.5's danger zone, the sibling of "Reset this
   * site". Removes every Change, Scenario and Link on EVERY site, not just this one.
   *
   * `{tabId?, refresh?:true}` -> `{ok:true, refreshed:boolean,
   *   cleared:{origins:string[], changes:number, presets:number, bindings:number}}`
   *
   * Deliberately NOT cleared: `settings` (wiping the companion pairing token would
   * silently unpair the user's AI, which a data reset should not do) and the
   * `signatures:<origin>` cache (derived, bounded, and relearned on the next page load
   * — it describes what requests look like, never what MockLab changed).
   *
   * `probe:true` scaffolding goes with everything else, exactly as RESET_SITE and
   * §17.5's startup sweep treat it.
   *
   * This exists so an MCP agent can do what the human can (§1.6 parity): the panel must
   * not reach around the contract into chrome.storage.local to implement it.
   */
  RESET_ALL: 'msg:resetAll',

  /**
   * Panel -> SW. Reload the tab without touching the store — the second half of
   * "Apply & refresh page" when the caller batched several edits with `refresh:false`.
   * `{tabId?}` -> `{ok:true, refreshed:boolean}`
   */
  REFRESH_TAB: 'msg:refreshTab',

  /**
   * Panel -> SW. `{tabId?|origin}` -> `{ok:true, origin, bindings:Binding[]}`.
   * The MCP `get_bindings` tool (§12.4 #6) reads the same handler. Until M4 every
   * binding here is `candidate` — see §17.4.
   */
  GET_BINDINGS: 'msg:getBindings',

  /** Panel -> SW. `{}` -> `{ok:true, settings}` (§4 settings key, §10.5). */
  GET_SETTINGS: 'msg:getSettings',

  /** Panel -> SW. `{patch}` -> `{ok:true, settings}` — merged, not replaced. */
  UPDATE_SETTINGS: 'msg:updateSettings',

  /**
   * SW -> panel broadcast. `{origin, count}` — a Change was created, edited, toggled,
   * deleted or reset ANYWHERE: this panel, another window's panel, or an MCP agent
   * (§1.6 agent/human parity). Data-free by the same reasoning as SOURCES_CHANGED: the
   * panel re-reads GET_SITE_STATE / LIST_CHANGES, so the event cannot go stale.
   * `count` is included only so a panel can skip a re-read it does not need.
   */
  CHANGES_CHANGED: 'msg:changesChanged'
};

/**
 * @typedef {Object} SourceSummary
 * @property {string} sigId
 * @property {string} name          friendly name (§10.2) — from signatures.friendlyName
 * @property {string} method
 * @property {string} urlPattern
 * @property {string} [gqlOperation]
 * @property {string} url           last concrete URL seen
 * @property {"fetch"|"xhr"|"document"|"other"} via
 * @property {number} fields        leaf-scalar count
 * @property {number} status
 * @property {number} bodyBytes
 * @property {number} lastSeenTs
 * @property {boolean} mocked
 * @property {boolean} unparsed
 * @property {boolean} changeDropped  a Change matched this source but could not be
 *   applied because the response body did not arrive in time
 */

/**
 * One Change as the panel and the MCP tools see it: the stored §4 Change plus the three
 * facts that only the service worker can supply.
 *
 * @typedef {Object} ChangeSummary
 * @property {string} id
 * @property {string} origin
 * @property {string} sigId
 * @property {string} path
 * @property {any} value
 * @property {any} originalValue   the REAL value last seen at this path, or undefined
 * @property {boolean} enabled
 * @property {number} createdAt
 * @property {string} [note]
 * @property {boolean} [probe]     internal probe scaffolding (§7.1) — never shown
 * @property {string} sourceName   the friendly source name, same one the Sources tab shows
 *   (`signatures.friendlyName`). Human-readable, so its fallback word lives in
 *   `strings.js` (§17.6) — an MCP client reads this field verbatim (§12.4).
 * @property {"verified"|"candidate"|"stale"|null} linkState
 *   The state of the Binding for this exact (sigId, path), or null when there is none.
 *   A Change created from the tree view without a probe leaves this at "candidate", and
 *   the panel must render §11's `editor.unverified` copy for it (§10.2, §17.4).
 * @property {boolean} applies
 *   False when this origin has no remembered signature for `sigId`, so the Change
 *   cannot be compiled into the in-page match list and will do nothing until MockLab
 *   sees that request again. Never report such a Change as applied (§1.1).
 */
