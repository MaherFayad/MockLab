/**
 * §8's document reader and rewriter, over the documents that break it.
 *
 * OWNER: probe-engineer.
 *
 * Everything in `documentData.js` is a pure function of a string, which is the reason it
 * was split out of `debuggerEngine.js`: the interesting failures of deep mode are not
 * "did the debugger attach" but "what did MockLab do to somebody's HTML", and those are
 * cheap to ask here and expensive to ask anywhere else.
 *
 * The bar every case below is held to: a document MockLab does not fully understand must
 * come back BYTE-IDENTICAL. A rewrite that half-works is a broken page, and a broken page
 * on a site the person was only looking at is worse than deep mode not working at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  scanJsonValue,
  readEmbedded,
  serializeEmbedded,
  applyToDocument,
  planDocument,
  rewriteHeaders,
  headerValue,
  toBase64,
  fromBase64,
  documentSigId,
  isDocumentSigId,
  isHtmlDocument,
  isStreamedComponent,
  MAX_DOCUMENT_CHARS
} from '../src/background/documentData.js';

/** A page shaped like Next.js output: server-rendered text AND the props beside it. */
const nextPage = (props) =>
  '<!doctype html><html><body><main><span id="pill">On time</span></main>' +
  '<script id="__NEXT_DATA__" type="application/json">' +
  JSON.stringify(props) +
  '</script><script src="/_next/app.js"></script></body></html>';

const SIG = 'abc123def456';

/* ══════════════════════════════ the scanner (§8: "not a naive regex") ═════════════ */

test('1 the scanner ends a JSON value where JSON ends it, not where a regex would', () => {
  // Each of these is a document a `/\{.*\}/` or `/\{[^}]*\}/` gets wrong.
  const cases = [
    ['{"a":"}"}', 9, 'a closing brace inside a string'],
    ['{"a":"\\""}', 10, 'an escaped quote'],
    ['{"a":"\\\\"}', 10, 'an escaped backslash, so the quote after it really closes'],
    ['{"a":{"b":[1,2,{"c":3}]}}', 25, 'nesting of both kinds'],
    ['[{"a":1},{"b":2}]', 17, 'a top-level array'],
    ['{"a":1} trailing junk', 7, 'the value ends before the junk']
  ];
  for (const [text, end, why] of cases) {
    assert.equal(scanJsonValue(text, 0), end, why);
    assert.doesNotThrow(() => JSON.parse(text.slice(0, end)), `the slice for "${why}" is JSON`);
  }
});

test('2 the scanner refuses what it cannot finish, and never runs past the end', () => {
  assert.equal(scanJsonValue('{"a":1', 0), -1, 'unterminated');
  assert.equal(scanJsonValue('{"a":"unclosed', 0), -1, 'unterminated inside a string');
  assert.equal(scanJsonValue('not json', 0), -1, 'does not start on a bracket');
  assert.equal(scanJsonValue('', 0), -1, 'empty');
  assert.equal(scanJsonValue('}{', 0), -1, 'starts on a close');
});

test('3 the scanner is a counter, not a validator — and the parse is what refuses', () => {
  // Stated as a test because it is a deliberate design choice, not an oversight: the
  // scanner balances `{ ]`, and `readEmbedded` still declines the block.
  assert.equal(scanJsonValue('{ ]', 0), 3, 'counting alone closes it');
  assert.throws(() => JSON.parse('{ ]'), 'and JSON.parse is what says no');
  assert.deepEqual(readEmbedded('<script id="x" type="application/json">{ ]</script>'), []);
});

/* ═════════════════════════════════ finding the blocks ════════════════════════════ */

test('4 §8 shape one: a JSON island in a script element, in any attribute order', () => {
  const props = { props: { pageProps: { status: 'ON_TIME' } } };
  for (const tag of [
    '<script id="__NEXT_DATA__" type="application/json">',
    '<script type="application/json" id="__NEXT_DATA__">',
    "<script id='__NEXT_DATA__' type='application/json'>",
    '<SCRIPT ID="__NEXT_DATA__" TYPE="application/json">',
    '<script  id = "__NEXT_DATA__"  type = "application/json"  nonce="r4nd0m">'
  ]) {
    const blocks = readEmbedded(`<html>${tag}${JSON.stringify(props)}</script></html>`);
    assert.equal(blocks.length, 1, tag);
    assert.equal(blocks[0].key, '__NEXT_DATA__', tag);
    assert.deepEqual(blocks[0].body, props, tag);
    assert.equal(blocks[0].kind, 'script', tag);
  }
});

test('5 §8 shape two: a balanced JSON literal assigned to a __SHOUTING__ global', () => {
  const html =
    '<html><script>window.__INITIAL_STATE__ = {"user":{"name":"Nora"}};' +
    'self.__NUXT__={"data":[{"id":1}]};</script></html>';
  const blocks = readEmbedded(html);
  assert.deepEqual(
    blocks.map((b) => [b.key, b.kind]),
    [['__INITIAL_STATE__', 'assignment'], ['__NUXT__', 'assignment']]
  );
  assert.equal(blocks[0].body.user.name, 'Nora');
  assert.deepEqual(blocks[1].body.data, [{ id: 1 }]);
});

test('6 what is deliberately NOT a block, one reason each', () => {
  const cases = [
    ['<script>window.__NUXT__=(function(a,b){return {a:a}})(1,2);</script>', 'Nuxt 2 emits a function call, not JSON'],
    ['<script id="x" type="text/javascript">{"a":1}</script>', 'a code script is code even when it looks like JSON'],
    ['<script type="application/json">{}</script>', 'an empty object is a source with nothing to edit'],
    ['<script id="e" type="application/json">[]</script>', 'and so is an empty array'],
    ['<script id="s" type="application/json">"just a string"</script>', 'a scalar is not state'],
    ['<script id="u" type="application/json">{"a":1}', 'a script with no closing tag is not read to EOF'],
    ['<script>window.__A__ = notJson;</script>', 'an identifier is not a literal'],
    ['<script>window.lowercase = {"a":1};</script>', 'the name shape is part of the pattern'],
    ['<div>{"a":1}</div>', 'JSON in the markup is text, not state']
  ];
  for (const [html, why] of cases) assert.deepEqual(readEmbedded(html), [], why);
});

test('7 an un-idd JSON island still counts, because its TYPE makes it inert data', () => {
  const blocks = readEmbedded('<script type="application/ld+json">{"@type":"Flight"}</script>');
  assert.deepEqual(blocks.map((b) => b.key), ['embedded']);
});

test('8 two blocks with one name are both addressable, in document order', () => {
  const html =
    '<script type="application/json" id="__D__">{"n":1}</script>' +
    '<script type="application/json" id="__D__">{"n":2}</script>';
  const blocks = readEmbedded(html);
  assert.deepEqual(blocks.map((b) => [b.key, b.body.n]), [['__D__', 1], ['__D__#2', 2]]);
});

test('9 a document past the memory ceiling is not scanned at all', () => {
  const huge = '<script id="x" type="application/json">{"a":1}</script>'.padEnd(MAX_DOCUMENT_CHARS + 1, ' ');
  assert.deepEqual(readEmbedded(huge), [], 'a ceiling that is only advisory is not a ceiling');
  assert.deepEqual(readEmbedded(null), []);
  assert.deepEqual(readEmbedded(undefined), []);
});

/* ═══════════════════════════════════ rewriting ═══════════════════════════════════ */

test('10 a value carrying </script> cannot end the element it is written into', () => {
  const evil = { note: '</script><img src=x onerror=alert(1)>' };
  const text = serializeEmbedded(evil);
  assert.equal(text.includes('</script'), false, 'the escape is the whole point');
  assert.equal(text.includes('<'), false);
  assert.deepEqual(JSON.parse(text), evil, 'and it is still the same JSON');

  // End to end: the escaped form is read back as one block, not as broken markup.
  const html = `<script id="__D__" type="application/json">{"note":"x"}</script>`;
  const out = applyToDocument(html, readEmbedded(html), new Map([['__D__', [{ path: '$.note', value: evil.note }]]]));
  const reread = readEmbedded(out.html);
  assert.equal(reread.length, 1);
  assert.equal(reread[0].body.note, evil.note);
});

test('11 the line separators JS treats as newlines are escaped too', () => {
  const raw = 'x\u2028y\u2029z';
  const text = serializeEmbedded({ a: raw });
  assert.equal(/[\u2028\u2029]/.test(text), false, 'JSON.stringify leaves these raw, and an assignment block is parsed as JS');
  assert.equal(JSON.parse(text).a, raw);
});

test('12 only the JSON is replaced — every other byte of the document survives', () => {
  const html = nextPage({ props: { pageProps: { status: 'ON_TIME' } } });
  const out = applyToDocument(
    html,
    readEmbedded(html),
    new Map([['__NEXT_DATA__', [{ path: '$.props.pageProps.status', value: 'CANCELLED' }]]])
  );
  assert.equal(out.applied, 1);
  assert.match(out.html, /<span id="pill">On time<\/span>/, 'the server markup is untouched — see the header of documentData.js');
  assert.match(out.html, /<script src="\/_next\/app\.js"><\/script>/, 'and so is every other script');
  assert.equal(readEmbedded(out.html)[0].body.props.pageProps.status, 'CANCELLED');
});

test('13 nothing to change gives back the document unchanged, byte for byte', () => {
  // Pretty-printed on purpose. `serializeEmbedded` is compact, so ANY re-serialization
  // of this block is visible in the bytes — which is what makes the assertion real. The
  // first version of this test compared the returned string with `===` against a compact
  // fixture, and `===` on two strings is value equality: a mutation that re-serialized
  // an untouched block could not have failed it. It survived, and was found by mutating.
  const pretty = '<script id="__P__" type="application/json">\n  {\n    "v": 1\n  }\n</script>';
  const blocks = readEmbedded(pretty);
  assert.equal(blocks.length, 1);

  const nothing = applyToDocument(pretty, blocks, new Map());
  assert.equal(nothing.html, pretty, '§5.1.2, one layer down: hand back the original');
  assert.equal(nothing.applied, 0);

  // An overlay that MISSES must also leave the bytes alone — nothing changed, so
  // nothing may be retyped.
  const missed = applyToDocument(pretty, blocks, new Map([['__P__', [{ path: '$.nope', value: 2 }]]]));
  assert.equal(missed.html, pretty);
  assert.equal(missed.applied, 0);

  // And when it does hit, exactly that block's text — and only it — is replaced.
  const hit = applyToDocument(pretty, blocks, new Map([['__P__', [{ path: '$.v', value: 2 }]]]));
  assert.equal(hit.applied, 1);
  assert.equal(hit.html, '<script id="__P__" type="application/json">\n  {"v":2}\n</script>');
});

test('14 two blocks change at once and neither splice moves the other', () => {
  // The right-to-left rule. The first block's replacement is much LONGER than what it
  // replaces, so a left-to-right splice corrupts the second one's indexes.
  const html =
    '<script id="__A__" type="application/json">{"v":1}</script>' +
    '<p>between</p>' +
    '<script id="__B__" type="application/json">{"v":2}</script>';
  const out = applyToDocument(
    html,
    readEmbedded(html),
    new Map([
      ['__A__', [{ path: '$.v', value: 'a'.repeat(200) }]],
      ['__B__', [{ path: '$.v', value: 'B!' }]]
    ])
  );
  assert.equal(out.applied, 2);
  const blocks = readEmbedded(out.html);
  assert.deepEqual(blocks.map((b) => [b.key, b.body.v]), [['__A__', 'a'.repeat(200)], ['__B__', 'B!']]);
  assert.match(out.html, /<p>between<\/p>/);
});

test('15 a path this load does not have applies nothing and is reported', () => {
  const html = nextPage({ props: { pageProps: { status: 'ON_TIME' } } });
  const out = applyToDocument(
    html,
    readEmbedded(html),
    new Map([['__NEXT_DATA__', [{ path: '$.props.pageProps.gate', value: 'B4' }]]])
  );
  assert.equal(out.applied, 0, '§5.4: setByPath creates nothing');
  assert.deepEqual(out.missed, ['__NEXT_DATA__.props.pageProps.gate']);
  assert.equal(out.html === html, true, 'and the document is untouched');
});

test('16 the parsed body a block was READ as is never mutated by a rewrite', () => {
  // §5.1.2: the capture is the REAL response. `deepFetch.js` reports these same objects
  // as the source, so a rewrite that wrote through them would make MockLab's record of
  // what the server sent say what MockLab did to it.
  const html = nextPage({ props: { pageProps: { status: 'ON_TIME' } } });
  const blocks = readEmbedded(html);
  applyToDocument(html, blocks, new Map([['__NEXT_DATA__', [{ path: '$.props.pageProps.status', value: 'DELAYED' }]]]));
  assert.equal(blocks[0].body.props.pageProps.status, 'ON_TIME');
});

/* ═════════════════════════════════ the whole plan ════════════════════════════════ */

test('17 every block is reported as a source, changed or not', () => {
  const html = nextPage({ props: { pageProps: { status: 'ON_TIME' } } });
  const plan = planDocument(html, SIG, new Map());
  assert.deepEqual(plan.sources.map((s) => s.sigId), [documentSigId(SIG, '__NEXT_DATA__')]);
  assert.equal(plan.sources[0].mocked, false);
  assert.equal(plan.applied, 0);
  assert.equal(plan.html === html, true);
  // §10.2's tree is how a person FINDS a field to change, so an untouched page must
  // still appear in Sources or deep mode is a feature nobody can start using.
  assert.equal(plan.sources[0].body.props.pageProps.status, 'ON_TIME');
});

test('18 an overlay reaches a block only through that block\'s own sigId', () => {
  const html = nextPage({ props: { pageProps: { status: 'ON_TIME' } } });
  const path = '$.props.pageProps.status';

  const right = planDocument(html, SIG, new Map([[documentSigId(SIG, '__NEXT_DATA__'), [{ path, value: 'CANCELLED' }]]]));
  assert.equal(right.applied, 1);
  assert.equal(right.sources[0].mocked, true);

  for (const wrong of [documentSigId('999999999999', '__NEXT_DATA__'), documentSigId(SIG, '__NUXT__'), 'a1b2c3d4e5f6']) {
    const plan = planDocument(html, SIG, new Map([[wrong, [{ path, value: 'CANCELLED' }]]]));
    assert.equal(plan.applied, 0, `${wrong} must not reach this block`);
    assert.equal(plan.sources[0].mocked, false);
  }
});

test('19 a document sigId is namespaced so nothing can mistake it for a request', () => {
  assert.equal(documentSigId(SIG, '__NEXT_DATA__'), '__document__:abc123def456:__NEXT_DATA__');
  assert.equal(isDocumentSigId(documentSigId(SIG, '__D__')), true);
  assert.equal(isDocumentSigId('abc123def456'), false, 'a real sigId is 12 hex chars and nothing else');
  assert.equal(isDocumentSigId('__document__'), false, 'the bare prefix names no block');
  assert.equal(isDocumentSigId(null), false);
});

test('20 a page with no embedded data plans nothing at all', () => {
  const plan = planDocument('<html><body><h1>Hello</h1></body></html>', SIG, new Map());
  assert.deepEqual(plan.sources, []);
  assert.equal(plan.applied, 0);
});

/* ═════════════════════════════ headers and the wire ══════════════════════════════ */

test('21 the headers a rewrite invalidates are dropped, and only those', () => {
  const headers = [
    { name: 'Content-Type', value: 'text/html; charset=utf-8' },
    { name: 'content-length', value: '4096' },
    { name: 'Content-Encoding', value: 'gzip' },
    { name: 'Transfer-Encoding', value: 'chunked' },
    { name: 'Content-MD5', value: 'q1w2e3' },
    { name: 'Content-Security-Policy', value: "default-src 'self'" },
    { name: 'Set-Cookie', value: 'sid=1' }
  ];
  assert.deepEqual(
    rewriteHeaders(headers).map((h) => h.name),
    ['Content-Type', 'Content-Security-Policy', 'Set-Cookie'],
    'content-encoding is the one §8 forgets: CDP hands back a DECODED body, so leaving ' +
      'gzip on the response makes the browser inflate plain HTML and render nothing'
  );
  assert.deepEqual(rewriteHeaders(undefined), []);
});

test('22 a header is read case-insensitively, because HTTP/2 lowercases and 1.1 does not', () => {
  const headers = [{ name: 'CoNtEnT-TyPe', value: 'text/html' }];
  assert.equal(headerValue(headers, 'content-type'), 'text/html');
  assert.equal(headerValue(headers, 'Content-Type'), 'text/html');
  assert.equal(headerValue(headers, 'content-length'), '');
  assert.equal(headerValue(undefined, 'content-type'), '');
});

test('23 only an HTML document is scanned, and §8\'s RSC stream is detected not attempted', () => {
  assert.equal(isHtmlDocument('text/html; charset=utf-8'), true);
  assert.equal(isHtmlDocument('application/xhtml+xml'), true);
  assert.equal(isHtmlDocument('application/json'), false);
  assert.equal(isHtmlDocument(''), false, 'a response with no content type is not assumed to be a page');
  assert.equal(isStreamedComponent('text/x-component'), true, 'PLAN.md §8: out of scope for v1');
  assert.equal(isStreamedComponent('text/html'), false);
});

test('24 base64 survives what btoa alone would not', () => {
  const arabic = '<html><head><title>رحلتك</title></head><body>🛫</body></html>';
  assert.equal(fromBase64(toBase64(arabic)), arabic, 'btoa() throws on the first non-Latin-1 character');
  assert.throws(() => btoa(arabic), 'which is stated here rather than assumed');

  const big = '<p>' + 'x'.repeat(400000) + '</p>';
  assert.equal(fromBase64(toBase64(big)).length, big.length, 'fromCharCode(...bytes) blows the stack here');

  assert.equal(fromBase64(toBase64('')), '');
});

test('25 a document read as base64 and written back is byte-identical', () => {
  const html = nextPage({ props: { pageProps: { status: 'ON_TIME', note: 'café — 90 % full' } } });
  assert.equal(fromBase64(toBase64(html)), html);
});

/* ══════════════════════════ §16 M7's own acceptance fixture ══════════════════════ */

/**
 * `companion/src/demo/ssr.html` is what §16 M7 asks for, and it is only a harness if the
 * engine really reads it. A fixture nobody parses is a page somebody edits into a shape
 * deep mode cannot handle, with every test still green — this build has shipped that
 * exact defect twice, in a CI loop and in a README table.
 */
const DEMO_SSR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../companion/src/demo/ssr.html'
);

test('26 the demo\'s SSR page is a document this engine can read and rewrite', () => {
  const html = fs.readFileSync(DEMO_SSR, 'utf8');
  const blocks = readEmbedded(html);
  assert.deepEqual(blocks.map((b) => b.key), ['__NEXT_DATA__'], 'the hydration script is code, not data');
  assert.equal(blocks[0].body.props.pageProps.trip.status, 'ON_TIME');

  const out = applyToDocument(
    html,
    blocks,
    new Map([['__NEXT_DATA__', [{ path: '$.props.pageProps.trip.status', value: 'CANCELLED' }]]])
  );
  assert.equal(out.applied, 1);
  assert.deepEqual(out.missed, []);
  assert.equal(readEmbedded(out.html)[0].body.props.pageProps.trip.status, 'CANCELLED');

  // The server-rendered halves the page carries on purpose (see its own header comment):
  // the pill's markup still says what the server said, and so does the printed note.
  assert.match(out.html, /<div id="status-pill">On time<\/div>/);
  assert.match(out.html, /Printed at booking<\/b> · Gate A17 · On time/);
});

test('27 the demo\'s SSR page fetches nothing, which is the whole reason it exists', () => {
  const html = fs.readFileSync(DEMO_SSR, 'utf8');
  assert.doesNotMatch(html, /\bfetch\s*\(/, '§5.1\'s patch has nothing to intercept here');
  assert.doesNotMatch(html, /XMLHttpRequest/);
  assert.doesNotMatch(html, /<script[^>]+\bsrc=/, 'and no external file either — every request delays §7.3 settle');
  assert.doesNotMatch(html, /<link[^>]+\bhref=/);
});
