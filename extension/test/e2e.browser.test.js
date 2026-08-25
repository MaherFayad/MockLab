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
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(HERE, '..');

/** Message types the panel uses — mirrored from src/background/messages.js. */
const MSG = { LIST_SOURCES: 'msg:listSources', GET_RESPONSE: 'msg:getResponse' };

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

async function loadChromium() {
  const candidates = ['playwright', 'playwright-core', '/opt/node22/lib/node_modules/playwright/index.mjs'];
  for (const spec of candidates) {
    try {
      const mod = await import(spec);
      if (mod && mod.chromium) return mod.chromium;
    } catch {
      /* try the next one */
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
    const tabIdOf = (page) =>
      sw.evaluate(async (u) => {
        const tabs = await chrome.tabs.query({});
        const hit = tabs.find((tab) => tab.url === u);
        return hit ? hit.id : null;
      }, page.url());
    const plantChanges = (origin, changes) =>
      sw.evaluate(async ([key, list]) => chrome.storage.local.set({ ['changes:' + key]: list }), [origin, changes]);

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
        await page.goto(fixtureOrigin + '/blank', { waitUntil: 'load' });
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

      /* ------------------------------------------- §17.2: the original Response */
      await t.test('an unmatched fetch hands back the original, unconsumed Response', async () => {
        const page = await ctx.newPage();
        await page.goto(fixtureOrigin + '/blank', { waitUntil: 'load' });
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
}
