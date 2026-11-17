/**
 * Integration tests for the `chh` shell wrapper.
 *
 * These boot a real REST server (with a fake auto-responding Dispatcher
 * in front of it) and shell out to bin/chh with the bridge URL and
 * token file pointed at the test fixtures. The goal is to confirm that
 * the CLI builds the right Authorization header, validates JSON input,
 * and posts the expected envelope to /v1/call — i.e. that AC3 (per-CLI
 * shell wrappers usable by Codex/Gemini) actually round-trips.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
import { Dispatcher } from "../../native-host/src/dispatcher.ts";
import { startRestServer, type RestServerHandle } from "../../native-host/src/rest-server.ts";

const TOKEN = crypto.randomBytes(32).toString("hex");
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const CHH = path.join(REPO_ROOT, "bin", "chh");

let handle: RestServerHandle;
let tokenPath: string;

before(async () => {
  const dispatcher = new Dispatcher({
    sendToChrome: (cmd) => {
      setImmediate(() => {
        if (cmd.action === "navigate") {
          dispatcher.handleResponse({
            id: cmd.id,
            success: true,
            result: { title: "Echoed", url: cmd.params.url, tabId: 1 },
          });
        } else if (cmd.action === "status") {
          dispatcher.handleResponse({
            id: cmd.id,
            success: true,
            result: { connected: true, automationTab: null, tabCount: 0 },
          });
        } else {
          dispatcher.handleResponse({
            id: cmd.id,
            success: true,
            result: { echoed: cmd.action },
          });
        }
      });
    },
  });
  handle = await startRestServer({ dispatcher, token: TOKEN, port: 0 });

  tokenPath = path.join(os.tmpdir(), `chh-cli-test-${process.pid}-${Date.now()}`);
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

async function runChh(args: string[]): Promise<string> {
  const { stdout } = await execFileP(CHH, args, {
    encoding: "utf-8",
    env: {
      ...process.env,
      CHH_BRIDGE_URL: handle.url,
      CHH_BRIDGE_TOKEN_FILE: tokenPath,
    },
  });
  return stdout;
}

describe("chh CLI — round-trip via REST", () => {
  it("`chh status` returns the service envelope", async () => {
    const out = await runChh(["status"]);
    const body = JSON.parse(out);
    assert.equal(body.ok, true);
    assert.equal(body.service, "claude-has-hands");
    assert.ok(body.tools >= 16);
  });

  it("`chh tools` lists registered browser_* tools", async () => {
    const out = await runChh(["tools"]);
    const body = JSON.parse(out);
    assert.equal(body.ok, true);
    const names = (body.tools as Array<{ name: string }>).map((t) => t.name);
    assert.ok(names.includes("browser_navigate"));
    assert.ok(names.includes("browser_status"));
    assert.ok(names.includes("browser_select_option"));
    assert.ok(names.includes("browser_dom_snapshot"));
    assert.ok(names.length >= 16);
  });

  it("`chh call browser_navigate '<json>'` dispatches and unwraps", async () => {
    const out = await runChh([
      "call",
      "browser_navigate",
      '{"url":"https://example.com"}',
    ]);
    const body = JSON.parse(out);
    assert.equal(body.ok, true);
    assert.equal(body.tool, "browser_navigate");
    assert.equal(body.result.url, "https://example.com");
  });

  it("`chh browser_navigate <json>` shorthand works without explicit `call`", async () => {
    const out = await runChh([
      "browser_navigate",
      '{"url":"https://example.org"}',
    ]);
    const body = JSON.parse(out);
    assert.equal(body.ok, true);
    assert.equal(body.result.url, "https://example.org");
  });

  it("rejects malformed JSON input before contacting the bridge", async () => {
    await assert.rejects(
      runChh(["call", "browser_navigate", "{not json"]),
      /input must be JSON/
    );
  });
});
