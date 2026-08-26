/**
 * §16's M6 definition of done, in real Chromium against the real companion.
 *
 * OWNER: mcp-engineer.
 *
 * `wsClient.test.js` drives the ops with a fake dispatch and `companion/test/*` drives
 * the hub with a fake extension. Neither can prove the thing M6 is: that a REAL MCP
 * client, over a REAL WebSocket, reaches the REAL service worker and changes what a REAL
 * page renders. Every layer below is genuine — the unpacked extension, the demo site, the
 * hub, the pairing handshake, the MCP client from the SDK.
 *
 * The M6 DoD, asserted here in order:
 *   1. the agent happy path on the demo ends in a screenshot of a page whose pill is red;
 *   2. killing Chrome mid-call gives a clean MCP error, not a hang and not a lie;
 *   3. a wrong pairing code is rejected.
 *
 * ── WHAT THIS SUITE CANNOT REACH, STATED RATHER THAN IMPLIED ───────────────────────
 * The service worker cannot `chrome.runtime.sendMessage` to itself, so until
 * `background.js` carries the wiring block named in `wsClient.js`, the client cannot run
 * INSIDE the worker. It runs in the panel page instead — a real extension page, whose
 * `chrome.runtime.sendMessage` reaches the real worker, so every handler in the chain is
 * the shipping one. Two deps the worker would supply are stubbed here, and both are
 * named at the point of use: `portsFor` (worker-private, so `list_tabs`'s filter is not
 * exercised) and `onPicked` (pickApi is worker-private, so `probe_element` cannot
 * complete). The picking half of `probe_element` IS exercised, against the real page.
 *
 * Skips (never fails) when Playwright or a Chromium build is unavailable, and skips as
 * REPORTED checks: every check contributes exactly one test either way.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { loadChromium, launchExtension, createFixture } from '../testlib/browserFixture.js';
import { CONTENT_GLOBALS } from '../src/background/messages.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

const chromium = await loadChromium();

if (!chromium) {
  test('MCP browser suite', { skip: 'Playwright is not installed — `npm i -D playwright && npx playwright install chromium` enables it.' }, () => {});
} else {
  test('MockLab over MCP, in real Chromium', async (t) => {
    const { stage, optional, check, timeline } = createFixture(t);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mocklab-mcp-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mocklab-mcphome-'));
    const previousHome = process.env.MOCKLAB_HOME;
    process.env.MOCKLAB_HOME = home;

    let ctx = null;
    let sw = null;
    let panel = null;
    let hubRig = null;
    let demo = { value: null, why: null };
    let client = null;
    let mcpServer = null;

    try {
      demo = await optional('demo server', 10000, async () => {
        const { createServer } = await import('../../companion/src/index.js');
        const server = createServer();
        return { server, origin: `http://127.0.0.1:${await listen(server)}` };
      });

      hubRig = await stage('companion hub', 10000, async () => {
        const { createHub, HUB_PATH } = await import('../../companion/src/hub.js');
        const { createPairing, loadOrCreateToken } = await import('../../companion/src/pairing.js');
        const { token } = loadOrCreateToken();
        const lines = [];
        const pairing = createPairing({ token, onRefusal: (why) => lines.push(why) });
        const hub = createHub({ pairing, log: (line) => lines.push(line) });
        const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
        hub.attach(server);
        const port = await listen(server);
        return { hub, pairing, server, lines, token, url: `ws://127.0.0.1:${port}${HUB_PATH}` };
      });

      ctx = await stage('chromium launch + extension load', 60000, () => launchExtension(chromium, profile), {
        absent: 'Chromium could not be launched'
      });
      sw = await stage('service-worker registration', 20000, async () =>
        ctx.serviceWorkers()[0] || ctx.waitForEvent('serviceworker', { timeout: 20000 })
      );
      panel = await stage('panel page', 30000, async () => {
        const page = await ctx.newPage();
        await page.goto(sw.url().split('/src/')[0] + '/src/panel/panel.html');
        return page;
      });

      // The MCP client the checks below drive, over the SDK's own transport pair.
      const rig = await stage('MCP client', 10000, async () => {
        const { createMcpServer } = await import('../../companion/src/mcpServer.js');
        const server = createMcpServer({ hub: hubRig.hub });
        const c = new Client({ name: 'mocklab-browser-suite', version: '1.0.0' });
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(serverSide), c.connect(clientSide)]);
        return { c, server };
      });
      client = rig.c;
      mcpServer = rig.server;

      t.diagnostic(`fixture ready — ${timeline.join(', ')}`);
    } catch {
      // The stage that failed recorded whether this was an absent browser or a defect.
    }

    const demoSite = demo.value;

    /**
     * Start the wsClient inside the panel page and keep it on `window.mocklabTestClient`.
     * `portsFor` and `onPicked` are the two worker-private deps — see the header.
     */
    const startClient = (code) =>
      panel.evaluate(async ([url, pairingCode]) => {
        const { createWsClient } = await import('/src/background/wsClient.js');
        // One client at a time. Two would supersede each other on the hub for ever —
        // which is exactly the defect this suite found, and which `wsClient.js` now
        // refuses to take part in. The handle is deliberately NOT a `__mocklab…` name:
        // those are the content-script contracts `messages.js` names and audits, and a
        // test fixture must not add a sixth (`guards.contract.test.js` says so).
        if (window.mocklabTestClient) window.mocklabTestClient.stop();
        const client = createWsClient({
          url,
          dispatch: (message) => chrome.runtime.sendMessage(message),
          resolveTabId: async (id) => id,
          // STUB (worker-private): the real one is background.js's live Port set.
          portsFor: () => new Set([{}]),
          tabRecord: () => null,
          // STUB (worker-private): pickApi lives in the worker's module scope.
          onPicked: () => {},
          chrome: window.chrome
        });
        window.mocklabTestClient = client;
        if (pairingCode !== null) return client.pair(pairingCode);
        await client.start();
        return { ok: true };
      }, [hubRig ? hubRig.url : '', code === undefined ? null : code]);

    const stopClient = () => panel.evaluate(() => window.mocklabTestClient && window.mocklabTestClient.stop());

    const callTool = async (name, args) => {
      const answer = await client.callTool({ name, arguments: args });
      return {
        isError: Boolean(answer.isError),
        text: answer.content.find((part) => part.type === 'text') ? answer.content.find((part) => part.type === 'text').text : '',
        image: answer.content.find((part) => part.type === 'image') || null,
        json() {
          const text = answer.content.find((part) => part.type === 'text').text;
          return JSON.parse(text);
        }
      };
    };

    const tabIdOf = async (page) => {
      const url = page.url().split('#')[0];
      const ids = await sw.evaluate(async (u) => {
        const tabs = await chrome.tabs.query({});
        return tabs.filter((tab) => tab.url.split('#')[0] === u).map((tab) => tab.id);
      }, url);
      assert.equal(ids.length, 1, `exactly one tab is at ${url}`);
      return ids[0];
    };

    let demoPage = null;
    try {
      /* ─────────────────────────── DoD 3: a wrong pairing code is rejected ─────── */

      await check('§16 M6 DoD 3: a wrong pairing code is rejected, and pairs nothing', async () => {
        assert.ok(hubRig, 'the hub started');
        const { code } = hubRig.pairing.open();
        const wrong = String((Number(code) + 1) % 1000000).padStart(6, '0');

        const refused = await startClient(wrong);
        assert.deepEqual(refused, { ok: false }, 'the extension is told no, and nothing else');
        await sleep(200);
        assert.equal(hubRig.hub.isConnected(), false, 'a refused code leaves no authenticated socket');
        const stored = await panel.evaluate(() => chrome.storage.local.get('settings'));
        assert.ok(!stored.settings || !stored.settings.companionToken, 'and no token was stored');
        assert.equal(
          hubRig.lines.some((line) => line.includes(code)),
          false,
          'the real code is never echoed, not even into the companion log'
        );
        await stopClient();
      });

      await check('§12.3 the right code hands the token over, and the extension reconnects with it', async () => {
        const { code } = hubRig.pairing.open();
        const paired = await startClient(code);
        assert.deepEqual(paired, { ok: true });
        const stored = await panel.evaluate(() => chrome.storage.local.get('settings'));
        assert.equal(stored.settings.companionToken, hubRig.token, 'stored for every later connection');

        await startClient();   // ordinary start: presents the token in the handshake
        await sleep(400);
        assert.equal(hubRig.hub.isConnected(), true, 'the hub has one authenticated extension');
      });

      /* ────────────────── DoD 1: the agent happy path, on the demo site ────────── */

      await check('§16 M6 DoD 1: list_tabs -> list_sources -> set_value -> reload -> screenshot', async (subtest) => {
        if (!demoSite) {
          subtest.skip(`the demo server did not start — ${demo.why}`);
          return;
        }
        demoPage = await ctx.newPage();
        await demoPage.goto(`${demoSite.origin}/demo/`);
        await demoPage.waitForSelector('#status-pill');
        await sleep(600);
        const tabId = await tabIdOf(demoPage);

        const tabs = await callTool('list_tabs', {});
        assert.equal(tabs.isError, false, tabs.text);
        assert.ok(tabs.json().tabs.some((tab) => tab.tabId === tabId), 'the demo tab is offered to the agent');

        const sources = await callTool('list_sources', { tabId });
        assert.equal(sources.isError, false, sources.text);
        const names = sources.json().sources.map((source) => source.name);
        subtest.diagnostic(`sources: ${JSON.stringify(names)}`);
        const trip = sources.json().sources.find((source) => source.url.includes('trip.json'));
        assert.ok(trip, `§14's two sources are listed (${JSON.stringify(names)})`);

        const body = await callTool('get_response', { tabId, sigId: trip.sigId });
        assert.equal(body.json().body.status, 'ON_TIME', 'the real body, read over MCP');

        const set = await callTool('set_value', {
          tabId, sigId: trip.sigId, path: '$.status', value: 'CANCELLED', refresh: false
        });
        assert.equal(set.isError, false, set.text);
        assert.equal(set.json().change.value, 'CANCELLED');
        assert.equal(set.json().change.linkState, 'candidate', 'a change proves nothing on its own (§17.4)');

        const reloaded = await callTool('reload', { tabId, waitForSettle: true });
        assert.equal(reloaded.isError, false, reloaded.text);
        assert.equal(reloaded.json().reloaded, true);
        assert.equal(reloaded.json().settled, false, 'MockLab reports the checks it made, not the one it could not');

        await demoPage.waitForSelector('#status-pill');
        await demoPage.waitForFunction(
          () => document.querySelector('#status-pill') && /cancel/i.test(document.querySelector('#status-pill').textContent),
          null,
          { timeout: 8000 }
        );
        const pill = await demoPage.evaluate(() => {
          const node = document.querySelector('#status-pill');
          const style = getComputedStyle(node);
          return { text: node.textContent.trim(), color: style.color, background: style.backgroundColor };
        });
        subtest.diagnostic(`pill after set_value: ${JSON.stringify(pill)}`);
        const red = (value) => {
          const [r, g, b] = (value.match(/\d+/g) || []).map(Number);
          return r > g + 30 && r > b + 30;
        };
        assert.ok(
          red(pill.color) || red(pill.background),
          `the site rendered the cancelled state itself — pill was ${JSON.stringify(pill)}`
        );

        const shot = await callTool('screenshot', { tabId });
        assert.equal(shot.isError, false, shot.text);
        assert.ok(shot.image, '§12.4 #14 returns an image a model can look at');
        const png = Buffer.from(shot.image.data, 'base64');
        assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'and it really is a PNG');
        subtest.diagnostic(`screenshot: ${png.length} bytes of PNG`);
      });

      await check('§1.6 the agent\'s change is in the store the panel reads, and clear_changes puts it back', async (subtest) => {
        if (!demoSite || !demoPage) {
          subtest.skip('the happy-path check did not get far enough to leave a change behind');
          return;
        }
        const tabId = await tabIdOf(demoPage);
        const before = await panel.evaluate(async () => {
          const bag = await chrome.storage.local.get(null);
          return Object.entries(bag).filter(([key]) => key.startsWith('changes:')).flatMap(([, list]) => list);
        });
        assert.equal(before.length, 1, 'the agent\'s change is in the shared store (§1.6)');

        const cleared = await callTool('clear_changes', { tabId, refresh: true });
        assert.equal(cleared.isError, false, cleared.text);
        const after = await panel.evaluate(async () => {
          const bag = await chrome.storage.local.get(null);
          return Object.entries(bag).filter(([key]) => key.startsWith('changes:')).flatMap(([, list]) => list);
        });
        assert.deepEqual(after, [], '"Reset site" through MCP is the same reset (§1.5)');
      });

      await check('§1.1 a tool whose worker half is not built says so, and does not answer emptily', async () => {
        const answer = await callTool('list_presets', { tabId: 1 });
        assert.equal(answer.isError, true, 'M5 shipped the panel half of Scenarios; the worker half is not there');
        assert.match(answer.text, /still being built/, 'and an agent is told exactly that');
      });

      /* ─────────────── the picking half of probe_element, against the real page ── */

      await check('§12.4 #5 the injected picker finds the demo pill through the real element contract', async (subtest) => {
        if (!demoSite || !demoPage) {
          subtest.skip('the demo page never loaded');
          return;
        }
        // The check before this one cleared the site and reloaded it, so the page may be
        // mid-load. Picking then would fingerprint an empty pill and prove nothing — the
        // shape of green-for-the-wrong-reason this build has hit before.
        await demoPage.waitForFunction(
          () => {
            const node = document.querySelector('#status-pill');
            return Boolean(node && node.textContent.trim().length > 0);
          },
          null,
          { timeout: 10000 }
        );
        const tabId = await tabIdOf(demoPage);
        const found = await panel.evaluate(async ([id, globalName]) => {
          const { findTargetInPage } = await import('/src/background/wsOps.js');
          const [result] = await chrome.scripting.executeScript({
            target: { tabId: id },
            args: [globalName, '#status-pill', ''],
            func: findTargetInPage
          });
          return result.result;
        }, [tabId, CONTENT_GLOBALS.element]);

        assert.equal(found.ok, true, `the real page answered: ${JSON.stringify(found)}`);
        assert.ok(found.fingerprint.css, '§6.2 fingerprint');
        assert.ok(Array.isArray(found.fingerprint.treePath));
        assert.ok(found.snapshot.text.length > 0, `§7.3 snapshot: ${JSON.stringify(found.snapshot)}`);
        subtest.diagnostic(`picked ${found.fingerprint.css} — “${found.snapshot.text}”`);

        // By text, the way §12.4 #5 lets an agent name an element it can only see.
        const byText = await panel.evaluate(async ([id, globalName, text]) => {
          const { findTargetInPage } = await import('/src/background/wsOps.js');
          const [result] = await chrome.scripting.executeScript({
            target: { tabId: id }, args: [globalName, '', text], func: findTargetInPage
          });
          return result.result;
        }, [tabId, CONTENT_GLOBALS.element, found.snapshot.text]);
        assert.equal(byText.ok, true, 'the same element, found by its text');
        assert.equal(byText.fingerprint.css, found.fingerprint.css);

        const missing = await panel.evaluate(async ([id, globalName]) => {
          const { findTargetInPage } = await import('/src/background/wsOps.js');
          const [result] = await chrome.scripting.executeScript({
            target: { tabId: id }, args: [globalName, '#nothing-like-this', ''], func: findTargetInPage
          });
          return result.result;
        }, [tabId, CONTENT_GLOBALS.element]);
        assert.deepEqual(missing, { ok: false, reason: 'element-not-found' }, 'and an absent element is said to be absent');
      });

      /* ──────────────────── DoD 2: kill Chrome in the middle of a call ─────────── */

      await check('§16 M6 DoD 2: killing Chrome mid-call gives a clean error, not a hang', async (subtest) => {
        assert.equal(hubRig.hub.isConnected(), true, 'there is a browser to kill');
        const started = Date.now();
        // A tool the extension will be answering when the browser goes away.
        const call = callTool('reload', { tabId: 1 });
        await sleep(150);
        await ctx.close();
        ctx = null;

        const answer = await call;
        const waited = Date.now() - started;
        subtest.diagnostic(`the MCP call came back in ${waited} ms: ${answer.text}`);
        assert.equal(answer.isError, true, 'an error, not a made-up success');
        assert.match(answer.text, /disconnected|not connected|not responding/i, 'and it says what happened');
        assert.ok(waited < 20000, `${waited} ms — not the 30 s timeout, and not a hang`);
        assert.equal(hubRig.hub.pendingCount(), 0, 'nothing is left waiting for a browser that is gone');
      });
    } finally {
      try { if (client) await client.close(); } catch { /* already closed */ }
      try { if (mcpServer) await mcpServer.close(); } catch { /* already closed */ }
      try { if (ctx) await ctx.close(); } catch { /* already closed */ }
      if (hubRig) {
        hubRig.hub.close();
        await new Promise((resolve) => hubRig.server.close(resolve));
      }
      if (demoSite) await new Promise((resolve) => demoSite.server.close(resolve));
      fs.rmSync(profile, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.MOCKLAB_HOME;
      else process.env.MOCKLAB_HOME = previousHome;
    }
  });
}
