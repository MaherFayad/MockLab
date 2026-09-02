/**
 * A page for `interceptor.js` to be installed into, a flight-protocol fixture to serve
 * it, and an INDEPENDENT reader for the bytes that come out the other side.
 *
 * OWNER: interceptor-engineer. Used by `test/rsc.test.js` and `test/rscframing.test.js`.
 *
 * WHY THIS DIRECTORY: `node --test` executes EVERY .js file under `test/`, so a helper
 * module there would run as a suite with no tests in it. See `audit.js` beside this file
 * for the fuller note, including why a helper directory is not a blind spot.
 *
 * ── WHY THE REAL FILE IS LOADED, RATHER THAN A COPY OF ITS LOGIC ──────────────────────
 * `interceptor.js` is a MAIN-world IIFE with no exports, so the tempting thing is to
 * re-implement its parser in the test and assert against that. `signatures.test.js` did
 * exactly that for the in-page matcher and says so in its own header; a mirrored parser
 * proves the mirror, not the product. Instead `install()` below runs the GENUINE source
 * with `new Function`, handing it the four globals it reaches for. Every byte asserted on
 * in these suites has been through the same code Chromium runs.
 *
 * ── WHAT IS FAITHFUL ABOUT `FLIGHT`, AND WHAT IS RECONSTRUCTION ───────────────────────
 * FAITHFUL — the grammar, which is what the parser under test actually reads:
 *   • rows are `<lowercase-hex id>:<payload>`;
 *   • a payload starting `[` or `{` is a model row, terminated by `\n`, with no length
 *     anywhere in it;
 *   • `T` rows are `<id>:T<hex BYTE length>,<raw text>` with NO trailing newline, and
 *     their text may contain newlines — this is React's `emitTextChunk`;
 *   • `I[…]` (client module) and `HL[…]` (preload hint) rows are newline-terminated JSON;
 *   • `"$L1"`, `"$3"` and `"$undefined"` are the reference sigils that make one row's
 *     value live in another row.
 * RECONSTRUCTION — the CONTENT: the build id, the module ids, the router tree and the
 * flight card below were written by hand to exercise the parser. They were not captured
 * from a running Next.js server; this sandbox has no outbound network. So these fixtures
 * prove the parser handles the FORMAT, and they cannot prove the format is complete —
 * which is exactly why every unrecognised construct in `interceptor.js` falls back to
 * passing bytes through untouched instead of guessing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalize, compileMatchList } from '../src/background/signatures.js';
import { parsePath } from '../src/shared/jsonpath.js';

const EXTENSION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(EXTENSION, 'src', 'content', 'interceptor.js'), 'utf8');

export const ORIGIN = 'http://site.test';
export const RSC_TYPE = 'text/x-component';

export const enc = (text) => Buffer.from(text, 'utf8');
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `<id>:T<hex byte length>,<text>` — React's text row, length in BYTES, no newline. */
export const textRow = (id, text) =>
  enc(`${id}:T${Buffer.byteLength(text, 'utf8').toString(16)},${text}`);

/**
 * The text row of the fixture carries a line that LOOKS like a model row. A parser that
 * splits on newlines will find it, "fix" the status inside it, and leave the row's byte
 * length describing a number of bytes that is no longer there. That is the corruption
 * this fixture exists to catch, and `readFlight` below is what notices it.
 */
export const TRAP_TEXT = 'Gate A12 — boarding\n5:{"status":"CANCELLED"}\nsee the desk';

export const FLIGHT_ROWS = [
  enc(
    '0:{"b":"XN4tR8bqzQ","p":"","c":["","flights","LH401"],"i":false,' +
      '"f":[[["",{"children":["flights",{"children":[["id","LH401","d"],' +
      '{"children":["__PAGE__",{}]}]}]},"$undefined","$undefined",true]]],"G":["$L1",[]]}\n'
  ),
  enc('1:I[4707,["272","static/chunks/webpack-9d2b8c.js","231","static/chunks/main-app.js"],"ClientPageRoot"]\n'),
  enc('2:HL["/_next/static/css/app/layout.css","style"]\n'),
  textRow('3', TRAP_TEXT),
  enc(
    '4:["$","div",null,{"className":"card","children":[["$","span","pill",' +
      '{"className":"pill","children":"On time"}],["$","p","gate",{"children":"$3"}]],' +
      '"status":"ON_TIME","price":{"total":450,"currency":"EUR"}}]\n'
  ),
  enc('5:{"status":"ON_TIME","gate":"A12"}\n')
];

/** The whole response, as one buffer. Deterministic: every suite asserts against it. */
export const FLIGHT = Buffer.concat(FLIGHT_ROWS);

/** Offset of the first byte of row `id` inside FLIGHT. */
export function rowOffset(index) {
  let at = 0;
  for (let i = 0; i < index; i += 1) at += FLIGHT_ROWS[i].length;
  return at;
}

/* ───────────────────────────────── the independent reader ─────────────────────────── */

const LENGTH_TAGS = 'TABOoUSsLlGgMmV';

/**
 * Read a flight response the way a client does, and THROW on anything that is not
 * well-framed. Deliberately a second implementation: it is the only thing in these
 * suites that can tell "MockLab rewrote a row" from "MockLab broke the protocol".
 *
 * @param {Buffer} buffer
 * @returns {{id:string, kind:string, value?:any, text?:string, payload?:string}[]}
 */
export function readFlight(buffer) {
  const rows = [];
  let i = 0;
  while (i < buffer.length) {
    if (buffer[i] === 0x0a) { i += 1; continue; }
    const colon = buffer.indexOf(0x3a, i);
    if (colon === -1) throw new Error(`row header with no colon at byte ${i}`);
    const id = buffer.toString('latin1', i, colon);
    if (!/^[0-9a-f]+$/.test(id)) throw new Error(`bad row id ${JSON.stringify(id)} at byte ${i}`);
    const tag = String.fromCharCode(buffer[colon + 1]);

    if (tag === '[' || tag === '{') {
      let nl = buffer.indexOf(0x0a, colon + 1);
      if (nl === -1) nl = buffer.length;
      const payload = buffer.toString('utf8', colon + 1, nl);
      let value;
      try {
        value = JSON.parse(payload);
      } catch (err) {
        throw new Error(`row ${id} is not valid JSON: ${payload.slice(0, 120)}`);
      }
      rows.push({ id, kind: 'model', value });
      i = nl + 1;
      continue;
    }

    if (LENGTH_TAGS.includes(tag)) {
      const comma = buffer.indexOf(0x2c, colon + 2);
      if (comma === -1) throw new Error(`row ${id} is length-framed with no comma`);
      const hex = buffer.toString('latin1', colon + 2, comma);
      if (!/^[0-9a-f]+$/.test(hex)) throw new Error(`row ${id} has a bad length ${JSON.stringify(hex)}`);
      const size = parseInt(hex, 16);
      const start = comma + 1;
      if (start + size > buffer.length) {
        throw new Error(`row ${id} declares ${size} bytes; only ${buffer.length - start} remain`);
      }
      rows.push({ id, kind: tag, text: buffer.toString('utf8', start, start + size) });
      i = start + size;
      continue;
    }

    let nl = buffer.indexOf(0x0a, colon + 1);
    if (nl === -1) nl = buffer.length;
    rows.push({ id, kind: tag, payload: buffer.toString('utf8', colon + 2, nl) });
    i = nl + 1;
  }
  return rows;
}

/* ─────────────────────────────────── the page ─────────────────────────────────────── */

/**
 * Install the REAL `interceptor.js` into a fake page.
 *
 * `new Function` rather than `vm`: the patch is handed the four globals it names, and
 * everything else (Response, TransformStream, TextDecoder) resolves to this realm's own,
 * so `instanceof` and `Object.prototype.toString` mean what the code expects.
 *
 * @param {(input:any, init?:any) => Promise<Response>} realFetch
 */
export function install(realFetch) {
  const posted = [];
  const messageListeners = [];
  const token = 'rsc-test-token';

  const documentElement = {
    attributes: { 'data-mocklab-token': token },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    },
    removeAttribute(name) { delete this.attributes[name]; }
  };

  const win = {
    fetch: realFetch,
    // A bare function: its prototype has no open/send, so the XHR patch declines to
    // install itself, which is the correct behaviour and keeps this page to one subject.
    XMLHttpRequest: function XMLHttpRequestStub() {},
    history: { pushState() {}, replaceState() {} },
    addEventListener(type, handler) { if (type === 'message') messageListeners.push(handler); },
    postMessage(frame) { posted.push(frame); }
  };

  function MutationObserverStub() {
    this.observe = () => {};
    this.disconnect = () => {};
  }

  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'location', 'MutationObserver', SOURCE)(
    win,
    { documentElement },
    { href: `${ORIGIN}/flights/LH401` },
    MutationObserverStub
  );

  return {
    window: win,
    fetch: (...args) => win.fetch(...args),
    /** Every `page:captured` payload, in order. */
    captures: () => posted.filter((frame) => frame && frame.type === 'page:captured').map((frame) => frame.payload),
    /**
     * Hand the patch a compiled match list, exactly as `agent.js` does. Always call this
     * — including with `[]` — or the first fetch of the page waits out the one-second
     * match-list gate before it does anything at all.
     */
    setMatchList(entries) {
      for (const handler of messageListeners) {
        handler({ source: win, data: { __mocklab: token, type: 'page:matchList', payload: { entries } } });
      }
    }
  };
}

/**
 * A compiled match list for `url`, built by the REAL service-worker code: `normalize()`
 * makes the signature, `parsePath()` makes the tokens, `compileMatchList()` compiles the
 * entry. Nothing here is hand-written, so a test proves the whole chain rather than the
 * shape of a literal somebody typed.
 *
 * @param {string} url
 * @param {{path:string, value:any}[]} changes
 */
export async function matchListFor(url, changes, method = 'GET') {
  const signature = await normalize(method, url);
  return compileMatchList([
    {
      sigId: signature.sigId,
      signature,
      changes: changes.map((change) => ({
        path: change.path,
        tokens: parsePath(change.path),
        value: change.value
      }))
    }
  ]);
}

/* ────────────────────────────────── the network ───────────────────────────────────── */

/**
 * A source stream that records what it was asked to do. `sentAt` timestamps each chunk
 * as it goes ON the wire, which is what makes "the page saw chunk 1 before the server
 * sent the last one" a measurement rather than a hope.
 *
 * @param {Buffer[]} chunks
 * @param {{gapMs?:number}} [options]
 */
export function sourceStream(chunks, options = {}) {
  const gapMs = options.gapMs || 0;
  const state = { cancelled: false, reason: null, sentAt: [], closedAt: null };
  let index = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      if (index >= chunks.length) {
        state.closedAt = performance.now();
        controller.close();
        return;
      }
      if (gapMs && index > 0) await sleep(gapMs);
      state.sentAt.push(performance.now());
      controller.enqueue(new Uint8Array(chunks[index]));
      index += 1;
    },
    cancel(reason) {
      state.cancelled = true;
      state.reason = reason;
    }
  });
  return { stream, state };
}

/** A Response with a real streamed body, as the network layer would hand one over. */
export function streamedResponse(chunks, options = {}) {
  const { stream, state } = sourceStream(chunks, options);
  const headers = { 'content-type': options.contentType || RSC_TYPE, ...(options.headers || {}) };
  const response = new Response(stream, { status: options.status || 200, headers });
  return { response, state };
}

/**
 * Drain a response body, with a deadline. A read that never completes must FAIL the test
 * it is in — a suite that hangs reports nothing at all, which is worse than a red line.
 *
 * @returns {Promise<Buffer>}
 */
export async function readAll(response, ms = 4000) {
  const reader = response.body.getReader();
  const parts = [];
  const deadline = setTimeout(() => reader.cancel(new Error('readAll timed out')).catch(() => {}), ms);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(Buffer.from(value));
    }
  } finally {
    clearTimeout(deadline);
  }
  return Buffer.concat(parts);
}

/** Wait for a capture matching `predicate`; reject rather than hang if none arrives. */
export async function waitForCapture(page, predicate, ms = 3000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = page.captures().filter(predicate);
    if (found.length) return found[found.length - 1];
    if (Date.now() > deadline) throw new Error('no capture matched within ' + ms + ' ms');
    await sleep(10);
  }
}

/**
 * Count what MockLab touches on a Response. "Never read, never cloned" is the whole
 * promise §5.1.4 makes about a refused streamed type, and it cannot be measured by
 * watching the source stream: Node's own `Response` constructor pulls one chunk out of a
 * ReadableStream the moment it wraps it, so a stream that has been read once has not
 * necessarily been read by anything under test.
 *
 * @param {Response} response
 */
export function watch(response) {
  const seen = { body: 0, clones: 0 };
  const body = response.body;
  Object.defineProperty(response, 'body', {
    configurable: true,
    get() { seen.body += 1; return body; }
  });
  const clone = response.clone.bind(response);
  response.clone = () => { seen.clones += 1; return clone(); };
  return seen;
}
