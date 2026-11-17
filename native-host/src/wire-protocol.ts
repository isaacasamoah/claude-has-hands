/**
 * Length-prefixed JSON wire protocol — shared parser/writer.
 *
 * Wire format:
 *   - 4 bytes: uint32 LE message length
 *   - N bytes: UTF-8 JSON payload
 *
 * One helper is used in three places (Chrome stdio, native-host's MCP
 * socket, bridge client) so the 1MB cap is enforced consistently and
 * an attacker can't hand any of them a 4 GiB length and force a giant
 * Buffer.alloc.
 */

import type { Buffer as NodeBuffer } from "node:buffer";

/** 1 MB — Chrome's hard limit for native messaging. We mirror it everywhere. */
export const MAX_MESSAGE_SIZE = 1_024_000;

export class MessageTooLargeError extends Error {
  readonly declaredLength: number;
  readonly cap: number;
  constructor(declaredLength: number, cap: number) {
    super(`Message too large: declared ${declaredLength} bytes, cap ${cap} bytes`);
    this.name = "MessageTooLargeError";
    this.declaredLength = declaredLength;
    this.cap = cap;
  }
}

/**
 * Drain length-prefixed messages from a buffer.
 *
 * Returns the messages decoded so far and the unconsumed tail (a fresh
 * Buffer that the caller stores until more bytes arrive). If the declared
 * length of the *next* frame exceeds `maxBytes`, throws MessageTooLargeError
 * before allocating — the caller should close the connection.
 *
 * Pure: no I/O, no side effects on the input buffer.
 */
export function readLengthPrefixed(
  buffer: Buffer,
  maxBytes: number = MAX_MESSAGE_SIZE
): { messages: unknown[]; remainder: Buffer } {
  const messages: unknown[] = [];
  let offset = 0;

  while (offset + 4 <= buffer.length) {
    const msgLen = buffer.readUInt32LE(offset);

    if (msgLen > maxBytes) {
      throw new MessageTooLargeError(msgLen, maxBytes);
    }

    if (offset + 4 + msgLen > buffer.length) {
      // Need more bytes for this frame.
      break;
    }

    const jsonBytes = buffer.subarray(offset + 4, offset + 4 + msgLen);
    try {
      messages.push(JSON.parse(jsonBytes.toString("utf-8")));
    } catch (e) {
      // Malformed JSON inside a well-framed message — skip the frame, keep
      // draining. The caller decides whether to log.
      messages.push({ __parseError: String(e) });
    }
    offset += 4 + msgLen;
  }

  return { messages, remainder: buffer.subarray(offset) };
}

/**
 * Frame a message for the wire. Throws if the encoded payload would exceed
 * `maxBytes` so we can never send a frame the receiver will refuse.
 */
export function writeLengthPrefixed(
  msg: unknown,
  maxBytes: number = MAX_MESSAGE_SIZE
): { header: Buffer; payload: Buffer } {
  const json = JSON.stringify(msg);
  const payload = Buffer.from(json, "utf-8");

  if (payload.length > maxBytes) {
    throw new MessageTooLargeError(payload.length, maxBytes);
  }

  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return { header, payload };
}

// Re-export for callers that import via this module rather than node:buffer.
export type { NodeBuffer };
