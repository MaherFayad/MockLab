/**
 * End-to-end tests against the REAL unpacked extension in real Chromium.
 *
 * OWNER: interceptor-engineer. Added at M1 — an additive deviation from PLAN.md §2.1's
 * file tree (README "Deviations" 15), because the three defects that hurt most in M1
 * were all invisible to unit tests: a streaming response that froze the page, a
 * compiled match entry that could not match its own URL, and a stream MockLab never
 * released. Each of those is asserted here against the genuine service worker and the
 * genuine MAIN-world patch, so they cannot come back quietly.
 *
 * What a browser suite SHARES — the Chromium lookup, the extension launch line and the
 * stage/check machinery — lives in `../testlib/browserFixture.js`. `node --test` treats
 * EVERY .js file under `test/` as a test file, so a helper module in this directory
 * would be executed as one; `testlib` is outside that glob. The fixtures below are this
 * suite's own: the hostile little server, and the bodies it serves.
 *
 * Skips (never fails) when Playwright or a Chromium build is unavailable, so
 * `npm test -ws` stays green on a machine that only has Node — and skips as REPORTED
 * checks, so this suite's contribution to `# tests` is the same number whether it
 * passes, skips or breaks (README Deviation 45).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// This file runs in Node, which HAS a module graph — unlike the two content scripts,
// whose mirrored constants are a genuine necessity (§17.2). Nothing here needs to
// duplicate the contract, so nothing here does: these are the real constants the
// service worker answers to, and a rename in messages.js breaks this suite loudly.
import { MSG } from '../src/background/messages.js';
import { EXTENSION_DIR, loadChromium, launchExtension, createFixture } from '../testlib/browserFixture.js';

/**
 * In-page read deadlines for a capture-only body, mirrored from interceptor.js. The
 * endless fixture below serves text/plain, so the shorter of the two governs it.
 */
const CAPTURE_READ_TIMEOUT_OTHER_MS = 1500;

/** Hostile-but-legal query shapes. Every one must round-trip: signature -> match -> apply. */
const SHAPES = [
  'q=a%26b',                          // encoded & inside a kept value
  'q=a%3Db',                          // encoded = inside a kept value
  'q=%D9%85%D8%AF%D9%8A%D9%86%D8%A9', // unicode value
  'q=hello+world',                    // + means space
  'tag=red&tag=blue',                 // repeated param name
  'empty=&b=2',                       // empty value
  'star=%2A',                         // a value that IS "*" — a literal, not a wildcard
  'filters=17%7C1~17~1*80%7C0',       // pipes and an embedded literal *
  'path=%2Fa%2Fb%2Fc',                // encoded slashes
  'hotelId=44212114&cb=RANDOM'        // starred value + a dropped cache-buster
];

/* ------------------------------------------------------------------ fixtures */

/**
 * A response shaped like the ones this fix is about: wider than §5.4's default 5000-path
 * ceiling AND deeper than its default depth of 12 — and deeper than the 24 candidate
 * discovery searches to (Deviation 32), so a count that merely matched the search would
 * still be wrong here.
 *
 * `DEEP_FIELDS` is stated, not computed by the code under test: 6000 scalars in `rows`,
 * one `level` at each of 30 nesting levels, and the leaf at the bottom of them.
 */
const DEEP_LEVELS = 30;
const DEEP_FIELDS = 6000 + DEEP_LEVELS + 1;
/** `$.tree.next…next.bottom` — the deepest field, 32 levels down. */
const DEEP_LEAF_PATH = '$.tree' + '.next'.repeat(DEEP_LEVELS) + '.bottom';

function deepBody() {
  let node = { bottom: 'LEAF-AT-THE-BOTTOM' };
  for (let i = DEEP_LEVELS; i > 0; i -= 1) node = { level: i, next: node };
  return { rows: Array.from({ length: 6000 }, (_, i) => i), tree: node };
}

/** Tracks whether the endless response's socket is still open (the D8 leak probe). */
const endless = { closedAt: null, startedAt: null };

function fixtureHandler(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (code, type, body) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };

  if (url.pathname === '/streams') {
    send(200, 'text/html; charset=utf-8', `<!doctype html><title>streams</title><body><pre id="out">…</pre><script>
      window.__r = { rejections: [] };
      addEventListener('unhandledrejection', (e) => window.__r.rejections.push(String(e.reason)));
      (async () => {
        const t0 = performance.now();
        const r = await fetch('/sse');
        window.__r.sseHeaders = performance.now() - t0;
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        window.__r.sseFirst = dec.decode((await reader.read()).value).trim();
        window.__r.sseFirstAt = performance.now() - t0;
        window.__r.sseSecond = dec.decode((await reader.read()).value).trim();
        document.getElementById('out').textContent = window.__r.sseFirst;
        reader.cancel();
      })().catch((e) => { window.__r.sseError = String(e); });
      (async () => {
        const t0 = performance.now();
        await fetch('/rsc');
        window.__r.rscHeaders = performance.now() - t0;
      })().catch((e) => { window.__r.rscError = String(e); });
      (async () => {
        const t0 = performance.now();
        const r = await fetch('/slow-body');
        window.__r.slowHeaders = performance.now() - t0;
        window.__r.slowBody = (await r.json()).label;
        window.__r.slowBodyAt = performance.now() - t0;
      })().catch((e) => { window.__r.slowError = String(e); });
      (async () => {
        const r = await fetch('/endless');
        const reader = r.body.getReader();
        await reader.read();
        await reader.cancel();          // the page lets go after one chunk
        window.__r.endlessReleased = true;
      })().catch((e) => { window.__r.endlessError = String(e); });
    </script></body>`);
    return;
  }

  if (url.pathname === '/shapes') {
    send(200, 'text/html; charset=utf-8', `<!doctype html><title>shapes</title><body><script>
      window.__labels = {};
      const shapes = ${JSON.stringify(SHAPES)};
      Promise.all(shapes.map((s) => {
        const q = s.replace('RANDOM', String(Math.random()).slice(2));
        return fetch('/shape/' + shapes.indexOf(s) + '?' + q)
          .then((r) => r.json())
          .then((d) => { window.__labels[s] = d.label; });
      })).then(() => { window.__shapesDone = true; });
    </script></body>`);
    return;
  }

  if (url.pathname.startsWith('/shape/')) {
    send(200, 'application/json', JSON.stringify({ label: 'REAL', shape: url.search }));
    return;
  }

  if (url.pathname === '/sse') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    res.write('data: LIVE 1\n\n');
    let n = 1;
    const timer = setInterval(() => { n += 1; res.write(`data: LIVE ${n}\n\n`); }, 120);
    const stop = setTimeout(() => { clearInterval(timer); res.end(); }, 6000);
    req.on('close', () => { clearInterval(timer); clearTimeout(stop); });
    return;
  }

  if (url.pathname === '/rsc') {
    res.writeHead(200, { 'content-type': 'text/x-component', 'cache-control': 'no-store' });
    let i = 0;
    const timer = setInterval(() => {
      res.write(`${i}:["chunk"]\n`);
      i += 1;
      if (i > 14) { clearInterval(timer); res.end(); }
    }, 100);
    req.on('close', () => clearInterval(timer));
    return;
  }

  if (url.pathname === '/slow-body') {
    // Headers immediately, body only after 800 ms: a patch that buffers before handing
    // the Response back turns a 5 ms fetch into an 800 ms one.
    // flushHeaders() is essential — Node otherwise holds the head until the first
    // write, which would make even an unpatched browser resolve at 800 ms and the
    // assertion below meaningless.
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.flushHeaders();
    setTimeout(() => res.end(JSON.stringify({ label: 'REAL' })), 800);
    return;
  }

  if (url.pathname === '/very-slow-body') {
    // Headers now, body after 4 s — past interceptor.js's 3 s MODIFY_READ_TIMEOUT_MS.
    // A Change on this source CANNOT be applied, and Deviation 16 says the capture must
    // say so rather than letting the user think the edit took.
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.flushHeaders();
    setTimeout(() => res.end(JSON.stringify({ label: 'REAL' })), 4000);
    return;
  }

  if (url.pathname === '/huge') {
    // Declares its size and exceeds PLAN.md §4's 2 MB cap, so it is stored as an
    // {__unparsed} PREVIEW — 512 characters of it, not an empty string.
    const body = JSON.stringify({ marker: 'HUGE-BODY-MARKER', filler: 'x'.repeat(2.5 * 1024 * 1024) });
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store'
    });
    res.end(body);
    return;
  }

  if (url.pathname === '/deep') {
    send(200, 'text/html; charset=utf-8', `<!doctype html><title>deep</title><body><script>
      fetch('/deep/data.json').then((r) => r.json()).then((d) => { window.__deepDone = d.rows.length; });
    </script></body>`);
    return;
  }

  if (url.pathname === '/deep/data.json') {
    send(200, 'application/json', JSON.stringify(deepBody()));
    return;
  }

  if (url.pathname === '/blank') {
    send(200, 'text/html; charset=utf-8', '<!doctype html><title>blank</title><body>');
    return;
  }

  if (url.pathname === '/endless') {
    // text/plain, so it is NOT on the streaming content-type list: only owning the
    // reader and cancelling it can ever release this socket.
    endless.startedAt = Date.now();
    endless.closedAt = null;
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    const timer = setInterval(() => res.write('tick '.repeat(8) + '\n'), 100);
    req.on('close', () => { clearInterval(timer); endless.closedAt = Date.now(); });
    return;
  }

  send(404, 'text/plain', 'not found');
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------------- suite */

const chromium = await loadChromium();

if (!chromium) {
  test('browser end-to-end suite', { skip: 'Playwright is not installed — `npm i -D playwright && npx playwright install chromium` enables it.' }, () => {});
} else {
  test('MockLab in real Chromium', async (t) => {
    const { stage, optional, check, timeline } = createFixture(t);

    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mocklab-e2e-'));
    const fixtures = http.createServer(fixtureHandler);

    let fixtureOrigin = null;
    let ctx = null;
    let sw = null;
    let panel = null;
    // The demo site is optional here — five checks below need it and the rest do not —
    // so its failure skips those checks WITH THE REASON, and breaks nothing.
    let demo = { value: null, why: null };
    const swErrors = [];

    try {
      fixtureOrigin = await stage('fixture server', 10000, async () => `http://127.0.0.1:${await listen(fixtures)}`);

      demo = await optional('demo server', 10000, async () => {
        const { createServer } = await import('../../companion/src/index.js');
        const server = createServer();
        return { server, origin: `http://127.0.0.1:${await listen(server)}` };
      });

      // The ONE stage whose failure means an absent dependency rather than a defect.
      // Everything after it — a service worker that never registers, a panel page that
      // never opens — is this product failing, and says so by name instead of sending
      // whoever reads CI to check whether Chromium is installed.
      ctx = await stage(
        'chromium launch + extension load', 60000,
        () => launchExtension(chromium, profile),
        { absent: 'Chromium could not be launched' }
      );

      sw = await stage('service-worker registration', 20000, async () =>
        ctx.serviceWorkers()[0] || ctx.waitForEvent('serviceworker', { timeout: 20000 }));
      sw.on('console', (m) => { if (m.type() === 'error') swErrors.push(m.text()); });

      // The panel talks to the worker with chrome.runtime.sendMessage, and a message the
      // worker sends is never delivered back to itself — so drive it from a real
      // extension page, exactly as the Sources tab will.
      panel = await stage('panel page', 30000, async () => {
        const page = await ctx.newPage();
        await page.goto(sw.url().split('/src/')[0] + '/src/panel/panel.html');
        return page;
      });
      t.diagnostic(`fixture ready — ${timeline.join(', ')}`);
    } catch {
      // The stage that failed already recorded whether this was an absent browser (every
      // check skips) or a broken fixture (every check fails, naming the stage). Nothing
      // is decided here; the body below is entered either way so that every check
      // reports, and teardown is the `finally` at the end of it.
    }

    /** The companion's demo site, or null — with `demo.why` saying why not. */
    const demoSite = demo.value;

    const listSources = (tabId) =>
      panel.evaluate(([type, payload]) => chrome.runtime.sendMessage({ type, payload }), [MSG.LIST_SOURCES, { tabId }]);
    const getResponse = (tabId, sigId, jsonPath) =>
      panel.evaluate(([type, payload]) => chrome.runtime.sendMessage({ type, payload }), [MSG.GET_RESPONSE, { tabId, sigId, path: jsonPath }]);
    /**
     * Chrome tab ids are not exposed to Playwright, so a tab is found by its URL. That
     * only works while URLs are UNIQUE per tab — two pages on the same URL silently
     * resolve to whichever Chrome lists first, and every assertion afterwards is about
     * some other tab. Each subtest below therefore gives its page a distinguishing
     * query string, and this throws rather than returning null.
     */
    const tabIdOf = async (page) => {
      const url = page.url();
      const ids = await sw.evaluate(async (u) => {
        const tabs = await chrome.tabs.query({});
        return tabs.filter((tab) => tab.url === u).map((tab) => tab.id);
      }, url);
      assert.equal(ids.length, 1, `exactly one tab is at ${url} (found ${ids.length})`);
      return ids[0];
    };
    const plantChanges = (origin, changes) =>
      sw.evaluate(async ([key, list]) => chrome.storage.local.set({ ['changes:' + key]: list }), [origin, changes]);

    const sendMessage = (type, payload) =>
      panel.evaluate(([t, p]) => chrome.runtime.sendMessage({ type: t, payload: p }), [type, payload]);
    const badgeText = (tabId) => sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);

    /**
     * §17.2's whole point is that a broken MockLab leaves the page working — which
     * means a DEAD extension and a healthy one look identical from the page. Every
     * no-degradation assertion below therefore checks the patch is actually installed
     * first, so a silently-dead interceptor can never read as a pass.
     */
    const assertInterceptorInstalled = async (page) => {
      const installed = await page.evaluate(() => window.__mocklabInterceptorInstalled);
      assert.equal(installed, true, 'the MAIN-world patch is installed — otherwise this subtest proves nothing');
    };

    /** The badge is written asynchronously after a store read; poll rather than sleep. */
    async function waitForBadge(tabId, expected, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        last = await badgeText(tabId);
        if (last === expected) return last;
        await sleep(80);
      }
      return last;
    }

    /** Poll the demo's pill; a reload driven from the worker destroys the context. */
    async function waitForPill(page, expected, timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        try {
          last = await page.evaluate(() => {
            const pill = document.getElementById('status-pill');
            if (!pill) return null;
            return {
              text: pill.textContent,
              cls: pill.className,
              color: getComputedStyle(pill).color,
              banner: (document.getElementById('alert-banner') || {}).textContent || ''
            };
          });
          if (last && last.text === expected) return last;
        } catch {
          /* mid-navigation — try again */
        }
        await sleep(80);
      }
      return last;
    }

    async function waitForSources(tabId, count, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        last = await listSources(tabId);
        if (last && last.sources.length >= count) return last;
        await sleep(40);
      }
      return last;
    }

    try {
      /* ------------------------------------------------- §16 M1 DoD, on the demo */
      await check('the demo yields exactly two named sources, and SPA navigation adds none', async (tt) => {
        if (!demoSite) { tt.skip(`the companion demo site is not available: ${demo.why}`); return; }
        const page = await ctx.newPage();
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(String(e)));
        page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

        const startedAt = Date.now();
        await page.goto(demoSite.origin + '/demo/', { waitUntil: 'load' });
        const tabId = await tabIdOf(page);
        const res = await waitForSources(tabId, 2);
        const elapsed = Date.now() - startedAt;

        assert.equal(res.sources.length, 2, 'exactly two sources');
        assert.ok(elapsed <= 1000, `sources within 1 s (took ${elapsed} ms)`);
        const byVia = Object.fromEntries(res.sources.map((s) => [s.via, s]));
        assert.equal(byVia.fetch.name, 'Trip');
        assert.equal(byVia.xhr.name, 'User');
        assert.ok(res.sources.every((s) => /^[0-9a-f]{12}$/.test(s.sigId)), 'sigIds are 12 hex chars');

        const trip = await getResponse(tabId, byVia.fetch.sigId);
        const total = await getResponse(tabId, byVia.fetch.sigId, '$.price.total');
        assert.equal(trip.body.status, 'ON_TIME');
        assert.equal(total.body, 450);

        await page.evaluate(async () => {
          for (let i = 0; i < 5; i += 1) {
            history.pushState({}, '', '/demo/?view=' + i);
            await fetch('./api/trip.json').then((r) => r.json());
            await new Promise((r) => setTimeout(r, 30));
          }
        });
        await sleep(700);
        const after = await listSources(tabId);
        assert.equal(after.sources.length, 2, 'no duplicate captures on soft navigation');
        assert.ok(after.softNavs >= 5, `soft navigations reported (${after.softNavs})`);
        assert.deepEqual(pageErrors, [], 'the demo console stays clean');
        await page.close();
      });

      /* ---------- the §10.2 meta row and §12.4 #2 must count the WHOLE body ---------- */
      await check('"{n} fields" is the whole body, not the part an old bounded walk reached', async () => {
        const page = await ctx.newPage();
        await page.goto(fixtureOrigin + '/deep?case=fields', { waitUntil: 'load' });
        await page.waitForFunction(() => window.__deepDone === 6000, null, { timeout: 10000 });
        const tabId = await tabIdOf(page);

        const res = await waitForSources(tabId, 1);
        const source = res.sources.find((s) => s.url.includes('/deep/data.json'));
        assert.ok(source, 'the deep response was captured');

        // The number the Sources tab prints (§10.2) and `list_sources` returns (§12.4 #2).
        // Counted at §5.4's defaults it was 5000; at discovery's depth 24 it would still
        // miss the bottom of the tree. Either way the user is told a number smaller than
        // the data — about data MockLab searches further into than it counted.
        assert.equal(
          source.fields,
          DEEP_FIELDS,
          `the source holds ${DEEP_FIELDS} fields and must say so (said ${source.fields})`
        );

        // …and the deepest of them is genuinely addressable, so the count is a fact about
        // this body rather than a bigger number.
        const bottom = await getResponse(tabId, source.sigId, DEEP_LEAF_PATH);
        assert.equal(bottom.body, 'LEAF-AT-THE-BOTTOM', DEEP_LEAF_PATH);
        await page.close();
      });

      /* ------------------------------------- D1: streaming must never block a page */
      await check('streamed responses resolve at their headers and keep flowing', async () => {
        const page = await ctx.newPage();
        await page.goto(fixtureOrigin + '/streams', { waitUntil: 'load' });
        await assertInterceptorInstalled(page);
        await page.waitForFunction(
          () => window.__r.sseSecond && window.__r.rscHeaders !== undefined && window.__r.slowBody !== undefined,
          null,
          { timeout: 10000 }
        );
        const r = await page.evaluate(() => window.__r);

        assert.equal(r.sseFirst, 'data: LIVE 1', 'the first live chunk arrived');
        assert.equal(r.sseSecond, 'data: LIVE 2', 'the stream kept flowing past the first chunk');
        assert.ok(r.sseFirstAt < 1500, `the first live chunk is prompt (${Math.round(r.sseFirstAt)} ms)`);
        assert.ok(r.rscHeaders < 1000, `text/x-component resolves at headers, not after the stream (${Math.round(r.rscHeaders)} ms)`);
        await page.close();
      });

      /* ------------------------------- D14: no added latency when nothing matches */
      await check('a fetch with no matching Change resolves at its headers, not its body', async () => {
        const page = await ctx.newPage();
        await page.goto(fixtureOrigin + '/streams', { waitUntil: 'load' });
        await assertInterceptorInstalled(page);
        await page.waitForFunction(() => window.__r.slowBody !== undefined, null, { timeout: 10000 });
        // Measured again after load, so the one-time match-list wait is long over.
        const measured = await page.evaluate(async () => {
          const t0 = performance.now();
          const r = await fetch('/slow-body');
          const headersAt = performance.now() - t0;
          const label = (await r.json()).label;
          return { headersAt, bodyAt: performance.now() - t0, label };
        });
        assert.ok(
          measured.headersAt < 300,
          `headers resolve immediately, not after the 800 ms body (${Math.round(measured.headersAt)} ms)`
        );
        assert.ok(measured.bodyAt > 700, 'the body genuinely took 800 ms — the measurement is real');
        assert.equal(measured.label, 'REAL', 'the untouched body is still complete and parseable');
        await page.close();
      });

      /* -------------------- D8: an endless body is released, and nothing leaks out */
      await check('an endless response is released and no rejection reaches the page', async () => {
        const page = await ctx.newPage();
        await page.goto(fixtureOrigin + '/streams', { waitUntil: 'load' });
        await assertInterceptorInstalled(page);
        await page.waitForFunction(() => window.__r.endlessReleased === true, null, { timeout: 10000 });

        const deadline = Date.now() + CAPTURE_READ_TIMEOUT_OTHER_MS + 6000;
        while (endless.closedAt === null && Date.now() < deadline) await sleep(200);
        assert.ok(endless.closedAt !== null, 'MockLab released the endless stream, so the socket closed');
        const heldMs = endless.closedAt - endless.startedAt;
        assert.ok(
          heldMs <= CAPTURE_READ_TIMEOUT_OTHER_MS + 3000,
          `released within the capture deadline (held ${heldMs} ms)`
        );

        const rejections = await page.evaluate(() => window.__r.rejections);
        assert.deepEqual(rejections, [], 'no unhandledrejection reached the page');
        await page.close();
      });

      /* ---- D11: the round-trip invariant, against the REAL in-page matcher ---- */
      await check('every compiled entry matches the URL its signature came from', async () => {
        const page = await ctx.newPage();
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(String(e)));

        await page.goto(fixtureOrigin + '/shapes', { waitUntil: 'load' });
        await page.waitForFunction(() => window.__shapesDone === true, null, { timeout: 10000 });
        const tabId = await tabIdOf(page);
        const res = await waitForSources(tabId, SHAPES.length);
        assert.equal(res.sources.length, SHAPES.length, 'one source per URL shape');

        await plantChanges(
          fixtureOrigin,
          res.sources.map((s, i) => ({
            id: 'shape-' + i,
            origin: fixtureOrigin,
            sigId: s.sigId,
            path: '$.label',
            value: 'MOCKED',
            enabled: true,
            createdAt: Date.now()
          }))
        );
        await sleep(300);

        await page.reload({ waitUntil: 'load' });
        await page.waitForFunction(() => window.__shapesDone === true, null, { timeout: 10000 });
        const labels = await page.evaluate(() => window.__labels);

        const missed = SHAPES.filter((shape) => labels[shape] !== 'MOCKED');
        assert.deepEqual(missed, [], 'a compiled entry that cannot match its own URL is a silent no-op');
        assert.deepEqual(pageErrors, [], 'no page errors');
        await page.close();
      });

      /* ------------------ a literal "*" must not degrade into a wildcard in-page */
      await check('a param whose value is literally * does not match other values', async () => {
        const page = await ctx.newPage();
        // A document load is not a fetch, so the URL has to be requested from a page.
        await page.goto(fixtureOrigin + '/blank?case=literal-star', { waitUntil: 'load' });
        await page.evaluate(() => fetch('/shape/0?star=%2A').then((r) => r.json()));
        const tabId = await tabIdOf(page);
        await waitForSources(tabId, 1);
        const res = await listSources(tabId);
        const star = res.sources.find((s) => s.url.includes('star='));
        assert.ok(star, 'the literal-* URL was captured');

        await plantChanges(fixtureOrigin, [
          { id: 'star', origin: fixtureOrigin, sigId: star.sigId, path: '$.label', value: 'MOCKED', enabled: true, createdAt: Date.now() }
        ]);
        await sleep(300);

        const seen = await page.evaluate(async () => ({
          literal: (await (await fetch('/shape/0?star=%2A')).json()).label,
          other: (await (await fetch('/shape/0?star=anything')).json()).label
        }));
        assert.equal(seen.literal, 'MOCKED', 'the exact URL still matches');
        assert.equal(seen.other, 'REAL', 'a different value must NOT match a literal *');
        await page.close();
      });

      /* --------------------------- the engine: the site renders the mocked state */
      await check('the site itself re-renders from mocked data, over fetch and XHR', async (tt) => {
        if (!demoSite) { tt.skip(`the companion demo site is not available: ${demo.why}`); return; }
        const page = await ctx.newPage();
        await page.goto(demoSite.origin + '/demo/', { waitUntil: 'load' });
        const tabId = await tabIdOf(page);
        const res = await waitForSources(tabId, 2);
        const tripSig = res.sources.find((s) => s.via === 'fetch').sigId;
        const userSig = res.sources.find((s) => s.via === 'xhr').sigId;

        await plantChanges(demoSite.origin, [
          { id: 'a', origin: demoSite.origin, sigId: tripSig, path: '$.status', value: 'CANCELLED', enabled: true, createdAt: Date.now() },
          { id: 'b', origin: demoSite.origin, sigId: userSig, path: '$.user.displayName', value: 'Test Passenger', enabled: true, createdAt: Date.now() }
        ]);
        await sleep(300);
        await page.reload({ waitUntil: 'load' });
        await sleep(500);

        const shown = await page.evaluate(() => ({
          pill: document.getElementById('status-pill').textContent,
          cls: document.getElementById('status-pill').className,
          banner: document.getElementById('alert-banner').textContent,
          chip: document.getElementById('passenger-chip').textContent
        }));
        assert.equal(shown.pill, 'Cancelled', 'the site re-rendered the pill');
        assert.equal(shown.cls, 'is-cancelled', 'the site applied its own styling — not DOM editing');
        assert.equal(shown.banner, 'Your flight was cancelled', 'the derived banner appeared');
        assert.equal(shown.chip, 'Test Passenger', 'the XHR body was swapped too');

        const captured = await getResponse(tabId, tripSig);
        assert.equal(captured.body.status, 'ON_TIME', 'the captured body still holds the REAL value');
        const after = await listSources(tabId);
        assert.ok(after.sources.every((s) => s.mocked), 'both sources are flagged mocked');

        await plantChanges(demoSite.origin, []);
        await sleep(300);
        await page.reload({ waitUntil: 'load' });
        await sleep(500);
        const restored = await page.evaluate(() => document.getElementById('status-pill').textContent);
        assert.equal(restored, 'On time', 'removing every Change restores the real site');
        await page.close();
      });

      /* ═══════════════════════ §16 M2 DoD — the Changes engine, end to end ═══════
       *
       * "set `status=CANCELLED` in tree -> refresh -> demo pill is red WITHOUT any
       *  probe; change survives 10 refreshes; Reset site restores."
       *
       * Every step below goes through the REAL panel message surface (MSG.SET_VALUE,
       * MSG.RESET_SITE) — the same handlers the Sources tab calls. Nothing plants
       * storage directly, and no probe exists yet: probe.js is still a stub at M2, so
       * the pill turning red is the value edit alone.
       * ══════════════════════════════════════════════════════════════════════════ */
      await check('M2 DoD: a value edit turns the pill red, survives 10 refreshes, and Reset site restores', async (tt) => {
        if (!demoSite) { tt.skip(`the companion demo site is not available: ${demo.why}`); return; }
        const page = await ctx.newPage();
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(String(e)));
        page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

        await page.goto(demoSite.origin + '/demo/', { waitUntil: 'load' });
        await assertInterceptorInstalled(page);
        const tabId = await tabIdOf(page);
        const sources = await waitForSources(tabId, 2);
        const tripSig = sources.sources.find((s) => s.via === 'fetch').sigId;

        const before = await waitForPill(page, 'On time');
        assert.equal(before.text, 'On time', 'the real site starts on time');
        assert.equal(await waitForBadge(tabId, ''), '', 'nothing is modified yet, so the badge is empty');

        /* ---- the edit: exactly what "✏️ Change this value" in §10.2 sends ---- */
        const applied = await sendMessage(MSG.SET_VALUE, {
          tabId, sigId: tripSig, path: '$.status', value: 'CANCELLED'
        });
        assert.equal(applied.ok, true);
        assert.equal(applied.refreshed, true, 'Apply & refresh page actually refreshed');
        assert.equal(applied.change.originalValue, 'ON_TIME', 'the REAL value was captured for "Real value: …"');

        // §10.2 / §17.4: applied, but nothing has been proved.
        assert.equal(applied.change.linkState, 'candidate', 'a tree-view edit is never verified');
        const bindings = await sendMessage(MSG.GET_BINDINGS, { tabId });
        assert.deepEqual(
          [...new Set(bindings.bindings.map((b) => b.state))],
          ['candidate'],
          'no probe has run, so nothing may claim to be verified'
        );

        /* ---- the site itself renders the new state ---- */
        const red = await waitForPill(page, 'Cancelled');
        assert.equal(red.text, 'Cancelled', 'the site re-rendered its own pill');
        assert.equal(red.cls, 'is-cancelled', 'the site applied its own class — MockLab never touched the DOM');
        assert.equal(red.color, 'rgb(217, 48, 37)', 'the pill is genuinely RED, computed by the site CSS');
        assert.equal(red.banner, 'Your flight was cancelled', 'the derived banner appeared too');

        /* ---- §1.5: the badge mirrors the count, on this tab ---- */
        assert.equal(await waitForBadge(tabId, '1'), '1', 'the badge says one Change is on');

        const second = await ctx.newPage();
        await second.goto(demoSite.origin + '/demo/?tab=2', { waitUntil: 'load' });
        assert.equal(await waitForBadge(await tabIdOf(second), '1'), '1', 'a second tab on the same site shows it too');
        // A THIRD origin, with no Changes of its own. Same server, but `localhost` and
        // `127.0.0.1` are different origins — and the fixture origin cannot be used
        // here, because earlier subtests deliberately left Changes on it.
        const cleanOrigin = fixtureOrigin.replace('127.0.0.1', 'localhost');
        await second.goto(cleanOrigin + '/blank?case=other-origin', { waitUntil: 'load' });
        assert.equal(
          await waitForBadge(await tabIdOf(second), ''), '',
          'navigating that tab to a site with no Changes clears the badge — the count is per origin'
        );
        await second.close();

        /* ---- survives 10 consecutive refreshes ---- */
        for (let i = 1; i <= 10; i += 1) {
          await page.reload({ waitUntil: 'load' });
          const shown = await waitForPill(page, 'Cancelled');
          assert.equal(shown.text, 'Cancelled', `still cancelled on refresh ${i} of 10`);
          assert.equal(shown.color, 'rgb(217, 48, 37)', `still red on refresh ${i} of 10`);
        }
        assert.equal(await waitForBadge(tabId, '1'), '1', 'the badge survived ten refreshes as well');

        // The captured body is still the REAL one: the Sources tree must show the site's
        // data, not MockLab's own edit reflected back at the user.
        const captured = await sendMessage(MSG.GET_RESPONSE, { tabId, sigId: tripSig, path: '$.status' });
        assert.equal(captured.body, 'ON_TIME', 'the capture holds the real value, and the page holds the mock');

        /* ---- the per-row toggle turns it off without deleting it (§10.2) ---- */
        const off = await sendMessage(MSG.TOGGLE_CHANGE, { tabId, changeId: applied.change.id });
        assert.equal(off.change.enabled, false);
        assert.equal((await waitForPill(page, 'On time')).text, 'On time', 'switching it off restores the site');
        assert.equal(await waitForBadge(tabId, ''), '', 'a switched-off Change is not an active one');
        await sendMessage(MSG.TOGGLE_CHANGE, { tabId, changeId: applied.change.id });
        assert.equal((await waitForPill(page, 'Cancelled')).text, 'Cancelled', 'and back on again');

        /* ---- §1.5 Reset site ---- */
        const reset = await sendMessage(MSG.RESET_SITE, { tabId });
        assert.equal(reset.ok, true);
        assert.equal(reset.cleared, 1);
        assert.equal(reset.changeCount, 0);

        const restored = await waitForPill(page, 'On time');
        assert.equal(restored.text, 'On time', 'Reset site restored the real state');
        assert.equal(restored.cls, '', 'and the real styling');
        assert.equal(restored.banner, '', 'and removed the derived banner');
        assert.equal(await waitForBadge(tabId, ''), '', 'and cleared the badge');
        assert.deepEqual((await sendMessage(MSG.LIST_CHANGES, { tabId })).changes, [], 'the store is empty');

        assert.deepEqual(pageErrors, [], 'the demo console stayed clean throughout');
        await page.close();
      });

      /* ---- §10.5 danger zone: "Reset everything", across two sites at once ---- */
      await check('Reset everything clears every site and the pages go back to real', async (tt) => {
        if (!demoSite) { tt.skip(`the companion demo site is not available: ${demo.why}`); return; }

        const demoPage = await ctx.newPage();
        await demoPage.goto(demoSite.origin + '/demo/?run=reset-all', { waitUntil: 'load' });
        const demoTab = await tabIdOf(demoPage);
        const demoSources = await waitForSources(demoTab, 2);
        await sendMessage(MSG.SET_VALUE, {
          tabId: demoTab,
          sigId: demoSources.sources.find((s) => s.via === 'fetch').sigId,
          path: '$.status',
          value: 'CANCELLED'
        });
        assert.equal((await waitForPill(demoPage, 'Cancelled')).text, 'Cancelled', 'site one is mocked');

        const otherPage = await ctx.newPage();
        await otherPage.goto(fixtureOrigin + '/blank?case=reset-all', { waitUntil: 'load' });
        const otherTab = await tabIdOf(otherPage);
        await otherPage.evaluate(() => fetch('/shape/0?case=reset-all').then((r) => r.json()));
        const otherSources = await waitForSources(otherTab, 1);
        const otherSig = otherSources.sources.find((s) => s.url.includes('case=reset-all')).sigId;
        await sendMessage(MSG.SET_VALUE, {
          tabId: otherTab, sigId: otherSig, path: '$.label', value: 'MOCKED', refresh: false
        });
        await sleep(300);
        assert.equal(
          await otherPage.evaluate(() => fetch('/shape/0?case=reset-all').then((r) => r.json()).then((d) => d.label)),
          'MOCKED',
          'site two is mocked'
        );

        /* ---- one call, both sites ---- */
        const reset = await sendMessage(MSG.RESET_ALL, { tabId: demoTab });
        assert.equal(reset.ok, true);
        assert.ok(reset.cleared.changes >= 2, `at least both sites' Changes went (${reset.cleared.changes})`);
        assert.ok(reset.cleared.origins.includes(demoSite.origin), 'the demo origin is reported');
        assert.ok(reset.cleared.origins.includes(fixtureOrigin), 'the fixture origin is reported');

        // The real point of running this in a browser: Changes are REMOVED, not written
        // back as empty arrays, and only Chrome can say whether a removal fires
        // storage.onChanged — which is what re-pushes the match list and the badge.
        assert.equal((await waitForPill(demoPage, 'On time')).text, 'On time', 'site one is real again');
        assert.equal(await waitForBadge(demoTab, ''), '', 'and its badge cleared');
        assert.equal(await waitForBadge(otherTab, ''), '', 'the other site\'s badge cleared too');
        assert.equal(
          await otherPage.evaluate(() => fetch('/shape/0?case=reset-all').then((r) => r.json()).then((d) => d.label)),
          'REAL',
          'site two is real again without being reloaded — the match list was re-pushed'
        );
        assert.deepEqual((await sendMessage(MSG.LIST_CHANGES, { origin: demoSite.origin })).changes, []);
        assert.deepEqual((await sendMessage(MSG.LIST_CHANGES, { origin: fixtureOrigin })).changes, []);
        assert.deepEqual((await sendMessage(MSG.GET_BINDINGS, { origin: demoSite.origin })).bindings, []);

        await demoPage.close();
        await otherPage.close();
      });

      /* ---- Deviation 16: a Change that could not be applied is never silent ---- */
      await check('a Change on a too-slow response is reported dropped, not applied', async () => {
        const page = await ctx.newPage();
        await page.goto(fixtureOrigin + '/blank?case=dropped', { waitUntil: 'load' });
        await assertInterceptorInstalled(page);
        const tabId = await tabIdOf(page);

        // First visit with no Change: the capture read has a longer deadline, so the
        // source is learned and its identity is remembered.
        await page.evaluate(() => fetch('/very-slow-body').then((r) => r.json()));
        const seen = await waitForSources(tabId, 1, 12000);
        const slow = seen.sources.find((s) => s.url.includes('/very-slow-body'));
        assert.ok(slow, 'the slow source was captured');
        assert.equal(slow.changeDropped, false, 'nothing was dropped when nothing matched');

        const applied = await sendMessage(MSG.SET_VALUE, {
          tabId, sigId: slow.sigId, path: '$.label', value: 'MOCKED', refresh: false
        });
        assert.equal(applied.ok, true);
        await sleep(400);

        const label = await page.evaluate(() => fetch('/very-slow-body').then((r) => r.json()).then((d) => d.label));
        assert.equal(label, 'REAL', 'the page got the real response rather than hanging');

        const deadline = Date.now() + 8000;
        let dropped = null;
        while (Date.now() < deadline && !dropped) {
          const res = await listSources(tabId);
          const row = res.sources.find((s) => s.url.includes('/very-slow-body'));
          if (row && row.changeDropped) dropped = row;
          else await sleep(150);
        }
        assert.ok(dropped, 'the capture is flagged changeDropped, so the panel can say the edit did not apply');
        assert.equal(dropped.mocked, false, 'and it is NOT flagged as mocked — that would be the lie');
        await page.close();
      });

      /* ---- §4: over 2 MB the body is a 512-character preview, not an empty one ---- */
      await check('a body over the 2 MB cap is stored as a real preview', async () => {
        const page = await ctx.newPage();
        await page.goto(fixtureOrigin + '/blank?case=huge', { waitUntil: 'load' });
        await assertInterceptorInstalled(page);
        const tabId = await tabIdOf(page);

        const pageSaw = await page.evaluate(() =>
          fetch('/huge').then((r) => r.json()).then((d) => ({ marker: d.marker, filler: d.filler.length }))
        );
        assert.equal(pageSaw.marker, 'HUGE-BODY-MARKER', 'the page still received the WHOLE real body');
        assert.equal(pageSaw.filler, 2.5 * 1024 * 1024, 'every byte of it');

        const deadline = Date.now() + 8000;
        let row = null;
        while (Date.now() < deadline && !row) {
          const res = await listSources(tabId);
          row = res.sources.find((s) => s.url.includes('/huge')) || null;
          if (!row) await sleep(150);
        }
        assert.ok(row, 'the oversized source is still listed');
        assert.equal(row.unparsed, true, '§4 — stored unparsed');
        assert.ok(row.bodyBytes > 2 * 1024 * 1024, `the real size is reported (${row.bodyBytes})`);

        const body = await sendMessage(MSG.GET_RESPONSE, { tabId, sigId: row.sigId });
        assert.equal(body.body.__unparsed, true);
        assert.equal(typeof body.body.preview, 'string');
        assert.equal(body.body.preview.length, 512, '§4 asks for a 512-character preview');
        assert.ok(
          body.body.preview.includes('HUGE-BODY-MARKER'),
          'and it is the real start of the body, not an empty string'
        );
        await page.close();
      });

      /* ------------------------------------------- §17.2: the original Response */
      await check('an unmatched fetch hands back the original, unconsumed Response', async () => {
        const page = await ctx.newPage();
        await page.goto(fixtureOrigin + '/blank?case=identity', { waitUntil: 'load' });
        await assertInterceptorInstalled(page);
        const identity = await page.evaluate(async () => {
          const r = await fetch('/shape/0?identity=1');
          return { isResponse: r instanceof Response, bodyUsed: r.bodyUsed, hasStream: !!r.body, type: r.type, url: r.url };
        });
        assert.equal(identity.isResponse, true);
        assert.equal(identity.bodyUsed, false, 'the body is still unconsumed');
        assert.equal(identity.hasStream, true, 'the body is still streamable');
        assert.equal(identity.type, 'basic', 'type is unforgeable — a re-serialized Response cannot have it');
        assert.ok(identity.url.endsWith('/shape/0?identity=1'), 'url is unforgeable too');
        await page.close();
      });

      assert.deepEqual(swErrors, [], 'the service worker console stays clean');
    } finally {
      if (ctx) await ctx.close().catch(() => {});
      fixtures.close();
      if (demoSite) demoSite.server.close();
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });

  /**
   * §16 M2 DoD, "persistence": a Change must survive a browser restart AND take effect
   * on the very first load afterwards — not on the second, once something has been
   * captured. That is the whole reason for the `signatures:<origin>` key (Deviation 8),
   * and it is the one guarantee a same-session test cannot possibly cover, because the
   * service worker's in-memory capture state makes the first load look easy.
   *
   * Two real Chromium launches share one profile directory and one demo server, so the
   * origin is byte-identical across the restart.
   */
  test('a Change survives a browser restart and applies on the FIRST load after it', async (t) => {
    // This test has no subtests: its two launches are one narrative, and every
    // assertion is a step in it. So the constant-`# tests` half of the fixture contract
    // holds here for free (one test, always reported) and only the STAGE half is used —
    // which is the half this test was getting wrong.
    const fixture = createFixture(t);
    const { stage, optional } = fixture;
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mocklab-restart-'));

    const demo = await optional('demo server', 10000, async () => {
      const { createServer } = await import('../../companion/src/index.js');
      const server = createServer();
      return { server, origin: `http://127.0.0.1:${await listen(server)}` };
    });
    if (!demo.value) {
      fs.rmSync(profile, { recursive: true, force: true });
      t.skip(`the companion demo site is not available: ${demo.why}`);
      return;
    }
    const demoSite = demo.value;

    /**
     * Boot Chromium on the shared profile and hand back everything a phase needs.
     *
     * THREE stages, not one call that hides three waits. This function used to bundle the
     * launch, the service-worker registration and the panel page together, and its
     * caller's `catch` turned every one of them into `t.skip("Chromium could not be
     * launched…")`. A 20 s service-worker timeout reported as an absent browser is a
     * genuine failure wearing an environment gap's clothes: CI fails any suite that
     * reports a skip (README Deviation 41), so it WOULD have been caught — with the wrong
     * diagnosis, sending whoever read it to check whether Chromium was installed.
     *
     * Only the launch may claim the dependency is absent, and only on the first boot: by
     * the second, Chromium has demonstrably launched once on this very machine, so a
     * failure there is this product's and fails, naming its stage.
     */
    /**
     * Every context a boot has opened, closed by whichever path ends the phase.
     *
     * `boot` returns three things and can fail after two of them exist, so the caller
     * cannot be the only one holding the handle: a launch that succeeded and a
     * service-worker wait that did not used to leave a whole Chromium running with
     * nobody's reference on it, and `node --test` then waited on that process FOREVER —
     * a hang where the intended report was a named failure.
     */
    const opened = [];
    const closeAll = async () => {
      for (const ctx of opened.splice(0)) await ctx.close().catch(() => {});
    };

    async function boot(label, { mayBeAbsent = false } = {}) {
      const ctx = await stage(
        `${label}: chromium launch + extension load`, 60000,
        () => launchExtension(chromium, profile),
        mayBeAbsent ? { absent: 'Chromium could not be launched' } : {}
      );
      opened.push(ctx);
      const sw = await stage(`${label}: service-worker registration`, 20000, async () =>
        ctx.serviceWorkers()[0] || ctx.waitForEvent('serviceworker', { timeout: 20000 }));
      const panel = await stage(`${label}: panel page`, 30000, async () => {
        const page = await ctx.newPage();
        await page.goto(sw.url().split('/src/')[0] + '/src/panel/panel.html');
        return page;
      });
      return { ctx, sw, panel };
    }

    let first = null;
    try {
      first = await boot('launch 1', { mayBeAbsent: true });
    } catch (err) {
      await closeAll();
      demoSite.server.close();
      fs.rmSync(profile, { recursive: true, force: true });
      // An absent browser has already skipped this test, with the stage and the wait in
      // the reason. Anything past the launch is a defect and must read as one.
      if (!fixture.absent) throw err;
      return;
    }

    try {
      /* ---------------------------------------------------- launch 1: make the edit */
      const page = await first.ctx.newPage();
      await page.goto(demoSite.origin + '/demo/?run=1', { waitUntil: 'load' });

      const tabId = await first.sw.evaluate(async (u) => {
        const tabs = await chrome.tabs.query({});
        const hit = tabs.find((tab) => tab.url === u);
        return hit ? hit.id : null;
      }, page.url());

      let sources = null;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        sources = await first.panel.evaluate(
          ([type, payload]) => chrome.runtime.sendMessage({ type, payload }),
          [MSG.LIST_SOURCES, { tabId }]
        );
        if (sources && sources.sources.length >= 2) break;
        await sleep(50);
      }
      const tripSig = sources.sources.find((s) => s.via === 'fetch').sigId;

      const applied = await first.panel.evaluate(
        ([type, payload]) => chrome.runtime.sendMessage({ type, payload }),
        [MSG.SET_VALUE, { tabId, sigId: tripSig, path: '$.status', value: 'CANCELLED', refresh: false }]
      );
      assert.equal(applied.ok, true, 'the Change was stored before the restart');
    } finally {
      await closeAll();
    }

    /* ------------------------------------ launch 2: a genuinely cold service worker */
    let second = null;
    try {
      second = await boot('launch 2');
      const page = await second.ctx.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      // ONE load. No reload, no second chance: this is the load that must already be
      // mocked, or the persistence guarantee is not real.
      await page.goto(demoSite.origin + '/demo/?run=2', { waitUntil: 'load' });

      const deadline = Date.now() + 6000;
      let shown = null;
      while (Date.now() < deadline) {
        shown = await page.evaluate(() => {
          const pill = document.getElementById('status-pill');
          return pill ? { text: pill.textContent, color: getComputedStyle(pill).color } : null;
        });
        if (shown && shown.text !== '…') break;
        await sleep(60);
      }
      assert.equal(shown.text, 'Cancelled', 'the Change applied on the first load after a cold start');
      assert.equal(shown.color, 'rgb(217, 48, 37)', 'and the site rendered it red');

      const tabId = await second.sw.evaluate(async (u) => {
        const tabs = await chrome.tabs.query({});
        const hit = tabs.find((tab) => tab.url === u);
        return hit ? hit.id : null;
      }, page.url());
      let badge = '';
      const badgeDeadline = Date.now() + 5000;
      while (Date.now() < badgeDeadline) {
        badge = await second.sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
        if (badge === '1') break;
        await sleep(80);
      }
      assert.equal(badge, '1', 'the badge was repainted from storage on the cold start');
      assert.deepEqual(pageErrors, [], 'the demo console stays clean across the restart');
    } finally {
      // Reached however launch 2 ends. The second boot used to sit outside this block,
      // so a failure there leaked the demo server and the profile directory as well as
      // reporting itself wrongly.
      await closeAll();
      demoSite.server.close();
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });
}
