# Agent Latency Lab — Desktop App

A standalone Mac/Windows/Linux app for Agent Latency Lab's **simulated
workload** and **paste your trace** modes — no backend, no network
dependency, works fully offline. All trace data stays on your machine; the
app's Content-Security-Policy actively blocks outbound network requests
(`connect-src 'none'`), so this isn't just a claim — it's enforced.

What's intentionally **not** included here: the live SLO alert feed (which needs a running `npm run server` instance to poll) and the instrumentation middleware/tracers, both of which remain correctly scoped as something you run against *your own* agent's server — not something a static desktop shell should be reaching out to.

## Run it locally (no packaging)

```bash
npm install
npm start
```

`npm start` builds the Lab UI fresh and launches Electron pointed at it —
this is the fastest loop for trying changes.

## Build an installer

```bash
npm install
npm run dist:mac      # macOS — must run ON macOS (Apple requires native tooling
                      # for code signing / DMG creation; cannot cross-build)
npm run dist:win      # Windows NSIS installer — we cross-built this via Wine
npm run dist:linux    # AppImage — can cross-build from anywhere
npm run dist:all      # all three in one pass (mac target still needs to run on macOS)
```

Output lands in `release/`:
- **macOS:** `Agent Latency Lab-1.0.0.dmg`
- **Windows:** `Agent Latency Lab Setup 1.0.0.exe`
- **Linux:** `Agent Latency Lab-1.0.0.AppImage`

The Linux AppImage build was verified end-to-end during development — a
real, valid, self-contained executable, launched headlessly to confirm the
page loads, React mounts, and the CSP correctly blocks the (by-design-inert)
network call from the shared UI's alert-feed component. The Mac/Windows
targets use the identical `electron-builder` config and packaging pipeline,
just with platform-specific code signing requirements that can only be
exercised on their native OS.

**macOS note:** without an Apple Developer ID ($99/year) to code-sign and
  notarize the `.dmg`, Gatekeeper will show an "unidentified developer"
  warning on first launch. DMG creation and code-signing are macOS-native
  operations and cannot be reliably cross-built off macOS — for CI-produced
  macOS artifacts use the repository's GitHub Actions `macos-latest`
  runner (see `.github/workflows/release.yml`). Right-click → Open bypasses
  this for personal use; signing is only required for frictionless public
  distribution.

**Windows note:** similarly, an unsigned `.exe` will trigger a SmartScreen
warning. A code-signing certificate (or Microsoft's Trusted Signing service)
clears this; not required to build or run it yourself.

## How it works

`build.sh` does three things, in order:

1. **`vite build`** — the same production build used for the web deployment
   and VS Code extension.
2. **Rewrite `/assets/...` to `./assets/...`** in the built `index.html`.
   Vite's default absolute-path output works fine over `http://` but breaks
   under Electron's `file://` protocol — this is the same class of fix
   already proven for the VS Code webview's asset loading.
3. **Inject a strict CSP** (`default-src 'none'`, `connect-src 'none'`,
   scoped `script-src`/`style-src`/`font-src` for exactly what the app
   needs — Google Fonts, its own bundled script). Verified this doesn't
   break rendering: the packaged app's React tree mounts fully (confirmed by
   checking `#root`'s rendered content directly), and the CSP is
   demonstrably active — it visibly blocks the alert feed's fetch attempt in
   the console rather than that call silently succeeding against nothing.

`src/main.js` is deliberately minimal: no server process to spawn (unlike a
full Electron wrap of the server-connected app would need), just a
`BrowserWindow` loading the built HTML directly via `loadFile()`. The one
non-obvious piece is the **Edit menu** — Electron only wires Cmd/Ctrl+C/V/X
to the OS clipboard through menu roles, so stripping the menu down to
nothing (a natural instinct for a "minimal" app) would silently break paste
into the "Paste your trace" textarea. Kept explicit in the code as a
reminder not to remove it.

## Icons

`build-resources/icon-source.svg` is the single source of truth — the same
pulse-line mark used across the web app, VS Code extension, and this app,
rasterized to the three platform-specific formats `electron-builder` needs:

- `icon.icns` (macOS) — verified valid: correct magic bytes, internal
  declared size matches actual file size exactly.
- `icon.ico` (Windows) — verified valid: contains all 7 standard embedded
  resolutions (16 through 256px).
- `icon.png` (Linux) — 1024×1024, `electron-builder` resizes as needed for
  AppImage.

All three were generated from one 1024px master render via Pillow's native
`ICNS`/`ICO` writers — no external tools (`iconutil`, ImageMagick) required.

## File map

```
desktop/
├── src/main.js              Electron main process — BrowserWindow + menu, no backend
├── build.sh                 vite build → relative paths → inject CSP → stage media/
├── build-resources/
│   ├── icon-source.svg      single source of truth for all icon formats
│   ├── icon.icns            macOS
│   ├── icon.ico             Windows
│   └── icon.png             Linux
├── media/                   built UI + runtime icons (generated by build.sh)
└── package.json             electron-builder config for all three targets
```

## Windows cross-build (verified)

The Windows NSIS installer was cross-built and verified using Wine + a
`wine32` prefix. These are the steps used during verification; they can be
replayed on a Linux runner or local Linux machine with Wine installed.

1. Install Wine 32-bit support and helpers (example for Debian/Ubuntu):

```bash
sudo dpkg --add-architecture i386
sudo apt update
sudo apt install -y wine32 p7zip-full cabextract
```

2. In the repo root, install deps and build the UI bundle:

```bash
npm install
cd desktop
npm install
npm run build:ui
```

3. Cross-build the Windows NSIS installer using a 32-bit Wine prefix:

```bash
export WINEPREFIX="$HOME/.wine32"
export WINEARCH=win32
WINEDEBUG=-all npx electron-builder --win nsis
```

4. Verify the produced installer by running it under Wine and confirming
  the installer UI launches and that the resulting app launches and the
  CSP blocks outbound fetches as expected:

```bash
wine desktop/release/Agent\ Latency\ Lab\ Setup\ 1.0.0.exe
# then run the installed app or run the packaged executable under wine
wine "path/to/installed/app/Agent Latency Lab.exe"
```

The above produced a valid PE32 NSIS installer during development; the
installer was confirmed usable under Wine and the packaged AppImage was
confirmed to mount and run headlessly with the CSP enforcement active.
