/**
 * PLAN.md §10.1 State D, the probe progress card and the failure cards — rendered in the
 * real side panel, in real Chromium, against the real stylesheet.
 *
 * OWNER: panel-designer. Added at M4, which is the split README Deviation 27 says is due
 * here: `panel.browser.test.js` is the M2 changes flow and the M3 pick flow, in that
 * order, one depending on the state the other leaves behind. These screens depend on
 * neither, so they are a file rather than another 400 lines appended to a suite whose
 * ordering is already load-bearing — and none of the three `networkidle` waits inside
 * that suite is disturbed by anything here.
 *
 * ── What this suite can and cannot prove ────────────────────────────────────────
 * The STATE is simulated and the RENDERING is not: every screen below is drawn by the
 * panel's own modules, into the panel's own `#panel-pick`, with the panel's own cascade,
 * at a real width. That is the same technique `panel.browser.test.js` uses for §10.1A's
 * Recent links, and for the same reason — the alternative is shipping a screen nobody
 * ever looked at.
 *
 * What it CANNOT prove is that a real probe drives these screens, because the four
 * message types and three payload vocabularies the panel needs do not exist in
 * `messages.js` yet (that file has one owner; they are requested, not invented — see
 * `panel/probe.js`'s header). The first check below is the honest statement of that gap:
 * it asserts the panel is waiting for exactly the contract it documents, and that its
 * buttons are disabled for exactly as long as they cannot work. When the contract lands,
 * that check keeps holding with no edit here, and the buttons come alive on their own —
 * which is how the M3 picker contract landed mid-build.
 *
 * Every expected string is imported from `../src/panel/strings.js`, so §17.6 holds here
 * too. Several checks go further and SWAP a key for a sentinel: a test that asserts
 * today's wording passes just as happily with that wording baked into the render, which
 * is the defect class this repository has already shipped once.
 *
 * Every check REPORTS, whatever happens to the fixture (README Deviation 45).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { S } from '../src/panel/strings.js';
import { loadChromium, launchExtension, createFixture } from '../testlib/browserFixture.js';
import { readVerifiedChips, assertVerifiedHonesty } from '../testlib/verifiedChip.js';

/** Nothing a human would type, so a match can only have come from strings.js. */
const SENTINEL = '⟪sentinel⟫';

/** The panel is designed for 360–420px (§9.2) and must survive its 320px minimum. */
const WIDTH = 360;

/** The Binding a probe writes when it CONFIRMS (§7.1) — shaped like the demo's own. */
function link(state, over = {}) {
  return {
    id: 'link-1',
    origin: 'http://127.0.0.1',
    sigId: 'sig-trip',
    path: '$.status',
    elements: [
      { css: '#status-pill', textAnchor: 'On time', attrAnchors: [], treePath: [] },
      { css: '#alert-banner', textAnchor: 'Your flight was cancelled', attrAnchors: [], treePath: [] }
    ],
    state,
    lastVerifiedAt: 1000,
    observedValues: ['ON_TIME', 'DELAYED', 'CANCELLED'],
    probeMode: 'refresh',
    ...over
  };
}

/**
 * Render the Pick tab from a probe state and measure what a person would see.
 *
 * `swap` takes dotted keys into `strings.js` — 'probe.found', 'probe.step.control' — and
 * replaces each with a sentinel for this render only, restoring them afterwards. A
 * formatter is replaced by a formatter, so `probe.reloads(4, 8)` stays callable.
 */
function renderProbe(page, patch, swap = []) {
  return page.evaluate(
    async ([given, swapKeys, sentinel]) => {
      const pick = await import('/src/panel/pick.js');
      const probe = await import('/src/panel/probe.js');
      // The same module instance the panel imports, so a key replaced here is the key it
      // reads. Restored in the `finally` below — every later check reads real copy.
      const { S } = await import('/src/panel/strings.js');
      const saved = [];
      for (const key of swapKeys) {
        const parts = key.split('.');
        const leaf = parts.pop();
        const node = parts.reduce((where, part) => where[part], S);
        saved.push([node, leaf, node[leaf]]);
        node[leaf] = typeof node[leaf] === 'function' ? () => sentinel : sentinel;
      }
      try {
        const root = document.getElementById('panel-pick');
        const ctx = {
          state: Object.assign(
            {
              tabId: 1,
              sources: [{ sigId: 'sig-trip', name: 'Trip' }],
              settings: { advancedMode: false },
              bindings: [],
              pick: { picking: false, element: null, candidates: [] },
              probe: null
            },
            given
          ),
          send: async () => ({ ok: true }),
          toast: () => {},
          refresh: async () => {},
          rerender: () => {}
        };
        // The editor re-renders itself when the value picker changes, exactly as the
        // panel does — otherwise "click Custom…" would assert against a dead screen.
        ctx.rerender = () => pick.renderPickTab(root, ctx);
        pick.renderPickTab(root, ctx);

        // Show the tab, or innerText reads '' and every text assertion passes vacuously.
        document.getElementById('tab-pick').checked = true;
        for (const name of ['pick', 'sources', 'scenarios', 'settings']) {
          document.getElementById(`panel-${name}`).classList.toggle('hidden', name !== 'pick');
        }

        const textsOf = (selector) => [...root.querySelectorAll(selector)].map((n) => n.textContent.trim());
        const panelBox = document.querySelector('.app').getBoundingClientRect();
        const style = (node, property) => getComputedStyle(node)[property];

        const picker = root.querySelector('.segmented--values');
        const input = root.querySelector('.editor__input');
        const card = root.querySelector('.result, .probe-card, .fail-card');

        return {
          missingContract: probe.missingProbeContract(),
          rootText: root.innerText,
          bodyText: document.body.innerText,
          headings: textsOf('h2'),
          chips: [...root.querySelectorAll('.chip')].map((chip) => ({
            text: chip.textContent.trim(),
            cls: chip.className,
            linkState: chip.dataset.linkState === undefined ? null : chip.dataset.linkState
          })),
          cardState: card ? card.dataset.linkState || null : null,
          step: textsOf('.probe-step')[0] || null,
          count: textsOf('.probe-count')[0] || null,
          helps: textsOf('.help'),
          notes: textsOf('.editor__note'),
          failText: textsOf('.fail-card__text')[0] || null,
          affected: textsOf('.result__affected-text')[0] || null,
          source: textsOf('.result__source')[0] || null,
          fieldChip: textsOf('.chip--field')[0] || null,
          real: textsOf('.result__real')[0] || null,
          advanced: textsOf('.result__path'),
          spinners: root.querySelectorAll('.spinner').length,
          buttons: [...root.querySelectorAll('button')].map((button) => ({
            text: button.textContent.trim(),
            cls: button.className,
            disabled: button.disabled
          })),
          picker: picker
            ? {
                cols: Number(picker.style.getPropertyValue('--seg-cols')),
                rows: Number(picker.style.getPropertyValue('--seg-rows')),
                x: Number(picker.style.getPropertyValue('--seg-x')),
                y: Number(picker.style.getPropertyValue('--seg-y')),
                options: [...picker.querySelectorAll('.segmented__opt')].map((opt) => ({
                  label: opt.querySelector('label').textContent.trim(),
                  checked: opt.querySelector('input').checked,
                  font: style(opt.querySelector('label'), 'fontFamily'),
                  size: style(opt.querySelector('label'), 'fontSize')
                }))
              }
            : null,
          input: input ? { value: input.value, inputmode: input.getAttribute('inputmode') } : null,
          bool: root.querySelectorAll('.editor__bool').length,
          // §9.2's tooltips are up to 14rem wide and centred on their control; on a panel
          // this narrow that is how one ends up hanging off the edge.
          tips: [...root.querySelectorAll('.tip__bubble')].map((bubble) => {
            const box = bubble.getBoundingClientRect();
            return {
              text: bubble.textContent.trim(),
              overflows: box.right > panelBox.right + 0.5 || box.left < panelBox.left - 0.5
            };
          }),
          cards: [...root.querySelectorAll('.card')].map((node) => ({
            tag: node.tagName,
            chevrons: node.querySelectorAll('.card__chevron').length,
            cursor: style(node, 'cursor'),
            linkState: node.dataset.linkState || null
          }))
        };
      } finally {
        for (const [node, leaf, value] of saved) node[leaf] = value;
      }
    },
    [patch, swap, SENTINEL]
  );
}

/** The verified-chip invariant, read out of the page that was just rendered. */
async function honesty(page, expected, where) {
  assertVerifiedHonesty(await page.evaluate(readVerifiedChips, S.chips.verified), { expected, where });
}

const chromium = await loadChromium();

if (!chromium) {
  test('panel probe browser suite', { skip: 'Playwright is not installed — `npm i -D playwright && npx playwright install chromium` enables it.' }, () => {});
} else {
  test('the probe screens — PLAN.md §10.1 State D, its progress card and its failures', async (t) => {
    const { stage, check, timeline } = createFixture(t);

    let profile = null;
    let ctx = null;
    let worker = null;
    let panel = null;
    const panelErrors = [];

    try {
      profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mocklab-probe-'));
      ctx = await stage(
        'chromium launch + extension load',
        60000,
        () => launchExtension(chromium, profile),
        { absent: 'Chromium could not be launched' }
      );
      worker = await stage('service-worker registration', 20000, async () =>
        ctx.serviceWorkers()[0] || ctx.waitForEvent('serviceworker', { timeout: 20000 })
      );
      panel = await stage('panel page', 30000, async () => {
        const page = await ctx.newPage();
        page.on('pageerror', (err) => panelErrors.push(`pageerror: ${err.message}`));
        page.on('console', (msg) => msg.type() === 'error' && panelErrors.push(msg.text()));
        await page.setViewportSize({ width: WIDTH, height: 900 });
        await page.goto(`chrome-extension://${new URL(worker.url()).host}/src/panel/panel.html`);
        // The panel boots against whatever tab it can see. Everything below renders from
        // an explicit state, so the only thing worth waiting for is that boot finished
        // and the four tab panels exist.
        await page.waitForSelector('#panel-pick');
        return page;
      });
      t.diagnostic(`fixture ready — ${timeline.join(', ')}`);
    } catch {
      // Every check below reports; the stage recorded which one died and why.
    }

    try {
      await check('the panel waits for exactly the contract it documents, and says so (§17.8, §1.1)', async () => {
        const idle = await renderProbe(panel, {});
        // Not an assertion about today. Either the contract is complete and the buttons
        // work, or it is not and every control that needs it is disabled with a reason.
        const REQUESTED = ['START_PROBE', 'CANCEL_PROBE', 'GET_PROBE', 'PROBE_CHANGED', 'PROBE_PHASE', 'PROBE_STEP', 'PROBE_FAIL'];
        for (const name of idle.missingContract) {
          assert.ok(REQUESTED.includes(name), `probe.js waits for ${name}, which is not in the contract it documents`);
        }
        t.diagnostic(`probe contract still missing from messages.js: ${JSON.stringify(idle.missingContract)}`);

        const ready = idle.missingContract.length === 0;
        const seen = await renderProbe(panel, {
          pick: {
            picking: false,
            element: { text: 'On time' },
            candidates: [{ sigId: 'sig-trip', path: '$.status', value: 'ON_TIME', score: 0.5 }],
            searched: { sources: 1, bounded: 0, complete: true }
          }
        });
        const cta = seen.buttons.find((button) => button.text === S.probe.cta);
        assert.ok(cta, '§11 probe.cta must be on screen once there is something to probe');
        assert.equal(cta.disabled, !ready, 'the button offers the experiment exactly when it can run it');
        // §11's intro promises a run that takes half a minute. Only say it if it can start.
        assert.equal(seen.rootText.includes(S.probe.intro), ready, 'do not describe a run that cannot start');
        if (!ready) assert.ok(seen.helps.includes(S.soon), 'a disabled hero button owes a reason and a next step');
      });

      await check('§10.1C the progress card says which step, how far, and how to stop', async () => {
        const seen = await renderProbe(panel, {
          probe: { view: 'running', step: 'testing', testing: 12, reload: { index: 4, estimate: 8 } }
        });
        assert.equal(seen.step, S.probe.step.testing(12), '§11 probe.step.testing names the step');
        assert.equal(seen.count, S.probe.reloads(4, 8), '§11 probe.reloads is the counter');
        assert.ok(seen.rootText.includes(S.probe.intro), "the standing rule — don't click inside the page — stays on screen");
        assert.equal(seen.spinners, 1, '§10.1C: the DGA radial spinner');

        const stop = seen.buttons.find((button) => button.text === S.probe.cancel);
        assert.ok(stop, '§11 probe.cancel must be reachable at any moment (§7.1: the user can cancel any time)');
        assert.equal(stop.disabled, false, 'the way out of a run is never disabled');
        assert.ok(stop.cls.includes('btn--danger'), '§10.1C: a Cancel in danger colours');

        // "full-panel": the card REPLACES the tab, so none of State A/C is behind it.
        assert.equal(seen.rootText.includes(S.pick.title), false, 'the progress card is the whole screen');
        assert.equal(seen.rootText.includes(S.pick.cta), false);
        await honesty(panel, 0, 'the progress card');
      });

      await check('§10.1C every state change updates the line, and each line is §11’s', async () => {
        // The instruction this card exists to satisfy: "NEVER let the user think it's
        // stuck: every state change updates the line." Mechanically — four distinct
        // steps, four distinct sentences, none of them written here.
        const lines = [];
        for (const [step, expected] of [
          ['control', S.probe.step.control],
          ['testing', S.probe.step.testing(12)],
          ['confirming', S.probe.step.confirming],
          ['cleanup', S.probe.step.cleanup]
        ]) {
          const seen = await renderProbe(panel, { probe: { view: 'running', step, testing: 12, reload: null } });
          assert.equal(seen.step, expected, `§11 probe.step.${step}`);
          lines.push(seen.step);
        }
        assert.equal(new Set(lines).size, 4, 'four steps that read the same are one step with extra waiting');

        // …and each really comes from strings.js. Sentinelled one at a time, so a render
        // that printed a fixed sentence for every step would fail on three of the four.
        for (const key of ['control', 'testing', 'confirming', 'cleanup']) {
          const seen = await renderProbe(
            panel,
            { probe: { view: 'running', step: key, testing: 12, reload: null } },
            [`probe.step.${key}`]
          );
          assert.equal(seen.step, SENTINEL, `probe.step.${key} is printed from strings.js, not written into the card`);
        }

        // A step MockLab was not told about prints no sentence at all rather than a
        // guess — the spinner, the counter and the standing instruction still say the
        // run is alive.
        const unknown = await renderProbe(panel, { probe: { view: 'running', step: 'nonsense', reload: { index: 2, estimate: 8 } } });
        assert.equal(unknown.step, null, 'an unknown step invents nothing');
        assert.equal(unknown.count, S.probe.reloads(2, 8), 'and the card still shows it is moving');
      });

      await check('the spinner actually spins, and is visible on the surface it sits on', async () => {
        // It could not, until M4: the gradient was centred on the shape it filled, which
        // is radially symmetric, so `spin 1s linear infinite` painted the identical frame
        // forever — on the one screen whose rule is "never let the user think it's stuck".
        //
        // The first version of this check screenshotted the ring at two animation times
        // and required the pixels to differ. THAT WAS NOT A CHECK: putting the old
        // centred gradient back left it green. Two reasons, and the second is the one
        // that matters — the card's own 300 ms entrance was still running, and once that
        // was pushed to its end, Skia STILL rasterises a rotated gradient a little
        // differently at 90° than at 0°. A pixel diff cannot tell "it turns" from "it was
        // resampled", so it is not the observable.
        //
        // What makes a rotation visible is that the paint VARIES around the ring, so that
        // is what is measured: the gradient offset at twelve points on the circumference,
        // in the element's own coordinates.
        await renderProbe(panel, { probe: { view: 'running', step: 'control', reload: null } });
        const spin = await panel.evaluate(() => {
          const svg = document.querySelector('.probe-card .spinner');
          const gradient = svg.querySelector('radialGradient');
          const ring = svg.querySelector('circle');
          const box = ring.getBBox();            // objectBoundingBox units resolve against this
          const gx = box.x + Number(gradient.getAttribute('cx')) * box.width;
          const gy = box.y + Number(gradient.getAttribute('cy')) * box.height;
          const gr = Number(gradient.getAttribute('r')) * box.width;
          const cx = Number(ring.getAttribute('cx'));
          const cy = Number(ring.getAttribute('cy'));
          const radius = Number(ring.getAttribute('r'));
          const offsets = [];
          for (let step = 0; step < 12; step += 1) {
            const angle = (step / 12) * Math.PI * 2;
            const px = cx + radius * Math.cos(angle);
            const py = cy + radius * Math.sin(angle);
            offsets.push(Math.hypot(px - gx, py - gy) / gr);
          }
          const stops = [...gradient.querySelectorAll('stop')].map((stop) => ({
            offset: Number(stop.getAttribute('offset')),
            opacity: Number(getComputedStyle(stop).stopOpacity),
            colour: getComputedStyle(stop).stopColor
          }));
          const style = getComputedStyle(svg);
          const host = document.querySelector('.probe-card__spin');
          return {
            spread: Math.max(...offsets) - Math.min(...offsets),
            covered: offsets.some((value) => value > stops[0].offset && value < stops[1].offset),
            stops,
            animation: style.animationName,
            iterations: style.animationIterationCount,
            ink: getComputedStyle(host).color,
            card: getComputedStyle(host.closest('.probe-card')).backgroundColor
          };
        });

        assert.ok(
          spin.spread > 0.3,
          `the gradient paints the ring at offsets spanning only ${spin.spread.toFixed(3)} — a ring painted the ` +
            'same all the way round looks identical at every angle, so rotating it is invisible'
        );
        assert.ok(spin.covered, 'and the varying part has to fall BETWEEN the two stops, or it is flat again');
        assert.notEqual(spin.stops[0].opacity, spin.stops[1].opacity, 'the two stops differ, or there is nothing to vary');
        assert.equal(spin.animation, 'spin', '§9.2: `spin 1s linear infinite`');
        assert.equal(spin.iterations, 'infinite');

        // And it paints in something other than the card it is on: `currentColor`, which
        // used to be pinned to white and vanished on every surface but a blue button.
        assert.notEqual(spin.ink, spin.card, 'the spinner is painted in the colour of the card behind it');
        assert.equal(spin.stops[0].colour, spin.ink, 'the ring takes the colour of whatever it is placed in');
      });

      /* ───────────────────────────────── §10.1D — the result, and who may wear the chip */

      await check('§10.1D State D names the source, the field, and the value editor', async () => {
        const seen = await renderProbe(panel, { probe: { view: 'result', binding: link('verified'), real: 'ON_TIME' } });

        assert.ok(seen.headings.includes(S.probe.found), '§11 probe.found heads a proved result');
        assert.equal(seen.source, 'Trip', '§10.1D: the friendly source name §10.2 already uses');
        assert.equal(seen.fieldChip, 'status', 'the field, in the site’s own words');
        assert.deepEqual(seen.advanced, [], '§1.2: the raw path is Advanced-mode only');
        assert.equal(seen.real, S.editor.original('ON_TIME'), '§11 editor.original shows what is really there');
        assert.equal(seen.affected, S.probe.affected(2), '§10.1D: how many places this change reaches');
        assert.ok(seen.rootText.includes(S.probe.showMe), '§11 probe.showMe is offered');
        assert.ok(
          seen.buttons.some((button) => button.text === S.probe.showMe && !button.disabled),
          '§10.3 — "Show me" is live at M5; a disabled one was M4 saying the overlays did not exist yet'
        );
        assert.ok(seen.buttons.some((b) => b.text === S.editor.apply && !b.disabled), '§11 editor.apply is the primary action');
        assert.deepEqual(seen.notes, [], 'a proved link has nothing to disclaim');

        // §10.1D: "if observedValues ≥ 2 → segmented value picker of those values +
        // Custom…". The DGA segmented control, not a second vocabulary for the same job.
        assert.deepEqual(
          seen.picker.options.map((option) => option.label),
          ['ON_TIME', 'DELAYED', 'CANCELLED', S.editor.custom]
        );
        assert.deepEqual(seen.picker.options.map((option) => option.checked), [true, false, false, false]);
        assert.ok(seen.picker.options[0].font.includes('Fira Code'), '§9.1: a value is monospaced');
        assert.equal(
          new Set(seen.picker.options.map((option) => option.size)).size,
          1,
          'one type size across the control — "Custom…" set two sizes apart from the values it sits beside'
        );

        const withPath = await renderProbe(panel, {
          settings: { advancedMode: true },
          probe: { view: 'result', binding: link('verified'), real: 'ON_TIME' }
        });
        assert.deepEqual(withPath.advanced, [S.glyph.joinLabel(S.advanced.path, '$.status')], '§10.1D: Advanced shows the raw path');

        await honesty(panel, 1, 'State D on a proved link');
      });

      await check('§1.1 a proved Link whose source stopped loading is Stale, not "Found it"', async () => {
        // The state no demo fixture can reach. §14's demo always serves both its sources,
        // so every fixture in this repository draws a proved Link with its data present —
        // and a mutation that deleted the whole stale downgrade from State D was SILENT
        // across all four panel suites until this check existed. It is reached the way a
        // real site reaches it: the page loads, and the request behind the field does not.
        const state = { captured: true, sources: [{ sigId: 'sig-other', name: 'Something else' }] };
        const gone = await renderProbe(panel, {
          ...state,
          probe: { view: 'result', binding: link('verified'), real: 'ON_TIME' }
        });
        assert.equal(gone.cardState, 'stale', 'the card carries the state it was drawn from');
        assert.deepEqual(gone.chips.map((chip) => chip.text), [S.chips.stale, 'status']);
        assert.equal(gone.headings.includes(S.probe.found), false, `"${S.probe.found}" is a claim MockLab can no longer stand behind`);
        assert.ok(gone.headings.includes(S.editor.title), 'the editor still opens — the Change still applies (§10.2)');
        assert.deepEqual(gone.notes, [S.highlight.stale], "§11's sentence for a proof that has gone stale");
        assert.equal(gone.affected, S.probe.affected(2), 'the count was a real measurement of a real experiment, and stays');
        await honesty(panel, 0, 'a proved link whose source stopped loading');

        // The other direction, ONE source apart: the same link, same card, data present.
        const here = await renderProbe(panel, {
          captured: true,
          sources: [{ sigId: 'sig-trip', name: 'Trip' }],
          probe: { view: 'result', binding: link('verified'), real: 'ON_TIME' }
        });
        assert.equal(here.cardState, 'verified');
        assert.ok(here.headings.includes(S.probe.found));
        assert.deepEqual(here.notes, []);
        await honesty(panel, 1, 'the same link with its data present');

        // §10.1A's Recent links list draws the same downgrade, from the same function.
        const recent = await renderProbe(panel, { ...state, bindings: [link('verified')], probe: null });
        assert.deepEqual(recent.chips.map((chip) => chip.text), [S.chips.stale]);
        assert.deepEqual(recent.cards.map((card) => card.linkState), ['stale']);
        await honesty(panel, 0, "§10.1A's Recent links after the source stopped loading");
      });

      await check('§10.3 "Show me" asks the page for this exact field, and nothing else', async () => {
        // `panel.links.test.js` proves what `showOnPage` does with each of the three
        // answers it can get. What only a browser can prove is the WIRING: that the
        // button §10.1D draws is connected to it, and carries the link it sits under —
        // a "Show me" that highlights a different field is a lie told in overlays.
        const asked = await panel.evaluate(
          async ([binding]) => {
            const { renderResult } = await import('/src/panel/result.js');
            const root = document.getElementById('panel-pick');
            const sent = [];
            const ctx = {
              state: {
                tabId: 7,
                sources: [{ sigId: 'sig-trip', name: 'Trip' }],
                settings: { advancedMode: false },
                bindings: [],
                lostLinks: new Set(),
                canHighlight: true,
                probe: { view: 'result', binding, real: 'ON_TIME', affected: 0, draft: null }
              },
              send: async (type, payload) => {
                sent.push({ type, payload });
                return { ok: true, elements: 2, verified: true };
              },
              toast: () => {},
              refresh: async () => {},
              rerender: () => {}
            };
            root.replaceChildren();
            renderResult(root, ctx);
            const button = [...root.querySelectorAll('.result__affected button')][0];
            button.click();
            await new Promise((resolve) => setTimeout(resolve, 30));
            return { sent, disabled: button.disabled };
          },
          [link('verified')]
        );
        assert.equal(asked.disabled, false);
        assert.equal(asked.sent.length, 1, 'one press, one request');
        assert.deepEqual(asked.sent[0].payload, { tabId: 7, sigId: 'sig-trip', path: '$.status' });
        assert.equal(typeof asked.sent[0].type, 'string');
        assert.ok(asked.sent[0].type.length > 0, '§17.8 — a declared constant, not `undefined`');
      });

      await check('§17.12 the verified chip may describe ONLY a verified link', async () => {
        // The assertion this replaces said "Verified ✓" appeared nowhere in the panel,
        // which stopped being true the moment a probe could confirm something. This is
        // the statement that was always meant, and it is mutation-proved: rendering the
        // chip for a candidate link fails `assertVerifiedHonesty`, and so does widening
        // §10.1A's filter past `=== 'verified'`.
        const proved = await renderProbe(panel, { probe: { view: 'result', binding: link('verified'), real: 'ON_TIME' } });
        assert.deepEqual(proved.chips.map((chip) => chip.text), [S.chips.verified, 'status']);
        assert.equal(proved.cardState, 'verified');
        assert.ok(proved.chips[0].cls.split(/\s+/).includes('chip--verified'), '§10.6: and the colour that goes with the word');
        await honesty(panel, 1, 'a proved link');

        for (const state of ['candidate', 'stale']) {
          const seen = await renderProbe(panel, { probe: { view: 'result', binding: link(state), real: 'ON_TIME' } });
          // Same screen, same data, one field different — and everything that CLAIMS
          // changes with it.
          assert.equal(seen.bodyText.includes(S.chips.verified), false, `a ${state} link must not wear the verified chip`);
          assert.equal(seen.chips[0].text, S.chips[state], `§10.6: its own word from the four-word vocabulary`);
          // …and its own colour. A candidate chip painted with the verified green is a
          // quieter version of the same lie: §10.6's four chips are told apart by colour
          // first and read second.
          assert.ok(
            seen.chips[0].cls.split(/\s+/).includes(`chip--${state}`),
            `a ${state} link is painted ${JSON.stringify(seen.chips[0].cls)} — the word and the colour come from one datum or neither is trustworthy`
          );
          assert.equal(seen.chips[0].linkState, state);
          assert.equal(seen.cardState, state);
          assert.equal(seen.headings.includes(S.probe.found), false, `"${S.probe.found}" is a claim only a probe may make`);
          assert.ok(seen.headings.includes(S.editor.title), 'the editor still opens — a Change applies either way (§10.2)');
          // Two different facts, two different sentences. A link that was NEVER proved
          // gets §11's `editor.unverified` ("MockLab hasn't proven which elements it
          // affects"); a link that WAS proved and can no longer be stood behind gets the
          // one for that (§1.1's third state). Reusing `unverified` for both would tell a
          // person their proof never happened, which is a different — and false — thing.
          const note = state === 'stale' ? S.highlight.stale : S.editor.unverified;
          assert.deepEqual(seen.notes, [note], `§11's sentence for a ${state} link`);
          assert.notEqual(S.highlight.stale, S.editor.unverified, 'the two states must not share a sentence');
          assert.equal(seen.affected, null, 'nothing proved which elements it drives, so no count is offered');
          await honesty(panel, 0, `State D on a ${state} link`);
        }
      });

      await check('the chip’s word comes from the link’s own state, not from the call site (§17.6)', async () => {
        // A render that hardcoded `S.chips.verified` would print the VERIFIED sentinel on
        // a candidate card. Each state is swapped alone, so only the right one can match.
        const proved = await renderProbe(panel, { probe: { view: 'result', binding: link('verified'), real: 'ON_TIME' } }, ['chips.verified']);
        assert.equal(proved.chips[0].text, SENTINEL, 'the verified chip prints S.chips.verified');

        const guess = await renderProbe(panel, { probe: { view: 'result', binding: link('candidate'), real: 'ON_TIME' } }, ['chips.verified']);
        assert.equal(guess.chips[0].text, S.chips.candidate, 'a candidate link prints the candidate word');
        assert.equal(guess.rootText.includes(SENTINEL), false, 'and never reaches for the verified one');

        const swapped = await renderProbe(panel, { probe: { view: 'result', binding: link('candidate'), real: 'ON_TIME' } }, ['chips.candidate']);
        assert.equal(swapped.chips[0].text, SENTINEL, 'the candidate chip prints S.chips.candidate');
      });

      await check('§10.1D the value editor matches the value it is editing', async () => {
        // Fewer than two observed values: §10.1D falls back to a typed input.
        const one = await renderProbe(panel, {
          probe: { view: 'result', binding: link('verified', { observedValues: ['ON_TIME'] }), real: 'ON_TIME' }
        });
        assert.equal(one.picker, null, 'one known value is not a choice');
        assert.equal(one.input.value, 'ON_TIME', 'the box opens on what is really there, so one character can be changed');
        assert.equal(one.input.inputmode, 'text');

        const number = await renderProbe(panel, {
          probe: { view: 'result', binding: link('verified', { path: '$.price.total', observedValues: [450] }), real: 450 }
        });
        assert.equal(number.input.inputmode, 'decimal', '§10.1D: a number gets a number keyboard');
        assert.equal(number.fieldChip, S.glyph.joinDot('price', 'total'), 'a nested field reads out in the site’s own words');

        const flag = await renderProbe(panel, {
          probe: { view: 'result', binding: link('verified', { path: '$.refundable', observedValues: [true] }), real: true }
        });
        assert.equal(flag.bool, 1, '§10.1D: a true/false value gets a toggle, not a text box');

        // "Custom…" opens the typed box beside the picker rather than replacing it.
        await renderProbe(panel, { probe: { view: 'result', binding: link('verified'), real: 'ON_TIME' } });
        // The label, not the input: §9.2's segmented control hides its radios behind the
        // labels (opacity 0), which is how the sliding thumb can be the only thing that
        // moves. A human clicks the word.
        await panel.click('.segmented--values .segmented__opt:last-child label');
        const custom = await panel.evaluate(() => ({
          picker: Boolean(document.querySelector('.segmented--values')),
          input: Boolean(document.querySelector('.editor__input')),
          checked: document.querySelector('.segmented--values .segmented__opt:last-child input').checked
        }));
        assert.deepEqual(custom, { picker: true, input: true, checked: true }, '"Custom…" reveals a box and stays selected');
      });

      /* ─────────────────────────────────────── the failures, which matter more (§10.1D) */

      await check('§10.1D each failure says what MockLab actually established', async () => {
        for (const [failure, sentence] of [
          ['noneConfirmed', S.probe.noneConfirmed],
          ['tooNoisy', S.probe.tooNoisy],
          ['elementLost', S.probe.elementLost],
          ['timeout', S.probe.timeout],
          ['notRefetched', S.probe.notRefetched]
        ]) {
          const seen = await renderProbe(panel, { probe: { view: 'failed', failure } });
          assert.equal(seen.failText, sentence, `§11 probe.${failure}`);
          assert.equal(seen.headings.includes(S.probe.found), false, 'a failed run found nothing');
          // §11 always says what to do next; picking again is what exists.
          assert.ok(seen.buttons.some((button) => button.text === S.pick.cta), 'a failure leaves the person somewhere to go');
          await honesty(panel, 0, `the ${failure} card`);

          // §6.3's "Check all fields (slower)" is offered for the one failure it answers.
          const offered = seen.buttons.some((button) => button.text === S.pick.checkAll);
          assert.equal(
            offered,
            failure === 'noneConfirmed',
            `"${S.pick.checkAll}" answers a ranked list that confirmed nothing, and nothing else here — ` +
              'a noisy element, a lost one or a timeout is not a problem of having looked at too few fields'
          );
        }

        // Each sentence really comes from strings.js.
        for (const failure of ['noneConfirmed', 'tooNoisy', 'elementLost']) {
          const seen = await renderProbe(panel, { probe: { view: 'failed', failure } }, [`probe.${failure}`]);
          assert.equal(seen.failText, SENTINEL, `probe.${failure} is printed from strings.js`);
        }

        // §6.3's ending, which is not one of §7's: the run never started because value
        // matching produced nothing to test. §11 already wrote that sentence, in `pick`,
        // and it is the second place "Check all fields" is the real next step.
        const empty = await renderProbe(panel, { probe: { view: 'failed', failure: 'noCandidates' } });
        assert.equal(empty.failText, S.pick.noCandidates, '§6.3: tell the user honestly');
        assert.ok(empty.buttons.some((button) => button.text === S.pick.checkAll), '§6.3 offers the exhaustive pass');

        // A failure MockLab cannot name is still owed a word.
        const nameless = await renderProbe(panel, { probe: { view: 'failed', failure: '' } });
        assert.equal(nameless.failText, S.errors.pageBroke, 'silence is not an honest failure state');
      });

      /* ──────────────────────────────────────────── §10.1A — the door into State D */

      await check('§10.1A a proved Link opens the editor, and only a proved Link is listed', async () => {
        const proved = link('verified');
        const seen = await renderProbe(panel, { bindings: [proved] });
        assert.ok(seen.rootText.includes(S.pick.recent), '§11 pick.recent heads the list');
        assert.equal(seen.cards.length, 1);
        assert.equal(seen.cards[0].tag, 'BUTTON', 'the card opens something, so it must be reachable by keyboard');
        assert.equal(seen.cards[0].chevrons, 1, '§10.1A ends the card with a chevron, now that State D exists (Deviation 29)');
        assert.equal(seen.cards[0].linkState, 'verified');
        await honesty(panel, 1, '§10.1A Recent links');

        // The chevron is a promise. Press it.
        await panel.click('#panel-pick .card--link');
        const opened = await panel.evaluate(() => ({
          heading: document.querySelector('#panel-pick .result h2') ? document.querySelector('#panel-pick .result h2').textContent : null,
          picker: Boolean(document.querySelector('#panel-pick .segmented--values'))
        }));
        assert.equal(opened.heading, S.probe.found, 'the card opens State D on the Link it describes');
        assert.equal(opened.picker, true, 'with the value editor for its observed values');

        const unproven = await renderProbe(panel, { bindings: [link('candidate'), link('stale')] });
        assert.equal(unproven.cards.length, 0, '§10.1A lists proved Links and nothing else');
        assert.equal(unproven.rootText.includes(S.pick.recent), false, 'no list, so no heading over it');
        await honesty(panel, 0, '§10.1A with nothing proved');
      });

      /* ────────────────────────────────────────────────────── how it is all painted */

      await check('no tooltip on these screens hangs off the panel (§9.2)', async () => {
        for (const width of [320, WIDTH, 420]) {
          await panel.setViewportSize({ width, height: 900 });
          const seen = await renderProbe(panel, { probe: { view: 'result', binding: link('verified'), real: 'ON_TIME', applied: true } });
          const escaped = seen.tips.filter((tip) => tip.overflows).map((tip) => tip.text);
          assert.deepEqual(escaped, [], `at ${width}px a tooltip is rendered outside the panel and cannot be read`);
          assert.ok(seen.tips.length > 0, 'the disabled controls on this card still explain themselves');
        }
        await panel.setViewportSize({ width: WIDTH, height: 900 });
      });

      await check('every filled button meets WCAG 2.2 AA in both themes (§16 M7)', async () => {
        // The chips were measured at M3 and tuned; the BUTTONS were not. White on §9.1's
        // dark --accent (#4A90FF) measures 3.12:1 at 14px/600 — on "Apply & refresh page",
        // the button this product exists to have someone press.
        for (const scheme of ['light', 'dark']) {
          await panel.emulateMedia({ colorScheme: scheme });
          await renderProbe(panel, { probe: { view: 'result', binding: link('verified'), real: 'ON_TIME' } });
          const measured = await panel.evaluate(() => {
            const parse = (value) => {
              const n = value.match(/[\d.]+/g).map(Number);
              const scale = value.startsWith('color(') ? 255 : 1;
              return [n[0] * scale, n[1] * scale, n[2] * scale, n.length > 3 ? n[3] : 1];
            };
            const channel = (c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : Math.pow((c / 255 + 0.055) / 1.055, 2.4));
            const lum = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
            const flatten = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
            const page = parse(getComputedStyle(document.body).backgroundColor);
            const ratio = (node, behind) => {
              const style = getComputedStyle(node);
              const bg = flatten(parse(style.backgroundColor), behind || page);
              const fg = flatten(parse(style.color), [...bg, 1]);
              const a = lum(fg);
              const b = lum(bg);
              return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
            };
            const out = {};
            const primary = document.querySelector('#panel-pick .btn--primary');
            if (primary) out.primary = ratio(primary);
            // The picked segment is painted over the control's sliding thumb, which is a
            // ::before and therefore invisible to a walk up the DOM — so the surface is
            // named rather than discovered.
            const chosen = document.querySelector('.segmented--values .segmented__opt input:checked ~ label');
            const thumb = parse(getComputedStyle(document.querySelector('.segmented--values'), '::before').backgroundColor);
            if (chosen) out.chosenValue = ratio(chosen, flatten(thumb, page));
            const toast = document.createElement('div');
            toast.className = 'toast toast--danger';
            document.body.append(toast);
            out.dangerToast = ratio(toast);
            toast.remove();
            return out;
          });
          for (const [what, value] of Object.entries(measured)) {
            assert.ok(value >= 4.5, `${scheme}: ${what} is ${value}:1, below WCAG 2.2 AA 1.4.3 (4.5:1)`);
          }
          t.diagnostic(`${scheme}: ${JSON.stringify(measured)}`);

          /* AND THE SAME BUTTON WITH A POINTER ON IT, which is a different measurement
           * and the one the M7 token change is actually about.
           *
           * §9.2's primary button paints a "white 135° gradient sheen" over its fill on
           * hover. With the dark theme's label inked dark (M7), a WHITE sheen lifts the
           * surface toward the label and takes the ratio back down — the resting figure
           * above would stay green while the state a person is in at the moment they
           * press the button failed. So the sheen follows the label's own ink, and the
           * worst pixel under the label — the gradient's first stop, flattened over the
           * hover fill — is measured rather than reasoned about. */
          await panel.hover('#panel-pick .btn--primary');
          // The sheen fades in over --transition-rule (250ms). Waited for rather than
          // slept through: a fixed sleep here would go stale the day that token changes,
          // and reading mid-fade measures a surface nobody is ever looking at.
          await panel.waitForFunction(
            () => Number(getComputedStyle(document.querySelector('#panel-pick .btn--primary'), '::before').opacity) === 1,
            null,
            { timeout: 4000 }
          );
          const hovered = await panel.evaluate(() => {
            const parse = (value) => {
              const n = value.match(/[\d.]+/g).map(Number);
              const scale = value.startsWith('color(') ? 255 : 1;
              return [n[0] * scale, n[1] * scale, n[2] * scale, n.length > 3 ? n[3] : 1];
            };
            const channel = (c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : Math.pow((c / 255 + 0.055) / 1.055, 2.4));
            const lum = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
            const flatten = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
            const page = parse(getComputedStyle(document.body).backgroundColor);
            const button = document.querySelector('#panel-pick .btn--primary');
            const style = getComputedStyle(button);
            const sheen = getComputedStyle(button, '::before');
            // The sheen only counts if it is actually painted; a `0` opacity here would
            // mean this measurement is of the resting button under another name.
            const shown = Number(sheen.opacity);
            const stop = (sheen.backgroundImage.match(/(?:rgba?|color)\([^)]*\)/g) || [])[0];
            const fill = flatten(parse(style.backgroundColor), page);
            const over = stop ? flatten(parse(stop), [...fill, 1]) : fill;
            const fg = flatten(parse(style.color), [...over, 1]);
            const a = lum(fg);
            const b = lum(over);
            return { shown, worstPixel: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100 };
          });
          assert.equal(hovered.shown, 1, `${scheme}: the sheen is not painted on hover, so this measures nothing`);
          assert.ok(
            hovered.worstPixel >= 4.5,
            `${scheme}: the label over the hover sheen is ${hovered.worstPixel}:1, below WCAG 2.2 AA 1.4.3 (4.5:1)`
          );
          t.diagnostic(`${scheme}: primary hovered ${hovered.worstPixel}:1 under the sheen`);
          await panel.mouse.move(0, 0);
        }
        await panel.emulateMedia({ colorScheme: 'light' });
      });

      await check('§16 M7 prefers-reduced-motion stills the spring and the pop', async () => {
        await panel.emulateMedia({ reducedMotion: 'reduce' });
        await renderProbe(panel, { probe: { view: 'result', binding: link('verified'), real: 'ON_TIME' } });
        const still = await panel.evaluate(() => {
          const durations = (selector) => {
            const node = document.querySelector(selector);
            return node ? getComputedStyle(node).animationDuration : null;
          };
          return {
            chip: durations('.chip--verified'),
            card: durations('.result'),
            /* The spring thumb, measured WHERE IT LIVES. This read the CONTAINER, which
             * declares no transition in either mode — so the figure was '0s' at rest and
             * '0.001s' under the sweep, and either way it said nothing about the thumb.
             * It was also never asserted, in the subtest named for stilling the spring.
             * The thumb is `.segmented::before`. */
            thumbTransition: getComputedStyle(document.querySelector('.segmented--values'), '::before').transitionDuration,
            // The spinner is the exception on purpose: a still spinner over a page that
            // is genuinely reloading is the "is it stuck?" lie reduced motion cannot buy.
            spinner: (() => {
              const node = document.querySelector('.spinner');
              return node ? getComputedStyle(node).animationDuration : null;
            })()
          };
        });
        assert.equal(still.chip, '0.001s', 'the chip pop is stilled');
        assert.equal(still.card, '0.001s', 'so is the card entrance');
        // §16 M7 names the spring, so it is turned OFF rather than shortened, and the
        // sentence is literally true of the thing it names.
        assert.equal(still.thumbTransition, '0s', 'the segmented thumb still springs under prefers-reduced-motion');
        assert.notEqual(still.spinner, '0s', 'a still spinner over a reloading page is the "is it stuck?" lie');
        await panel.emulateMedia({ reducedMotion: 'no-preference' });
      });

      await check('the panel logged nothing to the console the whole way through', () => {
        assert.deepEqual(panelErrors, []);
      });
    } finally {
      if (ctx) await ctx.close().catch(() => {});
      if (profile) fs.rmSync(profile, { recursive: true, force: true });
    }
  });
}
