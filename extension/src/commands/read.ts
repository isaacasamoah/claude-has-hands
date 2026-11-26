/**
 * Read command — extract text content from the page or a specific element.
 *
 * Uses chrome.scripting.executeScript to get innerText.
 */

import type { NavigationState } from "./navigate.js";
import { unwrapPageResult, type PageResult } from "../lib/page-result.js";

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
    func: (sel: string | null): PageResult<string> => {
      try {
        if (sel) {
          const el = document.querySelector(sel);
          if (!el) return { ok: false, error: `Element not found: ${sel}` };
          return { ok: true, value: (el as HTMLElement).innerText || "" };
        }
        return { ok: true, value: document.body.innerText || "" };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    args: [selector ?? null],
  });

  let text = unwrapPageResult(results);
  let truncated = false;

  if (text.length > maxLength) {
    text = text.slice(0, maxLength);
    truncated = true;
  }

  return { text, truncated };
}
