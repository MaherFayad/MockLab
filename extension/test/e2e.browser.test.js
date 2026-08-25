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
 * Every fixture lives in this file on purpose: `node --test` treats EVERY .js file
 * under `test/` as a test file, so a separate fixture module would be executed as one.
 *
 * Skips (never fails) when Playwright or a Chromium build is unavailable, so
 * `npm test -ws` stays green on a machine that only has Node.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// This file runs in Node, which HAS a module graph — unlike the two content scripts,
// whose mirrored constants are a genuine necessity (§17.2). Nothing here needs to
// duplicate the contract, so nothing here does: these are the real constants the
// service worker answers to, and a rename in messages.js breaks this suite loudly.
import { MSG } from '../src/background/messages.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(HERE, '..');

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

/**
 * Directories where a GLOBALLY installed package lives. A global install is not on this
 * workspace's resolution path, so `import('playwright')` misses it — which is why an
 * earlier version of this file carried an absolute path from one machine. That path
 * would have shipped and resolved nowhere for anyone else; these are all derived at run
 * time from the running Node.
 */
function globalPackageRoots() {
  const roots = [];
  try {
    roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    /* npm is not on PATH — the other two guesses still stand */
  }
  // node lives at <prefix>/bin/node; global packages at <prefix>/lib/node_modules.
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

/* ------------------------------------------------------------------ fixtures */

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
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mocklab-e2e-'));
    const fixtures = http.createServer(fixtureHandler);
    const fixturePort = await listen(fixtures);
    const fixtureOrigin = `http://127.0.0.1:${fixturePort}`;

    let demoServer = null;
    let demoOrigin = null;
    try {
      const { createServer } = await import('../../companion/src/index.js');
      demoServer = createServer();
      demoOrigin = `http://127.0.0.1:${await listen(demoServer)}`;
    } catch {
      demoServer = null; // the demo site is optional; its subtest skips without it
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

    // The panel talks to the worker with chrome.runtime.sendMessage, and a message the
    // worker sends is never delivered back to itself — so drive it from a real
    // extension page, exactly as the Sources tab will.
    const panel = await ctx.newPage();
    await panel.goto(sw.url().split('/src/')[0] + '/src/panel/panel.html');

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
      await t.test('the demo yields exactly two named sources, and SPA navigation adds none', async (tt) => {
        if (!demoServer) { tt.skip('the companion demo site is not available'); return; }
        const page = await ctx.newPage();
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(String(e)));
        page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

        const startedAt = Date.now();
        await page.goto(demoOrigin + '/demo/', { waitUntil: 'load' });
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

      /* ------------------------------------- D1: streaming must never block a page */
      await t.test('streamed responses resolve at their headers and keep flowing', async () => {
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
      await t.test('a fetch with no matching Change resolves at its headers, not its body', async () => {
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
      await t.test('an endless response is released and no rejection reaches the page', async () => {
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
      await t.test('every compiled entry matches the URL its signature came from', async () => {
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
      await t.test('a param whose value is literally * does not match other values', async () => {
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
      await t.test('the site itself re-renders from mocked data, over fetch and XHR', async (tt) => {
        if (!demoServer) { tt.skip('the companion demo site is not available'); return; }
        const page = await ctx.newPage();
        await page.goto(demoOrigin + '/demo/', { waitUntil: 'load' });
        const tabId = await tabIdOf(page);
        const res = await waitForSources(tabId, 2);
        const tripSig = res.sources.find((s) => s.via === 'fetch').sigId;
        const userSig = res.sources.find((s) => s.via === 'xhr').sigId;

        await plantChanges(demoOrigin, [
          { id: 'a', origin: demoOrigin, sigId: tripSig, path: '$.status', value: 'CANCELLED', enabled: true, createdAt: Date.now() },
          { id: 'b', origin: demoOrigin, sigId: userSig, path: '$.user.displayName', value: 'Test Passenger', enabled: true, createdAt: Date.now() }
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

        await plantChanges(demoOrigin, []);
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
      await t.test('M2 DoD: a value edit turns the pill red, survives 10 refreshes, and Reset site restores', async (tt) => {
        if (!demoServer) { tt.skip('the companion demo site is not available'); return; }
        const page = await ctx.newPage();
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(String(e)));
        page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

        await page.goto(demoOrigin + '/demo/', { waitUntil: 'load' });
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
        await second.goto(demoOrigin + '/demo/?tab=2', { waitUntil: 'load' });
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

      /* ---- Deviation 16: a Change that could not be applied is never silent ---- */
      await t.test('a Change on a too-slow response is reported dropped, not applied', async () => {
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
      await t.test('a body over the 2 MB cap is stored as a real preview', async () => {
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
      await t.test('an unmatched fetch hands back the original, unconsumed Response', async () => {
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
      await ctx.close();
      fixtures.close();
      if (demoServer) demoServer.close();
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
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mocklab-restart-'));
    let demoServer = null;
    let demoOrigin = null;
    try {
      const { createServer } = await import('../../companion/src/index.js');
      demoServer = createServer();
      demoOrigin = `http://127.0.0.1:${await listen(demoServer)}`;
    } catch {
      demoServer = null;
    }
    if (!demoServer) {
      fs.rmSync(profile, { recursive: true, force: true });
      t.skip('the companion demo site is not available');
      return;
    }

    /** Boot Chromium on the shared profile and hand back everything a subtest needs. */
    async function boot() {
      const ctx = await chromium.launchPersistentContext(profile, {
        channel: 'chromium',
        args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`]
      });
      let sw = ctx.serviceWorkers()[0];
      if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
      const panel = await ctx.newPage();
      await panel.goto(sw.url().split('/src/')[0] + '/src/panel/panel.html');
      return { ctx, sw, panel };
    }

    let first = null;
    try {
      first = await boot();
    } catch (err) {
      if (demoServer) demoServer.close();
      fs.rmSync(profile, { recursive: true, force: true });
      t.skip(`Chromium could not be launched (${err.message.split('\n')[0]})`);
      return;
    }

    try {
      /* ---------------------------------------------------- launch 1: make the edit */
      const page = await first.ctx.newPage();
      await page.goto(demoOrigin + '/demo/?run=1', { waitUntil: 'load' });

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
      await first.ctx.close();
    }

    /* ------------------------------------ launch 2: a genuinely cold service worker */
    const second = await boot();
    try {
      const page = await second.ctx.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      // ONE load. No reload, no second chance: this is the load that must already be
      // mocked, or the persistence guarantee is not real.
      await page.goto(demoOrigin + '/demo/?run=2', { waitUntil: 'load' });

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
      await second.ctx.close();
      demoServer.close();
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });
}
