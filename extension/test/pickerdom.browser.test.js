/**
 * `picker.js`'s DOM logic, measured by real Chromium (PLAN.md §6.1, §6.2, §7.3).
 *
 * OWNER: probe-engineer. Split from `picker.browser.test.js` under §17.10.
 *
 * The split is not only about length. These subtests need NO extension: they load the
 * very same `src/content/element.js` and `src/content/picker.js` off disk into an
 * ordinary page and call their exports, which is the only way to reach code that
 * otherwise lives in an extension's isolated world. `picker.browser.test.js` is the
 * other half — the genuine panel -> worker -> content-script flow, and the §16 M3 DoD.
 *
 * They belong in a browser and not in a DOM shim because every rule they check is a
 * MEASUREMENT: §6.1's 1.4x area ratio, §6.2's `querySelectorAll(...).length === 1`
 * uniqueness, §7.3's computed colours. A fake DOM would answer whatever it was written
 * to answer.
 *
 * Skips (never fails) when Playwright or a Chromium build is unavailable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ELEMENT_JS = path.resolve(HERE, '..', 'src', 'content', 'element.js');
const PICKER_JS = path.resolve(HERE, '..', 'src', 'content', 'picker.js');

/** Same derivation as the other browser suites: a global install is off this path. */
function globalPackageRoots() {
  const roots = [];
  try {
    roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    /* npm is not on PATH */
  }
  roots.push(path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules'));
  for (const entry of String(process.env.NODE_PATH || '').split(path.delimiter)) {
    if (entry) roots.push(entry);
  }
  return [...new Set(roots.filter(Boolean))];
}

async function loadChromium() {
  for (const name of ['playwright', 'playwright-core']) {
    try {
      const mod = await import(name);
      if (mod && mod.chromium) return mod.chromium;
    } catch {
      /* not installed locally */
    }
  }
  for (const root of globalPackageRoots()) {
    for (const name of ['playwright', 'playwright-core']) {
      for (const entry of ['index.mjs', 'index.js']) {
        const file = path.join(root, name, entry);
        if (!fs.existsSync(file)) continue;
        try {
          const mod = await import(pathToFileURL(file).href);
          const chromium = (mod && mod.chromium) || (mod && mod.default && mod.default.chromium);
          if (chromium) return chromium;
        } catch {
          /* try the next candidate */
        }
      }
    }
  }
  return null;
}

/**
 * The demo's status pill, READ from the demo rather than copied into this file. A copy
 * is what went wrong before: one row of the walk table below said `5px 12px` while the
 * demo says `padding: 0.3125rem 0.875rem` (5px 14px), so its label ("the demo's own
 * pill CSS") was false and its ratio (2.57x) was a number about nothing.
 */
const DEMO_INDEX = path.resolve(HERE, '..', '..', 'companion', 'src', 'demo', 'index.html');

function demoPillGeometry() {
  const css = fs.readFileSync(DEMO_INDEX, 'utf8');
  const block = /#status-pill\s*\{([^}]*)\}/.exec(css);
  assert.ok(block, `#status-pill is no longer a rule in ${DEMO_INDEX}`);
  const value = (prop) => {
    const found = new RegExp(prop + ':\\s*([^;}]+)').exec(block[1]);
    assert.ok(found, `the demo's #status-pill no longer sets ${prop}`);
    return found[1].trim().split(/\s+/).map((token) => {
      const rem = /^([\d.]+)rem$/.exec(token);
      const px = /^([\d.]+)px$/.exec(token);
      assert.ok(rem || px, `#status-pill's ${prop} is "${token}" — this file reads rem and px only`);
      return `${rem ? Number(rem[1]) * 16 : Number(px[1])}px`;
    }).join(' ');
  };
  return { padding: value('padding'), fontSize: value('font-size') };
}

/**
 * One page, served over http so it has a real origin and a real layout. The pill is
 * padded by 1px/4px — 1.24x its inner span, just inside §6.1's 1.4x budget; the walk
 * subtest moves that padding around to prove the ratio is measured, not assumed.
 *
 * The pill's two colours are the demo's own status colours (`--ok-fg` #1E8E3E on
 * `--ok-bg` #E6F4EA, `--bad-fg` #D93025 on `--bad-bg` #FDECEA in
 * `companion/src/demo/index.html`), applied through a CLASS exactly as the demo applies
 * them, because that is the only thing §7.3's `style` block exists to catch: a status
 * change that repaints an element without touching a character of its text.
 */
const LOGIC = `<!doctype html><html><head><meta charset="utf-8"><title>logic</title><style>
  body{margin:0;font:16px system-ui}
  .pill{display:inline-block;padding:1px 4px;background:#E6F4EA;color:#1E8E3E}
  .pill.is-cancelled{background:#FDECEA;color:#D93025}
  .row{display:block;width:400px;height:120px}
</style></head><body>
  <main>
    <div class="row"><div class="pill" id="status-pill"><span class="txt">On time</span></div></div>
    <div class="row"><span data-testid="price">SAR 450.00</span></div>
    <div class="row"><span id="react-1234">Auto id</span><span aria-label="Seat map">◧</span></div>
    <div class="row"><p class="dup">Repeated</p><p class="dup">Repeated</p></div>
    <!-- The wrapper is only ~1.06x its first child, so ONLY the same-text half of
         §6.1's rule can stop the walk here. -->
    <div class="row"><span class="wrap"><span class="a">On time</span><span>.</span></span></div>
    <!-- Same text, but a whole row: 40x its child and 340px past it on one side. Must
         stay blocked by BOTH halves of the rule. -->
    <div class="bigrow" style="display:block;width:400px;height:120px"><span class="small">On time</span></div>
    <!-- A large child with 30px of padding: 1.27x by area (the ratio accepts it) but
         30px past on every side (the inset does not). Only the ratio half can pass this. -->
    <div class="pad30" style="display:inline-block;padding:30px"><span class="wide" style="display:inline-block;width:600px;height:400px">On time</span></div>
  </main>
</body></html>`;

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

const chromium = await loadChromium();

if (!chromium) {
  test('picker DOM-logic browser suite', { skip: 'Playwright is not installed — `npm i -D playwright && npx playwright install chromium` enables it.' }, () => {});
} else {
  test('picker.js against real Chromium layout', async (t) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(LOGIC);
    });
    const origin = `http://127.0.0.1:${await listen(server)}`;

    let browser = null;
    try {
      browser = await chromium.launch();
    } catch (err) {
      server.close();
      t.skip(`Chromium could not be launched (${err.message.split('\n')[0]})`);
      return;
    }
    const ctx = await browser.newContext();

    try {
    await t.test('§6.2 fingerprints, and §6.2 re-resolution after a reload', async () => {
      const page = await ctx.newPage();
      await page.goto(origin + '/logic?case=fingerprint', { waitUntil: 'load' });
      await page.addScriptTag({ path: ELEMENT_JS });

      const api = (fn, ...args) =>
        page.evaluate(([name, list]) => {
          const picker = window.__mocklabElement;
          const el = (sel) => document.querySelector(sel);
          const argv = list.map((a) => (typeof a === 'string' && a.startsWith('sel:') ? el(a.slice(4)) : a));
          const out = picker[name](...argv);
          return out && out.nodeType ? { css: out.id || out.className, tag: out.tagName.toLowerCase() } : out;
        }, [fn, args]);

      assert.equal((await api('fingerprint', 'sel:[data-testid=price]')).css, '[data-testid="price"]',
        '§6.2 prefers a test hook above everything');
      const pill = await api('fingerprint', 'sel:#status-pill');
      assert.equal(pill.css, '#status-pill', 'then a non-generated id');
      assert.equal(pill.textAnchor, 'On time');
      assert.deepEqual(pill.attrAnchors, ['id=status-pill']);
      assert.ok(pill.treePath.length >= 3, `a tree path back to <body>, got ${JSON.stringify(pill.treePath)}`);

      assert.equal((await api('fingerprint', 'sel:#react-1234')).css.startsWith('#'), false,
        '§6.2 rejects a generated-looking id');
      assert.equal((await api('fingerprint', 'sel:[aria-label="Seat map"]')).css, 'span[aria-label="Seat map"]');
      const dup = await api('fingerprint', 'sel:.dup');
      assert.ok(dup.css.startsWith('body >'), `a non-unique class falls through to structure, got ${dup.css}`);
      assert.equal(await page.evaluate((css) => document.querySelectorAll(css).length, dup.css), 1,
        'and the structural selector it produced is genuinely unique');

      // §6.2's re-resolution ladder, all three rungs.
      const resolve = (fp) => page.evaluate((f) => {
        const out = window.__mocklabElement.resolveFingerprint(f);
        return { confidence: out.confidence, id: out.element ? out.element.id || out.element.textContent : null };
      }, fp);

      assert.deepEqual(await resolve(pill), { confidence: 1, id: 'status-pill' }, 'css hit -> 1.0');
      assert.deepEqual(
        await resolve({ ...pill, css: '#gone-after-a-redeploy' }),
        { confidence: 0.8, id: 'status-pill' },
        '§6.2: no selector match falls back to the text anchor at 0.8'
      );
      const byTree = await resolve({ css: '#gone', textAnchor: 'nothing renders this', treePath: pill.treePath });
      assert.equal(byTree.confidence, 0.5, '§6.2: last resort is the tree path at 0.5');
      assert.equal(byTree.id, 'status-pill');
      assert.deepEqual(
        await resolve({ css: '#gone', textAnchor: 'nothing renders this', treePath: [9, 9, 9] }),
        { confidence: 0, id: null },
        'and when all three fail it says so — a probe must abort, never diff the wrong element'
      );

      // Two elements share the text: the closest tree path wins, not the first found.
      // The precondition is asserted, not assumed — `assert.ok(evaluate(() => true))`
      // proved only that Playwright can return a literal.
      const dupSetup = await page.evaluate(() => {
        const nodes = document.querySelectorAll('.dup');
        nodes[1].id = 'second-dup';
        return { count: nodes.length, texts: Array.from(nodes, (n) => n.textContent.trim()) };
      });
      assert.deepEqual(dupSetup, { count: 2, texts: ['Repeated', 'Repeated'] },
        'the fixture really does render the same text twice, which is what makes the next line a test');
      const dupFp = await api('fingerprint', 'sel:#second-dup');
      const moved = await resolve({ ...dupFp, css: '#not-here' });
      assert.equal(moved.confidence, 0.8);
      assert.equal(moved.id, 'second-dup', 'the same text twice resolves by tree-path proximity');
      await page.close();
    });

    await t.test('§6.1 the smart walk stops where the meaning stops', async () => {
      const page = await ctx.newPage();
      await page.goto(origin + '/logic?case=walk', { waitUntil: 'load' });
      await page.addScriptTag({ path: ELEMENT_JS });

      const walk = (selector) =>
        page.evaluate((sel) => {
          const from = document.querySelector(sel);
          const to = window.__mocklabElement.smartTarget(from);
          const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };
          return { to: to.className || to.tagName.toLowerCase(), grew: area(to) / area(from) };
        }, selector);

      /** Area of `parent` over area of `child`, whatever the walk decided to do. */
      const ratioOf = (parentSel, childSel) =>
        page.evaluate(([p2, c2]) => {
          const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };
          return area(document.querySelector(p2)) / area(document.querySelector(c2));
        }, [parentSel, childSel]);

      const up = await walk('.txt');
      assert.equal(up.to, 'pill', 'the inner span resolves to the pill that wraps it');
      assert.ok(up.grew > 1.1, `and the walk actually moved (area ratio ${up.grew.toFixed(2)})`);
      assert.ok(up.grew <= 1.4, `inside §6.1's budget (${up.grew.toFixed(2)}x)`);

      // §6.1's area ratio alone is a TIGHT budget on a short word: "On time" is about
      // 64x19 px at 16px, so 1.4x allows a parent roughly 500 px² — 1 px of vertical and
      // 5 px of horizontal padding. Every realistically styled pill blows past it, which
      // is why the rule is ADDITIVE: ratio <= 1.4 OR within 24 px on every side. The
      // table is the evidence — the middle two rows are accepted ONLY by the inset half —
      // and its `ratio` column is measured here, so no number in it is unchecked prose.
      //
      // Row 3 is SYNTHETIC and says so. It has the geometry of the demo's status pill
      // (read above off `companion/src/demo/index.html`), but it is not the demo
      // measured in operation: `renderStatus` in demo/app.js fills that pill with
      // `textContent`, so the real pill has NO child element and the smart walk never
      // runs on it on the DoD path at all (`picker.browser.test.js` asserts
      // `childCount === 0`). The row measures what the demo's padding would cost the
      // ratio if that label were wrapped in a span: 2.71x. The demo also sets
      // `font-weight: 700` and `letter-spacing: 0.01em`, which widen the text and bring
      // the same padding to ~2.60x; both are far past 1.4x, the only thing the rule
      // turns on.
      //
      // Text width is the one thing a different machine changes, so the ratios carry a
      // tolerance — deliberately NOT the guard on row 3's geometry, since 12px vs 14px
      // of padding moves the ratio by only 0.14 and any tolerance loose enough for a
      // font would hide it. What pins row 3 to the demo is that its padding IS the
      // demo's, read off disk.
      const RATIO_TOLERANCE = 0.25;
      const demoPill = demoPillGeometry();
      assert.deepEqual(demoPill, { padding: '5px 14px', fontSize: '12px' },
        `the 2.71x below was measured for the demo's pill; the demo now renders ${JSON.stringify(demoPill)}, so remeasure that row (and README Deviation 30) before touching this line`);
      const cases = [
        ['40px 120px', '16px', 'txt', null, 'a 120 px inset is not a pill by any measure (~24.8x here)'],
        ['6px 14px', '16px', 'pill', 2.35, 'a normal pill: 14 px by inset'],
        [demoPill.padding, demoPill.fontSize, 'pill', 2.71, "the demo's pill geometry, synthetically wrapped: 14 px by inset"],
        ['1px 4px', '16px', 'pill', 1.24, 'and §6.1\'s literal ratio still fires where it always did']
      ];
      for (const [padding, fontSize, expected, ratio, why] of cases) {
        await page.evaluate(([pad, size]) => {
          const pill = document.querySelector('.pill');
          pill.style.padding = pad;
          pill.style.fontSize = size;
        }, [padding, fontSize]);
        const result = await walk('.txt');
        // `result.grew` is the ratio of what the walk CHOSE to what it started from, so
        // it is 1.00 whenever the walk refused to move. The claim in the table is about
        // the pill either way, so measure the pill either way.
        const area = await ratioOf('.pill', '.txt');
        assert.equal(result.to, expected, `padding ${padding} @${fontSize}: ${why} (pill is ${area.toFixed(2)}x its span)`);
        if (ratio === null) {
          assert.ok(area > 10, `padding ${padding} is nowhere near any budget (${area.toFixed(2)}x)`);
        } else {
          assert.ok(Math.abs(area - ratio) <= RATIO_TOLERANCE,
            `padding ${padding} @${fontSize} measures ${area.toFixed(2)}x, and this file claims ${ratio}x`);
        }
        if (expected === 'pill' && padding !== '1px 4px') {
          assert.ok(area > 1.4, `and §6.1's ratio alone would have refused it (${area.toFixed(2)}x)`);
        }
      }
      await page.evaluate(() => {
        const pill = document.querySelector('.pill');
        pill.style.padding = '1px 4px';
        pill.style.fontSize = '16px';
      });

      // Each of the four sides is load-bearing. 60 px on ONE side, 4 px on the other
      // three: the area ratio is far past 1.4x, so only that one side's term can refuse
      // it. Without this loop, deleting a side from the inset test fails nothing.
      for (const [side, padding] of [
        ['top', '60px 4px 4px 4px'],
        ['right', '4px 60px 4px 4px'],
        ['bottom', '4px 4px 60px 4px'],
        ['left', '4px 4px 4px 60px']
      ]) {
        await page.evaluate((value) => { document.querySelector('.pill').style.padding = value; }, padding);
        const result = await walk('.txt');
        assert.equal(result.to, 'txt', `60 px of ${side} padding is past the 24 px inset (area ${result.grew.toFixed(2)}x)`);
      }
      await page.evaluate(() => { document.querySelector('.pill').style.padding = '1px 4px'; });

      // The inset half must not become a way to climb into a container. Same text,
      // ~40x the area and ~340 px past its child on one side: still refused. Both
      // numbers are measured, because a `.bigrow` that quietly became pill-sized would
      // pass the line below while testing nothing.
      assert.equal((await walk('.small')).to, 'small', 'a whole row is never the semantic element');
      const bigrow = await page.evaluate(() => {
        const row = document.querySelector('.bigrow').getBoundingClientRect();
        const small = document.querySelector('.small').getBoundingClientRect();
        return { ratio: (row.width * row.height) / (small.width * small.height), past: row.right - small.right };
      });
      assert.ok(bigrow.ratio > 20, `the row really is many times its child (${bigrow.ratio.toFixed(1)}x)`);
      assert.ok(bigrow.past > 24, `and reaches ${bigrow.past.toFixed(0)} px past it, well outside the 24 px inset`);

      // …and the ratio half is not redundant: a big element with 30 px of padding is
      // only ~1.27x by area but 30 px past on every side, so ONLY the ratio accepts it.
      // This one is pure geometry (a fixed 600x400 child), so the number is exact.
      const wide = await walk('.wide');
      assert.equal(wide.to, 'pad30', 'the area ratio still accepts what the inset refuses');
      assert.ok(wide.grew <= 1.4, `by ratio (${wide.grew.toFixed(2)}x), not by inset (30 px > 24 px)`);
      assert.ok(wide.grew > 1.2 && wide.grew < 1.35, `and this file's "~1.27x" is the measured value (${wide.grew.toFixed(2)}x)`);

      // Same text is the other half of the rule, and it has to be tested where the
      // area rule is NOT also blocking — otherwise deleting the text check changes
      // nothing and the assertion proves nothing.
      const sibling = await walk('.a');
      assert.equal(sibling.to, 'a', 'a parent whose text differs is never selected, however small the growth');
      assert.ok(sibling.grew === 1, 'the walk did not move at all');
      const ratio = await page.evaluate(() => {
        const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };
        return area(document.querySelector('.wrap')) / area(document.querySelector('.a'));
      });
      assert.ok(ratio < 1.4, `and the area rule would have allowed it (${ratio.toFixed(2)}x) — only the text stopped it`);
      assert.equal((await walk('.pill')).to, 'pill', 'nor is a much larger row');
      await page.close();
    });

    await t.test('§6.1 the walk is capped at 4 levels', async () => {
      const page = await ctx.newPage();
      await page.goto(origin + '/logic?case=cap', { waitUntil: 'load' });
      await page.addScriptTag({ path: ELEMENT_JS });
      const depth = await page.evaluate(() => {
        // Ten nested wrappers, each the same text and the same size as its child.
        let html = '<span id="deep">Deep</span>';
        for (let i = 0; i < 10; i += 1) html = '<span class="w' + i + '">' + html + '</span>';
        document.querySelector('main').insertAdjacentHTML('beforeend', '<div id="nest">' + html + '</div>');
        const from = document.getElementById('deep');
        const to = window.__mocklabElement.smartTarget(from);
        let levels = 0;
        for (let node = from; node && node !== to; node = node.parentElement) levels += 1;
        return levels;
      });
      assert.equal(depth, 4, '§6.1 caps the walk at 4 levels even when every parent qualifies');
      await page.close();
    });

    /**
     * §6.1: "All listeners use {capture:true} and are removed on exit."
     *
     * The behavioural check in subtest 3 cannot prove this on its own — every handler
     * starts with `if (!picking) return`, so a LEAKED listener still lets the page
     * behave normally and the test stays green. (Verified by mutation: deleting the
     * removeEventListener calls fails nothing else in this file.) So the bookkeeping
     * is audited directly: every add is recorded, every remove is matched against it,
     * and anything left over is a leak.
     */
    await t.test('§6.1 every listener is capture-phase, and every one comes off', async () => {
      const page = await ctx.newPage();
      await page.addInitScript(() => {
        window.__ml = { adds: [], removes: [] };
        const add = EventTarget.prototype.addEventListener;
        const remove = EventTarget.prototype.removeEventListener;
        const capture = (opts) => opts === true || Boolean(opts && opts.capture);
        EventTarget.prototype.addEventListener = function (type, fn, opts) {
          if (this === window || this === document) window.__ml.adds.push({ type, fn, capture: capture(opts) });
          return add.call(this, type, fn, opts);
        };
        EventTarget.prototype.removeEventListener = function (type, fn, opts) {
          if (this === window || this === document) window.__ml.removes.push({ type, fn, capture: capture(opts) });
          return remove.call(this, type, fn, opts);
        };
      });
      await page.goto(origin + '/logic?case=listeners', { waitUntil: 'load' });
      await page.addScriptTag({ path: ELEMENT_JS });
      await page.addScriptTag({ path: PICKER_JS });

      // The page, the real extension's own agent and Playwright all register
      // listeners of their own, so only what happens BETWEEN start and cancel counts.
      const during = await page.evaluate(() => {
        window.__ml.base = window.__ml.adds.length;
        window.__mocklabPicker.start(() => {});
        const mine = window.__ml.adds.slice(window.__ml.base);
        return { types: mine.map((a) => a.type).sort(), bubble: mine.filter((a) => !a.capture).map((a) => a.type) };
      });
      assert.ok(during.types.length >= 5, `pick mode registered ${during.types.length} listeners`);
      assert.deepEqual(during.bubble, [], '§6.1: every listener uses {capture:true}');
      for (const type of ['mousemove', 'click', 'keydown', 'scroll', 'mousedown']) {
        assert.ok(during.types.includes(type), `pick mode listens for ${type}`);
      }

      const leaked = await page.evaluate(() => {
        window.__mocklabPicker.cancel();
        return window.__ml.adds
          .slice(window.__ml.base)
          .filter((a) => !window.__ml.removes.some((r) => r.fn === a.fn && r.type === a.type && r.capture === a.capture))
          .map((a) => a.type);
      });
      assert.deepEqual(leaked, [], 'and every single one is removed on exit');
      await page.close();
    });

    await t.test('§7.3 the snapshot records what a rendered element looks like', async () => {
      const page = await ctx.newPage();
      await page.goto(origin + '/logic?case=snapshot', { waitUntil: 'load' });
      await page.addScriptTag({ path: ELEMENT_JS });
      const snap = await page.evaluate(() => {
        const row = document.querySelector('.row');
        row.setAttribute('data-x', '1');
        return window.__mocklabElement.snapshotElement(row);
      });
      assert.equal(snap.tag, 'div');
      assert.equal(snap.text, 'On time');
      assert.deepEqual(snap.cls, ['row']);
      assert.deepEqual(snap.attrs, { 'data-x': '1' }, 'every attribute except style and class');
      assert.equal(snap.childCount, 1);
      assert.deepEqual(snap.childTexts, ['On time']);
      assert.deepEqual(
        Object.keys(snap.style).sort(),
        ['backgroundColor', 'borderColor', 'color', 'display', 'opacity', 'visibility'],
        '§7.3 records exactly the six computed properties it names — no more, and none missing'
      );
      assert.equal(snap.style.display, 'block', 'and they are this element\'s values, not defaults');

      /**
       * What this subtest is FOR, written so it can fail. §7.3's `style` block is the
       * only way an M4 diff sees the demo's central behaviour: `status: "CANCELLED"`
       * repaints the pill through a CLASS. A snapshot reading the inline `style`
       * attribute instead of `getComputedStyle` would record "" for all six properties
       * on a stylesheet-painted element, and the probe would call a repainted element
       * unchanged — a missed link, or worse, a wrong one. So: the pill has no inline
       * style, and the snapshot still reports the colours its stylesheet rule paints.
       * (The line that stood here was `assert.equal(snap.style.color, cond ?
       * snap.style.color : snap.style.color)` — both branches the same expression, on
       * `.row`, whose colour is inherited black and never was the green it named.)
       */
      const pill = await page.evaluate(() => ({
        inline: document.querySelector('.pill').getAttribute('style'),
        snap: window.__mocklabElement.snapshotElement(document.querySelector('.pill'))
      }));
      assert.equal(pill.inline, null, 'the pill is painted by a stylesheet rule, with no inline style to read');
      assert.equal(pill.snap.style.color, 'rgb(30, 142, 62)',
        "§7.3 records the COMPUTED colour — the demo's --ok-fg green, which exists nowhere on the element itself");
      assert.equal(pill.snap.style.backgroundColor, 'rgb(230, 244, 234)', 'and the computed background (--ok-bg)');
      assert.equal(pill.snap.style.borderColor, 'rgb(30, 142, 62)', 'borderColor resolves through currentColor');
      assert.equal(pill.snap.style.opacity, '1');
      assert.equal(pill.snap.style.visibility, 'visible');

      // And the colour is not merely recorded, it is DIFFERENTIABLE: the demo's
      // ON_TIME -> CANCELLED path swaps a class and leaves the text alone.
      const cancelled = await page.evaluate(() => {
        const el = document.querySelector('.pill');
        el.classList.add('is-cancelled');
        return window.__mocklabElement.snapshotElement(el);
      });
      assert.equal(cancelled.text, pill.snap.text, 'the same text …');
      assert.equal(cancelled.style.color, 'rgb(217, 48, 37)', '… a different colour (--bad-fg) …');
      assert.equal(cancelled.style.backgroundColor, 'rgb(253, 236, 234)', '… on a different background (--bad-bg) …');
      assert.notDeepEqual(cancelled.style, pill.snap.style, '… so §7.3 can tell the two states apart');

      const long = await page.evaluate(() => {
        const el = document.createElement('div');
        el.textContent = 'x'.repeat(500);
        for (let i = 0; i < 9; i += 1) el.appendChild(document.createElement('span'));
        document.body.appendChild(el);
        return window.__mocklabElement.snapshotElement(el);
      });
      assert.equal(long.text.length, 300, '§7.3 caps the text at 300 characters');
      assert.equal(long.childCount, 9);
      assert.equal(long.childTexts.length, 5, 'and records the first 5 children');
      await page.close();
    });
    } finally {
      await browser.close().catch(() => {});
      server.close();
    }
  });
}
