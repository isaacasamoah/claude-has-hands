/**
 * CDP lifecycle helper — ephemeral debugger attach/detach.
 *
 * Attaches the Chrome DevTools Protocol debugger to a tab,
 * runs a callback, and ALWAYS detaches even if the callback throws.
 */

export async function withCDP<T>(
  tabId: number,
  fn: (tabId: number) => Promise<T>
): Promise<T> {
  await chrome.debugger.attach({ tabId }, "1.3");
  try {
    return await fn(tabId);
  } finally {
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // Already detached or tab closed — ignore
    }
  }
}
