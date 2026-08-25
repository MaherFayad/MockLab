/**
 * ISOLATED-world page agent (PLAN.md §2, §6, §7.2, §7.3).
 *
 * OWNER: probe-engineer (pick mode, snapshots, settle detection — M3/M4).
 * The MAIN <-> service-worker relay below is interceptor-engineer's, delivered at M1.
 *
 * The picker itself lives in `picker.js`, a SECOND ISOLATED-world content script listed
 * beside this one in the manifest (§17.10: the two together are 650 lines). They share
 * this extension's isolated global — never the page's — and the whole contract between
 * them is `globalThis.__mocklabPicker`. This file owns the Port; that one owns the DOM.
 *
 * The page is a hostile environment: every inbound postMessage must carry the exact
 * per-page-load token or be ignored outright (PLAN.md §2).
 *
 * MIRRORED LITERALS — see the header of src/background/messages.js. Content scripts
 * are classic scripts, not modules: `import` is a syntax error here, and dynamic
 * import() of an extension URL would require adding the file to
 * web_accessible_resources (exposing it to every page). So the handful of constants
 * below are duplicated, exactly as interceptor.js duplicates its own. Change one here
 * and change it in messages.js in the same commit.
 */
(function () {
  'use strict';

  /* ── mirrored from src/background/messages.js ──────────────────────────────── */
  var TAG = '__mocklab';                          // MOCKLAB_TAG
  var TOKEN_ATTRIBUTE = 'data-mocklab-token';     // TOKEN_ATTRIBUTE
  var PORT_NAME = 'mocklab';                      // PORT_NAME
  var PAGE = {                                    // PAGE
    HELLO: 'page:hello',
    CAPTURED: 'page:captured',
    SOFT_NAV: 'page:softNav',
    MATCH_LIST: 'page:matchList'
  };
  var PORT_MSG = {                                // PORT_MSG
    HELLO: 'port:hello',
    CAPTURED: 'port:captured',
    SOFT_NAV: 'port:softNav',
    MATCH_LIST: 'port:matchList',
    // M3 pick mode — same mirroring rule, same commit discipline.
    PICK_START: 'port:pickStart',
    PICK_CANCEL: 'port:pickCancel',
    PICKED: 'port:picked'
  };
  /* ─────────────────────────────────────────────────────────────────────────── */

  var token = null;
  /** Random per-page-load id, so the worker can tell a fresh document from a
      reconnect after service-worker eviction and only then clear the tab's captures. */
  var loadId = null;
  var port = null;
  /**
   * Last match list the service worker sent, replayed whenever MAIN world says hello.
   * `hasMatchList` matters: the MAIN patch holds the page's first requests until it
   * receives a list, so replaying the empty placeholder would open that gate early and
   * the page's first responses would arrive unmocked. Only a real list from the worker
   * counts.
   */
  var latestMatchList = { entries: [] };
  var hasMatchList = false;
  var mainIsListening = false;

  function mintToken() {
    try {
      if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch (err) { /* fall through */ }
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  /** MAIN world reads this attribute at document_start and removes it immediately. */
  function handOverToken() {
    token = mintToken();
    loadId = mintToken();
    document.documentElement.setAttribute(TOKEN_ATTRIBUTE, token);
    // Belt and braces: if the MAIN patch never installed (frozen page, CSP oddity),
    // do not leave the token sitting in the DOM for site scripts to read.
    setTimeout(function () {
      try { document.documentElement.removeAttribute(TOKEN_ATTRIBUTE); } catch (err) { /* ignore */ }
    }, 5000);
  }

  function hello() {
    return { url: location.href, origin: location.origin, loadId: loadId };
  }

  function toMain(type, payload) {
    try {
      if (token === null) return;
      var frame = { type: type, payload: payload };
      frame[TAG] = token;
      window.postMessage(frame, '*');
    } catch (err) { /* ignore */ }
  }

  /* ── Port to the service worker ────────────────────────────────────────────── */

  /**
   * MV3 service workers are evicted aggressively, which disconnects the Port. Rather
   * than keeping it alive artificially, reconnect lazily: every send goes through
   * here, so the first message after an eviction wakes the worker and re-says hello.
   */
  function getPort() {
    if (port) return port;
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
    } catch (err) {
      port = null;
      return null;
    }
    port.onDisconnect.addListener(function () {
      void chrome.runtime.lastError; // reading it suppresses the unchecked-error noise
      port = null;
    });
    port.onMessage.addListener(function (message) {
      try {
        if (!message) return;
        if (message.type === PORT_MSG.MATCH_LIST) {
          latestMatchList = { entries: (message.payload && message.payload.entries) || [] };
          hasMatchList = true;
          if (mainIsListening) toMain(PAGE.MATCH_LIST, latestMatchList);
          return;
        }
        // Pick mode is driven by the worker only — never by the page (see the
        // MAIN -> ISOLATED relay below, which has no pick cases on purpose).
        if (message.type === PORT_MSG.PICK_START) startPick();
        else if (message.type === PORT_MSG.PICK_CANCEL) cancelPick();
      } catch (err) { /* ignore */ }
    });
    try {
      port.postMessage({ type: PORT_MSG.HELLO, payload: hello() });
    } catch (err) { /* ignore */ }
    return port;
  }

  function toWorker(type, payload) {
    try {
      var live = getPort();
      if (!live) return;
      live.postMessage({ type: type, payload: payload });
    } catch (err) {
      // The worker went away between the check and the send: drop the port so the
      // next message reconnects. Losing one capture is fine; throwing is not.
      port = null;
    }
  }

  /* ── pick mode relay (§6.1) ────────────────────────────────────────────────── */

  /**
   * `picker.js` is a second ISOLATED-world content script, so it shares this
   * extension's isolated global — and only this extension's. It is looked up at call
   * time rather than captured at load: if it ever fails to inject, the panel is told
   * so instead of being left on "Click something on the page…" for ever (§1.1).
   */
  function picker() {
    try { return globalThis.__mocklabPicker || null; } catch (err) { return null; }
  }

  function startPick() {
    var ui = picker();
    if (!ui) {
      toWorker(PORT_MSG.PICKED, { ok: false, reason: 'unavailable' });
      return;
    }
    ui.start(function (result) { toWorker(PORT_MSG.PICKED, result); });
  }

  function cancelPick() {
    var ui = picker();
    if (ui) ui.cancel();
  }

  /* ── MAIN -> ISOLATED relay ────────────────────────────────────────────────── */

  window.addEventListener(
    'message',
    function (event) {
      try {
        if (event.source !== window) return;
        var data = event.data;
        if (!data || typeof data !== 'object') return;
        if (token === null || data[TAG] !== token) return;

        switch (data.type) {
          case PAGE.HELLO:
            mainIsListening = true;
            // The worker may have answered before the MAIN patch was ready; replay —
            // but only a list the worker actually sent (see hasMatchList above).
            if (hasMatchList) toMain(PAGE.MATCH_LIST, latestMatchList);
            toWorker(PORT_MSG.HELLO, hello());
            break;
          case PAGE.CAPTURED:
            toWorker(PORT_MSG.CAPTURED, data.payload);
            break;
          case PAGE.SOFT_NAV:
            toWorker(PORT_MSG.SOFT_NAV, data.payload);
            break;
          default:
            break;
        }
      } catch (err) { /* a hostile page must not be able to throw in here */ }
    },
    false
  );

  try {
    handOverToken();
    getPort();
  } catch (err) {
    console.error('[MockLab] agent failed to start', err);
  }

})();
