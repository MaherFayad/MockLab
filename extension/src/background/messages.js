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
 * @property {[string,string][]} params required query params; "*" value = any value
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
   * Panel -> SW. `{tabId, sigId, path?}` -> `{ok:true, body}` — the whole parsed body,
   * or the subtree at `path`. Feeds the tree view in §10.2.
   */
  GET_RESPONSE: 'msg:getResponse',

  /**
   * SW -> panel broadcast (throttled). `{tabId, reason:"captured"|"softNav"|"reset"}`
   * The panel re-reads with LIST_SOURCES; the event itself carries no data so it can
   * never go stale.
   */
  SOURCES_CHANGED: 'msg:sourcesChanged'
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
 */
