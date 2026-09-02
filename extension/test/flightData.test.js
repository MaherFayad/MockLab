/**
 * The App Router stream reader, over the streams that break it (PLAN.md §8).
 *
 * OWNER: probe-engineer. `documentData.test.js` holds the same bar for §8's two
 * written-down shapes; this file and `flightDocument.test.js` hold it for the shape §8
 * does not mention and the modern web is almost entirely made of — React's flight
 * stream, pushed into `self.__next_f` as text inside JavaScript string literals, cut at
 * arbitrary offsets.
 *
 * The seam between the two files is the same one §17.10 asks for and the same one the
 * source has: THIS file is the TEXT — decoding a literal, escaping one, splitting a
 * stream into rows, cutting a rewritten stream back up. `flightDocument.test.js` is the
 * DOCUMENT — which blocks a page yields, what §1.1 requires of one that cannot be
 * rewritten, and the demo fixture that has to stay readable.
 *
 * The bar, unchanged: a document MockLab does not fully understand must come back
 * BYTE-IDENTICAL, and one it does understand must come back parseable. A rewrite that
 * half-works is a page that dies on load, which is worse than deep mode not working at
 * all — so most of what follows is about REFUSING, and each refusal is tested from both
 * sides (it fires when it should, and the thing it guards really is broken without it).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeStringLiteral,
  escapeFlight,
  scanRows,
  recutPushes,
  flightSplices
} from '../src/background/flightData.js';
import { readEmbedded, applyToDocument } from '../src/background/documentData.js';
import { flightPage as page, flightLiteral as literal } from '../testlib/flightPage.js';

/** The trip row most tests below edit: row 0, a model tree with a status inside it. */
const TRIP = ['$', '$L3', null, { trip: { status: 'ON_TIME', price: { total: 450 } } }];
const TRIP_STREAM = '2:I[4707,[],""]\n0:' + JSON.stringify(TRIP) + '\n';
const STATUS = '$["0"][3].trip.status';

/* ═════════════════════════════ the string literal decoder ════════════════════════ */

test('1 the decoder reads every escape a chunk really carries', () => {
  const cases = [
    ['plain', 'plain'],
    ['a\\"b', 'a"b'],
    ['a\\\\b', 'a\\b'],
    ['a\\/b', 'a/b'],
    ['line\\nnext', 'line\nnext'],
    ['tab\\there', 'tab\there'],
    ['\\r\\b\\f\\v', '\r\b\f\v'],
    ['\\u003cdiv\\u003e', '<div>'],
    ['\\u0026', '&'],
    ['\\x41', 'A'],
    ['\\u{1F6EB}', '\u{1F6EB}'],
    ['\\u2028', '\u2028']
  ];
  for (const [source, want] of cases) {
    const read = decodeStringLiteral(`"${source}"`, 0);
    assert.ok(read, source);
    assert.equal(read.value, want, source);
    assert.equal(read.end, source.length + 2, `${source} ends at its closing quote`);
  }
  assert.equal(decodeStringLiteral("'it\\'s'", 0).value, "it's", 'a single-quoted literal too');
});

test('2 the decoder refuses what it cannot claim to understand, rather than guessing', () => {
  // Each of these is a literal a lenient decoder would "read" and then re-emit WRONGLY,
  // silently changing the page's data. Refusing makes the whole block read-only instead.
  for (const source of [
    '"a\\0b"',              // an octal escape is not the same as U+0000
    '"a\\1b"',
    '"a\\qb"',              // JS says this is `q`; guessing would drop the backslash
    '"a\\u00zzb"',          // not hex
    '"a\\u{110000}"',       // past the last code point
    '"unterminated',
    '"a\nb"',               // a raw newline ends a literal in JS, so this is not one
    '"a\u2028b"',
    'not a literal'
  ]) {
    assert.equal(decodeStringLiteral(source, 0), null, source);
  }
  assert.equal(decodeStringLiteral('"ok"', 1), null, 'the index must be the opening quote');
});

test('3 anything the escaper writes, the decoder reads back exactly', () => {
  const nasty = [
    'plain',
    'quotes " and \\ backslashes',
    'a </script> inside the data',
    'ampersand & entity',
    'line\nfeed\ttab\r control',
    'separators \u2028 \u2029 here',
    'emoji \u{1F6EB} and é and أهلاً',
    JSON.stringify({ a: '"b"', c: ['</script>', '\\'] })
  ];
  for (const text of nasty) {
    const round = decodeStringLiteral(`"${escapeFlight(text)}"`, 0);
    assert.ok(round, text);
    assert.equal(round.value, text, text);
  }
  // The four the escaper does that JSON.stringify does not, spelled out: without them a
  // value could end the script element it lives in and the rest of the page is markup.
  for (const ch of ['<', '>', '&', '\u2028', '\u2029']) {
    assert.doesNotMatch(escapeFlight(`x${ch}y`), new RegExp(ch < ' ' || ch > '~' ? ch : `\\${ch}`));
  }
});

/* ════════════════════════════════════ the rows ═══════════════════════════════════ */

test('4 only JSON rows are data — tags are skipped, and the stream stays in step', () => {
  const stream =
    '1:HL["/a.css","style"]\n' +
    '2:I[4707,[],""]\n' +
    '3:"a string row"\n' +
    '4:null\n' +
    '0:{"status":"ON_TIME"}\n' +
    '5:[1,2,3]\n';
  const scan = scanRows(stream);
  assert.equal(scan.ok, true);
  assert.deepEqual(scan.rows.map((row) => row.id), ['0', '5']);
  assert.deepEqual(scan.rows[0].value, { status: 'ON_TIME' });
  assert.equal(stream.slice(scan.rows[0].from, scan.rows[0].to), '{"status":"ON_TIME"}');
});

test('5 a T row is measured in bytes, so its own newlines do not split the stream', () => {
  const text = 'Gate A17 · boarding\nsecond line';       // 2-byte middle dot, real newline
  const bytes = new TextEncoder().encode(text).length;
  const stream = `5:T${bytes.toString(16)},${text}\n0:{"status":"ON_TIME"}\n`;

  const scan = scanRows(stream);
  assert.equal(scan.ok, true, 'the byte count landed exactly on the newline');
  assert.deepEqual(scan.rows.map((row) => row.id), ['0'], 'the row AFTER the text chunk is still found');

  // The same stream read by counting UTF-16 units instead of bytes: one byte short, the
  // count lands mid-word, and everything after it is misread. This is why the reading is
  // checked rather than trusted — see flightData.js's header.
  const wrong = `5:T${text.length.toString(16)},${text}\n0:{"status":"ON_TIME"}\n`;
  assert.equal(scanRows(wrong).ok, false);

  // And this is what the landing check is FOR, rather than for tidiness: a count that
  // stops one character early leaves the reader inside the text chunk, where the rest of
  // the chunk's own body parses as a perfectly good row. Without the check, MockLab
  // offers a field that is not data at all — it is a sentence inside somebody's copy —
  // and rewriting it would corrupt the byte length the header still states.
  const desync = '5:T2,abZ0:{"phantom":1}\n';
  const scanned = scanRows(desync);
  assert.equal(scanned.ok, false, 'the count did not land on a newline, so the read stops');
  assert.deepEqual(scanned.rows, [], 'and nothing inside the text chunk is offered as a field');
});

test('6 a stream that stops making sense stops being editable, at each of its four ways', () => {
  const cases = [
    ['0:{"status":"ON_TIME"}\n1:[1,2', 'a final row nobody terminated'],
    ['0:{"status":"ON_TIME"}\nnot-a-row\n', 'a header that is not `<hex>:`'],
    ['0:{"status":"ON_TIME"}\n1:{"a":}\n', 'a payload that opens like data and will not parse'],
    ['5:Tzz,text\n', 'a text chunk whose length is not hex']
  ];
  for (const [stream, why] of cases) {
    assert.equal(scanRows(stream).ok, false, why);
  }
  // The one that is not caught by anything downstream: a final row with no terminator
  // whose payload parses perfectly well. A stream that ends mid-row was TRUNCATED, and
  // the page's own runtime is still waiting for the rest of it — so a rewrite would be
  // MockLab finishing somebody else's sentence.
  const truncated = scanRows('0:{"a":1}\n1:{"b":2}');
  assert.equal(truncated.ok, false, 'an unterminated final row is not a row');
  assert.deepEqual(truncated.rows.map((row) => row.id), ['0'], 'only the row that was finished');

  assert.equal(scanRows('0:{"a":1}\n').ok, true, 'and a stream that does make sense is fine');
});

/* ═══════════════════════════ finding the pushes in a document ════════════════════ */

test('7 the push forms a real document uses are all found', () => {
  const stream = '0:{"status":"ON_TIME"}\n';
  const bodies = [
    `self.__next_f.push([1,${literal(stream)}])`,
    `(self.__next_f=self.__next_f||[]).push([1,${literal(stream)}])`,
    `self.__next_f . push ( [ 1 , ${literal(stream)} ] )`,
    `self.__next_f.push([1,${literal(stream).replace(/^"|"$/g, "'")}])`,
    `window.__next_f.push([1,${literal(stream)}])`
  ];
  for (const body of bodies) {
    const html = `<html><body><script>${body}</script></body></html>`;
    const block = readEmbedded(html)[0];
    assert.ok(block, body);
    assert.equal(block.key, '__next_f', body);
    assert.equal(block.kind, 'flight', body);
    assert.equal(block.editable, true, body);
    assert.deepEqual(block.body, { 0: { status: 'ON_TIME' } }, body);
  }
});

test('8 text that only LOOKS like a push is not one', () => {
  const stream = '0:{"status":"ON_TIME"}\n';
  const call = `self.__next_f.push([1,${literal(stream)}])`;
  for (const [html, why] of [
    [`<html><body><p>${call}</p></body></html>`, 'prose in the markup never runs'],
    [`<html><script type="application/json">{"code":"x"}</script></html>`, 'no push at all'],
    [`<html><script id="d" type="application/json">${JSON.stringify({ code: call })}</script></html>`,
      'a JSON island that quotes one is data, not code']
  ]) {
    const flight = readEmbedded(html).filter((block) => block.kind === 'flight');
    assert.deepEqual(flight, [], why);
  }
});

test('9 a push shape this reader has never seen makes the whole block read-only', () => {
  const stream = '0:{"status":"ON_TIME"}\n';
  const good = `self.__next_f.push([1,${literal(stream)}])`;
  for (const [odd, why] of [
    [`self.__next_f.push([2,${literal('anything')}])`, 'an unknown chunk type'],
    ['self.__next_f.push([1,someVariable])', 'a chunk that is not a literal'],
    [`self.__next_f.push([1,${literal('x')},${literal('y')}])`, 'two arguments in the array'],
    ['self.__next_f.push([1,"a\\0b"])', 'an escape the decoder refuses']
  ]) {
    const html = `<html><script>${good};${odd}</script></html>`;
    const block = readEmbedded(html).find((b) => b.kind === 'flight');
    assert.ok(block, why);
    assert.equal(block.editable, false, why);
  }
  // The bootstrap is the one call that is skipped rather than feared.
  const html = `<html><script>(self.__next_f=self.__next_f||[]).push([0]);${good}</script></html>`;
  assert.equal(readEmbedded(html).find((b) => b.kind === 'flight').editable, true);
});

/* ═════════════════ the split, which is the part a naive reader gets wrong ════════ */

test('10 one row cut across three pushes is one row', () => {
  const cut = TRIP_STREAM.indexOf('ON_T') + 4;
  const html = page(TRIP_STREAM, [10, cut, TRIP_STREAM.length]);
  assert.match(html, /"status\\":\\"ON_T"/, 'the fixture really is cut mid-value');

  const block = readEmbedded(html)[0];
  assert.equal(block.editable, true);
  assert.deepEqual(block.body['0'], TRIP, 'concatenated first, parsed second');

  // A reader that took each push on its own would see `…"status":"ON_T` and find nothing.
  const perPush = html.match(/push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g).length;
  assert.equal(perPush, 3, 'and it really is three separate literals, none of them parseable alone');
  for (const chunk of html.match(/push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)) {
    assert.throws(() => JSON.parse(chunk.slice(chunk.indexOf('0:') + 2)), 'no push is a document on its own');
  }
});

test('11 an edited row lands whole in the first push it started in, and the rest is untouched', () => {
  const cut = TRIP_STREAM.indexOf('ON_T') + 4;
  const html = page(TRIP_STREAM, [10, cut, TRIP_STREAM.length]);
  const blocks = readEmbedded(html);
  const out = applyToDocument(html, blocks, new Map([['__next_f', [{ path: STATUS, value: 'CANCELLED' }]]]));

  assert.equal(out.applied, 1);
  assert.deepEqual(out.missed, []);
  assert.notEqual(out.html, html);

  const again = readEmbedded(out.html);
  assert.equal(again.length, 1, 'the document still holds exactly one block');
  assert.equal(again[0].body['0'][3].trip.status, 'CANCELLED', 'and the site would read the new value');
  assert.equal(again[0].body['0'][3].trip.price.total, 450, 'with everything beside it intact');
  assert.equal(again[0].editable, true, 'and it is still a document this engine can rewrite');

  // Everything that is not one of the two literals it had to touch is byte-identical:
  // the markup, the bootstrap, and the push that carried no part of the edited row.
  assert.match(out.html, /<span id="pill">On time<\/span>/);
  assert.match(out.html, /\(self\.__next_f=self\.__next_f\|\|\[\]\)\.push\(\[0\]\)/);
  assert.equal(
    out.html.split('<script>').length,
    html.split('<script>').length,
    'no script element was added or lost'
  );
});

test('12 recutPushes puts each edit in one place and drops what the edit replaced', () => {
  const stream = 'abcdefghij';
  const spans = [
    { start: 0, end: 3 },
    { start: 3, end: 6 },
    { start: 6, end: 10 }
  ];
  assert.deepEqual(recutPushes(stream, spans, []), ['abc', 'def', 'ghij'], 'no edits, no change');
  assert.deepEqual(
    recutPushes(stream, spans, [{ from: 2, to: 8, text: 'X' }]),
    ['abX', '', 'ij'],
    'an edit spanning three pushes lands in the first and empties what it covered'
  );
  assert.deepEqual(
    recutPushes(stream, spans, [{ from: 3, to: 6, text: 'Y' }]),
    ['abc', 'Y', 'ghij'],
    'an edit that fills one push exactly'
  );
  assert.deepEqual(
    recutPushes(stream, spans, [{ from: 0, to: 1, text: 'P' }, { from: 8, to: 10, text: 'Q' }]),
    ['Pbc', 'def', 'ghQ'],
    'two edits, neither disturbing the other'
  );
  assert.deepEqual(recutPushes(stream, spans, []).join(''), stream, 'and the pieces still make the stream');
});

test('13 a rewrite touches only the pushes whose text changed', () => {
  const stream = '1:HL["/a.css","style"]\n' + TRIP_STREAM;
  const html = page(stream, [23, 23 + 16, stream.length]);
  const blocks = readEmbedded(html);
  const out = applyToDocument(html, blocks, new Map([['__next_f', [{ path: STATUS, value: 'DELAYED' }]]]));
  assert.equal(out.applied, 1);
  assert.match(out.html, /1:HL\[\\"\/a\.css\\",\\"style\\"\]/, 'the hint chunk is byte-identical');
});

test('14 nothing to change is nothing rewritten, byte for byte', () => {
  const html = page(TRIP_STREAM, [12, TRIP_STREAM.length]);
  const blocks = readEmbedded(html);
  for (const [key, overlays] of [
    ['__next_f', [{ path: STATUS, value: 'ON_TIME' }]],      // the value it already has
    ['__next_f', [{ path: '$["0"][3].trip.missing', value: 'x' }]],
    ['__NEXT_DATA__', [{ path: '$.a', value: 1 }]]           // a block this page has not got
  ]) {
    const out = applyToDocument(html, blocks, new Map([[key, overlays]]));
    assert.equal(out.html, html, `${key} ${JSON.stringify(overlays)}`);
  }
});
