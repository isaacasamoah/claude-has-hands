/**
 * Tests for scheduleGracefulShutdown — the Chrome-disconnect grace period that
 * stops the bridge token from vanishing during an MV3 service-worker recycle.
 *
 * The fake timer captures the scheduled callback so we can assert both the
 * "held during grace" and "acted after grace" halves without real time, and
 * the ownership branch proves an exiting host never deletes a newer host's
 * on-disk state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scheduleGracefulShutdown } from "../../native-host/src/graceful-shutdown.ts";

function harness(owns: boolean) {
  const calls = {
    releaseInProcess: 0,
    removeOnDiskState: 0,
    exit: [] as number[],
    logs: [] as string[],
  };
  let scheduled: { fn: () => void; ms: number } | null = null;
  scheduleGracefulShutdown({
    graceMs: 8000,
    ownsOnDiskState: () => owns,
    releaseInProcess: () => calls.releaseInProcess++,
    removeOnDiskState: () => calls.removeOnDiskState++,
    exit: (code) => calls.exit.push(code),
    log: (m) => calls.logs.push(m),
    setTimer: (fn, ms) => {
      scheduled = { fn, ms };
      return 0;
    },
  });
  return { calls, fire: () => scheduled!.fn(), delay: () => scheduled!.ms };
}

test("holds the bridge state during grace — nothing torn down before the timer fires", () => {
  const h = harness(true);
  // Grace scheduled at the configured delay; NO teardown yet.
  assert.equal(h.delay(), 8000);
  assert.equal(h.calls.releaseInProcess, 0);
  assert.equal(h.calls.removeOnDiskState, 0);
  assert.equal(h.calls.exit.length, 0);
});

test("genuine shutdown: still own the state after grace → remove it and exit", () => {
  const h = harness(true);
  h.fire();
  assert.equal(h.calls.releaseInProcess, 1);
  assert.equal(h.calls.removeOnDiskState, 1); // owned → cleaned up
  assert.deepEqual(h.calls.exit, [0]);
});

test("reconnect handoff: a newer host owns the state → NEVER delete its token", () => {
  const h = harness(false); // a newer host claimed bridge.json during grace
  h.fire();
  assert.equal(h.calls.releaseInProcess, 1); // our own resources still released
  assert.equal(h.calls.removeOnDiskState, 0); // the fix: newer host's token untouched
  assert.deepEqual(h.calls.exit, [0]);
  assert.ok(h.calls.logs.some((l) => /newer host/i.test(l)));
});
