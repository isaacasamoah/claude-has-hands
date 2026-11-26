/**
 * Claude Has Hands — Native Messaging Host
 *
 * Chrome spawns this process via connectNative("com.claude.has_hands").
 * It reads/writes length-prefixed JSON on stdin/stdout (Chrome native messaging).
 * It also opens a Unix domain socket at ~/.claude/claude-has-hands/bridge.sock
 * so the MCP server can send commands and receive responses.
 *
 * Flow:
 *   MCP server --[unix socket]--> this process --[native messaging]--> Chrome extension
 *   Chrome extension --[native messaging]--> this process --[unix socket]--> MCP server
 *
 * Authentication: at startup, this process writes a 32-byte random token to
 * `~/.claude/claude-has-hands/bridge.token` mode 0600. Every client must send
 * `{type:"handshake", token:"..."}` as its first message; otherwise the
 * connection is closed before any command is dispatched. The token file is
 * readable only by the same UNIX user, so an attacker on the box would
 * already need user-level access to read it.
 */

import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { NativeMessagingReader, NativeMessagingWriter } from "./native-messaging.js";
import {
  MAX_MESSAGE_SIZE,
  MessageTooLargeError,
  readLengthPrefixed,
  writeLengthPrefixed,
} from "./wire-protocol.js";
import type { CommandMessage, ResponseMessage } from "./types.js";
import { Dispatcher } from "./dispatcher.ts";
import { startRestServer, type RestServerHandle } from "./rest-server.ts";
import { scheduleGracefulShutdown } from "./graceful-shutdown.ts";

const LOG_PREFIX = "[CHH-Host]";
// Overridable for tests/integration so a spawned host can use a temp dir
// instead of the live bridge under ~/.claude.
const SOCKET_DIR = process.env.CHH_BRIDGE_DIR ?? path.join(os.homedir(), ".claude", "claude-has-hands");
const SOCKET_PATH = path.join(SOCKET_DIR, "bridge.sock");
const TOKEN_PATH = path.join(SOCKET_DIR, "bridge.token");
const BRIDGE_JSON_PATH = path.join(SOCKET_DIR, "bridge.json");
// How long to hold the bridge token/socket after Chrome disconnects, so an MV3
// service-worker recycle (new host in seconds) hands off without the token
// vanishing. Env-overridable (bump toward 35000 to also span the ~30s alarm
// recovery when the worker is idle-recycled).
const GRACE_MS = Number(process.env.CHH_BRIDGE_GRACE_MS ?? 8000);

// ── Native Messaging (Chrome side) ───────────────────────────────

const nativeReader = new NativeMessagingReader(process.stdin);
const nativeWriter = new NativeMessagingWriter(process.stdout);

// Track pending requests from MCP server awaiting extension responses
const pendingRequests = new Map<string, net.Socket>();

// Active MCP server connection (only one at a time — newer wins)
let mcpSocket: net.Socket | null = null;

// ── Dispatcher (REST + future MCP-over-REST callers) ──────────────
//
// The Unix socket retains its per-socket pendingRequests map so the
// legacy MCP-stdio adapter (Claude Code) keeps working byte-for-byte
// during the migration. The Dispatcher is a parallel path that REST
// (and the new MCP adapter) feed into.

const dispatcher = new Dispatcher({
  sendToChrome: (msg: CommandMessage) => nativeWriter.write(msg),
});

// ── Chrome -> {Dispatcher, Unix socket, broadcast event} relay ───

nativeReader.on("message", (msg: ResponseMessage) => {
  void handleChromeMessage(msg).catch((err) => {
    const text = err instanceof Error ? err.message : String(err);
    log(`Chrome response routing error: ${text}`);
  });
});

async function handleChromeMessage(msg: ResponseMessage): Promise<void> {
  // Keepalive frames are sent worker → host every ~20s to keep the MV3
  // service worker (and therefore this process, via the open native port)
  // resident. They carry no id and expect no reply — drop them before the
  // routing logic, or the unsolicited-event fallthrough would forward junk
  // to the MCP client.
  if ((msg as { type?: string }).type === "keepalive") return;

  // Response order of routing:
  //   1. Did the Dispatcher (REST/new MCP) issue this id? Hand it back.
  //   2. Else: did a Unix-socket caller issue this id? Frame it back.
  //   3. Else: unsolicited event (e.g. observe_event) — broadcast to the
  //      active Unix-socket subscriber, since SSE on REST is not yet
  //      wired up (research §Protocol Options Matrix marks events as
  //      "optional later").
  if (dispatcher.handleResponse(msg)) return;

  const socket = pendingRequests.get(msg.id);
  if (socket) {
    if (!socket.destroyed) sendToSocket(socket, msg);
    pendingRequests.delete(msg.id);
  } else if (mcpSocket && !mcpSocket.destroyed) {
    sendToSocket(mcpSocket, msg);
  }
}

nativeReader.on("end", () => {
  // Don't tear the bridge down instantly — a recycled MV3 worker reconnects
  // within seconds and a new host claims the on-disk state. Hold, then clean up
  // only if still ours. (SIGTERM/SIGINT below are the immediate path.)
  scheduleGracefulShutdown({
    graceMs: GRACE_MS,
    ownsOnDiskState,
    releaseInProcess,
    removeOnDiskState,
    exit: (code) => process.exit(code),
    log,
  });
});

nativeReader.on("error", (err: Error) => {
  log(`Native messaging error: ${err.message}`);
});

// ── Unix Socket Server ────────────────────────────────────────────

function ensureSocketDir(): void {
  fs.mkdirSync(SOCKET_DIR, { recursive: true });
}

function cleanStaleSocket(): void {
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {
    // Socket doesn't exist — that's fine
  }
}

/**
 * Generate a fresh per-process auth token and write it to TOKEN_PATH with
 * mode 0600. Returns the in-memory copy used for handshake comparison.
 *
 * Why: previously any local process could open the socket and drive the
 * authenticated browser. The token file gates the socket on filesystem
 * permissions — only processes running as the same UNIX user (which is
 * already a higher trust level than "any local process") can read it.
 */
function provisionAuthToken(): string {
  const token = crypto.randomBytes(32).toString("hex");
  // Write atomically: open with mode 0600, write, close.
  const fd = fs.openSync(TOKEN_PATH, "w", 0o600);
  try {
    fs.writeFileSync(fd, token, { encoding: "utf-8" });
  } finally {
    fs.closeSync(fd);
  }
  // Belt-and-braces: chmod in case umask interfered.
  fs.chmodSync(TOKEN_PATH, 0o600);
  return token;
}

function cleanAuthToken(): void {
  try {
    fs.unlinkSync(TOKEN_PATH);
  } catch {
    // Token doesn't exist — fine
  }
}

const AUTH_TOKEN = (() => {
  ensureSocketDir();
  return provisionAuthToken();
})();

/**
 * Send a JSON message over a Unix socket using the shared length-prefix
 * helper so we can never frame something larger than the agreed cap.
 */
function sendToSocket(socket: net.Socket, msg: unknown): void {
  try {
    const { header, payload } = writeLengthPrefixed(msg, MAX_MESSAGE_SIZE);
    socket.write(header);
    socket.write(payload);
  } catch (e) {
    if (e instanceof MessageTooLargeError) {
      log(`Refusing to send oversized frame: ${e.message}`);
      return;
    }
    throw e;
  }
}

// ── Per-socket state ─────────────────────────────────────────────

interface SocketState {
  buffer: Buffer;
  authed: boolean;
}

const socketServer = net.createServer((socket) => {
  log("Client connected via Unix socket — awaiting handshake");

  const state: SocketState = {
    buffer: Buffer.alloc(0),
    authed: false,
  };

  // Hard timeout on handshake — drop unauthenticated peers fast so
  // someone scanning sockets can't hold a slot indefinitely.
  const handshakeDeadline = setTimeout(() => {
    if (!state.authed) {
      log("Closing socket: handshake not received within 5s");
      socket.destroy();
    }
  }, 5_000);

  socket.on("data", (chunk: Buffer) => {
    state.buffer = Buffer.concat([state.buffer, chunk]);

    const parsed = readLengthPrefixed(state.buffer, MAX_MESSAGE_SIZE);
    state.buffer = parsed.remainder;

    for (const raw of parsed.messages) {
      if (raw && typeof raw === "object" && "__parseError" in raw) {
        log(`Invalid JSON from socket: ${(raw as { __parseError: string }).__parseError}`);
        continue;
      }

      // First message must be a handshake.
      if (!state.authed) {
        const handshake = raw as { type?: string; token?: string };
        if (
          handshake.type !== "handshake" ||
          typeof handshake.token !== "string" ||
          !timingSafeEqualHex(handshake.token, AUTH_TOKEN)
        ) {
          log("Closing socket: bad handshake (token mismatch or missing)");
          socket.destroy();
          return;
        }
        state.authed = true;
        clearTimeout(handshakeDeadline);
        // Last writer wins; gracefully drop the previous mcp client.
        if (mcpSocket && mcpSocket !== socket && !mcpSocket.destroyed) {
          log("Replacing existing MCP socket with newer authed connection");
          mcpSocket.destroy();
        }
        mcpSocket = socket;
        log("MCP server authenticated");
        continue;
      }

      const cmd = raw as CommandMessage;
      if (typeof cmd.id !== "string" || typeof cmd.action !== "string") {
        log(`Dropping malformed command (missing id/action)`);
        continue;
      }

      pendingRequests.set(cmd.id, socket);
      nativeWriter.write(cmd);
    }

    if (parsed.oversized) {
      log(`Closing socket: ${parsed.oversized.message}`);
      socket.destroy(parsed.oversized);
    }
  });

  socket.on("end", () => {
    clearTimeout(handshakeDeadline);
    if (mcpSocket === socket) {
      log("MCP server disconnected");
      mcpSocket = null;
    }
    // Drop any pending requests routed to this socket — their callers
    // will have given up by now anyway.
    for (const [id, pending] of pendingRequests) {
      if (pending === socket) pendingRequests.delete(id);
    }
  });

  socket.on("error", (err: Error) => {
    clearTimeout(handshakeDeadline);
    log(`Socket error: ${err.message}`);
    if (mcpSocket === socket) mcpSocket = null;
    for (const [id, pending] of pendingRequests) {
      if (pending === socket) pendingRequests.delete(id);
    }
  });
});

/**
 * Constant-time equality for hex-string tokens. crypto.timingSafeEqual
 * throws on mismatched lengths, so we length-check first.
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  return crypto.timingSafeEqual(ab, bb);
}

function log(msg: string): void {
  // Write to stderr so it doesn't interfere with native messaging on stdout
  process.stderr.write(`${LOG_PREFIX} ${msg}\n`);
}

// ── REST server (cli-agnostic northbound API) ────────────────────
//
// Optional: skip with `CHH_BRIDGE_REST=off`. The legacy Unix socket
// remains the canonical contract for the Claude MCP adapter; REST is
// purely additive so we can serve Codex/Gemini/curl without touching
// the existing path. Port 0 lets the OS pick a free port; `bridge.json`
// is then written so clients can discover the URL.

let restHandle: RestServerHandle | null = null;

async function maybeStartRest(): Promise<void> {
  if ((process.env.CHH_BRIDGE_REST ?? "on").toLowerCase() === "off") {
    log("REST server disabled (CHH_BRIDGE_REST=off)");
    return;
  }
  const portEnv = process.env.CHH_BRIDGE_PORT;
  const port = portEnv ? Number.parseInt(portEnv, 10) : 0;
  if (portEnv && Number.isNaN(port)) {
    log(`Ignoring invalid CHH_BRIDGE_PORT=${portEnv}`);
  }

  try {
    restHandle = await startRestServer({
      dispatcher,
      token: AUTH_TOKEN,
      port: Number.isFinite(port) ? port : 0,
    });
    writeBridgeJson(restHandle.url);
    log(`REST server listening at ${restHandle.url}`);
    log(`Bridge metadata written to ${BRIDGE_JSON_PATH}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Warning: failed to start REST server: ${msg}`);
  }
}

function writeBridgeJson(url: string): void {
  const payload = JSON.stringify(
    {
      url,
      token_file: TOKEN_PATH,
      socket: SOCKET_PATH,
      // The owning host's PID. Used by cleanup() to avoid the clobber where an
      // exiting OLD host unlinks the socket/token/bridge.json that a NEWER host
      // (spawned during a reconnect handoff) has just written — which left
      // clients with a token/port mismatch. Newest writer wins; older hosts
      // skip cleanup when they no longer own the on-disk state.
      pid: process.pid,
      version: 1,
    },
    null,
    2
  );
  const fd = fs.openSync(BRIDGE_JSON_PATH, "w", 0o600);
  try {
    fs.writeFileSync(fd, payload, { encoding: "utf-8" });
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(BRIDGE_JSON_PATH, 0o600);
}

function cleanBridgeJson(): void {
  try {
    fs.unlinkSync(BRIDGE_JSON_PATH);
  } catch {
    // ignore — file already gone
  }
}

// ── Startup ───────────────────────────────────────────────────────

/**
 * Does this process still own the on-disk bridge state? During a reconnect
 * handoff a newer host can start (rewriting token/socket/bridge.json with its
 * own pid) before this one finishes exiting. If we no longer own it, we must
 * NOT unlink those files — they belong to the live host now.
 */
function ownsOnDiskState(): boolean {
  try {
    const meta = JSON.parse(fs.readFileSync(BRIDGE_JSON_PATH, "utf-8"));
    return typeof meta.pid !== "number" || meta.pid === process.pid;
  } catch {
    // No/unreadable bridge.json — nothing newer claims ownership.
    return true;
  }
}

// Release this process's own resources — always safe, never touches shared files.
function releaseInProcess(): void {
  socketServer.close();
  if (restHandle) {
    // Best-effort close — we're about to exit anyway.
    restHandle.server.close();
  }
  dispatcher.rejectAll(new Error("Native host shutting down"));
}

// Unlink the shared on-disk bridge state. Caller must have confirmed ownership.
function removeOnDiskState(): void {
  cleanStaleSocket();
  cleanAuthToken();
  cleanBridgeJson();
}

// Immediate shutdown (SIGTERM/SIGINT) — no grace. Ownership-gated on-disk
// removal still prevents clobbering a newer host.
function cleanup(): void {
  releaseInProcess();
  if (ownsOnDiskState()) {
    removeOnDiskState();
  } else {
    log("A newer host owns the bridge state — leaving socket/token/bridge.json intact");
  }
}

process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});

cleanStaleSocket();

socketServer.listen(SOCKET_PATH, () => {
  // Restrict the socket itself to the owner's UID — defense in depth on
  // top of the handshake token.
  try {
    fs.chmodSync(SOCKET_PATH, 0o600);
  } catch (e) {
    log(`Warning: could not chmod 0600 ${SOCKET_PATH}: ${e}`);
  }
  log(`Unix socket listening at ${SOCKET_PATH}`);
  log(`Auth token written to ${TOKEN_PATH}`);
});

// Kick off REST asynchronously so a REST failure doesn't block the
// legacy socket path from coming up.
void maybeStartRest();

// Keep the process alive — Chrome will close stdin when the extension disconnects
log("Native host started. Waiting for connections...");
