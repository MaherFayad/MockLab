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

/** PLAN.md §4: a Binding remembers at most 10 distinct real values. */
const MAX_OBSERVED_VALUES = 10;

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
 * EXPORTED so a module that owns one key family can keep the same discipline without a
 * second lock map beside this one — `presets.js` does its own read-modify-write on
 * `presets:<origin>` (§17.10 put the Scenario mutators there; this file was over the
 * line budget with them in it). Two lock maps would serialize two halves of the same key
 * against themselves and not against each other, which is the race this exists to stop.
 *
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export function withLock(key, task) {
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

/**
 * How many Changes are ACTIVE on an origin — the number the toolbar badge shows and
 * the site bar's "{n} changes on" chip repeats (PLAN.md §1.5, §10).
 *
 * Probe scaffolding is excluded deliberately. A `probe:true` Change exists only inside
 * a running probe (§7.1), the panel is showing its own full-screen progress card at that
 * moment, and the badge flickering 1 -> 2 -> 0 through a bisection run would say nothing
 * true to the user. Every probe Change is deleted in CLEANUP and on service-worker
 * startup (§17.5), so this can never hide a lasting modification.
 *
 * @param {string} origin
 * @returns {Promise<number>}
 */
export async function countActiveChanges(origin) {
  if (!origin) return 0;
  const list = await getEnabledChanges(origin);
  return list.filter((change) => change.probe !== true).length;
}

/**
 * @param {string} origin @param {string} id @returns {Promise<Change|null>}
 */
export async function getChange(origin, id) {
  const list = await getChanges(origin);
  return list.find((change) => change && change.id === id) || null;
}

/**
 * "Reset everything" (PLAN.md §10.5): drop every Change, Scenario and Link, on every
 * site. `settings` survives — unpairing the user's AI is not part of a data reset — and
 * so does the derived `signatures:<origin>` cache, which records what a request looks
 * like and never what MockLab did to it.
 *
 * Each key is removed inside its own write lock, so a create that is mid-flight cannot
 * write its list back on top of the reset and leave one Change standing.
 *
 * @returns {Promise<{origins:string[], changes:number, presets:number, bindings:number}>}
 */
export async function resetEverything() {
  const PREFIXES = [
    ['changes:', 'changes'],
    ['presets:', 'presets'],
    ['bindings:', 'bindings']
  ];
  const tally = { origins: [], changes: 0, presets: 0, bindings: 0 };
  const origins = new Set();

  let all;
  try {
    all = await chrome.storage.local.get(null);
  } catch (err) {
    console.error('[MockLab] reset everything failed to read storage', err);
    return tally;
  }

  for (const [key, value] of Object.entries(all)) {
    const hit = PREFIXES.find(([prefix]) => key.startsWith(prefix));
    if (!hit) continue;
    const [prefix, bucket] = hit;
    origins.add(key.slice(prefix.length));
    tally[bucket] += Array.isArray(value) ? value.length : 0;
    // eslint-disable-next-line no-await-in-loop -- the lock IS the point: serial by key
    await withLock(key, async () => {
      try {
        await chrome.storage.local.remove(key);
      } catch (err) {
        console.error('[MockLab] storage remove failed', key, err);
      }
    });
  }

  tally.origins = [...origins];
  return tally;
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

/**
 * Record that a Change now exists at (sigId, path) WITHOUT claiming anything was
 * proved.
 *
 * PLAN.md §10.2: "a Change created here without a probe is applied but its binding
 * stays `candidate` — chip 'not verified, will still apply'". §17.4 is the hard half of
 * that rule: nothing outside probe.js may ever put a Binding into the verified state,
 * so this function only ever writes `candidate`, and when a Binding for the path
 * ALREADY exists it does not touch `state` at all — neither raising a candidate nor
 * silently downgrading something the probe proved (§1.1 forbids silent downgrades).
 *
 * The real value seen at the path is folded into `observedValues`, which is what powers
 * the value dropdown in §10.1D and the probe's enum flips in §7.4.
 *
 * @param {string} origin
 * @param {string} sigId
 * @param {string} path
 * @param {any} [observedValue] the REAL value currently at that path, if known
 * @returns {Promise<Binding>}
 */
export async function noteChangedPath(origin, sigId, path, observedValue) {
  return withLock(KEY.bindings(origin), async () => {
    const list = await getBindings(origin);
    const seen =
      observedValue === undefined || observedValue === null || typeof observedValue === 'object'
        ? null
        : String(observedValue);

    const index = list.findIndex((b) => b && b.sigId === sigId && b.path === path);
    if (index !== -1) {
      const existing = list[index];
      const values = Array.isArray(existing.observedValues) ? existing.observedValues.slice() : [];
      if (seen !== null && !values.includes(seen)) values.unshift(seen);
      // `state` is deliberately absent from this patch. See the note above.
      list[index] = { ...existing, observedValues: values.slice(0, MAX_OBSERVED_VALUES) };
      await setBindings(origin, list);
      return list[index];
    }

    /** @type {Binding} */
    const binding = {
      id: crypto.randomUUID(),
      origin,
      sigId,
      path,
      elements: [],
      // §17.4: the ONLY state this file may ever write. "candidate" is the honest
      // answer — a value edit proves the field exists, never what it renders.
      state: 'candidate',
      lastVerifiedAt: 0,
      observedValues: seen === null ? [] : [seen],
      probeMode: 'refresh'
    };
    list.push(binding);
    await setBindings(origin, list);
    return binding;
  });
}

/**
 * The Binding for one exact field, or null. Used to label a Change honestly.
 * @param {string} origin @param {string} sigId @param {string} path
 * @returns {Promise<Binding|null>}
 */
export async function findBinding(origin, sigId, path) {
  const list = await getBindings(origin);
  return list.find((b) => b && b.sigId === sigId && b.path === path) || null;
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

/** @param {string} origin @param {string} presetId @returns {Promise<Preset|null>} */
export async function getPreset(origin, presetId) {
  if (!presetId) return null;
  const list = await getPresets(origin);
  return list.find((preset) => preset && preset.id === presetId) || null;
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
