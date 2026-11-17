/**
 * Claude Has Hands — MCP Server (native-messaging transport).
 *
 * Claude Code spawns this process. It speaks MCP over stdio and relays
 * browser_* tool calls to the Chrome extension through the native host's
 * Unix socket (BridgeClient → bridge.sock → native host → extension).
 *
 * Every tool is generated from the shared BrowserToolRegistry — the single
 * source of truth also used by the REST server and the REST-backed MCP
 * adapter. Adding a tool to the registry surfaces it here automatically, so
 * the three transports can never drift apart (the bug this refactor removed:
 * the hand-maintained per-tool definitions that lived here lagged the
 * registry, leaving Claude Code unable to call newer tools).
 *
 * The only transport-specific concern left here is connection resilience:
 * `ensureBridge()` lazily (re)connects before each call, so a native-host
 * restart (which rotates the auth token and recreates the socket) self-heals
 * on the next tool call rather than wedging the session.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BridgeClient } from "./bridge.js";
import {
  BROWSER_TOOLS,
  runBatchSteps,
  type BatchStep,
  type ToolContent,
} from "./tool-registry.ts";

const LOG_PREFIX = "[CHH-MCP]";

function log(msg: string): void {
  process.stderr.write(`${LOG_PREFIX} ${msg}\n`);
}

// ── Bridge Connection ─────────────────────────────────────────────

const bridge = new BridgeClient();

bridge.on("error", (err: Error) => {
  log(`Bridge error: ${err.message}`);
});

bridge.on("disconnected", () => {
  log("Bridge disconnected from native host");
});

bridge.on("event", (event: unknown) => {
  log(`Bridge event: ${JSON.stringify(event)}`);
  // TODO: Forward observe events to MCP notifications.
});

/** Lazily (re)connect the bridge before a call. Idempotent. */
async function ensureBridge(): Promise<void> {
  if (!bridge.connected) {
    await bridge.connect();
    log("Connected to native host bridge");
  }
}

// ── Content helpers ───────────────────────────────────────────────

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

// ── MCP Server ────────────────────────────────────────────────────

const server = new McpServer({
  name: "claude-has-hands",
  version: "0.2.0",
});

// Register every registry tool with a single generic handler. The handler
// dispatches the tool's internal action over the bridge and formats the
// result with the tool's own formatter.
for (const tool of BROWSER_TOOLS) {
  server.tool(
    tool.name,
    tool.description,
    tool.schema,
    async (input: Record<string, unknown>) => {
      try {
        await ensureBridge();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorContent(`Extension not connected: ${msg}`);
      }

      // browser_batch is the one tool that doesn't map 1:1 to a bridge action:
      // it runs a sequence of other tools. Semantics live in the registry; we
      // inject bridge.sendCommand as the atomic-call primitive, then render the
      // collected results with the registry's batch formatter.
      if (tool.name === "browser_batch") {
        const steps = (input.steps as BatchStep[] | undefined) ?? [];
        try {
          const results = await runBatchSteps(steps, (action, stepInput) =>
            bridge.sendCommand(action, stepInput)
          );
          return toMcpContent(tool.format({ results }));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return errorContent(`browser_batch failed: ${msg}`);
        }
      }

      try {
        const response = await bridge.sendCommand(tool.action, input);
        if (!response.success) {
          return errorContent(`${tool.name} failed: ${response.error}`);
        }
        return toMcpContent(tool.format(response.result));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorContent(`${tool.name} call failed: ${msg}`);
      }
    }
  );
}

// ── Start ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("Starting MCP server...");

  // Best-effort connect at startup; tools also (re)connect lazily on demand.
  try {
    await bridge.connect();
    log("Connected to native host bridge");
  } catch (err) {
    log(
      `Warning: Could not connect to native host bridge: ${err instanceof Error ? err.message : err}`
    );
    log("Tools will attempt to connect on first call.");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server running on stdio");
}

main().catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});
