# MockLab

**Click any element on any website, find the data behind it, change it, and watch the
site render the new state.**

MockLab is a Chrome extension. Pick a price, a status pill, or a name on a page, and
MockLab works out which piece of loaded data controls it — by experiment, not by
guessing — then lets you change that value. The website's own code does the rendering,
so what you see is exactly what real users would see.

Nothing leaves your computer. No accounts, no servers, no tracking.

---

## 1. Install the extension

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** (top-right switch)
3. Click **Load unpacked** and choose the `extension` folder from this project

_[screenshot: chrome://extensions with Developer mode on]_

## 2. Pin it and open a site

Click the puzzle-piece icon in Chrome's toolbar and pin **MockLab**. Open any website,
then click the MockLab icon — the panel opens beside the page.

_[screenshot: the MockLab panel open next to a website]_

## 3. Optional — let an AI assistant drive it

This step is only needed if you want Claude Code (or another AI assistant) to read and
change data for you.

1. Install Node.js from [nodejs.org](https://nodejs.org) (any version 20 or newer)
2. Run this once in your terminal:

   ```
   claude mcp add mocklab -- npx mocklab-companion --stdio
   ```

3. Open MockLab's **Settings** tab, choose **Set up AI access**, and type in the
   6-digit code your terminal printed.

_[screenshot: the pairing code screen]_

---

## Try it safely first

MockLab ships with a small practice website so you can learn the tool without touching
anything real.

```
npx mocklab-companion
```

Then open **http://127.0.0.1:8517/demo/** — a pretend airline booking page with a
flight status, a price, and a passenger name. Try picking the status pill and changing
it to `CANCELLED`: the pill turns red and a cancellation banner appears, because the
page's own code reacted to the new data.

---

## What MockLab can't do yet

Being honest about the edges matters more than sounding capable:

- **Content inside frames.** Only the main page is covered in version 1.
- **Live-updating data** (WebSockets, live event streams) and **modern streamed pages**
  (React Server Components) are listed as sources but can't be edited. MockLab passes
  them through untouched and never reads them, so live tickers, chat views and
  streaming pages keep working normally with MockLab installed — they just show up
  greyed out rather than editable.
- **Sites that load data only once per visit.** Your change applies the next time the
  site asks for that data, not on a plain refresh.
- **Chromium browsers only** — Chrome, Edge, Brave, Arc. Not Firefox or Safari.
- **Non-text data formats** (binary, protobuf) are listed but can't be edited.
- **Screenshots** capture the visible part of the page, not the full scrollable page.

---

## Deviations from PLAN.md

Recorded per PLAN.md §17.11 — where the build differs from the specification and why.

| # | Milestone | Deviation | Why |
|---|-----------|-----------|-----|
| 1 | M0 | **`"sidePanel"` added to `manifest.json` permissions.** PLAN.md §3 says to write the manifest verbatim, and its permission array omits it. | `chrome.sidePanel` is undefined without this permission, so the toolbar icon can never open the panel — §3's own Notes require exactly that behaviour. Verified in Chromium: without the permission the namespace is `undefined`; with it, `setPanelBehavior` succeeds. `background.js` now checks for the namespace explicitly rather than optional-chaining, because the optional-chained form failed silently with a clean console. §17.11: prefer the working behaviour. |
| 2 | M0 | The demo page fetches `api/trip.json` with `fetch()` but `api/user.json` with `XMLHttpRequest`. PLAN.md §14 describes both as fetches. | The demo is the acceptance harness for every milestone. Using both APIs means it exercises both interception paths in §5.1 — the `fetch` wrapper and the harder `responseText` override — instead of leaving the XHR path untested through M6. Still two sources, as §14 requires. |
| 3 | M0 | The demo page loads no web font; it uses Inter when the machine has it and falls back to the system UI face. PLAN.md §14 specifies Inter. | A probe run reloads the page up to eight times. A web-font request on every load would appear in the capture list and delay the network-quiet condition in §7.3's settle definition. The panel will import Inter per §9.1 when `panel.css` is completed at M2 (see BUILD_LOG, "Carried into M2"). |
| 4 | M0 | The demo shows a banner for `DELAYED`, not only for `CANCELLED` as §14 specifies. | Gives the probe's inverse discovery (§7.6) a second multi-element case to find, so `elements[]` is exercised for more than one status value. Costs nothing and makes the harness stricter. |
| 5 | M0 | The demo's rotating tip box also prints `Gate {flight.gate}`, which §14 does not mention. | The noisy box needs to yield real value-match candidates, otherwise M4's `probe.tooNoisy` DoD cannot be tested — picking a box that matches nothing would fail with "no candidates" instead of exercising the noise mask. |
| 6 | M0 | The demo server answers `/favicon.ico` with `204` instead of `404`. | Chrome requests a favicon on every load. A 404 puts a red error in the page console, and the demo's console is where every later milestone's acceptance is judged. |
| 7 | M1 | **§5.2's volatile-param rule extended to delimited tokens inside a param name.** The spec's list is anchored, so it only fires when the volatile word IS the whole name. MockLab also drops a param when a volatile marker appears as a delimited token (split on `_ - .` and camelCase). | The product owner's real target page sends `masterhotelid_tracelogid=100051355-0a8e3544-496571-67667`, which the anchored list misses, and whose value escapes every volatile-value rule too (the dashes defeat all four). Under a literal reading the identity of that request would change on every single page load and **no change could ever apply** — the product would silently do nothing on the page it exists to demo. The token set used for this is deliberately narrower than the anchored list: generic words like `t`, `time`, `sign` and `hash` are excluded, so `checkInTime` and `signInMethod` are still treated as meaningful. Proved on a live page: a fresh trace id per load yields one stable identity, and a change made on one load still applies on the next. |
| 8 | M1 | **A fifth storage key family, `signatures:<origin>`.** PLAN.md §4 lists four. | A change is keyed by request identity, but the in-page matcher works on method and URL, so the service worker must be able to turn an identity back into a URL shape at page start — before that load has captured anything. Without this cache the match list is empty on every fresh load and no change could apply, which is M2's whole point. Captured **responses** stay session-only exactly as §4 requires; only the tiny identity shape is stored. |
| 9 | M1 | **The compiled match list carries query constraints beside the regex, not inside it.** §5.2 describes one `urlRegex` built from the whole normalized URL; MockLab builds it from the origin+path half and passes the query as a `params` list. | A normalized URL has its volatile params dropped and the rest sorted, so a regex built from it could never match the concrete, unsorted URL a page actually requests. Matching params by name and value is what that normalization means: "these must be present with these values; anything else is volatile". Entries are ordered most-constrained-first so §5.3's "first match wins" picks the most specific one. |
| 10 | M1 | **The page's first requests wait for the match list** (hard cap 1 second, once per page load). §5.1.5 says the change table is pushed in so application is synchronous. | It is pushed in — but that takes a few milliseconds, and a page that fires its data requests immediately gets its response back before any change is known, so the edit silently does nothing. The demo's XHR lost this race consistently. §5.1.5's actual hazard is an async round-trip **per request**; this waits once, for the table, and every request afterwards is fully synchronous. Measured cost, 11 loads per condition, two independent runs: demo time-to-render median 60 / 56 ms without the extension and 59 / 55 ms with it — the wait is inside the page's own start-up and does not show above the noise. It IS visible on a request issued in the page's very first milliseconds: an event stream's first chunk arrives at 13 ms without the extension and 43-49 ms with it, and the identical delta appears on a binary response MockLab never even reads, which is what shows it is this one-time wait rather than a per-response cost. |
| 11 | M1 | **`interceptor.js` is 920 lines (665 of them code), above §17.10's ~500.** | §17.10 says "split when bigger". Splitting it is technically possible — the manifest accepts several `js` entries in one MAIN-world block — but those entries **share the page's own global scope**, so the pieces could only reach each other through `window`. That would publish MockLab's match list and patch internals on a hostile page's global object, where any site script could read or rewrite them; the current single closure keeps everything private. A bundler is the other way to split, and §17.10 forbids that too. Everything that can live outside the page already does, in `signatures.js`, `jsonpath.js` and `ruleStore.js`. |
| 12 | M1 | **Both content scripts duplicate a few constants from `messages.js`**, not just `interceptor.js` as the M0 note anticipated. | Content scripts are classic scripts: `import` is a syntax error in `agent.js` too, and dynamic `import()` of an extension file would require making `messages.js` web-accessible to every page. Both files carry a clearly-marked mirrored block, and `messages.js`'s header names both. |
| 13 | M1 | **The XHR body is swapped through instance-level `responseText` / `response` getters installed at `open()`, not §5.1.3's capture-phase `readystatechange` listener.** | §5.1.3 assumes "capture listeners registered first fire first". That is a DOM-tree rule; `XMLHttpRequest` is not a tree, so listeners run in registration order and `{capture:true}` changes nothing. A site that assigns `onreadystatechange` before calling `send()` would therefore read the real body before MockLab's listener ever ran, and the change would apply at random. A lazy getter cannot lose that race: whoever reads the body first triggers the swap. |
| 14 | M1 | **A response body is only buffered when a change actually matches it.** §5.1.2 reads as "always clone and read the body, then decide". | Matching needs the method, the URL and the *request* body — never the response body — so the decision can be made first. Reading first is not merely slower, it is a page-breaking bug: an open event stream never finishes, so awaiting its body meant the site's `fetch()` promise never resolved and any live ticker or chat view froze permanently, on every site, with zero changes configured. Streamed content types are now never read or even cloned (listed read-only per §5.1.4), and everything else is read *after* the original response has already gone back to the page. Verified against the same page with the extension off and on, three runs: the first live chunk arrives at 13-14 ms without the extension and 43-49 ms with it, and `text/x-component` headers at ~110 ms vs ~145 ms — where before the fix the live stream never arrived at all and `text/x-component` took 1527 ms, the full duration of the stream. The remaining delta is deviation 10's one-time wait: it is the same on a binary response MockLab never reads. |
| 15 | M1 | **`extension/test/e2e.browser.test.js` added**, which PLAN.md §2.1's file tree does not list, plus a second CI job that installs Playwright and runs it. | Every M1 defect that mattered was invisible to unit tests and only appeared in a real browser: a streamed response that froze the page, a compiled match entry that could not match its own URL, and a stream MockLab never released. A guard that lives outside the repository cannot fire for anyone else. The suite loads the genuine unpacked extension in Chromium and asserts against the genuine service worker and MAIN-world patch. It **skips itself** when Playwright or a Chromium build is missing, so `npm test -ws` stays green on a plain Node machine. All fixtures live inside the one file because `node --test` executes every `.js` file under `test/`, so a separate fixture module would be run as a test. |
| 16 | M1 | **A change is dropped, not applied, when the response it targets takes longer than 3 seconds to arrive** — and the capture is flagged `changeDropped` so the panel can say so. | Rewriting a body means buffering it, and a body that never ends would otherwise hang the page forever (the failure mode of deviation 14). The deadline bounds that. The honest consequence: on a very slow endpoint the site receives the REAL response and the user's edit does not take effect that time. §1 forbids letting that be silent, so it is not: the flag travels with the capture, and the panel surfaces it rather than leaving the user to guess. |
| 17 | M1 | **A response MockLab is only capturing (no change matches it) keeps its connection alive for up to 1.5 s — 5 s if it declares JSON — after the page itself has stopped reading.** | To list a source, MockLab reads a clone of the body. A clone's two branches share one underlying connection, so that connection cannot close until MockLab's branch is released too. The read is bounded on time and on size (2 MB) and the reader is then genuinely cancelled — measured against an endless `text/plain` response: the page let go at 116 ms, MockLab released at 1605 ms, and the socket closed. An earlier version used `clone.text()` and tried `clone.body.cancel()`, which cannot work — `text()` locks the body, so the cancel rejected out of band, the socket stayed open indefinitely (121 chunks still arriving after 12 s), and the rejection surfaced on the page as a site-visible `unhandledrejection`. MockLab now owns the reader from the first byte. |
| 18 | M2 | §9.1's two Google Fonts `@import` lines are replaced by `@font-face` rules loading Inter and Fira Code from `extension/fonts/`. | §1.4 is a non-negotiable principle: everything local, no remote servers. A font request on every panel open would send the user's IP and usage timing to a third party, in a tool whose promise is that nothing leaves their machine. Bundling delivers §9.1's typography *more* faithfully — offline, on first paint, with no fallback flash — and it removed two console errors that had been permanently excusing the panel's "no errors" check. |
| 19 | M2 | An additive `:root` block supplies tokens §9.1 does not define — chip text colours, `--on-accent`, `--chip-changed-bg`, the `--json-*` tree colours, `--scrollbar-size` and `--dir`; §9.1's own tokens are untouched. | §9.2's semantic colour pairs fail WCAG 2.2 AA at the chip's 10px/600 weight — Stale measured 2.21:1 against a 4.5:1 requirement. The additive tokens bring all four chips to 4.6–8.9:1 in both themes without altering the design system §9.1 defines. |
| 20 | M2 | The segmented control's thumb is `calc((100% - 8px) / 4)`, not §9.2's `calc(25% - 4px)`. | The spec formula lands 2px off a cell, so the thumb drifts about 6px by the fourth tab. |
| 21 | M2 | Two hex literals live in `badge.js`, outside `panel.css`'s `:root` (§17.7): the badge background and its text colour. | `chrome.action.setBadgeBackgroundColor` is drawn by Chrome and takes a literal — no stylesheet is reachable from a service worker. The values are §9.1's light-theme `--accent` and `#FFFFFF` for the text, copied verbatim. |
| 22 | M2 | Seven files added beyond §2.1's tree: `background/{badge,changesApi}.js`, `panel/{dom,sources}.js`, `test/{changes,guards,panel.browser}.test.js`. | §17.10 caps files at ~500 lines and says to split when bigger; a single `background.js` or `panel.js` would have run past it. `test/e2e.browser.test.js` is itself 987 lines — a browser suite is a sequence of independent scenarios rather than logic to be re-entered, and splitting it would duplicate the extension-launch fixture rather than reduce anything. `guards.test.js` in particular turns §17.4's "grep-test yourself" instruction into an automated audit that fails CI if `state: "verified"` is ever assigned outside probe.js. |
| 23 | M2 | The badge counts enabled, non-`probe` Changes only. | Probe scaffolding exists only during a running probe, when the panel shows its own progress card. A badge flickering through a bisection would tell the user nothing true, and §17.5 guarantees probe Changes never outlive the probe. |
| 24 | M2 | `RESET_ALL` ("Reset everything", §10.5) clears Changes, Scenarios and Links on every site but not `settings`, and not the derived `signatures:` cache. It reloads only the calling tab. | `settings` holds the companion pairing token; silently unpairing the user's AI is not a data reset, and §10.5's copy gives no warning that it would. The signature cache describes what a request looks like, never what MockLab did to it, and is relearned on the next load. Other tabs are not force-reloaded because that would destroy form state on unrelated pages — they receive the emptied match list live instead, and the copy says exactly that rather than promising a refresh. |
| 25 | M2 | Strings shipped beyond §11's copy table, each marked in `strings.js` with its provenance. | §11 does not cover every surface §10 describes — the §10.2 meta row, accessible names for the per-row toggle and trash, §10.5's settings labels, editor affordances, and a `changeDropped` note for a Change that did not reach the page in time. All are written in §11's voice and routed through `strings.js`, so §17.6 holds and translation still means translating one file. |

---

## For developers

No build step, no bundler, no TypeScript compile — plain ES2022 everywhere. Edit a
file, reload the extension, done.

```
npm install     # workspaces: extension, companion
npm test -ws    # node --test across both workspaces
npm run zip     # produces mocklab-extension.zip
```

`PLAN.md` is the full build specification. `BUILD_LOG.md` records what each milestone
delivered and how it was verified.
