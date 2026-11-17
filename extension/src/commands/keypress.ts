/**
 * Keypress command — dispatch keyboard events to the page.
 *
 * Uses chrome.scripting.executeScript to fire keydown, keypress, keyup.
 */

import type { NavigationState } from "./navigate.js";

// ── Types ────────────────────────────────────────────────────────

export interface KeypressResult {
  key: string;
}

// ── Handler ─────────────────────────────────────────────────────

export async function handleKeypress(
  params: Record<string, unknown>,
  state: NavigationState
): Promise<KeypressResult> {
  if (state.automationTabId === null) {
    throw new Error("No active automation tab. Navigate to a page first.");
  }

  const tabId = state.automationTabId;
  const key = params.key as string;
  const selector = params.selector as string | undefined;
  const modifiers = (params.modifiers as string[] | undefined) ?? [];

  if (!key) {
    throw new Error("key parameter is required.");
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    func: (k: string, sel: string | null, mods: string[]) => {
      const target =
        (sel ? document.querySelector(sel) : document.activeElement) ||
        document.body;

      const opts: KeyboardEventInit = {
        key: k,
        code: k.length === 1 ? `Key${k.toUpperCase()}` : k,
        bubbles: true,
        cancelable: true,
        ctrlKey: mods.includes("ctrl") || mods.includes("control"),
        shiftKey: mods.includes("shift"),
        altKey: mods.includes("alt"),
        metaKey: mods.includes("meta") || mods.includes("command"),
      };

      target.dispatchEvent(new KeyboardEvent("keydown", opts));

      // Only fire keypress for printable characters
      if (k.length === 1) {
        target.dispatchEvent(new KeyboardEvent("keypress", opts));
      }

      target.dispatchEvent(new KeyboardEvent("keyup", opts));
    },
    args: [key, selector ?? null, modifiers],
  });

  return { key };
}
