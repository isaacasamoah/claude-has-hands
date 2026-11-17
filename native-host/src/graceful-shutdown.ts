/**
 * Graceful bridge shutdown on Chrome disconnect.
 *
 * The native host is launched by Chrome and tied to the extension's MV3 service
 * worker. When Chrome recycles the worker (memory pressure or its hard lifetime
 * cap), the native port closes and this host receives stdin EOF. If the host
 * reacts by *immediately* deleting the shared bridge state (token/socket/
 * bridge.json), it opens a window where the token is absent on disk and every
 * bridge call hard-fails with "Cannot read bridge token" — until a new host
 * (spawned when the worker reconnects, typically within seconds) rewrites it.
 * That flap is the root cause of the bridge dropping offline mid-session.
 *
 * The fix: on disconnect, HOLD the on-disk state for a short grace period. A
 * reconnecting worker spawns a new host during that window, which rewrites the
 * token/socket/bridge.json under its own pid. When the grace elapses we clean
 * up ONLY if we still own the on-disk state — so a newer host's token is never
 * deleted by this exiting one. In-process resources (socket server, REST,
 * pending requests) are always released; only the shared files are ownership-
 * gated.
 */

export interface GracefulShutdownDeps {
  /** How long to hold the on-disk bridge state before cleaning up. */
  graceMs: number;
  /** True iff this process still owns the on-disk bridge state (pid match). */
  ownsOnDiskState: () => boolean;
  /** Release this process's own resources (socket server, REST, pending). Always safe. */
  releaseInProcess: () => void;
  /** Unlink the shared token/socket/bridge.json. Called ONLY when we still own them. */
  removeOnDiskState: () => void;
  /** Terminate the process. */
  exit: (code: number) => void;
  log: (msg: string) => void;
  /** Injectable timer for tests; defaults to setTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
}

/**
 * Schedule the grace-period shutdown. Returns nothing; the process exits when
 * the grace elapses. In-process resources stay live during grace so a fast
 * reconnect handoff is seamless; on-disk state is preserved and only removed at
 * the end if still owned.
 */
export function scheduleGracefulShutdown(deps: GracefulShutdownDeps): void {
  const { graceMs, ownsOnDiskState, releaseInProcess, removeOnDiskState, exit, log } = deps;
  const setTimer = deps.setTimer ?? setTimeout;

  log(
    `Chrome disconnected (stdin closed). Holding bridge state for ${graceMs}ms ` +
      `in case the service worker reconnects (a new host would claim it).`
  );

  setTimer(() => {
    releaseInProcess();
    if (ownsOnDiskState()) {
      log("Grace elapsed and we still own the bridge state — removing it and exiting.");
      removeOnDiskState();
    } else {
      log("A newer host claimed the bridge during grace — exiting WITHOUT touching on-disk state.");
    }
    exit(0);
  }, graceMs);
}
