/**
 * The one invariant PLAN.md §17.12 turns on, written once and used by every browser
 * suite that renders the panel.
 *
 * OWNER: panel-designer — this file only. `browserFixture.js` beside it is
 * probe-engineer's and `audit.js` is interceptor-engineer's; the three share a directory
 * and nothing else. (`node --test` executes every .js file under `test/`, so a helper
 * living there would be run as a suite with no tests; `testlib` is outside that glob and
 * is audited for §17.10 like any other file — see `audit.js`'s header.)
 *
 * ── What this replaces, and why it had to change shape ──────────────────────────
 * From M2 to M3 the panel suite asserted that §11's "Verified ✓" appeared NOWHERE in the
 * panel body. That was a real guard while nothing could be verified: no probe existed, so
 * every occurrence was a bug by construction. It was also load-bearing — it is the one
 * assertion standing between this product and the failure §17.12 calls the worst bug it
 * can have.
 *
 * At M4 the word becomes legitimate, and "it never appears" would have to be deleted.
 * Deleting a load-bearing guard when the thing it guards finally becomes possible is how
 * a product ships the bug it spent three milestones avoiding. So it changes shape into
 * the stronger statement, which is the one that was always meant:
 *
 *   the chip may appear ONLY on a Link whose own state is `verified`.
 *
 * Three independent facts have to agree for every single node that reads the word, and
 * they come from three different places in the render:
 *
 *   1. the WORD  — `S.chips[state]`, looked up by the Link's state;
 *   2. the CLASS — `chip--<state>`, which is what paints it green;
 *   3. `data-link-state` on the chip AND on the card containing it, written from the
 *      Binding's own `state` field.
 *
 * A render that hardcodes the word fails (1) against (2) and (3). A filter that widens
 * from `=== 'verified'` to anything looser fails the COUNT, which the caller supplies
 * from the fixture it fed in. Both are mutation-proved in `panel.probe.browser.test.js`.
 */
import assert from 'node:assert/strict';

/**
 * Every node in the document that READS as the verified chip, with the three facts that
 * have to agree about it. Runs inside the page — it must stay self-contained, because
 * Playwright ships it as source.
 *
 * Leaf nodes only (`children.length === 0`): a card whose whole text happens to end in
 * the chip's word is not itself a chip, and counting it would report one lie as two.
 *
 * @param {string} word `S.chips.verified` — passed in so this file holds no copy.
 */
export function readVerifiedChips(word) {
  const nodes = [...document.body.querySelectorAll('*')].filter(
    (node) => node.children.length === 0 && node.textContent.trim() === word
  );
  return nodes.map((node) => {
    const owner = node.parentElement && node.parentElement.closest('[data-link-state]');
    return {
      cls: String(node.className || ''),
      // The chip's own claim about the Link it describes…
      linkState: node.dataset.linkState === undefined ? null : node.dataset.linkState,
      // …and the claim of the card it was rendered into, written separately.
      ownerState: owner ? owner.dataset.linkState : null,
      where: node.parentElement ? String(node.parentElement.className || '') : ''
    };
  });
}

/**
 * @param {ReturnType<typeof readVerifiedChips>} chips what the page reported
 * @param {{expected:number, where:string}} about  how many the fixture entitles the
 *   screen to, and a name for the screen so a failure says which one
 */
export function assertVerifiedHonesty(chips, { expected, where }) {
  for (const chip of chips) {
    assert.equal(
      chip.linkState,
      'verified',
      `${where}: a "Verified ✓" chip describes a link in state ${JSON.stringify(chip.linkState)} ` +
        `(rendered in .${chip.where}). §17.12: the word may only ever be drawn for a link the ` +
        'probe proved.'
    );
    assert.ok(
      chip.cls.split(/\s+/).includes('chip--verified'),
      `${where}: a node reads "Verified ✓" but is painted as ${JSON.stringify(chip.cls)} — the word ` +
        'and the colour must come from the same datum, or one of them is decoration'
    );
    assert.equal(
      chip.ownerState,
      'verified',
      `${where}: a "Verified ✓" chip sits inside a card whose own link state is ` +
        `${JSON.stringify(chip.ownerState)}. Two independent writes of the same fact disagree.`
    );
  }
  assert.equal(
    chips.length,
    expected,
    `${where}: the screen draws ${chips.length} "Verified ✓" chips and the fixture entitles it to ` +
      `${expected}. A filter that stopped saying \`=== 'verified'\` shows up here first.`
  );
}
