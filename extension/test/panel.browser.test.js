/**
 * The side panel (PLAN.md §10), driven as a human drives it, in real Chromium with the
 * real unpacked extension and the real demo site (§14).
 *
 * OWNER: panel-designer. Added at M2 — an additive deviation from §2.1's file tree, for
 * the same reason `e2e.browser.test.js` was added at M1: every defect that mattered here
 * was invisible to unit tests. The §16 M2 DoD is a sequence of UI actions ending in a
 * red pill on a page the extension never touched directly, and the §1.1 honesty
 * guarantee is a chip that must say "Possible" and must never say "Verified ✓". Neither
 * can be asserted without a browser, and a guard CI cannot run is not a guard.
 *
 * Rules this file follows, both learned the hard way in M1:
 *   - it SKIPS, never fails, when Playwright or a Chromium build is absent, so
 *     `npm test -ws` stays green on a plain Node machine;
 *   - it resolves Playwright at run time and hardcodes no machine's path.
 *
 * Every expected string is imported from `../src/panel/strings.js`, so §17.6 holds here
 * too: this file cannot drift from §11's copy, because it has no copy of its own.
 *
 * All fixtures live in this one file on purpose — `node --test` executes EVERY .js file
 * under `test/`, so a shared helper module would be run as a test file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { S } from '../src/panel/strings.js';
import { createServer } from '../../companion/src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(HERE, '..');

/** The value the demo maps to a red pill and a banner (§14). */
const CANCELLED = 'CANCELLED';

/* ------------------------------------------------------- portable Playwright */

/**
 * Directories where a GLOBALLY installed package lives. A global install is not on this
 * workspace's resolution path, so a bare `import('playwright')` misses it. Every root
 * here is derived from the running Node — none is a path from one machine.
 */
function globalPackageRoots() {
  const roots = [];
  try {
    roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    /* npm is not on PATH — the other guesses still stand */
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

/* --------------------------------------------------------------- page helpers */

/** The demo's status pill, as the SITE renders it — never as MockLab reports it. */
function readPill(page) {
  return page.evaluate(() => {
    const pill = document.getElementById('status-pill');
    const banner = document.getElementById('alert-banner');
    return {
      text: pill ? pill.textContent.trim() : null,
      cls: pill ? pill.className : null,
      color: pill ? getComputedStyle(pill).color : null,
      bannerText: banner ? banner.textContent.trim() : null,
      bannerShown: banner ? getComputedStyle(banner).display !== 'none' : false
    };
  });
}

/** The card for one friendly source name (§10.2). */
function cardFor(panel, name) {
  return panel.locator('#source-list .card').filter({ hasText: name }).first();
}

/** A ROOT-level tree row — `$.status`, not `$.booking.status`. */
function rootRow(panel, text) {
  return panel.locator('#source-list .tree > .tree__group > .tree__row', { hasText: text }).first();
}

const chromium = await loadChromium();

if (!chromium) {
  test('panel browser suite', { skip: 'Playwright is not installed — `npm i -D playwright && npx playwright install chromium` enables it.' }, () => {});
} else {
  test('side panel — PLAN.md §10 and the §16 M2 definition of done', async (t) => {
    let server = null;
    let ctx = null;
    let profile = null;

    try {
      server = createServer();
      // Port 0: never collide with a companion the developer already has running.
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mocklab-panel-'));
      ctx = await chromium.launchPersistentContext(profile, {
        channel: 'chromium',
        args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`]
      });
    } catch (err) {
      // No Chromium build (or no sandbox to launch it in) is an ABSENT DEPENDENCY, not
      // a failing product. Same contract as the M1 suite: skip loudly, never fail.
      if (ctx) await ctx.close().catch(() => {});
      if (server) server.close();
      if (profile) fs.rmSync(profile, { recursive: true, force: true });
      t.skip(`Chromium could not be launched (${err && err.message}) — install it with \`npx playwright install chromium\`.`);
      return;
    }

    const demoUrl = `http://127.0.0.1:${server.address().port}/demo/`;
    const panelErrors = [];

    try {
      let [worker] = ctx.serviceWorkers();
      if (!worker) worker = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
      const extensionId = new URL(worker.url()).host;

      const demo = await ctx.newPage();
      await demo.goto(demoUrl, { waitUntil: 'networkidle' });

      const panel = await ctx.newPage();
      panel.on('pageerror', (err) => panelErrors.push(`pageerror: ${err.message}`));
      panel.on('console', (msg) => msg.type() === 'error' && panelErrors.push(msg.text()));
      await panel.setViewportSize({ width: 400, height: 900 });
      await panel.goto(`chrome-extension://${extensionId}/src/panel/panel.html`);

      // The panel reads the ACTIVE tab, exactly as it does when Chrome hosts it in the
      // side panel next to the page. Here it is an ordinary tab, so the demo has to be
      // brought forward or the panel would describe itself.
      await demo.bringToFront();
      await panel.waitForTimeout(800);
      await panel.click('label[for="tab-sources"]');
      await panel.waitForTimeout(600);

      await t.test('the typography is bundled, not fetched from a third party (§1.4)', async () => {
        const fonts = await panel.evaluate(async () => {
          await document.fonts.ready;
          return {
            faces: [...document.fonts].map((f) => `${f.family}/${f.weight}`),
            inter: document.fonts.check('600 14px Inter')
          };
        });
        assert.ok(fonts.inter, 'Inter should be available to the panel with no network');
        assert.ok(fonts.faces.includes('Inter/600'), `Inter 600 should be declared, got ${fonts.faces.join(', ')}`);
        assert.ok(fonts.faces.some((f) => f.startsWith('Fira Code')), 'Fira Code should be declared');
        const css = fs.readFileSync(path.join(EXTENSION_DIR, 'src/panel/panel.css'), 'utf8');
        assert.equal(/^\s*@import/m.test(css), false, 'panel.css must not @import a remote stylesheet');
      });

      await t.test('the Sources tab lists both demo sources with friendly names (§10.2)', async () => {
        const names = await panel.$$eval('#source-list .card__title .truncate', (nodes) => nodes.map((n) => n.textContent));
        assert.deepEqual([...names].sort(), ['Trip', 'User']);
        const meta = await cardFor(panel, 'Trip').locator('.card__meta').innerText();
        assert.ok(meta.includes(S.sources.fields(18)), `expected "${S.sources.fields(18)}" in "${meta}"`);
      });

      await t.test('a card opens the response tree, scalar rows offer both §10.2 actions', async () => {
        await cardFor(panel, 'Trip').locator('.card__head').click();
        await panel.waitForTimeout(700);
        const rows = await panel.locator('#source-list .tree__row').count();
        assert.ok(rows > 10, `expected a populated tree, got ${rows} rows`);
        const row = rootRow(panel, 'ON_TIME');
        const labels = await row.locator('button[aria-label]').evaluateAll((n) => n.map((b) => b.getAttribute('aria-label')));
        assert.ok(labels.includes(S.sources.changeValue), 'the ✏️ action must be present');
        assert.ok(labels.includes(S.sources.showOnPage), 'the ◎ action must be present');
      });

      await t.test('the editor says Possible, never Verified (§1.1, §10.6, §17.4)', async () => {
        await rootRow(panel, 'ON_TIME').locator(`button[aria-label="${S.sources.changeValue}"]`).click();
        await panel.waitForTimeout(500);

        const chips = await panel.$$eval('.editor .chip', (nodes) => nodes.map((n) => n.textContent.trim()));
        assert.deepEqual(chips, [S.chips.candidate], 'the editor carries exactly one chip, and it is Possible');

        const editorText = await panel.locator('.editor').innerText();
        assert.ok(editorText.includes(S.editor.unverified), '§11 editor.unverified must be on screen');
        assert.ok(editorText.includes(S.editor.original('ON_TIME')), 'the real value must be shown');

        // The whole product's credibility is this line: nothing anywhere in the panel
        // may claim a proven link before a probe has ever run (§0.2, §17.4).
        const everything = await panel.locator('body').innerText();
        assert.equal(
          everything.includes(S.chips.verified),
          false,
          `"${S.chips.verified}" must not appear anywhere before a probe has run`
        );
      });

      await t.test('apply & refresh: the SITE renders the new state, with no probe (§16 M2)', async () => {
        await panel.fill('#ml-value', CANCELLED);
        await panel.click('.editor__actions .btn--primary');
        await panel.waitForTimeout(2500);
        await demo.waitForLoadState('networkidle');

        const pill = await readPill(demo);
        assert.equal(pill.text, 'Cancelled');
        assert.ok(pill.cls.includes('is-cancelled'), `the site's own class should drive the pill, got "${pill.cls}"`);
        assert.equal(pill.color, 'rgb(217, 48, 37)');
        assert.equal(pill.bannerShown, true, 'the derived banner must appear too');
        assert.equal(pill.bannerText, 'Your flight was cancelled');

        // "with no probe" is the load-bearing half. §10.2 says an edit made from the tree
        // DOES record a link, and that link stays `candidate` — which is what feeds the
        // Possible chip the previous subtest asserted. §17.4 says only the probe's
        // CONFIRMED state may ever write `verified`, and no probe has run here.
        const bindings = await panel.evaluate(async () => {
          const bag = await chrome.storage.local.get(null);
          return Object.entries(bag)
            .filter(([key]) => key.startsWith('bindings:'))
            .flatMap(([, value]) => (Array.isArray(value) ? value : []));
        });
        for (const binding of bindings) {
          assert.notEqual(binding.state, 'verified', `no probe ran, so ${binding.path} must not be verified (§17.4)`);
        }
        const link = bindings.find((b) => b.path === '$.status');
        assert.ok(link, 'the edit should record the link it acted on');
        assert.equal(link.state, 'candidate');
        assert.deepEqual(link.elements, [], 'nothing was proven about which elements it drives');
        assert.equal(link.lastVerifiedAt, 0);
      });

      await t.test('the changed row shows real → new, and the site bar counts it (§10.2, §1.5)', async () => {
        await panel.waitForTimeout(600);
        const changed = await panel.locator('#source-list .tree__row--changed').first().innerText();
        assert.ok(changed.includes('ON_TIME'), 'the real value stays visible');
        assert.ok(changed.includes(CANCELLED), 'the new value is shown beside it');

        const bar = await panel.locator('#sitebar').innerText();
        assert.ok(bar.includes(S.site.changes(1)), `expected "${S.site.changes(1)}" in "${bar}"`);
        assert.ok(bar.includes(S.site.reset), 'Reset site appears once a change is active');

        const badge = await worker.evaluate(async (url) => {
          const [tab] = await chrome.tabs.query({ url: url + '*' });
          return tab ? chrome.action.getBadgeText({ tabId: tab.id }) : null;
        }, demoUrl);
        assert.equal(badge, '1', 'the toolbar badge mirrors the active-change count');
      });

      await t.test('the change survives 10 refreshes (§16 M2)', async () => {
        let survived = 0;
        for (let i = 0; i < 10; i += 1) {
          await demo.reload({ waitUntil: 'networkidle' });
          const pill = await readPill(demo);
          if (pill.text === 'Cancelled' && pill.cls.includes('is-cancelled')) survived += 1;
        }
        assert.equal(survived, 10);
      });

      await t.test('Reset site restores the real page (§1.5, §10)', async () => {
        await panel.click('#sitebar .btn--danger'); // asks first
        await panel.waitForTimeout(300);
        const confirming = await panel.locator('#sitebar').innerText();
        assert.ok(confirming.includes(S.site.resetConfirm), 'Reset site must confirm before it acts');

        await panel.click('#sitebar .btn--danger'); // confirms
        await panel.waitForTimeout(2500);
        await demo.waitForLoadState('networkidle');

        const pill = await readPill(demo);
        assert.equal(pill.text, 'On time');
        assert.equal(pill.bannerShown, false);

        const bar = await panel.locator('#sitebar').innerText();
        assert.equal(bar.includes(S.site.reset), false, 'the danger button hides itself at zero changes');
      });

      await t.test('all four status chips meet WCAG 2.2 AA in both themes (§16 M7)', async () => {
        for (const scheme of ['light', 'dark']) {
          await panel.emulateMedia({ colorScheme: scheme });
          await panel.waitForTimeout(150);
          const measured = await panel.evaluate((kinds) => {
            const host = document.createElement('div');
            for (const kind of kinds) {
              const chip = document.createElement('span');
              chip.className = `chip chip--${kind}`;
              chip.textContent = kind;
              host.append(chip);
            }
            document.body.append(host);
            // color(srgb r g b) reports 0..1 components; rgb()/rgba() reports 0..255.
            const parse = (value) => {
              const n = value.match(/[\d.]+/g).map(Number);
              const scale = value.startsWith('color(') ? 255 : 1;
              return [n[0] * scale, n[1] * scale, n[2] * scale, n.length > 3 ? n[3] : 1];
            };
            const channel = (c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : Math.pow((c / 255 + 0.055) / 1.055, 2.4));
            const lum = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
            const flatten = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
            const page = parse(getComputedStyle(document.body).backgroundColor);
            const out = {};
            for (const chip of host.children) {
              const style = getComputedStyle(chip);
              const bg = flatten(parse(style.backgroundColor), page);
              const fg = flatten(parse(style.color), [...bg, 1]);
              const a = lum(fg);
              const b = lum(bg);
              out[chip.textContent] = Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
            }
            host.remove();
            return out;
          }, ['verified', 'candidate', 'stale', 'changed']);

          for (const [kind, ratio] of Object.entries(measured)) {
            assert.ok(ratio >= 4.5, `${scheme} ${kind} chip is ${ratio}:1, below WCAG 2.2 AA 1.4.3 (4.5:1)`);
          }
        }
        await panel.emulateMedia({ colorScheme: 'light' });
      });

      await t.test('the panel logged nothing to the console the whole way through', () => {
        assert.deepEqual(panelErrors, []);
      });
    } finally {
      if (ctx) await ctx.close().catch(() => {});
      if (server) server.close();
      if (profile) fs.rmSync(profile, { recursive: true, force: true });
    }
  });
}
