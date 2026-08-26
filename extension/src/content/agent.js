/**
 * ISOLATED-world page agent (PLAN.md §2, §6, §7.2, §7.3).
 *
 * OWNER: probe-engineer (pick mode, snapshots, settle detection — M3/M4).
 * The MAIN <-> service-worker relay below is interceptor-engineer's, delivered at M1.
 *
 * The picker itself lives in `picker.js`, and everything asked ABOUT an element in
 * `element.js` (§6.2's fingerprint, §7.3's snapshot, §6.1's smart target). Both are
 * ISOLATED-world content scripts listed beside this one, in the manifest's single
 * ISOLATED entry — three files, not two. §17.10 is why there are three rather than one:
 * each file stays inside its ~500-line cap, which `guards.lines.test.js` enforces from
 * the files themselves (a file past the cap must be recorded in README with its real
 * count). No line count is written here, deliberately: the one that used to be,
 * "the two together are 650 lines", was already false in the commit that wrote it
 * (`0ff2bd1` — which also added `element.js` and listed all three scripts in the
 * manifest, while the same sentence called `picker.js` the SECOND of them). Both halves
 * survived every pass since, because no guard reads a figure in a source header.
 *
 * All three share this extension's isolated global — never the page's. This file reads
 * both contracts: `globalThis.__mocklabPicker` for §6.1's pick mode, and, since M4,
 * `globalThis.__mocklabElement` for the questions §7.2 and §7.3 ask about nodes with no
 * picker running. Until M4 it read only the first, and its own header said so — the
 * sentence is rewritten rather than left standing, because the list
 * `guards.contract.test.js` keeps of who mirrors each name now has this file on it.
 * This file owns the Port and the settle clock; those two own the DOM.
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
  // M4 probe (PLAN.md §7). Mirrored from background/probeMessages.js, which is where
  // these three live until they can be folded into messages.js beside PORT_MSG.
  var PROBE_PORT_MSG = {                          // PROBE_PORT_MSG
    SNAPSHOT: 'port:probeSnapshot',
    FINGERPRINTS: 'port:probeFingerprints',
    RESULT: 'port:probeResult'
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
        // Pick mode and the probe are driven by the worker only — never by the page
        // (see the MAIN -> ISOLATED relay below, which has no cases for either).
        if (message.type === PORT_MSG.PICK_START) startPick();
        else if (message.type === PORT_MSG.PICK_CANCEL) cancelPick();
        else if (message.type === PROBE_PORT_MSG.SNAPSHOT) onSnapshotRequest(message.payload);
        else if (message.type === PROBE_PORT_MSG.FINGERPRINTS) onFingerprintRequest(message.payload);
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
   * `picker.js` is another ISOLATED-world content script of this extension, so it
   * shares this extension's isolated global — and only this. It is looked up at call
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

  /* ── the probe's page side (§7.2, §7.3, §7.6) ──────────────────────────────── */

  /**
   * `element.js`'s contract, looked up at call time for the same reason `picker()` is:
   * a lookup that can fail loudly beats a binding that captured `undefined` because the
   * manifest's script order changed.
   */
  function elementApi() {
    try { return globalThis.__mocklabElement || null; } catch (err) { return null; }
  }

  /** §7.3's settle definition, in the units it is written in. */
  var SETTLE = {
    QUIET_MS: 500,          // no captured request for this long
    MIN_AFTER_LOAD_MS: 800, // minimum after the load event
    QUIET_FRAMES: 2,        // consecutive ticks with no mutation in the watched subtree
    CAP_MS: 8000,           // hard cap; past it the snapshot is taken anyway, settled:false
    FALLBACK_TICK_MS: 200   // see `schedule()` — a hidden tab never paints
  };

  /** §7.6: "all elements currently on screen with text, sampled … max 3000". */
  var PAGE_SAMPLE_MAX = 3000;
  /** §7.2: "the picked element AND its 30 nearest visible ancestors/siblings". */
  var REGION_MAX = 30;
  var REGION_LEVELS = 6;

  /** When the last response was captured, and when `load` fired. Both drive settle. */
  var lastCaptureAt = Date.now();
  var loadAt = document.readyState === 'complete' ? Date.now() : 0;
  try {
    window.addEventListener('load', function () { loadAt = Date.now(); }, false);
  } catch (err) { /* ignore */ }

  /**
   * Call `done(settled)` once the page has stopped moving, per §7.3: the load event has
   * fired, no response has been captured for 500 ms, two consecutive ticks have passed
   * with no mutation anywhere in the document, and at least 800 ms have passed since
   * load. Past the 8 s cap it reports `settled:false` and lets the probe decide — the
   * alternative is a page that never settles stalling the whole run silently.
   */
  function whenSettled(done) {
    var started = Date.now();
    var observer = null;
    var mutations = 0;
    var lastSeen = -1;
    var quietTicks = 0;
    var finished = false;

    try {
      observer = new MutationObserver(function (records) {
        mutations += (records && records.length) || 1;
      });
      observer.observe(document.documentElement, {
        subtree: true, childList: true, characterData: true, attributes: true
      });
    } catch (err) { observer = null; }

    function finish(settled) {
      if (finished) return;
      finished = true;
      try { if (observer) observer.disconnect(); } catch (err) { /* ignore */ }
      try { done(settled); } catch (err) { /* the worker went away; nothing to do */ }
    }

    function tick() {
      if (finished) return;
      var now = Date.now();
      if (now - started >= SETTLE.CAP_MS) { finish(false); return; }
      if (mutations === lastSeen) quietTicks += 1;
      else quietTicks = 0;
      lastSeen = mutations;
      var quiet =
        loadAt > 0 &&
        now - loadAt >= SETTLE.MIN_AFTER_LOAD_MS &&
        now - lastCaptureAt >= SETTLE.QUIET_MS &&
        quietTicks >= SETTLE.QUIET_FRAMES;
      if (quiet) finish(true);
      else schedule();
    }

    /**
     * §7.3 counts requestAnimationFrame ticks, and a BACKGROUNDED tab never paints —
     * so on a tab the user has switched away from, rAF alone would leave every probe
     * reload to the 8 s cap and report `settled:false` for a page that settled in 200
     * ms. Whichever of the two fires first drives the next tick; when the tab is
     * visible that is always the frame.
     */
    function schedule() {
      var fired = false;
      var advance = function () { if (!fired) { fired = true; tick(); } };
      try { requestAnimationFrame(advance); } catch (err) { /* fall back to the timer */ }
      setTimeout(advance, SETTLE.FALLBACK_TICK_MS);
    }

    schedule();
  }

  /**
   * A node's key: its tag and its index path from `<html>`. Two snapshots of the same
   * page load are matched on it, which is what lets the worker compare a page against
   * itself across a reload without fingerprinting every node (a `querySelectorAll` per
   * node, thousands of times, for the four that turn out to matter).
   *
   * A page that re-orders its DOM on every load produces different keys on every load —
   * and that shows up in the control runs as noise, which is the honest outcome rather
   * than a silently wrong comparison.
   */
  function keyOf(el) {
    var steps = [];
    var node = el;
    while (node && node.parentElement) {
      steps.unshift(Array.prototype.indexOf.call(node.parentElement.children, node));
      node = node.parentElement;
    }
    return el.tagName.toLowerCase() + '@' + steps.join('.');
  }

  /** The element a key names, or null when the page no longer has that position. */
  function elementForKey(key) {
    try {
      var at = String(key).indexOf('@');
      if (at === -1) return null;
      var tail = String(key).slice(at + 1);
      var node = document.documentElement;
      var steps = tail === '' ? [] : tail.split('.');
      for (var i = 0; i < steps.length && node; i += 1) node = node.children[Number(steps[i])];
      return node && node.tagName.toLowerCase() === String(key).slice(0, at) ? node : null;
    } catch (err) { return null; }
  }

  /**
   * §7.2's bounded region around the picked element: itself, then its ancestors and
   * their children, outward, capped at 30 nodes.
   *
   * §7.2 says "visible" ancestors and siblings; this filters none out, and that is
   * deliberate. The demo's cancellation banner is `display:none` with no text until the
   * status field says otherwise — dropping invisible nodes would make the probe blind
   * to exactly the derived element §7.6 exists to find, and would make the noise mask
   * blind to a node that appears on some loads and not others. Recorded in README.
   */
  function regionOf(el) {
    var out = [];
    var seen = [];
    function push(node) {
      if (!node || node.nodeType !== 1) return;
      if (seen.indexOf(node) !== -1 || out.length >= REGION_MAX) return;
      seen.push(node);
      out.push(node);
    }
    push(el);
    var node = el;
    for (var level = 0; level < REGION_LEVELS && out.length < REGION_MAX; level += 1) {
      var parent = node.parentElement;
      if (!parent) break;
      push(parent);
      var kids = parent.children;
      for (var i = 0; i < kids.length && out.length < REGION_MAX; i += 1) push(kids[i]);
      node = parent;
    }
    return out;
  }

  /** §7.6's sample: every element with a text node of its own, capped. */
  function pageSample() {
    var out = [];
    try {
      if (!document.body) return out;
      var all = document.body.querySelectorAll('*');
      for (var i = 0; i < all.length && out.length < PAGE_SAMPLE_MAX; i += 1) {
        var el = all[i];
        var kids = el.childNodes;
        for (var c = 0; c < kids.length; c += 1) {
          if (kids[c].nodeType === 3 && String(kids[c].nodeValue || '').trim()) {
            out.push(el);
            break;
          }
        }
      }
    } catch (err) { /* whatever was collected is still usable */ }
    return out;
  }

  function snapshotNodes(dom, nodes) {
    var out = [];
    for (var i = 0; i < nodes.length; i += 1) {
      try { out.push({ key: keyOf(nodes[i]), snapshot: dom.snapshotElement(nodes[i]) }); }
      catch (err) { /* one unreadable node must not lose the rest */ }
    }
    return out;
  }

  function reply(payload) {
    toWorker(PROBE_PORT_MSG.RESULT, payload);
  }

  /**
   * §7.3's snapshot, once the page has settled. The element is re-resolved from §6.2's
   * fingerprint and its CONFIDENCE is reported rather than judged here: the worker
   * aborts the probe below 0.8 (§6.2), because diffing the wrong element is how a false
   * "Verified ✓" would be produced.
   */
  function onSnapshotRequest(payload) {
    var request = payload || {};
    whenSettled(function (settled) {
      var started = Date.now();
      try {
        var dom = elementApi();
        if (!dom) { reply({ requestId: request.requestId, ok: false, reason: 'unavailable' }); return; }
        var resolved = dom.resolveFingerprint(request.fingerprint);
        var target = resolved.element;
        reply({
          requestId: request.requestId,
          ok: true,
          settled: settled,
          url: location.href,
          confidence: resolved.confidence,
          elementKey: target ? keyOf(target) : null,
          element: target ? dom.snapshotElement(target) : null,
          region: target ? snapshotNodes(dom, regionOf(target)) : [],
          page: request.page === false ? [] : snapshotNodes(dom, pageSample()),
          tookMs: Date.now() - started
        });
      } catch (err) {
        reply({ requestId: request.requestId, ok: false, reason: 'error' });
      }
    });
  }

  /** §6.2 fingerprints for nodes the worker has already decided are interesting. */
  function onFingerprintRequest(payload) {
    var request = payload || {};
    try {
      var dom = elementApi();
      if (!dom) { reply({ requestId: request.requestId, ok: false, reason: 'unavailable' }); return; }
      var keys = Array.isArray(request.keys) ? request.keys : [];
      var out = [];
      for (var i = 0; i < keys.length; i += 1) {
        var node = elementForKey(keys[i]);
        if (!node) continue;
        try { out.push({ key: keys[i], fingerprint: dom.fingerprint(node) }); }
        catch (err) { /* skip the one that would not read */ }
      }
      reply({ requestId: request.requestId, ok: true, fingerprints: out });
    } catch (err) {
      reply({ requestId: request.requestId, ok: false, reason: 'error' });
    }
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
            // The settle clock's network half (§7.3): the page is not quiet while
            // responses are still arriving, and this relay is where they arrive.
            lastCaptureAt = Date.now();
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
