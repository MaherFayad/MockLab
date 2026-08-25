# MockLab build log

One entry per milestone (PLAN.md §16): what was built, the QA verdict, and any
deviation from the specification. Deviations are also recorded in README
"Deviations" as PLAN.md §17.11 requires.

---

## M0 — Scaffold + demo site

**Built by:** orchestrator (main loop). Mechanical, and it defines the file tree every
agent depends on.

**Delivered**

- Repository tree exactly per PLAN.md §2.1, plus `.gitignore` and `BUILD_LOG.md`.
- Root `package.json` with `extension` + `companion` workspaces and the `test` / `zip`
  scripts from §2.1.
- `extension/manifest.json` written verbatim from PLAN.md §3, plus the `sidePanel`
  permission the spec omits (Deviation 1 — see the QA verdict below).
- `extension/icons/{16,32,48,128}.png` — a white flask on an accent-blue (`#0066FF`)
  rounded square, generated from pixel data with `node:zlib` so there is no image
  dependency and no build step. Legible at 16px.
- Module skeletons for every file in §2.1, each carrying an owner header and the hard
  rules that apply to it, so no import path moves later in the build.
- `background.js` already honours §17.5: `probe:true` Changes are swept on every
  service-worker startup, so a crash mid-probe can never leave a site silently mocked.
- **Demo site (§14)** — the acceptance harness, built first and fully working:
  fake airline trip card with status pill, price rows, times, passenger chip, and a
  deliberately noisy rotating tip box.
- `companion/src/index.js` serves the demo on `http://127.0.0.1:8517/demo/` with
  `cache-control: no-store`, loopback binding only, and path-traversal refusal.
- `.github/workflows/ci.yml` runs `npm test -ws` and validates the manifest parses.
- `README.md` — non-technical three-step install (§13) plus the honest limitations
  list (§15) and the Deviations table (§17.11).

**Demo site verification** (headless Chromium, all three states by editing `trip.json`):

| `status` | pill text | pill colour | banner |
|---|---|---|---|
| `ON_TIME` | "On time" | green `rgb(30,142,62)` | hidden |
| `DELAYED` | "Delayed" | amber `rgb(178,106,0)` | shown |
| `CANCELLED` | "Cancelled" | red `rgb(217,48,37)` | shown |

Console errors in all three states: **zero**. Derived values confirmed rendering from
data rather than copied out of it: `12:40` formatted from `2026-09-04T12:40:00Z`, and
`SAR 58.70` taxes computed from `price.total` 450 and `taxRate` 0.15 — neither string
exists in the response, which is what makes the demo a real test of §6.3 candidate
discovery. The rotating tip box produced different text on two consecutive reloads in
one session, so §7.2 noise masking has something real to mask.

**Tests:** `npm test -ws` — extension 3/3 pass, companion 5/5 pass.

**QA verdict:** FAIL on first pass -> fixed -> **PASS** on re-verification (commit `a73aa41`).

The verifier loaded the unpacked extension in real Chromium and found one blocking
defect plus five smaller ones. All are fixed:

- **B1 (blocking) — the side panel could never open.** `chrome.sidePanel` is gated on a
  `"sidePanel"` permission that **PLAN.md §3's manifest omits**. Our manifest was
  byte-identical to §3, so the spec itself carried the bug. Worse, `background.js` used
  `chrome.sidePanel?.setPanelBehavior(...)`: optional chaining short-circuited to
  `undefined` without throwing, so the feature was dead while `chrome://extensions`
  stayed clean and the DoD line "loads with zero console errors" passed. Fixed by
  adding the permission (§17.11: prefer the working behaviour) and by replacing the
  optional chain with an explicit `if (chrome.sidePanel)` that logs loudly otherwise.
  Re-verified in Chromium: `typeof chrome.sidePanel === "object"`, permission granted,
  `setPanelBehavior` resolves.
- **D2 — the demo console was not actually clean.** Chrome's automatic `/favicon.ico`
  request 404'd on every load, putting a red error in the console that every later
  milestone would be judged in. The server now answers `204`. Re-verified: zero console
  errors on the demo with the extension loaded.
- **D3 — `panel.css` is not yet the §9.1 verbatim token block.** Correct, and not an M0
  item: panel styling is M2. Carried into M2's acceptance below so it cannot be lost.
- **D4 — two §14 divergences were unrecorded.** The `DELAYED` banner and the gate number
  in the tip box are deliberate and useful, but §17.11 means they belong in the table.
  Added as Deviations 4 and 5.
- **D5 — no lockfile.** `package-lock.json` is now committed and CI uses `npm ci`.
- **Deviation "node --test needs a glob" was retracted, not documented.** The verifier
  showed that bare `node --test` — the exact form §2.1 specifies — works fine; only
  `node --test test/` fails. Both workspaces reverted to the spec form. A deviation
  record is only worth anything if it is true.

**Deviations:** 6 — see README "Deviations".

**Carried into M2 (do not lose):** `panel.css` must become the §9.1 token block
verbatim, including both `@import` font rules and the `--accent` focus ring.

**Contract note for M1 (§17.2 vs §17.8).** These two rules pull against each other:
§17.2 forbids imports in `interceptor.js`, but §17.8 forbids magic strings. MAIN-world
scripts have no module graph, so `interceptor.js` **cannot** import `MOCKLAB_TAG` or
`TOKEN_ATTRIBUTE` from `messages.js`. It must duplicate those two literals with a
comment pointing back at `messages.js`. Nobody should "fix" this by adding an import —
that silently breaks the MAIN-world patch.

**§17.5 is proven end-to-end, not statically.** The verifier planted three Changes in
`chrome.storage.local` (two `probe:true`, one real), closed the browser, and relaunched
against the same user-data directory to force a genuine cold service-worker start. Both
probe Changes were swept, the real Change survived, and the service-worker console was
empty. The module-top-level call in `background.js` — not the `onStartup` listener — is
what does that work, which is the case that matters after a crash.

**Automated end-to-end testing is available.** Playwright can load the real unpacked
extension (`launchPersistentContext` + `--load-extension`), and the MV3 service worker
boots and is evaluable. Every later milestone can therefore be acceptance-tested against
the genuine interceptor and service worker rather than mocks. Real websites are NOT
reachable from the build sandbox (the network policy refuses all outbound hosts), so
real-OTA verification stays a human manual step.

---

## M1 — Capture

**Built by:** interceptor-engineer.

**Scope note.** M1 delivers the whole data pipeline up to and including the service
worker holding correctly-named `CapturedRequest`s, plus the messages the panel calls to
read them. The Sources **tab UI** (tree view, card rendering) is panel-designer's file
and lands at M2; nothing under `extension/src/panel/**` was touched.

**Delivered**

- `extension/src/content/interceptor.js` — the MAIN-world patch (§5.1). Dependency-free
  IIFE, everything in try/catch, originals saved first. Patches `fetch` and
  `XMLHttpRequest`, captures both, applies matching Changes, and reports raw
  method/url/body-keys outward. Computes no hashes (§17.3) and walks pre-parsed
  JSONPath token arrays the worker hands it, so no path parser lives in the page.
- `extension/src/content/agent.js` — **M1 portion only**: token minting, the
  MAIN⇄ISOLATED relay, and the lazily-reconnecting Port to the service worker. The file
  ends with an explicit marker block reserving §6/§7 (picker, overlays, snapshots) for
  probe-engineer at M3.
- `extension/src/background/messages.js` — every message constant and the §4 typedefs.
- `extension/src/background/signatures.js` — §5.2 normalization, `friendlyName()` (one
  implementation shared by the panel and the MCP `list_sources` tool so the two can
  never drift), and `compileMatchList()`.
- `extension/src/background/ruleStore.js` — storage schema and CRUD, with a per-key
  write lock (see "Bugs found by the real browser" below).
- `extension/src/shared/jsonpath.js` — the §5.4 subset: `parsePath`, `formatPath`,
  `joinPath`, `getByPath`, `setByPath`, `enumeratePaths`, `findByValue`.
- `extension/src/background/background.js` — M1 wiring only. The M0 `sidePanel` block
  and the module-top-level `probe:true` startup sweep are untouched, byte for byte.

**Tests:** `npm test -ws` — extension **77/77**, companion **5/5**.
31 signature normalization cases (§5.2 requires ≥ 15) and 45 JSONPath cases (§5.4
requires ≥ 30, including unicode keys, keys containing dots round-tripping through the
bracket form, and arrays of objects).

**M1 DoD, proved in real Chromium** with the real unpacked extension loaded via
`launchPersistentContext` and asserted from a real extension page (the worker cannot
`sendMessage` to itself, so the proof uses the same API the panel will):

| §16 M1 DoD | Result |
|---|---|
| open demo → 2 sources appear ≤ 1 s after load | **91 ms**, exactly 2 |
| both demo sources named | `Trip` (`via:"fetch"`) and `User` (`via:"xhr"`) |
| bodies parsed | `$.status === "ON_TIME"`, `$.user.displayName === "Nora Al-Amri"`, `$.price.total === 450` via a path query |
| no duplicate captures on SPA nav | 5 `pushState` navigations + 5 refetches → still exactly 2 sources, same two sigIds; `softNavs = 5` |
| full reload | still exactly 2 sources, soft-nav counter reset |
| a site with 50+ requests stays smooth | 60-request page → 60 distinct sources, 60 parallel fetches in 145 ms, no page errors |

Measured overhead, extension **off vs on**, median of 5 / 3 runs: demo time-to-render
49 ms → 55 ms; 60 parallel fetches 344 ms → 297 ms (inside run-to-run noise).

Also proved end to end, because the capture side is worthless if the other half is
broken: a planted Change makes the **site itself** re-render (`ON_TIME` → pill text
"Cancelled", the site's own `is-cancelled` class, and the derived banner — no DOM
editing); a second Change on the same source applies too; the XHR `responseText`
override reaches the site; the captured body still holds the **real** value with
`mocked: true`; disabling every Change restores the real site. Consoles clean
throughout — page, service worker, and the 60-request stress page.

**The trip.com vectors, proved on a live page.** A test server shaped like the product
owner's target (`/hotels/detail/` → `/api/hotel?...&masterhotelid_tracelogid=…`
regenerated per load, plus a fresh `hoteluniquekey` blob and `subStamp`) produces **one**
source with an identical `sigId` across loads, and a Change created on load 1 still
applies on load 2 with a brand-new trace id — and follows the user to a different
`hotelId`. Without the §5.2 extension below, each load would have minted a new `sigId`
and the product would have done nothing on the exact page it exists to demo.

**Bugs found by the real browser (not by the unit tests)**

1. **Lost update in `chrome.storage.local`.** Two captures landing together each did
   `get` → mutate → `set` on `signatures:<origin>`; the second write silently discarded
   the first. About one page load in twenty stored only one of the demo's two
   signatures, and a Change against the lost one stopped applying with no error
   anywhere — the worst kind of bug this product can have. Fixed with a per-key promise
   chain around every read-modify-write in `ruleStore.js`. 20/20 clean afterwards.
2. **Responses arriving before the match list.** The match list is pushed in from the
   worker, which takes a few milliseconds — long enough that a page firing data requests
   at `document_start` gets its response back before any Change is known. The demo's XHR
   consistently lost this race. Fixed by holding only the *first* requests of a page load
   until the list lands, capped at 1000 ms (Deviation 10).
3. **The agent replayed an empty placeholder match list**, which opened that gate early
   and let the first responses through unmocked. Now only a list the worker actually
   sent counts.
4. **Time-throttled soft-nav reporting dropped real navigations** (2 of 5 reported).
   Now collapsed by URL instead of by clock, so repeated `replaceState` at the same URL
   is still absorbed but every genuine URL change is reported.

**Interpretation recorded, not a deviation:** a `CapturedRequest.body` holds the
**original** response, with `mocked: true` beside it, when a Change applied. §4 does not
say which. Keeping the real body is what lets §10.2 show "original → new" and what gives
`Change.originalValue` something true to hold.

**Contract note extended.** M0's §17.2-vs-§17.8 note covers `interceptor.js`. It applies
to `agent.js` too: content scripts are classic scripts, `import` is a syntax error there,
and dynamic `import()` of an extension URL would require adding `messages.js` to
`web_accessible_resources` — exposing it to every page. Both content scripts therefore
carry a clearly-marked mirrored-literals block, and `messages.js`'s header names both
files. Do not "fix" either with an import.

**Deviations:** 6 new (7–12) — see README "Deviations".
