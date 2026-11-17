/**
 * Select-option command — change the value of a <select> or ARIA combobox.
 *
 * Two paths:
 *   - Native HTMLSelectElement: use the React-aware property-descriptor
 *     setter to bypass React's value tracker, then dispatch input + change.
 *     Supports <select multiple> via array of values/labels.
 *   - ARIA combobox (role="combobox" with role="listbox" of options): synthetic
 *     click to open, poll AX tree for the matching option, click it.
 *
 * Targeting: same three modes as click/type — selector, roleName, index.
 */

import { withCDP } from "../lib/cdp.js";
import { getSurveyCache } from "./survey.js";
import { INTERACTIVE_ROLES } from "../lib/role-name.js";
import type { NavigationState } from "./navigate.js";

// ── Types ────────────────────────────────────────────────────────

export interface SelectOptionParams {
  selector?: string;
  roleName?: string;
  index?: number;
  value?: string | string[];
  label?: string | string[];
  optionIndex?: number;
}

export interface SelectOptionResult {
  selected: { value: string | string[]; label: string | string[] };
  mode: "react-setter" | "react-setter-multi" | "aria-click";
  target: string;
}

interface AXValue {
  value: string;
}

interface AXNode {
  nodeId: string;
  role?: AXValue;
  name?: AXValue;
  ignored?: boolean;
  backendDOMNodeId?: number;
}

// ── Validation ──────────────────────────────────────────────────

function validateAddressingMode(params: {
  selector?: string;
  roleName?: string;
  index?: number;
}): void {
  const modes = [
    params.selector !== undefined,
    params.roleName !== undefined,
    params.index !== undefined,
  ].filter(Boolean).length;

  if (modes === 0) {
    throw new Error(
      "Exactly one of selector, roleName, or index must be provided."
    );
  }
  if (modes > 1) {
    throw new Error(
      "Exactly one of selector, roleName, or index must be provided. Got multiple."
    );
  }
}

function validateOptionSpec(params: SelectOptionParams): void {
  const specs = [
    params.value !== undefined,
    params.label !== undefined,
    params.optionIndex !== undefined,
  ].filter(Boolean).length;

  if (specs === 0) {
    throw new Error(
      "Exactly one of value, label, or optionIndex must be provided."
    );
  }
  if (specs > 1) {
    throw new Error(
      "Exactly one of value, label, or optionIndex must be provided. Got multiple."
    );
  }
}

// ── Element resolution (mirrors interact.ts) ────────────────────

async function findAXNodeByRoleName(
  tabId: number,
  roleName: string
): Promise<{ backendDOMNodeId: number; description: string }> {
  const parts = roleName.split(":");
  if (parts.length < 2) {
    throw new Error(
      `Invalid roleName format: "${roleName}". Expected "role:name" (e.g. "combobox:Project").`
    );
  }
  const targetRole = parts[0].toLowerCase();
  const targetName = parts.slice(1).join(":");

  const result = (await chrome.debugger.sendCommand(
    { tabId },
    "Accessibility.getFullAXTree"
  )) as { nodes?: AXNode[] };

  for (const node of result?.nodes || []) {
    if (node.ignored) continue;
    const role = (node.role?.value || "").toLowerCase();
    const name = node.name?.value || "";
    if (role === targetRole && name === targetName && node.backendDOMNodeId) {
      return {
        backendDOMNodeId: node.backendDOMNodeId,
        description: `${role}:"${name}"`,
      };
    }
  }

  throw new Error(
    `No accessible element found with role="${targetRole}" and name="${targetName}".`
  );
}

async function findAXNodeByIndex(
  tabId: number,
  index: number
): Promise<{ backendDOMNodeId: number; description: string }> {
  const cache = getSurveyCache();
  if (!cache) {
    throw new Error(
      "No survey cache available. Run browser_survey first to index page elements."
    );
  }

  const element = cache.elements.find((el) => el.index === index);
  if (!element) {
    throw new Error(
      `Survey index ${index} not found. Survey has ${cache.count} elements (0-${cache.count - 1}).`
    );
  }

  if (element.inIframe) {
    throw new Error(
      `browser_select_option does not yet support elements inside iframes. ` +
        `Use selector mode against the iframe contents, or address the iframe directly.`
    );
  }

  const result = (await chrome.debugger.sendCommand(
    { tabId },
    "Accessibility.getFullAXTree"
  )) as { nodes?: AXNode[] };

  let currentIndex = 0;
  for (const node of result?.nodes || []) {
    if (node.ignored) continue;
    const role = (node.role?.value || "").toLowerCase();
    if (role === "none" || role === "generic") continue;
    if (!INTERACTIVE_ROLES.has(role)) continue;

    if (currentIndex === index) {
      if (!node.backendDOMNodeId) {
        throw new Error(
          `Element at index ${index} (${role}:"${node.name?.value || ""}") has no DOM node backing.`
        );
      }
      return {
        backendDOMNodeId: node.backendDOMNodeId,
        description: `[${index}] ${role}:"${node.name?.value || ""}"`,
      };
    }
    currentIndex++;
  }

  throw new Error(
    `Could not resolve survey index ${index} in current AX tree. The page may have changed since the last survey.`
  );
}

// ── Native HTMLSelectElement handler (page-world script) ────────

/**
 * Source of the in-page function for setting <select>.value via the
 * React-aware setter. Used by both selector and CDP paths.
 *
 * Returns one of:
 *   - { mode: "react-setter", value, label }
 *   - { mode: "react-setter-multi", value: string[], label: string[] }
 *   - { mode: "aria-needs-open" } — caller should fall back to ARIA path
 *   - { mode: "error", message }
 */
const SELECT_OPTION_FN_SRC = `function(spec) {
  const tag = this.tagName;

  // Path A: native HTMLSelectElement
  if (tag === "SELECT") {
    const sel = this;
    const opts = Array.from(sel.options);

    function findByValue(v) {
      return opts.find(function (o) { return o.value === v; });
    }
    function findByLabel(l) {
      var t = String(l).trim();
      return opts.find(function (o) {
        return (o.label || "").trim() === t || (o.textContent || "").trim() === t;
      });
    }

    // Multi-select handling — value or label may be an array
    if (sel.multiple) {
      var targets = [];
      if (Array.isArray(spec.value)) {
        for (var i = 0; i < spec.value.length; i++) {
          var t = findByValue(spec.value[i]);
          if (!t) return { mode: "error", message: "Option not found by value: " + spec.value[i] };
          targets.push(t);
        }
      } else if (Array.isArray(spec.label)) {
        for (var j = 0; j < spec.label.length; j++) {
          var tl = findByLabel(spec.label[j]);
          if (!tl) return { mode: "error", message: "Option not found by label: " + spec.label[j] };
          targets.push(tl);
        }
      } else if (spec.optionIndex != null) {
        var tIdx = opts[spec.optionIndex];
        if (!tIdx) return { mode: "error", message: "optionIndex out of range" };
        targets.push(tIdx);
      } else if (spec.value != null) {
        var tv = findByValue(spec.value);
        if (!tv) return { mode: "error", message: "Option not found by value: " + spec.value };
        targets.push(tv);
      } else if (spec.label != null) {
        var tlb = findByLabel(spec.label);
        if (!tlb) return { mode: "error", message: "Option not found by label: " + spec.label };
        targets.push(tlb);
      } else {
        return { mode: "error", message: "No selection spec provided" };
      }

      // Clear all then set selected on targets
      for (var k = 0; k < opts.length; k++) opts[k].selected = false;
      for (var m = 0; m < targets.length; m++) targets[m].selected = true;

      sel.dispatchEvent(new Event("input", { bubbles: true }));
      sel.dispatchEvent(new Event("change", { bubbles: true }));

      return {
        mode: "react-setter-multi",
        value: targets.map(function (o) { return o.value; }),
        label: targets.map(function (o) {
          return (o.label || "").trim() || (o.textContent || "").trim();
        }),
      };
    }

    // Single-select
    var target;
    if (spec.optionIndex != null) {
      target = opts[spec.optionIndex];
    } else if (spec.value != null) {
      target = findByValue(spec.value);
    } else if (spec.label != null) {
      target = findByLabel(spec.label);
    }
    if (!target) {
      var key = spec.optionIndex != null ? "optionIndex=" + spec.optionIndex
              : spec.value != null ? "value=" + JSON.stringify(spec.value)
              : "label=" + JSON.stringify(spec.label);
      return { mode: "error", message: "Option not found in <select> by " + key };
    }

    // React-aware setter — bypass React's value tracker
    var setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype, "value"
    ).set;
    setter.call(sel, target.value);

    sel.dispatchEvent(new Event("input", { bubbles: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));

    return {
      mode: "react-setter",
      value: target.value,
      label: (target.label || "").trim() || (target.textContent || "").trim(),
    };
  }

  // Path B: ARIA combobox — needs open + click handled by caller
  var role = this.getAttribute && this.getAttribute("role");
  if (role === "combobox" || role === "listbox") {
    return { mode: "aria-needs-open" };
  }

  return {
    mode: "error",
    message: "Target is neither <select> nor role=combobox/listbox (tag=" + tag + ", role=" + role + ")",
  };
}`;

// ── Selector resolution via CDP ─────────────────────────────────
//
// Selector mode resolves the element to a backendDOMNodeId through CDP and then
// uses the SAME callFunctionOn path as roleName/index modes. An earlier version
// rebuilt the select helper with `new Function(...)` inside an injected script,
// but MV3's extension CSP forbids eval in the content-script isolated world, so
// it always threw ("no result from executeScript") — selector mode was wholly
// broken. Routing through CDP fixes it and also gives selector mode ARIA-combobox
// support for free (selectViaCDP handles both native <select> and ARIA).

async function resolveSelectorViaCDP(
  tabId: number,
  selector: string
): Promise<{ backendDOMNodeId: number; description: string }> {
  await chrome.debugger.sendCommand({ tabId }, "DOM.enable");
  const doc = (await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument", {
    depth: 0,
  })) as { root: { nodeId: number } };
  const found = (await chrome.debugger.sendCommand({ tabId }, "DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector,
  })) as { nodeId: number };
  if (!found.nodeId) {
    throw new Error(`Element not found: ${selector}`);
  }
  const desc = (await chrome.debugger.sendCommand({ tabId }, "DOM.describeNode", {
    nodeId: found.nodeId,
  })) as { node?: { backendNodeId?: number } };
  if (!desc.node?.backendNodeId) {
    throw new Error(`Could not resolve a DOM node for selector: ${selector}`);
  }
  return {
    backendDOMNodeId: desc.node.backendNodeId,
    description: `selector "${selector}"`,
  };
}

type SelectOptionFnResult =
  | { mode: "react-setter"; value: string; label: string }
  | { mode: "react-setter-multi"; value: string[]; label: string[] }
  | { mode: "aria-needs-open" }
  | { mode: "error"; message: string };

// ── CDP path (roleName / index modes) ───────────────────────────

async function callSelectFnViaCDP(
  tabId: number,
  backendNodeId: number,
  spec: SelectOptionParams
): Promise<SelectOptionFnResult> {
  const resolved = (await chrome.debugger.sendCommand(
    { tabId },
    "DOM.resolveNode",
    { backendNodeId }
  )) as { object: { objectId: string } };

  const result = (await chrome.debugger.sendCommand(
    { tabId },
    "Runtime.callFunctionOn",
    {
      objectId: resolved.object.objectId,
      functionDeclaration: SELECT_OPTION_FN_SRC,
      arguments: [
        {
          value: {
            value: spec.value,
            label: spec.label,
            optionIndex: spec.optionIndex,
          },
        },
      ],
      returnByValue: true,
    }
  )) as { result: { value: SelectOptionFnResult } };

  return result.result.value;
}

async function clickViaCDP(
  tabId: number,
  backendNodeId: number
): Promise<void> {
  const resolved = (await chrome.debugger.sendCommand(
    { tabId },
    "DOM.resolveNode",
    { backendNodeId }
  )) as { object: { objectId: string } };

  await chrome.debugger.sendCommand({ tabId }, "Runtime.callFunctionOn", {
    objectId: resolved.object.objectId,
    functionDeclaration: "function() { this.click(); }",
  });
}

/**
 * Poll the AX tree for an option whose name matches `label`.
 * Used after opening an ARIA combobox to find the target option.
 */
async function pollForOptionByLabel(
  tabId: number,
  label: string,
  timeoutMs: number
): Promise<{ backendDOMNodeId: number; name: string }> {
  const target = label.trim();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = (await chrome.debugger.sendCommand(
      { tabId },
      "Accessibility.getFullAXTree"
    )) as { nodes?: AXNode[] };

    for (const node of result?.nodes || []) {
      if (node.ignored) continue;
      const role = (node.role?.value || "").toLowerCase();
      if (role !== "option" && role !== "menuitem") continue;
      const name = (node.name?.value || "").trim();
      if (name === target && node.backendDOMNodeId) {
        return { backendDOMNodeId: node.backendDOMNodeId, name };
      }
    }

    // Brief wait before next poll
    await new Promise((r) => setTimeout(r, 100));
  }

  throw new Error(
    `ARIA combobox option with label "${label}" did not appear within ${timeoutMs}ms.`
  );
}

async function selectViaCDP(
  tabId: number,
  backendNodeId: number,
  description: string,
  spec: SelectOptionParams
): Promise<SelectOptionResult> {
  const out = await callSelectFnViaCDP(tabId, backendNodeId, spec);

  if (out.mode === "error") {
    throw new Error(out.message);
  }

  if (out.mode === "react-setter" || out.mode === "react-setter-multi") {
    return {
      selected: { value: out.value, label: out.label },
      mode: out.mode,
      target: description,
    };
  }

  // ARIA combobox: open the listbox, find option, click it.
  if (spec.label === undefined) {
    throw new Error(
      "ARIA combobox path requires a label (the visible option text). " +
        "Provide `label: \"...\"` instead of value/optionIndex for ARIA targets."
    );
  }
  if (Array.isArray(spec.label)) {
    throw new Error(
      "ARIA combobox path does not support multi-select via array labels."
    );
  }

  // Click to open
  await clickViaCDP(tabId, backendNodeId);

  // Poll for the option
  const option = await pollForOptionByLabel(tabId, spec.label, 2000);

  // Click the option
  await clickViaCDP(tabId, option.backendDOMNodeId);

  return {
    selected: { value: option.name, label: option.name },
    mode: "aria-click",
    target: description,
  };
}

// ── Handler ─────────────────────────────────────────────────────

export async function handleSelectOption(
  params: Record<string, unknown>,
  state: NavigationState
): Promise<SelectOptionResult> {
  if (state.automationTabId === null) {
    throw new Error("No active automation tab. Navigate to a page first.");
  }

  const tabId = state.automationTabId;
  const selector = params.selector as string | undefined;
  const roleName = params.roleName as string | undefined;
  const index = params.index as number | undefined;

  const spec: SelectOptionParams = {
    selector,
    roleName,
    index,
    value: params.value as string | string[] | undefined,
    label: params.label as string | string[] | undefined,
    optionIndex: params.optionIndex as number | undefined,
  };

  validateAddressingMode({ selector, roleName, index });
  validateOptionSpec(spec);

  // All three addressing modes resolve to a backendDOMNodeId and go through the
  // same CDP callFunctionOn path (handles native <select> and ARIA combobox).
  return withCDP(tabId, async (tid) => {
    let resolved: { backendDOMNodeId: number; description: string };
    if (selector !== undefined) {
      resolved = await resolveSelectorViaCDP(tid, selector);
    } else if (roleName !== undefined) {
      resolved = await findAXNodeByRoleName(tid, roleName);
    } else {
      resolved = await findAXNodeByIndex(tid, index!);
    }
    return selectViaCDP(tid, resolved.backendDOMNodeId, resolved.description, spec);
  });
}
