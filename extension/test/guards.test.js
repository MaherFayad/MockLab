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
 * Scope, deliberately different per rule:
 *   §17.1 / §17.2  extension source only — they are about MV3 and the MAIN world.
 *   §17.4 / §17.6  shipping source in BOTH workspaces. `test/` is excluded on purpose:
 *                  `changes.test.js` plants a verified Binding to prove the M2 engine
 *                  never downgrades one — the opposite of a violation.
 *   §17.10         every .js file in both workspaces, tests included.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(EXTENSION, '..');
const SRC = path.join(EXTENSION, 'src');
const COMPANION = path.join(ROOT, 'companion');
const README_PATH = path.join(ROOT, 'README.md');

/** Every .js file under `dir`, or none when the directory does not exist. */
function jsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(full);
    return entry.isFile() && entry.name.endsWith('.js') ? [full] : [];
  });
}

const read = (file) => fs.readFileSync(file, 'utf8');
/**
 * Repo-root-relative, forward slashes: `extension/src/…`, `companion/src/…`. Both
 * workspaces have a `src/` and a `test/`, so a path relative to either one would be
 * ambiguous the moment the companion is audited alongside the extension.
 */
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

/** The extension's own source — the only place §17.1 and §17.2 can apply. */
const FILES = jsFiles(SRC).sort();

/**
 * Shipping source in BOTH workspaces, for §17.4. The companion has no Binding today,
 * but at M6 it serves `get_bindings` to AI agents (§12.4 #6) — a hardcoded verified
 * state there would be the same lie §17.12 calls the worst bug this product can have,
 * told to a different audience.
 */
const SOURCE_FILES = [...jsFiles(SRC), ...jsFiles(path.join(COMPANION, 'src'))].sort();

/**
 * Everything §17.10's line budget applies to, in both workspaces. The companion is
 * three small files today and M6 adds the hub, the MCP server and 15 tool definitions
 * to it — written by someone who has not read this thread, which is exactly who a
 * self-checking record is for.
 */
const ALL_FILES = [
  ...jsFiles(SRC),
  ...jsFiles(path.join(EXTENSION, 'test')),
  ...jsFiles(path.join(COMPANION, 'src')),
  ...jsFiles(path.join(COMPANION, 'test'))
].sort();

/** What `wc -l` counts: newline-terminated lines, so a trailing newline is not a line. */
function lineCount(text) {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** Lines that are neither blank nor a comment line — the "of them code" figure. */
function codeLineCount(text) {
  return text.split('\n').filter((line) => {
    const trimmed = line.trim();
    return trimmed !== '' && !trimmed.startsWith('//') && !trimmed.startsWith('/*') && !trimmed.startsWith('*');
  }).length;
}

/**
 * Blank out comments so an audit reads CODE, never prose. Two passes, both deliberately
 * simple: this codebase always opens a block comment at the start of a line, and a
 * trailing `//` is only stripped when it is not preceded by `:` — otherwise the `//` in
 * a `https://` literal would take the rest of the line with it.
 */
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

/**
 * Every string literal in comment-free `code`, contents only — in ALL THREE quotes. QA
 * put `` return `Data`; `` back into signatures.js and every audit in this file stayed
 * green: this half was quote-only, and a backtick is one keystroke away. (The §17.4
 * pair above always read all three.) The template pattern matches only a template with
 * no `${…}` in it — the kind that IS a whole literal; one that interpolates is
 * concatenation, which is the boundary stated below.
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

test('§17.2 vs §17.8 the content scripts mirror messages.js exactly', async () => {
  // Neither content script can import messages.js (no module graph in the MAIN world,
  // and agent.js is a classic script), so both duplicate a handful of literals. That
  // duplication is only safe while it is checked: a silent drift here kills the whole
  // MAIN-world patch while the page keeps working, so nothing else would fail loudly.
  const { MOCKLAB_TAG, TOKEN_ATTRIBUTE, PORT_NAME, PAGE, PORT_MSG } = await import(
    '../src/background/messages.js'
  );
  const interceptor = fs.readFileSync(path.join(SRC, 'content/interceptor.js'), 'utf8');
  const agent = fs.readFileSync(path.join(SRC, 'content/agent.js'), 'utf8');

  const literal = (value) => new RegExp(`(['"])${value.replace(/[$]/g, '\\$&')}\\1`);

  for (const value of [MOCKLAB_TAG, TOKEN_ATTRIBUTE, ...Object.values(PAGE)]) {
    assert.match(interceptor, literal(value), `interceptor.js mirrors ${value}`);
  }
  for (const value of [
    MOCKLAB_TAG, TOKEN_ATTRIBUTE, PORT_NAME,
    ...Object.values(PAGE), ...Object.values(PORT_MSG)
  ]) {
    assert.match(agent, literal(value), `agent.js mirrors ${value}`);
  }
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

/* ══════════════════════════ §17.10, and the record that documents it ═══════════════
 *
 * §17.10 caps a file at ~500 lines. Files past that are recorded in README's Deviations
 * table with the reason, which is prose a human owns. The NUMBER is not: it has been
 * wrong twice, both times because someone edited a file and never revisited the row,
 * and once it survived a whole QA round. So it is read out of README and checked
 * against the file — editing an oversized file without fixing its row breaks the build.
 * ═══════════════════════════════════════════════════════════════════════════════════ */

/** §17.10's "~500", with slack for the long header comment every file here carries. */
const LINE_BUDGET = 520;

/** Just the Deviations table, so a line count mentioned elsewhere is not swept in. */
function deviationsTable() {
  const readme = read(README_PATH);
  const start = readme.indexOf('## Deviations from PLAN.md');
  assert.notEqual(start, -1, 'README must keep its "## Deviations from PLAN.md" section (§17.11)');
  const end = readme.indexOf('\n## ', start + 1);
  return end === -1 ? readme.slice(start) : readme.slice(start, end);
}

/**
 * Line counts the Deviations table states, keyed by the path it names — which may be a
 * bare basename ("interceptor.js") or a partial path ("test/e2e.browser.test.js").
 * Recognised phrasings: "`x.js` is N lines", "is itself N lines", "is now N lines".
 */
function recordedLineCounts() {
  const found = new Map();
  for (const match of deviationsTable().matchAll(/`([\w./-]+\.js)`\s+is\s+(?:itself\s+|now\s+)?(\d+)\s+lines/g)) {
    found.set(match[1], Number(match[2]));
  }
  return found;
}

/** A recorded key names a file when it IS the path, or is a trailing part of it. */
const namesFile = (key, relative) => relative === key || relative.endsWith('/' + key);

test('§17.10 a file over the line budget is recorded in README', () => {
  const recorded = recordedLineCounts();
  const oversized = ALL_FILES.map((file) => [rel(file), lineCount(read(file))]).filter(
    ([, lines]) => lines > LINE_BUDGET
  );

  for (const [relative, lines] of oversized) {
    const hits = [...recorded.keys()].filter((key) => namesFile(key, relative));
    assert.equal(
      hits.length,
      1,
      `${relative} is ${lines} lines, past §17.10's budget, and README's Deviations name it ` +
        `${hits.length} times. Record it there in the form "\`${relative}\` is ${lines} lines", ` +
        'with the reason it cannot be split — or split it.'
    );
  }
});

test('§17.10 every line count README states is the file\'s real one', () => {
  const recorded = recordedLineCounts();
  assert.ok(recorded.size > 0, 'the Deviations table states at least one line count');

  for (const [key, claimed] of recorded) {
    const hits = ALL_FILES.map((file) => [rel(file), lineCount(read(file))]).filter(([relative]) =>
      namesFile(key, relative)
    );
    assert.equal(hits.length, 1, `README's Deviations name \`${key}\`, which matches ${hits.length} files`);
    const [relative, real] = hits[0];
    assert.equal(
      claimed,
      real,
      `README says ${relative} is ${claimed} lines; it is ${real}. Update the row — a ` +
        'record nobody maintains is worse than no record.'
    );
  }
});

test('§17.10 Deviation 11 states interceptor.js\'s real code-line count too', () => {
  const match = /`interceptor\.js` is (\d+) lines \((\d+) of them code\)/.exec(deviationsTable());
  assert.ok(
    match,
    'Deviation 11 must read "`interceptor.js` is N lines (M of them code)" — this test ' +
      'reads those two numbers out of it, so the phrasing is load-bearing.'
  );

  const text = read(path.join(SRC, 'content', 'interceptor.js'));
  assert.equal(Number(match[1]), lineCount(text), 'the total-line figure in Deviation 11');
  assert.equal(
    Number(match[2]),
    codeLineCount(text),
    'the code-line figure in Deviation 11 (non-blank lines that are not comment lines)'
  );
});
