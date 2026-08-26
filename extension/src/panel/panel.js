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
import { MSG, PROBE_MSG } from '../background/messages.js';
import { el, clear, ICON, wireTips } from './dom.js';
import { renderSources } from './sources.js';
import { renderPickTab, pickingChrome, cancelPick, loadPick } from './pick.js';
import { EMPTY_PROBE, VIEW, readProbe } from './probe.js';
import { EMPTY_SCENARIOS, loadScenarios, renderScenariosTab } from './scenarios.js';
import { NO_ANSWER, forgetLostLinks } from './links.js';
import { renderSettingsTab } from './settings.js';

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
    // A worker that answered nothing at all — no handler for this type in this build.
    // `links.js` is the one caller that draws a conclusion from that rather than from a
    // named refusal, so the two read the same constant (see NO_ANSWER there).
    return res || { ok: false, reason: NO_ANSWER };
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

const TAB_ORDER = ['pick', 'sources', 'scenarios', 'settings'];

/**
 * Which tab is showing, said in the three places that have to agree: the sliding thumb
 * (§9.2), the hidden/shown panels, and `aria-selected`.
 *
 * The third one is not decoration. §10's tab strip is four `<input type="radio">` given
 * `role="tab"`, and an explicit role REPLACES the native semantics — so `checked` stops
 * being announced as anything and `aria-selected`, which the tab role is the one that
 * carries, was on none of them. A screen reader met four tabs with no way to tell which
 * one it was in, on the control that navigates the whole product.
 */
function markTabs(name) {
  dom.tabs.style.setProperty('--seg-x', String(Math.max(0, TAB_ORDER.indexOf(name))));
  for (const tab of TAB_ORDER) {
    const input = document.getElementById(`tab-${tab}`);
    if (input) input.setAttribute('aria-selected', String(tab === name));
    document.getElementById(`panel-${tab}`).classList.toggle('hidden', tab !== name);
  }
}

function setTab(name) {
  state.tab = name;
  markTabs(name);
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

/* ─────────────────────────────────────────────────────────────────── rendering */

/**
 * Where the focus is, in a form that survives the DOM being thrown away.
 *
 * An `id` was the only key this understood, and only the panel's text inputs and the value
 * picker's radios have one — so every OTHER control dropped the focus on the floor the
 * moment it did anything. Operating the §10.2 tree from a keyboard meant: Tab to a source,
 * press Space, and land back on <body> with the tree open and no way into it but tabbing
 * from the top again. §16 M7 asks that every control be keyboard-REACHABLE, and one you
 * can reach once per press is not. `data-focus` is the same key for a control that should
 * not carry an id — an id is a document-wide anchor, and a tree row's key has to carry a
 * source and a field, which contain characters that make a poor one.
 */
function focusKey(node) {
  if (!node) return null;
  if (node.id) return `#${CSS.escape(node.id)}`;
  const key = node.dataset && node.dataset.focus;
  return key ? `[data-focus="${CSS.escape(key)}"]` : null;
}

/**
 * A full re-render of the active tab. Cheap at this size, and it removes a whole class
 * of bug (a stale row surviving a store update). The one thing it would otherwise cost
 * is the caret in whatever the user is typing in, so that is carried across by hand.
 */
function render() {
  const active = document.activeElement;
  const focusId = focusKey(active);
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
  if (state.tab === 'settings') renderSettingsTab({ rows: dom.settingsRows, companion: dom.settingsCompanion, danger: dom.settingsDanger }, ctx);

  if (focusId) {
    const next = document.querySelector(focusId);
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

const ctx = { state, send, refresh, toast, rerender: render, setTab };

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
    else if (matches(MSG.PICK_CHANGED) || matches(PROBE_MSG.PROBE_CHANGED)) void refresh();
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
  // Which language this panel is in and which way it runs, both from the one file a
  // translator is promised (§9.2). `panel.html` states neither: `dir="ltr"` written into
  // the markup is what made "RTL-ready" untrue while every rule in panel.css was built
  // on logical properties and a `--dir` flip nothing could flip.
  document.documentElement.lang = S.meta.lang;
  document.documentElement.dir = S.meta.dir;
  fillStatic();
  markTabs(state.tab);
  document.getElementById('search-icon').append(ICON.search());
  wireTabs();
  wireEvents();
  // WCAG 2.2 1.4.13's dismissible clause, for every tooltip at once — see dom.js.
  wireTips();
  watchProbe();
  await loadSettings();
  await refresh();
}

void boot();
