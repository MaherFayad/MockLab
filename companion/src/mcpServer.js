/**
 * MCP server — the 15 tools in PLAN.md §12.4.
 *
 * Implemented in milestone M6 by the mcp-engineer agent. Kept as a module from M0 so
 * the file tree in PLAN.md §2.1 is stable.
 *
 * The tool names below are the contract: exact names, exact schemas, no additions.
 */
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
