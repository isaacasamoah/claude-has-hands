/**
 * file_upload command — set files on a file <input> (browser_file_upload).
 *
 * File inputs are usually hidden (sites overlay a styled button and forward the
 * click), so accessibility-tree / survey-index targeting rarely surfaces them.
 * This tool therefore targets by CSS selector and uses CDP DOM.setFileInputFiles
 * to attach local files — the only reliable way, since synthesizing a real OS
 * file picker isn't possible from a page.
 *
 * Paths are read from the local filesystem by Chrome (the machine running the
 * browser). They must be absolute.
 */

import { withCDP } from "../lib/cdp.js";
import type { NavigationState } from "./navigate.js";

export interface FileUploadResult {
  selector: string;
  files: string[];
  count: number;
}

export async function handleFileUpload(
  params: Record<string, unknown>,
  state: NavigationState
): Promise<FileUploadResult> {
  if (state.automationTabId === null) {
    throw new Error("No active automation tab. Navigate to a page first.");
  }

  const selector = params.selector as string | undefined;
  if (typeof selector !== "string" || selector.length === 0) {
    throw new Error("selector parameter is required (CSS selector for the file input).");
  }

  const filesRaw = params.files;
  const files = Array.isArray(filesRaw)
    ? filesRaw.filter((f): f is string => typeof f === "string")
    : typeof filesRaw === "string"
      ? [filesRaw]
      : [];
  if (files.length === 0) {
    throw new Error("files parameter is required (an absolute path or array of paths).");
  }
  for (const f of files) {
    if (!f.startsWith("/")) {
      throw new Error(`File paths must be absolute: ${f}`);
    }
  }

  const tabId = state.automationTabId;

  return withCDP(tabId, async (tid) => {
    await chrome.debugger.sendCommand({ tabId: tid }, "DOM.enable");
    const doc = (await chrome.debugger.sendCommand({ tabId: tid }, "DOM.getDocument", {
      depth: 0,
    })) as { root: { nodeId: number } };

    const found = (await chrome.debugger.sendCommand({ tabId: tid }, "DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector,
    })) as { nodeId: number };

    if (!found.nodeId) {
      throw new Error(`No element matches selector: ${selector}`);
    }

    try {
      await chrome.debugger.sendCommand({ tabId: tid }, "DOM.setFileInputFiles", {
        files,
        nodeId: found.nodeId,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Failed to set files on ${selector}: ${msg}. Confirm the selector targets an <input type="file"> and the paths exist and are absolute.`
      );
    }

    return { selector, files, count: files.length };
  });
}
