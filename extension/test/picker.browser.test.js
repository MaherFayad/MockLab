/**
 * The element picker and candidate discovery, in real Chromium, against the REAL
 * unpacked extension (PLAN.md §6.1, §6.2, §6.3, §7.3; §16 M3 DoD).
 *
 * OWNER: probe-engineer.
 *
 * A picker cannot be proved by unit tests. Everything that makes it right or wrong is
 * browser behaviour: whether the overlay survives the site's own CSS, whether a click
 * reaches the page underneath, whether the listeners really came off, whether
 * `prefers-color-scheme` picks the right accent, whether the area ratio in §6.1's smart
 * walk measures anything real. So the §16 M3 DoD is asserted here, end to end, through
 * the same messages the side panel sends.
 *
 * This half drives the GENUINE extension end to end — panel -> service worker ->
 * content script -> service worker — so a break anywhere in that chain fails here.
 * `pickerdom.browser.test.js` is the other half: `picker.js`'s DOM logic, called
 * directly in a page, which is the only way to reach code that otherwise lives in an
 * extension's isolated world.
 *
 * Every fixture is in this file: `node --test` runs every .js under `test/`, so a
 * separate fixture module would be executed as a test (README Deviations 15).
 *
 * Skips (never fails) when Playwright or a Chromium build is unavailable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The real constants: a rename in the contract breaks this suite loudly.
import { MSG } from '../src/background/messages.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(HERE, '..');

/* --------------------------------------------------------------- playwright lookup */

/** Same derivation as `e2e.browser.test.js`: a global install is off this resolution path. */
function globalPackageRoots() {
  const roots = [];
  try {
    roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    /* npm is not on PATH */
  }
  roots.push(path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules'));
  for (const entry of String(process.env.NODE_PATH || '').split(path.delimiter)) {
    if (entry) roots.push(entry);
  }
  return [...new Set(roots.filter(Boolean))];
}

async function loadChromium() {
  for (const name of ['playwright', 'playwright-core']) {
    try {
      const mod = await import(name);
      if (mod && mod.chromium) return mod.chromium;
    } catch {
      /* not installed locally */
    }
  }
  for (const root of globalPackageRoots()) {
    for (const name of ['playwright', 'playwright-core']) {
      for (const entry of ['index.mjs', 'index.js']) {
        const file = path.join(root, name, entry);
        if (!fs.existsSync(file)) continue;
        try {
          const mod = await import(pathToFileURL(file).href);
          const chromium = (mod && mod.chromium) || (mod && mod.default && mod.default.chromium);
          if (chromium) return chromium;
        } catch {
          /* try the next candidate */
        }
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------------ fixtures */

/**
 * A page that fights back, the way real sites do: `!important` resets on everything,
 * a nested pill whose inner span is what `elementFromPoint` returns, a wrapper that
 * shares its child's text but is far too big to be the semantic element, and a click
 * handler that navigates away if a click ever reaches it.
 */
const HOSTILE = `<!doctype html><html><head><meta charset="utf-8"><title>hostile</title><style>
  *{border:0!important;border-radius:0!important;background:none!important;cursor:default!important;
    box-shadow:none!important;transition:none!important;animation:none!important}
  body{margin:0;font:16px system-ui}
  #pill{display:inline-block;padding:1px 5px;margin:40px}   /* 1.28x its span — see the walk subtest */
  #huge{display:block;width:600px;height:400px}
  #btn{display:block;margin:20px}
</style></head><body>
  <div id="pill"><span id="inner">On time</span></div>
  <div id="huge"><em id="tiny">Rare</em></div>
  <button id="btn">Press</button>
  <script>
    window.__clicks = 0; window.__downs = 0;
    document.addEventListener('click', function(){ window.__clicks++; });
    document.addEventListener('mousedown', function(){ window.__downs++; });
  </script>
</body></html>`;

function fixtureHandler(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (body) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  };
  if (url.pathname === '/hostile') return send(HOSTILE);
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------------------- suite */

const chromium = await loadChromium();

if (!chromium) {
  test('picker browser suite', { skip: 'Playwright is not installed — `npm i -D playwright && npx playwright install chromium` enables it.' }, () => {});
} else {
  test('the MockLab picker in real Chromium', async (t) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mocklab-pick-'));
    const fixtures = http.createServer(fixtureHandler);
    const fixtureOrigin = `http://127.0.0.1:${await listen(fixtures)}`;

    let demoServer = null;
    let demoOrigin = null;
    try {
      const { createServer } = await import('../../companion/src/index.js');
      demoServer = createServer();
      demoOrigin = `http://127.0.0.1:${await listen(demoServer)}`;
    } catch {
      demoServer = null; // the demo subtests skip without it
    }

    let ctx = null;
    try {
      ctx = await chromium.launchPersistentContext(profile, {
        channel: 'chromium',
        args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`]
      });
    } catch (err) {
      fixtures.close();
      if (demoServer) demoServer.close();
      fs.rmSync(profile, { recursive: true, force: true });
      t.skip(`Chromium could not be launched (${err.message.split('\n')[0]})`);
      return;
    }

    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
    const swErrors = [];
    sw.on('console', (m) => { if (m.type() === 'error') swErrors.push(m.text()); });

    const panel = await ctx.newPage();
    await panel.goto(sw.url().split('/src/')[0] + '/src/panel/panel.html');

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

    /** Poll rather than sleep: the pick answer crosses two process boundaries. */
    async function waitForPhase(tabId, phase, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        last = await send(MSG.GET_PICK, { tabId });
        if (last && last.phase === phase) return last;
        await sleep(60);
      }
      return last;
    }

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

    /** Read the overlay the content script drew, through its open shadow root. */
    const overlayState = (page) =>
      page.evaluate(() => {
        const host = document.getElementById('__mocklab_overlay__');
        if (!host) return { present: false };
        const hostStyle = getComputedStyle(host);
        const root = host.shadowRoot || host;
        const box = root.querySelector('.box');
        const chip = root.querySelector('.chip');
        const boxStyle = box ? getComputedStyle(box) : null;
        return {
          present: true,
          parentIsHtml: host.parentElement === document.documentElement,
          position: hostStyle.position,
          pointerEvents: hostStyle.pointerEvents,
          zIndex: hostStyle.zIndex,
          shown: Boolean(box && box.classList.contains('on')),
          rect: box ? box.getBoundingClientRect().toJSON() : null,
          border: boxStyle && boxStyle.borderTopWidth + ' ' + boxStyle.borderTopStyle + ' ' + boxStyle.borderTopColor,
          radius: boxStyle && boxStyle.borderTopLeftRadius,
          transition: boxStyle && boxStyle.transitionDuration + ' ' + boxStyle.transitionTimingFunction,
          chipText: chip ? chip.textContent : null,
          chipBg: chip ? getComputedStyle(chip).backgroundColor : null,
          cursor: getComputedStyle(document.documentElement).cursor
        };
      });

    const boxOf = (page, selector) =>
      page.evaluate((sel) => document.querySelector(sel).getBoundingClientRect().toJSON(), selector);

    /** Move the real mouse to the centre of an element and let one rAF pass. */
    async function hover(page, selector) {
      const rect = await boxOf(page, selector);
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
      await sleep(120);
      return rect;
    }

    try {
      /* ═══════════════════════════════════ §6.1 — the overlay contract, on a hostile page */
      await t.test('§6.1 the hover overlay survives a page that resets everything', async () => {
        const page = await ctx.newPage();
        await page.goto(fixtureOrigin + '/hostile?case=overlay', { waitUntil: 'load' });
        const tabId = await tabIdOf(page);

        assert.deepEqual(await send(MSG.START_PICK, { tabId }), { ok: true, tabId });
        const rect = await hover(page, '#inner');
        const ui = await overlayState(page);

        assert.equal(ui.present, true, 'the overlay container exists');
        assert.equal(ui.parentIsHtml, true, '§6.1: appended to <html>, never <body>');
        assert.equal(ui.position, 'fixed');
        assert.equal(ui.pointerEvents, 'none');
        assert.equal(ui.zIndex, '2147483646');
        assert.equal(ui.shown, true, 'and it is actually drawn');
        assert.equal(ui.border, '2px solid rgb(0, 102, 255)', '§6.1/§9.1 light accent, through `border:0!important`');
        assert.equal(ui.radius, '10px', '§6.1: 10px radius');
        assert.equal(ui.transition, '0.25s cubic-bezier(0.4, 0, 0.2, 1)', '§6.1/§9.1: the panel\'s motion');
        assert.equal(ui.cursor, 'crosshair', 'through the page\'s `cursor:default!important`');

        // §6.1's smart target: elementFromPoint returned the <span>, the outline is
        // around the pill. Compare against the PILL's box, not the span's.
        const pill = await boxOf(page, '#pill');
        assert.ok(Math.abs(ui.rect.x - pill.x) < 1.5 && Math.abs(ui.rect.width - pill.width) < 1.5,
          `the outline tracks the pill (${JSON.stringify(ui.rect)} vs ${JSON.stringify(pill)})`);
        assert.ok(ui.rect.width > rect.width, 'which is wider than the span inside it');
        assert.equal(ui.chipText, 'div “On time”', '§6.1: the label chip is tag + trimmed text');

        await send(MSG.CANCEL_PICK, { tabId });
        await page.close();
      });

      await t.test('§6.1 the accent follows prefers-color-scheme', async () => {
        const page = await ctx.newPage();
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto(fixtureOrigin + '/hostile?case=dark', { waitUntil: 'load' });
        const tabId = await tabIdOf(page);
        await send(MSG.START_PICK, { tabId });
        await hover(page, '#inner');
        const ui = await overlayState(page);
        assert.equal(ui.border, '2px solid rgb(74, 144, 255)', '§9.1 dark --accent');
        assert.equal(ui.chipBg, 'rgb(74, 144, 255)');
        await send(MSG.CANCEL_PICK, { tabId });
        await page.close();
      });

      /* ══════════════════════════════════ §6.1 — the page must not feel the picker */
      await t.test('§6.1 pick mode swallows the press, and Escape gives the page back', async () => {
        const page = await ctx.newPage();
        await page.goto(fixtureOrigin + '/hostile?case=escape', { waitUntil: 'load' });
        const tabId = await tabIdOf(page);
        const counters = () => page.evaluate(() => ({ clicks: window.__clicks, downs: window.__downs }));

        // Baseline: the page's own handlers work before MockLab touches anything.
        await page.click('#btn');
        assert.deepEqual(await counters(), { clicks: 1, downs: 1 }, 'the fixture counts a normal click');

        await send(MSG.START_PICK, { tabId });
        await hover(page, '#btn');
        await page.mouse.down();
        await page.mouse.up();
        assert.deepEqual(await counters(), { clicks: 1, downs: 1 }, 'nothing reached the page during pick mode');
        let picked = await waitForPhase(tabId, 'picked');
        assert.equal(picked.phase, 'picked', 'the button was picked instead');

        // Escape from a fresh pick, then prove every listener really came off.
        // The wait is load-bearing: the confirm flash above schedules its own teardown
        // 400 ms after the click, and that timer must not remove the NEXT pick's
        // overlay. Asserting sooner than 400 ms would pass either way.
        await send(MSG.START_PICK, { tabId });
        await hover(page, '#btn');
        await sleep(500);
        assert.equal((await overlayState(page)).shown, true,
          'a pick started during the previous confirm flash keeps its overlay');
        await page.keyboard.press('Escape');
        const idle = await waitForPhase(tabId, 'idle');
        assert.equal(idle.phase, 'idle', 'Escape reports back to the panel — it does not just vanish');

        const after = await overlayState(page);
        assert.equal(after.present, false, 'the overlay container is gone');
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).cursor), 'default',
          'and so is the crosshair style');
        assert.equal(await page.evaluate(() => document.querySelectorAll('style[data-mocklab]').length), 0);

        await page.click('#btn');
        assert.deepEqual(await counters(), { clicks: 2, downs: 2 }, 'the page is fully its own again');
        await page.close();
      });

      /* ═══════════════════════════════════════════════ §16 M3 DoD 1 — the demo pill */
      await t.test('§16 M3 DoD — picking the demo status pill finds `status`', async (tt) => {
        if (!demoServer) { tt.skip('the companion demo site is not available'); return; }
        const page = await ctx.newPage();
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(String(e)));
        page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

        await page.goto(demoOrigin + '/demo/?case=pill', { waitUntil: 'load' });
        const tabId = await tabIdOf(page);
        const sources = await waitForSources(tabId, 2);
        assert.equal(sources.sources.length, 2, 'both demo sources are captured before the pick');

        assert.equal((await send(MSG.GET_PICK, { tabId })).phase, 'idle');
        await send(MSG.START_PICK, { tabId });
        assert.equal((await send(MSG.GET_PICK, { tabId })).phase, 'picking');

        await hover(page, '#status-pill');
        await page.mouse.down();
        await page.mouse.up();

        const result = await waitForPhase(tabId, 'picked');
        assert.equal(result.phase, 'picked');

        // The element, as §7.3 defines a snapshot.
        assert.equal(result.element.text, 'On time');
        assert.equal(result.element.tag, 'div');
        assert.equal(result.element.label, 'On time');
        assert.equal(result.element.attrs.id, 'status-pill');
        assert.ok(!('class' in result.element.attrs) && !('style' in result.element.attrs),
          '§7.3: class and style are not attributes here — they have their own fields');
        assert.equal(result.element.style.backgroundColor, 'rgb(230, 244, 234)', 'the pill\'s real green');
        assert.equal(result.element.childCount, 0);

        // §16 M3 DoD 1. The pill says "On time"; the data says "ON_TIME".
        const top3 = result.candidates.slice(0, 3).map((c) => c.path);
        assert.ok(top3.includes('$.status'), `$.status in the top 3, got ${JSON.stringify(top3)}`);
        const status = result.candidates.find((c) => c.path === '$.status');
        assert.equal(status.value, 'ON_TIME');
        assert.equal(status.sourceName, 'Trip', 'named the way the Sources tab names it');
        assert.ok(status.rules.includes('sibling-key'), '§6.3\'s enum heuristic is one of the rules that found it');
        assert.ok(
          result.candidates.every((c) => !('state' in c)),
          '§17.4: a candidate is a guess and carries no link state at all'
        );

        // The trip response was the one that rendered it; the user response was not —
        // and user.json carries `$.user.status`, a status-ish key in a response that
        // renders no part of the pill. §6.3's gate is what keeps it out.
        const trip = sources.sources.find((s) => s.name === 'Trip');
        assert.ok(result.candidates.every((c) => c.sigId === trip.sigId), 'no field of user.json is offered');
        const userBody = await send(MSG.GET_RESPONSE, { tabId, sigId: sources.sources.find((s) => s.name === 'User').sigId });
        assert.equal(userBody.body.user.status, 'ACTIVE', 'and the unrelated status-ish key really is in the fixture');

        // §1.1: an empty or short list is only "nothing more is there" when the search
        // reached everywhere, and the panel is told which it was.
        assert.deepEqual(result.searched, { sources: 2, bounded: 0, complete: true },
          'the demo is small enough to search exhaustively, and the answer says so');

        // §6.3's honesty clause: a reload clears the tab's captures, so the answer that
        // pointed at them must go too rather than lingering as last page's truth.
        await page.reload({ waitUntil: 'load' });
        const afterReload = await waitForPhase(tabId, 'idle');
        assert.equal(afterReload.phase, 'idle');
        assert.equal(afterReload.candidates.length, 0);

        assert.deepEqual(pageErrors, [], 'the demo console stays clean through a pick');
        await page.close();
      });

      /* ═══════════════════════════════════════════════ §16 M3 DoD 2 — the demo price */
      await t.test('§16 M3 DoD — picking the demo price finds price.total', async (tt) => {
        if (!demoServer) { tt.skip('the companion demo site is not available'); return; }
        const page = await ctx.newPage();
        await page.goto(demoOrigin + '/demo/?case=price', { waitUntil: 'load' });
        const tabId = await tabIdOf(page);
        await waitForSources(tabId, 2);

        await send(MSG.START_PICK, { tabId });
        await hover(page, '#price-total');
        await page.mouse.down();
        await page.mouse.up();

        const result = await waitForPhase(tabId, 'picked');
        assert.equal(result.element.text, 'SAR 450.00');
        const total = result.candidates.find((c) => c.path === '$.price.total');
        assert.ok(total, `$.price.total must be found, got ${JSON.stringify(result.candidates.map((c) => c.path))}`);
        assert.equal(total.via, 'numeric', 'by numeric match — the page formatted the rest');
        assert.equal(total.value, 450);
        assert.equal(result.candidates[0].path, '$.price.total', 'and it ranks first');
        await page.close();
      });

      /* ══════════════════════════════════════════════════ honest failure, no fantasy */
      await t.test('§1.1 a tab with no page agent is told so, not left waiting', async () => {
        const answer = await send(MSG.START_PICK, { tabId: 987654321 });
        assert.deepEqual(answer, { ok: false, reason: 'no-content-script' });
      });

      assert.deepEqual(swErrors, [], 'the service worker logged no errors during any of this');
    } finally {
      await ctx.close().catch(() => {});
      fixtures.close();
      if (demoServer) demoServer.close();
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });
}
