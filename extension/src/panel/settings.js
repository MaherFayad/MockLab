/**
 * Settings tab — PLAN.md §10.5: the checkbox rows, the AI-access section and the danger
 * zone.
 *
 * OWNER: panel-designer. Split from `panel.js` for §17.10's ~500-line ceiling, the same
 * reason `sources.js`, `pick.js`, `probe.js`, `result.js` and `scenarios.js` are files of
 * their own, and along the same seam: one tab, one screen, one file. It is the last tab
 * that was still living inside the shell.
 *
 * §17.6: every word here comes from strings.js.
 * §17.7: every colour comes from panel.css.
 * §17.8: every message uses a constant from `background/messages.js`.
 *
 * ── The rule this tab is the reason for ─────────────────────────────────────────────
 * Three of its controls are inert, and until M7 all three said why through a hover
 * tooltip on a `disabled` element — which is a reason a mouse can collect and nothing
 * else can, because `disabled` removes the element from the focus order AND stops it
 * dispatching pointer events, so `:focus-within` on the wrapper can never fire. Every
 * inert control on this screen now states its reason as VISIBLE TEXT beside it, in the
 * shape the Pick tab has used since M3. A tooltip is for a control in a dense row with
 * nowhere to put a sentence (§10.2's per-row icon buttons); this screen has room.
 */
import { S } from './strings.js';
import { MSG } from '../background/messages.js';
import { el, clear } from './dom.js';

/**
 * §9.2's checkbox row. `note` is a SECOND help line, for the one case that needs it: a
 * row that is switched off and owes the reason.
 *
 * Exported because `panel.strings.test.js` and the a11y suite both read this shape, and
 * because there is exactly one checkbox-row recipe in the panel.
 */
export function checkRow({ label, help, note, checked, disabled, onChange }) {
  const input = el('input', { type: 'checkbox', disabled: Boolean(disabled) });
  input.checked = Boolean(checked);
  const box = el('span', { class: 'check-box' });
  input.addEventListener('change', () => {
    // Only a real toggle animates — see the --draw note in panel.css.
    box.classList.add('check-box--draw');
    if (onChange) onChange(input.checked);
  });
  return el(
    'label',
    { class: 'check-row' },
    input,
    box,
    el(
      'span',
      { class: 'check-row__text' },
      el('span', { class: 'check-row__label', text: label }),
      help && el('span', { class: 'check-row__help', text: help }),
      note && el('span', { class: 'check-row__help', text: note })
    )
  );
}

function ghost(text, onClick) {
  return el('button', { type: 'button', class: 'btn btn--ghost', text, onClick });
}

/**
 * Draw §10.5 into the three containers `panel.html` gives it.
 *
 * @param {{rows:HTMLElement, companion:HTMLElement, danger:HTMLElement}} dom
 * @param {Object} ctx the panel context, plus `setTab`
 */
export function renderSettingsTab(dom, ctx) {
  const state = ctx.state;
  clear(dom.rows);
  dom.rows.append(
    checkRow({
      label: S.settings.advanced,
      help: S.settings.advancedHelp,
      checked: state.settings.advancedMode,
      onChange: (value) => saveSetting(ctx, { advancedMode: value })
    }),
    checkRow({
      label: S.settings.paranoid,
      help: S.settings.paranoidHelp,
      checked: state.settings.paranoid,
      onChange: (value) => saveSetting(ctx, { paranoid: value })
    }),
    // Deep mode attaches the debugger (§8), which is not built. The reason is the row's
    // second help line rather than a tooltip — see this file's header.
    checkRow({ label: S.deep.label, help: S.deep.help, note: S.notYet, checked: false, disabled: true })
  );

  clear(dom.companion);
  dom.companion.append(
    el(
      'div',
      { class: 'info-row' },
      el('span', { class: 'dot' }),
      el('span', { class: 'check-row__text' }, el('span', { class: 'check-row__label', text: S.companion.disconnected }))
    ),
    el('button', { type: 'button', class: 'btn btn--secondary', disabled: true, text: S.companion.setup }),
    el('p', { class: 'help', text: S.notYet })
  );

  clear(dom.danger);
  dom.danger.append(el('p', { class: 'section-title', text: S.settings.dangerTitle }));
  const nothing = state.changeCount === 0;
  const site = el('button', { type: 'button', class: 'btn btn--secondary', text: S.settings.resetSite, disabled: nothing });
  site.addEventListener('click', () => {
    state.confirm = 'site';
    ctx.setTab('sources');
  });
  dom.danger.append(site);
  // The third inert control on this screen, and the one nobody had noticed: it is
  // switched off when the site has no changes, and said so to nobody at all — not even
  // by tooltip. §1.1 is about a control that is visibly present and silently does
  // nothing, and grey is not a sentence.
  if (nothing) dom.danger.append(el('p', { class: 'help', text: S.settings.nothingToReset }));

  if (state.confirm === 'all') {
    dom.danger.append(
      el('p', { class: 'help', text: S.settings.resetAllConfirm }),
      el(
        'div',
        { class: 'editor__actions' },
        el('button', { type: 'button', class: 'btn btn--secondary', text: S.settings.resetAll, onClick: () => void resetEverything(ctx) }),
        ghost(S.editor.cancel, () => {
          state.confirm = null;
          ctx.rerender();
        })
      )
    );
  } else {
    const all = el('button', { type: 'button', class: 'btn btn--secondary', text: S.settings.resetAll });
    all.addEventListener('click', () => {
      state.confirm = 'all';
      ctx.rerender();
    });
    dom.danger.append(all);
  }
}

/**
 * Deliberately does NOT re-render: the checkbox already shows its own new state
 * natively, and rebuilding it here would cut its own pop animation off mid-flight.
 * The only other surface a setting changes is the Sources tab, which re-renders when
 * the user switches to it.
 */
async function saveSetting(ctx, patch) {
  const res = await ctx.send(MSG.UPDATE_SETTINGS, { patch });
  if (res.ok && res.settings) ctx.state.settings = res.settings;
  else ctx.toast(S.errors.pageBroke, true);
}

/**
 * "Reset everything" (§10.5 danger zone) spans every origin, so it is its own message
 * rather than a loop over RESET_SITE — and it goes through the contract, not around it
 * into chrome.storage, so an MCP agent can do exactly what the human just did (§1.6).
 *
 * The worker deliberately spares `settings` (it holds the companion pairing token, and
 * §10.5's copy never warns that a data reset would unpair the user's AI) and the
 * derived signature cache. The toast reports the counts it actually cleared, and says
 * plainly that only THIS page reloads — the other open tabs are left alone and simply
 * stop receiving edited data.
 */
async function resetEverything(ctx) {
  ctx.state.confirm = null;
  const res = await ctx.send(MSG.RESET_ALL, { tabId: ctx.state.tabId, refresh: true });
  if (!res.ok) {
    ctx.toast(S.errors.pageBroke, true);
    return;
  }
  ctx.state.open = null;
  ctx.state.editing = null;
  const cleared = res.cleared || {};
  const changes = Number(cleared.changes) || 0;
  const presets = Number(cleared.presets) || 0;
  ctx.toast(changes + presets === 0 ? S.settings.resetAllNothing : S.settings.resetAllDone(changes, presets));
  await ctx.refresh();
}
