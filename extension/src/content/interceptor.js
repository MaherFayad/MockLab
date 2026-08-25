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
    /** Deadline for buffering a body we intend to REWRITE. Expiry = hand back the original. */
    var MODIFY_READ_TIMEOUT_MS = 3000;
    /**
     * Deadlines for the background read that only feeds the Sources list. A response
     * that declares JSON is worth waiting for; anything else textual is at best a 512
     * character preview, so it is released far sooner. This is what bounds how long
     * MockLab keeps a socket alive after the page itself has let go: an endless
     * text/plain body is released after this, not held until the JSON deadline.
     */
    var CAPTURE_READ_TIMEOUT_MS = 5000;
    var CAPTURE_READ_TIMEOUT_OTHER_MS = 1500;

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

    function groupParams(params) {
      var groups = [];
      var list = params || [];
      for (var i = 0; i < list.length; i += 1) {
        var name = list[i][0];
        var group = null;
        for (var j = 0; j < groups.length; j += 1) {
          if (groups[j].name === name) { group = groups[j]; break; }
        }
        if (!group) { group = { name: name, values: [] }; groups.push(group); }
        group.values.push(list[i][1]);
      }
      return groups;
    }

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
              // Grouped once, here, so a repeated param name (?a=1&a=2) is matched as a
              // multiset rather than by searchParams.get(), which only sees the first.
              paramGroups: groupParams(entry.params),
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
        for (var j = 0; j < entry.paramGroups.length; j += 1) {
          var group = entry.paramGroups[j];
          var pool = parsed.searchParams.getAll(group.name);
          if (pool.length < group.values.length) { ok = false; break; }
          pool = pool.slice();
          var wildcards = 0;
          for (var k = 0; k < group.values.length; k += 1) {
            var want = group.values[k];
            // null (not the string "*") means "any value": a param whose real value is
            // literally "*" is a normal literal and must not match everything.
            if (want === null) { wildcards += 1; continue; }
            var at = pool.indexOf(want);
            if (at === -1) { ok = false; break; }
            pool.splice(at, 1);
          }
          if (!ok || pool.length < wildcards) { ok = false; break; }
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
        value.indexOf('x-www-form-urlencoded') !== -1
      );
    }

    /**
     * Content types that are a LIVE STREAM, not a document with an end.
     *
     * Reading one to completion never completes, so a patch that awaits the body before
     * handing the Response back leaves the page hanging forever — a ticker or chat UI
     * simply stops working, on every site, with zero Changes configured. `bodyUsed` is
     * always false at that moment, so §5.1.4's streaming guard cannot catch this on its
     * own: the content type has to. These are captured metadata-only (§5.1.4) and their
     * body is never read and never cloned.
     */
    function isStreamingType(contentType) {
      var value = String(contentType || '').toLowerCase();
      return (
        value.indexOf('event-stream') !== -1 ||   // Server-Sent Events
        value.indexOf('x-component') !== -1 ||    // Next.js App Router RSC flight data
        value.indexOf('x-ndjson') !== -1 ||
        value.indexOf('stream+json') !== -1 ||
        value.indexOf('multipart/') === 0
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

    /**
     * Parse a body if it is JSON and small enough, report the capture, and say whether
     * it parsed. The captured body is always the REAL one — `mocked` records that a
     * Change was applied on the way out, so the panel can show real vs new.
     */
    function reportBody(info, via, status, contentType, text, mocked, changeDropped) {
      var chars = text ? text.length : 0;
      var parsed = null;
      var isJson = false;
      if (text !== null && chars <= MAX_BODY_CHARS) {
        try {
          parsed = JSON.parse(text);
          isJson = true;
        } catch (err) { isJson = false; }
      }
      report(info, via, status, contentType, isJson ? parsed : unparsed(text), chars, mocked, changeDropped);
      return isJson;
    }

    /**
     * @param {{method:string,url:string,bodyText:string|null}} info
     * @param {boolean} [changeDropped] a Change matched but the body did not arrive in
     *   time to rewrite it, so the page got the real response. Never silent: the panel
     *   surfaces it (PLAN.md §1 — never lie about what happened).
     */
    function report(info, via, status, contentType, body, bodyBytes, mocked, changeDropped) {
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
          changeDropped: Boolean(changeDropped),
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

    function finishFetch(info, response, status, contentType, text, changes) {
      // applyChanges returns null for a non-JSON body, so nothing else needs checking.
      var modified = applyChanges(text, changes);

      reportBody(info, 'fetch', status, contentType, text, modified !== null);

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

    /**
     * Read a cloned body with a deadline and a size cap, owning the reader throughout.
     *
     * MockLab owns the reader deliberately. `clone.text()` LOCKS the body, so the
     * obvious `clone.body.cancel()` on timeout returns a REJECTED promise that no
     * try/catch around the call can catch — it surfaces on the page as an
     * `unhandledrejection` with no MockLab frame on the stack, so a site running Sentry
     * or its own handler logs an error caused purely by MockLab being installed. Worse,
     * the read carries on: an endless response keeps its socket open and keeps
     * buffering long after the page has let go of its own reader.
     *
     * Holding the reader ourselves makes `reader.cancel()` legal (we hold the lock),
     * its promise ours to handle, and the release real.
     *
     * Resolves with the decoded text, or null when the deadline or the size cap hit.
     */
    function readWithDeadline(clone, ms) {
      return new Promise(function (resolve) {
        var settled = false;
        var reader = null;
        var timer = null;
        var decoder = null;
        var text = '';
        var bytes = 0;

        function finish(value) {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          resolve(value);
        }

        /** Deadline or size cap: let the stream go, and handle cancel()'s promise. */
        function abandon() {
          if (settled) return;
          if (reader) {
            try {
              var cancelled = reader.cancel();
              if (cancelled && typeof cancelled.then === 'function') {
                cancelled.then(null, function () { /* already closed — not the page's problem */ });
              }
            } catch (err) { /* already released */ }
          }
          finish(null);
        }

        try {
          if (!clone.body || typeof clone.body.getReader !== 'function') {
            // No stream at all (an empty body): there is nothing to read or release.
            finish('');
            return;
          }
          reader = clone.body.getReader();
          decoder = new TextDecoder();
        } catch (err) {
          finish(null);
          return;
        }

        timer = setTimeout(abandon, ms);

        function pump() {
          reader.read().then(
            function (chunk) {
              if (settled) return;
              if (chunk.done) {
                try { text += decoder.decode(); } catch (err) { /* trailing bytes */ }
                finish(text);
                return;
              }
              bytes += chunk.value ? chunk.value.length : 0;
              try {
                text += decoder.decode(chunk.value, { stream: true });
              } catch (err) { /* undecodable chunk: keep what we have */ }
              // Bounded memory as well as bounded time: an endless body is released
              // as soon as it passes the size a capture could ever use (§4).
              if (bytes > MAX_BODY_CHARS) { abandon(); return; }
              pump();
            },
            function () { finish(null); }
          );
        }
        pump();
      });
    }

    /**
     * No Change can apply to this response, so the ORIGINAL Response goes back to the
     * page IMMEDIATELY — its promise resolves exactly when it would without MockLab —
     * and the clone is read afterwards purely so the Sources list has something in it.
     */
    function captureInBackground(info, response, status, contentType) {
      var clone;
      try {
        clone = response.clone();
      } catch (err) {
        report(info, 'fetch', status, contentType, unparsed(''), 0, false);
        return;
      }
      var deadline = String(contentType || '').toLowerCase().indexOf('json') !== -1
        ? CAPTURE_READ_TIMEOUT_MS
        : CAPTURE_READ_TIMEOUT_OTHER_MS;
      readWithDeadline(clone, deadline).then(function (text) {
        try {
          reportBody(info, 'fetch', status, contentType, text, false);
        } catch (err) { /* capture is best-effort */ }
      });
    }

    function handleFetchResponse(info, response) {
      var status = 0;
      var contentType = '';
      try { status = response.status; } catch (err) { /* opaque */ }
      try { contentType = response.headers.get('content-type') || ''; } catch (err) { /* opaque */ }

      // §5.1.4 — opaque, binary, streamed or oversized: metadata only, never read,
      // never cloned, never modified.
      var opaque = false;
      try { opaque = response.type === 'opaque' || response.type === 'opaqueredirect' || response.bodyUsed; } catch (err) { /* ignore */ }
      if (opaque || !isTextual(contentType) || isStreamingType(contentType) || tooLarge(response)) {
        report(info, 'fetch', status, contentType, unparsed(''), 0, false);
        return response;
      }

      // Matching needs only the method, the URL and the REQUEST body — never the
      // response body — so the decision to buffer at all is made before buffering.
      var changes = findChanges(info.method, info.url, requestFacts(info).gql);
      if (!changes || !changes.length) {
        captureInBackground(info, response, status, contentType);
        return response;
      }

      var clone;
      try {
        clone = response.clone();
      } catch (err) {
        report(info, 'fetch', status, contentType, unparsed(''), 0, false);
        return response;
      }

      return readWithDeadline(clone, MODIFY_READ_TIMEOUT_MS).then(function (text) {
        try {
          if (text === null) {
            // Never arrived in time: hand back the untouched original rather than hang.
            // A Change DID match, so the capture is flagged — the panel must be able to
            // say the edit did not apply instead of leaving the user guessing.
            report(info, 'fetch', status, contentType, unparsed(''), 0, false, true);
            return response;
          }
          return finishFetch(info, response, status, contentType, text, changes);
        } catch (err) { return response; }
      });
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
     *
     * This deliberately diverges from §5.1.3's capture-phase `readystatechange` recipe
     * (README "Deviations"): XMLHttpRequest is not a DOM tree, so `{capture:true}` does
     * NOT make a listener fire first — listeners run in registration order, and a site
     * that assigns `onreadystatechange` before calling send() would read the real body
     * before our listener ever ran. A lazy getter cannot lose that race.
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

        // status 0 means the request was aborted, blocked or failed at the network
        // layer: there is no response to show, so it never becomes a data source.
        if (!status) return;

        if (responseType !== '' && responseType !== 'text' && responseType !== 'json') {
          report(state, 'xhr', status, contentType, unparsed(''), 0, false);
          return;
        }

        var text = '';
        try {
          text = textDesc && textDesc.get ? textDesc.get.call(xhr) : xhr.responseText;
        } catch (err) { text = ''; }
        text = text == null ? '' : String(text);

        var changes = findChanges(state.method, state.url, requestFacts(state).gql);
        if (changes && changes.length && text.length <= MAX_BODY_CHARS) {
          state.mockText = applyChanges(text, changes);
        }

        reportBody(state, 'xhr', status, contentType, text, state.mockText != null);
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
