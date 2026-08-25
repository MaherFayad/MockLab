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
 */

import { PORT_NAME, PORT_MSG, MSG } from './messages.js';
import { normalizeRaw, friendlyName, compileMatchList } from './signatures.js';
import { originOf, rememberSignature, groupChangesBySignature } from './ruleStore.js';
import { parsePath, enumeratePaths, getByPath } from '../shared/jsonpath.js';

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
 * PLAN.md §7.1 / §17.5: probe Changes are internal scaffolding and must never
 * outlive the probe that created them. M4 replaces this with the ruleStore call;
 * until then it is a direct storage sweep so the guarantee holds from day one.
 */
async function deleteCrashedProbeChanges() {
  try {
    const all = await chrome.storage.local.get(null);
    const writes = {};
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith('changes:') || !Array.isArray(value)) continue;
      const kept = value.filter((change) => change && change.probe !== true);
      if (kept.length !== value.length) writes[key] = kept;
    }
    if (Object.keys(writes).length) await chrome.storage.local.set(writes);
  } catch (err) {
    console.error('[MockLab] probe cleanup on startup failed', err);
  }
}

chrome.runtime.onStartup?.addListener(deleteCrashedProbeChanges);
chrome.runtime.onInstalled?.addListener(deleteCrashedProbeChanges);
deleteCrashedProbeChanges();

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

/** A Change (or scenario, or reset) landed in storage: re-push to every affected tab. */
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
});

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

function countFields(body) {
  try {
    if (!body || typeof body !== 'object' || body.__unparsed) return 0;
    return enumeratePaths(body).length;
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
      if (isNewDocument) notifyPanel(tabId, 'reset');
      break;
    }
    case PORT_MSG.CAPTURED:
      onCaptured(tabId, message.payload).catch((err) =>
        console.error('[MockLab] capture failed', err)
      );
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handled = message && (message.type === MSG.LIST_SOURCES || message.type === MSG.GET_RESPONSE);
  if (!handled) return false;
  handleMessage(message)
    .then(sendResponse)
    .catch((err) => {
      console.error('[MockLab] message failed', err);
      sendResponse({ ok: false, reason: String(err && err.message) });
    });
  return true; // async response
});
