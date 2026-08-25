/**
 * Signature normalization tests (PLAN.md §5.2).
 *
 * OWNER: interceptor-engineer. §16 M2's DoD requires >= 15 normalization cases; §5.2
 * names the mandatory ones: trip-style URLs with numeric ids, UUID paths, volatile
 * query params, GraphQL operations, batched GraphQL.
 *
 * The `sa.trip.com` block at the bottom uses real vectors from the product owner's
 * actual target page and is the reason for the one documented extension to §5.2
 * (delimited volatile tokens inside a param NAME — see README "Deviations").
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSignature,
  buildSignatureFromParts,
  compileMatchList,
  friendlyName,
  isVolatileParamName,
  isVolatileValue,
  looksBase64,
  normalize,
  normalizeRaw,
  signatureFingerprint,
  tokenizeParamName
} from '../src/background/signatures.js';

const patternOf = (method, url, body) => buildSignature(method, url, body).urlPattern;

/* ------------------------------------------------------------------ URL basics */

test('01 lowercases the host, keeps path case, drops the hash', () => {
  assert.equal(
    patternOf('GET', 'https://API.Example.COM/Api/Flight/Status#frag'),
    'https://api.example.com/Api/Flight/Status'
  );
});

test('02 uppercases the method', () => {
  assert.equal(buildSignature('post', 'https://a.test/x').method, 'POST');
});

test('03 long numeric path segments become *', () => {
  assert.equal(patternOf('GET', 'https://a.test/orders/44212114/items'), 'https://a.test/orders/*/items');
});

test('04 short numeric path segments are kept', () => {
  assert.equal(patternOf('GET', 'https://a.test/v2/seat/12'), 'https://a.test/v2/seat/12');
});

test('05 UUID path segments become *', () => {
  assert.equal(
    patternOf('GET', 'https://a.test/u/3F2504E0-4F89-11D3-9A0C-0305E82C3301/profile'),
    'https://a.test/u/*/profile'
  );
});

test('06 hex-id path segments (>=16 chars) become *', () => {
  assert.equal(patternOf('GET', 'https://a.test/s/a1b2c3d4e5f60718/x'), 'https://a.test/s/*/x');
});

test('07 base64-looking path segments become * but ordinary long words survive', () => {
  assert.equal(patternOf('GET', 'https://a.test/k/H4sIAAAAAAAA9Qk1x/z'), 'https://a.test/k/*/z');
  assert.equal(patternOf('GET', 'https://a.test/flightreservations'), 'https://a.test/flightreservations');
  assert.equal(looksBase64('flightreservations'), false);
  assert.equal(looksBase64('H4sIAAAAAAAA9Qk1x'), true);
});

test('08 an unparseable URL falls back to the raw string minus the hash', () => {
  assert.equal(patternOf('GET', '/relative/path?a=1#f'), '/relative/path?a=1');
});

/* ------------------------------------------------------------- query parameters */

test('09 drops every volatile param NAME from PLAN.md §5.2', () => {
  const url =
    'https://a.test/api/x?keep=1&t=1&ts=2&_=3&cb=4&nonce=5&timestamp=6&time=7&rnd=8&random=9' +
    '&sid=a&sessionid=b&session_id=c&token=d&auth=e&signature=f&sign=g&hash=h&traceid=i' +
    '&trace_id=j&requestid=k&request_id=l&x-request-id=m';
  assert.equal(patternOf('GET', url), 'https://a.test/api/x?keep=1');
});

test('10 volatile param VALUES become * while the name is kept', () => {
  assert.equal(
    patternOf('GET', 'https://a.test/api/x?hotelId=44212114&city=Makkah'),
    'https://a.test/api/x?city=Makkah&hotelId=*'
  );
});

test('11 remaining params are sorted by name, so URL order cannot change the sigId', async () => {
  const a = await normalize('GET', 'https://a.test/api/x?b=2&a=1&c=3');
  const b = await normalize('GET', 'https://a.test/api/x?c=3&a=1&b=2');
  assert.equal(a.urlPattern, 'https://a.test/api/x?a=1&b=2&c=3');
  assert.equal(a.sigId, b.sigId);
});

test('12 empty param values are kept as-is', () => {
  assert.equal(patternOf('GET', 'https://a.test/api/x?ages='), 'https://a.test/api/x?ages=');
});

/* ------------------------------------------------------------------- GraphQL */

test('13 a /graphql path drops the query and takes operationName from the body', () => {
  const sig = buildSignature('POST', 'https://a.test/graphql?opt=1', {
    operationName: 'HotelDetail',
    query: 'query HotelDetail { id }'
  });
  assert.equal(sig.urlPattern, 'https://a.test/graphql');
  assert.equal(sig.gqlOperation, 'HotelDetail');
  assert.equal(sig.bodyShape, undefined);
});

test('14 operationName in the body makes any path GraphQL', () => {
  const sig = buildSignature('POST', 'https://a.test/api/gateway', '{"operationName":"SearchHotels"}');
  assert.equal(sig.gqlOperation, 'SearchHotels');
  assert.equal(sig.urlPattern, 'https://a.test/api/gateway');
});

test('15 batched GraphQL joins the operation names in order', () => {
  const sig = buildSignature('POST', 'https://a.test/graphql', [
    { operationName: 'A' },
    { operationName: 'B' },
    { query: '{ anonymous }' }
  ]);
  assert.equal(sig.gqlOperation, 'A,B');
});

test('16 two GraphQL calls to one endpoint with different operations get different sigIds', async () => {
  const a = await normalize('POST', 'https://a.test/graphql', { operationName: 'A' });
  const b = await normalize('POST', 'https://a.test/graphql', { operationName: 'B' });
  assert.notEqual(a.sigId, b.sigId);
});

/* ---------------------------------------------------------------- POST bodies */

test('17 bodyShape is the sorted top-level keys of a JSON POST body', () => {
  const sig = buildSignature('POST', 'https://a.test/api/search', '{"z":1,"a":2,"m":{"deep":true}}');
  assert.equal(sig.bodyShape, 'a,m,z');
});

test('18 GET requests never get a bodyShape', () => {
  assert.equal(buildSignature('GET', 'https://a.test/api/search', '{"a":1}').bodyShape, undefined);
});

test('19 two POST searches with the same keys share a sigId, different keys do not', async () => {
  const a = await normalize('POST', 'https://a.test/api/search', '{"city":"RUH","date":"1"}');
  const b = await normalize('POST', 'https://a.test/api/search', '{"date":"2","city":"JED"}');
  const c = await normalize('POST', 'https://a.test/api/search', '{"city":"RUH"}');
  assert.equal(a.sigId, b.sigId);
  assert.notEqual(a.sigId, c.sigId);
});

/* -------------------------------------------------------------------- sigId */

test('20 sigId is 12 lowercase hex chars and hashes exactly the §5.2 fingerprint', async () => {
  const sig = await normalize('GET', 'https://a.test/api/x');
  assert.match(sig.sigId, /^[0-9a-f]{12}$/);
  assert.equal(signatureFingerprint(sig), 'GET https://a.test/api/x  ');
});

test('21 normalizeRaw (MAIN-world parts) agrees with normalize (full body)', async () => {
  const full = await normalize('POST', 'https://a.test/api/search', '{"b":1,"a":2}');
  const raw = await normalizeRaw({
    method: 'POST',
    url: 'https://a.test/api/search',
    requestBodyKeys: ['a', 'b']
  });
  assert.equal(raw.sigId, full.sigId);

  const gqlFull = await normalize('POST', 'https://a.test/graphql', { operationName: 'X' });
  const gqlRaw = await normalizeRaw({ method: 'POST', url: 'https://a.test/graphql', gqlOperation: 'X' });
  assert.equal(gqlRaw.sigId, gqlFull.sigId);
  assert.equal(buildSignatureFromParts({ method: 'GET', url: 'https://a.test/x' }).urlPattern, 'https://a.test/x');
});

/* ------------------------------------------- sa.trip.com — the real target page */

const TRIP_BASE =
  'https://sa.trip.com/hotels/detail/?cityEnName=Makkah&cityId=3744&hotelId=44212114' +
  '&checkIn=2026-08-25&checkOut=2026-08-26&adult=2&children=0&ages=&crn=1&curr=SAR&barcurr=SAR' +
  '&detailFilters=17%7C1~17~1*80%7C0%7C1~80~0&hotelType=normal&display=exavg&isCT=true' +
  '&isFlexible=F&locale=en-SA';

const tripUrl = (extra) => TRIP_BASE + extra;

test('22 trip.com: the trace-log param is dropped, the hotel id is starred, the rest survive', () => {
  const pattern = patternOf(
    'GET',
    tripUrl('&hoteluniquekey=H4sIAAAAAAAA_-P6xMzFJMEk9ZqRQeIVIwNjIzMDIwMjAyMDIyMg' +
      '&masterhotelid_tracelogid=100051355-0a8e3544-496571-67667&subStamp=1440')
  );
  assert.ok(!pattern.includes('masterhotelid_tracelogid'), 'trace-log param must be dropped');
  assert.ok(pattern.includes('hotelId=*'), 'numeric hotel id must be starred');
  assert.ok(pattern.includes('cityId=*'), 'numeric city id must be starred');
  assert.ok(pattern.includes('hoteluniquekey=*'), 'base64 blob must be starred');
  assert.ok(pattern.includes('subStamp=*'), 'numeric stamp must be starred');
  assert.ok(pattern.includes('cityEnName=Makkah'), 'stable params must survive');
  assert.ok(pattern.includes('curr=SAR') && pattern.includes('locale=en-SA'));
  assert.ok(pattern.includes('checkIn=2026-08-25'), 'dates must survive');
  // Kept values are percent-encoded so urlPattern is unambiguous (see case 32); the
  // literal `*` inside the filter set becomes %2A so it cannot be read as a wildcard.
  assert.ok(pattern.includes('detailFilters=17%7C1~17~1%2A80%7C0%7C1~80~0'), 'filter sets must survive');
});

test('23 trip.com: two loads differing only in volatile params produce the SAME sigId', async () => {
  const a = await normalize(
    'GET',
    tripUrl('&hoteluniquekey=H4sIAAAAAAAA_-P6xMzFJMEk9ZqRQeIVIwNjIzMDIwMjAyMDIyMg' +
      '&masterhotelid_tracelogid=100051355-0a8e3544-496571-67667&subStamp=1440')
  );
  const b = await normalize(
    'GET',
    tripUrl('&hoteluniquekey=H4sIAAAAAAAA_-P7zM9GJcEo9aaRQeQXKxNTAxMzIyMTQyMzAyM2' +
      '&masterhotelid_tracelogid=100051355-9f7c1120-778213-11902&subStamp=1441')
  );
  assert.equal(a.sigId, b.sigId);
});

test('24 trip.com: a different hotel gives the same sigId (the Change follows the user)', async () => {
  const a = await normalize('GET', tripUrl(''));
  const b = await normalize('GET', tripUrl('').replace('hotelId=44212114', 'hotelId=99881234'));
  assert.equal(a.sigId, b.sigId);
});

test('25 trip.com: a different currency gives a DIFFERENT sigId', async () => {
  const a = await normalize('GET', tripUrl(''));
  const b = await normalize('GET', tripUrl('').replace('curr=SAR', 'curr=USD'));
  assert.notEqual(a.sigId, b.sigId);
});

test('26 the delimited-token rule drops trace ids without touching meaningful names', () => {
  assert.deepEqual(tokenizeParamName('masterhotelid_tracelogid'), ['masterhotelid', 'tracelogid']);
  assert.deepEqual(tokenizeParamName('hotelId'), ['hotel', 'id']);
  assert.equal(isVolatileParamName('masterhotelid_tracelogid'), true);
  assert.equal(isVolatileParamName('x-trace-id'), true);
  assert.equal(isVolatileParamName('pageSessionId'), true);
  assert.equal(isVolatileParamName('hotelId'), false);
  assert.equal(isVolatileParamName('cityEnName'), false);
  assert.equal(isVolatileParamName('checkInTime'), false, 'generic "time" must not merge real params');
  assert.equal(isVolatileParamName('signInMethod'), false, 'generic "sign" must not merge real params');
  assert.equal(isVolatileParamName('hoteluniquekey'), false);
  // The token rule applies to one-word names too: a bare `tracelogid` and an
  // `x_tracelogid` must not be treated differently.
  assert.equal(isVolatileParamName('tracelogid'), true);
  assert.equal(isVolatileParamName('x_tracelogid'), true);
  assert.equal(isVolatileParamName('trace'), true);
});

test('27 isVolatileValue covers all four §5.2 value shapes and nothing else', () => {
  assert.equal(isVolatileValue('44212114'), true);
  assert.equal(isVolatileValue('1440'), true);
  assert.equal(isVolatileValue('123'), false);
  assert.equal(isVolatileValue('3F2504E0-4F89-11D3-9A0C-0305E82C3301'), true);
  assert.equal(isVolatileValue('a1b2c3d4e5f60718'), true);
  assert.equal(isVolatileValue('SAR'), false);
  assert.equal(isVolatileValue('2026-08-25'), false);
  assert.equal(isVolatileValue('100051355-0a8e3544-496571-67667'), false, 'value rules alone miss it');
});

/* ------------------------------------------------------------- friendly names */

test('28 friendly names are the sentence-case, jargon-free names the panel shows', () => {
  assert.equal(friendlyName(buildSignature('GET', 'https://a.test/api/flight/status')), 'Flight status');
  assert.equal(friendlyName(buildSignature('GET', 'http://127.0.0.1:8517/demo/api/trip.json')), 'Trip');
  assert.equal(friendlyName(buildSignature('GET', 'http://127.0.0.1:8517/demo/api/user.json')), 'User');
  assert.equal(friendlyName(buildSignature('GET', 'https://sa.trip.com/hotels/detail/')), 'Hotels detail');
  assert.equal(friendlyName(buildSignature('GET', 'https://a.test/v2/booking-summary')), 'Booking summary');
  assert.equal(friendlyName(buildSignature('POST', 'https://a.test/graphql', { operationName: 'getHotelDetail' })), 'Get hotel detail');
  assert.equal(friendlyName(buildSignature('GET', 'https://a.test/')), 'a.test');
  assert.equal(friendlyName(buildSignature('GET', 'https://a.test/orders/44212114/items')), 'Orders items');
});

test('28b a path with nothing meaningful in it falls back to the host, never to an id', () => {
  // /api/58 used to be named "58". "Api" would be worse still: §11 forbids that word
  // in default copy. The host is the only honest name left.
  assert.equal(friendlyName(buildSignature('GET', 'https://a.test/api/58')), 'a.test');
  assert.equal(friendlyName(buildSignature('GET', 'https://a.test/v1/2024/1042')), 'a.test');
  assert.equal(friendlyName(buildSignature('GET', 'https://a.test/api/58/booking')), 'Booking');
  assert.equal(friendlyName(buildSignature('GET', 'https://a.test/v2/seat/12')), 'Seat');
});

test('28c plumbing words never reach a friendly name (PLAN.md §1.2 zero-jargon)', () => {
  // §11's closing note lists the banned words: JSON, API, endpoint, payload, regex…
  assert.equal(friendlyName(buildSignature('GET', 'https://a.test/rest/payload/endpoint')), 'a.test');
  assert.equal(friendlyName(buildSignature('GET', 'https://a.test/booking-payload')), 'Booking');
  assert.equal(friendlyName(buildSignature('GET', 'https://a.test/v1/json/response')), 'a.test');
  assert.equal(friendlyName(buildSignature('GET', 'https://a.test/trip/endpoint')), 'Trip');
  for (const path of ['/rest/payload/endpoint', '/api/58', '/v1/json/response', '/booking-payload']) {
    const name = friendlyName(buildSignature('GET', 'https://a.test' + path)).toLowerCase();
    for (const banned of ['json', 'api', 'endpoint', 'payload', 'regex']) {
      assert.ok(!name.split(/\W+/).includes(banned), `"${name}" must not contain "${banned}"`);
    }
  }
});

/* --------------------------------------------------------------- match list */

test('29 compileMatchList anchors the regex, stars ids, and lifts params out', () => {
  const [entry] = compileMatchList([
    {
      sigId: 'abc123abc123',
      signature: { method: 'GET', urlPattern: 'https://a.test/orders/*/items?curr=SAR&hotelId=*' },
      changes: [{ path: '$.status', tokens: [{ type: 'key', value: 'status' }], value: 'CANCELLED' }]
    }
  ]);
  assert.equal(entry.urlRegex, '^https://a\\.test/orders/[^/&?]+/items$');
  assert.deepEqual(entry.params, [['curr', 'SAR'], ['hotelId', null]]);
  const re = new RegExp(entry.urlRegex);
  assert.equal(re.test('https://a.test/orders/44212114/items'), true);
  assert.equal(re.test('https://a.test/orders/44212114/items/2'), false);
  assert.equal(re.test('https://evil.test/orders/1/items'), false);
});

test('30 compileMatchList skips signature-less or change-less groups and sorts by specificity', () => {
  const list = compileMatchList([
    { sigId: 'a', signature: { method: 'GET', urlPattern: 'https://a.test/x' }, changes: [{ path: '$.a', tokens: [], value: 1 }] },
    { sigId: 'b', signature: { method: 'GET', urlPattern: 'https://a.test/x?p=1&q=2' }, changes: [{ path: '$.b', tokens: [], value: 2 }] },
    { sigId: 'c', signature: { method: 'GET', urlPattern: 'https://a.test/y' }, changes: [] },
    { sigId: 'd', signature: null, changes: [{ path: '$.d', tokens: [], value: 3 }] }
  ]);
  assert.deepEqual(list.map((e) => e.sigId), ['b', 'a']);
});

test('31 compileMatchList carries the GraphQL operation through', () => {
  const [entry] = compileMatchList([
    {
      sigId: 'g',
      signature: { method: 'POST', urlPattern: 'https://a.test/graphql', gqlOperation: 'HotelDetail' },
      changes: [{ path: '$.data', tokens: [{ type: 'key', value: 'data' }], value: null }]
    }
  ]);
  assert.equal(entry.gqlOperation, 'HotelDetail');
  assert.deepEqual(entry.params, []);
});

/* ------------------------------------------------- the round-trip invariant (D3) */

/**
 * Mirror of the in-page matcher in `interceptor.js` (findChanges). It has to be
 * duplicated here because that file is a MAIN-world IIFE with no exports — see
 * README "Deviations" 11 and 12. The invariant it checks is the important part:
 *
 *   a compiled match entry MUST match the concrete URL its signature was built from.
 *
 * When it does not, nothing throws and nothing is logged — the user's change simply
 * never applies, which is exactly the kind of silent lie PLAN.md §1 forbids.
 */
function matchesOwnUrl(entry, method, url) {
  const parsed = new URL(url);
  const base = parsed.protocol + '//' + parsed.host.toLowerCase() + parsed.pathname;
  if (entry.method !== String(method).toUpperCase()) return false;
  if (!new RegExp(entry.urlRegex).test(base)) return false;

  const groups = new Map();
  for (const [name, value] of entry.params) {
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(value);
  }
  for (const [name, wants] of groups) {
    const pool = parsed.searchParams.getAll(name);
    if (pool.length < wants.length) return false;
    let wildcards = 0;
    for (const want of wants) {
      // null, not "*": a param whose real value is literally "*" is a literal.
      if (want === null) { wildcards += 1; continue; }
      const at = pool.indexOf(want);
      if (at === -1) return false;
      pool.splice(at, 1);
    }
    if (pool.length < wildcards) return false;
  }
  return true;
}

const ROUND_TRIP_URLS = [
  'https://a.test/api/x',
  'https://a.test/api/x?a=1&b=2',
  'https://a.test/orders/44212114/items?curr=SAR',
  'https://a.test/api/x?q=a%26b',                       // encoded & inside a kept value
  'https://a.test/api/x?q=a%3Db',                       // encoded = inside a kept value
  'https://a.test/api/x?q=%D9%85%D8%AF%D9%8A%D9%86%D8%A9', // unicode value
  'https://a.test/api/x?q=hello+world',                 // + means space
  'https://a.test/api/x?a=1&a=2',                       // repeated param name
  'https://a.test/api/x?a=1&a=1',                       // repeated identical values
  'https://a.test/api/x?empty=&b=2',
  'https://a.test/api/x?star=%2A',                      // a literal * (see case 35)
  'https://a.test/api/x?hotelId=44212114&t=99',         // starred value + dropped param
  'https://a.test/api/x?filters=17%7C1~17~1*80%7C0',    // pipes and a literal *
  'https://a.test/api/x?path=%2Fa%2Fb%2Fc',
  TRIP_BASE + '&masterhotelid_tracelogid=100051355-0a8e3544-496571-67667&subStamp=1440'
];

test('32 INVARIANT: a compiled entry always matches the URL its signature came from', async () => {
  for (const url of ROUND_TRIP_URLS) {
    const signature = await normalize('GET', url);
    const [entry] = compileMatchList([
      { sigId: signature.sigId, signature, changes: [{ path: '$.a', tokens: [{ type: 'key', value: 'a' }], value: 1 }] }
    ]);
    assert.ok(entry, 'an entry must be compiled for ' + url);
    assert.equal(matchesOwnUrl(entry, 'GET', url), true, 'entry must match its own URL: ' + url);
  }
});

test('33 the round-trip does not make the matcher indiscriminate', async () => {
  const signature = await normalize('GET', 'https://a.test/api/x?q=a%26b');
  const [entry] = compileMatchList([
    { sigId: signature.sigId, signature, changes: [{ path: '$.a', tokens: [], value: 1 }] }
  ]);
  assert.equal(matchesOwnUrl(entry, 'GET', 'https://a.test/api/x?q=a%26b'), true);
  assert.equal(matchesOwnUrl(entry, 'GET', 'https://a.test/api/x?q=a'), false);
  assert.equal(matchesOwnUrl(entry, 'GET', 'https://a.test/api/x?q=b'), false);
  assert.equal(matchesOwnUrl(entry, 'POST', 'https://a.test/api/x?q=a%26b'), false);
  assert.equal(matchesOwnUrl(entry, 'GET', 'https://a.test/api/y?q=a%26b'), false);
  // Extra params are volatile by construction, so they must not block a match.
  assert.equal(matchesOwnUrl(entry, 'GET', 'https://a.test/api/x?q=a%26b&_=1770000000'), true);
});

test("35 a param whose value is literally '*' stays a literal and never becomes a wildcard", async () => {
  const signature = await normalize('GET', 'https://a.test/api/x?star=%2A');
  // The encoder must not short-circuit on a value that IS "*": emitting it bare would
  // make it decode back to the volatile sentinel and match anything at all.
  assert.equal(signature.urlPattern, 'https://a.test/api/x?star=%2A');
  const [entry] = compileMatchList([
    { sigId: signature.sigId, signature, changes: [{ path: '$.a', tokens: [], value: 1 }] }
  ]);
  assert.deepEqual(entry.params, [['star', '*']], 'a literal, not the null sentinel');
  assert.equal(matchesOwnUrl(entry, 'GET', 'https://a.test/api/x?star=%2A'), true);
  // The assertion that would have failed while the encoder was broken:
  assert.equal(matchesOwnUrl(entry, 'GET', 'https://a.test/api/x?star=anything'), false);
  assert.equal(matchesOwnUrl(entry, 'GET', 'https://a.test/api/x?star=%2A%2A'), false);
});

test('36 a volatile value IS a wildcard, and is the only thing that is', async () => {
  const signature = await normalize('GET', 'https://a.test/api/x?hotelId=44212114&curr=SAR');
  assert.equal(signature.urlPattern, 'https://a.test/api/x?curr=SAR&hotelId=*');
  const [entry] = compileMatchList([
    { sigId: signature.sigId, signature, changes: [{ path: '$.a', tokens: [], value: 1 }] }
  ]);
  assert.deepEqual(entry.params, [['curr', 'SAR'], ['hotelId', null]]);
  assert.equal(matchesOwnUrl(entry, 'GET', 'https://a.test/api/x?hotelId=99881234&curr=SAR'), true);
  assert.equal(matchesOwnUrl(entry, 'GET', 'https://a.test/api/x?hotelId=99881234&curr=USD'), false);
  assert.equal(matchesOwnUrl(entry, 'GET', 'https://a.test/api/x?curr=SAR'), false, 'the param must still be present');
});

test('34 repeated param names are matched as a multiset, not by the first value', async () => {
  const signature = await normalize('GET', 'https://a.test/api/x?tag=red&tag=blue');
  const [entry] = compileMatchList([
    { sigId: signature.sigId, signature, changes: [{ path: '$.a', tokens: [], value: 1 }] }
  ]);
  assert.deepEqual(entry.params, [['tag', 'blue'], ['tag', 'red']]);
  assert.equal(matchesOwnUrl(entry, 'GET', 'https://a.test/api/x?tag=blue&tag=red'), true, 'order must not matter');
  assert.equal(matchesOwnUrl(entry, 'GET', 'https://a.test/api/x?tag=red'), false, 'a missing value must not match');
});
