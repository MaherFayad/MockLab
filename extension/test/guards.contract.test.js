/**
 * The contract the content scripts share, audited from source (PLAN.md §17.2, §17.8).
 *
 * OWNER: interceptor-engineer. Split out of `guards.test.js` before M4, with the §17.6
 * string audit and the §17.10 line-count audit (README Deviation 43). Every regex here
 * still sits beside the boundary note that qualifies it — that was the objection to
 * splitting, and the seam was chosen so no note had to be separated from its pattern.
 *
 * Scope: the whole extension workspace, tests included. These are names, and a name is
 * mirrored by whoever reads it, wherever they live.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { SRC, EXTENSION_FILES, jsFiles, read, rel, stripComments } from '../testlib/audit.js';

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
 * Every file that MIRRORS the contract: the extension workspace, minus the one file that
 * declares it. `messages.js` naming these values is the definition, not a copy of it, so
 * counting it would make the exact-set check below tautological. The scope is derived
 * from the workspace rather than listed as `src/` + `test/`, so a directory added later
 * is scanned without anyone remembering to add it.
 */
const MESSAGES_JS = path.join(SRC, 'background', 'messages.js');
const CONTENT_SCOPE = EXTENSION_FILES.filter((file) => file !== MESSAGES_JS);

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
    'extension/src/content/agent.js', 'extension/src/content/element.js',
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
