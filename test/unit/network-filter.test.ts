/**
 * Tests for the network read-filter logic (status matching).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesStatus, type NetEntry } from "../../extension/src/commands/network.ts";

function entry(over: Partial<NetEntry>): NetEntry {
  return {
    seq: 0,
    type: "fetch",
    method: "GET",
    url: "https://x/y",
    startTs: 0,
    status: 200,
    ok: true,
    durationMs: 1,
    ...over,
  };
}

test("undefined / empty status matches everything", () => {
  assert.equal(matchesStatus(entry({ status: 500, ok: false }), undefined), true);
  assert.equal(matchesStatus(entry({}), ""), true);
});

test("exact numeric status", () => {
  assert.equal(matchesStatus(entry({ status: 404, ok: false }), 404), true);
  assert.equal(matchesStatus(entry({ status: 200 }), 404), false);
});

test("numeric string status", () => {
  assert.equal(matchesStatus(entry({ status: 301, ok: false }), "301"), true);
});

test('"error" matches failed or non-2xx', () => {
  assert.equal(matchesStatus(entry({ status: 0, ok: false, error: "net" }), "error"), true);
  assert.equal(matchesStatus(entry({ status: 500, ok: false }), "error"), true);
  assert.equal(matchesStatus(entry({ status: 200, ok: true }), "error"), false);
});

test("status bands", () => {
  assert.equal(matchesStatus(entry({ status: 404, ok: false }), "4xx"), true);
  assert.equal(matchesStatus(entry({ status: 503, ok: false }), "5xx"), true);
  assert.equal(matchesStatus(entry({ status: 200 }), "4xx"), false);
  assert.equal(matchesStatus(entry({ status: 204 }), "2xx"), true);
});
