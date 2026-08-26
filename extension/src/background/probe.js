/**
 * The probe: PLAN.md §7's A/B/A verification protocol, as an explicit state machine.
 *
 * OWNER: probe-engineer.
 *
 * This is the file §0.2 is about. Every other part of MockLab may guess; this one is the
 * only thing in the product allowed to say a link is PROVED, and §17.4 gives it exactly
 * one assignment of that word — the `state: 'verified'` in `persist()`, reached only
 * from CONFIRMED. §17.12 states the stake: a wrong "Verified ✓" is the worst bug this
 * product can have, worse than a crash. So every branch that could reach CONFIRMED
 * without the evidence §7 requires ends in an honest failure instead.
 *
 * The evidence CONFIRMED requires, in order, none of it skippable:
 *   1. two control runs, and the picked element identical in both — if it is not, the
 *      element changes on its own and nothing can be proved about it (§7.2, `tooNoisy`);
 *   2. a noise mask built from those two runs, so no later difference is credited to
 *      MockLab when the page produces it unprompted;
 *   3. bisection down to a single field, where a batch may only ever DISCARD or NARROW —
 *      a batch can never confirm (§7.5);
 *   4. VERIFY_ON: that field mutated, alone, on a fresh load, with a value DIFFERENT
 *      from the one bisection used where the domain allows it — the element must change;
 *   5. VERIFY_OFF: the field put back, the element equal to the control snapshot again.
 *      A change that does not undo is not a proof, it is a coincidence with a page.
 *
 * §17.5 is the other hard rule: every Change written here carries `probe:true`, and
 * CLEANUP deletes every one however the run ends — success, failure, cancel or exception.
 * `background.js` sweeps them again at module top level on every service-worker start,
 * which is what covers a crash mid-probe.
 */

import { PROBE_MSG, PROBE_PORT_MSG, PROBE_PHASE, PROBE_STATE, PROBE_STEP, PROBE_FAIL } from './probeMessages.js';
import { createProbeLink, probeFailure, PROBE_LIMITS } from './probeLink.js';
import { expectedReloads } from './probeValues.js';
import { clearProbeChanges, applyProbeChanges } from './probeChanges.js';
import { buildQueue, affectedKeys, allFields } from './probeQueue.js';
import { buildNoiseMask, snapshotsEqual, diffSnapshots } from '../shared/diff.js';
import { getBindings, setBindings, getSettings } from './ruleStore.js';
import { friendlyName } from './signatures.js';

/** Re-exported so `background.js` reaches the whole probe through ONE import. */
export { PROBE_MSG, PROBE_PORT_MSG } from './probeMessages.js';
export { sweepProbeChanges } from './probeChanges.js';

/** Every message type this module answers. background.js routes on this set. */
export const PROBE_MESSAGE_TYPES = new Set([PROBE_MSG.START_PROBE, PROBE_MSG.CANCEL_PROBE, PROBE_MSG.GET_PROBE]);

/**
 * @param {{
 *   resolveTabId: (requested:any) => Promise<number|null>,
 *   portsFor: (tabId:number) => Set<any>|null,
 *   tabRecord: (tabId:number) => {origin:string, sources:Map<string,any>}|null,
 *   pickedElement: (tabId:number) => {fingerprint:any, snapshot:any, candidates:any[]}|null,
 *   reload: (tabId:number) => Promise<boolean>,
 *   notify: (tabId:number, state:string) => void
 * }} deps
 */
export function createProbeApi(deps) {
  /** @type {Map<number, any>} one run per tab; a second START while one is live is refused. */
  const runs = new Map();
  /** Everything about talking to the page — and about the page not answering. */
  const link = createProbeLink({ portsFor: deps.portsFor, reload: deps.reload });

  const originOf = (tabId) => (deps.tabRecord(tabId) || {}).origin || '';

  function setState(run, state, step) {
    run.state = state;
    if (step !== undefined) run.step = step;
    deps.notify(run.tabId, state);
  }

  /** §17.5's scaffolding, applied and taken back by `probeChanges.js`. */
  const applyBatch = (run, batch, avoid) =>
    applyProbeChanges(run.origin, batch, avoid).then((ids) => { run.applied = ids; });

  /* ------------------------------------------------------------------- the cycle */

  function guard(run) {
    if (run.cancelled) throw probeFailure(PROBE_FAIL.CANCELLED);
    if (Date.now() - run.startedAt > PROBE_LIMITS.TOTAL_MS) {
      throw probeFailure(PROBE_FAIL.TIMEOUT, 'the whole probe passed its 3 minute cap');
    }
  }

  /**
   * One reload, one settled §7.3 snapshot back. The counter is bumped BEFORE the reload,
   * so the progress card counts the refresh the user is watching rather than the last
   * one that finished.
   */
  async function reloadAndSnapshot(run, options = {}) {
    guard(run);
    run.reloads += 1;
    deps.notify(run.tabId, run.state);
    const answer = await link.reloadAndSnapshot(run.tabId, run.fingerprint, options);
    guard(run);
    if (answer.settled === false) run.unsettled += 1;
    return answer;
  }

  /**
   * The MASK reads region AND page (§7.2 asks for the picked element's neighbourhood as
   * well; masking more can only make the probe more cautious). Inverse discovery reads
   * the PAGE sample alone — §7.6's "every element with a direct text node" — because the
   * region is ancestors, and an ancestor's `innerText` contains its children's. Every
   * wrapper around the pill would otherwise be reported as a place the field "affects".
   */
  const nodesOf = (answer) => [...(answer.region || []), ...(answer.page || [])];
  const pageOf = (answer) => answer.page || [];

  /**
   * Did the PICKED element change, against the control run? This — not the whole page —
   * attributes a batch: the user asked about one element, and a batch that moved
   * something else moved something else.
   */
  function elementChanged(run, answer) {
    return !snapshotsEqual(run.control.element, answer.element);
  }

  /**
   * One batch: apply, reload, look. Never confirms anything (§7.5). `lastChanged`
   * remembers the SMALLEST batch that moved the element — what §7.5's multi-field clause
   * searches for pairs in when every single field fails.
   */
  async function testBatch(run, batch) {
    run.testing = batch.length;
    await applyBatch(run, batch);
    const answer = await reloadAndSnapshot(run, { page: false });
    const changed = elementChanged(run, answer);
    if (changed && (!run.lastChanged || batch.length <= run.lastChanged.length)) {
      run.lastChanged = batch;
    }
    return changed;
  }

  /**
   * §7.5's bisection. `known` means this list has already been shown to change the
   * element, which lets the other half be entered without spending a reload: if the
   * whole changed and the first half did not, the driver is in the second. That
   * inference is never trusted — what comes out still has to pass VERIFY_ON and
   * VERIFY_OFF alone, and a wrong one fails there.
   */
  async function search(run, list, known) {
    if (!list.length) return null;
    if (list.length === 1) {
      if (known) return list;
      return (await testBatch(run, list)) ? list : null;
    }
    const half = Math.ceil(list.length / 2);
    const left = list.slice(0, half);
    const right = list.slice(half);
    if (await testBatch(run, left)) return search(run, left, true);
    if (known) return search(run, right, true);
    return (await testBatch(run, right)) ? search(run, right, true) : null;
  }

  /**
   * §7.5's multi-field clause: singles failed, but some batch drove the element. Try
   * pairs out of the last batch that changed it — bounded at 6 probes, because past
   * that the honest answer is "MockLab could not narrow this down".
   *
   * §7.5 asks for the MINIMAL driving set, so a working pair is not returned until both
   * halves have been shown not to work alone: bisection discards halves wholesale, so a
   * field in a discarded half may never have been tried by itself, and a pair whose
   * first member does all the work would put "Verified ✓" on a field that drives nothing
   * (§17.12). Two extra reloads, once, on the rare run that gets this far.
   *
   * Honest note: while `search` is correct this cannot fire — a field that drives the
   * element alone is found alone. It is here so the ANSWER does not depend on that. Only
   * the two mutated together (a bisection narrowing into the wrong half AND this check
   * removed) produce a spurious verified pair; either alone does not.
   */
  async function searchPairs(run, batch) {
    let spent = 0;
    for (let i = 0; i < batch.length; i += 1) {
      for (let j = i + 1; j < batch.length; j += 1) {
        if (spent >= PROBE_LIMITS.MAX_PAIRS) return null;
        spent += 1;
        const pair = [batch[i], batch[j]];
        if (!(await testBatch(run, pair))) continue;
        if (await testBatch(run, [pair[0]])) return [pair[0]];
        if (await testBatch(run, [pair[1]])) return [pair[1]];
        return pair;
      }
    }
    return null;
  }

  /**
   * §7.1's VERIFY_ON / VERIFY_OFF, the only path to CONFIRMED.
   *
   * VERIFY_ON mutates the driver(s) alone, with a value different from the bisection's
   * where §7.4 has one, and takes the whole-page sample §7.6 needs. VERIFY_OFF reverts
   * and requires the element to be EQUAL to the control snapshot again: "it changed" is
   * a fact about one load, "it changed and changed back" is a fact about the field.
   */
  async function verify(run, drivers) {
    let first = null;
    // §7.1's "[optional 3rd cycle if settings.paranoid]" — a second full ON/OFF pair,
    // not a second ON. A cycle that mutated and never reverted would leave the site
    // mocked at the end of the run for as long as CLEANUP's reload takes.
    for (let cycle = 0; cycle < (run.paranoid ? 2 : 1); cycle += 1) {
      setState(run, PROBE_STATE.VERIFY_ON, PROBE_STEP.CONFIRMING);
      run.testing = drivers.length;
      await applyBatch(run, drivers, true);
      const on = await reloadAndSnapshot(run, { page: cycle === 0 });
      if (!elementChanged(run, on)) return { ok: false };
      if (!first) first = on;

      setState(run, PROBE_STATE.VERIFY_OFF, PROBE_STEP.CONFIRMING);
      await applyBatch(run, []);
      const off = await reloadAndSnapshot(run, { page: false });
      if (!snapshotsEqual(run.control.element, off.element)) {
        // It changed, but it did not change BACK. Something else is moving this element,
        // and §7.2's sentence for an element that moves on its own is the honest one.
        throw probeFailure(PROBE_FAIL.TOO_NOISY, `did not return to the control state: ${
          diffSnapshots(run.control.element, off.element).join(', ')}`);
      }
    }
    return { ok: true, on: first };
  }

  /* ---------------------------------------------------------------- the protocol */

  /**
   * §7.1's cycle, top to bottom.
   *
   * DELIBERATE DIVERGENCE from §7.1's "CONTROL_A: reload with zero mock Changes": a
   * probe does not touch the Changes the user already has here. Disabling them would
   * make the control runs describe a page the user is not looking at, and a crash
   * mid-probe would leave their work switched off with nothing to switch it back on.
   * What the control runs need is to be STABLE and identical to each other, which an
   * existing Change is — it applies on every load. A Change on a candidate's own path
   * is not a conflict either: probe Changes are appended after it and the in-page
   * matcher applies a signature's Changes in order, so the probe value is what the site
   * sees, and VERIFY_OFF returns the page to the control state. Recorded in README.
   */
  async function protocol(run) {
    setState(run, PROBE_STATE.CONTROL_A, PROBE_STEP.CONTROL);
    const controlA = await reloadAndSnapshot(run, { page: true });
    setState(run, PROBE_STATE.CONTROL_B, PROBE_STEP.CONTROL);
    const controlB = await reloadAndSnapshot(run, { page: true });
    run.mask = buildNoiseMask(nodesOf(controlA), nodesOf(controlB));
    run.control = controlB;

    // §7.2: an element that differs between two identical loads cannot be reasoned
    // about at all, and saying so is the whole point of the control runs.
    const drift = diffSnapshots(controlA.element, controlB.element);
    if (drift.length) throw probeFailure(PROBE_FAIL.TOO_NOISY, drift.join(', '));

    const queue = await queueFor(run);
    if (!queue.length) {
      throw probeFailure(
        run.notRefetched.length ? PROBE_FAIL.NOT_REFETCHED : PROBE_FAIL.NONE_CONFIRMED,
        'no candidate could be tested on a refresh'
      );
    }

    setState(run, PROBE_STATE.TESTING, PROBE_STEP.TESTING);
    let drivers = await search(run, queue, false);
    let outcome = drivers ? await verify(run, drivers) : { ok: false };

    if (!outcome.ok && run.lastChanged && run.lastChanged.length > 1) {
      setState(run, PROBE_STATE.TESTING, PROBE_STEP.TESTING);
      const pair = await searchPairs(run, run.lastChanged);
      if (pair) {
        drivers = pair;
        outcome = await verify(run, pair);
      }
    }
    if (!outcome.ok || !drivers) throw probeFailure(PROBE_FAIL.NONE_CONFIRMED);

    setState(run, PROBE_STATE.CONFIRMED, PROBE_STEP.CONFIRMING);
    const elements = await discoverElements(run, outcome.on);
    const bindings = [];
    for (const driver of drivers) bindings.push(await persist(run, driver, elements));
    return { ok: true, bindings, affected: elements.length, notRefetched: run.notRefetched };
  }

  /**
   * `probeQueue.buildQueue` with this run's store reads done for it — over the ranked
   * guesses (§6.3) or, when the person asked for "Check all fields (slower)", over
   * every leaf the tab has captured.
   */
  async function queueFor(run) {
    const record = deps.tabRecord(run.tabId);
    const sources = (record && record.sources) || new Map();
    const { queue, notRefetched } = buildQueue({
      candidates: run.exhaustive ? allFields({ sources }) : run.candidates,
      sources,
      bindings: await getBindings(run.origin),
      nameFor: (captured) => friendlyName(captured.signature)
    });
    run.notRefetched = notRefetched;
    return queue;
  }

  /**
   * §7.6, for free: every non-masked node that moved while the field was mutated — what
   * makes ONE probe answer "which elements does this field drive" rather than "does it
   * drive the one you clicked". It finds the demo's cancellation banner, which has no
   * text in either control run, so it is not masked and it APPEARS.
   */
  async function discoverElements(run, on) {
    const ordered = affectedKeys(pageOf(run.control), pageOf(on), run.mask, on.elementKey);
    const answer = await link.fingerprints(run.tabId, ordered);
    const byKey = new Map((answer.fingerprints || []).map((entry) => [entry.key, entry.fingerprint]));
    const elements = ordered.map((key) => byKey.get(key)).filter(Boolean);
    // VERIFY_ON proved the picked element itself; if the page would not fingerprint it,
    // the one taken at pick time still describes it.
    if (!elements.length && run.fingerprint) return [run.fingerprint];
    return elements;
  }

  /**
   * CONFIRMED. The one place in the entire product allowed to write the verified state
   * (PLAN.md §17.4) — reached only through the full control + bisection + VERIFY_ON +
   * VERIFY_OFF cycle above.
   *
   * A Binding that already exists for this exact field keeps its id and its observed
   * values; everything else is replaced with what this run proved.
   *
   * KNOWN BOUNDARY, stated rather than pretended away: `ruleStore.js` keeps its write
   * lock private, so this read-modify-write is not serialized against a `SET_VALUE`
   * landing in the same instant. The race can only DROP this write — the panel would
   * show the link as a candidate and the user would probe again — never invent one, so
   * it fails in the direction §17.12 cares about.
   */
  async function persist(run, driver, elements) {
    const list = await getBindings(run.origin);
    const index = list.findIndex((b) => b && b.sigId === driver.sigId && b.path === driver.path);
    const existing = index === -1 ? null : list[index];
    const observed = [String(driver.real)];
    for (const value of (existing && existing.observedValues) || []) {
      if (!observed.includes(String(value))) observed.push(String(value));
    }
    const binding = {
      id: existing ? existing.id : crypto.randomUUID(),
      origin: run.origin,
      sigId: driver.sigId,
      path: driver.path,
      elements,
      state: 'verified',
      lastVerifiedAt: Date.now(),
      observedValues: observed.slice(0, PROBE_LIMITS.MAX_OBSERVED),
      probeMode: 'refresh'
    };
    if (index === -1) list.push(binding);
    else list[index] = binding;
    await setBindings(run.origin, list);
    return { ...binding, sourceName: driver.sourceName, realValue: driver.real };
  }

  /* ------------------------------------------------------------------- lifecycle */

  async function execute(run) {
    let result;
    try {
      result = await protocol(run);
    } catch (error) {
      result = {
        ok: false,
        reason: error && error.probeReason ? error.probeReason : PROBE_FAIL.INTERNAL,
        ...(error && error.probeDetail ? { detail: error.probeDetail } : {}),
        ...(run.notRefetched && run.notRefetched.length ? { notRefetched: run.notRefetched } : {})
      };
      if (!error || !error.probeReason) console.error('[MockLab] probe crashed', error);
    }

    // CLEANUP runs however the run ended — success, failure, cancel or exception
    // (PLAN.md §7.1, §17.5). The final reload happens only when something was still
    // applied: after VERIFY_OFF the page is already showing the site's real data, and
    // a reload that changes nothing is a reload the user watches for nothing.
    setState(run, PROBE_STATE.CLEANUP, PROBE_STEP.CLEANUP);
    try {
      link.abort(run.tabId);
      const removed = await clearProbeChanges(run.origin);
      if (removed > 0) {
        run.reloads += 1;
        await deps.reload(run.tabId);
      }
    } catch (error) {
      console.error('[MockLab] probe cleanup failed', error);
    }

    run.result = result;
    run.testing = 0;
    setState(run, PROBE_STATE.DONE, null);
  }

  async function start(tabId, options = {}) {
    const live = runs.get(tabId);
    if (live && live.state !== PROBE_STATE.DONE) return { ok: false, reason: PROBE_FAIL.BUSY };

    const picked = deps.pickedElement(tabId);
    if (!picked || !picked.fingerprint) return { ok: false, reason: PROBE_FAIL.NO_PICK };
    if (!deps.portsFor(tabId) || !deps.portsFor(tabId).size) {
      return { ok: false, reason: PROBE_FAIL.NO_CONTENT_SCRIPT };
    }
    const exhaustive = options.exhaustive === true;
    const candidates = (picked.candidates || []).filter((c) => c && c.value !== null);
    // §6.3 offers "Check all fields" precisely when there are no guesses to offer, so
    // an empty candidate list is only a dead end in the ranked mode.
    if (!candidates.length && !exhaustive) return { ok: false, reason: PROBE_FAIL.NO_CANDIDATES };

    const settings = await getSettings();
    const run = {
      tabId,
      origin: originOf(tabId),
      fingerprint: picked.fingerprint,
      element: picked.snapshot || null,
      candidates,
      exhaustive,
      paranoid: settings.paranoid === true,
      state: PROBE_STATE.IDLE,
      step: PROBE_STEP.CONTROL,
      testing: 0,
      reloads: 0,
      unsettled: 0,
      expected: expectedReloads(exhaustive ? 64 : candidates.length, settings.paranoid === true),
      startedAt: Date.now(),
      cancelled: false,
      applied: [],
      notRefetched: [],
      lastChanged: null,
      result: null
    };
    runs.set(tabId, run);
    void execute(run);
    return { ok: true, tabId };
  }

  /**
   * §11's "Stop checking". The run unwinds at its next guard, CLEANUP deletes every
   * probe Change, and the page goes back to the site's real data — §16 M4's third DoD
   * line is that a cancel leaves ZERO probe changes in storage.
   */
  function cancel(tabId) {
    const run = runs.get(tabId);
    if (!run || run.state === PROBE_STATE.DONE) return { ok: true, tabId, cancelled: false };
    run.cancelled = true;
    // Reject what the run is waiting for as well as flagging it: a probe that has just
    // reloaded is inside a 15 s wait, and "Stop checking" must stop it now.
    link.abort(tabId, PROBE_FAIL.CANCELLED);
    return { ok: true, tabId, cancelled: true };
  }

  /**
   * What §10.1 renders. `phase` is the four-way screen selector, `state` the §7.1
   * machine behind it — both, so the panel need not switch on nine states to draw four
   * screens. `binding` is the §4 Binding as STORED, so the panel derives "Verified ✓"
   * from its `state` and never from the fact that a result arrived at all (§17.4).
   */
  function view(tabId, run) {
    if (!run) {
      return {
        ok: true, tabId, origin: originOf(tabId), phase: PROBE_PHASE.IDLE,
        state: PROBE_STATE.IDLE, step: '', testing: 0, element: null, reload: null,
        binding: null, bindings: [], value: undefined, failure: '', affected: 0
      };
    }
    const done = run.state === PROBE_STATE.DONE;
    const result = run.result || null;
    const proved = done && result && result.ok === true ? result.bindings || [] : [];
    return {
      ok: true,
      tabId,
      origin: run.origin,
      phase: !done ? PROBE_PHASE.RUNNING : proved.length ? PROBE_PHASE.DONE : PROBE_PHASE.FAILED,
      state: run.state,
      step: done ? '' : run.step,
      testing: run.testing,
      // §10.1D still has to name what the user clicked, and the pick record was cleared
      // by the probe's own first reload — so the run carries the snapshot it started on.
      element: run.element,
      // §11's `probe.reloads(i, n)`. The estimate is corrected upward by what actually
      // happened, because "refresh 9 of ~8" is a smaller lie than a bar that overruns.
      reload: { index: run.reloads, estimate: Math.max(run.expected, run.reloads) },
      binding: proved[0] || null,
      bindings: proved,
      value: proved.length ? proved[0].realValue : undefined,
      failure: done && result && result.ok !== true ? result.reason : '',
      detail: (result && result.detail) || '',
      affected: (result && result.affected) || 0,
      notRefetched: (result && result.notRefetched) || [],
      unsettledLoads: run.unsettled
    };
  }

  async function handle(message) {
    const payload = (message && message.payload) || {};
    const tabId = await deps.resolveTabId(payload.tabId);
    if (tabId === null) return { ok: false, reason: 'no-tab' };
    switch (message.type) {
      case PROBE_MSG.START_PROBE:
        return start(tabId, { exhaustive: payload.exhaustive === true });
      case PROBE_MSG.CANCEL_PROBE:
        return cancel(tabId);
      case PROBE_MSG.GET_PROBE:
        return view(tabId, runs.get(tabId));
      default:
        return undefined;
    }
  }

  /** The tab went away, or navigated somewhere the probe was not aiming at. */
  function forgetTab(tabId) {
    cancel(tabId);
    runs.delete(tabId);
  }

  return {
    handle,
    cancel,
    forgetTab,
    /** background.js routes these two straight through to the page link. */
    onProbeResult: link.onProbeResult,
    onNewDocument: link.onNewDocument,
    PROBE_MESSAGE_TYPES
  };
}
