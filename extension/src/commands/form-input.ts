/**
 * form_input command — fill multiple form fields in one round trip.
 *
 * Each field targets an element by CSS selector and sets its value according to
 * the field kind (auto-detected from the element, overridable):
 *   - text     → focus, select-all, insertText (works with React-controlled
 *                inputs, same approach as browser_type)
 *   - select   → set value and dispatch input/change
 *   - checkbox → set checked from a truthy value and dispatch input/change
 *   - radio    → check the targeted radio and dispatch input/change
 *
 * All fields are applied in a single executeScript call so a multi-field form
 * costs one native round trip.
 */

import type { NavigationState } from "./navigate.js";

export interface FormField {
  selector: string;
  value: string | boolean | number;
  kind?: "text" | "select" | "checkbox" | "radio";
}

export interface FormInputFieldResult {
  selector: string;
  ok: boolean;
  kind?: string;
  error?: string;
}

export interface FormInputResult {
  results: FormInputFieldResult[];
  filled: number;
  total: number;
}

export async function handleFormInput(
  params: Record<string, unknown>,
  state: NavigationState
): Promise<FormInputResult> {
  if (state.automationTabId === null) {
    throw new Error("No active automation tab. Navigate to a page first.");
  }

  const fieldsRaw = params.fields;
  if (!Array.isArray(fieldsRaw) || fieldsRaw.length === 0) {
    throw new Error("fields parameter is required (a non-empty array).");
  }
  const fields = fieldsRaw as FormField[];
  const tabId = state.automationTabId;

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (items: FormField[]) => {
      const out: FormInputFieldResult[] = [];

      for (const f of items) {
        try {
          const el = document.querySelector(f.selector) as
            | (HTMLElement & {
                value?: string;
                checked?: boolean;
                type?: string;
                select?: () => void;
              })
            | null;
          if (!el) {
            out.push({ selector: f.selector, ok: false, error: "element not found" });
            continue;
          }

          const tag = el.tagName.toLowerCase();
          const inputType = (el.type || "").toLowerCase();
          let kind = f.kind;
          if (!kind) {
            if (tag === "select") kind = "select";
            else if (inputType === "checkbox") kind = "checkbox";
            else if (inputType === "radio") kind = "radio";
            else kind = "text";
          }

          const fire = () => {
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          };

          if (kind === "checkbox") {
            el.checked = Boolean(f.value);
            fire();
          } else if (kind === "radio") {
            el.checked = true;
            fire();
          } else if (kind === "select") {
            el.value = String(f.value);
            fire();
          } else {
            el.focus();
            if (typeof el.select === "function") el.select();
            else document.execCommand("selectAll");
            document.execCommand("insertText", false, String(f.value));
          }

          out.push({ selector: f.selector, ok: true, kind });
        } catch (e) {
          out.push({
            selector: f.selector,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      return out;
    },
    args: [fields],
  });

  const fieldResults = (results?.[0]?.result as FormInputFieldResult[]) ?? [];
  const filled = fieldResults.filter((r) => r.ok).length;
  return { results: fieldResults, filled, total: fields.length };
}
