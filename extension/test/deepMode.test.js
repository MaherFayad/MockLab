/**
 * Deep mode's LIFECYCLE: when the debugger is attached, and when it is not (PLAN.md §8).
 *
 * OWNER: probe-engineer. `deepFetch.test.js` beside it is the other half — what happens
 * to one paused navigation — split at the same seam the source is, because the two hold
 * different risks: this file is about a browser that must not be left wearing a debugging
 * bar, and that one is about a request that must always be released.
 *
 * Chrome's "being debugged" bar is on screen for every second between an attach and a
 * detach. So: off unless the person asked; gone the moment they stop asking, the tab
 * leaves the origin, the tab closes, or something takes the target away — and when it is
 * taken away, the SETTING stops claiming otherwise, because a checkbox that says deep
 * mode is on while nothing is intercepting is a false statement about MockLab's own
 * state (§17.12's family).
 *
 * `deep.browser.test.js` proves the same engine against real Chromium; this file makes
 * each outcome cheap to reproduce and reaches failures a browser will not perform on
 * request (an attach Chrome refuses, a `Fetch.enable` that fails after it).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  world, store, deepOn, flush, until, pausedEvent, ORIGIN, URL, TAB, OTHER
} from '../testlib/deepWorld.js';

const { LET_GO, FETCH_PATTERNS, KEEPALIVE_ALARM } = await import('../src/background/debuggerEngine.js');
const { quiet } = await import('../testlib/deepWorld.js');

test.beforeEach(() => {
  store.__data.clear();
});

test('1 off by default — nothing attaches to a site nobody asked for', async () => {
  const w = world();
  await w.engine.start();
  assert.deepEqual(w.of('attach'), [], 'the debugging bar is not a default');
  assert.deepEqual(w.engine.attachedTabs(), []);
  assert.deepEqual(w.of('Fetch.enable'), []);
});

test('2 an opted-in origin attaches once, with §8\'s Response-stage Document patterns', async () => {
  await deepOn(ORIGIN);
  const w = world();
  await w.engine.start();

  assert.deepEqual(w.of('attach').map((c) => c.args), [[TAB, '1.3']]);
  assert.deepEqual(w.of('Fetch.enable')[0].args[1].patterns, [
    { urlPattern: '*', requestStage: 'Response', resourceType: 'Document' }
  ]);
  assert.deepEqual(FETCH_PATTERNS.map((p) => p.resourceType), ['Document'], 'DEVIATION 1, pinned');
  assert.deepEqual(w.engine.attachedTabs(), [TAB]);
  assert.equal(w.engine.status(TAB).origin, ORIGIN);

  // A second sync must not attach a second time — Chrome answers that with an error and
  // the engine would read its own noise as a conflict.
  await w.engine.syncTab(TAB, URL);
  assert.equal(w.of('attach').length, 1);
});

test('3 the keepalive alarm exists only while something is attached', async () => {
  await deepOn(ORIGIN);
  const w = world();
  await w.engine.start();
  assert.deepEqual(w.of('alarms.create')[0].args[0], KEEPALIVE_ALARM);

  await w.engine.detach(TAB, LET_GO.OFF);
  assert.deepEqual(
    w.calls.filter((c) => c.name.startsWith('alarms.')).map((c) => c.name),
    ['alarms.clear', 'alarms.create', 'alarms.clear'],
    'cleared by the cold-start sweep, created on attach, cleared again when the last tab goes'
  );
});

test('4 leaving the origin detaches — the bar does not follow the person to the next site', async () => {
  await deepOn(ORIGIN);
  const w = world();
  await w.engine.start();

  w.emitUpdated(OTHER);
  await flush();
  assert.deepEqual(w.of('detach').map((c) => c.args), [[TAB]]);
  assert.deepEqual(w.of('Fetch.disable').length, 1, 'requests are released before the session goes');
  assert.deepEqual(w.engine.attachedTabs(), []);
});

test('5 turning the setting off detaches, through the same storage event the panel writes', async () => {
  await deepOn(ORIGIN);
  const w = world();
  await w.engine.start();
  assert.deepEqual(w.engine.attachedTabs(), [TAB]);

  await deepOn();
  w.emitSettings();
  await flush();
  assert.deepEqual(w.engine.attachedTabs(), [], '§10.5\'s checkbox needs no message type of its own');
  assert.equal(w.of('detach').length, 1);
});

test('6 a closed tab is forgotten without a detach call into a tab that is gone', async () => {
  await deepOn(ORIGIN);
  const w = world();
  await w.engine.start();
  w.emitRemoved();
  assert.deepEqual(w.engine.attachedTabs(), []);
  assert.deepEqual(w.of('detach'), []);
});

/* ══════════════════ when it cannot attach, and when it is taken away ═════════════ */

test('7 an attach Chrome refuses turns the setting off rather than lying about it', async () => {
  await deepOn(ORIGIN);
  const w = world();
  w.fail.set('attach', 'Another debugger is already attached to the tab with id: 11');

  const { said } = await quiet(() => w.engine.start());
  assert.deepEqual(w.engine.attachedTabs(), []);
  assert.deepEqual((await store.storage.local.get('settings')).settings.deepModeOrigins, [], 'rule 3');
  assert.match(said.join('\n'), /deep mode off for https:\/\/ssr\.test/);
  assert.deepEqual(w.of('Fetch.enable'), [], 'and nothing was enabled on a session that never opened');
});

test('8 an attach that succeeds and a Fetch.enable that fails leaves no bar standing', async () => {
  await deepOn(ORIGIN);
  const w = world();
  w.fail.set('Fetch.enable', 'Not allowed');

  await quiet(() => w.engine.start());
  assert.deepEqual(w.names().filter((n) => n === 'attach' || n === 'detach'), ['attach', 'detach']);
  assert.deepEqual(w.engine.attachedTabs(), []);
  assert.deepEqual((await store.storage.local.get('settings')).settings.deepModeOrigins, []);
});

test('9 a detach MockLab did not ask for turns the setting off; its own does not', async () => {
  await deepOn(ORIGIN);
  const w = world();
  await w.engine.start();

  // DevTools takes the target, or the person presses Cancel on Chrome's own bar.
  await quiet(async () => {
    w.emitDetach('canceled_by_user');
    await flush();
  });
  assert.deepEqual(w.engine.attachedTabs(), []);
  assert.deepEqual((await store.storage.local.get('settings')).settings.deepModeOrigins, []);

  // The other direction: an engine-initiated detach must NOT clear anything, or every
  // ordinary navigation away from the site would silently switch deep mode off. The fake
  // fires `onDetach` for our own detach too (see `world()`), which is what makes the
  // `releasing` flag the thing under test rather than an untouched line.
  await deepOn(ORIGIN);
  const w2 = world();
  await w2.engine.start();
  await w2.engine.detach(TAB, LET_GO.NAVIGATED);
  await flush();
  assert.deepEqual((await store.storage.local.get('settings')).settings.deepModeOrigins, [ORIGIN]);
});

test('10 a cold worker lets go of everything before it attaches to anything', async () => {
  await deepOn(ORIGIN);
  const w = world({ targets: [{ type: 'page', attached: true, tabId: TAB }, { type: 'page', attached: false, tabId: 12 }] });
  await w.engine.start();

  assert.deepEqual(
    w.names().filter((n) => n === 'detach' || n === 'attach'),
    ['detach', 'attach'],
    'an evicted worker leaves the attachment standing and its memory of it gone'
  );
  assert.deepEqual(w.of('detach').map((c) => c.args[0]), [TAB], 'an unattached target is left alone');
  assert.deepEqual((await store.storage.local.get('settings')).settings.deepModeOrigins, [ORIGIN], 'and the startup detach is not a conflict');
});

/* ═══════════════════════════ one paused navigation ══════════════════════════════ */

test('23 moving between two deep-mode sites re-attaches for the site it arrived at', async () => {
  // The case the "detach on navigation to a different origin" branch is really for.
  // Where the next origin is NOT opted in, the branch below it detaches anyway, so
  // deleting the branch changes nothing — mutation-checked, and this is the case that
  // moves. Without it the tab stays attached while `held.origin` names the site the
  // person LEFT, and every document on the new one is silently declined.
  const SECOND = 'https://other-ssr.test';
  const SECOND_URL = SECOND + '/trip/1';
  await deepOn(ORIGIN, SECOND);

  const w = world();
  await w.engine.start();
  assert.equal(w.engine.status(TAB).origin, ORIGIN);

  w.emitUpdated(SECOND_URL);
  await until(() => w.engine.status(TAB).origin === SECOND);
  assert.equal(w.engine.status(TAB).attached, true, 'still intercepting, now for the site it is on');
  assert.deepEqual(w.of('attach').length, 2, 'let go of the first, took the second');

  await w.pause(pausedEvent({ request: { url: SECOND_URL } }));
  assert.equal(w.captured.length, 1, 'the new site\'s document is read');
  assert.equal(w.captured[0].url, SECOND_URL);
});
