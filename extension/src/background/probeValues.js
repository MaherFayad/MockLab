/**
 * §7.4's probe values, and §11's reload estimate.
 *
 * OWNER: probe-engineer. Split out of `probe.js` under §17.10 — that file is the state
 * machine and this is a pure function of one value, which is also what makes the
 * domain rules below exhaustively unit-testable without a browser or a store.
 *
 * The rule these obey, and the reason §7.4 spends a paragraph on it: a probe value has
 * to exercise the site's REAL rendering path. Writing `"__probe__"` into a status field
 * changes the pill — through the site's unknown-value branch — and proves nothing about
 * what the field renders normally. So a value really seen at the path beats a known enum
 * neighbour, which beats a case flip, which beats a marked-up copy of the original.
 */

/**
 * Enum families worth flipping between, from §7.4's list plus the obvious neighbours of
 * each. A flip inside a family exercises the site's real rendering path; a made-up
 * constant usually exercises its default branch, which changes the element for the
 * wrong reason and would prove nothing about the field.
 */
const ENUM_FAMILIES = [
  ['ON_TIME', 'DELAYED', 'CANCELLED'],
  ['IN_STOCK', 'OUT_OF_STOCK'],
  ['ACTIVE', 'INACTIVE'],
  ['ENABLED', 'DISABLED'],
  ['AVAILABLE', 'UNAVAILABLE'],
  ['OPEN', 'CLOSED'],
  ['PAID', 'UNPAID'],
  ['CONFIRMED', 'PENDING', 'REJECTED'],
  ['SUCCESS', 'FAILED'],
  ['YES', 'NO'],
  ['TRUE', 'FALSE']
];

/** §7.4's "enum-like string". */
const ENUM_LIKE = /^[A-Z0-9_]{2,30}$/;

/** §7.4's "free text": append a visible glyph, minimal layout shift. */
const TEXT_MARK = ' ●';

/**
 * The value to write at a candidate's path so the site RENDERS something different
 * (PLAN.md §7.4). Never null: a null-valued candidate is skipped before it gets here,
 * because a null tells the site "no value" and the resulting change would say more
 * about the site's empty state than about the field.
 *
 * `avoid` is what makes VERIFY_ON stronger than the bisection run that preceded it:
 * the same field is mutated a SECOND time, to a different value where the domain has
 * one. A field that changes the element for two unrelated values is not coincidence.
 *
 * @param {any} value the real value at the path
 * @param {{observedValues?:any[], avoid?:any}} [options]
 * @returns {any} the replacement, or undefined when there is nothing safe to write
 */
export function probeValueFor(value, options = {}) {
  const avoid = options.avoid;
  const observed = (options.observedValues || [])
    .filter((seen) => seen !== null && seen !== undefined && typeof seen !== 'object');

  if (value === null || value === undefined) return undefined;
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'number') {
    // §7.4: "multiply by 3 and add 7 … keep integer-ness".
    const next = value * 3 + 7;
    const flipped = Number.isInteger(value) ? Math.round(next) : next;
    return flipped === avoid ? flipped * 3 + 7 : flipped;
  }
  if (typeof value !== 'string') return undefined;

  const differs = (candidate) => candidate !== value && candidate !== avoid;

  // §7.4's first rule: another value REALLY seen at this path beats anything invented.
  const seen = observed.map(String).find(differs);
  if (seen !== undefined) return seen;

  const enumLike = ENUM_LIKE.test(value) || observed.length > 0;
  if (enumLike) {
    const family = ENUM_FAMILIES.find((group) => group.includes(value.toUpperCase()));
    if (family) {
      const flip = family.map((member) => matchCase(value, member)).find(differs);
      if (flip !== undefined) return flip;
    }
    // §7.4's last resort for an enum: reverse the case. It stays inside the same
    // alphabet, so a site that maps unknown constants to a default still renders.
    const reversed = swapCase(value);
    if (differs(reversed)) return reversed;
  }

  const marked = value + TEXT_MARK;
  return differs(marked) ? marked : value + TEXT_MARK + TEXT_MARK.trim();
}

/** `ON_TIME` stays upper, `on_time` stays lower — the site may switch on either. */
function matchCase(sample, member) {
  return sample === sample.toLowerCase() ? member.toLowerCase() : member;
}

function swapCase(text) {
  return text.replace(/[A-Za-z]/g, (ch) =>
    ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()
  );
}

/**
 * The "~n" in §11's `probe.reloads(i, n)` — an ESTIMATE, which is why the copy hedges.
 *
 * Two control runs, then the bisection (a first batch test, then one test per halving),
 * then VERIFY_ON and VERIFY_OFF, then a third cycle when the user asked for one, then
 * the CLEANUP reload. §7.5 costs 12 candidates at "≈ 8 refreshes" by counting ~4
 * bisection reloads and no cleanup; this counts 5 and 1, so it lands two higher. The
 * view clamps it up to the real count if a run ever exceeds it — "refresh 9 of ~8" is a
 * smaller lie than a bar that finishes and keeps going.
 *
 * @param {number} count candidates in the queue @param {boolean} paranoid
 */
export function expectedReloads(count, paranoid) {
  const levels = Math.ceil(Math.log2(Math.max(2, count)));
  return 2 + (levels + 1) + 2 + (paranoid ? 1 : 0) + 1;
}

