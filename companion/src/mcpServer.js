/**
 * MCP server — the 15 tools in PLAN.md §12.4.
 *
 * OWNER: mcp-engineer.
 *
 * The tool names below are the contract: exact names, exact schemas, no additions.
 * `TOOL_NAMES` is the frozen list §12.4 numbers 1-15, in its order; `tools.js` holds the
 * schemas and is checked against this list at load, so a tool renamed in one file and
 * not the other fails on import rather than at the first call an agent makes.
 *
 * WHAT THIS FILE MAY AND MAY NOT DECIDE. It forwards; it does not conclude. Every answer
 * an agent reads is the extension's answer, passed through. In particular nothing here
 * computes a link state: §17.4 allows exactly one place in the codebase to decide that a
 * link is proved, and it is in the browser, not here (§17.12 — a wrong "Verified" told to
 * an agent is the same lie as one told to a person, and it will be repeated in prose to
 * a human who cannot see the page).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { TOOLS, TOOL_BY_NAME, validateArguments } from './tools.js';
import { HubError } from './hub.js';

export const TOOL_NAMES = Object.freeze([
  'list_tabs',
  'list_sources',
  'get_response',
  'search_value',
  'probe_element',
  'get_bindings',
  'set_value',
  'clear_changes',
  'highlight',
  'list_presets',
  'apply_preset',
  'save_preset',
  'delete_preset',
  'screenshot',
  'reload'
]);

/**
 * The names and the schemas are written in two files and must be one list. Checked on
 * import: a mismatch here is not something to discover from a tool call.
 */
{
  const declared = TOOLS.map((tool) => tool.name);
  const same = declared.length === TOOL_NAMES.length && declared.every((name, i) => name === TOOL_NAMES[i]);
  if (!same) {
    throw new Error(
      `tools.js declares [${declared.join(', ')}]; PLAN.md §12.4 fixes [${TOOL_NAMES.join(', ')}] ` +
        'in that order. The names and the order are the contract.'
    );
  }
}

/** §12.4: "put this in the MCP server's top-level `instructions` string". */
export const INSTRUCTIONS = [
  'MockLab lets you change what a website receives from its own APIs, so the site renders a',
  'different state with its own code. Nothing in the page is edited — the data is.',
  '',
  'Happy path: list_tabs -> list_sources -> search_value("On time") -> set_value(..., "CANCELLED")',
  '-> reload -> screenshot.',
  '',
  'For guaranteed correctness, run probe_element FIRST and then edit the field of the verified',
  'binding it returns. search_value returns GUESSES from value matching; only probe_element',
  'proves which field drives an element, and only it can produce a verified link. Never tell a',
  'person a link is verified because a value matched — check the state MockLab returns.',
  '',
  'Everything is local to this browser and reversible: clear_changes puts a site back.'
].join('\n');

/** Text content, pretty enough to read in a transcript. */
const asText = (value) => ({ type: 'text', text: JSON.stringify(value, null, 2) });

/**
 * One tool answer -> MCP content.
 *
 * §12.4 #14 returns `{image: base64 png}`. It is returned BOTH ways: as an MCP image
 * block, so a model can actually look at the screenshot (which is what §16's M6 DoD
 * asks for — "returns a screenshot with a red pill"), and as JSON without the pixels, so
 * the transcript stays readable and the agent can still see the tab and size it got.
 */
function contentFor(tool, answer) {
  if (!tool.image || !answer || typeof answer.image !== 'string') return [asText(answer)];
  const { image, ...rest } = answer;
  return [
    { type: 'image', data: image, mimeType: answer.mimeType || 'image/png' },
    asText({ ...rest, image: `<${image.length} base64 characters, returned as the image above>` })
  ];
}

/** An honest failure, as an MCP tool error (§12.4: "MCP tool-errors with the honest reason"). */
const toolError = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

/**
 * @param {{hub: ReturnType<import('./hub.js').createHub>, name?:string, version?:string}} deps
 */
export function createMcpServer(deps) {
  const hub = deps.hub;
  const server = new Server(
    { name: deps.name || 'mocklab', version: deps.version || '1.0.0' },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = TOOL_BY_NAME.get(request.params.name);
    if (!tool) return toolError(`MockLab has no tool called ${request.params.name}.`);

    const args = request.params.arguments || {};
    const complaint = validateArguments(tool, args);
    if (complaint) return toolError(complaint);

    // §12.4 #5: "Long-running: send MCP progress notifications at each state change."
    const progressToken = extra && extra._meta ? extra._meta.progressToken : undefined;
    const onProgress =
      tool.progress && progressToken !== undefined
        ? (update) => {
            void extra.sendNotification({
              method: 'notifications/progress',
              params: {
                progressToken,
                progress: Number(update.progress) || 0,
                ...(update.total !== undefined ? { total: Number(update.total) } : {}),
                ...(update.message ? { message: String(update.message) } : {})
              }
            });
          }
        : null;

    let answer;
    try {
      // `extra.signal` is MCP's own cancellation. Forwarded rather than answered here:
      // a client that walks away from a probe leaves a page reloading in front of a
      // person for up to §7.1's three minutes, and only the browser can stop that.
      answer = await hub.request(tool.name, args, {
        timeoutMs: tool.timeoutMs,
        onProgress,
        signal: extra ? extra.signal : undefined
      });
    } catch (err) {
      // A hub error is a fact about the connection, and it is already a sentence a
      // person could act on. Anything else is a defect here, and says so rather than
      // being dressed up as a finding about the browser.
      if (err instanceof HubError) return toolError(err.message);
      return toolError(`MockLab's companion failed while running ${tool.name}: ${String(err && err.message)}`);
    }

    if (!answer || typeof answer !== 'object') {
      return toolError(`MockLab returned nothing for ${tool.name}.`);
    }
    if (answer.ok === false) {
      // `message` is the extension's own honest sentence (§11 copy, chosen there so
      // MockLab's words live in one file); `reason` is the machine code behind it.
      return toolError(answer.message || `MockLab could not do that: ${answer.reason || 'no reason given'}`);
    }
    return { content: contentFor(tool, answer) };
  });

  return server;
}
