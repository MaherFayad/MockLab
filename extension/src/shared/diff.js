/**
 * Element snapshot diffing (PLAN.md §7.3), and the two set operations the probe builds
 * on it: the noise mask (§7.2) and inverse discovery (§7.6).
 *
 * OWNER: probe-engineer.
 *
 * Pure functions, no chrome APIs, no DOM: the snapshots arrive from `content/agent.js`
 * as plain objects, and everything below is comparison. That is deliberate — this is
 * the file that decides whether "the element changed", and §17.12 says a wrong
 * "Verified ✓" is the worst bug this product can have. A decision that can be unit
 * tested exhaustively should be.
 *
 * ── What a difference MEANS here ────────────────────────────────────────────────
 * `diffSnapshots` reports every field that differs, never a boolean. The probe needs
 * the field list twice: once to say WHY it thinks an element changed (Advanced mode,
 * and every failure message worth reading), and once because a difference in `text` and
 * a difference in `style.opacity` are not equally interesting to a human — but neither
 * is discarded here, because discarding one is a judgement about the site's rendering
 * that this file has no way to make correctly.
 *
 * An ABSENT snapshot is not an empty one. `null` vs `{…}` is the demo's cancellation
 * banner appearing out of `display:none` with no text, which is exactly the derived
 * element §7.6 exists to discover — so "present in one side only" is a difference, and
 * `EXISTENCE` names it rather than letting it hide inside a field comparison.
 */

/** The field name reported when a node exists on one side of a comparison only. */
export const EXISTENCE = 'exists';

/** Nested objects inside a §7.3 snapshot; their keys are reported as `attrs.href`. */
const NESTED = ['attrs', 'style'];

/** Ordered lists inside a §7.3 snapshot: compared element by element, order included. */
const LISTS = ['cls', 'childTexts'];

/** Scalars inside a §7.3 snapshot. `tag` is additive (see element.js) and cannot change. */
const SCALARS = ['tag', 'text', 'childCount'];

function isObject(value) {
  return Boolean(value) && typeof value === 'object';
}

/**
 * Every key of two records, in a stable order, so two runs of the same comparison
 * report the same field list — a diff whose output depends on insertion order makes
 * every message it appears in unreproducible.
 */
function keysOf(a, b) {
  const keys = new Set();
  for (const key of Object.keys(isObject(a) ? a : {})) keys.add(key);
  for (const key of Object.keys(isObject(b) ? b : {})) keys.add(key);
  return [...keys].sort();
}

function listsDiffer(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  if (left.length !== right.length) return true;
  return left.some((item, index) => String(item) !== String(right[index]));
}

/**
 * Which fields of two §7.3 element snapshots differ.
 *
 * @param {any} a
 * @param {any} b
 * @returns {string[]} field names, e.g. `["text", "style.color", "attrs.aria-label"]`,
 *   or `["exists"]` when one side is absent. Empty means the two are the same element
 *   in the same state as far as §7.3 can see.
 */
export function diffSnapshots(a, b) {
  const hasA = isObject(a);
  const hasB = isObject(b);
  if (!hasA && !hasB) return [];
  if (!hasA || !hasB) return [EXISTENCE];

  const fields = [];
  for (const key of SCALARS) {
    if (String(a[key] === undefined ? '' : a[key]) !== String(b[key] === undefined ? '' : b[key])) {
      fields.push(key);
    }
  }
  for (const key of NESTED) {
    for (const inner of keysOf(a[key], b[key])) {
      const left = isObject(a[key]) ? a[key][inner] : undefined;
      const right = isObject(b[key]) ? b[key][inner] : undefined;
      if (String(left === undefined ? '' : left) !== String(right === undefined ? '' : right)) {
        fields.push(`${key}.${inner}`);
      }
    }
  }
  for (const key of LISTS) {
    if (listsDiffer(a[key], b[key])) fields.push(key);
  }
  return fields;
}

/**
 * @param {any} a @param {any} b
 * @returns {boolean} true when §7.3 can see no difference at all.
 */
export function snapshotsEqual(a, b) {
  return diffSnapshots(a, b).length === 0;
}

/**
 * A list of `{key, snapshot}` nodes as a Map. Accepts a Map or a plain object too, so a
 * caller never has to know which shape crossed the wire.
 *
 * @param {any} nodes
 * @returns {Map<string, any>}
 */
export function toNodeMap(nodes) {
  if (nodes instanceof Map) return nodes;
  const map = new Map();
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      if (node && typeof node.key === 'string') map.set(node.key, node.snapshot);
    }
    return map;
  }
  if (isObject(nodes)) {
    for (const [key, snapshot] of Object.entries(nodes)) map.set(key, snapshot);
  }
  return map;
}

/**
 * Compare two keyed page samples.
 *
 * `appeared` and `vanished` are kept apart from `changed` because they mean different
 * things to the two callers: to the noise mask they are all noise, and to inverse
 * discovery an element that APPEARED is the most interesting result there is (the
 * demo's "Your flight was cancelled" banner is `display:none` with no text until the
 * status field says so).
 *
 * @param {any} before @param {any} after
 * @returns {{changed:string[], appeared:string[], vanished:string[], fields:Record<string,string[]>}}
 */
export function diffNodeMaps(before, after) {
  const left = toNodeMap(before);
  const right = toNodeMap(after);
  const changed = [];
  const appeared = [];
  const vanished = [];
  /** @type {Record<string, string[]>} */
  const fields = {};

  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const inLeft = left.has(key);
    const inRight = right.has(key);
    if (inLeft && !inRight) {
      vanished.push(key);
      fields[key] = [EXISTENCE];
      continue;
    }
    if (!inLeft && inRight) {
      appeared.push(key);
      fields[key] = [EXISTENCE];
      continue;
    }
    const differences = diffSnapshots(left.get(key), right.get(key));
    if (differences.length) {
      changed.push(key);
      fields[key] = differences;
    }
  }
  changed.sort();
  appeared.sort();
  vanished.sort();
  return { changed, appeared, vanished, fields };
}

/**
 * PLAN.md §7.2's noise mask: every node whose snapshot differs between the two control
 * runs, plus every node present in only one of them.
 *
 * A node absent from BOTH control runs is deliberately NOT masked — that is the demo's
 * banner, and masking it would make the probe blind to the one derived element the M4
 * DoD asks it to find.
 *
 * @param {any} controlA @param {any} controlB
 * @returns {Set<string>}
 */
export function buildNoiseMask(controlA, controlB) {
  const { changed, appeared, vanished } = diffNodeMaps(controlA, controlB);
  return new Set([...changed, ...appeared, ...vanished]);
}

/**
 * Every node that differs from the control run and is not masked — §7.6's inverse
 * discovery, and the same comparison the bisection uses to attribute a batch.
 *
 * @param {any} control  the control-run sample
 * @param {any} current  the sample taken with probe values applied
 * @param {Iterable<string>} [mask]  §7.2's noise mask
 * @returns {{keys:string[], fields:Record<string,string[]>}}
 */
export function changedNodes(control, current, mask) {
  const masked = mask instanceof Set ? mask : new Set(mask || []);
  const { changed, appeared, vanished, fields } = diffNodeMaps(control, current);
  const keys = [...changed, ...appeared, ...vanished].filter((key) => !masked.has(key)).sort();
  /** @type {Record<string, string[]>} */
  const kept = {};
  for (const key of keys) kept[key] = fields[key];
  return { keys, fields: kept };
}
