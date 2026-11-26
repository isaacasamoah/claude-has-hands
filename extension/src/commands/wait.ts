/**
 * Wait command — wait for navigation, element existence, or a timeout.
 *
 * Uses chrome.tabs.onUpdated for navigation, executeScript polling for
 * selector existence, and setTimeout for plain timeouts.
 */

import type { NavigationState } from "./navigate.js";

// ── Types ────────────────────────────────────────────────────────

export interface WaitResult {
  waited: string;
  elapsed: number;
}

// ── Handler ─────────────────────────────────────────────────────

export async function handleWait(
  params: Record<string, unknown>,
  state: NavigationState
): Promise<WaitResult> {
  if (state.automationTabId === null) {
    throw new Error("No active automation tab. Navigate to a page first.");
  }

  const tabId = state.automationTabId;
  const condition = params.condition as string;
  const selector = params.selector as string | undefined;
  const timeout = typeof params.timeout === "number" ? params.timeout : 10000;

  if (!condition) {
    throw new Error("condition parameter is required.");
  }

  const start = Date.now();

  switch (condition) {
    case "navigation": {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          reject(new Error(`Navigation wait timed out after ${timeout}ms`));
        }, timeout);

        function listener(
          updatedTabId: number,
          changeInfo: chrome.tabs.TabChangeInfo
        ) {
          if (updatedTabId === tabId && changeInfo.status === "complete") {
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        }

        chrome.tabs.onUpdated.addListener(listener);
      });

      return {
        waited: "navigation",
        elapsed: Date.now() - start,
      };
    }

    case "selector": {
      if (!selector) {
        throw new Error('condition "selector" requires a selector parameter.');
      }

      const pollInterval = 200;

      while (Date.now() - start < timeout) {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: (sel: string) => !!document.querySelector(sel),
          args: [selector],
        });

        if (results?.[0]?.result) {
          return {
            waited: `selector: ${selector}`,
            elapsed: Date.now() - start,
          };
        }

        await new Promise((r) => setTimeout(r, pollInterval));
      }

      throw new Error(`Selector wait timed out after ${timeout}ms: ${selector}`);
    }

    case "timeout": {
      await new Promise((r) => setTimeout(r, timeout));

      return {
        waited: `timeout: ${timeout}ms`,
        elapsed: Date.now() - start,
      };
    }

    default:
      throw new Error(
        `Unknown wait condition: "${condition}". Must be "navigation", "selector", or "timeout".`
      );
  }
}
