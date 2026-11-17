/**
 * read_console command — read buffered console output from the page.
 *
 * The MAIN-world capture installer (inject.ts, registered at document_start)
 * buffers console.* output plus uncaught errors and unhandled rejections into
 * window.__chh_console_buffer. This handler reads that ring buffer via an
 * executeScript hop into the MAIN world, applies optional level filtering and
 * a tail limit, and can clear the buffer after reading.
 *
 * If capture is not active (e.g. the page loaded before the extension
 * registered the capture script), `captureActive` is false and the caller is
 * told to reload the page.
 */

import type { NavigationState } from "./navigate.js";

export interface ConsoleEntry {
  seq: number;
  ts: number;
  level: string;
  text: string;
}

export interface ReadConsoleResult {
  entries: ConsoleEntry[];
  total: number;
  returned: number;
  captureActive: boolean;
}

export async function handleReadConsole(
  params: Record<string, unknown>,
  state: NavigationState
): Promise<ReadConsoleResult> {
  if (state.automationTabId === null) {
    throw new Error("No active automation tab. Navigate to a page first.");
  }

  const tabId = state.automationTabId;
  const level = typeof params.level === "string" ? params.level : undefined;
  const limit = typeof params.limit === "number" ? params.limit : 100;
  const clear = params.clear === true;

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (doClear: boolean) => {
      const w = window as unknown as {
        __chh_capture_installed?: boolean;
        __chh_console_buffer?: ConsoleEntry[];
      };
      const buf = w.__chh_console_buffer;
      const installed = w.__chh_capture_installed === true;
      const copy = buf ? buf.slice() : [];
      if (doClear && buf) buf.length = 0;
      return { entries: copy, installed };
    },
    args: [clear],
  });

  const out = results?.[0]?.result as
    | { entries: ConsoleEntry[]; installed: boolean }
    | undefined;

  let entries = out?.entries ?? [];
  const captureActive = out?.installed ?? false;

  if (level && level !== "all") {
    entries = entries.filter((e) => e.level === level);
  }

  const total = entries.length;
  if (limit > 0 && entries.length > limit) {
    entries = entries.slice(entries.length - limit);
  }

  return { entries, total, returned: entries.length, captureActive };
}
