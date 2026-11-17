/**
 * Smoke test scenario — Section 10.1 end-to-end verification.
 *
 * Claude Code reads this scenario and executes each step via
 * the MCP tools, then checks assertions against the results.
 *
 * Prerequisites:
 * - Extension loaded in Chrome
 * - Native host + MCP server running
 * - Test fixture served (e.g. file:// or localhost)
 */

import { TestScenario } from "./types.js";

/**
 * Base URL for test fixtures.
 * When running locally, point this at the fixture file.
 * The installer prints the correct path.
 */
const FIXTURE_BASE = "file://${PROJECT_ROOT}/test/fixture.html";

export const smokeTest: TestScenario = {
  id: "smoke-e2e",
  name: "End-to-end smoke test",
  description:
    "Verifies the full chain: navigate, survey, click, type, read, screenshot, and back. " +
    "Maps to spec Section 10.1 acceptance criteria.",
  steps: [
    // Step 1: Navigate to fixture
    {
      tool: "browser_navigate",
      params: { url: FIXTURE_BASE },
      description: "Navigate to the test fixture page",
    },
    // Step 2: Survey the page
    {
      tool: "browser_survey",
      params: {},
      description:
        "Survey interactive elements — expect buttons, inputs, links, selects, checkboxes",
    },
    // Step 3: Click a button
    {
      tool: "browser_click",
      params: { roleName: "button:Primary Action" },
      description:
        "Click the Primary Action button — status bar should update",
    },
    // Step 4: Type into a text field
    {
      tool: "browser_type",
      params: { selector: "#input-email", text: "test@example.com" },
      description:
        "Type an email into the login form email field",
    },
    // Step 5: Read content
    {
      tool: "browser_read",
      params: { selector: "#read-target" },
      description:
        "Read text from the read-target block — expect formatted text, link, code snippet, list items",
    },
    // Step 6: Screenshot
    {
      tool: "browser_screenshot",
      params: { quality: 30 },
      description:
        "Capture a screenshot — expect base64 JPEG image in response",
    },
    // Step 7: Navigate to page 2 then back
    {
      tool: "browser_navigate",
      params: { url: FIXTURE_BASE.replace("fixture.html", "fixture-page2.html") },
      description: "Navigate to test page 2",
    },
    {
      tool: "browser_back",
      params: {},
      description:
        "Navigate back — should return to the main fixture page",
    },
  ],
  assertions: [
    // After step 1: page title matches
    {
      field: "steps[0].title",
      operator: "contains",
      value: "Test Fixture",
    },
    // After step 2: survey returns interactive elements
    {
      field: "steps[1].elements.length",
      operator: "gt",
      value: 10,
    },
    // After step 3: click succeeded
    {
      field: "steps[2].clicked",
      operator: "truthy",
      value: null,
    },
    // After step 5: read text contains expected content
    {
      field: "steps[4].text",
      operator: "contains",
      value: "read target",
    },
    // After step 6: screenshot returned image data
    {
      field: "steps[5].image",
      operator: "truthy",
      value: null,
    },
    // After step 8 (back): returned to fixture
    {
      field: "steps[7].title",
      operator: "contains",
      value: "Test Fixture",
    },
  ],
};
