/**
 * §10.3's highlight overlays, in real Chromium, against the REAL unpacked extension
 * (PLAN.md §10.3, §10.2, §12.4 #9; §16 M5 DoD "Show me highlights pill+banner").
 *
 * OWNER: interceptor-engineer.
 *
 * WHY A NINTH SUITE. The worker half of the highlight decides what to draw and what to
 * claim, and `highlight.test.js` proves that without a browser. The DRAWING is the other
 * half and it is DOM behaviour end to end: a shadow root a site's `!important` reset
 * cannot erase, a rect measured on a real layout, §6.2's re-resolution running against a
 * document that has actually changed, a listener that has to come off, and a container
 * that must be gone four seconds later. A fake DOM would only prove the fake works.
 *
 * It is in `.github/workflows/ci.yml`'s `for suite in …` loop, added in the same change
 * as this file — three suites on this build have existed without CI invoking them, and
 * the comment in that job says so.
 *
 * Skips (never fails) when Playwright or a Chromium build is missing, and skips as
 * REPORTED checks: this suite's contribution to `# tests` is the same number whether it
 * passes, skips or breaks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MSG, CONTENT_GLOBALS } from '../src/background/messages.js';
import { EXTENSION_DIR, loadChromium, launchExtension, createFixture } from '../testlib/browserFixture.js';

/* ------------------------------------------------------------------------ fixtures */

/**
 * A trip page in miniature, and a hostile one: every border, background and radius is
 * reset with `!important`, which is what the shadow root exists to survive. `#pill` and
 * `#banner` both render the value at `$.status`; `#far` renders it too, three screens
 * down, which is what \`offscreen\` counts. \`#tip\` is noise that shares no text. \`#wrap\`
 * is an ancestor that shares its children's text — every text search hits it, and it is
 * what an unpruned one would outline instead of the pill.
 */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>trip</title><style>
  *{border:0!important;border-radius:0!important;background:none!important;
    box-shadow:none!important;transition:none!important;animation:none!important}
  body{margin:0;font:16px system-ui}
  #wrap{display:block;padding:4px}
  #pill{display:inline-block;padding:2px 6px;margin:30px}
  #banner{display:block;margin:10px 30px;width:320px}
  #tip{display:block;margin:10px 30px}
  #far{display:block;margin-top:2400px}
  #empty{display:block;width:0;height:0;overflow:hidden}
</style></head><body>
  <div id="wrap">
    <div id="pill"><span id="pill-inner">CANCELLED</span></div>
    <div id="banner">Status: CANCELLED</div>
  </div>
  <div id="tip">Tip of the day: check in early</div>
  <div id="price">450</div>
  <div id="far">CANCELLED</div>
  <div id="empty">CANCELLED</div>
  <script>
    window.__loaded = fetch('./api/trip.json').then(function (r) { return r.json(); });
  </script>
</body></html>`;

const TRIP = { status: 'CANCELLED', price: { total: 450 }, crew: { pilot: 'Rae' } };

function fixtureHandler(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/trip') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(PAGE);
  }
  if (url.pathname === '/api/trip.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(TRIP));
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------------------- suite */

const chromium = await loadChromium();

if (!chromium) {
  test('highlight browser suite', { skip: 'Playwright is not installed — `npm i -D playwright && npx playwright install chromium` enables it.' }, () => {});
} else {
  test('§10.3 highlight overlays in real Chromium', async (t) => {
    const { stage, check, timeline } = createFixture(t);

    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mocklab-hl-'));
    const fixtures = http.createServer(fixtureHandler);
    let fixtureOrigin = null;
    let ctx = null;
    let sw = null;
    let panel = null;
    const swErrors = [];

    try {
      fixtureOrigin = await stage('fixture server', 10000, async () => `http://127.0.0.1:${await listen(fixtures)}`);
      ctx = await stage('chromium launch + extension load', 60000, () => launchExtension(chromium, profile), {
        absent: 'Chromium could not be launched'
      });
      sw = await stage('service-worker registration', 20000, async () =>
        ctx.serviceWorkers()[0] || ctx.waitForEvent('serviceworker', { timeout: 20000 }));
      sw.on('console', (m) => { if (m.type() === 'error') swErrors.push(m.text()); });
      panel = await stage('panel page', 30000, async () => {
        const page = await ctx.newPage();
        await page.goto(sw.url().split('/src/')[0] + '/src/panel/panel.html');
        return page;
      });
      t.diagnostic(`fixture ready — ${timeline.join(', ')}`);
    } catch {
      /* the stage that failed named itself; every check below still reports */
    }

    /** Exactly the call `panel/links.js` makes — the panel's own channel, not a shortcut. */
    const send = (type, payload) =>
      panel.evaluate(([t2, p]) => chrome.runtime.sendMessage({ type: t2, payload: p }), [type, payload]);

    const tabIdOf = async (page) => {
      const url = page.url();
      const ids = await sw.evaluate(async (u) => {
        const tabs = await chrome.tabs.query({});
        return tabs.filter((tab) => tab.url === u).map((tab) => tab.id);
      }, url);
      assert.equal(ids.length, 1, `exactly one tab is at ${url} (found ${ids.length})`);
      return ids[0];
    };

    async function waitForSources(tabId, count, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        last = await send(MSG.LIST_SOURCES, { tabId });
        if (last && last.sources.length >= count) return last;
        await sleep(50);
      }
      return last;
    }

    /** A fresh page on the fixture, its tab id, and the sigId MockLab captured for it. */
    async function openTrip(label) {
      const page = await ctx.newPage();
      await page.goto(`${fixtureOrigin}/trip?case=${label}`, { waitUntil: 'load' });
      const tabId = await tabIdOf(page);
      const sources = await waitForSources(tabId, 1);
      assert.equal(sources.sources.length, 1, `the fixture's one source is captured (${label})`);
      return { page, tabId, sigId: sources.sources[0].sigId, origin: sources.origin };
    }

    /**
     * §6.2 fingerprints for real elements, taken the way the probe takes them: by asking
     * `element.js` inside the page. Building them by hand here would test this file's
     * idea of a fingerprint rather than the product's.
     */
    const fingerprintsFor = (tabId, selectors) =>
      sw.evaluate(async ([id, sels, globalName]) => {
        const [frame] = await chrome.scripting.executeScript({
          target: { tabId: id },
          args: [sels, globalName],
          func: (list, name) =>
            list.map((sel) => {
              const node = document.querySelector(sel);
              return node ? globalThis[name].fingerprint(node) : null;
            })
        });
        return frame.result;
      }, [tabId, selectors, CONTENT_GLOBALS.element]);

    /** Plant a Binding, the way a finished probe would. */
    const storeBinding = (origin, binding) =>
      sw.evaluate(async ([key, value]) => {
        await chrome.storage.local.set({ [key]: value });
      }, [`bindings:${origin}`, [binding]]);

    /** Everything about the overlay host, read through its open shadow root. */
    const overlay = (page, hostId) =>
      page.evaluate((id) => {
        const hosts = document.querySelectorAll('#' + id);
        const host = hosts[0];
        if (!host) return { present: false, hosts: hosts.length };
        const hostStyle = getComputedStyle(host);
        const root = host.shadowRoot || host;
        const boxes = [...root.querySelectorAll('.box')];
        return {
          present: true,
          hosts: hosts.length,
          parentIsHtml: host.parentElement === document.documentElement,
          position: hostStyle.position,
          pointerEvents: hostStyle.pointerEvents,
          zIndex: hostStyle.zIndex,
          count: boxes.length,
          on: boxes.filter((b) => b.classList.contains('on')).length,
          classes: boxes.map((b) => b.className),
          rects: boxes.map((b) => b.getBoundingClientRect().toJSON()),
          borders: boxes.map((b) => {
            const s = getComputedStyle(b);
            return `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`;
          }),
          radius: boxes[0] ? getComputedStyle(boxes[0]).borderTopLeftRadius : null,
          chips: [...root.querySelectorAll('.chip')].map((c) => c.textContent),
          chipBg: root.querySelector('.chip') ? getComputedStyle(root.querySelector('.chip')).backgroundColor : null
        };
      }, hostId);

    const HOST = CONTENT_GLOBALS.highlightId;
    const rectOf = (page, selector) =>
      page.evaluate((sel) => document.querySelector(sel).getBoundingClientRect().toJSON(), selector);

    try {
      /* ════════════════════════════════ §10.2 — the soft highlight, on a hostile page */
      await check('§10.2 an unproved field is found by its value and outlined as a GUESS', async () => {
        const { page, tabId, sigId } = await openTrip('guess');
        const res = await send(MSG.HIGHLIGHT, { tabId, sigId, path: '$.status' });

        assert.equal(res.ok, true);
        assert.equal(res.verified, false, '§17.12: nothing here was proved, so nothing here says proved');
        assert.equal(
          res.elements, 3,
          `the pill, the banner and the one below the fold — and NOT the wrapper above them ` +
            `or the zero-sized one below (got ${res.elements})`
        );
        assert.equal(res.offscreen, 1, '#far is three screens down and is counted, not scrolled to');

        // Measured after the pop-in: until a box has `.on` it carries §9.2's entry
        // transform (scale .96), and a rect read through it is 4% short of the element.
        await sleep(300);
        const ui = await overlay(page, HOST);
        assert.equal(ui.present, true);
        assert.equal(ui.hosts, 1);
        assert.equal(ui.on, ui.count, '§10.3: every box pops in, staggered');
        assert.equal(ui.parentIsHtml, true, '§10.3/§6.1: appended to <html>, never <body>');
        assert.equal(ui.position, 'fixed');
        assert.equal(ui.pointerEvents, 'none', 'the page underneath stays clickable');
        assert.equal(ui.zIndex, '2147483646');
        assert.equal(ui.radius, '10px');
        for (const border of ui.borders) {
          assert.equal(border, '2px dashed rgb(178, 106, 0)', '§10.3: dashed warning for a guess, through `border:0!important`');
        }
        assert.deepEqual([...new Set(ui.chips)], ['status'], 'the chip is the field\'s own name');

        // The innermost element with the text, not <body> and not the <span> inside the pill.
        const pill = await rectOf(page, '#pill');
        assert.ok(
          ui.rects.some((r) => Math.abs(r.x - pill.x) < 1.5 && Math.abs(r.width - pill.width) < 1.5),
          `one outline is the pill itself (${JSON.stringify(ui.rects)} vs ${JSON.stringify(pill)})`
        );
        const wrap = await rectOf(page, '#wrap');
        assert.ok(
          !ui.rects.some((r) => Math.abs(r.height - wrap.height) < 1.5),
          'the innermost element with the text, never the container that merely holds it'
        );
        const inner = await rectOf(page, '#pill-inner');
        assert.ok(
          !ui.rects.some((r) => Math.abs(r.width - inner.width) < 1.5),
          '§6.1\'s smart walk: the pill, not the <span> a text search lands on'
        );
        await page.close();
      });

      /* ═════════════════════════════ §10.3 / §16 M5 DoD — a proved Link's own elements */
      await check('§16 M5 DoD "Show me" outlines every element the probe proved, solid', async () => {
        const { page, tabId, sigId, origin } = await openTrip('proved');
        const [pillFp, bannerFp] = await fingerprintsFor(tabId, ['#pill', '#banner']);
        await storeBinding(origin, {
          id: 'b-proved', origin, sigId, path: '$.status',
          elements: [pillFp, bannerFp],
          state: 'verified', lastVerifiedAt: Date.now(), observedValues: ['CANCELLED'], probeMode: 'refresh'
        });

        const res = await send(MSG.HIGHLIGHT, { tabId, sigId, path: '$.status' });
        assert.equal(res.ok, true);
        assert.equal(res.verified, true);
        assert.equal(res.elements, 2, 'the pill AND the banner — §7.6 found both, and both are drawn');
        assert.equal(res.lowConfidence, 0);

        await sleep(300);
        const ui = await overlay(page, HOST);
        assert.equal(ui.count, 2, 'and not the third element that merely shares the text');
        assert.equal(ui.on, 2, '§10.3: both pop in, staggered');
        for (const border of ui.borders) {
          assert.equal(border, '2px solid rgb(0, 102, 255)', '§10.3/§9.1: solid accent for a proved Link');
        }
        assert.equal(ui.chipBg, 'rgb(0, 102, 255)');

        const banner = await rectOf(page, '#banner');
        assert.ok(
          ui.rects.some((r) => Math.abs(r.x - banner.x) < 1.5 && Math.abs(r.width - banner.width) < 1.5),
          'the banner is one of them'
        );
        await page.close();
      });

      /* ══════════════════════════════════════════ §17.12 — the same elements, unproved */
      await check('§17.12 the SAME elements on a candidate link are drawn as a guess', async () => {
        const { page, tabId, sigId, origin } = await openTrip('candidate');
        const [pillFp] = await fingerprintsFor(tabId, ['#pill']);
        await storeBinding(origin, {
          id: 'b-candidate', origin, sigId, path: '$.status',
          elements: [pillFp],
          // The ONE difference from the check above.
          state: 'candidate', lastVerifiedAt: 0, observedValues: ['CANCELLED'], probeMode: 'refresh'
        });

        const res = await send(MSG.HIGHLIGHT, { tabId, sigId, path: '$.status' });
        assert.equal(res.verified, false, 'a stored candidate may not produce the solid overlay');
        const ui = await overlay(page, HOST);
        assert.ok(ui.borders.every((b) => b.includes('dashed')), `every outline is a guess (${JSON.stringify(ui.borders)})`);
        await page.close();
      });

      /* ═════════════════════════ §1.1 — a proved Link whose elements are no longer there */
      await check('§1.1 elements that no longer resolve are reported as ZERO drawn', async () => {
        const { page, tabId, sigId, origin } = await openTrip('lost');
        const [pillFp] = await fingerprintsFor(tabId, ['#pill']);
        await storeBinding(origin, {
          id: 'b-lost', origin, sigId, path: '$.crew.pilot',
          // A fingerprint for an element this page does not have and whose text is not on
          // it either: §6.2 falls through to the tree path, which resolves SOMETHING at
          // confidence 0.5 — "whatever is in that position now".
          elements: [{ css: '#gone-in-the-redesign', textAnchor: 'Nothing like this', attrAnchors: [], treePath: [0, 0] }],
          state: 'verified', lastVerifiedAt: Date.now(), observedValues: ['Rae'], probeMode: 'refresh'
        });

        const res = await send(MSG.HIGHLIGHT, { tabId, sigId, path: '$.crew.pilot' });
        assert.equal(res.ok, true);
        assert.equal(res.elements, 0, 'nothing was drawn, and that is what the panel turns into a Stale chip');
        assert.equal(res.resolved, 1, 'something WAS at that position');
        assert.equal(res.lowConfidence, 1, 'and MockLab was not sure enough to point at it');
        assert.equal(res.verified, true, 'the Link is still proved — its elements are what went missing');
        assert.equal((await overlay(page, HOST)).present, false, 'and no box was left on the page');
        await page.close();
      });

      /* ═══════════════════════════════════════════════════════ §10.3 — and then it goes */
      await check('§10.3 the overlays dismiss themselves, and a click takes them at once', async () => {
        const { page, tabId, sigId } = await openTrip('dismiss');
        await send(MSG.HIGHLIGHT, { tabId, sigId, path: '$.status' });
        assert.equal((await overlay(page, HOST)).present, true);
        await page.mouse.click(5, 5);
        await sleep(60);
        assert.equal((await overlay(page, HOST)).present, false, '§10.3: dismissed on click');

        await send(MSG.HIGHLIGHT, { tabId, sigId, path: '$.status' });
        assert.equal((await overlay(page, HOST)).present, true);
        await sleep(4600);
        assert.equal((await overlay(page, HOST)).present, false, '§10.3: gone after four seconds');
        assert.equal(
          await page.evaluate(() => document.querySelectorAll('div').length),
          7,
          'and the page is exactly as it was — MockLab leaves nothing behind (§1.3)'
        );
        await page.close();
      });

      await check('a second highlight replaces the first rather than stacking on it', async () => {
        const { page, tabId, sigId } = await openTrip('twice');
        await send(MSG.HIGHLIGHT, { tabId, sigId, path: '$.status' });
        const first = await overlay(page, HOST);
        const answer = await send(MSG.HIGHLIGHT, { tabId, sigId, path: '$.price.total' });
        assert.equal(answer.elements, 1, 'the second question has an answer of its own');
        const second = await overlay(page, HOST);
        assert.equal(second.hosts, 1, 'one host, not two answers about the same page at once');
        assert.deepEqual([...new Set(second.chips)], ['total'], 'and it is the second question that is on screen');
        assert.notEqual(first.count, 0);
        await page.close();
      });

      await check('§9.1 the overlays follow prefers-color-scheme, like the picker\'s', async () => {
        const page = await ctx.newPage();
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto(`${fixtureOrigin}/trip?case=dark`, { waitUntil: 'load' });
        const tabId = await tabIdOf(page);
        const sources = await waitForSources(tabId, 1);
        const sigId = sources.sources[0].sigId;
        const [pillFp] = await fingerprintsFor(tabId, ['#pill']);

        await send(MSG.HIGHLIGHT, { tabId, sigId, path: '$.status' });
        const guess = await overlay(page, HOST);
        assert.equal(guess.borders[0], '2px dashed rgb(253, 214, 99)', '§9.1 dark --warning');

        await storeBinding(sources.origin, {
          id: 'b-dark', origin: sources.origin, sigId, path: '$.status',
          elements: [pillFp], state: 'verified', lastVerifiedAt: Date.now(), observedValues: [], probeMode: 'refresh'
        });
        await send(MSG.HIGHLIGHT, { tabId, sigId, path: '$.status' });
        const proved = await overlay(page, HOST);
        assert.equal(proved.borders[0], '2px solid rgb(74, 144, 255)', '§9.1 dark --accent');
        assert.equal(proved.chipBg, 'rgb(74, 144, 255)');
        await page.close();
      });

      /* ══════════════════════════════════════════════════ honest failure, no fantasy */
      await check('§1.1 a tab MockLab cannot reach is a failure, never "no elements"', async () => {
        const answer = await send(MSG.HIGHLIGHT, { tabId: 987654321, sigId: 'nope', path: '$.status' });
        assert.equal(answer.ok, false);
        assert.equal(answer.elements, undefined);
      });

      await check('the service worker logged no errors during any of this', () => {
        assert.deepEqual(swErrors, []);
      });
    } finally {
      if (ctx) await ctx.close().catch(() => {});
      fixtures.close();
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });
}

/** Referenced so a rename of the harness's export is a loud failure here too. */
assert.equal(typeof EXTENSION_DIR, 'string');
