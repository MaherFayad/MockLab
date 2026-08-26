/**
 * The data a page carries INSIDE its own document, read and rewritten as text.
 *
 * OWNER: probe-engineer. Implements the parsing half of PLAN.md §8; `debuggerEngine.js`
 * beside it is the CDP half. Split under §17.10, along the one seam that is worth having
 * here: everything in this file is a pure function of a string, so the whole matrix of
 * hostile documents below is unit-tested with no browser, no debugger and no chrome API
 * — and `debuggerEngine.js` is left holding only the attach/detach lifecycle, which is
 * the part that needs a real Chrome to judge.
 *
 * ── WHAT §8 ASKS FOR ───────────────────────────────────────────────────────────────
 * Two shapes, and §8 is explicit that the second is NOT to be done with a naive regex:
 *
 *   1. `<script id="__NEXT_DATA__" type="application/json">{…}</script>`
 *   2. `window.__INITIAL_STATE__ = {…}` / `window.__NUXT__ = {…}` and their relatives —
 *      "regex-extract balanced JSON via a small scanner".
 *
 * `scanJsonValue` is that scanner. A regex cannot do it: `{"a":"}"}` closes on the brace
 * inside the string, and `[^}]*}` stops at the first nested object. The scanner tracks
 * string state and escapes, and is deliberately NOT a JSON validator — it finds where
 * the value ENDS, and `JSON.parse` on the slice is what decides whether it was JSON at
 * all. That division is the whole safety argument: the scanner may over-accept (`{ ]`
 * balances by its counting and by nobody else's), the parse then refuses it, and a block
 * MockLab cannot parse is a block MockLab does not touch.
 *
 * ── WHY A REWRITE IS A TEXT SPLICE AND NOT A RE-SERIALIZED DOCUMENT ────────────────
 * Only the bytes between `from` and `to` are replaced. Everything else in the document
 * — the server-rendered markup, other scripts, the whitespace — comes out byte-identical.
 * This is §5.1.2's rule ("return the ORIGINAL Response object … never a re-serialized
 * one") applied one layer down: MockLab is a tool for watching a site render its own
 * state, so the less of the site it retypes, the less of the site it can break.
 *
 * ── THE ONE THING A DOCUMENT REWRITE CANNOT DO, SAID PLAINLY ───────────────────────
 * Server-rendered markup is not data. A site that prints `<span>On time</span>` into the
 * HTML *and* embeds the props that produced it has already committed the old value to
 * the screen; changing the props changes what the page's own code will render FROM, and
 * nothing else. Frameworks differ in what happens next — a client that renders from the
 * embedded state repaints and the change is visible; a client that only hydrates
 * pre-rendered markup may keep the server's text until something makes it re-render.
 * MockLab cannot promise more than "the site received your value", which is the promise
 * §11's `editor.applied` actually makes. `companion/src/demo/ssr.html` is built to show
 * both halves on one screen.
 */

import { setByPath } from '../shared/jsonpath.js';

/**
 * The sigId namespace §8 reserves for document-embedded data. A source id is
 * `__document__:<12 hex of the document's signature>:<block key>` — namespaced so no
 * code path can confuse it with a captured request's sigId, and stable across reloads so
 * a Change made today still finds its block tomorrow.
 *
 * The block key is part of it because one document may carry several blocks, and merging
 * them into a single source would put a top-level `__NEXT_DATA__` key in front of a user
 * who is never shown jargon (§11) — and would make one field's path depend on whether
 * some unrelated block happened to be present on this load.
 */
export const DOC_SIG_PREFIX = '__document__';

/** @param {string} sigHex @param {string} key */
export const documentSigId = (sigHex, key) => `${DOC_SIG_PREFIX}:${sigHex}:${key}`;

/** Is this a document source id? Read by anything that must not treat one as a request. */
export const isDocumentSigId = (sigId) => typeof sigId === 'string' && sigId.startsWith(DOC_SIG_PREFIX + ':');

/**
 * A document bigger than this is never buffered, scanned or rewritten. A deep-mode
 * document is held in the service worker's memory in full, twice (the original text and
 * the spliced copy), while the page waits on the other side of a paused request — so the
 * ceiling is about the tab, not about tidiness. §4's own limit for a captured body is
 * 2 MB; a document carries markup as well as data, so this is larger, and a document past
 * it is continued untouched rather than truncated: a truncated document is a broken page.
 */
export const MAX_DOCUMENT_CHARS = 6 * 1024 * 1024;

/**
 * The end of the JSON value that starts at `from`, exclusive, or -1.
 *
 * `text[from]` must be `{` or `[`. Depth counting only; string state and backslash
 * escapes are tracked because that is the whole reason a regex cannot do this.
 *
 * NOT A VALIDATOR, on purpose — see the header. `{ ]` returns an end index and
 * `JSON.parse` then refuses the slice, which is the order that keeps this function small
 * enough to be obviously correct.
 *
 * @param {string} text
 * @param {number} from
 * @returns {number}
 */
export function scanJsonValue(text, from) {
  const open = text[from];
  if (open !== '{' && open !== '[') return -1;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/* ------------------------------------------------------------------ script blocks */

/**
 * Attributes of one HTML start tag, lowercased names, as a plain object.
 *
 * Written rather than regexed off the whole document because attribute ORDER is not
 * fixed: `<script type="application/json" id="__NEXT_DATA__">` is the same tag as
 * §8's example with the two swapped, and a pattern that spells one order silently misses
 * the other — a whole framework's data, invisible, with nothing to notice it.
 *
 * @param {string} tag the text between `<script` and the closing `>`
 */
function attributesOf(tag) {
  /** @type {Record<string,string>} */
  const attrs = {};
  const pattern = /([a-zA-Z_:][-\w:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'`=<>]+))?/g;
  for (const match of tag.matchAll(pattern)) {
    const raw = match[2] || '';
    const value = raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw;
    attrs[match[1].toLowerCase()] = value;
  }
  return attrs;
}

/**
 * Every `<script>` element in the document, as `{attrs, from, to}` where from/to bound
 * its TEXT CONTENT.
 *
 * `</script` is the only thing that ends a script element — that is a rule of the HTML
 * parser and not a convention — so the inner text is taken verbatim up to it, with no
 * attempt to understand the JavaScript in between. A script with no closing tag is
 * skipped rather than assumed to run to the end of the file.
 *
 * @param {string} html
 */
function scriptElements(html) {
  const found = [];
  const open = /<script\b([^>]*)>/gi;
  for (const match of html.matchAll(open)) {
    const from = match.index + match[0].length;
    const close = html.toLowerCase().indexOf('</script', from);
    if (close === -1) continue;
    found.push({ attrs: attributesOf(match[1]), from, to: close });
  }
  return found;
}

/** §8's first shape: a JSON island in a script element with an id. */
const JSON_TYPES = /^(application\/json|application\/ld\+json)$/i;

/**
 * §8's second shape. A global whose name is `__SHOUTING__` being assigned an object or
 * array literal — `window.__NEXT_DATA__`, `window.__INITIAL_STATE__`, `window.__NUXT__`,
 * and whatever the next framework calls its own.
 *
 * Generic by §8's instruction, and safe to be generic because the parse decides: a name
 * matched inside somebody's string literal yields a slice `JSON.parse` refuses, and a
 * `window.__NUXT__=(function(a,b){…})(…)` — which is what Nuxt 2 actually emits — is not
 * followed by `{` or `[` and never starts a scan at all.
 */
const ASSIGNMENT = /(?:window|self|globalThis)\s*\.\s*(__[A-Za-z0-9_]+__)\s*=\s*/g;

/**
 * @typedef {Object} EmbeddedBlock
 * @property {string} key    the block's name: `__NEXT_DATA__`, `__INITIAL_STATE__`, …
 * @property {"script"|"assignment"} kind
 * @property {number} from   index of the first character of the JSON text
 * @property {number} to     index one past its last character
 * @property {any}    body   the parsed value
 */

/**
 * Every block of embedded state this document carries, in document order.
 *
 * A block counts only when its JSON parses AND holds something — an empty object is a
 * source with no field in it, and offering the user a data source they cannot edit a
 * single value in is worse than not mentioning it.
 *
 * Duplicate names are suffixed `#2`, `#3` in document order rather than dropped. Dropping
 * would hide real data behind an accident of ordering; the suffix keeps every block
 * addressable and keeps the key stable across reloads, which is what a Change is stored
 * against.
 *
 * @param {string} html
 * @returns {EmbeddedBlock[]}
 */
export function readEmbedded(html) {
  if (typeof html !== 'string' || html.length > MAX_DOCUMENT_CHARS) return [];

  /** @type {EmbeddedBlock[]} */
  const blocks = [];
  const seen = new Map();

  const add = (key, kind, from, to) => {
    if (from >= to) return;
    let body;
    try {
      body = JSON.parse(html.slice(from, to));
    } catch {
      return; // not JSON. §8 rewrites data, and this was not data.
    }
    if (!body || typeof body !== 'object') return;
    if (Array.isArray(body) ? body.length === 0 : Object.keys(body).length === 0) return;
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    blocks.push({ key: count === 1 ? key : `${key}#${count}`, kind, from, to, body });
  };

  for (const script of scriptElements(html)) {
    const id = script.attrs.id || '';
    const type = script.attrs.type || '';
    // An id is what makes a JSON island addressable; a type of `application/json` is what
    // makes it inert data rather than code. Either alone is enough to look at, because
    // the parse is what admits it.
    if (!id && !JSON_TYPES.test(type)) continue;
    if (type && !JSON_TYPES.test(type)) continue;
    const text = html.slice(script.from, script.to);
    const start = text.search(/[^\s]/);
    if (start === -1) continue;
    const from = script.from + start;
    const to = scanJsonValue(html, from);
    if (to === -1 || to > script.to) continue;
    add(id || 'embedded', 'script', from, to);
  }

  for (const match of html.matchAll(ASSIGNMENT)) {
    const from = match.index + match[0].length;
    const to = scanJsonValue(html, from);
    if (to === -1) continue;
    add(match[1], 'assignment', from, to);
  }

  return blocks.sort((a, b) => a.from - b.from);
}

/* ---------------------------------------------------------------------- rewriting */

/**
 * JSON, escaped so it cannot end the script element it sits inside.
 *
 * `</script>` inside a string in the data would close the element early: the rest of the
 * page's data becomes markup and the document is destroyed. `<` is the same
 * character to every JSON parser and inert to the HTML tokenizer. `&` and the two line
 * separators are escaped for the neighbouring reasons — an assignment block is parsed as
 * JavaScript, where U+2028 and U+2029 are line terminators inside strings in engines
 * older than ES2019, and a JSON island inside XHTML is entity-decoded before parsing.
 *
 * @param {any} value
 * @returns {string}
 */
export function serializeEmbedded(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * @typedef {Object} DocumentEdit
 * @property {string} key      which block
 * @property {{path:string, value:any}[]} overlays  §5.4 paths into that block's body
 */

/**
 * Apply Changes to a document's embedded blocks and give back the rewritten HTML.
 *
 * Splices run right to left so an earlier block's replacement cannot move a later
 * block's indexes — the ordinary bug in text rewriting, and one that would corrupt a
 * document rather than fail to change it.
 *
 * `setByPath` "creates nothing" (§5.4): a path that is not in this load's data applies
 * nothing and is counted in `missed`. That is the honest outcome — the site changed its
 * shape, or the Change was made against a different page of the same site — and the
 * caller can say so instead of writing a key the site's code never reads.
 *
 * Each body is CLONED before it is written to. The caller reports the blocks it read as
 * the captured source, and §5.1.2 requires that capture to be the REAL response —
 * mutating the parsed body in place would make MockLab's own record of what the server
 * sent say what MockLab did to it, which is the one thing a capture may never say.
 *
 * @param {string} html
 * @param {EmbeddedBlock[]} blocks
 * @param {Map<string, {path:string, value:any}[]>} byKey  overlays per block key
 * @returns {{html:string, applied:number, missed:string[]}}
 */
export function applyToDocument(html, blocks, byKey) {
  /** @type {{from:number, to:number, text:string}[]} */
  const splices = [];
  const missed = [];
  let applied = 0;

  for (const block of blocks) {
    const overlays = byKey.get(block.key);
    if (!overlays || !overlays.length) continue;
    let touched = 0;
    const body = structuredClone(block.body);
    for (const overlay of overlays) {
      if (setByPath(body, overlay.path, overlay.value)) {
        touched += 1;
        applied += 1;
      } else {
        missed.push(`${block.key}${overlay.path.startsWith('$') ? overlay.path.slice(1) : overlay.path}`);
      }
    }
    if (touched) splices.push({ from: block.from, to: block.to, text: serializeEmbedded(body) });
  }

  if (!splices.length) return { html, applied: 0, missed };

  splices.sort((a, b) => b.from - a.from);
  let out = html;
  for (const splice of splices) out = out.slice(0, splice.from) + splice.text + out.slice(splice.to);
  return { html: out, applied, missed };
}

/**
 * Everything §8 does to one document, as a pure function of its text.
 *
 * It lives here rather than in `debuggerEngine.js` because it is the whole decision —
 * which blocks this page carries, which of them a Change targets, what the rewritten
 * document reads, and what the panel should be told the page really sent — and none of
 * it needs a browser to check. What is left on the other side is CDP plumbing.
 *
 * `sources` is ALWAYS every block the document carries, changed or not: §10.2's tree is
 * how a person finds a field to change in the first place, so a page whose data nobody
 * has touched yet still has to appear.
 *
 * @param {string} html
 * @param {string} sigHex           12 hex chars from `signatures.js` — §17.3 keeps sigIds there
 * @param {Map<string, {path:string,value:any}[]>} overlays  by sigId (see `effectiveBody.js`)
 * @returns {{sources:{sigId:string,key:string,body:any,bodyBytes:number,mocked:boolean}[],
 *            html:string, applied:number, missed:string[]}}
 */
export function planDocument(html, sigHex, overlays) {
  const blocks = readEmbedded(html);
  if (!blocks.length) return { sources: [], html, applied: 0, missed: [] };

  /** @type {Map<string, {path:string,value:any}[]>} */
  const byKey = new Map();
  for (const block of blocks) {
    const list = overlays && overlays.get(documentSigId(sigHex, block.key));
    if (list && list.length) byKey.set(block.key, list);
  }

  const result = byKey.size ? applyToDocument(html, blocks, byKey) : { html, applied: 0, missed: [] };
  const sources = blocks.map((block) => ({
    sigId: documentSigId(sigHex, block.key),
    key: block.key,
    body: block.body,
    bodyBytes: block.to - block.from,
    mocked: byKey.has(block.key) && result.applied > 0
  }));
  return { sources, html: result.html, applied: result.applied, missed: result.missed };
}

/* --------------------------------------------------------------- the CDP wire form */

/**
 * CDP carries a body as base64 of BYTES, and a document is text — so both directions go
 * through TextEncoder/TextDecoder rather than through `btoa` on a JS string, which throws
 * on any character above U+00FF. A page with an Arabic title is not an edge case (§9.2
 * has this product RTL-ready) and `btoa(html)` throws on the first one.
 *
 * The chunking is not tidiness either: `String.fromCharCode(...bytes)` spreads one
 * argument per byte and blows the call stack somewhere around a hundred thousand of
 * them, which a real document reaches.
 */
const CHUNK = 0x8000;

/** @param {string} text @returns {string} */
export function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** @param {string} base64 @returns {string} */
export function fromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/* -------------------------------------------------------------------- the headers */

/**
 * Headers that describe the ENCODING or LENGTH of the body we just replaced, and are
 * therefore lies about the body we are about to send.
 *
 * `content-length` is §8's own instruction. `content-encoding` is the one §8 does not
 * mention and the one that breaks the page hardest: CDP's `Fetch.getResponseBody` hands
 * back the DECODED body, so a document served gzipped comes back as text — fulfil it
 * with `content-encoding: gzip` still on the response and the browser tries to inflate
 * plain HTML and renders nothing at all. `transfer-encoding` and `content-md5` are the
 * same class of claim.
 *
 * CSP is deliberately NOT stripped: MockLab changes the site's data and must not quietly
 * weaken the site's security posture while doing it.
 */
const REWRITTEN_AWAY = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'content-md5']);

/**
 * The response headers to fulfil with: the original ones, minus the ones the rewrite
 * invalidated.
 *
 * @param {{name:string, value:string}[]|undefined} headers  CDP's `responseHeaders`
 * @returns {{name:string, value:string}[]}
 */
export function rewriteHeaders(headers) {
  if (!Array.isArray(headers)) return [];
  return headers.filter((header) => header && !REWRITTEN_AWAY.has(String(header.name).toLowerCase()));
}

/**
 * One header's value, case-insensitively, or ''. CDP does not normalize header case and
 * HTTP/2 lowercases while HTTP/1.1 does not, so every read of one goes through here.
 *
 * @param {{name:string, value:string}[]|undefined} headers
 * @param {string} name
 */
export function headerValue(headers, name) {
  if (!Array.isArray(headers)) return '';
  const wanted = name.toLowerCase();
  for (const header of headers) {
    if (header && String(header.name).toLowerCase() === wanted) return String(header.value || '');
  }
  return '';
}

/**
 * PLAN.md §8, last bullet: React Server Component payloads are OUT OF SCOPE for v1 and
 * are to be DETECTED rather than attempted. Detection is by content type, which is the
 * only thing that is true of every one of them.
 *
 * @param {string} contentType
 */
export const isStreamedComponent = (contentType) => /text\/x-component/i.test(String(contentType || ''));

/** Only an HTML document is scanned; anything else is continued untouched. */
export const isHtmlDocument = (contentType) => /text\/html|application\/xhtml\+xml/i.test(String(contentType || ''));
