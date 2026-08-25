/**
 * Sources tab (PLAN.md §10.2) + the value editor (§10.1 State D) it opens.
 *
 * OWNER: panel-designer. Split from panel.js to stay under §17.10's ~500-line ceiling.
 *
 * §17.6: every word here comes from strings.js.
 * §17.7: every colour comes from panel.css.
 * §17.8: every message uses a constant from ../background/messages.js.
 */
import { S } from './strings.js';
import { MSG } from '../background/messages.js';
import { el, clear, ICON, spinner, withTip } from './dom.js';
import { joinPath } from '../shared/jsonpath.js';

/** §10.2: "max initial depth 2" — the root and one level of containers start open. */
const INITIAL_OPEN_DEPTH = 1;

/* ────────────────────────────────────────────────────────────────── formatting */

/**
 * How a value reads in the tree and in "Real value: …". Deliberately unquoted: a
 * quotation mark is punctuation a non-technical reader has to decode, and §1.2 asks
 * for the plainer option. Type still shows, through colour and through the editor.
 *
 * Two of these branches return a DESCRIPTION rather than the value's own text — a field
 * holding no value, and a container drawn collapsed. Both words come from strings.js
 * (§17.6): `null` was a literal here for one milestone, and it read out to the human in
 * the tree and in "Real value: null" — the one programmer's word this panel showed.
 * `panel.strings.test.js` fails if any word moves back into this function.
 *
 * A value that is absent (null) and one that was never there (undefined) read
 * differently on purpose: the first is a field the site sent with nothing in it and is
 * worth saying out loud, the second is a row that has no value slot at all.
 */
export function formatValue(value) {
  if (value === null) return S.glyph.nullValue;
  if (value === undefined) return '';
  if (typeof value === 'object') return Array.isArray(value) ? S.glyph.list(value.length) : S.glyph.collapsedObject;
  return String(value);
}

/**
 * What the editor's text box STARTS with, which is not what the tree shows.
 * `formatValue` describes a value that has no text of its own ("nothing", "{…}"), and a
 * description seeded into an editable box is applied as if the person had typed it — a
 * null field would reach the site as the literal text "nothing". An absent value starts
 * as an empty box instead, so whatever the site ends up seeing is something a human
 * actually wrote.
 *
 * Exported for `panel.strings.test.js` alone, and it has to be: this defect is
 * invisible from outside the module. The only fixture that reaches it is a response
 * field holding no value, and the demo site (§14) has none — which is exactly how it
 * survived a full browser run of the M2 flow. `return formatValue(value)` restores the
 * bug and breaks no other test; the seeding test is the one that stops it.
 */
export function draftFor(value) {
  if (value === null || value === undefined || typeof value === 'object') return '';
  return String(value);
}

function valueKind(value) {
  if (value === null || value === undefined) return 'null';
  const t = typeof value;
  return t === 'string' || t === 'number' || t === 'boolean' ? t : 'null';
}

function isContainer(value) {
  return value !== null && typeof value === 'object' && !value.__unparsed;
}

/** §10.2's meta row is "{n} fields · just now / 2 min ago". */
function relativeTime(ts) {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return S.sources.justNow;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return S.sources.minutesAgo(minutes);
  return S.sources.hoursAgo(Math.round(minutes / 60));
}

/* ─────────────────────────────────────────────────────────────────── the list */

/**
 * @param {HTMLElement} container
 * @param {{state:Object, send:Function, refresh:Function, toast:Function, rerender:Function}} ctx
 */
export function renderSources(container, ctx) {
  clear(container);
  const all = ctx.state.sources;
  if (!all.length) {
    container.append(el('p', { class: 'empty', text: S.sources.empty }));
    return;
  }
  const query = ctx.state.query.trim().toLowerCase();
  const shown = query ? all.filter((s) => s.name.toLowerCase().includes(query)) : all;
  if (!shown.length) {
    container.append(el('p', { class: 'empty', text: S.sources.noMatch }));
    return;
  }
  for (const source of shown) container.append(sourceCard(source, ctx));
}

function sourceCard(source, ctx) {
  const open = ctx.state.open === source.sigId;
  const changes = ctx.state.changes.filter((c) => c.sigId === source.sigId && !c.probe);

  const box = el('input', { type: 'checkbox', tabindex: '-1', 'aria-hidden': 'true' });
  box.checked = open;

  const title = el('span', { class: 'card__title' }, el('span', { class: 'truncate', text: source.name }));
  if (changes.length) title.append(chip('changed', S.chips.changed));
  if (source.via === 'document') title.append(chip('neutral', S.sources.builtin));
  const chevron = el('span', { class: 'card__chevron' }, ICON.chevron());
  title.append(chevron);

  const meta = el(
    'span',
    { class: 'card__meta' },
    el('span', { text: S.sources.fields(source.fields) }),
    el('span', { text: relativeTime(source.lastSeenTs) })
  );

  const head = el(
    'label',
    { class: 'card__head' },
    box,
    title,
    meta
  );
  head.addEventListener('change', () => {
    if (box.checked) openSource(source, ctx);
    else closeSource(ctx);
  });

  const card = el('div', { class: 'card' }, head);

  // Advanced mode is the one place §1.2 allows technical vocabulary, and it is what the
  // Settings row promises: the request behind the friendly name.
  if (ctx.state.settings.advancedMode) {
    card.append(
      el(
        'div',
        { class: 'card__advanced' },
        el('span', { class: 'mono truncate', text: S.glyph.joinLabel(S.advanced.method, source.method) }),
        el('span', { class: 'mono truncate', text: S.glyph.joinLabel(S.advanced.url, source.urlPattern) }),
        el('span', { class: 'mono truncate', text: S.glyph.joinLabel(S.advanced.via, source.via) }),
        el('span', { class: 'mono truncate', text: S.glyph.joinLabel(S.advanced.sigId, source.sigId) })
      )
    );
  }

  if (source.unparsed) card.append(el('p', { class: 'card__note', text: S.sources.streamedUnsupported }));
  if (source.changeDropped) card.append(el('p', { class: 'card__note', text: S.sources.changeDropped }));

  if (open) {
    if (ctx.state.editing && ctx.state.editing.sigId === source.sigId) card.append(valueEditor(ctx, source));
    card.append(treeFor(source, ctx));
  }
  return card;
}

function chip(kind, text) {
  const node = el('span', { class: `chip chip--${kind}`, text });
  return node;
}

async function openSource(source, ctx) {
  ctx.state.open = source.sigId;
  ctx.state.editing = null;
  ctx.state.body = undefined;
  ctx.state.expanded = new Set();
  ctx.rerender();
  const res = await ctx.send(MSG.GET_RESPONSE, { tabId: ctx.state.tabId, sigId: source.sigId });
  if (ctx.state.open !== source.sigId) return;
  ctx.state.body = res && res.ok ? res.body : null;
  if (isContainer(ctx.state.body)) prefillExpanded(ctx.state.body, '$', 0, ctx.state.expanded);
  ctx.rerender();
}

function closeSource(ctx) {
  ctx.state.open = null;
  ctx.state.body = undefined;
  ctx.state.editing = null;
  ctx.rerender();
}

function prefillExpanded(value, path, depth, set) {
  if (!isContainer(value) || depth > INITIAL_OPEN_DEPTH) return;
  set.add(path);
  for (const [key, child] of entriesOf(value)) {
    prefillExpanded(child, joinPath(path, key), depth + 1, set);
  }
}

function entriesOf(value) {
  return Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
}

/* ──────────────────────────────────────────────────────────── the tree — §10.2 */

function treeFor(source, ctx) {
  const wrap = el('div', { class: 'tree' });
  const body = ctx.state.body;
  if (body === undefined) {
    wrap.append(el('div', { class: 'tree__row' }, spinner('ml-tree-spin')));
    return wrap;
  }
  if (body === null || (body && body.__unparsed)) {
    wrap.append(el('p', { class: 'help', text: S.sources.streamedUnsupported }));
    return wrap;
  }
  if (!isContainer(body) || !entriesOf(body).length) {
    wrap.append(el('p', { class: 'help', text: S.sources.emptyBody }));
    return wrap;
  }
  wrap.append(children(body, '$', 0, source, ctx));
  return wrap;
}

function children(value, path, depth, source, ctx) {
  const list = el('div', { class: 'tree__group' });
  for (const [key, child] of entriesOf(value)) {
    list.append(treeNode(key, child, joinPath(path, key), depth, source, ctx));
  }
  return list;
}

function labelOf(key) {
  return typeof key === 'number' ? S.glyph.index(key) : String(key);
}

function treeNode(key, value, path, depth, source, ctx) {
  if (isContainer(value)) return branchNode(key, value, path, depth, source, ctx);
  return leafNode(key, value, path, source, ctx);
}

function branchNode(key, value, path, depth, source, ctx) {
  const expanded = ctx.state.expanded.has(path);
  const count = entriesOf(value).length;
  const toggle = el(
    'button',
    { type: 'button', class: 'tree__toggle', 'aria-expanded': String(expanded) },
    el('span', { class: 'tree__caret' }, ICON.caret()),
    el('span', { class: 'tree__key', text: labelOf(key) }),
    el('span', { class: 'tree__count mono', text: Array.isArray(value) ? S.glyph.list(count) : S.glyph.object(count) })
  );
  toggle.addEventListener('click', () => {
    if (expanded) ctx.state.expanded.delete(path);
    else ctx.state.expanded.add(path);
    ctx.rerender();
  });
  const node = el('div', { class: 'tree__branch' }, el('div', { class: 'tree__row' }, toggle));
  if (expanded) node.append(el('div', { class: 'tree__children' }, children(value, path, depth + 1, source, ctx)));
  return node;
}

function leafNode(key, value, path, source, ctx) {
  const change = ctx.state.changes.find((c) => c.sigId === source.sigId && c.path === path && !c.probe);
  const row = el('div', { class: 'tree__row' + (change ? ' tree__row--changed' : '') + (change && !change.enabled ? ' tree__row--off' : '') });
  row.append(el('span', { class: 'tree__key', text: labelOf(key) }));

  if (change) {
    const real = change.originalValue === undefined ? value : change.originalValue;
    row.append(el('span', { class: 'tree__value tree__value--old mono', text: formatValue(real) }));
    row.append(el('span', { class: 'tree__arrow' }, ICON.arrow()));
    row.append(el('span', { class: `tree__value tree__value--${valueKind(change.value)} mono`, text: formatValue(change.value) }));
  } else {
    row.append(el('span', { class: `tree__value tree__value--${valueKind(value)} mono`, text: formatValue(value) }));
  }

  row.append(rowActions({ key, value, path, change, source, ctx }));
  return row;
}

function rowActions({ key, value, path, change, source, ctx }) {
  const actions = el('div', { class: 'tree__actions' + (change ? ' tree__actions--pinned' : '') });

  if (change) {
    const box = el('input', { type: 'checkbox', 'aria-label': change.enabled ? S.sources.changeOn : S.sources.changeOff });
    box.checked = Boolean(change.enabled);
    const mark = el('span', { class: 'check-box' });
    box.addEventListener('change', async () => {
      mark.classList.add('check-box--draw'); // only a real toggle animates
      const res = await ctx.send(MSG.TOGGLE_CHANGE, { tabId: ctx.state.tabId, changeId: change.id, enabled: box.checked });
      if (!res || !res.ok) ctx.toast(S.errors.pageBroke, true);
      await ctx.refresh();
    });
    actions.append(el('label', { class: 'check' }, box, mark));
  }

  const edit = el('button', { type: 'button', class: 'icon-btn', 'aria-label': S.sources.changeValue }, ICON.pencil());
  edit.addEventListener('click', () => {
    ctx.state.editing = {
      sigId: source.sigId,
      sourceName: source.name,
      url: source.url,
      path,
      key: labelOf(key),
      real: change && change.originalValue !== undefined ? change.originalValue : value,
      draft: draftFor(change ? change.value : value),
      bool: Boolean(change ? change.value : value),
      kind: valueKind(change ? change.value : value),
      error: '',
      busy: false
    };
    ctx.rerender();
  });
  actions.append(withTip(edit, [S.sources.changeValue], { up: true }));

  // ◎ "Show on page" needs the on-page overlay engine, which is §10.3 / M5 work. It is
  // shown disabled rather than hidden so the row's vocabulary matches §10.2, and it says
  // why instead of doing nothing quietly.
  const show = el('button', { type: 'button', class: 'icon-btn', disabled: true, 'aria-label': S.sources.showOnPage }, ICON.target());
  actions.append(withTip(show, [S.sources.showOnPage, S.soon], { up: true }));

  if (change) {
    const remove = el('button', { type: 'button', class: 'icon-btn icon-btn--danger', 'aria-label': S.sources.removeChange }, ICON.trash());
    remove.addEventListener('click', async () => {
      const res = await ctx.send(MSG.DELETE_CHANGE, { tabId: ctx.state.tabId, changeId: change.id });
      if (!res || !res.ok) ctx.toast(S.errors.pageBroke, true);
      await ctx.refresh();
    });
    actions.append(withTip(remove, [S.sources.removeChange], { up: true }));
  }
  return actions;
}

/* ─────────────────────────────────────────────── the value editor — §10.1 State D */

function valueEditor(ctx, source) {
  const e = ctx.state.editing;
  const box = el('div', { class: 'editor' });

  const close = el('button', { type: 'button', class: 'icon-btn', 'aria-label': S.editor.cancel }, ICON.back());
  close.addEventListener('click', () => {
    ctx.state.editing = null;
    ctx.rerender();
  });

  box.append(el('div', { class: 'editor__head' }, close, el('h2', { text: S.editor.title }), chip('candidate', S.chips.candidate)));

  const where = el(
    'div',
    { class: 'editor__where' },
    el('span', { class: 'editor__field', text: S.glyph.joinDot(source.name, e.key) }),
    el('span', { class: 'mono', text: S.editor.original(formatValue(e.real)) })
  );
  if (ctx.state.settings.advancedMode) {
    where.append(el('span', { class: 'mono truncate', text: S.glyph.joinLabel(S.advanced.path, e.path) }));
    where.append(el('span', { class: 'mono truncate', text: S.glyph.joinLabel(S.advanced.url, e.url) }));
  }
  box.append(where);

  // Label, field and its error are one group: at Inter's metrics a bare --gap-m between
  // them reads as three unrelated blocks rather than one labelled control.
  const group = el('div', { class: 'editor__group' });
  group.append(el('label', { class: 'editor__label', for: 'ml-value', text: S.editor.newValue }));
  group.append(inputFor(e, ctx));
  if (e.error) group.append(el('p', { class: 'editor__error', text: e.error }));
  box.append(group);

  // §10.2: a Change made from the tree has not been probed, so it is Possible, never
  // Verified (§17.4). The chip above and this line say the same thing twice on purpose.
  box.append(el('p', { class: 'editor__note' }, ICON.warn(), el('span', { text: S.editor.unverified })));

  const apply = el('button', { type: 'button', class: 'btn btn--primary' });
  if (e.busy) apply.append(spinner('ml-apply-spin'));
  apply.append(el('span', { text: S.editor.apply }));
  apply.disabled = e.busy;
  apply.addEventListener('click', () => applyEdit(ctx, apply));

  const cancel = el('button', { type: 'button', class: 'btn btn--ghost', text: S.editor.cancel });
  cancel.addEventListener('click', () => {
    ctx.state.editing = null;
    ctx.rerender();
  });

  box.append(el('div', { class: 'editor__actions' }, apply, cancel));
  return box;
}

function inputFor(e, ctx) {
  if (e.kind === 'boolean') {
    const group = el('div', { class: 'editor__bool' });
    for (const [value, label] of [[true, S.editor.trueLabel], [false, S.editor.falseLabel]]) {
      const id = `ml-bool-${value}`;
      const input = el('input', { type: 'radio', name: 'ml-bool', id });
      input.checked = e.bool === value;
      input.addEventListener('change', () => {
        e.bool = value;
      });
      group.append(input, el('label', { for: id, text: label }));
    }
    return group;
  }
  const input = el('input', {
    class: 'editor__input',
    id: 'ml-value',
    type: 'text',
    autocomplete: 'off',
    spellcheck: 'false',
    inputmode: e.kind === 'number' ? 'decimal' : 'text'
  });
  input.value = e.draft;
  input.addEventListener('input', () => {
    e.draft = input.value;
    e.error = '';
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') applyEdit(ctx);
  });
  queueMicrotask(() => {
    if (!ctx.state.restoreFocus) input.focus();
  });
  return input;
}

/** The typed value a Change stores, or an error string in §11's voice. */
function coerce(e) {
  if (e.kind === 'boolean') return { value: e.bool };
  if (e.kind === 'number') {
    const value = Number(e.draft.trim());
    if (e.draft.trim() === '' || Number.isNaN(value)) return { error: S.editor.invalidNumber };
    return { value };
  }
  return { value: e.draft };
}

async function applyEdit(ctx, button) {
  const e = ctx.state.editing;
  if (!e || e.busy) return;
  const result = coerce(e);
  if (result.error) {
    e.error = result.error;
    ctx.rerender();
    return;
  }
  e.busy = true;
  if (button) button.disabled = true;
  const res = await ctx.send(MSG.SET_VALUE, {
    tabId: ctx.state.tabId,
    sigId: e.sigId,
    path: e.path,
    value: result.value,
    refresh: true
  });
  e.busy = false;
  if (!res || !res.ok) {
    ctx.toast(S.errors.pageBroke, true);
    ctx.rerender();
    return;
  }
  // §1.1 — a Change whose request MockLab has never seen cannot apply yet, and saying
  // "Done" would be the lie the whole product exists to avoid.
  const applied = res.change && res.change.applies !== false;
  ctx.toast(applied ? S.editor.applied : S.probe.notRefetched);
  ctx.state.editing = null;
  await ctx.refresh();
}
