/**
 * Tests for the active keepalive ping loop.
 *
 * The ping loop is the primary keepalive: it sends a message over the native
 * port every ~20s so the MV3 worker (and the native host behind it) never
 * naps. Here we drive it with a tiny interval and assert it fires repeatedly
 * and that stop() actually halts it (no stacked timers, no fire after stop).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startPingLoop } from "../../extension/src/lib/keepalive.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("startPingLoop fires the tick repeatedly", async () => {
  let count = 0;
  const stop = startPingLoop(() => {
    count += 1;
  }, 5);

  await sleep(40);
  stop();

  assert.ok(count >= 3, `expected at least 3 ticks, got ${count}`);
});

test("stop() halts the loop and no further ticks fire", async () => {
  let count = 0;
  const stop = startPingLoop(() => {
    count += 1;
  }, 5);

  await sleep(20);
  stop();
  const atStop = count;

  await sleep(30);
  assert.equal(count, atStop, "tick fired after stop()");
});

test("a throwing tick does not break the loop", async () => {
  let count = 0;
  const stop = startPingLoop(() => {
    count += 1;
    throw new Error("boom");
  }, 5);

  await sleep(30);
  stop();

  // The loop reschedules in a finally block, so a throwing tick must not stop
  // future ticks — the worker would otherwise nap the first time a ping failed.
  assert.ok(count >= 2, `expected loop to survive throws, got ${count} ticks`);
});
