/**
 * Pick tab — PLAN.md §10.1 states A (idle), B (picking) and C (candidates).
 *
 * OWNER: panel-designer. Split from panel.js to stay under §17.10's ~500-line ceiling.
 *
 * §17.6: every word here comes from strings.js.
 * §17.7: every colour comes from panel.css.
 * §17.8: every message uses a declared constant — see the note on pickMessages.js below.
 *
 * ── What this file deliberately does NOT do ─────────────────────────────────────
 * State D (the result / editor card) and the probe progress card are §16 M4. Nothing
 * below runs a probe, and §17.12 is the reason the omission is loud rather than faked:
 * a wrong "Verified ✓" is the worst bug this product can have, so at M3
 *   - `probe.cta` is rendered, and rendered DISABLED with the reason beside it. Hiding
 *     it would misdescribe the screen; enabling it would promise an experiment that
 *     cannot run yet;
 *   - the candidate rows are rows, not buttons. There is no editor behind them at M3
 *     and an affordance that leads nowhere is a lie told with CSS;
 *   - the "Recent links" list filters on `state === 'verified'` and nothing else, so
 *     until a probe has confirmed something it renders NOTHING AT ALL — no heading, no
 *     empty-state box. An empty box under "Recent links on this site" would promise a
 *     shelf that fills itself; absence is the honest picture of "nothing is proven".
 *
 * ── Where this tab's message types live ─────────────────────────────────────────
 * Entering pick mode means reaching `content/agent.js`, which the panel can only do
 * through the service worker. §17.8 forbids magic strings, and `messages.js` was owned
 * by another agent for this milestone, so M3's four types are declared once in
 * `background/pickMessages.js` — a staging file whose own header says it merges into
 * `messages.js` in a single no-behaviour-change commit. This file imports the constants
 * and will need only its import line changed when that merge happens.
 *
 * `missingPickContract` stays regardless. It is what keeps the promise on the button
 * honest: if a constant this tab sends ever goes missing, the button reports that it
 * cannot pick instead of posting `undefined` at the worker and appearing to hang.
 */
import { S } from './strings.js';
import { PICK_MSG } from '../background/pickMessages.js';
// `PHASE` is §10.1's three states, named — and named, by its own comment, for this tab.
// It should sit in `pickMessages.js` beside `PICK_MSG` (it is payload vocabulary, not
// worker internals) so the panel need not reach into a service-worker module for it;
// that is a one-line move for whoever lands the merge commit pickMessages.js describes.
import { PHASE } from '../background/pickApi.js';
import { el, clear, ICON } from './dom.js';
import { formatValue } from './sources.js';
import { parsePath } from '../shared/jsonpath.js';

/** §10.1C — "max 12 rows". */
const MAX_CANDIDATES = 12;
/** §10.1A — "last 3 verified Links for this site". */
const MAX_RECENT = 3;

const EMPTY_PICK = { picking: false, element: null, candidates: [] };

/**
 * Every message type this tab uses. Declared as a list so the button can check that the
 * contract is really there before it promises anything (see `canPick`).
 */
export const PICK_CONTRACT = ['START_PICK', 'CANCEL_PICK', 'GET_PICK', 'PICK_CHANGED'];

/** @returns {string[]} contract names the message module does not define. */
export function missingPickContract() {
  return PICK_CONTRACT.filter((name) => typeof PICK_MSG[name] !== 'string');
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
  if (pick.picking) renderPicking(root);
  else if (pick.element) renderCandidates(root, ctx, pick);
  else renderIdle(root, ctx);
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
    const rows = el('div', { class: 'cand-list' });
    for (const candidate of shown) rows.append(candidateRow(candidate, ctx));
    root.append(rows);

    // §16 M4 owns the experiment. Disabled and explained beats hidden (the screen would
    // then misdescribe itself) and beats enabled (it would promise a probe that cannot
    // run). `S.soon` also names where the person CAN change a value today, which is
    // exactly what the rows above just told them: a source and a field.
    root.append(
      el(
        'div',
        { class: 'pick-live' },
        el('button', { type: 'button', class: 'btn btn--primary', disabled: true, text: S.probe.cta }),
        el('p', { class: 'help', text: S.soon })
      )
    );
  } else {
    // §6.3: "If ZERO candidates: tell the user honestly … and offer Check all fields".
    root.append(el('p', { class: 'empty', text: S.pick.noCandidates }));
    root.append(
      el(
        'div',
        { class: 'pick-live' },
        el('button', { type: 'button', class: 'btn btn--secondary', disabled: true, text: S.pick.checkAll }),
        el('p', { class: 'help', text: S.soon })
      )
    );
  }

  const ready = canPick(ctx);
  const again = el(
    'button',
    { type: 'button', class: 'btn btn--secondary btn--wide', disabled: !ready },
    ICON.pick(),
    el('span', { text: S.pick.cta })
  );
  if (ready) again.addEventListener('click', () => void startPick(ctx));
  root.append(again);
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
 * A field, read out the way the §10.2 tree draws it: the keys the site itself used,
 * from the outside in, with the `$.` and the brackets that only a programmer needs
 * dropped. `$.booking.status` → "booking · status". An unparseable path falls back to
 * itself rather than to nothing — showing something odd beats showing an unlabelled row.
 */
function fieldLabel(path) {
  const tokens = parsePath(String(path || ''));
  if (!tokens || !tokens.length) return String(path || '');
  return tokens
    .map((token) => (token.type === 'index' ? S.glyph.index(token.value) : String(token.value)))
    .reduce((trail, part) => S.glyph.joinDot(trail, part));
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
 * One proven Link. §10.1A ends this card with a chevron into the editor (State D),
 * which is §16 M4 — so at M3 the card carries no chevron and no click handler. A
 * chevron is a promise that something opens; drawing one over nothing is the same lie
 * as an enabled `probe.cta`. It comes back with State D.
 */
function recentCard(link, ctx) {
  const where = (link.elements && link.elements[0] && link.elements[0].textAnchor) || '';
  const values = Array.isArray(link.observedValues) ? link.observedValues : [];
  return el(
    'div',
    { class: 'card card--static' },
    el(
      'div',
      { class: 'card__title' },
      el('span', { class: 'truncate', text: where ? S.glyph.quote(where) : sourceName(ctx, link.sigId) }),
      // The chip's colour comes from the DATUM, never from a word written beside it.
      // `recentLinks` has already filtered to `state === 'verified'`, so this reads the
      // same fact twice — which is the point: a copy-paste slip that widens that filter
      // now shows the wrong-coloured chip loudly instead of painting every Link green.
      // It also keeps §17.4's grep honest: the literal 'verified' is assigned in exactly
      // one place in this codebase, and it is not a render helper's argument.
      chipNode(link.state, S.chips.verified)
    ),
    el(
      'div',
      { class: 'card__meta' },
      el('span', { class: 'truncate', text: sourceName(ctx, link.sigId) }),
      values.length ? el('span', { class: 'mono truncate', text: formatValue(values[0]) }) : null
    )
  );
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
  const res = await ctx.send(PICK_MSG.START_PICK, { tabId: ctx.state.tabId });
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
  await ctx.send(PICK_MSG.CANCEL_PICK, { tabId: ctx.state.tabId });
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
  const res = await ctx.send(PICK_MSG.GET_PICK, { tabId: ctx.state.tabId });
  const phase = res && res.ok ? res.phase : PHASE.IDLE;
  ctx.state.pick = {
    picking: phase === PHASE.PICKING,
    // The element is only shown for a pick that finished. A picked element left over
    // from a phase that has moved on is a screen describing something that is no
    // longer true.
    element: phase === PHASE.PICKED ? res.element || null : null,
    candidates: phase === PHASE.PICKED ? res.candidates || [] : []
  };
}
