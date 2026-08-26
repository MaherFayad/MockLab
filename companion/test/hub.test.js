/**
 * The hub the extension talks on (PLAN.md §12.2, §12.3).
 *
 * OWNER: mcp-engineer. Every test here drives a REAL socket against a REAL server,
 * because the whole subject of this file is a handshake — a fake would be asserting
 * about the fake.
 *
 * §14's demo site moved to `demo.test.js` when this file passed §17.10's budget. The
 * seam was already written in this header: those tests serve static files and open no
 * socket, these open nothing else. Pairing lives in `pairing.test.js`, the MCP surface
 * in `mcp.test.js`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';

import { HOST, HUB_PORT } from '../src/index.js';
import { TOOL_NAMES } from '../src/mcpServer.js';
import { createPairing } from '../src/pairing.js';
import {
  createHub,
  checkUpgrade,
  bearerToken,
  KIND,
  HUB_OP,
  HUB_PATH,
  SUBPROTOCOL,
  TOKEN_SUBPROTOCOL_PREFIX,
  EXTENSION_TIMEOUT_MESSAGE,
  NOT_CONNECTED_MESSAGE,
  DISCONNECTED_MESSAGE,
  CANCELLED_MESSAGE,
  REQUEST_TIMEOUT_MS
} from '../src/hub.js';

const TOKEN = 'a1b2c3d4'.repeat(8);
const EXTENSION_ORIGIN = 'chrome-extension://' + 'a'.repeat(32);

/** A hub on a real loopback port, with a pairing window open unless told otherwise. */
async function startHub({ open = true } = {}) {
  const lines = [];
  const pairing = createPairing({ token: TOKEN, onRefusal: (why) => lines.push(why) });
  const hub = createHub({ pairing, log: (line) => lines.push(line) });
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  hub.attach(server);
  await new Promise((resolve) => server.listen(0, HOST, resolve));
  const code = open ? pairing.open().code : null;
  return {
    hub,
    pairing,
    lines,
    code,
    url: `ws://${HOST}:${server.address().port}${HUB_PATH}`,
    async close() {
      hub.close();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

/** Connect, and resolve when the socket opens or the upgrade is refused. */
function connect(url, { token, origin, protocols } = {}) {
  const headers = {};
  if (origin) headers.origin = origin;
  if (token) headers.authorization = `Bearer ${token}`;
  const socket = new WebSocket(url, protocols, { headers });
  socket.frames = [];
  socket.on('message', (data) => socket.frames.push(JSON.parse(String(data))));
  return new Promise((resolve) => {
    socket.on('open', () => resolve({ socket, ok: true, status: 101 }));
    socket.on('unexpected-response', (_req, res) => resolve({ socket, ok: false, status: res.statusCode }));
    socket.on('error', () => resolve({ socket, ok: false, status: 0 }));
  });
}

/** The next frame this socket receives, or null after `ms`. */
function nextFrame(socket, ms = 2000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    socket.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(data)));
    });
  });
}

/**
 * A promise that rejects rather than hanging. Every wait below is bounded: a test that
 * hangs when the rule it checks is removed reports nothing at all — it just stops the
 * run, which is how a mutation that should be loud becomes a silence.
 */
function within(ms, what, promise) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms))
  ]);
}

/** An extension that answers every request with `answer(frame)`. */
function answerWith(socket, answer) {
  socket.on('message', (data) => {
    const frame = JSON.parse(String(data));
    if (frame.kind !== KIND.REQ) return;
    const payload = answer(frame, socket);
    if (payload !== undefined) {
      socket.send(JSON.stringify({ id: frame.id, kind: KIND.RES, op: frame.op, payload }));
    }
  });
}

test('the companion binds to loopback only (PLAN.md §12.3)', () => {
  assert.equal(HOST, '127.0.0.1');
  assert.equal(HUB_PORT, 8517);
});

test('the 15 MCP tool names in PLAN.md §12.4 are declared', () => {
  assert.equal(TOOL_NAMES.length, 15);
  assert.ok(TOOL_NAMES.includes('probe_element'));
  assert.equal(new Set(TOOL_NAMES).size, 15);
});

/* ══════════════════════════ §12.2 / §12.3 — the hub (M6) ══════════════════════════ */

test('§12.3 an upgrade is judged on path, host and origin before any socket exists', () => {
  const at = (headers, url = HUB_PATH) => checkUpgrade({ url, headers });
  const good = { host: '127.0.0.1:8517' };

  assert.deepEqual(at(good), { ok: true }, 'a local client with no Origin is the CLI case');
  assert.deepEqual(at({ ...good, origin: EXTENSION_ORIGIN }), { ok: true });
  assert.deepEqual(at({ ...good, origin: 'https://evil.example' }).why, 'origin',
    'a WEB PAGE can open a WebSocket to loopback; this check is what stops it');
  assert.deepEqual(at({ ...good, origin: 'http://127.0.0.1:8517' }).why, 'origin',
    'including a page served by the companion itself — the demo is not the extension');
  assert.deepEqual(at({ ...good, origin: 'null' }).why, 'origin');
  assert.deepEqual(at({ ...good, origin: 'chrome-extension://short' }).why, 'origin');
  assert.deepEqual(at({ host: 'evil.example:8517' }).why, 'host', 'DNS rebinding');
  assert.deepEqual(at({ host: 'localhost:8517' }), { ok: true });
  assert.deepEqual(at(good, '/mcp').why, 'path');
  assert.deepEqual(at(good, HUB_PATH + '?x=1'), { ok: true }, 'a query string is not a path');
});

test('§12.3 the token is read from either header form', () => {
  assert.equal(bearerToken({ headers: { authorization: `Bearer ${TOKEN}` } }), TOKEN);
  assert.equal(bearerToken({ headers: { authorization: `bearer ${TOKEN.toUpperCase()}` } }), TOKEN);
  assert.equal(
    bearerToken({ headers: { 'sec-websocket-protocol': `${SUBPROTOCOL}, ${TOKEN_SUBPROTOCOL_PREFIX}${TOKEN}` } }),
    TOKEN,
    'the browser cannot set Authorization on a WebSocket handshake — see hub.js'
  );
  assert.equal(bearerToken({ headers: {} }), '');
  assert.equal(bearerToken({ headers: { authorization: TOKEN } }), '', 'a bare token is not a Bearer header');
});

test('§12.3 with no pairing window, an unauthenticated socket is refused with nothing said', async (t) => {
  const rig = await startHub({ open: false });
  try {
    const refused = await connect(rig.url, { origin: EXTENSION_ORIGIN });
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 401, 'refused at the upgrade, before a WebSocket exists');
    assert.equal(rig.hub.isConnected(), false);

    const page = await connect(rig.url, { origin: 'https://evil.example' });
    assert.equal(page.status, 403, 'a web page is refused for a different reason, and told neither');
    t.diagnostic(`refusals logged locally: ${rig.lines.length}`);
  } finally {
    await rig.close();
  }
});

test('§12.3 a wrong code over a real socket returns {ok:false} and nothing else', async () => {
  const rig = await startHub();
  try {
    const { socket, ok } = await connect(rig.url, { origin: EXTENSION_ORIGIN });
    assert.equal(ok, true, 'an open pairing window lets an unpaired extension in');
    const wrong = String((Number(rig.code) + 1) % 1000000).padStart(6, '0');
    socket.send(JSON.stringify({ id: '1', kind: KIND.REQ, op: HUB_OP.PAIR, payload: { code: wrong } }));
    const answer = await nextFrame(socket);
    assert.deepEqual(answer, { id: '1', kind: KIND.RES, op: HUB_OP.PAIR, payload: { ok: false } });
    assert.equal(JSON.stringify(answer).includes(TOKEN), false, 'no token, no reason, no hint');

    // And the socket is still only allowed to pair: an op frame on it does nothing.
    socket.send(JSON.stringify({ id: '2', kind: KIND.REQ, op: 'list_tabs', payload: {} }));
    assert.equal(await nextFrame(socket, 300), null, 'an unpaired socket cannot call a tool');
    socket.close();
  } finally {
    await rig.close();
  }
});

test('§12.3 the right code hands the token over, and the token then opens the socket', async () => {
  const rig = await startHub();
  try {
    const first = await connect(rig.url, { origin: EXTENSION_ORIGIN });
    first.socket.send(JSON.stringify({ id: '1', kind: KIND.REQ, op: HUB_OP.PAIR, payload: { code: rig.code } }));
    const answer = await nextFrame(first.socket);
    assert.equal(answer.payload.ok, true);
    assert.equal(answer.payload.token, TOKEN);
    assert.equal(rig.hub.isConnected(), false, 'pairing does not itself authenticate the socket');
    first.socket.close();

    const second = await connect(rig.url, { origin: EXTENSION_ORIGIN, token: answer.payload.token });
    assert.equal(second.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(rig.hub.isConnected(), true);
    second.socket.close();
  } finally {
    await rig.close();
  }
});

test('§12.3 the token also arrives as a subprotocol, which is all a browser can send', async () => {
  const rig = await startHub({ open: false });
  try {
    const { socket, ok } = await connect(rig.url, {
      origin: EXTENSION_ORIGIN,
      protocols: [SUBPROTOCOL, TOKEN_SUBPROTOCOL_PREFIX + TOKEN]
    });
    assert.equal(ok, true, 'no pairing window is needed once the extension holds the token');
    assert.equal(socket.protocol, SUBPROTOCOL, 'the hub never echoes the token subprotocol back');
    socket.close();

    const wrong = await connect(rig.url, {
      origin: EXTENSION_ORIGIN,
      protocols: [SUBPROTOCOL, TOKEN_SUBPROTOCOL_PREFIX + 'b'.repeat(64)]
    });
    assert.equal(wrong.status, 401, 'a token that is not the token is not a token');
  } finally {
    await rig.close();
  }
});

test('§12.2 a request goes out as a req frame and comes back by id', async () => {
  const rig = await startHub();
  try {
    const { socket } = await connect(rig.url, { origin: EXTENSION_ORIGIN, token: TOKEN });
    const seen = [];
    answerWith(socket, (frame) => {
      seen.push(frame);
      return { ok: true, echoed: frame.payload };
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const answer = await rig.hub.request('list_sources', { tabId: 7 });
    assert.deepEqual(answer, { ok: true, echoed: { tabId: 7 } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].kind, KIND.REQ);
    assert.equal(seen[0].op, 'list_sources');
    assert.ok(seen[0].id, 'every request carries an id, or two calls could not overlap');
    assert.equal(rig.hub.pendingCount(), 0, 'an answered request is not still pending');
    socket.close();
  } finally {
    await rig.close();
  }
});

test('§12.2 two calls in flight at once do not get each other\'s answers', async () => {
  const rig = await startHub();
  try {
    const { socket } = await connect(rig.url, { origin: EXTENSION_ORIGIN, token: TOKEN });
    // Answer the SECOND request first: an id that was ignored would cross the wires.
    const held = [];
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data));
      held.push(frame);
      if (held.length === 2) {
        for (const pending of held.reverse()) {
          socket.send(JSON.stringify({ id: pending.id, kind: KIND.RES, op: pending.op, payload: { ok: true, op: pending.op } }));
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [a, b] = await Promise.all([
      rig.hub.request('list_tabs', {}),
      rig.hub.request('list_sources', { tabId: 1 })
    ]);
    assert.deepEqual([a.op, b.op], ['list_tabs', 'list_sources']);
    socket.close();
  } finally {
    await rig.close();
  }
});

test('§16 M6 DoD: killing the browser mid-call fails the call at once, and honestly', async () => {
  const rig = await startHub();
  try {
    const { socket } = await connect(rig.url, { origin: EXTENSION_ORIGIN, token: TOKEN });
    answerWith(socket, () => undefined); // takes the request, never answers
    await new Promise((resolve) => setTimeout(resolve, 50));

    const started = Date.now();
    const call = rig.hub.request('screenshot', { tabId: 1 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    socket.terminate(); // Chrome was killed

    const err = await call.then(() => null, (e) => e);
    const waited = Date.now() - started;
    assert.ok(err, 'a call whose socket died must reject');
    assert.equal(err.code, 'disconnected');
    assert.equal(err.message, DISCONNECTED_MESSAGE);
    assert.ok(waited < 2000, `rejected in ${waited} ms, not after the ${REQUEST_TIMEOUT_MS} ms timeout`);
    assert.equal(rig.hub.pendingCount(), 0);
    assert.equal(rig.hub.isConnected(), false);
  } finally {
    await rig.close();
  }
});

test('§12.2 a silent extension times out with the sentence §12.2 wrote', async () => {
  const rig = await startHub();
  try {
    const { socket } = await connect(rig.url, { origin: EXTENSION_ORIGIN, token: TOKEN });
    answerWith(socket, () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const err = await within(
      5000,
      'the 60 ms timeout',
      rig.hub.request('reload', { tabId: 1 }, { timeoutMs: 60 })
    ).then(() => null, (e) => e);
    assert.equal(err.code, 'timeout', `the call must not be left waiting: ${err && err.message}`);
    assert.equal(err.message, EXTENSION_TIMEOUT_MESSAGE);
    assert.equal(rig.hub.pendingCount(), 0, 'a timed-out call is forgotten, not leaked');

    // A late answer to a forgotten call must not resolve anything or throw.
    socket.send(JSON.stringify({ id: 'nobody', kind: KIND.RES, op: 'reload', payload: { ok: true } }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(rig.hub.isConnected(), true);
    socket.close();
  } finally {
    await rig.close();
  }
});

test('§12.2 with no extension at all, a call says so instead of waiting 30 seconds', async () => {
  const rig = await startHub();
  try {
    const started = Date.now();
    const err = await rig.hub.request('list_tabs', {}).then(() => null, (e) => e);
    assert.equal(err.code, 'not-connected');
    assert.equal(err.message, NOT_CONNECTED_MESSAGE);
    assert.ok(Date.now() - started < 500);
  } finally {
    await rig.close();
  }
});

test('§12.2 the hub keeps ONE extension connection: newest wins', async () => {
  const rig = await startHub();
  try {
    const first = await connect(rig.url, { origin: EXTENSION_ORIGIN, token: TOKEN });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const closed = new Promise((resolve) => first.socket.on('close', (code) => resolve(code)));

    const second = await connect(rig.url, { origin: EXTENSION_ORIGIN, token: TOKEN });
    answerWith(second.socket, () => ({ ok: true, from: 'second' }));
    assert.equal(
      await within(3000, 'the superseded socket closing', closed),
      4002,
      'the older socket is closed, not left half-alive'
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(
      await within(5000, 'an answer from the newest socket', rig.hub.request('list_tabs', {})),
      { ok: true, from: 'second' }
    );
    first.socket.close();
    second.socket.close();
  } finally {
    await rig.close();
  }
});

test('closing the hub closes every socket it accepted, not only the current one', async () => {
  const rig = await startHub();
  const first = await connect(rig.url, { origin: EXTENSION_ORIGIN, token: TOKEN });
  const second = await connect(rig.url, { origin: EXTENSION_ORIGIN, token: TOKEN });
  const bothClosed = Promise.all([first, second].map(({ socket }) =>
    socket.readyState === socket.CLOSED ? null : new Promise((resolve) => socket.on('close', resolve))
  ));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await rig.close();
  await within(3000, 'both sockets closing', bothClosed);
  assert.equal(rig.hub.isConnected(), false);
});

test('§12.4 #5 progress events reach the call they belong to, and only it', async () => {
  const rig = await startHub();
  try {
    const { socket } = await connect(rig.url, { origin: EXTENSION_ORIGIN, token: TOKEN });
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data));
      if (frame.kind !== KIND.REQ) return;
      socket.send(JSON.stringify({ id: frame.id, kind: KIND.EVENT, op: HUB_OP.PROGRESS, payload: { progress: 1, total: 8 } }));
      socket.send(JSON.stringify({ id: 'someone-else', kind: KIND.EVENT, op: HUB_OP.PROGRESS, payload: { progress: 99 } }));
      socket.send(JSON.stringify({ id: frame.id, kind: KIND.RES, op: frame.op, payload: { ok: true } }));
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const updates = [];
    const answer = await rig.hub.request('probe_element', { tabId: 1 }, { onProgress: (u) => updates.push(u) });
    assert.deepEqual(answer, { ok: true });
    assert.deepEqual(updates, [{ progress: 1, total: 8 }], 'a progress frame for another id is not this call\'s');
    socket.close();
  } finally {
    await rig.close();
  }
});

test('§7.1 a cancelled call tells the BROWSER to stop, and stops waiting itself', async () => {
  const rig = await startHub();
  try {
    const { socket } = await connect(rig.url, { origin: EXTENSION_ORIGIN, token: TOKEN });
    const asked = [];
    socket.on('message', (data) => asked.push(JSON.parse(String(data))));   // answers nothing, like a running probe
    await new Promise((resolve) => setTimeout(resolve, 50));

    const controller = new AbortController();
    const call = rig.hub.request('probe_element', { tabId: 1 }, { timeoutMs: 30_000, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const request = asked.find((frame) => frame.kind === KIND.REQ);
    assert.ok(request, 'the probe is running in the browser');

    controller.abort();
    const error = await within(2000, 'the cancelled call to come back', call.then(() => null, (err) => err));
    assert.equal(error.code, 'cancelled');
    assert.equal(error.message, CANCELLED_MESSAGE);
    assert.equal(rig.hub.pendingCount(), 0, 'and it is not left waiting out the 30 seconds');

    await new Promise((resolve) => setTimeout(resolve, 50));
    const cancellation = asked.find((frame) => frame.op === HUB_OP.CANCEL);
    assert.ok(cancellation, 'the browser was told — otherwise the page keeps reloading in front of a person');
    assert.equal(cancellation.kind, KIND.EVENT, 'an event: a req reusing this id would come back as this call\'s answer');
    assert.equal(cancellation.id, request.id, 'and it names the call to stop, not the socket');
    socket.close();
  } finally {
    await rig.close();
  }
});

test('§7.1 a signal that fires after the answer cancels nothing', async () => {
  const rig = await startHub();
  try {
    const { socket } = await connect(rig.url, { origin: EXTENSION_ORIGIN, token: TOKEN });
    const asked = [];
    socket.on('message', (data) => asked.push(JSON.parse(String(data))));
    answerWith(socket, () => ({ ok: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const controller = new AbortController();
    assert.deepEqual(await rig.hub.request('reload', { tabId: 1 }, { signal: controller.signal }), { ok: true });
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(asked.some((frame) => frame.op === HUB_OP.CANCEL), false, 'a finished call is not a running one');

    // Already aborted before the call: the browser is never asked to do the work at all.
    const before = asked.length;
    const error = await rig.hub.request('reload', { tabId: 1 }, { signal: controller.signal }).then(() => null, (err) => err);
    assert.equal(error.code, 'cancelled');
    assert.equal(asked.length, before, 'nothing went to the browser');
    socket.close();
  } finally {
    await rig.close();
  }
});

test('§12.2 the hub caches the latest store per origin, and labels nothing as live', async () => {
  const rig = await startHub();
  try {
    const { socket } = await connect(rig.url, { origin: EXTENSION_ORIGIN, token: TOKEN });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(rig.hub.cachedStore('https://demo.test'), null);

    socket.send(JSON.stringify({
      kind: KIND.EVENT,
      op: HUB_OP.STORE_CHANGED,
      payload: { origin: 'https://demo.test', changes: [{ id: 'c1' }], bindings: [], presets: [] }
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const cached = rig.hub.cachedStore('https://demo.test');
    assert.equal(cached.changes.length, 1);
    assert.ok(cached.cachedAt > 0, 'a cached answer carries WHEN it was true');
    assert.equal(rig.hub.cachedOrigins().length, 1);

    socket.send(JSON.stringify({
      kind: KIND.EVENT,
      op: HUB_OP.STORE_CHANGED,
      payload: { origin: 'https://demo.test', changes: [], bindings: [], presets: [] }
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(rig.hub.cachedStore('https://demo.test').changes.length, 0, 'latest, not first');
    socket.close();
  } finally {
    await rig.close();
  }
});

test('a frame that is not JSON, or not a frame, does not take the socket down', async () => {
  const rig = await startHub();
  try {
    const { socket } = await connect(rig.url, { origin: EXTENSION_ORIGIN, token: TOKEN });
    answerWith(socket, () => ({ ok: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.send('not json at all');
    socket.send(JSON.stringify(null));
    socket.send(JSON.stringify({ kind: 'nonsense' }));
    socket.send(JSON.stringify({ kind: KIND.RES, id: 'never-asked', payload: { ok: true } }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(rig.hub.isConnected(), true);
    assert.deepEqual(await rig.hub.request('list_tabs', {}), { ok: true });
    socket.close();
  } finally {
    await rig.close();
  }
});
