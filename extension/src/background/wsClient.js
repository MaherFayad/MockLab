/**
 * WebSocket client to the companion daemon: connect, reconnect, auth, pairing.
 *
 * OWNER: mcp-engineer. Implements PLAN.md §2.2, §12.2, §12.3.
 *
 * The fifteen things an agent can ASK for live in `wsOps.js` — the §17.10 split, at the
 * seam the companion has too (`hub.js` is the socket, `tools.js` is the tools). This
 * file knows how to hold a socket open and how to prove who it is; it does not know what
 * any op means, and it may not: an op that needed to know it was reached over a
 * WebSocket would be an op the panel could not also reach (§1.6).
 *
 * ── §12.2's frame contract ─────────────────────────────────────────────────────────
 *   {id, kind:"req"|"res"|"event", op, payload}
 * The hub sends `req`; this answers with a `res` carrying the same id. `event` goes the
 * other way: `progress` during a long op (§12.4 #5) and `storeChanged` whenever the
 * store moves, which is what lets the hub answer a read instantly mid-navigation.
 *
 * ── §12.3's auth, and the one place it deviates ────────────────────────────────────
 * §12.3 says the token rides in an `Authorization: Bearer` header on the upgrade. The
 * browser has no way to set a header on a WebSocket handshake — `new WebSocket(url,
 * protocols)` is the whole API a service worker gets — so it rides in the one header the
 * browser does populate, `Sec-WebSocket-Protocol`, as `mocklab.token.<hex>`. Same
 * handshake, same loopback socket, and not in the URL where it would land in logs.
 * §17.11: prefer the working behaviour and record it. `hub.js` reads both forms.
 *
 * ── WIRING (background.js) ─────────────────────────────────────────────────────────
 * A service worker cannot `chrome.runtime.sendMessage` to itself, so this module cannot
 * reach the panel's handlers on its own. `background.js` hands its router over —
 * `routeMessage`, the one the `onMessage` listener uses — together with `pickApi`'s own
 * `onPicked`. Both are deliberate: an agent's call lands in the handler a person's click
 * lands in (§1.6), and `probe_element` fills the SAME pick record a human pick fills, so
 * there is one path to a verified Binding rather than two (§17.4, §17.12).
 *
 * ── WHEN THIS CONNECTS, AND WHEN IT DOES NOT ───────────────────────────────────────
 * Only once the browser has been paired (§12.3). Before that there is no token, the hub
 * would refuse the socket anyway unless a pairing window happens to be open, and a
 * client that retried a port nobody is listening on every 25 seconds would spend the
 * rest of the user's browsing session writing connection errors into their console for
 * a feature they never asked for. `pair()` opens without one — that is what pairing is —
 * and the moment a token lands in storage the socket goes up, from whichever window did
 * the pairing.
 */

import { MSG } from './messages.js';
import { getSettings, updateSettings } from './ruleStore.js';
import { createOps, INTERNAL_FAILURE } from './wsOps.js';

/** §12.1: the hub, on loopback, always. */
export const HUB_URL = 'ws://127.0.0.1:8517/ext';
/** §12.2's frame kinds. */
export const KIND = Object.freeze({ REQ: 'req', RES: 'res', EVENT: 'event' });
/**
 * The ops that travel in the extension -> hub direction.
 *
 * `CAPTURED` is §12.2's second event and is NOT SENT by this file — stated here rather
 * than left to be discovered from a constant that never appears again. Captures live in
 * the service worker's own per-tab map, which this module cannot observe: the wiring
 * block hands over the ROUTER, not the capture path, and the throttled 2/s push belongs
 * beside `onCaptured` in the worker rather than behind a poll from here. Nothing depends
 * on it today: the hub's cache is the STORE (§12.2's sentence), and every source an agent
 * reads comes from a live `list_sources`.
 */
export const HUB_OP = Object.freeze({
  PAIR: 'pair',
  STORE_CHANGED: 'storeChanged',
  CAPTURED: 'captured',
  PROGRESS: 'progress',
  /**
   * The one op that travels hub -> extension as an EVENT rather than a `req`: MCP's own
   * cancellation, carrying the id of the call to stop. It is an event and not a request
   * on purpose — a `req` reusing that id would be answered with a `res` bearing the same
   * id, which is exactly the frame the hub reads as "the call finished".
   */
  CANCEL: 'cancel'
});
/**
 * Close codes the hub uses, which this side must act on differently (`hub.js` names the
 * same two — `mcp.test.js` compares the two tables, because they are one contract).
 *
 * 4002 SUPERSEDED is the one that matters. §12.2 says the hub keeps ONE extension
 * connection and the newest wins, so a second MockLab — another profile, a panel left
 * open in a second window, a reload that outran its own teardown — will be closed with
 * it. Reconnecting immediately after that is a LOOP: two clients take the socket from
 * each other for ever, and while they do, no tool call can survive long enough to be
 * answered. Found by driving the real thing: a `reload` call timed out at 20 s against a
 * hub that logged twenty "extension connected" lines in those 20 seconds.
 */
export const CLOSE = Object.freeze({ UNAUTHORIZED: 4001, SUPERSEDED: 4002 });

/** The subprotocols of §12.3's handshake — see the header for why the token rides here. */
export const SUBPROTOCOL = 'mocklab.v1';
export const TOKEN_SUBPROTOCOL_PREFIX = 'mocklab.token.';

/** §2: "a chrome.alarms heartbeat every 25s as a reconnect safety net". */
export const HEARTBEAT_ALARM = 'mocklab-companion-heartbeat';
export const HEARTBEAT_MINUTES = 25 / 60;
/** Reconnect backoff: quick at first, then out of the way. */
export const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

/**
 * @param {{
 *   dispatch: (message:{type:string, payload:any}) => Promise<any>,
 *   resolveTabId?: (requested:any) => Promise<number|null>,
 *   portsFor: (tabId:number) => Set<any>|null,
 *   tabRecord: (tabId:number) => {origin:string, sources:Map<string,any>}|null,
 *   onPicked: (tabId:number, picked:any) => Promise<void>|void,
 *   url?: string,
 *   WebSocketImpl?: any,
 *   chrome?: any,
 *   ops?: Record<string, Function>
 * }} deps
 */
export function createWsClient(deps) {
  const api = deps.chrome || globalThis.chrome;
  const Socket = deps.WebSocketImpl || globalThis.WebSocket;
  const url = deps.url || HUB_URL;
  const OPS = deps.ops || createOps(deps);

  let socket = null;
  let attempts = 0;
  let stopped = true;
  let reconnectTimer = null;
  let pairWaiter = null;
  /** The token the live socket presented, so a token that CHANGES reconnects and one that did not, does not. */
  let presented = null;
  /** @type {Map<string, AbortController>} in-flight ops, by the frame id that started them. */
  const inflight = new Map();

  function post(frame) {
    try {
      if (socket && socket.readyState === 1) socket.send(JSON.stringify(frame));
    } catch {
      /* the socket died between the check and the send */
    }
  }

  /**
   * One `req` from the hub: run the op, answer with its id.
   *
   * An op that THROWS is a defect in MockLab, not a finding about the page, and it is
   * reported as one — `internal`, with §11's `errors.pageBroke` beside it. Reporting a
   * crash as a result about the site is the same class of lie as a false "Verified ✓"
   * (§17.12), told to an audience that will repeat it in prose.
   */
  async function handleFrame(frame) {
    if (!frame) return;
    if (frame.kind === KIND.EVENT && frame.op === HUB_OP.CANCEL) {
      const running = inflight.get(frame.id);
      if (running) running.abort();
      return;
    }
    if (frame.kind !== KIND.REQ) return;
    const run = OPS[frame.op];
    if (!run) {
      post({ id: frame.id, kind: KIND.RES, op: frame.op, payload: { ok: false, reason: 'unknown-op' } });
      return;
    }
    const cancel = new AbortController();
    inflight.set(frame.id, cancel);
    let payload;
    try {
      payload = await run(
        frame.payload || {},
        (update) => post({ id: frame.id, kind: KIND.EVENT, op: HUB_OP.PROGRESS, payload: update }),
        cancel.signal
      );
    } catch (err) {
      console.error('[MockLab] companion op failed', frame.op, err);
      payload = INTERNAL_FAILURE;
    } finally {
      inflight.delete(frame.id);
    }
    post({ id: frame.id, kind: KIND.RES, op: frame.op, payload });
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const wait = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
    attempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void open();
    }, wait);
  }

  function closeSocket() {
    if (!socket) return;
    try {
      socket.close();
    } catch {
      /* already gone */
    }
    socket = null;
  }

  /**
   * One connection attempt. With a token the socket presents it (§12.3); a PAIRING
   * attempt connects without one, which the hub refuses outright unless a pairing window
   * is open — that refusal is the whole of the access control.
   *
   * An unpaired browser with no code to submit opens nothing at all: see the header. The
   * heartbeat and the reconnect timer both come through here, so that decision is made
   * once, for every path that can reach a socket.
   */
  async function open(codeToSubmit) {
    if (socket) return;
    const settings = await getSettings();
    const token = settings.companionToken;
    if (!token && !codeToSubmit) return;
    const protocols = token ? [SUBPROTOCOL, TOKEN_SUBPROTOCOL_PREFIX + token] : [SUBPROTOCOL];
    presented = token || null;
    let ws;
    try {
      ws = new Socket(url, protocols);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      attempts = 0;
      if (codeToSubmit) post({ id: 'pair', kind: KIND.REQ, op: HUB_OP.PAIR, payload: { code: codeToSubmit } });
    };
    ws.onmessage = (event) => {
      let frame = null;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (frame && frame.kind === KIND.RES && frame.op === HUB_OP.PAIR) {
        void finishPairing(frame.payload);
        return;
      }
      void handleFrame(frame);
    };
    ws.onclose = (event) => {
      if (socket === ws) socket = null;
      if (pairWaiter) {
        pairWaiter({ ok: false });
        pairWaiter = null;
      }
      // Another connection now owns the hub. Do not race it — the 25 s heartbeat tries
      // again, so if that one goes away this one comes back, without a loop in between.
      if (event && event.code === CLOSE.SUPERSEDED) return;
      scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows; a lone error handler must not double-schedule a reconnect */
    };
  }

  /**
   * The answer to a pairing attempt. The token is stored, and the socket is dropped
   * either way: the next connection presents the token in the handshake, so exactly one
   * code path — the one every ordinary connection takes — grants access.
   */
  async function finishPairing(payload) {
    const ok = Boolean(payload && payload.ok === true && payload.token);
    if (ok) await updateSettings({ companionToken: payload.token });
    const waiter = pairWaiter;
    pairWaiter = null;
    closeSocket();
    // The storage write above reaches every context including this one, so the ordinary
    // token-presenting connection is opened by `watchStore`. Opening it here as well
    // would be a second path to the same socket, and `open()` already refuses the second.
    if (ok) {
      attempts = 0;
      void open();
    }
    if (waiter) waiter({ ok });
  }

  /**
   * The extension's half of §12.2's `storeChanged` — what the hub caches per origin —
   * and the one thing that makes pairing take effect NOW.
   *
   * §12.3's flow ends with a token in `chrome.storage.local`, written by whichever
   * extension page ran the pairing. Every other MockLab context sees that write here, and
   * the one that owns the socket acts on it: without this, a user who has just typed the
   * six digits waits out a backoff — up to 30 seconds of a Settings screen that still
   * says "Not connected" after they did everything right (§1.1's calmer, more honest
   * option is also the one that is simply true sooner).
   */
  function watchStore() {
    if (!api.storage || !api.storage.onChanged) return;
    api.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.settings) {
        const token = (changes.settings.newValue && changes.settings.newValue.companionToken) || null;
        // Only a token this socket is not already presenting: an ordinary settings write
        // (advanced mode, deep mode) must not drop a working connection.
        //
        // And never while a pairing is in flight — the write that ends §12.3's handshake
        // arrives HERE as well, and closing the pairing socket from under `finishPairing`
        // makes its own `onclose` answer the waiting panel `{ok:false}` about a pairing
        // that had just succeeded. `finishPairing` opens the token connection itself.
        if (token && token !== presented && !pairWaiter) {
          attempts = 0;
          closeSocket();
          void open();
        }
      }
      const origins = new Set();
      for (const key of Object.keys(changes)) {
        const cut = key.indexOf(':');
        if (cut !== -1) origins.add(key.slice(cut + 1));
      }
      for (const origin of origins) void pushStore(origin);
    });
  }

  async function pushStore(origin) {
    if (!socket || !origin) return;
    const [changes, bindings, presets] = await Promise.all([
      deps.dispatch({ type: MSG.LIST_CHANGES, payload: { origin } }),
      deps.dispatch({ type: MSG.GET_BINDINGS, payload: { origin } }),
      deps.dispatch({ type: MSG.LIST_PRESETS, payload: { origin } })
    ]);
    post({
      kind: KIND.EVENT,
      op: HUB_OP.STORE_CHANGED,
      payload: {
        origin,
        changes: (changes && changes.changes) || [],
        bindings: (bindings && bindings.bindings) || [],
        // `[]` rather than absent when a handler is missing: an empty list the hub caches
        // is only ever served with `fromCache` on it, and the tool call itself answers
        // out of the live path, where an unrouted type still says so (§1.1).
        presets: (presets && presets.presets) || []
      }
    });
  }

  return {
    /** §12.4's fifteen, as this side spells them — checked against the companion's list. */
    OP_NAMES: Object.freeze(Object.keys(OPS)),
    /** Exposed so a test can drive one frame without a socket. */
    handleFrame,
    isConnected: () => Boolean(socket && socket.readyState === 1),

    async start() {
      stopped = false;
      watchStore();
      if (api.alarms) {
        api.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_MINUTES });
        api.alarms.onAlarm.addListener((alarm) => {
          // `stopped` is checked here too: stop() must mean stopped, or the heartbeat
          // quietly reopens a connection the caller closed 25 seconds earlier.
          if (alarm && alarm.name === HEARTBEAT_ALARM && !socket && !stopped) void open();
        });
      }
      await open();
    },

    stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      closeSocket();
    },

    /**
     * §12.3's pairing, from the panel's "set up AI access" flow. Resolves `{ok}` and
     * nothing else — the hub tells this side no more than that, deliberately.
     */
    async pair(code) {
      closeSocket();
      stopped = false;
      const answer = new Promise((resolve) => {
        pairWaiter = resolve;
      });
      await open(String(code || ''));
      return answer;
    }
  };
}
