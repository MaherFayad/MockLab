/**
 * M8 road B — `text/x-component` (Next.js App Router flight data) edited IN FLIGHT.
 *
 * OWNER: interceptor-engineer. This file is the fetch boundary: what the page is handed,
 * when it is handed it, what is captured, and which streamed types stay refused.
 * `rscframing.test.js` beside it is the row machine — the byte-level matrix.
 *
 * ── THE DEFECT THIS CLOSES ────────────────────────────────────────────────────────────
 * Every interaction after first paint on an App Router site — filter, sort, paginate,
 * click a link — is a `fetch` for `text/x-component`. `isStreamingType()` refused those
 * outright, so MockLab changed nothing on such a site after the first render.
 *
 * ── THE DEFECT THAT MUST NOT COME BACK WHILE CLOSING IT ───────────────────────────────
 * The refusal was right about the reason: reading a live stream to completion never
 * completes, so buffering the body before handing the Response back hangs the page. Half
 * the tests below exist to keep that from being reintroduced — `resolves before the body
 * is complete`, `arrives incrementally`, and the cancellation pair. A patch that buffers
 * passes none of them.
 *
 * Every test carries a timeout. A hang here must be a RED LINE, not a suite that reports
 * nothing — that failure has already happened once in this repository.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ORIGIN, RSC_TYPE, FLIGHT, FLIGHT_ROWS, TRAP_TEXT, enc, sleep,
  install, matchListFor, streamedResponse, readAll, readFlight, waitForCapture, watch
} from '../testlib/rscWorld.js';

const URL_RSC = `${ORIGIN}/flights/LH401?_rsc=1a2b3`;
const T = { timeout: 10000 };

/** One page, one response, wired to the real patch. */
async function page(chunks, options = {}, changes = null) {
  const made = streamedResponse(chunks, options);
  const harness = install(async () => made.response);
  harness.setMatchList(changes ? await matchListFor(options.url || URL_RSC, changes) : []);
  return { ...harness, ...made };
}

/* ══════════════════════════ nothing matches: nothing changes ══════════════════════ */

test('no Change: the page is handed the ORIGINAL Response object', T, async () => {
  const world = await page([FLIGHT]);
  const got = await world.fetch(URL_RSC);
  assert.equal(got, world.response, '§17.2 — not a re-serialized copy, the same object');
});

test('no Change: the bytes are identical to the last byte', T, async () => {
  const world = await page(FLIGHT_ROWS);
  const got = await readAll(await world.fetch(URL_RSC));
  assert.equal(got.equals(FLIGHT), true, `${got.length} bytes out of ${FLIGHT.length} in`);
});

test('no Change: the model rows are captured, keyed by row id, with their real values', T, async () => {
  const world = await page(FLIGHT_ROWS);
  await readAll(await world.fetch(URL_RSC));
  const capture = await waitForCapture(world, (c) => c.url === URL_RSC && !c.body.__unparsed);

  assert.deepEqual(Object.keys(capture.body).sort(), ['0', '4', '5'], 'the three model rows');
  assert.equal(capture.body['5'].status, 'ON_TIME');
  assert.equal(capture.body['4'][3].price.total, 450);
  assert.equal(capture.mocked, false);
  assert.equal(capture.changeDropped, false);
  // §1.1: the tagged rows are not in there. A field MockLab cannot edit is not offered
  // as one — the panel is never handed `1` or `3` to draw a pencil next to.
  assert.equal('1' in capture.body, false, 'the client-module row is not offered');
  assert.equal('3' in capture.body, false, 'the text row is not offered');
});

test('a Change whose row is absent: the bytes are still identical', T, async () => {
  const world = await page(FLIGHT_ROWS, {}, [{ path: '$["9"].status', value: 'CANCELLED' }]);
  const got = await readAll(await world.fetch(URL_RSC));
  assert.equal(got.equals(FLIGHT), true, 'the transform is installed and changed nothing');
});

test('a Change that applies nowhere is reported dropped, never as applied', T, async () => {
  const world = await page(FLIGHT_ROWS, {}, [{ path: '$["5"].notAField', value: 'x' }]);
  await readAll(await world.fetch(URL_RSC));
  const capture = await waitForCapture(world, (c) => !c.body.__unparsed);
  assert.equal(capture.mocked, false, 'nothing was mocked');
  assert.equal(capture.changeDropped, true, 'and the panel can say so (Deviation 16)');
});

/* ═══════════════════════════════ the rewrite itself ═══════════════════════════════ */

test('a Change rewrites its row and leaves every other byte alone', T, async () => {
  const world = await page(FLIGHT_ROWS, {}, [{ path: '$["5"].status', value: 'CANCELLED' }]);
  const got = await readAll(await world.fetch(URL_RSC));

  const rows = readFlight(got);
  assert.equal(rows.find((r) => r.id === '5').value.status, 'CANCELLED', 'the site receives the new value');
  assert.equal(rows.find((r) => r.id === '5').value.gate, 'A12', 'and everything else in the row');
  // Every OTHER row byte-for-byte: the rewrite is one row wide.
  const before = FLIGHT.subarray(0, FLIGHT.length - FLIGHT_ROWS[5].length);
  assert.equal(got.subarray(0, before.length).equals(before), true, 'rows 0-4 are untouched bytes');
});

test('the capture holds the REAL value while the page holds the mock', T, async () => {
  const world = await page(FLIGHT_ROWS, {}, [{ path: '$["5"].status', value: 'CANCELLED' }]);
  const got = await readAll(await world.fetch(URL_RSC));
  const capture = await waitForCapture(world, (c) => !c.body.__unparsed);

  assert.equal(capture.body['5'].status, 'ON_TIME', 'the Sources tree shows the site\'s own data');
  assert.equal(readFlight(got).find((r) => r.id === '5').value.status, 'CANCELLED');
  assert.equal(capture.mocked, true);
  assert.equal(capture.changeDropped, false);
});

test('a Change names ONE row: an identical field in another row is untouched', T, async () => {
  const world = await page(FLIGHT_ROWS, {}, [{ path: '$["5"].status', value: 'CANCELLED' }]);
  const rows = readFlight(await readAll(await world.fetch(URL_RSC)));
  assert.equal(rows.find((r) => r.id === '4').value[3].status, 'ON_TIME', 'row 4 has the same key and keeps it');
});

test('a text row that CONTAINS a fake model row keeps its bytes and its length', T, async () => {
  // The trap: row 3's text holds `5:{"status":"CANCELLED"}` on a line of its own. A
  // newline-splitting parser rewrites it and the row's byte length then describes bytes
  // that are no longer there — which readFlight refuses to read.
  const world = await page(FLIGHT_ROWS, {}, [{ path: '$["5"].status', value: 'DELAYED' }]);
  const got = await readAll(await world.fetch(URL_RSC));

  const rows = readFlight(got);              // throws if the framing was broken
  assert.equal(rows.find((r) => r.id === '3').text, TRAP_TEXT, 'the text row is byte-for-byte');
  assert.equal(got.includes(enc(`3:T${Buffer.byteLength(TRAP_TEXT).toString(16)},`)), true, 'length prefix intact');
  assert.equal(rows.find((r) => r.id === '5').value.status, 'DELAYED', 'the REAL row 5 was the one edited');
});

/* ════════════════════════════ the Response that comes back ════════════════════════ */

test('the transformed Response drops content-length and keeps status', T, async () => {
  const world = await page(FLIGHT_ROWS, { headers: { 'content-length': String(FLIGHT.length) } },
    [{ path: '$["5"].status', value: 'CANCELLED' }]);
  const got = await world.fetch(URL_RSC);
  assert.equal(got.headers.get('content-length'), null, 'a rewritten row is a different length');
  assert.equal(got.headers.get('content-type'), RSC_TYPE, 'and the type still says what it is');
  assert.equal(got.status, 200);
});

test('a response with no body at all is handed back untouched', T, async () => {
  const response = new Response(null, { status: 200, headers: { 'content-type': RSC_TYPE } });
  const world = install(async () => response);
  world.setMatchList(await matchListFor(URL_RSC, [{ path: '$["5"].status', value: 'CANCELLED' }]));
  assert.equal(await world.fetch(URL_RSC), response, 'nothing to transform: the original');
  const capture = await waitForCapture(world, () => true);
  assert.equal(capture.changeDropped, true, 'and the edit is reported as not applied');
});

test('a body-less status is never wrapped in a transform', T, async () => {
  // A real Response cannot carry both 204 and a body, so this one is hand-made: the
  // guard exists because `new Response(stream, {status:204})` THROWS, and a throw inside
  // the patch is the one thing §17.2 forbids.
  const made = streamedResponse([FLIGHT]);
  const synthetic = {
    status: 204,
    statusText: 'No Content',
    type: 'basic',
    bodyUsed: false,
    body: made.response.body,
    headers: new Headers({ 'content-type': RSC_TYPE }),
    clone() { throw new Error('a 204 must never be cloned either'); }
  };
  const world = install(async () => synthetic);
  world.setMatchList(await matchListFor(URL_RSC, [{ path: '$["5"].status', value: 'CANCELLED' }]));
  assert.equal(await world.fetch(URL_RSC), synthetic, 'the original object, unwrapped');
});

/* ═════════════════ the other streamed types stay refused (§5.1.4) ═════════════════ */

for (const type of [
  'text/event-stream',
  'application/x-ndjson',
  'application/stream+json',
  'multipart/mixed; boundary=abc'
]) {
  test(`${type} is still refused: never read, never cloned, never transformed`, T, async () => {
    const world = await page([enc('data: LIVE 1\n\n')], { contentType: type }, [
      { path: '$["5"].status', value: 'CANCELLED' }
    ]);
    // Node's own Response constructor pulls a chunk out of any ReadableStream it wraps,
    // so "never read" is measured where MockLab would have to touch it: the body getter
    // and clone(). Both are zero here and both are non-zero on the RSC path.
    const seen = watch(world.response);
    const got = await world.fetch(URL_RSC);
    assert.equal(got, world.response, 'the ORIGINAL Response object');
    await sleep(60);
    assert.deepEqual(seen, { body: 0, clones: 0 }, 'never read, never cloned (§5.1.4)');
    const capture = await waitForCapture(world, () => true);
    assert.equal(capture.body.__unparsed, true, 'metadata only');
  });
}

test('an ordinary JSON response is still buffered and rewritten as before', T, async () => {
  const world = await page([enc('{"status":"ON_TIME"}')], { contentType: 'application/json' },
    [{ path: '$.status', value: 'CANCELLED' }]);
  const got = await world.fetch(URL_RSC);
  assert.equal(await got.text(), '{"status":"CANCELLED"}', 'the non-RSC path is untouched by this work');
});

/* ═══════════════════ streaming semantics: the whole point of M8B ══════════════════ */

test('fetch() resolves before the body is complete', T, async () => {
  // Three chunks, 250 ms apart. A patch that buffers the body before handing the
  // Response back cannot resolve in under 500 ms; this one resolves at the headers.
  const world = await page([FLIGHT_ROWS[0], Buffer.concat(FLIGHT_ROWS.slice(1, 4)), Buffer.concat(FLIGHT_ROWS.slice(4))],
    { gapMs: 250 }, [{ path: '$["5"].status', value: 'CANCELLED' }]);
  const started = performance.now();
  const got = await world.fetch(URL_RSC);
  const resolvedAt = performance.now() - started;

  assert.ok(resolvedAt < 150, `resolved at the headers (${Math.round(resolvedAt)} ms)`);
  const body = await readAll(got);
  assert.ok(world.state.sentAt.length === 3, 'the server really did send three chunks');
  assert.ok(
    world.state.sentAt[2] - world.state.sentAt[0] > 400,
    'and really did take its time about it — otherwise the measurement above proves nothing'
  );
  assert.equal(readFlight(body).find((r) => r.id === '5').value.status, 'CANCELLED');
});

test('a page reading the stream sees the FIRST chunk before the last one is sent', T, async () => {
  // The design claim, measured: with the transform installed, output leaves for the page
  // while the server is still writing. A transform that buffers to the end fails here —
  // every byte would arrive after `sentAt[2]`.
  const world = await page(
    [FLIGHT_ROWS[0], Buffer.concat(FLIGHT_ROWS.slice(1, 4)), Buffer.concat(FLIGHT_ROWS.slice(4))],
    { gapMs: 300 },
    [{ path: '$["5"].status', value: 'CANCELLED' }]
  );
  const got = await world.fetch(URL_RSC);
  const reader = got.body.getReader();

  const first = await reader.read();
  const firstAt = performance.now();
  assert.equal(first.done, false, 'a chunk arrived');
  assert.equal(Buffer.from(first.value).equals(FLIGHT_ROWS[0]), true, 'and it is row 0, whole');
  assert.equal(world.state.sentAt.length < 3, true, 'the server has not sent its last chunk yet');

  const rest = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    rest.push(Buffer.from(next.value));
  }
  assert.ok(
    firstAt < world.state.sentAt[2],
    `the page had row 0 ${Math.round(world.state.sentAt[2] - firstAt)} ms before the server sent the last chunk`
  );
  assert.equal(readFlight(Buffer.concat([FLIGHT_ROWS[0], ...rest])).length, 6, 'and the whole response still reads');
});

test('an unedited stream also arrives incrementally', T, async () => {
  // The no-Change path returns the original Response, so this measures that MockLab's
  // background capture is not silently sitting between the two.
  const world = await page([FLIGHT_ROWS[0], Buffer.concat(FLIGHT_ROWS.slice(1))], { gapMs: 300 });
  const reader = (await world.fetch(URL_RSC)).body.getReader();
  const first = await reader.read();
  const firstAt = performance.now();
  assert.equal(Buffer.from(first.value).equals(FLIGHT_ROWS[0]), true);
  await reader.read();
  assert.ok(firstAt < world.state.sentAt[1], 'row 0 reached the page before chunk 2 was sent');
  await reader.cancel();
});

/* ═════════════════════════════════ cancellation ═══════════════════════════════════ */

test('the page abandoning the body cancels the network stream', T, async () => {
  const world = await page(FLIGHT_ROWS, { gapMs: 40 }, [{ path: '$["5"].status', value: 'CANCELLED' }]);
  const got = await world.fetch(URL_RSC);
  const reader = got.body.getReader();
  await reader.read();
  await reader.cancel('the page navigated away');

  const deadline = Date.now() + 2000;
  while (!world.state.cancelled && Date.now() < deadline) await sleep(20);
  assert.equal(world.state.cancelled, true, 'the transform did not keep the stream alive');
});

test('a cancelled flight response still reports what had arrived', T, async () => {
  const world = await page(FLIGHT_ROWS, { gapMs: 30 }, [{ path: '$["5"].status', value: 'CANCELLED' }]);
  const reader = (await world.fetch(URL_RSC)).body.getReader();
  await reader.read();
  await reader.cancel();
  const capture = await waitForCapture(world, () => true);
  assert.equal(capture.url, URL_RSC, 'the source is still listed, from the rows that made it');
});

test('the capture-only path lets an endless flight stream go', T, async () => {
  // Nothing matches, so MockLab reads a CLONE for the Sources list. A response that never
  // ends must be released on the capture deadline rather than held open forever.
  const never = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(FLIGHT_ROWS[0])); },
    pull() { return new Promise(() => {}); },
    cancel() { never.wasCancelled = true; }
  });
  never.wasCancelled = false;
  const response = new Response(never, { status: 200, headers: { 'content-type': RSC_TYPE } });
  const world = install(async () => response);
  world.setMatchList([]);
  const got = await world.fetch(URL_RSC);
  assert.equal(got, response, 'handed back immediately, whatever the body is doing');

  const capture = await waitForCapture(world, () => true, 4000);
  assert.equal(capture.body['0'].b, 'XN4tR8bqzQ', 'the rows that arrived are what the panel gets');
});

test('an endless flight stream with a Change configured never delays the page', T, async () => {
  // THE HANG, in the one shape that can still produce it. `isStreamingType()` keeps
  // `x-component` on its refusal list as a net under the RSC branch; remove BOTH and a
  // flight response falls into the ordinary buffering path, where a matching Change makes
  // the patch wait out MODIFY_READ_TIMEOUT_MS (3 s) before the page gets its Response.
  // With either one of them in place this resolves immediately. That is what makes the
  // duplicated entry load-bearing rather than dead.
  let stream = null;
  const source = { cancelled: false };
  stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(FLIGHT_ROWS[0])); },
    pull() { return new Promise(() => {}); },      // never another chunk, never an end
    cancel() { source.cancelled = true; }
  });
  const response = new Response(stream, { status: 200, headers: { 'content-type': RSC_TYPE } });
  const world = install(async () => response);
  world.setMatchList(await matchListFor(URL_RSC, [{ path: '$["0"].b', value: 'MOCKED' }]));

  const started = performance.now();
  const got = await world.fetch(URL_RSC);
  const at = performance.now() - started;
  // Deliberately the ONLY assertion in this test. Refusing the response and transforming
  // it are both fine here; buffering it is not, and this is the one test that separates
  // "MockLab handled it differently" from "MockLab held the page".
  assert.ok(at < 500, `the page has its Response in ${Math.round(at)} ms, not after the stream ends`);
  await got.body.cancel().catch(() => {});
});

test('an endless flight stream is already flowing, edited, while it is still open', T, async () => {
  const source = { cancelled: false };
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(FLIGHT_ROWS[0])); },
    pull() { return new Promise(() => {}); },
    cancel() { source.cancelled = true; }
  });
  const response = new Response(stream, { status: 200, headers: { 'content-type': RSC_TYPE } });
  const world = install(async () => response);
  world.setMatchList(await matchListFor(URL_RSC, [{ path: '$["0"].b', value: 'MOCKED' }]));

  const reader = (await world.fetch(URL_RSC)).body.getReader();
  const first = await reader.read();
  assert.equal(
    Buffer.from(first.value).toString('utf8').startsWith('0:{"b":"MOCKED"'),
    true,
    'row 0 is edited and out of the door while the response is still open'
  );
  await reader.cancel();
});
