/**
 * What MockLab may still CLAIM about a proven Link today, and how it points at one on
 * the page — PLAN.md §1.1's third state and §10.3's overlays, from the panel's side.
 *
 * OWNER: panel-designer. A file of its own because both halves answer the same question
 * about the same thing, and both are read by three screens that may not import each other
 * (§10.1A's Recent links, §10.1D's result card, §10.2's tree rows).
 *
 * §17.6: every word comes from strings.js. §17.7: every colour from panel.css.
 * §17.8: every message type comes from a constant in `background/messages.js`. `HIGHLIGHT`
 * is §12.4 #9 — requested through the orchestrator during M5 and merged there since.
 *
 * ══════════════════════════════════════════════════════════════════════════════════
 *  §1.1's third state, and the ONE direction this file may move a Link in
 * ══════════════════════════════════════════════════════════════════════════════════
 * "Three states exist everywhere in UI and API: `verified` (proved by probe), `candidate`
 * (value-match guess), `stale` (was verified, but the site changed and it no longer
 * matches). … No silent downgrades."
 *
 * The store holds the first two. `stale` is different in kind: it is not something the
 * probe writes when it finishes, it is something that becomes true LATER, while nobody
 * is looking — a page redeploys, an endpoint is renamed, an element moves. Nothing writes
 * it at the moment it becomes true, because nothing is running at that moment. So the
 * panel has to be able to work it out at the moment it DRAWS, from what this page load
 * actually did.
 *
 * `shownLinkState()` is that, and it is built so it can only ever be wrong in the safe
 * direction:
 *
 *   • it never PRODUCES the word `verified`. It compares against it and otherwise returns
 *     the Link's own stored state unchanged, so no path through this file can raise a
 *     Link to proved — which is §17.4's rule kept structurally rather than remembered.
 *     (`guards.test.js` audits exactly that, and would fail on a `return 'verified'`.)
 *   • it downgrades only, and only on POSITIVE evidence. Two things count, and each is
 *     something MockLab watched happen:
 *       1. THE SOURCE STOPPED APPEARING. This tab captured requests on this page load and
 *          the Link's source was not among them (§7.2's replay check, asked of an ordinary
 *          page load rather than of a probe).
 *       2. THE ELEMENTS STOPPED RESOLVING. §10.3's highlight ran for this Link and drew
 *          nothing, which is §6.2's re-resolve failing on every fingerprint it holds.
 *   • it says nothing when it knows nothing. A tab MockLab has captured NOTHING on — a
 *     page that has not loaded yet, a panel opened before the first refresh — leaves every
 *     Link exactly as the store has it. "I have not seen that data" and "that data is
 *     gone" look identical from here, and only one of them is a finding.
 *
 * Neither condition is written back to the store. The panel reports what it can see now;
 * only the worker owns what MockLab believes (§17.4).
 */
import { S } from './strings.js';
import { MSG } from '../background/messages.js';

/** One Link, as a key: a Binding is identified by its source and its field. */
export const linkKey = (sigId, path) => `${sigId} ${path}`;

/**
 * The `reason` `panel.send()` reports when the worker returned NOTHING — no handler for
 * this message type in this build. It is the one failure that is a fact about MockLab
 * rather than about the page, and the only one this file may draw a conclusion from, so
 * it is a named constant here and imported by `panel.js` rather than spelled twice.
 */
export const NO_ANSWER = 'no-answer';

/**
 * Does this tab know what the page loaded?
 *
 * Both of these have to hold, and they are not the same question: `captured` is the
 * worker's answer about the TAB, `sources.length` is what this panel actually holds. A
 * disagreement between them (a reply in flight, an origin that just changed) is exactly
 * when a confident answer would be worth least.
 */
export function knowsWhatLoaded(ctx) {
  return Boolean(ctx.state.captured) && (ctx.state.sources || []).length > 0;
}

/** Every source identity this tab has seen on this page load. */
export function liveSigIds(ctx) {
  return new Set((ctx.state.sources || []).map((source) => source && source.sigId).filter(Boolean));
}

/**
 * Did the request behind this field come back on this page load? `true` when MockLab has
 * no idea — see the header: not knowing is not evidence.
 */
export function sourceStillLoads(ctx, sigId) {
  if (!sigId || !knowsWhatLoaded(ctx)) return true;
  return liveSigIds(ctx).has(sigId);
}

/** Links whose elements a §10.3 highlight could not find on this page load. */
export function elementsLost(ctx, sigId, path) {
  const lost = ctx.state.lostLinks;
  return Boolean(lost && lost.has(linkKey(sigId, path)));
}

/**
 * The state a Link may be DRAWN in right now — the Link's own, unless something MockLab
 * watched happen has taken the proof away from it. Downgrade only; see the header.
 *
 * @param {Object} binding a §4 Binding
 * @param {Object} ctx the panel context
 * @returns {string} one of §10.6's four words, or '' for a Link with no state at all
 */
export function shownLinkState(binding, ctx) {
  const held = (binding && binding.state) || '';
  // Only a proof can go stale. A guess that stops matching is still exactly a guess, and
  // moving it to a THIRD word would invent a distinction §10.6 does not have.
  if (held !== 'verified') return held;
  if (!sourceStillLoads(ctx, binding.sigId)) return 'stale';
  if (elementsLost(ctx, binding.sigId, binding.path)) return 'stale';
  return held;
}

/**
 * §10.4: "a scenario whose signatures no longer match anything → card shows Stale chip".
 *
 * ANY missing source, not every one, because §11's sentence for this card is "Some
 * changes may not apply" — a scenario half of which cannot reach the page is the case
 * that sentence was written for, and the one a person is most likely to be misled by.
 *
 * @returns {number} how many of the scenario's changes have nowhere to land right now
 */
export function scenarioMisses(preset, ctx) {
  if (!knowsWhatLoaded(ctx)) return 0;
  const live = liveSigIds(ctx);
  const changes = (preset && Array.isArray(preset.changes) && preset.changes) || [];
  return changes.filter((change) => change && change.sigId && !live.has(change.sigId)).length;
}

/* ───────────────────────────────────────────── §10.3 — pointing at it on the page */

/**
 * §10.1D's "Show me" and §10.2's ◎ "Show on page": ask the page to draw §10.3's overlays
 * over every element this field drives.
 *
 * FOUR ENDINGS, and three of them are the point of the function:
 *
 *   • the worker drew some — nothing to say. The answer is on the page, which is where
 *     the person is looking, and a toast over it would only cover it up.
 *   • the worker drew NONE. For a proved Link that is §6.2's re-resolve failing on every
 *     fingerprint — the second half of §1.1's stale, arriving live. It is remembered for
 *     this page load, so the chip beside the control the person just pressed changes to
 *     Stale, and §11's voice explains it instead of a button that appeared to do nothing.
 *   • the worker REFUSED, by name: a tab that is not a tab any more, a `chrome://` page
 *     or one opened before MockLab was installed (`no-tab`, `no-content-script`). This
 *     is something going wrong between the panel and this page, which is exactly what
 *     §11's `errors.pageBroke` is for, and the control STAYS AVAILABLE — the next page,
 *     or the same page after a refresh, is a different question.
 *   • the worker does not answer at all, because this half of §10.3 is not built in the
 *     browser the panel is running in. That is not a fact about the page and must not be
 *     reported as one (it is precisely the class of lie §17.12 is about), so the control
 *     is marked unavailable and says the one thing that is true: not ready yet.
 *
 * The last two used to be one. That was right for exactly as long as nothing answered
 * `HIGHLIGHT`: everything arrived as `{ok:false}`, and "still being built" was true of
 * all of it. `background/highlight.js` answers now, and answers with a REASON — so from
 * that milestone on, opening the panel on a `chrome://` tab and pressing "Show on page"
 * told the person a built feature was unbuilt AND latched the control off for the rest
 * of the session, on every site, until the panel was reopened. One honest sentence
 * turned into a wrong one and a dead button by a change three files away.
 *
 * @param {Object} ctx @param {{sigId:string, path:string}} link
 * @returns {Promise<{ok:boolean, elements:number}>}
 */
export async function showOnPage(ctx, link) {
  const sigId = (link && link.sigId) || '';
  const path = (link && link.path) || '';
  const res = await ctx.send(MSG.HIGHLIGHT, { tabId: ctx.state.tabId, sigId, path });
  if (!res || !res.ok) {
    // Only silence licenses the claim that the feature is missing, and only that claim
    // licenses turning the control off for the session. A refusal is an event, not a
    // capability — see the fourth ending above.
    const unbuilt = !res || res.reason === NO_ANSWER;
    if (unbuilt) ctx.state.canHighlight = false;
    ctx.toast(unbuilt ? S.notYet : S.errors.pageBroke, !unbuilt);
    ctx.rerender();
    return { ok: false, elements: 0 };
  }
  const elements = Number(res.elements) || 0;
  if (elements === 0) {
    forget(ctx, sigId, path);
    ctx.toast(S.highlight.none);
    ctx.rerender();
  }
  return { ok: true, elements };
}

/** Remember, for this page load only, that this Link's elements could not be found. */
function forget(ctx, sigId, path) {
  if (!ctx.state.lostLinks) ctx.state.lostLinks = new Set();
  ctx.state.lostLinks.add(linkKey(sigId, path));
}

/**
 * A new page load makes every "could not be found" observation obsolete — it was about a
 * document that no longer exists. Called by `panel.js` when the tab navigates or
 * reloads; forgetting too eagerly costs a Link one honest chip until the next highlight,
 * while forgetting too late leaves a Stale chip on a Link that came back.
 */
export function forgetLostLinks(ctx) {
  ctx.state.lostLinks = new Set();
}

/**
 * Can the highlight be asked for at all? Starts true and is only ever turned off by a
 * worker that did not answer (above) — the panel cannot ask "do you support this?"
 * without asking for the thing itself, and §10.3's overlays are not something to flash on
 * the page to find out.
 */
export function canHighlight(ctx) {
  return ctx.state.canHighlight !== false;
}
