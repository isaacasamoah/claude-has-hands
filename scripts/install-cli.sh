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

# Per-tool symlinks. docs/tools.md is generated from the tool registry and a
# unit test keeps it in sync, so it lists every tool without a running host.
TOOLS="$(grep -oE '^\| `browser_[a-z_]+`' "$PROJECT_ROOT/docs/tools.md" | tr -d '|` ')"
if [ -z "$TOOLS" ]; then
  echo "ERROR: no tools found in $PROJECT_ROOT/docs/tools.md" >&2
  exit 1
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
