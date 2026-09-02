/**
 * M8 road B — the row machine, byte by byte.
 *
 * OWNER: interceptor-engineer. `rsc.test.js` is the fetch boundary; this file is what
 * happens to the BYTES: chunk boundaries in every possible place, length-framed rows,
 * tags the parser does not know, rows too big to hold, and the paths that address a row.
 *
 * The case this file exists for is the straddle. A JSON payload split across a chunk
 * boundary is what a naive implementation gets wrong and it is what actually happens on
 * the wire — an RSC response for a real page arrives in whatever pieces the network felt
 * like. So the first test does not pick a likely boundary: it puts one at EVERY byte
 * offset of the fixture and demands the same output from all of them.
 *
 * Every test carries a timeout, so a machine that stalls fails out loud.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ORIGIN, FLIGHT, FLIGHT_ROWS, TRAP_TEXT, enc,
  install, matchListFor, streamedResponse, readAll, readFlight, waitForCapture, textRow
} from '../testlib/rscWorld.js';

const URL_RSC = `${ORIGIN}/flights/LH401`;
const T = { timeout: 20000 };

/** Run `chunks` through the real patch with `changes` applied, and return the bytes. */
async function through(chunks, changes = [], options = {}) {
  const made = streamedResponse(chunks, options);
  const world = install(async () => made.response);
  world.setMatchList(await matchListFor(URL_RSC, changes));
  const got = await readAll(await world.fetch(URL_RSC), 8000);
  return { bytes: got, world, state: made.state };
}

/** The whole fixture with row 5's status swapped — the expected output, computed once. */
const EXPECTED = Buffer.concat([
  ...FLIGHT_ROWS.slice(0, 5),
  enc('5:{"status":"CANCELLED","gate":"A12"}\n')
]);
const SWAP = [{ path: '$["5"].status', value: 'CANCELLED' }];

/* ═══════════════════════════════ the straddle matrix ══════════════════════════════ */

test('a chunk boundary at EVERY byte offset produces the same rewritten bytes', T, async () => {
  const wrong = [];
  for (let at = 0; at <= FLIGHT.length; at += 1) {
    const { bytes } = await through([FLIGHT.subarray(0, at), FLIGHT.subarray(at)], SWAP);
    if (!bytes.equals(EXPECTED)) wrong.push(at);
  }
  assert.deepEqual(wrong, [], `boundaries that produced different bytes (of ${FLIGHT.length + 1})`);
});

test('a chunk boundary at every offset still captures all three model rows', T, async () => {
  // The straddle can break the capture without breaking the output: a row parsed twice,
  // or a row whose first half was dropped, shows up here and nowhere else.
  const wrong = [];
  for (let at = 0; at <= FLIGHT.length; at += 1) {
    const { world } = await through([FLIGHT.subarray(0, at), FLIGHT.subarray(at)], SWAP);
    const capture = await waitForCapture(world, (c) => !c.body.__unparsed, 1000);
    if (Object.keys(capture.body).sort().join(',') !== '0,4,5') wrong.push([at, Object.keys(capture.body)]);
    else if (capture.body['5'].status !== 'ON_TIME') wrong.push([at, 'captured the edited value']);
  }
  assert.deepEqual(wrong, [], 'offsets whose capture came out wrong');
});

test('one byte at a time is still one correct response', T, async () => {
  const chunks = [];
  for (let i = 0; i < FLIGHT.length; i += 1) chunks.push(FLIGHT.subarray(i, i + 1));
  const { bytes } = await through(chunks, SWAP);
  assert.equal(bytes.equals(EXPECTED), true, 'reassembled from 1-byte chunks');
});

test('a multi-byte character split across the boundary survives a rewrite', T, async () => {
  const row = enc('0:{"city":"München","sign":"✈️","status":"ON_TIME"}\n');
  const change = [{ path: '$["0"].status', value: 'ANNULLIERT' }];
  const wrong = [];
  for (let at = 0; at <= row.length; at += 1) {
    const { bytes } = await through([row.subarray(0, at), row.subarray(at)], change);
    const value = readFlight(bytes)[0].value;
    if (value.city !== 'München' || value.sign !== '✈️' || value.status !== 'ANNULLIERT') {
      wrong.push([at, JSON.stringify(value)]);
    }
  }
  assert.deepEqual(wrong, [], 'offsets that mangled UTF-8');
});

test('a text row split across the boundary keeps its length and its bytes', T, async () => {
  // Offsets inside row 3 specifically: its hex length, its comma, and its content.
  const start = FLIGHT.indexOf(enc('3:T'));
  const end = start + FLIGHT_ROWS[3].length;
  const wrong = [];
  for (let at = start; at <= end; at += 1) {
    const { bytes } = await through([FLIGHT.subarray(0, at), FLIGHT.subarray(at)], SWAP);
    const rows = readFlight(bytes);          // throws on broken framing
    if (rows.find((r) => r.id === '3').text !== TRAP_TEXT) wrong.push(at);
  }
  assert.deepEqual(wrong, [], 'offsets that damaged the text row');
});

/* ════════════════════ what it refuses to touch, and keeps whole ═══════════════════ */

test('an unknown row tag stops the parser and keeps every byte after it', T, async () => {
  const body = Buffer.concat([
    enc('0:{"status":"ON_TIME"}\n'),
    enc('1:Zsomething this parser has never seen\n'),
    enc('2:{"status":"ON_TIME"}\n')
  ]);
  const { bytes } = await through([body], [
    { path: '$["0"].status', value: 'CANCELLED' },
    { path: '$["2"].status', value: 'CANCELLED' }
  ]);
  assert.equal(readFlight(bytes)[0].value.status, 'CANCELLED', 'the row before it was edited');
  assert.equal(
    bytes.subarray(enc('0:{"status":"CANCELLED"}\n').length).equals(body.subarray(enc('0:{"status":"ON_TIME"}\n').length)),
    true,
    'from the unknown tag on, the bytes are the server\'s own — editing stops, mangling does not start'
  );
});

test('a row header that is not lowercase hex stops the parser', T, async () => {
  const body = Buffer.concat([enc('0:{"a":1}\n'), enc('BAD:{"a":1}\n'), enc('2:{"a":1}\n')]);
  const { bytes } = await through([body], [
    { path: '$["0"].a', value: 9 },
    { path: '$["2"].a', value: 9 }
  ]);
  assert.equal(bytes.toString('utf8').startsWith('0:{"a":9}\n'), true, 'the valid row before it');
  assert.equal(bytes.toString('utf8').endsWith('BAD:{"a":1}\n2:{"a":1}\n'), true, 'and nothing after it moved');
});

test('a length row with a bad hex count stops the parser rather than guessing', T, async () => {
  const body = Buffer.concat([enc('0:{"a":1}\n'), enc('1:Tzz,hello'), enc('2:{"a":1}\n')]);
  const { bytes } = await through([body], [{ path: '$["2"].a', value: 9 }]);
  assert.equal(bytes.toString('utf8').endsWith('1:Tzz,hello2:{"a":1}\n'), true, 'everything after it is verbatim');
});

test('a model row that is not valid JSON passes through verbatim', T, async () => {
  const body = enc('0:{"a":1,,}\n1:{"a":1}\n');
  const { bytes, world } = await through([body], [{ path: '$["1"].a', value: 9 }]);
  assert.equal(bytes.toString('utf8'), '0:{"a":1,,}\n1:{"a":9}\n', 'the broken row is left exactly as it came');
  const capture = await waitForCapture(world, (c) => !c.body.__unparsed);
  assert.equal('0' in capture.body, false, 'and it is not offered as a field either (§1.1)');
});

test('a response with no readable row at all stays {__unparsed}', T, async () => {
  const { bytes, world } = await through([enc('this is not flight data at all')], SWAP);
  assert.equal(bytes.toString('utf8'), 'this is not flight data at all', 'every byte survives');
  const capture = await waitForCapture(world, () => true);
  assert.equal(capture.body.__unparsed, true, 'the panel says it cannot edit this (source.streamedUnsupported)');
  assert.equal(capture.changeDropped, true, 'and that the Change did not apply');
});

test('a model row too big to hold is forwarded whole, and editing resumes after it', T, async () => {
  // The cap is on what the machine HOLDS, so it only bites when the row is still
  // incomplete: 600 KB arriving in 64 KB pieces with no newline yet. Past the cap the
  // bytes go out as they came and the row is not parsed at all — bounded memory bought
  // with one un-editable row rather than with a mangled one.
  const huge = enc(`0:{"filler":"${'x'.repeat(600 * 1024)}","status":"ON_TIME"}\n`);
  const chunks = [];
  for (let i = 0; i < huge.length; i += 64 * 1024) chunks.push(huge.subarray(i, i + 64 * 1024));
  chunks.push(enc('1:{"status":"ON_TIME"}\n'));
  const { bytes } = await through(chunks, [
    { path: '$["0"].status', value: 'CANCELLED' },
    { path: '$["1"].status', value: 'CANCELLED' }
  ]);
  assert.equal(bytes.subarray(0, huge.length).equals(huge), true, 'the oversized row is untouched');
  assert.equal(bytes.subarray(huge.length).toString('utf8'), '1:{"status":"CANCELLED"}\n', 'the next row still edits');
});

test('a stream that ends mid-row loses nothing', T, async () => {
  const body = enc('0:{"status":"ON_TIME"}\n1:{"status":"ON_T');
  const { bytes } = await through([body], SWAP.concat([{ path: '$["1"].status', value: 'X' }]));
  assert.equal(bytes.toString('utf8'), body.toString('utf8'), 'a half-arrived row is handed over as it is');
});

test('a final row with no trailing newline is rewritten, and gains none', T, async () => {
  const body = enc('0:{"status":"ON_TIME"}\n1:{"status":"ON_TIME"}');
  const { bytes } = await through([body], [{ path: '$["1"].status', value: 'CANCELLED' }]);
  assert.equal(bytes.toString('utf8'), '0:{"status":"ON_TIME"}\n1:{"status":"CANCELLED"}', 'no newline invented');
});

/* ═══════════════════════════ which path addresses what ═══════════════════════════ */

test('an index inside a row works, and so does a nested key', T, async () => {
  const { bytes } = await through([FLIGHT], [
    { path: '$["4"][3].price.total', value: 999 },
    { path: '$["4"][3].children[0][3].children', value: 'Cancelled' }
  ]);
  const row = readFlight(bytes).find((r) => r.id === '4').value;
  assert.equal(row[3].price.total, 999);
  assert.equal(row[3].children[0][3].children, 'Cancelled', 'the pill text the site will render');
  assert.equal(row[0], '$', 'the element sigil is untouched');
});

test('a one-step path replaces the whole row value', T, async () => {
  const { bytes } = await through([FLIGHT], [{ path: '$["5"]', value: { status: 'CANCELLED' } }]);
  assert.deepEqual(readFlight(bytes).find((r) => r.id === '5').value, { status: 'CANCELLED' });
});

test('two Changes on one row both apply, in order', T, async () => {
  const { bytes } = await through([FLIGHT], [
    { path: '$["5"].status', value: 'CANCELLED' },
    { path: '$["5"].gate', value: 'B7' }
  ]);
  assert.deepEqual(readFlight(bytes).find((r) => r.id === '5').value, { status: 'CANCELLED', gate: 'B7' });
});

test('Changes on two different rows both apply', T, async () => {
  const { bytes } = await through([FLIGHT], [
    { path: '$["5"].status', value: 'CANCELLED' },
    { path: '$["4"][3].status', value: 'CANCELLED' }
  ]);
  const rows = readFlight(bytes);
  assert.equal(rows.find((r) => r.id === '5').value.status, 'CANCELLED');
  assert.equal(rows.find((r) => r.id === '4').value[3].status, 'CANCELLED');
});

test('a path whose first step is an array index never names a row', T, async () => {
  // `$[0]` parses, and `0` is a real row id — but as an INDEX, not a key. A row is a key
  // in the captured object, so this must miss rather than "helpfully" match.
  const { bytes, world } = await through([FLIGHT], [{ path: '$[0].b', value: 'MOCKED' }]);
  assert.equal(bytes.equals(FLIGHT), true, 'nothing was rewritten');
  const capture = await waitForCapture(world, (c) => !c.body.__unparsed);
  assert.equal(capture.changeDropped, true);
});

test('a repeated row id keeps the FIRST value in the capture and edits both rows', T, async () => {
  const body = enc('0:{"status":"ON_TIME"}\n0:{"status":"DELAYED"}\n');
  const { bytes, world } = await through([body], [{ path: '$["0"].status', value: 'CANCELLED' }]);
  assert.equal(bytes.toString('utf8'), '0:{"status":"CANCELLED"}\n0:{"status":"CANCELLED"}\n');
  const capture = await waitForCapture(world, (c) => !c.body.__unparsed);
  assert.equal(capture.body['0'].status, 'ON_TIME', 'the capture is the first real value, never the edit');
});

test('rows past the capture cap still stream and still edit', T, async () => {
  // The cap bounds what the panel is told about, not what the page receives.
  const rows = [];
  for (let i = 0; i < 420; i += 1) rows.push(enc(`${i.toString(16)}:{"n":${i}}\n`));
  const body = Buffer.concat(rows);
  // Row 419 is `1a3` in hex and the 420th row — well past the 400-row capture cap.
  const { bytes, world } = await through([body], [{ path: '$["1a3"].n', value: -1 }]);
  assert.equal(bytes.toString('utf8').endsWith('1a3:{"n":-1}\n'), true, 'a row past the cap is still edited');
  assert.equal(bytes.length, body.length - 1, 'and every other row came through untouched');
  const capture = await waitForCapture(world, (c) => !c.body.__unparsed);
  assert.equal(Object.keys(capture.body).length, 400, 'the capture stops at the cap');
});

test('a text row and a model row that share an id do not confuse each other', T, async () => {
  const body = Buffer.concat([textRow('7', 'plain text'), enc('\n'), enc('7:{"status":"ON_TIME"}\n')]);
  const { bytes } = await through([body], [{ path: '$["7"].status', value: 'CANCELLED' }]);
  const rows = readFlight(bytes);
  assert.equal(rows[0].text, 'plain text', 'the text row is not JSON and is not touched');
  assert.equal(rows[1].value.status, 'CANCELLED', 'the model row with the same id is');
});

test('a row whose JSON does not round-trip is handed over as BYTES, not re-serialized', T, async () => {
  // The mutation this exists for survived every other byte check in these suites: make
  // rewriteRow() return `JSON.stringify(parsed)` for rows nothing touched. Most flight
  // rows round-trip byte-identically, so the fixture said nothing — and a row that does
  // NOT round-trip is exactly the row a site notices. `1.50`, `1e3` and `<` all come
  // back different, and `<` is not cosmetic: React escapes it so that a payload
  // inlined into a <script> cannot close it.
  const odd = enc('0:{"n":1.50,"e":1e3,"s":"\\u003cb\\u003e","t":"caf\\u00e9"}\n');
  const body = Buffer.concat([odd, enc('1:{"status":"ON_TIME"}\n')]);
  const { bytes } = await through([body], [{ path: '$["1"].status', value: 'CANCELLED' }]);
  assert.equal(bytes.subarray(0, odd.length).equals(odd), true, 'the untouched row is the server\'s own bytes');
  assert.equal(bytes.subarray(odd.length).toString('utf8'), '1:{"status":"CANCELLED"}\n', 'and the edit still landed');
});
