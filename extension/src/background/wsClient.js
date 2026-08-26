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
 * ── §10.5's STATUS DOT, AND HOW MANY TIMES IT MOVES ────────────────────────────────
 * `onStatus()` is an optional, argument-free "read it again" for `background.js`, which
 * turns it into `MSG.COMPANION_CHANGED`. It fires when a socket OPENS, when one CLOSES,
 * and when a pairing stores a token — the three moments `GET_COMPANION`'s two booleans
 * can move. It is deliberately given nothing to carry: a dot fed from the event would be
 * as old as the event, and the panel re-reading is what keeps it honest (§1.1).
 *
 * One successful pairing therefore fires it FOUR times, in this order:
 *   1. the pairing socket opens          → connected:false, paired:false
 *   2. the token is stored               → connected:false, paired:true
 *   3. the pairing socket closes         → connected:false, paired:true
 *   4. the token socket opens            → connected:true,  paired:true
 * and the dot moves ONCE, at 4. Neither 1 nor 3 is suppressed — the case that matters is
 * the companion dying while Settings is open, and a rule of the form "not that close, it
 * doesn't count" is how that one gets lost too. They are SILENT rather than skipped,
 * because a pairing socket is not a connection: see `isConnected`, which draws with
 * `presented` the line the hub draws with `live`. Three extra reads of a two-boolean
 * answer is the price; the alternative is deciding per socket which closes are worth
 * mentioning, and paying in wrong colours on the screen.
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
 *   onStatus?: () => void,
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
  /**
   * The pairing attempt in flight, or null. ONE OBJECT PER ATTEMPT, because both fields
   * belong to one attempt and to no other:
   *
   *   resolve  the panel waiting on `pair()`.
   *   reached  did THIS attempt's socket reach OPEN before it ended? The extension's own
   *            observation at the transport, never a disclosure from the companion —
   *            `companion/src/pairing.js` hands the socket one indistinguishable `false`
   *            for all four of §12.3's refusal causes and nothing here widens that.
   *            `background.js` reads it as PAIR_FAIL's two values: a socket that never
   *            opened is NO_COMPANION (not running, or running with no pairing window,
   *            which the hub refuses at the upgrade with a 401 — no `onopen` either
   *            way), and one that opened and was told no is REFUSED.
   *
   * A `let reached` beside `socket` would outlive the attempt that set it, and the next
   * `pair()` would inherit a verdict about the previous one. Held here it cannot: the
   * object is made by `pair()` and dropped when the attempt is settled, and each socket
   * handler captures the attempt it was dialled FOR (`mine`) rather than reading
   * whichever attempt happens to be current when it fires.
   * @type {{resolve:(answer:{ok:boolean, reached:boolean}) => void, reached:boolean}|null}
   */
  let attempt = null;
  /** The token the live socket presented, so a token that CHANGES reconnects and one that did not, does not. */
  let presented = null;
  /** @type {Map<string, AbortController>} in-flight ops, by the frame id that started them. */
  const inflight = new Map();

  /**
   * "The companion status may have moved — read it again." Data-free on purpose: the
   * panel answers it with `GET_COMPANION`, so the dot cannot show a value that was true
   * when the event was sent and false when it arrived (see `MSG.COMPANION_CHANGED`).
   *
   * Optional: every caller but `background.js` builds this client without one.
   *
   * The callback belongs to the caller, so a failure inside it must not take the socket
   * handler down with it — an exception thrown out of `onopen` would skip the pairing
   * frame below it. Tests therefore RECORD their calls and assert afterwards; an
   * assertion made inside the callback would be swallowed here and pass either way,
   * which is the shape of silent success this build keeps producing.
   */
  function notifyStatus() {
    if (typeof deps.onStatus !== 'function') return;
    try {
      deps.onStatus();
    } catch (err) {
      console.error('[MockLab] companion status listener failed', err);
    }
  }

  /** Answer the pairing attempt in flight, once, and forget it. */
  function settlePairing(answer) {
    const waiting = attempt;
    attempt = null;
    if (waiting) waiting.resolve(answer);
  }

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
    /**
     * The attempt THIS socket is being dialled for, captured once, here.
     *
     * `null` for every ordinary connection, and that is half the point: `pair()` drops
     * the working socket before it dials, a real `close()` completes a task or two
     * later, and an `onclose` that read `attempt` at firing time would answer the panel
     * "no companion" using the death of a socket that was never part of the pairing.
     * The other half is `pair()` twice in a row: the first socket's `onclose` arrives
     * after the second attempt exists, and `mine === attempt` is what stops it
     * reporting the first attempt's `reached` as the second's verdict.
     */
    const mine = codeToSubmit ? attempt : null;
    let ws;
    try {
      ws = new Socket(url, protocols);
    } catch {
      // Nothing was dialled, so nothing reached OPEN. Said now rather than left to a
      // waiter that would never be answered at all.
      if (mine && attempt === mine) settlePairing({ ok: false, reached: false });
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      attempts = 0;
      // The one place `reached` is ever set true: this socket, in the OPEN state.
      if (mine) mine.reached = true;
      if (codeToSubmit) post({ id: 'pair', kind: KIND.REQ, op: HUB_OP.PAIR, payload: { code: codeToSubmit } });
      notifyStatus();
    };
    ws.onmessage = (event) => {
      let frame = null;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (frame && frame.kind === KIND.RES && frame.op === HUB_OP.PAIR) {
        void finishPairing(frame.payload, mine);
        return;
      }
      void handleFrame(frame);
    };
    ws.onclose = (event) => {
      if (socket === ws) socket = null;
      // The handler that answers a pairing nobody answered — and the one that reads
      // `reached`, because this is the moment the attempt is over and the flag is final.
      if (mine && attempt === mine) settlePairing({ ok: false, reached: mine.reached });
      notifyStatus();
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
  async function finishPairing(payload, mine) {
    const ok = Boolean(payload && payload.ok === true && payload.token);
    if (ok) {
      await updateSettings({ companionToken: payload.token });
      // §12.3's third state change: paired. `GET_COMPANION`'s two booleans move
      // separately and this is the one that moved.
      notifyStatus();
    }
    // Taken BEFORE `closeSocket()`, which can run `onclose` synchronously: the close
    // handler above would otherwise answer this attempt `{ok:false}` about a handshake
    // that had just succeeded.
    const waiting = attempt && attempt === mine ? attempt : null;
    if (waiting) attempt = null;
    closeSocket();
    // The storage write above reaches every context including this one, so the ordinary
    // token-presenting connection is opened by `watchStore`. Opening it here as well
    // would be a second path to the same socket, and `open()` already refuses the second.
    if (ok) {
      attempts = 0;
      void open();
    }
    // `reached` even on success: it is a fact about this attempt's socket either way,
    // and a shape that changes between the two answers is one `background.js` would
    // have to branch on twice.
    if (waiting) waiting.resolve({ ok, reached: mine.reached });
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
        if (token && token !== presented && !attempt) {
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
    /**
     * Is there a socket an agent's call could travel over right now? §10.5's dot, and
     * `GET_COMPANION`'s `connected`.
     *
     * `presented` is in the condition on purpose. A PAIRING socket is open, and carries
     * exactly one frame in each direction; the hub adds it to `pairingSockets` and never
     * sets `live` to it, so no `req` will ever arrive on it and no op can be answered
     * over it. Reporting it as connected would put §11's "Connected — AI agents can
     * control this site" on screen at the one moment no agent can — and, because the
     * pairing socket opens and closes inside the pairing flow, it would make the dot go
     * green, grey, green on a single successful pairing. The other end already draws the
     * line here: `hub.isConnected()` is `Boolean(live)`, which a pairing socket never is.
     */
    isConnected: () => Boolean(socket && socket.readyState === 1 && presented),

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
     * §12.3's pairing, from the panel's "set up AI access" flow.
     *
     * Resolves `{ok, reached}`. `ok` is everything the COMPANION said — one bit, by its
     * design. `reached` is everything THIS SIDE saw: whether the socket for this attempt
     * ever opened. Nothing here can tell the panel which of §12.3's four refusals fired,
     * and nothing here should be able to.
     */
    async pair(code) {
      // A pairing already waiting is abandoned with its OWN attempt's observation, not
      // the next one's, and not left hanging for a socket this call is about to close.
      if (attempt) settlePairing({ ok: false, reached: attempt.reached });
      closeSocket();
      stopped = false;
      const answer = new Promise((resolve) => {
        attempt = { resolve, reached: false };
      });
      await open(String(code || ''));
      return answer;
    }
  };
}
