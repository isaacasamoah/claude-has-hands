/**
 * Observe command — inject MutationObserver to watch for DOM changes.
 *
 * "start": inject content script that sets up MutationObserver + navigation listener.
 * "stop": inject script that tears down the observer.
 *
 * The content script sends changes via chrome.runtime.sendMessage,
 * and the background listener forwards them as EventMessages through
 * the native messaging port.
 */

import type { NavigationState } from "./navigate.js";

// ── Types ────────────────────────────────────────────────────────

export interface ObserveResult {
  observeId: string;
  monitoring?: string[];
  stopped?: boolean;
}

// ── Observer registry (background-side) ─────────────────────────

const activeObservers = new Set<string>();

// ── Handler ─────────────────────────────────────────────────────

export async function handleObserve(
  params: Record<string, unknown>,
  state: NavigationState
): Promise<ObserveResult> {
  if (state.automationTabId === null) {
    throw new Error("No active automation tab. Navigate to a page first.");
  }

  const tabId = state.automationTabId;
  const action = params.action as "start" | "stop";
  const observeId = params.observeId as string;

  if (!observeId) {
    throw new Error("observeId parameter is required.");
  }

  if (!action || (action !== "start" && action !== "stop")) {
    throw new Error('action must be "start" or "stop".');
  }

  if (action === "start") {
    const events = (params.events as string[] | undefined) ?? ["dom", "navigation"];

    await chrome.scripting.executeScript({
      target: { tabId },
      func: (oid: string, evts: string[]) => {
        // Clean up any existing observer with this ID
        const existingKey = `__chh_observer_${oid}`;
        const existing = (window as unknown as Record<string, unknown>)[existingKey] as
          | MutationObserver
          | undefined;
        if (existing) {
          existing.disconnect();
        }

        let debounceTimer: ReturnType<typeof setTimeout> | null = null;
        let pendingChanges: Array<{ type: string; target: string; count: number }> = [];

        function flush() {
          if (pendingChanges.length === 0) return;
          const batch = pendingChanges;
          pendingChanges = [];
          chrome.runtime.sendMessage({
            type: "observe_event",
            observe_id: oid,
            event: "dom",
            data: { changes: batch },
          });
        }

        if (evts.includes("dom")) {
          const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
              pendingChanges.push({
                type: m.type,
                target: (m.target as HTMLElement).tagName?.toLowerCase() || "unknown",
                count:
                  m.type === "childList"
                    ? m.addedNodes.length + m.removedNodes.length
                    : 1,
              });
            }
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(flush, 1000);
          });

          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
          });

          (window as unknown as Record<string, unknown>)[existingKey] = observer;
        }

        if (evts.includes("navigation")) {
          // Watch for URL changes via popstate and hashchange
          const navHandler = () => {
            chrome.runtime.sendMessage({
              type: "observe_event",
              observe_id: oid,
              event: "navigation",
              data: { url: location.href, title: document.title },
            });
          };
          window.addEventListener("popstate", navHandler);
          window.addEventListener("hashchange", navHandler);
          (window as unknown as Record<string, unknown>)[`__chh_nav_handler_${oid}`] = navHandler;
        }
      },
      args: [observeId, events],
    });

    activeObservers.add(observeId);

    return { observeId, monitoring: (params.events as string[] | undefined) ?? ["dom", "navigation"] };
  }

  // action === "stop"
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (oid: string) => {
      const observerKey = `__chh_observer_${oid}`;
      const observer = (window as unknown as Record<string, unknown>)[observerKey] as
        | MutationObserver
        | undefined;
      if (observer) {
        observer.disconnect();
        delete (window as unknown as Record<string, unknown>)[observerKey];
      }

      const navKey = `__chh_nav_handler_${oid}`;
      const navHandler = (window as unknown as Record<string, unknown>)[navKey] as
        | EventListener
        | undefined;
      if (navHandler) {
        window.removeEventListener("popstate", navHandler);
        window.removeEventListener("hashchange", navHandler);
        delete (window as unknown as Record<string, unknown>)[navKey];
      }
    },
    args: [observeId],
  });

  activeObservers.delete(observeId);

  return { observeId, stopped: true };
}

/** Check if an observer is active (for background.ts message forwarding) */
export function isObserverActive(observeId: string): boolean {
  return activeObservers.has(observeId);
}
