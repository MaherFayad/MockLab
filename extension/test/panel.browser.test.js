/**
 * The side panel (PLAN.md §10), driven as a human drives it, in real Chromium with the
 * real unpacked extension and the real demo site (§14).
 *
 * OWNER: panel-designer. Added at M2 — an additive deviation from §2.1's file tree, for
 * the same reason `e2e.browser.test.js` was added at M1: every defect that mattered here
 * was invisible to unit tests. The §16 M2 DoD is a sequence of UI actions ending in a
 * red pill on a page the extension never touched directly, M3's is a click on the page
 * turning into a list of guesses in the panel, and the §1.1 honesty guarantee is a chip
 * that must say "Possible" and must never say "Verified ✓". None can be asserted without
 * a browser, and a guard CI cannot run is not a guard.
 *
 * Rules this file follows, the first two learned the hard way in M1:
 *   - it SKIPS, never fails, when Playwright or a Chromium build is absent, so
 *     `npm test -ws` stays green on a plain Node machine;
 *   - it resolves Playwright at run time and hardcodes no machine's path;
 *   - it MEASURES the panel and never restates a number panel.css already knows. A
 *     constant copied out of the stylesheet keeps its old value after the stylesheet
 *     changes, and a geometry test whose model is stale stays green while describing a
 *     layout that no longer exists — the same silent drift §17.10's line counts had.
 *
 * Every expected string is imported from `../src/panel/strings.js`, so §17.6 holds here
 * too: this file cannot drift from §11's copy, because it has no copy of its own.
 *
 * All fixtures live in this one file on purpose — `node --test` executes EVERY .js file
 * under `test/`, so a shared helper module would be run as a test file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { S } from '../src/panel/strings.js';
import { MSG } from '../src/background/messages.js';
import { createServer } from '../../companion/src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(HERE, '..');

/** The value the demo maps to a red pill and a banner (§14). */
const CANCELLED = 'CANCELLED';

/* ------------------------------------------------------- portable Playwright */

/**
 * Directories where a GLOBALLY installed package lives. A global install is not on this
 * workspace's resolution path, so a bare `import('playwright')` misses it. Every root
 * here is derived from the running Node — none is a path from one machine.
 */
function globalPackageRoots() {
  const roots = [];
  try {
    roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    /* npm is not on PATH — the other guesses still stand */
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

/* --------------------------------------------------------------- page helpers */

/** The demo's status pill, as the SITE renders it — never as MockLab reports it. */
function readPill(page) {
  return page.evaluate(() => {
    const pill = document.getElementById('status-pill');
    const banner = document.getElementById('alert-banner');
    return {
      text: pill ? pill.textContent.trim() : null,
      cls: pill ? pill.className : null,
      color: pill ? getComputedStyle(pill).color : null,
      bannerText: banner ? banner.textContent.trim() : null,
      bannerShown: banner ? getComputedStyle(banner).display !== 'none' : false
    };
  });
}

/** The card for one friendly source name (§10.2). */
function cardFor(panel, name) {
  return panel.locator('#source-list .card').filter({ hasText: name }).first();
}

/** A ROOT-level tree row — `$.status`, not `$.booking.status`. */
function rootRow(panel, text) {
  return panel.locator('#source-list .tree > .tree__group > .tree__row', { hasText: text }).first();
}

/**
 * Render the Pick tab (§10.1) from a state this milestone cannot otherwise produce, and
 * measure what a person would see.
 *
 * The subtest above this one reaches State C for real, through the button, the worker,
 * the page agent and the demo. What it CANNOT reach is the rest of the state space: a
 * source list longer than 12, an element whose text matches nothing, an element with no
 * text at all, and above all §10.1A's "Recent links" — which needs a Binding the probe
 * has confirmed, and nothing may write that word before M4 (§17.4). Leaving those
 * screens unlooked-at until a later milestone is how a design ships unseen, so this
 * imports the panel's own module INSIDE the real panel page and renders into the real
 * `#panel-pick`, against the real stylesheet: the STATE is simulated, the rendering, the
 * cascade and the geometry are not.
 *
 * Deliberately not a hook in the product code. pick.js exports what the panel itself
 * imports and nothing more — a test seam in shipping code is a thing that can be wrong
 * in production, and this file needs none.
 */
function renderPick(page, patch) {
  return page.evaluate(async (given) => {
    const mod = await import('/src/panel/pick.js');
    const root = document.getElementById('panel-pick');
    const ctx = {
      state: Object.assign(
        {
          tabId: 1,
          sources: [],
          settings: { advancedMode: false },
          bindings: [],
          pick: { picking: false, element: null, candidates: [] }
        },
        given
      ),
      send: async () => ({ ok: true }),
      toast: () => {},
      rerender: () => {}
    };
    mod.renderPickTab(root, ctx);
    mod.pickingChrome(ctx.state.pick.picking);

    // Show the tab, or innerText reads '' and every text assertion below passes vacuously.
    document.getElementById('tab-pick').checked = true;
    for (const name of ['pick', 'sources', 'scenarios', 'settings']) {
      document.getElementById(`panel-${name}`).classList.toggle('hidden', name !== 'pick');
    }

    /**
     * One element's opacity AS DESIGNED, not as mid-animation.
     *
     * The dim is a 250ms transition, and this panel has to stay a BACKGROUND tab for the
     * rest of the suite to describe the demo — Chromium suspends rendering there, so the
     * transition never advances and a plain read returns its starting value however long
     * the test waits. (It cost an hour: freshly created nodes read 0.6 because they never
     * transitioned at all, while the one pre-existing node stayed at 1 forever.)
     * Suspending the transition makes the computed value jump to the end state, which is
     * the thing worth asserting — the same technique the tooltip subtest above uses.
     */
    const opacity = (sel) => {
      const node = document.querySelector(sel);
      if (!node) return null;
      const inline = node.style.transition;
      node.style.transition = 'none';
      const value = Number(getComputedStyle(node).opacity);
      node.style.transition = inline;
      return value;
    };
    const textsOf = (sel) => [...root.querySelectorAll(sel)].map((n) => n.textContent.trim());
    const primary = root.querySelector('.btn--primary');
    return {
      missingContract: mod.missingPickContract(),
      rootText: root.innerText,
      bodyText: document.body.innerText,
      cards: root.querySelectorAll('.card').length,
      emptyBoxes: root.querySelectorAll('.empty').length,
      chips: textsOf('.chip'),
      sectionTitles: textsOf('.section-title'),
      helps: textsOf('.help'),
      primary: primary
        ? {
            text: primary.textContent.trim(),
            disabled: primary.disabled,
            icons: primary.querySelectorAll('svg').length,
            // How strongly the label is actually painted. §9.2's disabled recipe is
            // opacity .7 + saturate(.7) brightness(.85); on State B's button that is the
            // difference between a readable instruction and a 2.87:1 one.
            paint: {
              opacity: Number(getComputedStyle(primary).opacity),
              filter: getComputedStyle(primary).filter,
              shadow: getComputedStyle(primary).boxShadow
            }
          }
        : null,
      secondaries: [...root.querySelectorAll('.btn--secondary')].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled })),
      picked: root.querySelector('.picked__text') ? root.querySelector('.picked__text').textContent : null,
      rows: [...root.querySelectorAll('.cand')].map((row) => ({
        name: row.querySelector('.cand__name').textContent,
        value: row.querySelector('.cand__value').textContent,
        field: row.querySelector('.cand__field') ? row.querySelector('.cand__field').textContent : null,
        valueFont: getComputedStyle(row.querySelector('.cand__value')).fontFamily,
        // Everything the row actually SAYS. Two rows with the same reading are two
        // different fields drawn as one thing.
        reading: row.innerText.replace(/\s+/g, ' ').trim(),
        paths: row.querySelectorAll('.cand__path').length
      })),
      // §10.1B's dim, measured rather than restated: the panel recedes, the live
      // instruction does not.
      dim: {
        head: opacity('.app__head'),
        title: opacity('#panel-pick h2'),
        body: opacity('#panel-pick p.help'),
        live: opacity('#panel-pick .pick-live')
      },
      linkCards: [...root.querySelectorAll('.card')].map((card) => ({
        cursor: getComputedStyle(card).cursor,
        chevrons: card.querySelectorAll('.card__chevron').length,
        clickable: card.tagName === 'BUTTON' || card.tagName === 'A'
      }))
    };
  }, patch);
}

/** A Binding the probe would write at M4 — the only thing §10.1A's list may ever show. */
function verifiedLink(path, textAnchor, value, lastVerifiedAt) {
  return {
    id: `id-${path}`,
    origin: 'http://127.0.0.1',
    sigId: 'sig-trip',
    path,
    elements: [{ css: '#status-pill', textAnchor, attrAnchors: [], treePath: [] }],
    state: 'verified',
    lastVerifiedAt,
    observedValues: [value],
    probeMode: 'refresh'
  };
}

const chromium = await loadChromium();

if (!chromium) {
  test('panel browser suite', { skip: 'Playwright is not installed — `npm i -D playwright && npx playwright install chromium` enables it.' }, () => {});
} else {
  test('side panel — PLAN.md §10 and the §16 M2 and M3 definitions of done', async (t) => {
    let server = null;
    let ctx = null;
    let profile = null;

    try {
      server = createServer();
      // Port 0: never collide with a companion the developer already has running.
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mocklab-panel-'));
      ctx = await chromium.launchPersistentContext(profile, {
        channel: 'chromium',
        args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`]
      });
    } catch (err) {
      // No Chromium build (or no sandbox to launch it in) is an ABSENT DEPENDENCY, not
      // a failing product. Same contract as the M1 suite: skip loudly, never fail.
      if (ctx) await ctx.close().catch(() => {});
      if (server) server.close();
      if (profile) fs.rmSync(profile, { recursive: true, force: true });
      t.skip(`Chromium could not be launched (${err && err.message}) — install it with \`npx playwright install chromium\`.`);
      return;
    }

    const demoUrl = `http://127.0.0.1:${server.address().port}/demo/`;
    const panelErrors = [];

    try {
      let [worker] = ctx.serviceWorkers();
      if (!worker) worker = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
      const extensionId = new URL(worker.url()).host;

      const demo = await ctx.newPage();
      await demo.goto(demoUrl, { waitUntil: 'networkidle' });

      const panel = await ctx.newPage();
      panel.on('pageerror', (err) => panelErrors.push(`pageerror: ${err.message}`));
      panel.on('console', (msg) => msg.type() === 'error' && panelErrors.push(msg.text()));
      await panel.setViewportSize({ width: 400, height: 900 });
      await panel.goto(`chrome-extension://${extensionId}/src/panel/panel.html`);

      // The panel reads the ACTIVE tab, exactly as it does when Chrome hosts it in the
      // side panel next to the page. Here it is an ordinary tab, so the demo has to be
      // brought forward or the panel would describe itself.
      await demo.bringToFront();
      await panel.waitForTimeout(800);
      await panel.click('label[for="tab-sources"]');
      await panel.waitForTimeout(600);

      await t.test('the typography is bundled, not fetched from a third party (§1.4)', async () => {
        const fonts = await panel.evaluate(async () => {
          await document.fonts.ready;
          return {
            faces: [...document.fonts].map((f) => `${f.family}/${f.weight}`),
            inter: document.fonts.check('600 14px Inter')
          };
        });
        assert.ok(fonts.inter, 'Inter should be available to the panel with no network');
        assert.ok(fonts.faces.includes('Inter/600'), `Inter 600 should be declared, got ${fonts.faces.join(', ')}`);
        assert.ok(fonts.faces.some((f) => f.startsWith('Fira Code')), 'Fira Code should be declared');
        const css = fs.readFileSync(path.join(EXTENSION_DIR, 'src/panel/panel.css'), 'utf8');
        assert.equal(/^\s*@import/m.test(css), false, 'panel.css must not @import a remote stylesheet');
      });

      await t.test('the Sources tab lists both demo sources with friendly names (§10.2)', async () => {
        const names = await panel.$$eval('#source-list .card__title .truncate', (nodes) => nodes.map((n) => n.textContent));
        assert.deepEqual([...names].sort(), ['Trip', 'User']);
        const meta = await cardFor(panel, 'Trip').locator('.card__meta').innerText();
        assert.ok(meta.includes(S.sources.fields(18)), `expected "${S.sources.fields(18)}" in "${meta}"`);
      });

      await t.test('a card opens the response tree, scalar rows offer both §10.2 actions', async () => {
        await cardFor(panel, 'Trip').locator('.card__head').click();
        await panel.waitForTimeout(700);
        const rows = await panel.locator('#source-list .tree__row').count();
        assert.ok(rows > 10, `expected a populated tree, got ${rows} rows`);
        const row = rootRow(panel, 'ON_TIME');
        const labels = await row.locator('button[aria-label]').evaluateAll((n) => n.map((b) => b.getAttribute('aria-label')));
        assert.ok(labels.includes(S.sources.changeValue), 'the ✏️ action must be present');
        assert.ok(labels.includes(S.sources.showOnPage), 'the ◎ action must be present');
      });

      await t.test('the editor says Possible, never Verified (§1.1, §10.6, §17.4)', async () => {
        await rootRow(panel, 'ON_TIME').locator(`button[aria-label="${S.sources.changeValue}"]`).click();
        await panel.waitForTimeout(500);

        const chips = await panel.$$eval('.editor .chip', (nodes) => nodes.map((n) => n.textContent.trim()));
        assert.deepEqual(chips, [S.chips.candidate], 'the editor carries exactly one chip, and it is Possible');

        const editorText = await panel.locator('.editor').innerText();
        assert.ok(editorText.includes(S.editor.unverified), '§11 editor.unverified must be on screen');
        assert.ok(editorText.includes(S.editor.original('ON_TIME')), 'the real value must be shown');

        // The whole product's credibility is this line: nothing anywhere in the panel
        // may claim a proven link before a probe has ever run (§0.2, §17.4).
        const everything = await panel.locator('body').innerText();
        assert.equal(
          everything.includes(S.chips.verified),
          false,
          `"${S.chips.verified}" must not appear anywhere before a probe has run`
        );
      });

      await t.test('apply & refresh: the SITE renders the new state, with no probe (§16 M2)', async () => {
        await panel.fill('#ml-value', CANCELLED);
        await panel.click('.editor__actions .btn--primary');
        await panel.waitForTimeout(2500);
        await demo.waitForLoadState('networkidle');

        const pill = await readPill(demo);
        assert.equal(pill.text, 'Cancelled');
        assert.ok(pill.cls.includes('is-cancelled'), `the site's own class should drive the pill, got "${pill.cls}"`);
        assert.equal(pill.color, 'rgb(217, 48, 37)');
        assert.equal(pill.bannerShown, true, 'the derived banner must appear too');
        assert.equal(pill.bannerText, 'Your flight was cancelled');

        // "with no probe" is the load-bearing half. §10.2 says an edit made from the tree
        // DOES record a link, and that link stays `candidate` — which is what feeds the
        // Possible chip the previous subtest asserted. §17.4 says only the probe's
        // CONFIRMED state may ever write `verified`, and no probe has run here.
        const bindings = await panel.evaluate(async () => {
          const bag = await chrome.storage.local.get(null);
          return Object.entries(bag)
            .filter(([key]) => key.startsWith('bindings:'))
            .flatMap(([, value]) => (Array.isArray(value) ? value : []));
        });
        for (const binding of bindings) {
          assert.notEqual(binding.state, 'verified', `no probe ran, so ${binding.path} must not be verified (§17.4)`);
        }
        const link = bindings.find((b) => b.path === '$.status');
        assert.ok(link, 'the edit should record the link it acted on');
        assert.equal(link.state, 'candidate');
        assert.deepEqual(link.elements, [], 'nothing was proven about which elements it drives');
        assert.equal(link.lastVerifiedAt, 0);
      });

      await t.test('the changed row shows real → new, and the site bar counts it (§10.2, §1.5)', async () => {
        await panel.waitForTimeout(600);
        const changed = await panel.locator('#source-list .tree__row--changed').first().innerText();
        assert.ok(changed.includes('ON_TIME'), 'the real value stays visible');
        assert.ok(changed.includes(CANCELLED), 'the new value is shown beside it');

        const bar = await panel.locator('#sitebar').innerText();
        assert.ok(bar.includes(S.site.changes(1)), `expected "${S.site.changes(1)}" in "${bar}"`);
        assert.ok(bar.includes(S.site.reset), 'Reset site appears once a change is active');

        const badge = await worker.evaluate(async (url) => {
          const [tab] = await chrome.tabs.query({ url: url + '*' });
          return tab ? chrome.action.getBadgeText({ tabId: tab.id }) : null;
        }, demoUrl);
        assert.equal(badge, '1', 'the toolbar badge mirrors the active-change count');
      });

      await t.test('no tab tooltip covers the Reset site control (§10 site bar)', async () => {
        // A tooltip that hides the way to undo every change is worse than no tooltip.
        // The tab strip opens its bubbles downward into the site bar's margin, and that
        // margin is sized for them — a geometry relationship no other kind of test sees.
        const measured = await panel.evaluate(() => {
          const hit = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
          const box = (node) => {
            const b = node.getBoundingClientRect();
            return { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
          };

          /**
           * One tooltip's box AS SHOWN — put into its shown state, then measured.
           *
           * `.tip__bubble` rests translated away from where it is read and slides in, so
           * its resting box is not the box that covers anything. It is revealed the way a
           * keyboard user reveals it (`.tip:focus-within`, which each tab's radio input
           * satisfies) because :hover is not delivered to a background tab and this panel
           * has to stay in the background for the site bar to describe the DEMO tab.
           * The transition is suspended so this reads the end state and not a frame of
           * the animation; focus and the inline style are both put back afterwards.
           */
          const shownBox = (opt) => {
            const bubble = opt.querySelector('.tip__bubble');
            const input = opt.querySelector('input');
            const previous = document.activeElement;
            const inline = bubble.style.transition;
            bubble.style.transition = 'none';
            input.focus({ preventScroll: true });
            const shown = box(bubble);
            const revealed = getComputedStyle(bubble).opacity === '1';
            if (previous && previous.focus) previous.focus({ preventScroll: true });
            else input.blur();
            bubble.style.transition = inline;
            return { ...shown, revealed };
          };

          const reset = document.querySelector('#sitebar .btn--danger');
          const chip = document.querySelector('#sitebar .chip');
          const out = { reset: Boolean(reset), tabs: [] };
          if (!reset) return out;
          const resetBox = box(reset);
          const chipBox = chip ? box(chip) : null;
          for (const opt of document.querySelectorAll('.segmented__opt')) {
            const shown = shownBox(opt);
            out.tabs.push({
              tab: opt.querySelector('input').value,
              revealed: shown.revealed,
              hidesReset: hit(shown, resetBox),
              hidesChip: chipBox ? hit(shown, chipBox) : false,
              clearance: Math.round(resetBox.top - shown.bottom)
            });
          }
          return out;
        });

        assert.equal(measured.reset, true, 'this subtest is meaningless unless Reset site is on screen');
        assert.equal(measured.tabs.length, 4, 'all four tabs carry a tooltip');
        for (const tab of measured.tabs) {
          // Without this, a tooltip that never opened would measure as a bubble that
          // covers nothing, and the whole subtest would pass by measuring the wrong box.
          assert.equal(tab.revealed, true, `the ${tab.tab} tooltip did not open on focus, so nothing below was measured`);
          assert.equal(tab.hidesReset, false, `the ${tab.tab} tooltip overlaps Reset site (clearance ${tab.clearance}px)`);
          assert.equal(tab.hidesChip, false, `the ${tab.tab} tooltip hides the active-changes count`);
          // Vertical, and checked for every tab: the lane has to be wide enough that
          // moving a control along the site bar can never put it under a bubble.
          assert.ok(
            tab.clearance >= 4,
            `the ${tab.tab} tooltip reaches to within ${tab.clearance}px of the site bar's control row — widen the .sitebar lane in panel.css`
          );
        }
      });

      await t.test('the change survives 10 refreshes (§16 M2)', async () => {
        let survived = 0;
        for (let i = 0; i < 10; i += 1) {
          await demo.reload({ waitUntil: 'networkidle' });
          const pill = await readPill(demo);
          if (pill.text === 'Cancelled' && pill.cls.includes('is-cancelled')) survived += 1;
        }
        assert.equal(survived, 10);
      });

      await t.test('Reset site restores the real page (§1.5, §10)', async () => {
        await panel.click('#sitebar .btn--danger'); // asks first
        await panel.waitForTimeout(300);
        const confirming = await panel.locator('#sitebar').innerText();
        assert.ok(confirming.includes(S.site.resetConfirm), 'Reset site must confirm before it acts');

        await panel.click('#sitebar .btn--danger'); // confirms
        await panel.waitForTimeout(2500);
        await demo.waitForLoadState('networkidle');

        const pill = await readPill(demo);
        assert.equal(pill.text, 'On time');
        assert.equal(pill.bannerShown, false);

        const bar = await panel.locator('#sitebar').innerText();
        assert.equal(bar.includes(S.site.reset), false, 'the danger button hides itself at zero changes');
      });

      /* ───────────────────────────────── the Pick tab — PLAN.md §10.1 states A, B, C */

      await t.test('State A is calm, and promises nothing it has not proved (§10.1A, §17.12)', async () => {
        await panel.click('label[for="tab-pick"]');
        await panel.waitForTimeout(400);

        const screen = await panel.locator('#panel-pick').innerText();
        assert.ok(screen.includes(S.pick.title), `§11 pick.title must be the heading, got "${screen}"`);
        assert.ok(screen.includes(S.pick.body), '§11 pick.body must explain the flow');

        const cta = panel.locator('#panel-pick .btn--primary');
        assert.equal(await cta.count(), 1, 'State A has exactly one primary button');
        assert.ok((await cta.innerText()).includes(S.pick.cta), `§11 pick.cta must label it`);
        assert.equal(await cta.locator('svg').count(), 1, '§10.1A gives the button a crosshair icon');

        // The whole point of the empty case: nothing has been probed, so there is no
        // list, no heading over an absent list, and no dashed empty box promising one.
        assert.equal(await panel.locator('#panel-pick .card').count(), 0, 'no Link can exist before a probe has run');
        assert.equal(await panel.locator('#panel-pick .empty').count(), 0, 'an empty shelf is still a promise — do not draw one');
        assert.equal(screen.includes(S.pick.recent), false, `"${S.pick.recent}" heads a list that does not exist yet`);

        // §17.12 — the sentence this whole product is judged on.
        const everything = await panel.locator('body').innerText();
        assert.equal(everything.includes(S.chips.verified), false, `"${S.chips.verified}" must not appear anywhere before a probe has run`);
      });

      await t.test('§16 M3 — the button picks the demo pill, and the tab follows the page (§10.1B, §10.1C)', async () => {
        // The one subtest here that uses no fixture at all: the real button, the real
        // service worker, the real page agent, the real demo. Everything below this
        // point simulates a state; this asserts that the state can actually be reached.
        await panel.click('label[for="tab-pick"]');
        await panel.waitForTimeout(300);
        await panel.click('#panel-pick .btn--primary');
        await panel.waitForTimeout(600);

        const picking = await panel.evaluate(() => ({
          label: document.querySelector('#panel-pick .btn--primary').textContent.trim(),
          disabled: document.querySelector('#panel-pick .btn--primary').disabled,
          dimmed: document.body.classList.contains('is-picking')
        }));
        assert.equal(picking.label, S.pick.picking, '§10.1B: the button carries the instruction while picking');
        assert.equal(picking.disabled, true);
        assert.equal(picking.dimmed, true, 'the panel recedes so the page can be clicked');

        // Now the human clicks the pill. The picker throttles hover to rAF, so move
        // first and let a frame pass, exactly as the picker's own suite does.
        const box = await demo.evaluate(() => {
          const rect = document.getElementById('status-pill').getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        });
        await demo.mouse.move(box.x, box.y);
        await demo.waitForTimeout(150);
        await demo.mouse.down();
        await demo.mouse.up();
        await panel.waitForTimeout(1500);

        const seen = await panel.evaluate(() => {
          const root = document.getElementById('panel-pick');
          return {
            text: root.innerText,
            dimmed: document.body.classList.contains('is-picking'),
            picked: root.querySelector('.picked__text') ? root.querySelector('.picked__text').textContent : null,
            rows: [...root.querySelectorAll('.cand')].map((row) => ({
              name: row.querySelector('.cand__name').textContent,
              value: row.querySelector('.cand__value').textContent,
              reading: row.innerText.replace(/\s+/g, ' ').trim()
            })),
            chips: [...root.querySelectorAll('.chip')].map((chip) => chip.textContent.trim()),
            body: document.body.innerText
          };
        });

        assert.equal(seen.dimmed, false, 'the pick is over, so the panel comes back');
        assert.equal(seen.picked, S.glyph.quote('On time'), 'the mini card quotes the page back (§10.1C)');
        assert.ok(seen.rows.length > 0 && seen.rows.length <= 12, `expected 1..12 rows, got ${seen.rows.length}`);
        // §16 M3's DoD, seen from the panel: the pill reads "On time", the data says
        // "ON_TIME", and the row a person would act on has to be near the top.
        assert.ok(
          seen.rows.slice(0, 3).some((row) => row.name === 'Trip' && row.value === 'ON_TIME'),
          `the Trip source's ON_TIME must be in the top 3, got ${JSON.stringify(seen.rows.slice(0, 3))}`
        );
        assert.deepEqual(seen.chips, [S.chips.candidate], 'one chip, and it is the honest one (§10.6)');
        assert.equal(seen.body.includes(S.chips.verified), false, 'a value match proves nothing (§0.2, §17.12)');
        assert.ok(seen.text.includes(S.probe.cta), '§11 probe.cta is on screen');

        // The demo holds "ON_TIME" at BOTH `$.status` and `$.booking.status`, so this
        // list really does contain two rows from the same source with the same value.
        // A list whose job is "choose the likeliest" must never draw two different
        // fields as one thing (§1.1) — this is the assertion that caught it.
        const readings = seen.rows.map((row) => row.reading);
        assert.equal(
          new Set(readings).size,
          readings.length,
          `two rows read exactly alike, so nothing on screen tells them apart: ${JSON.stringify(readings)}`
        );

        // Hand the worker back to idle. Everything below simulates a Pick-tab state by
        // rendering into this same panel, and a live pick would re-render over it the
        // next time the worker broadcast anything.
        await panel.evaluate((type) => chrome.runtime.sendMessage({ type, payload: {} }), MSG.CANCEL_PICK);
        await panel.waitForTimeout(400);
      });

      await t.test('the picker button is enabled exactly when it can actually pick (§1.1, §17.8)', async () => {
        // pick.js names the message types it sends and refuses to send one that is not
        // there. The invariant holds in both directions: a button that cannot do its job
        // must say so, and a button that can must not be dimmed for no reason. It is not
        // an assertion about today — it kept holding when the contract landed mid-build,
        // with no edit here.
        const seen = await renderPick(panel, {});
        const cta = panel.locator('#panel-pick .btn--primary');
        assert.equal(
          await cta.isDisabled(),
          seen.missingContract.length > 0,
          `pick.js is missing ${JSON.stringify(seen.missingContract)} from messages.js, so the button must be disabled and say why`
        );
        if (seen.missingContract.length) {
          assert.ok(seen.helps.includes(S.soon), 'a disabled hero button has to give a reason and a next step');
        }
      });

      await t.test('State B dims the panel to 60% and keeps the live instruction readable (§10.1B)', async () => {
        const seen = await renderPick(panel, { pick: { picking: true, element: null, candidates: [] } });

        assert.equal(seen.primary.disabled, true, '§10.1B: the button becomes disabled while picking');
        assert.equal(seen.primary.text, S.pick.picking, '§11 pick.picking is the label, not a caption beside it');

        assert.equal(seen.dim.head, 0.6, '§10.1B: the panel dims 60%');
        assert.equal(seen.dim.title, 0.6);
        assert.equal(seen.dim.body, 0.6);
        assert.equal(seen.dim.live, 1, 'the sentence telling the person what to do next is the one thing the dim must spare');

        // …and the dim the button applies to ITSELF matters just as much. §9.2's disabled
        // recipe measured this label at 2.87:1 (light) and 2.54:1 (dark) against its own
        // fill. Asserted as a property, not as a number: however §9.2's disabled recipe
        // changes, the one instruction on screen is never painted weaker than an ordinary
        // primary button.
        const idle = await renderPick(panel, {});
        assert.equal(seen.primary.paint.opacity, idle.primary.paint.opacity, 'the picking label must not be faded');
        assert.equal(seen.primary.paint.filter, idle.primary.paint.filter, 'nor desaturated');
        assert.equal(seen.primary.paint.filter, 'none');
        // The raised glow is what reads as "press me", and it stays off — that, plus the
        // panel dimmed around it, is what says "waiting" instead.
        assert.equal(seen.primary.paint.shadow, 'none');
        assert.notEqual(idle.primary.paint.shadow, 'none', 'a button you CAN press keeps its §9.2 glow');
      });

      await t.test('State C lists possible sources honestly (§10.1C, §10.6)', async () => {
        // Shaped like the demo's own result, collision included: "ON_TIME" sits at both
        // `$.status` and `$.booking.status`, so two rows share a source AND a value.
        const candidates = [
          { sigId: 'sig-trip', path: '$.passenger.name', value: 'On time traveller', score: 0.5 },
          { sigId: 'sig-trip', path: '$.status', value: 'ON_TIME', score: 0.45 },
          { sigId: 'sig-trip', path: '$.booking.status', value: 'ON_TIME', score: 0.45 },
          { sigId: 'sig-user', path: '$.label', value: 'On time', score: 1 }
        ];
        const seen = await renderPick(panel, {
          sources: [
            { sigId: 'sig-trip', name: 'Trip' },
            { sigId: 'sig-user', name: 'User' }
          ],
          pick: { picking: false, element: { text: 'On time' }, candidates }
        });

        assert.equal(seen.picked, S.glyph.quote('On time'), 'the picked element is quoted back, text only (§10.1C)');
        assert.ok(seen.sectionTitles.includes(S.pick.picked));
        assert.ok(seen.sectionTitles.includes(S.pick.sources), '§10.1C names this list "Possible sources"');

        // §10.6: four chips are the entire status vocabulary, and an unproven guess is
        // "Possible". Once, over the list — never "Verified ✓", and never a fifth word.
        assert.deepEqual(seen.chips, [S.chips.candidate]);
        assert.equal(seen.bodyText.includes(S.chips.verified), false, 'nothing here has been proved (§17.12)');

        assert.deepEqual(
          seen.rows.map((row) => row.value),
          ['On time', 'On time traveller', 'ON_TIME', 'ON_TIME'],
          '§10.1C: score-ordered, highest first — the order IS a claim about likelihood'
        );
        assert.deepEqual(seen.rows.map((row) => row.name), ['User', 'Trip', 'Trip', 'Trip'], 'the friendly name §10.2 already uses');
        assert.ok(seen.rows[0].valueFont.includes('Fira Code'), `§10.1C puts the matched value in Fira Code, got ${seen.rows[0].valueFont}`);
        assert.equal(seen.rows[0].paths, 0, 'the RAW path stays Advanced-mode only (§1.2)');
        // …but which field it is, said in the site's own words, is default UI — the same
        // keys the §10.2 tree already labels its rows with.
        assert.deepEqual(
          seen.rows.map((row) => row.field),
          ['label', S.glyph.joinDot('passenger', 'name'), 'status', S.glyph.joinDot('booking', 'status')],
          'each row names its field without a "$." or a bracket in sight'
        );

        // §16 M4 owns the experiment. Shown, disabled, and explained — not hidden, and
        // not enabled over nothing.
        assert.equal(seen.primary.text, S.probe.cta, '§11 probe.cta must be on screen');
        assert.equal(seen.primary.disabled, true, 'no probe can run at M3, so it must not offer to');
        assert.ok(seen.helps.includes(S.soon), 'and it must say so, with somewhere to go instead');
        assert.equal(seen.rootText.includes(S.probe.intro), false, 'do not describe a run that cannot start');
      });

      await t.test('State C shows at most 12 possibilities (§10.1C)', async () => {
        const many = Array.from({ length: 25 }, (_, i) => ({ sigId: 'sig-trip', path: `$.f${i}`, value: i, score: i / 100 }));
        const seen = await renderPick(panel, {
          sources: [{ sigId: 'sig-trip', name: 'Trip' }],
          pick: { picking: false, element: { text: 'On time' }, candidates: many }
        });
        assert.equal(seen.rows.length, 12);
        assert.deepEqual(seen.rows.map((row) => row.value), ['24', '23', '22', '21', '20', '19', '18', '17', '16', '15', '14', '13']);
      });

      await t.test('State C with nothing found says so, and offers §6.3’s way out', async () => {
        const seen = await renderPick(panel, {
          pick: { picking: false, element: { text: 'On time' }, candidates: [] }
        });
        assert.ok(seen.rootText.includes(S.pick.noCandidates), '§6.3: tell the user honestly');
        assert.equal(seen.rows.length, 0);
        assert.equal(seen.chips.length, 0, 'there is no list, so there is nothing to call Possible');
        assert.equal(seen.rootText.includes(S.probe.cta), false, 'there is nothing to find the source among');
        assert.ok(
          seen.secondaries.some((button) => button.text === S.pick.checkAll && button.disabled),
          '§6.3 offers "Check all fields", and at M3 it cannot run yet'
        );
      });

      await t.test('an element with no text of its own says so instead of drawing an empty card', async () => {
        const seen = await renderPick(panel, { pick: { picking: false, element: { text: '   ' }, candidates: [] } });
        assert.equal(seen.picked, S.pick.noText);
      });

      await t.test('§10.1A’s Recent links list shows verified Links and ONLY verified Links (§17.12)', async () => {
        const proved = verifiedLink('$.status', 'On time', 'ON_TIME', 300);
        const links = [
          { ...proved, id: 'a', path: '$.a', lastVerifiedAt: 100 },
          { ...proved, id: 'b', path: '$.b', lastVerifiedAt: 200 },
          proved,
          { ...proved, id: 'd', path: '$.d', lastVerifiedAt: 400 }
        ];

        // The state M3 actually ships in, spelled out: a Change made from the tree view
        // records a `candidate` Binding (the M2 subtests above just made one). If this
        // list ever loosened to "has a Binding", every such edit would grow a Verified ✓.
        const unproven = await renderPick(panel, {
          sources: [{ sigId: 'sig-trip', name: 'Trip' }],
          bindings: links.map((link) => ({ ...link, state: 'candidate' })).concat(links.map((link) => ({ ...link, state: 'stale' })))
        });
        assert.equal(unproven.cards, 0, 'a candidate or stale Link is not a proved one, and §10.1A lists only proved ones');
        assert.equal(unproven.rootText.includes(S.pick.recent), false, 'no list, so no heading over it');
        assert.equal(unproven.bodyText.includes(S.chips.verified), false, `"${S.chips.verified}" must never come from an unproved Link`);

        const shown = await renderPick(panel, { sources: [{ sigId: 'sig-trip', name: 'Trip' }], bindings: links });
        assert.equal(shown.cards, 3, '§10.1A: the last 3');
        assert.deepEqual(shown.chips, [S.chips.verified, S.chips.verified, S.chips.verified]);
        assert.ok(shown.rootText.includes(S.pick.recent), '§11 pick.recent heads the list');
        assert.ok(shown.rootText.includes(S.glyph.quote('On time')), "the element's own text identifies the Link");
        assert.ok(shown.rootText.includes('ON_TIME'), '§10.1A shows the current value');
        // Most recently proved first — "last 3" is a claim about time, not about order
        // of insertion.
        assert.equal(shown.rootText.indexOf(S.pick.recent) >= 0, true);
        for (const card of shown.linkCards) {
          // State D is M4. A chevron and a pointer cursor both say "this opens" — over
          // nothing, at M3, that is the same lie as an enabled probe button.
          assert.equal(card.chevrons, 0, 'no chevron until there is an editor behind it');
          assert.equal(card.clickable, false);
          assert.equal(card.cursor, 'default');
        }

        // Leave the fixture page as this milestone really ships, so nothing later reads
        // a "Verified ✓" this subtest put there.
        const after = await renderPick(panel, {});
        assert.equal(after.bodyText.includes(S.chips.verified), false);
      });

      await t.test('all four status chips meet WCAG 2.2 AA in both themes (§16 M7)', async () => {
        for (const scheme of ['light', 'dark']) {
          await panel.emulateMedia({ colorScheme: scheme });
          await panel.waitForTimeout(150);
          const measured = await panel.evaluate((kinds) => {
            const host = document.createElement('div');
            for (const kind of kinds) {
              const chip = document.createElement('span');
              chip.className = `chip chip--${kind}`;
              chip.textContent = kind;
              host.append(chip);
            }
            document.body.append(host);
            // color(srgb r g b) reports 0..1 components; rgb()/rgba() reports 0..255.
            const parse = (value) => {
              const n = value.match(/[\d.]+/g).map(Number);
              const scale = value.startsWith('color(') ? 255 : 1;
              return [n[0] * scale, n[1] * scale, n[2] * scale, n.length > 3 ? n[3] : 1];
            };
            const channel = (c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : Math.pow((c / 255 + 0.055) / 1.055, 2.4));
            const lum = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
            const flatten = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
            const page = parse(getComputedStyle(document.body).backgroundColor);
            const out = {};
            for (const chip of host.children) {
              const style = getComputedStyle(chip);
              const bg = flatten(parse(style.backgroundColor), page);
              const fg = flatten(parse(style.color), [...bg, 1]);
              const a = lum(fg);
              const b = lum(bg);
              out[chip.textContent] = Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
            }
            host.remove();
            return out;
          }, ['verified', 'candidate', 'stale', 'changed']);

          for (const [kind, ratio] of Object.entries(measured)) {
            assert.ok(ratio >= 4.5, `${scheme} ${kind} chip is ${ratio}:1, below WCAG 2.2 AA 1.4.3 (4.5:1)`);
          }
        }
        await panel.emulateMedia({ colorScheme: 'light' });
      });

      await t.test('the panel logged nothing to the console the whole way through', () => {
        assert.deepEqual(panelErrors, []);
      });
    } finally {
      if (ctx) await ctx.close().catch(() => {});
      if (server) server.close();
      if (profile) fs.rmSync(profile, { recursive: true, force: true });
    }
  });
}
