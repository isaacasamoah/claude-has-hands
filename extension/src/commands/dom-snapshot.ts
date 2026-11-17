/**
 * DOM snapshot command - lightweight element inspection for agent grounding.
 *
 * browser_survey is accessibility-first and intentionally compact. This
 * command complements it with DOM-specific context: selectors, XPath,
 * bounding boxes, visibility, attributes, and bounded outerHTML.
 */

import type { NavigationState } from "./navigate.js";

export interface DomSnapshotElement {
  index: number;
  frameIndex: number;
  frameUrl: string;
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
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  style: {
    display: string;
    visibility: string;
    opacity: string;
    pointerEvents: string;
    position: string;
    zIndex: string;
  };
  attributes: Record<string, string>;
  value?: string;
  valueRedacted?: boolean;
  outerHTML: string;
}

export interface DomSnapshotResult {
  url: string;
  title: string;
  selector: string;
  textFilter?: string;
  count: number;
  elements: DomSnapshotElement[];
}

const DEFAULT_SELECTOR =
  'a[href],button,input,select,textarea,summary,[role],[contenteditable="true"],[tabindex]:not([tabindex="-1"])';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_MAX_HTML_LENGTH = 800;
const MAX_HTML_LENGTH = 5_000;

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export async function handleDomSnapshot(
  params: Record<string, unknown>,
  state: NavigationState
): Promise<DomSnapshotResult> {
  if (state.automationTabId === null) {
    throw new Error("No active automation tab. Navigate to a page first.");
  }

  const tabId = state.automationTabId;
  const selector =
    typeof params.selector === "string" && params.selector.trim()
      ? params.selector.trim()
      : DEFAULT_SELECTOR;
  const textFilter =
    typeof params.text === "string" && params.text.trim()
      ? params.text.trim()
      : undefined;
  const includeHidden = params.includeHidden === true;
  const limit = clampNumber(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const maxHtmlLength = clampNumber(
    params.maxHtmlLength,
    DEFAULT_MAX_HTML_LENGTH,
    0,
    MAX_HTML_LENGTH
  );

  const tab = await chrome.tabs.get(tabId);

  type FrameSnapshot = {
    frameUrl: string;
    frameTitle: string;
    elements: Omit<DomSnapshotElement, "index" | "frameIndex">[];
  };

  let results: chrome.scripting.InjectionResult<FrameSnapshot>[];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: collectDomSnapshot,
      args: [selector, textFilter ?? null, includeHidden, limit, maxHtmlLength],
    });
  } catch {
    // Some pages/frames reject all-frame injection. Fall back to the main
    // frame so the command still returns useful context.
    results = await chrome.scripting.executeScript({
      target: { tabId },
      func: collectDomSnapshot,
      args: [selector, textFilter ?? null, includeHidden, limit, maxHtmlLength],
    });
  }

  const elements: DomSnapshotElement[] = [];
  for (const [frameIndex, frame] of results.entries()) {
    const frameResult = frame.result;
    if (!frameResult) continue;
    for (const element of frameResult.elements) {
      if (elements.length >= limit) break;
      elements.push({
        index: elements.length,
        frameIndex,
        ...element,
      });
    }
    if (elements.length >= limit) break;
  }

  return {
    url: tab.url || "",
    title: tab.title || "",
    selector,
    textFilter,
    count: elements.length,
    elements,
  };
}

/**
 * Runs in the page world via chrome.scripting.executeScript. Keep this
 * function self-contained; it cannot close over extension variables.
 */
function collectDomSnapshot(
  selector: string,
  textFilter: string | null,
  includeHidden: boolean,
  limit: number,
  maxHtmlLength: number
) {
  const trim = (value: string | null | undefined, max = 240): string => {
    const normalized = (value || "").replace(/\s+/g, " ").trim();
    return normalized.length > max ? normalized.slice(0, max) + "..." : normalized;
  };

  const escapeCss = (value: string): string => {
    const css = globalThis.CSS as { escape?: (s: string) => string } | undefined;
    if (css && typeof css.escape === "function") return css.escape(value);
    return value.replace(/["\\#.:,[\]>+~*'=]/g, "\\$&");
  };

  const unique = (candidate: string): boolean => {
    try {
      return document.querySelectorAll(candidate).length === 1;
    } catch {
      return false;
    }
  };

  const tagName = (el: Element): string => el.tagName.toLowerCase();

  const nthOfType = (el: Element): number => {
    let index = 1;
    let sibling = el.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === el.tagName) index++;
      sibling = sibling.previousElementSibling;
    }
    return index;
  };

  const cssPath = (el: Element): string => {
    const id = el.getAttribute("id");
    if (id) {
      const byId = `#${escapeCss(id)}`;
      if (unique(byId)) return byId;
    }

    const parts: string[] = [];
    let cursor: Element | null = el;
    while (cursor && cursor.nodeType === Node.ELEMENT_NODE && parts.length < 7) {
      let part = tagName(cursor);
      const cursorId = cursor.getAttribute("id");
      if (cursorId) {
        part += `#${escapeCss(cursorId)}`;
        parts.unshift(part);
        break;
      }

      const classes = Array.from(cursor.classList)
        .filter((c) => c && !/^\d/.test(c))
        .slice(0, 3);
      if (classes.length > 0) {
        part += classes.map((c) => `.${escapeCss(c)}`).join("");
      }

      const parent: Element | null = cursor.parentElement;
      if (parent) {
        const currentTag = cursor.tagName;
        const sameTagSiblings = Array.from(parent.children).filter((child) => {
          return child.tagName === currentTag;
        });
        if (sameTagSiblings.length > 1) {
          part += `:nth-of-type(${nthOfType(cursor)})`;
        }
      }

      parts.unshift(part);
      const candidate = parts.join(" > ");
      if (unique(candidate)) return candidate;
      cursor = parent;
    }

    return parts.join(" > ");
  };

  const xpath = (el: Element): string => {
    const parts: string[] = [];
    let cursor: Element | null = el;
    while (cursor && cursor.nodeType === Node.ELEMENT_NODE) {
      const tag = tagName(cursor);
      const id = cursor.getAttribute("id");
      if (id) {
        parts.unshift(`*[@id="${id.replace(/"/g, '\\"')}"]`);
        break;
      }
      parts.unshift(`${tag}[${nthOfType(cursor)}]`);
      cursor = cursor.parentElement;
    }
    return "/" + parts.join("/");
  };

  const labelledByText = (el: Element): string => {
    const ids = (el.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean);
    return ids
      .map((id) => document.getElementById(id)?.textContent || "")
      .join(" ");
  };

  const implicitRole = (el: Element): string | null => {
    const tag = tagName(el);
    if (tag === "a" && (el as HTMLAnchorElement).href) return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "summary") return "button";
    if (tag === "input") {
      const type = ((el as HTMLInputElement).type || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "submit" || type === "button" || type === "reset") return "button";
      return "textbox";
    }
    return null;
  };

  const accessibleName = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) return trim(aria);

    const labelled = labelledByText(el);
    if (labelled) return trim(labelled);

    const alt = el.getAttribute("alt");
    if (alt) return trim(alt);

    const title = el.getAttribute("title");
    if (title) return trim(title);

    const tag = tagName(el);
    if (tag === "input") {
      const input = el as HTMLInputElement;
      if (input.type === "submit" || input.type === "button" || input.type === "reset") {
        return trim(input.value);
      }
      const label = input.labels?.[0]?.textContent;
      if (label) return trim(label);
      if (input.placeholder) return trim(input.placeholder);
      if (input.name) return trim(input.name);
    }

    return trim((el as HTMLElement).innerText || el.textContent || "");
  };

  const selectedAttributes = (el: Element): Record<string, string> => {
    const names = [
      "id",
      "class",
      "name",
      "type",
      "role",
      "aria-label",
      "aria-labelledby",
      "aria-describedby",
      "aria-expanded",
      "aria-selected",
      "aria-checked",
      "aria-disabled",
      "placeholder",
      "title",
      "href",
      "data-testid",
      "data-test",
      "data-cy",
    ];
    const attrs: Record<string, string> = {};
    for (const name of names) {
      const value = el.getAttribute(name);
      if (value !== null) attrs[name] = trim(value, 320);
    }
    return attrs;
  };

  const isSensitiveInput = (el: Element): boolean => {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
    if (el instanceof HTMLInputElement) {
      const type = (el.type || "").toLowerCase();
      if (["password", "hidden"].includes(type)) return true;
    }
    const joined = [
      el.getAttribute("name"),
      el.getAttribute("id"),
      el.getAttribute("autocomplete"),
      el.getAttribute("aria-label"),
      el.getAttribute("placeholder"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return /(password|secret|token|api[-_ ]?key|csrf|auth|credential|session)/.test(joined);
  };

  const valueInfo = (el: Element): { value?: string; valueRedacted?: boolean } => {
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    ) {
      if (isSensitiveInput(el)) return { valueRedacted: true };
      return { value: trim(el.value, 160) };
    }
    return {};
  };

  let candidates: Element[];
  try {
    candidates = Array.from(document.querySelectorAll(selector));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid selector "${selector}": ${msg}`);
  }

  const filter = textFilter ? textFilter.toLowerCase() : null;
  const elements = [];

  for (const el of candidates) {
    if (elements.length >= limit) break;

    const htmlEl = el as HTMLElement;
    const rect = htmlEl.getBoundingClientRect();
    const style = getComputedStyle(htmlEl);
    const visible =
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity || "1") > 0 &&
      rect.width > 0 &&
      rect.height > 0;
    if (!includeHidden && !visible) continue;

    const text = trim(htmlEl.innerText || el.textContent || "", 500);
    const name = accessibleName(el);
    const role = el.getAttribute("role") || implicitRole(el);
    const haystack = `${tagName(el)} ${role || ""} ${name} ${text} ${el.getAttribute("class") || ""}`.toLowerCase();
    if (filter && !haystack.includes(filter)) continue;

    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const inViewport =
      rect.bottom >= 0 &&
      rect.right >= 0 &&
      rect.top <= window.innerHeight &&
      rect.left <= window.innerWidth;
    const top = inViewport
      ? document.elementFromPoint(
          Math.max(0, Math.min(window.innerWidth - 1, centerX)),
          Math.max(0, Math.min(window.innerHeight - 1, centerY))
        )
      : null;
    const topmost = top === el || (top !== null && el.contains(top));
    const disabled =
      (el as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)
        .disabled === true || el.getAttribute("aria-disabled") === "true";

    const html = el.outerHTML || "";
    const value = valueInfo(el);

    elements.push({
      frameUrl: document.location.href,
      tag: tagName(el),
      role,
      name,
      text,
      selector: cssPath(el),
      xpath: xpath(el),
      visible,
      inViewport,
      topmost,
      disabled,
      bounds: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      style: {
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
        position: style.position,
        zIndex: style.zIndex,
      },
      attributes: selectedAttributes(el),
      ...value,
      outerHTML:
        maxHtmlLength > 0 && html.length > maxHtmlLength
          ? html.slice(0, maxHtmlLength) + "..."
          : html,
    });
  }

  return {
    frameUrl: document.location.href,
    frameTitle: document.title,
    elements,
  };
}
