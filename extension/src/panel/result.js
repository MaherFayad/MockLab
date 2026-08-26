/**
 * Pick tab — PLAN.md §10.1 State D: the result card and the value editor under it.
 *
 * OWNER: panel-designer. Split from `probe.js` for §17.10's ~500-line ceiling; that file
 * is the RUN (contract, progress, the five ways it ends) and this one is what a finished
 * run leaves on screen. The import runs one way, here -> `probe.js`.
 *
 * §17.6: every word here comes from strings.js.
 * §17.7: every colour comes from panel.css.
 * §17.8: every message uses a constant from `background/messages.js`.
 *
 * ── §17.12, in this file ────────────────────────────────────────────────────────
 * `probe.found` — "Found it — this element is controlled by:" — is the strongest claim
 * this product makes, and it is printed behind `proved(binding)`, which is an
 * `=== 'verified'` comparison living in `probe.js` and nothing looser. A Binding in any
 * other state still gets an editor, because a Change applies whether or not MockLab
 * proved what it drives (§10.2) — but it gets the neutral heading, its own chip from
 * §10.6's four-word vocabulary, and §11's `editor.unverified` under it. The worker is
 * not trusted to hand back only verified results: if it ever hands back something else,
 * this screen says so instead of celebrating it.
 */
import { S } from './strings.js';
import { MSG } from '../background/messages.js';
import { el, ICON, spinner, withTip } from './dom.js';
import { formatValue, draftFor, valueKind, coerceValue, fieldLabel } from './sources.js';
import { EMPTY_PROBE, closeResult, linkChip, proved } from './probe.js';

/** §10.1D. The success card, the field it names, and the value editor under it. */
export function renderResult(root, ctx) {
  const probe = ctx.state.probe || EMPTY_PROBE;
  const binding = probe.binding;
  if (!binding) return;
  const isProved = proved(binding);
  // The working draft is STATE, not a per-render value: the picker re-renders the card
  // on every choice, so a draft created here and thrown away would reset the person's
  // selection on the very click that made it. Seeded once, then reused.
  if (!probe.draft) probe.draft = draftFrom(binding, probe.real);
  const draft = probe.draft;

  const card = el('section', { class: 'result', dataset: { linkState: String(binding.state || '') } });

  const back = el('button', { type: 'button', class: 'icon-btn', 'aria-label': S.editor.cancel }, ICON.back());
  back.addEventListener('click', () => closeResult(ctx));
  card.append(
    el(
      'div',
      { class: 'result__head' },
      back,
      el('h2', { text: isProved ? S.probe.found : S.editor.title }),
      linkChip(binding.state)
    )
  );

  // Which source, and which field of it — §10.1D's "source name + field chip". The raw
  // path is Advanced-only (§1.2); the field's own keys are not, and are the same words
  // the §10.2 tree labels its rows with.
  const where = el(
    'div',
    { class: 'result__where' },
    el('span', { class: 'result__source truncate', text: sourceNameFor(ctx, binding.sigId) }),
    el('span', { class: 'chip chip--field mono truncate', text: fieldLabel(binding.path) })
  );
  card.append(where);
  if (probe.real !== undefined) {
    card.append(el('p', { class: 'result__real mono', text: S.editor.original(formatValue(probe.real)) }));
  }
  if (ctx.state.settings && ctx.state.settings.advancedMode) {
    card.append(el('p', { class: 'result__path mono truncate', text: S.glyph.joinLabel(S.advanced.path, binding.path) }));
  }

  const group = el('div', { class: 'editor__group' });
  group.append(el('span', { class: 'editor__label', text: S.editor.newValue }));
  group.append(valueControl(binding, draft, ctx));
  if (draft.error) group.append(el('p', { class: 'editor__error', text: draft.error }));
  card.append(group);

  if (!isProved) card.append(el('p', { class: 'editor__note' }, ICON.warn(), el('span', { text: S.editor.unverified })));
  // §7.2's obstacle, carried through from the run: the request behind this field did not
  // come back on a reload, so the site will see the new value the next time it asks for
  // it. Saying nothing here and then refreshing to an unchanged page is the §1.1 failure.
  if (probe.notRefetched) card.append(el('p', { class: 'editor__note' }, ICON.warn(), el('span', { text: S.probe.notRefetched })));

  card.append(affectedNote(binding, isProved, probe.affected));

  const apply = el('button', { type: 'button', class: 'btn btn--primary' });
  if (draft.busy) apply.append(spinner('ml-result-spin'));
  apply.append(el('span', { text: S.editor.apply }));
  apply.disabled = Boolean(draft.busy);
  apply.addEventListener('click', () => void applyValue(ctx, binding, draft));
  card.append(el('div', { class: 'editor__actions' }, apply));

  // §10.1D: the ghost button appears at the "applied" moment, because a Scenario is a
  // bundle of changes that are already on — there is nothing to save before that.
  if (probe.applied) {
    const save = el('button', { type: 'button', class: 'btn btn--ghost btn--wide', disabled: true, text: S.editor.saveScenario });
    card.append(withTip(save, [S.notYet], { up: true }));
  }
  root.append(card);
}

/**
 * §10.1D's "This change affects {k} places on the page — [Show me]".
 *
 * The count comes from the Binding's own proven `elements` (§7.6 fills it during
 * VERIFY_ON), falling back to the run's own tally of the same thing; either way it is
 * only shown for a Binding that was proved. An unproven Link has
 * no such list, and "affects 0 places" would read as a measurement rather than as the
 * absence of one. "Show me" needs §10.3's on-page overlays, which are §16 M5 — shown
 * disabled with its reason rather than hidden, so the row still describes itself.
 */
function affectedNote(binding, isProved, reported) {
  const proven = Array.isArray(binding.elements) ? binding.elements.length : 0;
  const places = proven || Number(reported) || 0;
  if (!isProved || places < 1) return el('span', { class: 'hidden' });
  const show = el('button', { type: 'button', class: 'btn btn--ghost', disabled: true, text: S.probe.showMe });
  return el(
    'div',
    { class: 'result__affected' },
    el('span', { class: 'result__affected-text', text: S.probe.affected(places) }),
    withTip(show, [S.notYet], { up: true, end: true })
  );
}

function sourceNameFor(ctx, sigId) {
  const source = (ctx.state.sources || []).find((entry) => entry && entry.sigId === sigId);
  return (source && source.name) || S.sources.fallbackName;
}

/* ───────────────────────────────────────────────────────────── the value editor */

/** The editor's working state for one field. */
export function draftFrom(binding, real) {
  const values = Array.isArray(binding.observedValues) ? binding.observedValues.filter((v) => v !== undefined) : [];
  return {
    values,
    /** Index into `values`, or -1 for §11's "Custom…". */
    choice: values.length >= 2 ? 0 : -1,
    kind: valueKind(real === undefined ? values[0] : real),
    draft: draftFor(real === undefined ? values[0] : real),
    bool: Boolean(real === undefined ? values[0] : real),
    error: '',
    busy: false
  };
}

/**
 * §10.1D: "if `observedValues` ≥ 2 → segmented value picker of those values +
 * 'Custom…'; else typed input (number/text/toggle per value type)".
 *
 * The picker is §9.2's segmented control, spring thumb and all — the same recipe as the
 * four main tabs, because it is the same thing: one choice out of a small fixed set. It
 * wraps to a grid when the field has more values than fit across the panel, and the
 * thumb moves on both axes rather than the control degrading into a different vocabulary
 * halfway up the value count.
 */
function valueControl(binding, draft, ctx) {
  if (draft.values.length < 2) return typedInput(draft, ctx);

  const options = draft.values.map((value) => ({ label: formatValue(value), mono: true }));
  options.push({ label: S.editor.custom, mono: false });
  const columns = options.length <= 3 ? options.length : 2;
  const rows = Math.ceil(options.length / columns);
  const chosen = draft.choice < 0 ? options.length - 1 : draft.choice;

  const box = el('div', { class: 'segmented segmented--values' });
  box.style.setProperty('--seg-cols', String(columns));
  box.style.setProperty('--seg-rows', String(rows));
  box.style.setProperty('--seg-x', String(chosen % columns));
  box.style.setProperty('--seg-y', String(Math.floor(chosen / columns)));

  options.forEach((option, index) => {
    const id = `ml-val-${index}`;
    const input = el('input', { type: 'radio', name: 'ml-values', id });
    input.checked = index === chosen;
    input.addEventListener('change', () => {
      draft.choice = index === options.length - 1 ? -1 : index;
      draft.error = '';
      if (draft.choice >= 0) {
        draft.kind = valueKind(draft.values[index]);
        draft.draft = draftFor(draft.values[index]);
        draft.bool = Boolean(draft.values[index]);
      }
      ctx.rerender();
    });
    box.append(
      el(
        'div',
        { class: 'segmented__opt' },
        input,
        el('label', { class: option.mono ? 'mono truncate' : 'truncate', for: id, text: option.label })
      )
    );
  });

  if (draft.choice >= 0) return box;
  return el('div', { class: 'editor__group' }, box, typedInput(draft, ctx));
}

/** §10.1D's "typed input (number/text/toggle per value type)". */
function typedInput(draft, ctx) {
  if (draft.kind === 'boolean') {
    const group = el('div', { class: 'editor__bool' });
    for (const [value, label] of [[true, S.editor.trueLabel], [false, S.editor.falseLabel]]) {
      const id = `ml-result-bool-${value}`;
      const input = el('input', { type: 'radio', name: 'ml-result-bool', id });
      input.checked = draft.bool === value;
      input.addEventListener('change', () => {
        draft.bool = value;
      });
      group.append(input, el('label', { for: id, text: label }));
    }
    return group;
  }
  const input = el('input', {
    class: 'editor__input',
    id: 'ml-result-value',
    type: 'text',
    autocomplete: 'off',
    spellcheck: 'false',
    inputmode: draft.kind === 'number' ? 'decimal' : 'text'
  });
  input.value = draft.draft;
  input.addEventListener('input', () => {
    draft.draft = input.value;
    draft.error = '';
  });
  return input;
}

/**
 * §10.1D's "Apply & refresh page", then §11's `editor.applied` toast.
 *
 * `SET_VALUE` reports whether the Change can actually reach the page; a Change against a
 * request this visit never made applies later, not now, and saying "Done" then would be
 * the lie the whole product exists to avoid (§1.1). That is §11's `probe.notRefetched`,
 * the same sentence the §10.2 editor already says for the same fact.
 */
async function applyValue(ctx, binding, draft) {
  if (draft.busy) return;
  const chosen = draft.choice >= 0 ? { value: draft.values[draft.choice] } : coerceValue(draft);
  if (chosen.error) {
    draft.error = chosen.error;
    ctx.rerender();
    return;
  }
  draft.busy = true;
  ctx.rerender();
  const res = await ctx.send(MSG.SET_VALUE, {
    tabId: ctx.state.tabId,
    sigId: binding.sigId,
    path: binding.path,
    value: chosen.value,
    refresh: true
  });
  draft.busy = false;
  if (!res || !res.ok) {
    ctx.toast(S.errors.pageBroke, true);
    ctx.rerender();
    return;
  }
  const applied = res.change && res.change.applies !== false;
  ctx.toast(applied ? S.editor.applied : S.probe.notRefetched);
  ctx.state.probe = { ...ctx.state.probe, draft, applied: true };
  await ctx.refresh();
}
