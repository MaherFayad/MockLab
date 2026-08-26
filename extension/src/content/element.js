/**
 * Reading one element: fingerprints (PLAN.md §6.2), snapshots (§7.3) and §6.1's smart
 * target selection.
 *
 * OWNER: probe-engineer.
 *
 * The third ISOLATED-world content script: the manifest's one ISOLATED entry lists
 * `agent.js`, this file, then `picker.js`. §17.10 is why, and the seam is real —
 * `picker.js` is the INTERACTION (overlay, cursor, listeners), this is the pure QUESTION
 * about an element that the M4 probe asks with no picker running. No test holds that
 * line: the two browser suites split on whether an extension is loaded, not on this.
 *
 * ISOLATED-world scripts of one extension share a global the page cannot reach, so the
 * contract is `globalThis.__mocklabElement`:
 *   smartTarget(el)          §6.1's walk up to the semantic element
 *   fingerprint(el)          §6.2, create
 *   resolveFingerprint(fp)   §6.2, re-resolve -> {element, confidence}
 *   snapshotElement(el)      §7.3
 *   textOf / normText / areaOf   the three measurements the above share
 *
 * §17.2 applies to every line: no imports, every entry point in a try/catch, and any
 * failure leaves the page exactly as it was found.
 */
(function () {
  'use strict';

  var AUTO_ID = /\d{3,}|^:|^ember|^radix|^react/;   // §6.2's rejected id shapes
  var SMART_WALK_LIMIT = 4;       // §6.1
  var SMART_AREA_RATIO = 1.4;     // §6.1
  var SMART_INSET_PX = 24;        // the additive half of the rule — see smartTarget

  /** innerText where the element has it (SVG and friends do not), else textContent. */
  function textOf(el) {
    try {
      var raw = typeof el.innerText === 'string' ? el.innerText : el.textContent;
      return String(raw || '').trim();
    } catch (err) { return ''; }
  }

  function normText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function areaOf(el) {
    try {
      var r = el.getBoundingClientRect();
      return Math.max(0, r.width) * Math.max(0, r.height);
    } catch (err) { return 0; }
  }

  /* ── smart target selection (§6.1) ─────────────────────────────────────────── */

  /**
   * Is the parent's border box within `SMART_INSET_PX` of the child's on EVERY side?
   * A negative inset (the parent smaller than the child) counts as within.
   */
  function withinInset(child, parent) {
    try {
      var c = child.getBoundingClientRect();
      var p = parent.getBoundingClientRect();
      return (
        c.left - p.left <= SMART_INSET_PX &&
        p.right - c.right <= SMART_INSET_PX &&
        c.top - p.top <= SMART_INSET_PX &&
        p.bottom - c.bottom <= SMART_INSET_PX
      );
    } catch (err) { return false; }
  }

  /**
   * Walk up while the parent shows the SAME trimmed text and is not much bigger than
   * the node below it — this lands on the semantic pill instead of the `<span>` inside
   * it. Capped at 4 levels, so the total growth is bounded even in a chain of
   * single-child wrappers.
   *
   * "Not much bigger" is §6.1's ≤ 1.4× area ratio OR a border box within 24 px on every
   * side. The second half is ADDITIVE: it never rejects anything the ratio accepts.
   *
   * An area ratio is the wrong metric here. A pill's padding is roughly constant
   * whatever the text says, so the ratio it produces depends on the text's LENGTH and is
   * harshest on the short text this rule exists for. Measured in Chromium, the demo's
   * pill padding (`0.3125rem 0.875rem` = 5px 14px at 12px text) puts a pill at 2.71× a
   * wrapped inner span — so under the ratio alone §6.1 could not meet the purpose §6.1
   * states for it ("picks the semantic pill instead of an inner <span>"). That 2.71× is
   * SYNTHETIC and labelled as such: the demo's real pill is filled with `textContent`,
   * so it has no inner span for the walk to climb out of at all. It stands in for the
   * padded pills of real component libraries, none of which pass 1.4× either.
   *
   * The inset test is length-independent and is in the units a designer uses. README
   * Deviation 30 carries the measurement table; `pickerdom.browser.test.js` asserts both
   * halves, each where only it can fire, and takes the demo's padding off disk so this
   * paragraph cannot drift from it silently.
   */
  function smartTarget(el) {
    var node = el;
    var text = textOf(el);
    // A long text belongs to a container, not to a value; walking up from one only
    // ever selects a bigger container.
    if (text.length > 300) return el;
    for (var i = 0; i < SMART_WALK_LIMIT; i += 1) {
      var parent = node.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      if (textOf(parent) !== text) break;
      var childArea = areaOf(node);
      var ratioOk = childArea === 0 || areaOf(parent) <= childArea * SMART_AREA_RATIO;
      if (!ratioOk && !withinInset(node, parent)) break;
      node = parent;
    }
    return node;
  }

  /* ── fingerprint (§6.2) ────────────────────────────────────────────────────── */

  function cssEscape(value) {
    try {
      if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    } catch (err) { /* fall through */ }
    return String(value).replace(/([^\w-])/g, '\\$1');
  }

  function attrSelector(name, value) {
    return '[' + name + '="' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]';
  }

  function isUnique(selector, el) {
    try {
      var found = document.querySelectorAll(selector);
      return found.length === 1 && found[0] === el;
    } catch (err) { return false; }
  }

  /** `body > :nth-child(2) > :nth-child(1)…` — §6.2's last resort. */
  function structuralPath(el) {
    var steps = [];
    var node = el;
    while (node && node !== document.body && node.parentElement) {
      var index = Array.prototype.indexOf.call(node.parentElement.children, node);
      steps.unshift(':nth-child(' + (index + 1) + ')');
      node = node.parentElement;
    }
    return ['body'].concat(steps).join(' > ');
  }

  function treePathOf(el) {
    var out = [];
    var node = el;
    while (node && node !== document.body && node.parentElement) {
      out.unshift(Array.prototype.indexOf.call(node.parentElement.children, node));
      node = node.parentElement;
    }
    return out;
  }

  /** §6.2's preference order, each candidate accepted only if it is actually unique. */
  function selectorFor(el) {
    var tag = el.tagName.toLowerCase();
    var tries = [];
    ['data-testid', 'data-test', 'data-qa'].forEach(function (name) {
      var value = el.getAttribute(name);
      if (value) tries.push(attrSelector(name, value));
    });
    if (el.id && !AUTO_ID.test(el.id)) tries.push('#' + cssEscape(el.id));
    var aria = el.getAttribute('aria-label');
    if (aria) tries.push(tag + attrSelector('aria-label', aria));
    var classes = classListOf(el);
    if (classes.length) tries.push(tag + '.' + classes.map(cssEscape).join('.'));
    for (var i = 0; i < tries.length; i += 1) {
      if (isUnique(tries[i], el)) return tries[i];
    }
    return structuralPath(el);
  }

  function classListOf(el) {
    try {
      return Array.prototype.slice.call(el.classList).filter(Boolean).sort();
    } catch (err) { return []; }
  }

  /** @returns {{css:string, textAnchor:string, attrAnchors:string[], treePath:number[]}} */
  function fingerprint(el) {
    var anchors = [];
    ['data-testid', 'data-test', 'data-qa', 'aria-label', 'id'].forEach(function (name) {
      var value = el.getAttribute(name);
      if (value) anchors.push(name + '=' + value);
    });
    return {
      css: selectorFor(el),
      textAnchor: textOf(el).slice(0, 80),
      attrAnchors: anchors,
      treePath: treePathOf(el)
    };
  }

  /**
   * Ceiling on the text-anchor scan in `resolveFingerprint`. Reading `textContent` off
   * every element costs work proportional to the subtree below each one, so an
   * unbounded scan of a very large document is slow enough to be felt. Past this point
   * MockLab falls through to the tree path at confidence 0.5 — a weaker answer, which
   * is the honest one, rather than a frozen page.
   */
  var MAX_ANCHOR_SCAN = 20000;

  function commonPrefix(a, b) {
    var n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
    return n;
  }

  /**
   * §6.2's re-resolution, used after every probe reload (M4). Confidence is the honest
   * part: below 0.8 a probe must abort with `element-lost` rather than diff whatever
   * happens to be at that position now.
   *
   * @returns {{element:Element|null, confidence:number}}
   */
  function resolveFingerprint(fp) {
    if (!fp) return { element: null, confidence: 0 };
    try {
      var found = document.querySelectorAll(fp.css);
      if (found.length === 1) return { element: found[0], confidence: 1 };
    } catch (err) { /* the page may have moved on; fall through */ }

    var anchor = normText(fp.textAnchor);
    var tree = Array.isArray(fp.treePath) ? fp.treePath : [];
    if (anchor && document.body) {
      var best = null;
      var bestScore = -1;
      var all = document.body.querySelectorAll('*');
      var limit = Math.min(all.length, MAX_ANCHOR_SCAN);
      for (var i = 0; i < limit; i += 1) {
        // textContent is cheap; innerText forces layout, so it only confirms a
        // shortlist. On a 5000-element page the naive form costs seconds.
        if (normText(all[i].textContent) !== anchor) continue;
        if (normText(textOf(all[i])) !== anchor) continue;
        var score = commonPrefix(treePathOf(all[i]), tree);
        if (score > bestScore) { bestScore = score; best = all[i]; }
      }
      if (best) return { element: best, confidence: 0.8 };
    }

    var node = document.body;
    for (var j = 0; node && j < tree.length; j += 1) node = node.children[tree[j]];
    if (node && node !== document.body) return { element: node, confidence: 0.5 };
    return { element: null, confidence: 0 };
  }

  /* ── element snapshot (§7.3) ───────────────────────────────────────────────── */

  var SNAPSHOT_STYLE = ['color', 'backgroundColor', 'borderColor', 'display', 'visibility', 'opacity'];

  /**
   * §7.3's snapshot of one element. `tag` is additive — the panel's picked-element card
   * and the label chip both need it, and an element's tag cannot change under it, so it
   * costs the M4 diff nothing.
   */
  function snapshotElement(el) {
    var attrs = {};
    try {
      for (var i = 0; i < el.attributes.length; i += 1) {
        var attribute = el.attributes[i];
        if (attribute.name === 'style' || attribute.name === 'class') continue;
        attrs[attribute.name] = attribute.value;
      }
    } catch (err) { /* ignore */ }

    var style = {};
    try {
      var computed = window.getComputedStyle(el);
      SNAPSHOT_STYLE.forEach(function (prop) { style[prop] = String(computed[prop] || ''); });
    } catch (err) { /* ignore */ }

    var childTexts = [];
    try {
      for (var c = 0; c < el.children.length && c < 5; c += 1) {
        childTexts.push(normText(textOf(el.children[c])).slice(0, 30));
      }
    } catch (err) { /* ignore */ }

    return {
      tag: el.tagName.toLowerCase(),
      text: textOf(el).slice(0, 300),
      attrs: attrs,
      cls: classListOf(el),
      style: style,
      childCount: el.children ? el.children.length : 0,
      childTexts: childTexts
    };
  }

  try {
    globalThis.__mocklabElement = {   // CONTENT_GLOBALS.element in messages.js
      smartTarget: smartTarget,
      fingerprint: fingerprint,
      resolveFingerprint: resolveFingerprint,
      snapshotElement: snapshotElement,
      textOf: textOf,
      normText: normText,
      areaOf: areaOf
    };
  } catch (err) { /* ignore */ }
})();
