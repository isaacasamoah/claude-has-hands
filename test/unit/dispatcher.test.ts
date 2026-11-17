/**
 * Unit tests for the Dispatcher — the in-process router that takes
 * `send(action, params)` calls from REST/MCP and turns them into the
 * length-prefixed Chrome native-messaging messages, then matches replies
 * back by id.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Dispatcher } from "../../native-host/src/dispatcher.ts";
import type { CommandMessage, ResponseMessage } from "../../native-host/src/types.ts";

describe("Dispatcher", () => {
  it("forwards commands to Chrome and resolves on matching response", async () => {
    const sent: CommandMessage[] = [];
    let nextId = 0;
    const d = new Dispatcher({
      sendToChrome: (m) => sent.push(m),
      idGen: () => `t-${++nextId}`,
    });

    const promise = d.send("status", { foo: 1 });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].action, "status");
    assert.deepEqual(sent[0].params, { foo: 1 });
    assert.equal(sent[0].id, "t-1");

    const reply: ResponseMessage = { id: "t-1", success: true, result: { ok: true } };
    const consumed = d.handleResponse(reply);
    assert.equal(consumed, true);

    const settled = await promise;
    assert.deepEqual(settled, reply);
    assert.equal(d.pendingCount, 0);
  });

  it("ignores unknown response ids and reports them unconsumed", () => {
    const d = new Dispatcher({ sendToChrome: () => {} });
    const consumed = d.handleResponse({ id: "nope", success: true });
    assert.equal(consumed, false);
  });

  it("times out a command if no response arrives", async () => {
    const d = new Dispatcher({
      sendToChrome: () => {},
      timeoutMs: 20,
    });
    await assert.rejects(d.send("hang"), /timed out/);
    assert.equal(d.pendingCount, 0);
  });

  it("rejects all outstanding commands on rejectAll", async () => {
    const d = new Dispatcher({
      sendToChrome: () => {},
      timeoutMs: 1000,
    });
    const a = d.send("a");
    const b = d.send("b");
    d.rejectAll(new Error("shutdown"));
    await assert.rejects(a, /shutdown/);
    await assert.rejects(b, /shutdown/);
    assert.equal(d.pendingCount, 0);
  });

  it("rejects and cleans up when sendToChrome throws synchronously", async () => {
    const d = new Dispatcher({
      sendToChrome: () => {
        throw new Error("stdin closed");
      },
    });
    await assert.rejects(d.send("status"), /stdin closed/);
    assert.equal(d.pendingCount, 0);
  });
});
