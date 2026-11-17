/**
 * Unit tests for the navigation URL scheme allowlist.
 *
 * The big risk is page text or prompt-injected content turning into a
 * `javascript:` / `data:` / `file:` / `chrome:` URL that drives the
 * authenticated browser into a privileged context — these tests pin the
 * boundary explicitly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ensureUrl,
  DisallowedSchemeError,
} from "../../extension/src/commands/navigate.ts";

describe("ensureUrl — allowlist", () => {
  it("accepts plain https URLs unchanged", () => {
    assert.equal(ensureUrl("https://example.com"), "https://example.com");
  });

  it("accepts plain http URLs unchanged (localhost dev)", () => {
    assert.equal(ensureUrl("http://localhost:3000"), "http://localhost:3000");
  });

  it("accepts about:blank exactly", () => {
    assert.equal(ensureUrl("about:blank"), "about:blank");
    assert.equal(ensureUrl("ABOUT:BLANK"), "ABOUT:BLANK");
  });

  it("prepends https:// to a bare host", () => {
    assert.equal(ensureUrl("example.com"), "https://example.com");
    assert.equal(ensureUrl("example.com/path"), "https://example.com/path");
  });

  it("trims surrounding whitespace before scheme check", () => {
    assert.equal(ensureUrl("  https://example.com  "), "https://example.com");
  });
});

describe("ensureUrl — rejected schemes", () => {
  const dangerous = [
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "chrome://settings",
    "chrome-extension://abc/page.html",
    "view-source:https://example.com",
    "vbscript:msgbox(1)",
    "ftp://example.com",
    "ws://example.com",
  ];

  for (const url of dangerous) {
    it(`rejects ${url}`, () => {
      assert.throws(
        () => ensureUrl(url),
        (err: unknown) => err instanceof DisallowedSchemeError
      );
    });
  }

  it("rejects about:settings (only about:blank is special-cased)", () => {
    assert.throws(
      () => ensureUrl("about:settings"),
      (err: unknown) => err instanceof DisallowedSchemeError
    );
  });

  it("error message names the offending URL and explains the policy", () => {
    try {
      ensureUrl("javascript:alert(1)");
      assert.fail("expected throw");
    } catch (err) {
      assert.ok(err instanceof DisallowedSchemeError);
      assert.match(err.message, /javascript:/);
      assert.match(err.message, /Only http:\/\/, https:\/\//);
    }
  });
});
