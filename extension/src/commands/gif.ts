/**
 * gif command — capture a timed sequence of frames (browser_gif).
 *
 * Captures `count` screenshots over a duration via CDP Page.captureScreenshot
 * (the same proven path as browser_screenshot), holding a single CDP attach for
 * the whole window, and returns them as an ordered frame sequence. Useful for
 * seeing motion/animation/loading over a time window.
 *
 * Why a frame sequence and not an encoded .gif file: Chrome native messaging
 * caps a single message at ~1MB, so the returned artifact cannot exceed that.
 * Encoding a true shareable .gif file would need a frame-streaming protocol
 * (many sub-1MB messages reassembled + encoded host-side) — that's a documented
 * follow-up. The frame sequence delivers the core value within the limit.
 *
 * The total response is bounded: frames stop being added once the accumulated
 * base64 size approaches the message limit, and `truncated` is set.
 */

import { withCDP } from "../lib/cdp.js";
import { planFrames } from "./gif-plan.js";
import type { NavigationState } from "./navigate.js";

export { planFrames };

export interface GifFrame {
  index: number;
  /** ms since capture start */
  ts: number;
  /** data: URI JPEG */
  image: string;
}

export interface GifResult {
  frames: GifFrame[];
  frameCount: number;
  intervalMs: number;
  durationMs: number;
  truncated: boolean;
}

const MAX_TOTAL_BASE64 = 850_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function handleGif(
  params: Record<string, unknown>,
  state: NavigationState
): Promise<GifResult> {
  if (state.automationTabId === null) {
    throw new Error("No active automation tab. Navigate to a page first.");
  }

  const tabId = state.automationTabId;
  const durationMs = typeof params.duration === "number" ? params.duration : 3000;
  const fps = typeof params.fps === "number" ? params.fps : 2;
  const maxFrames = typeof params.maxFrames === "number"
    ? Math.max(1, Math.min(params.maxFrames, 12))
    : 8;
  let quality = typeof params.quality === "number" ? params.quality : 30;
  quality = Math.max(1, Math.min(100, quality));

  const { count, intervalMs } = planFrames(durationMs, fps, maxFrames);

  return withCDP(tabId, async (tid) => {
    const frames: GifFrame[] = [];
    let totalBase64 = 0;
    let truncated = false;
    const start = Date.now();

    for (let i = 0; i < count; i++) {
      const shot = (await chrome.debugger.sendCommand({ tabId: tid }, "Page.captureScreenshot", {
        format: "jpeg",
        quality,
      })) as { data: string };

      if (totalBase64 + shot.data.length > MAX_TOTAL_BASE64) {
        truncated = true;
        break;
      }
      totalBase64 += shot.data.length;
      frames.push({
        index: i,
        ts: Date.now() - start,
        image: `data:image/jpeg;base64,${shot.data}`,
      });

      if (i < count - 1) await sleep(intervalMs);
    }

    return {
      frames,
      frameCount: frames.length,
      intervalMs,
      durationMs: Date.now() - start,
      truncated,
    };
  });
}
