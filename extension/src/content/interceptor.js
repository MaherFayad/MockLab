/**
 * MAIN-world capture & mock engine (PLAN.md §5, §5.1, §5.3).
 *
 * OWNER: interceptor-engineer.
 *
 * HARD RULES (PLAN.md §17.1-§17.3) — these hold from the very first line of code:
 *   - Zero imports. MAIN-world scripts cannot use extension modules. Single IIFE.
 *   - Everything inside try/catch. An internal error must NEVER break the host page.
 *   - When no Change matches, return the ORIGINAL Response object — never a
 *     re-serialized copy (that breaks streaming and binary responses).
 *   - Compute no hashes here. sigIds come only from signatures.js in the service
 *     worker; this file matches against a compiled match list it is handed, and it
 *     walks pre-parsed JSONPath tokens rather than parsing paths itself.
 *
 * MIRRORED LITERALS — see the header of src/background/messages.js. A MAIN-world
 * script has no module graph, so the constants below CANNOT be imported (§17.2 vs
 * §17.8; the M0 contract note in BUILD_LOG.md spells this out). Change one here and
 * you must change it in messages.js in the same commit. Do not "fix" this with an
 * import: the patch dies silently and the page keeps working, so nothing fails loudly.
 */
(function () {
  'use strict';

  try {
    /* ── mirrored from src/background/messages.js ────────────────────────────── */
    var TAG = '__mocklab';                          // MOCKLAB_TAG
    var TOKEN_ATTRIBUTE = 'data-mocklab-token';     // TOKEN_ATTRIBUTE
    var T_HELLO = 'page:hello';                     // PAGE.HELLO
    var T_CAPTURED = 'page:captured';               // PAGE.CAPTURED
    var T_SOFT_NAV = 'page:softNav';                // PAGE.SOFT_NAV
    var T_MATCH_LIST = 'page:matchList';            // PAGE.MATCH_LIST
    /* ───────────────────────────────────────────────────────────────────────── */

    var INSTALL_FLAG = '__mocklabInterceptorInstalled';
    if (window[INSTALL_FLAG]) return;
    window[INSTALL_FLAG] = true;

    /** PLAN.md §4: bodies over 2 MB are kept as an unparsed preview only. */
    var MAX_BODY_CHARS = 2 * 1024 * 1024;
    var PREVIEW_CHARS = 512;
    var MAX_PENDING = 200;
    var SOFT_NAV_THROTTLE_MS = 100;
    /**
     * The match list is pushed in from the service worker (PLAN.md §5.1.5), which takes
     * a few milliseconds — long enough that a page firing its data requests at
     * document_start can get its response back BEFORE any Change is known, and the edit
     * silently does nothing. So the FIRST requests of a page load are held until the
     * list lands, capped hard by this deadline. §5.1.5's real requirement — no async
     * round-trip PER REQUEST inside the patch — still holds: this waits once per page
     * load, for the table itself, and every request after it is fully synchronous.
     */
    var MATCH_LIST_GATE_MS = 1000;

    /* ── save originals FIRST (PLAN.md §5.1.1) ──────────────────────────────── */
    var realFetch = window.fetch;
    var RealXHR = window.XMLHttpRequest;
    var XHRProto = RealXHR && RealXHR.prototype;
    var realOpen = XHRProto && XHRProto.open;
    var realSend = XHRProto && XHRProto.send;
    var textDesc = XHRProto && Object.getOwnPropertyDescriptor(XHRProto, 'responseText');
    var respDesc = XHRProto && Object.getOwnPropertyDescriptor(XHRProto, 'response');
    var realPushState = window.history && window.history.pushState;
    var realReplaceState = window.history && window.history.replaceState;

    /* ── transport to the ISOLATED world ────────────────────────────────────── */

    var token = null;
    var pending = [];
    var matchList = [];
    var xhrState = new WeakMap();
    var matchListReady = false;
    var gateDeadline = Date.now() + MATCH_LIST_GATE_MS;
    var gateWaiters = [];
    var gateTimer = null;
    var lastNavPost = 0;
    var lastNavUrl = null;

    function post(type, payload) {
      try {
        if (token === null) {
          if (pending.length < MAX_PENDING) pending.push([type, payload]);
          return;
        }
        var frame = { type: type, payload: payload };
        frame[TAG] = token;
        window.postMessage(frame, '*');
      } catch (err) { /* never let messaging break the page */ }
    }

    function gateOpen() {
      return matchListReady || Date.now() >= gateDeadline;
    }

    function releaseGate() {
      if (gateTimer !== null) { clearTimeout(gateTimer); gateTimer = null; }
      var waiters = gateWaiters;
      gateWaiters = [];
      for (var i = 0; i < waiters.length; i += 1) {
        try { waiters[i](); } catch (err) { /* one bad waiter must not strand the rest */ }
      }
    }

    /** Run `callback` once the match list has arrived, or once the deadline passes. */
    function whenGateOpen(callback) {
      if (gateOpen()) { callback(); return; }
      gateWaiters.push(callback);
      if (gateTimer === null) {
        gateTimer = setTimeout(releaseGate, Math.max(0, gateDeadline - Date.now()));
      }
    }

    function flushPending() {
      var queued = pending;
      pending = [];
      for (var i = 0; i < queued.length; i += 1) post(queued[i][0], queued[i][1]);
    }

    /**
     * agent.js (ISOLATED) hands the per-page-load token over on documentElement, then
     * we remove it. Manifest order puts THIS script first, so the attribute is usually
     * not there yet — hence the observer and the short poll. Captures made before the
     * token arrives sit in `pending`, so nothing is lost.
     */
    function readToken() {
      try {
        var root = document.documentElement;
        if (!root) return false;
        var value = root.getAttribute(TOKEN_ATTRIBUTE);
        if (!value) return false;
        root.removeAttribute(TOKEN_ATTRIBUTE);
        token = value;
        post(T_HELLO, { url: location.href });
        flushPending();
        return true;
      } catch (err) { return false; }
    }

    function waitForToken() {
      try {
        var observer = new MutationObserver(function () {
          if (readToken()) observer.disconnect();
        });
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: [TOKEN_ATTRIBUTE]
        });
      } catch (err) { /* fall through to the poll */ }
      var tries = 0;
      var timer = setInterval(function () {
        tries += 1;
        if (readToken() || tries > 40) clearInterval(timer);
      }, 25);
    }

    window.addEventListener(
      'message',
      function (event) {
        try {
          if (event.source !== window) return;
          var data = event.data;
          if (!data || typeof data !== 'object') return;
          if (token === null || data[TAG] !== token) return;
          if (data.type !== T_MATCH_LIST) return;
          installMatchList(data.payload && data.payload.entries);
        } catch (err) { /* hostile page: ignore */ }
      },
      false
    );

    /* ── §5.3 matching ──────────────────────────────────────────────────────── */

    function installMatchList(entries) {
      var next = [];
      if (Object.prototype.toString.call(entries) === '[object Array]') {
        for (var i = 0; i < entries.length; i += 1) {
          try {
            var entry = entries[i];
            next.push({
              sigId: entry.sigId,
              method: String(entry.method || 'GET').toUpperCase(),
              re: new RegExp(entry.urlRegex),
              params: entry.params || [],
              gql: entry.gqlOperation || null,
              changes: entry.changes || []
            });
          } catch (err) { /* a single bad entry must not discard the rest */ }
        }
      }
      matchList = next;
      matchListReady = true;
      releaseGate();
    }

    function absolute(url) {
      try {
        return new URL(String(url), location.href).href;
      } catch (err) { return String(url); }
    }

    /**
     * First match wins per signature; every Change on that signature applies in order
     * (PLAN.md §5.3). Entries arrive sorted most-constrained-first.
     */
    function findChanges(method, url, gqlOperation) {
      if (!matchList.length) return null;
      var parsed;
      try {
        parsed = new URL(url, location.href);
      } catch (err) { return null; }
      var base = parsed.protocol + '//' + parsed.host.toLowerCase() + parsed.pathname;
      var verb = String(method || 'GET').toUpperCase();

      for (var i = 0; i < matchList.length; i += 1) {
        var entry = matchList[i];
        if (entry.method !== verb) continue;
        if (!entry.re.test(base)) continue;
        if (entry.gql && entry.gql !== gqlOperation) continue;
        var ok = true;
        for (var j = 0; j < entry.params.length; j += 1) {
          var name = entry.params[j][0];
          var want = entry.params[j][1];
          if (!parsed.searchParams.has(name)) { ok = false; break; }
          if (want !== '*' && parsed.searchParams.get(name) !== want) { ok = false; break; }
        }
        if (ok) return entry.changes;
      }
      return null;
    }

    /* ── writing values (pre-parsed tokens only — no path parser lives here) ─── */

    function stepExists(container, step) {
      if (container === null || typeof container !== 'object') return false;
      if (step.type === 'index') {
        return (
          Object.prototype.toString.call(container) === '[object Array]' &&
          step.value >= 0 &&
          step.value < container.length
        );
      }
      return Object.prototype.hasOwnProperty.call(container, step.value);
    }

    function setTokens(root, tokens, value) {
      try {
        if (!tokens || !tokens.length) return false;
        var cur = root;
        for (var i = 0; i < tokens.length - 1; i += 1) {
          if (!stepExists(cur, tokens[i])) return false;
          cur = cur[tokens[i].value];
        }
        var last = tokens[tokens.length - 1];
        if (!stepExists(cur, last)) return false;
        cur[last.value] = value;
        return true;
      } catch (err) { return false; }
    }

    /**
     * Apply every matching Change to a fresh copy of the body.
     * Returns the serialized modified body, or null when nothing actually changed.
     */
    function applyChanges(text, changes) {
      var copy;
      try {
        copy = JSON.parse(text);
      } catch (err) { return null; }
      var touched = false;
      for (var i = 0; i < changes.length; i += 1) {
        if (setTokens(copy, changes[i].tokens, changes[i].value)) touched = true;
      }
      if (!touched) return null;
      try {
        return JSON.stringify(copy);
      } catch (err) { return null; }
    }

    /* ── capture reporting ──────────────────────────────────────────────────── */

    function isTextual(contentType) {
      if (!contentType) return true; // unknown: worth a look
      var value = String(contentType).toLowerCase();
      return (
        value.indexOf('json') !== -1 ||
        value.indexOf('text/') === 0 ||
        value.indexOf('javascript') !== -1 ||
        value.indexOf('xml') !== -1 ||
        value.indexOf('x-component') !== -1 ||
        value.indexOf('x-www-form-urlencoded') !== -1
      );
    }

    function unparsed(text) {
      return { __unparsed: true, preview: String(text == null ? '' : text).slice(0, PREVIEW_CHARS) };
    }

    /**
     * Everything the service worker needs to know about a REQUEST body, read once and
     * cached on the request record: the sorted top-level keys (§5.2 bodyShape) and any
     * GraphQL operationName. The body itself never leaves the page (§17.3).
     */
    function requestFacts(record) {
      if (record.facts) return record.facts;
      var facts = { keys: undefined, gql: undefined };
      record.facts = facts;
      try {
        var trimmed = String(record.bodyText || '').trim();
        if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return facts;
        var body = JSON.parse(trimmed);
        if (Object.prototype.toString.call(body) === '[object Array]') {
          var names = [];
          for (var i = 0; i < body.length; i += 1) {
            if (body[i] && typeof body[i].operationName === 'string' && body[i].operationName) {
              names.push(body[i].operationName);
            }
          }
          if (names.length) facts.gql = names.join(',');
          return facts;
        }
        if (!body || typeof body !== 'object') return facts;
        if (typeof body.operationName === 'string' && body.operationName) facts.gql = body.operationName;
        else facts.keys = Object.keys(body).sort();
      } catch (err) { /* a non-JSON body simply has no facts */ }
      return facts;
    }

    /** @param {{method:string,url:string,bodyText:string|null}} info */
    function report(info, via, status, contentType, body, bodyBytes, mocked) {
      try {
        if (info.url.indexOf('http') !== 0) return; // data:, blob:, chrome-extension: — not page data
        post(T_CAPTURED, {
          method: info.method,
          url: info.url,
          status: status,
          contentType: contentType || '',
          body: body,
          bodyBytes: bodyBytes,
          via: via,
          requestBodyKeys: requestFacts(info).keys,
          gqlOperation: requestFacts(info).gql,
          mocked: Boolean(mocked),
          ts: Date.now()
        });
      } catch (err) { /* reporting must never throw into the page */ }
    }

    /* ── fetch patch (PLAN.md §5.1.2) ───────────────────────────────────────── */

    function requestInfo(input, init) {
      var url = null;
      var method = 'GET';
      var bodyText = null;

      if (typeof input === 'string') url = input;
      else if (typeof URL !== 'undefined' && input instanceof URL) url = input.href;
      else if (input && typeof input === 'object' && typeof input.url === 'string') {
        url = input.url;
        method = input.method || 'GET';
      }
      if (url === null) return null;

      if (init && init.method) method = init.method;
      if (init && typeof init.body === 'string') bodyText = init.body;
      else if (init && init.body && typeof URLSearchParams !== 'undefined' && init.body instanceof URLSearchParams) {
        bodyText = init.body.toString();
      }
      return { url: absolute(url), method: String(method).toUpperCase(), bodyText: bodyText };
    }

    /** A Request object's body can only be read asynchronously; do it in parallel. */
    function lateRequestBody(input, init) {
      try {
        if (init && 'body' in init) return null;
        if (!input || typeof input !== 'object' || typeof input.clone !== 'function') return null;
        var verb = String(input.method || 'GET').toUpperCase();
        if (verb === 'GET' || verb === 'HEAD' || !input.body) return null;
        return input.clone().text();
      } catch (err) { return null; }
    }

    function tooLarge(response) {
      try {
        var length = Number(response.headers.get('content-length'));
        return Number.isFinite(length) && length > MAX_BODY_CHARS;
      } catch (err) { return false; }
    }

    function finishFetch(info, response, status, contentType, text) {
      var chars = text ? text.length : 0;
      var parsed = null;
      var isJson = false;
      if (chars <= MAX_BODY_CHARS) {
        try {
          parsed = JSON.parse(text);
          isJson = true;
        } catch (err) { isJson = false; }
      }

      var modified = null;
      if (isJson) {
        var changes = findChanges(info.method, info.url, requestFacts(info).gql);
        if (changes && changes.length) modified = applyChanges(text, changes);
      }

      report(info, 'fetch', status, contentType, isJson ? parsed : unparsed(text), chars, modified !== null);

      // §17.2: nothing matched -> the ORIGINAL Response object leaves this function.
      if (modified === null) return response;
      if (status === 204 || status === 205 || status === 304 || status < 200) return response;
      try {
        var headers = new Headers(response.headers);
        headers.delete('content-length');
        return new Response(modified, {
          status: response.status,
          statusText: response.statusText,
          headers: headers
        });
      } catch (err) { return response; }
    }

    function handleFetchResponse(info, response) {
      var status = 0;
      var contentType = '';
      try { status = response.status; } catch (err) { /* opaque */ }
      try { contentType = response.headers.get('content-type') || ''; } catch (err) { /* opaque */ }

      // §5.1.4 — opaque, binary or oversized: metadata only, never modified.
      var opaque = false;
      try { opaque = response.type === 'opaque' || response.type === 'opaqueredirect' || response.bodyUsed; } catch (err) { /* ignore */ }
      if (opaque || !isTextual(contentType) || tooLarge(response)) {
        report(info, 'fetch', status, contentType, unparsed(''), 0, false);
        return response;
      }

      var clone;
      try {
        clone = response.clone();
      } catch (err) {
        report(info, 'fetch', status, contentType, unparsed(''), 0, false);
        return response;
      }

      return clone.text().then(
        function (text) {
          try {
            return finishFetch(info, response, status, contentType, text);
          } catch (err) { return response; }
        },
        function () {
          return response;
        }
      );
    }

    function patchedFetch(self, args, input, init) {
      var info = null;
      try {
        info = requestInfo(input, init);
      } catch (err) { info = null; }
      var bodyPromise = null;
      try {
        if (info && info.bodyText === null) bodyPromise = lateRequestBody(input, init);
      } catch (err) { bodyPromise = null; }

      var result = realFetch.apply(self, args);
      if (!info || !result || typeof result.then !== 'function') return result;

      return result.then(function (response) {
        try {
          if (!bodyPromise) return handleFetchResponse(info, response);
          return bodyPromise.then(
            function (text) {
              if (text) info.bodyText = text;
              return handleFetchResponse(info, response);
            },
            function () {
              return handleFetchResponse(info, response);
            }
          );
        } catch (err) { return response; }
      });
    }

    if (typeof realFetch === 'function') {
      window.fetch = function (input, init) {
        var self = this;
        var args = arguments;
        if (gateOpen()) return patchedFetch(self, args, input, init);
        return new Promise(function (resolve, reject) {
          whenGateOpen(function () {
            try {
              Promise.resolve(patchedFetch(self, args, input, init)).then(resolve, reject);
            } catch (err) {
              reject(err);
            }
          });
        });
      };
    }

    /* ── XHR patch (PLAN.md §5.1.3) ─────────────────────────────────────────── */

    /**
     * Rather than racing the site's listeners, the modified body is exposed through
     * instance-level `responseText` / `response` getters installed at open() time.
     * Whoever reads first — the site's onload or our own readystatechange listener —
     * triggers the one-shot finalize below, so ordering cannot go wrong.
     */
    function finalizeXhr(xhr, state) {
      if (state.done) return;
      state.done = true;
      try {
        var responseType = String(xhr.responseType || '');
        var status = 0;
        try { status = xhr.status; } catch (err) { /* ignore */ }
        var contentType = '';
        try { contentType = xhr.getResponseHeader('content-type') || ''; } catch (err) { /* ignore */ }

        if (responseType !== '' && responseType !== 'text' && responseType !== 'json') {
          report(state, 'xhr', status, contentType, unparsed(''), 0, false);
          return;
        }

        var text = '';
        try {
          text = textDesc && textDesc.get ? textDesc.get.call(xhr) : xhr.responseText;
        } catch (err) { text = ''; }
        text = text == null ? '' : String(text);
        var chars = text.length;

        var parsed = null;
        var isJson = false;
        if (chars <= MAX_BODY_CHARS) {
          try {
            parsed = JSON.parse(text);
            isJson = true;
          } catch (err) { isJson = false; }
        }

        if (isJson) {
          var changes = findChanges(state.method, state.url, requestFacts(state).gql);
          if (changes && changes.length) state.mockText = applyChanges(text, changes);
        }

        report(state, 'xhr', status, contentType, isJson ? parsed : unparsed(text), chars, state.mockText != null);
      } catch (err) { /* a failed capture must not disturb the request */ }
    }

    function installXhrGetters(xhr, state) {
      if (!textDesc || !textDesc.get || !respDesc || !respDesc.get) return;
      try {
        Object.defineProperty(xhr, 'responseText', {
          configurable: true,
          enumerable: false,
          get: function () {
            try {
              if (this.readyState === 4) {
                finalizeXhr(this, state);
                if (state.mockText != null) return state.mockText;
              }
            } catch (err) { /* fall through to the real value */ }
            return textDesc.get.call(this);
          }
        });
        Object.defineProperty(xhr, 'response', {
          configurable: true,
          enumerable: false,
          get: function () {
            try {
              if (this.readyState === 4) {
                finalizeXhr(this, state);
                if (state.mockText != null) {
                  var responseType = String(this.responseType || '');
                  if (responseType === '' || responseType === 'text') return state.mockText;
                  if (responseType === 'json') return JSON.parse(state.mockText);
                }
              }
            } catch (err) { /* fall through to the real value */ }
            return respDesc.get.call(this);
          }
        });
      } catch (err) { /* a locked-down instance simply goes uncaptured */ }
    }

    if (XHRProto && typeof realOpen === 'function' && typeof realSend === 'function') {
      XHRProto.open = function (method, url, isAsync) {
        try {
          var state = {
            method: String(method || 'GET').toUpperCase(),
            url: absolute(url),
            // A synchronous XHR can never be deferred — the caller is already blocked.
            isAsync: arguments.length < 3 ? true : Boolean(isAsync),
            bodyText: null,
            mockText: null,
            done: false
          };
          xhrState.set(this, state);
          installXhrGetters(this, state);
          var self = this;
          this.addEventListener('readystatechange', function () {
            try {
              if (self.readyState === 4) finalizeXhr(self, state);
            } catch (err) { /* ignore */ }
          });
        } catch (err) { /* uninstrumented XHR still works normally */ }
        return realOpen.apply(this, arguments);
      };

      XHRProto.send = function (body) {
        try {
          var state = xhrState.get(this);
          if (state) {
            if (typeof body === 'string') state.bodyText = body;
            else if (body && typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
              state.bodyText = body.toString();
            }
          }
        } catch (err) { /* ignore */ }

        // XHR exposes responseText synchronously, so the body cannot be swapped after
        // the fact — the send itself waits for the match list instead.
        try {
          var gated = xhrState.get(this);
          if (gated && gated.isAsync && !gateOpen()) {
            var self = this;
            var args = arguments;
            whenGateOpen(function () {
              try { realSend.apply(self, args); } catch (err) { /* aborted meanwhile */ }
            });
            return undefined;
          }
        } catch (err) { /* fall through to an immediate send */ }

        return realSend.apply(this, arguments);
      };
    }

    /* ── SPA soft navigations (PLAN.md §5.1.7) ──────────────────────────────── */

    /**
     * Report every URL change, but collapse the replaceState bursts SPA routers fire
     * at the SAME url — throttling on time alone silently loses real navigations.
     */
    function notifyNav() {
      var href = location.href;
      var now = Date.now();
      if (href === lastNavUrl && now - lastNavPost < SOFT_NAV_THROTTLE_MS) return;
      lastNavUrl = href;
      lastNavPost = now;
      post(T_SOFT_NAV, { url: href });
    }

    try {
      if (typeof realPushState === 'function') {
        window.history.pushState = function () {
          var result = realPushState.apply(this, arguments);
          try { notifyNav(); } catch (err) { /* ignore */ }
          return result;
        };
      }
      if (typeof realReplaceState === 'function') {
        window.history.replaceState = function () {
          var result = realReplaceState.apply(this, arguments);
          try { notifyNav(); } catch (err) { /* ignore */ }
          return result;
        };
      }
      window.addEventListener('popstate', notifyNav, false);
    } catch (err) { /* history is frozen on some pages — capture still works */ }

    if (!readToken()) waitForToken();
  } catch (err) {
    // Swallow: a broken MockLab must still leave the page working.
  }
})();
