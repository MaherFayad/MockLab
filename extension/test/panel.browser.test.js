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
 * What a browser suite SHARES — the Chromium lookup, the extension launch line and the
 * stage/check machinery — lives in `../testlib/browserFixture.js`. `node --test`
 * executes EVERY .js file under `test/`, so a helper module in this directory would be
 * run as a test file; `testlib` is outside that glob. The fixtures below are the ones
 * only this suite has any use for.
 *
 * Every check REPORTS, whatever happens to the fixture (README Deviation 45). This
 * file's contribution to `# tests` is therefore a constant — which matters most here,
 * because the subtest that keeps "Verified ✓" off an unproven Link is one of these, and
 * a fixture that quietly deleted it would leave §1.1 unguarded and CI green.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { S } from '../src/panel/strings.js';
import { MSG } from '../src/background/messages.js';
import { createServer } from '../../companion/src/index.js';
import { EXTENSION_DIR, loadChromium, launchExtension, createFixture } from '../testlib/browserFixture.js';
import { readVerifiedChips, assertVerifiedHonesty } from '../testlib/verifiedChip.js';

/** The value the demo maps to a red pill and a banner (§14). */
const CANCELLED = 'CANCELLED';

/** Nothing a human would type, so a match can only have come from strings.js. */
const SENTINEL = '⟪sentinel⟫';

/**
 * `GET_PICK`'s `searched` (§6.3), in its two meanings.
 *
 * `REACHED_EVERYTHING` is what `findCandidates` answers on the demo: every captured
 * response walked to its end. It is the ONLY answer that entitles the panel to
 * `pick.noCandidates`, whose §11 wording — "couldn't find this text in any data the page
 * loaded" — is a claim about the data rather than about the search.
 *
 * `STOPPED_SHORT` is the same search after it hit one of §6.3's ceilings (depth 24,
 * 20 000 leaves per response, 120 000 across the tab). MockLab then knows nothing about
 * the part it never read, and every screen below must say a different sentence.
 *
 * Spelled into every Pick fixture rather than defaulted, because which sentence appears
 * turns on it — a fixture that omits it would be describing a state the worker never
 * sends and hiding which one the assertion is really about.
 */
const REACHED_EVERYTHING = { sources: 2, bounded: 0, complete: true };
const STOPPED_SHORT = { sources: 40, bounded: 3, complete: false };

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
 *
 * `swap` is the `panel.strings.test.js` technique, moved into the real page: name any
 * `S.pick.*` keys and they are replaced with a sentinel for this render and restored
 * after. A test that asserts today's wording passes just as happily with that wording
 * baked into pick.js, which is the defect class this repository has already shipped
 * once; a test that asserts the SENTINEL reaches the screen cannot.
 */
function renderPick(page, patch, swap) {
  return page.evaluate(async ([given, swapKeys, sentinel]) => {
    const mod = await import('/src/panel/pick.js');
    const probe = await import('/src/panel/probe.js');
    // The same module instance pick.js imports, so a key replaced here is the key it
    // reads. Restored in the `finally` below — every later subtest reads real copy.
    const { S } = await import('/src/panel/strings.js');
    const saved = {};
    for (const key of swapKeys || []) {
      saved[key] = S.pick[key];
      S.pick[key] = sentinel;
    }
    try {
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
      /** The two colours one node is actually painted with, or null if it is not there. */
      const ink = (node) => {
        if (!node) return null;
        const style = getComputedStyle(node);
        return { color: style.color, background: style.backgroundColor };
      };
      const primary = root.querySelector('.btn--primary');
      return {
        missingContract: mod.missingPickContract(),
        // §10.1C's experiment needs its own contract, which §16 M4 requested and which
        // messages.js may or may not define yet. Every assertion about the probe button
        // is stated against THIS rather than against today's answer.
        missingProbe: probe.missingProbeContract(),
        rootText: root.innerText,
        bodyText: document.body.innerText,
        cards: root.querySelectorAll('.card').length,
        emptyBoxes: root.querySelectorAll('.empty').length,
        // What the empty state and the list's caveat actually SAY, not just how many
        // boxes exist — the §6.3 bounded case turns on which sentence is in which.
        empties: textsOf('.empty'),
        notes: textsOf('.pick-note'),
        noteInk: ink(root.querySelector('.pick-note')),
        chipInk: ink(root.querySelector('.chip--candidate')),
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
    } finally {
      for (const key of Object.keys(saved)) S.pick[key] = saved[key];
    }
  }, [patch, swap, SENTINEL]);
}

/**
 * §17.12's invariant, read out of the panel as it currently stands.
 *
 * From M2 to M3 this file asserted instead that §11's "Verified ✓" appeared NOWHERE in
 * the panel body. That was true and load-bearing while no probe existed: every
 * occurrence was a bug by construction. At M4 the word becomes legitimate, and the old
 * assertion could only have been DELETED — which is how a product ships the bug it spent
 * three milestones avoiding. It changes shape into the statement that was always meant,
 * and the statement lives in `testlib/verifiedChip.js` so this suite and
 * `panel.probe.browser.test.js` cannot drift apart about what honesty means here.
 *
 * @param {number} expected how many chips the FIXTURE entitles this screen to
 */
async function honesty(page, expected, where) {
  assertVerifiedHonesty(await page.evaluate(readVerifiedChips, S.chips.verified), { expected, where });
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
    const { stage, check, timeline } = createFixture(t);

    let server = null;
    let profile = null;
    let ctx = null;
    let worker = null;
    let demo = null;
    let panel = null;
    let demoUrl = null;
    const panelErrors = [];

    try {
      server = createServer();
      demoUrl = await stage('demo server', 10000, async () => {
        // Port 0: never collide with a companion the developer already has running.
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', resolve);
        });
        return `http://127.0.0.1:${server.address().port}/demo/`;
      });

      profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mocklab-panel-'));
      // No Chromium build (or no sandbox to launch it in) is an ABSENT DEPENDENCY, not a
      // failing product, and this is the only stage that may say so. Every stage after it
      // fails by name — a service worker that never registers is not a missing browser.
      ctx = await stage(
        'chromium launch + extension load', 60000,
        () => launchExtension(chromium, profile),
        { absent: 'Chromium could not be launched' }
      );

      worker = await stage('service-worker registration', 20000, async () =>
        ctx.serviceWorkers()[0] || ctx.waitForEvent('serviceworker', { timeout: 20000 }));

      demo = await stage('demo page renders both of its sources', 30000, async () => {
        const page = await ctx.newPage();
        await page.goto(demoUrl, { waitUntil: 'load' });
        /**
         * `networkidle` stood here, and it is the reason this stage exists.
         *
         * It waits for a quiet NETWORK — a proxy for the thing this suite actually needs,
         * which is that the demo has RENDERED from both of its sources (§14: trip.json
         * over fetch, user.json over XHR). The proxy can be satisfied while the page is
         * still blank, and it can also never be satisfied at all, on Playwright's default
         * 30 s timeout, inside a fixture that used to take every subtest down with it and
         * say nothing. The condition below is the real one: both placeholders replaced by
         * the site's own rendering code.
         */
        await page.waitForFunction(() => {
          const rendered = (id) => {
            const node = document.getElementById(id);
            const text = node ? node.textContent.trim() : '';
            return text !== '' && text !== '…';
          };
          return rendered('status-pill') && rendered('passenger-chip');
        }, null, { timeout: 20000 });
        return page;
      });

      panel = await stage('panel page', 30000, async () => {
        const page = await ctx.newPage();
        page.on('pageerror', (err) => panelErrors.push(`pageerror: ${err.message}`));
        page.on('console', (msg) => msg.type() === 'error' && panelErrors.push(msg.text()));
        await page.setViewportSize({ width: 400, height: 900 });
        await page.goto(`chrome-extension://${new URL(worker.url()).host}/src/panel/panel.html`);
        return page;
      });

      await stage('the panel describes the demo tab', 20000, async () => {
        // The panel reads the ACTIVE tab, exactly as it does when Chrome hosts it in the
        // side panel next to the page. Here it is an ordinary tab, so the demo has to be
        // brought forward or the panel would describe itself.
        //
        // Two fixed sleeps stood here, 800 ms then 600 ms, for two events that are both
        // observable: the site bar naming the demo's host, and the source list drawing a
        // card per captured source. A sleep asserts nothing — it is only ever too short
        // (flake) or too long (slow), and it cannot tell the two apart.
        await demo.bringToFront();
        await panel.click('label[for="tab-sources"]');
        await panel.waitForFunction((host) => {
          const named = document.querySelector('#sitebar .sitebar__host');
          return Boolean(named && named.textContent.includes(host)) &&
            document.querySelectorAll('#source-list .card').length >= 2;
        }, '127.0.0.1', { timeout: 15000 });
      });
      t.diagnostic(`fixture ready — ${timeline.join(', ')}`);
    } catch {
      // Whichever stage failed has already recorded whether the browser was absent (every
      // check skips) or the fixture broke (every check fails, naming the stage and the
      // wait). Nothing is decided here — the body below runs either way so that every
      // check reports, and teardown is the `finally` at the end of it.
    }

    try {
      await check('the typography is bundled, not fetched from a third party (§1.4)', async () => {
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

      await check('the Sources tab lists both demo sources with friendly names (§10.2)', async () => {
        const names = await panel.$$eval('#source-list .card__title .truncate', (nodes) => nodes.map((n) => n.textContent));
        assert.deepEqual([...names].sort(), ['Trip', 'User']);
        const meta = await cardFor(panel, 'Trip').locator('.card__meta').innerText();
        assert.ok(meta.includes(S.sources.fields(18)), `expected "${S.sources.fields(18)}" in "${meta}"`);
      });

      await check('a card opens the response tree, scalar rows offer both §10.2 actions', async () => {
        await cardFor(panel, 'Trip').locator('.card__head').click();
        await panel.waitForTimeout(700);
        const rows = await panel.locator('#source-list .tree__row').count();
        assert.ok(rows > 10, `expected a populated tree, got ${rows} rows`);
        const row = rootRow(panel, 'ON_TIME');
        const labels = await row.locator('button[aria-label]').evaluateAll((n) => n.map((b) => b.getAttribute('aria-label')));
        assert.ok(labels.includes(S.sources.changeValue), 'the ✏️ action must be present');
        assert.ok(labels.includes(S.sources.showOnPage), 'the ◎ action must be present');
      });

      await check('the editor says Possible, never Verified (§1.1, §10.6, §17.4)', async () => {
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

      await check('apply & refresh: the SITE renders the new state, with no probe (§16 M2)', async () => {
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

      await check('the changed row shows real → new, and the site bar counts it (§10.2, §1.5)', async () => {
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

      await check('no tab tooltip covers the Reset site control (§10 site bar)', async () => {
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

      await check('the change survives 10 refreshes (§16 M2)', async () => {
        let survived = 0;
        for (let i = 0; i < 10; i += 1) {
          await demo.reload({ waitUntil: 'networkidle' });
          const pill = await readPill(demo);
          if (pill.text === 'Cancelled' && pill.cls.includes('is-cancelled')) survived += 1;
        }
        assert.equal(survived, 10);
      });

      await check('Reset site restores the real page (§1.5, §10)', async () => {
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

      await check('State A is calm, and promises nothing it has not proved (§10.1A, §17.12)', async () => {
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

        // §17.12 — the sentence this whole product is judged on. Nothing is proved on
        // this screen, so the honest number of "Verified ✓" chips is zero; and any chip
        // that DID appear would have to agree, in three independently written places,
        // that the Link it describes is verified.
        await honesty(panel, 0, 'State A with nothing proved');
      });

      await check('§16 M3 — the button picks the demo pill, and the tab follows the page (§10.1B, §10.1C)', async () => {
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
            notes: [...root.querySelectorAll('.pick-note')].map((note) => note.textContent.trim()),
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
        // The whole trip on the real wire: the worker walked both demo responses to
        // their end and said so (`searched.complete:true`), so this list really is all
        // of it and must carry no caveat. This is the only subtest that reads `searched`
        // through `loadPick` and a live GET_PICK — the simulated ones below hand the
        // state straight to the renderer, so a panel that stopped carrying the field off
        // the message would still look right to every one of them.
        assert.deepEqual(seen.notes, [], 'the demo is searched to the end, so nothing here may hedge');

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

      await check('the picker button is enabled exactly when it can actually pick (§1.1, §17.8)', async () => {
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

      await check('State B dims the panel to 60% and keeps the live instruction readable (§10.1B)', async () => {
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

      await check('State C lists possible sources honestly (§10.1C, §10.6)', async () => {
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
          pick: { picking: false, element: { text: 'On time' }, candidates, searched: REACHED_EVERYTHING }
        });

        assert.equal(seen.picked, S.glyph.quote('On time'), 'the picked element is quoted back, text only (§10.1C)');
        assert.ok(seen.sectionTitles.includes(S.pick.picked));
        assert.ok(seen.sectionTitles.includes(S.pick.sources), '§10.1C names this list "Possible sources"');

        // §10.6: four chips are the entire status vocabulary, and an unproven guess is
        // "Possible". Once, over the list — never "Verified ✓", and never a fifth word.
        assert.deepEqual(seen.chips, [S.chips.candidate]);
        await honesty(panel, 0, 'State C — a list of guesses');

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

        // §10.1C's experiment: shown, and offered exactly when it can really run. Stated
        // as a property of the contract rather than as a fact about today, so it keeps
        // holding when the probe's message types land — the same shape as the picker
        // button's check above, which survived its own contract arriving mid-build.
        assert.equal(seen.primary.text, S.probe.cta, '§11 probe.cta must be on screen');
        assert.equal(seen.primary.disabled, seen.missingProbe.length > 0, 'the button offers the experiment exactly when it can run it');
        if (seen.primary.disabled) assert.ok(seen.helps.includes(S.soon), 'and a disabled hero button says so, with somewhere to go instead');
        // §11's intro promises a run that takes half a minute; only say it if one can start.
        assert.equal(seen.rootText.includes(S.probe.intro), !seen.primary.disabled, 'do not describe a run that cannot start');
      });

      await check('State C shows at most 12 possibilities (§10.1C)', async () => {
        const many = Array.from({ length: 25 }, (_, i) => ({ sigId: 'sig-trip', path: `$.f${i}`, value: i, score: i / 100 }));
        const seen = await renderPick(panel, {
          sources: [{ sigId: 'sig-trip', name: 'Trip' }],
          pick: { picking: false, element: { text: 'On time' }, candidates: many, searched: REACHED_EVERYTHING }
        });
        assert.equal(seen.rows.length, 12);
        assert.deepEqual(seen.rows.map((row) => row.value), ['24', '23', '22', '21', '20', '19', '18', '17', '16', '15', '14', '13']);
      });

      await check('State C with nothing found says so, and offers §6.3’s way out', async () => {
        const seen = await renderPick(panel, {
          pick: { picking: false, element: { text: 'On time' }, candidates: [], searched: REACHED_EVERYTHING }
        });
        assert.ok(seen.rootText.includes(S.pick.noCandidates), '§6.3: tell the user honestly');
        assert.equal(seen.rows.length, 0);
        assert.equal(seen.chips.length, 0, 'there is no list, so there is nothing to call Possible');
        assert.equal(seen.rootText.includes(S.probe.cta), false, 'there is nothing to find the source among');
        assert.ok(
          seen.secondaries.some((button) => button.text === S.pick.checkAll && button.disabled === (seen.missingProbe.length > 0)),
          '§6.3 offers "Check all fields", live exactly when the exhaustive run can actually start'
        );
      });

      /**
       * The bounded-search screens (§6.3's ceilings, `GET_PICK`'s `searched.complete`).
       *
       * These two subtests are written to fail three different ways, because "it renders
       * the right sentence today" is the assertion that let `formatValue`'s `'null'`
       * ship:
       *   1. the bounded screen showing `pick.noCandidates` — the §17.12 failure this
       *      whole mechanism exists to prevent, a confident claim about data MockLab
       *      never read;
       *   2. `searched.complete` no longer being READ — asserted as a property, by
       *      rendering the SAME pick twice with only that boolean different and
       *      requiring the two screens to differ. Delete the branch in pick.js and both
       *      renders become identical, whichever sentence survives;
       *   3. the wording being hardcoded in pick.js rather than taken from strings.js —
       *      caught by rendering with the key sentinelled (§17.6).
       */
      await check('State C after a search that stopped short never claims the data is empty (§1.1, §17.12)', async () => {
        const element = { text: 'On time' };
        const bounded = await renderPick(panel, {
          pick: { picking: false, element, candidates: [], searched: STOPPED_SHORT }
        });

        // (1) §11 phrases `noCandidates` as a fact about the data — "MockLab couldn't
        // find this text in any data the page loaded", then three reasons why the data
        // would not hold it. A search that stopped short establishes none of that.
        assert.equal(
          bounded.rootText.includes(S.pick.noCandidates),
          false,
          'the search never reached the end of the data, so the panel may not say the text is not in it'
        );
        assert.deepEqual(
          bounded.empties,
          [S.pick.searchIncomplete],
          'the empty state gets the sentence for "MockLab stopped looking", and only that one'
        );

        // §6.3 offers "Check all fields" for a search that found nothing in data it read
        // to the end. It does not describe this case, the control cannot run before M4,
        // and an exhaustive pass would meet the same ceilings — so a grey button under
        // this sentence would read as the cure and be wrong twice.
        assert.equal(bounded.rootText.includes(S.pick.checkAll), false, 'no dead button offered as the way out');
        assert.equal(bounded.rootText.includes(S.probe.cta), false, 'and nothing to find the source among');
        assert.equal(bounded.chips.length, 0, 'there is no list, so there is nothing to call Possible');
        // (The sentence's own promise — that it names somewhere the person can go
        // instead — is audited in panel.strings.test.js, which runs without a browser.)

        // (2) The flag is read, not ignored. One boolean apart, and nothing else.
        const complete = await renderPick(panel, {
          pick: { picking: false, element, candidates: [], searched: REACHED_EVERYTHING }
        });
        assert.notEqual(
          bounded.rootText,
          complete.rootText,
          'a bounded search and a complete one draw the identical screen — searched.complete is not being read'
        );
        assert.ok(complete.rootText.includes(S.pick.noCandidates), '§6.3: a search that DID reach the end says so');
        assert.ok(complete.secondaries.some((button) => button.text === S.pick.checkAll));

        // A worker that stops sending `searched` at all must make the panel quieter,
        // never more confident. Not knowing how far it got is not knowing.
        const silent = await renderPick(panel, { pick: { picking: false, element, candidates: [] } });
        assert.equal(
          silent.rootText.includes(S.pick.noCandidates),
          false,
          'with no report of how far the search got, the panel must not claim the data is empty'
        );
        assert.deepEqual(silent.empties, [S.pick.searchIncomplete]);

        // (3) The words come from §11's file. Hardcode them in pick.js and this fails.
        const swapped = await renderPick(
          panel,
          { pick: { picking: false, element, candidates: [], searched: STOPPED_SHORT } },
          ['searchIncomplete']
        );
        assert.deepEqual(swapped.empties, [SENTINEL], '§17.6: this sentence must come from strings.js');
      });

      await check('a list built from a search that stopped short says it may not be all of it (§1.1)', async () => {
        const candidates = [
          { sigId: 'sig-trip', path: '$.status', value: 'ON_TIME', score: 0.45 },
          { sigId: 'sig-user', path: '$.label', value: 'On time', score: 1 }
        ];
        const sources = [
          { sigId: 'sig-trip', name: 'Trip' },
          { sigId: 'sig-user', name: 'User' }
        ];
        const element = { text: 'On time' };
        const bounded = await renderPick(panel, {
          sources,
          pick: { picking: false, element, candidates, searched: STOPPED_SHORT }
        });
        const complete = await renderPick(panel, {
          sources,
          pick: { picking: false, element, candidates, searched: REACHED_EVERYTHING }
        });

        // Twelve rows in likelihood order read as "these are the possibilities". After a
        // bounded search that completeness is implied and unearned, so the list says so.
        assert.deepEqual(bounded.notes, [S.pick.listIncomplete], 'the list must admit what it does not cover');
        assert.deepEqual(complete.notes, [], 'and must not say it when the search did reach the end');
        assert.notEqual(
          bounded.rootText,
          complete.rootText,
          'both lists read exactly alike — searched.complete is not being read on this branch either'
        );

        // A caveat under the rows arrives after the person has already picked a row.
        assert.ok(
          bounded.rootText.indexOf(S.pick.listIncomplete) < bounded.rootText.indexOf(candidates[0].value),
          'the caveat has to be readable before the list it qualifies, not after it'
        );
        // It qualifies the list; it does not change it.
        assert.deepEqual(bounded.rows.map((row) => row.reading), complete.rows.map((row) => row.reading));

        // §10.6 fixes the status vocabulary at four chips, and this is prose, not a fifth
        // word. It is painted in the same warning family as the "Possible" chip beside
        // the heading, so uncertainty reads as one mood — and so the contrast the chip
        // subtest below already measures in both themes covers this block too.
        assert.deepEqual(bounded.chips, [S.chips.candidate], 'no new status word');
        assert.deepEqual(bounded.noteInk, bounded.chipInk, 'the caveat and the Possible chip share their colours');

        const swapped = await renderPick(
          panel,
          { sources, pick: { picking: false, element, candidates, searched: STOPPED_SHORT } },
          ['listIncomplete']
        );
        assert.deepEqual(swapped.notes, [SENTINEL], '§17.6: this sentence must come from strings.js');
      });

      await check('an element with no text of its own says so instead of drawing an empty card', async () => {
        const seen = await renderPick(panel, {
          // No text of its own means no needles, so §6.3 searches nothing and reports
          // the search complete — the honest answer here really is `noCandidates`.
          pick: { picking: false, element: { text: '   ' }, candidates: [], searched: REACHED_EVERYTHING }
        });
        assert.equal(seen.picked, S.pick.noText);
      });

      await check('§10.1A’s Recent links list shows verified Links and ONLY verified Links (§17.12)', async () => {
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
        await honesty(panel, 0, '§10.1A with eight unproved Links');

        const shown = await renderPick(panel, { sources: [{ sigId: 'sig-trip', name: 'Trip' }], bindings: links });
        assert.equal(shown.cards, 3, '§10.1A: the last 3');
        assert.deepEqual(shown.chips, [S.chips.verified, S.chips.verified, S.chips.verified]);
        assert.ok(shown.rootText.includes(S.pick.recent), '§11 pick.recent heads the list');
        assert.ok(shown.rootText.includes(S.glyph.quote('On time')), "the element's own text identifies the Link");
        assert.ok(shown.rootText.includes('ON_TIME'), '§10.1A shows the current value');
        // Most recently proved first — "last 3" is a claim about time, not about order
        // of insertion.
        assert.equal(shown.rootText.indexOf(S.pick.recent) >= 0, true);
        // Three cards, three chips, and every one of them describing a Link that really
        // is verified — the count is what a widened filter breaks first.
        await honesty(panel, 3, '§10.1A with four proved Links');

        for (const card of shown.linkCards) {
          // At M3 this asserted the opposite: a chevron is a promise that something
          // opens, and there was nothing behind it. State D exists now (Deviation 29).
          assert.equal(card.chevrons, 1, '§10.1A ends the card with a chevron into the editor');
          assert.equal(card.clickable, true, 'and it is a real control, reachable by keyboard');
          assert.equal(card.cursor, 'pointer');
        }

        // Leave the fixture page as the idle screen, so nothing later reads a
        // "Verified ✓" this subtest put there.
        const after = await renderPick(panel, {});
        assert.equal(after.cards, 0);
        await honesty(panel, 0, 'the Pick tab after the fixture is cleared');
      });

      await check('all four status chips meet WCAG 2.2 AA in both themes (§16 M7)', async () => {
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

      await check('the panel logged nothing to the console the whole way through', () => {
        assert.deepEqual(panelErrors, []);
      });
    } finally {
      if (ctx) await ctx.close().catch(() => {});
      if (server) server.close();
      if (profile) fs.rmSync(profile, { recursive: true, force: true });
    }
  });
}
