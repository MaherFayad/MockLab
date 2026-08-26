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

import { SRC, EXTENSION_FILES, SOURCE_FILES, jsFiles, read, rel, stripComments } from '../testlib/audit.js';

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
 * Every string `messages.js` exports, whatever holds it: a top-level string export, or a
 * value of an exported object. One level deep, which is every shape that file uses.
 *
 * WHY NOT `Object.values(PORT_MSG)`, which is what this audit walked until now: naming
 * the TABLE is what decides the coverage, so a wire value declared in any other table is
 * outside the guard until somebody remembers to add it. That is not hypothetical twice
 * over. At M3 the pick types sat in `background/pickMessages.js`, and breaking
 * `agent.js`'s mirror of `port:picked` — which kills pick mode end to end — passed all
 * twelve guards. At M4 the probe's three port types sat in `background/probeMessages.js`
 * and had the identical exposure: with `port:probeResult` mutated in `agent.js`, all 27
 * guard subtests were green. Folding both files into `messages.js` does not by itself
 * close that, because `PROBE_PORT_MSG` is still a table this list did not name.
 *
 * The PREFIX is the real contract and it is a convention the whole codebase already
 * keeps: `page:` is MAIN <-> ISOLATED, `port:` is agent <-> service worker, `msg:` is
 * panel/MCP <-> service worker. So the audit asks the question by wire — every `page:`
 * value must be spelled in `interceptor.js` AND `agent.js`, every `port:` value in
 * `agent.js` — and a message type added to any table, in any future file, is covered on
 * the day it is written rather than the day someone extends this line.
 */
function exportedStrings(module) {
  const values = [];
  for (const entry of Object.values(module)) {
    if (typeof entry === 'string') values.push(entry);
    else if (entry && typeof entry === 'object') {
      for (const value of Object.values(entry)) if (typeof value === 'string') values.push(value);
    }
  }
  return values;
}

/** The distinct wire values on one side of the postMessage/Port boundary, sorted. */
const wireValues = (module, prefix) =>
  [...new Set(exportedStrings(module).filter((value) => value.startsWith(prefix)))].sort();

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
  /*
   * EMPTY, and that is the finding rather than a gap in the list.
   *
   * `highlightId` is the one CONTENT_GLOBALS entry whose readers can all import
   * `messages.js`: §10.3's overlay host is created by a function that runs in the page
   * but is written in `background/highlight.js`, a module, and the browser suite that
   * reads the host back is a module too. Both name it as `CONTENT_GLOBALS.highlightId`,
   * so there is no hand-copied literal anywhere to drift — which is what this table
   * audits. A file that starts spelling it by hand appears here as a failure, which is
   * the direction that matters: the answer then is to import the constant, not to add a
   * row.
   */
  highlightId: [],
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
  const messages = await import('../src/background/messages.js');
  const { MOCKLAB_TAG, TOKEN_ATTRIBUTE, PORT_NAME, CONTENT_GLOBALS } = messages;
  const interceptor = fs.readFileSync(path.join(SRC, 'content/interceptor.js'), 'utf8');
  const agent = fs.readFileSync(path.join(SRC, 'content/agent.js'), 'utf8');

  const literal = (value) => new RegExp(`(['"])${value.replace(/[$]/g, '\\$&')}\\1`);

  // Floors, so this cannot pass by collecting nothing — the failure mode every audit in
  // this file exists to prevent. They are today's counts (4 `page:`; 7 `PORT_MSG` plus
  // the probe's 3), and message types are only ever added.
  const pageValues = wireValues(messages, 'page:');
  const portValues = wireValues(messages, 'port:');
  assert.ok(pageValues.length >= 4, `only ${pageValues.length} page: values found — the collector has stopped seeing tables`);
  assert.ok(portValues.length >= 10, `only ${portValues.length} port: values found — the collector has stopped seeing tables`);

  for (const value of [MOCKLAB_TAG, TOKEN_ATTRIBUTE, ...pageValues]) {
    assert.match(interceptor, literal(value), `interceptor.js mirrors ${value}`);
  }
  for (const value of [MOCKLAB_TAG, TOKEN_ATTRIBUTE, PORT_NAME, ...pageValues, ...portValues]) {
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

test('§17.2 the mirror audit reads wire values by prefix, not by table name', () => {
  // The regression this closes: walking `Object.values(PORT_MSG)` covered exactly the
  // table it named. A SECOND table of `port:` types was invisible — which is what
  // `pickMessages.js` was at M3 and `probeMessages.js` at M4, and what `PROBE_PORT_MSG`
  // still is now that both have merged into `messages.js` under their own names.
  const fixture = {
    PORT_NAME: 'mocklab',
    PAGE: { HELLO: 'page:hello' },
    PORT_MSG: { HELLO: 'port:hello' },
    SOME_OTHER_PORT_TABLE: { RESULT: 'port:invented' },
    MSG: { GET: 'msg:get' },
    PHASE: { IDLE: 'idle' },
    notATable: 7
  };
  assert.deepEqual(
    wireValues(fixture, 'port:'),
    ['port:hello', 'port:invented'],
    'a port type in a table this file never names is still collected'
  );
  assert.deepEqual(wireValues(fixture, 'page:'), ['page:hello']);
  assert.deepEqual(wireValues(fixture, 'msg:'), ['msg:get'], 'and the third prefix is separable');
});

/* ═════════ §17.8: what pins a wire VALUE, as opposed to a wire NAME ════════════════
 *
 * The audit above pins `page:` and `port:` values because two content scripts spell them
 * BY HAND — they have no module graph, so the literal in `agent.js` and the literal in
 * `messages.js` are two copies and the audit compares them.
 *
 * `msg:` has no such copy. The panel and the service worker both IMPORT this file, so
 * changing `MSG.GET_PROBE` from `msg:getProbe` to anything at all changes both ends in
 * the same instant and every suite in this repository stays green. Twenty-four of these
 * existed when that was noticed; M5's eight land below it and §12.4's fifteen MCP tools
 * come next, so the surface only grows. It was reported at M4 as "pinned by nothing
 * static" and deferred; this is it closed, and the reason it is cheap to close is the
 * prefix collector above — the same three lines that made table names stop mattering.
 *
 * Three properties, none of which names a table, so a type added to any future one is
 * covered on the day it is written:
 *
 *   1. DERIVABLE. A value is its own prefix plus its key in lowerCamel — `LIST_PRESETS`
 *      is `msg:listPresets`. That is not a style rule invented here; it is how all 46
 *      values were already spelled, which is why `panel/requestedMessages.js` could
 *      propose eight of them from the key alone and land byte-identical. Made an
 *      assertion, it pins the value to the name in both directions: rename the key or
 *      retype the string and this fails.
 *   2. DISTINCT. Two types sharing one value is the silent one. Both `switch` arms are
 *      live code, one is unreachable, and the caller gets a plausible answer from the
 *      wrong handler. Nothing else in the tree would notice.
 *   3. MIRRORED ONE WAY ONLY. Every wire-shaped literal in shipping source outside this
 *      file must be a value `messages.js` exports. That is §17.8's "no magic strings"
 *      asked in the direction that catches an invented one — which is how M5's eight
 *      spent a milestone living as fallback literals in a panel file.
 *
 * KNOWN BOUNDARY, stated rather than pretended away: none of this proves a `msg:` value
 * is ROUTED. A type both ends import and nobody handles resolves to no answer, and
 * `panel.js`'s `send()` turns that into `{ok:false}` — which is a thing the panel is
 * built to render honestly (see `requestedMessages.js`), not a thing this file can see.
 * What is checked here is that the constant is unambiguous, derivable and unique; that a
 * worker understands it is proved by the suites that call the handler.
 * ══════════════════════════════════════════════════════════════════════════════════ */

/** `SNAKE_CASE` -> `lowerCamel`, the spelling every constant in `messages.js` uses. */
const lowerCamel = (key) => key.toLowerCase().replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase());

/**
 * Every `[table, key, value]` in `module` whose value is shaped like a wire type. One
 * level deep, matching `exportedStrings` above — and the test below asserts the two
 * collectors see the SAME set, so a wire type exported at the top level (where it would
 * have no key to derive from) fails rather than slipping past this one silently.
 */
function wireEntries(module) {
  const entries = [];
  for (const [table, holder] of Object.entries(module)) {
    if (!holder || typeof holder !== 'object') continue;
    for (const [key, value] of Object.entries(holder)) {
      if (typeof value === 'string' && /^[a-z]+:/.test(value)) entries.push([table, key, value]);
    }
  }
  return entries;
}

/** The three boundaries §2 draws, and the only prefixes a wire value may carry. */
const PREFIXES = ['msg:', 'page:', 'port:'];

/**
 * The values that do NOT derive from their key — an exact set, so a fourth cannot be
 * added without writing it here.
 *
 * These three are not a boundary. They are the rename `messages.js`'s header records as
 * owed: `PROBE_PORT_MSG.SNAPSHOT` carries `probe` in the value because the TABLE NAME
 * carried it, and dissolving that table into `PORT_MSG` as `PROBE_SNAPSHOT` makes it
 * derive and empties this list. Keeping the list here rather than only in a header
 * comment means the debt is measured on every `node --test`: finish the rename and this
 * array must go to `[]` in the same commit, or the test says so.
 */
const DERIVATION_EXEMPT = ['port:probeFingerprints', 'port:probeResult', 'port:probeSnapshot'];

test('§17.8 every wire value is derivable from its name, unique, and on one transport', async () => {
  const messages = await import('../src/background/messages.js');
  const entries = wireEntries(messages);

  // Floors first, so this cannot pass by collecting nothing — the failure mode every
  // audit in this file exists to prevent. Today's counts; message types are only added.
  assert.ok(entries.length >= 46, `only ${entries.length} wire values found — the collector has stopped seeing tables`);
  const byPrefix = (prefix) => entries.filter(([, , value]) => value.startsWith(prefix));
  assert.ok(byPrefix('msg:').length >= 32, `only ${byPrefix('msg:').length} msg: values — M5's eight are meant to be in here`);

  // The two collectors must agree, or a wire type exported at the top level would be
  // inside the mirror audit and outside this one.
  assert.deepEqual(
    [...new Set(entries.map(([, , value]) => value))].sort(),
    [...new Set(PREFIXES.flatMap((prefix) => wireValues(messages, prefix)))].sort(),
    'a wire value is exported that is not inside a table — it has no key to derive from. ' +
      'Put it in one of the message tables.'
  );

  // Only the three prefixes §2 draws, and one table may not straddle two of them: the
  // prefix is what decides which dispatcher ever sees the message, so a `port:` value
  // sitting in `MSG` is a handler that is never reached.
  assert.deepEqual(
    [...new Set(entries.map(([, , value]) => value.slice(0, value.indexOf(':') + 1)))].sort(),
    PREFIXES,
    'the wire prefixes in use are exactly the three transports §2 describes'
  );
  const straddling = [...new Set(entries.map(([table]) => table))].filter(
    (table) =>
      new Set(
        entries.filter(([owner]) => owner === table).map(([, , value]) => value.slice(0, value.indexOf(':') + 1))
      ).size > 1
  );
  assert.deepEqual(straddling, [], 'these tables mix transports; one table, one prefix');

  const wrong = entries
    .filter(([, key, value]) => value !== value.slice(0, value.indexOf(':') + 1) + lowerCamel(key))
    .map(([, , value]) => value)
    .sort();
  assert.deepEqual(
    wrong,
    DERIVATION_EXEMPT,
    'a wire value must be its prefix plus its key in lowerCamel, so the string is pinned ' +
      'to the name. Both ends import this file, so nothing else would catch a change to it.'
  );

  const values = entries.map(([, , value]) => value);
  const collisions = [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
  assert.deepEqual(
    collisions,
    [],
    'two message types share one wire value: one of the two handlers is unreachable and ' +
      'the caller gets a plausible answer from the wrong one'
  );
});

/** Every wire-shaped string literal in comment-free `code`, in all three quotes. */
function wireLiterals(code) {
  const pattern = new RegExp(`(['"\`])((?:${PREFIXES.map((p) => p.slice(0, -1)).join('|')}):[^'"\`\\n]*)\\1`, 'g');
  return [...code.matchAll(pattern)].map((match) => match[2]);
}

test('§17.8 every wire literal in shipping code is one messages.js exports', async () => {
  const messages = await import('../src/background/messages.js');
  const known = new Set(wireEntries(messages).map(([, , value]) => value));

  // Shipping source in BOTH workspaces, minus the file that declares them. `test/` is
  // excluded on purpose: the fixtures above deliberately invent `port:invented` to prove
  // the collector reads tables it has never heard of, and a fixture is not a magic string.
  const invented = [];
  const mirrors = new Map();
  for (const file of SOURCE_FILES) {
    if (file === MESSAGES_JS) continue;
    for (const value of wireLiterals(stripComments(read(file)))) {
      if (known.has(value)) mirrors.set(rel(file), (mirrors.get(rel(file)) || 0) + 1);
      else invented.push(`${rel(file)}: ${JSON.stringify(value)}`);
    }
  }
  assert.deepEqual(
    invented,
    [],
    'a wire value written by hand that messages.js does not export. Either import the ' +
      'constant (§17.8), or — if this file cannot import, like the content scripts — add ' +
      'the value to messages.js so the mirror audit above starts checking it.'
  );

  // And the audit must be LOOKING at something: the two content scripts mirror by
  // necessity, and `panel/requestedMessages.js` mirrors M5's eight as dead fallbacks
  // until its author deletes it. Zero here means the scan stopped reading files.
  assert.ok(mirrors.size >= 2, `only ${mirrors.size} files mirror a wire value — the scan found nothing to check`);
});

test('§17.8 the value pin can tell a conforming table from a mutated one', async () => {
  // A guard that cannot fail is decoration. Each fixture below breaks one property and
  // must be visible to the same collector the test above uses.
  const good = { MSG: { LIST_PRESETS: 'msg:listPresets' }, PORT_MSG: { SOFT_NAV: 'port:softNav' } };
  const derives = ([, key, value]) => value === value.slice(0, value.indexOf(':') + 1) + lowerCamel(key);
  assert.ok(wireEntries(good).every(derives), 'lowerCamel handles a multi-word key and a single-word one');

  const retyped = { MSG: { LIST_PRESETS: 'msg:listPreset' } };
  assert.deepEqual(wireEntries(retyped).filter((entry) => !derives(entry)).map(([, , v]) => v), ['msg:listPreset']);

  const renamed = { MSG: { PRESET_LIST: 'msg:listPresets' } };
  assert.deepEqual(wireEntries(renamed).filter((entry) => !derives(entry)).map(([, , v]) => v), ['msg:listPresets']);

  // A value carrying its table's name, which is exactly the shape of the three exempted
  // above — the pin must see it, or the owed rename would never be measured.
  const tableNamed = { PROBE_PORT_MSG: { RESULT: 'port:probeResult' } };
  assert.deepEqual(wireEntries(tableNamed).filter((entry) => !derives(entry)).map(([, , v]) => v), ['port:probeResult']);

  // Nothing without a colon is a wire value. `PROBE_FAIL.NO_PICK` is `no-pick` and the
  // `CONTENT_GLOBALS` entries are `__mocklab…` names; neither is addressed to a
  // transport, so neither may be dragged into a rule about transports. The globals are
  // read out of the module rather than spelled here — this file keeps no copy of those
  // four names (see the header), and writing one cost two failures in the audits below
  // before it cost anything else.
  const { CONTENT_GLOBALS } = await import('../src/background/messages.js');
  assert.deepEqual(
    wireEntries({ PROBE_FAIL: { NO_PICK: 'no-pick', TIMEOUT: 'timeout' }, CONTENT_GLOBALS }),
    []
  );

  // And the literal scanner reads all three quotes, ignoring anything else in the line.
  assert.deepEqual(
    wireLiterals(`const A = 'page:hello'; const B = "port:picked"; const C = \`msg:highlight\`; const D = 'idle';`),
    ['page:hello', 'port:picked', 'msg:highlight']
  );
});

/* ═════════ the third way a message type goes wrong: reading it off the wrong table ══
 *
 * The two audits above pin a value to its name and a hand-written literal to a value.
 * Neither can see the commonest way §17.8 is broken by someone who obeyed it: writing
 * `MSG.PROBE_CHANGED` when `PROBE_CHANGED` lives in `PROBE_MSG`. That is not a magic
 * string — it is a constant, from this module, spelled correctly — and it evaluates to
 * `undefined`.
 *
 * It fails the way everything in this file fails: silently. `panel.js` compares the
 * incoming type against it, `undefined` never equals a string, and the panel simply
 * stops reacting to that broadcast; the tab keeps rendering, no error is thrown, and the
 * feature is just quieter than it should be. This is the same shape as the content-script
 * method audit further down — `api.smartTraget(raw)` returns `undefined` inside a
 * try/catch — and it is checked the same way: ask the module what it actually exports.
 *
 * Scope is the whole extension workspace including tests, because a suite asserting
 * against `PROBE_MSG.SOMETHING_ELSE` is asserting against `undefined` and will pass no
 * matter what the code does. The tables are read from the module rather than listed, so
 * one added later is covered without anyone extending a line here.
 *
 * KNOWN BOUNDARY, stated rather than pretended away — and it was stated wrong first, so
 * it is stated from a measurement now. This resolves only reads that NAME the key. A
 * computed one, `MSG[name]`, is not checked and is not forbidden either: `panel/pick.js`
 * and `panel/probe.js` both walk a declared list of contract names that way ON PURPOSE,
 * to render §10.1's honest not-ready screen when this module does not define a type yet.
 * Forbidding it would delete the mechanism that makes a missing constant visible to the
 * user instead of invisible. Those lists are audited from the panel's side, by its own
 * suites; what is added here is the half nothing was looking at — a key named literally,
 * on the wrong table, in a file that will never mention it again.
 *
 * The first version of this note claimed there were no computed reads in the workspace.
 * There are two. It was written without looking, which is the exact defect this file
 * exists to catch, committed inside the guard that catches it.
 * ══════════════════════════════════════════════════════════════════════════════════ */

test('§17.8 every constant read off a message table is one that table defines', async () => {
  const messages = await import('../src/background/messages.js');
  const tables = Object.entries(messages).filter(([, value]) => value && typeof value === 'object');
  assert.ok(tables.length >= 11, `only ${tables.length} tables found — the collector has stopped seeing exports`);

  // `TABLE.KEY`, not preceded by a word character or a dot — so `M5_MSG.X` is not read
  // as `MSG.X`. The `(?!\$\{)` skips `` `TABLE.${key}` ``, which is how three assertion
  // MESSAGES in this repo name a key in prose; `$` is a legal identifier start, so
  // without it the audit reports its own error strings as broken reads.
  const access = new RegExp(
    `(?<![\\w$.])(${tables.map(([name]) => name).join('|')})\\s*\\.\\s*(?!\\$\\{)([A-Za-z_$][\\w$]*)`,
    'g'
  );

  const undefinedReads = [];
  let checked = 0;
  for (const file of CONTENT_SCOPE) {
    const code = stripComments(read(file));
    const lineAt = (index) => code.slice(0, index).split('\n').length;
    for (const match of code.matchAll(access)) {
      checked += 1;
      if (!Object.prototype.hasOwnProperty.call(messages[match[1]], match[2])) {
        undefinedReads.push(`${rel(file)}:${lineAt(match.index)} ${match[1]}.${match[2]}`);
      }
    }
  }

  // A floor, so this cannot pass by reading nothing — the failure mode every audit in
  // this file exists to prevent.
  assert.ok(checked >= 300, `only ${checked} reads of a message table found — the scan stopped seeing files`);
  assert.deepEqual(
    undefinedReads,
    [],
    'this constant is `undefined`: it is read off a table that does not define it. ' +
      'Nothing throws — a comparison against `undefined` is simply never true — so the ' +
      'feature stops and the page keeps working. Read it off the table that has it.'
  );
});

/* ═════════ the OTHER unpinned values: payload vocabulary that is not a wire type ═══
 *
 * `PROBE_STEP.CLEANUP` is `cleanup` and `PROBE_FAIL.TIMEOUT` is `timeout`. Neither
 * carries a transport prefix, so neither is a wire type and the three properties above
 * say nothing about them — and they were the values that started this: retyping
 * `PROBE_FAIL.TIMEOUT` was measured, on this tree, to pass every non-browser suite.
 *
 * Most of that is genuinely not pinnable, and saying so is the honest answer rather than
 * inventing a rule. Both ends import this module and `panel/probe.js` keys its
 * translation table BY THE CONSTANT (`{[F.TIMEOUT]: 'timeout'}`), so retyping the value
 * moves the sender, the receiver and the table together and NOTHING observable changes.
 * A mutation that changes no behaviour is not a defect, and a guard that failed on it
 * would be pinning a spelling for its own sake.
 *
 * What IS pinnable is the part `messages.js` states as FACT. Its `PROBE_FAIL` comment
 * says "the FIRST FIVE are keys of `S.probe` in strings.js", and `PROBE_STEP`'s says the
 * four "are keys of `S.probe.step` … the panel renders `S.probe.step[step]`". Those are
 * claims, and on this build a claim that nothing checks is the recurring defect, not a
 * hypothetical one. Where a value is documented to BE a copy key, the value is pinned by
 * that document — so the document is made to fail when it stops being true.
 *
 * KNOWN BOUNDARY, stated rather than pretended away, three parts:
 *   • `PHASE`, `PROBE_PHASE` and `PROBE_STATE` are pinned by nothing here and cannot be.
 *     They name screens and states, no copy key corresponds to them, and no file spells
 *     them by hand. Retyping one is invisible because it IS invisible.
 *   • The last six `PROBE_FAIL` values have no `S.probe` sentence on purpose (§11 wrote
 *     copy for a probe that ran and found nothing, not for one that never started), so
 *     they are asserted to stay OUT — otherwise this test would quietly start demanding
 *     copy for a defect of MockLab's own, which §17.12 says must never read as a finding
 *     about the site.
 *   • Renaming a value AND its copy key together still passes. That is a real edit with
 *     a real reason, not a slip; what is caught is the half-edit.
 * ══════════════════════════════════════════════════════════════════════════════════ */

test('§17.6 vs §17.8 every vocabulary value documented as a copy key is one', async () => {
  const { PROBE_STEP, PROBE_FAIL } = await import('../src/background/messages.js');
  const { S } = await import('../src/panel/strings.js');
  const has = (table, key) => Object.prototype.hasOwnProperty.call(table, key);

  // §11 gives the progress card four lines and the panel renders `S.probe.step[step]`,
  // so a step whose value is not a key there renders NOTHING — on the screen whose whole
  // promise (§10.1C) is that the user never thinks it is stuck.
  const steps = Object.entries(PROBE_STEP);
  assert.ok(steps.length >= 4, `only ${steps.length} probe steps — the collector has stopped seeing the table`);
  assert.deepEqual(
    steps.filter(([, value]) => !has(S.probe.step, value)).map(([key]) => key),
    [],
    'PROBE_STEP values are documented as keys of S.probe.step; the panel indexes that ' +
      'table with them, so one that is not a key prints an empty progress line'
  );

  // The five findings ABOUT THE PAGE, which §11 wrote an honest sentence for each of.
  const FINDINGS = ['TOO_NOISY', 'NONE_CONFIRMED', 'ELEMENT_LOST', 'NOT_REFETCHED', 'TIMEOUT'];
  assert.deepEqual(
    FINDINGS.filter((key) => !has(S.probe, PROBE_FAIL[key])),
    [],
    "messages.js documents these five PROBE_FAIL values as keys of S.probe — §11's " +
      'sentence for each. Retyping one leaves the failure card with no sentence to print.'
  );
  // §6.3's own ending, which §11 put in `pick` rather than `probe`.
  assert.ok(has(S.pick, PROBE_FAIL.NO_CANDIDATES), 'PROBE_FAIL.NO_CANDIDATES is a key of S.pick');

  // And the converse, which is the half that keeps this honest: the REST must have no
  // sentence. A run nobody started, a tab with no page agent, the user's own Stop, and a
  // defect of MockLab's own are not findings about the site, and giving one an
  // `S.probe.*` sentence is how it would start being reported as one (§17.12, §1.1).
  const named = new Set([...FINDINGS.map((key) => PROBE_FAIL[key]), PROBE_FAIL.NO_CANDIDATES]);
  assert.deepEqual(
    Object.entries(PROBE_FAIL)
      .filter(([, value]) => !named.has(value) && has(S.probe, value))
      .map(([key]) => key),
    [],
    'this ending has acquired an S.probe sentence. It is not a finding about the page — ' +
      "§11's `errors.pageBroke` is what the card falls back to, on purpose."
  );
});

test('§17.6 vs §17.8 the vocabulary pin can tell a documented key from a retyped one', async () => {
  const { S } = await import('../src/panel/strings.js');
  const has = (table, key) => Object.prototype.hasOwnProperty.call(table, key);
  // The two mutations that were measured to pass every non-browser suite before this
  // test existed. Both must be visible to exactly the comparison used above.
  assert.equal(has(S.probe.step, 'cleaningUp'), false, 'a retyped PROBE_STEP value is not a copy key');
  assert.equal(has(S.probe, 'timedOut'), false, 'a retyped PROBE_FAIL value is not a copy key');
  // And the comparison is not vacuous — the real values ARE keys.
  assert.equal(has(S.probe.step, 'cleanup'), true);
  assert.equal(has(S.probe, 'timeout'), true);
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
