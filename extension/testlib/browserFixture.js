/**
 * The harness the four browser suites share: find a Chromium, launch the REAL unpacked
 * extension, and run a fixture whose every check reports whatever happens to it.
 *
 * OWNER: probe-engineer — this file only. `audit.js` beside it belongs to
 * interceptor-engineer and is a different thing entirely (it reads source; this drives a
 * browser). They share a directory, not a subject.
 *
 * WHY THIS DIRECTORY: `node --test` treats EVERY .js file under a directory called
 * `test` as a test file, so a helper module living there would be executed as a suite
 * containing no tests — which is why all four suites carried their own copy of
 * `loadChromium` for three milestones (README Deviations 15, 22, 27 each state that
 * reason). `testlib` is outside that glob and no file in it may be named `test-*.js`.
 * `audit.js`'s header carries the fuller note, including why a helper directory is not a
 * blind spot: the §17.10 line audit and the ISOLATED-world global scan both derive their
 * file lists from the root `package.json`'s workspaces, so this file is audited like any
 * other the day it appears.
 *
 * ── WHAT `createFixture` IS FOR ─────────────────────────────────────────────────────
 *
 * A real run once showed `# tests 211 # pass 210 # fail 1`: an outer fixture died and
 * took 22 subtests out of the totals without a word, and CI displayed a green-looking
 * "210 pass". Nothing was wrong with the assertions; they simply never ran, and the only
 * thing that noticed was somebody's memory of a larger number (README Deviation 45).
 *
 * So a fixture built here has two properties, and they are the whole point:
 *
 *   1. Every check REPORTS. However the fixture ends, `check()` contributes exactly one
 *      test — passed, failed, or skipped — so a suite's contribution to `# tests` is a
 *      constant. A dead fixture can no longer subtract subtests from a total.
 *   2. A failure says WHICH STAGE and HOW LONG it waited, and distinguishes an absent
 *      dependency from a defect. A 20 s service-worker timeout reported as "Chromium
 *      could not be launched" sends whoever reads CI to check whether a browser is
 *      installed — a genuine failure wearing an environment gap's clothes. Only a stage
 *      declared `{ absent: … }` may skip; every other stage fails, loudly, by name.
 *
 * Stage budgets are enforced here rather than left to Playwright's defaults so that a
 * stage with no timeout of its own (opening a page, awaiting an event) cannot hang the
 * run silently. Honest limit, unchanged from where this code came from: the budget makes
 * a hung stage LEGIBLE, not fast — an abandoned stage still holds the event loop until
 * Playwright's own promise settles.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The extension workspace root — the directory Chromium is told to load unpacked, and
 * the root every suite resolves its own source paths from.
 *
 * Derived here rather than imported from `audit.js`: that module is the source-reading
 * apparatus for the guards, and a browser harness that imports it would couple two files
 * that have nothing to say to each other. One `path.resolve` is the cheaper duplication.
 */
export const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------- Playwright lookup */

/**
 * Directories where a GLOBALLY installed package lives. A global install is not on this
 * workspace's resolution path, so a bare `import('playwright')` misses it — which is why
 * an early version of one suite carried an absolute path from one machine. That path
 * would have shipped and resolved nowhere for anyone else; every root here is derived at
 * run time from the running Node.
 */
function globalPackageRoots() {
  const roots = [];
  try {
    roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    /* npm is not on PATH — the other guesses still stand */
  }
  // node lives at <prefix>/bin/node; global packages at <prefix>/lib/node_modules.
  roots.push(path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules'));
  for (const entry of String(process.env.NODE_PATH || '').split(path.delimiter)) {
    if (entry) roots.push(entry);
  }
  return [...new Set(roots.filter(Boolean))];
}

/**
 * Playwright's `chromium`, from wherever this machine happens to keep it, or `null`.
 *
 * Null is not a failure: Playwright is deliberately not a declared dependency of either
 * workspace (README Deviation 40), so `npm test -ws` has to stay green on a machine that
 * only has Node. Each suite answers a null by registering ONE skipped test, and the CI
 * browser job is what makes sure that path is never the one CI takes (Deviation 41).
 */
export async function loadChromium() {
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
 * A persistent context with the genuine unpacked extension loaded — the launch line
 * every suite that drives the real product needs, written once so the two flags cannot
 * drift apart between files.
 */
export function launchExtension(chromium, profileDir) {
  return chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`]
  });
}

/* --------------------------------------------------------------------- the fixture */

/**
 * @typedef {Object} Fixture
 * @property {(name: string, budgetMs: number, run: Function, options?: {absent?: string}) => Promise<any>} stage
 * @property {(name: string, budgetMs: number, run: Function) => Promise<{value: any, why: string|null}>} optional
 * @property {(name: string, fn: Function) => Promise<any>} check
 * @property {string[]} timeline
 */

/**
 * Build the setup-and-report machinery for one outer test.
 *
 * The intended shape, and the reason `stage` throws rather than returning a flag: the
 * setup is one `try` whose `catch` needs no logic at all, because classification already
 * happened inside the stage that failed.
 *
 *     const { stage, optional, check, timeline } = createFixture(t);
 *     try {
 *       ctx = await stage('chromium launch', 60000, () => launchExtension(chromium, dir),
 *         { absent: 'Chromium could not be launched' });
 *       sw = await stage('service-worker registration', 20000, () => …);
 *       t.diagnostic(`fixture ready — ${timeline.join(', ')}`);
 *     } catch {
 *       // every check below reports; the stage recorded which one died and why
 *     }
 *     try {
 *       await check('…', async () => { … });
 *     } finally { … teardown … }
 *
 * @param {import('node:test').TestContext} t
 * @returns {Fixture}
 */
export function createFixture(t) {
  /** `name Nms` for every stage that finished, in order — printable evidence. */
  const timeline = [];
  /** Set when a stage failed and the fault is this product's: every check FAILS. */
  let broke = null;
  /** Set when a stage failed and the dependency is missing: every check SKIPS. */
  let absent = null;

  /**
   * One setup stage: named, timed, capped by a budget of its own.
   *
   * A stage says which it was, how long it waited, and what the stages before it cost,
   * so a timeout is only ever raised when a MEASUREMENT says the budget was the fault.
   *
   * `options.absent` is the one thing that may turn a failure into a skip, and it
   * belongs on exactly one stage per fixture — the browser launch. Put it on a later
   * stage and this file is back to reporting defects as absent dependencies.
   */
  async function stage(name, budgetMs, run, options = {}) {
    const started = Date.now();
    let timer = null;
    const work = Promise.resolve().then(run);
    work.catch(() => {});   // whichever side of the race loses must not go unhandled
    try {
      const value = await Promise.race([work, new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer inside this stage's own ${budgetMs} ms budget`)),
          budgetMs
        );
      })]);
      timeline.push(`${name} ${Date.now() - started}ms`);
      return value;
    } catch (err) {
      const why =
        `fixture stage "${name}" gave up after ${Date.now() - started} ms of a ${budgetMs} ms ` +
        `budget: ${String((err && err.message) || err).split('\n')[0]}. Stages that finished ` +
        `first: ${timeline.join(', ') || 'none'}.`;
      if (options.absent) {
        absent = `${options.absent} — ${why}`;
        t.skip(absent);
      } else {
        broke = why;
      }
      throw new Error(why);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A stage the suite can do without — the companion's demo site, which several checks
   * need and the rest do not. Its failure skips those checks; it must not break the
   * fixture, and it must not be swallowed either: the REASON comes back so the skip can
   * carry it. A bare `catch {}` here would turn a broken demo server into a silently
   * absent one, and a §16 DoD would stop being checked with the suite still green.
   *
   * Any break recorded BEFORE this call is restored afterwards, so an optional stage can
   * only ever forgive its own failure — never an earlier real one.
   */
  async function optional(name, budgetMs, run) {
    const before = broke;
    try {
      return { value: await stage(name, budgetMs, run), why: null };
    } catch (err) {
      broke = before;
      return { value: null, why: String((err && err.message) || err).split('\n')[0] };
    }
  }

  /**
   * One check. However the fixture ended, this REPORTS — skipped when the browser was
   * absent, failed (naming the stage that died) when it was not, run when all is well.
   * `fn` receives the subtest's own context, so a check may still skip itself for a
   * reason of its own.
   */
  const check = (name, fn) =>
    absent
      ? t.test(name, { skip: absent }, () => {})
      : t.test(name, broke ? () => assert.fail(`did not run — ${broke}`) : fn);

  return {
    stage,
    optional,
    check,
    timeline,
    /** Why the dependency is missing, or null. Read it to tell a skip from a failure. */
    get absent() {
      return absent;
    },
    /** Which stage broke and how long it waited, or null. */
    get broke() {
      return broke;
    }
  };
}
