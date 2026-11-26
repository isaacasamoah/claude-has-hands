interface KeyDefinition {
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED_KEYS: Record<string, KeyDefinition> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  Insert: { code: "Insert", keyCode: 45 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  Shift: { code: "ShiftLeft", keyCode: 16 },
  Control: { code: "ControlLeft", keyCode: 17 },
  Alt: { code: "AltLeft", keyCode: 18 },
  Meta: { code: "MetaLeft", keyCode: 91 },
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, { code: `F${i + 1}`, keyCode: 112 + i }])
  ),
};

const US_PUNCTUATION: Record<string, { code: string; keyCode: number }> = {
  " ": { code: "Space", keyCode: 32 },
  "-": { code: "Minus", keyCode: 189 },
  _: { code: "Minus", keyCode: 189 },
  "=": { code: "Equal", keyCode: 187 },
  "+": { code: "Equal", keyCode: 187 },
  "[": { code: "BracketLeft", keyCode: 219 },
  "{": { code: "BracketLeft", keyCode: 219 },
  "]": { code: "BracketRight", keyCode: 221 },
  "}": { code: "BracketRight", keyCode: 221 },
  "\\": { code: "Backslash", keyCode: 220 },
  "|": { code: "Backslash", keyCode: 220 },
  ";": { code: "Semicolon", keyCode: 186 },
  ":": { code: "Semicolon", keyCode: 186 },
  "'": { code: "Quote", keyCode: 222 },
  '"': { code: "Quote", keyCode: 222 },
  ",": { code: "Comma", keyCode: 188 },
  "<": { code: "Comma", keyCode: 188 },
  ".": { code: "Period", keyCode: 190 },
  ">": { code: "Period", keyCode: 190 },
  "/": { code: "Slash", keyCode: 191 },
  "?": { code: "Slash", keyCode: 191 },
  "`": { code: "Backquote", keyCode: 192 },
  "~": { code: "Backquote", keyCode: 192 },
};

const US_SHIFTED_DIGITS = ")!@#$%^&*(";

function singleCharacter(char: string): KeyDefinition {
  if (/^[a-z]$/i.test(char)) {
    const upper = char.toUpperCase();
    return { code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: char };
  }
  const digit = /^[0-9]$/.test(char) ? Number(char) : US_SHIFTED_DIGITS.indexOf(char);
  if (digit >= 0) return { code: `Digit${digit}`, keyCode: 48 + digit, text: char };
  const punctuation = US_PUNCTUATION[char];
  if (punctuation) return { ...punctuation, text: char };
  return { code: "", keyCode: 0, text: char };
}

const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  command: 4,
  shift: 8,
};

export interface KeyEventParams {
  type: "keyDown" | "rawKeyDown" | "keyUp";
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode: number;
  modifiers: number;
  text?: string;
  unmodifiedText?: string;
}

/**
 * A keyDown that carries `text` also fires keypress and inserts the text, so
 * no separate `char` event is sent.
 */
export function keyPressEvents(key: string, modifierNames: string[]): [KeyEventParams, KeyEventParams] {
  let modifiers = 0;
  for (const name of modifierNames) {
    const bit = MODIFIER_BITS[name.toLowerCase()];
    if (bit === undefined) {
      throw new Error(`Unknown modifier: "${name}". Use "ctrl", "shift", "alt" or "meta".`);
    }
    modifiers |= bit;
  }

  const definition = NAMED_KEYS[key] ?? ([...key].length === 1 ? singleCharacter(key) : undefined);
  if (!definition) {
    throw new Error(
      `Unknown key: "${key}". Use a single character or one of: ${Object.keys(NAMED_KEYS).join(", ")}.`
    );
  }

  const isShortcut = (modifiers & ~MODIFIER_BITS.shift) !== 0;
  const text = isShortcut ? undefined : definition.text;
  const base = {
    key,
    code: definition.code,
    windowsVirtualKeyCode: definition.keyCode,
    nativeVirtualKeyCode: definition.keyCode,
    modifiers,
  };
  return [
    text === undefined ? { type: "rawKeyDown", ...base } : { type: "keyDown", ...base, text, unmodifiedText: text },
    { type: "keyUp", ...base },
  ];
}
