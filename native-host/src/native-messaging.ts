/**
 * Chrome Native Messaging protocol — length-prefixed JSON over stdio.
 *
 * Wire format:
 * - 4 bytes: uint32 LE message length
 * - N bytes: UTF-8 JSON payload
 */

import { EventEmitter } from "events";
import {
  MAX_MESSAGE_SIZE,
  readLengthPrefixed,
  writeLengthPrefixed,
} from "./wire-protocol.ts";

export class NativeMessagingReader extends EventEmitter {
  private buffer: Buffer = Buffer.alloc(0);
  private oversizedBytesLeft = 0;
  private stream: NodeJS.ReadableStream;

  constructor(stream: NodeJS.ReadableStream) {
    super();
    this.stream = stream;

    this.stream.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });

    this.stream.on("end", () => {
      this.emit("end");
    });

    this.stream.on("error", (err: Error) => {
      this.emit("error", err);
    });
  }

  private drain(): void {
    for (;;) {
      const skipped = Math.min(this.oversizedBytesLeft, this.buffer.length);
      this.buffer = this.buffer.subarray(skipped);
      this.oversizedBytesLeft -= skipped;
      if (this.oversizedBytesLeft > 0) return;

      const parsed = readLengthPrefixed(this.buffer, MAX_MESSAGE_SIZE);
      this.buffer = parsed.remainder;
      for (const msg of parsed.messages) {
        if (msg && typeof msg === "object" && "__parseError" in msg) {
          this.emit(
            "error",
            new Error(`Invalid JSON in native message: ${(msg as { __parseError: string }).__parseError}`)
          );
          continue;
        }
        this.emit("message", msg);
      }

      if (!parsed.oversized) return;
      this.emit("error", parsed.oversized);
      this.oversizedBytesLeft = 4 + parsed.oversized.declaredLength;
    }
  }
}

export class NativeMessagingWriter {
  private stream: NodeJS.WritableStream;

  constructor(stream: NodeJS.WritableStream) {
    this.stream = stream;
  }

  write(msg: unknown): void {
    const { header, payload } = writeLengthPrefixed(msg, MAX_MESSAGE_SIZE);
    this.stream.write(header);
    this.stream.write(payload);
  }
}
