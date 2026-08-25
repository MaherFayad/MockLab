/**
 * PLAN.md §17.6 — "Every user-visible string comes from `strings.js`. Adding a literal
 * string in panel.js is a bug" — checked on the panel, on every `npm test`.
 *
 * OWNER: panel-designer. Added at M2 for a defect this suite could not see.
 *
 * `formatValue` in `sources.js` returned the literal `'null'`, and that word reached the
 * human twice: as any field with no value in the tree (§10.2), and inside "Real value:
 * null" in the editor (§10.1 State D). It survived a browser suite that drives the whole
 * §16 M2 flow, because the demo trip (§14) holds no such field — the render path was
 * exercised for every OTHER type. That is the shape of this defect class: a branch no
 * fixture happens to take, printing a word no copy table ever approved.
 *
 * So the tests below do not assert today's output. Asserting `formatValue(null) ===
 * 'nothing'` would pass just as happily with the word hardcoded, which is the bug. They
 * assert the COUPLING instead:
 *   1. swap the words in `strings.js` for a sentinel and the panel must print it —
 *      any word baked into the function fails;
 *   2. read the function's source and allow no quoted word in it at all;
 *   3. audit every place the panel puts text on screen, for the next one.
 *
 * This file is unit-level on purpose. The browser suite needs a null-bearing fixture to
 * see any of this, and changing the demo's data to grow one would change what every
 * other milestone's acceptance test is run against.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { S } from '../src/panel/strings.js';
import { formatValue, draftFor } from '../src/panel/sources.js';

const PANEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'panel');
const read = (file) => fs.readFileSync(path.join(PANEL, file), 'utf8');

/** Nothing a human would ever type, so a match can only have come from strings.js. */
const SENTINEL = '⟪sentinel⟫';

/** Comments claim nothing and print nothing; only code can put a word on screen. */
function stripComments(text) {
  let inBlock = false;
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (inBlock) {
        if (trimmed.includes('*/')) inBlock = false;
        return '';
      }
      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/')) inBlock = true;
        return '';
      }
      if (trimmed.startsWith('//')) return '';
      return line.replace(/(^|[^:])\/\/.*$/, '$1');
    })
    .join('\n');
}

/** One top-level function's source. Every function in this codebase closes at column 0. */
function functionBody(text, name) {
  const start = text.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() is the subject of this audit and it has been renamed or removed`);
  const end = text.indexOf('\n}', start);
  assert.notEqual(end, -1, `${name}() must close at column 0 for this audit to read it`);
  return stripComments(text.slice(start, end));
}

/** Every quoted string in a chunk of code, contents only. */
function stringLiterals(code) {
  return [...code.matchAll(/(['"`])((?:[^'"`\\]|\\.)*)\1/g)].map((match) => match[2]);
}

/* ─────────────────────────────────── the words the tree and the editor print */

test('§17.6 the panel prints the words strings.js gives it, not words of its own', () => {
  // A value with no text of its own is DESCRIBED, and every description is copy: it is
  // read by the same person, translated with the same file, and can be just as wrong.
  const original = { ...S.glyph };
  try {
    S.glyph.nullValue = SENTINEL;
    S.glyph.collapsedObject = SENTINEL;
    S.glyph.list = (n) => `${SENTINEL}${n}`;

    assert.equal(formatValue(null), SENTINEL, 'a field the site sent with no value in it');
    assert.equal(formatValue({ a: 1 }), SENTINEL, 'a container drawn collapsed');
    assert.equal(formatValue([1, 2]), `${SENTINEL}2`, 'a list drawn collapsed');
  } finally {
    Object.assign(S.glyph, original);
  }
});

test('§17.6 formatValue holds no word of its own, in any branch', () => {
  // The test above can only see the branches it calls. This one reads the function.
  // `valueKind()` next door is deliberately NOT audited: its 'null' is a CSS class name
  // that reaches a stylesheet, never a reader.
  const TYPEOF_TAGS = ['object', 'string', 'number', 'boolean', 'undefined', 'function', 'symbol', 'bigint'];
  for (const name of ['formatValue', 'draftFor']) {
    const words = stringLiterals(functionBody(read('sources.js'), name)).filter(
      (literal) => literal !== '' && !TYPEOF_TAGS.includes(literal)
    );
    assert.deepEqual(
      words,
      [],
      `${name}() contains ${JSON.stringify(words)}. A word this function can print belongs in ` +
        'strings.js (§17.6) — the only quoted strings it may hold are the type names it branches on.'
    );
  }
});

test("§1.2 no reader of this panel is shown a programmer's name for an absent value", () => {
  // `null` is the word §1.2's non-technical user has no meaning for. It is not in §11's
  // banned list literally, and it does not need to be: the list is examples of a rule.
  assert.doesNotMatch(
    S.glyph.nullValue,
    /^(null|nil|none|undefined|nan|void|n\/a)$/i,
    'the tree and "Real value: …" show this word to a designer or a QA person'
  );
  assert.ok(S.glyph.nullValue.trim().length > 0, 'an absent value is worth saying out loud, not blank');
});

test('a value that is absent never reads like a value that is there', () => {
  // §1's brand is certainty, and the tree is where the person decides what to edit. If
  // "no value" and a real one draw the same, the panel has told them something false.
  const absent = formatValue(null);
  for (const [label, value] of [
    ['a value that was never there', undefined],
    ['an empty text', ''],
    ['zero', 0],
    ['false', false],
    ['an empty list', []]
  ]) {
    assert.notEqual(formatValue(value), absent, `${label} must not read the same as a field with no value`);
  }
  // The one collision copy cannot prevent: a text whose content IS the word. panel.css
  // draws a description in italics and a real text in the string colour, so the two are
  // told apart by something other than colour (WCAG 1.4.1).
  assert.match(
    read('panel.css'),
    /\.tree__value--null\s*\{[^}]*font-style:\s*italic/,
    'a described value must be visibly a description, not only a different colour'
  );
});

/* ─────────────────────────── what the editor SEEDS, which is not what the tree shows */

/**
 * The M2 fix these two tests were missing.
 *
 * `draftFor` exists because `formatValue` DESCRIBES a value that has no text of its own
 * ("nothing", "{…}"), and a description seeded into an editable box is applied as if the
 * person had typed it: opening the editor on a field the site sent with no value in it,
 * and pressing Apply without touching the box, sent the site the literal text "nothing".
 *
 * The audit above reads `draftFor` for LITERALS, which is a different property.
 * `return formatValue(value)` puts the defect back with no literal anywhere, and until
 * now left all 161 tests green. These two assert the behaviour instead.
 */
test('§1.1 the editor seeds its box with a value, never with a description of one', () => {
  // Not `assert.equal(draftFor(null), '')` — that passes just as happily with the word
  // hardcoded, and it also passes if someone changes strings.js. The property is the
  // COUPLING: no word MockLab authored may ever end up in the box, whatever that word
  // is today. Sentinelled so the test cannot be satisfied by matching a fixed string.
  const original = { ...S.glyph };
  try {
    S.glyph.nullValue = SENTINEL;
    S.glyph.collapsedObject = SENTINEL;
    S.glyph.list = (n) => `${SENTINEL}${n}`;

    for (const [label, value] of [
      ['a field the site sent with no value in it', null],
      ['a field with no value slot at all', undefined],
      ['a container', { a: 1 }],
      ['a list', [1, 2]]
    ]) {
      const seed = draftFor(value);
      assert.equal(
        String(seed).includes(SENTINEL),
        false,
        `the editor opened on ${label} starts with “${seed}” — MockLab's own description of ` +
          'the value, which Apply would then send to the site as if a human had typed it (§1.1)'
      );
      assert.equal(seed, '', `${label} has no text of its own, so the box starts empty`);
    }
  } finally {
    Object.assign(S.glyph, original);
  }
});

test('§10.1D a value that HAS text of its own is seeded with exactly that text', () => {
  // The other half. Without this, `draftFor = () => ''` passes the test above and
  // silently empties the box for every ordinary edit — the box is meant to open on what
  // is really there, so the person can change one character of it.
  for (const value of ['ON_TIME', '', 'nothing', 0, 450, -1.5, true, false]) {
    assert.equal(draftFor(value), String(value), `editing ${JSON.stringify(value)} starts from its own text`);
  }
  // The collision the previous test cannot see: a REAL text that happens to read like
  // MockLab's description of an absent value must still come back verbatim.
  assert.equal(draftFor(S.glyph.nullValue), S.glyph.nullValue);
});

/* ───────────────────────────────────────── the next one, wherever it is written */

test('§17.6 nothing in the panel puts a literal on screen', () => {
  // Every word the panel renders leaves through one of these four doors: `el(…, {text})`
  // for a text node, an accessible name / placeholder / title given as an option, the
  // same three assigned to a node, and `setAttribute`. A quoted word at any of them is
  // copy that never passed through §11 — which is how the `'null'` above got out.
  const QUOTED = String.raw`(['"\`])((?:[^'"\`\\]|\\.)*)\1`;
  const NAMED = '(?:aria-label|placeholder|title)';
  const SINKS = [
    [new RegExp(String.raw`\btext:\s*${QUOTED}`, 'g'), 2],
    [new RegExp(String.raw`(['"])${NAMED}\1\s*:\s*(['"\`])((?:[^'"\`\\]|\\.)*)\2`, 'g'), 3],
    [new RegExp(String.raw`\.(?:textContent|innerText|placeholder|title|ariaLabel)\s*=\s*${QUOTED}`, 'g'), 2],
    [new RegExp(String.raw`setAttribute\(\s*(['"])${NAMED}\1\s*,\s*(['"\`])((?:[^'"\`\\]|\\.)*)\2`, 'g'), 3]
  ];

  const offenders = [];
  for (const file of fs.readdirSync(PANEL).filter((name) => name.endsWith('.js') && name !== 'strings.js')) {
    const code = stripComments(read(file));
    for (const [sink, group] of SINKS) {
      for (const match of code.matchAll(sink)) {
        // An empty literal renders nothing and says nothing, so it is not copy.
        if (match[group] !== '') offenders.push(`${file}: ${match[0].trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'route these through strings.js (§17.6) so one file still translates MockLab');
});

test('§17.6 panel.html carries no copy either', () => {
  // The markup fills itself from strings.js through `data-s` attributes. A word typed
  // straight into it would be invisible to §11 and to a translator both. The document
  // title is the product's own name, which is not copy and is not translated.
  const html = read('panel.html')
    .replace(/<title>[\s\S]*?<\/title>/g, '')
    .replace(/<script[\s\S]*?<\/script>/g, '');
  const copy = [...html.matchAll(/>([^<>]*[A-Za-z][^<>]*)</g)].map((match) => match[1].trim()).filter(Boolean);
  assert.deepEqual(copy, [], 'put it in strings.js and render it with data-s');
});

test("§11's closing rules: the default UI speaks no technical vocabulary", () => {
  // "never use: JSON, API, endpoint, payload, regex, DOM, probe, binding, signature
  // (those words may ONLY appear when Advanced mode is on)" — §11, and §1.2 for why.
  const BANNED = /\b(json|api|endpoint|payload|regex|dom|probe|binding|signature)s?\b/i;
  const offenders = [];
  const walk = (node, trail) => {
    for (const [key, value] of Object.entries(node)) {
      const where = trail ? `${trail}.${key}` : key;
      if (where === 'advanced') continue; // §1.2's one sanctioned place for these words
      if (typeof value === 'object' && value !== null) walk(value, where);
      // Sample the interpolating ones: their fixed words are what this audit is about.
      const text = typeof value === 'function' ? tryCall(value) : typeof value === 'string' ? value : '';
      const hit = BANNED.exec(text);
      if (hit) offenders.push(`S.${where}: “${hit[0]}”`);
    }
  };
  const tryCall = (fn) => {
    for (const args of [[1, 1], ['x', 'y']]) {
      try {
        const out = fn(...args);
        if (typeof out === 'string') return out;
      } catch {
        /* a shape this audit cannot call says nothing either way */
      }
    }
    return '';
  };
  walk(S, '');
  assert.deepEqual(offenders, [], 'a non-technical user has no meaning for these (§1.2)');
});
