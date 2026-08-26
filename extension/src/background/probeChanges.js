/**
 * PLAN.md §17.5, in one file: the `probe:true` Changes the probe writes, and every way
 * they are taken back.
 *
 * OWNER: probe-engineer.
 *
 * A probe Change is internal scaffolding. It mocks a real site with a value nobody
 * asked for, and the only thing that makes that acceptable is that it CANNOT outlive
 * the run that wrote it. §17.5 names two guarantees, and both live here so neither can
 * be weakened without reading the other:
 *
 *   1. CLEANUP deletes them — however the run ended, including an exception nobody
 *      predicted (`clearProbeChanges`, called from `probe.js`'s `execute`);
 *   2. a service-worker start deletes them — which is what covers the case CLEANUP
 *      cannot reach, a browser crash or an extension reload mid-probe
 *      (`sweepProbeChanges`, called at module top level in `background.js`; the
 *      top-level call rather than the `onStartup` listener is the one that runs after
 *      a crash, and that distinction was proved in a real browser at M0).
 *
 * The sweep talks to `chrome.storage.local` directly rather than through `ruleStore`'s
 * per-origin helpers, deliberately: it runs before anything is known about which
 * origins exist, it must not depend on a write lock that a crashed run may have left
 * behind, and it must be the shortest possible path between a cold start and a site
 * that is no longer silently mocked.
 */

import { addChange, getChanges, deleteChange } from './ruleStore.js';
import { probeValueFor } from './probeValues.js';

/** §17.5's storage-key prefix, and the flag that marks scaffolding. */
const CHANGES_PREFIX = 'changes:';

/**
 * Delete every `probe:true` Change written for one origin — this run's and any orphan
 * an earlier one left behind. One LOCKED delete per id rather than one bulk write, so
 * a Change the user creates in the same instant cannot be lost.
 *
 * @param {string} origin
 * @returns {Promise<number>} how many were removed
 */
export async function clearProbeChanges(origin) {
  let removed = 0;
  for (const change of await getChanges(origin)) {
    if (change && change.probe === true) removed += await deleteChange(origin, change.id);
  }
  return removed;
}

/**
 * Replace the probe's applied Changes with exactly this batch (§7.5 — a batch is all
 * of the mutations on the page at once, and nothing else of the probe's is left over
 * from the previous one).
 *
 * Each item's `probeValue` is remembered on it, which is what lets VERIFY_ON ask §7.4
 * for a DIFFERENT value from the one bisection used.
 *
 * @param {string} origin
 * @param {{sigId:string, path:string, real:any, observed:string[], probeValue:any}[]} batch
 * @param {boolean} [avoidPrevious] pass the last probe value to §7.4 as the one to avoid
 * @returns {Promise<string[]>} the ids written
 */
export async function applyProbeChanges(origin, batch, avoidPrevious) {
  await clearProbeChanges(origin);
  const ids = [];
  for (const item of batch) {
    const value = probeValueFor(item.real, {
      observedValues: item.observed,
      avoid: avoidPrevious ? item.probeValue : undefined
    });
    // §7.4 has nothing safe to write here (a null, or a container). Skipping is the
    // honest move: a candidate that cannot be mutated cannot be proved either.
    if (value === undefined) continue;
    item.probeValue = value;
    const change = await addChange({
      origin,
      sigId: item.sigId,
      path: item.path,
      value,
      originalValue: item.real,
      enabled: true,
      probe: true
    });
    ids.push(change.id);
  }
  return ids;
}

/**
 * §17.5's second guarantee: on every service-worker start, no `probe:true` Change
 * survives anywhere. Called at module top level in `background.js` — not only from
 * `onStartup`, which does not fire after a crash.
 *
 * @returns {Promise<number>} how many were swept
 */
export async function sweepProbeChanges() {
  let swept = 0;
  try {
    const all = await chrome.storage.local.get(null);
    const writes = {};
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(CHANGES_PREFIX) || !Array.isArray(value)) continue;
      const kept = value.filter((change) => change && change.probe !== true);
      if (kept.length !== value.length) {
        swept += value.length - kept.length;
        writes[key] = kept;
      }
    }
    if (Object.keys(writes).length) await chrome.storage.local.set(writes);
  } catch (err) {
    console.error('[MockLab] probe cleanup on startup failed', err);
  }
  return swept;
}
