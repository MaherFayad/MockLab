/**
 * §10.5's two engines, from the panel's side — the parts that need no browser.
 *
 * OWNER: panel-designer. Written with the M7 addendum that made Deep mode and §12.3's
 * pairing REACHABLE: both had been finished engines behind a control a person could not
 * operate (`settings.js` rendered `disabled: true` with "still being built" over a deep
 * mode that has had seven passing tests since M7, and over a pairing flow that had worked
 * end to end since M6 from a test and from nowhere else).
 *
 * The seam with `panel.settings.browser.test.js`: that file drives the real controls in
 * real Chromium and reads what the real service worker stored. This one holds the
 * decisions those controls are made of, where they can be stated exhaustively —
 * which origins deep mode can mean anything for, what a patch to §4's `deepModeOrigins`
 * must contain, and which sentence each `PAIR_FAIL` value gets.
 *
 * Two source files, one screen: §10.5's rows are `panel/settings.js` and its AI-access
 * section is `panel/companion.js`, split at §17.10's ceiling. The tests are not split
 * with them — the checks below are the SCREEN's decisions, and which file a function
 * ended up in is not a fact about the product.
 *
 * Nothing here asserts today's WORDING. A test reading `assert.equal(msg, 'The companion
 * did not accept…')` passes just as happily with that sentence written into `settings.js`,
 * which is the §17.6 defect this repository has already shipped once; every copy check
 * below swaps `strings.js` for a sentinel and requires the sentinel to come back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { S } from '../src/panel/strings.js';
import { PAIR_FAIL, MSG } from '../src/background/messages.js';
import { deepModeUsable, deepOrigins, deepOriginsPatch } from '../src/panel/settings.js';
import {
  COMPANION_CONTRACT,
  EMPTY_COMPANION,
  loadCompanion,
  missingCompanionContract,
  pairFailMessage
} from '../src/panel/companion.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

/** Nothing a human would type, so a match can only have come from strings.js. */
const SENTINEL = '⟪sentinel⟫';

/** Swap one copy key for the sentinel, run, and put it back whatever happens. */
function withSentinel(group, key, run) {
  const saved = S[group][key];
  S[group][key] = SENTINEL;
  try {
    return run();
  } finally {
    S[group][key] = saved;
  }
}

/* ══════════════════════════ deep mode is per ORIGIN (§4, §8) ═══════════════════════ */

test('§8 deep mode can only mean something on a page the debugger can attach to', () => {
  for (const origin of ['https://www.trip.com', 'http://127.0.0.1:8517', 'https://x.test']) {
    assert.equal(deepModeUsable(origin), true, `${origin} is a website`);
  }
  // Every one of these reaches the panel as `state.origin` in real use: a new tab, the
  // extensions page, a local file, a tab MockLab has no answer for yet. The checkbox is
  // switched off for all of them WITH ITS REASON — never silently ineffective.
  for (const origin of ['', null, undefined, 'chrome://extensions', 'about:', 'about://', 'file://', 'https://', 'ftp://x.test']) {
    assert.equal(deepModeUsable(origin), false, `${String(origin)} is not a website`);
  }
  // The storage-key form has no path (`ruleStore.originOf`), so anything carrying one is
  // not an origin and must not be written into §4's list as if it were.
  assert.equal(deepModeUsable('https://x.test/page'), false);
});

test('§4 the deep-mode patch is a LIST of origins, and never a boolean', () => {
  // The mutation this exists for: writing `true`, or `[origin]`, into a settings key that
  // §4 declares as `string[]` and `debuggerEngine.js` reads as the set of sites to attach
  // to. Both look right on the screen that made the change and are only wrong somewhere
  // else — which is why the type is asserted before the contents.
  const before = ['https://a.test', 'https://b.test'];
  const on = deepOriginsPatch(before, 'https://c.test', true);
  assert.ok(Array.isArray(on), 'a boolean here disables deep mode for every other site');
  for (const entry of on) assert.equal(typeof entry, 'string');
  assert.deepEqual(on, ['https://a.test', 'https://b.test', 'https://c.test']);
});

test('§4 switching one site on or off leaves every OTHER site exactly where it was', () => {
  const before = ['https://a.test', 'https://b.test', 'https://c.test'];
  // ON, for a site already in the list: still there, still once, and nobody displaced.
  assert.deepEqual(deepOriginsPatch(before, 'https://b.test', true), [
    'https://a.test',
    'https://c.test',
    'https://b.test'
  ]);
  // OFF: that one goes and only that one.
  assert.deepEqual(deepOriginsPatch(before, 'https://b.test', false), ['https://a.test', 'https://c.test']);
  // OFF for a site that was never on: nothing changes, and nothing is invented.
  assert.deepEqual(deepOriginsPatch(before, 'https://z.test', false), before);
  // The input is never mutated — the panel keeps the old settings until the worker
  // answers, and a patch that edited them in place would leave the screen and the store
  // disagreeing if the write failed.
  assert.deepEqual(before, ['https://a.test', 'https://b.test', 'https://c.test']);
});

test('§4 a duplicate is impossible, and a settings object without the key is not a crash', () => {
  const twice = deepOriginsPatch(['https://a.test', 'https://a.test'], 'https://a.test', true);
  assert.deepEqual(twice, ['https://a.test'], 'one site is one entry');
  // A profile written before the key existed, or a worker that answered something else.
  assert.deepEqual(deepOrigins(undefined), []);
  assert.deepEqual(deepOrigins({}), []);
  assert.deepEqual(deepOrigins({ deepModeOrigins: 'https://a.test' }), [], 'a string is not a list of origins');
  assert.deepEqual(deepOrigins({ deepModeOrigins: ['https://a.test', 7, null] }), ['https://a.test']);
  assert.deepEqual(deepOriginsPatch(undefined, 'https://a.test', true), ['https://a.test']);
});

/* ═════════════════════ §12.3's two refusals, and no third one ══════════════════════ */

test('§12.3 there are exactly two ways a pairing can be refused', () => {
  // Not a style rule. `companion/src/pairing.js` hands the socket ONE indistinguishable
  // answer for all four of its refusals on purpose — that is MockLab's security boundary —
  // and `PAIR_FAIL` staying at two is the extension's half of it. A third value here would
  // mean the hub had started disclosing WHICH of the four fired.
  assert.deepEqual(Object.keys(PAIR_FAIL).sort(), ['NO_COMPANION', 'REFUSED']);
  assert.equal(new Set(Object.values(PAIR_FAIL)).size, 2, 'two names for one value is one reason drawn twice');
});

test('§11 every refusal has its OWN sentence, and no reason borrows another', () => {
  // The mutation: swapping the two arms. Asserted through the sentinel, so a sentence
  // hardcoded into settings.js fails even while reading exactly like §11's.
  assert.equal(withSentinel('companion', 'pairRefused', () => pairFailMessage(PAIR_FAIL.REFUSED)), SENTINEL);
  assert.equal(withSentinel('companion', 'pairNoCompanion', () => pairFailMessage(PAIR_FAIL.NO_COMPANION)), SENTINEL);
  // …and swapping them really is visible: neither arm may answer the other's sentence.
  assert.notEqual(pairFailMessage(PAIR_FAIL.REFUSED), pairFailMessage(PAIR_FAIL.NO_COMPANION));
  assert.equal(pairFailMessage(PAIR_FAIL.REFUSED), S.companion.pairRefused);
  assert.equal(pairFailMessage(PAIR_FAIL.NO_COMPANION), S.companion.pairNoCompanion);

  // The generalisation, so the NEXT value cannot arrive without copy: every reason the
  // contract declares has a sentence of its own, none of them falling through to the
  // "nothing answered" one.
  for (const reason of Object.values(PAIR_FAIL)) {
    const said = pairFailMessage(reason);
    assert.equal(typeof said, 'string');
    assert.ok(said.length > 0, `${reason} has no sentence`);
    assert.notEqual(said, S.companion.pairNoAnswer, `${reason} falls through to "no answer", which is a different fact`);
  }
});

test('§1.1 an answer that is neither refusal claims neither', () => {
  // An evicted service worker, a build with no handler, the panel's own 20s timeout. The
  // companion said nothing, so nothing may be said about the companion — and above all
  // not "the terminal says why", which would send a person to read an answer that is not
  // printed there.
  for (const reason of [undefined, null, '', 'no-answer', 'some-new-reason']) {
    assert.equal(pairFailMessage(reason), S.companion.pairNoAnswer, `“${String(reason)}” is not a refusal`);
  }
  assert.equal(withSentinel('companion', 'pairNoAnswer', () => pairFailMessage(undefined)), SENTINEL);
  const three = [S.companion.pairRefused, S.companion.pairNoCompanion, S.companion.pairNoAnswer];
  assert.equal(new Set(three).size, 3, 'three different situations need three different next steps');
});

/* ═════════════════ GET_COMPANION: two facts, and neither one guessed ═══════════════ */

/** A ctx that records what the panel asked and answers with `reply`. */
function fakeCtx(reply) {
  const sent = [];
  return {
    sent,
    state: {},
    send: async (type, payload) => {
      sent.push({ type, payload });
      return typeof reply === 'function' ? reply(type, payload) : reply;
    }
  };
}

test('§10.5 connected and paired are read as two separate facts', async () => {
  const ctx = fakeCtx({ ok: true, connected: true, paired: true });
  await loadCompanion(ctx);
  assert.deepEqual(ctx.sent, [{ type: MSG.GET_COMPANION, payload: {} }]);
  assert.equal(ctx.state.companion.ready, true);
  assert.equal(ctx.state.companion.connected, true);
  assert.equal(ctx.state.companion.paired, true);

  // The state §11 has no sentence for and `messages.js` insists is NOT an error: a paired
  // machine whose companion is not running. Both facts must survive the read separately,
  // or the dot has to guess one of them.
  const idle = fakeCtx({ ok: true, connected: false, paired: true });
  await loadCompanion(idle);
  assert.equal(idle.state.companion.paired, true);
  assert.equal(idle.state.companion.connected, false);
});

test('§1.1 a green dot is a claim, so only `true` earns one', async () => {
  // A worker that answers `{ok:true}` and nothing else has said nothing about a socket.
  const vague = fakeCtx({ ok: true });
  await loadCompanion(vague);
  assert.equal(vague.state.companion.ready, true);
  assert.equal(vague.state.companion.connected, false, 'absence of an answer is not a connection');
  assert.equal(vague.state.companion.paired, false);

  // And a truthy non-answer is not one either.
  const sloppy = fakeCtx({ ok: true, connected: 'yes', paired: 1 });
  await loadCompanion(sloppy);
  assert.equal(sloppy.state.companion.connected, false);
  assert.equal(sloppy.state.companion.paired, false);

  for (const answer of [{ ok: false, reason: 'no-answer' }, null, undefined]) {
    const refused = fakeCtx(answer);
    await loadCompanion(refused);
    assert.equal(refused.state.companion.ready, false, 'a worker that cannot answer leaves the section not-ready');
    assert.equal(refused.state.companion.connected, false);
    assert.equal(refused.state.companion.paired, false);
  }
});

test('§17.8 the section checks its contract before it sends anything at all', async () => {
  // Today `messages.js` defines all three, so the section is live.
  assert.deepEqual(missingCompanionContract(), []);
  assert.deepEqual(COMPANION_CONTRACT, ['PAIR_COMPANION', 'GET_COMPANION', 'COMPANION_CHANGED']);

  // And with one of them gone — the state every tab in this panel was written in before
  // its worker half landed — nothing is posted at the worker and the screen says so.
  const saved = MSG.GET_COMPANION;
  delete MSG.GET_COMPANION;
  try {
    assert.deepEqual(missingCompanionContract(), ['GET_COMPANION']);
    const ctx = fakeCtx({ ok: true, connected: true, paired: true });
    await loadCompanion(ctx);
    assert.deepEqual(ctx.sent, [], 'a message type this build does not define must not be posted as `undefined`');
    assert.equal(ctx.state.companion.ready, false);
    assert.equal(ctx.state.companion.connected, false, 'and nothing may be claimed about a companion nobody asked');
  } finally {
    MSG.GET_COMPANION = saved;
  }
  assert.deepEqual(missingCompanionContract(), []);
});

test('the empty companion state claims nothing before the first answer', () => {
  assert.equal(EMPTY_COMPANION.ready, null, 'null is "not asked yet"; false is "asked and refused"');
  assert.equal(EMPTY_COMPANION.connected, false);
  assert.equal(EMPTY_COMPANION.paired, false);
  assert.equal(EMPTY_COMPANION.form, null);
});

/* ═══════════ the suite this change adds is a suite CI actually invokes ═════════════ */

test('every browser suite is in CI’s `for suite in …` loop', () => {
  /* This repository has shipped a browser suite CI never invoked THREE times, and the
   * `ci.yml` comment asks whoever adds the next one to add it in the same change. That
   * request has been honoured by hand three times running and is still unchecked, so the
   * fourth time it is checked here: a suite outside the loop is zero coverage that reads
   * as green, which is this build's signature defect written in YAML.
   *
   * It lives in this file because this file's own change adds a browser suite. It is
   * a unit test on purpose — the browser suites skip themselves without Playwright, and
   * a guard about which suites run must not be one of the things that stops running. */
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const loop = /for suite in ([^;]+); do/.exec(workflow);
  assert.ok(loop, 'ci.yml must keep a `for suite in …; do` loop over the browser suites');
  const listed = new Set(loop[1].trim().split(/\s+/));
  const suites = fs
    .readdirSync(path.join(ROOT, 'extension', 'test'))
    .filter((name) => name.endsWith('.browser.test.js'))
    .map((name) => name.replace('.browser.test.js', ''));

  assert.ok(suites.length >= 10, `only ${suites.length} browser suites found — this check is not seeing the directory`);
  assert.deepEqual(
    suites.filter((name) => !listed.has(name)).sort(),
    [],
    'a browser suite CI never invokes is not run at all — add it to the loop in ci.yml'
  );
  // The other direction: a name in the loop with no file behind it fails the job the day
  // somebody renames a suite, which is a worse way to find out than this.
  assert.deepEqual(
    [...listed].filter((name) => !suites.includes(name)).sort(),
    [],
    'ci.yml names a browser suite that does not exist'
  );
});
