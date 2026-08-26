/**
 * Deep mode against a REAL page, in real Chromium, through the real unpacked extension
 * (PLAN.md §8; §16 M7).
 *
 * OWNER: probe-engineer.
 *
 * `deepMode.test.js` drives the same engine against a fake CDP, which is what makes each
 * outcome cheap to reproduce. It cannot prove the one claim deep mode exists to make,
 * because that claim is about a browser: **the site rendered a different state, from a
 * document MockLab rewrote in flight.** Nothing short of Chrome can say whether
 * `Fetch.fulfillRequest` produced a page that parses, hydrates and paints.
 *
 * The five things asserted here, in order, and why a unit test cannot reach them:
 *
 *   1. With deep mode OFF, `demo/ssr.html` yields NO sources at all. That is the honest
 *      failure §11's `pick.noCandidates` describes, and it is true of this page: it
 *      fetches nothing, so §5.1's patch has nothing to see. It is also the whole reason
 *      §8 exists — this is the page MV3 cannot otherwise touch.
 *   2. Turned on for the origin, the same page's embedded props appear as a source with
 *      `via: "document"` — §10.2's "Page's built-in data".
 *   3. Changing one field there and refreshing turns the pill red BECAUSE THE PAGE
 *      RE-RENDERED (§1.3). The server-printed line beside it still says "On time",
 *      which is the honest limit of a data rewrite, on screen.
 *   4. §5.1's in-page patch still works on the same origin while deep mode is on. This
 *      is DEVIATION 1 in `debuggerEngine.js` — the reason the Fetch patterns are
 *      Document-only rather than muting the interceptor — and if it ever stops being
 *      true, deep mode has broken every other feature on the site it is turned on for.
 *   5. Off again, and a different origin, and nothing is intercepted in either case.
 *   6. Interception starts at the NEXT load of a tab, never the first one — measured in
 *      Chromium, not assumed — and nothing claims otherwise in between.
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

import { MSG } from '../src/background/messages.js';
import { loadChromium, launchExtension, createFixture, recordWorkerErrors } from '../testlib/browserFixture.js';

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chromium = await loadChromium();

if (!chromium) {
  test('deep mode browser suite', { skip: 'Playwright is not installed — `npm i -D playwright && npx playwright install chromium` enables it.' }, () => {});
} else {
  test('deep mode in real Chromium', async (t) => {
    const { stage, optional, check, timeline } = createFixture(t);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mocklab-deep-'));

    let ctx = null;
    let sw = null;
    let panel = null;
    let swErrors = null;
    let demo = { value: null, why: null };
    try {
      demo = await optional('demo server', 10000, async () => {
        const { createServer } = await import('../../companion/src/index.js');
        const server = createServer();
        const port = await listen(server);
        // One server, two origins. `localhost` and `127.0.0.1` are different origins to
        // every part of this product, which is how check 5 tests "detach on navigation
        // to a different origin" without a second listener to keep alive.
        return { server, origin: `http://127.0.0.1:${port}`, other: `http://localhost:${port}` };
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

    const site = demo.value;

    /**
     * What the worker logs is recorded by `recordWorkerErrors` in `testlib/browserFixture.js`,
     * which is where this suite's own wrapper moved to. Playwright raises no console event
     * for an extension service worker in this Chromium — measured, not assumed — so every
     * suite that ended on `assert.deepEqual(swErrors, [])` was asserting that an
     * always-empty array is empty. That module's header carries the full measurement and
     * the two things the wrapper still cannot see.
     */

    const send = (type, payload) =>
      panel.evaluate(([t2, p]) => chrome.runtime.sendMessage({ type: t2, payload: p }), [type, payload]);

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

    const tabIdOf = async (page) => {
      const url = page.url().split('#')[0];
      const ids = await sw.evaluate(async (u) => {
        const tabs = await chrome.tabs.query({});
        return tabs.filter((tab) => tab.url.split('#')[0] === u).map((tab) => tab.id);
      }, url);
      assert.equal(ids.length, 1, `exactly one tab is at ${url} (found ${ids.length})`);
      return ids[0];
    };

    /** Sources for a tab, after giving the worker a moment to have any. */
    const sourcesFor = async (tabId, { want = 0, budgetMs = 6000 } = {}) => {
      const deadline = Date.now() + budgetMs;
      let answer = { sources: [] };
      for (;;) {
        answer = await send(MSG.LIST_SOURCES, { tabId });
        if ((answer.sources || []).length >= want || Date.now() > deadline) return answer.sources || [];
        await sleep(100);
      }
    };

    const deepMode = (...origins) => send(MSG.UPDATE_SETTINGS, { patch: { deepModeOrigins: origins } });

    /** What the card says, as a person reads it. */
    const card = (page) =>
      page.evaluate(() => ({
        pill: document.getElementById('status-pill').textContent.trim(),
        pillClass: document.getElementById('status-pill').className,
        banner: document.getElementById('alert-banner').textContent.trim(),
        printed: document.getElementById('printed-note').textContent.trim()
      }));

    try {
      /* ═══════════════ 1 — the page MV3 cannot touch, before deep mode ═════════════ */
      await check('§8 with deep mode off, the SSR page yields nothing — honestly', async (tt) => {
        if (!site) { tt.skip(`the companion demo site is not available: ${demo.why}`); return; }
        const page = await ctx.newPage();
        await page.goto(site.origin + '/demo/ssr.html', { waitUntil: 'load' });
        const tabId = await tabIdOf(page);

        assert.deepEqual(await sourcesFor(tabId, { budgetMs: 2500 }), [],
          'this page fetches nothing, so §11\'s "couldn\'t find this text in any data the page ' +
            'loaded" is TRUE of it — which is exactly the case §8 exists for');

        // It is nevertheless a fully rendered card: the data was in the document.
        assert.deepEqual(await card(page), {
          pill: 'On time',
          pillClass: '',
          banner: '',
          printed: 'Printed at booking · Gate A17 · On time'
        });
        await page.close();
      });

      /* ═══════════════ 2 and 3 — attached, read, and rewritten ═════════════════════ */
      await check('§8 deep mode turns the document into a source, and a Change into a red pill', async (tt) => {
        if (!site) { tt.skip(`the companion demo site is not available: ${demo.why}`); return; }
        const page = await ctx.newPage();
        await page.goto(site.origin + '/demo/ssr.html', { waitUntil: 'load' });
        const tabId = await tabIdOf(page);

        assert.deepEqual(await deepMode(site.origin), {
          ok: true,
          settings: { advancedMode: false, paranoid: false, deepModeOrigins: [site.origin], companionToken: null }
        }, '§10.5\'s checkbox needs no message type of its own — this is the settings surface it already has');

        // The attach happens on the storage write; the interception starts at the NEXT
        // navigation. That ordering is the product's too: a person turns deep mode on
        // and then presses "Apply & refresh page".
        await sleep(600);
        await page.reload({ waitUntil: 'load' });

        const sources = await sourcesFor(tabId, { want: 1 });
        assert.equal(sources.length, 1, 'one document, one block of built-in data');
        const source = sources[0];
        assert.equal(source.via, 'document', '§10.2 draws "Page\'s built-in data" from this');
        assert.match(source.sigId, /^__document__:[0-9a-f]{12}:__NEXT_DATA__$/, '§8\'s namespace');
        assert.ok(source.fields > 10, `the whole props tree is addressable (${source.fields} fields)`);

        const body = await send(MSG.GET_RESPONSE, { tabId, sigId: source.sigId });
        assert.equal(body.body.props.pageProps.trip.status, 'ON_TIME', 'the REAL value, §5.1.2');

        /* --- the claim: the SITE renders the new state (§1.3) --- */
        const applied = await send(MSG.SET_VALUE, {
          tabId,
          sigId: source.sigId,
          path: '$.props.pageProps.trip.status',
          value: 'CANCELLED',
          refresh: true
        });
        assert.equal(applied.ok, true);
        await page.waitForLoadState('load');
        await sleep(400);

        assert.deepEqual(await card(page), {
          pill: 'Cancelled',
          pillClass: 'is-cancelled',
          banner: 'Your flight was cancelled',
          // Server-printed text, re-rendered by nothing. MockLab changed the DATA, and
          // §11 promises only that the site received it — see documentData.js's header.
          printed: 'Printed at booking · Gate A17 · On time'
        }, 'the page\'s own code did this: MockLab never touches the DOM (§1.3)');

        // And MockLab's own record still says what the SERVER sent, marked as mocked.
        const after = (await sourcesFor(tabId, { want: 1 })).find((s) => s.sigId === source.sigId);
        assert.equal(after.mocked, true);
        assert.equal(after.changeDropped, false);
        const real = await send(MSG.GET_RESPONSE, { tabId, sigId: source.sigId });
        assert.equal(real.body.props.pageProps.trip.status, 'ON_TIME', '§5.1.2: the capture is the real one');

        await page.close();
      });

      /* ═══════════════ 4 — DEVIATION 1: the in-page patch is untouched ═════════════ */
      await check('the fetch-based demo still works on an origin deep mode is ON for', async (tt) => {
        if (!site) { tt.skip(`the companion demo site is not available: ${demo.why}`); return; }
        const page = await ctx.newPage();
        await page.goto(site.origin + '/demo/', { waitUntil: 'load' });
        const tabId = await tabIdOf(page);

        const sources = await sourcesFor(tabId, { want: 2 });
        const trip = sources.find((s) => s.via !== 'document' && s.url.endsWith('trip.json'));
        assert.ok(trip, `the fetch-captured source is still there (${sources.map((s) => s.via).join(', ')})`);

        const applied = await send(MSG.SET_VALUE, { tabId, sigId: trip.sigId, path: '$.status', value: 'DELAYED', refresh: true });
        assert.equal(applied.ok, true);
        await page.waitForLoadState('load');
        await sleep(500);

        const pill = await page.evaluate(() => document.getElementById('status-pill').textContent.trim());
        assert.equal(pill, 'Delayed',
          'DEVIATION 1: narrowing the Fetch patterns to Documents is what keeps §5.1\'s patch ' +
            'in charge of XHR and fetch. Muting it in deep mode would break this.');

        await send(MSG.RESET_SITE, { tabId, refresh: false });
        await page.close();
      });

      /* ═══════════════ 5 — off, and a different origin ═════════════════════════════ */
      await check('§8 detaches when the setting goes off, and never follows another origin', async (tt) => {
        if (!site) { tt.skip(`the companion demo site is not available: ${demo.why}`); return; }

        // A second origin, served by the same listener, while deep mode is on for the first.
        const elsewhere = await ctx.newPage();
        await elsewhere.goto(site.other + '/demo/ssr.html', { waitUntil: 'load' });
        await sleep(700);
        assert.deepEqual(await sourcesFor(await tabIdOf(elsewhere), { budgetMs: 2000 }), [],
          'the person turned deep mode on for ONE site; the debugging bar does not follow them');
        await elsewhere.close();

        // The SAME tab across the switch, deliberately. A fresh tab would prove nothing:
        // it has no remembered sources for the HELLO exception to have to drop.
        const page = await ctx.newPage();
        await page.goto(site.origin + '/demo/ssr.html', { waitUntil: 'load' });
        const tabId = await tabIdOf(page);
        // The second load is the first one deep mode can reach — see the check below.
        await page.reload({ waitUntil: 'load' });
        assert.equal((await sourcesFor(tabId, { want: 1 })).length, 1, 'still on, still read');

        assert.equal((await deepMode()).ok, true);
        await sleep(600);
        await page.reload({ waitUntil: 'load' });
        await sleep(400);

        assert.deepEqual(await sourcesFor(tabId, { budgetMs: 2500 }), [],
          'a source MockLab is no longer reading must not linger: a Change made on it ' +
            'would apply to nothing, silently');
        assert.equal((await card(page)).pill, 'On time',
          'and the Change is still in storage, so this proves the DOCUMENT is no longer rewritten');

        await send(MSG.RESET_SITE, { tabId, refresh: false });
        await page.close();
      });

      /* ═════════ when interception starts, said as it actually behaves ═══════════ */
      await check('§8 deep mode starts at the NEXT load of a tab, and claims nothing before it', async (tt) => {
        if (!site) { tt.skip(`the companion demo site is not available: ${demo.why}`); return; }

        // MEASURED, not assumed. `chrome.tabs.onUpdated` delivers `changeInfo.url` when a
        // navigation COMMITS, which is after the response has already arrived — traced in
        // Chromium at M7: the attach itself takes about 6 ms and still lands after the
        // document. So the FIRST load of a tab MockLab was not already attached to cannot
        // be rewritten, whatever the page does or how slowly the server answers.
        //
        // This is what the product does anyway (turn deep mode on, then "Apply & refresh
        // page"), and the honest half is that nothing claims otherwise in between: no
        // source appears, so no field is offered that could not have been changed.
        assert.equal((await deepMode(site.origin)).ok, true);
        await sleep(500);

        const page = await ctx.newPage();
        await page.goto(site.origin + '/demo/ssr.html', { waitUntil: 'load' });
        const tabId = await tabIdOf(page);
        assert.deepEqual(await sourcesFor(tabId, { budgetMs: 2000 }), [],
          'the first document of a brand-new tab is not intercepted — and is not reported');

        await page.reload({ waitUntil: 'load' });
        const after = await sourcesFor(tabId, { want: 1 });
        assert.equal(after.length, 1, 'and from the next load on, it is');
        assert.equal(after[0].via, 'document');

        await deepMode();
        await page.close();
      });

      await check('the service worker logged no errors during any of this', () =>
        swErrors.assertClean());
    } finally {
      if (ctx) await ctx.close().catch(() => {});
      if (site) site.server.close();
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });
}
