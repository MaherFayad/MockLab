/**
 * Shared reading helpers for the source audits in `test/guards*.test.js`.
 *
 * OWNER: interceptor-engineer.
 *
 * WHY THIS DIRECTORY IS NOT `test/`: `node --test` treats EVERY .js file under a
 * directory called `test` as a test file, so a helper module living there would be
 * executed as a suite that contains no tests. `testlib` is outside that glob, and no
 * file in it may be named `test-*.js`, which is inside it.
 *
 * WHY IT IS NOT A BLIND SPOT: a helper directory nothing audits is a place for code to
 * hide from §17.10's line budget and from the ISOLATED-world global scan — trading a
 * recorded overage for an unrecorded hole, which is worse. It does not hide here,
 * because none of the file sets below is written out by hand. They are derived from the
 * workspaces the root `package.json` declares, so a directory added tomorrow is audited
 * the day it appears rather than the day somebody remembers to list it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXTENSION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = path.resolve(EXTENSION, '..');
export const SRC = path.join(EXTENSION, 'src');
export const README_PATH = path.join(ROOT, 'README.md');

/** Every .js file under `dir`, or none when the directory does not exist. */
export function jsFiles(dir) {
  return filesUnder(dir, (name) => name.endsWith('.js'));
}

/** The shared walk. `keep` decides on the BASENAME; `node_modules` never descends. */
function filesUnder(dir, keep) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full, keep);
    return entry.isFile() && keep(entry.name) ? [full] : [];
  });
}

/* ═══════════ What counts as a source file, and why it is not just `.js` ════════════
 *
 * §17.10 says "keep files under ~500 lines" and says nothing about an extension, but the
 * audit that enforces it could only see `.js` — so `panel.css` reached 542 lines with
 * the budget check unable to look at it and the README record unable to state a count
 * for it in any shape the parser accepts. That is the shape of every defect this build
 * has produced around this guard: a number in a place the audit cannot reach. Six stale
 * figures have rotted outside coverage; none inside it ever has. So coverage is defined
 * here, once, rather than implied by a file extension nobody chose deliberately.
 *
 * A SOURCE FILE is text a human in this repo wrote by hand, in a format where "this file
 * is too long, split it" is a sentence that means something. That is the whole test, and
 * it is what decides each of these:
 *
 *   .js    the code. Always was.
 *   .css   `panel.css` is the design system (§9.1) — hand-written, and splittable: CSS
 *          has `@import`, and the panel already splits its JS the same way.
 *   .html  `panel.html` and the demo page are hand-written structure with the same
 *          property; §14 calls the demo the acceptance harness, so it is not scratch.
 *   .json  `manifest.json` is a source file PLAN.md §3 dictates line by line, and the
 *          demo's `api/*.json` are the fixtures every milestone's DoD is measured
 *          against. Hand-written, and a 600-line manifest would be a real §17.10
 *          finding rather than noise.
 *
 * And what it excludes, each for the same one reason rather than by taste:
 *
 *   .woff2, .png   not text. A line count of a binary is not a number about anything.
 *   .md            prose, not source. You cannot "split" README for being long, and
 *                  README is where the record of this very budget lives — subjecting the
 *                  record to the rule it records is a circle, not a check.
 *   GENERATED      written by a tool, so no human decision is being audited and the
 *                  number would only ever be noise. `package-lock.json` is the case that
 *                  matters; it is excluded by NAME rather than by directory, because the
 *                  root lockfile already falls outside the workspace walk and the one
 *                  that would not is a lockfile inside a workspace.
 *
 * If you add a format, add it here with the sentence that justifies it. Widening this
 * list is how the audit stays able to look; the failure mode it exists to prevent is a
 * file that is real, over budget, and invisible.
 * ═══════════════════════════════════════════════════════════════════════════════════ */

export const SOURCE_EXTENSIONS = ['.js', '.css', '.html', '.json'];

/** Tool-written files that carry an audited extension. Excluded by name, with reason. */
export const GENERATED = ['package-lock.json'];

/** Every hand-written source file under `dir`, whatever format it is written in. */
export function sourceFiles(dir) {
  return filesUnder(
    dir,
    (name) => SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext)) && !GENERATED.includes(name)
  );
}

export const read = (file) => fs.readFileSync(file, 'utf8');
/**
 * Repo-root-relative, forward slashes: `extension/src/…`, `companion/src/…`. Both
 * workspaces have a `src/` and a `test/`, so a path relative to either one would be
 * ambiguous the moment the companion is audited alongside the extension.
 */
export const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

/**
 * The workspace directories, read out of the root manifest rather than listed here.
 * A glob would need expanding before any of this is true, so a glob is refused loudly
 * instead of silently walking nothing — an audit that sees no files passes, which is the
 * failure mode every guard in `test/` exists to prevent.
 */
export const WORKSPACES = (() => {
  const declared = JSON.parse(read(path.join(ROOT, 'package.json'))).workspaces;
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new Error('the root package.json declares no workspaces; the source audits have nothing to read');
  }
  for (const name of declared) {
    if (name.includes('*')) {
      throw new Error(`workspace "${name}" is a glob; teach ${rel(fileURLToPath(import.meta.url))} to expand it`);
    }
  }
  return declared.map((name) => path.join(ROOT, name)).sort();
})();

/** The extension's own source — the only place §17.1 and §17.2 can apply. */
export const FILES = jsFiles(SRC).sort();

/**
 * Shipping source in BOTH workspaces, for §17.4 and §17.6. The companion has no Binding
 * today, but at M6 it serves `get_bindings` to AI agents (§12.4 #6) — a hardcoded
 * verified state there would be the same lie §17.12 calls the worst bug this product can
 * have, told to a different audience.
 */
export const SOURCE_FILES = WORKSPACES.flatMap((workspace) => jsFiles(path.join(workspace, 'src'))).sort();

/**
 * Everything §17.10's line budget applies to, in both workspaces: source, tests and the
 * helpers beside them, in every format the note above admits — not only `.js`. The
 * companion is three small files today and M6 adds the hub, the MCP server and 15 tool
 * definitions to it — written by someone who has not read this thread, which is exactly
 * who a self-checking record is for.
 */
export const ALL_FILES = WORKSPACES.flatMap((workspace) => sourceFiles(workspace)).sort();

/** Every .js file in the extension workspace, whatever directory it was put in. */
export const EXTENSION_FILES = jsFiles(EXTENSION).sort();

/**
 * Blank out comments so an audit reads CODE, never prose. Two passes, both deliberately
 * simple: this codebase always opens a block comment at the start of a line, and a
 * trailing `//` is only stripped when it is not preceded by `:` — otherwise the `//` in
 * a `https://` literal would take the rest of the line with it.
 */
export function stripComments(text) {
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
