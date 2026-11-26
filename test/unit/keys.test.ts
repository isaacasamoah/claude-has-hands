import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keyPressEvents } from "../../extension/src/lib/keys.ts";

describe("keyPressEvents", () => {
  it("sends Enter with a carriage return so it can submit a form", () => {
    const [down, up] = keyPressEvents("Enter", []);
    assert.deepEqual(down, {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      modifiers: 0,
      text: "\r",
      unmodifiedText: "\r",
    });
    assert.equal(up.type, "keyUp");
    assert.equal(up.text, undefined);
  });

  it("gives digits a Digit code, not a Key code", () => {
    const [down] = keyPressEvents("7", []);
    assert.equal(down.code, "Digit7");
    assert.equal(down.windowsVirtualKeyCode, 55);
    assert.equal(down.text, "7");
  });

  it("gives letters a Key code and the uppercase virtual key", () => {
    const [down] = keyPressEvents("a", []);
    assert.equal(down.code, "KeyA");
    assert.equal(down.windowsVirtualKeyCode, 65);
    assert.equal(down.text, "a");
  });

  it("sends non-printing keys as rawKeyDown without text", () => {
    const [down] = keyPressEvents("Escape", []);
    assert.equal(down.type, "rawKeyDown");
    assert.equal(down.windowsVirtualKeyCode, 27);
    assert.equal(down.text, undefined);
  });

  it("encodes modifiers as the CDP bitmask on both events", () => {
    const [down, up] = keyPressEvents("Tab", ["alt", "ctrl", "meta", "shift"]);
    assert.equal(down.modifiers, 15);
    assert.equal(up.modifiers, 15);
  });

  it("does not type the character of a ctrl shortcut", () => {
    const [down] = keyPressEvents("a", ["ctrl"]);
    assert.equal(down.type, "rawKeyDown");
    assert.equal(down.modifiers, 2);
    assert.equal(down.text, undefined);
  });

  it("still types the character when only shift is held", () => {
    const [down] = keyPressEvents("!", ["shift"]);
    assert.equal(down.code, "Digit1");
    assert.equal(down.text, "!");
  });

  it("rejects an unknown key name", () => {
    assert.throws(() => keyPressEvents("Enterr", []), /Unknown key: "Enterr"/);
  });

  it("rejects an unknown modifier", () => {
    assert.throws(() => keyPressEvents("a", ["hyper"]), /Unknown modifier: "hyper"/);
  });
});
