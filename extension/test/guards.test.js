/**
 * Source audits for the rules that cannot be tested by running the code (PLAN.md §17).
 *
 * OWNER: interceptor-engineer.
 *
 * §17.4 in particular is a *grep* rule the plan asks the implementer to run on itself:
 * "the string `state: \"verified\"` may appear in exactly one assignment in the codebase
 * (probe.js)". A rule that only a human remembers to check is a rule that breaks the
 * first time nobody checks. It is checked here, on every `npm test`.
 *
 * Scope, deliberately different per rule:
 *   §17.1 / §17.2  extension source only — they are about MV3 and the MAIN world.
 *   §17.4          shipping source in BOTH workspaces. `test/` is excluded on purpose:
 *                  `changes.test.js` plants a verified Binding to prove the M2 engine
 *                  never downgrades one, which is the opposite of a violation.
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
 * Three shapes, and only these three: `state: <rhs>` in an object literal,
 * `something.state = <rhs>`, and `something['state'] = <rhs>`. A bare `state = …` is
 * deliberately NOT matched — `interceptor.js`, `background.js` and `panel.js` all keep
 * ordinary local variables called `state`, and flagging those would drown the audit.
 * The lookbehind also keeps `linkState:` and the ternary `binding.state : null` out.
 *
 * @param {string} text
 * @returns {{kind:'literal'|'indirect', value?:string, rhs?:string}[]}
 */
function stateAssignments(text) {
  const PATTERNS = [
    /(?<![.\w$])state\s*:\s*([^,;}\n]+)/g,
    /\.state\s*=\s*([^;\n]+)/g,
    /\[\s*['"`]state['"`]\s*\]\s*=\s*([^;\n]+)/g
  ];
  const code = stripComments(text);
  const found = [];
  for (const pattern of PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const rhs = match[1].trim();
      const literal = /^(['"`])((?:[^'"`\\]|\\.)*)\1/.exec(rhs);
      found.push(literal ? { kind: 'literal', value: literal[2] } : { kind: 'indirect', rhs });
    }
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
  const offenders = [];
  for (const file of SOURCE_FILES) {
    const verified = stateAssignments(read(file)).filter((a) => a.kind === 'literal' && a.value === 'verified');
    if (verified.length) offenders.push(`${rel(file)} (${verified.length})`);
  }

  const allowed = offenders.filter((entry) => entry.startsWith(PROBE_JS));
  assert.deepEqual(
    offenders.filter((entry) => !allowed.includes(entry)),
    [],
    'a wrong "Verified ✓" is the worst bug this product can have (§17.12) — only the ' +
      'probe CONFIRMED state may assign it'
  );
  assert.ok(allowed.length <= 1, 'even probe.js gets exactly one such assignment');
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
 * §17.10 caps a file at ~500 lines and says to split when bigger. Two files are past
 * that on purpose, each with a recorded reason in README's Deviations table.
 *
 * The reason is prose and a human owns it. The NUMBER is not: it has already been wrong
 * twice, both times because someone edited a file and did not revisit the row, and the
 * second time it survived a whole QA round. So the number is read out of README and
 * checked against the file — the record cannot drift silently any more, because editing
 * an oversized file without updating its row breaks the build.
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
