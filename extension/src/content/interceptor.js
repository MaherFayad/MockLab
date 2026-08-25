/**
 * MAIN-world capture & mock engine (PLAN.md §5).
 *
 * OWNER: interceptor-engineer. Filled in at milestone M1.
 *
 * HARD RULES (PLAN.md §17.1-§17.3) — these hold from the very first line of code:
 *   - Zero imports. MAIN-world scripts cannot use extension modules. Single IIFE.
 *   - Everything inside try/catch. An internal error must NEVER break the host page.
 *   - When no Change matches, return the ORIGINAL Response object — never a
 *     re-serialized copy (that breaks streaming and binary responses).
 *   - Compute no hashes here. sigIds come only from signatures.js in the service
 *     worker; this file matches against a compiled match list it is handed.
 */
(function () {
  'use strict';
  try {
    // M1: save originals FIRST (PLAN.md §5.1), then patch fetch and XMLHttpRequest.
  } catch (err) {
    // Swallow: a broken MockLab must still leave the page working.
  }
})();
