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
    checkAll: 'Check all fields (slower)'
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
    deleteConfirm: (name) => `Delete “${name}”?`
  },
  chips: { verified: 'Verified ✓', candidate: 'Possible', stale: 'Stale', changed: 'Changed' },
  deep: {
    label: 'Deep mode for this site',
    help: "Only needed when a site already shows data the moment it opens. Chrome will show a bar saying the browser is being debugged — that's MockLab, and it's normal.",
    devtoolsConflict: 'Deep mode paused: Chrome DevTools is open on this tab. Close DevTools to resume.'
  },
  companion: {
    connected: 'Connected — AI agents can control this site',
    disconnected: 'Not connected',
    setup: 'Set up AI access',
    pairTitle: 'Pair with your AI',
    pairBody: 'Run this once in your terminal, then enter the 6-digit code it prints:',
    pairPlaceholder: '6-digit code',
    paired: 'Paired. Agents can now see and change data through MockLab.'
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
    // + not in §11 — how a null leaf reads in the tree and in "Real value: …". §17.12
    // picks the calmer word: `null` is a programmer's name for this, `empty` is what it
    // means to the person reading it. panel-designer owns the wording.
    nullValue: 'empty',
    joinDot: (a, b) => `${a} · ${b}`,
    joinLabel: (a, b) => `${a}: ${b}`
  },
  // + not in §11 — this build stops at PLAN.md §16 M2, so the Pick and Scenario actions
  // are visibly present but inert. Saying so beats a control that silently does nothing.
  soon: 'Not ready yet — for now, change values from the Sources tab.'
};
