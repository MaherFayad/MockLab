/**
 * Service worker entry — wires the background modules together (PLAN.md §2, §2.1).
 *
 * OWNER: shared. Each agent adds only the wiring for its own module and never
 * rewrites another agent's block.
 *
 * Milestone M0 does exactly two things, both of which must work before anything
 * else is built: open the side panel from the toolbar icon, and clear crashed probe
 * state on startup (PLAN.md §17.5 — probe:true Changes are deleted on SW startup,
 * so a browser crash mid-probe can never leave a site silently mocked).
 */

// Toolbar icon opens the side panel (PLAN.md §3).
chrome.sidePanel
  ?.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('[MockLab] sidePanel.setPanelBehavior failed', err));

/**
 * PLAN.md §7.1 / §17.5: probe Changes are internal scaffolding and must never
 * outlive the probe that created them. M4 replaces this with the ruleStore call;
 * until then it is a direct storage sweep so the guarantee holds from day one.
 */
async function deleteCrashedProbeChanges() {
  try {
    const all = await chrome.storage.local.get(null);
    const writes = {};
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith('changes:') || !Array.isArray(value)) continue;
      const kept = value.filter((change) => change && change.probe !== true);
      if (kept.length !== value.length) writes[key] = kept;
    }
    if (Object.keys(writes).length) await chrome.storage.local.set(writes);
  } catch (err) {
    console.error('[MockLab] probe cleanup on startup failed', err);
  }
}

chrome.runtime.onStartup?.addListener(deleteCrashedProbeChanges);
chrome.runtime.onInstalled?.addListener(deleteCrashedProbeChanges);
deleteCrashedProbeChanges();
