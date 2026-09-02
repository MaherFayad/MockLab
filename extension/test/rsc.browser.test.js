/**
 * M8 road B in real Chromium: an App-Router-shaped page whose every interaction after
 * first paint is a `text/x-component` fetch, driven through the GENUINE extension.
 *
 * OWNER: interceptor-engineer.
 *
 * The Node suites (`rsc.test.js`, `rscframing.test.js`) run the real `interceptor.js`
 * against real WHATWG streams and can put a chunk boundary anywhere; what they cannot do
 * is prove that Chromium's own fetch, the extension's service worker, the match list and
 * the page all agree. That is this file, and it is deliberately short: five questions
 * that only a browser can answer.
 *
 *   1. a flight response becomes an editable data source at all;
 *   2. a Change reaches a CLIENT NAVIGATION — the defect this milestone exists for;
 *   3. with no Change, the page receives the server's bytes exactly;
 *   4. with the transform installed, the page still sees chunk 1 before chunk 3 is sent;
 *   5. abandoning the response closes the socket.
 *
 * Skips (never fails) when Playwright or a Chromium build is unavailable, and skips as
 * REPORTED checks so this suite's contribution to `# tests` is the same number whether it
 * passes, skips or breaks (README Deviation 45).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MSG, CONTENT_GLOBALS } from '../src/background/messages.js';
import { FLIGHT, FLIGHT_ROWS, RSC_TYPE } from '../testlib/rscWorld.js';
import { loadChromium, launchExtension, createFixture, recordWorkerErrors } from '../testlib/browserFixture.js';

/** A stable `_rsc` token, as Next.js sends per route — so the signature is stable too. */
const RSC_QUERY = '?_rsc=1a2b3';

/**
 * Three chunks, with two straddles: the first boundary falls inside row 0's JSON and the
 * second inside row 4's — the row this page renders from. A parser that only works when
 * rows arrive whole fails check 2, not some byte-level check nobody reads.
 */
const SPLIT_A = Math.floor(FLIGHT_ROWS[0].length / 2);
const SPLIT_B = FLIGHT.length - Math.floor(FLIGHT_ROWS[4].length / 2) - FLIGHT_ROWS[5].length;
const CHUNKS = [FLIGHT.subarray(0, SPLIT_A), FLIGHT.subarray(SPLIT_A, SPLIT_B), FLIGHT.subarray(SPLIT_B)];
const GAP_MS = 250;

/** What the server did, read back by the checks. */
const wire = { sentAt: [], closedAt: null, requests: 0 };

const PAGE = `<!doctype html><meta charset="utf-8"><title>flights</title>
<style>.is-cancelled{color:rgb(217,48,37)}</style>
<body>
  <span id="pill">…</span>
  <script>
  /* A minimal App-Router-shaped client: every interaction fetches flight data and
     re-renders from it. It reads row 4 — the element tree — exactly as React would. */
  window.__seen = { chunkAt: [], bytes: null, error: null };
  window.navigate = async function (signal) {
    const res = await fetch('/rsc/flights${RSC_QUERY}', { headers: { RSC: '1' }, signal });
    const reader = res.body.getReader();
    const parts = [];
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      window.__seen.chunkAt.push(Date.now());
      parts.push(step.value);
    }
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) { all.set(part, at); at += part.length; }
    window.__seen.bytes = Array.from(all);
    const tree = window.readRows(all)['4'];
    const pill = tree[3].children[0][3].children;
    document.getElementById('pill').textContent = pill;
    document.getElementById('pill').className = tree[3].status === 'CANCELLED' ? 'is-cancelled' : '';
    return pill;
  };
  /* A correct flight reader, in the role of the CLIENT: length-framed rows are skipped
     by their byte count, never by a newline. React's own parser works this way, and a
     reader that splits on newlines cannot even find row 4 — the text row before it does
     not end in one. So this is also what makes the checks meaningful: the bytes MockLab
     produces have to satisfy a reader that actually honours the framing. */
  window.readRows = function (bytes) {
    const dec = new TextDecoder();
    const out = {};
    let i = 0;
    while (i < bytes.length) {
      if (bytes[i] === 10) { i += 1; continue; }
      let colon = i;
      while (colon < bytes.length && bytes[colon] !== 58) colon += 1;
      const id = dec.decode(bytes.subarray(i, colon));
      const tag = String.fromCharCode(bytes[colon + 1]);
      if (tag === '[' || tag === '{') {
        let nl = colon + 1;
        while (nl < bytes.length && bytes[nl] !== 10) nl += 1;
        out[id] = JSON.parse(dec.decode(bytes.subarray(colon + 1, nl)));
        i = nl + 1;
      } else if ('TABOoUSsLlGgMmV'.indexOf(tag) !== -1) {
        let comma = colon + 2;
        while (comma < bytes.length && bytes[comma] !== 44) comma += 1;
        const size = parseInt(dec.decode(bytes.subarray(colon + 2, comma)), 16);
        i = comma + 1 + size;
      } else {
        let nl = colon + 1;
        while (nl < bytes.length && bytes[nl] !== 10) nl += 1;
        i = nl + 1;
      }
    }
    return out;
  };
  /* Two ways a page lets go, and they take different routes out. "abort" tears down the
     fetch itself; "cancel" releases only the body MockLab handed over, which is the one
     that has to travel back through the transform to reach the network. */
  window.letGo = async function (how) {
    const controller = new AbortController();
    const res = await fetch('/rsc/flights${RSC_QUERY}', { signal: controller.signal });
    const reader = res.body.getReader();
    await reader.read();
    if (how === 'abort') controller.abort();
    else await reader.cancel();
    return true;
  };
  </script>
</body>`;

function fixtureHandler(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (url.pathname === '/app/flights') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(PAGE);
    return;
  }

  if (url.pathname === '/rsc/flights') {
    wire.requests += 1;
    wire.sentAt = [];
    wire.closedAt = null;
    res.writeHead(200, { 'content-type': RSC_TYPE, 'cache-control': 'no-store' });
    res.flushHeaders();
    let i = 0;
    const write = () => {
      if (i >= CHUNKS.length) { res.end(); return; }
      wire.sentAt.push(Date.now());
      res.write(CHUNKS[i]);
      i += 1;
      if (i < CHUNKS.length) timer = setTimeout(write, GAP_MS);
      else res.end();
    };
    let timer = setTimeout(write, 0);
    req.on('close', () => { clearTimeout(timer); wire.closedAt = Date.now(); });
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chromium = await loadChromium();

if (!chromium) {
  test('RSC browser suite', { skip: 'Playwright is not installed — `npm i -D playwright && npx playwright install chromium` enables it.' }, () => {});
} else {
  test('flight data, edited in flight, in real Chromium', async (t) => {
    const { stage, check, timeline } = createFixture(t);

    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mocklab-rsc-'));
    const fixtures = http.createServer(fixtureHandler);
    let origin = null;
    let ctx = null;
    let sw = null;
    let panel = null;
    let swErrors = null;

    try {
      origin = await stage('fixture server', 10000, async () => `http://127.0.0.1:${await listen(fixtures)}`);
      ctx = await stage(
        'chromium launch + extension load', 60000,
        () => launchExtension(chromium, profile),
        { absent: 'Chromium could not be launched' }
      );
      sw = await stage('service-worker registration', 20000, async () =>
        ctx.serviceWorkers()[0] || ctx.waitForEvent('serviceworker', { timeout: 20000 }));
      swErrors = await stage('service-worker error recorder', 10000, () => recordWorkerErrors(ctx, sw));
      panel = await stage('panel page', 30000, async () => {
        const page = await ctx.newPage();
        await page.goto(sw.url().split('/src/')[0] + '/src/panel/panel.html');
        return page;
      });
      t.diagnostic(`fixture ready — ${timeline.join(', ')}`);
    } catch {
      /* the stage recorded whether this is an absent browser or a defect; every check
         below still reports, either way. */
    }

    const sendMessage = (type, payload) =>
      panel.evaluate(([m, p]) => chrome.runtime.sendMessage({ type: m, payload: p }), [type, payload]);
    const tabIdOf = async (page) => {
      const ids = await sw.evaluate(async (u) => (await chrome.tabs.query({})).filter((tab) => tab.url === u).map((tab) => tab.id), page.url());
      assert.equal(ids.length, 1, `exactly one tab is at ${page.url()}`);
      return ids[0];
    };
    /** §17.2's point is that a dead MockLab looks exactly like a healthy one from the
     *  page. Every check below asserts the patch is really installed first. */
    const assertInstalled = async (page) => {
      const installed = await page.evaluate((flag) => window[flag], CONTENT_GLOBALS.interceptorInstalled);
      assert.equal(installed, true, 'the MAIN-world patch is installed — otherwise this proves nothing');
    };
    async function waitForSource(tabId, match, ms = 8000) {
      const deadline = Date.now() + ms;
      let last = null;
      while (Date.now() < deadline) {
        last = await sendMessage(MSG.LIST_SOURCES, { tabId });
        const found = (last.sources || []).find(match);
        if (found) return found;
        await sleep(80);
      }
      throw new Error(`no source matched within ${ms} ms: ${JSON.stringify(last)}`);
    }

    try {
      await check('a streamed flight response becomes an editable data source', async () => {
        const page = await ctx.newPage();
        await page.goto(`${origin}/app/flights?case=capture`, { waitUntil: 'load' });
        await assertInstalled(page);
        assert.equal(await page.evaluate(() => window.navigate()), 'On time', 'the site rendered from flight data');

        const tabId = await tabIdOf(page);
        const source = await waitForSource(tabId, (s) => s.url.includes('/rsc/flights'));
        assert.equal(source.unparsed, undefined === source.unparsed ? undefined : false, 'not an unreadable stream');
        assert.ok(source.fields > 0, `the rows carry addressable fields (${source.fields})`);

        const body = await sendMessage(MSG.GET_RESPONSE, { tabId, sigId: source.sigId });
        assert.deepEqual(Object.keys(body.body).sort(), ['0', '4', '5'], 'one entry per model row');
        assert.equal(body.body['5'].status, 'ON_TIME', 'holding the site\'s real values');
        const pill = await sendMessage(MSG.GET_RESPONSE, {
          tabId, sigId: source.sigId, path: '$["4"][3].children[0][3].children'
        });
        assert.equal(pill.body, 'On time', 'and the field the pill renders from is addressable');
        await page.close();
      });

      await check('a Change reaches a CLIENT NAVIGATION and the site renders it', async () => {
        const page = await ctx.newPage();
        await page.goto(`${origin}/app/flights?case=edit`, { waitUntil: 'load' });
        await assertInstalled(page);
        assert.equal(await page.evaluate(() => window.navigate()), 'On time');

        const tabId = await tabIdOf(page);
        const source = await waitForSource(tabId, (s) => s.url.includes('/rsc/flights'));
        const applied = await sendMessage(MSG.SET_VALUE, {
          tabId, sigId: source.sigId, path: '$["4"][3].children[0][3].children',
          value: 'Cancelled', refresh: false
        });
        assert.equal(applied.ok, true);
        assert.equal(applied.change.originalValue, 'On time', 'the real value was captured for "Real value: …"');
        await sendMessage(MSG.SET_VALUE, {
          tabId, sigId: source.sigId, path: '$["4"][3].status', value: 'CANCELLED', refresh: false
        });
        await sleep(400);   // the match list is pushed on the storage change

        // NO RELOAD. This is the milestone: the page interacts, fetches flight data, and
        // renders the changed state from its own tree.
        const rendered = await page.evaluate(() => window.navigate());
        assert.equal(rendered, 'Cancelled', 'the site re-rendered its pill from the edited row');
        const shown = await page.evaluate(() => ({
          text: document.getElementById('pill').textContent,
          color: getComputedStyle(document.getElementById('pill')).color
        }));
        assert.equal(shown.text, 'Cancelled');
        assert.equal(shown.color, 'rgb(217, 48, 37)', 'the SITE turned it red — MockLab never touched the DOM');

        const captured = await sendMessage(MSG.GET_RESPONSE, {
          tabId, sigId: source.sigId, path: '$["4"][3].status'
        });
        assert.equal(captured.body, 'ON_TIME', 'the capture still holds the real value');
        await sendMessage(MSG.RESET_SITE, { tabId });
        await sleep(300);
        assert.equal(await page.evaluate(() => window.navigate()), 'On time', 'Reset site restores the real page');
        await page.close();
      });

      await check('with no Change the page receives the server\'s bytes exactly', async () => {
        const page = await ctx.newPage();
        await page.goto(`${origin}/app/flights?case=identity`, { waitUntil: 'load' });
        await assertInstalled(page);
        await page.evaluate(() => window.navigate());
        const got = Buffer.from(await page.evaluate(() => window.__seen.bytes));
        assert.equal(got.equals(FLIGHT), true, `${got.length} bytes received of ${FLIGHT.length} sent`);
        await page.close();
      });

      await check('with the transform installed the stream still arrives incrementally', async () => {
        const page = await ctx.newPage();
        await page.goto(`${origin}/app/flights?case=stream`, { waitUntil: 'load' });
        await assertInstalled(page);
        const tabId = await tabIdOf(page);
        await page.evaluate(() => window.navigate());
        const source = await waitForSource(tabId, (s) => s.url.includes('/rsc/flights'));

        // A Change that DOES apply, so the transform is genuinely in the path.
        await sendMessage(MSG.SET_VALUE, {
          tabId, sigId: source.sigId, path: '$["4"][3].status', value: 'CANCELLED', refresh: false
        });
        await sleep(400);

        await page.evaluate(() => { window.__seen.chunkAt = []; });
        await page.evaluate(() => window.navigate());
        const seen = await page.evaluate(() => window.__seen.chunkAt);
        assert.equal(wire.sentAt.length, 3, 'the server really sent three chunks');
        assert.ok(
          wire.sentAt[2] - wire.sentAt[0] > GAP_MS,
          'and really did space them out — otherwise the measurement below proves nothing'
        );
        assert.ok(seen.length >= 1, 'the page received the body in pieces');
        assert.ok(
          seen[0] < wire.sentAt[2],
          `the page had data ${wire.sentAt[2] - seen[0]} ms before the server sent its last chunk ` +
            '— a transform that buffers to the end cannot do this'
        );
        await sendMessage(MSG.RESET_SITE, { tabId });
        await page.close();
      });

      for (const how of ['abort', 'cancel']) {
        await check(`a page that lets go of a flight response (${how}) closes the socket`, async () => {
          const page = await ctx.newPage();
          await page.goto(`${origin}/app/flights?case=${how}`, { waitUntil: 'load' });
          await assertInstalled(page);
          wire.closedAt = null;
          await page.evaluate((mode) => window.letGo(mode), how);
          const deadline = Date.now() + 5000;
          while (wire.closedAt === null && Date.now() < deadline) await sleep(100);
          assert.ok(wire.closedAt !== null, 'the transform did not keep the stream alive after the page let go');
          await page.close();
        });
      }

      await check('the service worker logged no errors during any of this', () => swErrors.assertClean());
    } finally {
      if (ctx) await ctx.close().catch(() => {});
      fixtures.close();
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });
}
