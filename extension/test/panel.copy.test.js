/**
 * PLAN.md §11's copy table, audited as a TABLE — the properties the screens need of the
 * words themselves, independently of any code that renders them.
 *
 * OWNER: panel-designer. Split from `panel.strings.test.js` for §17.10's ~500-line
 * ceiling, at the seam the two files already had:
 *
 *   `panel.strings.test.js`  does the PANEL hold words of its own? It swaps `strings.js`
 *                            for a sentinel, reads render helpers, and audits panel
 *                            source for literals at a copy sink.
 *   this file                does the COPY TABLE have the properties the screens depend
 *                            on? §11's closing rules, and — the part that grew at M5 —
 *                            whether sentences that must differ actually do, whether a
 *                            palette contains the value a control starts on, and whether
 *                            a chip's word and its colour are chosen together.
 *
 * Nothing here renders anything, so nothing here needs a browser. That is the point: a
 * copy table that two screens read differently is wrong before either screen runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { S } from '../src/panel/strings.js';

const PANEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'panel');
const read = (file) => fs.readFileSync(path.join(PANEL, file), 'utf8');

/** Comments claim nothing and print nothing; only code can put a word on screen. */
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

/* ─────────────────────────────────────────────────── §11's closing rules */

test("§11's closing rules: sentence case, and no exclamation marks outside an applied moment", () => {
  // "no exclamation marks except `applied` moments" — §11. Audited across the whole
  // table so the next string added inherits the rule instead of re-arguing it.
  const offenders = [];
  const walk = (node, trail) => {
    for (const [key, value] of Object.entries(node)) {
      const where = trail ? `${trail}.${key}` : key;
      if (value && typeof value === 'object') {
        walk(value, where);
        continue;
      }
      const text = typeof value === 'function' ? sample(value) : typeof value === 'string' ? value : '';
      if (/applied|paired/i.test(key)) continue; // §11's one sanctioned exception
      if (text.includes('!')) offenders.push(`S.${where}: “${text}”`);
    }
  };
  walk(S, '');
  assert.deepEqual(offenders, [], '§11: no exclamation marks except at an "applied" moment');
});

/** A representative rendering of an interpolating string, for the audits above. */
function sample(fn) {
  for (const args of [[1, 1], ['x', 'y']]) {
    try {
      const out = fn(...args);
      if (typeof out === 'string') return out;
    } catch {
      /* a shape this audit cannot call says nothing either way */
    }
  }
  return '';
}

test("§11's closing rules: the default UI speaks no technical vocabulary", () => {
  // "never use: JSON, API, endpoint, payload, regex, DOM, probe, binding, signature
  // (those words may ONLY appear when Advanced mode is on)" — §11, and §1.2 for why.
  const BANNED = /\b(json|api|endpoint|payload|regex|dom|probe|binding|signature)s?\b/i;
  const offenders = [];
  const walk = (node, trail) => {
    for (const [key, value] of Object.entries(node)) {
      const where = trail ? `${trail}.${key}` : key;
      if (where === 'advanced') continue; // §1.2's one sanctioned place for these words
      if (typeof value === 'object' && value !== null) walk(value, where);
      // Sample the interpolating ones: their fixed words are what this audit is about.
      const text = typeof value === 'function' ? tryCall(value) : typeof value === 'string' ? value : '';
      const hit = BANNED.exec(text);
      if (hit) offenders.push(`S.${where}: “${hit[0]}”`);
    }
  };
  const tryCall = (fn) => {
    for (const args of [[1, 1], ['x', 'y']]) {
      try {
        const out = fn(...args);
        if (typeof out === 'string') return out;
      } catch {
        /* a shape this audit cannot call says nothing either way */
      }
    }
    return '';
  };
  walk(S, '');
  assert.deepEqual(offenders, [], 'a non-technical user has no meaning for these (§1.2)');
});

/* ═════════════ M5: §10.4's copy, and the chip pairing §10.6 depends on ═══════════ */

test('§10.6 a status chip\'s word and its colour are never chosen separately', () => {
  // `linkChip(state)` looks the word up BY the state, so the pairing cannot be got wrong.
  // The other three chips are drawn by helpers that take BOTH — `chip('changed',
  // S.chips.changed)` — and a call site that takes both is a call site a copy-paste can
  // get wrong: an amber "Possible" chip reading "Changed" is a smaller version of exactly
  // the mistake §17.12 calls the worst bug this product can have. Nothing is mispaired
  // today; this is what keeps it that way without refactoring three render paths.
  const offenders = [];
  for (const file of fs.readdirSync(PANEL).filter((name) => name.endsWith('.js') && name !== 'strings.js')) {
    const code = stripComments(read(file));
    for (const match of code.matchAll(/\b(?:chip|chipNode)\(\s*'([a-z]+)'\s*,\s*S\.chips\.([a-z]+)/gi)) {
      if (match[1] !== match[2]) offenders.push(`${file}: chip('${match[1]}', S.chips.${match[2]})`);
    }
  }
  assert.deepEqual(offenders, [], 'the class and the word must name the same state (§10.6)');
  // …and the audit can see a mispairing, or the test above passes by seeing nothing.
  const planted = "chip('changed', S.chips.candidate);";
  assert.equal([...planted.matchAll(/\b(?:chip|chipNode)\(\s*'([a-z]+)'\s*,\s*S\.chips\.([a-z]+)/gi)].length, 1);
});

test('§10.4 the symbol palette really contains the symbol the form starts on', () => {
  // The picker sets its thumb from `symbols.indexOf(form.emoji)`. A default that is not
  // in the list resolves to -1, the thumb clamps to 0, and the highlighted symbol is not
  // the one the scenario would be saved with — a control that shows the wrong answer.
  assert.ok(Array.isArray(S.scenarios.symbols) && S.scenarios.symbols.length > 1);
  assert.ok(S.scenarios.symbols.includes(S.scenarios.defaultSymbol), 'the default symbol must be pickable');
  assert.equal(new Set(S.scenarios.symbols).size, S.scenarios.symbols.length, 'two identical symbols are one choice drawn twice');
  for (const symbol of S.scenarios.symbols) {
    assert.equal(typeof symbol, 'string');
    assert.ok(symbol.length > 0 && [...symbol].length <= 3, `“${symbol}” is not one glyph`);
  }
});

test('§10.4 "{n} changes" on a card is not the site bar\'s "{n} changes on"', () => {
  // Two counts of the same thing in two places, and they are not the same sentence: the
  // site bar's says the changes are ON right now, a card's says how many the scenario
  // holds. Reusing one for the other put "2 changes on" inside a card that is not applied.
  assert.notEqual(S.scenarios.count(2), S.site.changes(2));
  assert.equal(S.scenarios.count(1), '1 change', 'one change is not "1 changes"');
  assert.equal(S.scenarios.count(0), '0 changes');
});

test('§10.4 the ⋯ menu reads as four different actions', () => {
  const items = [S.scenarios.rename, S.scenarios.duplicate, S.scenarios.exportFile, S.scenarios.delete];
  assert.equal(new Set(items).size, 4, `§10.4's menu reads as ${new Set(items).size} actions`);
  for (const item of items) assert.ok(item.trim().length > 0);
});

test('§1.1 the two "this is not proved" sentences say different things', () => {
  // `editor.unverified` is about a link that was NEVER proved. `highlight.stale` is about
  // one that WAS and can no longer be stood behind. Collapsing them tells a person their
  // experiment never happened, which is false — and it is the collapse a rewrite makes
  // first, because both sentences live in the same place on the same card.
  assert.notEqual(S.highlight.stale, S.editor.unverified);
  assert.notEqual(S.highlight.stale, S.scenarios.stale);
  assert.notEqual(S.highlight.none, S.highlight.stale);
});

test('§17.6 no panel source carries a byte that hides it from a grep', () => {
  // Found by measurement, not by reasoning: a raw NUL written into `links.js` made `grep`
  // classify the whole file as binary and SKIP it. Every guard in this repository that
  // reads source with `fs.readFileSync` would still have seen it — but every audit a
  // person runs by hand, and every ripgrep-backed search, would silently not. A file no
  // grep will read is the ideal hiding place for the next off-§11 literal.
  const offenders = [];
  for (const file of fs.readdirSync(PANEL)) {
    if (!/\.(js|css|html)$/.test(file)) continue;
    const bytes = fs.readFileSync(path.join(PANEL, file));
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index];
      if (byte < 9 || (byte > 13 && byte < 32)) {
        offenders.push(`${file}: byte 0x${byte.toString(16)} at ${index}`);
        break;
      }
    }
  }
  assert.deepEqual(offenders, [], 'write it as an escape sequence — a raw control byte makes grep treat the file as binary');
});
