/**
 * BrowserToolRegistry — single source of truth for the browser_* tool surface.
 *
 * Both the legacy MCP-via-Unix-socket adapter and the new REST/MCP adapters
 * read from this list so we don't end up with three hand-maintained schemas
 * drifting from each other.
 *
 * Each entry pairs the public tool name (browser_*) with the internal action
 * (navigate/click/...) the extension dispatches on, plus a zod input schema
 * and a formatter that turns the typed result into text content for MCP.
 *
 * The wire boundary that all adapters share is:
 *   { tool: "browser_*", input: <validated against zod schema> }
 *   → response body { ok, request_id, result | error }
 *
 * Adapters are responsible only for transport (stdio MCP, Streamable HTTP MCP,
 * REST, shell wrapper) — never for re-defining tool semantics.
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/jpeg" | "image/png" };

/**
 * Format a successful command result into MCP content blocks.
 * The legacy MCP server inlined these per tool; this consolidates them.
 */
export type ToolFormatter = (result: unknown) => ToolContent[];

export interface BrowserTool<TInput extends z.ZodRawShape = z.ZodRawShape> {
  /** Public-facing tool name. */
  name: string;
  /** Internal action sent to the extension. */
  action: string;
  /** Tool description shown to the model. */
  description: string;
  /** Input shape (object of zod fields). */
  schema: TInput;
  /** Default formatter for successful results. */
  format: ToolFormatter;
}

const navTitleUrlTab = (verb: string): ToolFormatter => (result) => {
  const r = result as { title: string; url: string; tabId: number };
  return [
    {
      type: "text",
      text: `${verb}: ${r.title}\nURL: ${r.url}\nTab: ${r.tabId}`,
    },
  ];
};

const formatDomSnapshot: ToolFormatter = (result) => {
  const r = result as {
    title: string;
    url: string;
    selector: string;
    textFilter?: string;
    count: number;
    elements: Array<{
      index: number;
      frameIndex: number;
      tag: string;
      role: string | null;
      name: string;
      text: string;
      selector: string;
      xpath: string;
      visible: boolean;
      inViewport: boolean;
      topmost: boolean;
      disabled: boolean;
      bounds: { x: number; y: number; width: number; height: number };
      attributes: Record<string, string>;
      value?: string;
      valueRedacted?: boolean;
    }>;
  };

  const lines = [
    `Page: ${r.title} (${r.url})`,
    `DOM snapshot (${r.count} elements)`,
    `Selector: ${r.selector}`,
  ];
  if (r.textFilter) lines.push(`Text filter: ${JSON.stringify(r.textFilter)}`);
  lines.push("");

  for (const el of r.elements) {
    const label = el.name || el.text || "";
    const role = el.role ? ` role=${JSON.stringify(el.role)}` : "";
    const state = [
      el.visible ? "visible" : "hidden",
      el.inViewport ? "in-viewport" : "offscreen",
      el.topmost ? "topmost" : "covered",
      el.disabled ? "disabled" : "",
      el.valueRedacted ? "value-redacted" : "",
    ].filter(Boolean);
    lines.push(
      `[${el.index}] <${el.tag}>${role} ${JSON.stringify(label)} (${state.join(", ")})`
    );
    lines.push(
      `  box=${el.bounds.x},${el.bounds.y} ${el.bounds.width}x${el.bounds.height}`
    );
    lines.push(`  selector=${el.selector}`);
    lines.push(`  xpath=${el.xpath}`);
  }

  return [{ type: "text", text: lines.join("\n") }];
};

export const BROWSER_TOOLS: BrowserTool[] = [
  {
    name: "browser_status",
    action: "status",
    description:
      "Check if the Chrome extension is connected and responsive. Returns connection status, active automation tab info, and total tab count.",
    schema: {},
    format: (result) => {
      const r = result as {
        connected: boolean;
        automationTab: { id: number; url: string; title: string } | null;
        tabCount: number;
      };
      const lines = [
        `Connected: ${r.connected}`,
        `Tabs open: ${r.tabCount}`,
      ];
      if (r.automationTab) {
        lines.push(
          `Active tab: [${r.automationTab.id}] ${r.automationTab.title}`
        );
        lines.push(`  URL: ${r.automationTab.url}`);
      } else {
        lines.push("Active tab: none (will be created on first navigation)");
      }
      return [{ type: "text", text: lines.join("\n") }];
    },
  },
  {
    name: "browser_navigate",
    action: "navigate",
    description: "Navigate to a URL in the browser. Returns page title, URL, and tab ID.",
    schema: {
      url: z
        .string()
        .describe("The URL to navigate to. https:// is prepended if missing."),
      tab: z
        .union([z.number(), z.literal("new")])
        .optional()
        .describe(
          'Tab to navigate in. A number targets that tab ID, "new" opens a new tab. Omit to use the current automation tab.'
        ),
    },
    format: navTitleUrlTab("Navigated to"),
  },
  {
    name: "browser_back",
    action: "back",
    description:
      "Navigate back in browser history. Returns the resulting page title, URL, and tab ID.",
    schema: {},
    format: navTitleUrlTab("Navigated back to"),
  },
  {
    name: "browser_forward",
    action: "forward",
    description:
      "Navigate forward in browser history. Returns the resulting page title, URL, and tab ID.",
    schema: {},
    format: navTitleUrlTab("Navigated forward to"),
  },
  {
    name: "browser_survey",
    action: "survey",
    description:
      "Get accessibility tree snapshot of interactive elements on the current page. Returns indexed list of interactive elements with their roles, names, and states. This is the primary tool for understanding page structure — use it before clicking or typing.",
    schema: {
      includeAll: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, include all accessibility tree nodes (not just interactive ones). Defaults to false."
        ),
    },
    format: (result) => {
      const r = result as {
        elements: Array<{
          index: number;
          role: string;
          name: string;
          inIframe: boolean;
          frameId: string;
          focusable: boolean;
          disabled: boolean;
          value?: string;
        }>;
        count: number;
        iframeCount: number;
        url: string;
        title: string;
      };
      const lines: string[] = [
        `Page: ${r.title} (${r.url})`,
        `Interactive elements (${r.count} found, ${r.iframeCount} iframes):`,
        "",
      ];
      for (const el of r.elements) {
        const valuePart =
          el.value !== undefined ? `  value=${JSON.stringify(el.value)}` : "";
        const stateParts: string[] = [];
        if (el.disabled) stateParts.push("disabled");
        const stateStr = stateParts.length > 0 ? `  (${stateParts.join(", ")})` : "";
        const name = el.name ? JSON.stringify(el.name) : '""';
        lines.push(
          `[${el.index}]  ${el.role.padEnd(12)} ${name}${valuePart}${stateStr}`
        );
      }
      return [{ type: "text", text: lines.join("\n") }];
    },
  },
  {
    name: "browser_dom_snapshot",
    action: "dom_snapshot",
    description:
      "Inspect DOM elements on the current page with selectors, XPath, bounding boxes, visibility, attributes, text, and bounded outerHTML. Use this when browser_survey is ambiguous or when you need a stable selector for duplicate-looking elements.",
    schema: {
      selector: z
        .string()
        .optional()
        .describe(
          "CSS selector to inspect. Defaults to common interactive elements: links, buttons, inputs, selects, textareas, summary, role-bearing, contenteditable, and tabbable elements."
        ),
      text: z
        .string()
        .optional()
        .describe(
          "Case-insensitive substring filter applied to tag, role, accessible name, visible text, and class."
        ),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Maximum number of elements to return. Defaults to 50, capped at 200."),
      includeHidden: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, include hidden or zero-size matches. Defaults to false."),
      maxHtmlLength: z
        .number()
        .optional()
        .default(800)
        .describe("Maximum outerHTML characters per element. Defaults to 800, capped at 5000."),
    },
    format: formatDomSnapshot,
  },
  {
    name: "browser_click",
    action: "click",
    description:
      "Click an element on the page. Target by CSS selector, role:name string (e.g. 'button:Sign in'), or survey index from browser_survey. Exactly one targeting mode must be provided.",
    schema: {
      selector: z
        .string()
        .optional()
        .describe(
          "CSS selector to target the element (e.g. '#submit-btn', '.login-form button')."
        ),
      roleName: z
        .string()
        .optional()
        .describe(
          'Accessibility role:name string (e.g. "button:Sign in", "link:Home"). Use browser_survey to discover available elements.'
        ),
      index: z
        .number()
        .optional()
        .describe(
          "Survey index from the last browser_survey result. Run browser_survey first to get indices."
        ),
    },
    format: (result) => {
      const r = result as { clicked: string; description: string; hint?: string };
      const lines = [`Clicked: ${r.description}`, `Target: ${r.clicked}`];
      if (r.hint) lines.push(`Hint: ${r.hint}`);
      return [{ type: "text", text: lines.join("\n") }];
    },
  },
  {
    name: "browser_type",
    action: "type",
    description:
      "Type text into an element. Target by CSS selector, role:name, or survey index. Clears existing content by default. Exactly one targeting mode must be provided.",
    schema: {
      selector: z
        .string()
        .optional()
        .describe(
          "CSS selector to target the element (e.g. '#search-input', 'input[name=email]')."
        ),
      roleName: z
        .string()
        .optional()
        .describe(
          'Accessibility role:name string (e.g. "textbox:Search", "combobox:Email"). Use browser_survey to discover available elements.'
        ),
      index: z
        .number()
        .optional()
        .describe(
          "Survey index from the last browser_survey result. Run browser_survey first to get indices."
        ),
      text: z.string().describe("The text to type into the element."),
      clear: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "If true (default), clears existing content before typing. Set to false to append."
        ),
    },
    format: (result) => {
      const r = result as { typed: string; target: string };
      return [
        { type: "text", text: `Typed "${r.typed}" into ${r.target}` },
      ];
    },
  },
  {
    name: "browser_select_option",
    action: "select_option",
    description:
      "Select an option in a native <select> element or ARIA combobox. Use this instead of browser_click for <option> elements inside closed native selects, where clicking the option is a browser no-op.",
    schema: {
      selector: z
        .string()
        .optional()
        .describe(
          "CSS selector for the <select> element. For ARIA comboboxes, prefer roleName or index."
        ),
      roleName: z
        .string()
        .optional()
        .describe(
          'Accessibility role:name string for the combobox (e.g. "combobox:Project").'
        ),
      index: z
        .number()
        .optional()
        .describe(
          "Survey index of the select/combobox from the last browser_survey result."
        ),
      value: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe(
          "The option value attribute. Pass an array for <select multiple>. Native <select> only."
        ),
      label: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe(
          "The option's visible text. For ARIA combobox, this is the supported option spec. Pass an array for <select multiple>."
        ),
      optionIndex: z
        .number()
        .optional()
        .describe(
          "Zero-based index of the option in the <select>. Native <select> only."
        ),
    },
    format: (result) => {
      const r = result as {
        selected: { value: string | string[]; label: string | string[] };
        mode: string;
        target: string;
      };
      const valueStr = Array.isArray(r.selected.value)
        ? `[${r.selected.value.map((v) => JSON.stringify(v)).join(", ")}]`
        : JSON.stringify(r.selected.value);
      const labelStr = Array.isArray(r.selected.label)
        ? `[${r.selected.label.map((l) => JSON.stringify(l)).join(", ")}]`
        : JSON.stringify(r.selected.label);
      return [
        {
          type: "text",
          text: `Selected ${labelStr} (value=${valueStr}) in ${r.target} via ${r.mode}.`,
        },
      ];
    },
  },
  {
    name: "browser_read",
    action: "read",
    description:
      "Extract text content from the current page or a specific element. Returns the innerText, optionally truncated.",
    schema: {
      selector: z
        .string()
        .optional()
        .describe(
          "CSS selector to read text from a specific element. Omit to read the entire page body."
        ),
      maxLength: z
        .number()
        .optional()
        .default(50000)
        .describe("Maximum character length of returned text. Defaults to 50000."),
    },
    format: (result) => {
      const r = result as { text: string; truncated: boolean };
      const truncNote = r.truncated ? "\n[truncated]" : "";
      return [{ type: "text", text: r.text + truncNote }];
    },
  },
  {
    name: "browser_scroll",
    action: "scroll",
    description:
      "Scroll the page or a specific scrollable element. Specify direction and optional page count.",
    schema: {
      direction: z
        .enum(["up", "down", "left", "right"])
        .describe("Direction to scroll."),
      amount: z
        .number()
        .optional()
        .default(1)
        .describe("Number of pages to scroll. Defaults to 1."),
      selector: z
        .string()
        .optional()
        .describe(
          "CSS selector of a scrollable container. Omit to scroll the page."
        ),
    },
    format: (result) => {
      const r = result as { scrolled: string; amount: number };
      return [{ type: "text", text: `Scrolled ${r.scrolled}` }];
    },
  },
  {
    name: "browser_keypress",
    action: "keypress",
    description:
      "Dispatch a keyboard event (keydown, keypress, keyup) to the page or a specific element. Useful for Enter, Escape, Tab, arrow keys, or keyboard shortcuts.",
    schema: {
      key: z
        .string()
        .describe(
          'The key to press. Examples: "Enter", "Escape", "Tab", "ArrowDown", "a", "1".'
        ),
      selector: z
        .string()
        .optional()
        .describe(
          "CSS selector of the element to target. Omit to target the currently focused element."
        ),
      modifiers: z
        .array(z.string())
        .optional()
        .describe(
          'Modifier keys to hold during the keypress. Options: "ctrl", "shift", "alt", "meta".'
        ),
    },
    format: (result) => {
      const r = result as { key: string };
      return [{ type: "text", text: `Pressed key: ${r.key}` }];
    },
  },
  {
    name: "browser_screenshot",
    action: "screenshot",
    description:
      "Capture a screenshot of the current page as a JPEG image. Returns a base64 data URI. Prefer browser_survey for understanding page structure — use screenshots only when visual context is needed.",
    schema: {
      quality: z
        .number()
        .optional()
        .default(40)
        .describe("JPEG quality 1-100. Lower = smaller. Default 40."),
    },
    format: (result) => {
      const r = result as { image: string };
      return [
        {
          type: "image",
          data: r.image.replace(/^data:image\/jpeg;base64,/, ""),
          mimeType: "image/jpeg",
        },
      ];
    },
  },
  {
    name: "browser_observe",
    action: "observe",
    description:
      "Start or stop a DOM/navigation observer on the current page. When started, the extension will send events when the page changes. Useful for monitoring dynamic content.",
    schema: {
      action: z
        .enum(["start", "stop"])
        .describe("Whether to start or stop observing."),
      observeId: z
        .string()
        .describe(
          "Unique identifier for this observer. Use the same ID to stop a previously started observer."
        ),
      events: z
        .array(z.string())
        .optional()
        .describe(
          'Event types to monitor. Options: "dom", "navigation". Defaults to both.'
        ),
    },
    format: (result) => {
      const r = result as {
        observeId: string;
        monitoring?: string[];
        stopped?: boolean;
      };
      if (r.stopped) {
        return [{ type: "text", text: `Observer "${r.observeId}" stopped.` }];
      }
      return [
        {
          type: "text",
          text: `Observer "${r.observeId}" started. Monitoring: ${r.monitoring?.join(", ") || "dom, navigation"}`,
        },
      ];
    },
  },
  {
    name: "browser_tabs",
    action: "tabs",
    description:
      "Manage browser tabs: list all tabs, switch to a tab, open a new tab, or close a tab.",
    schema: {
      action: z
        .enum(["list", "switch", "new", "close"])
        .describe("The tab action to perform."),
      tabId: z
        .number()
        .optional()
        .describe("Tab ID for switch or close actions."),
      url: z
        .string()
        .optional()
        .describe(
          "URL for new tab, or URL substring to match when switching tabs."
        ),
    },
    format: (result) => {
      const r = result as {
        action: string;
        tabs?: Array<{
          id: number;
          url: string;
          title: string;
          active: boolean;
          isAutomationTab: boolean;
        }>;
        tabId?: number;
        url?: string;
        title?: string;
        closed?: boolean;
      };
      if (r.action === "list" && r.tabs) {
        const lines = r.tabs.map((t) => {
          const markers: string[] = [];
          if (t.active) markers.push("active");
          if (t.isAutomationTab) markers.push("automation");
          const suffix = markers.length ? ` (${markers.join(", ")})` : "";
          return `[${t.id}] ${t.title || "(untitled)"}${suffix}\n  ${t.url}`;
        });
        return [
          {
            type: "text",
            text: `Tabs (${r.tabs.length}):\n${lines.join("\n")}`,
          },
        ];
      }
      if (r.action === "switch") {
        return [
          {
            type: "text",
            text: `Switched to tab [${r.tabId}]: ${r.title}\nURL: ${r.url}`,
          },
        ];
      }
      if (r.action === "new") {
        return [
          {
            type: "text",
            text: `Opened new tab [${r.tabId}]${r.url ? `\nURL: ${r.url}` : ""}`,
          },
        ];
      }
      if (r.action === "close") {
        return [{ type: "text", text: `Closed tab [${r.tabId}]` }];
      }
      return [{ type: "text", text: JSON.stringify(r) }];
    },
  },
  {
    name: "browser_wait",
    action: "wait",
    description:
      "Wait for a condition: page navigation to complete, a CSS selector to appear, or a fixed timeout. Useful after clicking links or submitting forms.",
    schema: {
      condition: z
        .enum(["navigation", "selector", "timeout"])
        .describe("What to wait for."),
      selector: z
        .string()
        .optional()
        .describe(
          'CSS selector to wait for (required when condition is "selector").'
        ),
      timeout: z
        .number()
        .optional()
        .default(10000)
        .describe("Maximum wait time in milliseconds. Default 10000."),
    },
    format: (result) => {
      const r = result as {
        waited: string;
        elapsed: number;
        found?: boolean;
      };
      let text = `Waited for ${r.waited} (${r.elapsed}ms)`;
      if (r.found !== undefined) {
        text += r.found ? " — element found" : " — element NOT found (timed out)";
      }
      return [{ type: "text", text }];
    },
  },
  {
    name: "browser_console",
    action: "read_console",
    description:
      "Read buffered console output (log/info/warn/error/debug) plus uncaught errors and unhandled promise rejections from the current page. Capture starts at page load — reload the page if it reports capture is not active. Use this to debug client-side errors.",
    schema: {
      level: z
        .enum(["all", "log", "info", "warn", "error", "debug"])
        .optional()
        .describe('Filter by level. "all" (default) returns every level.'),
      limit: z
        .number()
        .optional()
        .default(100)
        .describe("Maximum number of most-recent entries to return. Default 100."),
      clear: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, clear the console buffer after reading."),
    },
    format: (result) => {
      const r = result as {
        entries: Array<{ seq: number; ts: number; level: string; text: string }>;
        total: number;
        returned: number;
        captureActive: boolean;
      };
      if (!r.captureActive) {
        return [
          {
            type: "text",
            text: "Console capture is not active on this page. Reload the page (browser_navigate to the same URL) so the capture script installs at document_start, then retry.",
          },
        ];
      }
      if (r.entries.length === 0) {
        return [{ type: "text", text: "No console messages buffered." }];
      }
      const lines = [`Console (${r.returned} of ${r.total} matching):`, ""];
      for (const e of r.entries) {
        lines.push(`[${e.level.toUpperCase()}] ${e.text}`);
      }
      return [{ type: "text", text: lines.join("\n") }];
    },
  },
  {
    name: "browser_network",
    action: "read_network",
    description:
      "Read buffered network request metadata (method, URL, status, timing) for fetch() and XMLHttpRequest calls made by the current page. Metadata only — request/response bodies are never captured. Capture starts at page load — reload the page if it reports capture is not active.",
    schema: {
      url: z
        .string()
        .optional()
        .describe("Case-insensitive substring filter on the request URL."),
      method: z
        .string()
        .optional()
        .describe('Filter by HTTP method (e.g. "GET", "POST").'),
      status: z
        .union([z.number(), z.string()])
        .optional()
        .describe(
          'Filter by status. A number matches exactly; "error" matches failed/non-2xx; "4xx"/"5xx"/"2xx"/"3xx" match a band.'
        ),
      limit: z
        .number()
        .optional()
        .default(100)
        .describe("Maximum number of most-recent entries to return. Default 100."),
      clear: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, clear the network buffer after reading."),
    },
    format: (result) => {
      const r = result as {
        entries: Array<{
          type: string;
          method: string;
          url: string;
          status: number;
          ok: boolean;
          durationMs: number;
          error?: string;
        }>;
        total: number;
        returned: number;
        captureActive: boolean;
      };
      if (!r.captureActive) {
        return [
          {
            type: "text",
            text: "Network capture is not active on this page. Reload the page (browser_navigate to the same URL) so the capture script installs at document_start, then retry.",
          },
        ];
      }
      if (r.entries.length === 0) {
        return [{ type: "text", text: "No network requests buffered." }];
      }
      const lines = [`Network (${r.returned} of ${r.total} matching):`, ""];
      for (const e of r.entries) {
        const statusPart = e.error
          ? `ERR ${e.error}`
          : `${e.status || "pending"}${e.ok ? "" : e.status ? " ✗" : ""}`;
        lines.push(
          `${e.method.padEnd(6)} ${statusPart}  ${e.durationMs}ms  ${e.url}`
        );
      }
      return [{ type: "text", text: lines.join("\n") }];
    },
  },
  {
    name: "browser_eval",
    action: "eval",
    description:
      "Evaluate a JavaScript expression in the page's main world and return its value. Has access to the page's own globals (window, document, app state). Promises are awaited. Use for reading computed state or driving behaviour that has no dedicated tool — prefer the structured tools (survey/click/type) when they fit.",
    schema: {
      expression: z
        .string()
        .describe(
          "The JavaScript expression to evaluate (e.g. 'document.title', 'window.__APP_STATE__', 'fetch(\"/api\").then(r=>r.status)')."
        ),
      awaitPromise: z
        .boolean()
        .optional()
        .default(true)
        .describe("If the expression returns a Promise, await it (default true)."),
    },
    format: (result) => {
      const r = result as { value: unknown; type: string; truncated: boolean };
      let rendered: string;
      if (r.value === undefined) rendered = "undefined";
      else if (typeof r.value === "string") rendered = r.value;
      else rendered = JSON.stringify(r.value, null, 2);
      const trunc = r.truncated ? "\n[truncated]" : "";
      return [{ type: "text", text: `(${r.type}) ${rendered}${trunc}` }];
    },
  },
  {
    name: "browser_file_upload",
    action: "file_upload",
    description:
      "Attach local files to a file <input> on the page, targeted by CSS selector. File inputs are usually hidden, so this targets by selector (not survey index) and sets the files directly. Paths must be absolute and are read from the machine running the browser.",
    schema: {
      selector: z
        .string()
        .describe('CSS selector for the file input (e.g. \'input[type="file"]\').'),
      files: z
        .union([z.string(), z.array(z.string())])
        .describe("Absolute path, or array of absolute paths, to upload."),
    },
    format: (result) => {
      const r = result as { selector: string; files: string[]; count: number };
      return [
        {
          type: "text",
          text: `Attached ${r.count} file(s) to ${r.selector}:\n${r.files.join("\n")}`,
        },
      ];
    },
  },
  {
    name: "browser_form_input",
    action: "form_input",
    description:
      "Fill multiple form fields in one call, targeting each by CSS selector. The field kind (text / select / checkbox / radio) is auto-detected from the element but can be overridden. Faster than issuing separate type/select_option calls for a multi-field form.",
    schema: {
      fields: z
        .array(
          z.object({
            selector: z.string().describe("CSS selector for the field."),
            value: z
              .union([z.string(), z.boolean(), z.number()])
              .describe(
                "Value to set. For checkbox/radio a truthy value checks it; for text/select it is the text/value to set."
              ),
            kind: z
              .enum(["text", "select", "checkbox", "radio"])
              .optional()
              .describe("Override the auto-detected field kind."),
          })
        )
        .describe("The fields to fill, applied in order."),
    },
    format: (result) => {
      const r = result as {
        results: Array<{ selector: string; ok: boolean; kind?: string; error?: string }>;
        filled: number;
        total: number;
      };
      const lines = [`Form input (${r.filled}/${r.total} filled):`];
      for (const f of r.results) {
        lines.push(
          f.ok
            ? `  ✓ ${f.selector}${f.kind ? ` (${f.kind})` : ""}`
            : `  ✗ ${f.selector}: ${f.error}`
        );
      }
      return [{ type: "text", text: lines.join("\n") }];
    },
  },
  {
    name: "browser_gif",
    action: "gif",
    description:
      "Capture a timed sequence of frames (screenshots) over a duration — useful for seeing animation, loading, or motion over a window. Returns an ordered set of JPEG frames. Note: returns a frame sequence, not an encoded .gif file (the browser↔host channel caps a single artifact at ~1MB); frames stop once the response nears that limit.",
    schema: {
      duration: z
        .number()
        .optional()
        .default(3000)
        .describe("Capture window in milliseconds. Default 3000, max 10000."),
      fps: z
        .number()
        .optional()
        .default(2)
        .describe("Frames per second. Default 2, max 5."),
      maxFrames: z
        .number()
        .optional()
        .default(8)
        .describe("Hard cap on frame count. Default 8, max 12."),
      quality: z
        .number()
        .optional()
        .default(30)
        .describe("JPEG quality 1-100. Lower = smaller frames. Default 30."),
    },
    format: (result) => {
      const r = result as {
        frames: Array<{ index: number; ts: number; image: string }>;
        frameCount: number;
        intervalMs: number;
        durationMs: number;
        truncated: boolean;
      };
      const content: ToolContent[] = [
        {
          type: "text",
          text:
            `Captured ${r.frameCount} frame(s) over ${r.durationMs}ms (~${r.intervalMs}ms apart)` +
            (r.truncated ? " — truncated at the response size limit." : "."),
        },
      ];
      for (const f of r.frames) {
        content.push({ type: "text", text: `frame ${f.index} (+${f.ts}ms):` });
        content.push({
          type: "image",
          data: f.image.replace(/^data:image\/jpeg;base64,/, ""),
          mimeType: "image/jpeg",
        });
      }
      return content;
    },
  },
  {
    name: "browser_batch",
    action: "batch",
    description:
      "Run several browser_* tool calls in one request, in order, stopping at the first failure. The win is fewer model round-trips for a known multi-step sequence (e.g. navigate → wait → type → click). Each step is { tool, input }. Cannot be nested.",
    schema: {
      steps: z
        .array(
          z.object({
            tool: z
              .string()
              .describe('The tool name to call (e.g. "browser_click").'),
            input: z
              .record(z.string(), z.unknown())
              .optional()
              .describe("The input object for that tool."),
          })
        )
        .describe("The ordered list of tool calls to run."),
    },
    format: (result) => {
      const r = result as { results: BatchStepResult[] };
      const blocks: ToolContent[] = [];
      const n = r.results.length;
      r.results.forEach((s, i) => {
        const label = `[${i + 1}/${n}] ${s.tool}`;
        if (!s.ok) {
          blocks.push({ type: "text", text: `${label} FAILED: ${s.error}` });
          return;
        }
        blocks.push({ type: "text", text: `${label}:` });
        const def = getToolByName(s.tool);
        if (def) blocks.push(...def.format(s.result));
        else blocks.push({ type: "text", text: JSON.stringify(s.result) });
      });
      if (blocks.length === 0) {
        blocks.push({ type: "text", text: "No steps executed." });
      }
      return blocks;
    },
  },
];

export function getToolByName(name: string): BrowserTool | undefined {
  return BROWSER_TOOLS.find((t) => t.name === name);
}

// ── browser_batch execution helper ────────────────────────────────
//
// browser_batch is the one tool that doesn't map 1:1 to an extension action:
// it runs a sequence of other tools. The semantics live here (single source of
// truth) and each transport injects its own "call one atomic tool" primitive —
// the legacy MCP server uses bridge.sendCommand, the REST server uses
// dispatcher.send. The REST-backed MCP adapter needs nothing special: it
// forwards browser_batch to REST, which runs it here, and formats the returned
// { results } with the formatter above.

export interface BatchStep {
  tool: string;
  input?: Record<string, unknown>;
}

export interface BatchStepResult {
  tool: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Outcome of one atomic call, transport-agnostic. */
export interface AtomicCallOutcome {
  success: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Run batch steps in order, validating each step's tool + input against the
 * registry before dispatching via the injected `callOne`. Stops at the first
 * failure (later steps usually depend on earlier ones) and returns the results
 * collected so far.
 */
export async function runBatchSteps(
  steps: BatchStep[],
  callOne: (action: string, input: Record<string, unknown>) => Promise<AtomicCallOutcome>
): Promise<BatchStepResult[]> {
  const out: BatchStepResult[] = [];

  for (const step of steps) {
    const def = getToolByName(step.tool);
    if (!def) {
      out.push({ tool: step.tool, ok: false, error: "unknown tool" });
      break;
    }
    if (def.name === "browser_batch") {
      out.push({ tool: step.tool, ok: false, error: "browser_batch cannot be nested" });
      break;
    }

    const parsed = z.object(def.schema).safeParse(step.input ?? {});
    if (!parsed.success) {
      out.push({ tool: step.tool, ok: false, error: `invalid input: ${parsed.error.message}` });
      break;
    }

    try {
      const r = await callOne(def.action, parsed.data as Record<string, unknown>);
      if (!r.success) {
        out.push({ tool: step.tool, ok: false, error: r.error ?? "tool error" });
        break;
      }
      out.push({ tool: step.tool, ok: true, result: r.result });
    } catch (e) {
      out.push({ tool: step.tool, ok: false, error: e instanceof Error ? e.message : String(e) });
      break;
    }
  }

  return out;
}

/**
 * Build a JSON Schema descriptor list for `GET /v1/tools`. Each entry
 * carries the public name, description, action, and a JSON Schema 7
 * draft of the input shape so any client (curl, Codex, Gemini) can
 * introspect the surface without owning a zod runtime.
 */
export interface ToolDescriptor {
  name: string;
  action: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function listToolDescriptors(): ToolDescriptor[] {
  return BROWSER_TOOLS.map((t) => ({
    name: t.name,
    action: t.action,
    description: t.description,
    inputSchema: zodToJsonSchema(z.object(t.schema), {
      target: "jsonSchema7",
      $refStrategy: "none",
    }) as Record<string, unknown>,
  }));
}
