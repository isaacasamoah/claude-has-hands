/**
 * Interact commands — click + type with three addressing modes.
 *
 * Phase 2c: CSS selector, role:name, and survey index targeting.
 *
 * Element resolution:
 * - CSS selector: chrome.scripting.executeScript in page context
 * - roleName / index: CDP Accessibility tree -> backendDOMNodeId -> Runtime.callFunctionOn
 */

import { withCDP } from "../lib/cdp.js";
import { unwrapPageResult, type PageResult } from "../lib/page-result.js";
import {
  getSurveyCache,
  buildParentMap,
  ancestorPath,
  pathsEqual,
  type AXNode,
  type SurveyElement,
} from "./survey.js";
import type { NavigationState } from "./navigate.js";

// ── Types ────────────────────────────────────────────────────────

export interface ClickParams {
  selector?: string;
  roleName?: string;
  index?: number;
}

export interface ClickResult {
  clicked: string;
  description: string;
  /** Optional diagnostic hint when the click likely had no effect (e.g. <option> inside closed <select>). */
  hint?: string;
}

/**
 * Result of the post-click diagnostic check. Returned from a single CDP
 * Runtime.callFunctionOn so we don't pay the cost of multiple roundtrips.
 */
interface ClickDiagnostic {
  tag: string;
  parentTag: string | null;
  parentRole: string | null;
  parentSize: number | null;
  parentMultiple: boolean | null;
  forTargetDisabled: boolean | null;
  detailsToggleNoop: boolean;
}

export interface TypeParams {
  selector?: string;
  roleName?: string;
  index?: number;
  text: string;
  clear?: boolean;
}

export interface TypeResult {
  typed: string;
  target: string;
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

// ── CSS Selector Helpers ────────────────────────────────────────

async function clickBySelector(
  tabId: number,
  selector: string
): Promise<ClickResult> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel: string): PageResult<{ description: string; hint: string | null }> => {
      try {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return { ok: false, error: `Element not found: ${sel}` };
        el.click();
        const tag = el.tagName.toLowerCase();
        const text = el.textContent?.trim().slice(0, 50) || "";
        const desc = text ? `<${tag}> "${text}"` : `<${tag}>`;

        const parent = el.parentElement;
        const parentTag = parent ? parent.tagName : null;
        const parentSelect = parent && parent.tagName === "SELECT"
          ? (parent as HTMLSelectElement)
          : null;

        let hint: string | null = null;
        if (
          el.tagName === "OPTION" &&
          parentSelect &&
          !parentSelect.multiple &&
          (parentSelect.size || 1) <= 1
        ) {
          hint =
            "Clicked an <option> inside a closed <select>. The select's value did NOT change " +
            "because native <select> popups are OS-rendered, not DOM-rendered. " +
            "Use browser_select_option to actually change the value.";
        } else if (el.tagName === "LABEL") {
          const labelEl = el as HTMLLabelElement;
          if (labelEl.htmlFor) {
            const ref = document.getElementById(labelEl.htmlFor) as
              | (HTMLElement & { disabled?: boolean })
              | null;
            if (ref && ref.disabled) {
              hint =
                "Clicked a <label> whose for-target element is disabled. The associated " +
                "control will not receive focus or activation.";
            }
          }
        } else if (
          el.tagName === "SUMMARY" &&
          parentTag !== null &&
          parentTag !== "DETAILS"
        ) {
          hint =
            "Clicked a <summary> that is not inside a <details>. The expected toggle " +
            "behaviour does not apply.";
        }

        return { ok: true, value: { description: desc, hint } };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    args: [selector],
  });

  const out = unwrapPageResult(results);
  const result: ClickResult = { clicked: selector, description: out.description };
  if (out.hint) result.hint = out.hint;
  return result;
}

async function typeBySelector(
  tabId: number,
  selector: string,
  text: string,
  clear: boolean
): Promise<TypeResult> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel: string, txt: string, clr: boolean): PageResult<string> => {
      try {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return { ok: false, error: `Element not found: ${sel}` };
        el.focus();
        if (clr) {
          if ("select" in el && typeof (el as HTMLInputElement).select === "function") {
            (el as HTMLInputElement).select();
          } else {
            document.execCommand("selectAll");
          }
        }
        document.execCommand("insertText", false, txt);
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role") || "";
        const desc = role ? `<${tag} role="${role}">` : `<${tag}>`;
        return { ok: true, value: desc };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    args: [selector, text, clear],
  });

  return { typed: text, target: unwrapPageResult(results) };
}

// ── CDP Element Resolution ──────────────────────────────────────

/**
 * Find an AX node by role:name string and return its backendDOMNodeId.
 */
async function findAXNodeByRoleName(
  tabId: number,
  roleName: string
): Promise<{ backendDOMNodeId: number; description: string }> {
  const parts = roleName.split(":");
  if (parts.length < 2) {
    throw new Error(
      `Invalid roleName format: "${roleName}". Expected "role:name" (e.g. "button:Sign in").`
    );
  }
  const targetRole = parts[0].toLowerCase();
  const targetName = parts.slice(1).join(":"); // name may contain colons

  const result = (await chrome.debugger.sendCommand(
    { tabId },
    "Accessibility.getFullAXTree"
  )) as { nodes?: AXNode[] };

  const nodes = result?.nodes || [];

  for (const node of nodes) {
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

/**
 * Re-resolve a cached survey element against a freshly-fetched AX tree.
 *
 * Identity = (role, name, containerPath). We do NOT trust the survey
 * positional index across DOM mutations: if the page added a button
 * between survey time and click time, the index would silently retarget.
 * Matching on stable identity gives us three clear outcomes:
 *   - exactly one match  → click that node's backendDOMNodeId
 *   - zero matches       → "element no longer present"
 *   - multiple matches   → "element identity ambiguous after DOM change"
 */
function resolveBySnapshot(
  cached: SurveyElement,
  nodes: AXNode[]
): AXNode {
  const byId = buildParentMap(nodes);
  const matches: AXNode[] = [];

  for (const node of nodes) {
    if (node.ignored) continue;
    const role = (node.role?.value || "").toLowerCase();
    if (role === "none" || role === "generic") continue;
    if (role !== cached.role) continue;
    if ((node.name?.value || "") !== cached.name) continue;
    if (!pathsEqual(ancestorPath(node, byId), cached.containerPath)) continue;
    matches.push(node);
  }

  if (matches.length === 0) {
    throw new Error(
      `Element no longer present (was [${cached.index}] ${cached.role}:"${cached.name}"). ` +
        `The page likely changed between survey and action — re-run browser_survey.`
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Element identity ambiguous after DOM change (was [${cached.index}] ${cached.role}:"${cached.name}", now ${matches.length} candidates with the same (role, name, container path)). Re-run browser_survey.`
    );
  }

  const node = matches[0];
  if (!node.backendDOMNodeId) {
    throw new Error(
      `Element at index ${cached.index} (${cached.role}:"${cached.name}") has no DOM node backing.`
    );
  }
  return node;
}

/**
 * Find an AX node by survey index and return its backendDOMNodeId,
 * resolving by stable identity rather than positional index.
 *
 * If the element is in an iframe, attach to that iframe's target,
 * fetch its AX tree, and resolve there. The iframe target stays
 * attached; the caller (clickViaCDP / typeViaCDP) reuses the same
 * session and detaches in a finally block.
 */
async function findAXNodeByIndex(
  tabId: number,
  index: number
): Promise<{ backendDOMNodeId: number; description: string; iframeTargetId?: string }> {
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

  // Iframe element → attach to the iframe target, resolve there. The
  // attach is held only for the duration of this call; the calling
  // click/type re-attaches when it actually acts. Per-tab mutex in
  // background.ts guarantees only one command holds the attach at a
  // time, so the previous "double-attach race" is structurally absent.
  if (element.inIframe && element.frameId) {
    await chrome.debugger.attach({ targetId: element.frameId }, "1.3");
    try {
      const result = (await chrome.debugger.sendCommand(
        { targetId: element.frameId },
        "Accessibility.getFullAXTree"
      )) as { nodes?: AXNode[] };
      const node = resolveBySnapshot(element, result?.nodes || []);
      return {
        backendDOMNodeId: node.backendDOMNodeId!,
        description: `[${index}] ${element.role}:"${element.name}" (iframe)`,
        iframeTargetId: element.frameId,
      };
    } finally {
      try {
        await chrome.debugger.detach({ targetId: element.frameId });
      } catch {
        // already detached
      }
    }
  }

  // Main-frame element — fetch the live AX tree and resolve by identity.
  const result = (await chrome.debugger.sendCommand(
    { tabId },
    "Accessibility.getFullAXTree"
  )) as { nodes?: AXNode[] };
  const node = resolveBySnapshot(element, result?.nodes || []);
  return {
    backendDOMNodeId: node.backendDOMNodeId!,
    description: `[${index}] ${element.role}:"${element.name}"`,
  };
}

/**
 * Build a debugger target — either tabId or targetId for iframes.
 */
function debuggerTarget(tabId: number, iframeTargetId?: string): chrome.debugger.Debuggee {
  if (iframeTargetId) {
    return { targetId: iframeTargetId };
  }
  return { tabId };
}

/**
 * Click an element via CDP using its backendDOMNodeId.
 */
async function clickViaCDP(
  tabId: number,
  backendNodeId: number,
  iframeTargetId?: string
): Promise<void> {
  const target = debuggerTarget(tabId, iframeTargetId);

  const resolved = (await chrome.debugger.sendCommand(
    target,
    "DOM.resolveNode",
    { backendNodeId }
  )) as { object: { objectId: string } };

  await chrome.debugger.sendCommand(target, "Runtime.callFunctionOn", {
    objectId: resolved.object.objectId,
    functionDeclaration: "function() { this.click(); }",
  });
}

/**
 * Inspect the clicked node and surface a hint if the click was likely a no-op.
 * Returns null if no diagnostic hint applies. Single CDP roundtrip.
 */
async function diagnoseClick(
  tabId: number,
  backendNodeId: number,
  iframeTargetId?: string
): Promise<string | null> {
  const target = debuggerTarget(tabId, iframeTargetId);

  const resolved = (await chrome.debugger.sendCommand(
    target,
    "DOM.resolveNode",
    { backendNodeId }
  )) as { object: { objectId: string } };

  const result = (await chrome.debugger.sendCommand(target, "Runtime.callFunctionOn", {
    objectId: resolved.object.objectId,
    functionDeclaration: `function() {
      var tag = this.tagName || "";
      var parent = this.parentElement;
      var parentTag = parent ? (parent.tagName || "") : null;
      var parentRole = parent && parent.getAttribute ? parent.getAttribute("role") : null;
      var parentSize = parent && parent.tagName === "SELECT" ? (parent.size || 1) : null;
      var parentMultiple = parent && parent.tagName === "SELECT" ? !!parent.multiple : null;

      // <label for=X> targeting a disabled element
      var forTargetDisabled = null;
      if (tag === "LABEL" && this.htmlFor) {
        var doc = this.ownerDocument || document;
        var ref = doc.getElementById(this.htmlFor);
        if (ref) forTargetDisabled = !!ref.disabled;
      }

      // <summary> click only toggles when inside a <details>
      var detailsToggleNoop = false;
      if (tag === "SUMMARY" && parent && parent.tagName !== "DETAILS") {
        detailsToggleNoop = true;
      }

      return {
        tag: tag,
        parentTag: parentTag,
        parentRole: parentRole,
        parentSize: parentSize,
        parentMultiple: parentMultiple,
        forTargetDisabled: forTargetDisabled,
        detailsToggleNoop: detailsToggleNoop,
      };
    }`,
    returnByValue: true,
  })) as { result: { value: ClickDiagnostic } };

  const diag = result.result.value;

  // <option> inside a closed (size===1, not multiple) <select> — the canonical no-op
  if (
    diag.tag === "OPTION" &&
    diag.parentTag === "SELECT" &&
    diag.parentMultiple === false &&
    (diag.parentSize ?? 1) <= 1
  ) {
    return (
      "Clicked an <option> inside a closed <select>. The select's value did NOT change " +
      "because native <select> popups are OS-rendered, not DOM-rendered. " +
      "Use browser_select_option to actually change the value."
    );
  }

  // <label> whose `for` references a disabled element
  if (diag.tag === "LABEL" && diag.forTargetDisabled === true) {
    return (
      "Clicked a <label> whose for-target element is disabled. The associated " +
      "control will not receive focus or activation."
    );
  }

  // <summary> outside <details>
  if (diag.detailsToggleNoop) {
    return (
      "Clicked a <summary> that is not inside a <details>. The expected toggle " +
      "behaviour does not apply."
    );
  }

  return null;
}

/**
 * Type into an element via CDP using its backendDOMNodeId.
 */
async function typeViaCDP(
  tabId: number,
  backendNodeId: number,
  text: string,
  clear: boolean,
  iframeTargetId?: string
): Promise<void> {
  const target = debuggerTarget(tabId, iframeTargetId);

  const resolved = (await chrome.debugger.sendCommand(
    target,
    "DOM.resolveNode",
    { backendNodeId }
  )) as { object: { objectId: string } };

  await chrome.debugger.sendCommand(target, "Runtime.callFunctionOn", {
    objectId: resolved.object.objectId,
    functionDeclaration: `function(text, clear) {
      this.focus();
      if (clear) {
        if (typeof this.select === 'function') {
          this.select();
        } else {
          document.execCommand('selectAll');
        }
      }
      document.execCommand('insertText', false, text);
    }`,
    arguments: [
      { value: text },
      { value: clear },
    ],
  });
}

// ── Handlers ────────────────────────────────────────────────────

export async function handleClick(
  params: Record<string, unknown>,
  state: NavigationState
): Promise<ClickResult> {
  if (state.automationTabId === null) {
    throw new Error("No active automation tab. Navigate to a page first.");
  }

  const tabId = state.automationTabId;
  const selector = params.selector as string | undefined;
  const roleName = params.roleName as string | undefined;
  const index = params.index as number | undefined;

  validateAddressingMode({ selector, roleName, index });

  // CSS selector mode — no CDP needed
  if (selector) {
    return clickBySelector(tabId, selector);
  }

  // roleName or index mode — use CDP
  return withCDP(tabId, async (tid) => {
    let resolved: { backendDOMNodeId: number; description: string; iframeTargetId?: string };

    if (roleName) {
      resolved = await findAXNodeByRoleName(tid, roleName);
    } else {
      resolved = await findAXNodeByIndex(tid, index!);
    }

    // For iframe elements, re-attach to iframe target for the click
    let hint: string | null = null;
    if (resolved.iframeTargetId) {
      await chrome.debugger.attach({ targetId: resolved.iframeTargetId }, "1.3");
      try {
        await clickViaCDP(tid, resolved.backendDOMNodeId, resolved.iframeTargetId);
        try {
          hint = await diagnoseClick(tid, resolved.backendDOMNodeId, resolved.iframeTargetId);
        } catch {
          // Diagnostic is best-effort — never let it fail the click.
        }
      } finally {
        try {
          await chrome.debugger.detach({ targetId: resolved.iframeTargetId });
        } catch { /* already detached */ }
      }
    } else {
      await clickViaCDP(tid, resolved.backendDOMNodeId);
      try {
        hint = await diagnoseClick(tid, resolved.backendDOMNodeId);
      } catch {
        // Diagnostic is best-effort.
      }
    }

    const result: ClickResult = {
      clicked: roleName || `index:${index}`,
      description: `Clicked ${resolved.description}`,
    };
    if (hint) result.hint = hint;
    return result;
  });
}

export async function handleType(
  params: Record<string, unknown>,
  state: NavigationState
): Promise<TypeResult> {
  if (state.automationTabId === null) {
    throw new Error("No active automation tab. Navigate to a page first.");
  }

  const tabId = state.automationTabId;
  const selector = params.selector as string | undefined;
  const roleName = params.roleName as string | undefined;
  const index = params.index as number | undefined;
  const text = params.text as string | undefined;
  const clear = params.clear !== undefined ? Boolean(params.clear) : true;

  if (!text && text !== "") {
    throw new Error("text parameter is required.");
  }

  validateAddressingMode({ selector, roleName, index });

  // CSS selector mode — no CDP needed
  if (selector) {
    return typeBySelector(tabId, selector, text, clear);
  }

  // roleName or index mode — use CDP
  return withCDP(tabId, async (tid) => {
    let resolved: { backendDOMNodeId: number; description: string; iframeTargetId?: string };

    if (roleName) {
      resolved = await findAXNodeByRoleName(tid, roleName);
    } else {
      resolved = await findAXNodeByIndex(tid, index!);
    }

    // For iframe elements, re-attach to iframe target for the type
    if (resolved.iframeTargetId) {
      await chrome.debugger.attach({ targetId: resolved.iframeTargetId }, "1.3");
      try {
        await typeViaCDP(tid, resolved.backendDOMNodeId, text, clear, resolved.iframeTargetId);
      } finally {
        try {
          await chrome.debugger.detach({ targetId: resolved.iframeTargetId });
        } catch { /* already detached */ }
      }
    } else {
      await typeViaCDP(tid, resolved.backendDOMNodeId, text, clear);
    }

    return {
      typed: text,
      target: resolved.description,
    };
  });
}
