/**
 * Scenario files — PLAN.md §10.4's "Export file" and "Import", as pure functions.
 *
 * OWNER: panel-designer. Split out of `scenarios.js` because this is the only place in
 * MockLab where a file the PRODUCT DID NOT MAKE is read, and that deserves to be
 * testable without a browser, a worker or a DOM. `scenarioFile.test.js` feeds it the
 * hostile shapes a file chooser can really produce; every one of them has to come back as
 * one honest sentence from `strings.js` and nothing else.
 *
 * §17.6: every word this module can put on screen comes from strings.js — and it returns
 * copy rather than rendering it, so `scenarios.js` shows the sentence and this file
 * decides which one.
 *
 * ── The threat model, written down rather than assumed ──────────────────────────
 * `<input type="file">` hands over whatever the person clicked: a photo, a 400 MB log, a
 * truncated download, a scenario exported from a different website, a JSON file that is
 * valid and simply is not this. None of those is an error condition — each is a person
 * who picked the wrong thing, and §11's rule is to say what to do next without blaming
 * them. So:
 *
 *   • SIZE IS CHECKED BEFORE PARSING. `JSON.parse` on a hundred megabytes blocks the
 *     panel's only thread for as long as it takes; a cap read off `text.length` costs
 *     nothing and is the difference between a sentence and a frozen side panel.
 *   • NOTHING FROM THE FILE IS SPREAD. Every field of the returned Preset is copied out
 *     by name into a fresh object, so a key MockLab does not know about cannot ride
 *     along into `chrome.storage.local` — or into an `Object.assign` somewhere later.
 *   • A DAMAGED SCENARIO IS REFUSED WHOLE, never repaired. Importing "the changes that
 *     parsed" would produce a scenario that silently does less than its name says, which
 *     is the §1.1 failure in the shape hardest to notice.
 *   • A SCENARIO FROM ANOTHER SITE IS REFUSED BY NAME. Its Changes are addressed by a
 *     source identity that is derived from the site's own address, so on this site they
 *     could never match anything: importing it would produce a card that is Stale from
 *     the moment it appears, under a sentence ("this site seems to have changed") that
 *     would not be true. Naming the site it came from is the one answer that lets the
 *     person actually do something.
 */
import { S } from './strings.js';

/**
 * The file extension §10.4 specifies. NOT copy and deliberately not in `strings.js`: it
 * is a format identifier, like the product's own name in `<title>`, and a locale that
 * translated it would produce files this build could not recognise as scenarios.
 */
export const SCENARIO_EXTENSION = '.mocklab.json';

/**
 * The biggest file worth reading. An exported scenario is its name plus one record per
 * change; the demo's three-change scenario serialises to well under a kilobyte, and
 * MAX_CHANGES below caps the record count at 1000, so a legitimate file cannot approach
 * this. Two megabytes is the same ceiling PLAN.md §4 puts on a captured response body,
 * borrowed so MockLab has one answer to "how big is too big" rather than two.
 */
export const MAX_FILE_CHARS = 2 * 1024 * 1024;

/** More changes than any scenario a human assembles by hand, by a wide margin. */
export const MAX_CHANGES = 1000;

/** Long enough for a sentence, short enough that a card is still a card. */
const MAX_NAME_CHARS = 120;

/** A path this build can address at all: `$` root, then §5.4's dot/bracket steps. */
const PATH_SHAPE = /^\$(?:\.[A-Za-z_$][\w$]*|\[\d+\]|\["(?:[^"\\]|\\.)*"\])*$/;

/** One emoji-ish label. Not validated as an emoji — any short glyph a person picked. */
const MAX_EMOJI_CHARS = 8;

/**
 * Characters no file name may carry on Windows, macOS or Linux between them, plus the
 * control range. Written as an explicit list and not as a range: `[ -<]` looks like the
 * punctuation it is made of and is actually every character from space to `<`, which
 * silently strips the digits out of "Sprint 4 cancelled".
 */
const RESERVED_IN_FILE_NAMES = /[<>:"/\\|?*\u0000-\u001f\u007f]+/g;

/* ─────────────────────────────────────────────────────────────────────── export */

/**
 * §10.4: "Export format = the Preset JSON (§4) pretty-printed". Written field by field
 * rather than by stringifying the stored object, so a field the worker adds internally
 * (an index, a cache, a future flag) is never published into a file format other builds
 * of MockLab will have to keep reading.
 *
 * @param {Object} preset a §4 Preset
 * @returns {string}
 */
export function serializeScenario(preset) {
  const source = preset || {};
  return JSON.stringify(
    {
      mocklab: 1,
      id: String(source.id || ''),
      origin: String(source.origin || ''),
      name: String(source.name || ''),
      emoji: String(source.emoji || ''),
      createdAt: Number(source.createdAt) || 0,
      changes: (Array.isArray(source.changes) ? source.changes : []).map((change) => ({
        sigId: String((change && change.sigId) || ''),
        path: String((change && change.path) || ''),
        value: change ? change.value : null,
        enabled: (change && change.enabled) !== false,
        ...(change && change.note ? { note: String(change.note) } : {})
      }))
    },
    null,
    2
  );
}

/**
 * A file name a person will recognise a week later: the scenario's own name, reduced to
 * what every filesystem accepts, plus the format's extension.
 *
 * A name made entirely of characters no filesystem accepts leaves nothing to use, and the
 * one thing this may not produce is a bare `.mocklab.json` — a leading dot hides the file
 * on every unix-like system, so the export would appear to have silently failed. The
 * fallback stem therefore comes from `strings.js` and not from here: the download dialog
 * shows it to a person, and it is the one word in this module that a translator should
 * reach (§17.6). The extension beside it stays untranslated, because that is a format
 * identifier and translating it would produce files this build could not read back.
 *
 * @param {Object} preset @returns {string}
 */
export function scenarioFileName(preset) {
  const stem = String((preset && preset.name) || '')
    .normalize('NFKD')
    .replace(RESERVED_IN_FILE_NAMES, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
    .replace(/^[-.]+|[-.]+$/g, '');
  return (stem || S.scenarios.untitledFile) + SCENARIO_EXTENSION;
}

/* ─────────────────────────────────────────────────────────────────────── import */

/** One refusal: the sentence a person reads, and a key only tests and code branch on. */
const refuse = (reason, error) => ({ ok: false, reason, error });

/**
 * Read a chosen file into a §4 Preset, or into one honest sentence.
 *
 * @param {string} text the file's contents
 * @param {{origin?:string, hostname?:string}} [site] the site the panel is looking at
 * @returns {{ok:true, preset:Object}|{ok:false, reason:string, error:string}}
 */
export function parseScenarioFile(text, site = {}) {
  const raw = typeof text === 'string' ? text : '';
  // Before parsing, always: see the header. A cap on `length` is O(1); `JSON.parse` on a
  // file this size is not, and the panel has one thread.
  if (raw.length > MAX_FILE_CHARS) return refuse('too-big', S.scenarios.importTooBig);
  if (!raw.trim()) return refuse('unreadable', S.scenarios.importUnreadable);

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Deliberately not reported: §1.2 rules out showing a parser's own words, and a
    // truncated download and a photograph fail here identically anyway.
    return refuse('not-scenario', S.scenarios.importNotScenario);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return refuse('not-scenario', S.scenarios.importNotScenario);
  }

  const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
  if (!name || name.length > MAX_NAME_CHARS) return refuse('not-scenario', S.scenarios.importNotScenario);

  if (!Array.isArray(parsed.changes)) return refuse('not-scenario', S.scenarios.importNotScenario);
  if (parsed.changes.length > MAX_CHANGES) return refuse('too-big', S.scenarios.importTooBig);
  // An empty list parses perfectly and is not a defect — it is a scenario that would do
  // nothing, and a card promising changes it does not have is the lie worth avoiding.
  if (parsed.changes.length === 0) return refuse('empty', S.scenarios.importEmpty);

  const changes = [];
  for (const entry of parsed.changes) {
    // `!entry` and nothing more, deliberately. A `typeof !== 'object' || Array.isArray`
    // gate beside it reads like a safety check and is not one: every non-object a JSON
    // file can produce — a string, a number, an array — carries no `sigId`, so the rule
    // on the next line refuses it with the same sentence. `scenarioFile.test.js` proves
    // that (a change that is a string, and one that is a list, are both refused), and its
    // mutation matrix proved the wider gate silent: deleting it changed no outcome. A
    // branch nothing can reach is not defence in depth, it is an untested line. What
    // `!entry` genuinely prevents is a null in the list, which would throw one line down.
    if (!entry) return refuse('not-scenario', S.scenarios.importNotScenario);
    if (typeof entry.sigId !== 'string' || !entry.sigId) return refuse('not-scenario', S.scenarios.importNotScenario);
    if (typeof entry.path !== 'string' || !PATH_SHAPE.test(entry.path)) {
      return refuse('not-scenario', S.scenarios.importNotScenario);
    }
    // `value` may legitimately be anything JSON holds, including null and false — so the
    // test is that the KEY is there, never that the value is truthy.
    if (!Object.prototype.hasOwnProperty.call(entry, 'value')) {
      return refuse('not-scenario', S.scenarios.importNotScenario);
    }
    changes.push({
      sigId: entry.sigId,
      path: entry.path,
      value: entry.value,
      enabled: entry.enabled !== false,
      ...(typeof entry.note === 'string' && entry.note ? { note: entry.note.slice(0, MAX_NAME_CHARS) } : {})
    });
  }

  // The site check is LAST, so a person who picked a photograph is told it is not a
  // scenario rather than told which site it came from.
  const from = typeof parsed.origin === 'string' ? parsed.origin : '';
  const here = String(site.origin || '');
  if (from && here && from !== here) {
    return refuse('other-site', S.scenarios.importOtherSite(hostOf(from)));
  }

  const emoji = typeof parsed.emoji === 'string' ? parsed.emoji.slice(0, MAX_EMOJI_CHARS) : '';
  return {
    ok: true,
    // Built by name, never spread: nothing the file carried beyond these five fields
    // reaches the store. `id` is deliberately absent — the worker mints one, so importing
    // the same file twice gives two scenarios rather than one that overwrote the other.
    preset: { name, emoji: emoji || S.scenarios.defaultSymbol, changes, createdAt: Date.now(), origin: here }
  };
}

/**
 * The host of an origin, for `scenarios.importOtherSite`. A stored origin is always a
 * URL, but this reads a FILE, so anything at all can arrive here — and a person is
 * better served by the odd text they can compare against their address bar than by a
 * blank space where the site's name should be.
 */
function hostOf(origin) {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin.slice(0, MAX_NAME_CHARS);
  }
}
