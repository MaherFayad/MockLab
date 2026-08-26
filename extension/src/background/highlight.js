/**
 * §10.3's on-page highlights, from the worker's side — PLAN.md §10.3, §10.2, §12.4 #9.
 *
 * OWNER: interceptor-engineer.
 *
 * ── What was missing ────────────────────────────────────────────────────────────────
 * M5 built both CONSUMERS of `MSG.HIGHLIGHT` — the panel's "Show me" / "Show on page"
 * (`panel/links.js`) and the MCP `highlight` tool (`wsOps.js`) — and no worker answered
 * it. Both said "not ready yet", correctly. This answers it.
 *
 * ── Why the drawing runs from here and not in `agent.js` ────────────────────────────
 * PLAN.md §2 sketches overlays as `agent.js`'s job, and the picker's hover overlay is
 * indeed there (`content/picker.js`). This half is injected instead, with
 * `chrome.scripting.executeScript` into the SAME ISOLATED world the content scripts run
 * in, exactly as `wsOps.findTargetInPage` already does for `probe_element`. Three
 * reasons, in order of weight:
 *
 *   1. It reads the contract `element.js` publishes (`resolveFingerprint`, `textOf`,
 *      `normText`) and adds nothing to it, so nothing new has to be mirrored across the
 *      MAIN/ISOLATED boundary or added to the Port protocol.
 *   2. A highlight is a one-shot side effect with a 4-second life. The Port carries
 *      standing state (the match list, the pick, a running probe); a fire-and-forget
 *      draw does not belong in it.
 *   3. `agent.js` is another owner's file. The injected form needs no line of it.
 *
 * Recorded as a deviation rather than done quietly. If overlays later move into
 * `agent.js`, this file is one `executeScript` call to delete.
 *
 * ── §1.1, which is the whole point of the answer shape ──────────────────────────────
 * `{ok:true, elements:n, verified:boolean}` is §12.4 #9's shape and every field of it is
 * a claim MockLab has to be able to stand behind:
 *
 *   • `verified` is a claim about PROOF, read from the stored Binding and never derived
 *     from anything that happened during this call (§17.4). False draws §10.3's dashed
 *     amber "best guess" outline and §11's `sources.guessHighlight`, never the solid one.
 *   • `elements` is how many overlays were ACTUALLY DRAWN — not how many fingerprints
 *     the Binding holds, not how many resolved. A proved Link whose elements are gone
 *     after a redesign returns 0, which is what makes the panel's stale chip (README
 *     Deviation 65) able to appear at all.
 *   • a fingerprint that re-resolves below §6.2's 0.8 confidence is NOT drawn. Below it
 *     the match came from the tree path alone — "whatever is in that position now" —
 *     and a solid accent box around the wrong element is §17.12's bug drawn on the
 *     user's own page. Counted in `lowConfidence`, so the caller can tell "gone" from
 *     "not sure enough".
 *   • an element that resolved but is scrolled out of view is counted in `offscreen` and
 *     drawn where it is. §10.3 dismisses the overlays ON scroll, so scrolling one into
 *     view would erase the thing it was scrolled to.
 */

import { MSG, CONTENT_GLOBALS } from './messages.js';
import { parsePath, getByPath } from '../shared/jsonpath.js';
import { findBinding } from './ruleStore.js';
import { overlaysFor, effectiveValue } from './effectiveBody.js';

/** Every message type this module answers. `changesApi.js` folds it into the router's set. */
export const HIGHLIGHT_MESSAGE_TYPES = new Set([MSG.HIGHLIGHT]);

/*
 * WHY THE MODE IS CALLED `proved` AND NOT `verified`.
 *
 * §10.3 has two overlays and the obvious pair of words for them is verified/guess. The
 * word `verified` is spoken for: §17.4 allows exactly one assignment of it in the whole
 * codebase, in probe.js's CONFIRMED state, and `guards.test.js` audits every OTHER
 * production of the literal — including `mode: 'verified'`, which is what this file said
 * first and what that guard caught. The guard is right even though this particular use
 * was a CSS class name: a codebase where the word appears as a value in six harmless
 * places is one where the seventh is invisible. The boolean this file REPORTS is still
 * `verified`, because §12.4 #9 names the field and it is read from the stored Binding.
 */

/** §6.2: below this, the element was found by tree position alone. Never drawn. See header. */
export const MIN_CONFIDENCE = 0.8;

/** §10.3: "auto-dismiss after 4 s or on scroll+click". */
const DISMISS_MS = 4000;

/** §10.3: "stagger pop-ins 60ms apart". */
const STAGGER_MS = 60;

/** §6.3's ceiling, reused: a guess that matches half the page is not a highlight. */
const MAX_GUESSES = 12;

/**
 * §17.7 — the second file in this extension that hardcodes colour, and for the same
 * reason `content/picker.js` does (README Deviation 21): this stylesheet is injected
 * into the user's page, which can never reach `panel.css`. Every value below is copied
 * verbatim from §9.1's `:root` blocks — accent and its dark twin, `--text-oninverse`,
 * and the warning pair with `--bg-warning` — and the two recipes are §9.2's: the solid
 * accent outline for a proved Link, and the "Possible" chip's own colours for a guess,
 * so the page and the panel say the same thing in the same colours.
 *
 * `prefers-reduced-motion` removes the pop and the stagger's transition (§9, M7's a11y
 * rule) without removing the overlay — the information is the outline, not the motion.
 */
const OVERLAY_CSS = [
  '.box{position:absolute;box-sizing:border-box;border-radius:10px;pointer-events:none;',
  'opacity:0;transform:scale(0.96);transform-origin:center;',
  'transition:opacity 250ms cubic-bezier(0.4,0,0.2,1),transform 350ms cubic-bezier(0.34,1.56,0.64,1)}',
  '.box.on{opacity:1;transform:scale(1)}',
  '.box.proved{border:2px solid #0066FF;background:rgba(0,102,255,.08)}',
  '.box.guess{border:2px dashed #B26A00;background:rgba(178,106,0,.08)}',
  '.chip{position:absolute;bottom:calc(100% + 6px);left:0;max-width:22rem;overflow:hidden;',
  'text-overflow:ellipsis;white-space:nowrap;border-radius:999px;padding:2px 8px;',
  'font:600 0.75rem/1.5 Inter,-apple-system,system-ui,sans-serif}',
  '.box.proved .chip{background:#0066FF;color:#FFFFFF}',
  '.box.guess .chip{background:#FFF4E0;color:#B26A00;border:1px dashed #B26A00}',
  '.box.low .chip{bottom:auto;top:calc(100% + 6px)}',
  '@media (prefers-color-scheme:dark){',
  '.box.proved{border-color:#4A90FF}.box.proved .chip{background:#4A90FF}',
  '.box.guess{border-color:#FDD663}',
  '.box.guess .chip{background:#3A3323;color:#FDD663;border-color:#FDD663}}',
  '@media (prefers-reduced-motion:reduce){.box{transition:none;transform:none}',
  '.box.on{transform:none}}'
].join('');

/**
 * The chip's label: the field's own last step, e.g. `$.data.flights[0].status` -> status.
 *
 * DATA, not copy — the page's own key, like the tag and text the picker's chip shows
 * (§17.6 has nothing to translate here). An index-only path (`$[0]`) has no name, and an
 * unparseable one has nothing to show, so both give an empty chip rather than an
 * invented word.
 *
 * @param {string} path @returns {string}
 */
export function fieldLabel(path) {
  const tokens = parsePath(path);
  if (!tokens || !tokens.length) return '';
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (tokens[i].type === 'key') return String(tokens[i].value);
  }
  return '';
}

/**
 * The text a guess highlight looks for: what the page is CURRENTLY rendering at that
 * field, which is the mocked value while a Change is in force and the captured one
 * otherwise (`effectiveBody.js`). Searching for the captured value under an active
 * Change looks for text the site stopped showing the moment the Change was applied —
 * the same defect README Deviation 32 records one layer up, in candidate discovery.
 *
 * Objects and arrays have no rendered text to find, and `null` renders as nothing at
 * all, so both give '' and the caller draws nothing rather than outlining every empty
 * element on the page.
 *
 * @param {any} value @returns {string}
 */
export function needleFor(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return '';
  const text = String(value).trim();
  // One character matches nearly every element on a page; that is not a highlight, it is
  // a flash of the whole document.
  return text.length >= 2 ? text : '';
}

/**
 * @param {{
 *   target: (payload:any) => Promise<{tabId:number|null, origin:string, info:any}>,
 *   capturedRecord: (tabId:number|null, sigId:string) => any,
 *   chrome?: any
 * }} deps
 */
export function createHighlightApi(deps) {
  const api = deps.chrome || globalThis.chrome;

  /**
   * What to draw.
   *
   * `verified` is the answer's claim and it describes WHAT WAS DRAWN, so it is true only
   * on the branch that draws a proved Link's own elements. A Binding that says `verified`
   * and holds no fingerprints falls through to the value guess — §7.6 records at least
   * the picked element, so an empty list means a stored Link from before that or one
   * damaged since — and it is reported as a guess, because a guess is what is on the
   * screen. Pairing "proved" with the dashed overlay would be §17.12's lie with the
   * evidence sitting next to it.
   */
  async function specFor(tabId, origin, sigId, path) {
    const binding = await findBinding(origin, sigId, path);
    const label = fieldLabel(path);

    // §10.2: "if a verified Binding exists for the path, highlight its elements; else run
    // soft-highlight". The elements are only trustworthy for a Binding a probe proved:
    // `elements[]` is written by §7.6's inverse discovery and by nothing else.
    if (binding && binding.state === 'verified' && Array.isArray(binding.elements) && binding.elements.length) {
      return { mode: 'proved', label, elements: binding.elements, verified: true };
    }

    const record = deps.capturedRecord(tabId, sigId);
    if (!record) return { mode: 'guess', label, needle: '', verified: false };
    const overlays = await overlaysFor(origin);
    const real = getByPath(record.body, path);
    const needle = needleFor(effectiveValue(overlays.get(sigId), path, real));
    return { mode: 'guess', label, needle, verified: false };
  }

  /**
   * @param {{type:string, payload?:any}} message
   * @returns {Promise<any>}
   */
  async function handle(message) {
    const payload = (message && message.payload) || {};
    if (message.type !== MSG.HIGHLIGHT) return undefined;

    const { tabId, origin } = await deps.target(payload);
    // No origin means Chrome could not tell the worker what this tab is — a tab id that
    // is not a tab, one that closed mid-call. MockLab cannot look at it, and "I drew
    // nothing" would be a claim about a page it never reached (§1.1).
    if (tabId === null || !origin) return { ok: false, reason: 'no-tab' };
    if (typeof payload.sigId !== 'string' || typeof payload.path !== 'string') {
      return { ok: false, reason: 'bad-request' };
    }

    const spec = await specFor(tabId, origin, payload.sigId, payload.path);

    // Nothing to look for. NOT an error and not a failure to draw: MockLab has no proved
    // elements and no value to find, so it says it drew nothing (§1.1) — the panel then
    // shows §11's `highlight.none` rather than a flash of nothing.
    if (spec.mode === 'guess' && !spec.needle) {
      return { ok: true, elements: 0, verified: spec.verified, resolved: 0, offscreen: 0, lowConfidence: 0 };
    }

    let drawn = null;
    try {
      const [frame] = await api.scripting.executeScript({
        target: { tabId },
        args: [
          CONTENT_GLOBALS.element,
          CONTENT_GLOBALS.highlightId,
          {
            mode: spec.mode,
            label: spec.label,
            elements: spec.elements || [],
            needle: spec.needle || '',
            css: OVERLAY_CSS,
            minConfidence: MIN_CONFIDENCE,
            dismissMs: DISMISS_MS,
            staggerMs: STAGGER_MS,
            max: MAX_GUESSES
          }
        ],
        func: drawHighlightsInPage
      });
      drawn = frame && frame.result;
    } catch (err) {
      // A tab MockLab cannot inject into — a chrome:// page, a tab opened before install,
      // a document that navigated mid-call. That is a fact about the PAGE, not a count of
      // elements, so it is never reported as one.
      console.error('[MockLab] highlight injection failed', err);
      return { ok: false, reason: 'no-content-script' };
    }
    if (!drawn || drawn.ok !== true) {
      return { ok: false, reason: (drawn && drawn.reason) || 'no-content-script' };
    }

    return {
      ok: true,
      verified: spec.verified,
      elements: drawn.drawn,
      resolved: drawn.resolved,
      offscreen: drawn.offscreen,
      lowConfidence: drawn.lowConfidence
    };
  }

  return { handle };
}

/**
 * Runs IN THE PAGE (ISOLATED world, via chrome.scripting), so it is serialized and has
 * no closure: every value it needs arrives as an argument, including the two names from
 * `CONTENT_GLOBALS` and the stylesheet above (§17.8 — the literals live in `messages.js`
 * and, for the colours, at the top of this file where §17.7 records them).
 *
 * EXPORTED for the same reason `wsOps.findTargetInPage` is: `guards.contract.test.js`
 * audits every call on a content-script contract against the methods that contract
 * really publishes, and it cannot see these — the receiver arrives as an argument and
 * this file never names the global. `highlight.test.js` repeats that audit over this
 * function's source, and `highlight.browser.test.js` runs the whole thing against a real
 * page, where a renamed method throws instead of returning undefined.
 *
 * @param {string} globalName  the element contract's name on the isolated global
 * @param {string} hostId      the overlay host's element id
 * @param {Object} spec        what to draw (see the caller above)
 * @returns {{ok:boolean, drawn?:number, resolved?:number, offscreen?:number, lowConfidence?:number, reason?:string}}
 */
export function drawHighlightsInPage(globalName, hostId, spec) {
  try {
    var api = globalThis[globalName];
    if (!api) return { ok: false, reason: 'no-content-script' };
    if (!document.body) return { ok: false, reason: 'no-content-script' };

    /* ── which elements ─────────────────────────────────────────────────────── */

    var targets = [];
    var resolved = 0;
    var lowConfidence = 0;

    if (spec.mode === 'proved') {
      for (var i = 0; i < spec.elements.length; i += 1) {
        var found = api.resolveFingerprint(spec.elements[i]);
        if (!found || !found.element) continue;
        resolved += 1;
        // See the header: below §6.2's 0.8 this is "whatever is in that position now".
        if (found.confidence < spec.minConfidence) { lowConfidence += 1; continue; }
        if (targets.indexOf(found.element) === -1) targets.push(found.element);
      }
    } else {
      var wanted = api.normText(spec.needle).toLowerCase();
      var hits = [];
      var all = document.body.querySelectorAll('*');
      for (var j = 0; j < all.length && hits.length < spec.max * 20; j += 1) {
        // textContent first: innerText forces layout, so it only confirms a shortlist.
        // The same two-step element.js uses, for the same reason.
        if (api.normText(all[j].textContent).toLowerCase().indexOf(wanted) === -1) continue;
        if (api.normText(api.textOf(all[j])).toLowerCase().indexOf(wanted) === -1) continue;
        hits.push(all[j]);
      }
      // Every ancestor of a hit is a hit. What a person means by "where is this on the
      // page" is the innermost one, so anything containing another hit is dropped —
      // otherwise the first overlay is always <body>.
      //
      // Then §6.1's smart walk, for the same reason `wsOps.findTargetInPage` applies it:
      // the picker outlines the semantic pill and not the <span> inside it, and a
      // highlight that framed a different element from the one a click selects would make
      // "where is this on the page" and "what did I pick" two different answers.
      for (var k = 0; k < hits.length && targets.length < spec.max; k += 1) {
        var inner = false;
        for (var m = 0; m < hits.length; m += 1) {
          if (m !== k && hits[k].contains(hits[m])) { inner = true; break; }
        }
        if (inner) continue;
        var semantic = api.smartTarget(hits[k]);
        if (targets.indexOf(semantic) === -1) targets.push(semantic);
      }
      resolved = targets.length;
    }

    /* ── the overlay host ───────────────────────────────────────────────────── */

    // A previous highlight is replaced, never stacked: two answers about the same page
    // on screen at once is two claims, one of which is out of date.
    var old = document.getElementById(hostId);
    if (old && old.parentNode) old.parentNode.removeChild(old);
    if (!targets.length) {
      return { ok: true, drawn: 0, resolved: resolved, offscreen: 0, lowConfidence: lowConfidence };
    }

    var host = document.createElement('div');
    host.id = hostId;
    host.setAttribute('data-mocklab', '');
    var fixed = {
      position: 'fixed', top: '0', left: '0', width: '0', height: '0',
      margin: '0', padding: '0', border: '0', background: 'none',
      'pointer-events': 'none', 'z-index': '2147483646'
    };
    for (var prop in fixed) host.style.setProperty(prop, fixed[prop], 'important');

    // A shadow root for the same reason picker.js uses one: a single
    // `div{border:0!important}` on the host page would otherwise erase MockLab's own UI
    // and the highlight would silently show nothing while reporting a count.
    var root = host;
    try { root = host.attachShadow({ mode: 'open' }); } catch (err) { /* plain div */ }
    var style = document.createElement('style');
    style.textContent = spec.css;
    root.appendChild(style);
    document.documentElement.appendChild(host);   // §6.1/§10.3: <html>, never <body>

    /* ── draw ───────────────────────────────────────────────────────────────── */

    var viewportHeight = window.innerHeight || 0;
    var viewportWidth = window.innerWidth || 0;
    var drawn = 0;
    var offscreen = 0;

    for (var n = 0; n < targets.length; n += 1) {
      var rect = targets[n].getBoundingClientRect();
      // A zero-sized box is not something a person can be shown. Counted as resolved
      // (it IS the element) and not as drawn, because nothing appears.
      if (rect.width <= 0 || rect.height <= 0) continue;
      var box = document.createElement('div');
      box.className = 'box ' + (spec.mode === 'proved' ? 'proved' : 'guess');
      box.style.left = rect.left + 'px';
      box.style.top = rect.top + 'px';
      box.style.width = rect.width + 'px';
      box.style.height = rect.height + 'px';
      if (rect.top < 28) box.className += ' low';
      if (spec.label) {
        var chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = spec.label;
        box.appendChild(chip);
      }
      root.appendChild(box);
      drawn += 1;
      if (rect.bottom < 0 || rect.top > viewportHeight || rect.right < 0 || rect.left > viewportWidth) {
        offscreen += 1;
      }
      // §10.3's stagger. `setTimeout` and not a CSS delay so the pop is per-box even
      // when the same box is redrawn by a second call.
      (function (node, delay) {
        setTimeout(function () { node.classList.add('on'); }, delay);
      })(box, n * spec.staggerMs);
    }

    /* ── and away ───────────────────────────────────────────────────────────── */

    var gone = false;
    function dismiss() {
      if (gone) return;
      gone = true;
      try { window.removeEventListener('scroll', dismiss, true); } catch (err) { /* ignore */ }
      try { window.removeEventListener('click', dismiss, true); } catch (err) { /* ignore */ }
      try { if (host.parentNode) host.parentNode.removeChild(host); } catch (err) { /* ignore */ }
    }
    // §10.3: 4 seconds, or the moment the person moves the page under them — a fixed box
    // over a scrolled document points at the wrong place.
    setTimeout(dismiss, spec.dismissMs + targets.length * spec.staggerMs);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('click', dismiss, true);

    return { ok: true, drawn: drawn, resolved: resolved, offscreen: offscreen, lowConfidence: lowConfidence };
  } catch (err) {
    // §17.2's rule for anything MockLab runs inside a page: never break the host page.
    return { ok: false, reason: 'error' };
  }
}
