/**
 * The probe protocol against the REAL demo site, in real Chromium, through the real
 * unpacked extension (PLAN.md §7; §16 M4's three definitions of done).
 *
 * OWNER: probe-engineer.
 *
 * `probe.test.js` drives the same state machine against a fake page, which is what
 * makes each outcome cheap to reproduce. It cannot prove the thing this file is for:
 * that a real page, reloading itself six times, settles when `agent.js` says it has;
 * that §6.2's fingerprint really finds the same pill on the next load; that the demo's
 * rotating tip really lands in the noise mask; and that a run leaves the site exactly
 * as it found it. Every one of those is browser behaviour, and none of it is visible to
 * a unit test.
 *
 * The §16 M4 DoD, asserted here in order:
 *   1. probing the demo pill yields a VERIFIED binding for `$.status` in ≤ 8 reloads,
 *      and `elements[]` holds both the pill and the derived banner;
 *   2. the rotating-tip box lands in the noise mask — probing a candidate that matches
 *      its text gives an honest `tooNoisy`, not a false positive;
 *   3. cancelling mid-probe leaves the site clean: 0 probe changes in storage.
 *
 * And one journey that is not in the DoD but is the one M4 is FOR, added after QA
 * reproduced it broken: change a value from the tree, watch the page change, then ask
 * MockLab to prove which field did it. Everything about that journey happens on a page
 * rendered from a body no capture holds, which is the seam `effectiveBody.js` exists for.
 *
 * Skips (never fails) when Playwright or a Chromium build is unavailable, and skips as
 * REPORTED checks: `stage()` and `check()` keep this suite's contribution to `# tests`
 * constant whether it passes, skips or breaks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MSG, PROBE_MSG, PROBE_PHASE, PROBE_FAIL } from '../src/background/messages.js';
import { loadChromium, launchExtension, createFixture, recordWorkerErrors } from '../testlib/browserFixture.js';

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chromium = await loadChromium();

if (!chromium) {
  test('probe browser suite', { skip: 'Playwright is not installed — `npm i -D playwright && npx playwright install chromium` enables it.' }, () => {});
} else {
  test('the MockLab probe in real Chromium', async (t) => {
    const { stage, optional, check, timeline } = createFixture(t);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mocklab-probe-'));

    let ctx = null;
    let sw = null;
    let panel = null;
    let demo = { value: null, why: null };
    let swErrors = null;
    try {
      demo = await optional('demo server', 10000, async () => {
        const { createServer } = await import('../../companion/src/index.js');
        const server = createServer();
        return { server, origin: `http://127.0.0.1:${await listen(server)}` };
      });

      ctx = await stage(
        'chromium launch + extension load', 60000,
        () => launchExtension(chromium, profile),
        { absent: 'Chromium could not be launched' }
      );
      sw = await stage('service-worker registration', 20000, async () =>
        ready(ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 20000 }))));
      swErrors = await stage('service-worker error recorder', 10000, () => recordWorkerErrors(ctx, sw));

      panel = await stage('panel page', 30000, async () => {
        const page = await ctx.newPage();
        await page.goto(sw.url().split('/src/')[0] + '/src/panel/panel.html');
        return page;
      });
      t.diagnostic(`fixture ready — ${timeline.join(', ')}`);
    } catch {
      // The stage that failed already recorded whether this was an absent browser
      // (skip) or a broken fixture (fail), and named itself either way.
    }

    const demoSite = demo.value;

    const send = (type, payload) =>
      panel.evaluate(([t2, p]) => chrome.runtime.sendMessage({ type: t2, payload: p }), [type, payload]);

    const tabIdOf = async (page) => {
      const url = page.url().split('#')[0];
      const ids = await sw.evaluate(async (u) => {
        const tabs = await chrome.tabs.query({});
        return tabs.filter((tab) => tab.url.split('#')[0] === u).map((tab) => tab.id);
      }, url);
      assert.equal(ids.length, 1, `exactly one tab is at ${url} (found ${ids.length})`);
      return ids[0];
    };

    /** Every Change in storage, as the §17.5 sweep sees them. */
    const storedChanges = () =>
      sw.evaluate(async () => {
        const all = await chrome.storage.local.get(null);
        return Object.entries(all)
          .filter(([key]) => key.startsWith('changes:'))
          .flatMap(([, list]) => (Array.isArray(list) ? list : []));
      });

    const probeChanges = async () => (await storedChanges()).filter((change) => change.probe === true);

    /** Every proved link on every origin, as `path@sigId`. */
    const verifiedLinks = async () => {
      const all = await sw.evaluate(async () => {
        const bag = await chrome.storage.local.get(null);
        return Object.entries(bag)
          .filter(([key]) => key.startsWith('bindings:'))
          .flatMap(([, list]) => (Array.isArray(list) ? list : []));
      });
      return all.filter((b) => b.state === 'verified').map((b) => `${b.path}@${b.sigId}`).sort();
    };

    /**
     * A freshly launched worker answers `evaluate` before its `chrome` namespaces are
     * there, which reads as a defect two hundred lines away from the wait that was
     * missing. Ask it something harmless until it can answer.
     */
    async function ready(worker, budgetMs = 15000) {
      const deadline = Date.now() + budgetMs;
      for (;;) {
        try {
          if (await worker.evaluate(() => Boolean(globalThis.chrome && chrome.storage))) return worker;
        } catch {
          /* not up yet */
        }
        assert.ok(Date.now() < deadline, 'the service worker never became evaluable');
        await sleep(100);
      }
    }

    async function pick(page, selector) {
      const tabId = await tabIdOf(page);
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const sources = await send(MSG.LIST_SOURCES, { tabId });
        if (sources && sources.sources.length >= 2) break;
        await sleep(50);
      }
      assert.deepEqual(await send(MSG.START_PICK, { tabId }), { ok: true, tabId });
      const rect = await page.evaluate((sel) => document.querySelector(sel).getBoundingClientRect().toJSON(), selector);
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
      await sleep(120);
      await page.mouse.down();
      await page.mouse.up();
      const until = Date.now() + 8000;
      while (Date.now() < until) {
        const state = await send(MSG.GET_PICK, { tabId });
        if (state && state.phase === 'picked') return { tabId, pick: state };
        await sleep(50);
      }
      assert.fail(`the pick on ${selector} never came back`);
    }

    /** Poll the panel's own message until the run is over. */
    async function awaitProbe(tabId, budgetMs = 90000) {
      const deadline = Date.now() + budgetMs;
      let last = null;
      while (Date.now() < deadline) {
        last = await send(PROBE_MSG.GET_PROBE, { tabId });
        if (last && last.phase !== PROBE_PHASE.RUNNING) return last;
        await sleep(150);
      }
      assert.fail(`the probe never finished — ${JSON.stringify(last)}`);
    }

    const pillText = (page) => page.evaluate(() => document.getElementById('status-pill').textContent);

    try {
      /* ═════════════════════════════ §16 M4 DoD 1 — the demo pill, proved ══════════ */
      await check('§16 M4 DoD — the demo pill is proved to be driven by `$.status`', async (tt) => {
        if (!demoSite) { tt.skip(`the companion demo site is not available: ${demo.why}`); return; }
        const page = await ctx.newPage();
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(String(e)));
        await page.goto(demoSite.origin + '/demo/?case=probe-pill', { waitUntil: 'load' });

        const { tabId, pick: picked } = await pick(page, '#status-pill');
        assert.ok(picked.candidates.some((c) => c.path === '$.status'), '§6.3 offered it first');

        const started = Date.now();
        assert.deepEqual(await send(PROBE_MSG.START_PROBE, { tabId }), { ok: true, tabId });

        // While it runs the panel has something true to draw at every moment (§10.1C).
        const running = await send(PROBE_MSG.GET_PROBE, { tabId });
        assert.equal(running.phase, PROBE_PHASE.RUNNING);
        assert.ok(['control', 'testing'].includes(running.step), `step ${running.step}`);

        const view = await awaitProbe(tabId);
        t.diagnostic(
          `probe finished in ${Date.now() - started} ms, ${view.reload.index} reloads ` +
            `(estimate ~${view.reload.estimate}), ${view.unsettledLoads} load(s) hit the settle cap`
        );

        assert.equal(view.phase, PROBE_PHASE.DONE, `probe failed: ${view.failure} ${view.detail || ''}`);
        assert.equal(view.binding.path, '$.status', 'the field the site really reads');
        assert.equal(view.binding.state, 'verified');
        assert.equal(view.value, 'ON_TIME', 'and State D shows the REAL value, not a probe value');

        // DoD: "elements[] contains BOTH the pill and the derived banner". The demo's
        // status dot comes with them: it has no text at all, so §7.6's sample cannot see
        // it and only §7.2's region around the pill can. Nothing else is claimed — not
        // the boxes that merely contain the pill, and not the tip box the mask removed.
        const found = view.binding.elements.map((fp) => fp.css).sort();
        assert.deepEqual(found, ['#alert-banner', '#status-dot', '#status-pill'],
          `the pill, the banner and the dot it drives, and nothing else — got ${JSON.stringify(found)}`);
        assert.equal(view.affected, 3);

        // DoD: "in ≤ 8 reloads".
        assert.ok(view.reload.index <= 8, `${view.reload.index} reloads, §16 M4 allows 8`);

        // §7.1 CLEANUP: the site is exactly as it was found.
        assert.deepEqual(await probeChanges(), [], '0 probe changes in storage');
        assert.equal(await pillText(page), 'On time', 'and the page is back on the real data');
        assert.deepEqual(pageErrors, [], 'the demo console stays clean through six reloads');
        await page.close();
      });

      /* ═════════════════ the journey M4 is for: change it, then prove it ══════════ */
      await check('a value the person already changed is found AND proved', async (tt) => {
        if (!demoSite) { tt.skip(`the companion demo site is not available: ${demo.why}`); return; }
        const page = await ctx.newPage();
        await page.goto(demoSite.origin + '/demo/?case=probe-changed', { waitUntil: 'load' });
        const tabId = await tabIdOf(page);
        // Whatever happens below, this tab's Changes must not survive into the checks
        // that follow — a failure here that also mocked the site would read as three.
        try {
        // Wait for the capture, then do exactly what QA did from the Sources tree.
        const until = Date.now() + 8000;
        while (Date.now() < until) {
          const sources = await send(MSG.LIST_SOURCES, { tabId });
          if (sources && sources.sources.length >= 2) break;
          await sleep(50);
        }
        const trip = (await send(MSG.LIST_SOURCES, { tabId })).sources.find((s2) => /trip/i.test(s2.url));
        assert.ok(trip, 'the demo trip source');
        // `refresh:false`: the worker's own reload would race the one below and abort it
        // (`net::ERR_ABORTED`, about one run in seven). One navigation, owned here.
        const set = await send(MSG.SET_VALUE, {
          tabId, sigId: trip.sigId, path: '$.status', value: 'DELAYED', refresh: false
        });
        assert.equal(set.ok, true);
        assert.equal(set.refreshed, false, 'so nothing else is navigating this tab');
        await page.reload({ waitUntil: 'load' });
        await sleep(500);
        assert.equal(await pillText(page), 'Delayed', 'the site rendered the new state');

        // §6.3 against the body the page ACTUALLY rendered from. The capture is still
        // ON_TIME — this used to answer `candidates: []`, which §11 renders as "MockLab
        // couldn't find this text in any data the page loaded", about data on screen.
        const picked = await pick(page, '#status-pill');
        const guess = picked.pick.candidates.find((c) => c.path === '$.status');
        assert.ok(guess, `\$.status must be offered — got ${
          JSON.stringify(picked.pick.candidates.map((c) => c.path))}`);
        assert.equal(picked.pick.searched.complete, true, 'and nothing about the search was bounded');

        // §7.4 against the same body: a probe value equal to the Change already in force
        // moves nothing, and the run would report `noneConfirmed` about the real driver.
        assert.deepEqual(await send(PROBE_MSG.START_PROBE, { tabId: picked.tabId }), { ok: true, tabId: picked.tabId });
        const view = await awaitProbe(picked.tabId);
        assert.equal(view.phase, PROBE_PHASE.DONE, `probe failed: ${view.failure} ${view.detail || ''}`);
        assert.equal(view.binding.path, '$.status');
        assert.equal(view.binding.state, 'verified');
        assert.equal(view.value, 'ON_TIME', '§10.1D still names the value the SITE serves');

        // §7.1 CLEANUP, with the person's own Change left exactly where they put it.
        assert.deepEqual(await probeChanges(), [], '0 probe changes in storage');
        const mine = (await storedChanges()).filter((c) => c.path === '$.status' && !c.probe);
        assert.equal(mine.length, 1, "the person's Change survived the probe");
        assert.equal(mine[0].value, 'DELAYED');
        await page.reload({ waitUntil: 'load' });
        await sleep(500);
        assert.equal(await pillText(page), 'Delayed', 'and the page is back where they left it');


        } finally {
          await send(MSG.RESET_SITE, { tabId, refresh: false }).catch(() => {});
          await page.close().catch(() => {});
        }
      });

      /* ═════════════════════════════ §16 M4 DoD 2 — the rotating tip box ══════════ */
      await check('§16 M4 DoD — the rotating tip box is refused, honestly', async (tt) => {
        if (!demoSite) { tt.skip(`the companion demo site is not available: ${demo.why}`); return; }
        const page = await ctx.newPage();
        await page.goto(demoSite.origin + '/demo/?case=probe-noise', { waitUntil: 'load' });

        // The box prints the gate number beside a tip that changes on every load, so a
        // value match really does offer a field for it — this is a probe with something
        // plausible to confirm, refused because the ELEMENT cannot be reasoned about.
        const { tabId, pick: picked } = await pick(page, '#tip-box');
        assert.ok(picked.candidates.length > 0, '§6.3 found something to try');
        assert.ok(picked.candidates.some((c) => c.path === '$.flight.gate'), 'including the gate it prints');

        // The set of proved links BEFORE this run. The pill check above earned one on
        // this origin, and `$.status` is among the tip box's own candidates, so a bare
        // "no verified binding anywhere" would only pass by accident of test order.
        const before = await verifiedLinks();
        assert.deepEqual(await send(PROBE_MSG.START_PROBE, { tabId }), { ok: true, tabId });
        const view = await awaitProbe(tabId);

        assert.equal(view.phase, PROBE_PHASE.FAILED);
        assert.equal(view.failure, PROBE_FAIL.TOO_NOISY, `got ${view.failure} — ${view.detail || ''}`);
        assert.equal(view.binding, null);
        assert.equal(view.reload.index, 2, 'the two control runs are enough to refuse it');

        assert.deepEqual(await verifiedLinks(), before,
          '§17.12: this run proved nothing, so the set of proved links is exactly what it was');
        assert.deepEqual(await probeChanges(), []);
        await page.close();
      });

      /* ═════════════════════════════ §16 M4 DoD 3 — cancel leaves it clean ════════ */
      await check('§16 M4 DoD — cancelling mid-probe leaves the site clean', async (tt) => {
        if (!demoSite) { tt.skip(`the companion demo site is not available: ${demo.why}`); return; }
        const page = await ctx.newPage();
        await page.goto(demoSite.origin + '/demo/?case=probe-cancel', { waitUntil: 'load' });
        const { tabId } = await pick(page, '#status-pill');
        await send(PROBE_MSG.START_PROBE, { tabId });

        // Wait until the site is really mocked — cancelling before anything was applied
        // would prove nothing about cleanup.
        const deadline = Date.now() + 30000;
        let applied = [];
        while (Date.now() < deadline) {
          applied = await probeChanges();
          if (applied.length) break;
          await sleep(50);
        }
        assert.ok(applied.length, 'the probe applied a Change to the site to cancel out of');
        assert.equal(applied[0].probe, true, 'flagged the way §17.5 requires');

        await send(PROBE_MSG.CANCEL_PROBE, { tabId });
        const view = await awaitProbe(tabId, 30000);
        assert.equal(view.failure, PROBE_FAIL.CANCELLED);

        assert.deepEqual(await probeChanges(), [], '§16 M4: 0 probe changes in storage');
        await page.reload({ waitUntil: 'load' });
        await sleep(400);
        assert.equal(await pillText(page), 'On time', 'and the site renders its own data again');
        assert.equal((await send(MSG.GET_SITE_STATE, { tabId })).changeCount, 0,
          'the badge count never counted the scaffolding');
        await page.close();
      });

      /* ═════════════════════════════ §17.5 — the half CLEANUP cannot reach ════════ */
      await check('§17.5 a probe Change does not survive a cold service-worker start', async () => {
        // A crash mid-probe leaves scaffolding behind with no run to clean up after it.
        // The guarantee is the sweep at `background.js`'s module top level — NOT the
        // `onStartup` listener, which does not fire after a crash — so this proves it
        // the only way that distinction is observable: plant, close the browser, and
        // reopen the same profile, which is a genuine cold worker on a warm store.
        //
        // `chrome.runtime.reload()` was tried first and is not usable here: with
        // `--load-extension` the extension does not come back, and every later
        // `chrome-extension://` navigation fails with ERR_BLOCKED_BY_CLIENT.
        await sw.evaluate(async () => {
          await chrome.storage.local.set({
            'changes:http://127.0.0.1:1': [
              { id: 'probe-1', origin: 'http://127.0.0.1:1', sigId: 'a', path: '$.x', value: 1, enabled: true, probe: true },
              { id: 'real-1', origin: 'http://127.0.0.1:1', sigId: 'a', path: '$.y', value: 2, enabled: true }
            ]
          });
        });
        assert.equal((await probeChanges()).length, 1, 'planted');

        // The record comes out of the outgoing worker while it can still be read; the
        // relaunch is this check's SUBJECT, so it moves across rather than starting over.
        await swErrors.handoff();
        await ctx.close();
        ctx = await launchExtension(chromium, profile);
        sw = await ready(ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 20000 })));
        await swErrors.rebind(ctx, sw);

        const deadline = Date.now() + 10000;
        let left = null;
        while (Date.now() < deadline) {
          left = await probeChanges();
          if (!left.length) break;
          await sleep(100);
        }
        assert.deepEqual(left, [], 'the probe Change is gone after a cold start');
        const survivors = (await storedChanges()).map((change) => change.id);
        assert.deepEqual(survivors, ['real-1'], "and the user's own Change survived");
      });

      await check('the service worker logged no errors during any of this', () =>
        swErrors.assertClean());
    } finally {
      if (ctx) await ctx.close().catch(() => {});
      if (demoSite) demoSite.server.close();
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });
}
