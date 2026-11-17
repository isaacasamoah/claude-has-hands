#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "=== Claude Has Hands — Dev Mode ==="
echo "Watching for file changes. Press Ctrl+C to stop."
echo ""

node esbuild.config.mjs --watch
