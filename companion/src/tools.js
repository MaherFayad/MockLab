/**
 * The fifteen MCP tools of PLAN.md §12.4 — names, descriptions and JSON Schemas.
 *
 * OWNER: mcp-engineer.
 *
 * The NAMES and their ORDER are frozen (`mcpServer.js` holds the list and checks this
 * file against it). The schemas are §12.4's argument lists written out: every tool that
 * targets a page takes `tabId`, and every mutation takes `refresh` defaulting to true.
 *
 * `additionalProperties: false` on every schema, deliberately. An agent that misspells
 * an argument gets told so, rather than having its `valeu` silently ignored and being
 * shown a page that did not change — which is the §1.1 failure in agent form.
 *
 * That strictness is also why three OPTIONAL arguments were added here after M6 closed,
 * each closing a case where the panel offered a person something an agent could not
 * reach at all (§1.6): `set_value.enabled` (§10.2's per-row switch — switching a change
 * off without deleting it), `probe_element.paranoid` (§10.5's "Extra-careful checking",
 * which changes how the probe itself behaves) and `probe_element.exhaustive` (§10.1D's
 * "Check all fields (slower)", offered to a person precisely after an honest
 * `noneConfirmed`, which is when an agent most needs it). Adding an optional argument is
 * not the same act as renaming or reordering one: no existing call changes meaning, and
 * §12.4's fifteen names and their order are untouched — the two remaining gaps
 * (renaming/importing a Scenario, and "Reset everything") would each need a SIXTEENTH
 * TOOL, so they stay open and recorded rather than being smuggled in as an argument.
 *
 * Each tool is a THIN declaration: an op name (identical to the tool name — one
 * vocabulary on the wire, so a frame in a log says which tool sent it), a timeout, and
 * whether it streams progress. The behaviour is in the extension, because the panel and
 * the agent must reach the SAME handler (§1.6) — a second implementation here would be a
 * second set of answers to drift.
 *
 * NOTE ON THE DESCRIPTIONS: they are the only documentation an agent gets, so each says
 * what the tool proves as well as what it does. `get_bindings` and `probe_element` in
 * particular say who may call something verified, because an agent that assumes a
 * `set_value` implies a proven link would report §17.12's lie to a human in prose.
 */

/** The 30s of §12.2 covers every tool but one; the probe's own cap is §7.1's 3 minutes. */
export const PROBE_TIMEOUT_MS = 210_000;

const tabId = {
  type: 'integer',
  description: 'A tab id from list_tabs. MockLab only reaches tabs it has a live connection in.'
};

const refresh = {
  type: 'boolean',
  default: true,
  description: 'Reload the tab so the site re-requests its data and renders the new value. Default true.'
};

/** @param {Object} properties @param {string[]} required */
const schema = (properties, required = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false
});

/**
 * @typedef {Object} ToolDefinition
 * @property {string} name        §12.4's exact name — also the op on the §12.2 wire
 * @property {string} description
 * @property {Object} inputSchema
 * @property {number} [timeoutMs] overrides §12.2's 30s
 * @property {boolean} [progress] §12.4 #5: "send MCP progress notifications"
 * @property {(args:Object) => string|null} [validate] argument rules a schema cannot state
 * @property {boolean} [image]    the answer carries a PNG, not only JSON
 */

/** @type {ToolDefinition[]} */
export const TOOLS = [
  {
    name: 'list_tabs',
    description:
      'List the browser tabs MockLab can work with — the ones where its page agent is ' +
      'live. Start here: every other tool takes a tabId from this list. Returns tabId, ' +
      'url, title, origin, whether the tab is active, how many changes are currently on ' +
      'for that site, and whether deep mode is on for it.',
    inputSchema: schema({})
  },
  {
    name: 'list_sources',
    description:
      'List the data sources this tab has loaded — one entry per distinct request the ' +
      'page made, named the way a person sees it in MockLab. Includes the field count, ' +
      'when it was last seen, and whether a change is currently applied to it. Captures ' +
      'are per page load: a tab that has not loaded since MockLab attached lists nothing.',
    inputSchema: schema({ tabId }, ['tabId'])
  },
  {
    name: 'get_response',
    description:
      'Read the body a source returned, or the part of it at `path`. Paths are the ' +
      'dotted form MockLab uses everywhere: $.data.flights[0].status. A body over 200 KB ' +
      'comes back as its top-level keys with truncated:true — pass a path to narrow it.',
    inputSchema: schema(
      {
        tabId,
        sigId: { type: 'string', description: 'A source id from list_sources.' },
        path: { type: 'string', description: 'Optional. Return only the subtree at this path.' }
      },
      ['tabId', 'sigId']
    )
  },
  {
    name: 'search_value',
    description:
      'Find where a value on screen might come from: searches every response this tab ' +
      'has captured for the text and returns ranked guesses as {sigId, path, value, ' +
      'score}. These are GUESSES from value matching, not proven links — probe_element ' +
      'is what proves one.',
    inputSchema: schema(
      { tabId, needle: { type: 'string', description: 'The text or number to look for, e.g. "On time" or "450".' } },
      ['tabId', 'needle']
    )
  },
  {
    name: 'probe_element',
    description:
      'Prove which field controls one element on the page, by experiment. Give either a ' +
      'CSS selector or the exact trimmed text of the element. MockLab changes candidate ' +
      'fields, reloads the page several times, and watches whether the element follows — ' +
      'so it takes roughly half a minute and the page will reload while it runs. This is ' +
      'the ONLY tool that can return a verified link. On success it returns the stored ' +
      'binding, every element that field was proven to affect, and the real values seen ' +
      'at that field; on failure it returns why, honestly (the element changes by itself, ' +
      'nothing confirmed, the element could not be found again, and so on).',
    inputSchema: schema(
      {
        tabId,
        selector: { type: 'string', description: 'CSS selector for the element. One of selector or text is required.' },
        text: { type: 'string', description: 'Exact trimmed text of a visible element. One of selector or text is required.' },
        exhaustive: {
          type: 'boolean',
          default: false,
          description:
            'Check every field of every captured source instead of only the ranked ' +
            'guesses. Much slower, and it is what to try after a probe honestly reports ' +
            'that none of the possibilities controlled the element — the same "Check all ' +
            'fields" a person is offered at that point.'
        },
        paranoid: {
          type: 'boolean',
          description:
            "Turn MockLab's extra-careful checking on or off: a second full change-and-" +
            'revert cycle before anything is called verified, for flaky pages. This is a ' +
            'SETTING, not a per-call flag — it is the same checkbox a person has, it stays ' +
            'as you leave it, and the panel shows the value you set.'
        }
      },
      ['tabId']
    ),
    timeoutMs: PROBE_TIMEOUT_MS,
    progress: true,
    validate: (args) =>
      args.selector || args.text
        ? null
        : 'probe_element needs either a selector or the exact text of the element to work on.'
  },
  {
    name: 'get_bindings',
    description:
      'List the links MockLab holds for a site: which field drives which elements, and ' +
      'what state that claim is in — verified (proved by a probe) or candidate (a value ' +
      'match that was never proved). The state is read from storage, never inferred. ' +
      'Each entry also carries sourceLoadedThisPageLoad: when that is false, the request ' +
      'behind a proved link did not come back on this page load, which is what MockLab ' +
      'shows a person as a link having gone stale.',
    inputSchema: schema({
      tabId,
      origin: { type: 'string', description: 'Site origin, e.g. https://example.com. Use instead of tabId to read a site no tab is on.' }
    })
  },
  {
    name: 'set_value',
    description:
      'Make the site see a different value at one field of one source, from the next ' +
      'time it requests it. The page renders the new state itself — nothing in the DOM ' +
      'is edited. One change per (sigId, path): setting a field that already has one ' +
      'updates it. The answer says whether the change can actually apply yet: a source ' +
      'MockLab has never seen on this site cannot be matched, and applies:false says so.',
    inputSchema: schema(
      {
        tabId,
        sigId: { type: 'string', description: 'A source id from list_sources.' },
        path: { type: 'string', description: 'Field path, e.g. $.status or $.price.total.' },
        value: { description: 'The replacement value: string, number, boolean, null, object or array.' },
        note: { type: 'string', description: 'Optional label a person will see beside the change.' },
        enabled: {
          type: 'boolean',
          default: true,
          description:
            'Whether the change is switched on. false stages it, or switches an existing ' +
            'change at this field off without deleting it — the same on/off switch a person ' +
            'has on the row. The value is kept either way, so switching it back on is the ' +
            'same call with enabled:true.'
        },
        refresh
      },
      ['tabId', 'sigId', 'path', 'value']
    )
  },
  {
    name: 'clear_changes',
    description:
      'Remove one change by id, or every change on the site in this tab when no id is ' +
      'given, and reload so the page shows the real data again.',
    inputSchema: schema({ tabId, changeId: { type: 'string', description: 'Optional. Omit to clear the whole site.' }, refresh }, ['tabId'])
  },
  {
    name: 'highlight',
    description:
      'Flash outlines on the page over every element this field drives, and report how ' +
      'many were actually drawn. The answer carries a verified flag: it says whether those ' +
      'elements were proved by a probe or are only a best guess, and the outline a person ' +
      'sees differs accordingly. Zero elements on a proved link means the page no longer ' +
      'contains them.',
    inputSchema: schema({ tabId, sigId: { type: 'string' }, path: { type: 'string' } }, ['tabId', 'sigId', 'path'])
  },
  {
    name: 'list_presets',
    description:
      'List the saved scenarios for a site: a scenario is a named bundle of changes a ' +
      'person or an agent can apply in one step.',
    inputSchema: schema({
      tabId,
      origin: { type: 'string', description: 'Site origin. Defaults to the site in tabId.' }
    })
  },
  {
    name: 'apply_preset',
    description:
      'Apply every change in a saved scenario to the site in this tab and reload. The ' +
      'answer reports applied and unapplied counts separately: a change whose source ' +
      'this site no longer loads cannot take effect, and reporting it as applied would ' +
      'be a claim about a page that did not change.',
    inputSchema: schema({ tabId, presetId: { type: 'string' }, refresh }, ['tabId', 'presetId'])
  },
  {
    name: 'save_preset',
    description:
      'Save the changes currently switched on for this site as a named scenario. The ' +
      'changes are copied into it, so later edits to them do not alter what the scenario ' +
      'does.',
    inputSchema: schema(
      {
        tabId,
        name: { type: 'string', description: 'What to call it, e.g. "Flight cancelled".' },
        emoji: { type: 'string', description: 'Optional single emoji shown on the scenario card.' }
      },
      ['tabId', 'name']
    )
  },
  {
    name: 'delete_preset',
    description:
      'Delete a saved scenario. This removes the saved bundle only: any of its changes ' +
      'that are currently switched on for the site stay on, and clear_changes is what ' +
      'turns those off.',
    inputSchema: schema(
      {
        presetId: { type: 'string' },
        tabId,
        origin: { type: 'string', description: 'The site the scenario belongs to. Defaults to the site in tabId, or the active tab.' }
      },
      ['presetId']
    )
  },
  {
    name: 'screenshot',
    description:
      'Take a PNG of the visible part of the tab, activating it first. Version 1 ' +
      'captures the viewport only — a full-page image is not available, and fullPage:true ' +
      'is refused rather than quietly returning a viewport shot.',
    inputSchema: schema({ tabId, fullPage: { type: 'boolean', default: false } }, ['tabId']),
    image: true,
    validate: (args) =>
      args.fullPage === true
        ? 'MockLab can only capture the visible part of a tab in this version. Call screenshot without fullPage.'
        : null
  },
  {
    name: 'reload',
    description:
      'Reload the tab. With waitForSettle (the default) the answer comes back once the ' +
      'page has finished loading, and `settled` says whether MockLab observed the full ' +
      'settle condition it uses during a probe — page loaded, no new requests, no DOM ' +
      'changes — or only that loading finished.',
    inputSchema: schema({ tabId, waitForSettle: { type: 'boolean', default: true } }, ['tabId']),
    // A reload plus §7.3's settle watch is capped at 15s in the extension; the wait here
    // has to outlast that, or the tool would time out on exactly the slow page the
    // settle definition exists for.
    timeoutMs: 45_000
  }
];

/** Every tool by name, for the dispatcher. */
export const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/**
 * Arguments a schema cannot check on its own (§12.4 #5's "one required", #14's refused
 * fullPage). Returns the sentence to hand back, or null.
 *
 * Required-key checking is here rather than left to the SDK: the low-level server does
 * not validate a raw JSON Schema, so without this a missing `sigId` would reach the
 * extension and come back as something less clear than "you left out sigId".
 */
export function validateArguments(tool, args) {
  const given = args && typeof args === 'object' ? args : {};
  const known = Object.keys(tool.inputSchema.properties || {});
  const required = tool.inputSchema.required || [];
  // `given[key] === undefined` and not a falsy test: `value: null` and `value: false`
  // are values a caller means, and refusing them would make two of the states the demo
  // renders unreachable through MCP.
  const missing = required.filter((key) => given[key] === undefined);
  const unknown = Object.keys(given).filter((key) => !known.includes(key));

  // BOTH complaints, not the first one. A misspelled argument produces a missing one as
  // well, and an agent told only "needs value" while it believes it sent `valeu` has
  // been given the less useful half of what this function knows.
  const complaints = [];
  if (missing.length) complaints.push(`${tool.name} needs ${missing.join(', ')}.`);
  if (unknown.length) {
    complaints.push(`${tool.name} does not take ${unknown.join(', ')}. It takes: ${known.join(', ') || 'no arguments'}.`);
  }
  if (complaints.length) return complaints.join(' ');
  return tool.validate ? tool.validate(given) : null;
}
