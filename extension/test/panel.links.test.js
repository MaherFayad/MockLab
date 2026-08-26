/**
 * PLAN.md §1.1's THIRD link state, and §10.3's highlight from the panel's side.
 *
 * OWNER: panel-designer.
 *
 * "Three states exist everywhere in UI and API: `verified` … `candidate` … `stale` (was
 * verified, but the site changed and it no longer matches). … No silent downgrades."
 *
 * `verified` and `candidate` are written by the worker. `stale` is not written by anyone,
 * because it becomes true while nothing is running — a site redeploys, an endpoint moves,
 * an element is renamed — so the panel has to work it out at the moment it draws
 * (`links.js`). That makes it the one link state a browser suite against the demo site
 * (§14) cannot reach: the demo always serves both its sources and always renders both its
 * elements, which is exactly what it was built to do. This suite is where the state is
 * reachable, and it reaches it in both of the two ways a real site would.
 *
 * ── What every test here is written against ─────────────────────────────────────
 * §17.4 permits ONE assignment of the verified state in the whole codebase, in
 * `probe.js`. A function that computes a link state is the obvious place for a second one
 * to appear — so the property asserted below is not "it returns the right word for these
 * six inputs" (which a lookup table with a bug in it would also satisfy) but the
 * STRUCTURAL one: over every combination of stored state and observed world, the output
 * is either the stored state unchanged or the single word `stale`, and never anything
 * stronger than what the store already held. A `shownLinkState` that could raise a
 * candidate to proved fails that whatever else it gets right.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { S } from '../src/panel/strings.js';
import {
  NO_ANSWER,
  canHighlight,
  elementsLost,
  forgetLostLinks,
  knowsWhatLoaded,
  linkKey,
  liveSigIds,
  scenarioMisses,
  shownLinkState,
  showOnPage,
  sourceStillLoads
} from '../src/panel/links.js';

/** §10.6's whole status vocabulary. Nothing here may produce a fifth word. */
const STATES = ['verified', 'candidate', 'stale', '', undefined];

const link = (over = {}) => ({ id: 'l1', sigId: 'sig-trip', path: '$.status', state: 'verified', ...over });

/**
 * A panel context. `world` describes what this tab has SEEN, which is the only evidence
 * `links.js` is allowed to act on.
 */
function ctxWith(world = {}, sent = []) {
  const state = {
    tabId: 7,
    origin: 'http://127.0.0.1:8517',
    captured: world.captured !== false,
    sources: world.sources === undefined ? [{ sigId: 'sig-trip' }, { sigId: 'sig-user' }] : world.sources,
    bindings: [],
    lostLinks: new Set(world.lost || []),
    canHighlight: world.canHighlight !== false
  };
  const toasts = [];
  let renders = 0;
  return {
    state,
    toasts,
    get renders() {
      return renders;
    },
    send: async (type, payload) => {
      sent.push({ type, payload });
      return world.answer === undefined ? { ok: true, elements: 2, verified: true } : world.answer;
    },
    toast: (text) => toasts.push(text),
    rerender: () => {
      renders += 1;
    },
    refresh: async () => {}
  };
}

/* ══════════════════ the structural property: this may only ever downgrade ══════════ */

test('§17.4 no world can make this panel call a link proved that the store did not', () => {
  const worlds = [
    ['everything still loading', {}],
    ['the source stopped appearing', { sources: [{ sigId: 'sig-user' }] }],
    ['nothing captured at all', { captured: false, sources: [] }],
    ['captured, but this panel holds no list', { sources: [] }],
    ['the elements could not be found', { lost: [linkKey('sig-trip', '$.status')] }],
    ['both at once', { sources: [{ sigId: 'sig-user' }], lost: [linkKey('sig-trip', '$.status')] }]
  ];
  const seen = new Set();
  for (const stored of STATES) {
    for (const [what, world] of worlds) {
      const out = shownLinkState(link({ state: stored }), ctxWith(world));
      seen.add(out);
      assert.ok(
        out === (stored || '') || out === 'stale',
        `a link the store holds as ${JSON.stringify(stored)} is drawn as ${JSON.stringify(out)} when ${what}`
      );
      if (out === 'stale' && stored !== 'stale') {
        assert.equal(stored, 'verified', `only a PROVED link can go stale — this one was ${JSON.stringify(stored)}`);
      }
    }
  }
  // And the property is not vacuous: the matrix really did produce more than one word.
  assert.ok(seen.has('verified') && seen.has('stale') && seen.has('candidate'), `the matrix produced ${[...seen]}`);
});

test('§10.6 nothing here invents a fifth word', () => {
  const allowed = new Set(['verified', 'candidate', 'stale', '']);
  for (const stored of STATES) {
    for (const world of [{}, { sources: [] }, { captured: false }, { lost: [linkKey('sig-trip', '$.status')] }]) {
      const out = shownLinkState(link({ state: stored }), ctxWith(world));
      assert.ok(allowed.has(out), `shownLinkState produced ${JSON.stringify(out)}, which §10.6 has no chip for`);
    }
  }
});

/* ══════════════════════ each rule, in both directions ═════════════════════════════ */

test('§1.1 a proved link whose source stopped appearing reads as stale', () => {
  const gone = ctxWith({ sources: [{ sigId: 'sig-user' }] });
  assert.equal(shownLinkState(link(), gone), 'stale');
  // The other direction, one field apart: the same link, with its source still loading.
  const here = ctxWith({ sources: [{ sigId: 'sig-trip' }, { sigId: 'sig-user' }] });
  assert.equal(shownLinkState(link(), here), 'verified');
});

test('§1.1 a proved link whose elements could not be found reads as stale', () => {
  const lost = ctxWith({ lost: [linkKey('sig-trip', '$.status')] });
  assert.equal(shownLinkState(link(), lost), 'stale');
  // A DIFFERENT field of the same source is untouched — the observation is about one
  // link, not about the source it came from.
  assert.equal(shownLinkState(link({ path: '$.price.total' }), lost), 'verified');
});

test('§1.1 a tab MockLab has seen nothing on makes no claim either way', () => {
  // The failure this prevents is the honest-sounding one: a panel opened before the page
  // has loaded would otherwise mark every proved link on the site Stale, which reads as
  // "the site changed" and is a statement MockLab never established.
  for (const world of [{ captured: false, sources: [] }, { captured: false }, { sources: [] }]) {
    assert.equal(shownLinkState(link(), ctxWith(world)), 'verified', JSON.stringify(world));
    assert.equal(knowsWhatLoaded(ctxWith(world)), false);
    assert.equal(sourceStillLoads(ctxWith(world), 'anything-at-all'), true);
  }
});

test('a guess that stops matching is still exactly a guess', () => {
  // §10.6 has no word for "was a possibility and is not any more", and inventing one
  // would be a fifth state. A candidate is drawn as a candidate whatever the page does.
  const gone = ctxWith({ sources: [], captured: true });
  assert.equal(shownLinkState(link({ state: 'candidate' }), gone), 'candidate');
  assert.equal(shownLinkState(link({ state: 'candidate' }), ctxWith({ lost: [linkKey('sig-trip', '$.status')] })), 'candidate');
});

test('the observed facts are read from the tab, not remembered from another one', () => {
  const ctx = ctxWith();
  assert.deepEqual([...liveSigIds(ctx)].sort(), ['sig-trip', 'sig-user']);
  assert.equal(elementsLost(ctx, 'sig-trip', '$.status'), false);
  ctx.state.lostLinks.add(linkKey('sig-trip', '$.status'));
  assert.equal(elementsLost(ctx, 'sig-trip', '$.status'), true);
  // A new document makes the observation obsolete; it was about a page that is gone.
  forgetLostLinks(ctx);
  assert.equal(elementsLost(ctx, 'sig-trip', '$.status'), false);
  assert.equal(shownLinkState(link(), ctx), 'verified');
});

test('two links are told apart by BOTH the source and the field', () => {
  // `sigId + path` and not either alone: one source drives many fields, and the demo's
  // own `$.status` and `$.booking.status` live in the same response.
  assert.notEqual(linkKey('sig-trip', '$.status'), linkKey('sig-trip', '$.booking.status'));
  assert.notEqual(linkKey('sig-trip', '$.status'), linkKey('sig-user', '$.status'));
});

/* ══════════════════════════ §10.4's stale scenario card ═══════════════════════════ */

test('§10.4 a scenario is stale when ANY of its changes has nowhere to land', () => {
  const preset = {
    id: 'p1',
    changes: [
      { sigId: 'sig-trip', path: '$.status', value: 'CANCELLED' },
      { sigId: 'sig-gone', path: '$.x', value: 1 }
    ]
  };
  // §11's sentence for this card is "SOME changes may not apply", so one missing source
  // is the case it was written for.
  assert.equal(scenarioMisses(preset, ctxWith()), 1);
  assert.equal(S.scenarios.stale.toLowerCase().includes('some changes'), true, '§11 says "Some changes may not apply"');

  // Both present -> nothing to say.
  const whole = { id: 'p2', changes: [{ sigId: 'sig-trip', path: '$.status', value: 1 }] };
  assert.equal(scenarioMisses(whole, ctxWith()), 0);
  // Nothing captured -> nothing known, so nothing claimed.
  assert.equal(scenarioMisses(preset, ctxWith({ captured: false, sources: [] })), 0);
  // A scenario with no changes cannot be stale; it has nothing to fail to apply.
  assert.equal(scenarioMisses({ id: 'p3', changes: [] }, ctxWith()), 0);
  assert.equal(scenarioMisses({ id: 'p4' }, ctxWith()), 0);
});

/* ═══════════════════════ §10.3's highlight: three endings ═════════════════════════ */

test('§10.3 a highlight that drew something says nothing over it', async () => {
  const sent = [];
  const ctx = ctxWith({ answer: { ok: true, elements: 2, verified: true } }, sent);
  const result = await showOnPage(ctx, { sigId: 'sig-trip', path: '$.status' });
  assert.deepEqual(result, { ok: true, elements: 2 });
  assert.deepEqual(ctx.toasts, [], 'the answer is on the page; a toast would cover it up');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].payload, { tabId: 7, sigId: 'sig-trip', path: '$.status' });
  assert.equal(typeof sent[0].type, 'string');
  assert.ok(sent[0].type.length > 0, '§17.8 — the type is a constant, not undefined');
});

test('§10.3 a highlight that drew NOTHING says so, and the link goes stale', async () => {
  // This is §1.1's second stale trigger arriving live: §6.2's re-resolve failed on every
  // fingerprint the link holds. Before this call the link reads verified; after it, the
  // chip beside the button the person just pressed reads Stale.
  const ctx = ctxWith({ answer: { ok: true, elements: 0, verified: true } });
  assert.equal(shownLinkState(link(), ctx), 'verified');
  const result = await showOnPage(ctx, { sigId: 'sig-trip', path: '$.status' });
  assert.deepEqual(result, { ok: true, elements: 0 });
  assert.deepEqual(ctx.toasts, [S.highlight.none]);
  assert.equal(shownLinkState(link(), ctx), 'stale');
  assert.ok(ctx.renders > 0, 'and the screen is redrawn, or the chip is a lie until the next render');
});

test('§10.3 a worker that cannot highlight is reported as that, never as a fact about the page', async () => {
  // The §17.12 distinction: "MockLab cannot do this yet" and "those elements are not on
  // your page" are different sentences, and reporting the first as the second is the same
  // class of lie as a wrong "Verified ✓".
  //
  // SILENCE is what licenses this ending, and `NO_ANSWER` is what silence looks like by
  // the time `panel.send()` has wrapped it — no handler for this type in this build.
  const ctx = ctxWith({ answer: { ok: false, reason: NO_ANSWER } });
  assert.equal(canHighlight(ctx), true, 'the control starts available');
  const result = await showOnPage(ctx, { sigId: 'sig-trip', path: '$.status' });
  assert.deepEqual(result, { ok: false, elements: 0 });
  assert.deepEqual(ctx.toasts, [S.notYet]);
  assert.notEqual(S.notYet, S.highlight.none, 'the two endings must not share a sentence');
  // And the link is NOT marked stale by it: nothing was learned about the page.
  assert.equal(shownLinkState(link(), ctx), 'verified');
  // The control now wears its reason instead of pretending again.
  assert.equal(canHighlight(ctx), false);
});

/**
 * The ending this file did not have, and the defect it hid.
 *
 * Every `{ok:false}` used to mean "still being built", which was TRUE while no worker
 * answered `HIGHLIGHT` at all. `background/highlight.js` answers now, and refuses by name
 * — `no-tab` for a tab that closed mid-call, `no-content-script` for a `chrome://` page or
 * one opened before MockLab was installed. Those are events on a page, not a missing
 * feature, and the old mapping made each of them tell the person that a built feature was
 * unbuilt AND latch the control off for the whole session, on every site.
 *
 * Every refusal the worker can produce is stated here rather than one representative one,
 * because the rule is about the CLASS: anything that is not silence is an event.
 */
for (const reason of ['no-tab', 'no-content-script', 'bad-request', 'error', '']) {
  test(`§10.3 a highlight the worker refused (${reason || 'no reason given'}) is an event, not a missing feature`, async () => {
    const ctx = ctxWith({ answer: { ok: false, reason } });
    const result = await showOnPage(ctx, { sigId: 'sig-trip', path: '$.status' });
    assert.deepEqual(result, { ok: false, elements: 0 });
    // §11's one sentence for "something went wrong talking to this page" — not the
    // sentence for a part of MockLab that does not exist.
    assert.deepEqual(ctx.toasts, [S.errors.pageBroke]);
    // The control STAYS AVAILABLE. This is the half that made the old mapping expensive:
    // one chrome:// tab disabled "Show on page" everywhere until the panel was reopened.
    assert.equal(canHighlight(ctx), true, 'a refusal is an event; the next page is a different question');
    // And nothing was learned about the elements, so nothing is claimed about them.
    assert.equal(shownLinkState(link(), ctx), 'verified');
  });
}

test('§10.3 the three not-drawn endings are three different sentences', () => {
  // Collapsing any two of them is the defect above in a different direction: "MockLab
  // cannot do this", "this page would not answer" and "those elements are not here" are
  // three different things for a person to do next.
  const said = [S.notYet, S.errors.pageBroke, S.highlight.none];
  assert.equal(new Set(said).size, 3, `these three endings share a sentence: ${said}`);
});

test('§17.6 the highlight sentences come from strings.js, not from links.js', async () => {
  const SENTINEL = '⟪sentinel⟫';
  const saved = [S.highlight.none, S.notYet, S.errors.pageBroke];
  try {
    S.highlight.none = SENTINEL;
    S.notYet = SENTINEL + '2';
    const empty = ctxWith({ answer: { ok: true, elements: 0 } });
    await showOnPage(empty, { sigId: 'sig-trip', path: '$.status' });
    assert.deepEqual(empty.toasts, [SENTINEL]);
    const absent = ctxWith({ answer: { ok: false, reason: NO_ANSWER } });
    await showOnPage(absent, { sigId: 'sig-trip', path: '$.status' });
    assert.deepEqual(absent.toasts, [SENTINEL + '2']);
    // …and the third sentence, on the refusal path, from the same file.
    S.errors.pageBroke = SENTINEL + '3';
    const refused = ctxWith({ answer: { ok: false, reason: 'no-content-script' } });
    await showOnPage(refused, { sigId: 'sig-trip', path: '$.status' });
    assert.deepEqual(refused.toasts, [SENTINEL + '3']);
  } finally {
    S.highlight.none = saved[0];
    S.notYet = saved[1];
    S.errors.pageBroke = saved[2];
  }
});

test('§11 the stale sentence claims what was seen and not what it implies', () => {
  // `chips.stale` is one word on a chip; this is the sentence beside it, and the thing it
  // must not do is state the stronger fact. MockLab watched some data fail to arrive; it
  // did not watch the site change, and a page that simply has not loaded looks the same.
  const text = S.highlight.stale;
  assert.ok(text.length > 0);
  assert.doesNotMatch(text, /\b(the site (has )?changed|was (re)?deployed|is broken)\b/i, `“${text}” states more than was observed`);
  assert.doesNotMatch(text, /!/, '§11: no exclamation marks outside an applied moment');
  assert.match(text, /refresh/i, '§11: always say what to do next');
  assert.notEqual(text, S.editor.unverified, 'a link that was never proved and one that went stale are different facts');
});
