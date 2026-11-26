/**
 * Claude Has Hands — Extension Service Worker
 *
 * Connects to native host via chrome.runtime.connectNative().
 * Handles reconnection with exponential backoff.
 * Keepalive via chrome.alarms (MV3 service workers die after ~30s idle).
 *
 * Phase 1: Connection lifecycle only. Command dispatch added in Phase 2.
 */

import { setupKeepalive, startPingLoop } from "./lib/keepalive.js";
import { runExclusive } from "./lib/mutex.js";
import {
  handleNavigate,
  handleBack,
  handleForward,
  type NavigationState,
} from "./commands/navigate.js";
import { handleSurvey } from "./commands/survey.js";
import { handleClick, handleType } from "./commands/interact.js";
import { handleSelectOption } from "./commands/select-option.js";
import { handleRead } from "./commands/read.js";
import { handleDomSnapshot } from "./commands/dom-snapshot.js";
import { handleScroll } from "./commands/scroll.js";
import { handleKeypress } from "./commands/keypress.js";
import { handleScreenshot } from "./commands/screenshot.js";
import { handleObserve } from "./commands/observe.js";
import { handleTabs } from "./commands/tabs.js";
import { handleWait } from "./commands/wait.js";
import { handleReadConsole } from "./commands/console.js";
import { handleReadNetwork } from "./commands/network.js";
import { handleEval } from "./commands/eval.js";
import { handleFileUpload } from "./commands/file-upload.js";
import { handleFormInput } from "./commands/form-input.js";
import { handleGif } from "./commands/gif.js";
import type { CommandMessage, ResponseMessage, EventMessage, TabEntry } from "./types.js";
import { MAX_MESSAGE_SIZE } from "./types.js";

const HOST_NAME = "com.claude.has_hands";
const LOG_PREFIX = "[CHH]";

// ── Connection State ──────────────────────────────────────────────

let port: chrome.runtime.Port | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30_000;

const COMMAND_DEADLINE_MS = 28_000;

// ── Tab Registry ──────────────────────────────────────────────────

let automationTabId: number | null = null;
const tabRegistry = new Map<number, TabEntry>();

/** Shared mutable state passed to command handlers */
const navigationState: NavigationState = {
  get automationTabId() {
    return automationTabId;
  },
  setAutomationTabId(id: number | null) {
    automationTabId = id;
  },
  tabRegistry,
};

// ── Connection Management ─────────────────────────────────────────

function connect(): void {
  if (port) return; // already connected

  try {
    port = chrome.runtime.connectNative(HOST_NAME);
    reconnectDelay = 1000; // reset backoff on successful connect

    port.onMessage.addListener(handleCommand);

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      console.log(`${LOG_PREFIX} Disconnected:`, err?.message || "unknown");
      port = null;
      scheduleReconnect();
    });

    console.log(`${LOG_PREFIX} Connected to native host`);
  } catch (e) {
    console.error(`${LOG_PREFIX} Connection failed:`, e);
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

// ── Command Dispatch ──────────────────────────────────────────────

/**
 * Pick the per-command mutex key. Most commands act on the automation tab,
 * so they share the same lane. Commands that target a specific tab id in
 * params get that tab's lane. Tabs-list and global commands run on the
 * shared "global" lane, which still serializes against itself but doesn't
 * block per-tab work.
 *
 * Why serialize: chrome.debugger.attach against the same tab from two
 * concurrent commands fails the second attach and leaves cachedSurvey
 * mid-write. Serializing per tab eliminates the race without sacrificing
 * cross-tab parallelism.
 */
function mutexKey(action: string, params: Record<string, unknown>): string {
  // Explicit tab targeting wins.
  if (typeof params.tabId === "number") return `tab:${params.tabId}`;
  if (typeof params.tab === "number") return `tab:${params.tab}`;

  // Tabs management is global state.
  if (action === "tabs") return "global:tabs";

  // Status is read-only across tabs.
  if (action === "status") return "global:status";

  // Everything else acts on the current automation tab.
  if (automationTabId !== null) return `tab:${automationTabId}`;
  return "global:no-tab";
}

async function handleCommand(msg: CommandMessage): Promise<void> {
  const { id, action, params = {} } = msg;

  const dispatch = async (): Promise<unknown> => {
    switch (action) {
      case "status":
        return await doStatus();
      case "navigate":
        return await handleNavigate(params, navigationState);
      case "back":
        return await handleBack(params, navigationState);
      case "forward":
        return await handleForward(params, navigationState);
      case "survey":
        return await handleSurvey(params, navigationState);
      case "click":
        return await handleClick(params, navigationState);
      case "type":
        return await handleType(params, navigationState);
      case "select_option":
        return await handleSelectOption(params, navigationState);
      case "read":
        return await handleRead(params, navigationState);
      case "dom_snapshot":
        return await handleDomSnapshot(params, navigationState);
      case "scroll":
        return await handleScroll(params, navigationState);
      case "keypress":
        return await handleKeypress(params, navigationState);
      case "screenshot":
        return await handleScreenshot(params, navigationState);
      case "observe":
        return await handleObserve(params, navigationState);
      case "read_console":
        return await handleReadConsole(params, navigationState);
      case "read_network":
        return await handleReadNetwork(params, navigationState);
      case "eval":
        return await handleEval(params, navigationState);
      case "file_upload":
        return await handleFileUpload(params, navigationState);
      case "form_input":
        return await handleFormInput(params, navigationState);
      case "gif":
        return await handleGif(params, navigationState);
      case "tabs":
        return await handleTabs(params, navigationState);
      case "wait":
        return await handleWait(params, navigationState);
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  };

  try {
    const result = await runExclusive(mutexKey(action, params), COMMAND_DEADLINE_MS, dispatch);
    sendResponse({ id, success: true, result });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    sendResponse({ id, success: false, error });
  }
}

function sendResponse(response: ResponseMessage): void {
  if (!port) {
    console.error(`${LOG_PREFIX} Cannot send response — not connected`);
    return;
  }

  const serialized = JSON.stringify(response);
  if (serialized.length > MAX_MESSAGE_SIZE) {
    port.postMessage({
      id: response.id,
      success: false,
      error: `Response too large (${serialized.length} bytes). Native messaging limit is 1MB.`,
    });
    return;
  }

  port.postMessage(response);
}

// ── Status ────────────────────────────────────────────────────────

async function doStatus(): Promise<{
  connected: boolean;
  automationTab: { id: number; url: string; title: string } | null;
  tabCount: number;
}> {
  const tabs = await chrome.tabs.query({});
  let automationTab: { id: number; url: string; title: string } | null = null;

  if (automationTabId !== null) {
    try {
      const tab = await chrome.tabs.get(automationTabId);
      automationTab = {
        id: tab.id!,
        url: tab.url || "",
        title: tab.title || "",
      };
    } catch {
      automationTabId = null;
    }
  }

  return { connected: true, automationTab, tabCount: tabs.length };
}

// ── Keepalive ─────────────────────────────────────────────────────

setupKeepalive(() => {
  if (!port) {
    console.log(`${LOG_PREFIX} Keepalive: reconnecting`);
    connect();
  }
});

// Active ping loop — the primary keepalive. Sending a message over the native
// port every ~20s resets the worker's idle timer, keeping both the service
// worker and (via the open port) the native host process resident. Without
// this the worker naps after ~30s, the port drops, and the host tears down its
// socket + token — the root cause of the bridge dropping offline. The host
// ignores `{ type: "keepalive" }` frames (see native-host/src/index.ts).
startPingLoop(() => {
  if (port) {
    try {
      port.postMessage({ type: "keepalive" });
    } catch (e) {
      // postMessage throws if the port closed between the null-check and here;
      // the onDisconnect handler will have scheduled a reconnect already.
      console.log(`${LOG_PREFIX} Keepalive ping failed:`, e);
    }
  }
});

// ── Observe Event Forwarding ─────────────────────────────────────
// Content scripts from handleObserve send messages via chrome.runtime.sendMessage.
// Forward them as unsolicited EventMessages through the native messaging port.

chrome.runtime.onMessage.addListener(
  (message: EventMessage, _sender, _sendResponse) => {
    if (message.type === "observe_event" && port) {
      port.postMessage(message);
    }
  }
);

// ── Capture content script ────────────────────────────────────────
// Register the MAIN-world capture installer (inject.js) so console output and
// fetch/XHR metadata are buffered from document_start on every page. This is
// what read_console / read_network read. Registration persists across worker
// restarts, so we only register if it isn't already present.

async function registerCaptureScript(): Promise<void> {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({
      ids: ["chh-capture"],
    });
    if (existing.length > 0) return;

    await chrome.scripting.registerContentScripts([
      {
        id: "chh-capture",
        matches: ["http://*/*", "https://*/*"],
        js: ["dist/inject.js"],
        runAt: "document_start",
        world: "MAIN",
        allFrames: false,
      },
    ]);
    console.log(`${LOG_PREFIX} Capture content script registered`);
  } catch (e) {
    console.error(`${LOG_PREFIX} Failed to register capture content script:`, e);
  }
}

void registerCaptureScript();

// ── Start ─────────────────────────────────────────────────────────

connect();
