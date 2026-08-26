/**
 * The three controls that were stubs — driven as a person drives them, in real Chromium,
 * with the real unpacked extension and the real service worker behind them.
 *
 * OWNER: panel-designer. The eleventh browser suite, and it is in CI's `for suite in …`
 * loop in the same change that creates it — for the fourth time on this build, and this
 * time `panel.settings.test.js` CHECKS it rather than asking the next person to remember.
 *
 * ── Why these three are one file ────────────────────────────────────────────────────
 * They are one defect: a finished engine behind a control nobody could reach. Deep mode
 * has had a debugger engine, a document rewriter and seven passing tests since M7 while
 * §10.5 rendered its checkbox `disabled` with "still being built" beside it; §12.3's
 * pairing has worked end to end since M6 from a test and from nowhere else; §10.1D's
 * "Save as Scenario" was a dimmed ghost button over a `SAVE_PRESET` that works. Each is
 * a screen, so none of them can be checked without a browser, and all three share one
 * Chromium launch and one demo server here rather than three.
 *
 * ── What each check is really holding upright ───────────────────────────────────────
 *   • deep mode is PER ORIGIN (§4's `deepModeOrigins` is a list). The check reads what
 *     the real worker really STORED, so writing a boolean, or writing `[thisOrigin]` and
 *     dropping every other site, fails here even though both look perfect on screen.
 *   • nothing attaches before the person agrees. Ticking the box does not write; the
 *     answer to §11's `deep.confirm` does. Chrome's debugging bar is not dismissible
 *     without dismissing MockLab, so a warning that arrives after it is not a warning.
 *   • the dot follows the FACTS, not the click (§10.5, `GET_COMPANION`). A pairing that
 *     succeeds and leaves the dot grey, and a `COMPANION_CHANGED` the panel ignores, are
 *     both a confident wrong colour on screen, which is §1.1 in a small place.
 *   • "Save as Scenario" both switches tab AND opens the form. Opening it without the
 *     switch sets state on a `display:none` panel: a button that visibly does nothing.
 *
 * Every expected string comes from `../src/panel/strings.js`, so this file has no copy of
 * its own to drift (§17.6) — and `guards.strings.test.js` forbids any panel file from
 * holding a literal at a copy sink, so an assertion against `S.x` cannot be satisfied by
 * a sentence written into the render. Every check REPORTS (README Deviation 45).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { S } from '../src/panel/strings.js';
import { MSG, PAIR_FAIL } from '../src/background/messages.js';
import { createServer } from '../../companion/src/index.js';
import { loadChromium, launchExtension, createFixture } from '../testlib/browserFixture.js';

/** The panel is designed for 360–420px (§9.2). */
const WIDTH = 380;

/** An origin no test may disturb: it stands in for "another site the person enabled". */
const OTHER_SITE = 'https://another.test';

/* ─────────────────────────────────────────────────────────────────────── helpers */

/** Show one tab, and wait for it to be the one on screen. */
async function openTab(page, name) {
  await page.click(`label[for="tab-${name}"]`);
  await page.waitForFunction(
    (tab) => !document.getElementById(`panel-${tab}`).classList.contains('hidden'),
    name,
    { timeout: 5000 }
  );
}

/**
 * Click the deep-mode row the way a person does: on the DRAWN box.
 *
 * §9.2's checkbox recipe puts the real `<input>` at `opacity:0` under a `.check-box`
 * span, so the input itself is not clickable and Playwright rightly refuses to fake it —
 * the surface a pointer can reach is the span, and the label around both is what turns
 * one into the other. (The keyboard reaches the input directly; that is a separate check.)
 */
const clickDeep = (page) => page.click('input[data-focus="deep-mode"] + .check-box');

/** Leave §10.5 and come back, which is what makes the panel re-read the companion. */
async function reopenSettings(page) {
  await openTab(page, 'pick');
  await openTab(page, 'settings');
}

/**
 * Answer chosen message types in the PANEL, and pass everything else through to the real
 * worker.
 *
 * The companion is a socket to a process this suite does not run, so `connected` is false
 * for ever and `PAIR_COMPANION` can only ever be refused. Stubbing the two answers is the
 * only way to reach the states §10.5 is made of — but the stub is a passthrough, so every
 * OTHER message on this screen (the settings, the site state, the deep-mode write) still
 * goes to the real worker and is really stored. `mcp.browser.test.js` drives the same
 * pairing against a real hub from the other end; what cannot be checked there is what the
 * SCREEN then says, which is all this file asserts.
 */
async function installStub(page) {
  await page.evaluate(() => {
    if (window.__mlStub) return;
    const real = chrome.runtime.sendMessage.bind(chrome.runtime);
    const stub = { answers: {}, sent: [] };
    chrome.runtime.sendMessage = (message) => {
      stub.sent.push(message && message.type);
      const answer = stub.answers[message && message.type];
      if (answer === undefined) return real(message);
      return Promise.resolve(JSON.parse(JSON.stringify(answer)));
    };
    window.__mlStub = stub;
  });
}

const setAnswers = (page, map) => page.evaluate((given) => Object.assign(window.__mlStub.answers, given), map);
const clearSent = (page) => page.evaluate(() => (window.__mlStub.sent.length = 0));
const sentTypes = (page) => page.evaluate(() => window.__mlStub.sent.slice());

/** §4's settings, as the worker really holds them. */
const storedSettings = (worker) =>
  worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings || null);

/** Put one origin into `deepModeOrigins` behind the panel's back, so it has company. */
const seedOtherSite = (worker, other) =>
  worker.evaluate(async (origin) => {
    const bag = await chrome.storage.local.get('settings');
    const settings = bag.settings || {};
    await chrome.storage.local.set({ settings: { ...settings, deepModeOrigins: [origin] } });
  }, other);

/** Everything §10.5 is showing right now. */
function readSettings(page) {
  return page.evaluate(() => {
    const rows = document.getElementById('settings-rows');
    const comp = document.getElementById('settings-companion');
    const app = document.querySelector('.app').getBoundingClientRect();
    const overflows = (node) => {
      const box = node.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) return false;
      return box.right > app.right + 0.5 || box.left < app.left - 0.5;
    };
    const text = (node) => (node ? node.textContent.trim() : null);
    const deepBox = rows.querySelector('input[data-focus="deep-mode"]');
    const deepRow = deepBox ? deepBox.closest('.check-row') : null;
    const confirm = rows.querySelector('.deep-confirm');
    const dot = comp.querySelector('.dot');
    const form = comp.querySelector('.editor');
    const escaped = [...document.querySelectorAll('#settings-rows *, #settings-companion *')].filter(overflows);
    return {
      rowsText: rows.innerText,
      companionText: comp.innerText,
      deep: deepRow
        ? {
            checked: deepBox.checked,
            disabled: deepBox.disabled,
            label: text(deepRow.querySelector('.check-row__label')),
            helps: [...deepRow.querySelectorAll('.check-row__help')].map((n) => n.textContent.trim())
          }
        : null,
      confirm: confirm
        ? { text: text(confirm.querySelector('.help')), buttons: [...confirm.querySelectorAll('button')].map((b) => b.textContent.trim()) }
        : null,
      dotOn: dot ? dot.classList.contains('dot--on') : null,
      status: text(comp.querySelector('.check-row__label')),
      helps: [...comp.querySelectorAll('.check-row__help, .help')].map((n) => n.textContent.trim()),
      commands: [...comp.querySelectorAll('.cmd')].map((n) => n.textContent.trim()),
      form: form
        ? {
            title: text(form.querySelector('h3')),
            body: text(form.querySelector('.help')),
            label: text(form.querySelector('label[for="pair-code"]')),
            placeholder: form.querySelector('#pair-code').placeholder,
            error: text(form.querySelector('.editor__error'))
          }
        : null,
      buttons: [...comp.querySelectorAll('button')].map((b) => ({
        text: b.textContent.trim(),
        // Both spellings of inert are reported for the reason panel.scenarios gives: a
        // control inside a tooltip wears `aria-disabled` so its reason stays reachable.
        inert: b.disabled || b.getAttribute('aria-disabled') === 'true',
        focusable: !b.disabled
      })),
      escaped: escaped.map((n) => n.className || n.tagName),
      toast: text(document.querySelector('#toast-host .toast'))
    };
  });
}

/** Press Tab until `selector` has the focus. Reached by TABBING, never by `focus()`. */
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

const chromium = await loadChromium();

if (!chromium) {
  test('panel settings browser suite', {
    skip: 'Playwright is not installed — `npm i -D playwright && npx playwright install chromium` enables it.'
  }, () => {});
} else {
  test('deep mode, pairing and "Save as Scenario" — PLAN.md §10.5, §8, §12.3, §10.1D', async (t) => {
    const { stage, check, timeline } = createFixture(t);

    let server = null;
    let profile = null;
    let ctx = null;
    let worker = null;
    let demo = null;
    let panel = null;
    let demoOrigin = '';
    const panelErrors = [];

    try {
      server = createServer();
      const demoUrl = await stage('demo server', 10000, async () => {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', resolve);
        });
        demoOrigin = `http://127.0.0.1:${server.address().port}`;
        return `${demoOrigin}/demo/`;
      });

      profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mocklab-settings-'));
      ctx = await stage('chromium launch + extension load', 60000, () => launchExtension(chromium, profile), {
        absent: 'Chromium could not be launched'
      });
      worker = await stage('service-worker registration', 20000, async () =>
        ctx.serviceWorkers()[0] || ctx.waitForEvent('serviceworker', { timeout: 20000 })
      );
      demo = await stage('demo page', 30000, async () => {
        const page = await ctx.newPage();
        await page.goto(demoUrl, { waitUntil: 'load' });
        await page.waitForFunction(() => {
          const pill = document.getElementById('status-pill');
          return Boolean(pill && pill.textContent.trim() && pill.textContent.trim() !== '…');
        }, null, { timeout: 20000 });
        return page;
      });
      panel = await stage('panel page', 30000, async () => {
        const page = await ctx.newPage();
        page.on('pageerror', (err) => panelErrors.push(`pageerror: ${err.message}`));
        page.on('console', (msg) => msg.type() === 'error' && panelErrors.push(msg.text()));
        await page.setViewportSize({ width: WIDTH, height: 1000 });
        await page.goto(`chrome-extension://${new URL(worker.url()).host}/src/panel/panel.html`);
        await page.waitForSelector('#settings-rows', { state: 'attached' });
        return page;
      });
      await stage('the panel describes the demo tab', 20000, async () => {
        // The panel reads the ACTIVE tab, so the demo has to be in front — otherwise the
        // panel would be describing its own chrome-extension:// tab, which is exactly the
        // "no site here" case the second check puts in front of it deliberately.
        await demo.bringToFront();
        await panel.waitForFunction(
          (host) => {
            const named = document.querySelector('#sitebar .sitebar__host');
            return Boolean(named && named.textContent.includes(host));
          },
          '127.0.0.1',
          { timeout: 15000 }
        );
        await openTab(panel, 'settings');
      });
      t.diagnostic(`fixture ready — ${timeline.join(', ')}`);
    } catch {
      // Every check below reports; the stage recorded which one died and why.
    }

    try {
      /* ══════════════════════════ §8 — deep mode, per origin ══════════════════════ */

      await check('§8 the tick asks before anything attaches, and the answer is what writes', async () => {
        await seedOtherSite(worker, OTHER_SITE);
        await reopenSettings(panel);
        const before = await readSettings(panel);
        assert.ok(before.deep, 'the deep-mode row is not on screen at all');
        assert.equal(before.deep.disabled, false, 'a website is in front, so the row must be operable');
        assert.equal(before.deep.checked, false, 'deep mode is OFF by default for every site (§8)');
        assert.equal(before.confirm, null);

        // Tick it. Nothing may be written: Chrome's debugging bar cannot be dismissed
        // without dismissing MockLab, so the question comes first.
        await clickDeep(panel);
        await panel.waitForSelector('.deep-confirm', { timeout: 5000 });
        const asked = await readSettings(panel);
        assert.equal(asked.confirm.text, S.deep.confirm, '§11 says what the bar is before it appears');
        assert.ok(asked.confirm.buttons.includes(S.deep.turnOn), 'the confirm button must say what it does');
        assert.equal(asked.deep.checked, false, 'the tick goes back down: nothing is on yet, and the box may not claim it is');
        assert.deepEqual(
          (await storedSettings(worker)).deepModeOrigins,
          [OTHER_SITE],
          'ticking the box wrote to storage — the debugger would already be attached'
        );

        // Cancel: still nothing.
        await panel.click(`.deep-confirm .btn--ghost`);
        await panel.waitForFunction(() => !document.querySelector('.deep-confirm'), null, { timeout: 5000 });
        assert.deepEqual((await storedSettings(worker)).deepModeOrigins, [OTHER_SITE], 'Cancel must leave the site alone');
        assert.equal((await readSettings(panel)).deep.checked, false);
      });

      await check('§4 turning it on adds THIS origin to the list and keeps every other one', async () => {
        await clickDeep(panel);
        await panel.waitForSelector('.deep-confirm', { timeout: 5000 });
        await panel.click('.deep-confirm .btn--primary');
        await panel.waitForFunction(() => !document.querySelector('.deep-confirm'), null, { timeout: 5000 });

        const stored = await storedSettings(worker);
        // The whole point of this check: the mutation that writes a boolean, and the one
        // that writes `[thisOrigin]`, both draw a perfect checkbox and both are caught
        // here — by reading what the WORKER stored, not what the panel believes.
        assert.ok(Array.isArray(stored.deepModeOrigins), '§4 declares a list of origins, never a boolean');
        assert.ok(stored.deepModeOrigins.includes(demoOrigin), 'this site is not in the list, so nothing will attach');
        assert.ok(
          stored.deepModeOrigins.includes(OTHER_SITE),
          'turning deep mode on here silently turned it off for another site the person had enabled'
        );
        assert.equal(stored.deepModeOrigins.length, 2);

        const on = await readSettings(panel);
        assert.equal(on.deep.checked, true, 'the box reflects the stored list, so it cannot disagree with it');
        // §11 says what happens NEXT: the engine reads the document at its next load, so
        // "on" without "refresh the page" would promise the page already on screen.
        assert.equal(on.toast, S.deep.on);

        // …and off again, which must take only this one away. No confirmation for that
        // direction: nothing is being done TO the browser, something is being stopped.
        await panel.evaluate(() => document.getElementById('toast-host').replaceChildren());
        await clickDeep(panel);
        await panel.waitForFunction(
          (expected) => {
            const node = document.querySelector('#toast-host .toast');
            return Boolean(node) && node.textContent.trim() === expected;
          },
          S.deep.off,
          { timeout: 5000 }
        );
        const after = await storedSettings(worker);
        assert.deepEqual(after.deepModeOrigins, [OTHER_SITE], 'switching one site off must not empty the list');
        assert.equal((await readSettings(panel)).deep.checked, false);
      });

      await check('§1.1 on a tab that is not a website the row is off, and says why in words', async () => {
        // `chrome://` and a blank tab are where this control cannot mean anything: there
        // is no origin to put in §4's list and nothing for the debugger to attach to.
        const blank = await ctx.newPage();
        await blank.goto('about:blank');
        await blank.bringToFront();
        await panel.waitForFunction(
          (host) => {
            const named = document.querySelector('#sitebar .sitebar__host');
            return Boolean(named) && !named.textContent.includes(host);
          },
          '127.0.0.1',
          { timeout: 15000 }
        );
        await reopenSettings(panel);
        const seen = await readSettings(panel);
        assert.equal(seen.deep.disabled, true, 'there is nothing here to turn deep mode on FOR');
        assert.equal(seen.deep.checked, false);
        // Grey is not a sentence (§1.1). The reason is VISIBLE TEXT inside the row —
        // available to a pointer, a keyboard and a screen reader at once — and never a
        // tooltip, which `disabled` makes reachable by hovering and by nothing else.
        assert.ok(seen.deep.helps.includes(S.deep.noSite), `the row says: ${JSON.stringify(seen.deep.helps)}`);
        assert.equal(
          await panel.evaluate(() => Boolean(document.querySelector('#settings-rows .tip'))),
          false,
          'the reason must not be behind a tooltip on a disabled control'
        );

        await blank.close();
        await demo.bringToFront();
        await panel.waitForFunction(
          (host) => {
            const named = document.querySelector('#sitebar .sitebar__host');
            return Boolean(named && named.textContent.includes(host));
          },
          '127.0.0.1',
          { timeout: 15000 }
        );
        await reopenSettings(panel);
      });

      /* ═══════════════════════ §12.3 — pairing, from the panel ════════════════════ */

      await check('§10.5 an unpaired browser is offered the way in, and the form is §11 verbatim', async () => {
        await installStub(panel);
        await setAnswers(panel, { [MSG.GET_COMPANION]: { ok: true, connected: false, paired: false } });
        await reopenSettings(panel);

        const idle = await readSettings(panel);
        assert.equal(idle.status, S.companion.disconnected);
        assert.equal(idle.dotOn, false, 'nothing is connected, so nothing may be green');
        const setup = idle.buttons.find((b) => b.text === S.companion.setup);
        assert.ok(setup, '§10.5 asks for a "Set up AI access" control and there is none');
        assert.equal(setup.inert, false, 'the pairing flow exists — this button may not be a stub any more');

        await panel.click(`#settings-companion button`);
        await panel.waitForSelector('#pair-code', { timeout: 5000 });
        const form = await readSettings(panel);
        // All four §11 strings the copy table ships for this screen, on the screen.
        assert.equal(form.form.title, S.companion.pairTitle);
        assert.equal(form.form.body, S.companion.pairBody);
        assert.equal(form.form.placeholder, S.companion.pairPlaceholder);
        assert.equal(form.form.label, S.companion.pairPlaceholder, 'a placeholder is gone the moment someone types');
        // §10.5's "one copy-paste command" — and it is the one that always prints a code.
        // `companion/src/index.js` opens a pairing window on `--pair` or on a machine's
        // first run only, so the plain command sends a returning person to a terminal to
        // read a number that is not there.
        assert.deepEqual(form.commands, [S.companion.command]);
        assert.ok(form.commands[0].includes('--pair'), 'this command must be the one that prints a code');
        // MockLab is not published to npm, so what is shown is the command's NAME and the
        // note beside it is the part that is actually actionable on a downloaded copy.
        // Wherever a command is drawn, that sentence is drawn with it (`companion.js`).
        assert.ok(form.helps.includes(S.companion.commandNote), `the section says: ${JSON.stringify(form.helps)}`);
      });

      await check('§12.3 a code that cannot be right never reaches the companion', async () => {
        await clearSent(panel);
        await panel.fill('#pair-code', '1234');
        await panel.click('#settings-companion .btn--primary');
        await panel.waitForSelector('.editor__error', { timeout: 5000 });
        const seen = await readSettings(panel);
        assert.equal(seen.form.error, S.companion.codeFormat);
        // §12.3 closes the window after five wrong codes. Spending one of them on four
        // digits would make the person restart the companion for a typo.
        assert.equal(
          (await sentTypes(panel)).includes(MSG.PAIR_COMPANION),
          false,
          'a four-digit code was sent at the companion and cost one of §12.3’s five attempts'
        );
      });

      await check('§11 each of the two refusals says its own thing, and neither guesses', async () => {
        for (const [reason, sentence] of [
          [PAIR_FAIL.REFUSED, S.companion.pairRefused],
          [PAIR_FAIL.NO_COMPANION, S.companion.pairNoCompanion]
        ]) {
          await setAnswers(panel, { [MSG.PAIR_COMPANION]: { ok: false, reason } });
          await panel.fill('#pair-code', '123456');
          await panel.click('#settings-companion .btn--primary');
          await panel.waitForFunction(
            (expected) => {
              const node = document.querySelector('#settings-companion .editor__error');
              return Boolean(node) && node.textContent.trim() === expected;
            },
            sentence,
            { timeout: 5000 }
          );
          const seen = await readSettings(panel);
          assert.equal(seen.form.error, sentence, `${reason} showed the wrong sentence`);
          assert.equal(seen.dotOn, false, 'a refused pairing must not light the dot');
          assert.ok(seen.form, 'the form stays open: the person has something to do here');
        }
      });

      await check('§10.5 a pairing that succeeds moves the dot, because the panel re-reads', async () => {
        // The mutation this exists for: pair, store the token, and leave the dot grey
        // because the screen followed its own click instead of asking again.
        await setAnswers(panel, {
          [MSG.PAIR_COMPANION]: { ok: true },
          [MSG.GET_COMPANION]: { ok: true, connected: true, paired: true }
        });
        await panel.fill('#pair-code', '123456');
        await panel.click('#settings-companion .btn--primary');
        await panel.waitForFunction(() => !document.querySelector('#pair-code'), null, { timeout: 5000 });

        const seen = await readSettings(panel);
        assert.equal(seen.toast, S.companion.paired, '§11 has one sentence for this moment');
        assert.equal(seen.status, S.companion.connected);
        assert.equal(seen.dotOn, true, 'paired and connected, and the dot did not follow');
        assert.equal(seen.form, null, 'the form is finished with');
        assert.equal(
          seen.buttons.some((b) => b.text === S.companion.setup),
          false,
          'a connected browser is not offered a set-up it has completed'
        );
      });

      await check('§10.5 COMPANION_CHANGED is heard, and paired-but-not-running is not an error', async () => {
        // The broadcast is data-free by design: the panel re-reads. A panel that ignores
        // it keeps a confident wrong colour on screen for as long as it is open — the
        // companion is stopped, killed or crashed and §10.5 still says "Connected".
        await setAnswers(panel, { [MSG.GET_COMPANION]: { ok: true, connected: false, paired: true } });
        await worker.evaluate((type) => chrome.runtime.sendMessage({ type }).catch(() => {}), MSG.COMPANION_CHANGED);
        await panel.waitForFunction(
          (expected) => {
            const label = document.querySelector('#settings-companion .check-row__label');
            return Boolean(label) && label.textContent.trim() === expected;
          },
          S.companion.idle,
          { timeout: 5000 }
        );

        const seen = await readSettings(panel);
        assert.equal(seen.dotOn, false, 'no socket is open, so the dot is not green');
        assert.equal(seen.status, S.companion.idle);
        assert.notEqual(seen.status, S.companion.disconnected, 'this browser IS set up — saying otherwise sends it through pairing again');
        assert.ok(seen.helps.includes(S.companion.idleHelp), `the section says: ${JSON.stringify(seen.helps)}`);
        // The command shown here is the plain one: this browser needs the companion
        // STARTED, not another pairing window.
        assert.deepEqual(seen.commands, [S.companion.start]);
        assert.equal(seen.commands[0].includes('--pair'), false);
        assert.ok(seen.helps.includes(S.companion.commandNote), 'the command is shown here too, so its note is owed here too');
      });

      /* ══════════════════ the new controls, without a mouse and in both themes ════ */

      await check('§16 M7 every new control is keyboard-reachable, and nothing overflows', async () => {
        await setAnswers(panel, { [MSG.GET_COMPANION]: { ok: true, connected: false, paired: false } });
        await reopenSettings(panel);
        await panel.click('#settings-companion button');
        await panel.waitForSelector('#pair-code', { timeout: 5000 });

        assert.equal(await tabTo(panel, 'input[data-focus="deep-mode"]'), true, 'the deep-mode box is mouse-only');
        assert.equal(await tabTo(panel, '#pair-code'), true, 'the pairing code box is mouse-only');
        assert.equal(await tabTo(panel, '.cmd__copy'), true, 'the copy-command button is mouse-only');

        for (const scheme of ['light', 'dark']) {
          await panel.emulateMedia({ colorScheme: scheme });
          for (const dir of ['ltr', 'rtl']) {
            await panel.evaluate((value) => document.documentElement.setAttribute('dir', value), dir);
            for (const width of [320, WIDTH, 420]) {
              await panel.setViewportSize({ width, height: 1000 });
              const seen = await readSettings(panel);
              assert.deepEqual(seen.escaped, [], `at ${width}px, ${scheme}, ${dir} something is drawn outside the panel`);
            }
          }
        }
        await panel.evaluate((value) => document.documentElement.setAttribute('dir', value), S.meta.dir);
        await panel.emulateMedia({ colorScheme: 'light' });
        await panel.setViewportSize({ width: WIDTH, height: 1000 });
      });

      /* ════════════════════════ §10.1D — "Save as Scenario" ═══════════════════════ */

      await check('§10.1D "Save as Scenario" switches to the tab AND opens the form there', async () => {
        /* State D after an apply cannot be reached in this fixture without running a real
         * probe, so the STATE is simulated and everything else — the modules, the real
         * markup, the real stylesheet, the real tab strip — is not. `setTab` here does
         * exactly what panel.js's does, and the check is that `result.js` ASKS for it:
         * without the call the Scenarios panel keeps its `.hidden` and the form is opened
         * on a screen nobody is looking at. */
        const seen = await panel.evaluate(async (label) => {
          const pick = await import('/src/panel/pick.js');
          const scenarios = await import('/src/panel/scenarios.js');
          const root = document.getElementById('panel-pick');
          const binding = {
            id: 'b1',
            sigId: 'sig-trip',
            path: '$.status',
            elements: [],
            state: 'candidate',
            observedValues: ['ON_TIME'],
            probeMode: 'refresh'
          };
          const ctx = {
            state: {
              tabId: 1,
              origin: 'http://127.0.0.1',
              sources: [{ sigId: 'sig-trip', name: 'Trip' }],
              changeCount: 1,
              settings: { advancedMode: false },
              bindings: [],
              lostLinks: new Set(),
              canHighlight: true,
              pick: { picking: false, element: null, candidates: [] },
              scenarios: { ready: true, presets: [], form: null, menu: null, confirm: null, error: '', busy: false },
              probe: { view: 'result', binding, real: 'ON_TIME', applied: true, draft: null }
            },
            send: async () => ({ ok: true }),
            toast: () => {},
            refresh: async () => {},
            rerender: () => {
              if (ctx.state.tab === 'scenarios') scenarios.renderScenariosTab(document.getElementById('scenario-body'), ctx);
              else pick.renderPickTab(root, ctx);
            },
            setTab: (name) => {
              ctx.state.tab = name;
              document.getElementById(`tab-${name}`).checked = true;
              for (const each of ['pick', 'sources', 'scenarios', 'settings']) {
                document.getElementById(`panel-${each}`).classList.toggle('hidden', each !== name);
              }
              ctx.rerender();
            }
          };
          ctx.setTab('pick');

          const before = {
            button: [...root.querySelectorAll('button')].map((b) => b.textContent.trim()),
            inert: [...root.querySelectorAll('button')]
              .filter((b) => b.disabled || b.getAttribute('aria-disabled') === 'true')
              .map((b) => b.textContent.trim())
          };
          const target = [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
          if (!target) return { before, clicked: null, scenariosShown: false, pickShown: true, form: false, namePrompt: null };
          target.click();
          return {
            before,
            clicked: target.textContent.trim(),
            scenariosShown: !document.getElementById('panel-scenarios').classList.contains('hidden'),
            pickShown: !document.getElementById('panel-pick').classList.contains('hidden'),
            form: Boolean(document.getElementById('scenario-name')),
            namePrompt: document.querySelector('#scenario-body .editor h2')
              ? document.querySelector('#scenario-body .editor h2').textContent.trim()
              : null
          };
        }, S.editor.saveScenario);

        assert.ok(seen.before.button.includes(S.editor.saveScenario), '§10.1D asks for this control at the applied moment');
        assert.equal(seen.before.inert.includes(S.editor.saveScenario), false, 'it is not a stub any more');
        assert.equal(seen.clicked, S.editor.saveScenario, 'the check clicked the wrong control');
        assert.equal(seen.scenariosShown, true, 'the form was opened on a tab nobody is looking at');
        assert.equal(seen.pickShown, false);
        assert.equal(seen.form, true, '§10.4’s name form is what "Save as Scenario" opens');
        assert.equal(seen.namePrompt, S.scenarios.namePrompt);
      });

      await check('the panel logged no error while any of that happened', () => {
        assert.deepEqual(panelErrors, []);
      });
    } finally {
      if (ctx) await ctx.close().catch(() => {});
      if (server) await new Promise((resolve) => server.close(resolve));
      if (profile) fs.rmSync(profile, { recursive: true, force: true });
    }
  });
}
