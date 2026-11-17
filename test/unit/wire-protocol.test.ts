/**
 * Unit tests for the length-prefixed wire protocol.
 *
 * Run via `npm test`. Node 24 strips TypeScript types at load time, so
 * these files don't need a separate compile step.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  readLengthPrefixed,
  writeLengthPrefixed,
  MessageTooLargeError,
  MAX_MESSAGE_SIZE,
} from "../../native-host/src/wire-protocol.ts";

function frame(obj: unknown): Buffer {
  const { header, payload } = writeLengthPrefixed(obj);
  return Buffer.concat([header, payload]);
}

describe("readLengthPrefixed", () => {
  it("decodes a single complete frame", () => {
    const buf = frame({ hello: "world" });
    const { messages, remainder } = readLengthPrefixed(buf);
    assert.deepEqual(messages, [{ hello: "world" }]);
    assert.equal(remainder.length, 0);
  });

  it("decodes multiple frames in one buffer", () => {
    const buf = Buffer.concat([frame({ a: 1 }), frame({ b: 2 }), frame({ c: 3 })]);
    const { messages, remainder } = readLengthPrefixed(buf);
    assert.deepEqual(messages, [{ a: 1 }, { b: 2 }, { c: 3 }]);
    assert.equal(remainder.length, 0);
  });

  it("returns the trailing partial frame as remainder", () => {
    const a = frame({ a: 1 });
    const b = frame({ b: 2 });
    // Cut the second frame mid-payload.
    const truncated = Buffer.concat([a, b.subarray(0, b.length - 3)]);
    const { messages, remainder } = readLengthPrefixed(truncated);
    assert.deepEqual(messages, [{ a: 1 }]);
    assert.equal(remainder.length, b.length - 3);
  });

  it("throws MessageTooLargeError when the declared length exceeds the cap", () => {
    // Hand-craft a header claiming 4 GiB.
    const header = Buffer.alloc(4);
    header.writeUInt32LE(0xffffffff, 0);
    assert.throws(
      () => readLengthPrefixed(header),
      (err: unknown) => {
        assert.ok(err instanceof MessageTooLargeError);
        assert.equal((err as MessageTooLargeError).declaredLength, 0xffffffff);
        assert.equal((err as MessageTooLargeError).cap, MAX_MESSAGE_SIZE);
        return true;
      }
    );
  });

  it("throws even with a custom (smaller) cap", () => {
    const buf = frame({ payload: "x".repeat(100) });
    assert.throws(
      () => readLengthPrefixed(buf, 50),
      (err: unknown) => err instanceof MessageTooLargeError
    );
  });

  it("returns __parseError marker for malformed JSON inside a valid frame", () => {
    const bad = Buffer.from("not json");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(bad.length, 0);
    const buf = Buffer.concat([header, bad]);
    const { messages } = readLengthPrefixed(buf);
    assert.equal(messages.length, 1);
    assert.ok(messages[0] && typeof messages[0] === "object");
    assert.ok("__parseError" in (messages[0] as object));
  });

  it("returns nothing on a sub-header buffer", () => {
    const { messages, remainder } = readLengthPrefixed(Buffer.from([0x01, 0x02]));
    assert.deepEqual(messages, []);
    assert.equal(remainder.length, 2);
  });
});

describe("writeLengthPrefixed", () => {
  it("emits the LE-uint32 header followed by the payload", () => {
    const { header, payload } = writeLengthPrefixed({ a: 1 });
    assert.equal(header.length, 4);
    const declared = header.readUInt32LE(0);
    assert.equal(declared, payload.length);
    assert.equal(JSON.parse(payload.toString("utf-8")).a, 1);
  });

  it("refuses to frame an oversized message", () => {
    const big = "x".repeat(MAX_MESSAGE_SIZE + 1);
    assert.throws(
      () => writeLengthPrefixed({ big }),
      (err: unknown) => err instanceof MessageTooLargeError
    );
  });
});
