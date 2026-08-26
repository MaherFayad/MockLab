/**
 * Every user-visible string (PLAN.md §11).
 *
 * OWNER: panel-designer.
 *
 * Rule §17.6: a literal user-facing string anywhere in panel.js is a bug. Everything
 * the human reads comes from this one export, so translating MockLab means
 * translating this file and nothing else.
 *
 * ── How to read this file ───────────────────────────────────────────────────────
 * Every key that appears in PLAN.md §11's copy table is reproduced here VERBATIM,
 * including punctuation and the curly quotes. Keys the panel needs that §11 does not
 * list are marked `// + not in §11` with where the wording came from. They obey §11's
 * closing rules: sentence case, no exclamation marks, never blame the user, always say
 * what to do next, and never the words JSON, API, endpoint, payload, regex, DOM, probe,
 * binding or signature outside the `advanced` section (§1.2 — that section only ever
 * renders when Advanced mode is on).
 */
export const S = {
  /* + not in §11 — WHICH LANGUAGE THIS FILE IS, and which way it runs.
   *
   * §9.2 ends with a promise: "RTL-ready: use logical properties everywhere; all strings
   * routed through strings.js so Arabic can be added by translating one file." Every
   * layout rule in panel.css is written in logical properties and reads its handedness
   * from `--dir`, which flips on `[dir='rtl']` — but the direction itself was written
   * into `panel.html` as `dir="ltr"`, so translating this one file produced an Arabic
   * panel laid out left-to-right and the promise was false by one attribute.
   *
   * It lives here rather than in the markup because it is a property OF THE COPY: these
   * two values and the sentences below them have to change together, and the one file a
   * translator is promised is this one. `panel.js` applies both to <html> at boot.
   *
   * NOT read from `chrome.i18n`: MockLab ships one locale, and a browser set to Arabic
   * would then flip an English panel — direction has to follow the words that are
   * actually on screen, which is exactly what this pair states. */
  meta: { lang: 'en', dir: 'ltr' },
  tab: { pick: 'Pick', sources: 'Sources', scenarios: 'Scenarios', settings: 'Settings' },
  site: {
    changes: (n) => `${n} change${n === 1 ? '' : 's'} on`,
    reset: 'Reset site',
    resetConfirm: 'Remove all changes on this site and refresh?',
    // + not in §11 — the panel can be opened on a tab that is not a website at all
    // (a new tab, the extensions page). Says what to do next, blames nothing.
    noPage: 'Open a website in this tab to start.'
  },
  pick: {
    title: 'What do you want to change?',
    body: 'Click the button, then click anything on the page — a price, a status, a name. MockLab will find the data behind it.',
    cta: 'Pick an element',
    picking: 'Click something on the page… (Esc to cancel)',
    recent: 'Recent links on this site',
    noCandidates:
      "MockLab couldn't find this text in any data the page loaded. It may be part of the page's design, an image, or loaded in a way MockLab can't see yet.",
    checkAll: 'Check all fields (slower)',
    // + not in §11 — the sentence that must be said INSTEAD of `noCandidates` when the
    // search that came back empty did not reach the end of the data (§6.3's MAX_DEPTH /
    // MAX_PATHS / MAX_TOTAL_PATHS; `GET_PICK` reports it as `searched.complete:false`).
    //
    // `noCandidates` above is a claim about the DATA — "couldn't find this text in any
    // data the page loaded", and then a list of reasons why the data would not contain
    // it. After a bounded search MockLab never established that. §17.12: a confident
    // wrong answer is the worst thing this product can do, and this is the one that
    // sounds most honest while being least true. So this string claims nothing about
    // the data and says only what happened: MockLab stopped looking.
    //
    // The next step is NOT "Check all fields". That control is §16 M4, and it would be
    // the same enumeration with the same ceilings — pointing at it would promise a cure
    // that is neither available nor certain. What exists today, and really does go
    // where the search did not, is the Sources tab: its tree renders whole response
    // bodies and opens to any depth (`sources.js` caps only how much starts OPEN).
    searchIncomplete:
      "MockLab searched the data this page loaded but couldn't reach every part of it, so it can't say whether this text is there. Open the Sources tab to look through the data yourself.",
    // + not in §11 — the same fact over a list that is NOT empty. Rows ordered by
    // likelihood and capped at 12 read as "these are the possibilities"; after a bounded
    // search that completeness is implied and unearned, so the list says what it is.
    // Separate from `searchIncomplete` because the claim is different: there, MockLab
    // cannot say whether the text is in the data at all; here it found some of it and
    // cannot say it found all of it.
    listIncomplete:
      "MockLab couldn't reach every part of the data this page loaded, so there may be more than what's listed here. Open the Sources tab to look through the data yourself.",
    // + not in §11 — §10.1 State C names its two sections in prose ("the picked
    // element", then "Possible sources") but the copy table has no keys for them. The
    // wording below is §10.1C's own, in §11's voice.
    picked: 'You picked',
    sources: 'Possible sources',
    // + not in §11 — an element can carry no text at all (an icon, a bare image). An
    // empty card would read as a rendering failure, and this is also the honest reason
    // the list under it may come back empty.
    noText: 'This element has no text of its own.'
  },
  probe: {
    cta: 'Find the real source',
    intro:
      "MockLab will refresh the page a few times to test what controls this element. Takes about half a minute. Don't click inside the page while it runs.",
    step: {
      control: 'Learning what changes on its own…',
      testing: (n) => `Testing ${n} possibilities…`,
      confirming: 'Double-checking…',
      cleanup: 'Putting everything back…'
    },
    reloads: (i, n) => `refresh ${i} of ~${n}`,
    cancel: 'Stop checking',
    found: 'Found it — this element is controlled by:',
    affected: (k) => `This change affects ${k} place${k === 1 ? '' : 's'} on the page`,
    showMe: 'Show me',
    noneConfirmed:
      'None of the possibilities actually control this element. Its content may be built into the page itself rather than loaded as data.',
    tooNoisy:
      "This element changes by itself on every refresh (like rotating or random content), so it can't be reliably checked.",
    elementLost:
      "The element couldn't be found again after refreshing. The page may change its layout on every load.",
    notRefetched:
      'This data only loads once per visit, so changes will show up the next time the site asks for it — not on a simple refresh.',
    timeout: 'The page took too long to settle. Try again, or close other heavy tabs.'
  },
  editor: {
    title: 'Change the value',
    custom: 'Custom…',
    original: (v) => `Real value: ${v}`,
    apply: 'Apply & refresh page',
    applied: 'Done. The site now sees your value.',
    unverified:
      "Not verified — the change will still apply, but MockLab hasn't proven which elements it affects.",
    saveScenario: 'Save as Scenario',
    // + not in §11 — controls the §10.1 State D editor needs but the table omits.
    cancel: 'Cancel',
    newValue: 'New value',
    trueLabel: 'True',
    falseLabel: 'False',
    invalidNumber: 'Type a number, like 450.'
  },
  sources: {
    title: 'Data this page loaded',
    empty: 'Nothing captured yet. Refresh the page with MockLab open.',
    builtin: "Page's built-in data",
    streamedUnsupported: "This data arrives as a stream MockLab can't edit yet.",
    changeValue: 'Change this value',
    showOnPage: 'Show on page',
    guessHighlight: 'Best guess — not verified',
    fields: (n) => `${n} fields`,
    // + not in §11 — the name a source falls back to when its URL carries no word worth
    // showing (`/api/v2/`, an opaque id). §17.6 owns it here because it reaches the human
    // twice: as a source card heading, and as `ChangeSummary.sourceName` over MCP (§12).
    // Imported by background/signatures.js and background/changesApi.js — read-only there.
    fallbackName: 'Data',
    // + not in §11 — the search field §10.2 asks for, and its empty result.
    search: 'Search',
    noMatch: 'Nothing here matches that search.',
    // + not in §11 — §10.2's meta row is specified as "{n} fields · just now / 2 min ago",
    // so the panel needs the relative times that row is made of.
    justNow: 'just now',
    minutesAgo: (n) => `${n} min ago`,
    hoursAgo: (n) => `${n} h ago`,
    // + not in §11 — accessible names for the per-row controls §10.2 requires on a row
    // that already carries a Change.
    changeOn: 'This change is on',
    changeOff: 'This change is off',
    removeChange: 'Remove this change',
    // + not in §11 — the backend can report that a Change matched but the page had
    // already been answered with the real data before the edit could be made
    // (`changeDropped`). §1 forbids letting that pass silently.
    changeDropped:
      "This change didn't reach the page in time, so the site showed its real data. Refresh the page to try again.",
    // + not in §11 — an empty response body still needs an honest line.
    emptyBody: 'This one arrived with nothing in it.'
  },
  scenarios: {
    title: 'Scenarios',
    new: 'New scenario from current changes',
    import: 'Import',
    empty: 'Save your current changes as a scenario to reuse them any time.',
    apply: 'Apply',
    applied: (name) => `“${name}” applied.`,
    stale: 'This site seems to have changed since this was saved. Some changes may not apply.',
    namePrompt: 'Name this scenario',
    deleteConfirm: (name) => `Delete “${name}”?`,
    // + not in §11 — §10.4 spells the card and its ⋯ menu out in prose but the copy table
    // has no keys for them. The wording below is §10.4's own.
    count: (n) => `${n} change${n === 1 ? '' : 's'}`,
    more: 'More actions',
    /* + not in §11 — §4 gives a Scenario an `emoji`, "user-picked, default 🎬", and §10.4
     * draws it on the card. A glyph IS a string a person reads, so it lives here and not
     * inline in a render (§17.6) — and a locale is entitled to change it: 🎬 reads as
     * "take" to some audiences and as nothing at all to others.
     *
     * A palette and not a full emoji keyboard: §10.4 asks for one picked symbol beside a
     * name, and the eight below are the states this product is used to stage — a take, a
     * problem, a failure, an experiment, money, waiting, refusal, success. */
    defaultSymbol: '🎬',
    symbols: ['🎬', '🚩', '💥', '🧪', '💸', '🕒', '🚫', '✅'],
    /* + not in §11 — the fallback stem for an exported file whose scenario name survives
     * nothing a filesystem accepts (a name written entirely in punctuation). It reaches a
     * person in the download dialog, so §17.6 applies to it. */
    untitledFile: 'scenario',
    rename: 'Rename',
    duplicate: 'Duplicate',
    exportFile: 'Export file',
    delete: 'Delete',
    save: 'Save',
    symbol: 'Pick a symbol',
    // + not in §11 — §10.4: "New scenario from current changes" is disabled when there are
    // none. A disabled control with no reason beside it is the thing §1.1 is about, and
    // this one names the step that makes it work.
    nothingToSave: 'Turn on at least one change first, then save those changes as a scenario.',
    // + not in §11 — the name box, empty. Says what to do, blames nobody.
    nameEmpty: 'Type a name for this scenario.',
    // + not in §11 — §10.4's Duplicate. A copy that reuses the name is two cards a person
    // cannot tell apart, which §1.1 forbids as plainly as a wrong chip does.
    copyOf: (name) => `${name} copy`,
    imported: (name) => `“${name}” is ready to use.`,
    // + not in §11 — the whole point of §10.4's "Apply" is that the site then renders it.
    // A scenario whose changes could not all be applied must say so rather than toast a
    // clean "applied" over a page that only half-changed (§1.1).
    appliedPartly: (name, n) =>
      `“${name}” applied, except ${n} change${n === 1 ? '' : 's'} the page has not asked for yet. Those will show up the next time the site loads that data.`,

    /* + not in §11 — IMPORT.
     *
     * A file chooser is the one place a person hands MockLab something MockLab did not
     * make, so every one of these sentences is about a FILE and none of them is about
     * the person. §1.2 rules out showing what actually went wrong — a parser message, a
     * line number, the text of the file — and §11 asks for the next step instead, so each
     * one names a different next step because each is a different situation. They are
     * separate keys and not one "that didn't work" for the same reason §10.6 keeps four
     * chips instead of one: a person who picked a screenshot, a person who picked a
     * scenario from another site, and a person whose file is damaged need to do three
     * different things next.
     */
    importUnreadable: "MockLab couldn't open that file. Choose it again, or pick a different one.",
    importNotScenario: 'That file is not a MockLab scenario. Choose one you saved here with Export file.',
    importEmpty: 'That scenario has no changes saved in it, so there is nothing to bring in.',
    importTooBig: 'That file is far too large to be a scenario. Choose one you saved here with Export file.',
    importOtherSite: (host) => `That scenario was saved on ${host}. Open ${host} in this tab to use it.`
  },
  /* + not in §11 — §10.3's on-page highlights, from the panel's side.
   *
   * §11 wrote `probe.showMe` and `sources.showOnPage` (the two controls) and
   * `sources.guessHighlight` (the unproven kind), and stopped there — it has no sentence
   * for a highlight that lit nothing up. That is not a rare case: it is what a person
   * sees whenever a proven Link's elements are no longer on the page, which is exactly
   * §1.1's third state arriving in front of them. Flashing nothing and saying nothing
   * would read as a broken button.
   */
  highlight: {
    none: "MockLab couldn't find those places on the page. Refresh the page and try again.",
    // + not in §11 — the sentence for a Link MockLab DID prove and can no longer stand
    // behind. §1.1: "was verified, but the site changed and it no longer matches". It
    // says what is true (it was proved, the data has not appeared) and never claims the
    // stronger thing (that the site definitely changed), because a page that simply has
    // not loaded yet looks identical from here.
    stale: "MockLab proved this before, but the data behind it hasn't loaded on this page — so it may not work any more. Refresh the page to check."
  },
  chips: { verified: 'Verified ✓', candidate: 'Possible', stale: 'Stale', changed: 'Changed' },
  deep: {
    label: 'Deep mode for this site',
    help: "Only needed when a site already shows data the moment it opens. Chrome will show a bar saying the browser is being debugged — that's MockLab, and it's normal.",
    devtoolsConflict: 'Deep mode paused: Chrome DevTools is open on this tab. Close DevTools to resume.',
    // + not in §11 — the row is per-site (§4's `deepModeOrigins` is a list of them), so
    // there are sites it cannot be turned on for at all: a new tab, the extensions page,
    // anything that is not a web address. Grey with no sentence is what §1.1 forbids.
    noSite: 'Deep mode is set per site. Open a website in this tab to turn it on for it.',
    /* + not in §11 — THE WARNING, ASKED BEFORE IT HAPPENS.
     *
     * §8 and §11 both describe Chrome's debugging bar, and until now both described it in
     * a help line under a checkbox — which is a warning a person reads AFTER the bar is
     * across their browser, if the tick came first. The bar is not a detail: it cannot be
     * dismissed without also dismissing MockLab, every navigation is paused mid-flight
     * while it is up, and §8 makes the whole feature opt-in per site because of it. So
     * the tick asks, and only the answer to this question attaches anything. `help` above
     * still says the same thing where the person is choosing; this is the last word
     * before the browser changes.
     *
     * `turnOn` is not the row's own label repeated: a confirm button must say what it
     * does, not "OK" (a person who has stopped reading presses either one). */
    confirm:
      'Turn deep mode on for this site? Chrome will show a bar across the top of the browser saying it is being debugged. That bar is MockLab, and it stays until you turn this off.',
    turnOn: 'Turn on deep mode',
    // + not in §11 — deep mode starts reading the page at its NEXT load, never the one
    // already on screen (`background/debuggerEngine.js` says why: nothing fires early
    // enough). Saying "on" and stopping there would promise the current page.
    on: 'Deep mode is on for this site. Refresh the page for MockLab to see the data built into it.',
    off: 'Deep mode is off for this site.'
  },
  companion: {
    connected: 'Connected — AI agents can control this site',
    disconnected: 'Not connected',
    setup: 'Set up AI access',
    pairTitle: 'Pair with your AI',
    pairBody: 'Run this once in your terminal, then enter the 6-digit code it prints:',
    pairPlaceholder: '6-digit code',
    paired: 'Paired. Agents can now see and change data through MockLab.',

    /* + not in §11 — THE COMMAND §10.5 promises ("shows one copy-paste command").
     *
     * Two of them, and the difference is not cosmetic. `companion/src/index.js` prints a
     * code only when a pairing window opens, and an ordinary start opens one just on the
     * FIRST run of a machine — after that it prints "already paired" and no code at all.
     * So the command beside §11's `pairBody` ("enter the 6-digit code it prints") has to
     * be the one that always prints one, or the sentence is false for everybody pairing a
     * second browser, and the person is sent to a terminal to read a number that is not
     * there.
     *
     * `start` is the other half: a browser that is ALREADY paired needs the companion
     * running, not another pairing window. Showing `pair` there would open a window
     * nobody asked for and print a code with nowhere to type it.
     *
     * NEITHER IS PREFIXED WITH `npx`, and `commandNote` is why. MockLab is not published
     * to npm, so `npx mocklab-companion` resolves to nothing on every machine there is
     * today — a command that runs for nobody is worse than no command, because it fails
     * in a terminal where MockLab cannot say anything about it. What a person actually
     * types from a downloaded copy is `node <their own path>/companion/src/index.js
     * --pair`, and that path is different on every machine and unknowable from inside the
     * panel: the extension knows its own id, never where the repository sits on disk. So
     * these two are the command's NAME — true of an installed copy, and the thing to look
     * for in the README of a downloaded one, which is what the note says.
     *
     * NOT TRANSLATABLE, and here anyway: a translator must leave both exactly as they
     * are — they are typed into a terminal, not read. They live in this file because
     * §17.6 is about every word that reaches a person, and because the day the package
     * is renamed there is one place to change.
     *
     * The day MockLab IS published, `npx ` goes on the front of both, this note goes, and
     * nothing else on the screen changes. */
    command: 'mocklab-companion --pair',
    start: 'mocklab-companion',
    commandNote:
      "That is the command's name. If you are running MockLab from a downloaded copy, the README file in the MockLab folder has the exact line to type.",
    copy: 'Copy',
    copied: 'Command copied. Paste it into your terminal.',
    // Clipboard access can be refused (no focus, a locked-down profile). The command is
    // on screen either way, so the honest answer names the way that still works.
    copyFailed: "MockLab couldn't copy it. Select the command above and copy it yourself.",

    /* + not in §11 — PAIRED, BUT NOTHING CONNECTED RIGHT NOW.
     *
     * `GET_COMPANION` answers two separate facts (`connected`, `paired`) and this is the
     * pair §11 has no sentence for. It is the ORDINARY state of a machine whose companion
     * is not running — not an error, and above all not "Not connected" in the sense the
     * button under it offers to fix: that would send a person back through a pairing they
     * have already completed. Nothing here says to pair again, because nothing about this
     * state is fixed by pairing again. */
    idle: 'Set up, but the companion is not running',
    idleHelp: 'This browser is paired. Start the companion in your terminal and MockLab connects on its own.',

    /* + not in §11 — the pairing form's own controls. `pairSubmit` is a verb because
     * "Set up AI access" is the label of the button that OPENED this form; two buttons
     * reading the same words in the same screen are one action drawn twice. */
    pairSubmit: 'Pair',
    codeFormat: 'Type the 6-digit code your terminal printed.',

    /* + not in §11 — WHY A PAIRING DID NOT HAPPEN. Exactly two, because
     * `PAIR_FAIL` in messages.js has exactly two values, and it has two because
     * `companion/src/pairing.js` gives the socket ONE answer for all four of §12.3's
     * refusals on purpose — that indistinguishability IS MockLab's security boundary.
     * The detail is printed on the terminal where the person who started the companion
     * can read it, and these two sentences are written to be useful under exactly that
     * constraint rather than to guess around it.
     *
     * `pairRefused` therefore points at the terminal, which is the only place the answer
     * exists — and then names the one step that works whichever of the four it was, since
     * three of them (an expired window, too many tries, a code from an older run) are
     * cured by a new window and the fourth (a mistyped code) is cured by the code that is
     * on screen there.
     *
     * `pairNoCompanion` never says "try the code again", because no code can help: no
     * socket opened at all, and both causes of that — nothing running, or something
     * running with no pairing window — are fixed by the same command, which then prints a
     * code that is NEW. Saying so is what stops a person retyping the old one. */
    pairRefused:
      'The companion did not accept that code. The terminal window where you started it says why — read it there, then use the newest code it shows.',
    pairNoCompanion:
      "MockLab couldn't reach the companion. Run the command above in your terminal: it starts the companion and prints a fresh code to type here.",
    // + not in §11 — neither of the two above. Nothing answered at all, which is a fact
    // about MockLab and not about the companion, so it claims nothing about either.
    pairNoAnswer: "MockLab didn't get an answer about that code. Try it again, or run the command above for a fresh one."
  },
  errors: {
    pageBroke: 'Something went wrong talking to this page. Refresh it and try again.',
    storageFull: "MockLab's local storage is full. Delete old scenarios in Settings."
  },
  // + not in §11 — §10.5 spells the Settings rows out in prose but the copy table has no
  // keys for them. The wording below is §10.5's own, split into label and help.
  settings: {
    title: 'Settings',
    advanced: 'Advanced mode',
    advancedHelp: 'Show technical details (web addresses, fields, and how they are matched).',
    paranoid: 'Extra-careful checking',
    paranoidHelp: 'Verify twice — slower, for pages that behave differently on every load.',
    companionTitle: 'AI access',
    dangerTitle: 'Danger zone',
    resetSite: 'Reset this site',
    resetAll: 'Reset everything',
    resetAllConfirm: 'Remove every change and scenario on every site?',
    // The counts come back from the service worker, so this can be specific instead of
    // a generic "done". The second sentence is the honest part: only THIS page reloads.
    // Other open tabs are not disturbed — they stop seeing edited data from their next
    // request onward, which is what the user will actually observe.
    resetAllDone: (changes, scenarios) => {
      const parts = [];
      if (changes) parts.push(`${changes} change${changes === 1 ? '' : 's'}`);
      if (scenarios) parts.push(`${scenarios} scenario${scenarios === 1 ? '' : 's'}`);
      return `Removed ${parts.join(' and ')}. This page is back to normal; other open tabs go back to real data the next time they load something.`;
    },
    resetAllNothing: 'There was nothing to remove.',
    // + not in §11 — §10.5's "Reset this site" is switched off when the site has no
    // changes on it, and until M7 it said so to nobody: no tooltip, no sentence, just
    // grey. §1.1 is about a control that is visibly present and silently does nothing.
    //
    // It states the world rather than a next step, which is the one case §11's "always
    // say what to do next" has no answer for: there is nothing to do, and inventing an
    // errand ("make a change first, then reset it") would be worse than saying so. Its
    // neighbour `resetAllNothing` already reads this way for the same reason.
    nothingToReset: 'No changes are on for this site, so there is nothing to reset.',
    limitations: 'MockLab works on the main page only, and cannot edit data that arrives as a live stream.'
  },
  // + not in §11 — labels that are only ever rendered while Advanced mode is ON, which
  // is the one place §1.2 permits technical vocabulary.
  advanced: {
    path: 'Field path',
    url: 'Request URL',
    sigId: 'Signature',
    method: 'Method',
    via: 'Captured via'
  },
  // + not in §11 — glyphs and joins the panel renders. They live here and not inline in
  // panel.js because §17.6 is about everything a human sees, and because an RTL locale
  // punctuates a "name · field" join differently from an LTR one.
  glyph: {
    object: (n) => `{${n}}`,
    list: (n) => `[${n}]`,
    index: (i) => `[${i}]`,
    collapsedObject: '{…}',
    // + not in §11 — how a field that carries no value reads in the tree and in
    // "Real value: …". `null` is a programmer's name for it, so §1.2 rules it out.
    // Of the plain-English candidates this file settles on "nothing", not "empty":
    //   - it is already this copy's word for absence ("Nothing captured yet", "Nothing
    //     here matches that search", "arrived with nothing in it"), so it adds no new
    //     vocabulary for a translator or a reader to learn;
    //   - "empty" is the ambiguous one. An empty text and an empty list are DIFFERENT
    //     real values that the tree draws differently (blank, and `[0]`), and §1 makes
    //     honesty the tiebreaker whenever two words are equally calm.
    // It is a description, not a value, so the tree draws it in italics — a string that
    // happens to read "nothing" must not look identical to a field that holds none
    // (.tree__value--null in panel.css; colour alone would be WCAG 1.4.1).
    nullValue: 'nothing',
    // + not in §11 — the page's OWN words, quoted back to the person in the Pick tab
    // (§10.1A, §10.1C). §11 already quotes a name this way in `scenarios.applied` and
    // `scenarios.deleteConfirm`; the curly pair is here so a locale that punctuates
    // quotation differently changes one line.
    quote: (text) => `“${text}”`,
    joinDot: (a, b) => `${a} · ${b}`,
    joinLabel: (a, b) => `${a}: ${b}`
  },
  // + not in §11 — a control that is visibly present but inert. Saying so beats a
  // control that silently does nothing.
  //
  // TWO strings, because §11's "always say what to do next" only has an answer for one
  // of them. `soon` is for the controls whose job — change a value — CAN be done another
  // way today, so it names that way. `notYet` is for the ones where there is no other
  // way: highlighting on the page, saving a Scenario, Deep mode, pairing an AI. Reusing
  // `soon` there put "change values from the Sources tab" under "Save as Scenario",
  // which is advice about a different task, and misdirection is a worse answer than
  // admitting there is nothing to do — the rule is a means to §1.1, not the other way
  // round. Found by reading the screens rather than by any test.
  soon: 'Not ready yet — for now, change values from the Sources tab.',
  notYet: 'Not ready yet — this part of MockLab is still being built.'
};
