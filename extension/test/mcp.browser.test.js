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
 *   3. a wrong pairing code is rejected;
 *
 *   4. `probe_element` runs end to end and returns a link nothing but a probe may produce;
 *   5. an agent that abandons a probe stops it in the browser, and leaves no mock behind.
 *
 * ── TWO HUBS, AND WHY ──────────────────────────────────────────────────────────────
 * Every tool check runs against the extension's OWN socket — the one `background.js`
 * opens — so `portsFor`, `pickApi` and the router are the shipping ones and nothing here
 * is stubbed. That client dials `ws://127.0.0.1:8517/ext` and only that, because a
 * shipped extension has no configuration; so this suite puts a hub on §12.1's real port
 * for it. If that port is taken (a companion the developer left running), every tool
 * check SKIPS with that reason rather than failing.
 *
 * The pairing checks need a second hub on a random port, because they need a client this
 * file can drive — `pair(code)` is called from the panel's Settings screen in the
 * product, and that screen is not built yet. They must not share a hub with the worker's
 * client either: §12.2 keeps ONE extension connection, so two authenticated clients from
 * one browser would supersede each other for as long as both lived.
 *
 * Nothing plants a token: the pairing checks pair for real, and the worker's own socket
 * comes up because of it. That is the wiring under test.
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

import { loadChromium, launchExtension, createFixture, recordWorkerErrors } from '../testlib/browserFixture.js';
import { CONTENT_GLOBALS, PROBE_MSG, PROBE_PHASE, PROBE_FAIL } from '../src/background/messages.js';

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
    let swErrors = null;
    let panel = null;
    let hubRig = null;
    let demo = { value: null, why: null };
    let worker = { value: null, why: null };
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

      // §12.1's real port, for the socket `background.js` opens on its own. Optional:
      // a developer with a companion already running should get skips, not failures.
      worker = await optional("companion hub on §12.1's port", 10000, async () => {
        const { createHub, HUB_PATH } = await import('../../companion/src/hub.js');
        const { createPairing, loadOrCreateToken } = await import('../../companion/src/pairing.js');
        const { token } = loadOrCreateToken();
        const lines = [];
        const hub = createHub({ pairing: createPairing({ token }), log: (line) => lines.push(line) });
        const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
        hub.attach(server);
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(8517, '127.0.0.1', resolve);
        });
        return { hub, server, lines };
      });

      ctx = await stage('chromium launch + extension load', 60000, () => launchExtension(chromium, profile), {
        absent: 'Chromium could not be launched'
      });
      sw = await stage('service-worker registration', 20000, async () =>
        ctx.serviceWorkers()[0] || ctx.waitForEvent('serviceworker', { timeout: 20000 })
      );
      swErrors = await stage('service-worker error recorder', 10000, () => recordWorkerErrors(ctx, sw));
      panel = await stage('panel page', 30000, async () => {
        const page = await ctx.newPage();
        await page.goto(sw.url().split('/src/')[0] + '/src/panel/panel.html');
        return page;
      });

      // The MCP client the checks below drive, over the SDK's own transport pair. It
      // talks to the hub the EXTENSION'S OWN client dials, so every answer below comes
      // back through the shipping wiring.
      const rig = await stage('MCP client', 10000, async () => {
        const { createMcpServer } = await import('../../companion/src/mcpServer.js');
        const server = createMcpServer({ hub: (worker.value || hubRig).hub });
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
    const workerHub = worker.value;
    /** Why a check that needs the extension's own socket cannot run, or null. */
    const noWorkerHub = workerHub
      ? null
      : `port 8517 could not be taken, so the extension's own client has no hub — ${worker.why}`;

    /** Wait for `condition`, or return false after `ms`. Never a bare sleep on a socket. */
    const until = async (ms, condition) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (await condition()) return true;
        await sleep(100);
      }
      return false;
    };

    /**
     * §14's trip source, once this page load has captured it.
     *
     * Polled, not read once: several checks reload the tab, and captures are per page
     * load (§4) — a `list_sources` fired at a document that is still loading answers an
     * empty list, correctly, and a test that read it as "the demo has no data" would be
     * reporting its own impatience as a defect.
     */
    const tripSource = async (tabId) => {
      let sources = [];
      await until(15000, async () => {
        const answer = await callTool('list_sources', { tabId });
        sources = answer.isError ? [] : answer.json().sources;
        return sources.some((source) => source.url.includes('trip.json'));
      });
      return sources.find((source) => source.url.includes('trip.json')) || null;
    };

    /** Every Change in the browser's store, mocks and probe scaffolding alike (§17.5). */
    const storedChanges = () =>
      panel.evaluate(async () => {
        const bag = await chrome.storage.local.get(null);
        return Object.entries(bag).filter(([key]) => key.startsWith('changes:')).flatMap(([, list]) => list);
      });

    /**
     * A client in the PANEL page, used for one thing only: §12.3's pairing, which in the
     * product is driven from a Settings screen that is not built yet. Its deps are stubs
     * because nothing but `pair()` is asked of it — every tool check below goes through
     * the worker's own client instead, which has the real ones.
     */
    const startClient = (code, urlOverride) =>
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
          portsFor: () => new Set([{}]),
          tabRecord: () => null,
          onPicked: () => {},
          chrome: window.chrome
        });
        window.mocklabTestClient = client;
        if (pairingCode !== null) {
          // Bounded, for the same reason `within` exists in `wsClient.test.js`: the
          // interesting refusals here are the ones where NOTHING arrives, and a `pair()`
          // that never settled would hang this suite instead of failing it. The sentinel
          // is a shape no real answer has, so it can only ever read as a failure.
          return Promise.race([
            client.pair(pairingCode),
            new Promise((resolve) => setTimeout(() => resolve({ neverAnswered: true }), 8000))
          ]);
        }
        await client.start();
        return { ok: true };
      }, [urlOverride || (hubRig ? hubRig.url : ''), code === undefined ? null : code]);

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
        assert.deepEqual(refused, { ok: false, reached: true }, 'told no over a socket that opened: PAIR_FAIL.REFUSED');
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

      await check('§12.3 a companion that never opens a socket is NO_COMPANION, either way it happens', async () => {
        // §11's two refusals are decided at the TRANSPORT, and this is the branch a
        // person actually hits. `wsClient.test.js` drives it with a fake socket that
        // declines to open; only here is it a real Chromium WebSocket meeting a real
        // closed port, and a real 401 from the real hub.
        assert.ok(hubRig, 'the hub started');
        const net = await import('node:net');
        const deadPort = await new Promise((resolve) => {
          const probe = net.createServer();
          probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
          });
        });

        const notRunning = await startClient('123456', `ws://127.0.0.1:${deadPort}/ext`);
        assert.deepEqual(notRunning, { ok: false, reached: false }, 'nothing is listening, so nothing opened');
        await stopClient();

        // The other cause, and the one no fake can imitate: a companion that IS running
        // and refuses the upgrade outright because no pairing window is open (§12.3, a
        // 401 before any WebSocket exists). Indistinguishable from the first at the
        // socket, which is the point — both are fixed by starting the companion again,
        // neither by retyping the code.
        hubRig.pairing.close();
        const noWindow = await startClient('123456');
        assert.deepEqual(noWindow, { ok: false, reached: false }, 'refused at the upgrade: still no OPEN');
        assert.equal(hubRig.hub.isConnected(), false, 'and no authenticated socket came of it');
        const stored = await panel.evaluate(() => chrome.storage.local.get('settings'));
        assert.ok(!stored.settings || !stored.settings.companionToken, 'nothing was stored either');
        await stopClient();
      });

      await check('§12.3 the right code hands the token over, and the extension reconnects with it', async () => {
        const { code } = hubRig.pairing.open();
        const paired = await startClient(code);
        assert.deepEqual(paired, { ok: true, reached: true });
        const stored = await panel.evaluate(() => chrome.storage.local.get('settings'));
        assert.equal(stored.settings.companionToken, hubRig.token, 'stored for every later connection');

        await startClient();   // ordinary start: presents the token in the handshake
        assert.equal(await until(4000, async () => hubRig.hub.isConnected()), true, 'the hub has one authenticated extension');
      });

      await check("§2 the extension's OWN socket comes up, because pairing happened", async (subtest) => {
        // Nobody started this one. The service worker did, at load, and it waited for a
        // token because §12.3 says an unpaired browser has nothing to connect to; the
        // pairing above is what let it dial. If `background.js` ever loses the wiring
        // block, this is the check that says so — and every tool check below it, which
        // has no other socket to travel on, says it again.
        if (noWorkerHub) {
          subtest.skip(noWorkerHub);
          return;
        }
        // The panel's client is stopped first: two authenticated clients from one browser
        // would supersede each other, and one of them would be the one under test.
        await stopClient();
        const connected = await until(15000, async () => workerHub.hub.isConnected());
        assert.equal(connected, true, `the worker never dialled 8517 — hub log: ${JSON.stringify(workerHub.lines)}`);
        subtest.diagnostic(`the extension connected on its own: ${workerHub.lines.join(' | ')}`);
      });

      /* ────────────────── DoD 1: the agent happy path, on the demo site ────────── */

      await check('§16 M6 DoD 1: list_tabs -> list_sources -> set_value -> reload -> screenshot', async (subtest) => {
        if (noWorkerHub || !demoSite) {
          subtest.skip(noWorkerHub || `the demo server did not start — ${demo.why}`);
          return;
        }
        demoPage = await ctx.newPage();
        await demoPage.goto(`${demoSite.origin}/demo/`);
        await demoPage.waitForSelector('#status-pill');
        await sleep(600);
        const tabId = await tabIdOf(demoPage);

        const tabs = await callTool('list_tabs', {});
        assert.equal(tabs.isError, false, tabs.text);
        const offered = tabs.json().tabs;
        assert.ok(offered.some((tab) => tab.tabId === tabId), 'the demo tab is offered to the agent');
        // §12.4 #1: "Only tabs where MockLab has a live content-script connection." The
        // panel page is open and is not one, which is the filter working — and it is the
        // worker's own live Port set doing the filtering, which no stub could show.
        assert.equal(offered.some((tab) => tab.url.startsWith('chrome-extension://')), false);

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
        if (noWorkerHub || !demoSite || !demoPage) {
          subtest.skip(noWorkerHub || 'the happy-path check did not get far enough to leave a change behind');
          return;
        }
        const tabId = await tabIdOf(demoPage);
        assert.equal((await storedChanges()).length, 1, 'the agent\'s change is in the shared store (§1.6)');

        const cleared = await callTool('clear_changes', { tabId, refresh: true });
        assert.equal(cleared.isError, false, cleared.text);
        assert.deepEqual(await storedChanges(), [], '"Reset site" through MCP is the same reset (§1.5)');
      });

      await check('§10.4 a Scenario an agent saves is one a person can see, apply and delete', async (subtest) => {
        if (noWorkerHub || !demoSite || !demoPage) {
          subtest.skip(noWorkerHub || 'the demo page never loaded');
          return;
        }
        const tabId = await tabIdOf(demoPage);
        const trip = await tripSource(tabId);
        assert.ok(trip, 'the demo source is there to build a scenario from');
        await callTool('set_value', { tabId, sigId: trip.sigId, path: '$.status', value: 'DELAYED', refresh: false });

        const saved = await callTool('save_preset', { tabId, name: 'Flight delayed', emoji: '🎬' });
        assert.equal(saved.isError, false, saved.text);
        const presetId = saved.json().preset.id;

        const listed = await callTool('list_presets', { tabId });
        assert.equal(listed.isError, false, listed.text);
        assert.equal(listed.json().presets.length, 1, `§10.4's card list, read by an agent: ${listed.text}`);
        assert.equal(listed.json().presets[0].name, 'Flight delayed');

        await callTool('clear_changes', { tabId, refresh: false });
        assert.deepEqual(await storedChanges(), [], 'the site is back to real data before applying');

        const applied = await callTool('apply_preset', { tabId, presetId, refresh: true });
        assert.equal(applied.isError, false, applied.text);
        assert.equal(applied.json().applied, 1, `§1.1: applied and unapplied are counted apart — ${applied.text}`);
        const back = await storedChanges();
        assert.equal(back.length, 1, 'the scenario put its change back');
        assert.equal(back[0].value, 'DELAYED');

        const deleted = await callTool('delete_preset', { presetId, tabId });
        assert.equal(deleted.isError, false, deleted.text);
        assert.equal((await callTool('list_presets', { tabId })).json().presets.length, 0);
        assert.equal((await storedChanges()).length, 1, 'deleting the bundle does not switch its change off');
        await callTool('clear_changes', { tabId, refresh: true });
        subtest.diagnostic('save -> list -> apply -> delete, all four over MCP');
      });

      await check('§10.3 highlight reports what it drew, and whether it was proved', async (subtest) => {
        if (noWorkerHub || !demoSite || !demoPage) {
          subtest.skip(noWorkerHub || 'the demo page never loaded');
          return;
        }
        await demoPage.waitForSelector('#status-pill');
        const tabId = await tabIdOf(demoPage);
        const trip = await tripSource(tabId);
        assert.ok(trip, 'the demo source is loaded');
        // A field whose value the page actually PRINTS: the soft-highlight is a text
        // search (§10.2), and asking it to find "ON_TIME" — which the demo renders as
        // "On time" — would be asserting that a guess fails, not that highlight works.
        const drawn = await callTool('highlight', { tabId, sigId: trip.sigId, path: '$.flight.number' });
        assert.equal(drawn.isError, false, drawn.text);
        // Nothing has been probed on this page load, so §10.3's honest answer is a GUESS
        // — drawn dashed for a person, and labelled `verified:false` for an agent.
        assert.equal(drawn.json().verified, false, `§0.2: a value match is not a proof — ${drawn.text}`);
        assert.ok(drawn.json().elements >= 1, `the flight number was outlined: ${drawn.text}`);
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

      /* ─────────── §12.4 #5: the whole probe, over MCP, through the real worker ── */

      await check('§16 M4+M6: probe_element proves the demo pill, and only a probe may', async (subtest) => {
        if (noWorkerHub || !demoSite || !demoPage) {
          subtest.skip(noWorkerHub || 'the demo page never loaded');
          return;
        }
        await demoPage.waitForFunction(
          () => {
            const node = document.querySelector('#status-pill');
            return Boolean(node && node.textContent.trim().length > 0);
          },
          null,
          { timeout: 10000 }
        );
        const tabId = await tabIdOf(demoPage);
        const notes = [];
        const started = Date.now();
        const answer = await client.callTool(
          { name: 'probe_element', arguments: { tabId, selector: '#status-pill' } },
          undefined,
          { timeout: 210000, onprogress: (note) => notes.push(note) }
        );
        const text = answer.content.find((part) => part.type === 'text').text;
        assert.equal(Boolean(answer.isError), false, text);
        const result = JSON.parse(text);
        subtest.diagnostic(`probe took ${Math.round((Date.now() - started) / 1000)}s and ${result.reloads} reloads`);

        assert.equal(result.binding.state, 'verified', '§17.4: written by probe.js and by nothing else');
        assert.equal(result.binding.path, '$.status', `§16's M4 DoD, reached over MCP: ${text}`);
        // §7.6: one probe finds every element the field drives — the pill AND the banner.
        const css = result.elements.map((element) => element.css).join(' ');
        assert.ok(result.elements.length >= 2, `the banner was found too: ${css}`);
        assert.ok(/alert-banner/.test(css), `§14's second element is in the binding: ${css}`);
        assert.ok(result.observedValues.includes('ON_TIME'), `the real values seen: ${JSON.stringify(result.observedValues)}`);

        // §12.4 #5's progress notifications, delivered by a real MCP client.
        assert.ok(notes.length >= 2, `expected a notification at each state change, got ${notes.length}`);
        assert.ok(notes.some((note) => /refresh|Learning|Testing|Double/i.test(String(note.message))),
          `§11 writes the words an agent sees: ${JSON.stringify(notes.map((note) => note.message))}`);

        // §7.1's CLEANUP: the experiment leaves nothing of itself behind (§17.5).
        assert.deepEqual(await storedChanges(), [], 'no probe scaffolding survived the run');
        const bindings = await callTool('get_bindings', { tabId });
        assert.equal(bindings.json().bindings.some((binding) => binding.state === 'verified'), true,
          'and the panel reads the same proved link out of the same store (§1.6)');
      });

      await check('§7.1 an agent that abandons a probe stops it in the browser', async (subtest) => {
        if (noWorkerHub || !demoSite || !demoPage) {
          subtest.skip(noWorkerHub || 'the demo page never loaded');
          return;
        }
        const tabId = await tabIdOf(demoPage);
        const controller = new AbortController();
        const call = client.callTool(
          { name: 'probe_element', arguments: { tabId, selector: '#status-pill' } },
          undefined,
          { timeout: 210000, signal: controller.signal }
        );
        call.catch(() => {});   // the cancellation is the point; the rejection is expected

        // Wait until the run is really under way — cancelling before it starts would
        // prove only that an unstarted probe stops.
        const running = await until(20000, async () =>
          (await storedChanges()).some((change) => change && change.probe === true)
        );
        assert.equal(running, true, 'the probe put its own scaffolding on the site');

        controller.abort();
        await assert.rejects(call, 'the agent\'s call ends at once');

        // WHAT THIS HAS TO SEPARATE: the demo probes in about five seconds, so "the site
        // came back" is true a moment later whether the run was stopped or simply
        // finished. The evidence that it was STOPPED is how the run ended — the panel's
        // own view of it, which is where a person watching would read the same thing.
        let ended = null;
        const finished = await until(25000, async () => {
          ended = await panel.evaluate(
            ([type, id]) => chrome.runtime.sendMessage({ type, payload: { tabId: id } }),
            [PROBE_MSG.GET_PROBE, tabId]
          );
          return ended && ended.phase !== PROBE_PHASE.RUNNING;
        });
        assert.equal(finished, true, `the run never ended: ${JSON.stringify(ended)}`);
        assert.equal(ended.failure, PROBE_FAIL.CANCELLED, `it was stopped, not merely finished: ${JSON.stringify(ended)}`);
        assert.equal(ended.binding, null, '§17.4: a cancelled run proves nothing');

        const cleaned = await until(20000, async () => (await storedChanges()).length === 0);
        assert.equal(cleaned, true,
          `§17.5: every probe:true Change is deleted in CLEANUP — left over: ${JSON.stringify(await storedChanges())}`);
        subtest.diagnostic('cancelled over MCP; the run ended as cancelled and the site was put back');
      });

      /* ──────────────────── DoD 2: kill Chrome in the middle of a call ─────────── */

      // BEFORE the check that closes the browser: fifteen tools have just been driven
      // through the worker, and nothing in this suite was in a position to notice if any
      // of them logged. This suite never made the claim at all — the other five browser
      // suites made it with `worker.on('console')`, which records nothing (see
      // `recordWorkerErrors`). Made here for the first time, and made for real.
      await check('the service worker logged no errors while the tools ran', () =>
        swErrors.assertClean());

      await check('§16 M6 DoD 2: killing Chrome mid-call gives a clean error, not a hang', async (subtest) => {
        if (noWorkerHub) {
          subtest.skip(noWorkerHub);
          return;
        }
        assert.equal(workerHub.hub.isConnected(), true, 'there is a browser to kill');
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
        assert.equal(workerHub.hub.pendingCount(), 0, 'nothing is left waiting for a browser that is gone');
      });
    } finally {
      try { if (client) await client.close(); } catch { /* already closed */ }
      try { if (mcpServer) await mcpServer.close(); } catch { /* already closed */ }
      try { if (ctx) await ctx.close(); } catch { /* already closed */ }
      if (hubRig) {
        hubRig.hub.close();
        await new Promise((resolve) => hubRig.server.close(resolve));
      }
      if (workerHub) {
        workerHub.hub.close();
        await new Promise((resolve) => workerHub.server.close(resolve));
      }
      if (demoSite) await new Promise((resolve) => demoSite.server.close(resolve));
      fs.rmSync(profile, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.MOCKLAB_HOME;
      else process.env.MOCKLAB_HOME = previousHome;
    }
  });
}
