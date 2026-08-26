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
 * outside, over whole files: everything the panel's audit is not looking at, plus — at
 * the fifth and sixth doors below — the sinks it looks at but cannot see all of.
 *
 * Scope: shipping source in BOTH workspaces. `test/` is excluded on purpose — a fixture
 * quoting a copy string is a fixture, not copy. The audits below that DO read the panel
 * say why where they stand.
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
 * KNOWN BOUNDARY, stated rather than pretended away: an argument counts when a VALUE
 * POSITION inside it holds a literal — the whole argument, an arm of the expression it
 * is (`copyIn`, below), or an element of an array literal, which is how `withTip`
 * receives its two lines. That is what keeps `el('p', { class: 'help' }, child)` from
 * reporting its own class name. What is out of reach is stated with `copyIn`, since both
 * doors now share it.
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
 * The one scanner every audit below reads source with. It walks `code` from `start`
 * tracking quotes, templates and brackets, and returns the first index where
 * `ends(character, index)` is true AT DEPTH 0 — or -1 when nothing ends it.
 *
 * One scanner rather than four: every audit here has to know that a bracket inside a
 * string is not a bracket, and four copies of that rule is four chances for one of them
 * to be subtly different from the others.
 */
function boundary(code, start, ends) {
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = start; index < code.length; index += 1) {
    const character = code[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (depth === 0 && ends(character, index)) return index;
    if (character === '"' || character === "'" || character === '`') quote = character;
    else if ('([{'.includes(character)) depth += 1;
    else if (')]}'.includes(character)) depth -= 1;
  }
  return -1;
}

/** Every closer, which is what ends a call, an array literal or an object literal. */
const CLOSER = (character) => ')]}'.includes(character);

/**
 * The source text inside the parentheses opening at `open`, or null when they never
 * close — an unterminated call is skipped rather than guessed at, which loses a call site
 * instead of inventing one.
 */
function insideParens(code, open) {
  const close = boundary(code, open + 1, CLOSER);
  return close === -1 ? null : code.slice(open + 1, close);
}

/**
 * `text` split at the commas that are not inside a bracket, a quote or a template — the
 * arguments of a call, or the elements of an array literal.
 */
function splitList(text) {
  const parts = [];
  for (let start = 0; ; ) {
    const comma = boundary(text, start, (character) => character === ',');
    parts.push(text.slice(start, comma === -1 ? text.length : comma).trim());
    if (comma === -1) break;
    start = comma + 1;
  }
  return parts.length === 1 && parts[0] === '' ? [] : parts;
}

/* ───── the sixth door: a literal INSIDE the expression, not adjacent to the sink ─────
 *
 * Every sink above, and every sink `panel.strings.test.js` watches, is found by reading
 * the token that IMMEDIATELY follows it — `\btext:\s*(['"`])…`. That regex sees
 *
 *     el('span', { class: 'sitebar__host truncate', text: 'No page selected yet' })
 *
 * and it does not see
 *
 *     el('span', { class: 'sitebar__host truncate', text: state.hostname || 'No page selected yet' })
 *
 * which renders the same word to the same reader. QA proved it as a live mutation on the
 * no-active-tab branch of `panel/panel.js`: with that line in the tree, this file and
 * `panel.strings.test.js` together ran 16 tests, 16 pass, 0 fail. A `||`, either arm of a
 * ternary, a `+` concatenation and a template's static text are all copy, and all of them
 * sit one token further out than those regexes reach. There is no breach in the tree
 * today — the conditionals at a sink have an `S.*` in both arms. This is a vaccine,
 * written before M5 and M6 pour new copy into the panel.
 *
 * `copyIn()` therefore classifies the whole EXPRESSION at a sink rather than the token
 * after it: it splits at the operators that let a value through to the screen — `||`,
 * `&&`, `??`, both arms of `?:`, `+` — and reports any operand that is a literal, the
 * static text of any template, and anything quoted inside a template's `${…}`. Both doors
 * use it: the three argument positions above, and the four property positions below.
 *
 * WHY THE PROPERTY DOORS ARE AUDITED HERE, in another owner's territory: the rule is the
 * same rule, `panel.strings.test.js` belongs to panel-designer, and it is that file's own
 * comment — "A quoted word at any of them is copy that never passed through §11" — that
 * this closes. A quoted word behind a `||` is copy too, and nothing there can see it. The
 * overlap is deliberate: a literal adjacent to a sink is now reported twice, which is the
 * cheap direction to be wrong in.
 *
 * KNOWN BOUNDARY, stated rather than pretended away:
 *   • an operand counts only when the WHOLE of it is a literal or a template. Copy that
 *     arrives through a CALL — `t('Some words')` — is out of reach, and deliberately: a
 *     call's arguments are values, not copy, or the panel's own formatters
 *     (`S.probe.reloads(i, n)`, `S.glyph.quote(text)`) would be reported at every sink.
 *   • a word held in a variable — `const gone = 'No page'; … text: host || gone` — is
 *     invisible here; nothing in this file follows data. `panel.strings.test.js` swaps
 *     `strings.js` for a sentinel and reads what the panel RENDERS; that is the audit
 *     that can see it, and it is why both exist.
 *   • inside a template, only static text containing a LETTER counts. Punctuation glue —
 *     `` `${a}: ${b}` `` — is out of reach: the panel routes those through `S.glyph.join*`,
 *     and a bare `text: ' · '` is still caught as a whole operand.
 *   • an expression ends at the first `;`, top-level `,` or unmatched closer. An
 *     assignment written without a semicolon runs on into the statement after it, which
 *     can only make the audit read MORE text, never less.
 *   • `text:` and `title:` are read as sinks wherever they are object keys, so a data
 *     field of either name is audited as if it were rendered. That fails toward flagging.
 * ══════════════════════════════════════════════════════════════════════════════════ */

/** The operators that pass one of their operands through to the screen unchanged. */
const VALUE_OPERATOR = /^(?:\|\||&&|\?\?|\+|\?(?!\.)|:)/;

/**
 * `expression` split at the top-level operators above, outside quotes and brackets — so
 * the `||` in `S.probe.reloads(i, n || i)` stays inside the call it belongs to, and `?.`
 * is not mistaken for a ternary.
 */
function operands(expression) {
  const parts = [];
  for (let start = 0; ; ) {
    const at = boundary(expression, start, (character, index) => VALUE_OPERATOR.test(expression.slice(index)));
    parts.push(expression.slice(start, at === -1 ? expression.length : at).trim());
    if (at === -1) break;
    start = at + VALUE_OPERATOR.exec(expression.slice(at))[0].length;
  }
  return parts.filter(Boolean);
}

/** A template split into its static `chunks` and the expressions in its `holes`. */
function templateParts(template) {
  const body = template.slice(1, -1);
  const chunks = [];
  const holes = [];
  let current = '';
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === '\\') {
      current += body.slice(index, index + 2);
      index += 1;
      continue;
    }
    if (body[index] === '$' && body[index + 1] === '{') {
      const hole = insideParens(body, index + 1);
      // An unterminated hole means the template was mis-sliced; stop rather than guess.
      if (hole === null) break;
      chunks.push(current);
      current = '';
      holes.push(hole);
      index += hole.length + 1;
      continue;
    }
    current += body[index];
  }
  chunks.push(current);
  return { chunks, holes };
}

/**
 * Every piece of `expression` that puts a word on screen: each operand that is a whole
 * literal, each template whose static text has a letter in it, whatever is quoted inside
 * that template's holes, and — for an array literal, which is how `withTip` receives its
 * two lines — the same applied to each element. A nested `el(…)` child holds no copy
 * attributable to THIS call site; it is audited at its own, which is why nothing here
 * recurses into a call.
 */
function copyIn(expression) {
  const trimmed = expression.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return splitList(trimmed.slice(1, -1)).flatMap(copyIn);
  }
  const found = [];
  for (const operand of operands(trimmed)) {
    // An empty literal renders nothing and says nothing, so it is never copy.
    if (WHOLE_LITERAL.test(operand)) {
      if (stringLiterals(operand)[0]) found.push(operand);
    } else if (operand.length > 1 && operand.startsWith('`') && operand.endsWith('`')) {
      const { chunks, holes } = templateParts(operand);
      if (chunks.some((chunk) => /\p{L}/u.test(chunk))) found.push(operand);
      found.push(...holes.flatMap(copyIn));
    }
  }
  return found;
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
        for (const piece of copyIn(args[index])) found.push(`${line}: ${what} — ${piece}`);
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

/**
 * The four property positions a word reaches a reader through, named the way
 * `panel.strings.test.js` names them — an option `el()` renders (`text`, and an
 * accessible name / placeholder / title), the same three assigned to a node, and
 * `setAttribute`. Here they are openers, not whole matches: what follows each one is an
 * EXPRESSION, read by `expressionAt` and classified by `copyIn`.
 *
 * The option key must sit where an object key can — after `{` or `,` — so the `text` in
 * `flag ? text : other` is not read as one, and `-` in the lookbehind keeps
 * `data-s-placeholder` out.
 */
const NAMED = '(?:aria-label|ariaLabel|placeholder|title)';
const PROPERTY_SINKS = [
  { what: 'an option that renders words', opener: new RegExp(String.raw`(?<=[{,]\s*)(['"]?)(?:text|${NAMED})\1\s*:`, 'g') },
  { what: 'a property assigned to a node', opener: /\.\s*(?:textContent|innerText|placeholder|title|ariaLabel)\s*=(?![=>])/g },
  { what: 'an attribute set on a node', opener: new RegExp(String.raw`setAttribute\(\s*(['"])${NAMED}\1\s*,`, 'g') }
];

/**
 * The expression starting at `start`: up to the first `;`, the first comma at depth 0, or
 * the closer that ends the object or call it sits in.
 */
function expressionAt(code, start) {
  const end = boundary(code, start, (character) => CLOSER(character) || character === ',' || character === ';');
  return code.slice(start, end === -1 ? code.length : end);
}

/**
 * Every word `code` puts on screen from inside an expression at a property sink, as
 * `line: what — piece`. Source order per sink, the same way `argumentCopy` is ordered.
 *
 * @param {string} code comment-free source
 */
function expressionCopy(code) {
  const found = [];
  for (const { what, opener } of PROPERTY_SINKS) {
    for (const match of code.matchAll(opener)) {
      const line = code.slice(0, match.index).split('\n').length;
      for (const piece of copyIn(expressionAt(code, match.index + match[0].length))) {
        found.push(`${line}: ${what} — ${piece}`);
      }
    }
  }
  return found;
}

test('§17.6 no word reaches the panel from inside an expression at a copy sink', () => {
  const offenders = [];
  for (const file of jsFiles(path.join(SRC, 'panel'))) {
    if (path.basename(file) === 'strings.js') continue;
    for (const hit of expressionCopy(stripComments(read(file)))) offenders.push(`${rel(file)}:${hit}`);
  }
  assert.deepEqual(
    offenders,
    [],
    'route it through strings.js and pass the key (§17.6). A word behind a `||`, in an arm ' +
      'of a ternary, on either side of a `+`, or written into a template is rendered exactly ' +
      'like a word written against the sink — and the adjacent-literal regexes cannot see it.'
  );
});

test('§17.6 the expression audit fails on QA’s mutation and on each shape beside it', () => {
  // Without this, the test above is green because nothing is broken today and would stay
  // green if the classifier stopped working. Line 1 is QA's mutation, verbatim.
  const planted = [
    "el('span', { class: 'sitebar__host truncate', text: state.hostname || 'No page selected yet' });",
    "el('p', { class: 'help', text: ready ? S.probe.intro : 'Coming soon' });",
    "el('h3', { text: 'Source: ' + sourceName(ctx, id) });",
    "el('p', { text: S.editor.original(v) + ' (best guess)' });",
    'el(\'p\', { text: `${places} places on the page` });',
    "node.textContent = value ?? 'nothing';",
    "box.setAttribute('aria-label', on ? S.sources.changeOn : 'Change is off');",
    "el('span', { 'aria-label': `${stopping ? 'Stopping…' : S.probe.cancel}` });"
  ].join('\n');
  assert.deepEqual(expressionCopy(planted), [
    "1: an option that renders words — 'No page selected yet'",
    "2: an option that renders words — 'Coming soon'",
    "3: an option that renders words — 'Source: '",
    "4: an option that renders words — ' (best guess)'",
    '5: an option that renders words — `${places} places on the page`',
    "8: an option that renders words — 'Stopping…'",
    "6: a property assigned to a node — 'nothing'",
    "7: an attribute set on a node — 'Change is off'"
  ]);

  // The same operand rule at the three ARGUMENT doors, which share `copyIn`.
  assert.deepEqual(
    argumentCopy("el('div', {}, ready ? S.pick.cta : 'Pick an element');\nroot.append(name || 'Untitled');"),
    ["1: a child of el() — 'Pick an element'", "2: a child appended to a node — 'Untitled'"]
  );

  // And the shapes the real panel is written in, which must NOT be flagged: the two
  // conditionals that live at sinks today, a formatter's arguments, an `||` inside a
  // call, literals at an option that is NOT a sink, a bare assignment, and an attribute
  // whose value is not copy.
  const innocent = [
    "el('span', { class: 'sitebar__host truncate', text: state.hostname || S.site.noPage });",
    "el('p', { class: 'help', text: ready ? S.probe.intro : S.soon });",
    "el('span', { text: S.glyph.joinLabel(S.advanced.path, candidate.path) });",
    "el('span', { text: S.probe.reloads(Number(r.index), Number(r.estimate) || Number(r.index)) });",
    "el('label', { class: option.mono ? 'mono truncate' : 'truncate', for: id, text: option.label });",
    "el('input', { type: 'checkbox', 'aria-label': change.enabled ? S.sources.changeOn : S.sources.changeOff });",
    'node.textContent = value;',
    "svg.setAttribute('aria-hidden', 'true');"
  ].join('\n');
  assert.deepEqual(expressionCopy(innocent), []);
});
