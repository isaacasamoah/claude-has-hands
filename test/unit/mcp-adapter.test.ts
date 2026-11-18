/**
 * Unit tests for the REST-backed MCP adapter (native-host/src/mcp-adapter.ts).
 *
 * The adapter's job is small but load-bearing: read CHH_BRIDGE_URL +
 * token file, forward each browser_* tool call to `POST /v1/call` with
 * a Bearer header, and format the response with the registry's per-tool
 * formatter. The MCP-protocol plumbing is provided by the SDK and is
 * exercised by the SDK's own tests, so we focus on the REST glue here.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Dispatcher } from "../../native-host/src/dispatcher.ts";
import { startRestServer, type RestServerHandle } from "../../native-host/src/rest-server.ts";
import {
  __resolveBridgeConfig,
  __resolveBridgeUrl,
  __restCall,
  __startHttp,
} from "../../native-host/src/mcp-adapter.ts";

let handle: RestServerHandle;
let tokenPath: string;
const TOKEN = crypto.randomBytes(32).toString("hex");

before(async () => {
  // Auto-respond dispatcher: every command gets a canned reply.
  const dispatcher = new Dispatcher({
    sendToChrome: (cmd) => {
      setImmediate(() => {
        if (cmd.action === "navigate") {
          dispatcher.handleResponse({
            id: cmd.id,
            success: true,
            result: { title: "Echoed", url: cmd.params.url, tabId: 7 },
          });
          return;
        }
        dispatcher.handleResponse({
          id: cmd.id,
          success: true,
          result: { ok: true, action: cmd.action },
        });
      });
    },
  });
  handle = await startRestServer({ dispatcher, token: TOKEN, port: 0 });

  tokenPath = path.join(os.tmpdir(), `chh-test-token-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
});

after(async () => {
  await handle.close();
  try {
    fs.unlinkSync(tokenPath);
  } catch {
    // ignore
  }
});

describe("mcp-adapter — bridge config resolution", () => {
  it("uses CHH_BRIDGE_URL and CHH_BRIDGE_TOKEN_FILE when set", () => {
    const prevUrl = process.env.CHH_BRIDGE_URL;
    const prevToken = process.env.CHH_BRIDGE_TOKEN_FILE;
    process.env.CHH_BRIDGE_URL = handle.url;
    process.env.CHH_BRIDGE_TOKEN_FILE = tokenPath;

    try {
      const cfg = __resolveBridgeConfig();
      assert.equal(cfg.url, handle.url);
      assert.equal(cfg.tokenPath, tokenPath);
    } finally {
      if (prevUrl === undefined) delete process.env.CHH_BRIDGE_URL;
      else process.env.CHH_BRIDGE_URL = prevUrl;
      if (prevToken === undefined) delete process.env.CHH_BRIDGE_TOKEN_FILE;
      else process.env.CHH_BRIDGE_TOKEN_FILE = prevToken;
    }
  });

  it("throws a clear error when neither env nor bridge.json provides a url", () => {
    const prevUrl = process.env.CHH_BRIDGE_URL;
    const prevBridgeJson = process.env.CHH_BRIDGE_JSON;
    delete process.env.CHH_BRIDGE_URL;
    process.env.CHH_BRIDGE_JSON = path.join(
      os.tmpdir(),
      `chh-no-bridge-${process.pid}-${Date.now()}`,
      "bridge.json"
    );

    try {
      assert.throws(() => __resolveBridgeConfig(), /Cannot determine REST bridge URL/);
    } finally {
      if (prevUrl === undefined) delete process.env.CHH_BRIDGE_URL;
      else process.env.CHH_BRIDGE_URL = prevUrl;
      if (prevBridgeJson === undefined) delete process.env.CHH_BRIDGE_JSON;
      else process.env.CHH_BRIDGE_JSON = prevBridgeJson;
    }
  });
});

describe("mcp-adapter — fresh URL resolution (host-restart resilience)", () => {
  it("re-reads bridge.json over a stale cached url so a host port change is picked up", () => {
    const prevUrl = process.env.CHH_BRIDGE_URL;
    delete process.env.CHH_BRIDGE_URL;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chh-bridge-"));
    const bridgeJsonPath = path.join(dir, "bridge.json");
    // Host restarted on a new port — bridge.json now holds the live url, while
    // the adapter still has the old one cached in cfg.url.
    fs.writeFileSync(bridgeJsonPath, JSON.stringify({ url: "http://127.0.0.1:55555" }));

    try {
      const url = __resolveBridgeUrl({
        url: "http://127.0.0.1:11111", // stale
        tokenPath,
        bridgeJsonPath,
      });
      assert.equal(url, "http://127.0.0.1:55555");
    } finally {
      if (prevUrl === undefined) delete process.env.CHH_BRIDGE_URL;
      else process.env.CHH_BRIDGE_URL = prevUrl;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the cached url when bridge.json is unreadable", () => {
    const prevUrl = process.env.CHH_BRIDGE_URL;
    delete process.env.CHH_BRIDGE_URL;
    try {
      const url = __resolveBridgeUrl({
        url: "http://127.0.0.1:22222",
        tokenPath,
        bridgeJsonPath: path.join(os.tmpdir(), "chh-nonexistent", "bridge.json"),
      });
      assert.equal(url, "http://127.0.0.1:22222");
    } finally {
      if (prevUrl === undefined) delete process.env.CHH_BRIDGE_URL;
      else process.env.CHH_BRIDGE_URL = prevUrl;
    }
  });
});

describe("mcp-adapter — REST call forwarding", () => {
  it("forwards a tool call to /v1/call and returns the unwrapped envelope", async () => {
    const cfg = { url: handle.url, tokenPath };
    const res = await __restCall(cfg, "browser_navigate", { url: "https://example.com" });
    assert.equal(res.ok, true);
    if (res.ok) {
      const result = res.result as { url: string; title: string; tabId: number };
      assert.equal(result.url, "https://example.com");
      assert.equal(result.title, "Echoed");
      assert.equal(result.tabId, 7);
      assert.equal(res.tool, "browser_navigate");
    }
  });

  it("returns the failure envelope when REST refuses the request (bad token)", async () => {
    const cfg = { url: handle.url, tokenPath: tokenPath + "-missing" };
    await assert.rejects(
      __restCall(cfg, "browser_status", {}),
      /Cannot read bridge token/
    );
  });

  it("runs browser_batch through the REST server and returns per-step results", async () => {
    const cfg = { url: handle.url, tokenPath };
    const res = await __restCall(cfg, "browser_batch", {
      steps: [
        { tool: "browser_navigate", input: { url: "https://example.com" } },
        { tool: "browser_survey", input: {} },
      ],
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      const { results } = res.result as {
        results: Array<{ tool: string; ok: boolean }>;
      };
      assert.equal(results.length, 2);
      assert.ok(results.every((r) => r.ok));
      assert.equal(results[0].tool, "browser_navigate");
      assert.equal(results[1].tool, "browser_survey");
    }
  });
});

describe("MCP adapter HTTP transport access control", () => {
  const token = crypto.randomBytes(32).toString("hex");
  let dir: string;
  let httpServer: Awaited<ReturnType<typeof __startHttp>>;
  let base: string;

  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    },
  };

  const post = (headers: Record<string, string>) =>
    fetch(base, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(initialize),
    });

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "chh-mcp-http-"));
    const tokenFile = path.join(dir, "bridge.token");
    fs.writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
    httpServer = await __startHttp(() => new McpServer({ name: "t", version: "0" }), 0, tokenFile);
    const addr = httpServer.address();
    assert.ok(addr && typeof addr === "object");
    base = `http://127.0.0.1:${addr.port}/`;
  });

  after(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a request with no bearer token", async () => {
    assert.equal((await post({})).status, 401);
  });

  it("rejects a wrong bearer token", async () => {
    assert.equal((await post({ Authorization: "Bearer nope" })).status, 401);
  });

  it("rejects a browser origin even with a valid token", async () => {
    const res = await post({
      Authorization: `Bearer ${token}`,
      Origin: "https://evil.example",
    });
    assert.equal(res.status, 403);
  });

  it("accepts a valid bearer token", async () => {
    const res = await post({ Authorization: `Bearer ${token}` });
    assert.equal(res.status, 200);
    await res.text();
  });
  it("serves every request, not just the first", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await post({ Authorization: `Bearer ${token}` });
      assert.equal(res.status, 200, `request ${i + 1}`);
      await res.text();
    }
  });
});
