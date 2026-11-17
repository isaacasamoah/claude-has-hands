/**
 * Navigation commands — navigate, back, forward.
 *
 * Each function takes command params and returns a NavigationResult.
 * Tab registry and activeTabId are managed via the shared state
 * passed in from background.ts.
 */

export interface NavigationResult {
  title: string;
  url: string;
  tabId: number;
}

export interface NavigationState {
  automationTabId: number | null;
  setAutomationTabId: (id: number | null) => void;
  tabRegistry: Map<number, { url: string; title: string; lastActive: number }>;
}

const LOAD_TIMEOUT = 30_000;

/**
 * Wait for a tab to finish loading (status === "complete").
 * Resolves with the updated tab, or rejects after timeout.
 */
function waitForLoad(tabId: number): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Page load timed out after ${LOAD_TIMEOUT}ms`));
    }, LOAD_TIMEOUT);

    function listener(
      updatedTabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab
    ): void {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function updateRegistry(
  state: NavigationState,
  tab: chrome.tabs.Tab
): NavigationResult {
  const tabId = tab.id!;
  const url = tab.url || "";
  const title = tab.title || "";

  state.setAutomationTabId(tabId);
  state.tabRegistry.set(tabId, { url, title, lastActive: Date.now() });

  return { title, url, tabId };
}

/**
 * Allowed schemes for navigation. http and https only — the browser is
 * authenticated, so any other scheme is a privilege escalation:
 *   - javascript:  → executes attacker-supplied script in the current origin
 *   - data:        → renders attacker-supplied HTML in a same-origin context
 *   - file:        → reads local files via the authed browser
 *   - chrome:/chrome-extension:/view-source:  → privileged surfaces
 *
 * `about:blank` is allowed as a special case (commonly used to clear a tab).
 *
 * The check rejects on string match, not URL parse, because a parsed URL
 * with `protocol === "https:"` could still be `https://x` followed by
 * whitespace — we want the literal prefix.
 */
const ALLOWED_SCHEME_PREFIXES = ["https://", "http://"] as const;
const SPECIAL_ALLOWED = new Set(["about:blank"]);

export class DisallowedSchemeError extends Error {
  readonly url: string;
  constructor(url: string) {
    super(
      `Disallowed URL scheme: ${url}. Only http://, https://, and about:blank are accepted. ` +
        `Schemes like javascript:, data:, file:, chrome:, chrome-extension: and view-source: are rejected because they would let page text or prompt-injected content drive the authenticated browser into privileged contexts.`
    );
    this.name = "DisallowedSchemeError";
    this.url = url;
  }
}

/**
 * Normalize a user-supplied URL and reject anything outside the allowlist.
 *
 * - Trims surrounding whitespace.
 * - If a bare host is supplied (no scheme), prepends https://.
 * - Otherwise the scheme must be in the allowlist.
 */
export function ensureUrl(raw: string): string {
  const trimmed = raw.trim();

  if (SPECIAL_ALLOWED.has(trimmed.toLowerCase())) {
    return trimmed;
  }

  // Detect any scheme (RFC 3986: scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )).
  // If a colon appears before the first slash, the user supplied a scheme.
  const schemeMatch = /^([a-z][a-z0-9+\-.]*):/i.exec(trimmed);

  if (!schemeMatch) {
    // No scheme — treat as a bare host, prepend https://.
    return `https://${trimmed}`;
  }

  const lower = trimmed.toLowerCase();
  for (const prefix of ALLOWED_SCHEME_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return trimmed;
    }
  }

  throw new DisallowedSchemeError(trimmed);
}

/**
 * Navigate to a URL.
 * - If tab === "new", creates a new tab.
 * - Otherwise navigates the current automation tab (or creates one if none exists).
 */
export async function handleNavigate(
  params: Record<string, unknown>,
  state: NavigationState
): Promise<NavigationResult> {
  const rawUrl = params.url as string | undefined;
  if (!rawUrl) {
    throw new Error("Missing required parameter: url");
  }

  const url = ensureUrl(rawUrl);
  const tabParam = params.tab as number | "new" | undefined;

  let tabId: number;

  if (tabParam === "new") {
    const tab = await chrome.tabs.create({ url });
    tabId = tab.id!;
  } else if (typeof tabParam === "number") {
    await chrome.tabs.update(tabParam, { url });
    tabId = tabParam;
  } else if (state.automationTabId !== null) {
    // Use the existing automation tab
    try {
      await chrome.tabs.get(state.automationTabId);
      await chrome.tabs.update(state.automationTabId, { url });
      tabId = state.automationTabId;
    } catch {
      // Automation tab was closed — create a new one
      const tab = await chrome.tabs.create({ url });
      tabId = tab.id!;
    }
  } else {
    // No automation tab yet — create one
    const tab = await chrome.tabs.create({ url });
    tabId = tab.id!;
  }

  const loaded = await waitForLoad(tabId);
  return updateRegistry(state, loaded);
}

/**
 * Go back in browser history for the automation tab.
 */
export async function handleBack(
  _params: Record<string, unknown>,
  state: NavigationState
): Promise<NavigationResult> {
  if (state.automationTabId === null) {
    throw new Error("No active automation tab. Navigate to a page first.");
  }

  const tabId = state.automationTabId;
  await chrome.tabs.goBack(tabId);
  const loaded = await waitForLoad(tabId);
  return updateRegistry(state, loaded);
}

/**
 * Go forward in browser history for the automation tab.
 */
export async function handleForward(
  _params: Record<string, unknown>,
  state: NavigationState
): Promise<NavigationResult> {
  if (state.automationTabId === null) {
    throw new Error("No active automation tab. Navigate to a page first.");
  }

  const tabId = state.automationTabId;
  await chrome.tabs.goForward(tabId);
  const loaded = await waitForLoad(tabId);
  return updateRegistry(state, loaded);
}
