/**
 * M3 — candidate discovery, the hypothesis generator (PLAN.md §6.3).
 *
 * OWNER: probe-engineer.
 *
 * Given the snapshot of one picked element and every response this tab has captured,
 * produce the ranked list of fields that MIGHT drive it. Nothing here proves anything:
 * §0.2 is explicit that value matching gives candidates with false positives and misses
 * derived values, and only the §7 probe can turn one of these into a link. So this file
 * writes no Binding, assigns no link state, and its output is labelled "Possible
 * sources" in the panel (§10.1C) — see §17.4.
 *
 * Pure functions only: no chrome APIs, no imports beyond the shared JSONPath subset, so
 * the whole scorer is unit-testable without a browser. `pickApi.js` is the glue that
 * feeds it captured bodies and answers the panel.
 *
 * ── Why the matcher is not a call to `findByValue` per needle ──────────────────────
 * §6.3 says to search each body "via findByValue". Done literally that is one full
 * `enumeratePaths` walk per (source × needle) — up to 200 sources × a dozen needles on
 * a news site, each rebuilding as many as 5000 path strings. So each body is enumerated
 * ONCE here and every needle is matched against that one leaf list.
 *
 * The matching semantics stay `findByValue`'s, exactly: `scanLeaves` below is the same
 * decision tree in the same order, and `candidates.test.js` asserts the two agree leaf
 * for leaf over a corpus of bodies and needles. That differential test is the point —
 * a comment asking the next person to keep two functions in step is not a guarantee.
 */

import { enumeratePaths, parsePath, getByPath } from '../shared/jsonpath.js';

/** §6.3: "Output: top 12 candidates". */
export const MAX_CANDIDATES = 12;

/**
 * How deep and how wide a response is searched.
 *
 * `jsonpath.enumeratePaths` defaults to depth 12 / 5000 paths (§5.4). Twelve is not
 * enough for the pages this product exists for: a Next.js `__NEXT_DATA__` or an Apollo
 * cache on a real travel site routinely nests past it, and a field below the cut is not
 * merely missed — the panel would answer `pick.noCandidates` ("MockLab couldn't find
 * this text in any data the page loaded"), which is §11 phrasing for "there is nothing
 * here". The field IS there. MockLab stopped looking. That is a false negative told as
 * a fact, and §1.1 forbids it as firmly as a false "Verified ✓".
 *
 * So the cut is raised, and — because any cut can still be hit — every result says
 * whether it was reached. `findCandidates` reports `searched.complete`, and a caller
 * that shows an empty list without checking it is making the same claim by omission.
 */
export const MAX_DEPTH = 24;
export const MAX_PATHS = 20000;

/**
 * Total leaves one pick may enumerate across ALL of a tab's responses.
 *
 * Raising the per-response cap raises the worst case with it: 200 captured sources each
 * at the 20 000-leaf ceiling is 4 million leaves and measured 3.2 s of blocked service
 * worker — for one click. This budget bounds that at a thirtieth of it. Sources are
 * searched newest-first (`pickApi.capturedSources`), so what is dropped is the oldest.
 *
 * It is only tolerable BECAUSE the result says so: anything past the budget counts in
 * `searched.bounded` exactly like a response that nested too deep. A cap that quietly
 * skipped responses would be the same false negative this file exists to avoid.
 */
export const MAX_TOTAL_PATHS = 120000;

/**
 * §6.3's scores, named. `full` is "exact full-text equality", `numeric` is "exact
 * numeric", `substring` is §6.3's loose rule, `siblingKey` is the enum-discovery
 * heuristic — the one that finds "ON_TIME" behind a pill that reads "On time".
 *
 * `attrExact` and `wordExact` are not in §6.3's three-value list, which only prices a
 * hit by HOW it matched and not by WHAT matched. A single word out of a sentence
 * matching a leaf exactly is much weaker evidence than the whole element text matching
 * it, and pricing both at 1.0 would let the word "Total" outrank the number the user
 * actually pointed at. See README Deviations.
 */
export const SCORE = {
  fullExact: 1.0,
  attrExact: 0.95,
  numeric: 0.9,
  wordExact: 0.6,
  substring: 0.5,
  siblingKey: 0.45
};

/** §6.3's status-ish key test, verbatim. */
const STATUS_ISH_KEY = /status|state|type|code|availability|stock/i;

/** §6.3: "each word ≥ 3 chars". */
const MIN_WORD_LENGTH = 3;

/** Bound on the needle set, so one picked paragraph cannot turn into 400 scans. */
const MAX_NEEDLES = 16;

/**
 * Attributes whose value is text a person can actually see or hear, and which a site
 * therefore renders from data the same way it renders the element's text. `id`, `class`
 * and `data-testid` are deliberately absent: they are build artefacts, they match
 * everything ("status-pill" contains "status"), and a hit on one proves nothing.
 */
const ATTR_NEEDLES = ['aria-label', 'aria-valuetext', 'alt', 'title', 'placeholder', 'value', 'data-value'];

/**
 * @typedef {Object} SourceInput
 * @property {string} sigId
 * @property {string} [name]   friendly source name (§10.2), passed through untouched
 * @property {any}    body     parsed response body
 * @property {number} [ts]     capture timestamp — the recency tiebreak in §6.3
 * @property {import('./effectiveBody.js').Overlay[]} [changes] the enabled Changes in
 *   force on this signature — the page rendered from the body WITH these applied, so the
 *   search must see them. `effectiveBody.js` has the why.
 */

/**
 * @typedef {Object} Candidate
 * @property {string} sigId
 * @property {string} [sourceName]
 * @property {string} path
 * @property {any}    value
 * @property {number} score
 * @property {string} via      the rule that produced the WINNING score
 * @property {string[]} rules  every rule that produced a hit for this field, sorted
 * @property {boolean} [mocked]    a Change is in force here, so `value` is what the page
 *   received and not what the site sent; `realValue` is the captured one
 * @property {any}     [realValue]
 */

/**
 * @typedef {Object} Needle
 * @property {string} value
 * @property {"full"|"attr"|"number"|"time"|"word"} kind
 */

/* ────────────────────────────────────────────────────────────────────── needles */

/** Strongest first: a value that appears as two kinds is kept as the stronger one. */
const NEEDLE_RANK = { full: 0, attr: 1, time: 2, number: 3, word: 4 };

/**
 * The needles §6.3 lists, from one element snapshot (§7.3): the full trimmed text, each
 * numeric token in it, each word of 3 characters or more, plus `HH:MM` times kept whole
 * — "12:40" must stay one needle, or it becomes the two meaningless numbers 12 and 40.
 *
 * @param {{text?:string, attrs?:Record<string,string>}} snapshot
 * @returns {Needle[]}
 */
export function needlesFrom(snapshot) {
  /** @type {Map<string, Needle>} */
  const byValue = new Map();

  const add = (raw, kind) => {
    const value = String(raw == null ? '' : raw).trim();
    if (!value) return;
    const existing = byValue.get(value.toLowerCase());
    if (existing && NEEDLE_RANK[existing.kind] <= NEEDLE_RANK[kind]) return;
    byValue.set(value.toLowerCase(), { value, kind });
  };

  const text = String((snapshot && snapshot.text) || '').trim();
  add(text, 'full');

  const attrs = (snapshot && snapshot.attrs) || {};
  for (const name of ATTR_NEEDLES) {
    if (typeof attrs[name] === 'string') add(attrs[name], 'attr');
  }

  // Times first, then blanked out, so the number pass cannot shred "12:40" into 12/40.
  let rest = text;
  for (const match of text.matchAll(/\d{1,2}:\d{2}(?::\d{2})?/g)) add(match[0], 'time');
  rest = rest.replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ');

  // "SAR 450.00" -> "450.00"; "1,299" -> "1,299", which findByValue's numeric compare
  // already strips separators from on both sides (§6.3's "no thousands separators").
  for (const match of rest.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) add(match[0], 'number');

  for (const match of text.matchAll(/[\p{L}\p{N}_]+/gu)) {
    if (match[0].length >= MIN_WORD_LENGTH) add(match[0], 'word');
  }

  return [...byValue.values()]
    .sort((a, b) => NEEDLE_RANK[a.kind] - NEEDLE_RANK[b.kind] || b.value.length - a.value.length)
    .slice(0, MAX_NEEDLES);
}

/* ───────────────────────────────────────────────────────────────────────── leaves */

/**
 * One enumerated leaf, pre-normalised so a needle scan is string comparisons and
 * nothing else. `key` is the nearest KEY step of the path — `$.flights[0].status` keys
 * on "status", `$.codes[3]` on "codes" — which is what the sibling-key rule reads.
 *
 * @typedef {Object} Leaf
 * @property {string} path
 * @property {any} value
 * @property {string} key
 * @property {string} lower
 * @property {number|null} num
 * @property {boolean} [mocked] a Change's value, not the captured one; `real` is under it
 * @property {any} [real]
 */

/** @param {string} path @returns {string} */
function lastKeyOf(path) {
  const tokens = parsePath(path);
  if (!tokens) return '';
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (tokens[i].type === 'key') return String(tokens[i].value);
  }
  return '';
}

/**
 * Did enumeration at `depth` drop anything? True when a non-empty container sits
 * exactly at the depth limit, which is the point `enumeratePaths` returns without
 * descending. Mirrors its walk — same cycle guard, same "scalars are never containers"
 * — but builds no strings and stops at the first hit, so it is a fraction of the cost.
 *
 * @param {any} node @param {number} remaining @param {Set<any>} seen
 * @returns {boolean}
 */
function droppedByDepth(node, remaining, seen) {
  if (!node || typeof node !== 'object') return false;
  if (seen.has(node)) return false;
  seen.add(node);
  const entries = Array.isArray(node) ? node : Object.values(node);
  if (remaining <= 0) return entries.length > 0;
  for (const entry of entries) {
    if (droppedByDepth(entry, remaining - 1, seen)) return true;
  }
  return false;
}

/**
 * Every leaf scalar of one body, normalised once, plus whether the walk reached the end
 * of it. Non-JSON bodies (§5.1.4's `{__unparsed:true}` previews) yield nothing: MockLab
 * cannot address a field inside something it never parsed, so offering one as a
 * candidate would be a lie — and that is a KNOWN nothing, not a bounded one, so it is
 * reported complete.
 *
 * @param {any} body
 * @param {number} [limit=MAX_PATHS] leaf budget for THIS body — the caller lowers it as
 *   the tab-wide budget runs down
 * @returns {{leaves:Leaf[], bounded:boolean}}
 */
export function leavesOf(body, limit = MAX_PATHS, changes = null) {
  if (!body || typeof body !== 'object' || body.__unparsed === true) {
    return { leaves: [], bounded: false };
  }
  if (limit <= 0) return { leaves: [], bounded: true };
  const out = [];
  for (const entry of enumeratePaths(body, MAX_DEPTH, limit)) {
    // findByValue skips null leaves; so does this, and for the same reason — §7.4
    // forbids probing a null-valued candidate, so listing one wastes a probe slot.
    if (entry.value === null) continue;
    out.push(normalise(entry.path, entry.value));
  }
  const bounded = out.length >= limit || droppedByDepth(body, MAX_DEPTH, new Set());
  for (const leaf of overlayLeaves(body, changes)) out.push(leaf);
  return { leaves: out, bounded };
}

/** One leaf, pre-normalised so a needle scan is string comparisons and nothing else. */
function normalise(path, value, extra) {
  const text = String(value).trim();
  const numeric = typeof value === 'boolean' ? NaN : Number(text.replace(/[\s,]/g, ''));
  const num = Number.isFinite(numeric) ? numeric : null;
  return { path, value, key: lastKeyOf(path), lower: text.toLowerCase(), num, ...(extra || {}) };
}

/**
 * The leaves a Change put on the page, added BESIDE the captured ones rather than in
 * place of them (`effectiveBody.js` explains why the search must see them at all).
 *
 * Both, and not a rewritten body, because MockLab cannot know which of the two documents
 * the page in front of the person was built from: a Change enabled a moment ago has not
 * reached the site yet, and `interceptor.js` can report a `changeDropped` response it
 * never managed to rewrite (§5.1) — in both, the page really did render the captured
 * value. The union costs one extra leaf per Change and is right in every case; picking
 * one document is right in most and silently wrong in the rest, which is the failure
 * this file exists to avoid. A Change whose path is absent from the body contributes
 * nothing: `setByPath` "creates nothing" (§5.4), so the page never saw it either.
 *
 * @param {any} body @param {import('./effectiveBody.js').Overlay[]|null} changes
 * @returns {Leaf[]}
 */
function overlayLeaves(body, changes) {
  if (!Array.isArray(changes) || !changes.length) return [];
  /** @type {Map<string, Leaf>} */
  const byPath = new Map();
  for (const change of changes) {
    if (!change || typeof change.path !== 'string') continue;
    const value = change.value;
    // The captured walk's own two exclusions: a null leaf is not a candidate (§7.4), a
    // container is not a leaf. Then: §5.3 applies a signature's Changes in order.
    if (value === null || value === undefined || typeof value === 'object') continue;
    const real = getByPath(body, change.path);
    if (real === undefined || String(real) === String(value)) continue;
    byPath.set(change.path, normalise(change.path, value, { mocked: true, real }));
  }
  return [...byPath.values()];
}

/**
 * `findByValue` over an already-enumerated leaf list — same decision tree, same order,
 * same three `kind`s, one leaf yielding at most one hit. `candidates.test.js` proves the
 * agreement rather than asserting it in prose.
 *
 * @param {Leaf[]} leaves
 * @param {string|number} needle
 * @returns {{path:string, value:any, kind:"exact"|"numeric"|"substring"}[]}
 */
export function scanLeaves(leaves, needle) {
  const raw = String(needle == null ? '' : needle).trim();
  if (raw === '') return [];
  const lower = raw.toLowerCase();
  const needleNum = Number(raw.replace(/[\s,]/g, ''));
  const needleIsNum = Number.isFinite(needleNum);

  const hits = [];
  const hit = (leaf, kind) =>
    ({ path: leaf.path, value: leaf.value, kind, ...(leaf.mocked ? { mocked: true, real: leaf.real } : {}) });
  for (const leaf of leaves) {
    if (leaf.lower === lower) {
      hits.push(hit(leaf, 'exact'));
      continue;
    }
    if (needleIsNum && leaf.num !== null && leaf.num === needleNum) {
      hits.push(hit(leaf, 'numeric'));
      continue;
    }
    if (leaf.lower.length && lower.length && leaf.lower.includes(lower)) {
      hits.push(hit(leaf, 'substring'));
    }
  }
  return hits;
}

/* ──────────────────────────────────────────────────────────────────────── scoring */

/** @param {Needle} needle @param {"exact"|"numeric"|"substring"} kind */
function scoreOf(needle, kind) {
  if (kind === 'substring') return { score: SCORE.substring, via: 'substring' };
  if (kind === 'numeric') return { score: SCORE.numeric, via: 'numeric' };
  switch (needle.kind) {
    case 'full':
      return { score: SCORE.fullExact, via: 'full-text' };
    case 'attr':
      return { score: SCORE.attrExact, via: 'attribute' };
    case 'time':
    case 'number':
      return { score: SCORE.numeric, via: 'numeric' };
    default:
      return { score: SCORE.wordExact, via: 'word' };
  }
}

/**
 * Rank and cut. §6.3: "ties broken by shorter path, then by response recency."
 * @param {Map<string, Candidate & {ts:number}>} byField
 * @returns {Candidate[]}
 */
function rank(byField) {
  return [...byField.values()]
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length || b.ts - a.ts)
    .slice(0, MAX_CANDIDATES)
    .map(({ ts, ...candidate }) => ({ ...candidate, rules: candidate.rules.slice().sort() }));
}

/**
 * Score one field, keeping the best rule that has hit it so far and remembering every
 * rule that did. Two rules finding the same field is corroboration the panel can show
 * in Advanced mode, and it is what lets a test assert that the sibling-key heuristic
 * fired even when a substring hit outranked it.
 */
function record(byField, source, hit) {
  const id = source.sigId + ' ' + hit.path;
  const existing = byField.get(id);
  if (!existing) {
    byField.set(id, {
      sigId: source.sigId,
      ...(source.name ? { sourceName: source.name } : {}),
      path: hit.path,
      value: hit.value,
      ...(hit.mocked ? { mocked: true, realValue: hit.real } : {}),
      score: hit.score,
      via: hit.via,
      rules: [hit.via],
      ts: Number(source.ts) || 0
    });
    return;
  }
  if (!existing.rules.includes(hit.via)) existing.rules.push(hit.via);
  // A field with a Change in force reports the value the PAGE has, whichever of its two
  // leaves scored higher; the captured one travels beside it rather than in place of it.
  if (hit.mocked && !existing.mocked) {
    Object.assign(existing, { mocked: true, realValue: hit.real, value: hit.value });
  }
  if (hit.score > existing.score) {
    existing.score = hit.score;
    existing.via = hit.via;
    if (!existing.mocked) existing.value = hit.value;
  }
}

/**
 * The §6.3 engine. Takes the picked element's snapshot and every captured body of the
 * tab; returns the ranked "Possible sources" list.
 *
 * ── The sibling-key heuristic, and the one judgement call in this file ────────────
 * §6.3: "if a leaf key looks status-ish … in a response that ALSO had a full-text hit
 * anywhere, add it with score 0.45 (this is how `ON_TIME` gets found when the pill
 * shows localized 'On time' text with no verbatim match)".
 *
 * Read strictly — "a hit for the FULL-TEXT needle" — the gate never fires in the case
 * the sentence itself gives as its example: a pill reading "On time" has no verbatim
 * match anywhere in `{"status":"ON_TIME"}`, so there is no full-text hit to hang off.
 *
 * `ON_TIME` is still FOUND, though — and an earlier version of this comment claimed it
 * was not, which was wrong. `needlesFrom` also derives the word needle `time`, and
 * `"ON_TIME".toLowerCase()` contains it, so the plain substring rule scores `$.status`
 * at 0.50, above the 0.45 this heuristic would give it. The demo passes either way.
 *
 * The cost of the strict reading is subtler than a failed example, which is why it was
 * easy to mis-state: it makes enum discovery depend on English "On time" and the
 * constant `ON_TIME` happening to share a substring. `"Delayed"`/`"LATE"`,
 * `"Sold out"`/`"OOS"` and any localized interface share none, and there the strict gate
 * finds nothing at all. See the LOCALIZED fixture in `candidates.test.js`, where the
 * heuristic is the only thing that can find the field.
 *
 * So "hit" here means any hit from any needle derived from the element (see
 * `needlesFrom`) — the test being "this response demonstrably renders part of this
 * element", which is what makes its status-ish siblings worth a probe slot. A response
 * with no hit at all contributes no sibling keys, so an unrelated source cannot leak in.
 * Recorded in README Deviations.
 *
 * ── The body this searches ────────────────────────────────────────────────────────
 * `source.changes` carries the Changes in force on that signature, searched beside the
 * captured values. Without it, an element the person had just changed — the whole point
 * of the product — matched NOTHING and the panel answered §11's `pick.noCandidates`
 * about data the page was rendering at that moment. `effectiveBody.js` holds the
 * reasoning and its shared root with the CONTROL_A divergence in `probe.js`.
 *
 * `searched` is the honesty half of the answer: `{sources, bounded, complete}`. `bounded`
 * counts responses whose enumeration hit MAX_DEPTH or MAX_PATHS, and `complete` is false
 * whenever one did. An empty `candidates` with `complete:false` means "MockLab did not
 * reach everywhere", which is a different sentence from `pick.noCandidates` and must be
 * shown as one.
 *
 * @param {{text?:string, attrs?:Record<string,string>}} snapshot
 * @param {SourceInput[]} sources
 * @returns {{candidates:Candidate[], needles:Needle[], searched:{sources:number, bounded:number, complete:boolean}}}
 */
export function findCandidates(snapshot, sources) {
  const needles = needlesFrom(snapshot);
  /** @type {Map<string, Candidate & {ts:number}>} */
  const byField = new Map();
  const list = Array.isArray(sources) ? sources.filter((s) => s && typeof s.sigId === 'string') : [];
  const searched = { sources: list.length, bounded: 0, complete: true };
  if (!needles.length) return { candidates: [], needles, searched };

  let budget = MAX_TOTAL_PATHS;
  for (const source of list) {
    const { leaves, bounded } = leavesOf(source.body, Math.min(MAX_PATHS, budget), source.changes);
    budget -= leaves.length;
    if (bounded) {
      searched.bounded += 1;
      searched.complete = false;
    }
    if (!leaves.length) continue;

    let related = false;
    for (const needle of needles) {
      for (const hit of scanLeaves(leaves, needle.value)) {
        related = true;
        record(byField, source, { ...hit, ...scoreOf(needle, hit.kind) });
      }
    }

    if (!related) continue;
    for (const leaf of leaves) {
      if (!STATUS_ISH_KEY.test(leaf.key)) continue;
      if (typeof leaf.value === 'object') continue;
      record(byField, source, {
        path: leaf.path,
        value: leaf.value,
        ...(leaf.mocked ? { mocked: true, real: leaf.real } : {}),
        score: SCORE.siblingKey,
        via: 'sibling-key'
      });
    }
  }

  return { candidates: rank(byField), needles, searched };
}

/**
 * The same engine with one caller-supplied needle and no element — PLAN.md §12.4 #4's
 * `search_value` tool, "the §6.3 engine, exposed raw". No sibling-key pass: that rule
 * reasons about an element's rendered text, and there is no element here.
 *
 * @param {string|number} needle
 * @param {SourceInput[]} sources
 * @returns {Candidate[]}
 */
export function searchValue(needle, sources) {
  /** @type {Map<string, Candidate & {ts:number}>} */
  const byField = new Map();
  /** @type {Needle} */
  const one = { value: String(needle == null ? '' : needle).trim(), kind: 'full' };
  if (!one.value) return [];

  for (const source of Array.isArray(sources) ? sources : []) {
    if (!source || typeof source.sigId !== 'string') continue;
    for (const hit of scanLeaves(leavesOf(source.body, MAX_PATHS, source.changes).leaves, one.value)) {
      record(byField, source, { ...hit, ...scoreOf(one, hit.kind) });
    }
  }
  return rank(byField);
}
