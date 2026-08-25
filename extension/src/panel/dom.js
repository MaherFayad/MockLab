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
  pick: () => svgIcon(['M12 3v4', 'M12 17v4', 'M3 12h4', 'M17 12h4', 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z'], 18),
  // stacked list — Sources
  sources: () => svgIcon(['M4 6.5h16', 'M4 12h16', 'M4 17.5h10'], 18),
  // clapperboard — Scenarios
  scenarios: () => svgIcon(['M3 8.5h18v11a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19.5z', 'M3.6 8.5 6 3.6l4 1.2-2.4 4.9', 'M10 5 14 6.2 11.6 11'], 18),
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
  warn: () => svgIcon(['M12 3.8 21 19.5H3z', 'M12 10v4.2', 'M12 17.1h.01'], 15)
};

/**
 * The DGA radial-gradient spinner (PLAN.md §9.2). Its two stops are painted from
 * panel.css (`.spinner .s-from` / `.s-to`) so no colour lives here.
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
  grad.setAttribute('cx', '0.5');
  grad.setAttribute('cy', '0.5');
  grad.setAttribute('r', '0.5');
  for (const [offset, cls] of [['0.62', 's-from'], ['1', 's-to']]) {
    const stop = document.createElementNS(SVG_NS, 'stop');
    stop.setAttribute('offset', offset);
    stop.setAttribute('class', cls);
    grad.append(stop);
  }
  defs.append(grad);
  const circle = document.createElementNS(SVG_NS, 'circle');
  circle.setAttribute('cx', '12');
  circle.setAttribute('cy', '12');
  circle.setAttribute('r', '9');
  circle.setAttribute('fill', `url(#${id})`);
  const hole = document.createElementNS(SVG_NS, 'circle');
  hole.setAttribute('cx', '12');
  hole.setAttribute('cy', '12');
  hole.setAttribute('r', '6.2');
  hole.setAttribute('fill', 'currentColor');
  svg.append(defs, circle, hole);
  return svg;
}

/**
 * Wrap a control in the §9.2 tooltip. `lines[0]` is the label, `lines[1]` the dimmed
 * secondary line. Both come from strings.js — never from here.
 * @param {Node} control @param {string[]} lines @param {{up?:boolean}} [opts]
 */
export function withTip(control, lines, opts = {}) {
  const bubble = el('span', { class: 'tip__bubble', role: 'tooltip', text: lines[0] });
  if (lines[1]) bubble.append(el('span', { text: lines[1] }));
  return el('span', { class: 'tip' + (opts.up ? ' tip--up' : '') }, control, bubble);
}
