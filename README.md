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
- **Live-updating data** (WebSocket and server-sent streams) can't be edited yet.
- **Some modern streamed pages** (React Server Components) are shown but can't be changed.
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
| 3 | M0 | The demo page loads no web font; it uses Inter when the machine has it and falls back to the system UI face. PLAN.md §14 specifies Inter. | A probe run reloads the page up to eight times. A web-font request on every load would appear in the capture list and delay the network-quiet condition in §7.3's settle definition. The panel itself still imports Inter exactly as §9.1 requires. |
| 4 | M0 | The demo shows a banner for `DELAYED`, not only for `CANCELLED` as §14 specifies. | Gives the probe's inverse discovery (§7.6) a second multi-element case to find, so `elements[]` is exercised for more than one status value. Costs nothing and makes the harness stricter. |
| 5 | M0 | The demo's rotating tip box also prints `Gate {flight.gate}`, which §14 does not mention. | The noisy box needs to yield real value-match candidates, otherwise M4's `probe.tooNoisy` DoD cannot be tested — picking a box that matches nothing would fail with "no candidates" instead of exercising the noise mask. |
| 6 | M0 | The demo server answers `/favicon.ico` with `204` instead of `404`. | Chrome requests a favicon on every load. A 404 puts a red error in the page console, and the demo's console is where every later milestone's acceptance is judged. |

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
