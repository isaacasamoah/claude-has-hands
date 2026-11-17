/**
 * Screenshot command — capture a screenshot via CDP.
 *
 * Uses Page.captureScreenshot with JPEG format. Automatically
 * reduces quality if the result exceeds 900KB base64.
 */

import { withCDP } from "../lib/cdp.js";
import type { NavigationState } from "./navigate.js";

// ── Types ────────────────────────────────────────────────────────

export interface ScreenshotResult {
  image: string;
}

// ── Handler ─────────────────────────────────────────────────────

const MAX_BASE64_SIZE = 900_000;

export async function handleScreenshot(
  params: Record<string, unknown>,
  state: NavigationState
): Promise<ScreenshotResult> {
  if (state.automationTabId === null) {
    throw new Error("No active automation tab. Navigate to a page first.");
  }

  const tabId = state.automationTabId;
  let quality = typeof params.quality === "number" ? params.quality : 40;

  // Clamp quality to 1-100
  quality = Math.max(1, Math.min(100, quality));

  return withCDP(tabId, async (tid) => {
    let result = (await chrome.debugger.sendCommand(
      { tabId: tid },
      "Page.captureScreenshot",
      { format: "jpeg", quality }
    )) as { data: string };

    // Re-capture at half quality if too large
    if (result.data.length > MAX_BASE64_SIZE && quality > 1) {
      const reducedQuality = Math.max(1, Math.floor(quality / 2));
      result = (await chrome.debugger.sendCommand(
        { tabId: tid },
        "Page.captureScreenshot",
        { format: "jpeg", quality: reducedQuality }
      )) as { data: string };
    }

    return {
      image: `data:image/jpeg;base64,${result.data}`,
    };
  });
}
