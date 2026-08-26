/**
 * WebSocket hub — extension <-> companion transport (PLAN.md §12.2, §12.3).
 *
 * OWNER: mcp-engineer.
 *
 * Contract (do not change without updating PLAN.md §12.2):
 *   frames   {id, kind:"req"|"res"|"event", op, payload}
 *   binding  127.0.0.1 ONLY
 *   auth     Bearer token from ~/.mocklab/token, 6-digit pairing code (§12.3)
 *   timeout  30s -> "extension not responding — is Chrome open with MockLab installed?"
 *
 * ── The three ways a tool call can fail to get an answer, and why they are three ────
 *
 * §12.2 writes down one sentence, for the timeout. There are three distinct facts here
 * and a caller can act on each differently, so each gets its own honest sentence and
 * none of them is ever reported as another:
 *
 *   NOT_CONNECTED   no extension socket at all. Chrome is not open, or MockLab is not
 *                   installed in it, or it has not been paired (§12.3).
 *   DISCONNECTED    the socket went away WHILE this call was in flight. This is §16's
 *                   M6 DoD line "kill Chrome mid-call": every pending request rejects
 *                   the moment the socket closes, so an agent gets an error in
 *                   milliseconds instead of waiting out a 30-second timeout for an
 *                   answer that can never arrive.
 *   TIMEOUT         the socket is up and the extension did not answer in time. §12.2's
 *                   sentence, verbatim.
 *
 * ── What the cache is and is not ────────────────────────────────────────────────────
 *
 * §12.2: "the hub caches the latest store per origin so read-only MCP tools answer
 * instantly even mid-navigation". It caches what the extension PUSHED, and it is used
 * only when the live path cannot answer — and then the answer says so, in the payload,
 * with the time it was captured. A cached answer presented as a live one would be a
 * quiet lie about the state of the user's browser (§1.1, §17.12), and the whole point of
 * this product is that it does not tell those.
 */
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

export const HUB_PATH = '/ext';
export const REQUEST_TIMEOUT_MS = 30_000;
export const EXTENSION_TIMEOUT_MESSAGE =
  'extension not responding — is Chrome open with MockLab installed?';
export const NOT_CONNECTED_MESSAGE =
  'MockLab is not connected — open Chrome with the MockLab extension installed and paired.';
export const DISCONNECTED_MESSAGE =
  'MockLab disconnected while this call was running — the browser was closed or the extension reloaded.';
/**
 * §7.1: "The user can cancel any time (CLEANUP runs; page returns to real state)". An MCP
 * client that abandons a `probe_element` is doing exactly that, and the browser is told
 * so — otherwise the page a person is looking at goes on reloading for up to three
 * minutes for a caller that stopped listening.
 */
export const CANCELLED_MESSAGE = 'The call was cancelled, and MockLab was told to stop and put the page back.';

/** Frame kinds (§12.2). */
export const KIND = Object.freeze({ REQ: 'req', RES: 'res', EVENT: 'event' });

/**
 * The op vocabulary of everything that is not a tool call. All but one travel
 * extension -> hub; everything else in that direction is a `res` to something the hub
 * asked for, or is dropped.
 *
 * `PAIR` is the one request an UNAUTHENTICATED socket may make, and the only one
 * (§12.3). `PROGRESS` carries the id of the request it belongs to, which is how §12.4's
 * "send MCP progress notifications at each state change" reaches the MCP client.
 *
 * `CANCEL` is the one that goes the other way, hub -> extension, carrying the id of the
 * call to stop. It is an EVENT and not a `req`: a `req` reusing that id would come back
 * as a `res` with the same id, which is the frame this file reads as "that call is
 * finished" — the answer to the cancellation would be mistaken for the answer to the
 * call. `wsClient.js` mirrors this table and `mcp.test.js` compares the two.
 */
export const HUB_OP = Object.freeze({
  PAIR: 'pair',
  STORE_CHANGED: 'storeChanged',
  CAPTURED: 'captured',
  PROGRESS: 'progress',
  CANCEL: 'cancel'
});

/** Close codes the extension can act on. 4001-4999 is the application range. */
export const CLOSE = Object.freeze({
  UNAUTHORIZED: 4001,
  SUPERSEDED: 4002
});

/** An error a caller can classify without parsing prose. */
export class HubError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HubError';
    this.code = code;
  }
}

/**
 * The upgrade is refused before any WebSocket exists when any of these is wrong. Each
 * check answers a different attacker.
 *
 * ORIGIN (§12.3: "Reject any origin-header that is not the extension's
 * chrome-extension:// origin or absent"). A WEB PAGE can open a WebSocket to
 * ws://127.0.0.1:8517/ext — same-origin policy does not apply to WebSockets — and the
 * browser sets `Origin` to that page's origin, which it cannot forge. So this one check
 * is what stops any site the user visits from driving their browser through MockLab.
 * Absent is allowed because a non-browser client (the tests here) sends no Origin, and
 * a non-browser client already has the loopback interface.
 *
 * HOST. A DNS rebinding attack resolves evil.example to 127.0.0.1 and the browser
 * connects with `Host: evil.example`. Requiring a loopback Host rejects that even before
 * the Origin check does. Not in §12.3; reported rather than added quietly.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ok:true} | {ok:false, why:string}}
 */
export function checkUpgrade(req) {
  const url = req.url || '';
  const pathname = url.split('?')[0];
  if (pathname !== HUB_PATH) return { ok: false, why: 'path' };

  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  if (!loopback) return { ok: false, why: 'host' };

  const origin = req.headers.origin;
  if (origin !== undefined && !/^chrome-extension:\/\/[a-z]{32}$/.test(String(origin))) {
    return { ok: false, why: 'origin' };
  }
  return { ok: true };
}

/**
 * The subprotocol the extension offers, and the one this hub answers with. A client that
 * offers no subprotocol (a Node client, every test in this file's suite) is answered with
 * none — `handleProtocols` may only select one the client actually asked for.
 */
export const SUBPROTOCOL = 'mocklab.v1';
/** `mocklab.token.<64 hex>` — the second subprotocol, which carries the §12.3 token. */
export const TOKEN_SUBPROTOCOL_PREFIX = 'mocklab.token.';

/**
 * The token on an upgrade request, or ''.
 *
 * DEVIATION FROM §12.3, and the reason (§17.11 — "prefer the working behavior, note
 * it"): §12.3 says the extension puts the token in an `Authorization: Bearer` header on
 * the WS upgrade. The browser cannot. `new WebSocket(url, protocols)` is the entire API
 * surface a service worker has — there is no header argument and no interceptor for a
 * WebSocket handshake in MV3 — so an `Authorization` header is not something the
 * extension is able to send.
 *
 * The token therefore travels in the ONE header the browser does let a caller populate:
 * `Sec-WebSocket-Protocol`, as `mocklab.token.<hex>`. Same handshake, same header block,
 * same loopback socket, same secrecy properties — and, unlike the other workaround, NOT
 * in the URL, where it would be written to every access log and process listing on the
 * machine. `Authorization` is still read first, so a non-browser client (and this file's
 * own tests) can present the token the way §12.3 describes.
 */
export function bearerToken(req) {
  const authorization = /^Bearer\s+([0-9a-f]+)$/i.exec(String(req.headers.authorization || '').trim());
  if (authorization) return authorization[1].toLowerCase();
  const offered = String(req.headers['sec-websocket-protocol'] || '')
    .split(',')
    .map((entry) => entry.trim());
  for (const entry of offered) {
    if (entry.startsWith(TOKEN_SUBPROTOCOL_PREFIX)) return entry.slice(TOKEN_SUBPROTOCOL_PREFIX.length).toLowerCase();
  }
  return '';
}

/**
 * @param {{
 *   pairing: ReturnType<import('./pairing.js').createPairing>,
 *   log?: (line:string) => void,
 *   now?: () => number
 * }} options
 */
export function createHub(options) {
  const pairing = options.pairing;
  const log = options.log || (() => {});
  const now = options.now || Date.now;

  const wss = new WebSocketServer({
    noServer: true,
    // Answer with the plain subprotocol when the client offered it, and never echo the
    // token one back — a handshake response is far more widely logged than a request.
    handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false)
  });
  /** The one authenticated extension socket (§12.2: newest wins), or null. */
  let live = null;
  /** Sockets that have connected but not yet paired — they may send `pair` and nothing else. */
  const pairingSockets = new Set();
  /**
   * EVERY socket this hub has accepted and not seen close, authenticated or not.
   *
   * `live` is not enough to shut down on: a superseded socket is asked to close, and
   * "asked" is not "closed" — a client that ignores the close frame, or a defect that
   * skips the request, leaves a socket nothing is tracking and the process never exits.
   * Found by mutation: removing the newest-wins close turned a test that should fail in
   * three seconds into a run that never ended.
   */
  const sockets = new Set();
  /** @type {Map<string, {resolve:Function, reject:Function, timer:any, onProgress:Function|null, op:string}>} */
  const pending = new Map();
  /** §12.2's per-origin store cache. */
  const storeCache = new Map();
  /** Listeners for pushed events (the MCP server does not use them; tests do). */
  const listeners = new Set();

  let connections = 0;

  function settle(entry) {
    clearTimeout(entry.timer);
    if (entry.detach) entry.detach();
  }

  function fail(entry, error) {
    settle(entry);
    entry.reject(error);
  }

  /** Every in-flight call rejects NOW. The M6 DoD's "kill Chrome mid-call" path. */
  function rejectAll(message, code) {
    for (const [id, entry] of pending) {
      pending.delete(id);
      fail(entry, new HubError(code, message));
    }
  }

  function emit(event) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        /* a listener that throws is not the hub's problem to have */
      }
    }
  }

  function onFrame(socket, raw, authenticated) {
    let frame = null;
    try {
      frame = JSON.parse(String(raw));
    } catch {
      return; // a frame that is not JSON says nothing; the socket may still be useful
    }
    if (!frame || typeof frame !== 'object') return;

    // §12.3: an unpaired socket may ask exactly one thing.
    if (!authenticated) {
      if (frame.kind === KIND.REQ && frame.op === HUB_OP.PAIR) {
        const token = pairing.submit(frame.payload && frame.payload.code);
        send(socket, {
          id: frame.id,
          kind: KIND.RES,
          op: HUB_OP.PAIR,
          // One shape for every refusal: no reason, no hint, no "close" (§12.3 note 2).
          payload: token ? { ok: true, token } : { ok: false }
        });
        if (token) {
          log('paired — an AI agent can now reach this browser through MockLab');
          // The socket does not become authenticated here: the extension stores the
          // token and reconnects with it, so exactly one code path grants access.
        }
        return;
      }
      return;
    }

    if (frame.kind === KIND.RES) {
      const entry = pending.get(frame.id);
      if (!entry) return; // a late answer to a call that already timed out
      pending.delete(frame.id);
      settle(entry);
      entry.resolve(frame.payload);
      return;
    }

    if (frame.kind === KIND.EVENT) {
      if (frame.op === HUB_OP.PROGRESS) {
        const entry = pending.get(frame.id);
        if (entry && entry.onProgress) {
          try {
            entry.onProgress(frame.payload || {});
          } catch {
            /* a progress notification that fails must not fail the call */
          }
        }
        return;
      }
      if (frame.op === HUB_OP.STORE_CHANGED) {
        const payload = frame.payload || {};
        if (payload.origin) storeCache.set(payload.origin, { ...payload, cachedAt: now() });
      }
      emit({ op: frame.op, payload: frame.payload || {} });
    }
  }

  function send(socket, frame) {
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * One upgrade. Called from the http server's `upgrade` event so the refusals above can
   * answer with a status line — `ws`'s own `verifyClient` cannot say which check failed,
   * and a browser that is refused should see 401/403, not a dropped socket.
   */
  function handleUpgrade(req, socket, head) {
    const verdict = checkUpgrade(req);
    if (!verdict.ok) {
      if (verdict.why === 'path') {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      } else {
        log(`refused a WebSocket upgrade: bad ${verdict.why} (${req.headers.origin || req.headers.host || '-'})`);
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      }
      socket.destroy();
      return;
    }

    const token = bearerToken(req);
    const authenticated = pairing.isToken(token);
    if (!authenticated && !pairing.isOpen()) {
      // Nothing about WHY: an unauthenticated caller learns only that it may not in.
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      connections += 1;
      if (authenticated) {
        if (live && live !== ws) {
          // §12.2: "The hub keeps ONE extension connection (newest wins)."
          const old = live;
          live = null;
          try {
            old.close(CLOSE.SUPERSEDED, 'superseded');
          } catch {
            /* already gone */
          }
        }
        live = ws;
        log('the MockLab extension connected');
      } else {
        pairingSockets.add(ws);
      }

      sockets.add(ws);
      ws.on('message', (data) => onFrame(ws, data, authenticated));
      ws.on('close', () => {
        sockets.delete(ws);
        pairingSockets.delete(ws);
        if (live === ws) {
          live = null;
          rejectAll(DISCONNECTED_MESSAGE, 'disconnected');
          log('the MockLab extension disconnected');
        }
      });
      ws.on('error', () => {
        /* the close handler does the work; an error event must not throw out of here */
      });
      emit({ op: 'connected', payload: { authenticated } });
    });
  }

  return {
    /** Wire the hub onto the same http server that serves §14's demo (one port, §12.1). */
    attach(server) {
      server.on('upgrade', handleUpgrade);
      return this;
    },

    /** Exposed for tests that drive an upgrade without a listening socket. */
    handleUpgrade,

    isConnected: () => Boolean(live),
    connectionCount: () => connections,
    pendingCount: () => pending.size,

    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** §12.2's cache, or null. Callers must label what they take from it. */
    cachedStore(origin) {
      return storeCache.get(origin) || null;
    },

    /** Every origin the extension has pushed a store for, newest first. */
    cachedOrigins() {
      return [...storeCache.values()].sort((a, b) => b.cachedAt - a.cachedAt);
    },

    /**
     * One MCP tool call, forwarded to the extension.
     *
     * `signal` is the MCP client's own cancellation, handed straight through from the
     * request handler. MCP already has this concept, so a sixteenth tool to express it
     * would be a second vocabulary for one idea; what the hub adds is the frame that
     * carries the decision across the socket, so the BROWSER learns about it. Cancelling
     * only here would leave the call tidy on this side and the page still reloading on
     * the other, which is the half that costs a person something.
     *
     * @param {string} op
     * @param {any} payload
     * @param {{timeoutMs?:number, onProgress?:(p:any)=>void, signal?:AbortSignal}} [options]
     * @returns {Promise<any>} whatever the extension answered
     */
    request(op, payload, requestOptions = {}) {
      const signal = requestOptions.signal || null;
      if (signal && signal.aborted) return Promise.reject(new HubError('cancelled', CANCELLED_MESSAGE));
      if (!live) return Promise.reject(new HubError('not-connected', NOT_CONNECTED_MESSAGE));
      const id = crypto.randomUUID();
      const timeoutMs = Number(requestOptions.timeoutMs) > 0 ? Number(requestOptions.timeoutMs) : REQUEST_TIMEOUT_MS;
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          if (!pending.has(id)) return;
          pending.delete(id);
          // Best effort, and deliberately not conditional on it: if the socket has gone,
          // the browser is not running the probe either.
          if (live) send(live, { id, kind: KIND.EVENT, op: HUB_OP.CANCEL, payload: {} });
          fail(entry, new HubError('cancelled', CANCELLED_MESSAGE));
        };
        const entry = {
          op,
          resolve,
          reject,
          onProgress: requestOptions.onProgress || null,
          // Removed when the call settles, whichever way it settles. A listener left on a
          // long-lived signal is a leak that grows with every tool call a client makes.
          detach: signal ? () => signal.removeEventListener('abort', onAbort) : null,
          timer: setTimeout(() => {
            pending.delete(id);
            if (signal) signal.removeEventListener('abort', onAbort);
            reject(new HubError('timeout', EXTENSION_TIMEOUT_MESSAGE));
          }, timeoutMs)
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        pending.set(id, entry);
        if (!send(live, { id, kind: KIND.REQ, op, payload })) {
          pending.delete(id);
          fail(entry, new HubError('disconnected', DISCONNECTED_MESSAGE));
        }
      });
    },

    close() {
      rejectAll(DISCONNECTED_MESSAGE, 'disconnected');
      for (const socket of sockets) {
        try {
          socket.terminate ? socket.terminate() : socket.close();
        } catch {
          /* already gone */
        }
      }
      sockets.clear();
      pairingSockets.clear();
      live = null;
      wss.close();
    }
  };
}
