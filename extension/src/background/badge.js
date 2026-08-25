/**
 * Toolbar badge — the always-visible count of active Changes (PLAN.md §1.5, §10).
 *
 * OWNER: interceptor-engineer.
 *
 * §1.5: "The badge on the extension icon shows the number of active Changes so the user
 * always knows the page is modified." That promise is only worth anything if the badge
 * is right at every moment the user might glance at it, so it is recomputed on all four
 * events that can change what it should say:
 *
 *   1. the store changed (here, in another window's panel, or from an MCP agent)
 *   2. the user switched tabs
 *   3. the tab navigated — including to a DIFFERENT ORIGIN, where the count is another
 *      site's and must not linger
 *   4. the service worker started (cold start, crash, install, browser restart)
 *
 * The count is per ORIGIN, and it is read from the tab's own URL rather than from the
 * capture state, so a tab MockLab has never intercepted still gets the right badge.
 */

import { originOf, countActiveChanges } from './ruleStore.js';

/**
 * DEVIATION (README "Deviations"): §17.7 says never hardcode a colour hex outside
 * `panel.css`'s `:root` blocks. The badge is drawn by Chrome, not by CSS — there is no
 * stylesheet in reach and `chrome.action.setBadgeBackgroundColor` takes a literal. This
 * is the light-theme `--accent` from §9.1, copied verbatim; §10's site bar asks for the
 * accent colour and this is the only way to give it one.
 */
const ACCENT = '#0066FF';
const BADGE_TEXT = '#FFFFFF';

/** Origins whose badge can never be anything but empty. Skips a storage read per tab. */
function isBadgeable(origin) {
  return typeof origin === 'string' && (origin.startsWith('http://') || origin.startsWith('https://'));
}

/**
 * Newest request per tab. Counting a Change means reading storage, which is async, and
 * a tab that navigates fires several events in quick succession — so two computations
 * for one tab can be in flight at once and finish in the wrong order. Without this the
 * previous site's count can land AFTER the new site's and stick: the badge then claims
 * a page is modified when it is not, which §1.5 exists to prevent.
 * @type {Map<number, number>}
 */
const latestRequest = new Map();

/**
 * Set one tab's badge from a URL we already have.
 * @param {number} tabId
 * @param {string} url
 */
export async function setBadgeForTab(tabId, url) {
  const ticket = (latestRequest.get(tabId) || 0) + 1;
  latestRequest.set(tabId, ticket);
  try {
    const origin = originOf(url || '');
    const count = isBadgeable(origin) ? await countActiveChanges(origin) : 0;
    if (latestRequest.get(tabId) !== ticket) return; // a newer answer already won
    // Per-tab text: two tabs on different sites must not share one number.
    await chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' });
  } catch {
    /* the tab closed mid-flight — nothing to badge */
  }
}

/** @param {number} tabId */
export async function refreshBadgeForTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab) await setBadgeForTab(tabId, tab.url || '');
  } catch {
    /* gone */
  }
}

/**
 * Every tab currently showing `origin`. A Change made in the panel of one tab must
 * update the badge of every other tab on the same site immediately (§1.6 parity).
 * @param {string} origin
 */
export async function refreshBadgesForOrigin(origin) {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs
        .filter((tab) => typeof tab.id === 'number' && originOf(tab.url || '') === origin)
        .map((tab) => setBadgeForTab(tab.id, tab.url || ''))
    );
  } catch (err) {
    console.error('[MockLab] badge refresh for origin failed', err);
  }
}

/** Cold start: every open tab at once. */
export async function refreshAllBadges() {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: ACCENT });
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ color: BADGE_TEXT });
    }
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.filter((tab) => typeof tab.id === 'number').map((tab) => setBadgeForTab(tab.id, tab.url || ''))
    );
  } catch (err) {
    console.error('[MockLab] badge refresh failed', err);
  }
}

/**
 * Wire the three tab events. The store event is wired in background.js, which already
 * owns the single `chrome.storage.onChanged` listener.
 */
export function installBadgeListeners() {
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    void refreshBadgeForTab(tabId);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    latestRequest.delete(tabId);
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // A URL change is the one that matters (a new origin means a new count), but the
    // loading/complete transitions are cheap and cover the in-place reloads that
    // "Apply & refresh page" triggers.
    if (changeInfo.url || changeInfo.status) void setBadgeForTab(tabId, (tab && tab.url) || changeInfo.url || '');
  });

  chrome.tabs.onReplaced?.addListener((addedTabId) => {
    void refreshBadgeForTab(addedTabId);
  });
}
