/**
 * ALL message type constants + JSDoc payload typedefs (PLAN.md §2.1, §4, §17.8).
 *
 * OWNER: interceptor-engineer. Read-only for every other agent — if you need a new
 * message type, request it through the orchestrator.
 *
 * Rule §17.8: all async messaging uses these constants. No magic strings anywhere.
 * The typedefs below are the source of truth for the shapes in PLAN.md §4.
 *
 * M3's pick types were staged in `background/pickMessages.js` while this file was
 * read-only to their author; they were folded in here — values byte-for-byte, so the
 * mirrored block in `agent.js` did not move — and that file is gone. `PHASE` came with
 * them out of `pickApi.js` for the same reason: it is payload vocabulary, so the panel
 * should not import a service-worker module to read a word off the wire.
 *
 * M4's probe types arrived the same way, staged in `background/probeMessages.js`, and
 * were folded in the same way: values byte-for-byte, that file gone. One difference,
 * stated rather than left to be noticed. The pick merge dissolved `PICK_MSG` INTO `MSG`
 * and renamed every call site; this one keeps `PROBE_MSG`, `PROBE_PORT_MSG`,
 * `PROBE_PHASE`, `PROBE_STATE`, `PROBE_STEP` and `PROBE_FAIL` as the names they already
 * were, so the merge is a move and the only edit anywhere else is a module specifier.
 * The rename is a four-module change in files another agent owns and is editing now —
 * doing it in the same commit would make "no behaviour change, byte-compared" a claim
 * nobody could check. It is still owed; §17.8 is satisfied either way, because §17.8
 * asks for one home for a message type and there is one again.
 *
 * What the separate names must NOT cost is guard coverage, and it does not: the §17.2
 * mirror audit in `test/guards.contract.test.js` no longer walks `PORT_MSG` by name. It
 * collects every `port:`-prefixed value this module exports, whatever object holds it,
 * so a probe port type is inside the guard for the same reason a pick one is. See the
 * note there — while these three sat in another module they were outside it, which is
 * exactly how the broken `port:picked` mirror passed twelve guards at M3.
 *
 * M5's eight preset/highlight types arrived the same way a third time, staged in
 * `panel/requestedMessages.js`, and are folded in below under `MSG` — values compared
 * byte-for-byte against that file's proposals, so no wire value moved and no panel call
 * site changed. That staging file is NOT deleted here the way M3's and M4's were: it
 * lives under `src/panel/`, which this agent may not write, and its `M5_MSG` now simply
 * forwards what `MSG` defines (`MSG.X || 'msg:…'` resolves to `MSG.X`) while
 * `stillRequested()` returns nothing. Its author deletes it and re-points the imports.
 *
 * ── What pins a `msg:` value, now that the eight below make thirty-two ───────────
 * Nothing did, and that was the real gap. A `page:`/`port:` value is pinned because two
 * content scripts spell it by hand and the mirror audit compares them; both ends of a
 * `msg:` value import THIS file, so changing one here changes both at once and no test
 * anywhere would notice. `guards.contract.test.js` now pins them three ways that need no
 * table named: every wire value must equal its own prefix plus its key in lowerCamel, so
 * the value is derivable from the name and a mutation of either fails; no two may be
 * equal, because a collision silently re-routes one type's messages to another's
 * handler; and every `msg:`/`port:`/`page:` literal in shipping code outside this file
 * must be one of these values, which is §17.8's "no magic strings" made checkable in the
 * direction that matters as M6 adds fifteen more.
 *
 * The derivation rule has EXACTLY THREE exceptions today and they are not a boundary —
 * they are the rename owed above, written down where a test reads it. `PROBE_PORT_MSG`'s
 * `SNAPSHOT`/`FINGERPRINTS`/`RESULT` carry `probe` in the value but not in the key,
 * because the table name carried it instead. Dissolving them into `PORT_MSG` as
 * `PROBE_SNAPSHOT`/`PROBE_FINGERPRINTS`/`PROBE_RESULT` makes all three derive and empties
 * that exemption list. `PROBE_MSG`'s four already derive, so dissolving it into `MSG` is
 * a pure rename of the table reference. Neither is done here: between them the call sites
 * are `background.js`, `probeLink.js`, `agent.js`, `panel/probe.js` and four suites —
 * two of which this agent may not write and two of which another agent was editing
 * minutes before this commit. Doing it now would mean nobody could check "no behaviour
 * change, byte-compared", which is the claim that makes a merge safe.
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

/* ───────────────────────────────────────── MIRRORED in both content scripts (see top) */

/** Tag on every MAIN <-> ISOLATED postMessage frame (PLAN.md §2). */
export const MOCKLAB_TAG = '__mocklab';

/** DOM attribute used once, at document_start, to hand the page token to MAIN world. */
export const TOKEN_ATTRIBUTE = 'data-mocklab-token';

/** Name of the chrome.runtime Port that agent.js opens to the service worker. */
export const PORT_NAME = 'mocklab';

/**
 * The names the content scripts publish themselves under, and the id of the one overlay
 * container. Not message types — but the same KIND of thing, and here for the same
 * reason: they are literals two files have to agree on with no import between them, so
 * §17.8's "no magic strings" applies to them exactly as it applies to `PAGE.CAPTURED`.
 *
 *   element  `element.js` -> read by `picker.js` (§6.1/§6.2/§7.3 questions about a node)
 *   picker   `picker.js`  -> read by `agent.js`  (§6.1 pick mode)
 *   overlayId  the single `#__mocklab_overlay__` host every overlay lives in (§6.1, §10.3)
 *   interceptorInstalled  the MAIN world's re-entrancy flag (§5.1.6) — the one name on
 *     the PAGE's window rather than the extension's isolated global, because that is the
 *     only global the MAIN-world patch has.
 *
 * Why these are worth a constant when nothing can import them: every read sits inside a
 * `try/catch` that returns null on failure (that is §17.2 — a content script may never
 * break the host page). So a rename degrades SILENTLY: pick mode simply stops working,
 * the page keeps rendering, and only a browser suite notices — which means nothing
 * notices on a machine without Playwright. This is the shape of bug that let a broken
 * mirror of `port:picked` pass twelve guards while killing pick mode end to end. The
 * guard is `guards.test.js` "§17.2 vs §17.8 …", which asserts these appear verbatim in
 * every file that mirrors them AND that every method called on the two contracts is a
 * method they actually export.
 *
 * NOT a runtime handshake: the content scripts still hardcode these names. Nothing here
 * is imported by them — it cannot be (see the header). This is the written-down half of
 * a duplication that already existed.
 */
export const CONTENT_GLOBALS = {
  element: '__mocklabElement',
  picker: '__mocklabPicker',
  overlayId: '__mocklab_overlay__',
  interceptorInstalled: '__mocklabInterceptorInstalled'
};

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
  MATCH_LIST: 'port:matchList',

  /* ───────────────────────────────────── M3 — pick mode (PLAN.md §6.1, §10.1B/C) ─── */

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

/* ─────────────────────── M4 — the probe's half of the same Port (PLAN.md §7, §7.3) ── */

export const PROBE_PORT_MSG = {
  /**
   * SW -> agent. "Tell me what the page looks like once it has settled."
   * `{requestId, fingerprint, page:boolean}` — `fingerprint` is §6.2's, re-resolved in
   * the page after the reload; `page:false` skips §7.6's whole-page sample when only
   * the element and its region are needed.
   *
   * Sent immediately after a new document says HELLO, so the agent starts watching for
   * §7.3's settle conditions from document_start rather than from whenever the worker
   * happened to ask.
   */
  SNAPSHOT: 'port:probeSnapshot',

  /**
   * SW -> agent. `{requestId, keys:string[]}` — §6.2 fingerprints for nodes the worker
   * has just decided are interesting (§7.6's inverse discovery). A second round trip on
   * the SAME page load, because fingerprinting 3000 sampled nodes to use four of them
   * would cost a `querySelectorAll` per node for nothing.
   */
  FINGERPRINTS: 'port:probeFingerprints',

  /**
   * agent -> SW. The answer to either request above, correlated by `requestId`:
   * `{requestId, ok, settled?, element?, region?, page?, fingerprints?, reason?}`.
   * One reply type, because the worker awaits one promise per request id either way.
   */
  RESULT: 'port:probeResult'
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
  CHANGES_CHANGED: 'msg:changesChanged',

  /* ═══════════════════════ M3 — pick mode (§6.1, §6.3, §10.1A/B/C) ════════════════
   *
   * Nothing here is or becomes a Link. Every candidate below is a GUESS — a value
   * match, with false positives — and only the §7 probe may raise one to verified
   * (§0.2, §17.4).
   * ═══════════════════════════════════════════════════════════════════════════════ */

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
   * `phase` is one of `PHASE` below. `element` is the picked element's §7.3 snapshot
   * plus a `label` for the mini card, or null. `candidates` is §6.3's ranked list,
   * `{sigId, sourceName, path, value, score, via, rules}[]`, empty when nothing matched
   * — which the panel renders as `pick.noCandidates` (§11), never as a silent empty
   * list.
   *
   * `searched` is `{sources, bounded, complete}` — how much of this tab's data the
   * search actually reached. A response nests deeper or wider than MockLab enumerates
   * (`candidates.js` MAX_DEPTH / MAX_PATHS) counts in `bounded` and makes `complete`
   * false. It exists because `pick.noCandidates` says "MockLab couldn't find this text
   * in any data the page loaded", which is a claim about the DATA; showing it after a
   * bounded search would state a fact MockLab never established (§1.1). With
   * `complete:false` and no candidates, the panel needs a different sentence — see the
   * note in BUILD_LOG: the string for it is not invented here.
   */
  GET_PICK: 'msg:getPick',

  /**
   * SW -> panel broadcast. `{tabId, phase}` — pick mode started, was cancelled, or an
   * element was picked. Data-free beyond the phase, by the same reasoning as
   * `SOURCES_CHANGED` and `CHANGES_CHANGED`: the panel re-reads `GET_PICK`, so the
   * event cannot go stale.
   */
  PICK_CHANGED: 'msg:pickChanged',

  /* ═════════════════ M5 — Scenarios (§10.4) and highlighting (§10.3) ══════════════
   *
   * Five of these seven preset types are §12.4's tool names spelled as messages — #10
   * `list_presets`, #11 `apply_preset`, #12 `save_preset`, #13 `delete_preset` — so the
   * panel and an MCP agent reach ONE handler per action rather than two that drift
   * (§1.6 parity). The other two exist because §10.4 gives the human two actions §12.4
   * has no tool for: Rename is `UPDATE_PRESET`, and Import is `IMPORT_PRESET`, which
   * also serves Duplicate — a duplicate is an import of a preset already in hand.
   *
   * `origin` is accepted beside `tabId` everywhere a preset is read or written, because
   * the Scenarios tab lists a site other than the one in the tab (§10.4).
   * ═══════════════════════════════════════════════════════════════════════════════ */

  /**
   * Panel -> SW. `{tabId?|origin}` -> `{ok:true, origin, presets:Preset[]}`.
   * The MCP `list_presets` tool (§12.4 #10) reads the same handler.
   */
  LIST_PRESETS: 'msg:listPresets',

  /**
   * Panel -> SW. §10.4's "New scenario from current changes", and §12.4 #12.
   * `{tabId?|origin, name, emoji?}` -> `{ok:true, preset:Preset}`
   *
   * Snapshots the origin's currently ENABLED, non-probe Changes as EMBEDDED COPIES, not
   * references (§4) — a Scenario has to still mean what it meant when it was saved, so
   * later edits to those Changes must not reach back into it. `probe:true` scaffolding
   * is never included: it is MockLab's own temporary machinery (§7.1), not the user's.
   */
  SAVE_PRESET: 'msg:savePreset',

  /**
   * Panel -> SW. §10.4's Rename, which §12.4 has no tool for.
   * `{tabId?|origin, presetId, name?, emoji?}`
   *   -> `{ok:true, preset:Preset}` | `{ok:false, reason:"no-such-preset"}`
   *
   * Renaming only. It deliberately cannot edit `changes`: re-snapshotting under an
   * existing name would silently change what an already-saved Scenario does, which is
   * the §1.1 lie in Scenario form. Saving again is `SAVE_PRESET`.
   */
  UPDATE_PRESET: 'msg:updatePreset',

  /** Panel -> SW. §10.4's ⋯ menu, and §12.4 #13. `{tabId?|origin, presetId}` -> `{ok:true, deleted:number}` */
  DELETE_PRESET: 'msg:deletePreset',

  /**
   * Panel -> SW. §10.4's Apply, and the MCP `apply_preset` tool (§12.4 #11).
   * `{tabId, presetId, refresh?:true}`
   *   -> `{ok:true, applied:number, unapplied:number, refreshed:boolean}`
   *
   * `unapplied` is the honest half and the panel must show it: a Change whose source
   * this origin has never seen cannot be compiled into the in-page match list, exactly
   * as `ChangeSummary.applies` reports for a single Change. Toasting a clean "applied"
   * over a half-changed page is §1.1's lie with a nicer noise. It is also what §10.4's
   * `scenarios.stale` copy is rendered from — a Scenario saved before the site changed.
   *
   * `refresh` defaults to true and the answer says `refreshed` — what happened, not what
   * was asked for — matching every other mutation above and §12.4's rule.
   */
  APPLY_PRESET: 'msg:applyPreset',

  /**
   * Panel -> SW. §10.4's Import (and Duplicate). `{tabId?|origin, preset}`
   *   -> `{ok:true, preset:Preset}`
   *
   * `preset` is a §4 Preset THE PANEL HAS ALREADY VALIDATED (`panel/scenarioFile.js`),
   * because a corrupt file must produce §10.4's friendly error beside the file picker,
   * where the person is, rather than a worker rejection they cannot see. The worker
   * still gives it a fresh `id` and its own `origin`: an imported file must never be
   * able to overwrite a Scenario already on this machine by carrying its id.
   */
  IMPORT_PRESET: 'msg:importPreset',

  /**
   * SW -> panel broadcast. `{origin}` — a Scenario was saved, renamed, imported,
   * deleted or applied anywhere, including by an MCP agent (§1.6). Data-free by the same
   * reasoning as `SOURCES_CHANGED`, `CHANGES_CHANGED` and `PICK_CHANGED`: the panel
   * re-reads `LIST_PRESETS`, so the event can never go stale.
   */
  PRESETS_CHANGED: 'msg:presetsChanged',

  /**
   * Panel -> SW. §10.3's overlays, and §12.4 #9 verbatim including its answer shape.
   * `{tabId, sigId, path}` -> `{ok:true, elements:number, verified:boolean}`
   *
   * `verified` is which overlay §10.3 draws, and it is a claim about PROOF: true only
   * when a Binding for this exact (sigId, path) is `verified`, which only the §7 probe
   * may write (§0.2, §17.4). False means the dashed amber "best guess" outline and
   * §11's `sources.guessHighlight` tooltip — never the solid accent one.
   *
   * `elements` is how many overlays were ACTUALLY drawn, not how many were asked for,
   * so the panel can tell "shown" from "there was nothing left to show" — a verified
   * Binding whose elements are all gone after a redesign returns 0, and saying "shown"
   * then would be a claim about a page MockLab could not find (§1.1).
   */
  HIGHLIGHT: 'msg:highlight'
};

/* ═══════════════════════ M4 — the probe (§7, §10.1C/D) ══════════════════════════ */

export const PROBE_MSG = {
  /**
   * Panel -> SW. §10.1C's "Find the real source". `{tabId?}` ->
   * `{ok:true, tabId}` | `{ok:false, reason}` where reason is a `PROBE_FAIL` value.
   * The probe then runs on its own; the panel follows it through `GET_PROBE`.
   */
  START_PROBE: 'msg:startProbe',

  /**
   * Panel -> SW. §11's `probe.cancel` ("Stop checking"). `{tabId?}` -> `{ok:true}`.
   * CLEANUP always runs: every `probe:true` Change is deleted and the page is put back
   * (PLAN.md §7.1, §17.5).
   */
  CANCEL_PROBE: 'msg:cancelProbe',

  /**
   * Panel -> SW. The whole progress card and, when it is over, §10.1 State D:
   * `{tabId?}` -> `{ok:true, tabId, origin, state, step, testing, reloads:{done,expected},
   *                 startedAt, result}`
   *
   * `state` is a `PROBE_STATE`, `step` a `PROBE_STEP` (which is the key of the §11
   * `probe.step.*` sentence to render), `testing` the number of possibilities in the
   * batch currently on the page (§11's `probe.step.testing(n)`), and `reloads` the
   * counter behind `probe.reloads(i, n)` — `done` is what has actually happened,
   * `expected` an estimate, which is why §11 phrases it "refresh 4 of ~8".
   *
   * `result` is null until the run ends, then either
   *   `{ok:true, binding, elements, affected, notRefetched}` or
   *   `{ok:false, reason}` with a `PROBE_FAIL` value naming the §11 sentence to show.
   */
  GET_PROBE: 'msg:getProbe',

  /**
   * SW -> panel broadcast. `{tabId, state}` — data-free beyond the state, by the same
   * reasoning as `SOURCES_CHANGED`, `CHANGES_CHANGED` and `PICK_CHANGED`: the panel
   * re-reads `GET_PROBE`, so the event can never go stale.
   */
  PROBE_CHANGED: 'msg:probeChanged'
};

/**
 * §10.1's three Pick-tab states, named — the vocabulary of `GET_PICK`'s `phase` and of
 * `PICK_CHANGED`'s payload, which is why it lives here beside them and not in the
 * service-worker module that happens to write it. The panel reads this word off the
 * wire; it should not have to import a worker module to learn what it can say.
 *
 * NOT a link state. §17.4's three states (`verified` / `candidate` / `stale`) describe
 * what MockLab has PROVED about a field; these three describe what the Pick tab is
 * currently doing. Nothing here ever becomes the other.
 */
export const PHASE = { IDLE: 'idle', PICKING: 'picking', PICKED: 'picked' };

/**
 * The four things the PANEL has to draw: nothing, a progress card, a result, a failure.
 * Coarser than `PROBE_STATE` on purpose — §10.1 has four screens, and a panel that
 * switched on nine states would have to be edited every time §7.1 grew one.
 *
 * `GET_PROBE` answers with both: `phase` for the screen, `state` for the detail.
 */
export const PROBE_PHASE = { IDLE: 'idle', RUNNING: 'running', DONE: 'done', FAILED: 'failed' };

/**
 * PLAN.md §7.1's state machine, named. This is what the probe is DOING; it is not a
 * link state. §17.4's three words (`verified` / `candidate` / `stale`) describe what
 * MockLab has PROVED about a field, and nothing here ever becomes one of them.
 */
export const PROBE_STATE = {
  IDLE: 'idle',
  CONTROL_A: 'controlA',
  CONTROL_B: 'controlB',
  TESTING: 'testing',
  VERIFY_ON: 'verifyOn',
  VERIFY_OFF: 'verifyOff',
  CONFIRMED: 'confirmed',
  CLEANUP: 'cleanup',
  DONE: 'done'
};

/**
 * The four sentences §11 gives the progress card, as keys of `S.probe.step`. The panel
 * renders `S.probe.step[step]`; `testing` is the one that takes the batch size.
 */
export const PROBE_STEP = {
  CONTROL: 'control',
  TESTING: 'testing',
  CONFIRMING: 'confirming',
  CLEANUP: 'cleanup'
};

/**
 * Why a probe ended without proving anything. The FIRST FIVE are keys of `S.probe` in
 * `strings.js` — §11 wrote the honest sentence for each, and the panel renders it by
 * name rather than by a code the worker invented.
 *
 * The REST have no `S.probe.*` sentence, because §11 wrote copy for a probe that ran and
 * found nothing, not for one that never started or one that broke. `NO_CANDIDATES` is
 * `pick.noCandidates`; the next four are conditions the panel already draws elsewhere —
 * nothing was picked (§10.1A), the tab has no page agent (the same `no-content-script`
 * `START_PICK` already answers with), the user's own Stop button, and a second START
 * arriving while a run is live.
 */
export const PROBE_FAIL = {
  TOO_NOISY: 'tooNoisy',
  NONE_CONFIRMED: 'noneConfirmed',
  ELEMENT_LOST: 'elementLost',
  NOT_REFETCHED: 'notRefetched',
  TIMEOUT: 'timeout',
  NO_CANDIDATES: 'noCandidates',
  NO_PICK: 'no-pick',
  NO_CONTENT_SCRIPT: 'no-content-script',
  CANCELLED: 'cancelled',
  BUSY: 'busy',
  /**
   * Not a fact about the page: MockLab itself threw. Kept apart from `TIMEOUT` and
   * `NONE_CONFIRMED` because reporting a defect of ours as a finding about the site is
   * the same class of lie as a false "Verified ✓" — the panel's sentence for it is
   * §11's `errors.pageBroke`, and the detail goes to the console.
   */
  INTERNAL: 'internal'
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
 * @property {number} fields        every leaf scalar the body holds — the WHOLE body,
 *   not the part a bounded walk reached (`background.countFields`). It is a claim about
 *   the data, so it is never smaller than what §6.3's search covered; `searched.complete`
 *   on `GET_PICK` is the separate, honest answer to "how much did MockLab look at".
 *   Zero for an `{__unparsed}` body, which travels with `unparsed:true` beside it.
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
