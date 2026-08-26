/**
 * The harness the eleven browser suites share: find a Chromium, launch the REAL unpacked
 * extension, run a fixture whose every check reports whatever happens to it, and record
 * what the service worker logs in the one way this Chromium actually permits.
 *
 * OWNER: probe-engineer — this file only. `audit.js` beside it belongs to
 * interceptor-engineer and is a different thing entirely (it reads source; this drives a
 * browser). They share a directory, not a subject.
 *
 * WHY THIS DIRECTORY: `node --test` treats EVERY .js file under a directory called
 * `test` as a test file, so a helper module living there would be executed as a suite
 * containing no tests — which is why every suite carried its own copy of
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

/* ------------------------------------------ what the service worker logs, for real */

/**
 * ── THE MEASUREMENT THIS SECTION EXISTS FOR ────────────────────────────────────────
 *
 * `worker.on('console')` RAISES NOTHING for an extension service worker in this
 * Chromium. Measured, not assumed, and re-measured before this code was written: a
 * `console.error` called straight out of `sw.evaluate` produced an empty event list,
 * and so did `console.log`, `console.warn`, `worker.on('pageerror')` and a
 * context-level `'console'` listener. A `page.on('console')` on an ordinary page —
 * including the panel, which is an ordinary page at a `chrome-extension://` URL —
 * captures the same synthetic error correctly. The gap is service workers only.
 *
 * Four suites therefore spent five milestones ending on
 *
 *     assert.deepEqual(swErrors, []);            // swErrors could never be non-empty
 *
 * — an assertion that cannot fail, on a claim ("the service worker logged no errors")
 * nobody was in a position to make. `e2e`, `probe`, `highlight` and `picker` each
 * carried one. `deep` was written last and wrapped `console.error` inside the worker
 * instead; that is what this is, lifted here so the next browser suite inherits a
 * working recorder rather than re-deriving a broken one. `mcp` drove fifteen tools
 * through the worker and never made the claim at all; it makes it here for the first
 * time. The four `panel.*` suites assert on their PANEL's console, not the worker's,
 * through a `page.on('console')` that works — each of them fails under an injected
 * `console.error`, so none of them needed changing.
 *
 * ── WHY THE READ IS ALLOWED TO FAIL FOR REASONS THAT ARE NOT ERRORS ────────────────
 *
 * A wrapper installed into a worker can go missing — an MV3 worker may be terminated
 * when idle and start again with a clean global. If `read()` answered a missing
 * recorder with "no errors", this check would be vacuous a SECOND way, and the second
 * way is harder to see than the first. So the recorder reports three facts and the
 * claim needs all three:
 *
 *   `installed`  the wrapper is present in the worker being read RIGHT NOW. False
 *                means the claim was not observed, and that is a failure, never a pass.
 *   `restarts`   how many times a new extension worker appeared. Each one takes its
 *                predecessor's list with it, unrecoverably — the errors are in a global
 *                of a dead JS context — so a restart means the span "during any of
 *                this" has a hole in it, and the claim cannot be made over a hole.
 *   `errors`     what was actually recorded.
 *
 * A restart is re-armed anyway (best effort, on the context's `serviceworker` event),
 * so that `installed:false` keeps its one unambiguous meaning: nothing is watching.
 *
 * ── WHAT IT STILL CANNOT SEE (both real, both narrow) ──────────────────────────────
 *
 * 1. Anything logged between the worker starting and this arming — the worker is
 *    already running when `launchPersistentContext` resolves, and there is no earlier
 *    hook Playwright offers for a worker target. Arm it in the stage directly after
 *    service-worker registration and the window is milliseconds wide.
 * 2. Messages the BROWSER writes about the extension rather than the extension writing
 *    them itself ("Unchecked runtime.lastError"), which never pass through this
 *    `console.error`. `worker.on('console')` would be the hook for those, and it is
 *    the hook that does not work. Uncaught exceptions and unhandled rejections ARE
 *    covered, by two listeners of their own — verified with a synthetic
 *    `Promise.reject` in the worker, which this records and a bare `console.error`
 *    wrapper would have missed.
 *
 * The recorder's global is deliberately NOT named `__mocklab…`: §17.8's audit reads
 * every global of that shape as one of `messages.js`'s `CONTENT_GLOBALS` contracts, and
 * this is a variable a test harness parks on a worker for the length of a run. A name
 * that looks like a contract is a name somebody will later go looking for one behind.
 */
const RECORDER_GLOBAL = 'browserFixtureWorkerErrors';

/** Put the wrapper in one worker. Idempotent: a second call keeps the first's list. */
function installRecorder(worker, name) {
  return worker.evaluate((globalName) => {
    if (Array.isArray(globalThis[globalName])) return true;
    const seen = [];
    globalThis[globalName] = seen;
    const say = (thing) => (thing && thing.message) || String(thing);
    const real = console.error.bind(console);
    console.error = (...args) => {
      seen.push(`console.error: ${args.map(say).join(' ')}`);
      real(...args);          // still visible to anyone watching the worker by hand
    };
    globalThis.addEventListener('unhandledrejection', (event) => {
      seen.push(`unhandledrejection: ${say(event && event.reason)}`);
    });
    globalThis.addEventListener('error', (event) => {
      seen.push(`uncaught: ${say(event && (event.error || event.message))}`);
    });
    return true;
  }, name);
}

/**
 * Start recording what the extension's service worker logs, and hand back the handle
 * whose `assertClean()` IS the "logged no errors" check.
 *
 * Use it as a fixture stage, immediately after service-worker registration, so that a
 * failure to arm breaks the fixture by name instead of quietly watching nothing:
 *
 *     swErrors = await stage('service-worker error recorder', 10000,
 *       () => recordWorkerErrors(ctx, sw));
 *     …
 *     await check('the service worker logged no errors during any of this',
 *       () => swErrors.assertClean());
 *
 * @param {import('playwright').BrowserContext} context
 * @param {import('playwright').Worker} worker  the extension's service worker
 */
export async function recordWorkerErrors(context, worker) {
  const origin = worker.url().split('/src/')[0];
  /** Errors read off a worker this suite ENDED on purpose — see `rebind`. */
  const carried = [];
  let latest = worker;
  let restarts = 0;
  let handedOff = false;
  let onWorker = null;
  let watched = null;

  await installRecorder(worker, RECORDER_GLOBAL);

  // A worker that restarts gets the wrapper back. Not a rescue — its predecessor's
  // list died with it and `restarts` says so — but it keeps `installed:false` meaning
  // exactly one thing.
  function watch(ctx) {
    if (watched && onWorker) watched.off('serviceworker', onWorker);
    watched = ctx;
    onWorker = (next) => {
      if (next === latest || !next.url().startsWith(origin)) return;
      latest = next;
      restarts += 1;
      installRecorder(next, RECORDER_GLOBAL).catch(() => {});
    };
    ctx.on('serviceworker', onWorker);
  }
  watch(context);

  /** What the worker holds now: `{installed, restarts, errors}`. Never throws. */
  async function read() {
    try {
      const worker_ = latest;
      const state = await worker_.evaluate(
        (globalName) => ({
          installed: Array.isArray(globalThis[globalName]),
          errors: (globalThis[globalName] || []).slice()
        }),
        RECORDER_GLOBAL
      );
      return { installed: state.installed, restarts, errors: carried.concat(state.errors) };
    } catch (err) {
      return {
        installed: false,
        restarts,
        errors: carried.concat(
          `the worker could not be read: ${String((err && err.message) || err).split('\n')[0]}`
        )
      };
    }
  }

  /**
   * Take the outgoing worker's record into Node, immediately BEFORE this suite ends
   * that worker on purpose. One suite closes its whole browser mid-run to test what a
   * cold service worker does with a warm store (§7.1's "delete probe Changes on SW
   * startup"); unlike an idle restart, that ending is a decision, and at the moment it
   * is taken the worker is still readable — so nothing has to be lost.
   *
   * It refuses if the recorder is already gone. A handoff that forgave a missing
   * wrapper would launder exactly the hole this module exists to keep visible, and the
   * order is the whole point: called after `context.close()`, there is nothing left to
   * read and this says so instead of carrying an empty list forward as if it were a
   * clean one.
   */
  async function handoff() {
    const before = await read();
    if (!before.installed) {
      throw new Error(
        'the outgoing service worker cannot be read, so this handoff would silently drop ' +
          'whatever it logged. Call it BEFORE closing the context, not after. Nothing past ' +
          'this point could claim "no errors during any of this".'
      );
    }
    carried.length = 0;
    carried.push(...before.errors);
    handedOff = true;
  }

  /** Continue recording in a worker of a NEW context, keeping what `handoff` carried. */
  async function rebind(nextContext, nextWorker) {
    if (!handedOff) await handoff();
    handedOff = false;
    latest = nextWorker;
    watch(nextContext);
    await installRecorder(nextWorker, RECORDER_GLOBAL);
  }

  /**
   * The whole check, in one place so that no suite can write a weaker version of it.
   * Throws unless the recorder was watching for the entire run and caught nothing.
   */
  async function assertClean() {
    const seen = await read();
    assert.ok(
      seen.installed,
      'the service-worker error recorder is not in the worker being read, so this check ' +
        'proves nothing about what was logged. See recordWorkerErrors() in ' +
        'testlib/browserFixture.js — an empty list from an absent recorder is exactly the ' +
        'vacuous pass it exists to prevent.'
    );
    assert.equal(
      seen.restarts,
      0,
      `the extension's service worker restarted ${seen.restarts} time(s) during this suite. ` +
        'Whatever the previous worker logged went with it, so "no errors during any of this" ' +
        `cannot be claimed over that gap. Recorded since the last restart: ${
          seen.errors.length ? JSON.stringify(seen.errors) : 'nothing'
        }.`
    );
    assert.deepEqual(seen.errors, [], 'the service worker logged this');
  }

  return { read, handoff, rebind, assertClean, get restarts() { return restarts; }, get worker() { return latest; } };
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
