/**
 * Scroll command — scroll the page or a specific element.
 *
 * Uses chrome.scripting.executeScript to call scrollBy().
 */

import type { NavigationState } from "./navigate.js";
import { unwrapPageResult, type PageResult } from "../lib/page-result.js";

// ── Types ────────────────────────────────────────────────────────

export interface ScrollResult {
  scrolled: string;
  amount: number;
}

// ── Handler ─────────────────────────────────────────────────────

export async function handleScroll(
  params: Record<string, unknown>,
  state: NavigationState
): Promise<ScrollResult> {
  if (state.automationTabId === null) {
    throw new Error("No active automation tab. Navigate to a page first.");
  }

  const tabId = state.automationTabId;
  const direction = params.direction as string;
  const amount = typeof params.amount === "number" ? params.amount : 1;
  const selector = params.selector as string | undefined;

  if (!direction || !["up", "down", "left", "right"].includes(direction)) {
    throw new Error(
      `Invalid direction: "${direction}". Must be "up", "down", "left", or "right".`
    );
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (dir: string, amt: number, sel: string | null): PageResult<string> => {
      try {
        const target = sel ? document.querySelector(sel) : null;
        if (sel && !target) return { ok: false, error: `Element not found: ${sel}` };

        const scrollHeight = window.innerHeight;
        const scrollWidth = window.innerWidth;
        const pixels = amt * (dir === "left" || dir === "right" ? scrollWidth : scrollHeight);

        const dx =
          dir === "left" ? -pixels : dir === "right" ? pixels : 0;
        const dy =
          dir === "up" ? -pixels : dir === "down" ? pixels : 0;

        if (target) {
          (target as HTMLElement).scrollBy({ left: dx, top: dy, behavior: "smooth" });
        } else {
          window.scrollBy({ left: dx, top: dy, behavior: "smooth" });
        }

        return { ok: true, value: `${dir} ${amt} page(s)` };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    args: [direction, amount, selector ?? null],
  });

  const scrolled = unwrapPageResult(results);

  return { scrolled, amount };
}
