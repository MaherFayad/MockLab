/**
 * PLAN.md §10.4 (the Scenarios tab), §10.3's triggers, and §1.1's third link state —
 * rendered in the real side panel, in real Chromium, against the real stylesheet.
 *
 * OWNER: panel-designer. A file rather than another 400 lines on `panel.browser.test.js`,
 * for the reason README Deviation 49 gives for the M4 split: that suite is the M2 changes
 * flow followed by the M3 pick flow, and the second depends on the state the first leaves
 * behind. Nothing here depends on either, so it shares `testlib/browserFixture.js`.
 *
 * ── What only a browser can answer ──────────────────────────────────────────────
 * `scenarioFile.test.js` proves what a chosen file becomes; `panel.links.test.js` proves
 * when a Link may still be called proved. Neither can answer the two questions M5 is
 * judged on, because both are questions about a SCREEN: does the refusal a corrupt file
 * produces reach a person's eyes, in a 360px panel, without overflowing it or being drawn
 * in an unreadable colour — and does export → delete → import round-trip through the real
 * controls (a real `<a download>`, a real `<input type="file">`, a real change event)
 * rather than through two functions called back to back.
 *
 * And one this build has learned to ask separately: §1.1's `stale` is the state no demo
 * fixture can reach, because the demo always serves both its sources. It is reached here
 * by taking a source away, and the screen is measured, not assumed.
 *
 * Every expected string comes from `../src/panel/strings.js` (§17.6), and several checks
 * SWAP a key for a sentinel — a test that asserts today's wording passes just as happily
 * with that wording baked into the render. Every check REPORTS (README Deviation 45).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { S } from '../src/panel/strings.js';
import { MSG } from '../src/background/messages.js';
import { SCENARIO_CONTRACT, missingScenarioContract } from '../src/panel/scenarios.js';
import { loadChromium, launchExtension, createFixture } from '../testlib/browserFixture.js';
import { readVerifiedChips, assertVerifiedHonesty } from '../testlib/verifiedChip.js';

const SENTINEL = '⟪sentinel⟫';
/** The panel is designed for 360–420px (§9.2) and must survive its 320px minimum. */
const WIDTH = 360;

/** A stored Scenario, shaped like one the demo would produce. */
const preset = (over = {}) => ({
  id: 'p-cancelled',
  origin: 'http://127.0.0.1:8517',
  name: 'Flight cancelled',
  emoji: '🎬',
  createdAt: 1700000000000,
  changes: [
    { sigId: 'sig-trip', path: '$.status', value: 'CANCELLED', enabled: true },
    { sigId: 'sig-trip', path: '$.price.total', value: 0, enabled: true }
  ],
  ...over
});

/**
 * Install a live panel context on `window.__ml` and render the Scenarios tab into the
 * panel's own markup. Everything after this drives the REAL controls.
 */
function mount(page, { presets = [], sources, changeCount = 2, answers = {}, swap = [] } = {}) {
  return page.evaluate(
    async ([given, answerMap, swapKeys, sentinel]) => {
      const scenarios = await import('/src/panel/scenarios.js');
      const { MSG } = await import('/src/background/messages.js');
      const { S } = await import('/src/panel/strings.js');

      const saved = [];
      for (const key of swapKeys) {
        const parts = key.split('.');
        const leaf = parts.pop();
        const node = parts.reduce((where, part) => where[part], S);
        saved.push([node, leaf, node[leaf]]);
        node[leaf] = typeof node[leaf] === 'function' ? () => sentinel : sentinel;
      }

      const root = document.getElementById('scenario-body');
      const sent = [];
      const toasts = [];
      const ctx = {
        state: {
          tabId: 7,
          origin: 'http://127.0.0.1:8517',
          hostname: '127.0.0.1',
          captured: true,
          sources: given.sources,
          changes: [],
          changeCount: given.changeCount,
          bindings: [],
          lostLinks: new Set(),
          canHighlight: true,
          settings: { advancedMode: false },
          scenarios: { ready: given.ready, presets: given.presets, form: null, menu: null, confirm: null, error: '', busy: false }
        },
        send: async (type, payload) => {
          sent.push({ type, payload });
          const key = Object.keys(MSG).find((name) => MSG[name] === type);
          return Object.prototype.hasOwnProperty.call(answerMap, key) ? answerMap[key] : { ok: true };
        },
        toast: (text) => toasts.push(text),
        refresh: async () => {},
        rerender: () => scenarios.renderScenariosTab(root, ctx)
      };
      window.__ml = { ctx, sent, toasts, root, restore: () => saved.forEach(([n, l, v]) => (n[l] = v)) };
      ctx.rerender();

      document.getElementById('tab-scenarios').checked = true;
      for (const name of ['pick', 'sources', 'scenarios', 'settings']) {
        document.getElementById(`panel-${name}`).classList.toggle('hidden', name !== 'scenarios');
      }
    },
    [
      { presets, sources: sources === undefined ? [{ sigId: 'sig-trip' }, { sigId: 'sig-user' }] : sources, changeCount, ready: answers.ready !== false },
      answers.map || {},
      swap,
      SENTINEL
    ]
  );
}

/** What a person can see on the tab right now. */
function readTab(page) {
  return page.evaluate(() => {
    const root = document.getElementById('scenario-body');
    const panelBox = document.querySelector('.app').getBoundingClientRect();
    const overflows = (node) => {
      const box = node.getBoundingClientRect();
      return box.right > panelBox.right + 0.5 || box.left < panelBox.left - 0.5;
    };
    const text = (selector) => [...root.querySelectorAll(selector)].map((n) => n.textContent.trim());
    return {
      bodyText: root.innerText,
      empty: text('.empty')[0] || null,
      helps: text('.help'),
      importError: text('.import-error')[0] || null,
      importErrorOverflows: [...root.querySelectorAll('.import-error')].some(overflows),
      cardsOverflow: [...root.querySelectorAll('.card')].some(overflows),
      names: text('.scenario__name'),
      symbols: text('.scenario__symbol'),
      metas: text('.card__meta'),
      notes: text('.card__note'),
      menuItems: text('.scenario__item'),
      confirm: text('.scenario__confirm .help')[0] || null,
      chips: [...root.querySelectorAll('.chip')].map((c) => ({
        text: c.textContent.trim(),
        cls: c.className,
        linkState: c.dataset.linkState === undefined ? null : c.dataset.linkState
      })),
      buttons: [...root.querySelectorAll('button')].map((b) => ({
        text: b.textContent.trim(),
        label: b.getAttribute('aria-label'),
        cls: b.className,
        disabled: b.disabled
      })),
      tips: [...root.querySelectorAll('.tip__bubble')].map((b) => ({ text: b.textContent.trim(), overflows: overflows(b) })),
      picker: (() => {
        const box = root.querySelector('.segmented--symbols');
        if (!box) return null;
        const style = getComputedStyle(box, '::before');
        return {
          cols: Number(box.style.getPropertyValue('--seg-cols')),
          x: Number(box.style.getPropertyValue('--seg-x')),
          options: [...box.querySelectorAll('.segmented__opt label')].map((l) => l.textContent.trim()),
          thumbTransition: style.transitionTimingFunction + ' ' + style.transitionDuration
        };
      })(),
      sent: ((window.__ml && window.__ml.sent) || []).map((s) => ({ type: s.type, payload: s.payload })),
      toasts: ((window.__ml && window.__ml.toasts) || []).slice()
    };
  });
}

/**
 * Contrast, measured in the page rather than stated from memory. The background walks UP
 * until it finds one that is not transparent, because a chip's own surface is often its
 * card's.
 */
const CONTRAST = (selector) => `(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) return null;
  const lum = (rgb) => rgb.match(/[\\d.]+/g).slice(0, 3).map(Number)
    .map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : Math.pow((v / 255 + 0.055) / 1.055, 2.4)))
    .reduce((sum, c, i) => sum + [0.2126, 0.7152, 0.0722][i] * c, 0);
  const style = getComputedStyle(node);
  let bg = style.backgroundColor, walk = node;
  while (bg === 'rgba(0, 0, 0, 0)' && walk.parentElement) { walk = walk.parentElement; bg = getComputedStyle(walk).backgroundColor; }
  const a = lum(style.color), b = lum(bg);
  return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
})()`;

const chromium = await loadChromium();

if (!chromium) {
  test('panel scenarios browser suite', { skip: 'Playwright is not installed — `npm i -D playwright && npx playwright install chromium` enables it.' }, () => {});
} else {
  test('the Scenarios tab, its import, and the stale state — PLAN.md §10.4, §10.3, §1.1', async (t) => {
    const { stage, check, timeline } = createFixture(t);

    let profile = null;
    let ctx = null;
    let worker = null;
    let panel = null;
    const panelErrors = [];

    try {
      profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mocklab-scenarios-'));
      ctx = await stage('chromium launch + extension load', 60000, () => launchExtension(chromium, profile), {
        absent: 'Chromium could not be launched'
      });
      worker = await stage('service-worker registration', 20000, async () =>
        ctx.serviceWorkers()[0] || ctx.waitForEvent('serviceworker', { timeout: 20000 })
      );
      panel = await stage('panel page', 30000, async () => {
        const page = await ctx.newPage();
        page.on('pageerror', (err) => panelErrors.push(`pageerror: ${err.message}`));
        page.on('console', (msg) => msg.type() === 'error' && panelErrors.push(msg.text()));
        await page.setViewportSize({ width: WIDTH, height: 1000 });
        await page.goto(`chrome-extension://${new URL(worker.url()).host}/src/panel/panel.html`);
        // `state: 'attached'` and not the default 'visible': the Scenarios panel starts
        // with `.hidden` on it, so its body has no box until `mount()` shows the tab —
        // and a default waitForSelector would sit here for its whole budget.
        await page.waitForSelector('#scenario-body', { state: 'attached' });
        return page;
      });
      t.diagnostic(`fixture ready — ${timeline.join(', ')}`);
    } catch {
      // Every check below reports; the stage recorded which one died and why.
    }

    try {
      await check('the tab waits for exactly the contract it documents, and says so (§17.8, §1.1)', async () => {
        // Not an assertion about today, and not a simulation either: this is the REAL
        // panel, booted against the REAL service worker, with the real Scenarios tab
        // clicked. Either the worker answers `LIST_PRESETS` and the tab works, or it does
        // not and every control is disabled with a reason beside it. When the worker half
        // lands, this check keeps holding with no edit here.
        t.diagnostic(`contract names messages.js does not define: ${JSON.stringify(missingScenarioContract())}`);
        for (const name of missingScenarioContract()) {
          assert.ok(SCENARIO_CONTRACT.includes(name), `${name} is waited for but is not in the contract this tab documents`);
        }
        // The LABEL, not the input: §9.2's segmented control hides the radio beneath it.
        await panel.click('label[for="tab-scenarios"]');
        await panel.waitForSelector('#scenario-body .btn', { timeout: 5000 });
        const seen = await readTab(panel);
        const reachable = !seen.bodyText.includes(S.notYet);
        t.diagnostic(`the real worker ${reachable ? 'answers' : 'does not answer'} LIST_PRESETS`);
        if (reachable) {
          // The worker half is here: the tab must be a working tab, not a disabled one.
          assert.equal(seen.buttons.some((button) => button.text === S.scenarios.import && !button.disabled), true, 'Import is live once the store answers');
          assert.ok(seen.empty === S.scenarios.empty || seen.names.length > 0, 'a reachable store shows scenarios, or says there are none');
        } else {
          // It is not: every control says so rather than doing nothing quietly (§1.1).
          assert.equal(seen.empty, null, '"no scenarios saved" is a different claim from "MockLab has not been told any"');
          for (const button of seen.buttons) {
            assert.equal(button.disabled, true, `“${button.text}” is live while the store cannot be reached`);
          }
          assert.ok(
            seen.tips.some((tip) => tip.text.includes(S.notYet)),
            'and every disabled control carries the reason, not just the screen'
          );
        }
      });

      await check('§10.4 with nothing saved: the empty line, and New disabled with its reason', async () => {
        await mount(panel, { presets: [], changeCount: 0 });
        const seen = await readTab(panel);
        assert.equal(seen.empty, S.scenarios.empty);
        const make = seen.buttons.find((b) => b.text === S.scenarios.new);
        assert.ok(make, '§10.4 names this button');
        assert.equal(make.disabled, true, '§10.4: disabled when 0 active changes');
        assert.ok(
          seen.tips.some((tip) => tip.text === S.scenarios.nothingToSave),
          '§10.4 asks for a tooltip, and the tooltip has to be the REASON, not the label again'
        );
        const bring = seen.buttons.find((b) => b.text === S.scenarios.import);
        assert.equal(bring.disabled, false, 'Import does not need a change to exist');

        await mount(panel, { presets: [], changeCount: 3 });
        const live = await readTab(panel);
        assert.equal(live.buttons.find((b) => b.text === S.scenarios.new).disabled, false);
        assert.equal(live.tips.some((tip) => tip.text === S.scenarios.nothingToSave), false);
      });

      await check('§10.4 a scenario card: symbol, name, count, Apply, ⋯ — and it fits 360px', async () => {
        await mount(panel, { presets: [preset(), preset({ id: 'p2', name: 'Delayed by two hours', emoji: '🕒', changes: [preset().changes[0]] })] });
        const seen = await readTab(panel);
        assert.deepEqual(seen.names, ['Flight cancelled', 'Delayed by two hours']);
        assert.deepEqual(seen.symbols, ['🎬', '🕒']);
        assert.deepEqual(seen.metas, [S.scenarios.count(2), S.scenarios.count(1)]);
        assert.equal(S.scenarios.count(1).includes('1 change'), true, 'one change is not "1 changes"');
        assert.equal(seen.buttons.filter((b) => b.text === S.scenarios.apply).length, 2);
        assert.equal(seen.buttons.filter((b) => b.label === S.scenarios.more).length, 2);
        assert.equal(seen.cardsOverflow, false, 'a card hangs off the panel at its designed width');
        assert.deepEqual(seen.tips.filter((tip) => tip.overflows), [], 'a tooltip hangs off the panel');
        assert.deepEqual(seen.notes, [], 'nothing is stale here, so nothing says it is');
        assert.deepEqual(seen.chips, [], '§10.6: no chip means no status claimed');
      });

      await check('§10.4 the ⋯ menu is §10.4\'s four actions, and Delete asks first', async () => {
        await mount(panel, { presets: [preset()] });
        await panel.click('#scenario-body .scenario__more');
        const open = await readTab(panel);
        assert.deepEqual(open.menuItems, [S.scenarios.rename, S.scenarios.duplicate, S.scenarios.exportFile, S.scenarios.delete]);

        await panel.click('#scenario-body .scenario__item--danger');
        const asked = await readTab(panel);
        assert.equal(asked.confirm, S.scenarios.deleteConfirm('Flight cancelled'));
        assert.deepEqual(asked.menuItems, [], 'the menu closes when its last action opens a question');
        assert.equal(asked.sent.length, 0, 'nothing is deleted until the question is answered');

        await panel.click('#scenario-body .scenario__confirm .btn--ghost');
        const cancelled = await readTab(panel);
        assert.equal(cancelled.confirm, null);
        assert.equal(cancelled.sent.length, 0);
        assert.deepEqual(cancelled.names, ['Flight cancelled']);
      });

      await check('§1.1 a scenario whose sources this page no longer loads reads as Stale', async () => {
        // The state no demo fixture can reach: the demo always serves both its sources.
        // Reached here by taking one away, which is what a redeploy does.
        await mount(panel, { presets: [preset()], sources: [{ sigId: 'sig-user' }] });
        const seen = await readTab(panel);
        assert.deepEqual(seen.chips.map((c) => c.text), [S.chips.stale]);
        assert.equal(seen.chips[0].linkState, 'stale', 'the chip carries the state it was drawn from');
        assert.ok(seen.chips[0].cls.split(/\s+/).includes('chip--stale'), 'the word and the colour come from one datum');
        assert.deepEqual(seen.notes, [S.scenarios.stale], '§10.4 asks for the sentence as well as the chip');
        await honesty(panel, 0, 'a stale scenario card');

        await mount(panel, { presets: [preset()], sources: [{ sigId: 'sig-trip' }, { sigId: 'sig-user' }] });
        const whole = await readTab(panel);
        assert.deepEqual(whole.chips, []);
        assert.deepEqual(whole.notes, []);
      });

      await check('§10.4 Apply says what actually happened, including when it half-happened', async () => {
        await mount(panel, { presets: [preset()], answers: { map: { APPLY_PRESET: { ok: true, applied: 1, unapplied: 1, refreshed: true } } } });
        await panel.click('#scenario-body .scenario__apply');
        const partly = await readTab(panel);
        assert.deepEqual(partly.sent.map((s) => s.type), [MSG.APPLY_PRESET]);
        assert.deepEqual(partly.sent[0].payload, { tabId: 7, presetId: 'p-cancelled', refresh: true });
        assert.deepEqual(partly.toasts, [S.scenarios.appliedPartly('Flight cancelled', 1)]);
        assert.notEqual(partly.toasts[0], S.scenarios.applied('Flight cancelled'), '§1.1: a half-applied scenario may not toast a clean "applied"');

        await mount(panel, { presets: [preset()], answers: { map: { APPLY_PRESET: { ok: true, applied: 2, unapplied: 0, refreshed: true } } } });
        await panel.click('#scenario-body .scenario__apply');
        assert.deepEqual((await readTab(panel)).toasts, [S.scenarios.applied('Flight cancelled')]);
      });

      await check('§16 M5 DoD — export → delete → import round-trips through the real controls', async () => {
        await mount(panel, { presets: [preset()] });
        // The anchor's blob is captured rather than the download intercepted: what has
        // to be proved is the BYTES the person receives, and a download's plumbing is
        // Chromium's, not this product's.
        const exported = await panel.evaluate(async () => {
          const real = URL.createObjectURL;
          let text = null;
          let name = null;
          URL.createObjectURL = (blob) => {
            const url = real.call(URL, blob);
            text = blob.text();
            return url;
          };
          const anchors = [];
          const append = document.body.append.bind(document.body);
          document.body.append = (node) => {
            if (node.tagName === 'A') anchors.push(node.getAttribute('download'));
            return append(node);
          };
          try {
            document.querySelector('.scenario__more').click();
            [...document.querySelectorAll('.scenario__item')][2].click();
            return { text: await text, name: anchors[0] };
          } finally {
            URL.createObjectURL = real;
            document.body.append = append;
          }
        });
        assert.ok(exported.name.endsWith('.mocklab.json'), `§10.4's extension, got ${exported.name}`);
        assert.equal(JSON.parse(exported.text).name, 'Flight cancelled');

        await mount(panel, { presets: [preset()], answers: { map: { DELETE_PRESET: { ok: true, deleted: 1 } } } });
        await panel.click('#scenario-body .scenario__more');
        await panel.click('#scenario-body .scenario__item--danger');
        await panel.click('#scenario-body .scenario__confirm .btn--danger');
        const deleted = await readTab(panel);
        assert.deepEqual(deleted.sent.map((s) => s.type), [MSG.DELETE_PRESET]);
        assert.deepEqual(deleted.sent[0].payload, { tabId: 7, presetId: 'p-cancelled' });

        await mount(panel, { presets: [] });
        await panel.setInputFiles('#scenario-body #scenario-file', {
          name: exported.name,
          mimeType: 'application/json',
          buffer: Buffer.from(exported.text, 'utf8')
        });
        await panel.waitForFunction(() => window.__ml.sent.length > 0, null, { timeout: 5000 });
        const imported = await readTab(panel);
        assert.deepEqual(imported.sent.map((s) => s.type), [MSG.IMPORT_PRESET]);
        const round = imported.sent[0].payload.preset;
        assert.equal(round.name, preset().name);
        assert.equal(round.emoji, preset().emoji);
        assert.deepEqual(round.changes, preset().changes, 'every change comes back with its source, field, value and on/off state');
        assert.equal(round.id, undefined, 'a re-import is a new scenario, not an overwrite');
        assert.deepEqual(imported.toasts, [S.scenarios.imported('Flight cancelled')]);
        assert.equal(imported.importError, null);
      });

      await check('§16 M5 DoD — a corrupt file produces a friendly error, on screen, readable', async () => {
        await mount(panel, { presets: [], swap: ['scenarios.importNotScenario'] });
        await panel.setInputFiles('#scenario-body #scenario-file', {
          name: 'holiday.png',
          mimeType: 'image/png',
          buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
        });
        await panel.waitForSelector('#scenario-body .import-error', { timeout: 5000 });
        const seen = await readTab(panel);
        // Sentinelled: asserting the wording would pass with it baked into the render.
        assert.equal(seen.importError, SENTINEL, 'the sentence is rendered from strings.js');
        assert.equal(seen.importErrorOverflows, false, 'the one sentence that has to be read hangs off a 360px panel');
        assert.deepEqual(seen.sent, [], 'nothing was sent to the store — the file never became a scenario');
        assert.deepEqual(seen.toasts, [], 'a toast is gone in 3.2s; this sentence tells the person what to pick instead');
        await panel.evaluate(() => window.__ml.restore());

        // Real words back: no stack, no file contents, no vocabulary a designer has no
        // meaning for (§1.2) — measured on what is ON SCREEN, not on the string.
        await mount(panel, { presets: [] });
        await panel.setInputFiles('#scenario-body #scenario-file', { name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"a":', 'utf8') });
        await panel.waitForSelector('#scenario-body .import-error', { timeout: 5000 });
        const real = await readTab(panel);
        assert.doesNotMatch(real.importError, /\b(json|api|endpoint|payload|regex|dom|probe|binding|signature|syntax|parse|token)s?\b/i);
        assert.doesNotMatch(real.importError, /\bat |position \d|column \d|line \d/i, 'no stack, no position in the file');
        assert.equal(real.importError.includes('{"a":'), false, 'the file is not quoted back at the person');
        const contrast = await panel.evaluate(CONTRAST('.import-error'));
        assert.ok(contrast >= 4.5, `the friendly error measures ${contrast}:1 — under WCAG 2.2 AA for 12px text`);
        t.diagnostic(`import error contrast: ${contrast}:1 (light)`);
      });

      await check('§10.4 the name form is §9.2\'s segmented control, spring thumb and all', async () => {
        await mount(panel, { presets: [], changeCount: 2 });
        // Scoped to the tab: `.btn--primary` also matches the Pick tab's CTA, which is in a
        // hidden panel — Playwright would wait its whole budget for it to become visible.
        await panel.click('#scenario-body > .stack .btn--primary');
        const form = await readTab(panel);
        assert.ok(form.picker, '§4 gives a scenario a symbol and §10.4 draws it');
        assert.equal(form.picker.cols, S.scenarios.symbols.length);
        assert.deepEqual(form.picker.options, S.scenarios.symbols);
        assert.match(form.picker.thumbTransition, /cubic-bezier\(0.34, ?1.56, ?0.64, ?1\)/, '§9.2\'s spring');
        assert.match(form.picker.thumbTransition, /0.35s/, '§9.2\'s 350ms');
        assert.equal(form.picker.x, 0, 'the default symbol is the one the thumb starts on');

        // The LABEL, which is what a person clicks: §9.2's segmented control hides the
        // radio under it (`opacity: 0`), so the input itself is never the hit target.
        await panel.click('#scenario-body label[for="scenario-symbol-3"]');
        assert.equal((await readTab(panel)).picker.x, 3);

        await panel.click('#scenario-body .editor .btn--primary');
        const empty = await readTab(panel);
        assert.equal(await panel.textContent('#scenario-body .editor__error'), S.scenarios.nameEmpty);
        assert.deepEqual(empty.sent, [], 'nothing is saved under no name');

        await panel.fill('#scenario-body #scenario-name', 'Sold out');
        await panel.click('#scenario-body .editor .btn--primary');
        const saved = await readTab(panel);
        assert.deepEqual(saved.sent.map((s) => s.type), [MSG.SAVE_PRESET]);
        assert.equal(saved.sent[0].payload.name, 'Sold out');
        assert.equal(saved.sent[0].payload.emoji, S.scenarios.symbols[3]);
      });

      await check('§10.6 the Stale chip is readable in both themes, and it is one of the four', async () => {
        for (const scheme of ['light', 'dark']) {
          await panel.emulateMedia({ colorScheme: scheme });
          await mount(panel, { presets: [preset()], sources: [{ sigId: 'sig-user' }] });
          const chip = await panel.evaluate(CONTRAST('.chip--stale'));
          const note = await panel.evaluate(CONTRAST('.card__note'));
          const error = await panel.evaluate(CONTRAST('.card__meta'));
          t.diagnostic(`${scheme}: stale chip ${chip}:1, stale note ${note}:1, card meta ${error}:1`);
          assert.ok(chip >= 4.5, `the Stale chip measures ${chip}:1 in ${scheme}`);
          assert.ok(note >= 4.5, `§11's stale sentence measures ${note}:1 in ${scheme}`);
          assert.ok(error >= 4.5, `the card's meta row measures ${error}:1 in ${scheme}`);
        }
        await panel.emulateMedia({ colorScheme: 'light' });
        // §10.6: four words, and no fifth. Every chip this tab can draw is one of them.
        const words = new Set(Object.values(S.chips));
        await mount(panel, { presets: [preset()], sources: [{ sigId: 'sig-user' }] });
        for (const chip of (await readTab(panel)).chips) {
          assert.ok(words.has(chip.text), `“${chip.text}” is not one of §10.6's four status words`);
        }
      });

      await check('§16 M7 prefers-reduced-motion turns the spring and the pop off', async () => {
        await panel.emulateMedia({ reducedMotion: 'reduce' });
        await mount(panel, { presets: [preset()], sources: [{ sigId: 'sig-user' }], changeCount: 2 });
        const still = await panel.evaluate(() => {
          const chip = document.querySelector('.chip--stale');
          const menu = document.querySelector('.scenario-grid .card');
          return {
            chip: getComputedStyle(chip).animationDuration,
            card: getComputedStyle(menu).transitionDuration
          };
        });
        assert.equal(still.chip, '0.001s', 'the chip pop still springs under prefers-reduced-motion');
        assert.equal(still.card, '0.001s', 'the card still animates under prefers-reduced-motion');
        await panel.emulateMedia({ reducedMotion: 'no-preference' });
      });

      await check('the panel logged no errors while any of this was rendered', () => {
        assert.deepEqual(panelErrors, []);
      });
    } finally {
      if (panel) await panel.close().catch(() => {});
      if (ctx) await ctx.close().catch(() => {});
      if (profile) fs.rmSync(profile, { recursive: true, force: true });
    }
  });
}

/** The §17.12 invariant, read out of whatever was just rendered. */
async function honesty(page, expected, where) {
  assertVerifiedHonesty(await page.evaluate(readVerifiedChips, S.chips.verified), { expected, where });
}
