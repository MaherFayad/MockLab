/**
 * Snapshot diffing (PLAN.md §7.3), the noise mask (§7.2) and inverse discovery (§7.6).
 *
 * OWNER: probe-engineer.
 *
 * This is the file that decides whether "the element changed", so it is the file a
 * false "Verified ✓" would come out of (§17.12). Everything below is a pure comparison
 * with no browser in it, which is exactly why it can be tested to exhaustion — and why
 * it should be.
 *
 * Two properties are asserted in BOTH directions everywhere: a difference must be
 * reported, and an equal pair must report nothing. A diff that always says "changed"
 * would pass every "it noticed" test in this file and would confirm every candidate the
 * probe ever tried.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXISTENCE,
  diffSnapshots,
  snapshotsEqual,
  toNodeMap,
  diffNodeMaps,
  buildNoiseMask,
  changedNodes
} from '../src/shared/diff.js';

/** A §7.3 snapshot, as `content/element.js` really produces one. */
const snap = (over = {}) => ({
  tag: 'div',
  text: 'On time',
  attrs: { id: 'status-pill', role: 'status' },
  cls: ['pill'],
  style: {
    color: 'rgb(30, 142, 62)',
    backgroundColor: 'rgb(230, 244, 234)',
    borderColor: 'rgb(0, 0, 0)',
    display: 'block',
    visibility: 'visible',
    opacity: '1'
  },
  childCount: 0,
  childTexts: [],
  ...over
});

/* ─────────────────────────────────────────────────────────── one element (§7.3) */

test('1 identical snapshots differ in nothing', () => {
  assert.deepEqual(diffSnapshots(snap(), snap()), []);
  assert.equal(snapshotsEqual(snap(), snap()), true);
});

test('2 the text is the difference the whole product is about', () => {
  assert.deepEqual(diffSnapshots(snap(), snap({ text: 'Cancelled' })), ['text']);
  assert.equal(snapshotsEqual(snap(), snap({ text: 'Cancelled' })), false);
});

test('3 a colour change with identical text is still a change', () => {
  // The demo's pill is the case: `ON_TIME` -> `BOARDING` keeps a label but not a colour,
  // and an enum -> colour mapping is §14's whole reason for existing.
  const recoloured = snap({ style: { ...snap().style, color: 'rgb(217, 48, 37)' } });
  assert.deepEqual(diffSnapshots(snap(), recoloured), ['style.color']);
});

test('4 an attribute added, removed or changed is named by key', () => {
  const added = snap({ attrs: { ...snap().attrs, 'aria-live': 'polite' } });
  assert.deepEqual(diffSnapshots(snap(), added), ['attrs.aria-live']);
  assert.deepEqual(diffSnapshots(added, snap()), ['attrs.aria-live']);
  const changed = snap({ attrs: { ...snap().attrs, role: 'alert' } });
  assert.deepEqual(diffSnapshots(snap(), changed), ['attrs.role']);
});

test('5 the class list is compared in order, and length counts', () => {
  assert.deepEqual(diffSnapshots(snap(), snap({ cls: ['pill', 'is-cancelled'] })), ['cls']);
  assert.deepEqual(diffSnapshots(snap({ cls: ['a', 'b'] }), snap({ cls: ['b', 'a'] })), ['cls']);
  assert.deepEqual(diffSnapshots(snap({ cls: ['a'] }), snap({ cls: ['a'] })), []);
});

test('6 child count and child texts are part of the element', () => {
  assert.deepEqual(diffSnapshots(snap(), snap({ childCount: 2 })), ['childCount']);
  assert.deepEqual(diffSnapshots(snap(), snap({ childTexts: ['Gate A17'] })), ['childTexts']);
});

test('7 every field that differs is reported, not just the first', () => {
  const other = snap({
    text: 'Cancelled',
    cls: ['pill', 'is-cancelled'],
    style: { ...snap().style, color: 'rgb(217, 48, 37)' }
  });
  assert.deepEqual(diffSnapshots(snap(), other), ['text', 'style.color', 'cls']);
});

test('8 a missing snapshot is a difference of its own, and two missing ones are not', () => {
  assert.deepEqual(diffSnapshots(null, snap()), [EXISTENCE]);
  assert.deepEqual(diffSnapshots(snap(), undefined), [EXISTENCE]);
  assert.deepEqual(diffSnapshots(null, null), []);
  assert.deepEqual(diffSnapshots(undefined, null), []);
});

test('9 an absent field and an empty one read the same, on purpose', () => {
  // `attrs` and `style` are built by iterating the live element, so a key is either
  // there with a value or not there at all. Treating "" and absent as different would
  // report a change every time a page dropped an empty attribute.
  assert.deepEqual(diffSnapshots(snap({ attrs: {} }), snap({ attrs: { id: '' } })), []);
  assert.deepEqual(diffSnapshots(snap({ text: '' }), { ...snap(), text: undefined }), []);
});

test('10 the field list is stable, so the same comparison always reads the same', () => {
  const a = snap({ attrs: { zeta: '1', alpha: '2' } });
  const b = snap({ attrs: { alpha: '9', zeta: '9' } });
  assert.deepEqual(diffSnapshots(a, b), ['attrs.alpha', 'attrs.zeta']);
  assert.deepEqual(diffSnapshots(a, b), diffSnapshots(a, b));
});

/* ───────────────────────────────────────────────────────── keyed page samples */

test('11 a node list, a map and an object all read as the same node map', () => {
  const list = [{ key: 'a', snapshot: snap() }];
  assert.equal(toNodeMap(list).get('a').text, 'On time');
  assert.equal(toNodeMap({ a: snap() }).get('a').text, 'On time');
  assert.equal(toNodeMap(toNodeMap(list)).get('a').text, 'On time');
  assert.equal(toNodeMap(null).size, 0);
  assert.equal(toNodeMap([{ snapshot: snap() }]).size, 0, 'a node with no key is not addressable');
});

test('12 appeared, vanished and changed are three different answers', () => {
  const before = [
    { key: 'pill', snapshot: snap() },
    { key: 'gone', snapshot: snap({ text: 'was here' }) }
  ];
  const after = [
    { key: 'pill', snapshot: snap({ text: 'Cancelled' }) },
    { key: 'banner', snapshot: snap({ text: 'Your flight was cancelled' }) }
  ];
  const result = diffNodeMaps(before, after);
  assert.deepEqual(result.changed, ['pill']);
  assert.deepEqual(result.appeared, ['banner']);
  assert.deepEqual(result.vanished, ['gone']);
  assert.deepEqual(result.fields.pill, ['text']);
  assert.deepEqual(result.fields.banner, [EXISTENCE]);
});

test('13 two identical samples produce three empty lists', () => {
  const sample = [{ key: 'pill', snapshot: snap() }];
  assert.deepEqual(diffNodeMaps(sample, sample), {
    changed: [], appeared: [], vanished: [], fields: {}
  });
});

/* ──────────────────────────────────────────────────── §7.2 — the noise mask */

test('14 the noise mask holds every node the two control runs disagree about', () => {
  const a = [
    { key: 'pill', snapshot: snap() },
    { key: 'tip', snapshot: snap({ text: 'Online check-in opens 24 hours before departure.' }) },
    { key: 'clock', snapshot: snap({ text: '12:40' }) }
  ];
  const b = [
    { key: 'pill', snapshot: snap() },
    { key: 'tip', snapshot: snap({ text: 'One cabin bag up to 7 kg travels free.' }) },
    { key: 'ad', snapshot: snap({ text: 'Members earn double points' }) }
  ];
  const mask = buildNoiseMask(a, b);
  assert.equal(mask.has('tip'), true, 'the rotating tip box changed by itself');
  assert.equal(mask.has('ad'), true, 'a node that appeared on one load only is noise');
  assert.equal(mask.has('clock'), true, 'and so is one that vanished');
  assert.equal(mask.has('pill'), false, 'the pill was identical on both loads');
  assert.equal(mask.size, 3);
});

test('15 a node absent from BOTH control runs is not masked — the demo banner', () => {
  // §16 M4's DoD needs the cancellation banner in `elements[]`. It has no text and
  // `display:none` until the status says otherwise, so it is in neither control sample.
  // Masking "absent" would make the probe blind to exactly the element it must find.
  const a = [{ key: 'pill', snapshot: snap() }];
  const b = [{ key: 'pill', snapshot: snap() }];
  const mask = buildNoiseMask(a, b);
  assert.equal(mask.has('banner'), false);
  assert.equal(mask.size, 0);

  const mutated = [
    { key: 'pill', snapshot: snap({ text: 'Cancelled' }) },
    { key: 'banner', snapshot: snap({ text: 'Your flight was cancelled' }) }
  ];
  assert.deepEqual(changedNodes(b, mutated, mask).keys, ['banner', 'pill']);
});

/* ─────────────────────────────────────────────── §7.6 — inverse discovery */

test('16 a masked node never counts as affected, however much it changed', () => {
  const control = [
    { key: 'pill', snapshot: snap() },
    { key: 'tip', snapshot: snap({ text: 'tip one' }) }
  ];
  const mutated = [
    { key: 'pill', snapshot: snap({ text: 'Cancelled' }) },
    { key: 'tip', snapshot: snap({ text: 'tip nine' }) }
  ];
  const { keys, fields } = changedNodes(control, mutated, new Set(['tip']));
  assert.deepEqual(keys, ['pill']);
  assert.deepEqual(Object.keys(fields), ['pill']);
});

test('17 the mask may arrive as any iterable, and an absent one masks nothing', () => {
  const control = [{ key: 'tip', snapshot: snap({ text: 'one' }) }];
  const mutated = [{ key: 'tip', snapshot: snap({ text: 'two' }) }];
  assert.deepEqual(changedNodes(control, mutated, ['tip']).keys, []);
  assert.deepEqual(changedNodes(control, mutated, undefined).keys, ['tip']);
  assert.deepEqual(changedNodes(control, mutated, new Set()).keys, ['tip']);
});

test('18 nothing changed means nothing is reported — the negative half', () => {
  const sample = [
    { key: 'pill', snapshot: snap() },
    { key: 'total', snapshot: snap({ text: 'SAR 450.00' }) }
  ];
  assert.deepEqual(changedNodes(sample, sample, new Set()).keys, []);
  // …and the same comparison with one field moved DOES report, so the emptiness above
  // is a fact about the samples rather than about the function.
  const moved = [sample[0], { key: 'total', snapshot: snap({ text: 'SAR 1357.00' }) }];
  assert.deepEqual(changedNodes(sample, moved, new Set()).keys, ['total']);
});
