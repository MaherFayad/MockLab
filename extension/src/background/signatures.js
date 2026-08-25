/**
 * Request signature normalization — pure functions, unit-tested (PLAN.md §5.2).
 *
 * OWNER: interceptor-engineer.
 *
 * §17.3: sigIds are computed HERE and nowhere else. The MAIN world never hashes; it
 * evaluates the compiled match list `compileMatchList()` produces.
 */

/** @typedef {import('./messages.js').RequestSignature} RequestSignature */

/* ------------------------------------------------------------------ volatile bits */

/** Long numbers: /1042/ is meaningful, /44212114/ is an id. */
const RE_LONG_NUMBER = /^\d{4,}$/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_HEX_ID = /^[0-9a-f]{16,}$/i;

/**
 * Param NAMES dropped outright. Verbatim from PLAN.md §5.2, anchored exactly as the
 * spec writes it.
 */
const RE_VOLATILE_PARAM_NAME =
  /^(t|ts|_|cb|nonce|timestamp|time|rnd|random|sid|sessionid|session_id|token|auth|signature|sign|hash|traceid|trace_id|requestid|request_id|x-request-id)$/i;

/**
 * DOCUMENTED EXTENSION to §5.2 (README "Deviations", BUILD_LOG M1).
 *
 * §5.2's list is anchored, so it only fires when the volatile word IS the whole param
 * name. Real sites bury trace ids inside compound names — the product owner's own
 * target page sends `masterhotelid_tracelogid=100051355-0a8e3544-496571-67667`, whose
 * value also escapes every volatile-VALUE rule (dashes defeat ^\d{4,}$, ^[0-9a-f]{16,}$
 * and the UUID shape, and it is not base64-looking). Under a literal reading that param
 * survives into urlPattern, the sigId changes on every single page load, and no Change
 * can ever apply — the product would silently do nothing on the page it exists to demo.
 *
 * So: after the literal §5.2 rules, also drop a param when a volatile marker appears as
 * a DELIMITED TOKEN inside its name. The set below is deliberately narrower than the
 * anchored list — generic members like `t`, `time`, `sign` and `hash` are NOT included,
 * because they occur inside meaningful compound names (`checkInTime`, `signInMethod`)
 * and dropping those would merge signatures that should stay distinct.
 */
const VOLATILE_NAME_TOKENS = new Set([
  'nonce', 'cb', 'rnd', 'random', 'timestamp',
  'sessionid', 'session', 'token',
  'traceid', 'trace', 'tracelog', 'tracelogid',
  'requestid', 'reqid', 'correlationid'
]);

/**
 * Words that must never reach a friendly name. Two reasons, one list:
 * plumbing words carry no meaning for the reader, and PLAN.md §1.2's zero-jargon rule
 * (word list in §11's closing note) forbids showing "JSON", "API", "endpoint",
 * "payload" and friends outside Advanced mode. `/rest/payload/endpoint` must not become
 * "Endpoint", and `/api/58` must not become "Api".
 */
const GENERIC_SEGMENTS = new Set([
  'api', 'apis', 'rest', 'restapi', 'ajax', 'json', 'v1', 'v2', 'v3', 'v4',
  'graphql', 'gql', 'service', 'services', 'svc', 'gateway', 'gw', 'public',
  'web', 'www', 'data', 'demo',
  'endpoint', 'endpoints', 'payload', 'payloads', 'request', 'requests',
  'response', 'responses', 'resource', 'resources', 'handler', 'call', 'calls'
]);

/** Last-segment words that are qualifiers, so the segment before them is kept too. */
const QUALIFIER_SEGMENTS = new Set([
  'status', 'detail', 'details', 'info', 'list', 'search', 'get', 'query',
  'index', 'summary', 'state', 'result', 'results', 'view', 'page', 'items'
]);

/**
 * Base64-looking, ≥16 chars. Requires real entropy markers (padding/base64url specials,
 * or mixed case AND a digit) so ordinary long words like `flightreservations` are kept.
 * @param {string} s
 */
export function looksBase64(s) {
  if (typeof s !== 'string' || s.length < 16) return false;
  if (!/^[A-Za-z0-9+/_=-]+$/.test(s)) return false;
  if (/[+/=]/.test(s)) return true;
  return /[A-Z]/.test(s) && /[a-z]/.test(s) && /\d/.test(s);
}

/**
 * True when a URL path segment or param VALUE is an id / cache-buster / opaque blob.
 * @param {string} s
 */
export function isVolatileValue(s) {
  if (typeof s !== 'string' || s === '') return false;
  return RE_LONG_NUMBER.test(s) || RE_UUID.test(s) || RE_HEX_ID.test(s) || looksBase64(s);
}

/**
 * Split a param name into delimited tokens: on `_ - .` and on camelCase boundaries.
 * `masterhotelid_tracelogid` -> ["masterhotelid", "tracelogid"]
 * `hotelId`                  -> ["hotel", "id"]
 * @param {string} name
 * @returns {string[]}
 */
export function tokenizeParamName(name) {
  return String(name)
    .split(/[_\-.]+/)
    .flatMap((part) => part.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/))
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

/**
 * True when a param name is volatile: the literal §5.2 anchored list, OR (documented
 * extension) any delimited token of the name is a volatile marker.
 * @param {string} name
 */
export function isVolatileParamName(name) {
  if (RE_VOLATILE_PARAM_NAME.test(name)) return true;
  // Applied to single-token names too, so a bare `tracelogid` and an `x_tracelogid` are
  // treated the same way. An asymmetry there is a coin flip the user cannot see.
  return tokenizeParamName(name).some((token) => VOLATILE_NAME_TOKENS.has(token));
}

/* --------------------------------------------------------------------- normalizing */

/**
 * Percent-encode one query name or value for the urlPattern.
 *
 * urlPattern used to carry DECODED values, which made it ambiguous: a kept param whose
 * value contains a literal `&` (`?q=a%26b`) became `q=a&b`, so the compiled match list
 * read it back as two params and the entry could never match the very URL it came from.
 * No error, no warning — the user's change simply never applied.
 *
 * The `*` volatile sentinel is written by the CALLER, which knows whether a value was
 * starred; this function only ever encodes real values, and it encodes `*` to `%2A`
 * unconditionally. An earlier version short-circuited on `text === '*'`, so a param
 * whose real value was exactly `*` was emitted bare and read back as the wildcard —
 * `?star=%2A` then matched `?star=anything`. Never add that short-circuit back.
 */
function encodeQueryPart(text) {
  return encodeURIComponent(text).replace(/\*/g, '%2A');
}

/** Inverse of encodeQueryPart. Callers detect the bare `*` sentinel before decoding. */
export function decodeQueryPart(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function normalizePathname(pathname) {
  return pathname
    .split('/')
    .map((segment) => (isVolatileValue(segment) ? '*' : segment))
    .join('/');
}

/** @param {any} body @returns {any} parsed object/array, or null */
function parseBody(body) {
  if (body == null) return null;
  if (typeof body === 'object') return body;
  if (typeof body !== 'string') return null;
  const trimmed = body.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** @param {any} parsed @returns {string|undefined} */
function graphqlOperation(parsed) {
  if (!parsed) return undefined;
  if (Array.isArray(parsed)) {
    const names = parsed
      .map((entry) => (entry && typeof entry === 'object' ? entry.operationName : null))
      .filter((n) => typeof n === 'string' && n);
    return names.length ? names.join(',') : undefined;
  }
  if (typeof parsed === 'object' && typeof parsed.operationName === 'string' && parsed.operationName) {
    return parsed.operationName;
  }
  return undefined;
}

/**
 * Build the signature shape (everything except sigId). Pure and synchronous, so the
 * whole of §5.2 is testable without touching crypto.
 *
 * @param {string} method
 * @param {string} url
 * @param {any} [requestBody] raw string or already-parsed object
 * @returns {{method:string, urlPattern:string, gqlOperation?:string, bodyShape?:string}}
 */
export function buildSignature(method, url, requestBody) {
  const verb = String(method || 'GET').toUpperCase();
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // Not a parseable absolute URL: fall back to the raw string, minus any hash.
    return { method: verb, urlPattern: String(url).split('#')[0] };
  }

  parsed.hash = '';
  const host = parsed.host.toLowerCase();
  const origin = parsed.protocol + '//' + host;
  const pathPattern = normalizePathname(parsed.pathname);

  const body = parseBody(requestBody);
  const gqlOperation = graphqlOperation(body);
  const isGraphql = /\/graphql\/?$/i.test(parsed.pathname) || Boolean(gqlOperation);

  if (isGraphql) {
    /** @type {any} */
    const sig = { method: verb, urlPattern: origin + parsed.pathname };
    if (gqlOperation) sig.gqlOperation = gqlOperation;
    return sig;
  }

  /** @type {[string,string,boolean][]} name, value, wasVolatile */
  const kept = [];
  for (const [name, value] of parsed.searchParams.entries()) {
    if (isVolatileParamName(name)) continue;
    kept.push([name, value, isVolatileValue(value)]);
  }
  const rank = ([name, value, wild]) => name + '\u0000' + (wild ? '' : value);
  kept.sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0));

  const query = kept
    .map(([name, value, wild]) => encodeQueryPart(name) + '=' + (wild ? '*' : encodeQueryPart(value)))
    .join('&');
  /** @type {any} */
  const sig = { method: verb, urlPattern: origin + pathPattern + (query ? '?' + query : '') };

  if (body && !Array.isArray(body) && typeof body === 'object' && verb !== 'GET' && verb !== 'HEAD') {
    const keys = Object.keys(body).sort();
    if (keys.length) sig.bodyShape = keys.join(',');
  }
  return sig;
}

/** The exact string that gets hashed into sigId. */
export function signatureFingerprint(sig) {
  return sig.method + ' ' + sig.urlPattern + ' ' + (sig.gqlOperation || '') + ' ' + (sig.bodyShape || '');
}

/**
 * SHA-256 (crypto.subtle — service worker / panel / Node ≥20 only), first 12 hex chars.
 * @param {string} input
 * @returns {Promise<string>}
 */
export async function sha256Short(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return hex.slice(0, 12);
}

/**
 * Signature from the RAW parts the MAIN world reports. §5.2 / §17.3 keep the request
 * body itself in the page: interceptor.js sends only the sorted top-level KEYS and any
 * GraphQL operationName, so a synthetic body carrying exactly those facts is rebuilt
 * here and fed through the one normalizer. There is no second code path.
 *
 * @param {{method:string, url:string, requestBodyKeys?:string[], gqlOperation?:string}} raw
 */
export function buildSignatureFromParts(raw) {
  let synthetic = null;
  if (raw.gqlOperation) {
    synthetic = { operationName: raw.gqlOperation };
  } else if (Array.isArray(raw.requestBodyKeys) && raw.requestBodyKeys.length) {
    synthetic = {};
    for (const key of raw.requestBodyKeys) synthetic[key] = 0;
  }
  return buildSignature(raw.method, raw.url, synthetic);
}

/**
 * @param {{method:string, url:string, requestBodyKeys?:string[], gqlOperation?:string}} raw
 * @returns {Promise<RequestSignature>}
 */
export async function normalizeRaw(raw) {
  const sig = buildSignatureFromParts(raw);
  sig.sigId = await sha256Short(signatureFingerprint(sig));
  return /** @type {RequestSignature} */ (sig);
}

/**
 * Full §5.2 normalization.
 * @param {string} method
 * @param {string} url
 * @param {any} [requestBody]
 * @returns {Promise<RequestSignature>}
 */
export async function normalize(method, url, requestBody) {
  const sig = buildSignature(method, url, requestBody);
  sig.sigId = await sha256Short(signatureFingerprint(sig));
  return /** @type {RequestSignature} */ (sig);
}

/* ------------------------------------------------------------------- friendly name */

function sentenceCase(words) {
  const joined = words.join(' ').replace(/\s+/g, ' ').trim();
  if (!joined) return '';
  return joined[0].toUpperCase() + joined.slice(1);
}

function splitWords(segment) {
  return segment
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .split(/[_\-.+]+/)
    .flatMap((part) => part.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/))
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * The friendly source name shown in the panel AND returned by the MCP `list_sources`
 * tool — one implementation so the two can never drift (PLAN.md §10.2, §12.4 #2).
 *
 *   /api/flight/status      -> "Flight status"
 *   /demo/api/trip.json     -> "Trip"
 *   /hotels/detail/         -> "Hotels detail"
 *   GraphQL getHotelDetail  -> "Get hotel detail"
 *
 * @param {{urlPattern:string, gqlOperation?:string, method?:string}} sig
 * @returns {string}
 */
export function friendlyName(sig) {
  if (!sig) return 'Data';

  if (sig.gqlOperation) {
    const first = String(sig.gqlOperation).split(',')[0];
    const name = sentenceCase(splitWords(first));
    return name || 'Data';
  }

  let pathname = '';
  let host = '';
  try {
    const url = new URL(sig.urlPattern);
    pathname = url.pathname;
    host = url.host;
  } catch {
    pathname = String(sig.urlPattern || '').split('?')[0];
  }

  const bare = (segment) => segment.replace(/\.[a-z0-9]{1,5}$/i, '').toLowerCase();

  // A segment is meaningful when it is not a wildcard, not a routing word, and not a
  // bare number. Numbers are ids even when short: /api/58 must not be named "58", and
  // naming it "Api" would put a forbidden word (§11) in front of the user — so when
  // nothing meaningful is left, the host is the honest answer.
  const segments = pathname
    .split('/')
    .filter((s) => s && s !== '*')
    .filter((s) => !GENERIC_SEGMENTS.has(bare(s)))
    .filter((s) => !/^\d+$/.test(bare(s)));

  if (!segments.length) return host || 'Data';

  const lastWords = splitWords(segments[segments.length - 1]);
  let words = lastWords;

  if (segments.length > 1 && (QUALIFIER_SEGMENTS.has(lastWords.join('')) || lastWords.length === 0)) {
    words = splitWords(segments[segments.length - 2]).concat(lastWords);
  }

  // A compound segment can smuggle jargon past the segment filter (`booking-payload`),
  // so filter the words too rather than trusting the segment check alone.
  words = words.filter((word) => !GENERIC_SEGMENTS.has(word));

  return sentenceCase(words) || host || 'Data';
}

/* ------------------------------------------------------------------- match list */

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * PLAN.md §5.2 final paragraph: the SW compiles a match list the MAIN world evaluates
 * synchronously. `urlRegex` is the urlPattern with `*` -> `[^/&?]+`, anchored.
 *
 * DOCUMENTED REFINEMENT (README "Deviations"): the regex is built from the origin+path
 * half of urlPattern only, and query constraints travel beside it as `params`. A
 * urlPattern's query is normalized — volatile params dropped, the rest sorted — so a
 * regex built from it could never match the concrete, unsorted URL the page requests.
 * Matching params by name/value instead is what the normalization actually means:
 * "these params must be present with these values; anything else is volatile".
 * Entries are ordered most-constrained-first so §5.3's "first match wins" picks the
 * most specific signature when two overlap.
 *
 * A `params` entry of `[name, null]` means "this param must be present with any value"
 * — the volatile sentinel. `[name, "*"]` means the value must literally be `*`.
 *
 * @param {{signature:{method:string,urlPattern:string,gqlOperation?:string}, sigId:string, changes:{path:string,tokens:any[],value:any}[]}[]} groups
 * @returns {{sigId:string, method:string, urlRegex:string, params:[string,string|null][], gqlOperation?:string, changes:any[]}[]}
 */
export function compileMatchList(groups) {
  const list = [];
  for (const group of groups) {
    const sig = group && group.signature;
    if (!sig || !group.changes || !group.changes.length) continue;

    const [base, query] = String(sig.urlPattern).split('?');
    const urlRegex = '^' + escapeRegex(base).replace(/\\\*/g, '[^/&?]+') + '$';

    /** @type {[string,string|null][]} */
    const params = [];
    if (query) {
      for (const pair of query.split('&')) {
        if (!pair) continue;
        const idx = pair.indexOf('=');
        const rawName = idx === -1 ? pair : pair.slice(0, idx);
        const rawValue = idx === -1 ? '' : pair.slice(idx + 1);
        // A bare `*` is the volatile sentinel and becomes null ("any value"). Everything
        // else decodes to a literal — including `%2A`, a param whose real value is `*`.
        params.push([decodeQueryPart(rawName), rawValue === '*' ? null : decodeQueryPart(rawValue)]);
      }
    }

    /** @type {any} */
    const entry = { sigId: group.sigId, method: sig.method, urlRegex, params, changes: group.changes };
    if (sig.gqlOperation) entry.gqlOperation = sig.gqlOperation;
    list.push(entry);
  }
  list.sort((a, b) => b.params.length - a.params.length);
  return list;
}
