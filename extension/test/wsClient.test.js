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
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { INTERNAL_FAILURE } from '../src/background/wsOps.js';
import { createWsClient, KIND, HUB_OP, CLOSE, SUBPROTOCOL, TOKEN_SUBPROTOCOL_PREFIX, BACKOFF_MS } from '../src/background/wsClient.js';
import { S } from '../src/panel/strings.js';
import { fakeChrome } from '../testlib/fakeChrome.js';

const TOKEN = 'f'.repeat(64);
const settingsWith = (companionToken) => ({ advancedMode: false, paranoid: false, deepModeOrigins: [], companionToken });

/**
 * A chrome with the namespaces `start()` touches, on top of the shared storage fake —
 * plus the one the fake does not have: `storage.onChanged`. Built here rather than in
 * `testlib/fakeChrome.js` because that file belongs to another owner, and needed at all
 * because §12.3's pairing ends in a storage write this module listens for. Only `set`
 * fires it, and only with the keys that changed, like the real one.
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

/** A WebSocket that records every handshake and frame and lets a test push frames in.
 *  `instances` is in dial order, so a test can assert about the socket it means. */
function fakeSockets(options = {}) {
  const seen = [];
  const instances = [];
  /**
   * `opens` is mutable so ONE client can meet a companion that is there and then one that
   * is not — the only way to check that an attempt's observation is its own. A socket
   * that does not open behaves as a browser's does when the port is dead or the hub
   * answers the upgrade with 401 (§12.3, no window): `onerror`, `onclose`, no `onopen`.
   */
  const state = { opens: options.opens !== false, throws: options.throws === true };
  function Impl(url, protocols) {
    // A dial refused before there is an object to hand back: no socket, so no `onclose`
    // either, and nothing will ever arrive to answer a waiting pairing.
    if (state.throws) throw new Error('this browser refused to dial');
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
    setTimeout(() => {
      if (state.opens) {
        if (this.onopen) this.onopen();
        return;
      }
      this.readyState = 3;
      if (this.onerror) this.onerror({});
      if (this.onclose) this.onclose({ code: 1006 });
    }, 0);
  }
  return { Impl, seen, instances, state, last: () => instances[instances.length - 1] };
}

/**
 * A promise that rejects rather than hanging — `hub.test.js` carries the same helper for
 * the same reason. A test that HANGS when the rule it checks is deleted reports nothing at
 * all: the cancel mutation below (drop the `cancel` branch) left five subtests neither
 * passed nor failed, the one outcome a mutation matrix must not have.
 */
const within = (ms, what, promise) =>
  Promise.race([
    promise,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms))
  ]);

/**
 * Every client this file builds, stopped after the test that built it — WHETHER OR NOT
 * that test reached its own `client.stop()`.
 *
 * Found by mutation: a failed assertion leaves the reconnect timer armed, the timer
 * reopens a socket and arms another, and the process never drains its event loop, so
 * `node --test` reports NOTHING for the file — not a pass, not a failure. Mutation (a)
 * did exactly that, and the guard it was aimed at could not be shown to exist. A hang is
 * the one outcome that means nothing at all (`within` says the same about promises), and
 * here it was one assertion away from every test in the file.
 */
const livingClients = new Set();
afterEach(() => {
  for (const client of livingClients) client.stop();
  livingClients.clear();
});

async function clientWith(ops, options = {}) {
  const api = await chromeWith(options);
  const sockets = fakeSockets(options);
  const client = createWsClient({
    dispatch: options.dispatch || (async () => undefined),
    portsFor: () => null,
    tabRecord: () => null,
    onPicked: () => {},
    chrome: api,
    ops,
    WebSocketImpl: sockets.Impl,
    ...(options.onStatus ? { onStatus: options.onStatus } : {}),
    ...(options.url ? { url: options.url } : {})
  });
  livingClients.add(client);
  return { client, sockets, api, socket: () => sockets.last() };
}

/** A tick of the macrotask queue: the fake socket opens, or dies, on it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

/** What a promise is doing RIGHT NOW: awaiting to prove "still pending" proves nothing. */
async function pendingStill(promise) {
  const marker = Symbol('pending');
  return (await Promise.race([promise, Promise.resolve(marker)])) === marker;
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
  assert.deepEqual(
    await answer,
    { ok: true, reached: true },
    'the panel is told it worked; `reached` is this side\'s own note that a socket opened, not news from the hub'
  );
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


/* ──────────────────────── §12.3 — which refusal the panel is allowed to name ─────
 * `PAIR_FAIL` has two values because two distinctions exist, and one of them is not the
 * companion's: whether a socket ever opened is something this side WATCHES. `pairing.js`
 * answers all four of its refusal causes with one indistinguishable `false`, and these
 * tests keep that true from the extension's side — the only thing below that tells two
 * refusals apart is the transport, never the payload.
 * ─────────────────────────────────────────────────────────────────────────────────── */

test('§12.3 a pairing whose socket never opened is not reported as a refusal', async () => {
  // Two causes, one shape: the companion is not running, or it runs with no pairing
  // window and refuses the upgrade with a 401. Neither reaches OPEN, and `background.js`
  // turns both into NO_COMPANION — "start it again", not "check the code you typed".
  const { client, sockets } = await clientWith({}, { token: null, opens: false });
  await client.start();
  const answer = client.pair('123456');
  assert.deepEqual(
    await within(2000, 'the pairing to be answered', answer),
    { ok: false, reached: false },
    'nothing opened, so nothing refused anything'
  );
  assert.equal(sockets.instances.length, 1, 'it did dial — the answer is about that dial, not about not trying');
  assert.equal(sockets.instances[0].sent.length, 0, 'and the code never went out: nobody was there to send it to');
  client.stop();
});

test('§12.3 a companion that answered no is told apart from one that was never there', async () => {
  const { client, sockets } = await clientWith({}, { token: null });
  await client.start();
  const answer = client.pair('000000');
  await settle();
  assert.equal(sockets.instances[0].sent.find((frame) => frame.op === HUB_OP.PAIR).payload.code, '000000');

  // §12.3's whole refusal vocabulary, as it arrives on the wire: one `false`.
  sockets.instances[0].onmessage({ data: JSON.stringify({ id: 'pair', kind: KIND.RES, op: HUB_OP.PAIR, payload: { ok: false } }) });
  assert.deepEqual(
    await within(2000, 'the refusal to be answered', answer),
    { ok: false, reached: true },
    'the socket opened and was told no — REFUSED, and still no word on which of the four reasons'
  );
  client.stop();
});

test('§12.3 an attempt\'s observation belongs to that attempt and no later one', async () => {
  // The leak this pins: one `reached` beside the socket rather than on the attempt.
  // Attempt 1 opens and is refused; attempt 2 never opens. If the flag outlived attempt
  // 1, the panel would say "check the code" about a companion since shut down.
  const { client, sockets } = await clientWith({}, { token: null });
  await client.start();
  const first = client.pair('111111');
  await settle();
  sockets.instances[0].onmessage({ data: JSON.stringify({ id: 'pair', kind: KIND.RES, op: HUB_OP.PAIR, payload: { ok: false } }) });
  assert.deepEqual(await within(2000, 'the first pairing', first), { ok: false, reached: true });

  sockets.state.opens = false;                       // the user quits the companion
  const second = client.pair('222222');
  assert.deepEqual(
    await within(2000, 'the second pairing', second),
    { ok: false, reached: false },
    'the second attempt reports its own socket, not the first attempt\'s'
  );
  client.stop();
});

test('§12.3 a socket from an abandoned attempt cannot answer the attempt that replaced it', async () => {
  // A real close completes a task or two after `close()` returns, so the socket `pair()`
  // drops can still fire `onclose` once the NEXT attempt is under way. However that
  // stale close is handled, it must not be by answering the new attempt: the answer
  // would carry the old attempt's `reached`, before the new socket had done anything.
  const { client, sockets } = await clientWith({}, { token: null });
  await client.start();
  const first = client.pair('111111');
  await settle();
  const stale = sockets.instances[0];
  stale.close = () => { stale.readyState = 3; };     // closes, but tells nobody yet

  const second = client.pair('222222');
  assert.deepEqual(
    await within(2000, 'the abandoned attempt', first),
    { ok: false, reached: true },
    'the attempt that was replaced is answered by the call that replaced it, not left hanging'
  );
  await settle();
  stale.onclose({ code: 1006 });                     // the real close, arriving late
  assert.equal(await pendingStill(second), true, 'the new attempt is still waiting on its own socket');

  sockets.last().onmessage({ data: JSON.stringify({ id: 'pair', kind: KIND.RES, op: HUB_OP.PAIR, payload: { ok: true, token: TOKEN } }) });
  assert.deepEqual(await within(2000, 'the second pairing', second), { ok: true, reached: true });
  client.stop();
});

/* ──────────────────────────── §10.5 — the dot follows the socket ────────────────── */

test('§10.5 the status callback fires when the socket opens and when it closes, with nothing to carry', async () => {
  const calls = [];
  // RECORDED, not asserted in place: `notifyStatus` catches what the callback throws
  // (a panel-side failure must not break the socket), so an assertion made in here
  // would be swallowed and the test would pass whatever happened.
  const { client, sockets } = await clientWith({}, { onStatus: (...args) => calls.push(args.length) });
  await client.start();
  await settle();
  assert.deepEqual(calls, [0], 'the socket opened: read it again — and the event carries no state to go stale');

  sockets.instances[0].onclose({ code: 1006 });
  assert.deepEqual(calls, [0, 0], 'and a companion that died while Settings was open says so');
  client.stop();
});

test('§10.5 a client with no status callback works, and says nothing about not having one', async () => {
  // Every other fixture here builds one without `onStatus`; this says so out loud,
  // because the dep is optional and a missing one must not throw inside `onopen`.
  // The console is watched because that is the only place a missing optional dep shows
  // up: `notifyStatus` catches what it calls, so calling an `onStatus` that is not there
  // raises a TypeError into that catch and logs a MockLab defect once per socket event,
  // for every user who never set up AI access. No behaviour differs — which is why
  // dropping the `typeof` check failed no test until this line existed.
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const { client, sockets } = await clientWith({}, { token: null });
    await client.start();
    const answer = client.pair('123456');
    await settle();
    sockets.instances[0].onmessage({ data: JSON.stringify({ id: 'pair', kind: KIND.RES, op: HUB_OP.PAIR, payload: { ok: true, token: TOKEN } }) });
    assert.deepEqual(await within(2000, 'the pairing', answer), { ok: true, reached: true });
    await settle();
    client.stop();
  } finally {
    console.error = realError;
  }
  assert.deepEqual(errors, [], 'four status moments passed with no listener, and none of them was an error');
});

test('§10.5 one successful pairing moves the dot once, and never through green on the way', async () => {
  // The four fires and the one transition, as the file header sets them out. Each value
  // recorded is what the panel would read back: a pairing socket is open but is not a
  // connection an agent can use, and §11's "Connected — AI agents can control this site"
  // beside a socket no `req` will ever arrive on is a small wrong "Verified ✓" (§17.12).
  const seen = [];
  let client;
  const { client: made, sockets, api } = await clientWith(
    {},
    { token: null, onStatus: () => seen.push(client.isConnected()) }
  );
  client = made;
  await client.start();
  assert.deepEqual(seen, [], 'an unpaired MockLab dials nothing, so there is nothing to report');

  const answer = client.pair('123456');
  await settle();
  assert.deepEqual(seen, [false], '1. the pairing socket opened — open, but not a connection');

  sockets.instances[0].onmessage({ data: JSON.stringify({ id: 'pair', kind: KIND.RES, op: HUB_OP.PAIR, payload: { ok: true, token: TOKEN } }) });
  assert.deepEqual(await within(2000, 'the pairing', answer), { ok: true, reached: true });
  assert.deepEqual(seen, [false, false, false], '2. the token was stored  3. the pairing socket closed');
  assert.equal((await api.storage.local.get('settings')).settings.companionToken, TOKEN);

  await settle();
  assert.deepEqual(seen, [false, false, false, true], '4. the token socket opened — the one transition');
  assert.equal(client.isConnected(), true);
  client.stop();
});

test('§12.3 a dial the browser refuses outright is answered, not left waiting', async () => {
  // `new WebSocket` can throw instead of returning a socket, and then no handler runs at
  // all. Found by mutation — the settle on that path was the one guard here nothing
  // exercised — and without it §10.5's pairing screen waits on an event that cannot come.
  const { client, sockets } = await clientWith({}, { token: null, throws: true });
  await client.start();
  assert.deepEqual(
    await within(2000, 'the refused dial to be answered', client.pair('123456')),
    { ok: false, reached: false },
    'nothing was dialled, so nothing opened — NO_COMPANION, and an answer rather than a spinner'
  );
  assert.deepEqual(sockets.instances, []);
  client.stop();
});

test('§10.5 a status listener that throws does not take the socket down with it', async () => {
  // `onStatus` is `background.js`'s broadcast, which §17.5 says rejects when no panel is
  // listening. However that fails, it is the CALLER's failure: the close handler's other
  // job is the reconnect, and a companion that came back would never be found again if a
  // listener could skip it.
  const { client, sockets } = await clientWith({}, { onStatus: () => { throw new Error('no panel'); } });
  await client.start();
  await settle();
  assert.equal(sockets.instances.length, 1, 'it opened despite the listener throwing on open');

  sockets.instances[0].onclose({ code: 1006 });
  await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[0] + 80));
  assert.equal(sockets.instances.length, 2, 'and the reconnect below the notification still ran');
  client.stop();
});
