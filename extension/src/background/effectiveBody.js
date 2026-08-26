/**
 * What the page actually rendered from (PLAN.md §5.1.2, §6.3, §7.2, §7.4).
 *
 * OWNER: probe-engineer.
 *
 * `interceptor.js` captures the REAL response and reports `mocked` beside it — the
 * capture is what the server sent, never what the site received (§5.1.2: "The captured
 * body is always the REAL one"). While a Change is enabled on that signature those are
 * two different documents, and the site's own code ran on the second one.
 *
 * Everything that reasons BACKWARDS from the screen therefore has to reason about the
 * second one. Two places did not, and both were the same defect:
 *
 *   - §6.3 candidate discovery matches an element's rendered text against response data.
 *     Matched against the captured body while a Change was in force, a pill the person
 *     had just set to "Delayed" matched nothing, and the panel answered §11's
 *     `pick.noCandidates` — "MockLab couldn't find this text in any data the page
 *     loaded". The data was right there. That is README Deviation 32's false negative
 *     told as a fact (§17.12), one layer down from where it was fixed.
 *   - §7.4 probe values must differ from what the page renders NOW. Derived from the
 *     captured value while a Change already held that field at the probe's chosen
 *     replacement, the probe writes the value that is already on screen, the element
 *     does not move, and the run reports `noneConfirmed` about the field that drives it.
 *
 * Both share a root cause with the CONTROL_A divergence recorded in `probe.js` and in
 * README: that divergence keeps the person's Changes ON through the control runs, which
 * is precisely what makes "the body the page rendered from" a different document from
 * "the body MockLab captured". The divergence is worth keeping — a probe must not switch
 * the person's work off, and a crash mid-probe must not leave it off — but it is only
 * honest if every consumer knows, and until now none did. This module is where they ask.
 *
 * `probe:true` Changes are deliberately EXCLUDED. They are the probe's own scaffolding
 * (§17.5) and they come and go between reloads; the state described here is the CONTROL
 * state, which is the page as the person left it.
 */

import { getEnabledChanges } from './ruleStore.js';

/**
 * @typedef {Object} Overlay
 * @property {string} path   a §5.4 JSONPath into the response body
 * @property {any}    value  what the page sees there instead of the captured value
 */

/**
 * Every enabled non-probe Change for one origin, grouped by the signature it targets.
 *
 * The list for a signature is in creation order, which is the order `interceptor.js`
 * applies them in (§5.3: "multiple Changes on one signature all apply in order"), so the
 * LAST entry for a path is the one the body ends up carrying.
 *
 * @param {string} origin
 * @returns {Promise<Map<string, Overlay[]>>} empty when this site is not mocked at all
 */
export async function overlaysFor(origin) {
  /** @type {Map<string, Overlay[]>} */
  const bySignature = new Map();
  for (const change of await getEnabledChanges(origin)) {
    if (!change || change.probe === true) continue;
    if (typeof change.sigId !== 'string' || typeof change.path !== 'string') continue;
    const list = bySignature.get(change.sigId);
    if (list) list.push({ path: change.path, value: change.value });
    else bySignature.set(change.sigId, [{ path: change.path, value: change.value }]);
  }
  return bySignature;
}

/**
 * The value the page has at one path right now: the last Change that targets it, or the
 * captured value when none does.
 *
 * `real` is passed in rather than looked up, because the caller has already read it and
 * because a path that does not exist in the captured body is a Change that does nothing
 * — `setByPath` "creates nothing" (§5.4), so the page never saw it either.
 *
 * @param {Overlay[]|null|undefined} overlay the list for THIS signature
 * @param {string} path
 * @param {any} real the captured value at `path`
 * @returns {any}
 */
export function effectiveValue(overlay, path, real) {
  if (!overlay || real === undefined) return real;
  for (let i = overlay.length - 1; i >= 0; i -= 1) {
    if (overlay[i].path === path) return overlay[i].value;
  }
  return real;
}
