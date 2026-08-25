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
