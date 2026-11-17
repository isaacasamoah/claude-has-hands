/**
 * Tests for planFrames — the pure gif-capture planner.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planFrames } from "../../extension/src/commands/gif-plan.ts";

test("interval derives from fps and is capped", () => {
  assert.equal(planFrames(3000, 2, 8).intervalMs, 500);
  assert.equal(planFrames(3000, 5, 100).intervalMs, 200);
  // fps over the cap is clamped to 5 → 200ms
  assert.equal(planFrames(3000, 50, 100).intervalMs, 200);
  // fps under 1 clamps to 1 → 1000ms
  assert.equal(planFrames(3000, 0, 100).intervalMs, 1000);
});

test("frame count respects maxFrames", () => {
  // 3000ms @ 2fps → ideal 7, but maxFrames 4 wins
  assert.equal(planFrames(3000, 2, 4).count, 4);
});

test("frame count follows duration when under the cap", () => {
  // 1000ms @ 2fps (500ms interval) → floor(1000/500)+1 = 3
  assert.equal(planFrames(1000, 2, 8).count, 3);
});

test("duration is clamped to the 10s ceiling", () => {
  // 60000ms clamps to 10000 @ 1fps → floor(10000/1000)+1 = 11, capped by maxFrames 12
  const p = planFrames(60_000, 1, 12);
  assert.equal(p.count, 11);
});

test("always at least one frame", () => {
  assert.equal(planFrames(0, 1, 8).count, 1);
});
