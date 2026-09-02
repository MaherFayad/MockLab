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
 * Both of those are the Next.js PAGES Router and its generation of frameworks. The APP
 * Router — most of what is built today — emits neither, and `flightData.js` is the third
 * shape: a stream of text in JavaScript string literals, cut across many `<script>`
 * elements. `readEmbedded` returns its block alongside these two and `applyToDocument`
 * rewrites it through the same door, so nothing downstream has to know the difference.
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
import { readFlight, flightSplices, readsBack } from './flightData.js';

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
  // Lowercased ONCE. Inside the loop this is a full pass per script element: measured at
  // 3.2 s on an App Router page of 1200 inline scripts, past `deepFetch.js`'s 2 s budget,
  // so the document is released untouched and the Change silently does not happen.
  const lower = html.toLowerCase();
  for (const match of html.matchAll(open)) {
    const from = match.index + match[0].length;
    const close = lower.indexOf('</script', from);
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
 * @property {"script"|"assignment"|"flight"} kind
 * @property {number} from   index of the first character of the JSON text
 * @property {number} to     index one past its last character
 * @property {any}    body   the parsed value
 * @property {boolean} editable  false when the block was found but cannot be safely put
 *   back — §1.1: a source that cannot be edited, never silently absent or broken
 * @property {string} [preview]  the head of an unreadable block's text, for that source
 * @property {any} [flight]      `flightData.js`'s own bookkeeping, for the rewrite
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
    blocks.push({ key: count === 1 ? key : `${key}#${count}`, kind, from, to, body, editable: true });
  };

  const scripts = scriptElements(html);
  for (const script of scripts) {
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

  // §8's two shapes are the PAGES Router's; App Router emits neither (`flightData.js`).
  const flight = readFlight(html, scripts);
  if (flight) {
    const count = (seen.get(flight.key) || 0) + 1;
    seen.set(flight.key, count);
    blocks.push(count === 1 ? flight : { ...flight, key: `${flight.key}#${count}` });
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
 * A block with `editable:false` is one MockLab found and cannot put back (today: an App
 * Router stream it could not fully read). Every overlay aimed at it is counted in
 * `missed` and NOTHING is spliced — §1.1, visible and uneditable rather than broken.
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
  /** Flight blocks that were spliced, and the body each one was MEANT to end up with. */
  const intended = [];
  let applied = 0;

  const miss = (block, overlay) =>
    missed.push(`${block.key}${overlay.path.startsWith('$') ? overlay.path.slice(1) : overlay.path}`);

  for (const block of blocks) {
    const overlays = byKey.get(block.key);
    if (!overlays || !overlays.length) continue;
    if (block.editable === false) {
      for (const overlay of overlays) miss(block, overlay);
      continue;
    }
    let touched = 0;
    const body = structuredClone(block.body);
    for (const overlay of overlays) {
      if (setByPath(body, overlay.path, overlay.value)) {
        touched += 1;
        applied += 1;
      } else {
        miss(block, overlay);
      }
    }
    if (!touched) continue;
    if (block.kind === 'flight') {
      // Not one span of the document, so the splices come from the file that knows
      // where its pieces are — and none is a row that re-serialized to what is there.
      const pieces = flightSplices(block, body);
      if (pieces.length) intended.push({ key: block.key, body, overlays });
      splices.push(...pieces);
    } else {
      splices.push({ from: block.from, to: block.to, text: serializeEmbedded(body) });
    }
  }

  if (!splices.length) return { html, applied: 0, missed };

  splices.sort((a, b) => b.from - a.from);
  let out = html;
  for (const splice of splices) out = out.slice(0, splice.from) + splice.text + out.slice(splice.to);

  // Read back what was just written: a flight block's rewrite is splices into several
  // string literals, so the finished bytes are the only place it can honestly be checked
  // (`readsBack` carries the fuller note). Nothing is applied partially — serving half a
  // rewrite would be a guess about which half was safe, and a wrong guess is a dead page.
  if (intended.length && !readsBack(readEmbedded(out), intended)) {
    console.error('[MockLab] a document rewrite did not read back correctly; serving the original');
    missed.length = 0;
    for (const block of blocks) for (const overlay of byKey.get(block.key) || []) miss(block, overlay);
    return { html, applied: 0, missed };
  }
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
 * @returns {{sources:{sigId:string,key:string,body:any,bodyBytes:number,editable:boolean,
 *                      preview:string,mocked:boolean}[],
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
    // §1.1: a block that cannot be put back is a source nobody can edit, and `preview`
    // is what the panel shows instead of fields it would be lying to offer.
    editable: block.editable !== false,
    preview: block.preview || '',
    mocked: byKey.has(block.key) && block.editable !== false && result.applied > 0
  }));
  return { sources, html: result.html, applied: result.applied, missed: result.missed };
}
