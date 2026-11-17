/**
 * Keepalive for the MV3 service worker + native messaging port.
 *
 * Two layers:
 *
 * 1. Active ping loop (the primary keepalive). MV3 service workers die after
 *    ~30s of inactivity, and when the worker dies the native messaging port
 *    dies with it — which makes the native host receive stdin EOF and exit,
 *    tearing down the Unix socket and rotating the auth token. The whole
 *    bridge goes offline until something revives the worker. To prevent the
 *    nap in the first place we send a lightweight message over the native
 *    port every PING_INTERVAL_MS. Outbound port traffic resets the worker's
 *    idle timer, so as long as the loop runs the worker (and therefore the
 *    host) stays resident. The loop is self-sustaining: each ping keeps the
 *    worker alive long enough to schedule the next ping.
 *
 * 2. Alarm recovery (the safety net). chrome.alarms persists across service
 *    worker restarts. If the worker dies anyway (e.g. the ping loop couldn't
 *    run because the port was briefly down), the alarm wakes the worker,
 *    which re-runs the service worker script from the top — re-establishing
 *    the connection and restarting the ping loop.
 *
 * The ping interval is deliberately well under the ~30s idle threshold so a
 * single missed tick doesn't let the worker nap.
 */

const KEEPALIVE_ALARM = "chh-keepalive";

/** Send a ping every 20s — comfortably under the ~30s MV3 idle threshold. */
export const PING_INTERVAL_MS = 20_000;

/**
 * Register the alarm-based recovery path. `onWake` runs whenever the alarm
 * fires; the caller uses it to reconnect the native port if it has dropped.
 */
export function setupKeepalive(onWake: () => void): void {
  // 0.5 min (30s) is the minimum alarm period Chrome honours. The alarm is
  // only the recovery net — the active ping loop is what actually keeps the
  // worker resident between alarms.
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEPALIVE_ALARM) {
      onWake();
    }
  });
}

/**
 * Start the active ping loop. `tick` is invoked every PING_INTERVAL_MS and
 * should send a keepalive message over the native port when one is open.
 * Uses a recursive setTimeout (not setInterval) so a slow/blocked tick can
 * never stack up overlapping timers.
 *
 * Returns a stop function, mainly for tests — in the worker the loop is meant
 * to run for the lifetime of the worker.
 */
export function startPingLoop(
  tick: () => void,
  intervalMs: number = PING_INTERVAL_MS
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    timer = setTimeout(() => {
      if (stopped) return;
      try {
        tick();
      } catch {
        // A failing ping must never kill the loop — if it did, the worker
        // would nap the first time a ping threw. Swallow and keep going.
      } finally {
        schedule();
      }
    }, intervalMs);
  };

  schedule();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
