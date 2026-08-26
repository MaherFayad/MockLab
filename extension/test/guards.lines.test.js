/**
 * PLAN.md §17.10's ~500-line budget, and the README record that documents every file
 * past it — both audited on every `npm test`.
 *
 * OWNER: interceptor-engineer. Split out of `guards.test.js` before M4, with the
 * ISOLATED-world contract audit and the §17.6 string audit (README Deviation 43). This
 * is the theme that separates most cleanly: every constant, parser and boundary note
 * below is read by these eight tests and by nothing else, so the split moved the whole
 * apparatus in one piece and left no regex behind its qualification.
 *
 * Scope: every .js file in both workspaces, tests and test helpers included.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { EXTENSION, SRC, README_PATH, ALL_FILES, read, rel } from '../testlib/audit.js';

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
 * figure that REACHES this clause sits at 203 — the threshold is near neither.
 *
 * That sentence used to say "the nearest innocent figure in today's table", which was
 * false: two innocent figures sit much closer, at 25 and 41 characters. Both are
 * §17.10's own "~500 lines" cap, and clause (c) frees them one step earlier, before any
 * distance is ever measured — so they never reach 80, and never tested it. The headroom
 * between 21 and 80 is therefore only as wide as (c) is reliable, which is worth knowing
 * before anyone moves either number: widen NEAR past 203 and the table's honest prose
 * starts failing; narrow it below 21 and both historical defects come back.
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
 *
 * ── and (e), the hole every clause above still had ─────────────────────────────────
 *
 * (a) through (d) all begin at LINE_FIGURE, which needs the word "line(s)" — so a claim
 * omitting the word was invisible to the checker for the same reason it is easy to miss
 * as a reader. Deviation 43 enumerated four files that way, one readable count and then
 * "`guards.contract.test.js` 329, … `extension/testlib/audit.js` (111)", and QA rewrote
 * all four figures to 999/888/777/666 with the whole suite green. Nothing here detects a
 * number being WRONG; only the SHAPE is, and these four had no shape to check. So (e): a
 * bare number in APPOSITION to a backticked `*.js` path — separated from it by
 * punctuation and nothing else — is a claim about that file, word or no word.
 *
 * KNOWN BOUNDARY 4: apposition is read in ONE direction, path then number. "329 `x.js`"
 * is NOT flagged, because Deviation 35 writes "Same precedent as Deviation 21
 * (`badge.js`)" — a cross-reference three characters from a path, in exactly that order,
 * with nothing in the text separating it from a size. Left uncaught on purpose rather
 * than flagged and routed around; that row is a fixture below, so whoever wants to close
 * this side finds the thing blocking it already on screen.
 *
 * KNOWN BOUNDARY 5: the number must end on punctuation or the line, never a word, so
 * "`x.js` 3 times" stays a quantity of something else. Both historical shapes end on ","
 * or ")". A figure that DOES carry the word is left to (a)–(d): (e) never re-reports a
 * span LINE_FIGURE matched, so those exemptions are not re-litigated here.
 *
 * SPEC_CAP does not extend to (e), deliberately: (c) frees a RESTATEMENT of §17.10's rule,
 * and a restatement is a sentence ("caps files at ~500 lines"). Apposition has no room for
 * one, because the gap admits no letters — so "`x.js` (500)" is a claim about x.js and is
 * read as one. Clause (d) DOES extend to it, and is literally the same code: a row may
 * quote a bare figure while correcting it, as Deviation 33 quotes "295 lines each".
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
 * Everything allowed BETWEEN a path and a bare number counting it: whitespace, a bracket,
 * a dash, a comma, a colon, a bold marker, a tilde. No letter, no `.`, no `§` — those are
 * what turn "beside" into a sentence, and a sentence is prose.
 */
const APPOSITION_GAP = '[ \\t(\\[*,:=~\u2248\u2013\u2014-]{0,6}';

/**
 * Clause (e): "`guards.contract.test.js` 329", "`extension/testlib/audit.js` (111)" — a
 * path, punctuation, a number, no word "lines" anywhere. The lookaheads are the
 * section-number guard (a figure may not run into a decimal or a `§17.10`) and KNOWN
 * BOUNDARY 5. A factory, like `readableCount()`, because a `g` regex carries state.
 */
const pathThenNumber = () =>
  new RegExp('`([\\w./-]+\\.js)`' + APPOSITION_GAP + '(\\d+)(?!\\.?\\d)(?!\\s*[A-Za-z])', 'g');

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

  // Clause (e). Everything above needed the word "lines" to start; this needs only a
  // number sitting where a count of the path beside it would sit.
  const figures = [...line.matchAll(LINE_FIGURE)].map((m) => [m.index, m.index + m[0].length]);
  for (const match of line.matchAll(pathThenNumber())) {
    const end = match.index + match[0].length;
    const span = [end - match[2].length, end];
    const covers = ([from, to]) => span[0] >= from && span[1] <= to;

    if (figures.some(covers)) continue; // carries the word: (a)–(d) already had their turn
    if (quoted.some(covers) && readable.length) continue; // clause (d), unchanged
    found.push(
      `${label}: "${match[2]}" sits directly beside \`${match[1]}\` with no word between ` +
        `them, so it reads as a count of it, but not as ${READABLE_SHAPE}.`
    );
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
  // 35 joins the list with clause (e): it is the row that decides KNOWN BOUNDARY 4.
  for (const number of [11, 22, 26, 27, 33, 35]) {
    assert.deepEqual(
      unreadableCounts(tableRow(number), `Deviation ${number}`),
      [],
      `Deviation ${number} reads correctly today — flagging it would teach people to work ` +
        'around this audit, which is worse than not having it'
    );
  }
  // Named individually, because each is a different way to mention lines innocently, and
  // a row-level deepEqual would still pass if the row stopped containing the figure.
  assert.match(tableRow(22), /caps files at ~500 lines/, '§17.10\'s cap, quoted as the rule it is');
  assert.match(tableRow(26), /caps files at ~500 lines/, 'and the second row that restates it');
  assert.match(tableRow(27), /passed 1000 lines/, 'a threshold a file crossed, not its size');
  // Was row 27's `~90-line Playwright resolver` until the shared harness made that cost void
  // and the phrase went; moved here rather than deleted — the shape needs a live example.
  assert.match(tableRow(43), /602-line helper/, 'a hyphenated line figure that is not a file\'s size');
  assert.match(tableRow(33), /"295 lines each"/, 'the false figure quoted while correcting it');
  assert.match(tableRow(35), /Deviation 21 \(`badge\.js`\)/, 'a cross-reference, in clause (e)\'s shape reversed');

  // Deviation 43 is asserted figure by figure rather than row-clean: it is the fixture
  // clause (e) was written for, so it is RED until rewritten and this has to hold on both
  // sides of that. What it protects is the prose in the same row — those numbers are
  // history and cost, not sizes, and (e) must not sweep them up on its way to the four.
  const prose = ['808 lines', '602-line', '1031', '520', '231 names'];
  for (const figure of prose) {
    assert.ok(tableRow(43).includes(figure), `Deviation 43 states "${figure}" as prose`);
    const swept = unreadableCounts(tableRow(43), 'Deviation 43').filter((claim) =>
      claim.includes(`"${/\d+/.exec(figure)[0]}"`)
    );
    assert.deepEqual(swept, [], `"${figure}" is history or cost, not a file's size — leave it`);
  }
});

test('§17.10 a bare number beside a path is a count of it, word or no word', () => {
  // Verbatim from README at e72bfe9. One readable count, then four files given their
  // sizes by apposition alone — the shape QA proved invisible to BOTH passes: the parser
  // could not read them, and the unreadable-shape audit could not see them either.
  const enumerated =
    '| 43 | M3 | The guards are split by theme — `extension/test/guards.test.js` is 254 lines, ' +
    '`guards.contract.test.js` 329, `guards.strings.test.js` 283, `guards.lines.test.js` 354, ' +
    'with shared helpers in `extension/testlib/audit.js` (111). | why |';

  const claims = unreadableCounts(enumerated, 'Deviation 43');
  const naming = (figure, file) =>
    claims.filter((claim) => claim.includes(`"${figure}"`) && claim.includes(file));
  for (const [figure, file] of [
    ['329', 'guards.contract.test.js'],
    ['283', 'guards.strings.test.js'],
    ['354', 'guards.lines.test.js'],
    ['111', 'extension/testlib/audit.js']
  ]) {
    assert.equal(naming(figure, file).length, 1, `"${figure}" must be read as a count of ${file}`);
  }
  assert.equal(claims.length, 4, `exactly the four unreadable ones. Got: ${JSON.stringify(claims)}`);
  assert.ok(
    claims.every((claim) => !claim.includes('"254"')),
    'the readable count in the same row is read by the parser, so it is not re-reported here'
  );

  // The same row with every figure false — QA's mutation, which the whole suite passed.
  // It must fail for the SAME reason, message for message once the digits are blanked:
  // nothing detects a number being WRONG until the shape lets it be read.
  const falsified = enumerated
    .replace('` 329', '` 999')
    .replace('` 283', '` 888')
    .replace('` 354', '` 777')
    .replace('(111)', '(666)');
  const blank = (list) => list.map((claim) => claim.replace(/"\d+"/, '"N"'));
  assert.deepEqual(
    blank(unreadableCounts(falsified, 'Deviation 43')),
    blank(claims),
    'the false figures fail identically to the true ones — the guard is about shape'
  );
  for (const figure of ['999', '888', '777', '666']) {
    assert.ok(
      unreadableCounts(falsified, 'Deviation 43').some((claim) => claim.includes(`"${figure}"`)),
      `and each false figure is named: ${figure}`
    );
  }
});

test('§17.10 clause (e) is a shape, not a number hunt', () => {
  const cases = [
    ['bold markers around the path', '| 9 | M3 | **`a.js`** 329, and more. | why |', 1],
    ['a parenthesised figure', '| 9 | M3 | helpers in `a.js` (111). | why |', 1],
    ['§17.10\'s own cap has no sentence to hide in here', '| 9 | M3 | `a.js` (500). | why |', 1],
    ['the readable rewrite of the same claim', '| 9 | M3 | `a.js` is 329 lines. | why |', 0],
    ['a count of something that is not lines', '| 9 | M3 | `a.js` 3 times faster. | why |', 0],
    ['a section reference after a path', '| 9 | M3 | `a.js`, §17.10, was split. | why |', 0],
    ['a cross-reference in the reverse order (KNOWN BOUNDARY 4)', '| 9 | M3 | as Deviation 21 (`a.js`). | why |', 0],
    ['a sentence between the path and the number', '| 9 | M3 | `a.js` was split at M3. Then 640 arrived. | why |', 0],
    ['a quoted bare figure beside a checked count', '| 9 | M3 | `a.js` is 12 lines (first "`a.js` 329"). | why |', 0]
  ];
  for (const [what, row, expected] of cases) {
    assert.equal(
      unreadableCounts(row, 'Deviation 9').length,
      expected,
      `${what} — expected ${expected} claim(s) from: ${row}`
    );
  }
});

test('§17.10 the audit\'s own self-check would fire if either pattern stopped matching', () => {
  // The floor in the live-table test believes a number this function produces. These
  // prove it is a real count of real matches: a table with nothing to read reports
  // nothing read, which is below the floor and fails.
  const nothing = auditTable('| 9 | M3 | `a.js` was split from `b.js`. | §17.10 says so. |');
  assert.equal(nothing.figures, 0, 'no figure in the text, none counted');
  assert.ok(nothing.figures < 8, 'and the live-table floor of 8 would fail on such a table');
  assert.deepEqual(nothing.claims, [], 'while a row with no figures at all raises nothing');

  // Clause (e) cannot have a floor on the live table: once the row above is rewritten
  // readable, the honest number of bare figures there is ZERO, and a floor would then
  // demand the table keep a defect to stay green. The fixtures in the test above are its
  // guarantee instead — neuter `pathThenNumber()` and all four assertions fail.
  assert.equal([...'`a.js` 329'.matchAll(pathThenNumber())].length, 1, 'pathThenNumber() matches');
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
