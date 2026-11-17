/**
 * REST-backed MCP adapter.
 *
 * This is the new MCP entry point that wraps the localhost REST API
 * (`POST /v1/call`, `GET /v1/tools`, `GET /v1/status`) and exposes the
 * same browser_* tool surface to MCP-aware clients (Codex, Cursor,
 * Gemini, future Claude Code config). It is backed by the same
 * Dispatcher → Chrome path as the REST API itself, so all adapters
 * share one schema source of truth (BrowserToolRegistry).
 *
 * The legacy `mcp-server.ts` (which talks to bridge.sock directly via
 * BridgeClient) is kept intact for byte-compatible Claude Code support
 * during the migration. This file is the cli-agnostic alternative.
 *
 * Transport modes:
 *   - stdio (default): standard MCP over stdin/stdout, suitable for
 *     `claude mcp add`, `codex mcp add`, `gemini mcp add`.
 *   - Streamable HTTP: when `CHH_MCP_HTTP_PORT` is set, also expose an
 *     HTTP server that speaks the MCP Streamable HTTP transport. Useful
 *     for engines that want a URL-based MCP config.
 *
 * Environment:
 *   CHH_BRIDGE_URL         override REST base URL (else read bridge.json)
 *   CHH_BRIDGE_TOKEN_FILE  override token path (else default ~/.claude/...)
 *   CHH_BRIDGE_JSON        override bridge metadata path
 *   CHH_MCP_HTTP_PORT      enable Streamable HTTP on this port
 *   CHH_MCP_TRANSPORT      "stdio" (default), "http", or "both"
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { BROWSER_TOOLS, type ToolContent } from "./tool-registry.ts";
import { isAuthorized, isOriginAllowed } from "./rest-server.ts";

const LOG_PREFIX = "[CHH-MCP-Adapter]";
const DEFAULT_DIR = path.join(os.homedir(), ".claude", "claude-has-hands");
const DEFAULT_TOKEN_PATH = path.join(DEFAULT_DIR, "bridge.token");
const DEFAULT_BRIDGE_JSON = path.join(DEFAULT_DIR, "bridge.json");

interface BridgeConfig {
  url: string;
  tokenPath: string;
  /**
   * Where bridge.json lives. Carried so `restCall` can re-resolve the URL on
   * every call — the native host listens on an OS-assigned port (port 0) that
   * changes on every restart, so a URL cached at startup goes stale the first
   * time the host (and therefore the worker) cycles. Optional for tests that
   * construct a config literal directly.
   */
  bridgeJsonPath?: string;
}

function log(msg: string): void {
  process.stderr.write(`${LOG_PREFIX} ${msg}\n`);
}

/**
 * Resolve where to send REST calls and where the bearer token lives.
 *
 * Order: explicit env > bridge.json (written by native host on start)
 * > built-in defaults. The token is re-read on every call so a host
 * restart (which rotates the token) is picked up without restarting
 * the adapter.
 */
function resolveBridgeConfig(): BridgeConfig {
  const tokenPath = process.env.CHH_BRIDGE_TOKEN_FILE ?? DEFAULT_TOKEN_PATH;
  const bridgeJsonPath = process.env.CHH_BRIDGE_JSON ?? DEFAULT_BRIDGE_JSON;

  let url = process.env.CHH_BRIDGE_URL;
  if (!url) {
    try {
      const meta = JSON.parse(fs.readFileSync(bridgeJsonPath, "utf-8"));
      if (typeof meta.url === "string") url = meta.url;
    } catch {
      // bridge.json absent — let the first call surface a clear error.
    }
  }
  if (!url) {
    throw new Error(
      `Cannot determine REST bridge URL. Set CHH_BRIDGE_URL, or run the native host so it writes ${bridgeJsonPath}.`
    );
  }
  return { url, tokenPath, bridgeJsonPath };
}

/**
 * Resolve the REST base URL fresh, used on every call. The host binds to an
 * OS-assigned port that changes whenever it restarts (which happens every time
 * the MV3 worker cycles), so we re-read bridge.json each call rather than trust
 * a URL captured at adapter startup.
 *
 * Order: explicit env > bridge.json (current value) > the URL captured in cfg
 * at startup (last-resort fallback, also what unit tests rely on).
 */
function resolveBridgeUrl(cfg: BridgeConfig): string {
  const envUrl = process.env.CHH_BRIDGE_URL;
  if (envUrl) return envUrl;
  if (cfg.bridgeJsonPath) {
    try {
      const meta = JSON.parse(fs.readFileSync(cfg.bridgeJsonPath, "utf-8"));
      if (typeof meta.url === "string" && meta.url) return meta.url;
    } catch {
      // bridge.json absent/unreadable — fall back to the cached URL.
    }
  }
  return cfg.url;
}

function readToken(tokenPath: string): string {
  try {
    return fs.readFileSync(tokenPath, "utf-8").trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot read bridge token at ${tokenPath}: ${msg}. Is the native host running?`
    );
  }
}

interface RestCallSuccess {
  ok: true;
  request_id?: string;
  tool: string;
  result: unknown;
}

interface RestCallFailure {
  ok: false;
  request_id?: string;
  error: { code: string; message: string };
}

type RestCallResponse = RestCallSuccess | RestCallFailure;

/**
 * Make one REST call to /v1/call. Re-reads the token on each invocation
 * so a host-side rotation is picked up without restarting the adapter.
 */
async function restCall(
  cfg: BridgeConfig,
  tool: string,
  input: Record<string, unknown>
): Promise<RestCallResponse> {
  const token = readToken(cfg.tokenPath);
  const url = resolveBridgeUrl(cfg);
  const res = await fetch(`${url}/v1/call`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ tool, input }),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: {
        code: "invalid_response",
        message: `REST returned non-JSON (status ${res.status}): ${text.slice(0, 200)}`,
      },
    };
  }
  return parsed as RestCallResponse;
}

function toMcpContent(content: ToolContent[]): {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: "image/jpeg" | "image/png" }
  >;
  isError?: boolean;
} {
  return { content: content as never };
}

function errorContent(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

/**
 * Build an MCP server with every browser_* tool registered. Each handler
 * forwards to the REST API and formats the response with the registry's
 * formatter, so adapters never have to know per-tool result shape.
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: "claude-has-hands",
    version: "0.2.0",
  });

  const cfg = resolveBridgeConfig();

  for (const tool of BROWSER_TOOLS) {
    server.tool(
      tool.name,
      tool.description,
      tool.schema,
      async (input: Record<string, unknown>) => {
        try {
          const response = await restCall(cfg, tool.name, input);
          if (!response.ok) {
            return errorContent(
              `${tool.name} failed: ${response.error.message} (${response.error.code})`
            );
          }
          return toMcpContent(tool.format(response.result));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return errorContent(`${tool.name} call failed: ${msg}`);
        }
      }
    );
  }

  return server;
}

async function startStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP adapter listening on stdio");
}

async function startHttp(
  server: McpServer,
  port: number,
  tokenPath: string = process.env.CHH_BRIDGE_TOKEN_FILE ?? DEFAULT_TOKEN_PATH
): Promise<http.Server> {
  // One stateless transport handles every request — adequate for local
  // single-user use; if we later want multi-session, we would generate
  // a session id per `initialize` and route subsequent requests by it.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
  });
  await server.connect(transport);

  const httpServer = http.createServer((req, res) => {
    // Same Origin allowlist and bearer check as the REST server. The token is
    // re-read per request because the host rotates it on every restart.
    if (!isOriginAllowed(req.headers.origin)) {
      res.statusCode = 403;
      res.end();
      return;
    }
    let expected: Buffer;
    try {
      expected = Buffer.from(readToken(tokenPath), "utf-8");
    } catch {
      res.statusCode = 401;
      res.end();
      return;
    }
    if (!isAuthorized(req.headers.authorization, expected)) {
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate", "Bearer");
      res.end();
      return;
    }
    transport.handleRequest(req, res).catch((err) => {
      log(`MCP HTTP error: ${err}`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: String(err) },
            id: null,
          })
        );
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });
  const addr = httpServer.address();
  const realPort = typeof addr === "object" && addr !== null ? addr.port : port;
  log(`MCP adapter listening on http://127.0.0.1:${realPort}`);
  return httpServer;
}

async function main(): Promise<void> {
  const transportMode = (
    process.env.CHH_MCP_TRANSPORT ?? "stdio"
  ).toLowerCase();
  const httpPortEnv = process.env.CHH_MCP_HTTP_PORT;

  // If only HTTP is asked for, skip stdio. Default is stdio so existing
  // `claude mcp add` invocations keep working.
  const useStdio = transportMode === "stdio" || transportMode === "both";
  const useHttp =
    transportMode === "http" || transportMode === "both" || !!httpPortEnv;

  const server = buildMcpServer();

  if (useStdio) await startStdio(server);
  if (useHttp) {
    const port = httpPortEnv ? Number.parseInt(httpPortEnv, 10) : 0;
    if (Number.isNaN(port)) throw new Error(`Invalid CHH_MCP_HTTP_PORT=${httpPortEnv}`);
    // The HTTP transport requires its own server instance; connecting two
    // transports to one McpServer is not supported by the SDK.
    const httpServer = buildMcpServer();
    await startHttp(httpServer, port);
  }
}

// Only run when executed directly, not when imported in tests.
const isMainEntry = (() => {
  try {
    const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : "";
    const here = path.resolve(new URL(import.meta.url).pathname);
    return argv1 === here || argv1.endsWith("mcp-adapter.js");
  } catch {
    return false;
  }
})();

if (isMainEntry) {
  main().catch((err) => {
    log(`Fatal: ${err}`);
    process.exit(1);
  });
}

// Re-exports for tests.
export {
  resolveBridgeConfig as __resolveBridgeConfig,
  resolveBridgeUrl as __resolveBridgeUrl,
  restCall as __restCall,
  startHttp as __startHttp,
};
export type { BridgeConfig as __BridgeConfig };
