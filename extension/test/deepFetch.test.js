/**
 * Deep mode's ONE PAUSED NAVIGATION, from `Fetch.requestPaused` to the answer that
 * releases it (PLAN.md §8; `background/deepFetch.js`).
 *
 * OWNER: probe-engineer. `deepMode.test.js` beside it is the other half — when the
 * debugger is attached at all.
 *
 * Two invariants, and everything here is one of them:
 *
 *   • EVERY paused request is settled exactly once. Not settling one is not a missing
 *     feature; it is a tab that never finishes loading, with no error anywhere to explain
 *     it. Three ways out — decided, thrown, timed out — and a guard so that two of them
 *     arriving cannot both act.
 *   • `mocked` means the site was served MockLab's value. It is reported after the fulfil
 *     has succeeded or failed, never before: a rewrite that could not be delivered means
 *     the page rendered its REAL data, and a source that said otherwise would be MockLab
 *     making a false claim about its own work.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  world, store, deepOn, flush, pausedEvent, page, ORIGIN, URL, TAB
} from '../testlib/deepWorld.js';

const { LET_GO } = await import('../src/background/debuggerEngine.js');
const { PAUSE_BUDGET_MS } = await import('../src/background/deepFetch.js');
const { addChange, clearChanges } = await import('../src/background/ruleStore.js');
const { documentSigId } = await import('../src/background/documentData.js');
const { normalize } = await import('../src/background/signatures.js');
const { quiet } = await import('../testlib/deepWorld.js');

test.beforeEach(() => {
  store.__data.clear();
});

test('11 a document nobody has changed is continued untouched, and becomes a source', async () => {
  await deepOn(ORIGIN);
  const w = world();
  await w.engine.start();

  await w.pause();

  assert.deepEqual(w.of('Fetch.fulfillRequest'), [], '§5.1.2 — with nothing to do, hand back the original');
  assert.equal(w.of('Fetch.continueResponse').length, 1);
  assert.equal(w.captured.length, 1);
  const source = w.captured[0];
  assert.equal(source.via, 'document', '§10.2 renders "Page\'s built-in data" from this');
  assert.equal(source.mocked, false);
  assert.equal(source.changeDropped, false);
  assert.equal(source.body.props.pageProps.status, 'ON_TIME');
  assert.equal(source.sigId, documentSigId((await normalize('GET', URL)).sigId, '__NEXT_DATA__'));
  assert.deepEqual(w.engine.counts(), { paused: 1, rewritten: 0, continued: 1, lost: 0 });
});

test('12 a Change on an embedded field is what MV3 cannot do any other way', async () => {
  await deepOn(ORIGIN);
  const sigId = documentSigId((await normalize('GET', URL)).sigId, '__NEXT_DATA__');
  await addChange({ origin: ORIGIN, sigId, path: '$.props.pageProps.status', value: 'CANCELLED' });

  const w = world();
  await w.engine.start();
  await w.pause();

  const fulfil = w.of('Fetch.fulfillRequest');
  assert.equal(fulfil.length, 1);
  const sent = fulfil[0].args[1];
  assert.equal(sent.responseCode, 200);
  const html = Buffer.from(sent.body, 'base64').toString('utf8');
  assert.match(html, /"status":"CANCELLED"/);
  assert.match(html, /<span id="pill">On time<\/span>/, 'the server markup is not MockLab\'s to rewrite');
  assert.deepEqual(
    sent.responseHeaders.map((h) => h.name),
    ['content-type', 'set-cookie'],
    'content-length and content-encoding described a body that no longer exists'
  );
  assert.deepEqual(w.of('Fetch.continueResponse'), []);

  // The capture is still the REAL document (§5.1.2); `mocked` is what the page got.
  assert.equal(w.captured[0].body.props.pageProps.status, 'ON_TIME');
  assert.equal(w.captured[0].mocked, true);
  assert.deepEqual(w.engine.counts(), { paused: 1, rewritten: 1, continued: 0, lost: 0 });
  await clearChanges(ORIGIN);
});

test('13 a rewrite that could not be delivered never claims the page was mocked', async () => {
  await deepOn(ORIGIN);
  const sigId = documentSigId((await normalize('GET', URL)).sigId, '__NEXT_DATA__');
  await addChange({ origin: ORIGIN, sigId, path: '$.props.pageProps.status', value: 'CANCELLED' });

  const w = world();
  await w.engine.start();
  w.fail.set('Fetch.fulfillRequest', 'Invalid InterceptionId');
  await quiet(() => w.pause());

  assert.equal(w.of('Fetch.continueResponse').length, 1, 'the request is released either way');
  assert.equal(w.captured[0].mocked, false, 'the site rendered its own data, so nothing may say otherwise');
  assert.equal(w.captured[0].changeDropped, true, '§11 sources.changeDropped says exactly this');
  await clearChanges(ORIGIN);
});

test('14 §17.5 probe scaffolding is never applied through this path', async () => {
  await deepOn(ORIGIN);
  const sigId = documentSigId((await normalize('GET', URL)).sigId, '__NEXT_DATA__');
  await addChange({ origin: ORIGIN, sigId, path: '$.props.pageProps.status', value: 'PROBE_VALUE', probe: true });

  const w = world();
  await w.engine.start();
  await w.pause();

  assert.deepEqual(w.of('Fetch.fulfillRequest'), [], 'DEVIATION 2 — deep mode is no second road to a proof');
  assert.equal(w.captured[0].mocked, false);
  await clearChanges(ORIGIN);
});

test('15 every response deep mode has nothing to say about goes straight through', async () => {
  await deepOn(ORIGIN);
  const cases = [
    [pausedEvent({ responseStatusCode: 302 }), 'a redirect carries no document'],
    [pausedEvent({ responseHeaders: [{ name: 'content-type', value: 'text/x-component' }] }), '§8: RSC is out of scope for v1'],
    [pausedEvent({ responseHeaders: [{ name: 'content-type', value: 'application/json' }] }), 'not a document'],
    [pausedEvent({ responseHeaders: [] }), 'no content type is not an invitation'],
    [pausedEvent({ request: { url: 'https://other.test/x' } }), 'a URL that is not the origin this tab is held for']
  ];
  for (const [event, why] of cases) {
    const w = world();
    await w.engine.start();
    await w.pause(event);
    assert.deepEqual(w.of('Fetch.fulfillRequest'), [], why);
    assert.equal(w.of('Fetch.continueResponse').length, 1, why);
    assert.deepEqual(w.captured, [], `${why} — and it is not offered as a source either`);
  }
});

test('16 a page with no embedded data is continued and reported as nothing', async () => {
  await deepOn(ORIGIN);
  const w = world();
  w.api.__body = { body: '<html><body><h1>Plain</h1></body></html>', base64Encoded: false };
  await w.engine.start();
  await w.pause();
  assert.equal(w.of('Fetch.continueResponse').length, 1);
  assert.deepEqual(w.captured, []);
});

test('17 a base64 body from CDP is decoded, changed, and re-encoded', async () => {
  await deepOn(ORIGIN);
  const sigId = documentSigId((await normalize('GET', URL)).sigId, '__NEXT_DATA__');
  await addChange({ origin: ORIGIN, sigId, path: '$.props.pageProps.status', value: 'DELAYED' });

  const w = world();
  w.api.__body = { body: Buffer.from(page('ON_TIME'), 'utf8').toString('base64'), base64Encoded: true };
  await w.engine.start();
  await w.pause();

  const html = Buffer.from(w.of('Fetch.fulfillRequest')[0].args[1].body, 'base64').toString('utf8');
  assert.match(html, /"status":"DELAYED"/);
  await clearChanges(ORIGIN);
});

/* ═════════════════════ the invariant: it is always released ═════════════════════ */

test('18 a command that throws still releases the request', async () => {
  await deepOn(ORIGIN);
  const w = world();
  await w.engine.start();
  w.fail.set('Fetch.getResponseBody', 'No resource with given identifier found');

  const { said } = await quiet(() => w.pause());
  assert.equal(w.of('Fetch.continueResponse').length, 1, 'a tab that never loads is the worst outcome here');
  assert.match(said.join('\n'), /deep mode failed on a document/);
});

test('19 a decision that never comes is released by the budget', async (t) => {
  await deepOn(ORIGIN);
  const w = world();
  await w.engine.start();

  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    // A `Fetch.getResponseBody` that simply never answers — the shape of the hang.
    w.api.debugger.sendCommand = (target, method) => {
      w.calls.push({ name: method, args: [target.tabId] });
      return method === 'Fetch.getResponseBody' ? new Promise(() => {}) : Promise.resolve({});
    };
    w.emitPause(pausedEvent());
    t.mock.timers.tick(PAUSE_BUDGET_MS);
  } finally {
    t.mock.timers.reset();
  }
  await flush();
  assert.equal(w.of('Fetch.continueResponse').length, 1, 'three ways out, and this is the third');
});

test('20 a build without continueResponse falls back, and a lost request is counted', async () => {
  await deepOn(ORIGIN);
  const w = world();
  await w.engine.start();
  w.fail.set('Fetch.continueResponse', "'Fetch.continueResponse' wasn't found");

  await w.pause();
  assert.equal(w.of('Fetch.continueRequest').length, 1);
  assert.equal(w.engine.counts().continued, 1);

  const w2 = world();
  await w2.engine.start();
  w2.fail.set('Fetch.continueResponse', 'gone');
  w2.fail.set('Fetch.continueRequest', 'gone');
  const { said } = await quiet(() => w2.pause());
  assert.equal(w2.engine.counts().lost, 1, 'the only outcome that must be visible in a log');
  assert.match(said.join('\n'), /could not be released/);
});

test('21 a pause on a tab this engine has already let go of is released, not rewritten', async () => {
  await deepOn(ORIGIN);
  const w = world();
  await w.engine.start();
  await w.engine.detach(TAB, LET_GO.OFF);

  await w.pause();
  assert.deepEqual(w.of('Fetch.fulfillRequest'), []);
  assert.equal(w.of('Fetch.continueResponse').length, 1);
  assert.deepEqual(w.captured, []);
});

test('22 a decision that arrives AFTER the budget cannot settle the request a second time', async (t) => {
  // The `settled` guard, which nothing above reaches: test 19 leaves the decision hanging
  // for ever, so only one path ever runs. Found by mutating — deleting the guard left
  // every subtest in this file green, and the guard is the whole invariant of
  // `deepFetch.js`: fulfilling a request Chrome has already been told to continue, and
  // then filing a capture that says the page was mocked when it was not.
  await deepOn(ORIGIN);
  const sigId = documentSigId((await normalize('GET', URL)).sigId, '__NEXT_DATA__');
  await addChange({ origin: ORIGIN, sigId, path: '$.props.pageProps.status', value: 'CANCELLED' });

  const w = world();
  await w.engine.start();

  let releaseBody = null;
  const slow = new Promise((resolve) => { releaseBody = resolve; });
  const real = w.api.debugger.sendCommand;
  w.api.debugger.sendCommand = (target, method, params) => {
    if (method === 'Fetch.getResponseBody') {
      w.calls.push({ name: method, args: [target.tabId] });
      return slow;
    }
    return real(target, method, params);
  };

  t.mock.timers.enable({ apis: ['setTimeout'] });
  w.emitPause(pausedEvent());
  t.mock.timers.tick(PAUSE_BUDGET_MS);
  t.mock.timers.reset();

  // Now the answer turns up, late, with a rewrite in hand.
  releaseBody({ body: page('ON_TIME'), base64Encoded: false });
  await flush(30);

  assert.equal(w.of('Fetch.continueResponse').length, 1, 'the budget released it, once');
  assert.deepEqual(w.of('Fetch.fulfillRequest'), [], 'and the late decision may not fulfil what was already continued');
  assert.deepEqual(w.engine.counts(), { paused: 1, rewritten: 0, continued: 1, lost: 0 });
  assert.deepEqual(w.captured, [], 'nor file a source claiming a rewrite that never reached the page');
  await clearChanges(ORIGIN);
});

