/**
 * Read command — extract text content from the page or a specific element.
 *
 * Uses chrome.scripting.executeScript to get innerText.
 */

import type { NavigationState } from "./navigate.js";

// ── Types ────────────────────────────────────────────────────────

export interface ReadResult {
  text: string;
  truncated: boolean;
}

// ── Handler ─────────────────────────────────────────────────────

export async function handleRead(
  params: Record<string, unknown>,
  state: NavigationState
): Promise<ReadResult> {
  if (state.automationTabId === null) {
    throw new Error("No active automation tab. Navigate to a page first.");
  }

  const tabId = state.automationTabId;
  const selector = params.selector as string | undefined;
  const maxLength = typeof params.maxLength === "number" ? params.maxLength : 50000;

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel: string | null) => {
      if (sel) {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`Element not found: ${sel}`);
        return (el as HTMLElement).innerText || "";
      }
      return document.body.innerText || "";
    },
    args: [selector ?? null],
  });

  let text = (results?.[0]?.result as string) ?? "";
  let truncated = false;

  if (text.length > maxLength) {
    text = text.slice(0, maxLength);
    truncated = true;
  }

  return { text, truncated };
}
