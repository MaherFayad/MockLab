/**
 * Pick tab — PLAN.md §10.1's probe: the message contract it runs on, the progress card
 * it shows while it runs, and the failure cards that matter more than the success one.
 *
 * OWNER: panel-designer. Split from pick.js to stay under §17.10's ~500-line ceiling, and
 * split again at `result.js`, which draws State D itself. The seam is the experiment
 * against its outcome: everything here is about a RUN — its contract, its progress, and
 * the five honest ways it can end — while `result.js` is the card and the editor a
 * finished run leaves behind. The import runs one way, `result.js` -> here, so the value
 * editor can read `linkChip` and `proved` and this file never depends on the editor.
 *
 * §17.6: every word here comes from strings.js.
 * §17.7: every colour comes from panel.css.
 * §17.8: every message uses a declared constant from `background/messages.js`.
 *
 * ── §17.12 lives in this file ───────────────────────────────────────────────────
 * This is the milestone where "Verified ✓" becomes something the panel can actually
 * draw, and a wrong one is the worst bug this product can have. Two rules, both
 * mechanical, both mutation-tested in `panel.browser.test.js`:
 *
 *   1. `linkChip()` takes ONE argument — the Binding's own `state` — and derives BOTH
 *      the word and the colour from it. There is no call site anywhere that can pass
 *      "verified" the word beside a state that is not verified, because there is
 *      nowhere to pass a word.
 *   2. `proved()` is an `=== 'verified'` comparison and nothing looser, and it is what
 *      `result.js` prints §11's `probe.found` behind. It lives here, with the run, so
 *      the question is asked in one place rather than answered again by the screen.
 *
 * ── Where this tab's message types live ─────────────────────────────────────────
 * A probe runs in the service worker (§7), so every word on these screens comes off a
 * wire. The four message types and three payload vocabularies were staged in
 * `background/probeMessages.js` while `messages.js` had another owner, as M3's pick types
 * were. That merge has landed: both come from `messages.js` now, so §17.8's one-home rule
 * holds without an asterisk and the only edit here was a module specifier. Nothing in
 * this file invents a value; §17.8 holds through `PROBE_MSG` and the three vocabularies.
 *
 * The read is a NAMESPACE import on purpose. `import { PROBE_PHASE }` of an export that
 * is not there is a link-time error that kills the WHOLE panel — every tab, not just
 * this one — and a screen that fails to load is a worse answer than a button that says
 * it is not ready. So `missingProbeContract()` checks for each name instead, and while
 * anything is missing the probe button renders disabled with a reason beside it. That is
 * not a hypothetical: this file was written before the worker's half existed and ran
 * that way, and the panel's own suite states every assertion about the button against
 * the contract rather than against the day it was written.
 */
import { S } from './strings.js';
import * as PROBE from '../background/messages.js';
import { el, ICON, spinner, withTip } from './dom.js';

/** What the Pick tab is showing. Panel-local: none of this goes on a wire. */
export const VIEW = { IDLE: 'idle', RUNNING: 'running', RESULT: 'result', FAILED: 'failed' };

export const EMPTY_PROBE = {
  view: VIEW.IDLE,
  /** A key of `S.probe.step`, or '' when the worker has not said yet. */
  step: '',
  /** How many possibilities the run is testing — §11's `probe.step.testing(n)`. */
  testing: 0,
  /** `{index, estimate}` for §11's `probe.reloads`, or null before the first refresh. */
  reload: null,
  binding: null,
  /** The REAL value at the proved field, for §11's `editor.original`. */
  real: undefined,
  /** A key of `S.probe` naming the honest failure sentence, or ''. */
  failure: '',
  /** How many elements the run proved this field drives, when the Binding has no list. */
  affected: 0,
  /** §7.2 — the source did not re-occur on reload, so a Change on it applies later. */
  notRefetched: false,
  /** The value editor's working state — see `draftFrom`. */
  draft: null,
  /** Set once "Apply & refresh page" has succeeded, which is what reveals §10.1D's
   *  "Save as Scenario". */
  applied: false,
  /** True when this card was opened from a stored Link (§10.1A) rather than by a run
   *  that just finished, so a worker reporting "no probe" must not close it. */
  local: false
};

/** Message types this tab sends or listens for. */
export const PROBE_CONTRACT = ['START_PROBE', 'CANCEL_PROBE', 'GET_PROBE', 'PROBE_CHANGED'];
/** Payload vocabularies it reads off the wire. */
export const PROBE_VOCABULARY = ['PROBE_PHASE', 'PROBE_STEP', 'PROBE_FAIL'];

/** The message types, whatever module ends up holding them. */
export const PROBE_MSG = PROBE.PROBE_MSG || {};

/** @returns {string[]} contract names the message module does not define. */
export function missingProbeContract() {
  const types = PROBE_CONTRACT.filter((name) => typeof PROBE_MSG[name] !== 'string');
  const words = PROBE_VOCABULARY.filter((name) => !PROBE[name] || typeof PROBE[name] !== 'object');
  return types.concat(words);
}

/** Can an experiment actually be started right now? */
export function canProbe(ctx) {
  return missingProbeContract().length === 0 && Boolean(ctx.state.tabId);
}

/**
 * §17.4 / §17.12, in one comparison, exported so `result.js` asks the question here
 * rather than asking it again. `=== 'verified'` and nothing looser: not
 * `!== 'candidate'`, not truthiness, not "has elements". Everything the success card
 * says that a failure card does not — the chip, `probe.found`, the absence of
 * `editor.unverified` — hangs off this one function.
 */
export function proved(binding) {
  return Boolean(binding) && binding.state === 'verified';
}

/**
 * The status chip for a Link, both halves of it read off the SAME datum.
 *
 * The word is `S.chips[state]`, not a word handed in beside the state, so there is no
 * call site anywhere in this panel that could pair "Verified ✓" with a Binding that is
 * not verified — the pairing does not exist as a thing a caller can get wrong. The
 * `data-link-state` attribute is the same fact once more, in a form a test can read:
 * `panel.browser.test.js` asserts that every node in the panel reading "Verified ✓"
 * carries `verified` there and wears `.chip--verified`.
 */
export function linkChip(linkState) {
  const word = S.chips[linkState];
  if (!word) return null;
  return el('span', { class: `chip chip--${linkState}`, text: word, dataset: { linkState } });
}

/* ─────────────────────────────────────────────────── reading the worker's answer */

const phaseView = (phase) => {
  const P = PROBE.PROBE_PHASE;
  if (!P) return VIEW.IDLE;
  if (phase === P.RUNNING) return VIEW.RUNNING;
  if (phase === P.DONE) return VIEW.RESULT;
  if (phase === P.FAILED) return VIEW.FAILED;
  return VIEW.IDLE;
};

/** Wire step -> the key of `S.probe.step` that names its line. */
const stepKey = (step) => {
  const T = PROBE.PROBE_STEP;
  if (!T) return '';
  const table = { [T.CONTROL]: 'control', [T.TESTING]: 'testing', [T.CONFIRMING]: 'confirming', [T.CLEANUP]: 'cleanup' };
  return Object.prototype.hasOwnProperty.call(table, step) ? table[step] : '';
};

/**
 * Wire failure -> the key naming the sentence to print, in `FAIL_LINES` below.
 *
 * §7.1 can end a run for more reasons than §11 wrote copy for, and the two lists are
 * deliberately not forced to match: five are findings ABOUT THE PAGE and have their own
 * honest sentence; `NO_CANDIDATES` is §6.3's finding and already has one in `S.pick`;
 * and the rest — a run nobody started, a tab with no page agent, a defect of MockLab's
 * own — are not findings at all. Reporting one of those as a fact about the site would
 * be the same class of lie as a false "Verified ✓", so they map to '' and the card falls
 * back to §11's `errors.pageBroke`.
 */
const failureKey = (failure) => {
  const F = PROBE.PROBE_FAIL;
  if (!F) return '';
  const table = {
    [F.NONE_CONFIRMED]: 'noneConfirmed',
    [F.TOO_NOISY]: 'tooNoisy',
    [F.ELEMENT_LOST]: 'elementLost',
    [F.TIMEOUT]: 'timeout',
    [F.NOT_REFETCHED]: 'notRefetched',
    [F.NO_CANDIDATES]: 'noCandidates'
  };
  return Object.prototype.hasOwnProperty.call(table, failure) ? table[failure] : '';
};

/** Did the run end because the person pressed "Stop checking"? That is not a failure. */
const wasCancelled = (failure) => Boolean(PROBE.PROBE_FAIL) && failure === PROBE.PROBE_FAIL.CANCELLED;

/**
 * Read the live probe state from the worker (§1.6: an agent can start one over MCP, so
 * the panel follows the worker rather than only its own clicks).
 *
 * A worker that answers "nothing is running" CLOSES a card this run put on screen, and
 * deliberately does not close one the person opened from §10.1A's Recent links — that
 * card describes a Binding already in the store, not an experiment.
 */
export async function readProbe(ctx) {
  const previous = ctx.state.probe || EMPTY_PROBE;
  if (missingProbeContract().length) {
    ctx.state.probe = { ...EMPTY_PROBE };
    return;
  }
  const res = await ctx.send(PROBE_MSG.GET_PROBE, { tabId: ctx.state.tabId });
  if (!res || !res.ok) {
    // The probe is gone — the worker was evicted, or the tab changed. §17.5 sweeps its
    // scaffolding on startup, so "gone" really is the truth, and a card left saying
    // "Double-checking…" over nothing is exactly what §10.1 forbids.
    ctx.state.probe = previous.local ? previous : { ...EMPTY_PROBE };
    return;
  }
  const view = phaseView(res.phase);
  // A run the person STOPPED is not a finding, and must not be drawn as one. §7.1 ends a
  // cancelled run in the same FAILED state as a real failure, so the panel reads the
  // reason before it decides there is anything to report.
  if (view === VIEW.IDLE || (view === VIEW.FAILED && wasCancelled(res.failure))) {
    ctx.state.probe = previous.local ? previous : { ...EMPTY_PROBE };
    return;
  }
  const binding = res.binding || null;
  const same = binding && previous.binding && previous.binding.path === binding.path && previous.binding.sigId === binding.sigId;
  ctx.state.probe = {
    ...EMPTY_PROBE,
    view,
    step: stepKey(res.step),
    testing: Number(res.testing) || 0,
    reload: res.reload && Number(res.reload.index) > 0 ? res.reload : null,
    binding,
    real: res.value,
    // §7.6's inverse discovery fills the Binding's own `elements`; `affected` is the
    // worker's count of the same thing, and is the fallback rather than the source —
    // "This change affects {k} places" is a claim, so it comes from the proven list
    // wherever there is one.
    affected: Number(res.affected) || 0,
    // §7.2: the request behind this field did not come back on a reload, so a Change on
    // it applies the next time the site asks — not now (§11's `probe.notRefetched`).
    notRefetched: Array.isArray(res.notRefetched) && res.notRefetched.length > 0,
    failure: view === VIEW.FAILED ? failureKey(res.failure) : '',
    // The person's half-typed value and the toast they already saw belong to the FIELD,
    // so they survive a re-read about the same one and are dropped with a different one.
    // A null draft is SEEDED by `result.js` on first render, never here: this function
    // must stay readable by someone who has not opened the editor.
    draft: same ? previous.draft : null,
    applied: Boolean(same && previous.applied)
  };
}

/* ──────────────────────────────────────────────────────────────────── behaviour */

/**
 * §10.1C — "Find the real source" starts the probe.
 * `exhaustive` is §6.3's "Check all fields (slower)", offered only after a run has come
 * back with nothing confirmed.
 */
export async function startProbe(ctx, options = {}) {
  if (!canProbe(ctx)) return;
  const res = await ctx.send(PROBE_MSG.START_PROBE, {
    tabId: ctx.state.tabId,
    exhaustive: Boolean(options.exhaustive)
  });
  if (!res || !res.ok) {
    // A start refused because a run is ALREADY going is not something to apologise for;
    // the progress card the person is looking at is the answer. Anything else is.
    if (!(PROBE.PROBE_FAIL && res && res.reason === PROBE.PROBE_FAIL.BUSY)) {
      ctx.toast(S.errors.pageBroke, true);
      return;
    }
  }
  // §7.1's machine begins at CONTROL_A, so the first line is known before the first
  // broadcast arrives. The worker overwrites it milliseconds later; what this avoids is
  // a card that spins with no sentence on it for as long as the first reload takes.
  ctx.state.probe = { ...EMPTY_PROBE, view: VIEW.RUNNING, step: 'control' };
  ctx.rerender();
}

/** §11's `probe.cancel` — "Stop checking". §7.1 CLEANUP puts the site back. */
export async function stopProbe(ctx) {
  if (missingProbeContract().length) return;
  ctx.state.probe = { ...EMPTY_PROBE };
  ctx.rerender();
  await ctx.send(PROBE_MSG.CANCEL_PROBE, { tabId: ctx.state.tabId });
}

/** §10.1A — a Recent link card opens State D on a Binding the store already holds. */
export function openLink(ctx, binding) {
  const values = Array.isArray(binding.observedValues) ? binding.observedValues : [];
  ctx.state.probe = {
    ...EMPTY_PROBE,
    view: VIEW.RESULT,
    binding,
    // A stored Link carries no live capture with it, so the closest thing to "the real
    // value" is the first value the field was ever seen holding (§4 observedValues).
    real: values[0],
    local: true
  };
  ctx.rerender();
}

/** Close State D and go back to the tab's idle screen. */
export function closeResult(ctx) {
  ctx.state.probe = { ...EMPTY_PROBE };
  ctx.rerender();
}

/* ───────────────────────────────────────────────── the progress card — §10.1C */

/**
 * §10.1C's full-panel progress card. Its instruction is the one every other decision
 * here answers to: "NEVER let the user think it's stuck: every state change updates
 * the line."
 *
 * Four things move or say something, in order of how quickly they answer "is it
 * alive?": the spinner (which, until this milestone, could not actually spin — see
 * `dom.js`), the step line, the refresh counter, and — the one that never moves —
 * §11's `probe.intro`, because "Don't click inside the page while it runs" is the
 * standing rule for the whole run and belongs where the person is looking, not on the
 * screen they left thirty seconds ago.
 */
export function renderProgress(root, ctx) {
  const probe = ctx.state.probe || EMPTY_PROBE;
  const card = el('section', { class: 'probe-card' });
  card.append(el('div', { class: 'probe-card__spin' }, spinner('ml-probe-spin')));

  const line = stepLine(probe, ctx);
  // `aria-live` on the element that is always present, not on one that comes and goes:
  // a live region announces CHANGES to itself, and a region inserted at the same moment
  // its text appears announces nothing.
  card.append(el('p', { class: 'probe-step', role: 'status', 'aria-live': 'polite', text: line }));

  if (probe.reload && Number(probe.reload.index) > 0) {
    card.append(
      el('p', {
        class: 'probe-count mono',
        text: S.probe.reloads(Number(probe.reload.index), Number(probe.reload.estimate) || Number(probe.reload.index))
      })
    );
  }

  card.append(el('p', { class: 'help probe-card__intro', text: S.probe.intro }));

  const stop = el('button', { type: 'button', class: 'btn btn--danger btn--wide', text: S.probe.cancel });
  stop.addEventListener('click', () => void stopProbe(ctx));
  card.append(stop);
  root.append(card);
}

/**
 * §11's four step lines. An unknown step renders NOTHING rather than a guess: the
 * spinner, the counter and the standing instruction still say the run is alive, and
 * inventing a sentence about a state MockLab was not told about is the §17.12 failure
 * in its quietest form.
 */
function stepLine(probe, ctx) {
  const candidates = (ctx.state.pick && ctx.state.pick.candidates) || [];
  const testing = probe.testing || candidates.length;
  const lines = {
    control: S.probe.step.control,
    testing: testing > 0 ? S.probe.step.testing(testing) : '',
    confirming: S.probe.step.confirming,
    cleanup: S.probe.step.cleanup
  };
  return Object.prototype.hasOwnProperty.call(lines, probe.step) ? lines[probe.step] : '';
}

/* ─────────────────────────────────────────── the failure cards — §10.1D variants */

/**
 * §10.1D's failure variants, which matter more than the success one: this is the screen
 * that has to be honest when the experiment did not work. Every sentence is §11's, and
 * every one of them says what was actually established rather than apologising.
 */
export function renderFailure(root, ctx) {
  const probe = ctx.state.probe || EMPTY_PROBE;
  const lines = {
    noneConfirmed: S.probe.noneConfirmed,
    tooNoisy: S.probe.tooNoisy,
    elementLost: S.probe.elementLost,
    timeout: S.probe.timeout,
    notRefetched: S.probe.notRefetched,
    // §6.3's finding, not §7's: the run never started because value matching produced
    // nothing to test. §11 already wrote that sentence, in `pick`.
    noCandidates: S.pick.noCandidates
  };
  const sentence = Object.prototype.hasOwnProperty.call(lines, probe.failure) ? lines[probe.failure] : '';
  // A failure with no reason MockLab can name is still a failure the person is owed a
  // word about, and §11 has exactly one for "something went wrong here".
  const card = el(
    'section',
    { class: 'fail-card' },
    el('span', { class: 'fail-card__icon' }, ICON.warn()),
    el('p', { class: 'fail-card__text', text: sentence || S.errors.pageBroke })
  );

  // §6.3's way out, offered for the two endings it answers: a ranked list that confirmed
  // nothing, and a ranked list that was empty to begin with. It is NOT offered for a
  // noisy element, a lost one or a timeout — none of those is a problem of having looked
  // at too few fields, and a slow button that cannot help is a lie about where the
  // person is.
  if (probe.failure === 'noneConfirmed' || probe.failure === 'noCandidates') {
    const ready = canProbe(ctx);
    const more = el('button', { type: 'button', class: 'btn btn--secondary btn--wide', disabled: !ready, text: S.pick.checkAll });
    if (ready) more.addEventListener('click', () => void startProbe(ctx, { exhaustive: true }));
    card.append(ready ? more : withTip(more, [S.soon], { up: true }));
  }
  root.append(card);
}

