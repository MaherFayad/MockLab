/**
 * Source audits for the rules that cannot be tested by running the code (PLAN.md §17).
 *
 * OWNER: interceptor-engineer.
 *
 * §17.4 in particular is a *grep* rule the plan asks the implementer to run on itself:
 * "the string `state: \"verified\"` may appear in exactly one assignment in the codebase
 * (probe.js)". A rule only a human remembers to check breaks the first time nobody
 * checks, so it is checked here, on every `npm test`.
 *
 * THREE SIBLINGS, split out of this file before M4 (README Deviation 43), each taking
 * its regexes and the boundary notes that qualify them in one piece:
 *   `guards.contract.test.js`  §17.2 / §17.8 — the ISOLATED-world contract
 *   `guards.strings.test.js`   §17.6 — copy kept outside `strings.js`
 *   `guards.lines.test.js`     §17.10 — the line budget and README's record of it
 * What stays here is §17.4 (the verified state, which is what M4 is about to write for
 * the first time), the two one-line MV3 rules — §17.1 and §17.2's ban on imports and
 * hashes in the MAIN world — and, added after M4, §17.7's design tokens, which until
 * then was the one auditable §17 rule with no guard at all. Shared file lists and
 * `stripComments` live in `testlib/audit.js`, which the §17.10 audit counts like any
 * other file.
 *
 * Scope, deliberately different per rule:
 *   §17.1 / §17.2  extension source only — they are about MV3 and the MAIN world.
 *   §17.4          shipping source in BOTH workspaces. `test/` is excluded on purpose:
 *                  `changes.test.js` plants a verified Binding to prove the M2 engine
 *                  never downgrades one — the opposite of a violation.
 *   §17.7          the extension's `src/` in EVERY format, `.css` and `.html` included.
 *                  Not the companion's demo, not `test/` — see the note above the rule.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, SRC, FILES, SOURCE_FILES, sourceFiles, read, rel, stripComments } from '../testlib/audit.js';

/** §17.4's single exception: the probe's CONFIRMED state, and nowhere else. */
const PROBE_JS = 'extension/src/background/probe.js';

/**
 * Every place a Binding's `state` PROPERTY is written, with the right-hand side.
 *
 * Four shapes: `state: <rhs>` and `"state": <rhs>` in an object literal,
 * `something.state = <rhs>`, and `something['state'] = <rhs>`. The quoted KEY form was
 * added after QA got `export const evil = { "state": "verified" };` past all three
 * guards — a quoted key is the same assignment with two more characters, and JSON-ish
 * object literals write it every day. A bare `state = …` is deliberately NOT matched:
 * three files here keep ordinary local variables called `state`, and flagging those
 * would drown the audit. The lookbehind also keeps
 * `linkState:` and the ternary `binding.state : null` out, and `=(?![=>])` keeps the
 * COMPARISON `binding.state === 'verified'` out — reading the state is legitimate
 * everywhere, and a guard that fails on a chip render is a guard someone deletes.
 *
 * @param {string} text
 * @returns {{kind:'literal'|'indirect', value?:string, rhs?:string}[]}
 */
function stateAssignments(text) {
  const PATTERNS = [
    /(?<![.\w$])(?:state|['"`]state['"`])\s*:\s*(?<rhs>[^,;}\n]+)/g,
    /\.state\s*=(?![=>])\s*(?<rhs>[^;\n]+)/g,
    /\[\s*['"`]state['"`]\s*\]\s*=(?![=>])\s*(?<rhs>[^;\n]+)/g
  ];
  const code = stripComments(text);
  const found = [];
  for (const pattern of PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const rhs = match.groups.rhs.trim();
      const literal = /^(['"`])((?:[^'"`\\]|\\.)*)\1/.exec(rhs);
      found.push(literal ? { kind: 'literal', value: literal[2] } : { kind: 'indirect', rhs });
    }
  }
  return found;
}

/* ─────────────────────────── the other half of §17.4 ──────────────────────────────
 *
 * `stateAssignments` reads the KEY. A dodge that hides the key from it —
 * `const K = 'state'; binding[K] = 'verified';` — still has to write the literal word
 * `verified` somewhere, so the value side is audited separately and independently.
 *
 * Outside probe.js the literal `'verified'` may only be READ: compared, switched on, or
 * looked up in a list. Producing one — assigning it, returning it, passing it as an
 * object value — is the thing §17.4 forbids, and it is forbidden whatever the key looks
 * like.
 *
 * KNOWN BOUNDARY, stated rather than pretended away: this is a regex over source text,
 * so a value assembled at run time is out of its reach — `'veri' + 'fied'`,
 * `String.fromCharCode(...)`, a state read back out of `chrome.storage`. No static check
 * can close that, and a guard that claimed to would be the lie §17.12 is about. Those
 * paths are covered behaviourally: `changes.test.js` "6 …" proves the M2 engine never
 * upgrades a link it did not prove, and `panel.browser.test.js` subtest 4 proves the
 * chip a human sees says "Possible" for an unprobed Change in real Chromium.
 * ═══════════════════════════════════════════════════════════════════════════════════ */

/** An equality comparison with the literal on the right, or a `switch` case. */
const COMPARISON = /(?:===|!==|==|!=|\bcase)\s*$/;
/** The same comparison written the other way round: `'verified' === binding.state`. */
const COMPARISON_YODA = /^\s*(?:===|!==|==|!=)/;
/** A membership test against a list of states. */
const MEMBERSHIP = /\.(?:includes|has|indexOf)\s*\(\s*$/;
/** An element position, which only counts as a READ inside an array literal. */
const LIST_ELEMENT = /[[,]\s*$/;

/**
 * The innermost bracket still open at `index`, or '' at top level. Brackets inside
 * string and regex literals are counted too — a known imprecision, and a cheap one:
 * it can only mis-CLASSIFY a `'verified'` literal that is already rare enough to read
 * by eye, and the argument-position rule below fails closed, not open.
 */
function enclosingOpener(before) {
  const stack = [];
  for (const character of before) {
    if ('([{'.includes(character)) stack.push(character);
    else if (')]}'.includes(character)) stack.pop();
  }
  return stack.length ? stack[stack.length - 1] : '';
}

/**
 * Every place the literal `'verified'` is PRODUCED rather than read, with the line and
 * a little context so a failure names the line instead of the file.
 *
 * A comma before it is only a read inside `[…]` — `['verified', 'stale']` is a list of
 * states, while `applyState(binding, 'verified')` is a write with the property name
 * hidden one call away, which is the same dodge as `binding[K] = 'verified'`.
 *
 * @param {string} text
 * @returns {string[]}
 */
function verifiedLiterals(text) {
  const code = stripComments(text);
  const found = [];
  for (const match of code.matchAll(/(['"`])verified\1/g)) {
    const before = code.slice(0, match.index);
    const tail = before.slice(-60);
    const read =
      COMPARISON.test(tail) ||
      COMPARISON_YODA.test(code.slice(match.index + match[0].length, match.index + match[0].length + 8)) ||
      MEMBERSHIP.test(tail) ||
      (LIST_ELEMENT.test(tail) && enclosingOpener(before) === '[');
    if (read) continue;
    const line = before.split('\n').length;
    found.push(`${line}: ${(tail.split('\n').pop() + match[0]).trim()}`);
  }
  return found;
}

/**
 * PLAN.md §17.4, the rule the plan asks the implementer to grep for on itself. Comments
 * are stripped first: JSDoc unions (`"verified"|"candidate"`), §11's "Verified ✓" chip
 * copy and prose like this paragraph all claim nothing, and only an assignment can lie.
 *
 * `test/` is NOT audited on purpose — `changes.test.js` plants a verified Binding to
 * prove the M2 engine never downgrades one, which is the opposite of a violation.
 */
test('§17.4 nothing outside probe.js may put a link into the verified state', () => {
  /** @type {{file:string, count:number}[]} */
  const offenders = [];
  for (const file of SOURCE_FILES) {
    const verified = stateAssignments(read(file)).filter((a) => a.kind === 'literal' && a.value === 'verified');
    if (verified.length) offenders.push({ file: rel(file), count: verified.length });
  }

  assert.deepEqual(
    offenders.filter((entry) => entry.file !== PROBE_JS).map((entry) => `${entry.file} (${entry.count})`),
    [],
    'a wrong "Verified ✓" is the worst bug this product can have (§17.12) — only the ' +
      'probe CONFIRMED state may assign it'
  );

  // §17.4 says the string may appear in exactly ONE assignment, not in one file. An
  // earlier version of this guard counted files, so a probe.js with three of them read
  // as compliant — the M4 state machine is the one place that mistake would matter.
  // Zero is allowed too: probe.js is still a stub until M4.
  const inProbe = offenders.find((entry) => entry.file === PROBE_JS);
  assert.ok(
    !inProbe || inProbe.count === 1,
    `${PROBE_JS} assigns the verified state ${inProbe && inProbe.count} times; §17.4 allows exactly one`
  );
});

/**
 * The literal check above can only see what it can read. `binding.state = NEXT_STATE`
 * would sail past it, and probe.js at M4 — a state machine, full of named states — is
 * exactly where writing one indirectly first becomes tempting.
 *
 * So outside probe.js a link state must be written as a LITERAL. That is not a style
 * preference: it is what makes §17.4 auditable at all. Anything else has to move into
 * probe.js, where it is one reviewed assignment instead of an invisible one.
 */
test('§17.4 a link state is never written indirectly, where no grep could catch it', () => {
  const indirect = [];
  for (const file of SOURCE_FILES) {
    if (rel(file) === PROBE_JS) continue;
    for (const assignment of stateAssignments(read(file))) {
      if (assignment.kind === 'indirect') indirect.push(`${rel(file)}: state = ${assignment.rhs}`);
    }
  }
  assert.deepEqual(
    indirect,
    [],
    'write the state as a literal so §17.4 can be audited, or move the assignment into probe.js'
  );
});

/**
 * The key-side guards above can be dodged by hiding the KEY:
 * `const K = 'state'; binding[K] = 'verified';` names no property the regexes can see.
 * This one watches the VALUE instead, so both halves of the sentence are audited and a
 * dodge has to defeat two independent checks that do not share a pattern.
 *
 * Outside probe.js the word may be read (compare it, switch on it, look it up in a list
 * of states) but never produced. The exact list of read contexts is the four constants
 * above — `COMPARISON`, `COMPARISON_YODA`, `MEMBERSHIP` and `LIST_ELEMENT` — and the
 * KNOWN BOUNDARY note beside them states the one class of dodge no regex can reach.
 */
test('§17.4 outside probe.js the verified state may be read, never written', () => {
  const offenders = [];
  for (const file of SOURCE_FILES) {
    if (rel(file) === PROBE_JS) continue;
    for (const hit of verifiedLiterals(read(file))) offenders.push(`${rel(file)}:${hit}`);
  }
  assert.deepEqual(
    offenders,
    [],
    'only the probe CONFIRMED state may produce a verified link (§17.4, §17.12). Compare ' +
      'against the state here, or move the assignment into probe.js'
  );
});

test('§17.4 the M2 Changes engine writes candidate links and nothing else', () => {
  const engine = ['background/ruleStore.js', 'background/changesApi.js'].map((relative) =>
    read(path.join(SRC, relative))
  );
  const written = new Set();
  for (const text of engine) {
    for (const assignment of stateAssignments(text)) {
      written.add(assignment.kind === 'literal' ? assignment.value : `<indirect: ${assignment.rhs}>`);
    }
  }
  assert.deepEqual([...written], ['candidate'], 'the only link state this half may write');
});

test('§17.2 interceptor.js has no imports and never hashes', () => {
  const text = fs.readFileSync(path.join(SRC, 'content/interceptor.js'), 'utf8');
  assert.doesNotMatch(text, /^\s*import\s/m, 'a MAIN-world script cannot import');
  assert.doesNotMatch(text, /\brequire\s*\(/, 'nor require');
  // §17.3: sigIds come only from signatures.js.
  assert.doesNotMatch(text, /crypto\.subtle|sha256|SHA-256/i, 'the MAIN world computes no hashes');
});

test('§17.1 no response body is ever modified through webRequest or DNR', () => {
  const forbidden = /declarativeNetRequest|chrome\.webRequest/;
  for (const file of FILES) {
    assert.doesNotMatch(read(file), forbidden, `${rel(file)} — MV3 cannot`);
  }
});

/* ══════════════════════ §17.7 — the design tokens, and the five hex literals ═══════
 *
 * "Use the design tokens; never hardcode a color hex outside `panel.css` `:root`
 * blocks." Every other rule in §17 that can be audited from source is audited; this one
 * was not, and it is the rule whose violations are cheapest to add and hardest to see —
 * one `#0066FF` in a component recipe looks right on screen and silently forks the
 * accent colour, so the day §9.1's token changes, one control does not follow.
 *
 * It holds today: `panel.css` carries every colour inside a `:root` block, and the only
 * hex outside one is the five literals in `content/picker.js` and `background/badge.js`,
 * both recorded (README Deviations 21 and 35) and both structurally unavoidable — a
 * content script cannot reach the panel's stylesheet, and Chrome's badge API takes a
 * literal, not a CSS variable. Nothing stopped a sixth.
 *
 * ── Why a brace-range parse and not a line grep ────────────────────────────────────
 * `panel.css` has FOUR `:root` blocks: §9.1's light token block, its
 * `@media (prefers-color-scheme: dark)` twin, and the additive extension-token pair
 * below them (Deviations 50 and 51). Their values sit on their own lines, so "the hex
 * and `:root` on one line" permits none of them. The other line-based reading — "any
 * line after a `:root` line" — permits everything from the last token block to the end
 * of the file, which is every component recipe in §9.2 and precisely where a stray hex
 * would go. Neither is a boundary; the block is. So the file is parsed: a hex is
 * permitted exactly when the INNERMOST unclosed brace at its position was opened by a
 * `:root` selector. That reads the dark blocks correctly for free, because only the
 * innermost selector is consulted and `@media` is simply the block around it.
 *
 * The parse is checked rather than trusted: braces must balance, and the ranges it finds
 * must contain a floor of real tokens. An audit that reports "no violations" because it
 * parsed nothing is the failure mode this whole file exists to prevent.
 *
 * ── Scope ──────────────────────────────────────────────────────────────────────────
 * The extension's own `src/`, in every format, which is where MockLab's UI is. NOT the
 * companion: `companion/src/demo/` is §14's acceptance harness — a fake airline site
 * with its own visual identity that must never load `panel.css`, and whose colours are
 * the thing the probe is pointed AT. Auditing it would be auditing the fixture.
 * NOT `test/`, where a browser suite states expected colours to assert them.
 *
 * KNOWN BOUNDARY 1: HEX only, as §17.7 says. `rgb()`, `hsl()`, `color-mix()` and the
 * named colours are hardcoded colour too, and one of them is deliberate — `picker.js`
 * carries `rgba(0,102,255,.08)` because §6.1 dictates that exact fill verbatim. A guard
 * that flagged it would be one people learn to route around, which is worse than no
 * guard. Stated here rather than chosen quietly.
 *
 * KNOWN BOUNDARY 2: comments are stripped first, everywhere. A hex in prose is
 * documentation, not a hardcode, and `panel.css` quotes `#4A90FF` and `#F28B82` inside
 * the notes that record their measured contrast — the row that explains a colour is the
 * last place this should fire.
 *
 * KNOWN BOUNDARY 3: a CSS id selector spelled in hex digits (`#fff`, `#ace`, `#dedede`)
 * is indistinguishable from a colour to any static reader. None exists today. The
 * failure direction is a false POSITIVE — the audit names a line and a human renames the
 * id or records it — never a silent pass, so it is left un-special-cased.
 *
 * KNOWN BOUNDARY 4: a colour ASSEMBLED at run time ('#' + value), or arriving in a
 * message, is invisible here. §17.6's copy audit has the identical boundary for the same
 * reason, and the answer is the same: this is a source audit, and the browser suites are
 * what read the pixels.
 * ═══════════════════════════════════════════════════════════════════════════════════ */

/** The panel's stylesheet: the one file where a hex may be written at all freely. */
const PANEL_CSS = path.join(SRC, 'panel', 'panel.css');

/**
 * The two files §17.7 is knowingly broken in, with the EXACT hex each may carry. An
 * exact set in both directions: dropping one fails, and so does a sixth appearing in a
 * file already on the list — which is the direction a table of exempt FILES would miss.
 */
const RECORDED_HEX = {
  'extension/src/content/picker.js': ['#0066FF', '#4A90FF', '#FFFFFF'],
  'extension/src/background/badge.js': ['#0066FF', '#FFFFFF'],
  // M6's gap-closing: §10.3's highlight overlays. Same unavoidability as picker.js — the
  // stylesheet is injected into the user's page, which can never reach panel.css — and
  // the same discipline: every value is a §9.1 token copied verbatim (accent + its dark
  // twin, --text-oninverse, and the warning trio the "Possible" chip is made of), so the
  // page and the panel say the same thing in the same colours.
  'extension/src/background/highlight.js': [
    '#0066FF', '#0066FF', '#3A3323', '#4A90FF', '#4A90FF',
    '#B26A00', '#B26A00', '#B26A00', '#FDD663', '#FDD663', '#FDD663', '#FFF4E0', '#FFFFFF'
  ]
};

/** A colour hex: 3, 4, 6 or 8 digits, not part of a longer word (`#__mocklab…`). */
const HEX = /#[0-9a-fA-F]{3,8}\b(?![\w-])/g;

/** Every `/* … *\/` span blanked, newlines kept so reported line numbers stay true. */
function stripBlockComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (span) => span.replace(/[^\n]/g, ' '));
}

/** The same for `//` to end of line, for the JS files. `https://` is left alone. */
const stripLineComments = (text) => text.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, lead) => lead + ' ');

/**
 * The character ranges of every `:root { … }` block, by brace depth. `selector` is the
 * text since the previous brace, so the `:root` nested inside `@media (…)` is read from
 * its own opener and the `@media` is simply the block around it.
 */
function rootRanges(css) {
  const ranges = [];
  const stack = [];
  let selectorStart = 0;
  for (let i = 0; i < css.length; i += 1) {
    if (css[i] === '{') {
      stack.push({ selector: css.slice(selectorStart, i).trim(), open: i });
      selectorStart = i + 1;
    } else if (css[i] === '}') {
      const block = stack.pop();
      assert.ok(block, `unbalanced } at index ${i} — this parse decides what §17.7 permits`);
      if (/(^|[,\s])::?root$/.test(block.selector)) ranges.push([block.open, i]);
      selectorStart = i + 1;
    }
  }
  assert.equal(stack.length, 0, 'panel.css braces must balance for the :root parse to mean anything');
  return ranges;
}

/** Every hex in `text` that no range covers, as `line: #HEX`. */
function hexOutside(text, ranges) {
  const found = [];
  for (const match of text.matchAll(HEX)) {
    if (ranges.some(([from, to]) => match.index > from && match.index < to)) continue;
    found.push(`${text.slice(0, match.index).split('\n').length}: ${match[0]}`);
  }
  return found;
}

test('§17.7 panel.css keeps every colour inside a :root block', () => {
  const css = stripBlockComments(read(PANEL_CSS));
  const ranges = rootRanges(css);

  // The floors. A parse that found no blocks would permit nothing and report every hex,
  // which is loud; a parse that found ONE huge block would permit everything and report
  // none, which is silent. Only the second can pass, so it is the one measured.
  assert.ok(ranges.length >= 4, `only ${ranges.length} :root blocks parsed — §9.1's two and the extension pair are all there`);
  const inside = ranges.reduce(
    (n, [from, to]) => n + [...css.slice(from, to).matchAll(HEX)].length,
    0
  );
  assert.ok(inside >= 30, `only ${inside} hex values found inside :root — the parse has stopped reading the token blocks`);

  assert.deepEqual(
    hexOutside(css, ranges),
    [],
    'a colour written into a component recipe silently forks §9.1: the day the token ' +
      'changes, this one control does not follow. Add a token in the :root block above ' +
      'and reference it with var().'
  );
});

test('§17.7 no source file outside panel.css hardcodes a colour', () => {
  const offenders = {};
  for (const file of sourceFiles(SRC)) {
    if (file === PANEL_CSS) continue;
    const text = stripLineComments(stripBlockComments(read(file)));
    const found = [...text.matchAll(HEX)].map((m) => m[0]);
    if (found.length) offenders[rel(file)] = found.sort();
  }
  assert.deepEqual(
    offenders,
    RECORDED_HEX,
    'these are the only files §17.7 is knowingly broken in, and these the only values ' +
      'they may carry (README Deviations 21 and 35). A new hex belongs in panel.css\'s ' +
      ':root as a token — unless it truly cannot reach a stylesheet, in which case record ' +
      'the deviation and add it above.'
  );
});

test('§17.7 each recorded exception says at its own definition why it is one', () => {
  // The table above is the machine's record; this is the human's. A hex exempted in a
  // list somewhere else is a hex nobody reading the file knows is exempt.
  for (const relative of Object.keys(RECORDED_HEX)) {
    const text = read(path.join(ROOT, relative));
    assert.match(text, /§17\.7/, `${relative} must cite §17.7 beside the literals it hardcodes`);
  }
});

test('§17.7 the :root parse is a range, not a line — both line-based readings fail it', () => {
  // The two ways a grep gets this wrong, on a miniature of panel.css's real shape.
  const css = [
    ':root {',
    '  --accent: #0066FF;',
    '}',
    '@media (prefers-color-scheme: dark) {',
    '  :root {',
    '    --accent: #4A90FF;',
    '  }',
    '}',
    '.pill {',
    '  color: #BADA55;',
    '}'
  ].join('\n');
  const ranges = rootRanges(css);
  assert.equal(ranges.length, 2, 'the top-level block and the one nested inside @media');
  assert.deepEqual(
    hexOutside(css, ranges),
    ['10: #BADA55'],
    'only the one in the component recipe — "same line as :root" would report all three, ' +
      'and "any line after a :root line" would report none'
  );

  // And the self-check: a file whose braces do not balance must fail loudly, never
  // silently produce ranges that permit the wrong half of the file.
  assert.throws(() => rootRanges(':root { --a: #fff;'), /braces must balance/);
  assert.throws(() => rootRanges('}'), /unbalanced/);
});
