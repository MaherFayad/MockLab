/**
 * ISOLATED-world pick mode: the crosshair, the hover overlay, the confirm flash
 * (PLAN.md §6.1).
 *
 * OWNER: probe-engineer.
 *
 * Split out of `agent.js` at M3 under §17.10. Unlike `interceptor.js` (README
 * Deviations 11), an ISOLATED-world content script CAN be split safely: the files share
 * the EXTENSION's isolated global, not the page's, so nothing here is reachable from
 * site script. `agent.js` owns the Port. `element.js` owns the questions asked ABOUT an
 * element — §6.2's fingerprint, §7.3's snapshot, §6.1's smart target — which the M4
 * probe asks with no picker running; this file owns the interaction. The contract out
 * of here is `globalThis.__mocklabPicker`:
 *   start(onResult)  enter pick mode; onResult gets {ok:true, fingerprint, snapshot}
 *                    on a click, or {ok:false, reason:"cancelled"} on Escape
 *   cancel()         leave pick mode silently (the panel already knows)
 * §17.2 applies to every line: no imports, every entry point in a try/catch, and any
 * failure leaves the page exactly as it was found. A picker that throws on a site's own
 * CSS breaks that site for the user, which is worse than not picking at all.
 */
(function () {
  'use strict';

  /**
   * §17.7 says never hardcode a colour outside `panel.css`'s `:root`. A content script
   * cannot reach that stylesheet: importing it is impossible, and injecting it would
   * expose it to every page AND drop the panel's `:root` variables onto the host
   * document, changing the site's own colours. So §9.1's accent pair is copied here,
   * verbatim, in one place — as `badge.js` already does (README Deviations 21). §6.1
   * states these two values itself.
   */
  var ACCENT_LIGHT = '#0066FF';   // §9.1 --accent, light
  var ACCENT_DARK = '#4A90FF';    // §9.1 --accent, dark
  var ACCENT_FILL = 'rgba(0,102,255,.08)';  // §6.1, verbatim
  var CHIP_TEXT = '#FFFFFF';      // §9.1 --text-oninverse on the accent chip

  /** CONTENT_GLOBALS.overlayId in messages.js — a browser suite reads this id too. */
  var OVERLAY_ID = '__mocklab_overlay__';   // §6.1 / §10.3 — the one overlay container
  var MOCKLAB_ATTR = 'data-mocklab';

  /**
   * `element.js`, looked up at call time rather than captured at load: the manifest
   * lists it first, but a lookup that can fail loudly beats a binding that silently
   * captured `undefined` if that order ever changes.
   */
  function el() {
    try { return globalThis.__mocklabElement || null; } catch (err) { return null; }
  }
  var textOf = function (node) { var api = el(); return api ? api.textOf(node) : ''; };
  var normText = function (value) { var api = el(); return api ? api.normText(value) : ''; };

  var picking = false;
  /** Set by `start()`; the only channel out of this file. */
  var pickResult = null;
  var cursorStyle = null;
  var overlay = null;             // { host, box, chip }
  var removeTimer = 0;            // the confirm animation's pending teardown
  var hovered = null;
  var pendingFrame = 0;
  var lastPoint = null;

  /* ── overlay (§6.1) ────────────────────────────────────────────────────────── */

  /**
   * The overlay lives in a shadow root inside `#__mocklab_overlay__`. §6.1 fixes the
   * container, the position, the z-index and `pointer-events:none`; the shadow root is
   * additive and defensive — without it a single `div{border:0!important}` on the host
   * page erases MockLab's own UI, and the picker would silently show nothing.
   */
  function ensureOverlay() {
    // A pick that starts while the previous confirm flash is still playing must not
    // have its overlay removed 400 ms later by that flash's timer.
    if (removeTimer) { clearTimeout(removeTimer); removeTimer = 0; }
    if (overlay && overlay.host.isConnected) return overlay;
    var host = document.createElement('div');
    host.id = OVERLAY_ID;
    host.setAttribute(MOCKLAB_ATTR, '');
    var fixed = {
      position: 'fixed', top: '0', left: '0', width: '0', height: '0',
      margin: '0', padding: '0', border: '0', background: 'none',
      'pointer-events': 'none', 'z-index': '2147483646'
    };
    for (var prop in fixed) host.style.setProperty(prop, fixed[prop], 'important');

    var root = host;
    try { root = host.attachShadow({ mode: 'open' }); } catch (err) { /* plain div */ }
    var style = document.createElement('style');
    style.textContent =
      '.box{position:absolute;box-sizing:border-box;border-radius:10px;' +
      'border:2px solid ' + ACCENT_LIGHT + ';background:' + ACCENT_FILL + ';' +
      'pointer-events:none;opacity:0;transform-origin:center;' +
      'transition:all 250ms cubic-bezier(0.4,0,0.2,1)}' +
      '.box.on{opacity:1}' +
      '.box.confirm{animation:mocklab-confirm 350ms cubic-bezier(0.34,1.56,0.64,1)}' +
      '@keyframes mocklab-confirm{0%{transform:scale(1)}50%{transform:scale(1.06)}' +
      '100%{transform:scale(1)}}' +
      '.chip{position:absolute;bottom:calc(100% + 6px);left:0;max-width:22rem;' +
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
      'background:' + ACCENT_LIGHT + ';color:' + CHIP_TEXT + ';border-radius:0.375rem;' +
      'padding:2px 8px;font:600 0.75rem/1.5 Inter,-apple-system,system-ui,sans-serif}' +
      '.box.low .chip{bottom:auto;top:calc(100% + 6px)}' +
      '@media (prefers-color-scheme:dark){.box{border-color:' + ACCENT_DARK + '}' +
      '.chip{background:' + ACCENT_DARK + '}}' +
      '@media (prefers-reduced-motion:reduce){.box{transition:none}' +
      '.box.confirm{animation:none}}';
    var box = document.createElement('div');
    box.className = 'box';
    var chip = document.createElement('span');
    chip.className = 'chip';
    box.appendChild(chip);
    root.appendChild(style);
    root.appendChild(box);
    document.documentElement.appendChild(host);   // §6.1: <html>, never <body>
    overlay = { host: host, box: box, chip: chip };
    return overlay;
  }

  function removeOverlay() {
    if (removeTimer) { clearTimeout(removeTimer); removeTimer = 0; }
    try { if (overlay && overlay.host.parentNode) overlay.host.parentNode.removeChild(overlay.host); }
    catch (err) { /* ignore */ }
    overlay = null;
  }

  /** Draw the hover outline around `el`, with the label chip §6.1 describes. */
  function drawOverlay(el) {
    var ui = ensureOverlay();
    var r = el.getBoundingClientRect();
    ui.box.style.left = r.left + 'px';
    ui.box.style.top = r.top + 'px';
    ui.box.style.width = r.width + 'px';
    ui.box.style.height = r.height + 'px';
    ui.box.classList.add('on');
    ui.box.classList.toggle('low', r.top < 28);
    var text = normText(textOf(el)).slice(0, 40);
    // Data, not copy: the element's own tag and text. §17.6 has nothing to translate.
    ui.chip.textContent = el.tagName.toLowerCase() + (text ? ' “' + text + '”' : '');
  }

  function hideOverlay() {
    if (overlay) overlay.box.classList.remove('on');
    hovered = null;
  }

  function targetAt(x, y) {
    var raw = null;
    try { raw = document.elementFromPoint(x, y); } catch (err) { return null; }
    if (!raw || raw === document.documentElement || raw === document.body) return null;
    if (raw.id === OVERLAY_ID || raw.closest('#' + OVERLAY_ID)) return null;
    var api = el();
    return api ? api.smartTarget(raw) : raw;
  }

  /* ── pick mode (§6.1) ──────────────────────────────────────────────────────── */

  function onMouseMove(event) {
    lastPoint = { x: event.clientX, y: event.clientY };
    if (pendingFrame) return;
    pendingFrame = requestAnimationFrame(function () {
      pendingFrame = 0;
      repaint();
    });
  }

  function repaint() {
    if (!picking || !lastPoint) return;
    var target = targetAt(lastPoint.x, lastPoint.y);
    if (!target) { hideOverlay(); return; }
    hovered = target;
    drawOverlay(target);
  }

  /**
   * Swallow the whole press, not just the click: a site that acts on `mousedown` would
   * otherwise navigate away underneath the picker. Every listener here is
   * `{capture:true}` and every one is removed in `exitPickMode`.
   */
  function swallow(event) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
  }

  function onPress(event) {
    if (!picking) return;
    swallow(event);
  }

  function onClick(event) {
    if (!picking) return;
    swallow(event);
    var target = targetAt(event.clientX, event.clientY) || hovered;
    if (!target) { exitPickMode(true); return; }

    // Read the element BEFORE anything is torn down, so what is sent is what the user
    // clicked on the page they were looking at.
    var api = el();
    if (!api) { exitPickMode(true); return; }
    var payload = { ok: true, fingerprint: api.fingerprint(target), snapshot: api.snapshotElement(target) };

    var ui = overlay;
    if (ui) {
      drawOverlay(target);
      ui.box.classList.add('confirm');
      removeTimer = setTimeout(removeOverlay, 400);
    }
    exitPickMode(false, true);
    deliver(payload);
  }

  function onKeyDown(event) {
    if (!picking) return;
    if (event.key !== 'Escape' && event.keyCode !== 27) return;
    swallow(event);
    exitPickMode(true);
  }

  function onScroll() {
    if (!picking || !hovered) return;
    if (!hovered.isConnected) { hideOverlay(); return; }
    drawOverlay(hovered);
  }

  var PRESS_EVENTS = ['pointerdown', 'mousedown', 'mouseup', 'contextmenu'];

  function enterPickMode() {
    if (picking) return;
    picking = true;
    try {
      cursorStyle = document.createElement('style');
      cursorStyle.setAttribute(MOCKLAB_ATTR, '');
      cursorStyle.textContent = 'html,html *{cursor:crosshair!important}';
      (document.head || document.documentElement).appendChild(cursorStyle);
      ensureOverlay();
      window.addEventListener('mousemove', onMouseMove, true);
      window.addEventListener('click', onClick, true);
      window.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', onScroll, true);
      PRESS_EVENTS.forEach(function (name) { window.addEventListener(name, onPress, true); });
    } catch (err) {
      // Never leave the page half-way into pick mode.
      exitPickMode(true);
    }
  }

  /**
   * @param {boolean} report   tell the worker the pick ended without a selection
   * @param {boolean} [keepOverlay] the confirm animation is still playing
   */
  function exitPickMode(report, keepOverlay) {
    if (!picking) {
      if (report) deliver({ ok: false, reason: 'cancelled' });
      return;
    }
    picking = false;
    hovered = null;
    lastPoint = null;
    if (pendingFrame) { cancelAnimationFrame(pendingFrame); pendingFrame = 0; }
    try {
      window.removeEventListener('mousemove', onMouseMove, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll, true);
      PRESS_EVENTS.forEach(function (name) { window.removeEventListener(name, onPress, true); });
    } catch (err) { /* ignore */ }
    try { if (cursorStyle && cursorStyle.parentNode) cursorStyle.parentNode.removeChild(cursorStyle); }
    catch (err) { /* ignore */ }
    cursorStyle = null;
    if (!keepOverlay) removeOverlay();
    if (report) deliver({ ok: false, reason: 'cancelled' });
  }

  /** One result per pick: the callback is cleared as it fires. */
  function deliver(result) {
    var callback = pickResult;
    pickResult = null;
    if (!callback) return;
    try { callback(result); } catch (err) { /* the relay is gone; nothing to do */ }
  }

  /**
   * The one export. On the extension's ISOLATED-world global — NOT on the page's
   * `window`, which a site can read and rewrite.
   */
  try {
    globalThis.__mocklabPicker = {   // CONTENT_GLOBALS.picker in messages.js
      start: function (onResult) {
        pickResult = typeof onResult === 'function' ? onResult : null;
        enterPickMode();
      },
      cancel: function () { exitPickMode(false); }
    };
  } catch (err) { /* ignore */ }
})();
