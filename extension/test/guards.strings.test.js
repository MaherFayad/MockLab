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
 * quoting a copy string is a fixture, not copy. The one audit below that DOES read the
 * panel says why where it stands.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { SRC, SOURCE_FILES, jsFiles, read, rel, stripComments } from '../testlib/audit.js';

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

/* ────────── §17.6's fifth door: copy that arrives as an ARGUMENT, not a property ─────
 *
 * `panel.strings.test.js` (OWNER: panel-designer) enumerates four ways a word reaches a
 * reader from panel code: `el(…, {text})`, an accessible name / placeholder / title
 * given as a named option, those three assigned to a node, and `setAttribute`. All four
 * are named PROPERTIES, so a regex has a name to look for.
 *
 * There is a fifth, and it has no name. `el()` takes variadic children and hands each to
 * `node.append(child)` (`panel/dom.js`), and `append` accepts a raw string — so
 * `el('div', {}, 'Some words')` renders a text node that not one of those four regexes
 * can see. `node.append('Some words')` is the same door reached directly, and
 * `withTip(button, ['Some words'])` is the same door in the tooltip helper, whose lines
 * are copy by definition (§9.2).
 *
 * There is not one instance today: QA found the hole, not a breach. It is guarded here
 * rather than in `panel.strings.test.js` because that file belongs to another owner, and
 * the rule being enforced is the same rule. The two audits deliberately overlap in
 * scope — this one reads ARGUMENT POSITIONS, that one reads property names, and neither
 * can see the other's door.
 *
 * KNOWN BOUNDARY, stated rather than pretended away: an argument only counts when the
 * WHOLE of it is a literal, or when it is an array literal whose elements are. That is
 * what keeps `el('p', { class: 'help' }, child)` from reporting its own class name, and
 * it means copy assembled at the call site — `'Some ' + word`, a template that
 * interpolates, a word held in a variable — is out of reach here exactly as it is in the
 * whole-literal audit above. The panel's own suite covers the rendered result.
 * ══════════════════════════════════════════════════════════════════════════════════ */

/** A WHOLE string literal: a quoted string, or a template with no `${…}` in it. */
const WHOLE_LITERAL = /^(?:(['"])(?:[^'"\\\n]|\\.)*\1|`(?:[^`\\$]|\\.|\$(?!\{))*`)$/;

/**
 * Argument positions that put their contents on screen, keyed by how the call opens.
 * `to` is exclusive: `withTip`'s third argument is placement options, not copy.
 */
const ARGUMENT_SINKS = [
  { what: 'a child of el()', opener: /(?<![\w$.])el\s*\(/g, from: 2, to: Infinity },
  {
    what: 'a child appended to a node',
    opener: /\.\s*(?:append|prepend|replaceChildren)\s*\(/g,
    from: 0,
    to: Infinity
  },
  { what: 'a line of withTip()', opener: /(?<![\w$.])withTip\s*\(/g, from: 1, to: 2 }
];

/**
 * The source text inside the parentheses opening at `open`, or null when they never
 * close. Quotes and templates are tracked, so a bracket inside a string is not counted —
 * an unterminated call is skipped rather than guessed at, which loses a call site
 * instead of inventing one.
 */
function insideParens(code, open) {
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < code.length; index += 1) {
    const character = code[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') quote = character;
    else if ('([{'.includes(character)) depth += 1;
    else if (')]}'.includes(character)) {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, index);
    }
  }
  return null;
}

/**
 * `text` split at the commas that are not inside a bracket, a quote or a template — the
 * arguments of a call, or the elements of an array literal.
 */
function splitList(text) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let escaped = false;
  let current = '';
  for (const character of text) {
    if (quote) {
      current += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') quote = character;
    else if ('([{'.includes(character)) depth += 1;
    else if (')]}'.includes(character)) depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  const trimmed = parts.map((part) => part.trim());
  return trimmed.length === 1 && trimmed[0] === '' ? [] : trimmed;
}

/**
 * The copy an argument holds DIRECTLY: itself when the whole argument is a literal, and
 * its literal elements when it is an array literal — which is how `withTip` receives its
 * two lines. A nested `el(…)` child holds no copy attributable to THIS call site; it is
 * audited at its own, which is why nothing here recurses.
 */
function literalCopy(argument) {
  if (WHOLE_LITERAL.test(argument)) return [argument];
  if (argument.startsWith('[') && argument.endsWith(']')) {
    return splitList(argument.slice(1, -1)).filter((item) => WHOLE_LITERAL.test(item));
  }
  return [];
}

/**
 * Every word `code` puts on screen through an argument, as `line: what — literal`.
 * Source order per sink, the same way `stringLiterals` is ordered per pattern.
 *
 * @param {string} code comment-free source
 */
function argumentCopy(code) {
  const found = [];
  for (const { what, opener, from, to } of ARGUMENT_SINKS) {
    for (const match of code.matchAll(opener)) {
      const inner = insideParens(code, match.index + match[0].length - 1);
      if (inner === null) continue;
      const args = splitList(inner);
      const line = code.slice(0, match.index).split('\n').length;
      for (let index = from; index < Math.min(args.length, to); index += 1) {
        for (const literal of literalCopy(args[index])) {
          // An empty literal renders nothing and says nothing, so it is not copy.
          if (stringLiterals(literal)[0]) found.push(`${line}: ${what} — ${literal}`);
        }
      }
    }
  }
  return found;
}

test('§17.6 no word reaches the panel as a bare argument, which no sink regex sees', () => {
  const offenders = [];
  for (const file of jsFiles(path.join(SRC, 'panel'))) {
    if (path.basename(file) === 'strings.js') continue;
    for (const hit of argumentCopy(stripComments(read(file)))) offenders.push(`${rel(file)}:${hit}`);
  }
  assert.deepEqual(
    offenders,
    [],
    'route it through strings.js and pass the key (§17.6). A string handed to `el()` as a ' +
      'child, to `append`, or to `withTip` as a line is rendered exactly like copy and is ' +
      'invisible to the four property sinks `panel.strings.test.js` watches.'
  );
});

test('§17.6 the argument audit sees the door, and leaves the panel\'s real calls alone', () => {
  // Without this, the test above is green because the door is shut today and would stay
  // green if the detector stopped working. Each shape below is one QA raised.
  const planted = [
    "const a = el('div', {}, 'Some words');",
    "root.append('Some words');",
    "withTip(button, ['Some words']);",
    'grid.replaceChildren(`Some words`);'
  ].join('\n');
  assert.deepEqual(argumentCopy(planted), [
    "1: a child of el() — 'Some words'",
    "2: a child appended to a node — 'Some words'",
    '4: a child appended to a node — `Some words`',
    "3: a line of withTip() — 'Some words'"
  ]);

  // And the shapes the real panel is written in, which must NOT be flagged: a tag name,
  // a class name, an option key, a nested element, a conditional child, an empty
  // literal, and a tooltip whose lines come from strings.js.
  const innocent = [
    "el('p', { class: 'help', text: S.pick.body });",
    "root.append(el('h2', { text: S.pick.title }), el('span', { class: 'truncate' }));",
    "el('div', { class: 'row' }, ready && el('b', {}, node), '');",
    'withTip(control, [S.tab.pick, S.tab.sources], { up: true });'
  ].join('\n');
  assert.deepEqual(argumentCopy(innocent), []);
});
