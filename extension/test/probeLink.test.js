/**
 * The probe's conversation with the page: what happens when the page does not answer
 * (PLAN.md §7.1's timeouts, §6.2's confidence floor).
 *
 * OWNER: probe-engineer.
 *
 * These are the states no demo fixture can reach. The demo settles in under a second,
 * always re-resolves its own pill, and never loses its content script — so every path
 * below is unreachable on the acceptance harness, and unreachable in the browser suite
 * with it. A page that hangs, an agent evicted with the service worker, a tab the user
 * navigates away from mid-run: all of them are ordinary on real sites, and each one has
 * an honest sentence in §11 waiting for it.
 *
 * `PROBE_LIMITS` is a plain object, so the timeouts are lowered here rather than waited
 * out. That is a deliberate seam: a 15-second wait asserted 15 seconds at a time is a
 * test nobody runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createProbeLink, probeFailure, PROBE_LIMITS } from '../src/background/probeLink.js';
import { PROBE_PORT_MSG, PROBE_FAIL } from '../src/background/probeMessages.js';

const TAB = 3;
const FINGERPRINT = { css: '#status-pill', textAnchor: 'On time', attrAnchors: [], treePath: [1, 0] };

/** A port that records what it was asked and answers only when told to. */
function fakePort() {
  const sent = [];
  return { sent, postMessage: (message) => sent.push(message), dead: false };
}

function withLimits(patch, run) {
  const saved = { ...PROBE_LIMITS };
  Object.assign(PROBE_LIMITS, patch);
  return run().finally(() => Object.assign(PROBE_LIMITS, saved));
}

test('1 a page that never answers fails with §11\'s timeout, not with silence', async () => {
  const port = fakePort();
  const link = createProbeLink({ portsFor: () => new Set([port]), reload: async () => true });
  await withLimits({ SETTLE_MS: 120 }, async () => {
    const started = Date.now();
    await assert.rejects(
      link.reloadAndSnapshot(TAB, FINGERPRINT, {}),
      (error) => error.probeReason === PROBE_FAIL.TIMEOUT
    );
    assert.ok(Date.now() - started >= 100, 'it really waited for the budget');
  });
  assert.equal(link.openRequests(), 0, 'and the request is not left dangling');
});

test('2 the snapshot is asked for when the RELOADED document says hello, never before', async () => {
  const port = fakePort();
  const link = createProbeLink({ portsFor: () => new Set([port]), reload: async () => true });
  await withLimits({ SETTLE_MS: 200 }, async () => {
    const waiting = link.reloadAndSnapshot(TAB, FINGERPRINT, { page: false });
    assert.deepEqual(port.sent, [], 'nothing is sent to the page that is on its way out');

    link.onNewDocument(TAB);
    assert.equal(port.sent.length, 1);
    assert.equal(port.sent[0].type, PROBE_PORT_MSG.SNAPSHOT);
    assert.equal(port.sent[0].payload.page, false, 'the caller asked for no page sample');
    assert.deepEqual(port.sent[0].payload.fingerprint, FINGERPRINT);

    // A page that reloads itself mid-probe gets asked again, so the answer describes the
    // document that is actually on screen.
    link.onNewDocument(TAB);
    assert.equal(port.sent.length, 2);
    assert.equal(port.sent[1].payload.requestId, port.sent[0].payload.requestId, 'one request, re-sent');

    link.onProbeResult(TAB, { requestId: port.sent[0].payload.requestId, ok: true, confidence: 1, element: {} });
    await waiting;
    link.onNewDocument(TAB);
    assert.equal(port.sent.length, 2, 'and once it is answered, nothing is sent again');
  });
});

test('3 an answer for another tab, or for nothing, is ignored', async () => {
  const port = fakePort();
  const link = createProbeLink({ portsFor: () => new Set([port]), reload: async () => true });
  await withLimits({ SETTLE_MS: 150 }, async () => {
    const waiting = link.reloadAndSnapshot(TAB, FINGERPRINT, {});
    link.onNewDocument(TAB);
    const requestId = port.sent[0].payload.requestId;
    link.onProbeResult(TAB + 1, { requestId, ok: true, confidence: 1, element: {} });
    link.onProbeResult(TAB, { requestId: 'made-up', ok: true, confidence: 1, element: {} });
    link.onProbeResult(TAB, null);
    await assert.rejects(waiting, (error) => error.probeReason === PROBE_FAIL.TIMEOUT);
  });
});

test('4 §6.2 — an element re-resolved below 0.8 aborts, and the floor is exactly 0.8', async () => {
  const answer = async (confidence) => {
    const port = fakePort();
    const link = createProbeLink({ portsFor: () => new Set([port]), reload: async () => true });
    const waiting = link.reloadAndSnapshot(TAB, FINGERPRINT, {});
    link.onNewDocument(TAB);
    link.onProbeResult(TAB, {
      requestId: port.sent[0].payload.requestId, ok: true, settled: true, confidence, element: { text: 'On time' }
    });
    return waiting;
  };
  await assert.rejects(answer(0.5), (error) => error.probeReason === PROBE_FAIL.ELEMENT_LOST);
  await assert.rejects(answer(0), (error) => error.probeReason === PROBE_FAIL.ELEMENT_LOST);
  assert.equal((await answer(0.8)).confidence, 0.8, 'the floor itself passes');
  assert.equal((await answer(1)).confidence, 1);
});

test('5 a page that reports it could not answer is element-lost, not a silent success', async () => {
  const port = fakePort();
  const link = createProbeLink({ portsFor: () => new Set([port]), reload: async () => true });
  const waiting = link.reloadAndSnapshot(TAB, FINGERPRINT, {});
  link.onNewDocument(TAB);
  link.onProbeResult(TAB, { requestId: port.sent[0].payload.requestId, ok: false, reason: 'unavailable' });
  await assert.rejects(waiting, (error) => error.probeReason === PROBE_FAIL.ELEMENT_LOST);
});

test('6 a tab that cannot be reloaded says so at once, without waiting out the budget', async () => {
  const link = createProbeLink({ portsFor: () => new Set([fakePort()]), reload: async () => false });
  const started = Date.now();
  await assert.rejects(
    link.reloadAndSnapshot(TAB, FINGERPRINT, {}),
    (error) => error.probeReason === PROBE_FAIL.NO_CONTENT_SCRIPT
  );
  assert.ok(Date.now() - started < 1000, 'it did not sit through the 15 s settle budget');
  // A reload that THROWS is the same fact, and must not escape as a raw exception.
  const throwing = createProbeLink({ portsFor: () => new Set([fakePort()]), reload: async () => { throw new Error('gone'); } });
  await assert.rejects(
    throwing.reloadAndSnapshot(TAB, FINGERPRINT, {}),
    (error) => error.probeReason === PROBE_FAIL.NO_CONTENT_SCRIPT
  );
});

test('7 aborting a tab rejects what it was waiting for, with the reason given', async () => {
  const port = fakePort();
  const link = createProbeLink({ portsFor: () => new Set([port]), reload: async () => true });
  const waiting = link.reloadAndSnapshot(TAB, FINGERPRINT, {});
  link.abort(TAB + 1);
  assert.equal(link.openRequests(), 1, 'another tab\'s abort leaves this one alone');
  link.abort(TAB);
  await assert.rejects(waiting, (error) => error.probeReason === PROBE_FAIL.CANCELLED);
  assert.equal(link.openRequests(), 0);
});

test('8 a missing fingerprint answer costs the elements, never the proof', async () => {
  // §7.6 runs AFTER the field is proved. A page that will not answer this second round
  // trip must leave the Binding without its `elements[]`, not turn a proved link into a
  // failed probe — the evidence for the link is already in.
  const port = fakePort();
  const link = createProbeLink({ portsFor: () => new Set([port]), reload: async () => true });
  await withLimits({ ANSWER_MS: 80 }, async () => {
    assert.deepEqual(await link.fingerprints(TAB, ['pill']), { ok: false, fingerprints: [] });
  });
  assert.equal(port.sent.length, 1, 'it did ask');

  // The same when there is no page agent left to ask at all.
  const deaf = createProbeLink({ portsFor: () => null, reload: async () => true });
  assert.deepEqual(await deaf.fingerprints(TAB, ['pill']), { ok: false, fingerprints: [] });
});

test('9 a fingerprint answer that arrives is passed through whole', async () => {
  const port = fakePort();
  const link = createProbeLink({ portsFor: () => new Set([port]), reload: async () => true });
  const waiting = link.fingerprints(TAB, ['pill', 'banner']);
  const { requestId, keys } = port.sent[0].payload;
  assert.deepEqual(keys, ['pill', 'banner']);
  link.onProbeResult(TAB, { requestId, ok: true, fingerprints: [{ key: 'pill', fingerprint: { css: '#p' } }] });
  assert.deepEqual((await waiting).fingerprints, [{ key: 'pill', fingerprint: { css: '#p' } }]);
});

test('10 a failure carries the §11 sentence, and an ordinary error does not pretend to', () => {
  const failure = probeFailure(PROBE_FAIL.TOO_NOISY, 'text');
  assert.equal(failure.probeReason, 'tooNoisy');
  assert.equal(failure.probeDetail, 'text');
  assert.ok(failure instanceof Error);
  assert.equal(probeFailure(PROBE_FAIL.TIMEOUT).probeDetail, undefined);
  assert.equal(new Error('a bug of ours').probeReason, undefined,
    'which is how execute() tells a defect from a fact about the page');
});
