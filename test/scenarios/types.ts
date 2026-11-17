/**
 * Declarative test scenario types for claude-has-hands.
 *
 * These define test steps and assertions that Claude Code executes
 * during manual verification. They are NOT automated test runners —
 * Claude reads the scenario, calls the MCP tools in order, and
 * checks the assertions against the results.
 */

export interface TestStep {
  /** MCP tool name (e.g. "browser_navigate", "browser_click") */
  tool: string;
  /** Parameters to pass to the tool */
  params: Record<string, unknown>;
  /** Human-readable description of what this step does */
  description: string;
}

export interface TestAssertion {
  /** Dot-path into the step result to check (e.g. "title", "elements.length") */
  field: string;
  /** Comparison operator */
  operator: "equals" | "contains" | "truthy" | "gt" | "falsy";
  /** Expected value for equals/contains/gt; ignored for truthy/falsy */
  value: unknown;
}

export interface TestScenario {
  /** Unique scenario identifier (e.g. "smoke-e2e") */
  id: string;
  /** Human-readable name */
  name: string;
  /** What this scenario verifies */
  description: string;
  /** Ordered list of tool invocations */
  steps: TestStep[];
  /** Assertions checked after all steps complete */
  assertions: TestAssertion[];
}
