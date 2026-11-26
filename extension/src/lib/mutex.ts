/**
 * Used in the extension to serialize CDP-touching commands per tab so two
 * concurrent MCP calls can't race chrome.debugger.attach against each
 * other and leave the tab with a stuck "Browser is being controlled by
 * automated test software" banner.
 */

const chains = new Map<string, Promise<unknown>>();

export async function runExclusive<T>(
  key: string,
  deadlineMs: number,
  fn: () => Promise<T>
): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const deadline = Date.now() + deadlineMs;

  // Build the next link: wait for the previous to settle (success OR
  // failure), then run fn. We swallow the previous error here so a
  // crashed task doesn't poison the chain.
  const next = previous
    .catch(() => undefined)
    .then(() => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Command did not start within ${deadlineMs}ms: earlier commands on the same tab held it.`
        );
      }
      return rejectAfter(
        fn(),
        remaining,
        `Command did not finish within ${deadlineMs}ms. It may still be running in the page.`
      );
    });

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

function rejectAfter<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Test-only: drop all chains. Not exported through any production path. */
export function __resetMutexes(): void {
  chains.clear();
}
