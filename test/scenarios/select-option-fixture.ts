/**
 * Select-option fixture scenario — Section 6 test 6.
 *
 * Drives the local fixture page end-to-end through every variation of
 * <select> + ARIA combobox + multi-select that browser_select_option claims
 * to support, plus the <option>-inside-closed-<select> diagnostic on
 * browser_click.
 *
 * This scenario runs entirely against file:// — no network needed.
 */

import { TestScenario } from "./types.js";

const FIXTURE_BASE = "file://${PROJECT_ROOT}/test/fixture.html";

export const selectOptionFixture: TestScenario = {
  id: "select-option-fixture",
  name: "browser_select_option — fixture coverage",
  description:
    "Verifies browser_select_option across native <select> (selector + index), " +
    "ARIA combobox (portal-rendered), <select multiple>, and the diagnostic " +
    "hint when browser_click is called on an <option> inside a closed <select>.",
  steps: [
    // 0: Navigate
    {
      tool: "browser_navigate",
      params: { url: FIXTURE_BASE },
      description: "Open the local fixture page.",
    },
    // 1: Survey so we have indices for the combobox
    {
      tool: "browser_survey",
      params: {},
      description: "Survey to populate the index cache.",
    },
    // 2: Native <select> via CSS selector + label
    {
      tool: "browser_select_option",
      params: { selector: "#select-color", label: "Blue" },
      description:
        "Select 'Blue' in the colour <select> via CSS selector + label.",
    },
    // 3: Native <select> via CSS selector + value
    {
      tool: "browser_select_option",
      params: { selector: "#select-project", value: "project-b" },
      description:
        "Select '8 Kirra' in the project <select> via CSS selector + value.",
    },
    // 4: Multi-select via array of values
    {
      tool: "browser_select_option",
      params: { selector: "#select-multi", value: ["a", "c"] },
      description:
        "Select two options simultaneously in <select multiple> via value array.",
    },
    // 5: ARIA combobox via roleName + label (must open + click)
    {
      tool: "browser_select_option",
      params: {
        roleName: "combobox:Select a mode...",
        label: "Log only — Mark done, never dial",
      },
      description:
        "Select 'Log only' in the portal-rendered ARIA combobox via roleName + label.",
    },
    // 6: Demonstrate the click diagnostic — survey first, then try clicking
    //    an <option> inside the closed <select>. Should return success WITH a hint.
    {
      tool: "browser_survey",
      params: {},
      description: "Re-survey after the changes above.",
    },
    // 7: Try the broken pattern — click an <option> inside a closed <select>
    {
      tool: "browser_click",
      params: { selector: "#select-color > option[value='red']" },
      description:
        "Click an <option> inside the closed colour <select> — should succeed " +
        "but return a hint pointing at browser_select_option.",
    },
  ],
  assertions: [
    // After step 1: survey returned elements
    {
      field: "steps[1].elements.length",
      operator: "gt",
      value: 5,
    },
    // After step 2: selected.label === "Blue"
    {
      field: "steps[2].selected.label",
      operator: "equals",
      value: "Blue",
    },
    // After step 3: selected.value === "project-b"
    {
      field: "steps[3].selected.value",
      operator: "equals",
      value: "project-b",
    },
    // After step 4: multi-select returned an array of two values
    {
      field: "steps[4].mode",
      operator: "equals",
      value: "react-setter-multi",
    },
    // After step 5: ARIA combobox path used
    {
      field: "steps[5].mode",
      operator: "equals",
      value: "aria-click",
    },
    // After step 7: hint surfaced
    {
      field: "steps[7].hint",
      operator: "contains",
      value: "browser_select_option",
    },
  ],
};
