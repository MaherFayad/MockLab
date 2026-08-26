/**
 * PLAN.md §16 M7's accessibility pass, performed on the real panel in real Chromium:
 * every control keyboard-reachable, `prefers-reduced-motion` off the spring and the pop,
 * and an RTL smoke test — plus WCAG 2.2 1.4.13 for the tooltips, which is what the three
 * mouse-only disabled controls turned out to be one symptom of.
 *
 * OWNER: panel-designer. The tenth browser suite, and it is in CI's `for suite in …` loop
 * in the same change that creates it — this repository has shipped three suites CI never
 * invoked, and the loop's own comment asks whoever adds the next one to do exactly this.
 *
 * ── Why these checks are not in the four panel suites that already exist ────────────
 * They are not about a screen. `panel.browser.test.js` is the M2 changes flow then the
 * M3 pick flow, `panel.probe.browser.test.js` is §10.1's probe screens,
 * `panel.scenarios.browser.test.js` is §10.4 — each drives one flow and asserts what that
 * flow shows. Everything below is a property of the WHOLE panel at once: the tab order
 * across four tabs, the direction the layout runs in, whether any tooltip anywhere can be
 * dismissed. Split across three suites, each would be checked on a third of the panel,
 * which is how "every control keyboard-reachable" becomes "the controls I happened to
 * render". So the fixture here is the panel as a person meets it — the real demo site
 * behind it, both real sources captured, the real service worker answering — and each
 * check sweeps all four tabs.
 *
 * ── The two properties this file is built to keep ──────────────────────────────────
 * Nothing below asserts a LIST of controls. A test naming today's buttons passes forever
 * while the next control someone adds is unreachable, which is the same defect class as a
 * copy test asserting today's wording. Every check derives its subjects from the DOM and
 * asserts a property over all of them — and asserts the derivation was not empty, because
 * a sweep that found nothing is the failure mode these checks exist to prevent.
 *
 * Every check REPORTS, whatever happens to the fixture (README Deviation 45).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { S } from '../src/panel/strings.js';
import { createServer } from '../../companion/src/index.js';
import { loadChromium, launchExtension, createFixture } from '../testlib/browserFixture.js';

/** The panel is designed for 360–420px (§9.2). */
const WIDTH = 380;

/** Every tab, so no check is performed on a quarter of the product. */
const TABS = ['pick', 'sources', 'scenarios', 'settings'];

/**
 * Everything on screen that a person can operate, and which of them the tab order is
 * entitled to skip.
 *
 * A radio GROUP is one tab stop, not one per option — that is how a browser implements
 * `role="tab"` strips and §10.1D's value picker, and a sweep that did not know it would
 * demand a tab stop per option and fail on correct code. So a group contributes its
 * checked member, or its first member when none is checked, which is exactly the member
 * the browser puts in the order.
 *
 * `display:none` is out because it is not on screen at all — the file chooser behind
 * §10.4's Import button is the only one, and the button is what a person operates.
 * `opacity:0` is deliberately IN: three controls in this panel are invisible inputs under
 * a drawn surface (the selection card's checkbox, the segmented control's radios, the
 * check-row's box), and those are precisely the ones whose keyboard access is easy to
 * lose without anything looking wrong.
 *
 * `[disabled]` is OUT, and the reason is worth stating because it is the one exclusion
 * that could hide a real defect. WCAG 2.1.1 is about FUNCTIONALITY, and a disabled
 * control has none — for anybody, mouse included — so demanding a tab stop for one would
 * fail correct code. What a disabled control does owe is its REASON, and that is not this
 * check's business: it is the next two, which require every inert control on screen to
 * state one somewhere a keyboard can reach. Between them nothing is exempt; separately,
 * either would look like a loophole.
 */
const COLLECT_CONTROLS = () => {
  const root = document.querySelector('.app');
  const selector = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';
  const onScreen = [...root.querySelectorAll(selector)].filter((node) => {
    if (node.closest('.hidden') || node.disabled) return false;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return node.getClientRects().length > 0;
  });
  const groups = new Map();
  const controls = [];
  for (const node of onScreen) {
    if (node.type === 'radio' && node.name) {
      const seen = groups.get(node.name);
      if (seen && !node.checked) continue;
      if (seen && node.checked) controls.splice(controls.indexOf(seen), 1);
      groups.set(node.name, node);
    }
    controls.push(node);
  }
  return controls;
};

/**
 * Tab through the panel and report which controls the keyboard actually reached.
 *
 * The controls are marked first and read back off `document.activeElement`, so this is
 * the real focus order rather than a list of things that CAN be focused: `focus()` on
 * each in turn would pass on a control with `tabindex="-1"`, which is the exact defect
 * the §10.2 source cards had.
 */
async function tabOrder(page) {
  const expected = await page.evaluate(
    // eslint-disable-next-line no-new-func
    `(${COLLECT_CONTROLS.toString()})().map((node, index) => {
       node.setAttribute('data-a11y', String(index));
       return {
         id: String(index),
         what: node.tagName.toLowerCase() + (node.type ? ':' + node.type : ''),
         name: (node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 40) ||
               (node.closest('label') ? node.closest('label').textContent.trim().slice(0, 40) : '') ||
               node.className
       };
     })`
  );
  await page.evaluate(() => document.body.focus());
  const reached = new Set();
  // A few extra presses so the order is allowed to wrap once; a control reached on the
  // second lap is still reached.
  for (let press = 0; press < expected.length + 4; press += 1) {
    await page.keyboard.press('Tab');
    const id = await page.evaluate(() =>
      document.activeElement ? document.activeElement.getAttribute('data-a11y') : null
    );
    if (id !== null) reached.add(id);
  }
  return { expected, reached };
}

/**
 * Press Tab until `selector` holds the focus, or give up. Used where the check is about
 * what a keyboard user can DO rather than about the order itself: it also guarantees the
 * browser's focus modality is "keyboard", which is what `:focus-visible` turns on.
 */
async function tabTo(page, selector, presses = 40) {
  await page.evaluate(() => document.body.focus());
  for (let press = 0; press < presses; press += 1) {
    await page.keyboard.press('Tab');
    const there = await page.evaluate(
      (target) => document.activeElement !== null && document.activeElement.matches(target),
      selector
    );
    if (there) return true;
  }
  return false;
}

/**
 * Freeze every transition and animation in the panel for the duration of one check, and
 * put them back afterwards.
 *
 * NOT a convenience, and not a way to make a flaky check pass. The panel page is a
 * BACKGROUND tab in this fixture — the demo has to be in front, or the panel would be
 * describing itself and the Sources tab would be empty — and a background tab's animation
 * timeline does not tick. A transitioned property therefore reads its START value
 * forever: measured, `[dir=rtl]` left the segmented thumb reporting +256.5px with `--dir`
 * already at -1, and a hovered tooltip reported `opacity: 0` with `.tip:hover` matching.
 * Both look exactly like a stylesheet that does not work.
 *
 * Every check that uses this is asking WHICH RULE APPLIES, never how the tween looks —
 * the tween is `panel.probe.browser.test.js`'s and the check below it. With no transition
 * there is nothing to tick, so the computed value is the answer directly.
 */
async function stillMotion(page, run) {
  await page.addStyleTag({
    content: '#ml-still, *, *::before, *::after { transition: none !important; animation: none !important; }'
  });
  const style = await page.evaluateHandle(() => document.head.lastElementChild);
  try {
    return await run();
  } finally {
    await style.evaluate((node) => node.remove());
  }
}

/** Show one tab and wait for it to be the one on screen. */
async function openTab(page, name) {
  await page.click(`label[for="tab-${name}"]`);
  await page.waitForFunction(
    (tab) => !document.getElementById(`panel-${tab}`).classList.contains('hidden'),
    name,
    { timeout: 5000 }
  );
}

const chromium = await loadChromium();

if (!chromium) {
  test('panel accessibility browser suite', {
    skip: 'Playwright is not installed — `npm i -D playwright && npx playwright install chromium` enables it.'
  }, () => {});
} else {
  test('the panel, operated without a mouse — PLAN.md §16 M7 and §9.2', async (t) => {
    const { stage, check, timeline } = createFixture(t);

    let server = null;
    let profile = null;
    let ctx = null;
    let worker = null;
    let demo = null;
    let panel = null;
    const panelErrors = [];

    try {
      server = createServer();
      const demoUrl = await stage('demo server', 10000, async () => {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', resolve);
        });
        return `http://127.0.0.1:${server.address().port}/demo/`;
      });

      profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mocklab-a11y-'));
      ctx = await stage(
        'chromium launch + extension load',
        60000,
        () => launchExtension(chromium, profile),
        { absent: 'Chromium could not be launched' }
      );
      worker = await stage('service-worker registration', 20000, async () =>
        ctx.serviceWorkers()[0] || ctx.waitForEvent('serviceworker', { timeout: 20000 })
      );
      demo = await stage('demo page renders both of its sources', 30000, async () => {
        const page = await ctx.newPage();
        await page.goto(demoUrl, { waitUntil: 'load' });
        await page.waitForFunction(
          () => {
            const rendered = (id) => {
              const node = document.getElementById(id);
              const text = node ? node.textContent.trim() : '';
              return text !== '' && text !== '…';
            };
            return rendered('status-pill') && rendered('passenger-chip');
          },
          null,
          { timeout: 20000 }
        );
        return page;
      });
      panel = await stage('panel page', 30000, async () => {
        const page = await ctx.newPage();
        page.on('pageerror', (err) => panelErrors.push(`pageerror: ${err.message}`));
        page.on('console', (msg) => msg.type() === 'error' && panelErrors.push(msg.text()));
        await page.setViewportSize({ width: WIDTH, height: 900 });
        await page.goto(`chrome-extension://${new URL(worker.url()).host}/src/panel/panel.html`);
        return page;
      });
      await stage('the panel describes the demo tab', 20000, async () => {
        // The panel reads the ACTIVE tab, so the demo has to be in front or the panel
        // would be describing itself and the Sources tab would be empty.
        await demo.bringToFront();
        await openTab(panel, 'sources');
        await panel.waitForFunction(
          (host) => {
            const named = document.querySelector('#sitebar .sitebar__host');
            return (
              Boolean(named && named.textContent.includes(host)) &&
              document.querySelectorAll('#source-list .card').length >= 2
            );
          },
          '127.0.0.1',
          { timeout: 15000 }
        );
      });
      t.diagnostic(`fixture ready — ${timeline.join(', ')}`);
    } catch {
      // Every check below reports; the stage recorded which one died and why.
    }

    try {
      /* ═══════════════════════ every control keyboard-reachable ═══════════════════ */

      await check('§16 M7 every control on every tab is in the tab order', async () => {
        let swept = 0;
        for (const tab of TABS) {
          await openTab(panel, tab);
          const { expected, reached } = await tabOrder(panel);
          // A sweep that found nothing would pass the assertion below by describing an
          // empty panel. The floor is per tab AND over the whole panel: the idle Pick tab
          // is genuinely two stops (the tab strip is one, being a radio group, plus its
          // one button), while §10.2 with the demo behind it is a dozen.
          assert.ok(expected.length >= 2, `only ${expected.length} controls found on the ${tab} tab — the sweep is not seeing the panel`);
          swept += expected.length;
          const missed = expected.filter((control) => !reached.has(control.id));
          assert.deepEqual(
            missed.map((control) => `${control.what} “${control.name}”`),
            [],
            `on the ${tab} tab these can be operated with a mouse and by nothing else`
          );
        }
        assert.ok(swept >= 12, `only ${swept} controls across all four tabs — the sweep is not seeing the panel`);
        t.diagnostic(`tab order: ${swept} controls reached across ${TABS.length} tabs`);
      });

      await check('§10.2 a source card opens from the keyboard, and says that it did', async () => {
        // The card's checkbox carried `tabindex="-1" aria-hidden="true"` and the label
        // around it is not focusable, so the whole §10.2 tab was mouse-only. The check
        // above would catch that; this one is what a person actually does with it.
        await openTab(panel, 'sources');
        const before = await panel.evaluate(() => ({
          expanded: document.querySelector('#source-list .card__head > input').getAttribute('aria-expanded'),
          trees: document.querySelectorAll('#source-list .tree').length
        }));
        assert.equal(before.expanded, 'false');
        assert.equal(before.trees, 0, 'the fixture must start with every source closed');

        // Reached BY TABBING, not by `focus()`. Two reasons, and the second is the one
        // that matters: `focus()` would pass on a control with `tabindex="-1"`, which is
        // exactly what these had; and `:focus-visible` is modality-dependent, so a ring
        // asserted after a scripted focus that followed a mouse click would be absent for
        // a reason that has nothing to do with the stylesheet.
        const landed = await tabTo(panel, '#source-list .card__head > input');
        assert.equal(landed, true, 'the keyboard cannot reach the control that opens a source');
        const focusRing = await panel.evaluate(() => {
          const card = document.querySelector('#source-list .card');
          // The input is invisible and has no area, so a ring on IT would be a ring
          // nobody can see. It is drawn on the card.
          return getComputedStyle(card).outlineStyle;
        });
        assert.notEqual(focusRing, 'none', 'a focused source card must show where the focus is (WCAG 2.4.7)');

        await panel.keyboard.press('Space');
        await panel.waitForSelector('#source-list .tree', { timeout: 5000 });
        const after = await panel.evaluate(() => ({
          expanded: document.querySelector('#source-list .card__head > input').getAttribute('aria-expanded'),
          rows: document.querySelectorAll('#source-list .tree__row').length
        }));
        assert.equal(after.expanded, 'true', 'and it has to SAY it opened, or a screen reader is told nothing happened');
        assert.ok(after.rows > 0, 'the response tree is what opening a source is for');
        await panel.keyboard.press('Space');
        await panel.waitForFunction(() => document.querySelectorAll('#source-list .tree').length === 0, null, { timeout: 5000 });
      });

      await check('§10 the tab strip says which tab is selected', async () => {
        // Four `<input type="radio">` given `role="tab"`. An explicit role REPLACES the
        // native semantics, so `checked` announces nothing and `aria-selected` — the
        // property the tab role carries — is the only thing that can.
        for (const tab of TABS) {
          await openTab(panel, tab);
          const marks = await panel.evaluate(
            (tabs) => tabs.map((name) => document.getElementById(`tab-${name}`).getAttribute('aria-selected')),
            TABS
          );
          assert.deepEqual(
            marks,
            TABS.map((name) => String(name === tab)),
            `on the ${tab} tab, aria-selected does not name it`
          );
        }
      });

      /* ═════════════ WCAG 2.2 1.4.13, and the reasons only a mouse could read ═════ */

      await check('§16 M7 no tooltip in the panel hides its reason behind a `disabled`', async () => {
        // Structural, and stated over the DOM rather than over a list of controls: a
        // `disabled` element is not focusable and dispatches no pointer events, so a
        // tooltip on one is readable by hovering and by nothing else. `withTip` converts
        // to `aria-disabled` (dom.js); this is what stops the next one regressing.
        let inert = 0;
        for (const tab of TABS) {
          await openTab(panel, tab);
          const found = await panel.evaluate(() => ({
            trulyDisabled: [...document.querySelectorAll('.tip :disabled')].map(
              (node) => (node.getAttribute('aria-label') || node.textContent || node.className).trim().slice(0, 40)
            ),
            inert: [...document.querySelectorAll('.tip [aria-disabled="true"]')].map((node) => ({
              name: (node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 40),
              describedBy: node.getAttribute('aria-describedby'),
              reason: (() => {
                const bubble = document.getElementById(node.getAttribute('aria-describedby') || '');
                return bubble ? bubble.textContent.trim() : null;
              })(),
              focusable: !node.disabled
            }))
          }));
          assert.deepEqual(
            found.trulyDisabled,
            [],
            `on the ${tab} tab a control inside a tooltip is \`disabled\`, so its reason is mouse-only`
          );
          for (const control of found.inert) {
            assert.equal(control.focusable, true, `“${control.name}” is inert and cannot be focused`);
            assert.ok(control.describedBy, `“${control.name}” is inert with no aria-describedby, so the reason is announced by nothing`);
            assert.ok(control.reason && control.reason.length > 0, `“${control.name}” points at a bubble with no words in it`);
          }
          inert += found.inert.length;
        }
        // Not vacuous: the panel really does carry inert controls with reasons today.
        assert.ok(inert > 0, 'no inert control found anywhere — this check is passing by describing nothing');
        t.diagnostic(`${inert} inert controls, every one of them focusable and described`);
      });

      await check('§1.1 a switched-off control states its reason in text a keyboard can reach', async () => {
        /* The other half of the exclusion in COLLECT_CONTROLS: a `disabled` control owes
         * no tab stop and does owe a reason, and until M7 three of them gave it through a
         * hover tooltip — which `disabled` itself makes unreachable — while a fourth, the
         * danger zone's "Reset this site", gave none at all. It was grey and silent, and
         * nothing had ever looked at it.
         *
         * The rule is structural so the next one inherits it: the reason is either a help
         * line INSIDE the row (the §9.2 check-row shape) or the control's immediately
         * following sibling. Both are visible text, which is the only form of reason that
         * is available to a pointer, a keyboard and a screen reader at once. */
        let explained = 0;
        for (const tab of TABS) {
          await openTab(panel, tab);
          const silent = await panel.evaluate(() => {
            const shown = (node) => node.getClientRects().length > 0 && !node.closest('.hidden');
            const out = { silent: [], explained: 0 };
            for (const control of document.querySelectorAll('.app :disabled')) {
              if (!shown(control)) continue;
              const row = control.closest('.check-row, .info-row');
              const inside = row ? row.querySelector('.check-row__help, .help') : null;
              const after = (row || control).nextElementSibling;
              const beside = after && after.classList.contains('help') ? after : null;
              const reason = (inside && inside.textContent.trim()) || (beside && beside.textContent.trim()) || '';
              if (reason) out.explained += 1;
              else {
                out.silent.push(
                  (control.getAttribute('aria-label') || control.textContent || '').trim().slice(0, 40) ||
                    (control.closest('label') ? control.closest('label').textContent.trim().slice(0, 40) : control.className)
                );
              }
            }
            return out;
          });
          assert.deepEqual(
            silent.silent,
            [],
            `on the ${tab} tab these are switched off and say nothing about why — grey is not a sentence (§1.1)`
          );
          explained += silent.explained;
        }
        assert.ok(explained >= 3, `only ${explained} explained disabled controls found — the sweep is not seeing the panel`);
        t.diagnostic(`${explained} switched-off controls, every one of them with a written reason`);
      });

      await check('§16 M7 a keyboard reveals the reason a mouse would (1.4.13 on focus)', async () => {
        // §10.4's "New scenario from current changes", which the demo leaves inert (no
        // changes are on) and which therefore carries its reason in a tooltip.
        await openTab(panel, 'scenarios');
        const seen = await stillMotion(panel, () => panel.evaluate(() => {
          // ON SCREEN, not merely in the document: a hidden tab's controls are still
          // queryable, and focusing one inside `display:none` does nothing at all — a
          // version of this check that did that measured 0 and 0 and looked like a
          // stylesheet failure.
          const visible = (node) => node.getClientRects().length > 0;
          const control = [...document.querySelectorAll('.tip [aria-disabled="true"], .tip button')].find(visible);
          if (!control) return null;
          const bubble = document.getElementById(control.getAttribute('aria-describedby'));
          const before = Number(getComputedStyle(bubble).opacity);
          control.focus();
          return { before, after: Number(getComputedStyle(bubble).opacity), text: bubble.textContent.trim() };
        }));
        assert.ok(seen, 'the fixture found no tooltip at all');
        assert.equal(seen.before, 0, 'a tooltip nobody is pointing at must not be on screen');
        assert.equal(seen.after, 1, 'focusing the control does not reveal its tooltip — :focus-within is not firing');
        assert.ok(seen.text.length > 0);
      });

      await check('WCAG 2.2 1.4.13 a tooltip can be hovered, and can be dismissed with Escape', async () => {
        await openTab(panel, 'settings');
        await stillMotion(panel, async () => {
        // The tab strip's own tooltip: present on every tab, and the one that opens over
        // the site bar and its "Reset site".
        const tip = panel.locator('.segmented__opt.tip').first();
        await tip.hover();
        await panel.waitForFunction(
          () => Number(getComputedStyle(document.querySelector('#tabs .tip__bubble')).opacity) === 1,
          null,
          { timeout: 4000 }
        );

        // PERSISTENT: it is on no timer.
        await panel.waitForTimeout(1200);
        const persistent = await panel.evaluate(() =>
          Number(getComputedStyle(document.querySelector('#tabs .tip__bubble')).opacity)
        );
        assert.equal(persistent, 1, 'the bubble disappeared on its own while the pointer was still on the control');

        // HOVERABLE: the pointer can be moved onto the bubble itself without it going.
        const events = await panel.evaluate(() => getComputedStyle(document.querySelector('#tabs .tip__bubble')).pointerEvents);
        assert.equal(events, 'auto', 'a shown bubble with pointer-events:none cannot be hovered (1.4.13)');
        const box = await panel.locator('#tabs .tip__bubble').first().boundingBox();
        await panel.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await panel.waitForTimeout(400);
        const onBubble = await panel.evaluate(() =>
          Number(getComputedStyle(document.querySelector('#tabs .tip__bubble')).opacity)
        );
        assert.equal(onBubble, 1, 'the bubble vanished out from under the pointer that moved onto it (1.4.13)');

        // DISMISSIBLE: Escape, with the pointer where it is and the focus where it is.
        await panel.keyboard.press('Escape');
        await panel.waitForTimeout(400);
        const dismissed = await panel.evaluate(() =>
          Number(getComputedStyle(document.querySelector('#tabs .tip__bubble')).opacity)
        );
        assert.equal(dismissed, 0, 'Escape does not dismiss the tooltip (1.4.13)');

        // …and the dismissal is not permanent: pointing somewhere else and coming back
        // shows it again. A hush that never lifted would be a tooltip deleted, not
        // dismissed, and every later check here would pass by seeing nothing.
        await panel.mouse.move(1, 1);
        await tip.hover();
        await panel.waitForFunction(
          () => Number(getComputedStyle(document.querySelector('#tabs .tip__bubble')).opacity) === 1,
          null,
          { timeout: 4000 }
        );
        await panel.mouse.move(1, 1);
        });
      });

      /* ═════════════════════════════ the RTL smoke test ═══════════════════════════ */

      await check('§9.2 the direction the panel runs in comes from strings.js, not the markup', async () => {
        const declared = await panel.evaluate(() => ({
          dir: document.documentElement.dir,
          lang: document.documentElement.lang,
          markup: null
        }));
        assert.equal(declared.dir, S.meta.dir, 'the panel must run the way its copy runs');
        assert.equal(declared.lang, S.meta.lang, 'and announce the language its copy is in');
        // The other half: nothing in the markup states either, or translating one file
        // would leave the direction behind. Read from the shipped file, not the DOM,
        // because the DOM is what panel.js has already fixed up.
        const markup = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src/panel/panel.html'), 'utf8');
        const html = /<html[^>]*>/.exec(markup)[0];
        assert.doesNotMatch(html, /\sdir\s*=/i, `panel.html states a direction of its own: ${html}`);
        assert.doesNotMatch(html, /\slang\s*=/i, `panel.html states a language of its own: ${html}`);
      });

      await check('§9.2 RTL smoke test: the whole panel mirrors, and nothing hangs off it', async () => {
        const measure = async () =>
          panel.evaluate(() => {
            const app = document.querySelector('.app');
            const appBox = app.getBoundingClientRect();
            const strip = document.getElementById('tabs');
            const thumb = strip.getBoundingClientRect();
            const before = getComputedStyle(strip, '::before');
            // Where the thumb ACTUALLY sits, which is the one thing `--dir` exists to
            // move: the transform is read as a matrix so a sign flip is measurable
            // rather than inferred from the stylesheet.
            const matrix = new DOMMatrixReadOnly(before.transform === 'none' ? '' : before.transform);
            const escaped = [...app.querySelectorAll('*')]
              .filter((node) => node.getClientRects().length > 0)
              .filter((node) => {
                const box = node.getBoundingClientRect();
                return box.right > appBox.right + 0.5 || box.left < appBox.left - 0.5;
              })
              .map((node) => node.className || node.tagName);
            return {
              dir: getComputedStyle(document.documentElement).getPropertyValue('--dir').trim(),
              thumbX: Math.round(matrix.m41),
              stripWidth: Math.round(thumb.width),
              overflowsPage: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
              escaped
            };
          });

        await openTab(panel, 'settings');
        await stillMotion(panel, async () => {
        const ltr = await measure();
        assert.equal(ltr.dir, '1', 'the light-to-right default');
        assert.ok(ltr.thumbX > 0, `the thumb must have travelled to the fourth tab; it is at ${ltr.thumbX}px`);
        assert.deepEqual(ltr.escaped, [], 'something hangs off the panel before RTL is even considered');
        assert.equal(ltr.overflowsPage, false);

        await panel.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));
        const rtl = await measure();
        assert.equal(rtl.dir, '-1', '`[dir=rtl]` must flip --dir, which is what every logical rule reads');
        // The Settings tab is the LAST of four, so its thumb is at the far end of the
        // strip — the far RIGHT in LTR and the far LEFT in RTL. Same magnitude, opposite
        // sign: a layout that only LOOKED mirrored would leave this positive.
        assert.ok(rtl.thumbX < 0, `the thumb did not cross to the other side: ${ltr.thumbX} -> ${rtl.thumbX}`);
        // Same magnitude, opposite sign. Compared with a pixel of slack because the real
        // figure is a half-pixel (256.5) and rounding a negative half is not the mirror
        // of rounding a positive one — an exact `-ltr.thumbX` fails on correct layout.
        assert.ok(
          Math.abs(rtl.thumbX + ltr.thumbX) <= 1,
          `the thumb mirrored to a different distance: ${ltr.thumbX} -> ${rtl.thumbX}`
        );
        assert.deepEqual(rtl.escaped, [], 'these hang off the panel when it runs right-to-left');
        assert.equal(rtl.overflowsPage, false, 'the panel scrolls sideways in RTL');

        // Every tab, because a mirroring failure is usually in one screen's one rule.
        for (const tab of TABS) {
          await openTab(panel, tab);
          const seen = await measure();
          assert.deepEqual(seen.escaped, [], `the ${tab} tab hangs off the panel in RTL`);
          assert.equal(seen.overflowsPage, false, `the ${tab} tab scrolls sideways in RTL`);
        }

        /* …and §10.2 with a response tree OPEN, which is the densest layout in the panel
         * and the only one whose controls sit hard against the inline end. This is not
         * thoroughness for its own sake: measuring it is what found three tooltips
         * hanging 32px off the panel — in the LTR build as well, shipped since M2 and
         * invisible because every tooltip-overflow check that existed was on a different
         * screen. Measured in both directions, because `.tip--end` is the fix and an
         * `inset-inline-end` that had been written as `right` would pass one and fail
         * the other. */
        await openTab(panel, 'sources');
        await panel.click('#source-list .card__head');
        await panel.waitForSelector('#source-list .tree', { timeout: 5000 });
        for (const dir of ['rtl', 'ltr']) {
          await panel.evaluate((where) => document.documentElement.setAttribute('dir', where), dir);
          const open = await measure();
          assert.ok(
            open.escaped.length === 0,
            `with a response tree open, ${dir} hangs these off the panel: ${open.escaped.slice(0, 4).join(', ')}`
          );
          assert.equal(open.overflowsPage, false, `the open tree scrolls sideways in ${dir}`);
        }
        await panel.click('#source-list .card__head');

        await panel.evaluate((dir) => document.documentElement.setAttribute('dir', dir), S.meta.dir);
        });
        await openTab(panel, 'sources');
      });

      /* ═══════════════════════════ motion is a preference ═════════════════════════ */

      await check('§16 M7 prefers-reduced-motion turns the tab spring and the checkbox pop off', async () => {
        await openTab(panel, 'settings');
        const moving = await panel.evaluate(() => ({
          thumb: getComputedStyle(document.getElementById('tabs'), '::before').transitionDuration,
          icon: getComputedStyle(document.querySelector('#tabs input:checked ~ label svg')).animationDuration
        }));
        assert.notEqual(moving.thumb, '0s', 'the spring is meant to exist when nobody asked for it not to');

        await panel.emulateMedia({ reducedMotion: 'reduce' });
        await panel.waitForTimeout(150);
        // The pop only runs on a REAL toggle (the --draw class), so one is performed.
        await panel.click('#settings-rows .check-row');
        const still = await panel.evaluate(() => {
          const box = document.querySelector('#settings-rows .check-box--draw');
          return {
            thumb: getComputedStyle(document.getElementById('tabs'), '::before').transitionDuration,
            icon: getComputedStyle(document.querySelector('#tabs input:checked ~ label svg')).animationDuration,
            pop: box ? getComputedStyle(box).animationName : null,
            mark: box ? getComputedStyle(box, '::after').animationName : null,
            card: getComputedStyle(document.querySelector('#panel-settings')).animationDuration
          };
        });
        assert.equal(still.thumb, '0s', '§16 M7 names the spring: it is off, not merely brief');
        assert.equal(still.pop, 'none', "§16 M7 names the pop: it is off, not merely brief");
        assert.equal(still.mark, 'none', 'and so is the checkmark it draws');
        assert.equal(still.icon, '0.001s', 'the tab icon still swings under prefers-reduced-motion');
        assert.equal(still.card, '0.001s', 'and so does the panel entrance');
        assert.ok(moving.icon !== '0.001s', 'the icon animation is meant to exist by default');

        // Put the setting back the way it was found, and the preference with it.
        await panel.click('#settings-rows .check-row');
        await panel.emulateMedia({ reducedMotion: 'no-preference' });
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
