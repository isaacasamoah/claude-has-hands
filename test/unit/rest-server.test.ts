/**
 * Unit tests for the REST server — covers the auth/origin/binding rules
 * (AC5) and the route surface (AC1).
 *
 * The tests run against a real http server bound to 127.0.0.1 with a
 * fake Dispatcher in front so we don't need Chrome or the native host.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { Dispatcher } from "../../native-host/src/dispatcher.ts";
import {
  startRestServer,
  type RestServerHandle,
} from "../../native-host/src/rest-server.ts";
import type { ResponseMessage } from "../../native-host/src/types.ts";

const TOKEN = crypto.randomBytes(32).toString("hex");

let handle: RestServerHandle;
let dispatcher: Dispatcher;

/**
 * Auto-respond test dispatcher: every command sent to "Chrome" gets
 * an immediate canned reply. Lets us exercise the real REST surface
 * without an extension on the other side.
 */
function makeAutoDispatcher(
  reply: (action: string, params: Record<string, unknown>) => Partial<ResponseMessage>
): Dispatcher {
  const d: Dispatcher = new Dispatcher({
    sendToChrome: (cmd) => {
      // Defer so the dispatcher's pending map is populated before we reply.
      setImmediate(() => {
        const partial = reply(cmd.action, cmd.params);
        d.handleResponse({
          id: cmd.id,
          success: partial.success ?? true,
          result: partial.result,
          error: partial.error,
        });
      });
    },
  });
  return d;
}

before(async () => {
  dispatcher = makeAutoDispatcher((action, params) => {
    if (action === "navigate") {
      return {
        success: true,
        result: { title: "Echoed", url: params.url, tabId: 1 },
      };
    }
    if (action === "status") {
      return {
        success: true,
        result: { connected: true, automationTab: null, tabCount: 0 },
      };
    }
    if (action === "click") {
      return { success: false, error: "no element matched" };
    }
    return { success: true, result: { echoed: action } };
  });
  handle = await startRestServer({
    dispatcher,
    token: TOKEN,
    port: 0,
  });
});

after(async () => {
  await handle.close();
});

async function fetchJson(
  path: string,
  init: RequestInit & { authToken?: string | null; origin?: string } = {}
): Promise<{ status: number; body: unknown }> {
  const headers = new Headers(init.headers ?? {});
  if (init.authToken === undefined) {
    headers.set("Authorization", `Bearer ${TOKEN}`);
  } else if (init.authToken !== null) {
    headers.set("Authorization", init.authToken);
  }
  if (init.origin) headers.set("Origin", init.origin);

  const res = await fetch(`${handle.url}${path}`, { ...init, headers });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

describe("REST server — binding and auth (AC5)", () => {
  it("binds 127.0.0.1 only", () => {
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("returns 401 with no Authorization header", async () => {
    const { status, body } = await fetchJson("/v1/status", { authToken: null });
    assert.equal(status, 401);
    assert.equal((body as { ok: boolean }).ok, false);
    assert.equal((body as { error: { code: string } }).error.code, "unauthorized");
  });

  it("returns 401 with a Bearer of the wrong token", async () => {
    const { status, body } = await fetchJson("/v1/status", {
      authToken: "Bearer wrong-token",
    });
    assert.equal(status, 401);
    assert.equal((body as { error: { code: string } }).error.code, "unauthorized");
  });

  it("returns 401 with an Authorization that isn't 'Bearer ...'", async () => {
    const { status } = await fetchJson("/v1/status", {
      authToken: "Basic abc",
    });
    assert.equal(status, 401);
  });

  it("rejects non-localhost Origin headers as 403", async () => {
    const { status, body } = await fetchJson("/v1/status", {
      origin: "https://evil.example.com",
    });
    assert.equal(status, 403);
    assert.equal((body as { error: { code: string } }).error.code, "origin_forbidden");
  });

  it("accepts Origin: http://localhost (chh CLI / curl)", async () => {
    const { status } = await fetchJson("/v1/status", {
      origin: "http://localhost",
    });
    assert.equal(status, 200);
  });

  it("accepts a missing Origin header (curl, native)", async () => {
    const { status } = await fetchJson("/v1/status");
    assert.equal(status, 200);
  });
});

describe("REST server — endpoints (AC1)", () => {
  it("GET /v1/status returns service info without contacting the extension", async () => {
    const { status, body } = await fetchJson("/v1/status");
    assert.equal(status, 200);
    const b = body as { ok: boolean; service: string; tools: number };
    assert.equal(b.ok, true);
    assert.equal(b.service, "claude-has-hands");
    assert.ok(b.tools >= 16);
  });

  it("GET /v1/tools returns descriptors with JSON Schemas", async () => {
    const { status, body } = await fetchJson("/v1/tools");
    assert.equal(status, 200);
    const b = body as {
      ok: boolean;
      tools: Array<{ name: string; action: string; inputSchema: { type: string } }>;
    };
    assert.equal(b.ok, true);
    const navigate = b.tools.find((t) => t.name === "browser_navigate");
    assert.ok(navigate, "browser_navigate must be registered");
    assert.equal(navigate!.action, "navigate");
    assert.equal(navigate!.inputSchema.type, "object");

    const selectOption = b.tools.find((t) => t.name === "browser_select_option");
    assert.ok(selectOption, "browser_select_option must be registered");
    assert.equal(selectOption!.action, "select_option");

    const domSnapshot = b.tools.find((t) => t.name === "browser_dom_snapshot");
    assert.ok(domSnapshot, "browser_dom_snapshot must be registered");
    assert.equal(domSnapshot!.action, "dom_snapshot");
    assert.equal(domSnapshot!.inputSchema.type, "object");
  });

  it("POST /v1/call dispatches to the extension and echoes the result", async () => {
    const { status, body } = await fetchJson("/v1/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: "t-call",
        tool: "browser_navigate",
        input: { url: "https://example.com" },
      }),
    });
    assert.equal(status, 200);
    const b = body as {
      ok: boolean;
      request_id: string;
      tool: string;
      result: { url: string };
    };
    assert.equal(b.ok, true);
    assert.equal(b.request_id, "t-call");
    assert.equal(b.tool, "browser_navigate");
    assert.equal(b.result.url, "https://example.com");
  });

  it("POST /v1/call returns ok:false when the tool itself fails", async () => {
    const { status, body } = await fetchJson("/v1/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: "browser_click",
        input: { selector: "#nope" },
      }),
    });
    // 200 because the dispatch worked; the inner result reports failure.
    assert.equal(status, 200);
    const b = body as { ok: boolean; error: { code: string; message: string } };
    assert.equal(b.ok, false);
    assert.equal(b.error.code, "tool_error");
    assert.match(b.error.message, /no element matched/);
  });

  it("POST /v1/call rejects unknown tools with 404 tool_not_found", async () => {
    const { status, body } = await fetchJson("/v1/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "browser_warp_drive", input: {} }),
    });
    assert.equal(status, 404);
    assert.equal((body as { error: { code: string } }).error.code, "tool_not_found");
  });

  it("POST /v1/call rejects bad input shape with 400 invalid_input", async () => {
    const { status, body } = await fetchJson("/v1/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: "browser_navigate",
        input: { url: 42 }, // wrong type
      }),
    });
    assert.equal(status, 400);
    assert.equal((body as { error: { code: string } }).error.code, "invalid_input");
  });

  it("POST /v1/call rejects non-JSON Content-Type with 415", async () => {
    const { status, body } = await fetchJson("/v1/call", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "tool=browser_status",
    });
    assert.equal(status, 415);
    assert.equal(
      (body as { error: { code: string } }).error.code,
      "unsupported_media_type"
    );
  });

  it("POST /v1/call rejects malformed JSON with 400 invalid_json", async () => {
    const { status, body } = await fetchJson("/v1/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    assert.equal(status, 400);
    assert.equal((body as { error: { code: string } }).error.code, "invalid_json");
  });

  it("returns 404 on unrecognised paths after auth passes", async () => {
    const { status, body } = await fetchJson("/v2/whatever");
    assert.equal(status, 404);
    assert.equal((body as { error: { code: string } }).error.code, "not_found");
  });
});
