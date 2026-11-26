/**
 * Unit tests for the per-key serial mutex used to keep two concurrent
 * MCP commands from racing chrome.debugger.attach against each other.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runExclusive,
  __resetMutexes,
} from "../../extension/src/lib/mutex.ts";

const DEADLINE = 1_000;

function defer<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("runExclusive", () => {
  it("serializes tasks on the same key", async () => {
    __resetMutexes();
    const order: string[] = [];
    const a = defer<void>();
    const b = defer<void>();

    const taskA = runExclusive("k", DEADLINE, async () => {
      order.push("A:start");
      await a.promise;
      order.push("A:end");
    });
    const taskB = runExclusive("k", DEADLINE, async () => {
      order.push("B:start");
      await b.promise;
      order.push("B:end");
    });

    // Allow the microtask queue to schedule taskA into running.
    await new Promise<void>((r) => setImmediate(r));

    assert.deepEqual(order, ["A:start"], "B should not have started while A is in flight");

    a.resolve();
    await taskA;
    // Now B can start.
    await new Promise<void>((r) => setImmediate(r));
    assert.deepEqual(order, ["A:start", "A:end", "B:start"]);

    b.resolve();
    await taskB;
    assert.deepEqual(order, ["A:start", "A:end", "B:start", "B:end"]);
  });

  it("runs tasks on different keys in parallel", async () => {
    __resetMutexes();
    const order: string[] = [];
    const a = defer<void>();
    const b = defer<void>();

    const taskA = runExclusive("ka", DEADLINE, async () => {
      order.push("A:start");
      await a.promise;
      order.push("A:end");
    });
    const taskB = runExclusive("kb", DEADLINE, async () => {
      order.push("B:start");
      await b.promise;
      order.push("B:end");
    });

    await new Promise<void>((r) => setImmediate(r));
    // Both should be in-flight because they hold different keys.
    assert.deepEqual(order, ["A:start", "B:start"]);

    b.resolve();
    a.resolve();
    await Promise.all([taskA, taskB]);
  });

  it("does not poison the chain when a prior task throws", async () => {
    __resetMutexes();
    const failed = runExclusive("k", DEADLINE, async () => {
      throw new Error("boom");
    });

    await assert.rejects(failed, /boom/);

    const ok = await runExclusive("k", DEADLINE, async () => "ok");
    assert.equal(ok, "ok");
  });

  it("preserves the return value of the task", async () => {
    __resetMutexes();
    const v = await runExclusive("k", DEADLINE, async () => 42);
    assert.equal(v, 42);
  });

  it("rejects a task that outlives its deadline and frees the key", async () => {
    __resetMutexes();
    const hung = runExclusive("k", 30, () => new Promise<never>(() => {}));
    await assert.rejects(hung, /did not finish within 30ms/);

    const next = await runExclusive("k", 30, async () => "next");
    assert.equal(next, "next");
  });

  it("does not start a task whose deadline passed while it waited", async () => {
    __resetMutexes();
    const slow = defer<void>();
    const first = runExclusive("k", DEADLINE, () => slow.promise);
    let started = false;
    const queued = runExclusive("k", 20, async () => {
      started = true;
    });

    await new Promise((r) => setTimeout(r, 40));
    slow.resolve();
    await first;
    await assert.rejects(queued, /did not start within 20ms/);
    assert.equal(started, false);
  });
});
