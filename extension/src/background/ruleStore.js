/**
 * CRUD for Changes / Scenarios / Bindings + the chrome.storage.local schema (PLAN.md §4).
 *
 * OWNER: interceptor-engineer.
 *
 * Keys (PLAN.md §4):
 *   changes:<origin>     Change[]
 *   bindings:<origin>    Binding[]
 *   presets:<origin>     Preset[]
 *   settings             {advancedMode, deepModeOrigins, companionToken}
 *   signatures:<origin>  {sigId: RequestSignature}   ← see DEVIATION note below
 *
 * DEVIATION (README "Deviations", BUILD_LOG M1): §4 lists four key families. A fifth,
 * `signatures:<origin>`, is required for Changes to survive a refresh at all. A Change
 * is keyed by sigId, but the MAIN world matches on method/URL — so the service worker
 * must be able to turn a sigId back into a RequestSignature at document_start, BEFORE
 * that page load has captured anything. Without this cache the compiled match list is
 * empty on every fresh load and no Change could ever apply, which is M2's entire DoD.
 * Captured RESPONSES stay session-only exactly as §4 requires; only the tiny signature
 * shape (method + urlPattern + operation, no bodies) is persisted.
 */

/** @typedef {import('./messages.js').Change} Change */
/** @typedef {import('./messages.js').Binding} Binding */
/** @typedef {import('./messages.js').Preset} Preset */
/** @typedef {import('./messages.js').RequestSignature} RequestSignature */

export const KEY = {
  changes: (origin) => 'changes:' + origin,
  bindings: (origin) => 'bindings:' + origin,
  presets: (origin) => 'presets:' + origin,
  signatures: (origin) => 'signatures:' + origin,
  settings: 'settings'
};

/** Signature cache is bounded so a long-lived browser profile cannot grow forever. */
const MAX_SIGNATURES_PER_ORIGIN = 400;

const DEFAULT_SETTINGS = {
  advancedMode: false,
  paranoid: false,
  deepModeOrigins: [],
  companionToken: null
};

async function read(key, fallback) {
  try {
    const bag = await chrome.storage.local.get(key);
    const value = bag[key];
    return value === undefined ? fallback : value;
  } catch (err) {
    console.error('[MockLab] storage read failed', key, err);
    return fallback;
  }
}

/**
 * chrome.storage.local has no atomic read-modify-write, and the service worker happily
 * runs two captures concurrently: `get` / `get` / `set` / `set` silently drops the first
 * writer's change. That is not theoretical — it lost one of the demo's two signatures
 * roughly one page load in twenty, so a Change created against that source stopped
 * applying with no error anywhere. Every read-modify-write below therefore runs inside a
 * per-key promise chain. The service worker is single-threaded, so this is a sufficient
 * mutex, and it only serializes writes to the SAME key.
 *
 * @type {Map<string, Promise<any>>}
 */
const writeLocks = new Map();

/**
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function withLock(key, task) {
  const previous = writeLocks.get(key) || Promise.resolve();
  const next = previous.then(task, task);
  writeLocks.set(
    key,
    next.then(
      () => { if (writeLocks.get(key) === next) writeLocks.delete(key); },
      () => { if (writeLocks.get(key) === next) writeLocks.delete(key); }
    )
  );
  return next;
}

async function write(key, value) {
  try {
    await chrome.storage.local.set({ [key]: value });
    return true;
  } catch (err) {
    // PLAN.md §11 errors.storageFull — the caller surfaces the friendly string.
    console.error('[MockLab] storage write failed', key, err);
    return false;
  }
}

/**
 * Normalize any URL to the origin form used as a storage key ("https://www.trip.com").
 * @param {string} url
 * @returns {string}
 */
export function originOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol + '//' + parsed.host.toLowerCase();
  } catch {
    return String(url || '');
  }
}

/* ------------------------------------------------------------------------ changes */

/** @param {string} origin @returns {Promise<Change[]>} */
export async function getChanges(origin) {
  const list = await read(KEY.changes(origin), []);
  return Array.isArray(list) ? list : [];
}

/** @param {string} origin @param {Change[]} changes */
export async function setChanges(origin, changes) {
  return write(KEY.changes(origin), changes);
}

/** @param {string} origin @returns {Promise<Change[]>} */
export async function getEnabledChanges(origin) {
  return (await getChanges(origin)).filter((change) => change && change.enabled !== false);
}

/**
 * Create a Change. Never sets a Binding state — a Change on its own proves nothing
 * (PLAN.md §17.4).
 * @param {Partial<Change> & {origin:string, sigId:string, path:string}} input
 * @returns {Promise<Change>}
 */
export async function addChange(input) {
  /** @type {Change} */
  const change = {
    id: input.id || crypto.randomUUID(),
    origin: input.origin,
    sigId: input.sigId,
    path: input.path,
    value: input.value,
    originalValue: input.originalValue,
    enabled: input.enabled !== false,
    createdAt: input.createdAt || Date.now(),
    ...(input.note ? { note: input.note } : {}),
    ...(input.probe ? { probe: true } : {})
  };
  return withLock(KEY.changes(input.origin), async () => {
    const list = await getChanges(input.origin);
    const existing = list.findIndex(
      (c) => c && c.sigId === change.sigId && c.path === change.path && Boolean(c.probe) === Boolean(change.probe)
    );
    if (existing === -1) list.push(change);
    else list[existing] = { ...list[existing], ...change, id: list[existing].id };
    await setChanges(input.origin, list);
    return existing === -1 ? change : list[existing];
  });
}

/** @param {string} origin @param {string} id @param {Partial<Change>} patch */
export async function updateChange(origin, id, patch) {
  return withLock(KEY.changes(origin), async () => {
    const list = await getChanges(origin);
    const index = list.findIndex((c) => c && c.id === id);
    if (index === -1) return null;
    list[index] = { ...list[index], ...patch, id };
    await setChanges(origin, list);
    return list[index];
  });
}

/** @param {string} origin @param {string} id @returns {Promise<number>} how many removed */
export async function deleteChange(origin, id) {
  return withLock(KEY.changes(origin), async () => {
    const list = await getChanges(origin);
    const kept = list.filter((c) => c && c.id !== id);
    if (kept.length === list.length) return 0;
    await setChanges(origin, kept);
    return list.length - kept.length;
  });
}

/**
 * Remove every Change for an origin ("Reset site", PLAN.md §1.5).
 * @param {string} origin @returns {Promise<number>}
 */
export async function clearChanges(origin) {
  return withLock(KEY.changes(origin), async () => {
    const list = await getChanges(origin);
    await setChanges(origin, []);
    return list.length;
  });
}

/* --------------------------------------------------------------- signature cache */

/** @param {string} origin @returns {Promise<Record<string, RequestSignature>>} */
export async function getSignatures(origin) {
  const bag = await read(KEY.signatures(origin), {});
  return bag && typeof bag === 'object' && !Array.isArray(bag) ? bag : {};
}

/**
 * Remember a signature so a Change created today still compiles into a match list on
 * tomorrow's cold page load. No-op when the shape is already stored unchanged.
 * @param {string} origin @param {RequestSignature} signature
 */
export async function rememberSignature(origin, signature) {
  if (!signature || !signature.sigId) return false;
  return withLock(KEY.signatures(origin), async () => {
    const bag = await getSignatures(origin);
    const prev = bag[signature.sigId];
    if (prev && prev.urlPattern === signature.urlPattern && prev.method === signature.method) return false;
    bag[signature.sigId] = {
      sigId: signature.sigId,
      method: signature.method,
      urlPattern: signature.urlPattern,
      ...(signature.gqlOperation ? { gqlOperation: signature.gqlOperation } : {}),
      ...(signature.bodyShape ? { bodyShape: signature.bodyShape } : {})
    };
    const ids = Object.keys(bag);
    if (ids.length > MAX_SIGNATURES_PER_ORIGIN) {
      for (const id of ids.slice(0, ids.length - MAX_SIGNATURES_PER_ORIGIN)) delete bag[id];
    }
    return write(KEY.signatures(origin), bag);
  });
}

/* ----------------------------------------------------------- bindings and presets */

/** @param {string} origin @returns {Promise<Binding[]>} */
export async function getBindings(origin) {
  const list = await read(KEY.bindings(origin), []);
  return Array.isArray(list) ? list : [];
}

/** @param {string} origin @param {Binding[]} bindings */
export async function setBindings(origin, bindings) {
  return write(KEY.bindings(origin), bindings);
}

/** @param {string} origin @returns {Promise<Preset[]>} */
export async function getPresets(origin) {
  const list = await read(KEY.presets(origin), []);
  return Array.isArray(list) ? list : [];
}

/** @param {string} origin @param {Preset[]} presets */
export async function setPresets(origin, presets) {
  return write(KEY.presets(origin), presets);
}

/* -------------------------------------------------------------------- settings */

export async function getSettings() {
  const stored = await read(KEY.settings, {});
  return { ...DEFAULT_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) };
}

/** @param {Partial<typeof DEFAULT_SETTINGS>} patch */
export async function updateSettings(patch) {
  return withLock(KEY.settings, async () => {
    const next = { ...(await getSettings()), ...patch };
    await write(KEY.settings, next);
    return next;
  });
}

/* ------------------------------------------------------------------ match list */

/**
 * Group an origin's enabled Changes by sigId and attach the remembered signature, in
 * the shape signatures.compileMatchList() consumes. Path parsing happens here (in the
 * service worker) so the MAIN world only ever walks pre-parsed tokens — it never needs
 * a JSONPath parser of its own (PLAN.md §17.2).
 *
 * @param {string} origin
 * @param {(path:string) => any[]|null} parsePath  injected from shared/jsonpath.js
 */
export async function groupChangesBySignature(origin, parsePath) {
  const [changes, signatures] = await Promise.all([getEnabledChanges(origin), getSignatures(origin)]);
  /** @type {Map<string, any>} */
  const groups = new Map();
  for (const change of changes) {
    if (!change || !change.sigId || !change.path) continue;
    const signature = signatures[change.sigId];
    if (!signature) continue; // never seen this request on this origin — nothing to match
    const tokens = parsePath(change.path);
    if (!tokens) continue; // malformed path: skip rather than guess
    if (!groups.has(change.sigId)) {
      groups.set(change.sigId, { sigId: change.sigId, signature, changes: [] });
    }
    groups.get(change.sigId).changes.push({ path: change.path, tokens, value: change.value });
  }
  return [...groups.values()];
}
