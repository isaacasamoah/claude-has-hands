/**
 * Dispatcher — internal command-routing surface for the native host.
 *
 * The native host historically grew two responsibilities glued into
 * `index.ts`: read length-prefixed JSON from Chrome's stdio, and run a
 * Unix socket server that relayed MCP-server commands into Chrome and
 * routed responses back to the right requester.
 *
 * That same routing logic now needs a third caller: the REST server.
 * Rather than re-implement it, both transports (Unix socket + REST) call
 * `Dispatcher.send(action, params)` and get back a Promise<ResponseMessage>.
 * The dispatcher owns id generation, pending-callback bookkeeping, and
 * the bounded request timeout.
 *
 * It is intentionally transport-agnostic: it knows how to talk to Chrome
 * (via an injected `nativeWriter.write`) and how to be told about replies
 * (via `handleResponse`). It does not know about sockets or HTTP.
 */
import type { CommandMessage, ResponseMessage } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface DispatcherOptions {
  /** Send a framed command to Chrome via native messaging. */
  sendToChrome: (msg: CommandMessage) => void;
  /** Override the per-command timeout. Defaults to 30s. */
  timeoutMs?: number;
  /** Override id generation (tests). */
  idGen?: () => string;
}

export class Dispatcher {
  private readonly opts: DispatcherOptions;
  private readonly pending = new Map<
    string,
    {
      resolve: (r: ResponseMessage) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private counter = 0;

  constructor(opts: DispatcherOptions) {
    this.opts = opts;
  }

  /**
   * Generate a request id, send the command to Chrome, and return a
   * promise that resolves when the matching response comes back through
   * `handleResponse`. Rejects if Chrome doesn't reply within the timeout.
   */
  send(action: string, params: Record<string, unknown> = {}): Promise<ResponseMessage> {
    const id = this.opts.idGen ? this.opts.idGen() : this.nextId();
    const cmd: CommandMessage = { id, action, params };
    const timeout = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<ResponseMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Command '${action}' timed out after ${timeout}ms. The extension may not be responding.`
          )
        );
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.opts.sendToChrome(cmd);
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /**
   * Called when a length-prefixed message arrives on Chrome's stdout.
   * Returns true if the message was a reply we were waiting on, false
   * if it looked like an unsolicited event the caller should re-emit.
   */
  handleResponse(msg: ResponseMessage): boolean {
    const cb = this.pending.get(msg.id);
    if (!cb) return false;
    clearTimeout(cb.timer);
    this.pending.delete(msg.id);
    cb.resolve(msg);
    return true;
  }

  /**
   * Reject every outstanding command with the given error. Used on shutdown
   * or when the Chrome side disconnects.
   */
  rejectAll(reason: Error): void {
    for (const [id, cb] of this.pending) {
      clearTimeout(cb.timer);
      cb.reject(reason);
      this.pending.delete(id);
    }
  }

  /** Visible to tests — confirms no callbacks leak. */
  get pendingCount(): number {
    return this.pending.size;
  }

  private nextId(): string {
    this.counter += 1;
    return `disp-${this.counter}-${Date.now()}`;
  }
}
