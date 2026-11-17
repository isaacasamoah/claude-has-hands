/**
 * REST server — northbound localhost API for cli-agnostic browser control.
 *
 * Endpoints (versioned under `/v1` so we can break shape later):
 *   GET  /v1/status   — shallow liveness; does not contact the extension
 *   GET  /v1/tools    — JSON Schema descriptors for every browser_* tool
 *   POST /v1/call     — { tool, input, request_id?, context? } → { ok, ... }
 *
 * Hardening rules (AC5 — preserve token security model):
 *   - Bind only to 127.0.0.1, never 0.0.0.0. The bind address is fixed.
 *   - Require `Authorization: Bearer <token>` on every request. Token is
 *     compared with crypto.timingSafeEqual after a length precheck. Missing
 *     or wrong → 401, never any leak about which case it was.
 *   - Reject any request whose Origin header is set to a browser-style
 *     origin (anything that isn't null/undefined, or an http://localhost*
 *     style). Random websites talking to local HTTP servers is exactly the
 *     DNS-rebinding scenario the MCP HTTP transport spec calls out.
 *   - POST bodies must be `Content-Type: application/json` and cap at 1 MB.
 *     The 1 MB cap mirrors the native-messaging frame ceiling so we don't
 *     accept things we can't forward to Chrome.
 *   - All responses send `Cache-Control: no-store` and a minimal CORS-deny
 *     header set so a malicious page can never coax the bridge into echoing
 *     state to an attacker origin.
 *
 * The server is a thin HTTP shell over the shared Dispatcher. Validation
 * uses each tool's zod schema from BrowserToolRegistry; the dispatched
 * `action` and `params` go to Chrome, and the response comes back as a
 * canonical `{ ok, request_id, result | error }` body.
 */
import * as http from "http";
import { timingSafeEqual } from "crypto";
import { z } from "zod";
import type { Dispatcher } from "./dispatcher.ts";
import {
  BROWSER_TOOLS,
  getToolByName,
  listToolDescriptors,
  runBatchSteps,
  type BatchStep,
} from "./tool-registry.ts";

const MAX_BODY_BYTES = 1_024_000;
const BIND_ADDRESS = "127.0.0.1";

/**
 * Allowed Origin values. We accept missing/null Origin (curl, native MCP,
 * direct fetch from Node), and an explicit set of localhost forms. Every
 * other value is treated as a browser origin and rejected outright — the
 * REST surface is not for web pages.
 */
const ALLOWED_ORIGIN_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

export interface RestServerOptions {
  /** The Dispatcher used to send commands to Chrome. */
  dispatcher: Dispatcher;
  /** The bearer token clients must present. Plain string. */
  token: string;
  /** Optional fixed port. Pass 0 to let the OS pick a free port. */
  port?: number;
}

export interface RestServerHandle {
  /** The `http.Server` instance, useful for tests. */
  server: http.Server;
  /** The bound URL — use this in client config files. */
  url: string;
  /** The chosen port — only known once `start()` resolves. */
  port: number;
  /** Stop the server. Resolves once it has truly closed. */
  close: () => Promise<void>;
}

export async function startRestServer(
  opts: RestServerOptions
): Promise<RestServerHandle> {
  const { dispatcher, token } = opts;
  const port = opts.port ?? 0;

  const tokenBuf = Buffer.from(token, "utf-8");

  const server = http.createServer((req, res) => {
    handleRequest(req, res, dispatcher, tokenBuf).catch((err) => {
      // Last-resort safety net: any unhandled error becomes a 500 with
      // no leak. We never want this surface to throw.
      try {
        sendJson(res, 500, {
          ok: false,
          error: { code: "internal_error", message: String(err) },
        });
      } catch {
        // ignore — connection probably gone
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, BIND_ADDRESS, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const boundPort =
    typeof addr === "object" && addr !== null ? addr.port : port;
  const url = `http://${BIND_ADDRESS}:${boundPort}`;

  return {
    server,
    url,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  dispatcher: Dispatcher,
  tokenBuf: Buffer
): Promise<void> {
  // Defense-in-depth: refuse anything that looks like a browser-page origin.
  // localhost forms get a free pass for `chh` tooling that runs in a shell.
  if (!isOriginAllowed(req.headers.origin)) {
    sendJson(res, 403, {
      ok: false,
      error: { code: "origin_forbidden", message: "Origin not allowed." },
    });
    return;
  }

  // No CORS — this is a private local API.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  // Authorization: applied to every endpoint. Always run before routing
  // so we never leak a 404 vs 401 difference.
  if (!isAuthorized(req.headers.authorization, tokenBuf)) {
    sendJson(res, 401, {
      ok: false,
      error: {
        code: "unauthorized",
        message: "Missing or invalid Authorization header.",
      },
    });
    return;
  }

  const method = (req.method ?? "GET").toUpperCase();
  const url = req.url ?? "/";

  if (method === "GET" && url === "/v1/status") {
    sendJson(res, 200, {
      ok: true,
      service: "claude-has-hands",
      version: 1,
      tools: BROWSER_TOOLS.length,
    });
    return;
  }

  if (method === "GET" && url === "/v1/tools") {
    sendJson(res, 200, {
      ok: true,
      tools: listToolDescriptors(),
    });
    return;
  }

  if (method === "POST" && url === "/v1/call") {
    await handleCall(req, res, dispatcher);
    return;
  }

  sendJson(res, 404, {
    ok: false,
    error: { code: "not_found", message: `No route for ${method} ${url}` },
  });
}

async function handleCall(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  dispatcher: Dispatcher
): Promise<void> {
  const ct = (req.headers["content-type"] ?? "").toString().toLowerCase();
  if (!ct.startsWith("application/json")) {
    sendJson(res, 415, {
      ok: false,
      error: {
        code: "unsupported_media_type",
        message: "Content-Type must be application/json.",
      },
    });
    return;
  }

  let body: string;
  try {
    body = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendJson(res, 413, {
      ok: false,
      error: { code: "payload_too_large", message: msg },
    });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    sendJson(res, 400, {
      ok: false,
      error: {
        code: "invalid_json",
        message: `Body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
    return;
  }

  const envelope = z
    .object({
      tool: z.string(),
      input: z.record(z.string(), z.unknown()).optional().default({}),
      request_id: z.string().optional(),
      context: z
        .object({
          tab_id: z.union([z.string(), z.number()]).optional(),
          timeout_ms: z.number().optional(),
        })
        .optional(),
    })
    .safeParse(parsed);

  if (!envelope.success) {
    sendJson(res, 400, {
      ok: false,
      error: {
        code: "invalid_envelope",
        message: envelope.error.message,
      },
    });
    return;
  }

  const { tool: toolName, input, request_id } = envelope.data;
  const tool = getToolByName(toolName);
  if (!tool) {
    sendJson(res, 404, {
      ok: false,
      request_id,
      error: {
        code: "tool_not_found",
        message: `Unknown tool: ${toolName}`,
      },
    });
    return;
  }

  const inputResult = z.object(tool.schema).safeParse(input);
  if (!inputResult.success) {
    sendJson(res, 400, {
      ok: false,
      request_id,
      error: {
        code: "invalid_input",
        message: inputResult.error.message,
      },
    });
    return;
  }

  // browser_batch doesn't map to a single extension action — it runs a
  // sequence of other tools. Run the batch here (the registry owns the
  // semantics; dispatcher.send is the atomic-call primitive) and return the
  // collected results. The REST-backed MCP adapter relies on this path.
  if (tool.name === "browser_batch") {
    const steps = (inputResult.data as { steps?: BatchStep[] }).steps ?? [];
    let results;
    try {
      results = await runBatchSteps(steps, async (action, stepInput) => {
        const r = await dispatcher.send(action, stepInput);
        return { success: r.success, result: r.result, error: r.error };
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 504, {
        ok: false,
        request_id,
        error: { code: "dispatch_failed", message: msg, retryable: true },
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      request_id,
      tool: toolName,
      result: { results },
    });
    return;
  }

  let response;
  try {
    response = await dispatcher.send(
      tool.action,
      inputResult.data as Record<string, unknown>
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendJson(res, 504, {
      ok: false,
      request_id,
      error: { code: "dispatch_failed", message: msg, retryable: true },
    });
    return;
  }

  if (!response.success) {
    sendJson(res, 200, {
      ok: false,
      request_id,
      error: {
        code: "tool_error",
        message: response.error ?? "Tool returned an error.",
      },
    });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    request_id,
    tool: toolName,
    result: response.result,
  });
}

export function isAuthorized(header: string | string[] | undefined, expected: Buffer): boolean {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return false;

  const match = /^Bearer\s+(.+)$/i.exec(raw);
  if (!match) return false;

  const presented = Buffer.from(match[1].trim(), "utf-8");
  if (presented.length !== expected.length) return false;

  return timingSafeEqual(presented, expected);
}

export function isOriginAllowed(origin: string | string[] | undefined): boolean {
  if (origin === undefined) return true;
  const value = Array.isArray(origin) ? origin[0] : origin;
  if (!value || value === "null") return true;

  // Try to parse as a URL — anything we can't parse, we deny.
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  return ALLOWED_ORIGIN_HOSTS.has(parsed.hostname);
}

function readBody(req: http.IncomingMessage, cap: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > cap) {
        req.destroy();
        reject(new Error(`Body exceeds ${cap} bytes`));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", (err) => reject(err));
  });
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown
): void {
  if (!res.headersSent) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
  }
  res.end(JSON.stringify(body));
}
