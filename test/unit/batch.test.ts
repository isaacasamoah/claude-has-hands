/**
 * Tests for runBatchSteps — the shared browser_batch executor.
 *
 * Verifies ordered execution, input validation against the registry, stop-on-
 * first-failure, unknown-tool handling, and nesting rejection. The atomic-call
 * primitive is mocked so this stays a pure unit test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runBatchSteps,
  type AtomicCallOutcome,
} from "../../native-host/src/tool-registry.ts";

function recorder() {
  const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
  const call = async (action: string, input: Record<string, unknown>): Promise<AtomicCallOutcome> => {
    calls.push({ action, input });
    return { success: true, result: { ok: true, action } };
  };
  return { calls, call };
}

test("runs steps in order and maps tool → action", async () => {
  const { calls, call } = recorder();
  const results = await runBatchSteps(
    [
      { tool: "browser_navigate", input: { url: "https://example.com" } },
      { tool: "browser_survey", input: {} },
    ],
    call
  );

  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.ok));
  assert.deepEqual(
    calls.map((c) => c.action),
    ["navigate", "survey"]
  );
});

test("stops at the first failing step", async () => {
  const calls: string[] = [];
  const results = await runBatchSteps(
    [
      { tool: "browser_navigate", input: { url: "https://example.com" } },
      { tool: "browser_click", input: { selector: "#go" } },
      { tool: "browser_survey", input: {} },
    ],
    async (action) => {
      calls.push(action);
      if (action === "click") return { success: false, error: "no such element" };
      return { success: true, result: {} };
    }
  );

  assert.equal(results.length, 2);
  assert.equal(results[1].ok, false);
  assert.match(results[1].error ?? "", /no such element/);
  // survey must not run after the failed click
  assert.deepEqual(calls, ["navigate", "click"]);
});

test("rejects an unknown tool without dispatching", async () => {
  const { calls, call } = recorder();
  const results = await runBatchSteps([{ tool: "browser_teleport" }], call);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.match(results[0].error ?? "", /unknown tool/);
  assert.equal(calls.length, 0);
});

test("rejects invalid input against the tool schema", async () => {
  const { calls, call } = recorder();
  // browser_navigate requires a string url; pass a number.
  const results = await runBatchSteps(
    [{ tool: "browser_navigate", input: { url: 42 } }],
    call
  );
  assert.equal(results[0].ok, false);
  assert.match(results[0].error ?? "", /invalid input/);
  assert.equal(calls.length, 0);
});

test("refuses to nest browser_batch", async () => {
  const { call } = recorder();
  const results = await runBatchSteps(
    [{ tool: "browser_batch", input: { steps: [] } }],
    call
  );
  assert.equal(results[0].ok, false);
  assert.match(results[0].error ?? "", /cannot be nested/);
});
