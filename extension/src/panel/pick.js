/**
 * Pick tab — PLAN.md §10.1 states A (idle), B (picking) and C (candidates).
 *
 * OWNER: panel-designer. Split from panel.js to stay under §17.10's ~500-line ceiling.
 *
 * §17.6: every word here comes from strings.js.
 * §17.7: every colour comes from panel.css.
 * §17.8: every message uses a declared constant from `background/messages.js`.
 *
 * ── What this file owns, and what `probe.js` next door owns ─────────────────────
 * Everything up to the moment an experiment starts: idle, picking, and the ranked list
 * of guesses. The progress card, State D and the failure cards are `probe.js`, and the
 * one-way import runs from here to there — so `probe.js` may never import this file.
 *
 * Two M3 promises are kept, and one is finally paid off:
 *   - the candidate rows are still rows, not buttons. There is no editor behind a GUESS;
 *     the way to a value is through the experiment, which is the button under them;
 *   - the "Recent links" list still filters on `state === 'verified'` and nothing looser
 *     — not `!== 'candidate'`, not truthiness, not "has elements";
 *   - those cards get their chevron and their click BACK, because State D now exists for
 *     them to open (Deviation 29). At M3 a chevron would have been a promise that
 *     something opens, drawn over nothing.
 *
 * ── Where this tab's message types live ─────────────────────────────────────────
 * Entering pick mode means reaching `content/agent.js`, which the panel can only do
 * through the service worker. M3's four pick types were staged in a separate
 * `background/pickMessages.js` while `messages.js` was owned by another agent; that
 * merge has landed, so both `MSG` and `PHASE` now come from `messages.js` and §17.8's
 * one-home rule holds without an asterisk.
 *
 * `missingPickContract` stays regardless. It is what keeps the promise on the button
 * honest: if a constant this tab sends ever goes missing, the button reports that it
 * cannot pick instead of posting `undefined` at the worker and appearing to hang.
 */
import { S } from './strings.js';
import { MSG, PHASE } from '../background/messages.js';
import { el, clear, ICON } from './dom.js';
import { formatValue, fieldLabel } from './sources.js';
import { VIEW, EMPTY_PROBE, canProbe, linkChip, openLink, renderFailure, renderProgress, startProbe } from './probe.js';
import { renderResult } from './result.js';

/** §10.1C — "max 12 rows". */
const MAX_CANDIDATES = 12;
/** §10.1A — "last 3 verified Links for this site". */
const MAX_RECENT = 3;

const EMPTY_PICK = { picking: false, element: null, candidates: [], searched: null };

/**
 * Did §6.3's search reach the end of this tab's data, or did it stop short?
 *
 * `GET_PICK` answers with `searched:{sources, bounded, complete}` because the search is
 * bounded on purpose: depth 24, 20 000 leaves per response, 120 000 across the tab —
 * without those ceilings one click blocks the worker for seconds. A ceiling that is hit
 * silently turns "MockLab stopped looking" into "there is nothing there", which is the
 * §17.12 failure told in the honest-sounding direction.
 *
 * The default is deliberately the humble one. A `searched` that is missing or malformed
 * is MockLab not KNOWING how far it got, and the sentence for not knowing is the one
 * that claims nothing about the data. Only an explicit `complete === true` — which the
 * worker sends on every real answer, including the blank record — buys the right to say
 * `pick.noCandidates`. So if this field is ever dropped from the message, the panel gets
 * quieter, never more confident.
 */
function searchReachedEverything(pick) {
  const searched = pick && pick.searched;
  return Boolean(searched) && searched.complete === true;
}

/**
 * Every message type this tab uses. Declared as a list so the button can check that the
 * contract is really there before it promises anything (see `canPick`).
 */
export const PICK_CONTRACT = ['START_PICK', 'CANCEL_PICK', 'GET_PICK', 'PICK_CHANGED'];

/** @returns {string[]} contract names the message module does not define. */
export function missingPickContract() {
  return PICK_CONTRACT.filter((name) => typeof MSG[name] !== 'string');
}

/** Can the picker actually be entered right now? */
function canPick(ctx) {
  return missingPickContract().length === 0 && Boolean(ctx.state.tabId);
}

/* ───────────────────────────────────────────────────────────────── the screens */

/**
 * Render the whole tab. Which of §10.1's three states shows is a function of the pick
 * state alone: idle (nothing picked), picking (waiting for a click on the page), or
 * candidates (something was picked).
 *
 * @param {HTMLElement} root the #panel-pick section — this function owns its contents
 * @param {{state:Object, send:Function, toast:Function, rerender:Function}} ctx
 */
export function renderPickTab(root, ctx) {
  clear(root);
  const pick = ctx.state.pick || EMPTY_PICK;
  const probe = ctx.state.probe || EMPTY_PROBE;
  // A running experiment outranks everything: §10.1C calls its card "full-panel", and
  // the person has been told not to touch the page until it finishes.
  if (probe.view === VIEW.RUNNING) {
    renderProgress(root, ctx);
    return;
  }
  if (pick.picking) {
    renderPicking(root);
    return;
  }
  if (probe.view === VIEW.RESULT) {
    renderResult(root, ctx);
    return;
  }
  if (probe.view === VIEW.FAILED) {
    renderFailure(root, ctx);
    // A failed run leaves the person somewhere, and §11's rule is to always say what to
    // do next. Picking again is the next thing that exists, so the button is under it.
    root.append(pickAgain(ctx));
    return;
  }
  if (pick.element) renderCandidates(root, ctx, pick);
  else renderIdle(root, ctx);
}

/** The secondary "Pick an element" that closes State C and the failure cards. */
function pickAgain(ctx) {
  const ready = canPick(ctx);
  const again = el(
    'button',
    { type: 'button', class: 'btn btn--secondary btn--wide', disabled: !ready },
    ICON.pick(),
    el('span', { text: S.pick.cta })
  );
  if (ready) again.addEventListener('click', () => void startPick(ctx));
  return again;
}

/** §10.1 State A — "illustration-free, calm". */
function renderIdle(root, ctx) {
  root.append(el('h2', { text: S.pick.title }), el('p', { class: 'help', text: S.pick.body }));

  const ready = canPick(ctx);
  const cta = el(
    'button',
    { type: 'button', class: 'btn btn--primary', disabled: !ready },
    ICON.pick(),
    el('span', { text: S.pick.cta })
  );
  if (ready) cta.addEventListener('click', () => void startPick(ctx));

  const live = el('div', { class: 'pick-live' }, cta);
  if (!ready) live.append(el('p', { class: 'help', text: S.soon }));
  root.append(live);

  const recent = recentLinks(ctx);
  if (recent) root.append(recent);
}

/**
 * §10.1B — "button becomes disabled with `pick.picking`; panel dims 60%".
 *
 * The instruction lives ON the button, which is where §10.1B puts it, and the button
 * is the one thing the dim spares (see `.pick-live` in panel.css): a 60% instruction
 * telling the person what to do next would be the one word on screen they cannot read.
 */
function renderPicking(root) {
  root.append(el('h2', { text: S.pick.title }), el('p', { class: 'help', text: S.pick.body }));
  const cta = el(
    'button',
    { type: 'button', class: 'btn btn--primary', disabled: true, 'aria-live': 'polite' },
    ICON.pick(),
    el('span', { text: S.pick.picking })
  );
  root.append(el('div', { class: 'pick-live' }, cta));
}

/** §10.1C — the picked element, then "Possible sources". */
function renderCandidates(root, ctx, pick) {
  // `label` is the worker's one-line name for the element: its text, else its accessible
  // name, else its tag — so an icon-only button still says something (§10.1C).
  const element = pick.element || {};
  const text = String(element.label || element.text || '').trim();
  root.append(el('h3', { class: 'section-title', text: S.pick.picked }));
  root.append(
    el(
      'div',
      { class: 'picked' },
      el('span', {
        // §10.1C: "text only". Quoted because it is the PAGE's words quoted back, not
        // MockLab's; an element with none says so rather than drawing an empty card.
        class: text ? 'picked__text' : 'picked__text picked__text--none',
        text: text ? S.glyph.quote(text) : S.pick.noText
      })
    )
  );

  // §10.1C: "max 12 rows … score-ordered". §6.3's engine already ranks and cuts; this
  // repeats both because the rank is what the person reads as "most likely", and the
  // screen that shows a claim is the one that has to be sure of it. Array#sort is
  // stable, so the worker's own tie-breaks (shorter path, then recency) survive intact.
  const shown = (pick.candidates || [])
    .filter(Boolean)
    .slice()
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, MAX_CANDIDATES);

  // §6.3's ceilings are real, so how far the search got is part of what this screen
  // means. Read once, used by both branches below.
  const wholeDataSearched = searchReachedEverything(pick);

  if (shown.length) {
    root.append(
      el(
        'div',
        { class: 'section-head' },
        el('h3', { class: 'section-title', text: S.pick.sources }),
        // §10.6: these are guesses from value matching, and "Possible" is the only word
        // in this product's vocabulary for that. One chip on the heading, not twelve on
        // the rows — it describes the whole list, and it is true of every row in it.
        chipNode('candidate', S.chips.candidate)
      )
    );
    // A list of twelve, ordered by likelihood, is read as "the possibilities". After a
    // bounded search that is a claim of completeness nobody made — so the list says so,
    // ABOVE the rows: a caveat under them arrives after the person has already decided
    // which row is the answer. Not a chip (§10.6 fixes the chip vocabulary at four and
    // this is not a status), but tinted from the same warning family as the "Possible"
    // chip beside it, so uncertainty reads as one block rather than two moods.
    if (!wholeDataSearched) root.append(el('p', { class: 'pick-note', text: S.pick.listIncomplete }));

    const rows = el('div', { class: 'cand-list' });
    for (const candidate of shown) rows.append(candidateRow(candidate, ctx));
    root.append(rows);

    // §10.1C's experiment. Enabled exactly when it can really run — which is what the
    // contract check answers, and nothing else: a button that promises an experiment it
    // cannot start is the same lie as a chevron over an editor that does not exist.
    const ready = canProbe(ctx);
    const cta = el('button', { type: 'button', class: 'btn btn--primary', disabled: !ready, text: S.probe.cta });
    if (ready) cta.addEventListener('click', () => void startProbe(ctx));
    const live = el('div', { class: 'pick-live' }, cta);
    // §11's `probe.intro` is what the person needs BEFORE pressing: how long it takes,
    // and that they must not click inside the page. It is only true if the button works.
    live.append(el('p', { class: 'help', text: ready ? S.probe.intro : S.soon }));
    root.append(live);
  } else if (wholeDataSearched) {
    // §6.3: "If ZERO candidates: tell the user honestly … and offer Check all fields".
    // This branch is the only one entitled to `noCandidates`, because that string is a
    // claim about the data ("couldn't find this text in any data the page loaded") and
    // only a search that reached the end of the data can make it.
    root.append(el('p', { class: 'empty', text: S.pick.noCandidates }));
    const ready = canProbe(ctx);
    const all = el('button', { type: 'button', class: 'btn btn--secondary', disabled: !ready, text: S.pick.checkAll });
    if (ready) all.addEventListener('click', () => void startProbe(ctx, { exhaustive: true }));
    const live = el('div', { class: 'pick-live' }, all);
    if (!ready) live.append(el('p', { class: 'help', text: S.soon }));
    root.append(live);
  } else {
    // Empty AND bounded. A different sentence, and deliberately no button under it.
    //
    // §6.3 offers "Check all fields" for the zero-candidate case; it does not describe
    // this one. Rendering that control here — disabled, as M4 requires — would put a
    // grey button directly beneath "MockLab couldn't reach every part of it" and make
    // it read as the cure, which is wrong twice over: it cannot be pressed at M3, and
    // an exhaustive pass is the same enumeration under the same ceilings, so it is not
    // promised to reach further either. `searchIncomplete` names the step that exists
    // today instead, and the "Pick an element" button below is still on screen.
    root.append(el('p', { class: 'empty', text: S.pick.searchIncomplete }));
  }

  root.append(pickAgain(ctx));
}

/**
 * One "Possible sources" row: friendly source name + the matched value in Fira Code
 * (§10.1C), plus the field it was found at.
 *
 * The field line is not in §10.1C, and it is not decoration. The demo alone produces
 * two rows reading "Trip … ON_TIME" — `$.status` and `$.booking.status` hold the same
 * value — and §10.1C's two columns draw them IDENTICALLY. A list whose whole job is
 * "pick the likeliest one" must never show two different things as the same thing
 * (§1.1), so the row says which field each one is, in the site's own words. That
 * vocabulary is already the default UI's: the §10.2 tree labels its rows with these
 * same keys, with no Advanced mode required.
 */
function candidateRow(candidate, ctx) {
  const row = el(
    'div',
    { class: 'cand' },
    el('span', { class: 'cand__name truncate', text: sourceName(ctx, candidate.sigId, candidate.sourceName) }),
    el('span', { class: 'cand__value mono truncate', text: formatValue(candidate.value) }),
    el('span', { class: 'cand__field truncate', text: fieldLabel(candidate.path) })
  );
  // §10.1D: "Advanced shows raw path" — the one place §1.2 permits the vocabulary.
  if (ctx.state.settings && ctx.state.settings.advancedMode) {
    row.append(el('span', { class: 'cand__path mono truncate', text: S.glyph.joinLabel(S.advanced.path, candidate.path) }));
  }
  return row;
}

/**
 * §10.1A — "last 3 verified Links for this site as selection cards".
 *
 * §17.12 lives in the filter on the next line. `state === 'verified'` and nothing
 * looser: not `!== 'candidate'`, not truthiness, not "has elements". Everything the
 * store can hold at M3 is a candidate, so this returns null and the section does not
 * exist — which is the honest picture and keeps `S.chips.verified` out of the panel.
 *
 * @returns {HTMLElement|null}
 */
function recentLinks(ctx) {
  const links = (ctx.state.bindings || [])
    .filter((binding) => binding && binding.state === 'verified')
    .sort((a, b) => (b.lastVerifiedAt || 0) - (a.lastVerifiedAt || 0))
    .slice(0, MAX_RECENT);
  if (!links.length) return null;

  const box = el('section', { class: 'stack' }, el('h3', { class: 'section-title', text: S.pick.recent }));
  for (const link of links) box.append(recentCard(link, ctx));
  return box;
}

/**
 * One proven Link. §10.1A ends this card with a chevron into the editor, and at M4 that
 * editor exists — so the chevron and the click come back (Deviation 29). It is a real
 * <button>: the card opens something, and a div with a click handler is a control that
 * a keyboard cannot reach.
 *
 * The chip is `linkChip(link.state)`, which derives BOTH the word and the colour from
 * the Link's own state. There is no argument to pass a word in, so no call site can pair
 * "Verified ✓" with a Link that is not verified — and `recentLinks` has already filtered
 * to `state === 'verified'`, so a slip that widened that filter would paint an amber
 * "Possible" card into this list rather than a green lie.
 */
function recentCard(link, ctx) {
  const where = (link.elements && link.elements[0] && link.elements[0].textAnchor) || '';
  const values = Array.isArray(link.observedValues) ? link.observedValues : [];
  const card = el(
    'button',
    { type: 'button', class: 'card card--link', dataset: { linkState: String(link.state || '') } },
    el(
      'div',
      { class: 'card__title' },
      el('span', { class: 'truncate', text: where ? S.glyph.quote(where) : sourceName(ctx, link.sigId) }),
      linkChip(link.state),
      el('span', { class: 'card__chevron' }, ICON.chevron())
    ),
    el(
      'div',
      { class: 'card__meta' },
      el('span', { class: 'truncate', text: sourceName(ctx, link.sigId) }),
      values.length ? el('span', { class: 'mono truncate', text: formatValue(values[0]) }) : null
    )
  );
  card.addEventListener('click', () => openLink(ctx, link));
  return card;
}

/**
 * The same friendly name the Sources tab shows (§10.2). The worker sends one with each
 * candidate; the local source list is the fallback for anything that arrives without.
 * Both come from `signatures.friendlyName`, so a source is never named two ways.
 */
function sourceName(ctx, sigId, given) {
  if (given) return given;
  const source = (ctx.state.sources || []).find((entry) => entry && entry.sigId === sigId);
  return (source && source.name) || S.sources.fallbackName;
}

/** The one chip on this screen that describes a LIST rather than a datum (§10.1C). */
function chipNode(kind, text) {
  return el('span', { class: `chip chip--${kind}`, text });
}

/* ─────────────────────────────────────────────────────────────────── behaviour */

/**
 * §10.1B's dim. Kept out of `renderPickTab` because it outlives the tab: the person can
 * switch to Sources mid-pick, and the panel must still look like it is waiting for a
 * click on the page. panel.js calls this on every render, whichever tab is showing.
 */
export function pickingChrome(picking) {
  document.body.classList.toggle('is-picking', Boolean(picking));
}

/**
 * Enter §6.1 pick mode.
 *
 * A tab with no live page agent (a chrome:// page, or a tab that was open before
 * MockLab was installed) answers `ok:false`. §1.1: say so and put the button back,
 * rather than leaving the person staring at "Click something on the page…" forever.
 */
export async function startPick(ctx) {
  if (!canPick(ctx)) return;
  const res = await ctx.send(MSG.START_PICK, { tabId: ctx.state.tabId });
  if (!res || !res.ok) {
    ctx.state.pick = { ...EMPTY_PICK };
    ctx.toast(S.errors.pageBroke, true);
    ctx.rerender();
    return;
  }
  ctx.state.pick = { picking: true, element: null, candidates: [] };
  ctx.rerender();
}

/**
 * Leave pick mode. §11's `pick.picking` promises "(Esc to cancel)", and that promise
 * has to hold when the keystroke lands in the PANEL rather than in the page — the panel
 * is where the person just clicked, so it is where the focus usually is.
 */
export async function cancelPick(ctx) {
  if (!ctx.state.pick || !ctx.state.pick.picking) return;
  if (missingPickContract().length) return;
  ctx.state.pick = { ...EMPTY_PICK };
  ctx.rerender();
  await ctx.send(MSG.CANCEL_PICK, { tabId: ctx.state.tabId });
}

/**
 * Read the live pick state from the worker. Called on boot and on every PICK_CHANGED,
 * so the panel shows the same thing whether the person clicked the page, pressed
 * Escape, or an agent drove the pick over MCP (§1.6).
 */
export async function loadPick(ctx) {
  if (missingPickContract().length) {
    ctx.state.pick = { ...EMPTY_PICK };
    return;
  }
  const res = await ctx.send(MSG.GET_PICK, { tabId: ctx.state.tabId });
  const phase = res && res.ok ? res.phase : PHASE.IDLE;
  ctx.state.pick = {
    picking: phase === PHASE.PICKING,
    // The element is only shown for a pick that finished. A picked element left over
    // from a phase that has moved on is a screen describing something that is no
    // longer true.
    element: phase === PHASE.PICKED ? res.element || null : null,
    candidates: phase === PHASE.PICKED ? res.candidates || [] : [],
    // How much of this tab's data the search behind those candidates actually reached
    // (§6.3). Carried at the same moment as the candidates and discarded with them: the
    // two are one answer, and a `searched` left over from a previous pick would describe
    // a search that produced a different list.
    searched: phase === PHASE.PICKED ? res.searched || null : null
  };
}
