/**
 * eval command — evaluate a JavaScript expression in the page (browser_eval).
 *
 * Runs the expression in the page's main world via CDP Runtime.evaluate, so it
 * has access to the page's own globals (window, document, app state). Promises
 * are awaited and the result is returned by value (serialized), capped in size.
 *
 * This is the claude-in-chrome `javascript_tool` equivalent — a deliberate,
 * operator-driven escape hatch. It is gated behind an explicit tool call (not
 * reachable from page content), unlike navigate(), which blocks javascript:
 * URLs precisely because those would be driven by untrusted page text.
 */

import { withCDP } from "../lib/cdp.js";
import type { NavigationState } from "./navigate.js";

export interface EvalResult {
  /** The returned value, serialized (string for primitives/objects). */
  value: unknown;
  /** The CDP-reported type of the result (string, number, object, ...). */
  type: string;
  /** Whether the serialized value was truncated for size. */
  truncated: boolean;
}

const MAX_VALUE_CHARS = 50_000;

export async function handleEval(
  params: Record<string, unknown>,
  state: NavigationState
): Promise<EvalResult> {
  if (state.automationTabId === null) {
    throw new Error("No active automation tab. Navigate to a page first.");
  }

  const expression = params.expression as string | undefined;
  if (typeof expression !== "string" || expression.length === 0) {
    throw new Error("expression parameter is required.");
  }

  const awaitPromise = params.awaitPromise !== false; // default true
  const tabId = state.automationTabId;

  return withCDP(tabId, async (tid) => {
    const res = (await chrome.debugger.sendCommand({ tabId: tid }, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
      // A bare object literal `{...}` is parsed as a block without this; it
      // matches DevTools console behaviour and is generally what callers expect.
      replMode: true,
    })) as {
      result?: { type: string; value?: unknown; description?: string };
      exceptionDetails?: {
        text?: string;
        exception?: { description?: string; value?: unknown };
      };
    };

    if (res.exceptionDetails) {
      const ex = res.exceptionDetails;
      const detail =
        ex.exception?.description ||
        (ex.exception?.value !== undefined ? String(ex.exception.value) : "") ||
        ex.text ||
        "evaluation threw";
      throw new Error(`Evaluation error: ${detail}`);
    }

    const type = res.result?.type ?? "undefined";
    let value: unknown = res.result?.value;
    let truncated = false;

    // returnByValue gives primitives directly; objects come as the serialized
    // value. Cap the size so a huge return can't blow the message budget.
    if (typeof value === "string") {
      if (value.length > MAX_VALUE_CHARS) {
        value = value.slice(0, MAX_VALUE_CHARS);
        truncated = true;
      }
    } else if (value !== undefined) {
      const serialized = JSON.stringify(value);
      if (typeof serialized === "string" && serialized.length > MAX_VALUE_CHARS) {
        // Too big to round-trip — return the truncated serialized form as text.
        value = serialized.slice(0, MAX_VALUE_CHARS);
        truncated = true;
      }
    }

    // Some results (DOM nodes, functions) don't serialize by value; surface the
    // description so the caller gets something meaningful instead of undefined.
    if (value === undefined && res.result?.description) {
      value = res.result.description;
    }

    return { value, type, truncated };
  });
}
