/**
 * Chrome Native Messaging protocol — length-prefixed JSON over stdio.
 *
 * Wire format:
 * - 4 bytes: uint32 LE message length
 * - N bytes: UTF-8 JSON payload
 *
 * Max message size: 1MB (Chrome hard limit). Enforced via the shared
 * readLengthPrefixed helper in wire-protocol.ts so the same cap applies
 * to every parser in this codebase.
 */

import { EventEmitter } from "events";
import {
  MAX_MESSAGE_SIZE,
  MessageTooLargeError,
  readLengthPrefixed,
  writeLengthPrefixed,
} from "./wire-protocol.js";

export class NativeMessagingReader extends EventEmitter {
  private buffer: Buffer = Buffer.alloc(0);
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
    let parsed;
    try {
      parsed = readLengthPrefixed(this.buffer, MAX_MESSAGE_SIZE);
    } catch (e) {
      if (e instanceof MessageTooLargeError) {
        this.emit("error", e);
        // Drop the buffer — we can no longer trust framing.
        this.buffer = Buffer.alloc(0);
        return;
      }
      throw e;
    }

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
