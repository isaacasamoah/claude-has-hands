/**
 * Tabs command — list, switch, create, and close browser tabs.
 */

import type { NavigationState } from "./navigate.js";

// ── Types ────────────────────────────────────────────────────────

export interface TabsResult {
  action: string;
  tabs?: Array<{
    id: number;
    url: string;
    title: string;
    active: boolean;
    isAutomationTab: boolean;
  }>;
  tabId?: number;
  url?: string;
  title?: string;
  closed?: boolean;
}

// ── Handler ─────────────────────────────────────────────────────

export async function handleTabs(
  params: Record<string, unknown>,
  state: NavigationState
): Promise<TabsResult> {
  const action = params.action as string;

  if (!action) {
    throw new Error("action parameter is required.");
  }

  switch (action) {
    case "list": {
      const chromeTabs = await chrome.tabs.query({});
      const tabs = chromeTabs.map((t) => ({
        id: t.id!,
        url: t.url || "",
        title: t.title || "",
        active: t.active || false,
        isAutomationTab: t.id === state.automationTabId,
      }));
      return { action: "list", tabs };
    }

    case "switch": {
      const tabId = params.tabId as number | undefined;
      const url = params.url as string | undefined;

      if (tabId !== undefined) {
        // Verify tab exists
        await chrome.tabs.get(tabId);
        await chrome.tabs.update(tabId, { active: true });
        state.setAutomationTabId(tabId);
        const tab = await chrome.tabs.get(tabId);
        state.tabRegistry.set(tabId, {
          url: tab.url || "",
          title: tab.title || "",
          lastActive: Date.now(),
        });
        return {
          action: "switch",
          tabId,
          url: tab.url || "",
          title: tab.title || "",
        };
      }

      if (url) {
        const chromeTabs = await chrome.tabs.query({});
        const match = chromeTabs.find(
          (t) => t.url && t.url.includes(url)
        );
        if (!match || !match.id) {
          throw new Error(`No tab found matching URL substring: "${url}"`);
        }
        await chrome.tabs.update(match.id, { active: true });
        state.setAutomationTabId(match.id);
        state.tabRegistry.set(match.id, {
          url: match.url || "",
          title: match.title || "",
          lastActive: Date.now(),
        });
        return {
          action: "switch",
          tabId: match.id,
          url: match.url || "",
          title: match.title || "",
        };
      }

      throw new Error("switch requires either tabId or url parameter.");
    }

    case "new": {
      const url = params.url as string | undefined;
      const tab = await chrome.tabs.create(url ? { url } : {});
      const tabId = tab.id!;
      state.setAutomationTabId(tabId);
      state.tabRegistry.set(tabId, {
        url: tab.url || "",
        title: tab.title || "",
        lastActive: Date.now(),
      });
      return {
        action: "new",
        tabId,
        url: tab.url || "",
        title: tab.title || "",
      };
    }

    case "close": {
      const tabId = params.tabId as number | undefined;
      if (tabId === undefined) {
        throw new Error("close requires tabId parameter.");
      }
      await chrome.tabs.remove(tabId);
      state.tabRegistry.delete(tabId);
      if (state.automationTabId === tabId) {
        state.setAutomationTabId(null);
      }
      return { action: "close", tabId, closed: true };
    }

    default:
      throw new Error(
        `Unknown tabs action: "${action}". Must be "list", "switch", "new", or "close".`
      );
  }
}
