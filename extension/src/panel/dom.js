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

/**
 * Wrap a control in the §9.2 tooltip. `lines[0]` is the label, `lines[1]` the dimmed
 * secondary line. Both come from strings.js — never from here.
 *
 * `end` anchors the bubble to the control's inline END instead of centring it on the
 * control. A centred 14rem bubble on a control near the edge of a 320px panel hangs off
 * it; the panel is too narrow for the bubble to be centred everywhere.
 *
 * @param {Node} control @param {string[]} lines @param {{up?:boolean, end?:boolean}} [opts]
 */
export function withTip(control, lines, opts = {}) {
  const bubble = el('span', { class: 'tip__bubble', role: 'tooltip', text: lines[0] });
  if (lines[1]) bubble.append(el('span', { text: lines[1] }));
  const where = 'tip' + (opts.up ? ' tip--up' : '') + (opts.end ? ' tip--end' : '');
  return el('span', { class: where }, control, bubble);
}
