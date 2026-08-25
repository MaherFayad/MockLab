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
 * the first time) and the two one-line MV3 rules, §17.1 and §17.2's ban on imports and
 * hashes in the MAIN world. Shared file lists and `stripComments` live in
 * `testlib/audit.js`, which the §17.10 audit counts like any other file.
 *
 * Scope, deliberately different per rule:
 *   §17.1 / §17.2  extension source only — they are about MV3 and the MAIN world.
 *   §17.4          shipping source in BOTH workspaces. `test/` is excluded on purpose:
 *                  `changes.test.js` plants a verified Binding to prove the M2 engine
 *                  never downgrades one — the opposite of a violation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { SRC, FILES, SOURCE_FILES, read, rel, stripComments } from '../testlib/audit.js';

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
