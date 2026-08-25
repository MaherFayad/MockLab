/**
 * WebSocket hub — extension <-> companion transport (PLAN.md §12.2, §12.3).
 *
 * Implemented in milestone M6 by the mcp-engineer agent. Kept as a module from M0 so
 * the file tree in PLAN.md §2.1 is stable and imports never move.
 *
 * Contract (do not change without updating PLAN.md §12.2):
 *   frames   {id, kind:"req"|"res"|"event", op, payload}
 *   binding  127.0.0.1 ONLY
 *   auth     Bearer token from ~/.mocklab/token, 6-digit pairing code (§12.3)
 *   timeout  30s -> "extension not responding — is Chrome open with MockLab installed?"
 */
export const HUB_PATH = '/ext';
export const REQUEST_TIMEOUT_MS = 30_000;
export const EXTENSION_TIMEOUT_MESSAGE =
  'extension not responding — is Chrome open with MockLab installed?';
