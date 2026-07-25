#!/usr/bin/env bash
# Builds the Agent Latency Lab web UI and stages it into vscode-extension/media/,
# preserving media/icon.svg. Run from the vscode-extension/ directory or repo root.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$REPO_ROOT/vscode-extension"

echo "→ Building Lab UI (vite build)…"
(cd "$REPO_ROOT" && npm run build)

echo "→ Staging dist/ into vscode-extension/media/…"
mkdir -p "$EXT_DIR/media"
find "$EXT_DIR/media" -mindepth 1 -not -name "icon.svg" -not -name "icon.png" -exec rm -rf {} +
cp -r "$REPO_ROOT/dist/"* "$EXT_DIR/media/"

echo "→ Compiling extension host TypeScript…"
(cd "$EXT_DIR" && npm run compile)

echo "✓ Ready. Package with: cd vscode-extension && npm run package"
