/**
 * Tiny JSONPath subset shared by every layer (PLAN.md §5.4).
 *
 * OWNER: interceptor-engineer.
 *
 * Grammar — deliberately ONLY this, because predictability beats power:
 *   $              root (required first character)
 *   .key           dot step, key matching /^[A-Za-z_$][\w$]*$/
 *   ["any key"]    bracket-quoted step (single or double quotes), any characters
 *   [123]          numeric array index
 *
 * No wildcards, no filters, no recursive descent. Keys that cannot be written in dot
 * form — unicode keys, keys containing dots or spaces — MUST round-trip through the
 * bracket form, which `formatPath` guarantees.
 *
 * NOTE: `interceptor.js` cannot import this file (MAIN world has no module graph,
 * PLAN.md §17.2). It receives pre-parsed token arrays from the service worker
 * instead, so the parser below stays the single source of truth for path syntax.
 */

/**
 * @typedef {Object} PathToken
 * @property {"key"|"index"} type
 * @property {string|number} value
 */

const DOT_KEY = /^[A-Za-z_$][\w$]*$/;

/**
 * Parse a JSONPath of the supported subset into tokens.
 * Returns null for anything outside the grammar — callers must handle null rather
 * than trusting a partially parsed path.
 *
 * @param {string} path
 * @returns {PathToken[]|null}
 */
export function parsePath(path) {
  if (typeof path !== 'string' || path.length === 0) return null;
  if (path[0] !== '$') return null;

  /** @type {PathToken[]} */
  const tokens = [];
  let i = 1;

  while (i < path.length) {
    const ch = path[i];

    if (ch === '.') {
      i += 1;
      let j = i;
      while (j < path.length && path[j] !== '.' && path[j] !== '[') j += 1;
      const key = path.slice(i, j);
      if (!DOT_KEY.test(key)) return null;
      tokens.push({ type: 'key', value: key });
      i = j;
      continue;
    }

    if (ch === '[') {
      const quote = path[i + 1];
      if (quote === '"' || quote === "'") {
        let j = i + 2;
        let key = '';
        let closed = false;
        while (j < path.length) {
          const c = path[j];
          if (c === '\\') {
            if (j + 1 >= path.length) return null;
            key += path[j + 1];
            j += 2;
            continue;
          }
          if (c === quote) {
            closed = true;
            break;
          }
          key += c;
          j += 1;
        }
        if (!closed || path[j + 1] !== ']') return null;
        tokens.push({ type: 'key', value: key });
        i = j + 2;
        continue;
      }

      const end = path.indexOf(']', i + 1);
      if (end === -1) return null;
      const raw = path.slice(i + 1, end);
      if (!/^\d+$/.test(raw)) return null;
      tokens.push({ type: 'index', value: Number(raw) });
      i = end + 1;
      continue;
    }

    return null;
  }

  return tokens;
}

/**
 * Render tokens back into a canonical path string. Keys that are not valid dot-form
 * identifiers are emitted in bracket form so every path round-trips through parsePath.
 *
 * @param {PathToken[]} tokens
 * @returns {string}
 */
export function formatPath(tokens) {
  let out = '$';
  for (const token of tokens) {
    if (token.type === 'index') {
      out += '[' + token.value + ']';
    } else if (DOT_KEY.test(String(token.value))) {
      out += '.' + token.value;
    } else {
      out += '["' + String(token.value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]';
    }
  }
  return out;
}

/**
 * Append one step to an existing path string.
 * @param {string} base
 * @param {string|number} step
 * @returns {string}
 */
export function joinPath(base, step) {
  if (typeof step === 'number') return base + '[' + step + ']';
  if (DOT_KEY.test(step)) return base + '.' + step;
  return base + '["' + step.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]';
}

function isContainer(value) {
  return value !== null && typeof value === 'object';
}

function hasStep(container, token) {
  if (!isContainer(container)) return false;
  if (token.type === 'index') {
    return Array.isArray(container) && token.value >= 0 && token.value < container.length;
  }
  return Object.prototype.hasOwnProperty.call(container, token.value);
}

/**
 * Read the value at `path`. Returns undefined when any step is missing.
 * @param {any} obj
 * @param {string} path
 * @returns {any}
 */
export function getByPath(obj, path) {
  const tokens = parsePath(path);
  if (!tokens) return undefined;
  let cur = obj;
  for (const token of tokens) {
    if (!hasStep(cur, token)) return undefined;
    cur = cur[token.value];
  }
  return cur;
}

/**
 * Write `value` at `path`. Creates NOTHING: if any intermediate step (or the final
 * key itself) does not already exist, nothing is written and false is returned.
 *
 * @param {any} obj
 * @param {string} path
 * @param {any} value
 * @returns {boolean} true when the write happened
 */
export function setByPath(obj, path, value) {
  const tokens = parsePath(path);
  if (!tokens || tokens.length === 0) return false;
  let cur = obj;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (!hasStep(cur, tokens[i])) return false;
    cur = cur[tokens[i].value];
  }
  const last = tokens[tokens.length - 1];
  if (!hasStep(cur, last)) return false;
  cur[last.value] = value;
  return true;
}

function isScalar(value) {
  return value === null || (typeof value !== 'object' && typeof value !== 'function');
}

/**
 * List every leaf scalar in `obj` as {path, value}. Bounded on both depth and count so
 * a hostile or enormous response can never hang the service worker.
 *
 * @param {any} obj
 * @param {number} [maxDepth=12]
 * @param {number} [maxPaths=5000]
 * @returns {{path:string, value:any}[]}
 */
export function enumeratePaths(obj, maxDepth = 12, maxPaths = 5000) {
  /** @type {{path:string, value:any}[]} */
  const out = [];
  const seen = new Set();

  function walk(node, path, depth) {
    if (out.length >= maxPaths) return;
    if (isScalar(node)) {
      out.push({ path, value: node });
      return;
    }
    if (depth >= maxDepth) return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        if (out.length >= maxPaths) return;
        walk(node[i], path + '[' + i + ']', depth + 1);
      }
      return;
    }
    for (const key of Object.keys(node)) {
      if (out.length >= maxPaths) return;
      walk(node[key], joinPath(path, key), depth + 1);
    }
  }

  walk(obj, '$', 0);
  return out;
}

/**
 * How many leaf scalars a body holds — the number the Sources tab prints as "{n} fields"
 * (§10.2) and the MCP `list_sources` tool returns as `fields` (§12.4 #2).
 *
 * Exactly `enumeratePaths(obj, ∞, ∞).length`, and it exists because that is not what the
 * bounded walk above returns. `enumeratePaths` is a SEARCH: it is bounded because the
 * work grows with (sources × needles) and something has to stop it, and when it stops
 * early the caller says so (`candidates.js`, `searched.complete`). A COUNT is a claim
 * about the data — "this source holds 18 fields" — and a bounded count is that claim
 * made false by an implementation detail the reader cannot see. Counting with the search
 * bounds would only move the lie: 24 levels is no more the truth about a body than 12 is.
 *
 * So this is unbounded, and three things make that affordable:
 *   - it builds no path strings, which is where enumeratePaths spends most of its time;
 *   - PLAN.md §4 already caps a parsed body at 2 MB (bigger arrives as an `{__unparsed}`
 *     preview and has no addressable fields at all), so the input is bounded by the one
 *     limit the product already states;
 *   - it is ITERATIVE. A recursive walk is safe only while a depth cap keeps the stack
 *     shallow; `JSON.parse` accepts nesting thousands deep, and a RangeError swallowed
 *     upstream would report "0 fields" — the same lie, told louder.
 *
 * Measured on a service-worker-sized budget (median of 9, Node 22): the demo's trip.json
 * 0.01 ms; a realistic 82 KB Next.js-shaped body 0.31 ms (against 1.80 ms for the walk it
 * replaces, which counted 2400 of its 3600 fields); the largest bodies §4 admits, 5-30 ms.
 *
 * Semantics match `enumeratePaths` exactly, including the parts that are not obvious:
 * `null` IS a leaf (a real, editable field), an empty object or array contributes
 * nothing, and a container reached twice is counted once.
 *
 * @param {any} obj
 * @returns {number}
 */
export function countLeaves(obj) {
  if (isScalar(obj)) return 1;
  let count = 0;
  const seen = new Set();
  /** @type {any[]} */
  const stack = [obj];
  while (stack.length) {
    const node = stack.pop();
    if (seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        const value = node[i];
        if (isScalar(value)) count += 1;
        else stack.push(value);
      }
      continue;
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (isScalar(value)) count += 1;
      else stack.push(value);
    }
  }
  return count;
}

/**
 * Loose value search over every leaf (PLAN.md §5.4, feeding the §6.3 scorer).
 *
 * `kind` reports HOW the leaf matched so the caller can score it:
 *   "exact"     — string equality after trim + lowercase
 *   "numeric"   — both sides parse to the same number
 *   "substring" — the needle appears inside the leaf (PLAN.md §6.3's loose rule)
 *
 * Scoring itself lives in §6.3, not here: this function only reports facts.
 *
 * @param {any} obj
 * @param {string|number} needle
 * @param {{maxDepth?:number, maxPaths?:number}} [opts]
 * @returns {{path:string, value:any, kind:"exact"|"numeric"|"substring"}[]}
 */
export function findByValue(obj, needle, opts = {}) {
  const leaves = enumeratePaths(obj, opts.maxDepth ?? 12, opts.maxPaths ?? 5000);
  const raw = String(needle == null ? '' : needle).trim();
  if (raw === '') return [];
  const lower = raw.toLowerCase();
  const needleNum = Number(raw.replace(/[\s,]/g, ''));
  const needleIsNum = raw !== '' && Number.isFinite(needleNum);

  /** @type {{path:string, value:any, kind:"exact"|"numeric"|"substring"}[]} */
  const hits = [];
  for (const leaf of leaves) {
    if (leaf.value === null) continue;
    const text = String(leaf.value).trim();
    const textLower = text.toLowerCase();
    if (textLower === lower) {
      hits.push({ path: leaf.path, value: leaf.value, kind: 'exact' });
      continue;
    }
    if (needleIsNum && typeof leaf.value !== 'boolean') {
      const leafNum = Number(text.replace(/[\s,]/g, ''));
      if (Number.isFinite(leafNum) && leafNum === needleNum) {
        hits.push({ path: leaf.path, value: leaf.value, kind: 'numeric' });
        continue;
      }
    }
    if (textLower.length && lower.length && textLower.includes(lower)) {
      hits.push({ path: leaf.path, value: leaf.value, kind: 'substring' });
    }
  }
  return hits;
}
