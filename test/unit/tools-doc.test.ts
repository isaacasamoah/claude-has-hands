import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { renderToolsDoc } from "../../scripts/generate-tools-doc.ts";

test("docs/tools.md matches the tool registry (run `npm run docs:tools`)", () => {
  const committed = fs.readFileSync(
    new URL("../../docs/tools.md", import.meta.url),
    "utf-8"
  );
  assert.equal(committed, renderToolsDoc());
});
