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
 * Three of its controls were inert, and until M7 all three said why through a hover
 * tooltip on a `disabled` element — which is a reason a mouse can collect and nothing
 * else can, because `disabled` removes the element from the focus order AND stops it
 * dispatching pointer events, so `:focus-within` on the wrapper can never fire. Every
 * inert control on this screen states its reason as VISIBLE TEXT beside it, in the shape
 * the Pick tab has used since M3. A tooltip is for a control in a dense row with nowhere
 * to put a sentence (§10.2's per-row icon buttons); this screen has room.
 *
 * ── M7 addendum: two of those three are no longer inert ─────────────────────────────
 * Deep mode (§8) and the pairing flow (§12.3) were both finished engines behind a
 * checkbox and a button a person could not reach. They are wired here, and each one
 * brought a rule with it:
 *
 *   • Deep mode is PER ORIGIN, never a boolean. §4's setting is `deepModeOrigins:
 *     string[]`, `debuggerEngine.js` watches that key directly, and the box below reads
 *     and writes THIS origin's membership of that list while leaving every other origin
 *     in it exactly where it was. There is no message to the engine: storage is the
 *     contract, which is what makes a person, a second window and an MCP agent unable to
 *     disagree about whether it is on (§1.6).
 *   • Turning it on attaches `chrome.debugger`, which puts Chrome's own "being debugged"
 *     bar across the top of the browser. §8 makes the feature opt-in per site for exactly
 *     that reason, so the tick ASKS first (`S.deep.confirm`) and only the answer attaches
 *     anything. A warning under a checkbox is read after the bar appears, if at all.
 *   • The companion's two facts — `connected` and `paired` — are separate and the dot
 *     needs both. Paired-but-not-connected is the ordinary state of a machine whose
 *     companion is not running; it is not an error, and it must not offer to fix itself
 *     by re-running a pairing that already succeeded (`messages.js`, `GET_COMPANION`).
 *
 * That last one is `companion.js` now: this file crossed §17.10's ceiling the moment
 * §10.5's AI-access section stopped being one disabled button and one sentence.
 */
import { S } from './strings.js';
import { MSG } from '../background/messages.js';
import { el, clear } from './dom.js';
import { renderCompanion } from './companion.js';

/** Focus keys — see `focusKey()` in panel.js. A re-render must not drop the focus. */
const DEEP_FOCUS = 'deep-mode';

/**
 * §9.2's checkbox row. `note` is a SECOND help line, for the one case that needs it: a
 * row that is switched off and owes the reason.
 *
 * Exported because `panel.strings.test.js` and the a11y suite both read this shape, and
 * because there is exactly one checkbox-row recipe in the panel.
 */
export function checkRow({ label, help, note, checked, disabled, focus, onChange }) {
  const input = el('input', { type: 'checkbox', disabled: Boolean(disabled) });
  if (focus) input.dataset.focus = focus;
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

/* ═════════════════════════════ deep mode — §8, §10.5, §4 ═══════════════════════════ */

/**
 * Whether deep mode can mean anything on this tab.
 *
 * `chrome.debugger` attaches to a PAGE, and §4 keys the setting by origin — so a tab
 * showing no web page has no origin to add to the list and nothing to attach to. A new
 * tab, `chrome://extensions`, a blank tab and a PDF viewer all arrive here as either an
 * empty string or a scheme MockLab's content scripts were never injected into.
 *
 * Stated as what IS allowed rather than as a list of what is not: a scheme nobody
 * thought of fails closed, which for a control that attaches a debugger is the only safe
 * direction.
 *
 * @param {string} origin §4's storage-key form, e.g. "https://www.trip.com"
 */
export function deepModeUsable(origin) {
  return /^https?:\/\/[^/]+$/.test(String(origin || ''));
}

/** §4's `deepModeOrigins`, defensively — a settings object may predate the key. */
export function deepOrigins(settings) {
  const list = settings && settings.deepModeOrigins;
  return Array.isArray(list) ? list.filter((entry) => typeof entry === 'string') : [];
}

/**
 * The new `deepModeOrigins` after this origin is switched on or off.
 *
 * A LIST OPERATION, and that is the whole point: `UPDATE_SETTINGS` merges the patch key
 * by key, so whatever this returns REPLACES the stored array. Writing `[origin]` — or a
 * boolean — would silently turn deep mode off for every other site the person had
 * enabled it on, and the only symptom would be a debugging bar that stopped appearing
 * somewhere else entirely.
 *
 * @param {string[]} origins what is stored now
 * @param {string} origin the site the checkbox is about
 * @param {boolean} on
 * @returns {string[]} always an array, with every OTHER origin preserved in order
 */
export function deepOriginsPatch(origins, origin, on) {
  const kept = deepOrigins({ deepModeOrigins: origins }).filter((entry) => entry !== origin);
  return on ? [...kept, origin] : kept;
}

/** §10.5's third row. Per origin, and it asks before it attaches anything. */
function deepRow(ctx) {
  const origin = String(ctx.state.origin || '');
  const usable = deepModeUsable(origin);
  const on = usable && deepOrigins(ctx.state.settings).includes(origin);
  return checkRow({
    label: S.deep.label,
    help: S.deep.help,
    // A control that is switched off owes the reason as text, not as grey (§1.1).
    note: usable ? null : S.deep.noSite,
    checked: on,
    disabled: !usable,
    focus: DEEP_FOCUS,
    onChange: (wanted) => {
      if (!wanted) {
        // Turning it OFF needs no confirmation and no re-render: the box already shows
        // its own new state, and rebuilding it here would cut its pop animation off.
        void setDeepMode(ctx, false);
        return;
      }
      // Turning it ON does. The re-render puts the tick back down, which is true —
      // nothing is attached until the question below is answered.
      ctx.state.deepAsk = true;
      ctx.rerender();
    }
  });
}

/** The last word before Chrome's debugging bar appears. §11's `deep.confirm`. */
function deepConfirm(ctx) {
  return el(
    'div',
    { class: 'deep-confirm', role: 'group', 'aria-label': S.deep.label },
    // `role="status"` and not `alert`: this is a question the person just asked for by
    // ticking a box, so it is announced politely after their own action rather than
    // interrupting. The focus stays on the box, and this is the next thing in the order.
    el('p', { class: 'help', role: 'status', text: S.deep.confirm }),
    el(
      'div',
      { class: 'editor__actions' },
      el('button', { type: 'button', class: 'btn btn--primary', text: S.deep.turnOn, onClick: () => void setDeepMode(ctx, true) }),
      ghost(S.editor.cancel, () => {
        ctx.state.deepAsk = false;
        ctx.rerender();
      })
    )
  );
}

/**
 * Write this origin's membership of §4's list, and then say what the STORE came back
 * with rather than what was asked for.
 *
 * The difference matters: a worker that refused, clamped or dropped the patch would
 * otherwise be toasted as a success while the checkbox — which is drawn from the same
 * answer — shows the opposite. Reporting the answer means the sentence and the tick can
 * never disagree.
 *
 * The list is read FRESH first, and not taken from `state.settings`, because the patch
 * REPLACES the whole array: this panel's copy was loaded at boot, and three things edit
 * that key behind it — a second window's Settings tab, an MCP agent, and
 * `debuggerEngine.js` itself, which removes an origin whenever an attach it did not ask
 * for goes away. Patching from a stale copy would silently switch deep mode off for
 * whichever site had changed hands since, and the only symptom would be a debugging bar
 * that stopped appearing somewhere else entirely.
 */
async function setDeepMode(ctx, on) {
  const origin = String(ctx.state.origin || '');
  ctx.state.deepAsk = false;
  if (!deepModeUsable(origin)) {
    ctx.rerender();
    return;
  }
  const fresh = await ctx.send(MSG.GET_SETTINGS, {});
  if (fresh && fresh.ok && fresh.settings) ctx.state.settings = fresh.settings;
  const patch = { deepModeOrigins: deepOriginsPatch(deepOrigins(ctx.state.settings), origin, on) };
  const res = await ctx.send(MSG.UPDATE_SETTINGS, { patch });
  if (!res || !res.ok || !res.settings) {
    ctx.toast(S.errors.pageBroke, true);
    ctx.rerender();
    return;
  }
  ctx.state.settings = res.settings;
  ctx.toast(deepOrigins(res.settings).includes(origin) ? S.deep.on : S.deep.off);
  ctx.rerender();
}

/* ══════════════════════════════════ the screen ═════════════════════════════════════ */

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
    deepRow(ctx)
  );
  if (state.deepAsk && deepModeUsable(state.origin)) dom.rows.append(deepConfirm(ctx));

  clear(dom.companion);
  renderCompanion(dom.companion, ctx);

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
