/**
 * Side panel UI logic (PLAN.md §10). No framework, no build step.
 *
 * OWNER: panel-designer. Filled in at milestone M2.
 *
 * Rule §17.6: every user-visible string comes from strings.js.
 * Rule §17.8: every message uses a constant from messages.js.
 */
import { S } from './strings.js';

const boot = document.getElementById('boot');
if (boot) boot.textContent = S.boot.loading;
