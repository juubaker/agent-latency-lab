#!/usr/bin/env bash
# Builds the Agent Latency Lab web UI and stages a file://-compatible copy
# into desktop/media/. Electron loads this via win.loadFile() with no
# server involved — the UI's simulated-workload and paste-your-trace modes
# have zero network dependency, so this works fully offline.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$REPO_ROOT/desktop"
MEDIA_DIR="$APP_DIR/media"

echo "→ Building Lab UI (vite build)…"
(cd "$REPO_ROOT" && npm run build)

echo "→ Staging dist/ into desktop/media/ (preserving icons)…"
mkdir -p "$MEDIA_DIR"
find "$MEDIA_DIR" -mindepth 1 \
  -not -name "icon.png" -not -name "icon.svg" \
  -not -name "icon.icns" -not -name "icon.ico" \
  -exec rm -rf {} +
cp -r "$REPO_ROOT/dist/"* "$MEDIA_DIR/"

echo "→ Rewriting absolute asset paths for file:// loading…"
# Vite's default build emits <script src="/assets/...">, an absolute path
# that resolves fine under http:// but breaks under file://, which Electron
# uses via loadFile(). Rewriting to a relative "./assets/..." path is the
# same fix already proven for the VS Code webview's file:// constraints.
sed -i.bak 's#/assets/#./assets/#g' "$MEDIA_DIR/index.html"

echo "→ Injecting a strict Content-Security-Policy…"
# The app has zero network dependency (simulated workload + paste-your-trace
# are pure client-side logic), so it can run under a genuinely strict CSP —
# same posture used for the VS Code extension's webview. connect-src 'none'
# means the live-alert-feed fetch (present in the shared UI bundle for the
# web/server-connected deployment) fails silently here, exactly as designed.
CSP="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'none'"
sed -i.bak "s#<head>#<head>\n    <meta http-equiv=\"Content-Security-Policy\" content=\"$CSP\">#" "$MEDIA_DIR/index.html"
rm -f "$MEDIA_DIR/index.html.bak"

echo "✓ Ready. Run locally with: npm start   ·   Package with: npm run dist:mac (or dist:win / dist:linux)"
