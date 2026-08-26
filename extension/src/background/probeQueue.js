/**
 * The selections the probe makes: which candidates are worth a reload (§7.2's replay
 * check, §7.4's null rule) and which nodes are worth a fingerprint once a field is
 * proved (§7.6).
 *
 * OWNER: probe-engineer. Split out of `probe.js` under §17.10, and the seam is chosen so
 * that these decisions can be tested exhaustively with no page and no reload — a
 * candidate silently dropped from the queue is a field the probe will report as "not the
 * one", which is the quietest way this product could be wrong. Everything here is pure
 * except `queueFor` at the bottom, which is the adapter that reads the store.
 */

import { getByPath, enumeratePaths } from '../shared/jsonpath.js';
import { changedNodes } from '../shared/diff.js';
import { getBindings } from './ruleStore.js';
import { friendlyName } from './signatures.js';

/**
 * The candidates that can actually be tested by refreshing, and the ones that cannot.
 *
 * §7.2's replay check: a source the page did not request again on the control loads
 * cannot be probed by refreshing at all — a Change on it applies the next time the site
 * asks for it, which is §11's `notRefetched`, and saying nothing about it would leave
 * the user with a field that "failed" for a reason MockLab knew and did not mention.
 *
 * §7.4: a null-valued candidate is skipped rather than probed. Writing a value where
 * the site expects none exercises its empty-state branch, so the element would change
 * for a reason that says nothing about the field.
 *
 * The values a probe may write come from what has REALLY been seen at the path — the
 * value on the page now, what the pick recorded, what a previous Binding remembers
 * (§4's `observedValues`, which §7.4 asks for by name). An invented constant is the
 * last resort, not the first.
 *
 * @param {{candidates:any[], sources:Map<string,any>, bindings:any[], nameFor:(captured:any)=>string}} input
 * @returns {{queue:any[], notRefetched:{sigId:string, path:string}[], nullValued:{sigId:string, path:string}[]}}
 */
export function buildQueue(input) {
  const sources = input.sources || new Map();
  const bindings = input.bindings || [];
  const queue = [];
  const notRefetched = [];
  const nullValued = [];

  for (const candidate of input.candidates || []) {
    const where = { sigId: candidate.sigId, path: candidate.path };
    const captured = sources.get(candidate.sigId);
    if (!captured) {
      notRefetched.push(where);
      continue;
    }
    const real = getByPath(captured.body, candidate.path);
    if (real === undefined || real === null) {
      nullValued.push(where);
      continue;
    }
    const binding = bindings.find((b) => b && b.sigId === candidate.sigId && b.path === candidate.path);
    const observed = [];
    for (const value of [candidate.value, ...((binding && binding.observedValues) || [])]) {
      if (value === null || value === undefined || typeof value === 'object') continue;
      if (String(value) !== String(real) && !observed.includes(String(value))) observed.push(String(value));
    }
    queue.push({
      sigId: candidate.sigId,
      path: candidate.path,
      sourceName: candidate.sourceName || input.nameFor(captured),
      real,
      observed,
      probeValue: undefined
    });
  }
  return { queue, notRefetched, nullValued };
}

/**
 * §7.6's answer to "which elements does this field drive": every non-masked node that
 * moved between the control run and the run with the field mutated, with the picked
 * element first because it is the one the user asked about.
 *
 * ANCESTORS OF THE PICKED ELEMENT ARE DROPPED, and that is the whole subtlety here. An
 * element's `innerText` contains its children's, so every wrapper around the pill —
 * the row, the card, `<body>` — "changes" whenever the pill does. §11 promises the
 * person "This change affects {k} places on the page"; counting six nested boxes as six
 * places would be true of the DOM and useless to a human.
 *
 * §7.6 gets that for free by sampling only elements with a direct text node. This takes
 * the ancestor rule directly instead, because the sample it reads includes §7.2's
 * region — which is what carries an element with NO text of its own, an icon or a
 * colour dot beside a status. Those are ordinary on real sites and invisible to the
 * literal rule. Recorded in README.
 *
 * @param {any} controlNodes @param {any} mutatedNodes
 * @param {Set<string>} mask @param {string|null} elementKey
 * @returns {string[]}
 */
export function affectedKeys(controlNodes, mutatedNodes, mask, elementKey) {
  const { keys } = changedNodes(controlNodes, mutatedNodes, mask);
  const kept = keys.filter((key) => key !== elementKey && !isAncestorOf(key, elementKey));
  return [elementKey, ...kept].filter(Boolean);
}

/** The index path out of a node key (`div@1.0.2`), or null when it carries none. */
function pathOf(key) {
  const at = String(key === null || key === undefined ? '' : key).indexOf('@');
  return at === -1 ? null : String(key).slice(at + 1);
}

/** Does `key` name an element that CONTAINS the one at `elementKey`? */
export function isAncestorOf(key, elementKey) {
  const outer = pathOf(key);
  const inner = pathOf(elementKey);
  if (outer === null || inner === null) return false;
  return outer === '' ? inner !== '' : inner.startsWith(outer + '.');
}

/**
 * §6.3's "Check all fields (slower)" and §7.5's exhaustive mode: every leaf of every
 * response this tab has, in candidate shape, so the same bisection can run over them.
 *
 * §7.5 is what makes this affordable — bisection costs about log2(n) reloads, so 400
 * fields is nine tests rather than four hundred. The cap is there because a batch is
 * applied to the REAL page: mutating a whole response at once is already a violent
 * thing to do to a site, and past a few hundred fields the site more often breaks than
 * renders, which produces an honest `elementLost` instead of an answer.
 *
 * @param {{sources:Map<string,any>, max?:number}} input
 * @returns {{sigId:string, path:string, value:any}[]}
 */
export function allFields(input) {
  const max = input.max || 400;
  const out = [];
  for (const [sigId, captured] of input.sources || new Map()) {
    const body = captured && captured.body;
    if (!body || typeof body !== 'object' || body.__unparsed) continue;
    for (const leaf of enumeratePaths(body)) {
      if (leaf.value === null || leaf.value === undefined) continue;
      out.push({ sigId, path: leaf.path, value: leaf.value });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/**
 * `buildQueue` with the store reads done for it: this origin's Bindings for §7.4's
 * observed values, and either §6.3's ranked guesses or — when the person asked for
 * "Check all fields (slower)" — every leaf the tab has captured.
 *
 * The one function here that is not pure, and the only one that knows a probe exists.
 *
 * @param {{origin:string, candidates:any[], sources:Map<string,any>, exhaustive:boolean,
 *   onNotRefetched:(list:any[])=>void}} input
 */
export async function queueFor(input) {
  const sources = input.sources || new Map();
  const { queue, notRefetched } = buildQueue({
    candidates: input.exhaustive ? allFields({ sources }) : input.candidates,
    sources,
    bindings: await getBindings(input.origin),
    nameFor: (captured) => friendlyName(captured.signature)
  });
  input.onNotRefetched(notRefetched);
  return queue;
}
