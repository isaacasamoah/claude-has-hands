/**
 * Structural + parity guards for the shared BrowserToolRegistry.
 *
 * The registry is the single source of truth across all three transports
 * (legacy MCP socket, REST, REST-backed MCP adapter). These tests assert its
 * invariants and that the parity tool set is present, so a tool can never be
 * silently dropped from the surface.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BROWSER_TOOLS,
  getToolByName,
  listToolDescriptors,
} from "../../native-host/src/tool-registry.ts";

test("every tool has the required fields", () => {
  for (const t of BROWSER_TOOLS) {
    assert.ok(t.name.startsWith("browser_"), `bad name: ${t.name}`);
    assert.ok(typeof t.action === "string" && t.action.length > 0, `${t.name} action`);
    assert.ok(t.description.length > 20, `${t.name} description too short`);
    assert.ok(t.schema && typeof t.schema === "object", `${t.name} schema`);
    assert.equal(typeof t.format, "function", `${t.name} format`);
  }
});

test("tool names and actions are unique", () => {
  const names = BROWSER_TOOLS.map((t) => t.name);
  const actions = BROWSER_TOOLS.map((t) => t.action);
  assert.equal(new Set(names).size, names.length, "duplicate tool name");
  assert.equal(new Set(actions).size, actions.length, "duplicate action");
});

test("parity tool set is present", () => {
  const expected = [
    // navigation + core
    "browser_status",
    "browser_navigate",
    "browser_back",
    "browser_forward",
    // read / inspect
    "browser_survey",
    "browser_dom_snapshot",
    "browser_read",
    "browser_screenshot",
    // interact
    "browser_click",
    "browser_type",
    "browser_select_option",
    "browser_scroll",
    "browser_keypress",
    // observe / tabs / wait
    "browser_observe",
    "browser_tabs",
    "browser_wait",
    // parity additions (claude-in-chrome surface)
    "browser_console",
    "browser_network",
    "browser_eval",
    "browser_file_upload",
    "browser_form_input",
    "browser_batch",
    "browser_gif",
  ];
  const have = new Set(BROWSER_TOOLS.map((t) => t.name));
  for (const name of expected) {
    assert.ok(have.has(name), `missing parity tool: ${name}`);
    assert.ok(getToolByName(name), `getToolByName failed for ${name}`);
  }
});

test("listToolDescriptors emits JSON Schema for every tool", () => {
  const descriptors = listToolDescriptors();
  assert.equal(descriptors.length, BROWSER_TOOLS.length);
  for (const d of descriptors) {
    assert.ok(d.name && d.action && d.description);
    assert.equal(typeof d.inputSchema, "object");
  }
});
