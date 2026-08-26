/**
 * The probe's half of the conversation with the page: request correlation, the timeouts
 * §7.1 sets on it, and the failure type both halves raise.
 *
 * OWNER: probe-engineer. Split out of `probe.js` under §17.10. The seam is real rather
 * than arithmetic: everything here is about a Port that may not answer — a page that
 * never settles, an agent evicted with the service worker, a tab the user navigated
 * away mid-run — while `probe.js` is about what the answers MEAN. Nothing in this file
 * knows what a candidate or a Binding is, and nothing in it may decide that anything
 * was proved.
 *
 * The one rule worth naming twice: §6.2 says a re-resolved element below confidence 0.8
 * aborts the probe. That check lives HERE, at the point the answer arrives, so no
 * caller can forget it — diffing the wrong element is exactly how a false "Verified ✓"
 * would be manufactured (§17.12).
 */

import { PROBE_PORT_MSG, PROBE_FAIL } from './probeMessages.js';

/** PLAN.md §7.1's timeouts and §6.2's confidence floor, in one place. */
export const PROBE_LIMITS = {
  /** "each reload+settle capped at 15 s" — the agent's own cap is 8 s plus its reply. */
  SETTLE_MS: 15000,
  /** A fingerprint round trip on an ALREADY settled page: no reload, so far shorter. */
  ANSWER_MS: 5000,
  /** "Whole probe capped at 3 min." */
  TOTAL_MS: 180000,
  /** §6.2: "Confidence < 0.8 during a probe = abort … never diff the wrong element." */
  MIN_CONFIDENCE: 0.8,
  /** §7.5: "try pairs from the last surviving batch, max 6 pair-probes". */
  MAX_PAIRS: 6,
  /** §4: "distinct real values ever seen at this path (max 10)". */
  MAX_OBSERVED: 10
};

/**
 * A failure carrying the §11 sentence behind it. Thrown from anywhere inside a run and
 * caught once, in `probe.js`'s `execute`, which turns `probeReason` into the copy key
 * the panel renders. An error WITHOUT a `probeReason` is a bug in MockLab rather than a
 * fact about the page, and is reported as such rather than dressed up as a probe result.
 *
 * @param {string} reason a PROBE_FAIL value @param {string} [detail] for Advanced mode
 */
export function probeFailure(reason, detail) {
  const error = new Error(`probe failed: ${reason}`);
  error.probeReason = reason;
  if (detail) error.probeDetail = detail;
  return error;
}

/**
 * @param {{
 *   portsFor: (tabId:number) => Set<any>|null,
 *   reload: (tabId:number) => Promise<boolean>
 * }} deps
 */
export function createProbeLink(deps) {
  /** @type {Map<string, any>} in-flight page requests, by request id. */
  const pending = new Map();
  let sequence = 0;

  function send(tabId, type, payload) {
    const ports = deps.portsFor(tabId);
    if (!ports || !ports.size) return false;
    let delivered = false;
    for (const port of ports) {
      try {
        port.postMessage({ type, payload });
        delivered = true;
      } catch {
        /* the port died between the check and the send */
      }
    }
    return delivered;
  }

  function settle(entry, value) {
    if (!pending.has(entry.requestId)) return;
    pending.delete(entry.requestId);
    clearTimeout(entry.timer);
    entry.finish(value);
  }

  /**
   * Register a request for the §7.3 snapshot of the page load that is ABOUT to happen.
   *
   * Deliberately not sent here: it is sent from `onNewDocument`, when the reloaded
   * page's agent says hello. That is the only moment at which the agent exists, is
   * listening, and can start watching for settle from document_start rather than from
   * whenever the worker got round to asking.
   */
  function expectSnapshot(tabId, fingerprint, options = {}) {
    const requestId = `s${(sequence += 1)}`;
    const entry = {
      requestId,
      tabId,
      kind: PROBE_PORT_MSG.SNAPSHOT,
      payload: { requestId, fingerprint, page: options.page !== false }
    };
    entry.promise = new Promise((resolve, reject) => {
      entry.finish = (value) => (value instanceof Error ? reject(value) : resolve(value));
      entry.timer = setTimeout(
        () => settle(entry, probeFailure(PROBE_FAIL.TIMEOUT, `no settled snapshot within ${PROBE_LIMITS.SETTLE_MS} ms`)),
        PROBE_LIMITS.SETTLE_MS
      );
    });
    pending.set(requestId, entry);
    return entry;
  }

  /**
   * One reload, one settle, one snapshot, checked (§7.1's per-reload cap, §6.2's
   * confidence floor). The caller counts the reload; this returns only an answer it is
   * safe to compare against another answer.
   */
  async function reloadAndSnapshot(tabId, fingerprint, options) {
    const waiting = expectSnapshot(tabId, fingerprint, options);
    let reloaded = false;
    try {
      reloaded = await deps.reload(tabId);
    } catch {
      reloaded = false;
    }
    if (!reloaded) {
      settle(waiting, probeFailure(PROBE_FAIL.NO_CONTENT_SCRIPT, 'the tab could not be reloaded'));
    }
    const answer = await waiting.promise;
    if (!answer || answer.ok !== true) {
      throw probeFailure(PROBE_FAIL.ELEMENT_LOST, (answer && answer.reason) || 'the page did not answer');
    }
    if (!answer.element || Number(answer.confidence) < PROBE_LIMITS.MIN_CONFIDENCE) {
      throw probeFailure(PROBE_FAIL.ELEMENT_LOST, `element re-resolved at confidence ${answer.confidence}`);
    }
    return answer;
  }

  /**
   * §7.6's second round trip: §6.2 fingerprints for the nodes the worker has just
   * decided are interesting, on the page that is already on screen.
   *
   * A missing answer costs the Binding its `elements[]`, not its proof, so this
   * resolves empty rather than failing a probe that has already been earned.
   */
  function fingerprints(tabId, keys) {
    const requestId = `f${(sequence += 1)}`;
    const entry = { requestId, tabId, kind: PROBE_PORT_MSG.FINGERPRINTS };
    entry.promise = new Promise((resolve) => {
      entry.finish = (value) => resolve(value instanceof Error ? { ok: false, fingerprints: [] } : value);
      entry.timer = setTimeout(() => settle(entry, { ok: false, fingerprints: [] }), PROBE_LIMITS.ANSWER_MS);
    });
    pending.set(requestId, entry);
    if (!send(tabId, PROBE_PORT_MSG.FINGERPRINTS, { requestId, keys })) {
      settle(entry, { ok: false, fingerprints: [] });
    }
    return entry.promise;
  }

  /** background.js hands every `port:probeResult` here. */
  function onProbeResult(tabId, payload) {
    const entry = payload && pending.get(payload.requestId);
    if (!entry || entry.tabId !== tabId) return;
    settle(entry, payload);
  }

  /**
   * A new document loaded in this tab. If a run is waiting for a snapshot, this is the
   * page it is waiting for — re-sent on EVERY new document rather than once, so a page
   * that reloads itself, or a user who presses F5 mid-probe, is answered by the load
   * that is actually on screen instead of by one that no longer exists.
   */
  function onNewDocument(tabId) {
    for (const entry of [...pending.values()]) {
      if (entry.tabId === tabId && entry.kind === PROBE_PORT_MSG.SNAPSHOT) {
        send(tabId, PROBE_PORT_MSG.SNAPSHOT, entry.payload);
      }
    }
  }

  /** Stop waiting for this tab — the run was cancelled, or has finished. */
  function abort(tabId, reason) {
    for (const entry of [...pending.values()]) {
      if (entry.tabId === tabId) settle(entry, probeFailure(reason || PROBE_FAIL.CANCELLED));
    }
  }

  /** How many requests are still open. Read by the tests, never by the protocol. */
  const openRequests = () => pending.size;

  return { reloadAndSnapshot, fingerprints, onProbeResult, onNewDocument, abort, openRequests };
}
