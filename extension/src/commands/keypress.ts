/**
 * Synthetic DOM KeyboardEvents are untrusted and get no default action, such
 * as a form submit on Enter, so keys go through CDP Input.dispatchKeyEvent.
 */

import { withCDP } from "../lib/cdp.js";
import { keyPressEvents } from "../lib/keys.js";
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

  const [keyDown, keyUp] = keyPressEvents(key, modifiers);

  await withCDP(tabId, async (tid) => {
    if (selector) await focusSelector(tid, selector);
    await chrome.debugger.sendCommand({ tabId: tid }, "Input.dispatchKeyEvent", keyDown);
    await chrome.debugger.sendCommand({ tabId: tid }, "Input.dispatchKeyEvent", keyUp);
  });

  return { key };
}

async function focusSelector(tabId: number, selector: string): Promise<void> {
  const res = (await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      return true;
    })()`,
    returnByValue: true,
  })) as {
    result?: { value?: unknown };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  };

  if (res.exceptionDetails) {
    const ex = res.exceptionDetails;
    throw new Error(ex.exception?.description || ex.text || `Invalid selector: ${selector}`);
  }
  if (res.result?.value !== true) {
    throw new Error(`Element not found: ${selector}`);
  }
}
