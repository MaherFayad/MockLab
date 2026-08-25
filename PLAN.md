# MockLab — Complete Build Specification

**Version 1.0 — hand this entire document to the implementing AI. It contains everything needed to build the product correctly on the first attempt. Read it fully before writing any code. Where this document says MUST / NEVER, treat it as a hard constraint, not a suggestion.**

---

## 0. What you are building (read this twice)

MockLab is a Chromium (Manifest V3) browser extension + a small local companion app. Together they let a **non-technical person** open any website, click on any element on the page (a price, a status pill, a name), and MockLab will:

1. **Find and PROVE** which API response field controls that element (not guess — prove, by experiment).
2. Let the person **change that value** with a friendly editor, so that on refresh the website's own front-end code renders the new state (e.g., a flight status pill turns red because the site's JavaScript actually received `"CANCELLED"` — this is NOT DOM text editing).
3. **Highlight on the page** every element that a given API field affects, before and after changes.
4. Save named **Scenarios** (bundles of value changes) locally, apply them with one click.
5. Expose everything through a local **MCP server**, so AI agents (Claude Code, etc.) can list APIs, change values, apply scenarios, and take screenshots on the user's behalf.

The user for the UI is a designer or QA person with **zero coding knowledge**. They never see the words "JSON", "endpoint", "regex", or "payload" in default UI copy. The user of the MCP is an AI agent that needs precise, machine-readable tools.

### 0.1 Vocabulary (used consistently in code and UI)

| Internal name (code) | UI name (what the human sees) | Meaning |
|---|---|---|
| CapturedRequest | "Data source" | One intercepted API request+response the page made |
| RequestSignature | (never shown) | Normalized stable identity of a request across refreshes |
| Binding | "Link" | A proven connection: API field ↔ page element(s) |
| Rule | "Change" | One edit: this field of this data source becomes this value |
| Preset | "Scenario" | A named saved set of Changes for one website |
| Probe | "Checking…" | The verification experiment (flip value, watch element, flip back) |
| JsonPath | "Field" | Dot/bracket path into a response body, e.g. `$.data.flights[0].status` |

### 0.2 The one hard truth the whole product is built on

You CANNOT know which API field drives an element by *looking* at data (string matching gives candidates, with false positives, and misses derived values like enum→color). You CAN know it with certainty by *experiment*: change the field → element changes; change it back → element changes back; and neither change happened in page regions that change on their own. This A/B/A probe protocol is the heart of the product. **NEVER display "Linked ✓" for a binding that has not survived the full probe protocol described in §7.** Unproven candidates are always displayed as "Possible link" with dashed styling.

---

## 1. Non-negotiable product principles

1. **Never lie about certainty.** Three states exist everywhere in UI and API: `verified` (proved by probe), `candidate` (value-match guess), `stale` (was verified, but the site changed and it no longer matches). Each has distinct visuals (§10.6). No fourth state. No silent downgrades.
2. **Zero-jargon default UI.** Every string a non-technical user sees is listed in §11 (copy table). Use those exact strings. An "Advanced" toggle in Settings reveals technical details (raw URLs, JSON paths, signatures) for power users; OFF by default.
3. **The site must do the rendering.** MockLab never mutates the DOM to fake a state (except temporary highlight overlays, which are clearly its own UI). All state changes flow through the site's own fetch/XHR/data pipeline.
4. **Everything local.** No telemetry, no remote servers, no accounts. All data in `chrome.storage.local` + the companion's local files. The extension only changes what THIS browser sees.
5. **Reversible always.** One click ("Reset site") removes every active Change for the current site and refreshes. The badge on the extension icon shows the number of active Changes so the user always knows the page is modified.
6. **Agent = human parity.** Every action in the panel has an MCP tool equivalent. The rule store is shared: an agent's change appears in the panel within 1 second, and vice versa.

---

## 2. System architecture

Two deliverables in one monorepo:

```
┌────────────────────────────  Chromium browser  ───────────────────────────┐
│                                                                           │
│  ┌── Web page (any site) ─────────────────────────────┐                   │
│  │                                                    │                   │
│  │  interceptor.js  (content script, world: MAIN,     │                   │
│  │   run_at: document_start)                          │                   │
│  │   • patches window.fetch + XMLHttpRequest          │                   │
│  │   • captures every response, applies Changes       │                   │
│  │   • window.postMessage ⇅ (tagged, secret token)    │                   │
│  │                                                    │                   │
│  │  agent.js  (content script, world: ISOLATED,       │                   │
│  │   run_at: document_start)                          │                   │
│  │   • relays MAIN ⇄ service worker (Port)            │                   │
│  │   • element picker, highlight overlays,            │                   │
│  │     snapshots, quiescence detection                │                   │
│  └────────────────────────────────────────────────────┘                   │
│                        ⇅ chrome.runtime Port                              │
│  ┌── Service worker (background.js) ──────────────────┐                   │
│  │  • rule store (chrome.storage.local), per origin   │                   │
│  │  • probe orchestrator (state machine, §7)          │                   │
│  │  • signature normalizer                            │                   │
│  │  • debugger engine (SSR mode, chrome.debugger+CDP) │                   │
│  │  • WebSocket CLIENT → companion daemon             │                   │
│  │  • badge counts, screenshot capture                │                   │
│  └────────────────────────────────────────────────────┘                   │
│                        ⇅ chrome.runtime Port                              │
│  ┌── Side panel (panel.html) ─────────────────────────┐                   │
│  │  Pick / Sources / Scenarios / Settings UI (§10)    │                   │
│  └────────────────────────────────────────────────────┘                   │
└───────────────────────────────────────────────────────────────────────────┘
                         ⇅ ws://127.0.0.1:8517 (token-authenticated)
┌── Companion daemon (Node ≥ 20, installed once) ───────────────────────────┐
│  • MCP server (stdio transport for Claude Code/Desktop, plus              │
│    Streamable HTTP on 127.0.0.1:8518 for other clients)                   │
│  • WebSocket hub: forwards MCP tool calls to the extension                │
│  • serves the bundled demo site at http://127.0.0.1:8517/demo             │
│  • file import/export helpers for Scenarios                               │
└───────────────────────────────────────────────────────────────────────────┘
```

Key architectural facts the implementer MUST respect:

- **Manifest V3 cannot modify response bodies with declarativeNetRequest.** Body modification happens ONLY in (a) the MAIN-world fetch/XHR patch, and (b) the CDP Fetch domain via `chrome.debugger` (SSR mode). Never attempt bodies via `chrome.webRequest` (observation-only in MV3) or DNR.
- **The extension cannot open a listening port.** The MCP server therefore lives in the companion; the extension connects OUT to it as a WebSocket client. Since Chrome 116, active WebSocket traffic extends MV3 service-worker lifetime; additionally use a `chrome.alarms` heartbeat every 25s as a reconnect safety net.
- **MAIN world is required.** The fetch patch must run in the page's own JS world before any site script (hence `run_at: document_start`, `world: "MAIN"`, declared statically in the manifest — NOT injected via `chrome.scripting` at runtime, which is too late on fast pages).
- **MAIN ⇄ ISOLATED communication** uses `window.postMessage` with a per-page-load random token generated by `agent.js` and handed to `interceptor.js` via a DOM attribute on `document.documentElement` (read then immediately removed). Every message is `{ __mocklab: token, type, payload }`. Ignore any message without the exact token (pages are hostile environments).
- The side panel uses `chrome.sidePanel` (Chrome 114+), opened per-tab via the toolbar icon. The panel stays open across refreshes of the tab — this is essential for the probe UX.

### 2.1 Repository layout (create exactly this)

```
mocklab/
├── package.json                 # workspaces: ["extension", "companion"], scripts below
├── README.md                    # user-facing install guide (§13)
├── PLAN.md                      # this document
├── extension/
│   ├── manifest.json
│   ├── src/
│   │   ├── content/
│   │   │   ├── interceptor.js   # MAIN world. No imports; single self-contained IIFE
│   │   │   └── agent.js        # ISOLATED world. Picker, overlays, snapshots, relay
│   │   ├── background/
│   │   │   ├── background.js    # entry: wires modules below
│   │   │   ├── ruleStore.js     # CRUD for Changes/Scenarios/Bindings + storage schema
│   │   │   ├── signatures.js    # normalization (§5.2) — pure functions, unit-testable
│   │   │   ├── probe.js         # probe state machine (§7) — pure logic + SW glue
│   │   │   ├── debuggerEngine.js# CDP Fetch attach/detach, document rewrite (§8)
│   │   │   ├── wsClient.js      # companion connection, reconnect, auth
│   │   │   └── messages.js      # ALL message type constants + JSDoc payload types
│   │   ├── panel/
│   │   │   ├── panel.html
│   │   │   ├── panel.css        # design system §9 — tokens copied verbatim
│   │   │   ├── panel.js         # UI logic; no framework, no build step
│   │   │   └── strings.js       # every user-visible string (§11), one export
│   │   └── shared/
│   │       ├── jsonpath.js      # tiny JSONPath subset (§5.4) — shared by all layers
│   │       └── diff.js          # snapshot diff (§7.3)
│   ├── icons/ (16, 32, 48, 128 px — flask emoji style ⚗ on accent-blue rounded square)
│   └── test/
│       ├── signatures.test.js
│       ├── jsonpath.test.js
│       └── diff.test.js
├── companion/
│   ├── package.json             # deps: @modelcontextprotocol/sdk, ws. Nothing else.
│   ├── src/
│   │   ├── index.js             # CLI entry: `mocklab-companion [--stdio|--http]`
│   │   ├── mcpServer.js         # tool definitions (§12), zod-free JSON-schema style
│   │   ├── hub.js               # WebSocket hub + token auth + request/response matching
│   │   └── demo/                # bundled demo site (§14) — static files
│   │       ├── index.html       # fake airline trip page
│   │       ├── app.js           # fetches /demo/api/trip.json, renders status pill etc.
│   │       └── api/trip.json
│   └── test/hub.test.js
└── .github/workflows/ci.yml     # node test runner: `node --test` across workspaces
```

Root `package.json` scripts: `"test": "npm test -ws"`, `"zip": "cd extension && zip -r ../mocklab-extension.zip ."`. No bundler, no TypeScript compile step, no framework. Plain modern JS (ES2022) everywhere; JSDoc `@typedef` for all shared types (they are the source of truth for shapes in §4). This is deliberate: zero build steps means any AI or human can edit one file and reload the extension.


---

## 3. Extension manifest (write exactly this, adjust nothing without reason)

```json
{
  "manifest_version": 3,
  "name": "MockLab",
  "version": "1.0.0",
  "description": "Click any element, find the data behind it, change it, and see the site render the new state.",
  "minimum_chrome_version": "116",
  "permissions": ["storage", "tabs", "scripting", "activeTab", "alarms", "debugger"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "src/background/background.js", "type": "module" },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["src/content/interceptor.js"],
      "run_at": "document_start",
      "world": "MAIN",
      "all_frames": false
    },
    {
      "matches": ["<all_urls>"],
      "js": ["src/content/agent.js"],
      "run_at": "document_start",
      "world": "ISOLATED",
      "all_frames": false
    }
  ],
  "side_panel": { "default_path": "src/panel/panel.html" },
  "action": { "default_title": "Open MockLab" },
  "icons": { "16": "icons/16.png", "32": "icons/32.png", "48": "icons/48.png", "128": "icons/128.png" }
}
```

Notes: `all_frames: false` in v1 (top frame only — iframes are a documented limitation, see §15). `debugger` permission is requested at install; the debugger is only ATTACHED when the user enables "Deep mode" (§8) — attaching shows Chrome's "started debugging this browser" bar, which is why it's opt-in per tab. `background.js` opens the side panel on action click via `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` at startup.

---

## 4. Data models (JSDoc typedefs — put in `messages.js` and reuse everywhere)

```js
/**
 * @typedef {Object} RequestSignature
 * @property {string} method        // "GET" | "POST" | ...
 * @property {string} urlPattern    // normalized URL, volatile parts → "*" (§5.2)
 * @property {string} [gqlOperation]// GraphQL operationName if detected
 * @property {string} [bodyShape]   // for POST search-style APIs: sorted top-level keys of request body, joined by ","
 * @property {string} sigId         // stable hash of the above (sha256 hex, first 12 chars) — the primary key
 */

/**
 * @typedef {Object} CapturedRequest
 * @property {string} sigId
 * @property {RequestSignature} signature
 * @property {string} url             // last concrete URL seen
 * @property {number} status          // HTTP status
 * @property {string} contentType
 * @property {any}    body            // parsed JSON (or {__unparsed: true, preview: string} for non-JSON)
 * @property {number} bodyBytes
 * @property {number} ts              // capture timestamp
 * @property {"fetch"|"xhr"|"document"|"other"} via
 * @property {boolean} mocked         // true if a Change was applied to this response
 */

/**
 * @typedef {Object} Change            // UI: "Change". One value edit.
 * @property {string} id               // crypto.randomUUID()
 * @property {string} origin           // e.g. "https://www.trip.com"
 * @property {string} sigId
 * @property {string} path             // JSONPath, e.g. "$.data.flights[0].status"
 * @property {any}    value            // the replacement value
 * @property {any}    originalValue    // last real value seen (for display + revert)
 * @property {boolean} enabled
 * @property {number} createdAt
 * @property {string} [note]           // user label, e.g. "Flight cancelled"
 */

/**
 * @typedef {Object} ElementFingerprint
 * @property {string}  css            // best-effort unique CSS selector (§6.2)
 * @property {string}  textAnchor     // trimmed innerText at fingerprint time, max 80 chars
 * @property {string[]} attrAnchors   // ["data-testid=...", "aria-label=...", "id=..."] that existed
 * @property {number[]} treePath      // child indexes from body, e.g. [1,0,3,2] — last-resort re-resolution
 */

/**
 * @typedef {Object} Binding           // UI: "Link"
 * @property {string} id
 * @property {string} origin
 * @property {string} sigId
 * @property {string} path
 * @property {ElementFingerprint[]} elements   // all elements proven affected
 * @property {"verified"|"candidate"|"stale"} state
 * @property {number} lastVerifiedAt
 * @property {string[]} observedValues  // distinct real values ever seen at this path (max 10) → powers the value dropdown
 * @property {"replace"|"refresh"} probeMode    // which probe mode proved it (replay unsupported in v1 → always "refresh")
 */

/**
 * @typedef {Object} Preset            // UI: "Scenario"
 * @property {string} id
 * @property {string} origin
 * @property {string} name             // e.g. "Flight cancelled"
 * @property {string} emoji            // user-picked, default "🎬"
 * @property {Change[]} changes        // embedded copies (not references)
 * @property {number} createdAt
 * @property {number} [lastAppliedAt]
 */
```

`chrome.storage.local` layout (keys): `changes:<origin>` → `Change[]`; `bindings:<origin>` → `Binding[]`; `presets:<origin>` → `Preset[]`; `settings` → `{advancedMode:boolean, deepModeOrigins:string[], companionToken:string|null}`. Captured requests are NOT persisted (session-only, kept in the SW in a `Map<tabId, Map<sigId, CapturedRequest>>`, max 200 entries per tab, LRU-evicted; bodies over 2 MB stored as `{__unparsed}` preview only).

---

## 5. Feature spec F1 — capture & mock engine (`interceptor.js`)

The single most load-bearing file. It is a self-contained IIFE with ZERO imports (MAIN-world scripts can't use extension modules). It must be defensive: any internal error must be swallowed (try/catch around everything) and NEVER break the host page. Structure:

### 5.1 Patching

1. Save originals FIRST: `const realFetch = window.fetch; const RealXHR = window.XMLHttpRequest;` before anything else runs (document_start guarantees this precedes site code).
2. **fetch patch**: wrap `window.fetch` so that: call `realFetch`, clone the `Response`, read the clone's text. If content-type includes `json` (or text parses as JSON), parse it → build capture record → `post({type:'captured', ...})`. Then ask the rule table (see 5.3) for matching enabled Changes; if any match, apply each `setByPath(body, path, value)` (§5.4), and return a NEW `Response(JSON.stringify(modified), {status, statusText, headers})` (copy original headers, drop `content-length`). If none match, return the original untouched Response object (never a re-serialized one — avoids breaking streaming/binary).
3. **XHR patch**: subclass-free approach — patch `open` to record method/url on the instance; patch `send`; on `load`, if matching Changes exist, redefine `responseText` and `response` on the instance via `Object.defineProperty` with the modified string BEFORE dispatching to site listeners. To do that reliably, intercept by replacing the instance's `onreadystatechange`/listener dispatch: the standard proven pattern is to override the getters at `readyState===4` time inside a capture-phase `readystatechange` listener registered in the patched `send` (register with `addEventListener(..., {capture:true})` — capture listeners registered first fire first).
4. **Streaming/opaque cases**: if `response.body` was already consumed as a stream by the site or content-type is not JSON-parseable → capture metadata only, mark `{__unparsed:true}`, never attempt modification.
5. The Change table is pushed INTO the page world: `agent.js` sends the origin's enabled Changes on load and on every store update; `interceptor.js` holds them in a local array. This makes application synchronous — no async round-trip inside the fetch patch (critical: an await to the extension would deadlock ordering on some sites).
6. Re-entrancy guard: mark internal messages; never capture requests initiated by MockLab itself (none should originate in MAIN world anyway).
7. SPA soft navigations: patch `history.pushState`/`replaceState` to notify `agent.js` (`type:'softNav'`) so the panel can mark the capture list as "navigated".

### 5.2 Signature normalization (`signatures.js`, pure, unit-tested)

`normalize(method, url, requestBody?) → RequestSignature`:

- Parse URL. Lowercase host. Drop hash.
- Path segments: replace any segment that matches `/^\d{4,}$/` (long numbers), `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` (UUIDs), `/^[0-9a-f]{16,}$/i` (hex ids), or base64-looking segments ≥ 16 chars, with `*`.
- Query params: DROP params whose name matches `/^(t|ts|_|cb|nonce|timestamp|time|rnd|random|sid|sessionid|session_id|token|auth|signature|sign|hash|traceid|trace_id|requestid|request_id|x-request-id)$/i`, and any param whose value matches the volatile-segment rules above. KEEP remaining params sorted by name, values replaced with `*` if volatile-looking else kept.
- GraphQL: if path ends in `/graphql` (or request body has `operationName`), set `gqlOperation` from the request body (`operationName` field; for batched arrays use the joined names) and set urlPattern to just `origin + path`.
- POST bodies (non-GraphQL, JSON): `bodyShape` = sorted top-level keys joined by `,`.
- `sigId` = first 12 hex chars of SHA-256 of `method + " " + urlPattern + " " + (gqlOperation||"") + " " + (bodyShape||"")`. Use `crypto.subtle` in SW/panel; in MAIN world use a bundled tiny synchronous FNV-1a 64-bit instead (subtle is async; determinism across layers matters → therefore: the MAIN world computes NOTHING — it sends raw method/url/body-keys to `agent.js`, and ONLY `signatures.js` (SW) computes sigIds. MAIN world matches Changes by a prepared match list the SW compiles (see below).)
- The SW compiles for each origin a **match list**: `[{sigId, method, urlRegex, gqlOperation?, changes:[{path, value}]}]` where `urlRegex` is the urlPattern with `*` → `[^/&?]+`, anchored. This compiled list is what `interceptor.js` receives and evaluates synchronously. Unit tests MUST cover: trip-style URLs with numeric ids, UUID paths, volatile query params, GraphQL operations, batched GraphQL.

### 5.3 Matching in-page

`interceptor.js` matching: for each captured request, test method equality then `urlRegex.test(url)`; for GraphQL also compare operationName extracted from the request body. First match wins per Change; multiple Changes on one signature all apply in order.

### 5.4 JSONPath subset (`jsonpath.js`)

Implement ONLY this grammar (RFC 9535-lite, sufficient and predictable): `$` root; `.key` (dot, keys matching `[A-Za-z_$][\w$]*`); `["any key"]` bracket-quoted; `[123]` numeric index. Functions: `getByPath(obj, path)`, `setByPath(obj, path, value)` (creates nothing — returns false if any step missing), `enumeratePaths(obj, maxDepth=12, maxPaths=5000)` → `[{path, value}]` for leaf scalars (used by candidate search), `findByValue(obj, needle)` → paths whose leaf loosely matches (see §6.3). No wildcards, no filters, no recursive descent — the product never needs them, and predictability beats power. 30+ unit tests including unicode keys, keys with dots (must round-trip via bracket form), arrays of objects.


---

## 6. Feature spec F2 — element picker & candidate discovery (`agent.js`)

### 6.1 Picker interaction

Triggered from the panel ("Pick an element") or MCP (`probe_element`). `agent.js` enters pick mode:

- Cursor: `crosshair` on `<html>` via injected `<style data-mocklab>`.
- On `mousemove` (throttled to rAF): outline the hovered element with the **hover overlay**: an absolutely-positioned `<div>` in a dedicated top-layer container `<div id="__mocklab_overlay__">` appended to `<html>` (NOT `<body>` — avoids site CSS), `position:fixed`, `pointer-events:none`, `z-index:2147483646`. The overlay is a rounded rect (10px radius) with 2px solid accent (#0066FF light / #4A90FF dark by `prefers-color-scheme`) + `rgba(0,102,255,.08)` fill + a small label chip above it showing the element's short name (tag + trimmed text, e.g. `“On time”`). Transition `all 250ms cubic-bezier(0.4,0,0.2,1)` — the SAME motion language as the panel (§9).
- Smart target selection: from the raw `elementFromPoint` target, walk UP while the parent has the same trimmed text content and ≤ 1.4× the area — this picks the semantic "pill" instead of an inner `<span>`. Cap the walk at 4 levels.
- `click` (capture phase, `preventDefault`+`stopPropagation`): confirm selection, exit pick mode, flash the confirm animation (overlay scales 1→1.06→1 in 350ms spring `cubic-bezier(0.34,1.56,0.64,1)`), take the element **snapshot** (§7.3) and fingerprint (§6.2), send both to the SW.
- `Escape` exits pick mode. All listeners use `{capture:true}` and are removed on exit.

### 6.2 Element fingerprint (create + re-resolve)

Create: prefer, in order: `[data-testid]`, `[data-test]`, `[data-qa]`, `id` (if not auto-generated-looking: reject ids matching `/\d{3,}|^:|^ember|^radix|^react/`), `aria-label`, unique class combo (test uniqueness with `querySelectorAll(...).length===1`), else structural path `body > :nth-child(a) > :nth-child(b)…`. ALWAYS also store `textAnchor` and `treePath`.

Re-resolve after a reload: try `css` selector → if exactly 1 match, confidence 1.0. If 0 or >1: candidates = elements whose trimmed text equals `textAnchor` (confidence 0.8, pick the one with closest treePath by common-prefix length); else walk `treePath` (confidence 0.5); else FAIL → binding shows as needing re-verification. Confidence < 0.8 during a probe = abort probe with `element-lost` error (never diff the wrong element).

### 6.3 Candidate discovery (hypothesis generator — runs before any probe)

Input: the picked element's snapshot (its texts + attributes). In the SW, search all `CapturedRequest.body`s of the tab via `findByValue`:

- Needles: the element's full trimmed text; each numeric token in it (`12:40`, `450`, `SAR 450` → `450`); each word ≥ 3 chars. Also try common transforms: number without thousands separators; text lowercased; time strings `HH:MM`.
- Loose match at a leaf: `String(leaf).toLowerCase()` equals / contains needle-lowercased, or numeric equality after parsing.
- Score each hit: exact full-text equality = 1.0; exact numeric = 0.9; substring = 0.5; ties broken by shorter path, then by response recency. Also include **sibling-key heuristic** for enum discovery: if a leaf key looks status-ish (`/status|state|type|code|availability|stock/i`) in a response that ALSO had a full-text hit anywhere, add it with score 0.45 (this is how `"ON_TIME"` gets found when the pill shows localized "On time" text with no verbatim match).
- Output: top 12 candidates `{sigId, path, value, score}` → shown in the panel as "Possible sources" and used as the probe queue, highest score first. If ZERO candidates: tell the user honestly (copy string `pick.noCandidates`, §11) and offer "Check all fields" (exhaustive bisection over every enumerated path of every captured response — §7.5 makes this affordable).

---

## 7. Feature spec F3 — probe verification (the A/B/A protocol). THE core feature.

Runs in the SW (`probe.js`) as an explicit state machine. The panel shows a full-screen progress card during a probe (copy in §11; the user sees "Checking which data controls this element — the page will refresh a few times. Don't click inside the page.").

### 7.1 State machine

```
IDLE → CONTROL_A → CONTROL_B → (noise mask built)
     → per candidate batch (bisection §7.5):
        APPLY(batch) → RELOAD → SETTLE → SNAPSHOT → DIFF?
          changed → recurse into batch halves until single field
          unchanged → discard batch
     → single field found:
        VERIFY_ON  (field mutated)   → element changed?   must be YES
        VERIFY_OFF (field reverted)  → element back?      must be YES (equal to control snapshot)
        [optional 3rd cycle if settings.paranoid]
     → CONFIRMED → persist Binding(state:"verified") → CLEANUP (remove probe Changes, final reload)
Any failure → CLEANUP → report reason
```

Timeouts: each reload+settle capped at 15 s (`probe.timeout` error). Whole probe capped at 3 min. The user can cancel any time (CLEANUP runs; page returns to real state — probe Changes are marked `probe:true` internally and are ALWAYS deleted in CLEANUP even after a crash: on SW startup, delete any Change with `probe:true`).

### 7.2 Control runs & noise mask

CONTROL_A: reload with zero mock Changes; after settle, `agent.js` captures a **page-region snapshot**: for the picked element AND its 30 nearest visible ancestors/siblings (bounded set), record the element snapshot (§7.3). CONTROL_B: reload again, capture again. Every node whose snapshot differs between A and B → added to the **noise mask** (matched by fingerprint). Diffs during probing ignore masked nodes entirely. If the PICKED element itself is in the noise mask → abort with honest error `probe.tooNoisy` ("This element changes on every refresh by itself, so it can't be reliably checked. It may be random/rotating content."). Also derived from control runs: the **request replay check** — if the candidate's signature did not re-occur on reload, that source is fetch-once-per-session; mark candidates from it `probeMode` obstacle and surface copy `probe.notRefetched` (v1 limitation; the Change will still apply next time the request happens).

### 7.3 Element snapshot & diff (`diff.js`)

Snapshot of one element = `{ text: innerText.trim().slice(0,300), attrs: {…all attributes except style/class}, cls: sorted class list, style: computed [color, backgroundColor, borderColor, display, visibility, opacity], childCount, childTexts: first 5 children's trimmed texts (30 chars each) }`. Diff = deep-compare; report which fields differ. "Element changed" = any non-masked difference. Settle definition (`agent.js`): page `load` event fired AND network quiet (no captured request for 500 ms) AND two consecutive `requestAnimationFrame` ticks with no DOM mutations on the watched subtree (via `MutationObserver`) AND minimum 800 ms after load — first met condition set wins after ALL are true; hard cap 8 s then snapshot anyway (flag `settled:false`).

### 7.4 Probe values (domain-aware, critical for correctness)

For a candidate leaf value, the probe replacement must exercise the real rendering path, not an error path:
- Enum-like string (matches `/^[A-Z0-9_]{2,30}$/` or appears in `observedValues` with siblings): use ANOTHER value from `observedValues` if known; else append then try known enum flips from a small dictionary (`ON_TIME↔DELAYED↔CANCELLED`, `IN_STOCK↔OUT_OF_STOCK`, `ACTIVE↔INACTIVE`, `true↔false` styles); else reverse the string case as last resort.
- Number: multiply by 3 and add 7 (visibly different, same magnitude class), keep integer-ness.
- Free text: append `" ●"` (visible glyph, minimal layout shift).
- Boolean: flip. Null: DO NOT probe null-valued candidates (skip, note in results).

### 7.5 Bisection

Candidate queue > 3 → probe in batches: apply the top half of remaining candidates simultaneously (all mutated), one reload; if changed → the driver is inside, recurse into that half; if unchanged → discard the whole half (one reload spent). This gives `O(log n)` reloads. IMPORTANT: batch members must come from ANY sources (multiple signatures fine); "changed" attribution recurses until exactly one field remains, and that single field then goes through the full VERIFY_ON/VERIFY_OFF cycle alone (a batch can never confirm). Multi-field drivers: if singles all fail but batches succeed, report the minimal driving SET (try pairs from the last surviving batch, max 6 pair-probes) → Binding stores multiple paths (extend `path` → `paths[]`? NO — keep model simple: create one Binding per path, both `verified`, panel groups them; the Change editor edits each). Expected cost, honest numbers to show in UI copy: 12 candidates ≈ 2 control + ~4 bisection + 2 verify ≈ 8 refreshes ≈ 25–60 s on a normal site.

### 7.6 Inverse discovery for free

During VERIFY_ON, `agent.js` runs a whole-page lightweight diff (all elements currently on screen with text, sampled: every element with direct text node, max 3000): every non-masked element that changed is recorded into the Binding's `elements[]`. This is how ONE probe discovers ALL elements a field affects → powers feature F4 — highlighting (specified in §10.3) — with proven data.

---

## 8. Feature spec F5 — Deep mode (F4 = highlighting, specified with the panel UI in §10.3) (SSR / document rewriting, `debuggerEngine.js`)

OFF by default. Toggle per-site in Settings ("Deep mode — needed only when a site shows data before any loading happens; shows Chrome's debugging bar"). When ON for an origin:

- `chrome.debugger.attach({tabId}, "1.3")`, `Fetch.enable` with patterns `[{urlPattern:"*", requestStage:"Response", resourceType:"Document"}, {urlPattern:"*", requestStage:"Response", resourceType:"XHR"}, {..."Fetch"}]`.
- On `Fetch.requestPaused` (Response stage): `Fetch.getResponseBody`; for Documents, scan for embedded state: `<script id="__NEXT_DATA__" type="application/json">` (parse, apply matching Changes whose sigId belongs to the special `sigId:"__document__"` namespace, re-serialize), plus generic `window.__INITIAL_STATE__ = {...}` / `window.__NUXT__` assignments (regex-extract balanced JSON via a small scanner, not a naive regex). Then `Fetch.fulfillRequest` with the rewritten body (base64), original status + headers minus content-length. For XHR/Fetch resource types in Deep mode, do NOT double-apply: the MAIN-world patch already handles them — the debugger engine must check a per-tab dedupe set (URL+timestamp) OR simpler: in Deep mode, `interceptor.js` is told to only CAPTURE, never MODIFY, and all modification happens in the debugger engine (single source of truth; this is the implemented rule).
- Document-embedded fields appear in the panel as a data source named "Page's built-in data" with `via:"document"`.
- Detach cleanly on tab close, navigation to a different origin, or toggle off. If DevTools attaches (debugger detach event with reason), show copy `deep.devtoolsConflict`.
- RSC streamed payloads (Next.js App Router flight data): OUT OF SCOPE v1 — detect (`content-type: text/x-component`) and mark such sources visible but read-only with copy `source.streamedUnsupported`. Do not attempt rewriting.


---

## 9. Design system — inherited from the “Swap All Variables (DGA)” Figma plugin

The panel must look and feel like a sibling of Maher's DGA Figma plugin. That plugin's UI is the visual source of truth. Reproduce its tokens and component behaviors EXACTLY as specified here (values were extracted from its `ui.html`).

### 9.1 Tokens — put verbatim at the top of `panel.css`

```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
@import url('https://fonts.googleapis.com/css2?family=Fira+Code&display=swap');

:root {
  --transition-rule: 250ms cubic-bezier(0.4, 0, 0.2, 1);
  --transition-spring: 350ms cubic-bezier(0.34, 1.56, 0.64, 1);

  --gap-l: 1.25rem;  --gap-m: 0.875rem;  --gap-s: 0.5rem;  --gap-xs: 0.25rem;
  --font-size-m: 0.875rem;  --font-size-s: 0.75rem;  --font-size-xs: 0.625rem;
  --radius-m: 0.625rem;  --radius-s: 0.375rem;

  /* Light theme (default) — standalone equivalents of the Figma theme vars */
  --bg: #FFFFFF;           --bg-secondary: #F5F6F8;   --bg-hover: #F0F2F5;
  --bg-tertiary: #E9EBEF;  --bg-inverse: #1E1F24;
  --text: #1E1F24;         --text-secondary: #6B6F76; --text-tertiary: #9AA0A6;
  --text-oninverse: #FFFFFF;
  --border: #E3E5E8;       --border-strong: #C9CDD3;
  --icon: #6B6F76;         --icon-secondary: #9AA0A6; --icon-tertiary: #C9CDD3;

  --accent: #0066FF;       --accent-hover: #0052CC;
  --danger: #D93025;       --bg-danger: #FDECEA;      --border-danger: #F5B7B1;
  --success: #1E8E3E;      --bg-success: #E6F4EA;
  --warning: #B26A00;      --bg-warning: #FFF4E0;

  --shadow-sm: 0 1px 3px rgba(0,0,0,0.06);
  --shadow-md: 0 4px 12px rgba(0,0,0,0.08);
  --shadow-lg: 0 8px 24px rgba(0,0,0,0.12);
  --shadow-button: 0 2px 8px rgba(0,102,255,0.25);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1E1F24;           --bg-secondary: #26272C;   --bg-hover: #2C2D33;
    --bg-tertiary: #33343A;  --bg-inverse: #F5F6F8;
    --text: #F0F1F3;         --text-secondary: #A6AAB1; --text-tertiary: #7A7E86;
    --text-oninverse: #1E1F24;
    --border: #34363C;       --border-strong: #4A4D55;
    --icon: #A6AAB1;         --icon-secondary: #7A7E86; --icon-tertiary: #4A4D55;

    --accent: #4A90FF;       --accent-hover: #5EA0FF;
    --danger: #F28B82;       --bg-danger: #3A2523;      --border-danger: #6B3A35;
    --success: #81C995;      --bg-success: #22372A;
    --warning: #FDD663;      --bg-warning: #3A3323;

    --shadow-sm: 0 1px 3px rgba(0,0,0,0.5);
    --shadow-md: 0 4px 12px rgba(0,0,0,0.6);
    --shadow-lg: 0 8px 24px rgba(0,0,0,0.8);
    --shadow-button: 0 2px 12px rgba(74,144,255,0.5);
  }
}
```

Typography: everything `Inter`, base `var(--font-size-m)`; JSON paths, URLs and values in `'Fira Code', monospace` at `--font-size-s`. `* { box-sizing:border-box; margin:0; padding:0; font-family:'Inter',… }`. Focus: `*:focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:var(--radius-s); }`. Custom scrollbars exactly as the DGA plugin (10px, track `--bg-secondary`, thumb `--border`, radius `--radius-s`).

### 9.2 Component recipes (reuse the DGA behaviors 1:1)

- **Selection cards** (used for data sources & scenarios) = DGA "library-card": `border:1.5px solid var(--border); border-radius:var(--radius-m); padding:1rem; box-shadow:var(--shadow-sm); transition:all var(--transition-rule);` hover → `translateY(-2px)`, `--shadow-md`, border-strong; selected (`:has(input:checked)`) → `box-shadow: 0 0 0 2px var(--accent), var(--shadow-button)` + subtle 135° gradient bg. Card title row: 600 weight + emoji icon; meta row: `--text-secondary`, `--font-size-s`.
- **Segmented control** (the 4 main tabs) = DGA "segmented": container `padding:4px; background:var(--bg-secondary); border:1.5px solid var(--border); border-radius:var(--radius-m);` with a sliding `::before` thumb (white/`--bg` pill, spring transition `var(--transition-spring)`, width `calc(25% - 4px)`). Icons-only labels with tooltips; checked icon animates `scale(1.15) rotate(8deg)` with the DGA `tabSwitch` keyframes; unchecked opacity .5, hover .75.
- **Tooltips** = DGA: inverse bg chip, `--radius-s`, `--shadow-lg`, fade+`translateY(-90%→-100%)` on hover/focus, `--font-size-s`, weight 500, secondary line via nested `<span>` at 65% opacity.
- **Checkbox rows** = DGA: bordered row `1.5px solid var(--border)`, radius m; custom 1.25rem box; checked → accent fill + `checkboxPop` (scale 1→1.2→1, spring) + `checkmarkDraw` (border-width checkmark drawing in 300ms).
- **Primary button** = DGA: full-width, accent bg, white text, weight 600, `--shadow-button` glow, hover `translateY(-2px)` + stronger glow + white 135° gradient sheen via `::before`; active `scale(0.98)`; disabled = darkened accent, no shadow, opacity .7. Loader = the DGA radial-gradient SVG spinner (copy the exact SVG), 1rem, `spin 1s linear infinite` with `scaleX(-1)`.
- **Secondary / danger buttons** = DGA `secondary` and `cancel-button` recipes.
- **Entrances**: container `fadeIn` (300ms, translateY(8px)→0); expanding sections `slideDown` (300ms, translateY(-8px)→0). List rows hover: `translateX(2px)` + shadow-sm, active `scale(0.98) translateX(2px)` — the DGA error-row feel.
- **Status chips** (new, but styled in-family): pill `border-radius:999px; padding:2px 8px; font-size:var(--font-size-xs); font-weight:600;` — Verified `--success` on `--bg-success` with ✓; Possible `--warning` on `--bg-warning` (dashed 1px border); Stale `--text-tertiary` on `--bg-tertiary`; Changed `--accent` on rgba(accent,.12).

Panel min-width 320px, designed for 360–420px. RTL-ready: use logical properties (`margin-inline-start` etc.) everywhere; all strings routed through `strings.js` so Arabic can be added by translating one file.

---

## 10. Panel UI — screen-by-screen (exact structure)

Four tabs in the segmented control (icons + tooltips): **Pick** (crosshair icon) · **Sources** (stacked-list icon) · **Scenarios** (clapperboard icon) · **Settings** (gear icon). Below the tabs, a persistent **site bar**: favicon + hostname + active-changes counter chip ("3 changes on") + "Reset site" text-button (danger color) visible only when count > 0. Extension toolbar badge mirrors the count (`chrome.action.setBadgeText`, accent bg).

### 10.1 Pick tab (default, the hero flow)

- State A (idle): illustration-free, calm. H2 `pick.title` "What do you want to change?", body `pick.body` "Click the button, then click anything on the page — a price, a status, a name. MockLab will find the data behind it." Primary button `pick.cta` "Pick an element" (crosshair icon). Below: last 3 verified Links for this site as selection cards (chip Verified ✓, element text, current value, chevron) → tapping opens the editor (State D).
- State B (picking): button becomes disabled with `pick.picking` "Click something on the page… (Esc to cancel)"; panel dims 60%.
- State C (candidates + probe): after the click, show the picked element (mini card: its text + a live thumbnail is out of scope — text only) and "Possible sources" list (max 12 rows: friendly source name (§10.2 naming), the matched value in Fira Code, score-ordered). Primary button `probe.cta` "Find the real source" starts the probe → full-panel progress card: spinner (DGA radial), step text that updates (`probe.step.control` "Learning what changes on its own…", `probe.step.testing` "Testing {n} possibilities…", `probe.step.confirming` "Double-checking…"), a reload counter ("refresh 4 of ~8"), and a Cancel (danger) button. NEVER let the user think it's stuck: every state change updates the line.
- State D (result / editor): success card `probe.found` "Found it — this element is controlled by:" + source name + field chip (Advanced shows raw path) + **the value editor**: if `observedValues` ≥ 2 → segmented value picker of those values + "Custom…"; else typed input (number/text/toggle per value type). Below, live affected-elements note: "This change affects **{k} places** on the page — [Show me]" (hover/press → highlight overlays, §10.3). Primary button `editor.apply` "Apply & refresh page". After apply: toast `editor.applied` "Done. The site now sees your value." + "Save as Scenario" ghost button. Failure card variants: `probe.noneConfirmed` (honest: "None of the possibilities actually control this element. It may be built into the page's code rather than loaded data.") with "Check all fields (slower)" secondary action; `probe.tooNoisy`; `probe.elementLost`.

### 10.2 Sources tab

Search field (filters). List of selection cards, one per captured signature, friendly-named: derive from URL path (`/api/flight/status` → "Flight status", title-cased last meaningful segments; GraphQL → operationName spaced) + meta row: "{n} fields · just now / 2 min ago" + chips: Changed (if any Change targets it), "Page's built-in data" for document sources. Clicking a card → **response tree view**: collapsible JSON tree (keys Inter 500, values Fira Code; strings green-ish `--success`, numbers accent, booleans warning; max initial depth 2). Each scalar row: hover reveals two icon-buttons — ✏️ "Change this value" (opens the same editor as 10.1D; a Change created here without a probe is applied but its binding stays `candidate` — chip "not verified, will still apply") and ◎ "Show on page" → if a verified Binding exists for the path, highlight its elements; else run **soft-highlight**: value-search the rendered DOM for the value text and pulse dashed outlines (clearly labeled `highlight.guess` tooltip "Best guess — not verified"). Rows with active Changes show original → new value strikethrough style and a per-row toggle + trash.

### 10.3 Highlight overlays (on-page)

Verified: solid 2px accent rounded outline + accent label chip (field name), pop-in with spring scale, auto-dismiss after 4 s or on scroll+click. Guess: dashed amber outline, same geometry. Multiple elements: stagger pop-ins 60ms apart (feels alive, DGA-like). All overlays in `#__mocklab_overlay__`, `pointer-events:none`, cleaned on navigation.

### 10.4 Scenarios tab

Grid of scenario cards (emoji + name + "{n} changes" meta + Apply primary-mini button + ⋯ menu: Rename, Duplicate, Export file, Delete[danger]). Top: "New scenario from current changes" primary button (disabled with tooltip when 0 active). "Import" secondary (file picker, `.mocklab.json`). Applying: applies all changes + refresh + toast; a scenario whose signatures no longer match anything → card shows Stale chip + `scenario.stale` copy ("This site seems to have changed since this was saved. Changes may not apply."). Export format = the Preset JSON (§4) pretty-printed, extension `.mocklab.json`.

### 10.5 Settings tab

Checkbox rows (DGA style): "Advanced mode — show technical details (URLs, fields, signatures)"; "Extra-careful checking — verify twice (slower, for flaky pages)" (`paranoid`); "Deep mode for this site" with the warning copy + Chrome-bar note; Companion section: status dot (green "Connected — AI agents can control this site" / gray "Not connected") + "Set up AI access" → shows one copy-paste command + the pairing code flow (§12.4); Danger zone: "Reset this site" / "Reset everything".

### 10.6 State visuals summary

Verified ✓ chip = success colors, solid. Possible = warning, dashed border. Stale = gray. Changed = accent. These four chips are the ONLY status vocabulary in the entire UI.

---

## 11. Copy table (`strings.js`) — ship these exact strings (en)

```js
export const S = {
  tab: { pick:"Pick", sources:"Sources", scenarios:"Scenarios", settings:"Settings" },
  site: { changes:(n)=>`${n} change${n===1?"":"s"} on`, reset:"Reset site",
          resetConfirm:"Remove all changes on this site and refresh?" },
  pick: {
    title:"What do you want to change?",
    body:"Click the button, then click anything on the page — a price, a status, a name. MockLab will find the data behind it.",
    cta:"Pick an element", picking:"Click something on the page… (Esc to cancel)",
    recent:"Recent links on this site",
    noCandidates:"MockLab couldn't find this text in any data the page loaded. It may be part of the page's design, an image, or loaded in a way MockLab can't see yet.",
    checkAll:"Check all fields (slower)" },
  probe: {
    cta:"Find the real source",
    intro:"MockLab will refresh the page a few times to test what controls this element. Takes about half a minute. Don't click inside the page while it runs.",
    step: { control:"Learning what changes on its own…", testing:(n)=>`Testing ${n} possibilities…`,
            confirming:"Double-checking…", cleanup:"Putting everything back…" },
    reloads:(i,n)=>`refresh ${i} of ~${n}`, cancel:"Stop checking",
    found:"Found it — this element is controlled by:",
    affected:(k)=>`This change affects ${k} place${k===1?"":"s"} on the page`, showMe:"Show me",
    noneConfirmed:"None of the possibilities actually control this element. Its content may be built into the page itself rather than loaded as data.",
    tooNoisy:"This element changes by itself on every refresh (like rotating or random content), so it can't be reliably checked.",
    elementLost:"The element couldn't be found again after refreshing. The page may change its layout on every load.",
    notRefetched:"This data only loads once per visit, so changes will show up the next time the site asks for it — not on a simple refresh.",
    timeout:"The page took too long to settle. Try again, or close other heavy tabs." },
  editor: {
    title:"Change the value", custom:"Custom…", original:(v)=>`Real value: ${v}`,
    apply:"Apply & refresh page", applied:"Done. The site now sees your value.",
    unverified:"Not verified — the change will still apply, but MockLab hasn't proven which elements it affects.",
    saveScenario:"Save as Scenario" },
  sources: {
    title:"Data this page loaded", empty:"Nothing captured yet. Refresh the page with MockLab open.",
    builtin:"Page's built-in data", streamedUnsupported:"This data arrives as a stream MockLab can't edit yet.",
    changeValue:"Change this value", showOnPage:"Show on page",
    guessHighlight:"Best guess — not verified", fields:(n)=>`${n} fields` },
  scenarios: {
    title:"Scenarios", new:"New scenario from current changes", import:"Import",
    empty:"Save your current changes as a scenario to reuse them any time.",
    apply:"Apply", applied:(name)=>`“${name}” applied.`,
    stale:"This site seems to have changed since this was saved. Some changes may not apply.",
    namePrompt:"Name this scenario", deleteConfirm:(name)=>`Delete “${name}”?` },
  chips: { verified:"Verified ✓", candidate:"Possible", stale:"Stale", changed:"Changed" },
  deep: {
    label:"Deep mode for this site",
    help:"Only needed when a site already shows data the moment it opens. Chrome will show a bar saying the browser is being debugged — that's MockLab, and it's normal.",
    devtoolsConflict:"Deep mode paused: Chrome DevTools is open on this tab. Close DevTools to resume." },
  companion: {
    connected:"Connected — AI agents can control this site", disconnected:"Not connected",
    setup:"Set up AI access", pairTitle:"Pair with your AI",
    pairBody:"Run this once in your terminal, then enter the 6-digit code it prints:",
    pairPlaceholder:"6-digit code", paired:"Paired. Agents can now see and change data through MockLab." },
  errors: { pageBroke:"Something went wrong talking to this page. Refresh it and try again.",
            storageFull:"MockLab's local storage is full. Delete old scenarios in Settings." }
};
```

Rules for any string not listed: sentence case, no exclamation marks except `applied` moments, never blame the user, always say what to do next, never use: JSON, API, endpoint, payload, regex, DOM, probe, binding, signature (those words may ONLY appear when Advanced mode is on).


---

## 12. Companion daemon + MCP server

### 12.1 Process & transports

`npx mocklab-companion` (package `companion/`, bin entry). Default: starts (a) WebSocket hub on `ws://127.0.0.1:8517/ext` for the extension, (b) MCP over **stdio** when launched by an MCP client, and (c) MCP over Streamable HTTP on `http://127.0.0.1:8518/mcp` always, (d) static demo site at `http://127.0.0.1:8517/demo/`. Claude Code registration the README shows: `claude mcp add mocklab -- npx mocklab-companion --stdio`.

### 12.2 Extension ⇄ hub protocol

JSON frames `{id, kind:"req"|"res"|"event", op, payload}`. The hub keeps ONE extension connection (newest wins). Every MCP tool call → `req` to the extension → SW executes → `res` back (30 s timeout → MCP error "extension not responding — is Chrome open with MockLab installed?"). Events pushed extension→hub: `storeChanged`, `captured` (throttled 2/s) — the hub caches the latest store per origin so read-only MCP tools answer instantly even mid-navigation.

### 12.3 Pairing (security — do not skip)

First run, the companion generates a random 32-byte hex token, stores it at `~/.mocklab/token`, and prints a 6-digit code. The extension's Settings → "Set up AI access" asks for the code; on match (code = first 6 digits of sha256(token) mod 10^6, single active pairing window of 5 min), the companion sends the full token over the local WS; the extension stores it and includes it in every subsequent connection handshake (`Authorization: Bearer` header on the WS upgrade). Hub binds to 127.0.0.1 ONLY. Reject any origin-header that is not the extension's `chrome-extension://` origin or absent.

### 12.4 MCP tools (define with these exact names, descriptions, and JSON Schemas)

Every tool that targets a page takes `tabId` (from `list_tabs`); every mutation defaults `refresh:true`. All responses are JSON. Errors are MCP tool-errors with the honest reason strings from §11 where applicable.

1. `list_tabs` — `{}` → `[{tabId, url, title, origin, active, changesCount, deepMode}]`. Only tabs where MockLab has a live content-script connection.
2. `list_sources` — `{tabId}` → `[{sigId, name, method, urlPattern, gqlOperation?, via, fields, lastSeenTs, mocked}]` (name = the same friendly name the panel shows).
3. `get_response` — `{tabId, sigId, path?}` → `{body}` (whole parsed body, or the subtree at `path`). Bodies > 200 KB: return `{truncated:true, topLevelKeys, hint}` unless `path` narrows it.
4. `search_value` — `{tabId, needle}` → candidate list `[{sigId, path, value, score}]` (the §6.3 engine, exposed raw).
5. `probe_element` — `{tabId, selector?, text?}` (one required; `text` = find visible element by exact trimmed text) → runs the FULL probe protocol → `{binding:{sigId, path, state:"verified", elements:[{css,textAnchor}], observedValues}}` or `{error, reason}`. Long-running: send MCP progress notifications at each state change.
6. `get_bindings` — `{tabId | origin}` → all Bindings with states.
7. `set_value` — `{tabId, sigId, path, value, note?, refresh?:true}` → creates/updates a Change → `{applied:true, changeId, refreshed}`.
8. `clear_changes` — `{tabId, changeId? }` (absent id = all for origin) → `{cleared:n, refreshed}`.
9. `highlight` — `{tabId, sigId, path}` → flashes overlays → `{elements:n, verified:boolean}`.
10. `list_presets` — `{origin?}` → Scenario summaries. 11. `apply_preset` — `{tabId, presetId, refresh?:true}`. 12. `save_preset` — `{tabId, name, emoji?}` (snapshots current enabled Changes). 13. `delete_preset` — `{presetId}`.
14. `screenshot` — `{tabId, fullPage?:false}` → `{image: base64 png}` via `chrome.tabs.captureVisibleTab` (activate the tab first; fullPage v1 = visible viewport only, document the limitation).
15. `reload` — `{tabId, waitForSettle?:true}` → resolves after the §7.3 settle definition → `{settled}`.

Agent happy-path (put this in the MCP server's top-level `instructions` string): `list_tabs → list_sources → search_value("On time") → set_value(...,"CANCELLED") → reload → screenshot` — and for guaranteed correctness `probe_element` first, then edit its verified binding.

---

## 13. README install flow (write it for a non-technical user)

Three numbered steps with screenshots placeholders: (1) Load the extension: chrome://extensions → Developer mode → Load unpacked → the `extension/` folder. (2) Pin MockLab, open any site, click the icon. (3) Optional AI setup: install Node from nodejs.org, run the one command, enter the code. Include a "Try it safely first" box pointing to the bundled demo (`npx mocklab-companion` → open `http://127.0.0.1:8517/demo`).

## 14. Bundled demo site (the acceptance harness — build it FIRST)

Static page styled like a minimal airline trip card (Inter, one card, status pill, price, times, passenger name, a "rotating tip" box that changes every load = deliberate noise). `app.js`: `fetch('./api/trip.json')` then renders: pill text+color from `status` (`ON_TIME`→green "On time", `DELAYED`→amber, `CANCELLED`→red + a red banner "Your flight was cancelled" appears), price from `price.total` with FE-computed `+ taxes` line (derived value!), times formatted from ISO strings (derived!). Also a second fetch `./api/user.json` → name chip. This page deterministically exercises: enum→color mapping, multi-element effects (pill + banner), derived values, noise masking, two sources. Every milestone's acceptance tests run against it.

## 15. Known limitations to document honestly (README + Settings footer)

iframes (v1 top frame only) · WebSocket/SSE data (visible in Sources as read-only later, not v1) · streamed RSC documents (§8) · sites that fetch once per session (copy `probe.notRefetched`) · Firefox/Safari (Chromium only) · protobuf/binary responses (shown as "can't edit this format") · full-page screenshots.

---

## 16. Build order — 7 milestones, each with Definition of Done

Work strictly in order; do not start a milestone before the previous DoD passes on the demo site.

- **M0 Scaffold + demo site.** Repo per §2.1, manifest loads with zero console errors on chrome://extensions, demo runs. DoD: `npm test` green (empty suites ok), demo renders all states by hand-editing trip.json.
- **M1 Capture.** interceptor+agent+SW pipeline, Sources tab lists both demo sources with friendly names; tree view renders. DoD: open demo → 2 sources appear ≤ 1 s after load; no duplicate captures on SPA nav; a site with 50+ requests (open a news site) stays smooth.
- **M2 Changes engine.** Edit from tree view, apply & refresh, badge, reset, persistence. DoD: set `status=CANCELLED` in tree → refresh → demo pill is red WITHOUT any probe; change survives 10 refreshes; Reset site restores; signature test suite green (≥ 15 normalization cases).
- **M3 Picker + candidates.** Pick mode, overlays, fingerprints, candidate list. DoD: picking the demo pill lists `status` among top-3 candidates via sibling-key heuristic (pill text "On time" ≠ "ON_TIME" — this MUST work); picking the price finds `price.total` by numeric match.
- **M4 Probe.** Full state machine incl. control runs, noise mask, bisection, A/B/A, inverse discovery, cleanup-on-crash. DoD on demo: pill probe → verified binding for `$.status` in ≤ 8 reloads, elements[] contains BOTH pill and banner; rotating-tip box lands in noise mask (probe a candidate that matches its text → honest `tooNoisy`); cancel mid-probe leaves site clean (0 probe changes in storage).
- **M5 Highlight + Scenarios.** Overlay system, scenarios CRUD, import/export, stale detection. DoD: "Show me" highlights pill+banner with stagger; export→delete→import round-trip; corrupt import file → friendly error.
- **M6 Companion + MCP.** Hub, pairing, all 15 tools, progress notifications. DoD: from Claude Code, the full agent happy-path on the demo returns a screenshot with a red pill; kill Chrome mid-call → clean MCP error; wrong pairing code → rejected.
- **M7 Deep mode + polish.** Debugger engine, `__NEXT_DATA__` rewrite (add a `demo/ssr.html` variant embedding the JSON in the document to test), a11y pass (every control keyboard-reachable, WCAG 2.2 AA contrast on all four chips in both themes, `prefers-reduced-motion` disables spring/pop animations), RTL smoke test, icon set, zip script.

## 17. Instructions to the implementing AI (failure-mode vaccine — obey literally)

1. NEVER try to modify response bodies with `chrome.webRequest` or `declarativeNetRequest` — MV3 cannot. Only the MAIN-world patch and CDP Fetch can.
2. `interceptor.js` MUST be dependency-free, wrapped in try/catch, and must return the ORIGINAL Response object when no change matches.
3. Do not compute hashes in the MAIN world; sigIds come only from `signatures.js` in the SW.
4. Never mark a Binding `verified` outside the probe CONFIRMED state. Grep-test yourself: the string `state: "verified"` may appear in exactly one assignment in the codebase (probe.js).
5. Always delete `probe:true` Changes in CLEANUP and on SW startup.
6. Every user-visible string comes from `strings.js`. Adding a literal string in panel.js is a bug.
7. Use the design tokens; never hardcode a color hex outside `panel.css` `:root` blocks.
8. All async messaging uses the constants in `messages.js`; no magic strings.
9. Test each milestone against the demo site before proceeding; the DoD lists are the acceptance tests.
10. Keep files under ~500 lines; split when bigger. No frameworks, no bundlers, no TypeScript compilation, no external runtime deps in the extension (companion may use only `@modelcontextprotocol/sdk` and `ws`).
11. If a Chrome API behaves differently than described here, prefer the working behavior, note it in README's "Deviations" section — do not silently restructure the architecture.
12. When in doubt about UX: the calmer, more honest option wins. The product's brand is certainty — a wrong "Verified ✓" is the worst bug the product can have, worse than a crash.
