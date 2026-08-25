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

**Deviations:** 11 new (7–17) — see README "Deviations".

### M1 QA round 2 — FAIL → fixed

Adversarial verification in real Chromium reproduced every DoD bullet independently
(2 sources in 131 ms, no duplicates across 5 soft navs, 60 distinct sources, a planted
Change re-rendering the site with its own `is-cancelled` class, the original-Response
guarantee proven through the unforgeable `type`/`url` fields, stable trip.com sigIds),
re-proved the §17.5 cold-restart sweep, and confirmed every mirrored constant is
byte-equal to `messages.js`. It also found two defects worth the whole exercise.

**D1 (blocking) — MockLab froze every streaming page.** `isTextual()` admitted
`text/event-stream` through its `text/` prefix, and `handleFetchResponse` awaited
`clone.text()` before handing the Response back. `response.bodyUsed` is always `false`
at that moment, so §5.1.4's streaming guard could never fire. An open Server-Sent
Events fetch therefore **never resolved**: any live ticker, chat view or streaming-SSR
page was permanently stuck — on every site, with zero Changes configured, merely by
having MockLab installed. Measured on the same page, extension off vs on:
`text/x-component` took 3 ms → 1506 ms (exactly the stream's duration), and SSE never
rendered at all within 5 s.

Fixed in two independent layers, because either one alone would have left a hole:

1. **Match first, buffer second.** Matching needs the method, the URL and the *request*
   body — never the response body. So `findChanges()` now runs before anything is read:
   when nothing matches, the ORIGINAL Response goes back to the page immediately and the
   clone is read afterwards purely to fill the Sources list. With no Changes configured —
   the state every page is in most of the time — MockLab now adds no latency to any
   response at all.
2. **Streamed content types are never read and never cloned.** `text/event-stream`,
   `text/x-component`, `x-ndjson`, `stream+json` and `multipart/*` are captured
   metadata-only per §5.1.4, so they stay visible in Sources as read-only.
   Both read paths also carry a deadline, so a body that never ends can strand neither
   the page nor the capture. **Correction (round 3, D8):** this section originally
   claimed the deadline "cancels the clone's stream". It did not — the cancel could not
   work at all, and the attempt leaked a rejection onto the page. See D8 below for what
   was actually happening and what the deadlines are now.

Proved with a new regression harness that measures the same page with the extension off
and on. **On the fixed build** (three runs, re-measured after round 3): SSE first chunk
13-14 ms → 43-49 ms and the stream keeps flowing; `text/x-component` headers ~110 ms →
~145 ms; binary 12 ms → 45 ms. The ~33 ms delta is deviation 10's one-time match-list
wait — it is identical on the binary response MockLab never reads, which is what shows
it is not a streaming stall. **On a deliberately re-broken copy of the build,
the same harness reproduces the original defect exactly:** SSE never resolves and RSC
takes 1527 ms. The test is a real guard, not a rubber stamp.

**D3 (medium) — a silently non-applying Change.** `urlPattern` carried DECODED query
values, so a kept param containing a literal `&` (`?q=a%26b`) became `q=a&b`, and
`compileMatchList` read it back as two params. The compiled entry could then never match
the very URL it was derived from: no error, no warning, the user's edit simply did
nothing — precisely the silent lie §1 forbids. Query names and values are now
percent-encoded into `urlPattern` (`*` stays bare as the volatile sentinel; a literal `*`
becomes `%2A`), and decoded back out when compiling. The in-page matcher was also
matching repeated param names with `searchParams.get()`, which only ever sees the first
value, so `?tag=red&tag=blue` could not match either; it now matches as a multiset.
Locked down by a general invariant test — *a compiled entry must match the URL its
signature came from* — over 15 URL shapes including encoded `&`, encoded `=`, unicode
values, `+`-as-space, repeated names, empty values, a literal `*`, and the full
sa.trip.com vector. Proved in the browser too: a Change on `?q=a%26b&tag=red&tag=blue`
applies.

**Smaller items, all fixed.** D4 — failed and aborted XHRs (`status 0`) no longer appear
in Sources as empty entries. D5 — `/api/58` used to be named "58"; bare-number segments
are now treated as ids, and when a path holds nothing meaningful the friendly name falls
back to the host rather than to an id or to "Api" (PLAN.md §1.2's zero-jargon
rule; the banned word list is in §11's closing note).
D6 — the delimited-token rule now applies to single-word names too, so a bare
`tracelogid` and an `x_tracelogid` are treated alike. D7 — README deviation 11 now reads
"866 lines (644 code)" — the file length §17.10 actually talks about, not just the code
count — and gives the real reason the file cannot be split: the manifest
*would* accept several MAIN-world `js` entries, but they share the page's global scope,
so splitting would publish the match list and patch internals on `window` where a hostile
page could rewrite them. The §5.1.3 XHR-mechanism divergence the verifier flagged as
undocumented is now deviation 13.

**Re-verified after round 2:** `npm test -ws` — extension 81/81, companion 5/5, plus
Chromium end-to-end runs. Those browser runs lived in a scratch directory, which round 3
correctly called out as worthless to anyone else — see D10 below.

### M1 QA round 3 — FAIL → fixed

Round 3 confirmed the round-2 fixes independently (SSE 6 ms → 31 ms and still flowing,
RSC 3 ms → 3 ms, ~0.7 ms median overhead when nothing matches, all hostile URL shapes
applying against the real interceptor, §17.5 re-proved) and found three more things,
one of which was a claim in this file that was not true.

**D8 (blocking) — MockLab never released a stream, and leaked a rejection onto the page.**
`readWithDeadline` documented "on timeout the clone's stream is cancelled". It did not.
`clone.text()` LOCKS the body, so `clone.body.cancel()` returns a **rejected** promise;
the rejection escapes the surrounding try/catch because it happens out of band. Two
consequences, both reproduced here against an endless `text/plain` response (which is
deliberately not on the streaming content-type list, so only this path can release it):

| | page let go | socket closed | chunks written | site-visible unhandledrejections |
|---|---|---|---|---|
| extension off | 116 ms | **yes, 105 ms** | 1 | none |
| before the fix | 118 ms | **no — still open after 12 s** | 121 | `TypeError: Failed to execute 'cancel' on 'ReadableStream': Cannot cancel a locked stream` |
| after the fix | 116 ms | **yes, 1605 ms** | 16 | none |

Any site running Sentry, Datadog or its own `onunhandledrejection` was logging an error
caused solely by MockLab being installed — also a breach of §5's "any internal error must
be swallowed". Fixed properly rather than with a `.catch()` band-aid: MockLab now **owns
the reader** (`clone.body.getReader()`), accumulates chunks itself, and on the deadline
calls `reader.cancel()` — legal, because it holds the lock — and handles that promise.
The read is now bounded on size as well as time (2 MB), and the capture-only deadline was
split: 5 s for a response that declares JSON, 1.5 s for anything else, because a non-JSON
body is only ever kept as a 512-character preview. That is what moved the release from
"never" to 1605 ms. The residual hold is real and is now recorded as deviation 17 rather
than described as something it is not.

**D10 (blocking, process) — the browser evidence was not in the repository.** Round 2
called the streaming harness "a real guard, not a rubber stamp" while it sat in a scratch
directory where it could never run for anyone. It is now
**`extension/test/e2e.browser.test.js`** (deviation 15): eight subtests against the real
unpacked extension in real Chromium, wired into `.github/workflows/ci.yml` as a second
`browser` job that installs Playwright and Chromium. It **skips itself** when Playwright
or a Chromium build is absent — verified: `ok 1 … # SKIP`, zero failures — so
`npm test -ws` stays green on a plain Node machine. All fixtures live in the one file
because `node --test` executes every `.js` file under `test/` (verified: a stray
`test/fixtures/probe.js` was executed as a test).

The three subtests that encode bugs which already bit us:

- *streamed responses resolve at their headers and keep flowing* (D1)
- *a fetch with no matching Change resolves at its headers, not its body* (D14) — the
  fixture calls `res.flushHeaders()`, without which Node holds the head until the first
  write and even an unpatched browser would "fail", making the assertion meaningless
- *every compiled entry matches the URL its signature came from* (D3/D11) — asserted
  against the REAL in-page matcher over ten hostile query shapes: encoded `&`, encoded
  `=`, unicode, `+`-as-space, repeated names, empty values, a literal `*`, pipes,
  encoded slashes, and a starred id beside a dropped cache-buster

**The suite was verified to actually catch its own defects.** Re-broken copies of the
build were run against it: reverting `readWithDeadline` to `clone.text()` +
`clone.body.cancel()` fails subtest 4 and nothing else; restoring the `encodeQueryPart`
short-circuit fails subtest 6 and nothing else.

**D9 — a claim of ours that was false.** `encodeQueryPart` short-circuited on
`text === '*'` before the `%2A` replacement, so a param whose value is exactly `*` was
emitted bare and decoded back as the volatile wildcard: `?star=%2A` matched
`?star=anything`. The comment and this log both claimed "a literal `*` becomes `%2A`",
true only for a `*` embedded in a longer value. Worse, test 32's `?star=%2A` line passed
*because of* the degradation. Fixed three ways: the encoder never short-circuits; the
volatile sentinel is now carried as a flag by the caller and compiles to `null` rather
than the string `"*"`, so a literal `*` and "any value" can no longer be confused
anywhere; and the test now asserts the thing that was broken —
`?star=anything` must NOT match — in the unit suite and against the real interceptor.

**D11** — the invariant is now asserted against the real in-page matcher in the browser
suite, not only against `matchesOwnUrl`, the hand-copy in `signatures.test.js` (which
stays as the fast unit-level check).
**D12** — the 3-second rewrite deadline no longer fails silently: the capture carries a
`changeDropped` flag through to the panel's source summary, and the honest consequence is
recorded as deviation 16.
**D13** — `endpoint`, `payload`, `request`, `response`, `resource`, `handler` and `call`
joined the ignored-segment list, and the filter now runs over the final WORDS as well as
the segments, so a compound like `booking-payload` cannot smuggle jargon through:
`/rest/payload/endpoint` → the host, `/booking-payload` → "Booking".
**Wording** — the jargon ban is cited as §1.2 (word list in §11's closing note), not §11.

**Re-verified after round 3:** `npm test -ws` — extension **93/93** (38 signature, 45
JSONPath, 8 browser subtests, 2 module placeholders), companion 5/5. Leak probe: socket
closed at 1605 ms, zero site-visible rejections.


---

## M1 verdict: PASS (commit `8d236fb`, after three QA rounds)

Round 1 FAIL: installing MockLab froze any page using a fetch-based SSE stream, with
zero Changes configured. Round 2 FAIL: the deadline meant to fix that did not release
the stream and leaked an unhandledrejection into the host page, and the browser
evidence lived in a scratch directory where CI could never run it. Round 3 PASS.

Independently confirmed at the passing commit:

- 8 browser subtests against the real unpacked extension, validated by FIVE mutations
  (two ours, three the verifier's own, including emptying `interceptor.js` entirely).
  Every subtest has now been shown to fail for a defect it targets, so a green run
  cannot be vacuous. Suite skips rather than fails when Playwright is absent.
- Endless-stream leak probe: socket closes in 1505ms (`text/plain`) and 5003ms
  (declared JSON), zero unhandledrejections reach the page, and the residual does not
  degrade under six concurrent streams.
- 2 sources in 118ms, no duplicates across 5 soft navigations, planted Changes drive
  the site's own rendering, captured bodies keep the real values.
- trip.com vectors: one stable sigId across a fresh trace id, a new 666-char blob and a
  changed stamp, and across a different `hotelId`; different for `curr` and `checkIn`;
  `checkInTime`/`signInMethod`/`hotelId`/`contentId` all correctly kept.
- §17: all 12 rules pass. `state: "verified"` is still assigned nowhere.

Deviations 7-17 were each checked for truth. No false claims remained.

**Open nits carried into M2** (none blocking): `e2e.browser.test.js:29` hand-mirrors
`MSG` although `messages.js` is importable from Node — one import removes a §17.8
duplication; `:53` hardcodes a verification-sandbox Playwright path that should not
ship; `changeDropped` has no automated guard; and a body over the 2MB cap reports an
empty preview rather than §4's 512-char preview.

---

## M2 — Changes engine

**Built by:** interceptor-engineer (backend) and panel-designer (UI), in parallel — their
owned files do not overlap. Deviations and this log were written by the orchestrator so
two concurrent agents never edited the same file.

**Delivered — backend**

- The full M2 message contract in `messages.js` (15 types), plus a `ChangeSummary`
  carrying `sourceName`, `linkState` and `applies`, so the panel can never claim a
  Change took effect when no signature is remembered.
- `changesApi.js` and `badge.js` split out under §17.10. The badge is per-tab and
  per-origin, recomputed on store change, tab switch, navigation, replace and cold
  worker start.
- `RESET_ALL` (§10.5's "Reset everything"). Before it existed the panel reached past the
  message contract into storage directly — which worked, but meant an MCP agent could
  not do what the human could, breaking §1.6 parity. It would have surfaced as a hole at
  M6, after the tools were built on the assumption.
- Bindings written outside a probe are `candidate`-only, and an existing binding's state
  is never touched — so a probe-verified binding cannot be silently downgraded by an
  unrelated edit (§1.1).

**Delivered — UI**

- §9.1's token block, with the Google Fonts `@import` replaced by bundled `@font-face`
  (Deviation 18). §9.2's component recipes reproduced.
- Sources tab (§10.2): friendly-named source cards, collapsible response tree, per-row
  ✏️ and ◎ actions, changed rows showing real → new with a toggle and trash.
- The value editor showing the **Possible** chip and §11's `editor.unverified` copy —
  never Verified, because nothing has been probed yet.
- `strings.js` compared against §11 programmatically: §11's **70** leaf values walked
  (independently re-extracted from PLAN.md and re-diffed at the PASS commit — the figure
  first recorded here, 102, reconciled with nothing measurable and is corrected), every function
  called with sample arguments, zero differences.

**Evidence**

`npm test -ws` at the M2 PASS commit: extension 156/156, companion 5/5, 0 skipped. Two
browser suites run against the real unpacked extension in real Chromium:
`e2e.browser.test.js` (14) and `panel.browser.test.js` (12). These totals are pinned to
a commit rather than left as a standing claim — see "Stale evidence" below for why.

M2 DoD, proven end to end: an edit from the tree turns the demo pill red — the site's own
`is-cancelled` class and a computed `rgb(217,48,37)`, with the derived banner appearing —
with **no probe involved**; it survives 10 refreshes; Reset site restores the real page.
A Change also survives a full browser restart and applies on the FIRST load after it.

**Three defects found by tests examining themselves**

1. The unit harness was testing two module instances: it cache-busted its `ruleStore.js`
   import, but `changesApi.js` imports that module by plain specifier, so the API under
   test held a different instance with a different write-lock map. Seventeen tests looked
   correct while exercising the wrong object graph.
2. A concurrency test passed without the lock it was written to prove. The fake's delayed
   read landed before the snapshot, so the hazard never occurred; removing the lock left
   it green. Reshaped, and verified to fail in its absence.
3. A panel assertion claimed a tree edit creates no Binding. It creates a `candidate`
   one, with `elements: []` — which is exactly what §10.2 requires and what feeds the
   Possible chip. The assertion was wrong, not the product.

**Both browser suites are mutation-tested.** Each deliberate regression fails exactly its
target subtest: restoring the remote `@import` fails typography *and* the console check;
changing the editor chip to Verified fails only the §1.1 subtest; reverting the stale-chip
token fails only the contrast subtest.

**Screenshot review caught six defects no DOM assertion would have.** The worst: a hidden
selection checkbox positioned absolutely was swallowing every input inside a card, so the
editor's text field was invisible. Re-review with the real typefaces caught two more — a
label reading as a heading at Inter's narrower metrics, and a checkbox animation that
blanked every tick for 300ms on any store-driven re-render.

**Correction to the record.** Commit `5d31087` is labelled "WIP … red — captured
mid-rewrite". That label is wrong: its tree passes its own full suite (142 extension
tests, the total at that commit). The orchestrator observed a
failure from an earlier on-disk state, and the agent saved the fixed file between that
test run and the commit. Noted here rather than rewritten, on the same principle applied
to every deviation on this build — a record is only worth something if it is true.

**Re-verification found three more.** The first M2 verdict was FAIL; the fixes for it
were themselves verified, and the second pass found three defects nothing else had:

1. **§17.6, panel.** `formatValue()` returned the literal `'null'` for a null leaf,
   rendered to the human in the tree and inside "Real value: …". The file's own header
   claimed every word came from `strings.js`. The demo fixtures contain no nulls, which
   is exactly why eleven browser subtests and both mutation passes missed it — the line
   never executed. Fixed via `S.glyph.nullValue`.
2. **§17.6, background.** `friendlyName()` and `changesApi.js` returned a bare `'Data'`
   as a source's display name at five sites. It reaches the human as a source-card
   heading today and as `ChangeSummary.sourceName` over MCP from M6 — so the breach
   would have widened into the agent-facing contract before anyone noticed. Fixed via
   `S.sources.fallbackName`.
3. **Stale evidence in this file.** See below.

**QA verdict:** FAIL -> fixed -> FAIL again -> fixed -> **PASS** on the second
re-verification (commit `7264a4c`). Two rounds, not one, and the second round found what
the first could not: the first re-verification's own fix for the `null` literal added the
key to `strings.js` but never wired it — `formatValue` still returned the literal at
`145be47`. Only `7264a4c` actually connected it. A fix that is recorded but not wired is
the same failure this build keeps producing, one level up.

**Open M7 items** — both recorded here so M7 inherits them, neither fixed unilaterally:

1. **Contrast — and it is wider than §16 M7 says.** White on `--accent` in dark mode is
   3.12:1, below AA. §9.2 specifies white text, so this is left for the M7 a11y pass
   rather than diverged from unilaterally. The light theme is 4.83:1 and passes; all four
   chips measure ≥ 4.5:1 in both themes.

   §16 M7 names only "all four chips", which is why this looked contained. It is not:
   `--accent` with white on it is **every primary button in the product** — Apply &
   refresh, Reset everything, Find the real source — not one screen. And no text colour
   reaches 4.5:1 on `#4A90FF`, so the fix cannot be a lighter or darker white: the dark
   theme has to go **dark-on-accent** (`--on-accent: #1E1F24` → 5.36:1), which also turns
   §9.2's primary-button `::before` sheen from a highlight into a shadow. That is a
   design-system decision touching every primary button, correctly not taken by one agent
   inside one milestone. **M7 owns it; recording it here because §16's wording left it
   unowned.**
2. **Disabled controls explain themselves only to a mouse.** Three controls — the Deep
   mode row, "Set up AI access", and "Show on page" — say *why* they are inert only
   through a hover tooltip. A `disabled` button is not focusable, so `.tip:focus-within`
   can never fire, and the disabled child carries `pointer-events: none` so the wrapper
   takes the hover: mouse-only by construction. The bubble is `role="tooltip"` with no
   `aria-describedby`, so a screen reader does not announce it either. A keyboard or
   screen-reader user meets three dead controls with no stated reason. **This item existed
   at the first M2 verdict and was left out of the record; only re-verification caught the
   omission.**

   M7 needs three separate fixes, not one — the first version of this entry said "copy a
   pattern this codebase already has", which is true of only two of the three controls:

   - **Deep mode row** and **Set up AI access** — yes, literally: visible `S.soon` help
     text, exactly as the Pick and Scenarios tabs already do it.
   - **"Show on page"** — no. It is a per-row icon button inside a hover-revealed action
     group in a dense tree. A help paragraph per row is noise and there is nowhere else to
     put it, so this one needs the tooltip *component* changed: an id plus
     `aria-describedby`, and `aria-disabled="true"` with an inert handler in place of
     `disabled`, so the control is focusable at all and `:focus-within` can fire.
   - **Every `.tip` in the panel, independent of the three disabled controls** — WCAG 2.2
     **1.4.13 Content on Hover or Focus** is unmet: the bubble is `pointer-events: none`
     so it cannot be hovered, and there is no Esc dismissal. M7 owes `dom.js` and
     `panel.css` a tooltip change regardless of what happens to the disabled controls.

**Two things the §17.6 fix uncovered that the breach itself did not.**

1. `formatValue()` did not only *display* the word — it also seeded the value editor's
   text box. Editing a field that held no value pre-filled the box with `null`, and one
   click sent the site the four-character string `"null"`. The friendly word would have
   made it worse, not better: `"nothing"` reads like real copy, so nobody would question
   it. The editor now opens **empty** for an absent value or a container, so whatever the
   site is told is something a human actually typed. A one-word copy fix turned out to be
   sitting on a data bug.
2. The word was distinguished from a genuine value by **colour alone** — WCAG 1.4.1. A
   text value that happens to read "nothing" was indistinguishable from a field that holds
   none. The row is now italic as well.

The chosen word is **"nothing"**, not "empty": it is already this copy file's word for
absence ("Nothing captured yet", "Nothing here matches that search"), so it adds no
vocabulary for a reader or a translator, and "empty" is the ambiguous one — an empty text
and an empty list are different real values the tree already draws differently.

**A guard that measured the wrong number.** The tooltip geometry test pinned a hardcoded
`4px` to mirror the CSS. Fixing it exposed that the constant was never load-bearing: it
modelled the tooltip's *resting* offset, which does not move the shown box at all. Moving
the CSS resting slide from `-4px` to `-24px` left the old test green **and** silently made
its clearance figure 20px wrong. The decisive mutation is the shown position — pushing the
revealed bubble down over "Reset site" leaves the old hardcoded test at **12 pass, 0 fail**
while the control that undoes every change on the site sits underneath it. The rewritten
subtest opens each tooltip the way a keyboard user does, measures the real box, and asserts
it actually opened, so a tooltip that failed to open can never be scored as "covers
nothing". This is the second guard this milestone that was green for a reason unrelated to
what it claimed to check.

**Stale evidence, and why it is worth its own entry.** The Evidence paragraph above and a
CI comment both carried hand-maintained test totals ("142"). The suite grew and the
numbers rotted in place — in a section that closes by saying a record is only worth
something if it is true, and in the one file whose entire job is to be trusted. The
recorded *line counts* could not rot, because `guards.test.js` parses them back out of
README and fails on drift; the *test totals* had no such guard and duly drifted. The CI
comment no longer states a total at all: "every unit test" makes the same point and
cannot go stale. Totals that are genuinely evidence are kept, pinned to the commit they
were measured at.

---

## M3 — Picker + candidates

**Built by:** probe-engineer (picker, fingerprints, candidate discovery) and panel-designer
(Pick tab states A–C), in parallel; interceptor-engineer closed three guard gaps left over
from M2 in the same window. Owned files did not overlap.

**Delivered — picker and discovery**

- `content/picker.js` (the interaction: cursor, hover overlay, confirm flash, listeners)
  and `content/element.js` (§6.2 fingerprint and re-resolve, §7.3 snapshot, §6.1 smart
  target — the questions M4's probe asks with no picker running).
- `background/candidates.js` (§6.3 hypothesis generator, pure functions, no chrome API)
  and `background/pickApi.js` (the service-worker glue).
- The overlay renders in an **open shadow root**: on a page with `* { border: 0 !important }`
  the site's own CSS erases MockLab's outline and the user sees nothing while believing
  they are picking. Proved by mutation.

**Delivered — Pick tab**

- States A, B and C per §10.1. State D and the probe progress card are M4 and were not
  built.
- `probe.cta` renders disabled with a real next step below it rather than hidden or
  enabled — hidden, the screen misdescribes itself; enabled, it promises an experiment
  that cannot run.

**The DoD, which is the milestone.** Picking the demo pill lists `status` in the top 3 when
the pill reads "On time" and the data says `"ON_TIME"`. Picking the price finds
`price.total` by numeric match. Both proven end to end in real Chromium, by QA's own
harness as well as ours.

**What actually connects "On time" to `"ON_TIME"` — corrected.** This paragraph first said
"no substring or numeric match connects those; it works only through §6.3's sibling-key
heuristic". That is false. §6.3 derives the word needle `time`, and `"ON_TIME".toLowerCase()`
contains it, so the spec's own substring rule scores `$.status` at **0.50 — rank 1**, above
sibling-key's 0.45. The shipped product reports it plainly: `via: substring`. The heuristic
also fires, which is what made the wrong story easy to believe.

The demo's own pill is therefore the *weakest* possible evidence for the heuristic, because
English "On time" and the constant `ON_TIME` happen to share a substring. `"Delayed"`/`"LATE"`,
`"Sold out"`/`"OOS"`, and any localized interface share none — which is the real reason the
gate is broadened (Deviation 31), and why `candidates.test.js` carries a Spanish fixture
where nothing but the heuristic can find the field.

**Three spec problems, found by measuring rather than by assuming**

1. **§6.1's 1.4× area rule cannot do the job §6.1 describes for it.** Measured in real
   Chromium, the demo's own pill (`padding: 5px 14px` at 12px) is **2.71×** — the 2.57×
   first recorded here belonged to a 5px/12px test fixture mislabelled as the demo's CSS,
   and is corrected. No realistically padded pill passes — the
   budget for a short word is 1px vertical and 5px horizontal. An area ratio depends on
   text *length* while padding does not, so the rule is harshest on exactly the short text
   §6.1 names as its purpose. Fixed additively (Deviation 30) rather than by raising the
   constant until the demo passed, which would have been a number chosen to fit one case.
2. **§6.3's sibling-key gate is too narrow — but not for the reason first recorded here.**
   The original entry said the strict reading makes the M3 DoD impossible. **That was
   false, and the orchestrator repeated it several times before QA re-measured it.** §6.3
   derives the word needle `time` from "On time", and `"ON_TIME".toLowerCase()` contains
   it, so the spec's own substring rule scores `$.status` at 0.50 — rank 1, above
   sibling-key's 0.45. The DoD passes under the literal spec. The real reason to broaden
   the gate is that the strict reading makes enum discovery hang on an **accidental shared
   substring** between a display string and a machine constant: "On time"/"ON_TIME" happens
   to share one, "Delayed"/"LATE" and "Sold out"/"OOS" do not, and no localized UI does.
   The DoD is passable either way; the product is not (Deviation 31).

   Worth naming as its own lesson: the claim was plausible, repeated, and load-bearing for
   a spec change, and nothing in the test suite could contradict it — the DoD passed, which
   is exactly what a false premise about *why* it passes predicts.
3. **§5.4's depth-12 cap made an honest string dishonest.** A field 13 levels down was
   invisible, and the user was shown `pick.noCandidates` — a claim about the data — when
   the truth was that MockLab stopped looking. Raised to 24, with `searched.complete`
   plumbed through so the bounded case can be told apart from the empty one (Deviation 32).
   Raising the cap raised the worst case with it: 200 sources at the ceiling blocked the
   service worker for **3244 ms** on one click. A tab-wide budget brings that to 163 ms,
   and the honesty flag is precisely what makes bounding acceptable.

**Two defects found by looking, not by testing**

1. **State B's only instruction measured 2.87:1.** §10.1B says the button "becomes
   disabled"; §9.2's disabled recipe dims it. Both rules are right, and composed they made
   the one sentence on screen unreadable. It now keeps real `disabled` semantics and paints
   at full strength (4.83:1); the 60% dimmed panel around it carries the "waiting" signal.
   Asserted as a property — never painted weaker than an ordinary primary button — not as
   a number.
2. **Two candidate rows read identically.** The demo holds `"ON_TIME"` at both `$.status`
   and `$.booking.status`, so §10.1C's two columns drew two different fields as one thing —
   in the screen whose entire job is telling you which field to trust. Rows now carry the
   field in the site's own words (`status`, `booking · status`); raw paths stay Advanced-only.

**Two tests that were not guards, caught by their own authors**

- Deleting every `removeEventListener` in the picker left all 12 browser subtests green,
  because each handler early-returns when not picking. Replaced with a subtest that
  instruments `addEventListener`/`removeEventListener` and pairs every add with a remove by
  `(type, fn, capture)`.
- The first same-text assertion for the smart walk sat where the *area* rule was also
  blocking, so deleting the text check changed nothing. And the first version of the new
  inset rule had only horizontal blockers — dropping the `top` term failed no test. Both
  found by mutation, both fixed.

**A fixture that made a vacuous assertion real.** `user.json` gained `"status": "ACTIVE"`.
Removing §6.3's `related` gate now fails on the demo itself; before, only a synthetic
fixture caught it. M2 spent a whole milestone with a code path no fixture could execute,
and this is the cheapest available insurance against a repeat.

**Evidence at the M3 commit:** `npm test -ws` extension 207/207, companion 5/5, 0 skipped,
stable across three consecutive runs. Four browser suites against the real unpacked
extension in real Chromium: `e2e` 14, `panel` 21, `picker` 7, `pickerdom` 6 — all four run
individually and in the parallel run, and all four are wired into CI as their own steps.

**QA verdict:** _pending qa-verifier_

**Three carry-forwards, all closed before M4 — recorded here because the first version of
this paragraph listed them as open and was never updated:**

- `pickMessages.js` merged into `messages.js` with `PHASE` (`9daef6c`). Byte-identical for
  all seven values, verified by loading both modules and comparing. It also closed a hole
  nobody was aiming at: §17.2's mirror guard walks `Object.values(PORT_MSG)`, so while the
  pick values sat outside it, breaking `agent.js`'s mirror of `port:picked` — which kills
  pick mode end to end — passed all twelve guards. Reproduced at `0ff2bd1`, fails in both
  directions at HEAD.
- `countFields()` replaced by an exact `countLeaves` (`4fe3c90`, Deviation 42). Neither 12
  nor 24 was the honest number; a count is a claim about the data, a ceiling is a fact about
  the search.
- The bounded-search sentences are rendered (`58ad67f`), so a search that stopped early no
  longer displays as one that found nothing.

That this paragraph went stale one milestone after the section above it was written about
stale evidence is the point, not an aside. A record that is only corrected when someone
re-reads it is not a record.
