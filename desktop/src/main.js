const { app, BrowserWindow, Menu, shell } = require("electron");
const path = require("node:path");

const isMac = process.platform === "darwin";

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    // matches the Lab's own dark background — avoids a white flash before
    // the page paints, which reads as broken on first launch
    backgroundColor: "#10141F",
    title: "Agent Latency Lab",
    icon: path.join(__dirname, "..", "media", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, "..", "media", "index.html"));

  // external links (e.g. a GitHub link in the UI, if ever added) open in the
  // system browser rather than navigating the app window away from the Lab
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  return win;
}

/**
 * A minimal menu. The Edit entries are NOT decorative — Electron wires
 * Cmd/Ctrl+C/V/X/A to the OS clipboard via these menu roles. Without an Edit
 * menu present, paste (Cmd+V) into the "Paste your trace" textarea silently
 * does nothing on macOS. This bit us once already in the VS Code extension
 * work; keeping it explicit here so it doesn't happen again.
 */
function buildMenu() {
  const template = [
    ...(isMac ? [{
      label: app.getName(),
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    }] : []),
    {
      label: "File",
      submenu: [isMac ? { role: "close" } : { role: "quit" }],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  return Menu.buildFromTemplate(template);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(buildMenu());
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (!isMac) app.quit();
});
