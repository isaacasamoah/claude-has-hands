/**
 * Pure capture planner for browser_gif. Kept free of chrome/CDP imports so it
 * can be unit-tested directly under node --test.
 */

/**
 * Plan a gif capture: how many frames and at what interval. fps and duration
 * are clamped to keep frames meaningful and the response under the message
 * limit.
 */
export function planFrames(
  durationMs: number,
  fps: number,
  maxFrames: number
): { count: number; intervalMs: number } {
  const dur = Math.max(200, Math.min(durationMs, 10_000));
  const clampedFps = Math.max(1, Math.min(fps, 5));
  const intervalMs = Math.round(1000 / clampedFps);
  // +1 because we capture at t=0 as well as across the duration.
  const ideal = Math.floor(dur / intervalMs) + 1;
  const count = Math.max(1, Math.min(ideal, maxFrames));
  return { count, intervalMs };
}
