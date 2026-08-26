/**
 * Element + icon helpers for the side panel.
 *
 * OWNER: panel-designer. Split out of panel.js to keep every panel file under the
 * ~500-line ceiling PLAN.md §17.10 sets. No framework, no build step: this is a
 * 40-line `createElement` wrapper and a sheet of inline SVG.
 *
 * There is NOT one user-visible string in this file — §17.6 keeps all of those in
 * strings.js — and not one colour, because every icon paints with `currentColor`
 * (§17.7 keeps colour in panel.css).
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @param {string} tag
 * @param {Object} [props]  className / text / html-free attributes / on* handlers
 * @param {...(Node|string|null|undefined|false)} children
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node && key !== 'list' && typeof value !== 'object') node[key] = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/** Remove every child of a node. */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Stroke-only 24×24 icon. `d` may be one path or several. */
export function svgIcon(d, size = 16) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const spec of Array.isArray(d) ? d : [d]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', spec);
    svg.append(path);
  }
  return svg;
}

/** Icon sheet. Names are internal, never shown to a human. */
export const ICON = {
  // crosshair — Pick
  pick: () => svgIcon(['M12 2.5v4.2', 'M12 17.3v4.2', 'M2.5 12h4.2', 'M17.3 12h4.2', 'M12 19.4a7.4 7.4 0 1 0 0-14.8 7.4 7.4 0 0 0 0 14.8z', 'M12 13.1a1.1 1.1 0 1 0 0-2.2 1.1 1.1 0 0 0 0 2.2z'], 18),
  // stacked list — Sources
  sources: () => svgIcon(['M4 6.5h16', 'M4 12h16', 'M4 17.5h10'], 18),
  // clapperboard — Scenarios
  scenarios: () => svgIcon(['M3 9h18v10.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19.5z', 'M3 9V6.4a1 1 0 0 1 .8-1l15.4-2.9a1 1 0 0 1 1.2.8L21 9z', 'M8.6 3.5 7.2 8.7', 'M14 2.5 12.6 7.9'], 18),
  // gear — Settings
  settings: () => svgIcon(['M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z', 'M19.2 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7.3 7.3 0 0 0-2-1.2L14.4 3H9.6l-.4 2.6a7.3 7.3 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-.9a7.3 7.3 0 0 0 2 1.2l.4 2.6h4.8l.4-2.6a7.3 7.3 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.07-.4.1-.8.1-1.2z'], 18),
  pencil: () => svgIcon(['M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z', 'M13.5 6.5l4 4'], 15),
  target: () => svgIcon(['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z'], 15),
  trash: () => svgIcon(['M4.5 6.5h15', 'M9.5 6.5V4.8c0-.7.6-1.3 1.3-1.3h2.4c.7 0 1.3.6 1.3 1.3v1.7', 'M6.5 6.5 7.4 20a1.5 1.5 0 0 0 1.5 1.4h6.2A1.5 1.5 0 0 0 16.6 20l.9-13.5'], 15),
  caret: () => svgIcon('M9.5 6 15.5 12l-6 6', 13),
  chevron: () => svgIcon('M9.5 6 15.5 12l-6 6', 16),
  arrow: () => svgIcon(['M4 12h15', 'M13.5 6.5 19.5 12l-6 5.5'], 13),
  search: () => svgIcon(['M10.8 18.1a7.3 7.3 0 1 0 0-14.6 7.3 7.3 0 0 0 0 14.6z', 'M16.2 16.2 21 21'], 15),
  back: () => svgIcon(['M20 12H5', 'M10.5 6.5 4.5 12l6 5.5'], 16),
  check: () => svgIcon('M5 12.5 10 17.5 19 7', 15),
  globe: () => svgIcon(['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M3.4 9.5h17.2', 'M3.4 14.5h17.2', 'M12 3c-4.5 5.2-4.5 12.8 0 18 4.5-5.2 4.5-12.8 0-18z'], 14),
  warn: () => svgIcon(['M12 3.8 21 19.5H3z', 'M12 10v4.2', 'M12 17.1h.01'], 15),
  // horizontal ellipsis — §10.4's ⋯ menu. Three dots as three zero-length round-capped
  // strokes, so they scale with the icon set's own stroke width instead of being circles
  // that need their own radius.
  more: () => svgIcon(['M6 12h.01', 'M12 12h.01', 'M18 12h.01'], 16)
};

/**
 * The DGA radial-gradient spinner (PLAN.md §9.2). Its two stops are painted from
 * panel.css (`.spinner .s-from` / `.s-to`) so no colour lives here.
 *
 * ── Rebuilt at M4, because the first version could not spin ─────────────────────
 * It was a disc filled with a radial gradient CENTRED ON ITSELF (cx .5, cy .5), with a
 * smaller disc of `currentColor` laid over the middle to fake a hole. Two consequences,
 * both invisible to every test and obvious the moment the thing is looked at:
 *
 *   1. a gradient centred on the shape it fills is radially SYMMETRIC, so rotating it
 *      changes nothing. `animation: spin 1s linear infinite` ran, painted the identical
 *      frame 60 times a second, and the "loader" sat perfectly still;
 *   2. the fake hole was `currentColor` — the colour of the TEXT around it, not of the
 *      surface behind it. In the §10.2 tree that drew a solid dark dot on white; inside
 *      a primary button, where the text is also white, the whole thing collapsed into a
 *      soft white blob.
 *
 * §16 M4 is where that stops being cosmetic: §10.1's progress card is on screen for
 * eight page reloads and its instruction is "NEVER let the user think it's stuck". A
 * motionless loader is precisely that lie.
 *
 * The fix keeps §9.2's radial gradient and moves its CENTRE to the top of the ring
 * (cx .5, cy 0), so opacity varies AROUND the circumference — transparent at the head,
 * solid at the tail, the comet shape every spinner is. And the ring is a STROKE, not a
 * disc with a patch over it, so the surface behind shows through on any background.
 *
 * @param {string} id  unique gradient id — SVG gradients are document-scoped
 */
export function spinner(id) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'spinner');
  svg.setAttribute('aria-hidden', 'true');
  const defs = document.createElementNS(SVG_NS, 'defs');
  const grad = document.createElementNS(SVG_NS, 'radialGradient');
  grad.setAttribute('id', id);
  // Centred on the TOP of the ring's box, radius 1 box-width: the far side of the ring
  // lands on the last stop and the near side on the first. This asymmetry IS the motion.
  grad.setAttribute('cx', '0.5');
  grad.setAttribute('cy', '0');
  grad.setAttribute('r', '1');
  for (const [offset, cls] of [['0.35', 's-from'], ['1', 's-to']]) {
    const stop = document.createElementNS(SVG_NS, 'stop');
    stop.setAttribute('offset', offset);
    stop.setAttribute('class', cls);
    grad.append(stop);
  }
  defs.append(grad);
  const ring = document.createElementNS(SVG_NS, 'circle');
  ring.setAttribute('cx', '12');
  ring.setAttribute('cy', '12');
  ring.setAttribute('r', '7.5');
  ring.setAttribute('fill', 'none');
  ring.setAttribute('stroke', `url(#${id})`);
  ring.setAttribute('stroke-width', '3');
  svg.append(defs, ring);
  return svg;
}

/** Tooltip ids are document-scoped, like the spinner's gradient ids above. */
let tipSeq = 0;

/**
 * Wrap a control in the §9.2 tooltip. `lines[0]` is the label, `lines[1]` the dimmed
 * secondary line. Both come from strings.js — never from here.
 *
 * `end` anchors the bubble to the control's inline END instead of centring it on the
 * control. A centred 14rem bubble on a control near the edge of a 320px panel hangs off
 * it; the panel is too narrow for the bubble to be centred everywhere.
 *
 * ── Two things this does that a `<span class="tip">` around a control cannot ────────
 *
 * 1. `aria-describedby`. The bubble was already `role="tooltip"` and nothing pointed at
 *    it, which makes it a labelled box no assistive technology has any reason to read:
 *    the role says what the node IS, the association is what makes it get announced. It
 *    is the description and not the name on purpose — the control keeps its own label
 *    (`S.sources.showOnPage`, the tab's `.sr-only` word), and the tooltip qualifies it.
 *
 * 2. A control handed here `disabled` is converted to `aria-disabled`. This is the fix
 *    for a defect that outlived three milestones: `disabled` removes an element from the
 *    focus order AND stops it dispatching pointer events, so `.tip:hover` needed the
 *    child's `pointer-events` turned off and `.tip:focus-within` could never fire at all.
 *    The result was three controls — Deep mode, "Set up AI access", "Show on page" — whose
 *    only statement of why they do nothing was reachable with a mouse and by nothing else.
 *    Two of those now carry visible help instead (§10.5); the third cannot, because it is
 *    a per-row icon button in a dense tree with nowhere to put a paragraph. So the
 *    TOOLTIP is made to work for it: `aria-disabled` keeps the control focusable and
 *    hoverable, announces "dimmed"/"unavailable", and the wrapper swallows activation in
 *    the capture phase — before any handler the caller attached to the control itself, so
 *    an inert control is inert whatever its own listeners think.
 *
 * The conversion is deliberately not offered as an option. A disabled control inside a
 * tooltip is a control with a reason to give, and there is no case where the right
 * answer is to keep the reason and throw away every way of reaching it.
 *
 * @param {Node} control @param {string[]} lines @param {{up?:boolean, end?:boolean}} [opts]
 */
export function withTip(control, lines, opts = {}) {
  tipSeq += 1;
  const id = `ml-tip-${tipSeq}`;
  const bubble = el('span', { class: 'tip__bubble', role: 'tooltip', id, text: lines[0] });
  if (lines[1]) bubble.append(el('span', { text: lines[1] }));
  const where = 'tip' + (opts.up ? ' tip--up' : '') + (opts.end ? ' tip--end' : '');
  const wrap = el('span', { class: where }, control, bubble);
  if (typeof control.setAttribute === 'function') control.setAttribute('aria-describedby', id);
  if (control.disabled === true) makeInert(control, wrap);
  return wrap;
}

/** Focusable, hoverable, announced as unavailable — and unable to do anything. */
function makeInert(control, wrap) {
  control.disabled = false;
  control.setAttribute('aria-disabled', 'true');
  const swallow = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  // On the WRAPPER and in the capture phase, which is the only position that runs before
  // listeners already registered on the control: at the target itself, capture and bubble
  // listeners fire in registration order, so a listener added here would run second.
  wrap.addEventListener('click', swallow, true);
  wrap.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Enter' || event.key === ' ') swallow(event);
    },
    true
  );
}

/**
 * WCAG 2.2 1.4.13's "dismissible" clause, for every tooltip in the panel at once.
 *
 * A shown bubble is up to 14rem wide and covers whatever sits under its control — on the
 * tab strip, that is the site bar and its "Reset site". 1.4.13 requires a way to get rid
 * of it WITHOUT moving the pointer or the focus, and there was none.
 *
 * Escape hushes; the hush lifts once the thing that opened the bubble is no longer
 * pointing at it or focused in it. Deliberately not per-tooltip state: the panel rebuilds
 * its DOM on every store update, so a flag on a node would be dropped by the next render
 * while the pointer had not moved — a dismissal that undismisses itself.
 *
 * The Escape listener does not consume the key. `panel.js` has its own Escape handler for
 * §11's "(Esc to cancel)" promise, and one keystroke is entitled to mean both.
 */
export function wireTips(root = document) {
  /** Where the pointer is, so "has it moved since?" is answerable at any moment. */
  let pointer = { x: -1, y: -1 };
  /** Where it was when Escape was pressed, or null when nothing is dismissed. */
  let hushedAt = null;
  const body = () => root.body || document.body;
  const unhush = () => {
    hushedAt = null;
    body().classList.remove('tips-hushed');
  };

  /* The hush lifts on a real POINTER MOVE and not on `pointerover`, and the difference
   * is not pedantry — it is a loop. Dismissing a bubble the pointer is resting ON hides
   * it, which puts a different element under the pointer, which fires `pointerover`; a
   * handler that lifted the hush there would show the bubble again, under the pointer,
   * having moved nothing. Measured in a browser, not reasoned about: the tooltip came
   * straight back. A distance is the honest test of "the person moved on", and 4px is
   * enough to survive the sub-pixel jitter a trackpad produces while resting. */
  const MOVED = 4;
  root.addEventListener(
    'pointermove',
    (event) => {
      pointer = { x: event.clientX, y: event.clientY };
      // Measured from where Escape was pressed, which never moves — so jitter around
      // that spot cannot accumulate its way past the threshold one pixel at a time.
      if (!hushedAt) return;
      if (Math.abs(pointer.x - hushedAt.x) + Math.abs(pointer.y - hushedAt.y) > MOVED) unhush();
    },
    true
  );
  // Focus moving is the other way a person leaves a tooltip behind, and it is the one a
  // keyboard user takes. Hiding a bubble moves no focus, so this cannot loop.
  root.addEventListener('focusin', () => hushedAt && unhush(), true);
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    hushedAt = { x: pointer.x, y: pointer.y };
    body().classList.add('tips-hushed');
  });
}
