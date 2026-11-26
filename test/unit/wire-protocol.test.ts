/**
 * Unit tests for the length-prefixed wire protocol.
 *
 * Run via `npm test`. Node 24 strips TypeScript types at load time, so
 * these files don't need a separate compile step.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  readLengthPrefixed,
  writeLengthPrefixed,
  MessageTooLargeError,
  MAX_MESSAGE_SIZE,
} from "../../native-host/src/wire-protocol.ts";
import { NativeMessagingReader } from "../../native-host/src/native-messaging.ts";

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

  it("reports a frame whose declared length exceeds the cap", () => {
    // Hand-craft a header claiming 4 GiB.
    const header = Buffer.alloc(4);
    header.writeUInt32LE(0xffffffff, 0);
    const { messages, remainder, oversized } = readLengthPrefixed(header);
    assert.deepEqual(messages, []);
    assert.ok(oversized instanceof MessageTooLargeError);
    assert.equal(oversized.declaredLength, 0xffffffff);
    assert.equal(oversized.cap, MAX_MESSAGE_SIZE);
    assert.equal(remainder.length, 4, "remainder starts at the oversized frame's header");
  });

  it("keeps the messages before an oversized frame", () => {
    const buf = Buffer.concat([frame({ a: 1 }), frame({ payload: "x".repeat(100) })]);
    const { messages, oversized } = readLengthPrefixed(buf, 50);
    assert.deepEqual(messages, [{ a: 1 }]);
    assert.ok(oversized instanceof MessageTooLargeError);
  });

  it("decodes a multibyte payload framed by its UTF-8 byte length", () => {
    const msg = { text: "café ✓ 😀" };
    const buf = frame(msg);
    assert.equal(buf.readUInt32LE(0), Buffer.byteLength(JSON.stringify(msg), "utf-8"));
    assert.deepEqual(readLengthPrefixed(buf).messages, [msg]);
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

describe("NativeMessagingReader", () => {
  it("skips exactly the oversized frame and keeps reading the next one", async () => {
    const stream = new PassThrough();
    const reader = new NativeMessagingReader(stream);
    const messages: unknown[] = [];
    const errors: Error[] = [];
    reader.on("message", (m) => messages.push(m));
    reader.on("error", (e: Error) => errors.push(e));

    const fitsInCodeUnitsNotBytes = JSON.stringify({ text: "é".repeat(600_000) });
    const payload = Buffer.from(fitsInCodeUnitsNotBytes, "utf-8");
    assert.ok(fitsInCodeUnitsNotBytes.length < MAX_MESSAGE_SIZE);
    assert.ok(payload.length > MAX_MESSAGE_SIZE);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    const oversized = Buffer.concat([header, payload]);

    stream.write(frame({ before: 1 }));
    stream.write(oversized.subarray(0, 300_000));
    stream.write(oversized.subarray(300_000, 900_000));
    stream.write(Buffer.concat([oversized.subarray(900_000), frame({ after: 2 })]));
    await new Promise<void>((r) => setImmediate(r));

    assert.deepEqual(messages, [{ before: 1 }, { after: 2 }]);
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof MessageTooLargeError);
  });
});
