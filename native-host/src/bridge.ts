/**
 * Bridge client — connects to the native host's Unix socket.
 *
 * Used by the MCP server to send commands to the extension
 * and receive responses.
 */

import * as net from "net";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { EventEmitter } from "events";
import type { CommandMessage, ResponseMessage } from "./types.js";
import {
  MAX_MESSAGE_SIZE,
  readLengthPrefixed,
  writeLengthPrefixed,
} from "./wire-protocol.js";

const SOCKET_DIR = path.join(os.homedir(), ".claude", "claude-has-hands");
const SOCKET_PATH = path.join(SOCKET_DIR, "bridge.sock");
const TOKEN_PATH = path.join(SOCKET_DIR, "bridge.token");
const CONNECT_TIMEOUT = 5_000;
const RESPONSE_TIMEOUT = 30_000;

export class BridgeClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private _connected = false;
  private pendingCallbacks = new Map<
    string,
    {
      resolve: (value: ResponseMessage) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private requestCounter = 0;

  private readToken(): string {
    // Read the per-session handshake token written by the native host at
    // startup. If the file is missing, the host isn't running — fail fast
    // with a clear hint.
    try {
      return fs.readFileSync(TOKEN_PATH, "utf-8").trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Cannot read bridge token at ${TOKEN_PATH}: ${msg}. Is Chrome running with the claude-has-hands extension enabled? The native host writes this file at startup.`
      );
    }
  }

  /**
   * Attempt one connection to the bridge socket. Resolves on success;
   * rejects with the underlying error on failure (preserving the original
   * error code so the caller can decide whether to retry).
   */
  private connectOnce(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            "Connection timeout. Is Chrome running with the claude-has-hands extension enabled?"
          )
        );
      }, CONNECT_TIMEOUT);

      const socket = net.createConnection(SOCKET_PATH, () => {
        clearTimeout(timer);
        this.socket = socket;
        // Send the handshake before resolving so callers never see an
        // unauthenticated socket.
        try {
          this.sendFrame({ type: "handshake", token });
          this._connected = true;
          resolve();
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });

      socket.on("data", (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.drain();
      });

      socket.on("error", (err: Error) => {
        clearTimeout(timer);
        if (!this.socket) {
          // Surface the raw error so connect() can inspect the code and
          // decide whether to retry. The friendly wrapper message is
          // applied in connect() after retry logic runs.
          reject(err);
        } else {
          this.emit("error", err);
        }
      });

      socket.on("end", () => {
        this.socket = null;
        this._connected = false;
        this.emit("disconnected");
      });
    });
  }

  /**
   * Connect to the bridge with a single 500ms-delayed retry on transient
   * errors (EPIPE / ECONNREFUSED). The native host can take a moment to
   * recreate its socket after Chrome reloads the extension; one retry
   * absorbs that race without masking real failures.
   */
  async connect(): Promise<void> {
    const token = this.readToken();

    try {
      await this.connectOnce(token);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPIPE" && code !== "ECONNREFUSED") {
        // Not a transient case — wrap and rethrow with the original
        // friendly message format so existing callers see the same text.
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Cannot connect to native host: ${msg}. Is Chrome running with the claude-has-hands extension enabled?`
        );
      }
      process.stderr.write(
        `[CHH-bridge] connect ${code} — retrying once after 500ms\n`
      );
      await new Promise((r) => setTimeout(r, 500));
      try {
        await this.connectOnce(token);
      } catch (retryErr) {
        const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        throw new Error(
          `Cannot connect to native host: ${msg}. Is Chrome running with the claude-has-hands extension enabled?`
        );
      }
    }
  }

  private drain(): void {
    const parsed = readLengthPrefixed(this.buffer, MAX_MESSAGE_SIZE);
    this.buffer = parsed.remainder;

    for (const raw of parsed.messages) {
      if (raw && typeof raw === "object" && "__parseError" in raw) {
        // Malformed JSON inside a well-framed message — skip silently.
        continue;
      }
      const msg = raw as { id?: string };
      if (msg.id && this.pendingCallbacks.has(msg.id)) {
        const cb = this.pendingCallbacks.get(msg.id)!;
        clearTimeout(cb.timer);
        this.pendingCallbacks.delete(msg.id);
        cb.resolve(msg as ResponseMessage);
      } else {
        this.emit("event", msg);
      }
    }

    if (parsed.oversized) {
      this.emit("error", parsed.oversized);
      this.socket?.destroy(parsed.oversized);
    }
  }

  private sendFrame(msg: unknown): void {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("Socket not open");
    }
    const { header, payload } = writeLengthPrefixed(msg, MAX_MESSAGE_SIZE);
    this.socket.write(header);
    this.socket.write(payload);
  }

  /**
   * Send a command to the extension via the native host bridge
   * and wait for a response.
   */
  async sendCommand(
    action: string,
    params: Record<string, unknown> = {}
  ): Promise<ResponseMessage> {
    if (!this.socket || this.socket.destroyed) {
      throw new Error(
        "Not connected to native host. Is Chrome running with the claude-has-hands extension enabled?"
      );
    }

    const id = `mcp-${++this.requestCounter}-${Date.now()}`;
    const command: CommandMessage = { id, action, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCallbacks.delete(id);
        reject(
          new Error(
            `Command '${action}' timed out after ${RESPONSE_TIMEOUT}ms. The extension may not be responding.`
          )
        );
      }, RESPONSE_TIMEOUT);

      this.pendingCallbacks.set(id, { resolve, reject, timer });

      try {
        this.sendFrame(command);
      } catch (e) {
        this.pendingCallbacks.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  get connected(): boolean {
    return this._connected;
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.end();
      this.socket = null;
      this._connected = false;
    }
    // Reject all pending requests
    for (const [id, cb] of this.pendingCallbacks) {
      clearTimeout(cb.timer);
      cb.reject(new Error("Disconnected"));
    }
    this.pendingCallbacks.clear();
  }
}
