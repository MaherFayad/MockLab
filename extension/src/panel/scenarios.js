/**
 * Scenarios tab — PLAN.md §10.4.
 *
 * OWNER: panel-designer. A file of its own for §17.10's ~500-line ceiling, the same
 * reason `sources.js`, `pick.js`, `probe.js` and `result.js` are files of their own.
 *
 * §17.6: every word here comes from strings.js.
 * §17.7: every colour comes from panel.css.
 * §17.8: every message uses a constant from `background/messages.js`. The seven preset
 *   types were requested through the orchestrator and staged in a panel-local module
 *   while `messages.js` had another owner, exactly as M3's pick types and M4's probe
 *   types were; that merge has landed, values byte-for-byte, so they come from the one
 *   home now and the staging module is gone. `missingScenarioContract()` stays — see it.
 *
 * ── The tab does not assume a worker that can answer it ─────────────────────────
 * A Scenario lives in `chrome.storage.local` (§4), which the panel could reach directly —
 * and must not. `messages.js` says why where RESET_ALL is defined: an action the human can
 * take has to be an action an agent can take (§1.6), so it goes through the contract and
 * not around it. Until the worker answers `LIST_PRESETS`, `state.scenarios.ready` is
 * false and every control here renders disabled with its reason, exactly as this tab
 * looked at M4 — a button that silently does nothing is the failure §1.1 is about.
 *
 * ── §1.1 on this screen ─────────────────────────────────────────────────────────
 * Two places on a scenario card can quietly become untrue, and both are drawn:
 *   • a scenario whose sources this page no longer loads wears §10.6's Stale chip and
 *     §11's `scenarios.stale` (`links.js` decides, and only on evidence);
 *   • an Apply that could not place every change says so, with the number, instead of
 *     toasting a clean "applied" over a page that only half-changed.
 */
import { S } from './strings.js';
import { el, clear, ICON, spinner, withTip } from './dom.js';
import { MSG } from '../background/messages.js';
import { linkChip } from './probe.js';
import { scenarioMisses } from './links.js';
import { parseScenarioFile, serializeScenario, scenarioFileName, MAX_FILE_CHARS } from '../shared/scenarioFile.js';

/** The tab's own state. Everything §10.4 can be showing is a function of this. */
export const EMPTY_SCENARIOS = {
  /** null before the first answer, then whether the worker handles LIST_PRESETS. */
  ready: null,
  presets: [],
  /** The open name form: `{presetId|null, name, emoji}`. */
  form: null,
  /** Which card's ⋯ menu is open. */
  menu: null,
  /** Which card is asking §11's `deleteConfirm`. */
  confirm: null,
  /** One sentence from `scenarioFile.js` about the last file that was chosen. */
  error: '',
  busy: false
};

/**
 * Every message type this tab sends or listens for, declared as a list so a control can
 * check that the contract is really there before it promises anything — the same idiom
 * `pick.js` and `probe.js` use, and it earned its keep twice: both of those tabs were
 * written before their worker half existed and rendered an honest disabled state instead
 * of posting `undefined` at the worker and appearing to hang.
 */
export const SCENARIO_CONTRACT = [
  'LIST_PRESETS',
  'SAVE_PRESET',
  'UPDATE_PRESET',
  'DELETE_PRESET',
  'APPLY_PRESET',
  'IMPORT_PRESET',
  'PRESETS_CHANGED'
];

/** @returns {string[]} contract names `messages.js` does not define. */
export function missingScenarioContract() {
  return SCENARIO_CONTRACT.filter((name) => typeof MSG[name] !== 'string');
}

/**
 * Read the origin's Scenarios. Also the tab's capability check: a worker with no handler
 * for this type answers nothing, `send()` reports `ok:false`, and the whole tab renders
 * its not-ready state rather than a grid of buttons that do nothing.
 */
export async function loadScenarios(ctx) {
  const previous = ctx.state.scenarios || EMPTY_SCENARIOS;
  if (missingScenarioContract().length) {
    ctx.state.scenarios = { ...previous, ready: false, presets: [] };
    return;
  }
  const res = await ctx.send(MSG.LIST_PRESETS, { tabId: ctx.state.tabId });
  ctx.state.scenarios = {
    ...previous,
    ready: Boolean(res && res.ok),
    presets: (res && res.ok && Array.isArray(res.presets) ? res.presets : []).filter(Boolean)
  };
}

/* ─────────────────────────────────────────────────────────────────── the screen */

/**
 * @param {HTMLElement} root the #panel-scenarios body — this function owns its contents
 * @param {{state:Object, send:Function, refresh:Function, toast:Function, rerender:Function}} ctx
 */
export function renderScenariosTab(root, ctx) {
  clear(root);
  const tab = ctx.state.scenarios || EMPTY_SCENARIOS;

  root.append(actionsRow(ctx, tab));
  if (tab.error) root.append(el('p', { class: 'import-error', role: 'alert' }, ICON.warn(), el('span', { text: tab.error })));
  if (tab.form) root.append(nameForm(ctx, tab));

  if (!tab.ready) {
    // Not "there are no scenarios" — MockLab has not been told any. §1.1: the two say
    // different things and only one of them is known.
    root.append(el('p', { class: 'help', text: S.notYet }));
    return;
  }
  if (!tab.presets.length) {
    root.append(el('p', { class: 'empty', text: S.scenarios.empty }));
    return;
  }
  const grid = el('div', { class: 'scenario-grid' });
  for (const preset of tab.presets) grid.append(scenarioCard(preset, ctx, tab));
  root.append(grid);
}

/** §10.4's two top controls. */
function actionsRow(ctx, tab) {
  const box = el('div', { class: 'stack' });

  // §10.4: "disabled with tooltip when 0 active". The tooltip is the reason, not a
  // restatement of the label — the person needs to know what makes it work.
  const nothing = ctx.state.changeCount === 0;
  const make = el('button', {
    type: 'button',
    class: 'btn btn--primary',
    disabled: nothing || !tab.ready || tab.busy,
    text: S.scenarios.new
  });
  make.addEventListener('click', () => openForm(ctx, null));
  box.append(nothing || !tab.ready ? withTip(make, [nothing ? S.scenarios.nothingToSave : S.notYet], { up: true }) : make);

  const bring = el('button', { type: 'button', class: 'btn btn--secondary', disabled: !tab.ready || tab.busy, text: S.scenarios.import });
  const chooser = el('input', {
    type: 'file',
    class: 'hidden',
    id: 'scenario-file',
    accept: '.json,.mocklab.json,application/json'
  });
  chooser.addEventListener('change', () => void importChosen(ctx, chooser));
  bring.addEventListener('click', () => chooser.click());
  box.append(tab.ready ? bring : withTip(bring, [S.notYet], { up: true }), chooser);
  return box;
}

/** §11's `namePrompt`, as a form rather than a `prompt()` — a side panel has no dialog. */
function nameForm(ctx, tab) {
  const form = tab.form;
  const box = el('section', { class: 'editor' });
  box.append(el('h2', { text: S.scenarios.namePrompt }));

  const group = el('div', { class: 'editor__group' });
  group.append(el('label', { class: 'editor__label', for: 'scenario-name', text: S.scenarios.namePrompt }));
  const input = el('input', {
    class: 'editor__input',
    id: 'scenario-name',
    type: 'text',
    autocomplete: 'off',
    spellcheck: 'false'
  });
  input.value = form.name;
  input.addEventListener('input', () => {
    form.name = input.value;
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void saveForm(ctx);
  });
  group.append(input);
  if (form.error) group.append(el('p', { class: 'editor__error', text: form.error }));
  box.append(group);

  // §9.2's segmented control, spring thumb and all — one choice out of a small fixed set
  // is exactly what it is for, and it is the same recipe as the four main tabs.
  const symbols = el('div', { class: 'editor__group' });
  symbols.append(el('span', { class: 'editor__label', text: S.scenarios.symbol }));
  const picker = el('div', { class: 'segmented segmented--symbols' });
  const options = S.scenarios.symbols;
  picker.style.setProperty('--seg-cols', String(options.length));
  picker.style.setProperty('--seg-x', String(Math.max(0, options.indexOf(form.emoji))));
  options.forEach((symbol, index) => {
    const id = `scenario-symbol-${index}`;
    const radio = el('input', { type: 'radio', name: 'scenario-symbol', id });
    radio.checked = symbol === form.emoji;
    radio.addEventListener('change', () => {
      form.emoji = symbol;
      ctx.rerender();
    });
    picker.append(el('div', { class: 'segmented__opt' }, radio, el('label', { for: id, text: symbol })));
  });
  symbols.append(picker);
  box.append(symbols);

  const save = el('button', { type: 'button', class: 'btn btn--primary' });
  if (tab.busy) save.append(spinner('ml-scenario-spin'));
  save.append(el('span', { text: S.scenarios.save }));
  save.disabled = tab.busy;
  save.addEventListener('click', () => void saveForm(ctx));
  const cancel = el('button', { type: 'button', class: 'btn btn--ghost', text: S.editor.cancel });
  cancel.addEventListener('click', () => {
    ctx.state.scenarios = { ...tab, form: null };
    ctx.rerender();
  });
  box.append(el('div', { class: 'editor__actions' }, save, cancel));
  return box;
}

/** §10.4: emoji + name + "{n} changes" + Apply + ⋯ menu. */
function scenarioCard(preset, ctx, tab) {
  const misses = scenarioMisses(preset, ctx);
  const changes = (Array.isArray(preset.changes) && preset.changes) || [];
  const card = el('div', { class: 'card card--scenario', dataset: { stale: misses ? 'yes' : 'no' } });

  const title = el(
    'div',
    { class: 'card__title' },
    el('span', { class: 'scenario__symbol', text: preset.emoji || S.scenarios.defaultSymbol }),
    el('span', { class: 'truncate scenario__name', text: preset.name || S.scenarios.untitledFile })
  );
  // §10.6's four words are the whole status vocabulary, and this is one of them. Drawn
  // by `linkChip`, which derives the word AND the colour from the state it is given, so
  // this screen cannot pair a chip's word with a different chip's meaning either.
  if (misses) title.append(linkChip('stale'));
  title.append(menuButton(ctx, tab, preset));
  card.append(title);

  card.append(el('div', { class: 'card__meta' }, el('span', { text: S.scenarios.count(changes.length) })));
  if (misses) card.append(el('p', { class: 'card__note', text: S.scenarios.stale }));

  if (tab.menu === preset.id) card.append(menuFor(ctx, tab, preset));
  if (tab.confirm === preset.id) {
    card.append(
      el(
        'div',
        { class: 'scenario__confirm' },
        el('p', { class: 'help', text: S.scenarios.deleteConfirm(preset.name || '') }),
        el(
          'div',
          { class: 'editor__actions' },
          el('button', { type: 'button', class: 'btn btn--danger', text: S.scenarios.delete, onClick: () => void removeScenario(ctx, preset) }),
          el('button', {
            type: 'button',
            class: 'btn btn--ghost',
            text: S.editor.cancel,
            onClick: () => {
              ctx.state.scenarios = { ...tab, confirm: null };
              ctx.rerender();
            }
          })
        )
      )
    );
  }

  const apply = el('button', { type: 'button', class: 'btn btn--secondary scenario__apply', disabled: tab.busy, text: S.scenarios.apply });
  apply.addEventListener('click', () => void applyScenario(ctx, preset));
  card.append(apply);
  return card;
}

function menuButton(ctx, tab, preset) {
  const open = tab.menu === preset.id;
  const button = el(
    'button',
    { type: 'button', class: 'icon-btn scenario__more', 'aria-label': S.scenarios.more, 'aria-expanded': String(open) },
    ICON.more()
  );
  button.addEventListener('click', () => {
    ctx.state.scenarios = { ...tab, menu: open ? null : preset.id, confirm: null };
    ctx.rerender();
  });
  return button;
}

/** §10.4's ⋯ menu: Rename, Duplicate, Export file, Delete[danger]. */
function menuFor(ctx, tab, preset) {
  const menu = el('div', { class: 'scenario__menu', role: 'group', 'aria-label': S.scenarios.more });
  const item = (text, onClick, danger) =>
    el('button', { type: 'button', class: 'scenario__item' + (danger ? ' scenario__item--danger' : ''), text, onClick });
  menu.append(
    item(S.scenarios.rename, () => openForm(ctx, preset)),
    item(S.scenarios.duplicate, () => void duplicateScenario(ctx, preset)),
    item(S.scenarios.exportFile, () => exportScenario(ctx, preset)),
    item(S.scenarios.delete, () => {
      ctx.state.scenarios = { ...(ctx.state.scenarios || EMPTY_SCENARIOS), menu: null, confirm: preset.id };
      ctx.rerender();
    }, true)
  );
  return menu;
}

/* ────────────────────────────────────────────────────────────────── behaviour */

/**
 * Open §11's `namePrompt` form — for a new Scenario (`preset` null) or a Rename.
 *
 * EXPORTED for §10.1D's "Save as Scenario", which is the same action reached from the
 * other side of the product: the Pick tab's editor switches to this tab and opens this
 * form, rather than growing a second name form and a second SAVE_PRESET call site that
 * could drift from this one. `result.js` -> here, one way, like every other import seam
 * in this panel.
 */
export function openForm(ctx, preset) {
  const tab = ctx.state.scenarios || EMPTY_SCENARIOS;
  ctx.state.scenarios = {
    ...tab,
    menu: null,
    confirm: null,
    error: '',
    form: {
      presetId: preset ? preset.id : null,
      name: preset ? String(preset.name || '') : '',
      emoji: (preset && preset.emoji) || S.scenarios.defaultSymbol,
      error: ''
    }
  };
  ctx.rerender();
}

/** "New scenario from current changes" (§10.4) and Rename both end here. */
async function saveForm(ctx) {
  const tab = ctx.state.scenarios || EMPTY_SCENARIOS;
  const form = tab.form;
  if (!form || tab.busy) return;
  const name = String(form.name || '').trim();
  if (!name) {
    form.error = S.scenarios.nameEmpty;
    ctx.rerender();
    return;
  }
  const renaming = Boolean(form.presetId);
  await run(ctx, async () => {
    const res = await ctx.send(renaming ? MSG.UPDATE_PRESET : MSG.SAVE_PRESET, {
      tabId: ctx.state.tabId,
      presetId: form.presetId || undefined,
      name,
      emoji: form.emoji
    });
    if (!res || !res.ok) return false;
    ctx.state.scenarios = { ...(ctx.state.scenarios || EMPTY_SCENARIOS), form: null };
    return true;
  });
}

/** §10.4: "Applying: applies all changes + refresh + toast". */
async function applyScenario(ctx, preset) {
  await run(ctx, async () => {
    const res = await ctx.send(MSG.APPLY_PRESET, { tabId: ctx.state.tabId, presetId: preset.id, refresh: true });
    if (!res || !res.ok) return false;
    // §1.1: a change with no source to land on did not apply, and the toast that says so
    // is the difference between a person believing the page and checking it.
    const missed = Number(res.unapplied) || 0;
    ctx.toast(missed > 0 ? S.scenarios.appliedPartly(preset.name || '', missed) : S.scenarios.applied(preset.name || ''));
    return true;
  });
}

async function removeScenario(ctx, preset) {
  await run(ctx, async () => {
    const res = await ctx.send(MSG.DELETE_PRESET, { tabId: ctx.state.tabId, presetId: preset.id });
    if (!res || !res.ok) return false;
    ctx.state.scenarios = { ...(ctx.state.scenarios || EMPTY_SCENARIOS), confirm: null, menu: null };
    return true;
  });
}

/**
 * §10.4's Duplicate. It goes through IMPORT_PRESET and not through a "copy" message: a
 * duplicate IS an import of a scenario already in hand, and one path means one place
 * where a stored Scenario becomes a new stored Scenario.
 */
async function duplicateScenario(ctx, preset) {
  await run(ctx, async () => {
    const res = await ctx.send(MSG.IMPORT_PRESET, {
      tabId: ctx.state.tabId,
      preset: {
        name: S.scenarios.copyOf(String(preset.name || '')),
        emoji: preset.emoji || S.scenarios.defaultSymbol,
        changes: Array.isArray(preset.changes) ? preset.changes : []
      }
    });
    if (!res || !res.ok) return false;
    ctx.state.scenarios = { ...(ctx.state.scenarios || EMPTY_SCENARIOS), menu: null };
    return true;
  });
}

/**
 * §10.4's "Export file". A Blob and an anchor rather than `chrome.downloads`: the panel
 * asks for no permission it does not already have, and the person gets their browser's
 * own save dialog, where the name is theirs to change.
 */
export function exportScenario(ctx, preset) {
  const tab = ctx.state.scenarios || EMPTY_SCENARIOS;
  const url = URL.createObjectURL(new Blob([serializeScenario(preset)], { type: 'application/json' }));
  const anchor = el('a', { href: url, download: scenarioFileName(preset), class: 'hidden' });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next turn, not immediately: a synchronous revoke can beat the
  // download the click just started.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  ctx.state.scenarios = { ...tab, menu: null };
  ctx.rerender();
}

/**
 * §10.4's "Import" — the one place a file the product did not make enters MockLab.
 *
 * Everything about the file is decided by `scenarioFile.js`, which is pure and is tested
 * against the shapes a file chooser really produces. This function's whole job is the
 * two things only a browser can do: read the bytes, and put the sentence on screen.
 */
async function importChosen(ctx, chooser) {
  const file = chooser.files && chooser.files[0];
  // Cleared before anything else, so choosing the SAME file twice fires `change` again —
  // otherwise a person who fixes their file and re-picks it gets no response at all.
  chooser.value = '';
  if (!file) return;
  const tab = ctx.state.scenarios || EMPTY_SCENARIOS;

  // Refused on the file's own size before a byte is read: `text()` on a large file buys
  // a string the panel then has to hold, and the answer would be the same sentence.
  if (Number(file.size) > MAX_FILE_CHARS) {
    ctx.state.scenarios = { ...tab, error: S.scenarios.importTooBig };
    ctx.rerender();
    return;
  }

  let text = null;
  try {
    text = await file.text();
  } catch {
    // A file that vanished, a permission the OS withdrew, a disk that failed. Nothing
    // about it is worth showing; what to do next is.
    ctx.state.scenarios = { ...tab, error: S.scenarios.importUnreadable };
    ctx.rerender();
    return;
  }

  const parsed = parseScenarioFile(text, { origin: ctx.state.origin, hostname: ctx.state.hostname });
  if (!parsed.ok) {
    ctx.state.scenarios = { ...(ctx.state.scenarios || EMPTY_SCENARIOS), error: parsed.error };
    ctx.rerender();
    return;
  }
  ctx.state.scenarios = { ...(ctx.state.scenarios || EMPTY_SCENARIOS), error: '' };
  await run(ctx, async () => {
    const res = await ctx.send(MSG.IMPORT_PRESET, { tabId: ctx.state.tabId, preset: parsed.preset });
    if (!res || !res.ok) return false;
    ctx.toast(S.scenarios.imported(parsed.preset.name));
    return true;
  });
}

/**
 * One mutation: mark the tab busy, do it, re-read, and — the part worth having in one
 * place — report a worker that refused. `errors.pageBroke` is §11's one sentence for
 * "something went wrong here", and it is said once per action rather than at four call
 * sites that could each forget.
 */
async function run(ctx, work) {
  const before = ctx.state.scenarios || EMPTY_SCENARIOS;
  ctx.state.scenarios = { ...before, busy: true };
  ctx.rerender();
  let ok = false;
  try {
    ok = await work();
  } finally {
    ctx.state.scenarios = { ...(ctx.state.scenarios || EMPTY_SCENARIOS), busy: false };
  }
  if (!ok) ctx.toast(S.errors.pageBroke, true);
  await ctx.refresh();
}
