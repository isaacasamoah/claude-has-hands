/**
 * Per-key serial mutex.
 *
 * `runExclusive(key, fn)` queues `fn` on a per-key chain — only one task
 * for a given key runs at a time. Failures on one task don't break the
 * chain; the next task starts as soon as the previous one settles.
 *
 * Used in the extension to serialize CDP-touching commands per tab so two
 * concurrent MCP calls can't race chrome.debugger.attach against each
 * other and leave the tab with a stuck "Browser is being controlled by
 * automated test software" banner.
 */

const chains = new Map<string, Promise<unknown>>();

export async function runExclusive<T>(
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();

  // Build the next link: wait for the previous to settle (success OR
  // failure), then run fn. We swallow the previous error here so a
  // crashed task doesn't poison the chain.
  const next = previous
    .catch(() => undefined)
    .then(() => fn());

  // Track the next link as the new tail. When this link settles, if it
  // is still the tail, drop the entry so the map doesn't leak.
  chains.set(key, next);

  // Use a finalizer that compares identity — only clear the slot if no
  // newer task has been queued in the meantime.
  next.finally(() => {
    if (chains.get(key) === next) {
      chains.delete(key);
    }
  }).catch(() => {/* swallow — already surfaced via `next` */});

  return next;
}

/** Test-only: drop all chains. Not exported through any production path. */
export function __resetMutexes(): void {
  chains.clear();
}
