/**
 * Source audits for the rules that cannot be tested by running the code (PLAN.md §17).
 *
 * OWNER: interceptor-engineer.
 *
 * §17.4 in particular is a *grep* rule the plan asks the implementer to run on itself:
 * "the string `state: \"verified\"` may appear in exactly one assignment in the codebase
 * (probe.js)". A rule that only a human remembers to check is a rule that breaks the
 * first time nobody checks. It is checked here, on every `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(full);
    return entry.isFile() && entry.name.endsWith('.js') ? [full] : [];
  });
}

const FILES = jsFiles(SRC).sort();

test('§17.4 nothing outside probe.js may put a link into the verified state', () => {
  // Matches an ASSIGNMENT of the verified state in any of the forms this codebase
  // could plausibly write it, in JS or JSON: `state: "verified"`, `state = 'verified'`,
  // `state:"verified"`, `.state="verified"`. Prose, JSDoc unions ("verified"|"candidate")
  // and §11's "Verified ✓" chip copy are deliberately NOT matched — they claim nothing.
  const ASSIGNMENT = /\bstate\s*[:=]\s*(['"`])verified\1/g;

  const offenders = [];
  for (const file of FILES) {
    const hits = fs.readFileSync(file, 'utf8').match(ASSIGNMENT);
    if (hits) offenders.push(`${path.relative(SRC, file)} (${hits.length})`);
  }

  const allowed = offenders.filter((entry) => entry.startsWith('background/probe.js'));
  assert.deepEqual(
    offenders.filter((entry) => !allowed.includes(entry)),
    [],
    'a wrong "Verified ✓" is the worst bug this product can have (§17.12) — only the ' +
      'probe CONFIRMED state may assign it'
  );
  assert.ok(allowed.length <= 1, 'even probe.js gets exactly one such assignment');
});

test('§17.4 the M2 Changes engine writes candidate links and nothing else', () => {
  const engine = ['background/ruleStore.js', 'background/changesApi.js'].map((rel) =>
    fs.readFileSync(path.join(SRC, rel), 'utf8')
  );
  const written = new Set();
  for (const text of engine) {
    for (const match of text.matchAll(/\bstate\s*[:=]\s*(['"`])([a-z]+)\1/g)) written.add(match[2]);
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
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), forbidden, `${path.relative(SRC, file)} — MV3 cannot`);
  }
});

test('§17.10 every source file stays under ~500 lines, or is a recorded deviation', () => {
  // Deviation 11 (README): interceptor.js cannot be split without publishing MockLab's
  // internals on a hostile page's global object, and §17.10 forbids a bundler too.
  const RECORDED = new Set(['content/interceptor.js']);
  const over = FILES.map((file) => [path.relative(SRC, file), fs.readFileSync(file, 'utf8').split('\n').length])
    .filter(([rel, lines]) => lines > 520 && !RECORDED.has(rel));
  assert.deepEqual(over, [], 'split it, or record a deviation saying why it cannot be split');
});
