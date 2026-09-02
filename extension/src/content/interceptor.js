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

    var INSTALL_FLAG = '__mocklabInterceptorInstalled';   // CONTENT_GLOBALS.interceptorInstalled
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
     *
     * `x-component` is on this list AND handled by the RSC section below, on purpose.
     * handleFetchResponse() reaches the RSC branch first, so the entry here is never the
     * answer for a flight response — it is the NET under it. Delete the RSC branch and a
     * flight response falls back to being refused, which is M7's behaviour and harmless;
     * leave the entry out of this list and the same deletion drops it into the ordinary
     * buffering path instead, which is the hang this comment is about. Both guards have
     * to go before a live stream can be buffered again, and `test/rsc.test.js`'s "never
     * delays the page" is the test that proves it.
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

    /* ═══════════════ RSC flight data (`text/x-component`) — M8 road B ═══════════════
     *
     * The ONE streamed type MockLab edits, and the reason isStreamingType() above is a
     * list rather than a rule.
     *
     * PLAN.md §8 and §15 put RSC out of scope for v1: "detect and mark such sources
     * visible but read-only … do not attempt rewriting". That was written against the
     * only tool then available — buffer the body, rewrite it, hand back a new Response —
     * which on a stream is exactly the hang isStreamingType() exists to prevent. This is
     * the other tool: a TransformStream between the network and the page rewrites rows
     * AS THEY PASS and never awaits the end, so a streamed response stays streamed. The
     * page's `fetch()` still resolves at the headers and its reader still sees the first
     * chunk before the server has sent the last. (Deviation from §8/§15 — recorded in
     * README by the orchestrator, not here.)
     *
     * Everything else on the refusal list stays refused. SSE, ndjson, ndjson-flavoured
     * stream+json and multipart carry no row framing this code can rewrite safely, and
     * their streams may never end at all — for them, metadata-only is still the answer.
     *
     * ── THE WIRE FORMAT, AND WHY ONLY PART OF IT IS EDITABLE ─────────────────────────
     * A flight response is a sequence of rows. Each begins with a lowercase-hex row id
     * and a colon; what follows the colon decides how the row ENDS:
     *
     *   `1:{…}` / `1:[…]`    a MODEL row — JSON, terminated by a newline, with no
     *                        length prefix anywhere in it.
     *   `1:T2a,<0x2a bytes>` a LENGTH-PREFIXED row (text, typed arrays, blobs). The hex
     *                        byte count is framing, and the content may contain
     *                        newlines — and may contain text that looks exactly like
     *                        rows.
     *   `1:I[…]`, `1:HL[…]`  other TAGGED rows: JSON payload, newline-terminated.
     *
     * MockLab rewrites MODEL ROWS ONLY. That is the safety argument, not a shortcut: a
     * model row carries no length to keep correct and no id that moves, so re-serialized
     * it is still a valid row of the same protocol at the same id. Length-prefixed rows
     * are skipped BY THEIR LENGTH, which is also what stops a newline inside a text row
     * from being read as a row boundary and its content from being mangled — the failure
     * a line-splitting parser makes, and the one that corrupts framing.
     *
     * Anything this parser does not recognise — an unknown tag, a header that is not
     * hex, a model row past the cap — switches it to passthrough for the REST of the
     * response: editing stops, the bytes do not change. §1.1: the panel is then shown
     * only the rows MockLab actually parsed, so a field it cannot edit is never offered
     * as one, and a response it understood nothing of stays `{__unparsed}` and keeps
     * saying `source.streamedUnsupported`.
     *
     * PATHS. A captured flight source is an object keyed by ROW ID, holding the real
     * parsed value of every model row: `{"0": {…}, "2": […]}`. So a Change's path reads
     * `$["2"].children[1]` — its first step names the row, the rest addresses inside it.
     * The transform applies a Change only to the row its first token names, which is why
     * one row's edit can never leak into another row that happens to share a shape.
     * ═══════════════════════════════════════════════════════════════════════════════ */

    /** Longest legal row header is a few bytes; past this we are not at a boundary. */
    var RSC_HEADER_MAX = 24;
    /** A model row past this is emitted verbatim rather than held in memory to parse. */
    var RSC_MAX_ROW_BYTES = 512 * 1024;
    /** Bound on what one capture reports to the panel. */
    var RSC_MAX_CAPTURE_ROWS = 400;
    /**
     * Row tags whose payload is framed BY A BYTE LENGTH (`id:T2a,<0x2a bytes>`): text,
     * typed arrays and blobs, whose content may contain anything at all. Skipped by
     * count, never by newline.
     */
    var RSC_LENGTH_TAGS = 'TABOoUSsLlGgMmV';
    /** Row tags whose payload is JSON terminated by a newline. Passed through as-is. */
    var RSC_LINE_TAGS = 'IHEDWRrXxCPNn';

    function isRscType(contentType) {
      return String(contentType || '').toLowerCase().indexOf('x-component') !== -1;
    }

    function hasOwn(object, key) {
      return Object.prototype.hasOwnProperty.call(object, key);
    }

    /** '[' and '{' mean "no tag byte at all": a model row. */
    function rscTagKind(byte) {
      if (byte === 0x5b || byte === 0x7b) return 'json';
      var ch = String.fromCharCode(byte);
      if (RSC_LENGTH_TAGS.indexOf(ch) !== -1) return 'length';
      if (RSC_LINE_TAGS.indexOf(ch) !== -1) return 'line';
      return 'unknown';
    }

    /** Row ids are lowercase hex (the flight parser reads them with `byte - 87`). */
    function isRscHexByte(byte) {
      return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x66);
    }

    function concatBytes(a, b) {
      if (!a || !a.length) return b;
      if (!b || !b.length) return a;
      var out = new Uint8Array(a.length + b.length);
      out.set(a, 0);
      out.set(b, a.length);
      return out;
    }

    /**
     * The row machine: bytes in, bytes out, one row at a time.
     *
     * It NEVER waits for the end of the response, and it holds at most one incomplete
     * model row. Tagged and length-prefixed rows are emitted the moment their bytes
     * arrive, so a chunk that contains no model row passes straight through — which is
     * what keeps a flight stream incremental while it is being edited.
     *
     * `changes` may be null: the capture-only path drives the same machine with no
     * Changes and a discarding sink, so the Sources list and the edit path can never
     * disagree about what a row is.
     *
     * @param {Array<{tokens:Array,value:any}>|null} changes
     */
    function createRscMachine(changes) {
      var decoder = new TextDecoder();
      var encoder = new TextEncoder();
      var buf = new Uint8Array(0);
      var mode = 'header';
      var remaining = 0;
      var colonAt = -1;

      var machine = {
        /** row id -> the REAL parsed value (an edit is always made on a copy). */
        rows: {},
        rowCount: 0,
        /** Rows MockLab saw but could not parse. Never offered to the panel as fields. */
        skippedRows: 0,
        /** Model rows actually rewritten. 0 with Changes present means nothing applied. */
        touched: 0,
        bytes: 0,
        /** True once parsing gave up: from here every byte is forwarded untouched. */
        passthrough: false,
        push: push,
        end: end
      };

      /** Stop parsing, keep every byte. The only failure mode this machine has. */
      function giveUp(emit) {
        machine.passthrough = true;
        if (buf.length) {
          var rest = buf;
          buf = new Uint8Array(0);
          emit(rest);
        }
      }

      function take(count, emit) {
        emit(buf.slice(0, count));
        buf = buf.slice(count);
      }

      function indexOfByte(bytes, byte, from) {
        for (var i = from; i < bytes.length; i += 1) if (bytes[i] === byte) return i;
        return -1;
      }

      /**
       * Rewrite one complete model row, or return its ORIGINAL bytes.
       *
       * Byte-identity is the default and the failure mode: an unparseable row, a row no
       * Change names, a Change whose path is not in it — every one of those returns
       * `rowBytes` itself, not a re-serialization of it.
       */
      function rewriteRow(rowBytes, terminated) {
        var text;
        try {
          text = decoder.decode(rowBytes);
        } catch (err) {
          machine.skippedRows += 1;
          return rowBytes;
        }
        var body = terminated ? text.slice(0, -1) : text;
        var colon = body.indexOf(':');
        if (colon <= 0) { machine.skippedRows += 1; return rowBytes; }
        var id = body.slice(0, colon);
        var payload = body.slice(colon + 1);
        var real;
        try {
          real = JSON.parse(payload);
        } catch (err) {
          machine.skippedRows += 1;
          return rowBytes;
        }
        if (real === null || typeof real !== 'object') { machine.skippedRows += 1; return rowBytes; }

        if (machine.rowCount < RSC_MAX_CAPTURE_ROWS && !hasOwn(machine.rows, id)) {
          machine.rows[id] = real;
          machine.rowCount += 1;
        }
        if (!changes || !changes.length) return rowBytes;

        var copy = null;
        var touched = false;
        for (var i = 0; i < changes.length; i += 1) {
          var tokens = changes[i] && changes[i].tokens;
          // The first token names the ROW. A Change for another row cannot touch this
          // one, however similar the two rows look inside.
          if (!tokens || !tokens.length) continue;
          if (tokens[0].type !== 'key' || String(tokens[0].value) !== id) continue;
          if (copy === null) {
            try {
              copy = JSON.parse(payload);
            } catch (err) {
              return rowBytes;
            }
          }
          if (tokens.length === 1) { copy = changes[i].value; touched = true; continue; }
          if (setTokens(copy, tokens.slice(1), changes[i].value)) touched = true;
        }
        if (!touched) return rowBytes;

        var out;
        try {
          out = encoder.encode(id + ':' + JSON.stringify(copy) + (terminated ? '\n' : ''));
        } catch (err) {
          return rowBytes;
        }
        machine.touched += 1;
        return out;
      }

      /**
       * Consume as much of `buf` as is unambiguous. Returns when it needs more bytes.
       * INVARIANT: a byte is in `buf` or it has been emitted — never both, never neither.
       */
      function run(emit, atEnd) {
        while (!machine.passthrough) {
          if (mode === 'header') {
            // A newline BETWEEN rows: length-framed rows do not need one, and producers
            // differ about writing it. Forward it and stay at the boundary.
            if (buf.length && buf[0] === 0x0a) { take(1, emit); continue; }
            var colon = -1;
            var limit = buf.length < RSC_HEADER_MAX ? buf.length : RSC_HEADER_MAX;
            for (var i = 0; i < limit; i += 1) {
              if (buf[i] === 0x3a) { colon = i; break; }
              if (!isRscHexByte(buf[i])) { giveUp(emit); return; }
            }
            if (colon === -1) {
              if (buf.length >= RSC_HEADER_MAX || atEnd) giveUp(emit);
              return;
            }
            if (colon === 0) { giveUp(emit); return; }   // a row with no id
            if (buf.length < colon + 2) {
              if (atEnd) giveUp(emit);
              return;
            }
            var kind = rscTagKind(buf[colon + 1]);
            if (kind === 'unknown') { giveUp(emit); return; }
            colonAt = colon;
            mode = kind === 'json' ? 'json' : (kind === 'line' ? 'line' : 'lengthHeader');
            continue;
          }

          if (mode === 'lengthHeader') {
            var comma = indexOfByte(buf, 0x2c, colonAt + 2);
            if (comma === -1) {
              if (buf.length >= RSC_HEADER_MAX * 2 || atEnd) giveUp(emit);
              return;
            }
            var hex = '';
            for (var h = colonAt + 2; h < comma; h += 1) hex += String.fromCharCode(buf[h]);
            var size = /^[0-9a-f]+$/.test(hex) ? parseInt(hex, 16) : NaN;
            if (!(size >= 0)) { giveUp(emit); return; }
            remaining = size;
            take(comma + 1, emit);
            mode = 'length';
            continue;
          }

          if (mode === 'length') {
            if (remaining > 0) {
              var chunk = buf.length < remaining ? buf.length : remaining;
              if (chunk > 0) { take(chunk, emit); remaining -= chunk; }
              if (remaining > 0) return;    // the rest of this row is still in flight
            }
            mode = 'header';
            continue;
          }

          if (mode === 'line' || mode === 'overflow') {
            var nl = indexOfByte(buf, 0x0a, 0);
            if (nl === -1) {
              if (buf.length) take(buf.length, emit);
              return;
            }
            take(nl + 1, emit);
            mode = 'header';
            continue;
          }

          if (mode === 'json') {
            var end = indexOfByte(buf, 0x0a, 0);
            if (end === -1) {
              // Held, not forwarded: a model row can only be parsed whole. Past the cap
              // it is forwarded verbatim and the rest of the row is skipped, so an
              // enormous row costs bounded memory instead of unbounded.
              if (buf.length > RSC_MAX_ROW_BYTES) {
                take(buf.length, emit);
                mode = 'overflow';
                continue;
              }
              return;
            }
            var row = buf.slice(0, end + 1);
            buf = buf.slice(end + 1);
            emit(rewriteRow(row, true));
            mode = 'header';
            continue;
          }

          return;
        }
      }

      /**
       * @param {Uint8Array} chunk
       * @param {(bytes:Uint8Array) => void} emit
       */
      function push(chunk, emit) {
        if (!chunk || !chunk.length) return;
        machine.bytes += chunk.length;
        if (machine.passthrough) { emit(chunk); return; }
        if (typeof chunk.byteLength !== 'number' || typeof chunk.slice !== 'function') {
          giveUp(emit);
          emit(chunk);
          return;
        }
        try {
          buf = concatBytes(buf, chunk);
          run(emit, false);
        } catch (err) {
          // Whatever went wrong, the bytes are still either in `buf` or already out.
          try { giveUp(emit); } catch (inner) { /* the sink is gone too */ }
        }
      }

      /** End of the response: nothing is left holding. */
      function end(emit) {
        if (machine.passthrough) return;
        try {
          run(emit, true);
        } catch (err) { /* fall through to the flush below */ }
        if (!buf.length) return;
        var rest = buf;
        buf = new Uint8Array(0);
        // A final model row the server never terminated is complete now — the stream
        // ending is its terminator — so it is rewritten without one.
        emit(mode === 'json' ? rewriteRow(rest, false) : rest);
      }

      return machine;
    }

    /**
     * The capture a flight response yields: an object keyed by row id, or `{__unparsed}`
     * when no model row could be read. `changeDropped` is true when a Change matched this
     * signature and NO row took it — §1.1, the panel must be able to say the edit did not
     * apply rather than let the user believe it did.
     */
    function reportRsc(info, status, contentType, machine, hadChanges) {
      try {
        if (machine.rowCount === 0) {
          report(info, 'fetch', status, contentType, unparsed(''), machine.bytes, false, hadChanges);
          return;
        }
        report(
          info, 'fetch', status, contentType, machine.rows, machine.bytes,
          machine.touched > 0, hadChanges && machine.touched === 0
        );
      } catch (err) { /* capture is best-effort */ }
    }

    /**
     * No Change matched, so the ORIGINAL Response goes back to the page untouched and a
     * CLONE is walked in the background purely to fill the Sources list.
     *
     * This is the one place MockLab clones a streamed response. It is safe because the
     * page's own Response is handed back first and never waited on, because the reader
     * is owned here (so `cancel()` is legal and its promise is handled — see
     * readWithDeadline's note), and because the deadline below releases the clone whether
     * or not the server is done. A flight response for a client navigation ends; one that
     * does not is let go of, and the panel shows the rows that had arrived.
     */
    function captureRsc(info, response, status, contentType, readable) {
      if (!readable) {
        report(info, 'fetch', status, contentType, unparsed(''), 0, false);
        return;
      }
      var reader = null;
      try {
        reader = response.clone().body.getReader();
      } catch (err) {
        reader = null;
      }
      if (!reader) {
        report(info, 'fetch', status, contentType, unparsed(''), 0, false);
        return;
      }

      var machine = createRscMachine(null);
      var discard = function () { /* capture only: the page has its own copy */ };
      var done = false;
      var timer = null;

      function finish() {
        if (done) return;
        done = true;
        if (timer !== null) { clearTimeout(timer); timer = null; }
        try { machine.end(discard); } catch (err) { /* partial is still a capture */ }
        reportRsc(info, status, contentType, machine, false);
      }

      function release() {
        try {
          var cancelled = reader.cancel();
          if (cancelled && typeof cancelled.then === 'function') {
            cancelled.then(null, function () { /* already closed — not the page's problem */ });
          }
        } catch (err) { /* already released */ }
      }

      timer = setTimeout(function () { release(); finish(); }, CAPTURE_READ_TIMEOUT_OTHER_MS);

      function pump() {
        reader.read().then(
          function (chunk) {
            if (done) return;
            if (chunk.done) { finish(); return; }
            try { machine.push(chunk.value, discard); } catch (err) { /* keep going */ }
            if (machine.bytes > MAX_BODY_CHARS) { release(); finish(); return; }
            pump();
          },
          function () { finish(); }
        );
      }
      pump();
    }

    /**
     * `text/x-component`, the only streamed type that is edited rather than refused.
     * Returns the ORIGINAL Response unless a Change matched AND the transform could be
     * installed (§17.2).
     */
    function handleRsc(info, response, status, contentType) {
      var changes = findChanges(info.method, info.url, requestFacts(info).gql);
      var hadChanges = Boolean(changes && changes.length);
      var body = null;
      try { body = response.body; } catch (err) { body = null; }
      var canTransform = Boolean(
        body &&
        typeof body.pipeThrough === 'function' &&
        typeof TransformStream !== 'undefined' &&
        typeof TextDecoder !== 'undefined' &&
        typeof TextEncoder !== 'undefined' &&
        status >= 200 && status !== 204 && status !== 205 && status !== 304
      );

      if (!hadChanges) {
        captureRsc(info, response, status, contentType, canTransform);
        return response;
      }
      if (!canTransform) {
        // A Change matched a response this code cannot rewrite in flight. Deviation 16's
        // flag says so; the page gets the untouched original either way.
        report(info, 'fetch', status, contentType, unparsed(''), 0, false, true);
        return response;
      }

      try {
        var machine = createRscMachine(changes);
        var reported = false;
        var finish = function () {
          if (reported) return;
          reported = true;
          reportRsc(info, status, contentType, machine, true);
        };
        var transform = new TransformStream({
          transform: function (chunk, controller) {
            try {
              machine.push(chunk, function (bytes) { controller.enqueue(bytes); });
            } catch (err) { /* push already forwarded what it held */ }
          },
          flush: function (controller) {
            try {
              machine.end(function (bytes) { controller.enqueue(bytes); });
            } catch (err) { /* the tail is gone; the page still gets a clean end */ }
            finish();
          },
          /**
           * The page let go of the body. `pipeThrough` aborts the source for us — that is
           * how cancellation reaches the network — so this exists only to report the
           * partial capture. Chromium calls it; older engines ignore an unknown key, and
           * then a cancelled flight response simply reports nothing.
           */
          cancel: function () { finish(); }
        });
        var headers = new Headers(response.headers);
        headers.delete('content-length');   // a rewritten row is a different length
        return new Response(body.pipeThrough(transform), {
          status: response.status,
          statusText: response.statusText,
          headers: headers
        });
      } catch (err) {
        report(info, 'fetch', status, contentType, unparsed(''), 0, false, true);
        return response;
      }
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
    function reportBody(info, via, status, contentType, text, mocked, changeDropped, truncated, bytesHint) {
      var chars = text ? text.length : 0;
      var parsed = null;
      var isJson = false;
      // A truncated read is a PREFIX of the body, so parsing it would either fail or —
      // worse — succeed on a prefix that happens to be valid JSON and present a partial
      // body as the whole thing. §4 says such a body is a preview and nothing more.
      if (!truncated && text !== null && chars <= MAX_BODY_CHARS) {
        try {
          parsed = JSON.parse(text);
          isJson = true;
        } catch (err) { isJson = false; }
      }
      var bytes = typeof bytesHint === 'number' && bytesHint > chars ? bytesHint : chars;
      report(info, via, status, contentType, isJson ? parsed : unparsed(text), bytes, mocked, changeDropped);
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

    /** The declared body size, or null when the response does not say. */
    function declaredLength(response) {
      try {
        var length = Number(response.headers.get('content-length'));
        return Number.isFinite(length) && length >= 0 ? length : null;
      } catch (err) { return null; }
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
     * Resolves with `{text, truncated}`:
     *   - the whole body               -> {text: "…", truncated: false}
     *   - stopped at `maxChars`        -> {text: "<prefix>", truncated: true}
     *   - deadline, or a read error    -> {text: null,  truncated: false}
     *
     * The size cap USED to resolve null as well, which is how a body over §4's 2 MB
     * limit ended up reported with an empty preview instead of the 512-character one
     * §4 asks for: the caller could not tell "never arrived" from "arrived, too big".
     * They are different facts and the panel says different things about them.
     */
    function readWithDeadline(clone, ms, maxChars) {
      return new Promise(function (resolve) {
        var settled = false;
        var reader = null;
        var timer = null;
        var decoder = null;
        var text = '';
        var bytes = 0;

        function finish(value, truncated) {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          resolve({ text: value, truncated: Boolean(truncated) });
        }

        /**
         * Let the stream go, and handle cancel()'s promise. `keep` is the prefix worth
         * reporting: a size-capped read still has a real preview to show, a timed-out
         * one has nothing trustworthy.
         */
        function abandon(keep) {
          if (settled) return;
          if (reader) {
            try {
              var cancelled = reader.cancel();
              if (cancelled && typeof cancelled.then === 'function') {
                cancelled.then(null, function () { /* already closed — not the page's problem */ });
              }
            } catch (err) { /* already released */ }
          }
          if (keep) finish(text, true);
          else finish(null, false);
        }

        try {
          if (!clone.body || typeof clone.body.getReader !== 'function') {
            // No stream at all (an empty body): there is nothing to read or release.
            finish('', false);
            return;
          }
          reader = clone.body.getReader();
          decoder = new TextDecoder();
        } catch (err) {
          finish(null, false);
          return;
        }

        var cap = typeof maxChars === 'number' && maxChars > 0 ? maxChars : MAX_BODY_CHARS;
        timer = setTimeout(function () { abandon(false); }, ms);

        function pump() {
          reader.read().then(
            function (chunk) {
              if (settled) return;
              if (chunk.done) {
                try { text += decoder.decode(); } catch (err) { /* trailing bytes */ }
                finish(text, false);
                return;
              }
              bytes += chunk.value ? chunk.value.length : 0;
              try {
                text += decoder.decode(chunk.value, { stream: true });
              } catch (err) { /* undecodable chunk: keep what we have */ }
              // Bounded memory as well as bounded time: an endless body is released as
              // soon as it passes the size this read could ever use — and the prefix
              // already decoded is kept, because that is the §4 preview.
              if (bytes > cap || text.length > cap) { abandon(true); return; }
              pump();
            },
            function () { finish(null, false); }
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
    function captureInBackground(info, response, status, contentType, cap, bytesHint, changeDropped) {
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
      readWithDeadline(clone, deadline, cap).then(function (result) {
        try {
          reportBody(
            info, 'fetch', status, contentType,
            result.text, false, Boolean(changeDropped), result.truncated, bytesHint
          );
        } catch (err) { /* capture is best-effort */ }
      });
    }

    function handleFetchResponse(info, response) {
      var status = 0;
      var contentType = '';
      try { status = response.status; } catch (err) { /* opaque */ }
      try { contentType = response.headers.get('content-type') || ''; } catch (err) { /* opaque */ }

      // §5.1.4 — opaque, binary or streamed: metadata only, never read, never cloned,
      // never modified. (An oversized body is handled below: it CAN be read far enough
      // for a preview, which a live stream cannot.)
      var opaque = false;
      try { opaque = response.type === 'opaque' || response.type === 'opaqueredirect' || response.bodyUsed; } catch (err) { /* ignore */ }
      // An opaque response has no readable body at all, so RSC or not, there is nothing
      // to transform. Everything else streamed stays refused EXCEPT `text/x-component`,
      // which the RSC section rewrites in flight without ever awaiting the end.
      //
      // THIS LINE COMES FIRST, AND THE REFUSAL BELOW STILL LISTS `x-component`. That
      // order is the whole safety property: delete this line and a flight response is
      // refused exactly as it was at M7 — captured metadata-only, page unharmed — rather
      // than falling through into the buffering path the refusal exists to keep it out of.
      // Written the other way round (one condition, an `isRscType` hole punched in it),
      // deleting the branch silently sends live streams to be buffered. Measured, not
      // assumed: `test/rsc.test.js`'s "never delays the page" is the test that separates
      // the two, and it passes with EITHER guard present and fails only with both gone.
      if (!opaque && isRscType(contentType)) return handleRsc(info, response, status, contentType);

      if (opaque || !isTextual(contentType) || isStreamingType(contentType)) {
        // Never read, never cloned: there is no preview to be had, and pretending
        // otherwise would mean holding a live stream open to get one.
        report(info, 'fetch', status, contentType, unparsed(''), 0, false);
        return response;
      }

      // Matching needs only the method, the URL and the REQUEST body — never the
      // response body — so the decision to buffer at all is made before buffering.
      var changes = findChanges(info.method, info.url, requestFacts(info).gql);
      var declared = declaredLength(response);
      var oversized = declared !== null && declared > MAX_BODY_CHARS;

      // §4: over 2 MB the body is stored as `{__unparsed}` with a preview. So it is
      // still read — just far enough for the 512 characters §4 asks for, and no
      // further. Reporting an empty preview here used to leave the panel showing an
      // apparently blank source with no way to tell what it was.
      if (oversized) {
        // A Change that matched a body this large is DROPPED, not applied. Deviation 16's
        // flag rides along on the one capture, rather than arriving as a second capture
        // that the preview would then overwrite.
        var dropped = Boolean(changes && changes.length);
        captureInBackground(info, response, status, contentType, PREVIEW_CHARS, declared, dropped);
        return response;
      }

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

      return readWithDeadline(clone, MODIFY_READ_TIMEOUT_MS, MAX_BODY_CHARS).then(function (result) {
        try {
          if (result.text === null) {
            // Never arrived in time: hand back the untouched original rather than hang.
            // A Change DID match, so the capture is flagged — the panel must be able to
            // say the edit did not apply instead of leaving the user guessing.
            report(info, 'fetch', status, contentType, unparsed(''), 0, false, true);
            return response;
          }
          if (result.truncated) {
            // No content-length, but it went past 2 MB while we read it. Same honest
            // outcome as the declared-oversize path: preview only, edit not applied.
            reportBody(info, 'fetch', status, contentType, result.text, false, true, true);
            return response;
          }
          return finishFetch(info, response, status, contentType, result.text, changes);
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
        var oversized = text.length > MAX_BODY_CHARS;
        if (changes && changes.length && !oversized) {
          state.mockText = applyChanges(text, changes);
        }

        // Over §4's 2 MB the body is a preview only, so a matching Change cannot be
        // applied — Deviation 16's flag says so rather than letting it look applied.
        reportBody(
          state, 'xhr', status, contentType, text,
          state.mockText != null, Boolean(changes && changes.length && oversized)
        );
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
