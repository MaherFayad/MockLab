/**
 * M4 — the probe's message contract (PLAN.md §7, §10.1C/D, §17.8).
 *
 * OWNER: probe-engineer. STAGED HERE, not in `messages.js`, for exactly the reason M3's
 * pick types were staged in `background/pickMessages.js`: `messages.js` belongs to
 * another agent and is read-only to this one, and §17.8's "no magic strings" cannot wait
 * for a merge. The values below are written the way `messages.js` writes them, so the
 * fold-in is a move and not a rewrite — nothing outside this file names any of these
 * strings except the mirrored block in `content/agent.js`, which spells the three PORT
 * values literally because a content script has no module graph (see the header of
 * `messages.js` and PLAN.md §17.2).
 *
 * WHEN THIS FILE MERGES: `PROBE_PORT_MSG` joins `PORT_MSG`, `PROBE_MSG` joins `MSG`, and
 * `PROBE_STATE` / `PROBE_STEP` / `PROBE_FAIL` sit beside `PHASE` for the same reason
 * `PHASE` does — they are payload vocabulary the PANEL reads off the wire, so the panel
 * must not import a service-worker module to learn what a word means.
 */

/* ─────────────────────────── agent.js (ISOLATED) <-> service worker, over the Port ── */

export const PROBE_PORT_MSG = {
  /**
   * SW -> agent. "Tell me what the page looks like once it has settled."
   * `{requestId, fingerprint, page:boolean}` — `fingerprint` is §6.2's, re-resolved in
   * the page after the reload; `page:false` skips §7.6's whole-page sample when only
   * the element and its region are needed.
   *
   * Sent immediately after a new document says HELLO, so the agent starts watching for
   * §7.3's settle conditions from document_start rather than from whenever the worker
   * happened to ask.
   */
  SNAPSHOT: 'port:probeSnapshot',

  /**
   * SW -> agent. `{requestId, keys:string[]}` — §6.2 fingerprints for nodes the worker
   * has just decided are interesting (§7.6's inverse discovery). A second round trip on
   * the SAME page load, because fingerprinting 3000 sampled nodes to use four of them
   * would cost a `querySelectorAll` per node for nothing.
   */
  FINGERPRINTS: 'port:probeFingerprints',

  /**
   * agent -> SW. The answer to either request above, correlated by `requestId`:
   * `{requestId, ok, settled?, element?, region?, page?, fingerprints?, reason?}`.
   * One reply type, because the worker awaits one promise per request id either way.
   */
  RESULT: 'port:probeResult'
};

/* ───────────────────────────────────── panel / MCP <-> service worker, one-shot ──── */

export const PROBE_MSG = {
  /**
   * Panel -> SW. §10.1C's "Find the real source". `{tabId?}` ->
   * `{ok:true, tabId}` | `{ok:false, reason}` where reason is a `PROBE_FAIL` value.
   * The probe then runs on its own; the panel follows it through `GET_PROBE`.
   */
  START_PROBE: 'msg:startProbe',

  /**
   * Panel -> SW. §11's `probe.cancel` ("Stop checking"). `{tabId?}` -> `{ok:true}`.
   * CLEANUP always runs: every `probe:true` Change is deleted and the page is put back
   * (PLAN.md §7.1, §17.5).
   */
  CANCEL_PROBE: 'msg:cancelProbe',

  /**
   * Panel -> SW. The whole progress card and, when it is over, §10.1 State D:
   * `{tabId?}` -> `{ok:true, tabId, origin, state, step, testing, reloads:{done,expected},
   *                 startedAt, result}`
   *
   * `state` is a `PROBE_STATE`, `step` a `PROBE_STEP` (which is the key of the §11
   * `probe.step.*` sentence to render), `testing` the number of possibilities in the
   * batch currently on the page (§11's `probe.step.testing(n)`), and `reloads` the
   * counter behind `probe.reloads(i, n)` — `done` is what has actually happened,
   * `expected` an estimate, which is why §11 phrases it "refresh 4 of ~8".
   *
   * `result` is null until the run ends, then either
   *   `{ok:true, binding, elements, affected, notRefetched}` or
   *   `{ok:false, reason}` with a `PROBE_FAIL` value naming the §11 sentence to show.
   */
  GET_PROBE: 'msg:getProbe',

  /**
   * SW -> panel broadcast. `{tabId, state}` — data-free beyond the state, by the same
   * reasoning as `SOURCES_CHANGED`, `CHANGES_CHANGED` and `PICK_CHANGED`: the panel
   * re-reads `GET_PROBE`, so the event can never go stale.
   */
  PROBE_CHANGED: 'msg:probeChanged'
};

/**
 * The four things the PANEL has to draw: nothing, a progress card, a result, a failure.
 * Coarser than `PROBE_STATE` on purpose — §10.1 has four screens, and a panel that
 * switched on nine states would have to be edited every time §7.1 grew one.
 *
 * `GET_PROBE` answers with both: `phase` for the screen, `state` for the detail.
 */
export const PROBE_PHASE = { IDLE: 'idle', RUNNING: 'running', DONE: 'done', FAILED: 'failed' };

/**
 * PLAN.md §7.1's state machine, named. This is what the probe is DOING; it is not a
 * link state. §17.4's three words (`verified` / `candidate` / `stale`) describe what
 * MockLab has PROVED about a field, and nothing here ever becomes one of them.
 */
export const PROBE_STATE = {
  IDLE: 'idle',
  CONTROL_A: 'controlA',
  CONTROL_B: 'controlB',
  TESTING: 'testing',
  VERIFY_ON: 'verifyOn',
  VERIFY_OFF: 'verifyOff',
  CONFIRMED: 'confirmed',
  CLEANUP: 'cleanup',
  DONE: 'done'
};

/**
 * The four sentences §11 gives the progress card, as keys of `S.probe.step`. The panel
 * renders `S.probe.step[step]`; `testing` is the one that takes the batch size.
 */
export const PROBE_STEP = {
  CONTROL: 'control',
  TESTING: 'testing',
  CONFIRMING: 'confirming',
  CLEANUP: 'cleanup'
};

/**
 * Why a probe ended without proving anything. The FIRST FIVE are keys of `S.probe` in
 * `strings.js` — §11 wrote the honest sentence for each, and the panel renders it by
 * name rather than by a code the worker invented.
 *
 * The REST have no `S.probe.*` sentence, because §11 wrote copy for a probe that ran and
 * found nothing, not for one that never started or one that broke. `NO_CANDIDATES` is
 * `pick.noCandidates`; the next four are conditions the panel already draws elsewhere —
 * nothing was picked (§10.1A), the tab has no page agent (the same `no-content-script`
 * `START_PICK` already answers with), the user's own Stop button, and a second START
 * arriving while a run is live.
 */
export const PROBE_FAIL = {
  TOO_NOISY: 'tooNoisy',
  NONE_CONFIRMED: 'noneConfirmed',
  ELEMENT_LOST: 'elementLost',
  NOT_REFETCHED: 'notRefetched',
  TIMEOUT: 'timeout',
  NO_CANDIDATES: 'noCandidates',
  NO_PICK: 'no-pick',
  NO_CONTENT_SCRIPT: 'no-content-script',
  CANCELLED: 'cancelled',
  BUSY: 'busy',
  /**
   * Not a fact about the page: MockLab itself threw. Kept apart from `TIMEOUT` and
   * `NONE_CONFIRMED` because reporting a defect of ours as a finding about the site is
   * the same class of lie as a false "Verified ✓" — the panel's sentence for it is
   * §11's `errors.pageBroke`, and the detail goes to the console.
   */
  INTERNAL: 'internal'
};
