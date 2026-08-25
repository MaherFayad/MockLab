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
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(full);
    return entry.isFile() && entry.name.endsWith('.js') ? [full] : [];
  });
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
 * helpers beside them. The companion is three small files today and M6 adds the hub, the
 * MCP server and 15 tool definitions to it — written by someone who has not read this
 * thread, which is exactly who a self-checking record is for.
 */
export const ALL_FILES = WORKSPACES.flatMap((workspace) => jsFiles(workspace)).sort();

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
