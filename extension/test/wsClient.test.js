/**
 * The socket that carries §12.4's ops: framing, auth, reconnect (`wsClient.js`).
 *
 * OWNER: mcp-engineer. The ops themselves are `wsOps.test.js`; this file is about the
 * §12.2 wire — a `req` answered by a `res` with the same id, a progress `event` that
 * names the call it belongs to, §12.3's token in the handshake, and what happens when
 * the socket goes away. Everything runs against a fake WebSocket, so a frame is a value
 * this file can read rather than something to hope arrived.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { INTERNAL_FAILURE } from '../src/background/wsOps.js';
import { createWsClient, KIND, HUB_OP, CLOSE, SUBPROTOCOL, TOKEN_SUBPROTOCOL_PREFIX, BACKOFF_MS } from '../src/background/wsClient.js';
import { S } from '../src/panel/strings.js';
import { fakeChrome } from '../testlib/fakeChrome.js';

/** A chrome with the namespaces `start()` touches, on top of the shared storage fake. */
function chromeWith() {
  const base = fakeChrome();
  const calls = [];
  return {
    ...base,
    __calls: calls,
    alarms: { create: (...args) => calls.push(['alarm', ...args]), onAlarm: { addListener: () => {} } }
  };
}

/* ─────────────────────────────────────────────────── §12.2 — the frames ─────────── */

/** A socket that records what was sent and lets a test push frames in. */
function fakeSocket() {
  const sent = [];
  const socket = {
    readyState: 1,
    sent,
    send: (text) => sent.push(JSON.parse(text)),
    close: () => { socket.readyState = 3; if (socket.onclose) socket.onclose(); }
  };
  return socket;
}

function clientWith(ops) {
  const socket = fakeSocket();
  const api = chromeWith();
  globalThis.chrome = api;
  const client = createWsClient({
    dispatch: async () => undefined,
    portsFor: () => null,
    tabRecord: () => null,
    onPicked: () => {},
    chrome: api,
    ops,
    WebSocketImpl: function () {
      Object.assign(this, socket);
      socket.instance = this;
      return this;
    }
  });
  return { client, socket };
}

test('§12.2 a req is answered by a res with the same id', async () => {
  const { client, socket } = clientWith({ list_tabs: async () => ({ ok: true, tabs: [] }) });
  await client.start();
  const live = socket.instance;
  live.readyState = 1;
  live.send = socket.send;
  await client.handleFrame({ id: 'abc', kind: KIND.REQ, op: 'list_tabs', payload: {} });
  const answered = socket.sent.find((frame) => frame.kind === KIND.RES);
  assert.deepEqual(answered, { id: 'abc', kind: KIND.RES, op: 'list_tabs', payload: { ok: true, tabs: [] } });
  client.stop();
});

test('§12.2 an op that throws is reported as MockLab\'s defect, not the page\'s', async () => {
  const { client, socket } = clientWith({ list_tabs: async () => { throw new Error('boom'); } });
  await client.start();
  socket.instance.send = socket.send;
  await client.handleFrame({ id: 'x', kind: KIND.REQ, op: 'list_tabs', payload: {} });
  const answered = socket.sent.find((frame) => frame.kind === KIND.RES);
  assert.deepEqual(answered.payload, INTERNAL_FAILURE);
  assert.equal(answered.payload.message, S.errors.pageBroke);
  client.stop();
});

test('§12.2 an op name the extension does not know is refused, not ignored', async () => {
  const { client, socket } = clientWith({});
  await client.start();
  socket.instance.send = socket.send;
  await client.handleFrame({ id: 'x', kind: KIND.REQ, op: 'rm_rf', payload: {} });
  assert.deepEqual(socket.sent.find((frame) => frame.kind === KIND.RES).payload, { ok: false, reason: 'unknown-op' });
  client.stop();
});

test('§12.2 a res or an event from the hub is not treated as a request', async () => {
  let ran = 0;
  const { client, socket } = clientWith({ list_tabs: async () => { ran += 1; return { ok: true }; } });
  await client.start();
  socket.instance.send = socket.send;
  await client.handleFrame({ id: 'x', kind: KIND.RES, op: 'list_tabs' });
  await client.handleFrame({ id: 'x', kind: KIND.EVENT, op: 'list_tabs' });
  await client.handleFrame(null);
  assert.equal(ran, 0);
  assert.equal(socket.sent.filter((frame) => frame.kind === KIND.RES).length, 0);
  client.stop();
});

test('§12.4 #5 progress from an op goes out as an event carrying that request\'s id', async () => {
  const { client, socket } = clientWith({
    probe_element: async (_payload, progress) => {
      progress({ progress: 2, total: 8, message: 'x' });
      return { ok: true };
    }
  });
  await client.start();
  socket.instance.send = socket.send;
  await client.handleFrame({ id: 'run-1', kind: KIND.REQ, op: 'probe_element', payload: {} });
  const event = socket.sent.find((frame) => frame.kind === KIND.EVENT);
  assert.equal(event.op, HUB_OP.PROGRESS);
  assert.equal(event.id, 'run-1', 'without the id the hub cannot tell which call it belongs to');
  assert.deepEqual(event.payload, { progress: 2, total: 8, message: 'x' });
  client.stop();
});

test('§12.3 the token rides in the subprotocol, and an unpaired extension offers none', async () => {
  const seen = [];
  const api = chromeWith();
  globalThis.chrome = api;
  const socket = fakeSocket();
  const make = function (url, protocols) {
    seen.push({ url, protocols });
    Object.assign(this, socket);
    return this;
  };
  const client = createWsClient({
    dispatch: async () => undefined, portsFor: () => null, tabRecord: () => null,
    onPicked: () => {}, chrome: api, ops: {}, WebSocketImpl: make, url: 'ws://127.0.0.1:8517/ext'
  });

  await client.start();
  assert.deepEqual(seen[0].protocols, [SUBPROTOCOL], 'nothing to present yet');
  client.stop();

  await api.storage.local.set({ settings: { advancedMode: false, deepModeOrigins: [], companionToken: 'f'.repeat(64) } });
  const paired = createWsClient({
    dispatch: async () => undefined, portsFor: () => null, tabRecord: () => null,
    onPicked: () => {}, chrome: api, ops: {}, WebSocketImpl: make
  });
  await paired.start();
  assert.deepEqual(paired.OP_NAMES, []);
  assert.deepEqual(seen[1].protocols, [SUBPROTOCOL, TOKEN_SUBPROTOCOL_PREFIX + 'f'.repeat(64)]);
  assert.equal(seen[1].url, 'ws://127.0.0.1:8517/ext', 'loopback, always (§12.3)');
  paired.stop();
});

test('§12.2 a socket closed as SUPERSEDED is not immediately reconnected', async () => {
  // Two MockLab connections taking the hub from each other is not a hypothetical: it
  // happened against the real hub, which logged twenty connections in twenty seconds
  // while a `reload` call waited for an answer no socket lived long enough to give.
  let opened = 0;
  const api = chromeWith();
  globalThis.chrome = api;
  const sockets = [];
  const client = createWsClient({
    dispatch: async () => undefined, portsFor: () => null, tabRecord: () => null, onPicked: () => {},
    chrome: api, ops: {},
    WebSocketImpl: function () {
      opened += 1;
      this.readyState = 1;
      this.send = () => {};
      this.close = () => {};
      // A real socket that opens resets the backoff. Without this the fake stays on an
      // ever-growing wait, and a test that watched for a reconnect would see none
      // because it was still waiting — passing while the rule it checks was deleted.
      setTimeout(() => this.onopen && this.onopen(), 0);
      sockets.push(this);
      return this;
    }
  });
  await client.start();
  assert.equal(opened, 1);

  // An ordinary drop reconnects (after a backoff, so nothing has opened yet).
  sockets[0].onclose({ code: 1006 });
  assert.equal(opened, 1, 'the reconnect is scheduled, not immediate');
  await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[0] + 80));
  assert.equal(opened, 2, `an ordinary close reconnects after ${BACKOFF_MS[0]} ms`);

  // A supersede does not: another connection owns the hub, and racing it is a loop.
  // The wait is the LONGEST backoff, not the shortest: a reconnect this test failed to
  // wait for would read as a reconnect that never happened.
  sockets[1].onclose({ code: CLOSE.SUPERSEDED });
  await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[1] + 300));
  assert.equal(opened, 2, 'a superseded client waits for the heartbeat instead of racing');
  client.stop();
});

test('§2 the reconnect backoff climbs and stops climbing, and start() arms the heartbeat', async () => {
  assert.deepEqual([...BACKOFF_MS].sort((a, b) => a - b), BACKOFF_MS, 'the wait only ever grows');
  assert.ok(BACKOFF_MS[0] <= 1000 && BACKOFF_MS[BACKOFF_MS.length - 1] <= 30000);
  const { client, socket } = clientWith({});
  await client.start();
  const alarm = socket && globalThis.chrome.__calls.find((call) => call[0] === 'alarm');
  assert.ok(alarm, '§2: a chrome.alarms heartbeat is the reconnect safety net');
  assert.ok(Math.abs(alarm[2].periodInMinutes * 60 - 25) < 0.01, '25 seconds, as §2 says');
  client.stop();
});

