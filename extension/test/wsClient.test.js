/**
 * The socket that carries §12.4's ops: framing, auth, reconnect (`wsClient.js`).
 *
 * OWNER: mcp-engineer. The ops themselves are `wsOps.test.js`; this file is about the
 * §12.2 wire — a `req` answered by a `res` with the same id, a progress `event` that
 * names the call it belongs to, a `cancel` event that stops one op and no other, §12.3's
 * token in the handshake, and what happens when the socket goes away. Everything runs
 * against a fake WebSocket, so a frame is a value this file can read rather than
 * something to hope arrived.
 *
 * EVERY FIXTURE HERE IS PAIRED unless it says otherwise, because an unpaired MockLab
 * opens no socket at all (§12.3, and the header of the file under test): a helper that
 * left the token out would build a client that never connects, and every frame assertion
 * below would be checking a socket nobody dialled.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { INTERNAL_FAILURE } from '../src/background/wsOps.js';
import { createWsClient, KIND, HUB_OP, CLOSE, SUBPROTOCOL, TOKEN_SUBPROTOCOL_PREFIX, BACKOFF_MS } from '../src/background/wsClient.js';
import { S } from '../src/panel/strings.js';
import { fakeChrome } from '../testlib/fakeChrome.js';

const TOKEN = 'f'.repeat(64);
const settingsWith = (companionToken) => ({ advancedMode: false, paranoid: false, deepModeOrigins: [], companionToken });

/**
 * A chrome with the namespaces `start()` touches, on top of the shared storage fake —
 * plus the one the fake does not have: `storage.onChanged`. It is built here rather than
 * added to `testlib/fakeChrome.js` because that file belongs to another owner, and it is
 * needed at all because §12.3's pairing ends in a storage write that this module listens
 * for. Only `set` fires it, and only with the keys that changed, like the real one.
 */
async function chromeWith({ token = TOKEN } = {}) {
  const base = fakeChrome();
  const calls = [];
  const listeners = new Set();
  const local = {
    ...base.storage.local,
    async set(bag) {
      const before = await base.storage.local.get(Object.keys(bag));
      await base.storage.local.set(bag);
      const changes = {};
      for (const key of Object.keys(bag)) changes[key] = { oldValue: before[key], newValue: bag[key] };
      for (const listener of listeners) listener(changes, 'local');
    }
  };
  const api = {
    ...base,
    __calls: calls,
    storage: { local, onChanged: { addListener: (fn) => listeners.add(fn) } },
    alarms: { create: (...args) => calls.push(['alarm', ...args]), onAlarm: { addListener: () => {} } }
  };
  if (token) await base.storage.local.set({ settings: settingsWith(token) });
  globalThis.chrome = api;
  return api;
}

/* ─────────────────────────────────────────────────── §12.2 — the frames ─────────── */

/**
 * A WebSocket that records every handshake and every frame, and lets a test push frames
 * in. `instances` is in dial order, so a test can assert about the socket it means.
 */
function fakeSockets() {
  const seen = [];
  const instances = [];
  function Impl(url, protocols) {
    seen.push({ url, protocols });
    this.readyState = 1;
    this.sent = [];
    this.send = (text) => this.sent.push(JSON.parse(text));
    this.close = () => {
      this.readyState = 3;
      if (this.onclose) this.onclose({ code: 1000 });
    };
    instances.push(this);
    // A real socket that opens resets the backoff; a fake that never did would leave
    // every reconnect test waiting on a wait that only ever grew.
    setTimeout(() => this.onopen && this.onopen(), 0);
  }
  return { Impl, seen, instances, last: () => instances[instances.length - 1] };
}

/**
 * A promise that rejects rather than hanging — `hub.test.js` carries the same helper for
 * the same reason. A test that HANGS when the rule it checks is deleted reports nothing
 * at all: the cancel mutation below (drop the `cancel` event branch) left five subtests
 * neither passed nor failed, which is the one outcome a mutation matrix must not have.
 */
const within = (ms, what, promise) =>
  Promise.race([
    promise,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms))
  ]);

async function clientWith(ops, options = {}) {
  const api = await chromeWith(options);
  const sockets = fakeSockets();
  const client = createWsClient({
    dispatch: options.dispatch || (async () => undefined),
    portsFor: () => null,
    tabRecord: () => null,
    onPicked: () => {},
    chrome: api,
    ops,
    WebSocketImpl: sockets.Impl,
    ...(options.url ? { url: options.url } : {})
  });
  return { client, sockets, api, socket: () => sockets.last() };
}

test('§12.2 a req is answered by a res with the same id', async () => {
  const { client, socket } = await clientWith({ list_tabs: async () => ({ ok: true, tabs: [] }) });
  await client.start();
  await client.handleFrame({ id: 'abc', kind: KIND.REQ, op: 'list_tabs', payload: {} });
  const answered = socket().sent.find((frame) => frame.kind === KIND.RES);
  assert.deepEqual(answered, { id: 'abc', kind: KIND.RES, op: 'list_tabs', payload: { ok: true, tabs: [] } });
  client.stop();
});

test('§12.2 an op that throws is reported as MockLab\'s defect, not the page\'s', async () => {
  const { client, socket } = await clientWith({ list_tabs: async () => { throw new Error('boom'); } });
  await client.start();
  await client.handleFrame({ id: 'x', kind: KIND.REQ, op: 'list_tabs', payload: {} });
  const answered = socket().sent.find((frame) => frame.kind === KIND.RES);
  assert.deepEqual(answered.payload, INTERNAL_FAILURE);
  assert.equal(answered.payload.message, S.errors.pageBroke);
  client.stop();
});

test('§12.2 an op name the extension does not know is refused, not ignored', async () => {
  const { client, socket } = await clientWith({});
  await client.start();
  await client.handleFrame({ id: 'x', kind: KIND.REQ, op: 'rm_rf', payload: {} });
  assert.deepEqual(socket().sent.find((frame) => frame.kind === KIND.RES).payload, { ok: false, reason: 'unknown-op' });
  client.stop();
});

test('§12.2 a res or an event from the hub is not treated as a request', async () => {
  let ran = 0;
  const { client, socket } = await clientWith({ list_tabs: async () => { ran += 1; return { ok: true }; } });
  await client.start();
  await client.handleFrame({ id: 'x', kind: KIND.RES, op: 'list_tabs' });
  await client.handleFrame({ id: 'x', kind: KIND.EVENT, op: 'list_tabs' });
  await client.handleFrame(null);
  assert.equal(ran, 0);
  assert.equal(socket().sent.filter((frame) => frame.kind === KIND.RES).length, 0);
  client.stop();
});

test('§12.4 #5 progress from an op goes out as an event carrying that request\'s id', async () => {
  const { client, socket } = await clientWith({
    probe_element: async (_payload, progress) => {
      progress({ progress: 2, total: 8, message: 'x' });
      return { ok: true };
    }
  });
  await client.start();
  await client.handleFrame({ id: 'run-1', kind: KIND.REQ, op: 'probe_element', payload: {} });
  const event = socket().sent.find((frame) => frame.kind === KIND.EVENT);
  assert.equal(event.op, HUB_OP.PROGRESS);
  assert.equal(event.id, 'run-1', 'without the id the hub cannot tell which call it belongs to');
  assert.deepEqual(event.payload, { progress: 2, total: 8, message: 'x' });
  client.stop();
});

test('§7.1 a cancel event stops the op it names, and only it', async () => {
  // The MCP client walked away from a probe. Nothing here decides what stopping means —
  // that is `wsOps.js`, which runs CLEANUP — but the SIGNAL has to reach the right op,
  // because the thing being stopped is a page reloading in front of a person.
  const running = new Map();
  const op = (payload, _progress, signal) =>
    new Promise((resolve) => {
      running.set(payload.id, signal);
      signal.addEventListener('abort', () => resolve({ ok: false, reason: 'cancelled' }));
    });
  const { client, socket } = await clientWith({ probe_element: op });
  await client.start();

  const first = client.handleFrame({ id: 'run-a', kind: KIND.REQ, op: 'probe_element', payload: { id: 'a' } });
  const second = client.handleFrame({ id: 'run-b', kind: KIND.REQ, op: 'probe_element', payload: { id: 'b' } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(running.size, 2, 'both probes are running');

  await client.handleFrame({ id: 'run-a', kind: KIND.EVENT, op: HUB_OP.CANCEL, payload: {} });
  await within(2000, 'the cancelled op to end', first);
  assert.equal(running.get('a').aborted, true);
  assert.equal(running.get('b').aborted, false, 'a cancellation is about one call, not about the socket');

  const answered = socket().sent.filter((frame) => frame.kind === KIND.RES);
  assert.deepEqual(answered.map((frame) => frame.id), ['run-a']);
  assert.deepEqual(answered[0].payload, { ok: false, reason: 'cancelled' });

  // A cancellation for a call that already finished is not an error and not a request.
  await client.handleFrame({ id: 'run-a', kind: KIND.EVENT, op: HUB_OP.CANCEL, payload: {} });
  assert.equal(socket().sent.filter((frame) => frame.kind === KIND.RES).length, 1);

  await client.handleFrame({ id: 'run-b', kind: KIND.EVENT, op: HUB_OP.CANCEL, payload: {} });
  await within(2000, 'the second op to end', second);
  client.stop();
});

test('§12.3 an unpaired MockLab dials nothing, and pairing brings the socket up at once', async () => {
  // Both halves of §12.3's rule, in the order a user meets them. The first half is the
  // one that is easy to lose: a client that connects before there is anything to connect
  // to spends the session writing connection errors into a browser console for a feature
  // the user never turned on.
  const { client, sockets, api } = await clientWith({}, { token: null, url: 'ws://127.0.0.1:8517/ext' });
  await client.start();
  assert.deepEqual(sockets.seen, [], 'nothing is paired, so nothing is dialled');

  // The pairing socket, which is the one connection that may present no token.
  const answer = client.pair('123456');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sockets.seen.length, 1, 'pairing dials, because pairing is how a token arrives');
  assert.deepEqual(sockets.seen[0].protocols, [SUBPROTOCOL], 'and it has nothing to present yet');
  assert.equal(sockets.seen[0].url, 'ws://127.0.0.1:8517/ext', 'loopback, always (§12.3)');
  const submitted = sockets.instances[0].sent.find((frame) => frame.op === HUB_OP.PAIR);
  assert.deepEqual(submitted.payload, { code: '123456' }, 'the code goes up as the one req an unpaired socket may send');

  // The hub hands the token over. Storing it is what opens the ordinary connection —
  // from ANY MockLab context, which is why this listens to storage rather than to itself.
  sockets.instances[0].onmessage({ data: JSON.stringify({ id: 'pair', kind: KIND.RES, op: HUB_OP.PAIR, payload: { ok: true, token: TOKEN } }) });
  assert.deepEqual(await answer, { ok: true }, 'the panel is told it worked, and nothing more');
  const stored = await api.storage.local.get('settings');
  assert.equal(stored.settings.companionToken, TOKEN, 'stored for every later connection');

  assert.equal(sockets.seen.length, 2, 'the connection is made now, not after a 30-second backoff');
  assert.deepEqual(sockets.seen[1].protocols, [SUBPROTOCOL, TOKEN_SUBPROTOCOL_PREFIX + TOKEN]);
  client.stop();
});

test('§12.3 a settings write that is not a new token leaves a working socket alone', async () => {
  const { client, sockets, api } = await clientWith({});
  await client.start();
  assert.equal(sockets.seen.length, 1);
  await api.storage.local.set({ settings: settingsWith(TOKEN) });      // same token
  await api.storage.local.set({ settings: { ...settingsWith(TOKEN), advancedMode: true } });
  assert.equal(sockets.seen.length, 1, 'ticking "Advanced mode" must not drop the companion');
  client.stop();
});

test('§12.2 a socket closed as SUPERSEDED is not immediately reconnected', async () => {
  // Two MockLab connections taking the hub from each other is not a hypothetical: it
  // happened against the real hub, which logged twenty connections in twenty seconds
  // while a `reload` call waited for an answer no socket lived long enough to give.
  const { client, sockets } = await clientWith({});
  await client.start();
  assert.equal(sockets.instances.length, 1);

  // An ordinary drop reconnects (after a backoff, so nothing has opened yet).
  sockets.instances[0].onclose({ code: 1006 });
  assert.equal(sockets.instances.length, 1, 'the reconnect is scheduled, not immediate');
  await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[0] + 80));
  assert.equal(sockets.instances.length, 2, `an ordinary close reconnects after ${BACKOFF_MS[0]} ms`);

  // A supersede does not: another connection owns the hub, and racing it is a loop.
  // The wait is the LONGEST backoff, not the shortest: a reconnect this test failed to
  // wait for would read as a reconnect that never happened.
  sockets.instances[1].onclose({ code: CLOSE.SUPERSEDED });
  await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[1] + 300));
  assert.equal(sockets.instances.length, 2, 'a superseded client waits for the heartbeat instead of racing');
  client.stop();
});

test('§2 the reconnect backoff climbs and stops climbing, and start() arms the heartbeat', async () => {
  assert.deepEqual([...BACKOFF_MS].sort((a, b) => a - b), BACKOFF_MS, 'the wait only ever grows');
  assert.ok(BACKOFF_MS[0] <= 1000 && BACKOFF_MS[BACKOFF_MS.length - 1] <= 30000);
  const { client, api } = await clientWith({});
  await client.start();
  const alarm = api.__calls.find((call) => call[0] === 'alarm');
  assert.ok(alarm, '§2: a chrome.alarms heartbeat is the reconnect safety net');
  assert.ok(Math.abs(alarm[2].periodInMinutes * 60 - 25) < 0.01, '25 seconds, as §2 says');
  client.stop();
});

