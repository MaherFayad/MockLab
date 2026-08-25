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
import vm from 'node:vm';
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

/* ═════════ §17.8's other half: the contract the content scripts share ══════════════
 *
 * Three ISOLATED-world scripts reach each other through names on the extension's
 * isolated global, and the MAIN-world patch keeps its re-entrancy flag on the page's.
 * `messages.js` names all four in `CONTENT_GLOBALS`. Nothing can import it, so they are
 * mirrored by hand — exactly like `PAGE.CAPTURED`, and checked for the same reason.
 *
 * The mirror half is that same presence check. The METHOD half below is not, and it is
 * the one nothing catches today: every read of these globals sits inside a `try/catch`
 * that returns null (§17.2 — a content script may never break the host page), so a
 * renamed METHOD does not throw either. `picker.js` would go on calling
 * `api.smartTarget(raw)`, get `undefined` back, and pick mode would quietly stop working
 * with every unit test still green. Only a browser suite would notice — which means
 * nothing notices on a machine without Playwright.
 *
 * NOTE ON THIS FILE: it deliberately contains no copy of any of the four names. They are
 * read out of `CONTENT_GLOBALS` at run time — even in the fixture below — so that the
 * audit cannot itself become one more mirror to drift, and so it needs no exemption from
 * the scan it runs. Please keep it that way.
 * ══════════════════════════════════════════════════════════════════════════════════ */

/**
 * Every file that MIRRORS the contract: extension source and extension tests, minus the
 * one file that declares it. `messages.js` naming these values is the definition, not a
 * copy of it, so counting it would make the exact-set check below tautological.
 */
const MESSAGES_JS = path.join(SRC, 'background', 'messages.js');
const CONTENT_SCOPE = [...jsFiles(SRC), ...jsFiles(path.join(EXTENSION, 'test'))]
  .filter((file) => file !== MESSAGES_JS)
  .sort();

/**
 * `value` as a WHOLE name, so that a rename by suffix cannot satisfy the mirror check by
 * containing the old name.
 */
const wholeName = (value) => new RegExp(`(?<![\\w$])${value.replace(/[$]/g, '\\$&')}(?![\\w$])`);

/**
 * Every file that mirrors each `CONTENT_GLOBALS` entry, as an EXACT set. A file that
 * drops the literal fails; so does a NEW file that starts using one without being
 * recorded here. The second direction is the point: a fifth reader would otherwise
 * appear with nothing checking that it spells the name the way messages.js does.
 */
const MIRRORS = {
  element: [
    'extension/src/content/element.js',
    'extension/src/content/picker.js',
    'extension/test/pickerdom.browser.test.js'
  ],
  picker: [
    'extension/src/content/agent.js',
    'extension/src/content/picker.js',
    'extension/test/pickerdom.browser.test.js'
  ],
  overlayId: ['extension/src/content/picker.js', 'extension/test/picker.browser.test.js'],
  interceptorInstalled: [
    'extension/src/content/interceptor.js',
    'extension/test/e2e.browser.test.js'
  ]
};

test('§17.2 vs §17.8 the content scripts mirror messages.js exactly', async () => {
  // Neither content script can import messages.js (no module graph in the MAIN world,
  // and agent.js is a classic script), so both duplicate a handful of literals. That
  // duplication is only safe while it is checked: a silent drift here kills the whole
  // MAIN-world patch while the page keeps working, so nothing else would fail loudly.
  const { MOCKLAB_TAG, TOKEN_ATTRIBUTE, PORT_NAME, PAGE, PORT_MSG, CONTENT_GLOBALS } = await import(
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

  // The ISOLATED-world contract. Comments are NOT stripped: each of these files carries
  // a header paragraph naming its half of the contract in prose, and a rename that
  // leaves the prose behind has left a lie behind (§1.1).
  assert.deepEqual(
    Object.keys(MIRRORS).sort(),
    Object.keys(CONTENT_GLOBALS).sort(),
    'every global messages.js declares is accounted for below, and nothing else is'
  );
  for (const [key, expected] of Object.entries(MIRRORS)) {
    const value = CONTENT_GLOBALS[key];
    const actual = CONTENT_SCOPE.filter((file) => wholeName(value).test(read(file))).map(rel);
    assert.deepEqual(
      actual,
      expected,
      `CONTENT_GLOBALS.${key} is "${value}"; these are the files that name it. Renaming it ` +
        'means renaming it in all of them in the same commit — every read is inside a ' +
        'try/catch, so a miss is silent (§17.2).'
    );
  }
});

/**
 * The converse: a `__mocklab…` name messages.js has never heard of. The table above can
 * only check names it knows, so a sixth global invented in a content script would be
 * invisible to it — and invisible is how this class of bug lives.
 */
test('§17.8 every MockLab global in the tree is one messages.js names', async () => {
  const { MOCKLAB_TAG, CONTENT_GLOBALS } = await import('../src/background/messages.js');
  const known = new Set([MOCKLAB_TAG, ...Object.values(CONTENT_GLOBALS)]);
  const anyName = new RegExp(`${MOCKLAB_TAG}[\\w$]*`, 'g');
  const unknown = new Map();
  for (const file of CONTENT_SCOPE) {
    for (const match of read(file).matchAll(anyName)) {
      if (!known.has(match[0])) unknown.set(match[0], rel(file));
    }
  }
  assert.deepEqual(
    [...unknown].map(([name, file]) => `${file}: ${name}`),
    [],
    'add it to CONTENT_GLOBALS and to MIRRORS above, or spell it the way messages.js does'
  );
});

/**
 * The braces-balanced block opening at `open`, or '' when it never closes. Braces inside
 * strings are counted too — the same cheap imprecision as `enclosingOpener`, failing the
 * same safe way: a mis-measured body can only make a function LOOK like a contract
 * accessor, which adds call sites to the audit instead of hiding any.
 */
function blockAfter(code, open) {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === '{') depth += 1;
    else if (code[index] === '}' && (depth -= 1) === 0) return code.slice(open, index + 1);
  }
  return '';
}

/**
 * The methods a content script really publishes — read by RUNNING it in a bare `vm`
 * context and asking the object.
 *
 * This was scoped as "regex-parse the `globalThis.<the element global> = { … }` object
 * literal", with the parse named as the brittle part. It is, so this does not do it:
 * both files are dependency-free IIFEs that touch no DOM at load time (§17.2 asks for
 * exactly that), so they evaluate in an empty context and hand over the real object. No
 * parse to under-match, and no copy of the key list here to drift.
 *
 * If one ever does need a DOM at load time, this fails and says so. It does NOT fall
 * back to a regex: a guard that keeps passing by looking at less is the failure mode
 * this whole file exists to prevent.
 */
function publishedContract(globalName) {
  const publishes = new RegExp(`globalThis\\s*\\.\\s*${globalName}\\s*=`);
  const file = jsFiles(path.join(SRC, 'content')).find((candidate) =>
    publishes.test(stripComments(read(candidate)))
  );
  assert.ok(file, `no content script publishes ${globalName}`);
  const context = vm.createContext({});
  try {
    vm.runInContext(read(file), context, { filename: rel(file) });
  } catch (error) {
    assert.fail(
      `${rel(file)} no longer evaluates in a bare context (${error.message}). This audit ` +
        'runs it to learn the real method names — give the context whatever it now needs, ' +
        'do not weaken the audit back to parsing the object literal.'
    );
  }
  assert.equal(typeof context[globalName], 'object', `${rel(file)} publishes ${globalName}`);
  return { file: rel(file), keys: Object.keys(context[globalName]) };
}

/**
 * Every method call on the contract published as `globalName`, and every computed access
 * to it, with line numbers.
 *
 * NOTHING in this repo writes `<the element global>.fingerprint(el)`. `picker.js` reaches
 * the global through a helper — `function el() { … }`, then `var api = el();` — precisely
 * because §17.2 wants the lookup to happen at call time rather than at load, and
 * `agent.js` does the same for the picker. A guard matching only the direct form would
 * have found ZERO call sites in `src/` and reported green: the sixth check in this
 * repository to be green for the wrong reason, in the file whose job is to catch that.
 * So receivers are resolved first — a variable initialised from the global, a function
 * whose body names it, and a variable initialised from such a function.
 */
function callSites(text, globalName) {
  const code = stripComments(text);
  const holds = wholeName(globalName);
  const names = new Set();
  const factories = new Set();

  for (const match of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) {
    if (holds.test(match[2])) names.add(match[1]);
  }
  for (const match of code.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g)) {
    if (holds.test(blockAfter(code, match.index + match[0].length - 1))) factories.add(match[1]);
  }
  for (const factory of factories) {
    const assigned = `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${factory}\\s*\\(`;
    for (const match of code.matchAll(new RegExp(assigned, 'g'))) names.add(match[1]);
  }

  const receiver = `(?<![\\w$.])(?:${[
    `(?:(?:window|globalThis|self)\\s*\\.\\s*)?${globalName}`,
    ...[...factories].map((factory) => `${factory}\\s*\\(\\s*\\)`),
    ...names
  ].join('|')})`;
  const lineAt = (index) => code.slice(0, index).split('\n').length;
  return {
    calls: [...code.matchAll(new RegExp(`${receiver}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, 'g'))].map(
      (match) => ({ name: match[1], line: lineAt(match.index) })
    ),
    dynamic: [...code.matchAll(new RegExp(`${receiver}\\s*\\[`, 'g'))].map((match) => lineAt(match.index))
  };
}

/**
 * The method audit. `CONTENT_GLOBALS` keeps the two contracts spelled the same way
 * everywhere; this keeps their CONTENTS honest, which is the half that fails silently:
 * `api.smartTraget(raw)` returns `undefined` inside a try/catch and the page keeps
 * rendering.
 *
 * `blind` is the clause that stops this test passing by seeing nothing. A file that
 * names a contract but offers the audit no checkable call site fails — being unable to
 * look is reported, never counted as a pass.
 *
 * KNOWN BOUNDARY 1, stated rather than pretended away: this audits CALLS against the
 * contract, never the contract against callers. A published method nobody calls yet can
 * be renamed with nothing going red — `areaOf` is one today, exported beside `textOf` and
 * `normText` for the M4 probe. Asserting the converse would fail on exactly that
 * deliberate case, so it is not asserted; it is written down here instead.
 *
 * KNOWN BOUNDARY 2: `pickerdom.browser.test.js` drives
 * the contract by name (`picker[name](...argv)`), which no static check can resolve.
 * Computed access is therefore forbidden in `src/`, where nothing else would catch it,
 * and allowed in a browser suite, where it IS caught: that line CALLS the method, so a
 * renamed one throws in Chromium. The static audit covers `src/` on every `node --test`;
 * Playwright covers the dynamic sites.
 */
test('§17.2 every method called on a content-script contract is one it publishes', async () => {
  const { CONTENT_GLOBALS } = await import('../src/background/messages.js');
  for (const globalName of [CONTENT_GLOBALS.element, CONTENT_GLOBALS.picker]) {
    const contract = publishedContract(globalName);
    const wrong = [];
    const blind = [];
    const computedInSrc = [];
    for (const file of CONTENT_SCOPE) {
      if (!wholeName(globalName).test(read(file))) continue;
      const { calls, dynamic } = callSites(read(file), globalName);
      for (const call of calls) {
        if (!contract.keys.includes(call.name)) wrong.push(`${rel(file)}:${call.line} .${call.name}()`);
      }
      if (!calls.length && rel(file) !== contract.file) blind.push(rel(file));
      if (file.startsWith(SRC + path.sep)) {
        for (const line of dynamic) computedInSrc.push(`${rel(file)}:${line}`);
      }
    }
    assert.deepEqual(
      wrong,
      [],
      `${contract.file} publishes ${globalName} with: ${contract.keys.join(', ')}. Calling ` +
        'anything else is silent — the read is inside a try/catch, so the page keeps working ' +
        'and the feature just stops.'
    );
    assert.deepEqual(
      blind,
      [],
      `these files name ${globalName} but this audit found no call it could check. Either ` +
        'the reference is dead and should go, or the receiver is resolved a way `callSites` ' +
        'cannot follow — teach it, do not leave it looking at nothing.'
    );
    assert.deepEqual(
      computedInSrc,
      [],
      `shipping code must name a ${globalName} method literally, so this audit can read it. ` +
        'Computed access is only tolerable in a browser suite, which calls the method for real.'
    );
  }
});

test('§17.2 the method audit can tell a real method from a plausible one', async () => {
  // The audit is only worth its lines if a wrong name fails it. `callSites` resolves
  // receivers through a helper because that is how picker.js and agent.js read these
  // globals; if that resolution is ever simplified away, both shapes below stop being
  // seen and every mutation of a method name goes green.
  const { CONTENT_GLOBALS } = await import('../src/background/messages.js');
  const name = CONTENT_GLOBALS.element;
  const source = [
    `function el() { return globalThis.${name} || null; }`,
    'var api = el();',
    'api.smartTarget(raw);',
    'el().fingerprint(node);',
    `window.${name}.snapshotElement(node);`,
    `var direct = globalThis.${name};`,
    'direct.normText(value);',
    'api[key](node);'
  ].join('\n');
  const { calls, dynamic } = callSites(source, name);
  assert.deepEqual(
    calls.map((call) => call.name),
    ['smartTarget', 'fingerprint', 'snapshotElement', 'normText'],
    'all four receiver shapes: a helper-returned value, the helper called inline, the ' +
      'global itself, and a plain variable holding it'
  );
  assert.deepEqual(dynamic, [8], 'the computed call on the last line, and only it');
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
 * The ONE phrasing this file can check: "`x.js` is N lines", "is itself N lines",
 * "is now N lines". A factory, not a constant, because a `g` regex carries state.
 *
 * Two things read it — `recordedLineCounts()` and the audit that fails a count written
 * in any OTHER shape. They must be the same pattern: if they drifted, the audit would
 * bless a phrasing the parser skips, which is the exact hole it exists to close.
 */
const readableCount = () => /`([\w./-]+\.js)`\s+is\s+(?:itself\s+|now\s+)?(\d+)\s+lines/g;

/** The shape every message below asks for, written once. */
const READABLE_SHAPE = '"`path/to/file.js` is N lines" (also "is now N lines", "is itself N lines")';

/**
 * Line counts the Deviations table states, keyed by the path it names — which may be a
 * bare basename ("interceptor.js") or a partial path ("test/e2e.browser.test.js").
 * Takes the text so a mutation test can feed it a row that is not in README.
 */
function recordedLineCounts(table = deviationsTable()) {
  const found = new Map();
  for (const match of table.matchAll(readableCount())) {
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

/* ═════════ A count this file cannot READ is a finding, not a pass ══════════════════
 *
 * `recordedLineCounts()` above reads exactly one phrasing. Everything else in the table
 * was skipped SILENTLY — not flagged, not counted — and that hole hid a stale figure
 * twice, two rows apart: Deviation 26's "`pick.js` is a new file (384 lines)", where a
 * parenthetical between the name and the number kept 384 alive through two edits, and
 * Deviation 33's "295 lines each" of two files that were 301 and 296, both broken by the
 * commits that were FIXING other record defects. One cause both times — a claim the
 * parser could not read was treated as a claim that did not exist — so it now fails.
 *
 * The hard half is not firing on prose that merely mentions lines. This table quotes
 * §17.10's "~500 lines" cap twice, records that a suite "passed 1000 lines", and costs
 * out "a ~90-line resolver". None of those is a measurement of a file, and a guard that
 * flagged them would be one people learn to route around — worse than no guard.
 *
 * A figure counts as a CLAIM when either
 *   (a) a copula puts it after a subject — "is now 640 lines", "are roughly 300 lines
 *       each" — in which case the subject has to be a backticked path or this file
 *       cannot know WHICH file is described even once it can read the number; or
 *   (b) it sits within NEAR characters of a backticked `*.js` path, which is what both
 *       historical defects looked like: 16 and 21 characters away.
 * and it is not
 *   (c) §17.10's own cap restated as the rule it is, or
 *   (d) a quotation, in a row that also states a count this file did check.
 *
 * KNOWN BOUNDARY 1: (b) is a distance, so a figure far from every path and attached to
 * no verb reads as prose. "It passed 1000 lines" is deliberately on that side; the cost
 * is that a bare "…, 640 lines, …" written far from any path stays invisible. NEAR is
 * 80 because the two real defects sat at 16 and 21 characters and the nearest innocent
 * figure in today's table sits at 203 — the threshold is near neither.
 *
 * KNOWN BOUNDARY 2, stated rather than picked silently: (d) tolerates a quoted figure
 * only in a row that ALSO states a checked count, which is the documented-correction
 * shape Deviation 33 has today. A row that quotes a figure and states none fails. What
 * genuinely cannot be classified is the row that does both honestly and also hides a
 * live claim inside quote marks: the quote marks are the only signal there and they
 * read identically either way. That case is written down here, not guessed at.
 *
 * KNOWN BOUNDARY 3: (c) frees the value 500 only AFTER the parser has had its turn, so
 * "`x.js` is 500 lines" is still read and checked like any other count; only unattached
 * restatements of the rule go free.
 * ═══════════════════════════════════════════════════════════════════════════════════ */

/** How far a figure may sit from a backticked path and still be read as a count of it. */
const NEAR = 80;

/** §17.10's cap. Restating the RULE is not stating any file's size. */
const SPEC_CAP = 500;

/**
 * A number written next to the word "line(s)": "384 lines", "295 lines each", "roughly
 * 300 lines", "a ~90-line resolver". Deliberately wider than `readableCount()` — its job
 * is to FIND claims that pattern missed, never to parse them.
 */
const LINE_FIGURE =
  /(?:~\s*|≈\s*|about\s+|roughly\s+|around\s+|approximately\s+)?\d+\s*(?:-|\s)\s*lines?\b/gi;

/** "is"/"are" and their hedges immediately before a figure: the row is stating a size. */
const COPULA_BEFORE =
  /\b(?:is|are|was|were)\s+(?:(?:now|itself|already|each|only|about|roughly|around|approximately)\s+)*$/i;

/**
 * Every line-count-shaped claim in one line of the table that `recordedLineCounts()`
 * cannot read, as sentences naming the row and what to rewrite.
 */
function unreadableCounts(line, label) {
  const readable = [...line.matchAll(readableCount())].map((m) => [m.index, m.index + m[0].length]);
  const quoted = [...line.matchAll(/["“][^"”]*["”]/g)].map((m) => [m.index, m.index + m[0].length]);
  const paths = [...line.matchAll(/`[\w./-]+\.js`/g)].map((m) => [m.index, m.index + m[0].length, m[0]]);
  const found = [];

  for (const figure of line.matchAll(LINE_FIGURE)) {
    const [start, end] = [figure.index, figure.index + figure[0].length];
    const covers = ([from, to]) => start >= from && end <= to;

    if (readable.some(covers)) continue; // read — the count test above checks the number
    if (COPULA_BEFORE.test(line.slice(Math.max(0, start - 40), start))) {
      found.push(
        `${label}: "${figure[0].trim()}" states a size, but not as ${READABLE_SHAPE}, so this ` +
          'audit cannot tell which file it is about.'
      );
      continue;
    }
    if (quoted.some(covers) && readable.length) continue; // a quotation, beside a checked count
    if (Number(/\d+/.exec(figure[0])[0]) === SPEC_CAP) continue; // §17.10's cap, not a measurement

    const nearest = paths
      .map(([from, to, text]) => [to <= start ? start - to : from >= end ? from - end : 0, text])
      .sort((a, b) => a[0] - b[0])[0];
    if (nearest && nearest[0] <= NEAR) {
      found.push(
        `${label}: "${figure[0].trim()}" sits ${nearest[0]} characters from ${nearest[1]} and ` +
          `reads as a count of it, but not as ${READABLE_SHAPE}.`
      );
    }
  }
  return found;
}

/** The whole table, row by row, plus how many figures were examined at all. */
function auditTable(table = deviationsTable()) {
  const claims = [];
  let figures = 0;
  for (const line of table.split('\n')) {
    const row = /^\|\s*(\d+)\s*\|/.exec(line);
    const label = row ? `Deviation ${row[1]}` : 'the Deviations section prose';
    figures += [...line.matchAll(LINE_FIGURE)].length;
    claims.push(...unreadableCounts(line, label));
  }
  return { claims, figures };
}

/** One numbered row of the live table, for tests that assert on the real prose. */
function tableRow(number) {
  const line = deviationsTable()
    .split('\n')
    .find((text) => text.startsWith(`| ${number} |`));
  assert.ok(line, `Deviation ${number} is a fixture for this audit; if the row is gone, repoint it`);
  return line;
}

test('§17.10 a line count README states in an unreadable shape fails, it is not skipped', () => {
  const { claims, figures } = auditTable();
  assert.ok(
    figures >= 8,
    `this audit examined ${figures} line figures in the Deviations table, which is too few ` +
      'to believe — LINE_FIGURE has stopped matching and the audit is passing by seeing nothing'
  );
  assert.deepEqual(
    claims,
    [],
    `a count written in a shape this file cannot read is a stale figure waiting to happen — ` +
      `it has happened twice. Rewrite each row above as ${READABLE_SHAPE}. If the number is ` +
      'genuinely prose about line budgets and not one file\'s size, say so as prose: name ' +
      '§17.10\'s ~500 cap, or quote the old wording, rather than leaving a bare figure beside ' +
      'a file name.'
  );
});

test('§17.10 the unreadable-count audit catches both phrasings that hid a stale figure', () => {
  // Both rows are verbatim from git, not from memory: `git show 0ff2bd1:README.md` (the
  // M3 commit) and `git show 5b8124d:README.md` (the commit before row 33 was rephrased).
  const parenthetical =
    '| 26 | M3 | `extension/src/panel/pick.js` is a new file (384 lines), splitting §10.1\'s Pick tab out of `panel.js`. | §17.10 caps files at ~500 lines and says to split when bigger — the same reason `sources.js` and `dom.js` were split at M2. |';
  const each =
    '| 33 | M3 | `extension/src/content/element.js` split from `picker.js`; the manifest lists three ISOLATED content scripts. | §17.10. The seam is the one the tests already used: `element.js` answers the questions the M4 probe asks with no picker running (§6.2 fingerprint and re-resolve, §7.3 snapshot, §6.1 smart target); `picker.js` is the interaction. 295 lines each. |';

  const from26 = unreadableCounts(parenthetical, 'Deviation 26');
  assert.equal(from26.length, 1, `the 384 must fail, not skip. Got: ${JSON.stringify(from26)}`);
  assert.match(from26[0], /"384 lines"/, 'and the message must name the figure to rewrite');
  assert.doesNotMatch(from26[0], /500/, 'while the same row\'s "~500 lines" cap stays untouched');

  const from33 = unreadableCounts(each, 'Deviation 33');
  assert.equal(from33.length, 1, `"295 lines each" must fail, not skip. Got: ${JSON.stringify(from33)}`);
  assert.match(from33[0], /"295 lines"/);
  assert.match(from33[0], /picker\.js/, 'naming the path it sits beside, which is the file it meant');
});

test('§17.10 the unreadable-count audit leaves the table\'s honest prose alone', () => {
  // The real rows, not copies of them: (a) would leave the hole open, (b) would make the
  // guard something people route around, and only the live text can prove (b) today.
  for (const number of [11, 22, 26, 27, 33, 43]) {
    assert.deepEqual(
      unreadableCounts(tableRow(number), `Deviation ${number}`),
      [],
      `Deviation ${number} reads correctly today — flagging it would teach people to work ` +
        'around this audit, which is worse than not having it'
    );
  }
  // Named individually, because each is a different way to mention lines innocently.
  assert.match(tableRow(22), /caps files at ~500 lines/, '§17.10\'s cap, quoted as the rule it is');
  assert.match(tableRow(27), /passed 1000 lines/, 'a threshold a file crossed, not its size');
  assert.match(tableRow(27), /~90-line Playwright resolver/, 'the cost of a split that was not made');
  assert.match(tableRow(33), /"295 lines each"/, 'the false figure quoted while correcting it');
});

test('§17.10 the audit is not fooled by a quote, a pronoun or a hedge', () => {
  const cases = [
    ['a pronoun subject nothing can resolve to a file', '| 9 | M3 | `a.js` was split. It is now 640 lines. | why |'],
    ['a hedge instead of a number this file can check', '| 9 | M3 | `a.js` and `b.js` are roughly 300 lines each. | why |'],
    ['"is 301 lines long" for a file that is not', '| 9 | M3 | `a.js` grew; the file is 301 lines long. | why |'],
    ['a bare figure beside the path it describes', '| 9 | M3 | `a.js` — 640 lines — was split. | why |'],
    ['a live claim hidden in quote marks, with no checked count in the row', '| 9 | M3 | `a.js` was split (**"295 lines each"**). | why |']
  ];
  for (const [what, row] of cases) {
    assert.equal(unreadableCounts(row, 'Deviation 9').length, 1, `${what} must fail: ${row}`);
  }
  assert.deepEqual(
    unreadableCounts('| 9 | M3 | `extension/src/panel/pick.js` is 430 lines. | §17.10 caps files at ~500 lines. |', 'Deviation 9'),
    [],
    'and the readable rewrite of the same row is clean — the audit asks for a shape it accepts'
  );
});

test('§17.10 a readable count that is WRONG still fails, exactly as it did before', () => {
  const row = '| 9 | M3 | `extension/test/guards.test.js` is 1 lines. | why |';
  assert.deepEqual(
    [...recordedLineCounts(row)],
    [['extension/test/guards.test.js', 1]],
    'the parser reads it, so the count test above compares 1 against the real file'
  );
  assert.notEqual(1, lineCount(read(path.join(EXTENSION, 'test', 'guards.test.js'))), 'and 1 is not it');
  assert.deepEqual(
    unreadableCounts(row, 'Deviation 9'),
    [],
    'the shape audit stays silent on it: readable-but-wrong is the other test\'s job, and a ' +
      'row failing both tests would say the same thing twice'
  );
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
