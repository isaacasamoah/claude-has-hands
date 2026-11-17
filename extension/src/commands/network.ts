/**
 * read_network command — read buffered network request metadata from the page.
 *
 * The MAIN-world capture installer (inject.ts) wraps fetch() and
 * XMLHttpRequest and buffers METADATA ONLY (method, url, status, timing) into
 * window.__chh_net_buffer. Request/response bodies are deliberately never
 * captured — they routinely carry auth tokens / PII on the authenticated sites
 * this tool is built for.
 *
 * This handler reads the ring buffer, applies optional url-substring / method /
 * status filtering and a tail limit, and can clear the buffer after reading.
 */

import type { NavigationState } from "./navigate.js";

export interface NetEntry {
  seq: number;
  type: "fetch" | "xhr";
  method: string;
  url: string;
  startTs: number;
  status: number;
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface ReadNetworkResult {
  entries: NetEntry[];
  total: number;
  returned: number;
  captureActive: boolean;
}

/**
 * Decide whether an entry matches the requested status filter.
 * Accepts an exact number, or one of: "error" (failed / non-2xx),
 * "2xx" / "3xx" / "4xx" / "5xx".
 */
export function matchesStatus(entry: NetEntry, status: unknown): boolean {
  if (status === undefined || status === null || status === "") return true;
  if (typeof status === "number") return entry.status === status;
  const s = String(status).toLowerCase();
  if (s === "error") return !!entry.error || !entry.ok;
  const band = /^([2345])xx$/.exec(s);
  if (band) {
    const lo = Number(band[1]) * 100;
    return entry.status >= lo && entry.status < lo + 100;
  }
  const n = Number(s);
  if (!Number.isNaN(n)) return entry.status === n;
  return true;
}

export async function handleReadNetwork(
  params: Record<string, unknown>,
  state: NavigationState
): Promise<ReadNetworkResult> {
  if (state.automationTabId === null) {
    throw new Error("No active automation tab. Navigate to a page first.");
  }

  const tabId = state.automationTabId;
  const urlFilter =
    typeof params.url === "string" ? params.url.toLowerCase() : undefined;
  const method =
    typeof params.method === "string" ? params.method.toUpperCase() : undefined;
  const status = params.status;
  const limit = typeof params.limit === "number" ? params.limit : 100;
  const clear = params.clear === true;

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (doClear: boolean) => {
      const w = window as unknown as {
        __chh_capture_installed?: boolean;
        __chh_net_buffer?: NetEntry[];
      };
      const buf = w.__chh_net_buffer;
      const installed = w.__chh_capture_installed === true;
      const copy = buf ? buf.slice() : [];
      if (doClear && buf) buf.length = 0;
      return { entries: copy, installed };
    },
    args: [clear],
  });

  const out = results?.[0]?.result as
    | { entries: NetEntry[]; installed: boolean }
    | undefined;

  let entries = out?.entries ?? [];
  const captureActive = out?.installed ?? false;

  if (urlFilter) entries = entries.filter((e) => e.url.toLowerCase().includes(urlFilter));
  if (method) entries = entries.filter((e) => e.method === method);
  entries = entries.filter((e) => matchesStatus(e, status));

  const total = entries.length;
  if (limit > 0 && entries.length > limit) {
    entries = entries.slice(entries.length - limit);
  }

  return { entries, total, returned: entries.length, captureActive };
}
