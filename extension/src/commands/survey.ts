/**
 * Survey command — accessibility tree snapshot of interactive elements.
 *
 * Phase 3a: main frame + iframe traversal.
 *
 * Uses CDP Accessibility.getFullAXTree to get the full accessibility tree,
 * filters to interactive roles, assigns stable positional indices, and
 * caches the result for click/type commands to resolve indices.
 *
 * For iframes: uses chrome.debugger.getTargets() to discover iframe targets,
 * attaches to each separately, gets their AX tree, and merges elements with
 * inIframe: true and the target's frameId.
 */

import { withCDP } from "../lib/cdp.js";
import { INTERACTIVE_ROLES } from "../lib/role-name.js";
import type { NavigationState } from "./navigate.js";

// ── Types ────────────────────────────────────────────────────────

export interface SurveyElement {
  index: number;
  role: string;
  name: string;
  inIframe: boolean;   // always false for Phase 2b
  frameId: string;     // always "" for Phase 2b
  focusable: boolean;
  disabled: boolean;
  value?: string;
  /**
   * Stable identity beyond (role, name): the chain of meaningful ancestor
   * `role:name` tuples up to the AX tree root (truncated to keep size
   * bounded). Click/type re-fetch the AX tree at action time and look up
   * elements by (role, name, containerPath) instead of by positional
   * index — that way mid-flight DOM mutation produces a clear "element
   * no longer present" rather than a silent click on the wrong node.
   */
  containerPath: string[];
}

export interface IframeInfo {
  targetId: string;
  url: string;
  title: string;
}

export interface SurveyResult {
  elements: SurveyElement[];
  count: number;
  iframeCount: number;
  iframes: IframeInfo[];
  url: string;
  title: string;
}

// ── CDP AX Node shape ────────────────────────────────────────────
// Chrome CDP Accessibility.AXNode — we type just the fields we use.

interface AXValue {
  value: string;
}

interface AXProperty {
  name: string;
  value: { value: boolean | string | number };
}

export interface AXNode {
  nodeId: string;
  role?: AXValue;
  name?: AXValue;
  ignored?: boolean;
  properties?: AXProperty[];
  value?: AXValue;
  parentId?: string;
  backendDOMNodeId?: number;
}

// ── Survey Cache ─────────────────────────────────────────────────

let cachedSurvey: SurveyResult | null = null;

/** Get the last survey result. Used by click/type to resolve element indices. */
export function getSurveyCache(): SurveyResult | null {
  return cachedSurvey;
}

/** Invalidate the survey cache. Called on navigation events. */
export function invalidateSurveyCache(): void {
  cachedSurvey = null;
}

// ── Cache invalidation on navigation ─────────────────────────────

let cacheListenerInstalled = false;
let watchedTabId: number | null = null;

function installCacheInvalidationListener(tabId: number): void {
  watchedTabId = tabId;

  if (cacheListenerInstalled) return;
  cacheListenerInstalled = true;

  chrome.tabs.onUpdated.addListener(
    (updatedTabId, changeInfo) => {
      if (updatedTabId === watchedTabId && changeInfo.url) {
        invalidateSurveyCache();
      }
    }
  );
}

// ── Helpers ──────────────────────────────────────────────────────

function getProperty(node: AXNode, propName: string): boolean {
  if (!node.properties) return false;
  const prop = node.properties.find((p) => p.name === propName);
  return prop ? Boolean(prop.value.value) : false;
}

/**
 * Truncate names so a deep ancestor chain doesn't blow up the cache.
 * 40 chars is enough to disambiguate landmarks ("Account settings",
 * "Search results", etc.) without dragging entire form labels along.
 */
const MAX_NAME_IN_PATH = 40;
const MAX_PATH_DEPTH = 6;

/**
 * Build a parent lookup once, then walk up to MAX_PATH_DEPTH meaningful
 * ancestors (skipping ignored / none / generic nodes). The path is the
 * stable-identity component used by click/type to re-resolve a survey
 * element after the DOM has mutated.
 */
export function buildParentMap(nodes: AXNode[]): Map<string, AXNode> {
  const byId = new Map<string, AXNode>();
  for (const n of nodes) byId.set(n.nodeId, n);
  return byId;
}

export function ancestorPath(node: AXNode, byId: Map<string, AXNode>): string[] {
  const path: string[] = [];
  let cursor: AXNode | undefined = node.parentId ? byId.get(node.parentId) : undefined;
  while (cursor && path.length < MAX_PATH_DEPTH) {
    const role = (cursor.role?.value || "").toLowerCase();
    if (role && role !== "none" && role !== "generic" && !cursor.ignored) {
      const rawName = cursor.name?.value || "";
      const name = rawName.length > MAX_NAME_IN_PATH
        ? rawName.slice(0, MAX_NAME_IN_PATH) + "…"
        : rawName;
      path.push(`${role}:${name}`);
    }
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return path;
}

/** Two paths are equal when every step matches. Length mismatch → not equal. */
export function pathsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ── Helpers: extract elements from AX nodes ─────────────────────

function extractElements(
  nodes: AXNode[],
  includeAll: boolean,
  startIndex: number,
  inIframe: boolean,
  frameId: string
): SurveyElement[] {
  const items: SurveyElement[] = [];
  const byId = buildParentMap(nodes);
  let index = startIndex;

  for (const node of nodes) {
    if (node.ignored) continue;

    const role = (node.role?.value || "").toLowerCase();

    // Skip non-interactive unless includeAll
    if (!includeAll && !INTERACTIVE_ROLES.has(role)) continue;

    // Skip nodes with generic/none roles even in includeAll mode
    if (role === "none" || role === "generic") continue;

    const name = node.name?.value || "";
    const focusable = getProperty(node, "focusable");
    const disabled = getProperty(node, "disabled");
    const value = node.value?.value;

    items.push({
      index,
      role,
      name,
      inIframe,
      frameId,
      focusable,
      disabled,
      value: value !== undefined ? value : undefined,
      containerPath: ancestorPath(node, byId),
    });

    index++;
  }

  return items;
}

// ── Survey Handler ───────────────────────────────────────────────

export async function handleSurvey(
  params: Record<string, unknown>,
  state: NavigationState
): Promise<SurveyResult> {
  if (state.automationTabId === null) {
    throw new Error("No active automation tab. Navigate to a page first.");
  }

  const tabId = state.automationTabId;
  const includeAll = params.includeAll === true;

  // Get tab info for url/title
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url || "";
  const title = tab.title || "";

  // Install cache invalidation listener for this tab
  installCacheInvalidationListener(tabId);

  // Get main frame elements via CDP
  const mainElements: SurveyElement[] = await withCDP(tabId, async (tid) => {
    const result = await chrome.debugger.sendCommand(
      { tabId: tid },
      "Accessibility.getFullAXTree"
    ) as { nodes?: AXNode[] };

    return extractElements(result?.nodes || [], includeAll, 0, false, "");
  });

  // Discover iframe targets
  const allElements: SurveyElement[] = [...mainElements];
  const iframes: IframeInfo[] = [];

  try {
    const targets = await chrome.debugger.getTargets();
    const iframeTargets = targets.filter(
      (t) =>
        t.type === "iframe" &&
        t.url !== "about:blank" &&
        t.tabId === tabId
    );

    for (const iframe of iframeTargets) {
      const iframeInfo: IframeInfo = {
        targetId: iframe.id,
        url: iframe.url,
        title: iframe.title,
      };
      iframes.push(iframeInfo);

      try {
        // Attach to the iframe target separately
        await chrome.debugger.attach({ targetId: iframe.id }, "1.3");

        try {
          const result = (await chrome.debugger.sendCommand(
            { targetId: iframe.id },
            "Accessibility.getFullAXTree"
          )) as { nodes?: AXNode[] };

          const iframeElements = extractElements(
            result?.nodes || [],
            includeAll,
            allElements.length,
            true,
            iframe.id
          );

          allElements.push(...iframeElements);
        } finally {
          try {
            await chrome.debugger.detach({ targetId: iframe.id });
          } catch {
            // Already detached
          }
        }
      } catch {
        // Could not attach to iframe — skip it silently
      }
    }
  } catch {
    // chrome.debugger.getTargets not available or failed — skip iframe discovery
  }

  const surveyResult: SurveyResult = {
    elements: allElements,
    count: allElements.length,
    iframeCount: iframes.length,
    iframes,
    url,
    title,
  };

  // Cache for click/type index resolution
  cachedSurvey = surveyResult;

  return surveyResult;
}
