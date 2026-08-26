/**
 * PLAN.md §10.4's Import and Export, and §16 M5's third DoD line: "a corrupt import file
 * → friendly error".
 *
 * OWNER: panel-designer.
 *
 * Import is the ONE place in MockLab where a file the product did not make crosses into
 * it. `<input type="file">` hands over whatever was clicked, so this suite feeds
 * `parseScenarioFile` the things a file chooser really produces — a photograph, a
 * truncated download, a scenario from another site, something enormous, and a dozen ways
 * a JSON file can be valid and still not be this — and requires each one to come back as
 * exactly one sentence from `strings.js`.
 *
 * ── Why these are mutation matrices and not examples ────────────────────────────
 * `assert.equal(parse(good).ok, true)` and a handful of bad shapes would pass just as
 * happily against a parser with half its rules deleted, because the remaining rules
 * happen to catch the examples somebody thought of. So every rule below is stated as a
 * PAIR: one fixture that differs from the valid scenario in exactly that one respect and
 * must be refused, and the valid scenario itself, which must be accepted. Delete any rule
 * from `scenarioFile.js` and its row goes red on the refusal; break the parser open-ended
 * and every row goes red on the acceptance.
 *
 * And no test here asserts a sentence's WORDING. That would pass with the wording baked
 * into the parser, which is the §17.6 defect this repository has already shipped once
 * (`formatValue`'s `'null'`). The words are swapped for a sentinel and the parser has to
 * print the sentinel.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { S } from '../src/panel/strings.js';
import {
  MAX_CHANGES,
  MAX_FILE_CHARS,
  SCENARIO_EXTENSION,
  parseScenarioFile,
  scenarioFileName,
  serializeScenario
} from '../src/panel/scenarioFile.js';

/** Nothing a human would type, so a match can only have come from strings.js. */
const SENTINEL = '⟪sentinel⟫';

const ORIGIN = 'http://127.0.0.1:8517';
const SITE = { origin: ORIGIN, hostname: '127.0.0.1' };

/** A scenario shaped exactly like one MockLab exported from the demo (§14). */
function goodPreset(over = {}) {
  return {
    id: 'preset-1',
    origin: ORIGIN,
    name: 'Flight cancelled',
    emoji: '🎬',
    createdAt: 1700000000000,
    changes: [
      { sigId: 'sig-trip', path: '$.status', value: 'CANCELLED', enabled: true },
      { sigId: 'sig-trip', path: '$.price.total', value: 0, enabled: true },
      { sigId: 'sig-user', path: '$.name', value: 'Maher', enabled: false, note: 'passenger' }
    ],
    ...over
  };
}

/** The valid file, as text — the thing every mutation below is one step away from. */
const goodFile = () => serializeScenario(goodPreset());

/** Parse an object as if it had been written to disk and chosen in the file picker. */
const parseObject = (object, site = SITE) => parseScenarioFile(JSON.stringify(object), site);

/* ───────────────────────────────────────────────────────── export, and the round trip */

test('§10.4 export → import round-trips every field a scenario is made of', () => {
  const parsed = parseScenarioFile(goodFile(), SITE);
  assert.equal(parsed.ok, true, parsed.error);
  const original = goodPreset();
  assert.equal(parsed.preset.name, original.name);
  assert.equal(parsed.preset.emoji, original.emoji);
  assert.deepEqual(
    parsed.preset.changes,
    original.changes.map((change) => ({
      sigId: change.sigId,
      path: change.path,
      value: change.value,
      enabled: change.enabled,
      ...(change.note ? { note: change.note } : {})
    })),
    'the changes come back with the same source, field, value and on/off state'
  );
  // A false, a zero and a note: the three values a careless round trip loses.
  assert.equal(parsed.preset.changes[1].value, 0, 'zero survives, rather than becoming absent');
  assert.equal(parsed.preset.changes[2].enabled, false, 'a change that was OFF stays off');
  assert.equal(parsed.preset.changes[2].note, 'passenger');
});

test('§10.4 the exported file publishes the §4 fields and nothing else', () => {
  // A worker is free to keep whatever it likes on a stored Preset. A FILE FORMAT that
  // other builds have to read is not free in the same way, and the failure is silent:
  // an internal field ships, someone starts relying on it, and it becomes the format.
  const written = JSON.parse(serializeScenario(goodPreset({ __cache: { hot: true }, lastAppliedAt: 5 })));
  assert.deepEqual(Object.keys(written).sort(), ['changes', 'createdAt', 'emoji', 'id', 'mocklab', 'name', 'origin']);
  assert.deepEqual(Object.keys(written.changes[0]).sort(), ['enabled', 'path', 'sigId', 'value']);
  assert.equal(written.__cache, undefined, 'an internal field does not become part of the format');
});

test('§10.4 the exported file is pretty-printed, as the plan specifies', () => {
  const text = serializeScenario(goodPreset());
  assert.match(text, /\n {2}"name"/, 'two-space indent — a person opening the file can read it');
  assert.equal(JSON.parse(text).name, 'Flight cancelled');
});

test('§10.4 the file name is the scenario\'s own, and never a hidden file', () => {
  assert.equal(scenarioFileName(goodPreset()), 'Flight-cancelled' + SCENARIO_EXTENSION);
  // The cases that would produce a leading dot — which hides the file on every unix-like
  // system and makes a successful export look like nothing happened.
  for (const name of ['', '   ', '///', '...', '<>:"|?*']) {
    const file = scenarioFileName({ name });
    assert.equal(file.startsWith('.'), false, `a scenario named ${JSON.stringify(name)} produced ${file}`);
    assert.equal(file, S.scenarios.untitledFile + SCENARIO_EXTENSION);
  }
  // Digits are part of a name, not punctuation. Written as a test because the obvious
  // character class for "punctuation" — `[ -<]` — is a RANGE that eats every digit.
  assert.equal(scenarioFileName({ name: 'Sprint 4 cancelled' }), 'Sprint-4-cancelled' + SCENARIO_EXTENSION);
});

/* ═══════════════════ the mutation matrix: one row per rule, both directions ═════════ */

/**
 * Each row: what is wrong with the file, the file itself, and the refusal it must draw.
 * `reason` is the machine key — never shown to anyone — so a row asserts WHICH rule
 * fired rather than which words came back.
 */
const REFUSALS = [
  ['a photograph, or anything that is not text this can read', '\x89PNG\r\n\x1a\n', 'not-scenario'],
  ['a truncated download', goodFile().slice(0, 60), 'not-scenario'],
  ['an empty file', '', 'unreadable'],
  ['a file of whitespace', '   \n\t  ', 'unreadable'],
  ['valid JSON that is a list, not a scenario', '[1,2,3]', 'not-scenario'],
  ['valid JSON that is a bare number', '42', 'not-scenario'],
  ['valid JSON that is a string', '"Flight cancelled"', 'not-scenario'],
  ['JSON null', 'null', 'not-scenario'],
  ['some other tool\'s config file', '{"version":2,"rules":[]}', 'not-scenario']
];

for (const [what, text, reason] of REFUSALS) {
  test(`§10.4 import refuses ${what}, in one sentence`, () => {
    const result = parseScenarioFile(text, SITE);
    assert.equal(result.ok, false, `this was accepted as a scenario: ${text.slice(0, 40)}`);
    assert.equal(result.reason, reason);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0, 'a refusal with no sentence is a button that did nothing');
  });
}

/**
 * The shape mutations: the SAME scenario with exactly one thing wrong. The valid object
 * is re-derived per row, so a row can only differ from the accepted file in its own
 * respect — which is what makes this a matrix rather than nine unrelated fixtures.
 */
const SHAPE_MUTATIONS = [
  ['no name at all', (p) => delete p.name, 'not-scenario'],
  ['a name that is not text', (p) => (p.name = 42), 'not-scenario'],
  ['a name of only spaces', (p) => (p.name = '   '), 'not-scenario'],
  ['a name longer than a card could ever show', (p) => (p.name = 'x'.repeat(500)), 'not-scenario'],
  ['no changes key', (p) => delete p.changes, 'not-scenario'],
  ['changes that are not a list', (p) => (p.changes = { a: 1 }), 'not-scenario'],
  ['no changes in it', (p) => (p.changes = []), 'empty'],
  ['a change that is not an object', (p) => (p.changes[0] = 'status'), 'not-scenario'],
  // A hole in the list. JSON writes `undefined` in an array as `null`, so this is what a
  // file produced by a careless exporter really looks like — and it is the one shape that
  // THROWS rather than refusing if the null gate goes: `null.sigId`.
  ['a change that is nothing at all', (p) => (p.changes[0] = null), 'not-scenario'],
  ['a change that was dropped on the way out', (p) => (p.changes = [undefined, p.changes[1]]), 'not-scenario'],
  ['a change that is a list', (p) => (p.changes[0] = ['$.status']), 'not-scenario'],
  ['a change with no source', (p) => delete p.changes[0].sigId, 'not-scenario'],
  ['a change whose source is not text', (p) => (p.changes[0].sigId = 7), 'not-scenario'],
  ['a change with no field', (p) => delete p.changes[0].path, 'not-scenario'],
  ['a change whose field is not a field this build can address', (p) => (p.changes[0].path = 'status'), 'not-scenario'],
  ['a change whose field uses a form this build cannot read', (p) => (p.changes[0].path = '$..status[*]'), 'not-scenario'],
  ['a change with no value key', (p) => delete p.changes[0].value, 'not-scenario'],
  ['more changes than any scenario has', (p) => (p.changes = Array.from({ length: MAX_CHANGES + 1 }, () => ({ sigId: 's', path: '$.a', value: 1 }))), 'too-big'],
  ['a scenario saved on another site', (p) => (p.origin = 'https://www.trip.com'), 'other-site']
];

for (const [what, mutate, reason] of SHAPE_MUTATIONS) {
  test(`§10.4 import refuses a scenario with ${what} — and accepts the same file without it`, () => {
    const broken = goodPreset();
    mutate(broken);
    const refused = parseObject(broken);
    assert.equal(refused.ok, false, `${what} was accepted`);
    assert.equal(refused.reason, reason, `${what} drew the wrong refusal: ${refused.error}`);

    // The other direction. Without this the row above passes against a parser that
    // refuses everything, which is not a friendly error — it is a broken Import button.
    const intact = parseObject(goodPreset());
    assert.equal(intact.ok, true, `the unmutated file must still import: ${intact.error}`);
  });
}

test('§10.4 a value that is null, false or zero is a value, not a missing one', () => {
  // The rule is `hasOwnProperty('value')`, and the reason it is not `entry.value != null`
  // is here: three perfectly good replacement values are falsy, and refusing them would
  // make "set this field to false" an import that fails with no explanation that fits.
  for (const value of [null, false, 0, '', []]) {
    const preset = goodPreset();
    preset.changes[0].value = value;
    const result = parseObject(preset);
    assert.equal(result.ok, true, `a change whose value is ${JSON.stringify(value)} was refused: ${result.error}`);
    assert.deepEqual(result.preset.changes[0].value, value);
  }
});

test('§10.4 a file far too large is refused before it is parsed', () => {
  const huge = '{"name":"x","changes":[' + '0,'.repeat(MAX_FILE_CHARS) + ']}';
  assert.ok(huge.length > MAX_FILE_CHARS);
  const started = Date.now();
  const result = parseScenarioFile(huge, SITE);
  assert.equal(result.reason, 'too-big');
  // Not a performance assertion dressed as correctness: the point is that the answer did
  // not come from `JSON.parse`, and a size check that ran AFTER parsing would have to
  // parse two megabytes of it first. The budget is deliberately loose.
  assert.ok(Date.now() - started < 1000, 'the size answer must not come from parsing the file');
});

test('§10.4 a scenario from the same site, and one with no site recorded, both import', () => {
  // The site check has to refuse a scenario from ELSEWHERE without refusing one saved by
  // an older build that recorded no origin, and without refusing one saved right here.
  assert.equal(parseObject(goodPreset({ origin: ORIGIN })).ok, true);
  assert.equal(parseObject(goodPreset({ origin: '' })).ok, true);
  const noSite = goodPreset();
  delete noSite.origin;
  assert.equal(parseObject(noSite).ok, true);
  // And on a panel that does not know its own site yet, nothing can be compared, so
  // nothing is claimed.
  assert.equal(parseScenarioFile(goodFile(), {}).ok, true);
});

test('§10.4 the site a scenario came from is named, so the person can go there', () => {
  const other = parseObject(goodPreset({ origin: 'https://www.trip.com' }));
  assert.equal(other.reason, 'other-site');
  assert.ok(other.error.includes('www.trip.com'), `the sentence must name the site: “${other.error}”`);
  // Including when the origin in the file is not a URL at all — this is a FILE, so the
  // field can hold anything, and a blank space where the site's name should be is worse
  // than odd text the person can compare with their address bar.
  const junk = parseObject(goodPreset({ origin: 'not a url' }));
  assert.equal(junk.reason, 'other-site');
  assert.ok(junk.error.includes('not a url'));
});

test('§10.4 nothing the file carried beyond the fields MockLab knows reaches the store', () => {
  const hostile = goodPreset();
  hostile.evil = { drop: true };
  hostile.changes[0].probe = true; // §7.1 scaffolding, which §17.5 deletes on sight
  hostile.changes[0].origin = 'https://elsewhere.example';
  const result = parseObject(hostile);
  assert.equal(result.ok, true);
  assert.equal(result.preset.evil, undefined, 'an unknown field must not ride along into storage');
  assert.deepEqual(Object.keys(result.preset).sort(), ['changes', 'createdAt', 'emoji', 'name', 'origin']);
  assert.deepEqual(Object.keys(result.preset.changes[0]).sort(), ['enabled', 'path', 'sigId', 'value']);
  assert.equal(result.preset.id, undefined, 'the worker mints the id, so importing twice gives two scenarios');
});

test('§10.4 a "__proto__" key in the file changes nothing about any other object', () => {
  const text = '{"name":"x","origin":"","changes":[{"sigId":"s","path":"$.a","value":1,"__proto__":{"polluted":true}}],"__proto__":{"polluted":true}}';
  const result = parseScenarioFile(text, SITE);
  assert.equal(result.ok, true);
  assert.equal({}.polluted, undefined, 'nothing in the file may reach Object.prototype');
  assert.equal(result.preset.polluted, undefined);
  assert.equal(result.preset.changes[0].polluted, undefined);
});

/* ────────────────────────────── §17.6: the sentence comes from the copy table ─────── */

test('§17.6 every refusal prints the sentence strings.js gives it, not one of its own', () => {
  // The defect this prevents is a parser that returns its own wording. Asserting the
  // wording would pass with the wording baked in — so the words are replaced and the
  // parser has to print the replacement.
  const keys = ['importUnreadable', 'importNotScenario', 'importEmpty', 'importTooBig', 'importOtherSite'];
  const saved = keys.map((key) => [key, S.scenarios[key]]);
  try {
    for (const key of keys) {
      S.scenarios[key] = typeof S.scenarios[key] === 'function' ? () => SENTINEL : SENTINEL;
    }
    const cases = [
      ['', 'unreadable'],
      ['not a scenario at all', 'not-scenario'],
      [JSON.stringify(goodPreset({ changes: [] })), 'empty'],
      ['x'.repeat(MAX_FILE_CHARS + 1), 'too-big'],
      [JSON.stringify(goodPreset({ origin: 'https://www.trip.com' })), 'other-site']
    ];
    for (const [text, reason] of cases) {
      const result = parseScenarioFile(text, SITE);
      assert.equal(result.reason, reason);
      assert.equal(result.error, SENTINEL, `the ${reason} refusal holds a word of its own`);
    }
  } finally {
    for (const [key, value] of saved) S.scenarios[key] = value;
  }
});

test('§1.2 a friendly error shows no stack, no file contents and no technical vocabulary', () => {
  // §16 M5's DoD says the corrupt file produces a FRIENDLY error. Mechanically: the
  // sentence may not contain a parser's words, a position in the file, the file's own
  // text, or any of §11's banned vocabulary.
  const hostile = [
    '{"name": "x", "changes": [',
    'SyntaxError: Unexpected token',
    '<?xml version="1.0"?><plist/>',
    '\x00\x01\x02binary'
  ];
  const BANNED = /\b(json|api|endpoint|payload|regex|dom|probe|binding|signature|syntax|parse|token|null|undefined|nan)s?\b/i;
  for (const text of hostile) {
    const result = parseScenarioFile(text, SITE);
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error, BANNED, `“${result.error}” speaks to a programmer`);
    assert.doesNotMatch(result.error, /\bat line\b|\bposition \d|\bcolumn \d/i, 'no position in the file');
    assert.doesNotMatch(result.error, /\n/, 'one sentence, not a report');
    assert.equal(result.error.includes(text.slice(0, 20)), false, 'the file\'s own text is not quoted back');
    assert.doesNotMatch(result.error, /!/, '§11: no exclamation marks outside an applied moment');
  }
});

test('§11 each refusal says something different, because each needs a different next step', () => {
  // Five sentences and not one "that didn\'t work": a person who picked a screenshot, a
  // person who picked a scenario from another site and a person whose file is damaged
  // have three different things to do next. Collapsing them is the calm-looking failure.
  const sentences = [
    S.scenarios.importUnreadable,
    S.scenarios.importNotScenario,
    S.scenarios.importEmpty,
    S.scenarios.importTooBig,
    S.scenarios.importOtherSite('example.com')
  ];
  assert.equal(new Set(sentences).size, sentences.length, `the refusals read as ${new Set(sentences).size} sentences`);
  for (const sentence of sentences) {
    assert.ok(sentence.trim().length > 0);
    assert.equal(sentence.trim(), sentence, 'no stray whitespace in a sentence a person reads');
  }
});
