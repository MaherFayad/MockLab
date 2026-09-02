/**
 * What an App Router DOCUMENT yields, and what MockLab is allowed to say about it
 * (PLAN.md §8, §1.1).
 *
 * OWNER: probe-engineer. The other half of `flightData.test.js` — that file is the text
 * machinery, this one is the document: which blocks a page yields, what happens to a
 * block that was found and cannot be safely put back, what the panel is told about it,
 * and whether §16 M7's acceptance fixture still parses.
 *
 * The claim this file exists to keep honest is §1.1's. A stream MockLab cannot rewrite
 * must be VISIBLE and UNEDITABLE — not silently missing from the Sources list, and not
 * offered with fields whose Change would quietly do nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readFlight, flightSplices } from '../src/background/flightData.js';
import { readEmbedded, applyToDocument, planDocument, documentSigId } from '../src/background/documentData.js';
import { flightPage as page, flightLiteral as literal } from '../testlib/flightPage.js';

const SIG = 'abc123def456';

/** The trip row most tests below edit: row 0, a model tree with a status inside it. */
const TRIP = ['$', '$L3', null, { trip: { status: 'ON_TIME', price: { total: 450 } } }];
const TRIP_STREAM = '2:I[4707,[],""]\n0:' + JSON.stringify(TRIP) + '\n';
const STATUS = '$["0"][3].trip.status';

/* ══════════════════ §1.1 — found, unrewritable, and visible as such ══════════════ */

test('15 a block that cannot be put back is reported, and refuses every change', () => {
  // The row this test edits is one the block REALLY HOLDS — the stream reads fine and
  // then stops making sense afterwards. A broken stream whose readable part is empty
  // would refuse the change for the wrong reason (`setByPath` creates nothing), and the
  // guard being tested here would be doing no work at all.
  const broken = page('0:{"trip":{"status":"ON_TIME"}}\n5:Tzz,text\n');
  const blocks = readEmbedded(broken);
  assert.equal(blocks.length, 1, '§1.1: found, so not silently absent');
  assert.equal(blocks[0].editable, false);
  assert.equal(blocks[0].body['0'].trip.status, 'ON_TIME', 'and the field really is in it');
  assert.ok(blocks[0].preview.startsWith('0:{'), 'and it carries something to show for itself');

  const path = '$["0"].trip.status';
  const out = applyToDocument(broken, blocks, new Map([['__next_f', [{ path, value: 'CANCELLED' }]]]));
  assert.equal(out.html, broken, '§1.1: and not silently broken either');
  assert.equal(out.applied, 0);
  assert.deepEqual(out.missed, ['__next_f["0"].trip.status'], 'the caller is told, and can say so');
});

test('15b the read-back is what stands between a wrong splice and a page that will not load', () => {
  // A block whose bookkeeping does not describe THIS document — the case no arithmetic
  // about the splices could catch, because the splices are internally consistent and
  // land in the wrong place. Produced here by moving the document out from under a block
  // that was read from it; produced in the field by any defect in the offsets.
  const html = page(TRIP_STREAM, [12, TRIP_STREAM.length]);
  const block = readEmbedded(html)[0];
  const moved = { ...block, flight: { ...block.flight, pushes: block.flight.pushes.map((push) => ({
    ...push, from: push.from - 3, to: push.to - 3
  })) } };

  const said = [];
  const real = console.error;
  console.error = (...args) => said.push(args.join(' '));
  let out;
  try {
    out = applyToDocument(html, [moved], new Map([['__next_f', [{ path: STATUS, value: 'CANCELLED' }]]]));
  } finally {
    console.error = real;
  }

  assert.equal(out.html, html, 'the site is served its own document, byte for byte');
  assert.equal(out.applied, 0, 'and MockLab does not claim the change happened');
  assert.deepEqual(out.missed, ['__next_f["0"][3].trip.status']);
  assert.equal(said.length, 1, 'and it says so where a person can find it');
});

test('16 a stream with nothing editable in it is not offered as a source at all', () => {
  // Hints and module references only: found, understood, and holding no field a person
  // could change. `documentData.js` drops an empty JSON island for the same reason.
  const html = page('1:HL["/a.css","style"]\n2:I[4707,[],""]\n');
  assert.deepEqual(readEmbedded(html), []);
  assert.deepEqual(readEmbedded('<html><body><p>no scripts here</p></body></html>'), []);
});

test('17 §8\'s namespace and §10.2\'s source, for a document nobody has changed yet', () => {
  const html = page(TRIP_STREAM, [12, TRIP_STREAM.length]);
  const plan = planDocument(html, SIG, new Map());
  assert.deepEqual(plan.sources.map((source) => source.sigId), [documentSigId(SIG, '__next_f')]);
  assert.equal(plan.sources[0].editable, true);
  assert.equal(plan.sources[0].mocked, false);
  assert.equal(plan.html, html);

  const overlay = new Map([[documentSigId(SIG, '__next_f'), [{ path: STATUS, value: 'CANCELLED' }]]]);
  const changed = planDocument(html, SIG, overlay);
  assert.equal(changed.applied, 1);
  assert.equal(changed.sources[0].mocked, true);
  assert.equal(changed.sources[0].body['0'][3].trip.status, 'ON_TIME', '§5.1.2: the capture is the REAL one');

  // A document carrying BOTH: one block that was really rewritten, and one that could
  // not be. `applied` is a figure about the whole document, so a source that read it
  // alone would say the broken block was mocked — MockLab claiming it changed something
  // it did not touch, on the one screen the person checks that from (§10.2).
  const mixed =
    '<html><script id="__NEXT_DATA__" type="application/json">{"a":1}</script>' +
    page('0:{"trip":{"status":"ON_TIME"}}\n5:Tzz,text\n').slice('<!doctype html><html><body>'.length);
  const both = planDocument(mixed, SIG, new Map([
    [documentSigId(SIG, '__NEXT_DATA__'), [{ path: '$.a', value: 2 }]],
    [documentSigId(SIG, '__next_f'), [{ path: '$["0"].trip.status', value: 'CANCELLED' }]]
  ]));
  assert.equal(both.applied, 1, 'the island changed');
  const island = both.sources.find((source) => source.key === '__NEXT_DATA__');
  const stream = both.sources.find((source) => source.key === '__next_f');
  assert.equal(island.mocked, true);
  assert.equal(stream.editable, false);
  assert.equal(stream.mocked, false, 'a block nobody can rewrite is never reported as mocked');

  const unreadable = planDocument(page('5:Tzz,x\n0:{"a":1}\n'), SIG, new Map());
  assert.equal(unreadable.sources[0].editable, false);
  assert.equal(unreadable.sources[0].mocked, false);
});

test('18 a value carrying </script> cannot end the element it is written into', () => {
  const html = page(TRIP_STREAM, [12, TRIP_STREAM.length]);
  const blocks = readEmbedded(html);
  const payload = '</script><script>alert(1)</script>';
  const out = applyToDocument(html, blocks, new Map([['__next_f', [{ path: STATUS, value: payload }]]]));

  assert.doesNotMatch(out.html.slice(out.html.indexOf('__next_f')), /<\/script><script>alert/);
  assert.equal(
    out.html.split('<script>').length,
    html.split('<script>').length,
    'the document still has exactly the script elements it had'
  );
  assert.equal(readEmbedded(out.html)[0].body['0'][3].trip.status, payload, 'and the site still reads the value');
});

/* ═══════════════════════ §16 M7's acceptance fixture, parsed ═════════════════════ */

/**
 * A fixture nobody parses is a page somebody edits into a shape deep mode cannot handle,
 * with every test still green. `documentData.test.js` says the same of `ssr.html`.
 */
const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../companion/src/demo/approuter.html');
const DEMO_STATUS = '$["0"][3].children[3].children[1][3].trip.status';

test('19 the App Router demo is a document this engine reads and rewrites', () => {
  const html = fs.readFileSync(DEMO, 'utf8');
  const blocks = readEmbedded(html);
  assert.deepEqual(blocks.map((block) => block.key), ['__next_f'], 'one block, and it is the stream');
  assert.equal(blocks[0].editable, true);
  assert.deepEqual(Object.keys(blocks[0].body).sort(), ['0', '6'], 'the two JSON rows; the tags are not data');

  const trip = blocks[0].body['0'][3].children[3].children[1][3].trip;
  assert.equal(trip.status, 'ON_TIME');
  assert.equal(trip.price.total, 450);

  const out = applyToDocument(html, blocks, new Map([['__next_f', [{ path: DEMO_STATUS, value: 'CANCELLED' }]]]));
  assert.equal(out.applied, 1);
  assert.deepEqual(out.missed, []);
  const again = readEmbedded(out.html);
  assert.equal(again[0].body['0'][3].children[3].children[1][3].trip.status, 'CANCELLED');
  assert.equal(again[0].editable, true);

  // The server-rendered halves the page carries on purpose: the pill's markup still says
  // what the server said, and so does the printed note. See the page's own header.
  assert.match(out.html, /<div id="status-pill">On time<\/div>/);
  assert.match(out.html, /Printed at booking<\/b> · Gate A17 · On time/);
});

test('20 the demo really is the hard case, in each of the three ways it claims to be', () => {
  const html = fs.readFileSync(DEMO, 'utf8');
  assert.match(html, /"status\\":\\"ON_T"\]\)/, 'a push boundary falls INSIDE the pill\'s value');
  assert.match(html, /5:T[0-9a-f]+,/, 'a text chunk with a byte-length header, whose body has a newline in it');
  assert.match(html, /2:I\[|1:HL\[/, 'tagged rows that are not data');

  const block = readEmbedded(html)[0];
  const spans = block.flight.spans;
  const row = block.flight.rows.find((r) => r.id === '0');
  const across = spans.filter((span) => span.start < row.to && span.end > row.from).length;
  assert.equal(across, 3, 'and row 0 is cut across three pushes');
});

test('21 the demo fetches nothing, which is the whole reason a document rewrite is the only way in', () => {
  const html = fs.readFileSync(DEMO, 'utf8');
  assert.doesNotMatch(html, /\bfetch\s*\(/, '§5.1\'s patch has nothing to intercept here');
  assert.doesNotMatch(html, /XMLHttpRequest/);
  assert.doesNotMatch(html, /<script[^>]+\bsrc=/, 'and no external file either');
  assert.doesNotMatch(html, /<link[^>]+\bhref=/);
});

/* ═══════════════════════════ the boundaries, said out loud ═══════════════════════ */

test('22 KNOWN LIMIT: a script tag written inside an HTML comment is read as a script', () => {
  // `scriptElements` in documentData.js does not model HTML comments — it never has, for
  // §8's two shapes either. The consequence for THIS reader is recorded rather than
  // papered over, because it decides how the demo fixture's own header may be written:
  // a comment that quotes a push call would be read as one.
  const stream = '0:{"status":"ON_TIME"}\n';
  const commented = `<html><body><!-- <script>self.__next_f.push([1,${literal(stream)}])</script> --></body></html>`;
  const blocks = readEmbedded(commented);
  assert.equal(blocks.length, 1, 'today it IS read — if this ever fails, comments are being modelled');
  assert.equal(blocks[0].kind, 'flight');
  // The direction that matters: it can only make MockLab see data that does not run, and
  // a Change on it rewrites a comment. It cannot make MockLab miss data that does run.
  const demo = fs.readFileSync(DEMO, 'utf8');
  assert.doesNotMatch(demo.slice(0, demo.indexOf('<style>')), /<script/i, 'so the fixture keeps none in its header');
});

test('23 a row is rewritten when its VALUE changed, not when its bytes could be spelled differently', () => {
  // `1e3` is 1000 to every JSON parser and a different string to every byte comparison.
  // A rewrite keyed on the bytes would rewrite this row on a Change that never touched
  // it — and would rewrite it in EVERY document that spells a number that way.
  const stream = '0:{"n":1e3,"status":"ON_TIME"}\n1:{"other":true}\n';
  const html = page(stream, [20, stream.length]);
  const block = readEmbedded(html)[0];
  assert.deepEqual(flightSplices(block, structuredClone(block.body)), [], 'nothing changed, nothing spliced');

  const edited = structuredClone(block.body);
  edited['0'].status = 'DELAYED';
  const splices = flightSplices(block, edited);
  assert.equal(splices.length, 2, 'the two pushes row 0 was cut across, and no others');
  assert.match(splices[0].text, /\\"n\\":1000/, 'the row it did rewrite is re-serialized whole');
  assert.equal(readEmbedded(applyToDocument(html, [block], new Map([['__next_f', [
    { path: '$["0"].status', value: 'DELAYED' }
  ]]])).html)[0].body['1'].other, true, 'and the row beside it survives');
});

test('24 readFlight is a pure reader: it never mutates the block it hands back', () => {
  const html = page(TRIP_STREAM, [12, TRIP_STREAM.length]);
  const block = readFlight(html, [{ attrs: {}, from: 0, to: html.length }]);
  const before = JSON.stringify(block.body);
  applyToDocument(html, [block], new Map([['__next_f', [{ path: STATUS, value: 'CANCELLED' }]]]));
  assert.equal(JSON.stringify(block.body), before, '§5.1.2: what MockLab captured stays what the server sent');
});
