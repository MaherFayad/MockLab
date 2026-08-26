/**
 * M5's Scenarios in the service worker — PLAN.md §10.4, §4's Preset, §12.4 #10–#13.
 *
 * OWNER: interceptor-engineer.
 *
 * ── Why this file exists at all ─────────────────────────────────────────────────────
 * M5 shipped the Scenarios tab and M6 shipped the four preset MCP tools, and neither had
 * anything to talk to: no handler in the worker answered `LIST_PRESETS`, so the panel
 * rendered its honest not-ready state and `list_presets` answered `S.notYet` through
 * `wsOps.relay`. Both were correct about a thing that did not exist. This is the thing.
 *
 * ── §1.6 parity, kept structurally ──────────────────────────────────────────────────
 * "Every action in the panel has an MCP tool equivalent. The rule store is shared."
 * There is ONE handler per action and both callers reach it: the panel through
 * `chrome.runtime.sendMessage`, an agent through `wsOps`' `dispatch`, which is the same
 * router. Nothing about a Scenario is decided in the panel and re-decided here.
 *
 * ── What this file may NOT do ───────────────────────────────────────────────────────
 * §17.4: no path through here writes a Binding state — not `verified`, and not
 * `candidate` either. Applying a Scenario is not evidence about what any element
 * renders: nobody picked anything, nothing was probed, and the values being applied were
 * chosen on a page load that is over. `changesApi.SET_VALUE` records a candidate link
 * because a person aimed at that field on this page load; a Scenario aims at a list.
 * Filling the Links list with guesses nobody made would be §1.1 in slow motion, and the
 * `stale` a panel later computes over them (README Deviation 65) would be computed over
 * fiction.
 *
 * ── Validation, and the ONE validator ───────────────────────────────────────────────
 * `IMPORT_PRESET` is the only door in MockLab that a document MockLab did not write can
 * come through, and since M6 it is reachable from two sides: a file the person chose
 * (already checked by `panel/scenarioFile.js`) and whatever an MCP client puts on the
 * socket (checked by nobody). So the worker checks it too, WITH THE SAME FUNCTION —
 * `parseScenarioFile`, run over the payload serialized back to text. Not a second
 * validator written to the same rules: the same code, so the two cannot drift, and
 * §10.4's whole hostile-input matrix (20 mutations in `scenarioFile.test.js`) applies to
 * the socket for free. Its refusals arrive as `{ok:false, reason, message}` where the
 * message is the sentence the panel would have shown — including the one that names the
 * site a scenario was saved on (README Deviation 63), which is the same sentence for an
 * agent because it is the same fact.
 *
 * That module lives under `panel/` and is imported here across that boundary, exactly as
 * `changesApi.js` and `wsOps.js` import `panel/strings.js`: it is pure, it touches no
 * DOM, and duplicating it is the one thing that would guarantee the two doors disagree.
 * It should MOVE to `src/shared/` now that a worker reads it — recorded for the
 * orchestrator rather than moved here, because it is another owner's file.
 *
 * SAVE and UPDATE do NOT run through it. What they snapshot is already in the store,
 * validated when each Change was created, and the file validator's path rule is
 * deliberately narrower than §5.4's grammar (it takes only double-quoted bracket keys,
 * while `parsePath` also takes single-quoted ones) — so re-checking stored data with it
 * would refuse a Change MockLab itself accepted. Their own bounds are below.
 */

import { MSG } from './messages.js';
import { parseScenarioFile, MAX_CHANGES } from '../panel/scenarioFile.js';
// §17.6: MockLab's words live in one file. These sentences reach a person through the
// panel and an agent through MCP; both read the same one.
import { S } from '../panel/strings.js';
import { KEY, withLock, getPresets, setPresets, getPreset, getEnabledChanges, getSignatures, addChange } from './ruleStore.js';

/** @typedef {import('./messages.js').Preset} Preset */
/** @typedef {import('./messages.js').Change} Change */

/* ─────────────────────────────────────────────── the `presets:<origin>` mutators
 *
 * These belong beside the rest of the schema in `ruleStore.js` and are here instead for
 * §17.10: that file was 534 lines with them in it, past the 520 the line audit allows.
 * The lock is IMPORTED rather than reinvented, so `presets:<origin>` still has exactly
 * one write mutex — two maps would serialize each half against itself and neither
 * against the other, which is the race the mutex exists to stop.
 */

/**
 * Scenario writes report whether they LANDED, and `ruleStore.js`'s Change writers do not.
 *
 * Deliberate, not an oversight: `write()` answers false when chrome.storage refuses (§11
 * wrote a sentence for it, `errors.storageFull`), and a Scenario is the one thing here a
 * person expects to still exist tomorrow — a save that toasted "saved" over a refused
 * write would lose their work with a success message on top of it (§1.1). `addChange`
 * still swallows the same answer; that gap is recorded rather than half-fixed here.
 *
 * @typedef {{ok:true, preset:Preset}|{ok:false, reason:'too-many'|'storage-full'}} PresetWrite
 */

/**
 * The most Scenarios one site may hold. A person will not approach it; an agent in a loop
 * reaches it in seconds, and the failure without a cap is `chrome.storage.local` filling
 * up, which breaks every other site too. Bounded where the signature cache is bounded.
 */
export const MAX_PRESETS_PER_ORIGIN = 200;

/**
 * Store a new Scenario. The handler below decides the shape; this mints the
 * identity, which may come from nowhere else — an imported file carrying an `id` must
 * never land on top of a Scenario already on this machine.
 *
 * @param {string} origin @param {Partial<Preset>} input @returns {Promise<PresetWrite>}
 */
export async function addPreset(origin, input) {
  return withLock(KEY.presets(origin), async () => {
    const list = await getPresets(origin);
    if (list.length >= MAX_PRESETS_PER_ORIGIN) return { ok: false, reason: 'too-many' };
    /** @type {Preset} */
    const preset = {
      id: crypto.randomUUID(),
      origin,
      name: input.name,
      emoji: input.emoji,
      changes: Array.isArray(input.changes) ? input.changes : [],
      createdAt: Number(input.createdAt) || Date.now()
    };
    list.push(preset);
    if (!(await setPresets(origin, list))) return { ok: false, reason: 'storage-full' };
    return { ok: true, preset };
  });
}

/**
 * Patch a stored Scenario. `changes`, `id` and `origin` are not patchable here, so no
 * caller can re-point one at another site or silently change what an already-named
 * Scenario does (see UPDATE_PRESET in messages.js).
 *
 * @param {string} origin @param {string} presetId
 * @param {{name?:string, emoji?:string, lastAppliedAt?:number}} patch
 * @returns {Promise<PresetWrite|{ok:false, reason:'no-such-preset'}>}
 */
export async function patchPreset(origin, presetId, patch) {
  return withLock(KEY.presets(origin), async () => {
    const list = await getPresets(origin);
    const index = list.findIndex((preset) => preset && preset.id === presetId);
    if (index === -1) return { ok: false, reason: 'no-such-preset' };
    const next = { ...list[index] };
    if (typeof patch.name === 'string') next.name = patch.name;
    if (typeof patch.emoji === 'string') next.emoji = patch.emoji;
    if (typeof patch.lastAppliedAt === 'number') next.lastAppliedAt = patch.lastAppliedAt;
    list[index] = next;
    if (!(await setPresets(origin, list))) return { ok: false, reason: 'storage-full' };
    return { ok: true, preset: next };
  });
}

/** @param {string} origin @param {string} presetId @returns {Promise<number>} how many removed */
export async function deletePreset(origin, presetId) {
  return withLock(KEY.presets(origin), async () => {
    const list = await getPresets(origin);
    const kept = list.filter((preset) => preset && preset.id !== presetId);
    if (kept.length === list.length) return 0;
    await setPresets(origin, kept);
    return list.length - kept.length;
  });
}


/** Every message type this module answers. `changesApi.js` folds it into the router's set. */
export const PRESET_MESSAGE_TYPES = new Set([
  MSG.LIST_PRESETS,
  MSG.SAVE_PRESET,
  MSG.UPDATE_PRESET,
  MSG.DELETE_PRESET,
  MSG.APPLY_PRESET,
  MSG.IMPORT_PRESET
]);

/**
 * The longest name a Scenario may carry. The same 120 `scenarioFile.js` enforces on an
 * imported one — stated again because that module does not export it, and a Scenario
 * saved here that a re-import would refuse is a round-trip MockLab breaks on itself.
 * (The export/import round-trip has one other seam like this; it is in the header.)
 */
const MAX_NAME_CHARS = 120;

/** One picked glyph (§4's `emoji`), not a sentence. `scenarioFile.js` slices to the same. */
const MAX_EMOJI_CHARS = 8;

/** An answer that failed, with the §11 sentence for it when §11 wrote one. */
const no = (reason, message) => (message ? { ok: false, reason, message } : { ok: false, reason });

/** The store's word for a write chrome.storage refused. */
const writeFailure = (result) =>
  result.reason === 'storage-full' || result.reason === 'too-many'
    ? no(result.reason, S.errors.storageFull)
    : no(result.reason || 'internal', S.errors.pageBroke);

/**
 * A name and a symbol a person will see on a card, or a refusal.
 * @returns {{ok:true, name:string, emoji:string}|{ok:false, reason:string, message:string}}
 */
function readLabel(payload, fallbackEmoji) {
  const typed = typeof payload.name === 'string' ? payload.name.trim() : '';
  if (!typed) return no('bad-name', S.scenarios.nameEmpty);
  // Cut, not refused. §11 has one sentence for a name — "Type a name for this scenario"
  // — and saying that to somebody who typed 200 characters would be false. The cut is
  // visible on the card the moment it is saved, so nothing is hidden by it, and it keeps
  // a saved Scenario inside the bound an imported one has to satisfy.
  const name = typed.slice(0, MAX_NAME_CHARS);
  const emoji =
    typeof payload.emoji === 'string' && payload.emoji.trim()
      ? payload.emoji.slice(0, MAX_EMOJI_CHARS)
      : fallbackEmoji;
  return { ok: true, name, emoji };
}

/**
 * §4: a Scenario embeds COPIES of its Changes, "not references". This is that copy, and
 * it is deliberately the same five fields `scenarioFile.serializeScenario` writes to a
 * file: what a Scenario means must not depend on whether it took the round trip through
 * disk. `id`, `origin` and `createdAt` are left off — a Change inside a Scenario is not a
 * Change that exists; it is a value waiting to be applied, and it gets its identity from
 * `addChange` on the day someone applies it.
 *
 * @param {Change} change @returns {Object}
 */
function embed(change) {
  return {
    sigId: change.sigId,
    path: change.path,
    value: change.value,
    enabled: change.enabled !== false,
    ...(change.note ? { note: String(change.note) } : {})
  };
}

/**
 * @param {{
 *   target: (payload:any) => Promise<{tabId:number|null, origin:string, info:any}>,
 *   reload: (tabId:number|null, payload:any) => Promise<boolean>,
 *   notify: (origin:string) => void
 * }} deps
 */
export function createPresetsApi(deps) {
  /** Every mutation ends here: tell whoever is watching, then answer. */
  function changed(origin, answer) {
    try {
      deps.notify(origin);
    } catch {
      /* nobody listening is not a failure */
    }
    return answer;
  }

  /**
   * §12.4 #11's honest half. A Change whose source this origin has never captured cannot
   * compile into the in-page match list (`groupChangesBySignature` drops it), so it is
   * stored and reported as NOT applied — the same fact `ChangeSummary.applies` states
   * for a single Change, and what §11's `scenarios.appliedPartly` is rendered from.
   */
  async function applyChanges(origin, preset) {
    const signatures = await getSignatures(origin);
    let applied = 0;
    let unapplied = 0;
    let disabled = 0;
    for (const change of Array.isArray(preset.changes) ? preset.changes : []) {
      if (!change || typeof change.sigId !== 'string' || typeof change.path !== 'string') continue;
      // Written whatever its state, because a Scenario means what it said when it was
      // saved; counted apart, because "off" and "nowhere to land" are different answers
      // and §11's sentence for the second would be untrue about the first.
      await addChange({
        origin,
        sigId: change.sigId,
        path: change.path,
        value: change.value,
        enabled: change.enabled !== false,
        ...(change.note ? { note: change.note } : {})
      });
      if (change.enabled === false) disabled += 1;
      else if (signatures[change.sigId]) applied += 1;
      else unapplied += 1;
    }
    return { applied, unapplied, disabled };
  }

  /**
   * @param {{type:string, payload?:any}} message
   * @returns {Promise<any>}
   */
  async function handle(message) {
    const payload = (message && message.payload) || {};

    switch (message.type) {
      case MSG.LIST_PRESETS: {
        const { origin } = await deps.target(payload);
        return { ok: true, origin, presets: await getPresets(origin) };
      }

      case MSG.SAVE_PRESET: {
        const { origin } = await deps.target(payload);
        if (!origin) return no('no-origin', S.errors.pageBroke);
        const label = readLabel(payload, S.scenarios.defaultSymbol);
        if (!label.ok) return label;

        // §10.4: "New scenario from current changes". The probe's own scaffolding is
        // never one of them — it exists for seconds inside a run (§7.1) and is deleted
        // in CLEANUP (§17.5), so saving it would save machinery, not the user's work.
        const changes = (await getEnabledChanges(origin)).filter((change) => change && change.probe !== true);
        if (!changes.length) return no('no-changes', S.scenarios.nothingToSave);

        const stored = await addPreset(origin, {
          name: label.name,
          emoji: label.emoji,
          changes: changes.map(embed),
          createdAt: Date.now()
        });
        if (!stored.ok) return writeFailure(stored);
        return changed(origin, { ok: true, origin, preset: stored.preset });
      }

      case MSG.UPDATE_PRESET: {
        const { origin } = await deps.target(payload);
        const current = await getPreset(origin, payload.presetId);
        if (!current) return no('no-such-preset', S.errors.pageBroke);
        const label = readLabel(payload, current.emoji || S.scenarios.defaultSymbol);
        if (!label.ok) return label;
        const stored = await patchPreset(origin, payload.presetId, { name: label.name, emoji: label.emoji });
        if (!stored.ok) return writeFailure(stored);
        return changed(origin, { ok: true, origin, preset: stored.preset });
      }

      case MSG.DELETE_PRESET: {
        const { origin } = await deps.target(payload);
        const deleted = await deletePreset(origin, payload.presetId);
        if (!deleted) return no('no-such-preset', S.errors.pageBroke);
        return changed(origin, { ok: true, origin, deleted });
      }

      case MSG.APPLY_PRESET: {
        const { tabId, origin } = await deps.target(payload);
        const preset = await getPreset(origin, payload.presetId);
        if (!preset) return no('no-such-preset', S.errors.pageBroke);

        const counts = await applyChanges(origin, preset);
        // Not a link state and not a claim about the page: the day it was last used.
        await patchPreset(origin, preset.id, { lastAppliedAt: Date.now() });
        const refreshed = await deps.reload(tabId, payload);
        return changed(origin, { ok: true, origin, presetId: preset.id, ...counts, refreshed });
      }

      case MSG.IMPORT_PRESET: {
        const { origin } = await deps.target(payload);
        // Without an origin there is no site to import INTO, and the file's own
        // "which site was this saved on" check has nothing to compare against — so a
        // scenario from anywhere would be accepted and filed under a key that is not a
        // site (README Deviation 63 depends on this not happening).
        if (!origin) return no('no-origin', S.errors.pageBroke);
        const checked = validateImport(payload.preset, origin);
        if (!checked.ok) return no(checked.reason, checked.error);
        const stored = await addPreset(origin, {
          name: checked.preset.name,
          emoji: checked.preset.emoji,
          changes: checked.preset.changes,
          createdAt: Date.now()
        });
        if (!stored.ok) return writeFailure(stored);
        return changed(origin, { ok: true, origin, preset: stored.preset });
      }

      default:
        return undefined;
    }
  }

  return { handle };
}

/**
 * Check an imported Scenario with the panel's own file validator — see the header for
 * why it is that function and not a second one written to the same rules.
 *
 * The payload is an object and `parseScenarioFile` reads text, so it is serialized back.
 * That is not a detour: JSON is exactly the domain the validator was written for, and
 * anything a structured clone can carry that JSON cannot (a `Map`, an `undefined`, a
 * cycle) is something no exported Scenario ever contained — it fails, in the safe
 * direction, with the sentence for a file that is not a Scenario.
 *
 * @param {any} preset @param {string} origin
 * @returns {{ok:true, preset:Object}|{ok:false, reason:string, error:string}}
 */
export function validateImport(preset, origin) {
  if (!preset || typeof preset !== 'object' || Array.isArray(preset)) {
    return { ok: false, reason: 'not-scenario', error: S.scenarios.importNotScenario };
  }
  // Before serializing, so a caller cannot make the worker stringify an unbounded list
  // to be told the length was the problem. The validator checks it again on the text.
  if (Array.isArray(preset.changes) && preset.changes.length > MAX_CHANGES) {
    return { ok: false, reason: 'too-big', error: S.scenarios.importTooBig };
  }
  let text = '';
  try {
    text = JSON.stringify(preset);
  } catch {
    return { ok: false, reason: 'not-scenario', error: S.scenarios.importNotScenario };
  }
  if (typeof text !== 'string') return { ok: false, reason: 'not-scenario', error: S.scenarios.importNotScenario };
  return parseScenarioFile(text, { origin });
}
