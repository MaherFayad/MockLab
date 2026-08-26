/**
 * Side panel UI logic (PLAN.md §10). No framework, no build step.
 *
 * OWNER: panel-designer.
 *
 * Rule §17.6: every user-visible string comes from strings.js — including the ones in
 *   panel.html, which are `data-s` keys filled in by fillStatic() below.
 * Rule §17.7: every colour comes from panel.css.
 * Rule §17.8: every message uses a constant from ../background/messages.js.
 */
import { S } from './strings.js';
import { MSG } from '../background/messages.js';
import { el, clear, ICON, withTip } from './dom.js';
import { renderSources } from './sources.js';
import { renderPickTab, pickingChrome, cancelPick, loadPick } from './pick.js';
import { EMPTY_PROBE, VIEW, readProbe } from './probe.js';
import { EMPTY_SCENARIOS, loadScenarios, renderScenariosTab } from './scenarios.js';
import { forgetLostLinks } from './links.js';

const TOAST_MS = 3200;

/**
 * How often the panel re-reads a RUNNING probe on its own (§10.1C: "NEVER let the user
 * think it's stuck").
 *
 * The worker broadcasts on every state change and that is what normally drives this
 * screen. This is the backstop for the two ways that promise can quietly break — an
 * evicted service worker, and a broadcast this panel simply did not receive — because
 * the failure mode is a card that says "Double-checking…" over a probe that stopped
 * running, and it is indistinguishable from a slow one. 1200ms is well under the time
 * one reload+settle takes (§7.3 caps it at 8s), so the picture is never far behind.
 */
const PROBE_POLL_MS = 1200;

const state = {
  tab: 'pick',
  tabId: null,
  origin: '',
  hostname: '',
  faviconUrl: '',
  captured: false,
  sources: [],
  changes: [],
  changeCount: 0,
  /** §10.1's three states are a function of this alone — see pick.js. */
  pick: { picking: false, element: null, candidates: [] },
  /** Proven Links for this origin (§10.1A). */
  bindings: [],
  /** §10.1's progress card, State D and the failure cards — see probe.js. */
  probe: { ...EMPTY_PROBE },
  /** §10.4 — see scenarios.js. `ready` stays null until the worker answers. */
  scenarios: { ...EMPTY_SCENARIOS },
  /**
   * §1.1's third link state, observed rather than stored — see links.js. `lostLinks`
   * holds the Links whose elements a §10.3 highlight could not find ON THIS PAGE LOAD,
   * and is emptied whenever the tab loads a new document; `canHighlight` goes false only
   * if the worker does not answer a highlight at all.
   */
  lostLinks: new Set(),
  canHighlight: true,
  settings: { advancedMode: false, paranoid: false },
  query: '',
  open: null,
  body: undefined,
  expanded: new Set(),
  editing: null,
  confirm: null, // 'site' | 'all'
  restoreFocus: false
};

const dom = {
  tabs: document.getElementById('tabs'),
  sitebar: document.getElementById('sitebar'),
  pickPanel: document.getElementById('panel-pick'),
  sourceList: document.getElementById('source-list'),
  scenarioBody: document.getElementById('scenario-body'),
  settingsRows: document.getElementById('settings-rows'),
  settingsCompanion: document.getElementById('settings-companion'),
  settingsDanger: document.getElementById('settings-danger'),
  toastHost: document.getElementById('toast-host'),
  search: document.getElementById('source-search')
};

/* ────────────────────────────────────────────────────────── strings & messaging */

/** Resolve "sources.fields" against strings.js. */
function lookup(key) {
  return key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), S);
}

/** Fill every data-s / data-s-placeholder in panel.html. §17.6 covers the markup too. */
function fillStatic(root = document) {
  for (const node of root.querySelectorAll('[data-s]')) {
    const value = lookup(node.dataset.s);
    if (typeof value === 'string') node.textContent = value;
  }
  for (const node of root.querySelectorAll('[data-s-placeholder]')) {
    const value = lookup(node.dataset.sPlaceholder);
    if (typeof value === 'string') node.placeholder = value;
  }
}

async function send(type, payload = {}) {
  try {
    const res = await chrome.runtime.sendMessage({ type, payload });
    return res || { ok: false, reason: 'no-answer' };
  } catch (err) {
    return { ok: false, reason: String(err && err.message) };
  }
}

function toast(text, danger = false) {
  clear(dom.toastHost);
  const node = el('div', { class: 'toast' + (danger ? ' toast--danger' : ''), role: 'status', text });
  dom.toastHost.append(node);
  setTimeout(() => node.remove(), TOAST_MS);
}

/* ──────────────────────────────────────────────────────────────────── the shell */

function setTab(name) {
  state.tab = name;
  const order = ['pick', 'sources', 'scenarios', 'settings'];
  dom.tabs.style.setProperty('--seg-x', String(Math.max(0, order.indexOf(name))));
  for (const tab of order) {
    document.getElementById(`panel-${tab}`).classList.toggle('hidden', tab !== name);
  }
  render();
}

function wireTabs() {
  for (const opt of dom.tabs.querySelectorAll('.segmented__opt')) {
    const label = opt.querySelector('label');
    const icon = ICON[opt.dataset.icon];
    if (icon) label.prepend(icon());
    const input = opt.querySelector('input');
    input.addEventListener('change', () => input.checked && setTab(input.value));
  }
}

/* ─────────────────────────────────────────────────── site bar — §10, §1.5, §10.6 */

function renderSiteBar() {
  clear(dom.sitebar);
  if (state.confirm === 'site') {
    dom.sitebar.append(
      el('span', { class: 'sitebar__host help', text: S.site.resetConfirm }),
      ghost(S.editor.cancel, () => {
        state.confirm = null;
        render();
      }),
      danger(S.site.reset, resetSite)
    );
    return;
  }

  const icon = el('span', { class: 'sitebar__icon' });
  if (state.faviconUrl) {
    const img = el('img', { src: state.faviconUrl, alt: '', width: 16, height: 16 });
    img.addEventListener('error', () => img.remove());
    icon.append(img);
  } else {
    // No favicon: a monogram of the site's first letter. An IP address has no letter to
    // take, and a bare digit beside the "3 changes on" chip would read as a count — so
    // that case falls back to a globe instead.
    const letter = (state.hostname.replace(/^www\./, '').match(/[a-z]/i) || [])[0];
    if (letter) icon.textContent = letter;
    else icon.append(ICON.globe());
  }
  dom.sitebar.append(icon);
  dom.sitebar.append(
    el('span', { class: 'sitebar__host truncate', text: state.hostname || S.site.noPage })
  );
  if (state.changeCount > 0) {
    dom.sitebar.append(el('span', { class: 'chip chip--changed sitebar__count', text: S.site.changes(state.changeCount) }));
    dom.sitebar.append(
      danger(S.site.reset, () => {
        state.confirm = 'site';
        render();
      })
    );
  }
}

function ghost(text, onClick) {
  return el('button', { type: 'button', class: 'btn btn--ghost', text, onClick });
}

function danger(text, onClick) {
  return el('button', { type: 'button', class: 'btn btn--danger', text, onClick });
}

async function resetSite() {
  state.confirm = null;
  const res = await send(MSG.RESET_SITE, { tabId: state.tabId });
  if (!res.ok) {
    toast(S.errors.pageBroke, true);
    return;
  }
  state.open = null;
  state.editing = null;
  await refresh();
}

/* ─────────────────────────────────────────────────────── tabs: pick & scenarios */

/** §10.4 — the whole tab lives in scenarios.js. */
function renderScenarios() {
  renderScenariosTab(dom.scenarioBody, ctx);
}

/* ───────────────────────────────────────────────────────────── settings — §10.5 */

function checkRow({ label, help, checked, disabled, onChange }) {
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
      help && el('span', { class: 'check-row__help', text: help })
    )
  );
}

function renderSettings() {
  clear(dom.settingsRows);
  dom.settingsRows.append(
    checkRow({
      label: S.settings.advanced,
      help: S.settings.advancedHelp,
      checked: state.settings.advancedMode,
      onChange: (value) => saveSetting({ advancedMode: value })
    }),
    checkRow({
      label: S.settings.paranoid,
      help: S.settings.paranoidHelp,
      checked: state.settings.paranoid,
      onChange: (value) => saveSetting({ paranoid: value })
    }),
    // Deep mode attaches the debugger (§8) and lands at §16 M7.
    withTip(checkRow({ label: S.deep.label, help: S.deep.help, checked: false, disabled: true }), [S.notYet], { up: true })
  );

  clear(dom.settingsCompanion);
  dom.settingsCompanion.append(
    el(
      'div',
      { class: 'info-row' },
      el('span', { class: 'dot' }),
      el('span', { class: 'check-row__text' }, el('span', { class: 'check-row__label', text: S.companion.disconnected }))
    ),
    withTip(el('button', { type: 'button', class: 'btn btn--secondary', disabled: true, text: S.companion.setup }), [S.notYet], { up: true })
  );

  clear(dom.settingsDanger);
  dom.settingsDanger.append(el('p', { class: 'section-title', text: S.settings.dangerTitle }));
  const site = el('button', { type: 'button', class: 'btn btn--secondary', text: S.settings.resetSite, disabled: state.changeCount === 0 });
  site.addEventListener('click', () => {
    state.confirm = 'site';
    setTab('sources');
  });
  dom.settingsDanger.append(site);

  if (state.confirm === 'all') {
    dom.settingsDanger.append(
      el('p', { class: 'help', text: S.settings.resetAllConfirm }),
      el(
        'div',
        { class: 'editor__actions' },
        el('button', { type: 'button', class: 'btn btn--secondary', text: S.settings.resetAll, onClick: resetEverything }),
        ghost(S.editor.cancel, () => {
          state.confirm = null;
          render();
        })
      )
    );
  } else {
    const all = el('button', { type: 'button', class: 'btn btn--secondary', text: S.settings.resetAll });
    all.addEventListener('click', () => {
      state.confirm = 'all';
      render();
    });
    dom.settingsDanger.append(all);
  }
}

/**
 * Deliberately does NOT re-render: the checkbox already shows its own new state
 * natively, and rebuilding it here would cut its own pop animation off mid-flight.
 * The only other surface a setting changes is the Sources tab, which re-renders when
 * the user switches to it.
 */
async function saveSetting(patch) {
  const res = await send(MSG.UPDATE_SETTINGS, { patch });
  if (res.ok && res.settings) state.settings = res.settings;
  else toast(S.errors.pageBroke, true);
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
async function resetEverything() {
  state.confirm = null;
  const res = await send(MSG.RESET_ALL, { tabId: state.tabId, refresh: true });
  if (!res.ok) {
    toast(S.errors.pageBroke, true);
    return;
  }
  state.open = null;
  state.editing = null;
  const cleared = res.cleared || {};
  const changes = Number(cleared.changes) || 0;
  const presets = Number(cleared.presets) || 0;
  toast(changes + presets === 0 ? S.settings.resetAllNothing : S.settings.resetAllDone(changes, presets));
  await refresh();
}

/* ─────────────────────────────────────────────────────────────────── rendering */

/**
 * A full re-render of the active tab. Cheap at this size, and it removes a whole class
 * of bug (a stale row surviving a store update). The one thing it would otherwise cost
 * is the caret in whatever the user is typing in, so that is carried across by hand.
 */
function render() {
  const active = document.activeElement;
  const focusId = active && active.id ? active.id : null;
  // Reading selectionStart throws InvalidStateError on input types that have no
  // selection (checkbox, radio), and those are focused all over this panel.
  let caret = null;
  try {
    if (active && typeof active.selectionStart === 'number') caret = active.selectionStart;
  } catch {
    caret = null;
  }
  state.restoreFocus = Boolean(focusId);

  renderSiteBar();
  // Not inside renderPickTab: the dim outlives the tab. Someone can switch to Sources
  // while the picker waits for a click on the page, and the panel must still look like
  // it is waiting (§10.1B).
  pickingChrome(state.pick.picking);
  if (state.tab === 'pick') renderPickTab(dom.pickPanel, ctx);
  if (state.tab === 'sources') renderSources(dom.sourceList, ctx);
  if (state.tab === 'scenarios') renderScenarios();
  if (state.tab === 'settings') renderSettings();

  if (focusId) {
    const next = document.getElementById(focusId);
    if (next && next !== document.activeElement) {
      next.focus();
      if (caret !== null && typeof next.setSelectionRange === 'function') {
        try {
          next.setSelectionRange(caret, caret);
        } catch {
          /* an input type that has no selection — nothing to restore */
        }
      }
    }
  }
  state.restoreFocus = false;
}

const ctx = { state, send, refresh, toast, rerender: render };

/* ─────────────────────────────────────────────────────────────────── data flow */

async function refresh() {
  const site = await send(MSG.GET_SITE_STATE, {});
  if (site.ok) {
    if (site.origin !== state.origin) {
      state.open = null;
      state.editing = null;
      state.body = undefined;
      // A different site's Links were never the ones a highlight failed to find here.
      forgetLostLinks(ctx);
    }
    state.tabId = site.tabId;
    state.origin = site.origin;
    state.hostname = site.hostname || '';
    state.faviconUrl = site.faviconUrl || '';
    state.captured = Boolean(site.captured);
    state.changes = (site.changes || []).filter((change) => !change.probe);
    state.changeCount = site.changeCount || 0;
  }
  const list = await send(MSG.LIST_SOURCES, { tabId: state.tabId });
  if (list.ok) state.sources = list.sources || [];
  const links = await send(MSG.GET_BINDINGS, { tabId: state.tabId });
  state.bindings = links.ok ? links.bindings || [] : [];
  await loadScenarios(ctx);
  await loadPick(ctx);
  await readProbe(ctx);
  render();
}

async function loadSettings() {
  const res = await send(MSG.GET_SETTINGS, {});
  if (res.ok && res.settings) state.settings = res.settings;
}

function wireEvents() {
  chrome.runtime.onMessage.addListener((message) => {
    const type = message && message.type;
    // `matches` and not `===` on purpose: a type this build's messages.js does not
    // define yet is `undefined`, and `undefined === undefined` would make every
    // typeless message look like that broadcast.
    const matches = (constant) => typeof constant === 'string' && type === constant;
    if (matches(MSG.SOURCES_CHANGED) || matches(MSG.CHANGES_CHANGED)) void refresh();
    // §10.4's store, changed anywhere — this panel, another window's, or an agent over
    // MCP (§1.6). Data-free like the others; the panel re-reads.
    else if (matches(MSG.PRESETS_CHANGED)) void refresh();
    // Pick mode can also be entered or cancelled from somewhere that is not this panel
    // — the page's own Escape key, or an agent over MCP (§1.6) — so the tab follows the
    // worker rather than only its own clicks. The same is true of a probe (§12.4 #5).
    else if (matches(MSG.PICK_CHANGED) || matches(MSG.PROBE_CHANGED)) void refresh();
    return false;
  });
  chrome.tabs.onActivated.addListener(() => void refresh());
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (tabId !== state.tabId) return;
    // A new document makes every "these elements could not be found" observation obsolete:
    // it was about a page that no longer exists (§1.1 — a Stale chip has to be about now).
    if (info.status === 'loading' || info.url) forgetLostLinks(ctx);
    if (info.status === 'complete' || info.url) void refresh();
  });
  dom.search.addEventListener('input', () => {
    state.query = dom.search.value;
    render();
  });
  // §11's `pick.picking` promises "(Esc to cancel)". The person's last click was in the
  // PANEL, so that is where the keystroke usually lands — the page's own Escape handler
  // (§6.1) would never see it, and a promise the product only keeps half the time is
  // the kind of small lie §1.1 is about.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.pick.picking) void cancelPick(ctx);
  });
}

/**
 * The anti-"is it stuck?" backstop described at PROBE_POLL_MS. Runs only while a probe
 * is actually running, so an idle panel sends nothing at all.
 */
function watchProbe() {
  setInterval(() => {
    if (state.probe && state.probe.view === VIEW.RUNNING) void refresh();
  }, PROBE_POLL_MS);
}

async function boot() {
  fillStatic();
  dom.tabs.style.setProperty('--seg-x', '0');
  document.getElementById('search-icon').append(ICON.search());
  wireTabs();
  wireEvents();
  watchProbe();
  await loadSettings();
  await refresh();
}

void boot();
