/**
 * PLAN.md §17.6 — "Every user-visible string comes from `strings.js`" — audited from
 * source, everywhere the panel's own audit cannot reach.
 *
 * OWNER: interceptor-engineer. Split out of `guards.test.js` before M4, with the
 * ISOLATED-world contract audit and the §17.10 line-count audit (README Deviation 43).
 *
 * The division of labour with `panel.strings.test.js` (OWNER: panel-designer): that file
 * audits the panel from the inside — it calls the render helpers, swaps `strings.js` for
 * a sentinel, and reads the functions that format values. This one audits from the
 * outside, over whole files, and its scope is everything the panel's audit is not
 * looking at.
 *
 * Scope: shipping source in BOTH workspaces. `test/` is excluded on purpose — a fixture
 * quoting a copy string is a fixture, not copy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { SRC, SOURCE_FILES, read, rel, stripComments } from '../testlib/audit.js';

/**
 * Every string literal in comment-free `code`, contents only — in ALL THREE quotes. QA
 * put `` return `Data`; `` back into signatures.js and every audit in this file stayed
 * green: this half was quote-only, and a backtick is one keystroke away. (The §17.4
 * pair in `guards.test.js` always read all three.) The template pattern matches only a
 * template with no `${…}` in it — the kind that IS a whole literal; one that
 * interpolates is concatenation, which is the boundary stated below.
 *
 * @param {string} code comment-free source
 * @returns {string[]} literal contents, in source order per pattern
 */
function stringLiterals(code) {
  const PATTERNS = [/(['"])((?:[^'"\\\n]|\\.)*)\1/g, /`((?:[^`\\$]|\\.|\$(?!\{))*)`/g];
  return PATTERNS.flatMap((pattern) =>
    [...code.matchAll(pattern)].map((match) => (match[2] === undefined ? match[1] : match[2]))
  );
}

/**
 * §17.6 — "every user-visible string comes from strings.js" — audited where it is
 * easiest to forget: OUTSIDE the panel. `signatures.friendlyName()` returns a source
 * name a human reads as a card heading (§10.2) and an agent reads as
 * `ChangeSummary.sourceName` (§12.4 #2); it shipped M2 with 'Data' written into it five
 * times, green all the way, because a duplicated string is only wrong on the day
 * somebody translates it.
 *
 * So: no shipping file outside `src/panel/` may contain a string literal that is also a
 * value in `strings.js`. Import the key instead — the worker may (see signatures.js).
 *
 * KNOWN BOUNDARY, stated rather than pretended away — it compares WHOLE literals, so:
 *   • copy assembled from parts is out of reach: `'Da' + 'ta'`, `` `${a} Data` ``, or a
 *     word built at run time. `signatures.test.js` 28d covers those behaviourally.
 *   • copy that never reached strings.js is invisible: strings.js IS the list compared
 *     against. Outside the panel, a newly invented word is still uncaught.
 *   • the patterns pair quotes independently: a lone backtick in a quoted string could
 *     pair with a later one. That fails toward flagging, never toward silence.
 */
test('§17.6 no file outside the panel keeps its own copy of a user-visible string', async () => {
  const { S } = await import('../src/panel/strings.js');
  /** Every literal string in the copy table, flattened. Functions are formatters. */
  const copy = new Set();
  (function walk(node) {
    for (const value of Object.values(node)) {
      if (typeof value === 'string') copy.add(value);
      else if (value && typeof value === 'object') walk(value);
    }
  })(S);

  const PANEL = path.join(SRC, 'panel');
  const offenders = [];
  for (const file of SOURCE_FILES) {
    if (file.startsWith(PANEL + path.sep)) continue;
    // An empty literal renders nothing and says nothing, so it is never copy.
    for (const literal of stringLiterals(stripComments(read(file)))) {
      if (literal && copy.has(literal)) offenders.push(`${rel(file)}: ${JSON.stringify(literal)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'import the key from panel/strings.js instead — §17.6 means translating MockLab is ' +
      'translating one file'
  );
});

test('§17.6 the audit itself reads all three quotes, which is how the gap got in', () => {
  // `stringLiterals` was quote-only, so `` return `Data`; `` in signatures.js passed
  // every audit here. Deleting the second pattern must fail now, not silently later.
  const source = String.raw`const a = 'Data'; const b = "Data"; const c = ` + '`Data`;';
  assert.equal(stringLiterals(source).filter((literal) => literal === 'Data').length, 3);
});
