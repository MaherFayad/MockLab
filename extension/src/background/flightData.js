/**
 * The data a Next.js App Router page carries inside its own document (PLAN.md §8).
 *
 * OWNER: probe-engineer. Split out of `documentData.js` under §17.10 — that file was
 * 465 lines before this existed and the two subjects do not overlap: `documentData.js`
 * reads JSON that is written into the document AS JSON, and this reads JSON that is
 * written into the document as TEXT INSIDE A JAVASCRIPT STRING LITERAL, cut into pieces
 * at arbitrary offsets. Everything here is a pure function of a string, so the whole
 * matrix of hostile documents is unit-tested with no browser and no debugger.
 *
 * ── WHY IT EXISTS ─────────────────────────────────────────────────────────────────
 * §8 names two shapes: a JSON island in a `<script type="application/json">`, and a
 * `window.__SHOUTING__ = {…}` assignment. A modern App Router page emits NEITHER. It
 * emits a run of
 *
 *     <script>self.__next_f.push([1,"3:[\"$\",\"div\",null,{\"a\":1}]\n"])</script>
 *
 * which fails all three of `documentData.js`'s tests at once: `__next_f` does not end in
 * `__`, a `.push(…)` is not an assignment, and the payload is a JS string literal whose
 * contents are React's flight protocol rather than JSON. Nothing MockLab had could see a
 * single field of it, and that is most of the current web.
 *
 * ── THE WIRE FORMAT, AND WHICH PARTS OF IT THIS FILE TRUSTS ────────────────────────
 * The concatenation of every `[1, "…"]` chunk's TEXT, in document order, is the flight
 * stream. A chunk boundary lands wherever the server flushed, so ONE logical row is
 * routinely cut across several pushes, mid-token and mid-word. That is the part a naive
 * reader gets wrong, and it is why nothing here looks at a push in isolation.
 *
 * The stream is a sequence of rows, `<hex id>:<payload>\n`. A payload that starts with a
 * capital letter is TAGGED — `I` a client-module reference, `H`/`HL` a preload hint, `T`
 * a raw text chunk, and others — and none of them is the site's data. A payload that
 * starts with `[` or `{` is a JSON row, and those are what a person can edit.
 *
 * `T` is the one tag that cannot be skipped by looking for the next newline: its header
 * carries a LENGTH and its body may contain raw newlines. Reading that length wrongly
 * would desynchronise every row after it, which is how a rewrite silently corrupts a
 * document. This file's reading — the length is hex, and counts UTF-8 BYTES of the text
 * — is a RECONSTRUCTION, so it is not trusted: a `T` row is only accepted when the byte
 * count lands exactly on a newline, and a document where it does not is reported as a
 * source that CANNOT be edited (§1.1) rather than rewritten on a guess.
 *
 * ── WHAT A REWRITE REPLACES ───────────────────────────────────────────────────────
 * `documentData.js` splices only the bytes of the JSON value it changed. Here the unit
 * is one push's ENTIRE string literal, because the row being changed does not occupy a
 * contiguous span of the document — it is spread across the literals, each with its own
 * escaping. So: the new flight text is computed, cut back up at the ORIGINAL push
 * boundaries (with an edited row landing whole in the first push it started in), and
 * every push whose text changed has its literal rewritten. Pushes that did not change
 * are not touched, and neither is any other byte of the document.
 *
 * That is invisible to the consumer: React's runtime feeds the chunks to a streaming
 * parser in order, so moving text between adjacent chunks — or leaving one empty — is
 * the same stream. It is NOT invisible to a byte comparison, and a rewrite that produces
 * a document the browser cannot parse kills the page, which is worse than not rewriting
 * it at all — so `applyToDocument` READS BACK the document it just wrote and throws the
 * whole rewrite away if what comes out is not what was meant. That check is in
 * `documentData.js` because it is about the finished bytes, which is the only place the
 * question can honestly be asked.
 *
 * An earlier version proved instead that `decodeStringLiteral(escapeFlight(t))` returns
 * `t` for every push, before offering the block as editable. It was deleted: those two
 * functions cannot disagree on any input that exists, so nothing could ever fail it —
 * a guard with no failing input is a guard that only looks like one.
 */

/** The global App Router pushes its stream into. The only one this file knows. */
export const FLIGHT_KEY = '__next_f';

/** How much of an unreadable block is quoted back to the panel as a preview (§4). */
const PREVIEW_CHARS = 512;

/**
 * The escapes this decoder accepts. Anything else — an octal escape, a line
 * continuation, `\q` — makes the whole literal unreadable and the block read-only.
 *
 * Strict on purpose, and this is the one decision in the file with a silent failure mode
 * behind it: a decoder that guessed (JavaScript says `\q` is `q`) would re-emit the
 * guess, so a document MockLab misread by one character would be a document MockLab
 * rewrote with that character gone, and nothing would ever say so.
 */
const SIMPLE = { '"': '"', "'": "'", '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };

/**
 * Decode the JavaScript string literal whose opening quote is at `at`.
 *
 * @param {string} text
 * @param {number} at index of `"` or `'`
 * @returns {{value:string, end:number}|null} null when this is not a literal this file
 *   is willing to claim it understands — see SIMPLE.
 */
export function decodeStringLiteral(text, at) {
  const quote = text[at];
  if (quote !== '"' && quote !== "'") return null;

  let value = '';
  let i = at + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === quote) return { value, end: i + 1 };
    // A raw line terminator ends a literal in JS, so anything that contains one is not
    // one. (The flight stream's own newlines arrive as the two characters `\` and `n`.)
    if (ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029') return null;
    if (ch !== '\\') {
      value += ch;
      i += 1;
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) return null;
    if (next === 'u' || next === 'x') {
      const braced = next === 'u' && text[i + 2] === '{';
      const from = i + (braced ? 3 : 2);
      const to = braced ? text.indexOf('}', from) : from + (next === 'u' ? 4 : 2);
      if (to === -1 || to > text.length || to === from) return null;
      const hex = text.slice(from, to);
      if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
      const code = parseInt(hex, 16);
      if (code > 0x10ffff) return null;
      value += String.fromCodePoint(code);
      i = braced ? to + 1 : to;
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(SIMPLE, next)) return null;
    value += SIMPLE[next];
    i += 2;
  }
  return null; // unterminated
}

/**
 * The contents of a double-quoted literal carrying `text`, WITHOUT the quotes.
 *
 * `JSON.stringify` does the quoting, the control characters and the lone surrogates.
 * The four replacements after it are the ones it does not do and a document needs:
 * `<` and `>` so a value containing `</script>` cannot end the element it lives in (the
 * whole rest of the page would become markup), `&` because a document parsed as XHTML
 * decodes entities before the script runs, and the two line separators because they
 * terminate a line inside a string in engines older than ES2019. Next.js escapes the
 * same five characters in its own output for the same reasons.
 *
 * @param {string} text
 */
export function escapeFlight(text) {
  return JSON.stringify(text)
    .slice(1, -1)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Skip whitespace from `i`. */
function skipSpace(text, i) {
  let at = i;
  while (at < text.length && /\s/.test(text[at])) at += 1;
  return at;
}

/**
 * The one argument of a `__next_f.push(…)` call whose `[` is at `at`.
 *
 * `{kind:'text'}` is a data chunk, `{kind:'bare'}` is the `push([0])` bootstrap, and
 * `{kind:'unknown'}` is everything this file will not claim to understand — which makes
 * the whole block read-only rather than half-read.
 */
function readPushArgument(html, at) {
  let i = skipSpace(html, at + 1);
  const digits = /^\d{1,10}/.exec(html.slice(i, i + 10));
  if (!digits) return { kind: 'unknown' };
  const type = Number(digits[0]);
  i = skipSpace(html, i + digits[0].length);
  if (html[i] === ']') return { kind: 'bare', type };
  if (html[i] !== ',') return { kind: 'unknown' };
  i = skipSpace(html, i + 1);
  const literal = decodeStringLiteral(html, i);
  if (!literal) return { kind: 'unknown' };
  const from = i + 1;
  const to = literal.end - 1;
  i = skipSpace(html, literal.end);
  if (html[i] !== ']') return { kind: 'unknown' };
  i = skipSpace(html, i + 1);
  if (html[i] !== ')') return { kind: 'unknown' };
  // Chunk type 1 is the stream's text. 0 is the bootstrap `push([0])`. Anything else is
  // a shape this file has never seen, and guessing about it is how a page dies.
  if (type !== 1) return { kind: 'unknown' };
  return { kind: 'text', from, to, text: literal.value };
}

/**
 * `__next_f…push(` — the global, then anything short of a statement boundary (which is
 * what `(self.__next_f=self.__next_f||[]).push(…)` needs), then the call.
 */
const PUSH = /__next_f\b[^;{}<>]{0,80}?\.\s*push\s*\(\s*\[/g;

/** A `<script>` that holds code rather than data. `attrs` comes from documentData.js. */
const isCodeScript = (attrs) => !attrs.type || /javascript|ecmascript|module/i.test(attrs.type);

/** How many characters of `text` from `at` make up `bytes` UTF-8 bytes, or -1. */
function advanceBytes(text, at, bytes) {
  let left = bytes;
  let i = at;
  while (left > 0 && i < text.length) {
    const code = text.codePointAt(i);
    const width = code > 0xffff ? 2 : 1;
    left -= code < 0x80 ? 1 : code < 0x800 ? 2 : code > 0xffff ? 4 : 3;
    i += width;
  }
  return left === 0 ? i : -1;
}

/**
 * @typedef {Object} FlightRow
 * @property {string} id       the row's hex id, as written
 * @property {number} from     offset of the payload in the concatenated stream
 * @property {number} to       one past its last character
 * @property {string} payload  the payload text
 * @property {any}    value    the parsed payload
 */

/**
 * Split the concatenated stream into rows, and keep the JSON ones.
 *
 * `ok:false` means the stream stopped making sense — an unreadable header, a `T` row
 * whose length did not land on a newline, a JSON payload that would not parse, or a
 * final row with no terminator. The rows found before that point are still returned,
 * because they are what the panel will SHOW; `ok:false` is what stops them being
 * offered as editable.
 *
 * @param {string} stream
 * @returns {{rows: FlightRow[], ok: boolean}}
 */
export function scanRows(stream) {
  /** @type {FlightRow[]} */
  const rows = [];
  let at = 0;
  while (at < stream.length) {
    const header = /^([0-9a-f]{1,8}):/.exec(stream.slice(at, at + 10));
    if (!header) return { rows, ok: false };
    const start = at + header[0].length;
    const tag = stream[start];

    if (tag === 'T') {
      // `<id>:T<hex byte length>,<text>` — the only row whose end is not the next
      // newline. See the header: this reading is a reconstruction, so it is checked.
      const comma = stream.indexOf(',', start + 1);
      if (comma === -1) return { rows, ok: false };
      const size = stream.slice(start + 1, comma);
      if (!/^[0-9a-f]{1,8}$/i.test(size)) return { rows, ok: false };
      const end = advanceBytes(stream, comma + 1, parseInt(size, 16));
      if (end === -1 || stream[end] !== '\n') return { rows, ok: false };
      at = end + 1;
      continue;
    }

    const newline = stream.indexOf('\n', start);
    if (newline === -1) return { rows, ok: false }; // a row nobody finished
    const payload = stream.slice(start, newline);
    if (payload[0] === '[' || payload[0] === '{') {
      let value;
      try {
        value = JSON.parse(payload);
      } catch {
        // A row that opens like data and does not parse means this file has read the
        // stream wrongly somewhere upstream. Nothing here is safe to rewrite after that.
        return { rows, ok: false };
      }
      rows.push({ id: header[1], from: start, to: newline, payload, value });
    }
    at = newline + 1;
  }
  return { rows, ok: true };
}

/**
 * Cut a rewritten stream back up at the original push boundaries.
 *
 * Every edit lands whole in the FIRST push its span started in; the pushes it continued
 * into lose their share of it. A push can end up empty, which is a chunk that contributes
 * nothing to the stream — legal, and what any streaming consumer already does with it.
 *
 * @param {string} stream the ORIGINAL concatenated text
 * @param {{start:number, end:number}[]} spans one per push, in order
 * @param {{from:number, to:number, text:string}[]} edits disjoint, sorted by `from`
 * @returns {string[]} the new text of each push
 */
export function recutPushes(stream, spans, edits) {
  return spans.map(({ start, end }) => {
    let out = '';
    let cursor = start;
    for (const edit of edits) {
      if (edit.to <= start || edit.from >= end) continue;
      const cut = Math.max(start, Math.min(edit.from, end));
      if (cut > cursor) out += stream.slice(cursor, cut);
      if (edit.from >= start && edit.from < end) out += edit.text;
      cursor = Math.max(cursor, Math.min(edit.to, end));
    }
    if (cursor < end) out += stream.slice(cursor, end);
    return out;
  });
}

/**
 * @typedef {Object} FlightBlock
 * @property {string} key       always `__next_f`
 * @property {"flight"} kind
 * @property {number} from      first push's literal, first character
 * @property {number} to        last push's literal, last character
 * @property {any} body         `{ "<row id>": <payload>, … }`
 * @property {boolean} editable false when this document must be shown read-only (§1.1)
 * @property {string} preview   the head of the stream, for a source nobody can edit
 * @property {{stream:string, spans:{start:number,end:number}[],
 *             pushes:{from:number,to:number,text:string}[], rows:FlightRow[]}} flight
 */

/**
 * The App Router block this document carries, or null if it carries none.
 *
 * A block is returned with `editable:false` — never dropped — whenever the stream was
 * found but cannot be safely put back: §1.1 forbids a source that is silently absent
 * just as it forbids one that is silently broken. A document whose stream reads cleanly
 * but holds no JSON row at all is a different thing and returns null: there is no field
 * in it to change, and `documentData.js` drops empty blocks for the same reason.
 *
 * @param {string} html
 * @param {{attrs:Record<string,string>, from:number, to:number}[]} scripts
 * @returns {FlightBlock|null}
 */
export function readFlight(html, scripts) {
  const code = scripts.filter((script) => isCodeScript(script.attrs));
  if (!code.length) return null;

  /** @type {{from:number, to:number, text:string}[]} */
  const pushes = [];
  let unknown = false;
  PUSH.lastIndex = 0;
  for (const match of html.matchAll(PUSH)) {
    const at = match.index + match[0].length - 1;
    // Inside a script element, or it never runs: a page may print this text as prose.
    if (!code.some((script) => match.index >= script.from && at < script.to)) continue;
    const arg = readPushArgument(html, at);
    if (arg.kind === 'text') pushes.push({ from: arg.from, to: arg.to, text: arg.text });
    else if (arg.kind === 'unknown') unknown = true;
  }
  if (!pushes.length) return null;

  const spans = [];
  let at = 0;
  for (const push of pushes) {
    spans.push({ start: at, end: at + push.text.length });
    at += push.text.length;
  }
  const stream = pushes.map((push) => push.text).join('');

  const scan = scanRows(stream);
  /** @type {Record<string, any>} */
  const body = {};
  for (const row of scan.rows) body[row.id] = row.value;

  // Safe to put back. A block that is safe but holds no JSON row has nothing in it to
  // change, and is not a source; a block that is NOT safe is a source that cannot be
  // edited, which §1.1 requires to be visible rather than silently absent.
  const safe = scan.ok && !unknown;
  if (safe && !scan.rows.length) return null;

  return {
    key: FLIGHT_KEY,
    kind: 'flight',
    from: pushes[0].from,
    to: pushes[pushes.length - 1].to,
    body,
    editable: safe,
    preview: stream.slice(0, PREVIEW_CHARS),
    flight: { stream, spans, pushes, rows: scan.rows }
  };
}

/**
 * The document splices that turn `block` into `body` — one per push whose text changed.
 *
 * A row is rewritten when its VALUE changed, which is asked by re-serializing both
 * sides rather than by comparing the new payload against the document's own bytes: a
 * page that wrote `1e3` would fail a byte comparison while holding the same 1000, and
 * every row spelled that way would be rewritten by a Change that never touched it.
 * Re-serialized text is what the site would parse, and it is the only thing that has to
 * match.
 *
 * @param {FlightBlock} block
 * @param {Record<string, any>} body the block's body after §5.4 paths were applied
 * @returns {{from:number, to:number, text:string}[]}
 */
export function flightSplices(block, body) {
  const edits = [];
  for (const row of block.flight.rows) {
    if (!Object.prototype.hasOwnProperty.call(body, row.id)) continue;
    const payload = JSON.stringify(body[row.id]);
    if (payload === undefined || payload === JSON.stringify(row.value)) continue;
    edits.push({ from: row.from, to: row.to, text: payload });
  }
  if (!edits.length) return [];
  edits.sort((a, b) => a.from - b.from);

  const rewritten = recutPushes(block.flight.stream, block.flight.spans, edits);
  const splices = [];
  rewritten.forEach((text, index) => {
    const push = block.flight.pushes[index];
    if (text === push.text) return;
    splices.push({ from: push.from, to: push.to, text: escapeFlight(text) });
  });
  return splices;
}

/**
 * Did the rewritten document come back saying what the rewrite meant?
 *
 * `applyToDocument` calls this on the blocks it re-read out of the finished bytes. It is
 * the last check before a page is served, and it exists because a flight rewrite cannot
 * be checked any earlier: the block's text is spread across several string literals in
 * several script elements, each with its own escaping, so no single splice is
 * inspectable and no arithmetic about them is convincing. Parsing the result is.
 *
 * A block that came back MISSING, unreadable, or holding anything other than the body
 * that was meant fails — and the caller then serves the site its own document untouched.
 * The person's Change does not happen and MockLab says so (`missed`), which is a failure
 * this product is allowed to have. A document Chrome cannot parse is not.
 *
 * @param {{key:string, body:any, editable?:boolean}[]} blocks  re-read from the new HTML
 * @param {{key:string, body:any}[]} intended
 */
export function readsBack(blocks, intended) {
  const after = new Map(blocks.map((block) => [block.key, block]));
  return intended.every(({ key, body }) => {
    const block = after.get(key);
    return Boolean(block) && block.editable !== false && JSON.stringify(block.body) === JSON.stringify(body);
  });
}
