/**
 * Service worker entry — wires the background modules together (PLAN.md §2, §2.1).
 *
 * OWNER: shared. Each agent adds only the wiring for its own module and never
 * rewrites another agent's block.
 *
 * M0 does two things, both of which must work before anything else is built: open the
 * side panel from the toolbar icon, and clear crashed probe state on startup
 * (PLAN.md §17.5 — probe:true Changes are deleted on SW startup, so a browser crash
 * mid-probe can never leave a site silently mocked). Neither may be weakened.
 *
 * M1 adds the capture pipeline below: the Port every page agent connects on, the
 * per-tab CapturedRequest store, the compiled match list push, and the one-shot
 * messages the side panel and (from M6) the MCP tools read sources through.
 *
 * M2 adds the Changes engine's wiring: the toolbar badge (badge.js), the Change CRUD
 * message surface (changesApi.js), and the single storage listener that keeps the
 * in-page match list, the badge and every open panel in step after any write — whether
 * it came from this panel, another window's panel, or an MCP agent (PLAN.md §1.6).
 *
 * M3 adds pick mode's wiring (pickApi.js): the route from the panel to the page agent's
 * picker, and back with one element that candidates.js turns into §6.3's guesses.
 *
 * M4 adds the probe's wiring (probe.js): the panel's START/CANCEL/GET, the snapshot
 * request that goes out the moment a reloaded document says hello, and the answer back.
 */

import { PORT_NAME, PORT_MSG, MSG } from './messages.js';
import { normalizeRaw, friendlyName, compileMatchList } from './signatures.js';
import { originOf, rememberSignature, groupChangesBySignature, countActiveChanges } from './ruleStore.js';
import { parsePath, countLeaves, getByPath } from '../shared/jsonpath.js';
import { createChangesApi, CHANGE_MESSAGE_TYPES } from './changesApi.js';
import { createPickApi, PICK_MESSAGE_TYPES } from './pickApi.js';
import { createProbeApi, PROBE_MESSAGE_TYPES, PROBE_MSG, PROBE_PORT_MSG, sweepProbeChanges } from './probe.js';
import { installBadgeListeners, refreshAllBadges, refreshBadgesForOrigin } from './badge.js';

/**
 * Toolbar icon opens the side panel (PLAN.md §3).
 *
 * Deliberately NOT optional-chained. chrome.sidePanel is undefined unless the
 * "sidePanel" permission is present, and `chrome.sidePanel?.setPanelBehavior(...)`
 * short-circuits to undefined without throwing — the panel silently never opens and
 * chrome://extensions stays clean. If this namespace is ever missing again, it must
 * be loud.
 */
if (chrome.sidePanel) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[MockLab] sidePanel.setPanelBehavior failed', err));
} else {
  console.error(
    '[MockLab] chrome.sidePanel is unavailable — the "sidePanel" permission is missing ' +
      'from manifest.json. The toolbar icon will not open the panel.'
  );
}

/**
 * PLAN.md §7.1 / §17.5. The sweep moved into `probeChanges.js` at M4, beside the CLEANUP
 * that is §17.5's other half. What stays here is the part that matters most: the BARE
 * call, at module top level — `onStartup` does not fire after a crash, and a crash is the
 * case this exists for. Proved in a real browser at M0, unchanged since.
 */
chrome.runtime.onStartup?.addListener(sweepProbeChanges);
chrome.runtime.onInstalled?.addListener(sweepProbeChanges);
void sweepProbeChanges();

/**
 * The badge is browser state, not worker state, so a cold start must repaint it — after
 * the probe sweep above, which may itself have emptied a site (PLAN.md §1.5, §17.5).
 * The bare call matters more than the listeners: it is what runs when an evicted worker
 * is woken by anything at all.
 */
installBadgeListeners();
chrome.runtime.onStartup?.addListener(refreshAllBadges);
chrome.runtime.onInstalled?.addListener(refreshAllBadges);
void refreshAllBadges();

/* ==========================================================================
 * M1 — capture pipeline (PLAN.md §5, §5.2, §10.2).  OWNER: interceptor-engineer.
 * ========================================================================== */

/** @typedef {import('./messages.js').CapturedRequest} CapturedRequest */

/** PLAN.md §4: captured requests are session-only, max 200 per tab, LRU-evicted. */
const MAX_SOURCES_PER_TAB = 200;
/** PLAN.md §12.2 throttles `captured` events to 2/s. The panel re-reads on each one. */
const NOTIFY_INTERVAL_MS = 500;

/** @type {Map<number, {url:string, origin:string, loadId:string|null, softNavs:number, sources:Map<string, CapturedRequest>}>} */
const tabState = new Map();
/** @type {Map<number, Set<chrome.runtime.Port>>} */
const tabPorts = new Map();
/** @type {Map<number, number>} */
const lastNotifyAt = new Map();
/** @type {Map<number, ReturnType<typeof setTimeout>>} */
const pendingNotify = new Map();

function stateFor(tabId, url) {
  let state = tabState.get(tabId);
  if (!state) {
    state = { url: url || '', origin: originOf(url || ''), loadId: null, softNavs: 0, sources: new Map() };
    tabState.set(tabId, state);
  }
  return state;
}

/**
 * Tell the panel something moved. Throttled, and deliberately data-free: the payload
 * can never go stale because there is no payload — the panel re-reads LIST_SOURCES.
 */
function notifyPanel(tabId, reason) {
  const send = () => {
    lastNotifyAt.set(tabId, Date.now());
    pendingNotify.delete(tabId);
    chrome.runtime
      .sendMessage({ type: MSG.SOURCES_CHANGED, payload: { tabId, reason } })
      .catch(() => {
        /* no panel open — expected, not an error */
      });
  };
  const elapsed = Date.now() - (lastNotifyAt.get(tabId) || 0);
  if (elapsed >= NOTIFY_INTERVAL_MS) {
    send();
    return;
  }
  if (pendingNotify.has(tabId)) return;
  pendingNotify.set(tabId, setTimeout(send, NOTIFY_INTERVAL_MS - elapsed));
}

/* ------------------------------------------------------------------ match list */

/**
 * Compile this origin's enabled Changes into the synchronous match list the MAIN
 * world evaluates (PLAN.md §5.2 final paragraph) and push it down every live Port.
 */
async function pushMatchList(tabId) {
  try {
    const state = tabState.get(tabId);
    const ports = tabPorts.get(tabId);
    if (!state || !ports || !ports.size) return;
    const groups = await groupChangesBySignature(state.origin, parsePath);
    const entries = compileMatchList(groups);
    for (const port of ports) {
      try {
        port.postMessage({ type: PORT_MSG.MATCH_LIST, payload: { entries } });
      } catch {
        /* the port died between the check and the send */
      }
    }
  } catch (err) {
    console.error('[MockLab] pushMatchList failed', err);
  }
}

/**
 * A Change (or scenario, or reset) landed in storage. ONE listener does all three
 * downstream jobs, so they can never disagree about what the store now says:
 *   1. re-push the compiled match list to every tab on that origin
 *   2. recompute that origin's toolbar badge (§1.5)
 *   3. tell every open panel to re-read (§1.6 — an agent's change shows up in the
 *      panel within a second, and the other way round)
 *
 * It fires for writes made anywhere: this worker, a second window's panel, or the MCP
 * bridge at M6 — chrome.storage is the shared source of truth for all of them.
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const origins = new Set();
  for (const key of Object.keys(changes)) {
    if (key.startsWith('changes:')) origins.add(key.slice('changes:'.length));
  }
  if (!origins.size) return;

  for (const [tabId, state] of tabState) {
    if (origins.has(state.origin)) pushMatchList(tabId);
  }
  for (const origin of origins) {
    void refreshBadgesForOrigin(origin);
    void notifyChanges(origin);
  }
});

/** Data-free by design: the panel re-reads, so this event can never go stale. */
async function notifyChanges(origin) {
  try {
    const count = await countActiveChanges(origin);
    await chrome.runtime.sendMessage({ type: MSG.CHANGES_CHANGED, payload: { origin, count } });
  } catch {
    /* no panel open — expected, not an error */
  }
}

/* -------------------------------------------------------------------- capture */

/** @param {number} tabId @param {import('./messages.js').RawCapture} raw */
async function onCaptured(tabId, raw) {
  if (!raw || typeof raw.url !== 'string') return;
  const state = tabState.get(tabId);
  if (!state) return;

  const signature = await normalizeRaw(raw);

  /** @type {CapturedRequest & {fields:number}} */
  const record = {
    sigId: signature.sigId,
    signature,
    url: raw.url,
    status: Number(raw.status) || 0,
    contentType: raw.contentType || '',
    body: raw.body,
    bodyBytes: Number(raw.bodyBytes) || 0,
    ts: Number(raw.ts) || Date.now(),
    via: raw.via || 'other',
    mocked: Boolean(raw.mocked),
    changeDropped: Boolean(raw.changeDropped),
    // Derived cache, not part of the §4 typedef: the panel's "{n} fields" meta row and
    // the MCP list_sources `fields` field. Counted once here, never on every read.
    fields: countFields(raw.body)
  };

  // Re-capturing the same signature UPDATES the entry — it never appends a second one.
  // That is what keeps SPA navigation from producing duplicate sources (§16 M1 DoD).
  state.sources.delete(record.sigId);
  state.sources.set(record.sigId, record);
  while (state.sources.size > MAX_SOURCES_PER_TAB) {
    state.sources.delete(state.sources.keys().next().value);
  }

  await rememberSignature(state.origin, signature);
  notifyPanel(tabId, 'captured');
}

/**
 * The "{n} fields" the Sources tab prints (§10.2) and `list_sources` returns (§12.4 #2):
 * every leaf field this source holds, counted whole.
 *
 * It used to be `enumeratePaths(body).length`, which stops at §5.4's default depth 12 and
 * 5000 paths — so a source with 3600 fields was announced as having 2400, while candidate
 * discovery searched it to depth 24 (Deviation 32) and could offer the user a field the
 * same screen had left out of the count. A count that truncates is a claim about the data
 * made false by an invisible detail, and counting at the search's bounds would only move
 * that boundary. The two numbers answer different questions and may differ in exactly one
 * direction: `fields` is what the source HOLDS, `searched.complete` (candidates.js) is how
 * much of it MockLab LOOKED at. `{__unparsed}` bodies (§5.1.4) hold no addressable field
 * at all, so they count zero and travel with `unparsed:true` beside them.
 *
 * @param {any} body
 * @returns {number}
 */
function countFields(body) {
  try {
    if (!body || typeof body !== 'object' || body.__unparsed) return 0;
    return countLeaves(body);
  } catch {
    return 0;
  }
}

/** @param {CapturedRequest & {fields?:number}} record */
function toSummary(record) {
  return {
    sigId: record.sigId,
    name: friendlyName(record.signature),
    method: record.signature.method,
    urlPattern: record.signature.urlPattern,
    ...(record.signature.gqlOperation ? { gqlOperation: record.signature.gqlOperation } : {}),
    url: record.url,
    via: record.via,
    fields: record.fields || 0,
    status: record.status,
    bodyBytes: record.bodyBytes,
    lastSeenTs: record.ts,
    mocked: record.mocked,
    changeDropped: Boolean(record.changeDropped),
    unparsed: Boolean(record.body && record.body.__unparsed)
  };
}

/* ----------------------------------------------------------------------- ports */

function handlePortMessage(tabId, message) {
  if (!message || typeof message.type !== 'string') return;
  switch (message.type) {
    case PORT_MSG.HELLO: {
      const payload = message.payload || {};
      const state = stateFor(tabId, payload.url);
      const isNewDocument = payload.loadId && payload.loadId !== state.loadId;
      if (isNewDocument) {
        state.sources.clear();
        state.softNavs = 0;
        state.loadId = payload.loadId;
      }
      state.url = payload.url || state.url;
      state.origin = payload.origin || originOf(state.url);
      pushMatchList(tabId);
      if (isNewDocument) {
        // The captures this tab's candidates point at have just been cleared.
        pickApi.onNewDocument(tabId);
        // A running probe is waiting for exactly this document (§7.3).
        probeApi.onNewDocument(tabId);
        notifyPanel(tabId, 'reset');
      }
      break;
    }
    case PORT_MSG.CAPTURED:
      onCaptured(tabId, message.payload).catch((err) =>
        console.error('[MockLab] capture failed', err)
      );
      break;
    case PORT_MSG.PICKED:
      pickApi.onPicked(tabId, message.payload);
      break;
    case PROBE_PORT_MSG.RESULT:
      probeApi.onProbeResult(tabId, message.payload);
      break;
    case PORT_MSG.SOFT_NAV: {
      const state = tabState.get(tabId);
      if (!state) break;
      state.softNavs += 1;
      if (message.payload && message.payload.url) state.url = message.payload.url;
      notifyPanel(tabId, 'softNav');
      break;
    }
    default:
      break;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  const tabId = port.sender && port.sender.tab && port.sender.tab.id;
  if (typeof tabId !== 'number') return;

  if (!tabPorts.has(tabId)) tabPorts.set(tabId, new Set());
  tabPorts.get(tabId).add(port);
  stateFor(tabId, port.sender.url);

  port.onMessage.addListener((message) => {
    try {
      handlePortMessage(tabId, message);
    } catch (err) {
      console.error('[MockLab] port message failed', err);
    }
  });

  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    const ports = tabPorts.get(tabId);
    if (!ports) return;
    ports.delete(port);
    if (!ports.size) tabPorts.delete(tabId);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pickApi.forgetTab(tabId);
  probeApi.forgetTab(tabId);
  tabState.delete(tabId);
  tabPorts.delete(tabId);
  lastNotifyAt.delete(tabId);
  const timer = pendingNotify.get(tabId);
  if (timer) clearTimeout(timer);
  pendingNotify.delete(tabId);
});

/* ------------------------------------------------------- panel / MCP one-shots */

async function resolveTabId(requested) {
  if (typeof requested === 'number') return requested;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ? tab.id : null;
}

async function handleMessage(message) {
  const payload = (message && message.payload) || {};
  switch (message && message.type) {
    case MSG.LIST_SOURCES: {
      const tabId = await resolveTabId(payload.tabId);
      const state = tabId === null ? null : tabState.get(tabId);
      if (!state) return { ok: true, tabId, url: '', origin: '', softNavs: 0, sources: [] };
      const sources = [...state.sources.values()].map(toSummary).sort((a, b) => b.lastSeenTs - a.lastSeenTs);
      return { ok: true, tabId, url: state.url, origin: state.origin, softNavs: state.softNavs, sources };
    }
    case MSG.GET_RESPONSE: {
      const tabId = await resolveTabId(payload.tabId);
      const state = tabId === null ? null : tabState.get(tabId);
      const record = state && state.sources.get(payload.sigId);
      if (!record) return { ok: false, reason: 'not-captured' };
      if (payload.path) {
        const value = getByPath(record.body, payload.path);
        return { ok: value !== undefined, body: value, path: payload.path };
      }
      return { ok: true, body: record.body, summary: toSummary(record) };
    }
    default:
      return undefined;
  }
}

/* =========================================================== M2 — Changes engine */

/**
 * What changesApi.js needs from the worker, and nothing more. Keeping it to four
 * functions is what lets the Change CRUD be unit-tested without a browser.
 */
const changesApi = createChangesApi({
  resolveTabId,

  /**
   * The tab's URL comes from Chrome, not from the capture state, so the site bar and
   * the badge agree even on a tab MockLab has never intercepted (a page with no
   * requests, or one loaded before the extension was installed).
   */
  async tabInfo(tabId) {
    const state = tabId === null ? null : tabState.get(tabId);
    let tab = null;
    if (tabId !== null) {
      try {
        tab = await chrome.tabs.get(tabId);
      } catch {
        tab = null;
      }
    }
    const url = (tab && tab.url) || (state && state.url) || '';
    return {
      url,
      origin: originOf(url),
      faviconUrl: (tab && tab.favIconUrl) || '',
      captured: Boolean(state && state.sources.size)
    };
  },

  capturedRecord(tabId, sigId) {
    const state = tabId === null ? null : tabState.get(tabId);
    return (state && state.sources.get(sigId)) || null;
  },

  /** "Reset everything" (§10.5) can empty a site with no tab-visible Change. */
  repaintAllBadges: refreshAllBadges,

  /** "Apply & refresh page" (§10.1D) and "Reset site" (§1.5) both end here. */
  async reload(tabId) {
    if (tabId === null) return false;
    try {
      await chrome.tabs.reload(tabId);
      return true;
    } catch (err) {
      console.error('[MockLab] tab reload failed', err);
      return false;
    }
  }
});

/* ============================================ M3 — picker & candidate discovery */

/**
 * What pick mode and the probe both need from the worker, written once because they
 * must not disagree: the live Ports for a tab (a chrome:// page or a tab opened before
 * MockLab was installed has none, and §1.1 says to say so rather than leave the panel
 * waiting), and the tab's origin with everything it has captured — which §6.3 searches
 * and §7.2's replay check re-reads after every probe reload.
 */
const pageAccess = {
  resolveTabId,
  portsFor: (tabId) => tabPorts.get(tabId) || null,
  tabRecord: (tabId) => tabState.get(tabId) || null
};

/** Pick mode (PLAN.md §6.1, §6.3). The behaviour lives in `pickApi.js`. */
const pickApi = createPickApi({
  ...pageAccess,
  /** Data-free beyond the phase, like every other panel broadcast in this file. */
  notify: (tabId, phase) =>
    void chrome.runtime
      .sendMessage({ type: MSG.PICK_CHANGED, payload: { tabId, phase } })
      .catch(() => {})
});

/* ══════════════════════════════════════════════════ M4 — the probe (PLAN.md §7) */

/**
 * The probe (PLAN.md §7). Beyond `pageAccess` it needs what the user picked (§6.1) and
 * a reload — deliberately the same `chrome.tabs.reload` "Apply & refresh page" performs,
 * because otherwise what the probe proves is not what happens afterwards.
 */
const probeApi = createProbeApi({
  ...pageAccess,
  pickedElement: (tabId) => pickApi.pickedElement(tabId),
  reload: (tabId) => chrome.tabs.reload(tabId).then(() => true, () => false),
  notify: (tabId, state) =>
    void chrome.runtime
      .sendMessage({ type: PROBE_MSG.PROBE_CHANGED, payload: { tabId, state } })
      .catch(() => {})
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message && message.type;
  const isSources = type === MSG.LIST_SOURCES || type === MSG.GET_RESPONSE;
  const isChanges = typeof type === 'string' && CHANGE_MESSAGE_TYPES.has(type);
  const isPick = typeof type === 'string' && PICK_MESSAGE_TYPES.has(type);
  const isProbe = typeof type === 'string' && PROBE_MESSAGE_TYPES.has(type);
  if (!isSources && !isChanges && !isPick && !isProbe) return false;

  const answer = isChanges ? changesApi.handle(message)
    : isPick ? pickApi.handle(message)
      : isProbe ? probeApi.handle(message) : handleMessage(message);
  answer
    .then(sendResponse)
    .catch((err) => {
      console.error('[MockLab] message failed', err);
      sendResponse({ ok: false, reason: String(err && err.message) });
    });
  return true; // async response
});
