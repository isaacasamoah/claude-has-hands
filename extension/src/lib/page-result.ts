/**
 * Chrome does not report an exception thrown inside a
 * chrome.scripting.executeScript func: the call resolves with no result.
 */

export type PageResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function unwrapPageResult<T>(
  results: Array<{ result?: PageResult<T> }> | undefined
): T {
  const out = results?.[0]?.result;
  if (!out) {
    throw new Error("The page script returned no result. The page may have navigated during the call.");
  }
  if (!out.ok) throw new Error(out.error);
  return out.value;
}
