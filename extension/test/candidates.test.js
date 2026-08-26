/**
 * Candidate discovery (PLAN.md §6.3) — the hypothesis generator behind the Pick tab.
 *
 * OWNER: probe-engineer.
 *
 * Two things these tests try hard to be, because M2's post-mortem says a test that
 * asserts today's output is not a guard:
 *
 *  1. Fixture-honest. The §16 M3 DoD is about the DEMO, so the DoD tests read
 *     `companion/src/demo/api/*.json` off disk rather than embedding a copy. If someone
 *     edits the demo, these fail — which is the point: the demo is the acceptance
 *     harness and a stale copy of it proves nothing.
 *  2. Directional. Every rule is asserted both ways: that it fires when it should, and
 *     that the case it is supposed to reject is actually rejected. The sibling-key
 *     heuristic in particular is proved on a fixture where NOTHING else can find the
 *     field, so a test passing on it cannot be a substring match in disguise.
 *
 * Nothing here may produce a link state. §6.3 emits guesses; §17.4 owns the rest.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  findCandidates,
  searchValue,
  needlesFrom,
  leavesOf,
  scanLeaves,
  SCORE,
  MAX_CANDIDATES,
  MAX_DEPTH,
  MAX_PATHS,
  MAX_TOTAL_PATHS
} from '../src/background/candidates.js';
import { findByValue } from '../src/shared/jsonpath.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO_API = path.resolve(HERE, '../../companion/src/demo/api');
const demo = (name) => JSON.parse(fs.readFileSync(path.join(DEMO_API, name), 'utf8'));

/** The two sources the demo loads, in the shape the service worker hands over. */
function demoSources() {
  return [
    { sigId: 'trip', name: 'Trip', body: demo('trip.json'), ts: 2000 },
    { sigId: 'user', name: 'User', body: demo('user.json'), ts: 1000 }
  ];
}

/** What `picker.js` sends for the demo's status pill: `<div id="status-pill">On time</div>`. */
const PILL = {
  tag: 'div',
  text: 'On time',
  attrs: { id: 'status-pill' },
  cls: [],
  style: {},
  childCount: 0,
  childTexts: []
};

/** …and for the total row: `<span id="price-total">SAR 450.00</span>`. */
const PRICE = {
  tag: 'span',
  text: 'SAR 450.00',
  attrs: { id: 'price-total' },
  cls: [],
  style: {},
  childCount: 0,
  childTexts: []
};

const pathsOf = (candidates) => candidates.map((c) => c.sigId + ' ' + c.path);
const find = (candidates, sigId, jsonPath) =>
  candidates.find((c) => c.sigId === sigId && c.path === jsonPath) || null;

/* ═════════════════════════════════════════════════ §16 M3 DoD, on the real demo ══ */

test('§16 M3 DoD 1 — picking the demo status pill lists `status` in the top 3', () => {
  const { candidates } = findCandidates(PILL, demoSources());
  const top3 = pathsOf(candidates).slice(0, 3);
  assert.ok(
    top3.includes('trip $.status'),
    `$.status must be in the top 3; got ${JSON.stringify(top3)}`
  );

  // The pill renders "On time" and the data says "ON_TIME". Assert that gap really
  // exists in the fixture, so this test cannot quietly become trivial if someone
  // "fixes" the demo to say "On time" in its JSON.
  const trip = demo('trip.json');
  assert.equal(trip.status, 'ON_TIME');
  assert.equal(
    findByValue(trip, 'On time').length,
    0,
    'the pill text appears NOWHERE verbatim in the response — that is what makes this DoD hard'
  );
});

test('§16 M3 DoD 1 — the sibling-key heuristic is one of the rules that finds it', () => {
  const { candidates } = findCandidates(PILL, demoSources());
  const status = find(candidates, 'trip', '$.status');
  assert.ok(status, '$.status is a candidate at all');
  assert.ok(
    status.rules.includes('sibling-key'),
    `§6.3's enum heuristic must be one of the rules that reached $.status; got ${JSON.stringify(status.rules)}`
  );
});

test('§16 M3 DoD 2 — picking the demo price finds price.total by numeric match', () => {
  const { candidates } = findCandidates(PRICE, demoSources());
  const total = find(candidates, 'trip', '$.price.total');
  assert.ok(total, `$.price.total must be a candidate; got ${JSON.stringify(pathsOf(candidates))}`);
  assert.equal(total.via, 'numeric', 'found by numeric match, per the DoD');
  assert.equal(total.score, SCORE.numeric);
  assert.equal(total.value, 450);

  // "SAR 450.00" never appears verbatim either: the page formats it. The 450 is the
  // only bridge, and $.price.total must outrank the currency word it sits beside.
  assert.equal(candidates[0].path, '$.price.total', 'and it ranks first');
  const currency = find(candidates, 'trip', '$.price.currency');
  assert.ok(currency && currency.score < total.score, 'the word "SAR" is weaker evidence than the number');
});

test('§6.3 the sibling-key gate holds on the demo itself', () => {
  // user.json carries `$.user.status` — a status-ish key in a response that renders no
  // part of the pill. It is in the fixture FOR this assertion: without it the gate had
  // no demo coverage at all, and a rule only synthetic tests exercise is a rule that
  // can rot. Picking the pill must offer nothing from it.
  const user = demo('user.json');
  assert.equal(user.user.status, 'ACTIVE', 'the demo still has the unrelated status-ish key');
  assert.equal(findByValue(user, 'On time').length + findByValue(user, 'time').length, 0,
    'and user.json still renders no part of the pill — that is what makes it unrelated');

  const { candidates } = findCandidates(PILL, demoSources());
  assert.deepEqual(
    candidates.filter((c) => c.sigId === 'user'),
    [],
    'a status-ish key in a response nothing pointed at is just another field on the internet'
  );
});

/* ══════════════════════════════════════════ the sibling-key heuristic, isolated ══ */

/**
 * The demo can only ever prove that the heuristic CONTRIBUTES — a substring hit
 * ("time" inside "ON_TIME") reaches `$.status` there too. This fixture removes that
 * escape route entirely: a Spanish pill, an enum with no shared letters, and the only
 * bridge to the response is the flight code beside it.
 */
const LOCALIZED = [
  {
    sigId: 'es',
    name: 'Trip',
    ts: 1,
    body: { flight: { code: 'SV1042' }, status: 'ON_TIME', crew: { name: 'Nora' } }
  }
];
const SPANISH_PILL = { tag: 'span', text: 'SV1042 En hora', attrs: {}, childTexts: [] };

test('§6.3 the sibling-key heuristic finds an enum no needle could reach', () => {
  const { candidates } = findCandidates(SPANISH_PILL, LOCALIZED);
  const status = find(candidates, 'es', '$.status');
  assert.ok(status, 'the localized pill still finds $.status');
  assert.equal(status.via, 'sibling-key');
  assert.equal(status.score, SCORE.siblingKey);
  assert.deepEqual(status.rules, ['sibling-key'], 'and NOTHING else found it — no substring, no number');
});

test('§6.3 the heuristic is gated: a response nothing pointed at yields no siblings', () => {
  const unrelated = [
    { sigId: 'other', name: 'Other', ts: 1, body: { status: 'ACTIVE', type: 'PREMIUM', code: 'XX' } }
  ];
  const { candidates } = findCandidates(SPANISH_PILL, unrelated);
  assert.deepEqual(
    candidates,
    [],
    'without a single hit from the element, a status-ish key is just another field on the internet'
  );

  // …and the same response DOES contribute once something ties it to the element.
  const related = [{ ...unrelated[0], body: { ...unrelated[0].body, label: 'SV1042' } }];
  const after = findCandidates(SPANISH_PILL, related).candidates;
  assert.ok(find(after, 'other', '$.status'), 'one hit is enough to make its siblings worth a probe');
  assert.ok(find(after, 'other', '$.type'), 'every status-ish key in it, not just the first');
});

test('§6.3 the heuristic never offers a null or an object', () => {
  const sources = [
    { sigId: 's', name: 'S', ts: 1, body: { code: 'SV1042', status: null, state: { deep: 'x' }, type: 'A' } }
  ];
  const { candidates } = findCandidates({ text: 'SV1042', attrs: {} }, sources);
  const offered = candidates.map((c) => c.path);
  assert.ok(!offered.includes('$.status'), '§7.4 forbids probing a null-valued candidate');
  assert.ok(!offered.includes('$.state'), 'an object is not a leaf');
  assert.ok(offered.includes('$.type'), 'the scalar sibling is still offered');
});

/* ═══════════════════════════════════════════════════════════ needles (§6.3's list) */

test('§6.3 needles: full text, numeric tokens, words of 3+, times kept whole', () => {
  const needles = needlesFrom({ text: 'Gate A17 · 12:40 · SAR 1,299.00', attrs: {} });
  const byKind = (kind) => needles.filter((n) => n.kind === kind).map((n) => n.value);

  assert.deepEqual(byKind('full'), ['Gate A17 · 12:40 · SAR 1,299.00']);
  assert.ok(byKind('time').includes('12:40'), 'HH:MM survives as one needle');
  assert.ok(!needles.some((n) => n.value === '40'), 'and is never shredded into 12 and 40');
  assert.ok(byKind('number').includes('1,299.00'), 'thousands separators are left for the numeric compare');
  assert.ok(byKind('word').includes('Gate'), 'words of three characters or more');
  assert.ok(!needles.some((n) => n.value === '·'), 'punctuation is not a word');
});

test('needles come from text a person can perceive, not from build artefacts', () => {
  const values = needlesFrom({
    text: 'Cancel',
    attrs: { 'aria-label': 'Cancel booking', id: 'btn-status-42', class: 'x', 'data-testid': 'cancel-status' }
  }).map((n) => n.value);
  assert.ok(values.includes('Cancel booking'), 'the accessible name is text a user hears');
  assert.ok(!values.includes('btn-status-42'), 'an id is not content');
  assert.ok(!values.includes('cancel-status'), 'nor is a test hook');
});

test('an element with no text and no labels yields no needles and no guesses', () => {
  assert.deepEqual(needlesFrom({ text: '   ', attrs: {} }), []);
  const { candidates } = findCandidates({ text: '', attrs: {} }, demoSources());
  assert.deepEqual(candidates, [], 'silence is the honest answer — the panel shows pick.noCandidates');
});

/* ═══════════════════════════════════════════════════ scoring & ordering (§6.3) ══ */

test('§6.3 scores: exact full text 1.0, exact numeric 0.9, substring 0.5', () => {
  const sources = [{ sigId: 's', name: 'S', ts: 1, body: { a: 'On time', b: 'the On time pill', c: 42 } }];
  const { candidates } = findCandidates({ text: 'On time', attrs: {} }, sources);
  assert.equal(find(candidates, 's', '$.a').score, 1.0);
  assert.equal(find(candidates, 's', '$.a').via, 'full-text');
  assert.equal(find(candidates, 's', '$.b').score, 0.5);
  assert.equal(find(candidates, 's', '$.b').via, 'substring');

  const numeric = findCandidates({ text: '42', attrs: {} }, sources).candidates;
  assert.equal(find(numeric, 's', '$.c').score, 1.0, 'a leaf whose text IS the element text is exact');

  const embedded = findCandidates({ text: 'Seat 42', attrs: {} }, sources).candidates;
  assert.equal(find(embedded, 's', '$.c').score, 0.9, 'a numeric token out of a longer text is 0.9');
  assert.equal(find(embedded, 's', '$.c').via, 'numeric');
});

test('§6.3 ties break on shorter path, then on response recency', () => {
  const sources = [
    { sigId: 'old', name: 'Old', ts: 1, body: { x: 'On time' } },
    { sigId: 'new', name: 'New', ts: 9, body: { x: 'On time' } },
    { sigId: 'deep', name: 'Deep', ts: 9, body: { a: { b: { c: 'On time' } } } }
  ];
  const { candidates } = findCandidates({ text: 'On time', attrs: {} }, sources);
  assert.deepEqual(pathsOf(candidates).slice(0, 3), ['new $.x', 'old $.x', 'deep $.a.b.c']);
});

test('§6.3 returns at most 12 candidates', () => {
  const body = {};
  for (let i = 0; i < 40; i += 1) body['field' + i] = 'On time';
  const { candidates } = findCandidates({ text: 'On time', attrs: {} }, [
    { sigId: 's', name: 'S', ts: 1, body }
  ]);
  assert.equal(candidates.length, MAX_CANDIDATES);
});

test('one field hit by several rules keeps the best score and remembers all of them', () => {
  const sources = [{ sigId: 's', name: 'S', ts: 1, body: { status: 'On time' } }];
  const { candidates } = findCandidates({ text: 'On time', attrs: {} }, sources);
  const hit = find(candidates, 's', '$.status');
  assert.equal(hit.score, 1.0, 'the exact hit wins');
  assert.equal(hit.via, 'full-text');
  // Three ways in: the whole text matches, the word "time" is inside it, and the key
  // is status-ish. All three are recorded; only the strongest sets the score.
  assert.deepEqual(hit.rules, ['full-text', 'sibling-key', 'substring'], 'sorted, all of them');
});

/* ════════════════════════════════════ the matcher agrees with findByValue (§5.4) ══ */

/**
 * `candidates.js` matches against a pre-enumerated leaf list instead of calling
 * `findByValue` per needle, for the reason in that file's header. This is the guard
 * that keeps the two honest: same bodies, same needles, identical results, including
 * the awkward ones — an empty string leaf is `Number('') === 0`, a boolean never
 * matches numerically, a null leaf never matches at all.
 */
test('§5.4 scanLeaves is findByValue, leaf for leaf', () => {
  const bodies = [
    demo('trip.json'),
    demo('user.json'),
    { a: '', b: 0, c: false, d: true, e: null, f: '  padded  ', g: '1,299', h: 1299 },
    [{ status: 'ON_TIME' }, { status: 'DELAYED' }],
    { 'key.with.dots': 'x', 'مدينة': 'الرياض', nested: { deep: [1, 2, { x: 'On time' }] } },
    { n: 12.5, s: '12.50', z: '0012' }
  ];
  const needles = [
    'On time', 'ON_TIME', 'time', '450', '450.00', '0', '', '  ', 'false', 'true',
    '1299', '1,299', '12.5', '12.50', '0012', 'الرياض', 'x', 'SV 1042', 'nora@example.com'
  ];
  let compared = 0;
  for (const body of bodies) {
    const { leaves } = leavesOf(body);
    for (const needle of needles) {
      assert.deepEqual(
        scanLeaves(leaves, needle),
        findByValue(body, needle),
        `disagreement on ${JSON.stringify(needle)} in ${JSON.stringify(body).slice(0, 60)}`
      );
      compared += 1;
    }
  }
  assert.equal(compared, bodies.length * needles.length);
});

/* ════════════════════════════════════════════════════════════════ hostile input ══ */

test('bodies MockLab could not parse offer no fields', () => {
  const sources = [
    { sigId: 'raw', name: 'Raw', ts: 1, body: { __unparsed: true, preview: 'On time On time' } },
    { sigId: 'nul', name: 'Nul', ts: 1, body: null },
    { sigId: 'str', name: 'Str', ts: 1, body: 'On time' }
  ];
  const { candidates } = findCandidates({ text: 'On time', attrs: {} }, sources);
  assert.deepEqual(candidates, [], 'a field it cannot address is not a field it may offer');
});

test('malformed input is answered, not thrown at', () => {
  assert.deepEqual(findCandidates(null, null).candidates, []);
  assert.deepEqual(findCandidates({ text: 'x' }, undefined).candidates, []);
  assert.deepEqual(findCandidates({ text: 'On time', attrs: {} }, [null, {}, { sigId: 5 }]).candidates, []);
  assert.deepEqual(searchValue(null, demoSources()), []);
  assert.deepEqual(searchValue('  ', demoSources()), []);
});

test('an array-rooted response is searchable, and keys on the array it sits in', () => {
  const sources = [
    { sigId: 'arr', name: 'Arr', ts: 1, body: [{ ref: 'MKL8842', status: 'ON_TIME' }, { ref: 'X', status: 'DELAYED' }] }
  ];
  const { candidates } = findCandidates({ text: 'MKL8842', attrs: {} }, sources);
  assert.equal(find(candidates, 'arr', '$[0].ref').score, 1.0);
  assert.ok(find(candidates, 'arr', '$[0].status'), 'siblings inside an array element are found too');

  const codes = leavesOf({ codes: ['A', 'B'] }).leaves;
  assert.equal(codes[0].key, 'codes', 'an index step keys on the nearest name above it');
});

/* ══════════════════════════════════════════════════════ search_value (§12.4 #4) ══ */

test('§12.4 search_value is the same engine with one needle and no element', () => {
  const hits = searchValue('ON_TIME', demoSources());
  assert.deepEqual(pathsOf(hits), ['trip $.status', 'trip $.booking.status']);
  assert.ok(hits.every((h) => h.score === 1.0 && h.via === 'full-text'));
  assert.equal(hits[0].sourceName, 'Trip', 'the friendly name travels with the answer');
  assert.ok(
    !searchValue('ON_TIME', demoSources()).some((h) => h.rules.includes('sibling-key')),
    'no element, no enum heuristic — it reasons about rendered text'
  );
});

/* ═════════════════════════════════════════════════════════════════════ bounded ══ */

test('§1.1 the tab-wide leaf budget is enforced AND admitted', () => {
  // Raising the per-response cap raises the worst case with it: without a tab-wide
  // budget, 200 sources at the ceiling measured 3.2 s of blocked service worker for one
  // click. The budget is only tolerable because what it skips is reported, not hidden.
  const wide = {};
  for (let i = 0; i < 6000; i += 1) wide['f' + i] = 'v' + i;
  const many = Array.from({ length: 40 }, (_, i) => ({ sigId: 's' + i, name: 'S', ts: i, body: wide }));
  assert.ok(40 * 6000 > MAX_TOTAL_PATHS, 'this fixture really does exceed the budget');

  const started = Date.now();
  const { candidates, searched } = findCandidates({ text: 'v42', attrs: {} }, many);
  const elapsed = Date.now() - started;

  assert.equal(searched.sources, 40, 'every source is counted');
  assert.ok(searched.bounded > 0, 'the ones past the budget are reported, not silently dropped');
  assert.equal(searched.complete, false);
  assert.ok(candidates.length > 0, 'and what WAS searched still answers — newest sources first');
  assert.ok(elapsed < 1000, `bounded work: ${elapsed} ms`);
});

test('a tab full of large responses is scored in well under a second', () => {
  const big = {};
  for (let i = 0; i < 500; i += 1) big['field' + i] = { name: 'value ' + i, status: 'ACTIVE', n: i };
  const sources = Array.from({ length: 60 }, (_, i) => ({ sigId: 's' + i, name: 'S', ts: i, body: big }));
  const started = Date.now();
  const { candidates } = findCandidates({ text: 'value 42 at 12:40 for SAR 450', attrs: {} }, sources);
  const elapsed = Date.now() - started;
  assert.ok(candidates.length > 0);
  assert.ok(elapsed < 1000, `60 sources x 1500 leaves scored in ${elapsed} ms`);
});

/* ════════════════════ how far the search reached, and saying so (§1.1, §6.3) ══════ */

/** A body nested `depth` levels deep with one findable field at the bottom. */
function nested(depth) {
  let body = { status: 'ON_TIME', label: 'SV1042' };
  for (let i = 0; i < depth; i += 1) body = { level: body };
  return body;
}

test('a field deeper than §5.4\'s default 12 is still found', () => {
  // §5.4's default would stop at 12. Real Next.js and Apollo payloads nest past it, and
  // the whole product is aimed at exactly those pages.
  const sources = [{ sigId: 's', name: 'S', ts: 1, body: nested(18) }];
  const { candidates, searched } = findCandidates({ text: 'SV1042', attrs: {} }, sources);
  assert.ok(candidates.some((c) => c.path.endsWith('.status')), '18 levels down is inside the search');
  assert.equal(searched.complete, true, 'and the search reached the end of it');
});

test('§1.1 a search that did NOT reach everywhere says so instead of reporting nothing', () => {
  const tooDeep = [{ sigId: 's', name: 'S', ts: 1, body: nested(MAX_DEPTH + 2) }];
  const { candidates, searched } = findCandidates({ text: 'SV1042', attrs: {} }, tooDeep);

  // This is the case that would otherwise be a lie: no candidates, because MockLab
  // stopped looking — not because the field is absent. `pick.noCandidates` claims the
  // text is in none of the data the page loaded, which MockLab has not established.
  assert.deepEqual(candidates, [], 'nothing was found below the cut');
  assert.equal(searched.complete, false, 'and the answer admits the search was bounded');
  assert.equal(searched.bounded, 1);
  assert.equal(searched.sources, 1);
});

test('a search wider than MAX_PATHS is reported bounded too', () => {
  const wide = {};
  for (let i = 0; i < MAX_PATHS + 500; i += 1) wide['f' + i] = 'v' + i;
  const { searched } = findCandidates({ text: 'v3', attrs: {} }, [{ sigId: 's', name: 'S', ts: 1, body: wide }]);
  assert.equal(searched.complete, false, `${MAX_PATHS} leaves is the cut, and it is admitted`);
});

test('an ordinary response is reported complete, and an unreadable one is not "bounded"', () => {
  const { searched } = findCandidates(PILL, demoSources());
  assert.deepEqual(searched, { sources: 2, bounded: 0, complete: true },
    'the demo is fully searched — "nothing found" there really would mean nothing is there');

  const unparsed = [{ sigId: 'raw', name: 'Raw', ts: 1, body: { __unparsed: true, preview: 'x' } }];
  assert.equal(findCandidates(PILL, unparsed).searched.complete, true,
    'a body MockLab never parsed is a KNOWN nothing, not a bounded search — §5.1.4 lists it read-only');
});

test('the depth probe agrees with what enumeration actually dropped', () => {
  // The boundedness flag is computed by a second walk, so it can drift from the walk it
  // describes. Check the two against each other at the boundary, both sides.
  for (let depth = MAX_DEPTH - 3; depth <= MAX_DEPTH + 3; depth += 1) {
    const { leaves, bounded } = leavesOf(nested(depth));
    const reachedTheBottom = leaves.some((leaf) => leaf.value === 'SV1042');
    assert.equal(bounded, !reachedTheBottom, `depth ${depth}: bounded=${bounded}, found=${reachedTheBottom}`);
  }
});

/* ══════════════════ §6.3 against the body the page actually rendered from ═════════ */

/**
 * QA's M4 journey, exactly: set `$.status` to "DELAYED" from the tree, watch the demo
 * pill render "Delayed", then ask MockLab which field did it.
 *
 * The capture is what the SERVER sent, so the un-mocked demo body has no "Delayed"
 * anywhere in it — and searching that alone produced ZERO candidates, which the panel
 * reported as §11's `pick.noCandidates`: "MockLab couldn't find this text in any data
 * the page loaded." The data was right there. `source.changes` is what closes it; see
 * `effectiveBody.js`. Removing that argument fails this test with an empty list, which
 * is the mutation that proves the assertion bites.
 */
test('§6.3 a field the person has already changed is found from the text it renders', () => {
  const mocked = demoSources();
  mocked[0].changes = [{ path: '$.status', value: 'DELAYED' }];
  const pill = { ...PILL, text: 'Delayed' };

  const before = findCandidates(pill, demoSources()).candidates;
  assert.deepEqual(before, [], 'the captured body alone really does contain no "Delayed"');

  const { candidates, searched } = findCandidates(pill, mocked);
  const hit = find(candidates, 'trip', '$.status');
  assert.ok(hit, `\$.status must be offered — got ${JSON.stringify(pathsOf(candidates))}`);
  assert.equal(hit.score, SCORE.fullExact, 'the pill text IS the value at that field');
  assert.equal(hit.value, 'DELAYED', 'and the value shown is the one the page received');
  assert.equal(hit.realValue, 'ON_TIME', 'with the captured value beside it, not instead of it');
  assert.equal(hit.mocked, true);
  assert.equal(searched.complete, true, 'nothing about this search was bounded');
});

test('§6.3 the captured value stays searchable beside the changed one', () => {
  // A Change enabled a moment ago has not reached the site until the next refresh, and
  // `interceptor.js` can report a `changeDropped` response it never rewrote — in both,
  // the page really did render the CAPTURED value. So both are searched.
  const mocked = demoSources();
  mocked[0].changes = [{ path: '$.status', value: 'DELAYED' }];

  const stillReal = findCandidates(PILL, mocked).candidates;
  assert.ok(find(stillReal, 'trip', '$.status'), '"On time" still reaches $.status');
  assert.equal(find(stillReal, 'trip', '$.status').mocked, true, 'and says a Change is in force');
});

test('§6.3 a Change on a path the body does not have contributes nothing', () => {
  // `setByPath` "creates nothing" (§5.4), so such a Change never reached the page either
  // — offering a field that exists in no response would be an invented candidate. A null
  // is dropped for §7.4's reason, the same one the captured walk drops nulls for.
  const sources = demoSources();
  sources[0].changes = [
    { path: '$.nowhere', value: 'Delayed' },
    { path: '$.status', value: null }
  ];
  const { candidates } = findCandidates({ ...PILL, text: 'Delayed' }, sources);
  assert.deepEqual(candidates, [], 'no path, no leaf — and §7.4 never offers a null');
});

test('§6.3 a Change that puts a scalar where a container was is a leaf, because the page saw one', () => {
  // `$.flight` holds an object in the capture and a string on the page. The leaf the
  // person is looking at is the string; refusing it because the CAPTURE has a container
  // there would be the same "search the wrong document" mistake in miniature.
  const sources = demoSources();
  sources[0].changes = [{ path: '$.flight', value: 'Delayed' }];
  const hit = find(findCandidates({ ...PILL, text: 'Delayed' }, sources).candidates, 'trip', '$.flight');
  assert.ok(hit);
  assert.equal(hit.value, 'Delayed');
  assert.deepEqual(hit.realValue, demo('trip.json').flight);
});

test('§6.3 the sibling-key heuristic reads the changed body too', () => {
  // The gate is "this response demonstrably renders part of this element". With a Change
  // in force, the only thing that can demonstrate it is the changed value.
  const sources = [{
    sigId: 'shop',
    name: 'Shop',
    ts: 1,
    body: { item: { label: 'Zapatos', availability: 'AGOTADO' } },
    changes: [{ path: '$.item.label', value: 'Botas' }]
  }];
  const { candidates } = findCandidates({ tag: 'span', text: 'Botas', attrs: {} }, sources);
  const enumField = find(candidates, 'shop', '$.item.availability');
  assert.ok(enumField, 'the status-ish sibling is offered');
  assert.equal(enumField.via, 'sibling-key');
  assert.equal(enumField.mocked, undefined, 'and it carries no Change of its own');
});
