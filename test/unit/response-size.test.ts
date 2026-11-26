import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fitResponse, MAX_MESSAGE_BYTES } from "../../extension/src/lib/response-size.ts";

describe("fitResponse", () => {
  it("passes a multibyte response that fits through unchanged", () => {
    const response = { id: "1", success: true, result: { text: "café ✓ 😀" } };
    assert.equal(fitResponse(response), response);
  });

  it("refuses a response that fits in UTF-16 units but not in UTF-8 bytes", () => {
    const text = "é".repeat(600_000);
    assert.ok(text.length < MAX_MESSAGE_BYTES);
    const fitted = fitResponse({ id: "1", success: true, result: { text } });
    assert.equal(fitted.id, "1");
    assert.equal(fitted.success, false);
    assert.match(fitted.error ?? "", /Response too large \(1200\d{3} bytes\)/);
  });
});
