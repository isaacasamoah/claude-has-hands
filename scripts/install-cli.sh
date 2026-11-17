#!/usr/bin/env bash
# install-cli.sh — install the chh CLI and per-tool symlinks into a bin dir.
#
# This is the engine-agnostic alternative to native MCP integration. After
# running this, Codex / Gemini / any shell-tool engine can drive the
# browser via plain `browser_navigate '{"url":"..."}'` style commands.
#
# Default install dir is $HOME/.local/bin. Override with CHH_BIN_DIR.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$PROJECT_ROOT/bin/chh"
DEST_DIR="${CHH_BIN_DIR:-$HOME/.local/bin}"

if [ ! -x "$SRC" ]; then
  echo "ERROR: $SRC not found or not executable. Run from a checked-out repo." >&2
  exit 1
fi

mkdir -p "$DEST_DIR"

# Main wrapper.
ln -sf "$SRC" "$DEST_DIR/chh"
echo "linked: $DEST_DIR/chh -> $SRC"

# Per-tool symlinks. The tool list is generated dynamically from the
# REST surface so it stays in lockstep with BrowserToolRegistry — but
# requires the host to be running. If it isn't, fall back to a static
# hard-coded list (kept in sync with native-host/src/tool-registry.ts).
TOOLS=""
DEFAULT_BRIDGE_JSON="${CHH_BRIDGE_JSON:-$HOME/.claude/claude-has-hands/bridge.json}"
DEFAULT_TOKEN_FILE="${CHH_BRIDGE_TOKEN_FILE:-$HOME/.claude/claude-has-hands/bridge.token}"

if [ -r "$DEFAULT_BRIDGE_JSON" ] && [ -r "$DEFAULT_TOKEN_FILE" ] && command -v curl >/dev/null && command -v python3 >/dev/null; then
  URL="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["url"])' "$DEFAULT_BRIDGE_JSON" 2>/dev/null || true)"
  TOKEN="$(tr -d '\n' < "$DEFAULT_TOKEN_FILE")"
  if [ -n "$URL" ] && [ -n "$TOKEN" ]; then
    TOOLS="$(curl -sS -H "Authorization: Bearer ${TOKEN}" "${URL}/v1/tools" 2>/dev/null \
      | python3 -c 'import json,sys
try:
  data = json.load(sys.stdin)
  for t in data.get("tools", []): print(t["name"])
except Exception:
  pass' || true)"
  fi
fi

if [ -z "$TOOLS" ]; then
  TOOLS="browser_status
browser_navigate
browser_back
browser_forward
browser_survey
browser_click
browser_type
browser_read
browser_scroll
browser_keypress
browser_screenshot
browser_observe
browser_tabs
browser_wait"
fi

while IFS= read -r tool; do
  [ -z "$tool" ] && continue
  ln -sf "$SRC" "$DEST_DIR/$tool"
  echo "linked: $DEST_DIR/$tool -> $SRC"
done <<< "$TOOLS"

cat <<EOF

Done. Confirm $DEST_DIR is on your PATH:
  echo \$PATH | tr ':' '\n' | grep -F "$DEST_DIR"

Try it out (host must be running):
  chh status
  chh tools
  browser_navigate '{"url":"https://example.com"}'

Engine integration:
  Codex / Gemini / any shell engine: expose chh and browser_* as
  shell tools. The engine runs the binaries; the bridge handles auth
  and the actual Chrome interaction.
EOF
