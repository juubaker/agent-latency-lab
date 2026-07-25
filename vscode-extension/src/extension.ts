import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

let activePanel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
  const open = vscode.commands.registerCommand("agentLatencyLab.open", () => {
    openLab(context);
  });

  const openWithSelection = vscode.commands.registerCommand(
    "agentLatencyLab.openWithSelection",
    () => {
      const editor = vscode.window.activeTextEditor;
      const text = editor && !editor.selection.isEmpty
        ? editor.document.getText(editor.selection)
        : undefined;
      if (!text) {
        vscode.window.showWarningMessage("Agent Latency Lab: select a trace (line or JSON format) first.");
        return;
      }
      openLab(context, text);
    }
  );

  const openWithClipboard = vscode.commands.registerCommand(
    "agentLatencyLab.openWithClipboard",
    async () => {
      const text = await vscode.env.clipboard.readText();
      if (!text.trim()) {
        vscode.window.showWarningMessage("Agent Latency Lab: clipboard is empty.");
        return;
      }
      openLab(context, text);
    }
  );

  context.subscriptions.push(open, openWithSelection, openWithClipboard);
}

function openLab(context: vscode.ExtensionContext, initialTrace?: string) {
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, "media");

  if (activePanel) {
    activePanel.reveal(vscode.ViewColumn.Active);
    if (initialTrace) postTrace(activePanel, initialTrace);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "agentLatencyLab",
    "Agent Latency Lab",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true, // keep sim state when the tab loses focus
      localResourceRoots: [mediaRoot],
    }
  );
  panel.iconPath = vscode.Uri.joinPath(mediaRoot, "icon.svg");

  panel.webview.html = buildHtml(panel.webview, mediaRoot);
  activePanel = panel;

  panel.onDidDispose(() => { activePanel = undefined; });

  // Once the webview signals it has mounted, deliver any trace we were asked
  // to open with (selection/clipboard). Avoids a race where postMessage
  // fires before the React app has registered its message listener.
  const sub = panel.webview.onDidReceiveMessage((msg) => {
    if (msg?.type === "ready" && initialTrace) {
      postTrace(panel, initialTrace);
    }
  });
  context.subscriptions.push(sub);
}

function postTrace(panel: vscode.WebviewPanel, trace: string) {
  panel.webview.postMessage({ type: "loadTrace", trace });
}

/**
 * Reads the built dist/index.html (copied into media/ at packaging time),
 * rewrites its asset reference to a webview-safe URI, and injects a strict
 * CSP. The React app pulls Google Fonts via an in-component <style>@import;
 * that's allowed explicitly below rather than disabling CSP altogether.
 */
function buildHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
  const indexPath = vscode.Uri.joinPath(mediaRoot, "index.html");
  let html: string;
  try {
    html = fs.readFileSync(indexPath.fsPath, "utf8");
  } catch {
    return errorHtml(
      "Build output not found in media/. Run `npm run build` in the project root, " +
      "then copy dist/* into vscode-extension/media/ (see vscode-extension/README.md)."
    );
  }

  const nonce = crypto.randomBytes(16).toString("base64");
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src https://fonts.gstatic.com`,
    `script-src 'nonce-${nonce}'`,
    // The Lab's live alert feed does a same-origin fetch("/debug/alerts") when
    // run as a normal web app talking to a local dev server. Inside a webview
    // there's no such server reachable at a relative path, so this simply
    // fails fast and the feed stays hidden — matching its designed
    // "no server, stay invisible" fallback. No network access is granted here.
    `connect-src 'none'`,
  ].join("; ");

  // Rewrite the built bundle's absolute /assets/... reference to a webview URI,
  // and tag the injected <script type="module"> with our nonce so it's allowed
  // to run under the CSP above.
  const assetsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "assets"));
  html = html.replace(/\/assets\//g, `${assetsUri.toString()}/`);
  html = html.replace(
    /<script /,
    `<script nonce="${nonce}" `
  );
  html = html.replace(
    "<head>",
    `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`
  );

  // Bridge script: forwards trace payloads from the extension host into the
  // page via a CustomEvent the React app listens for (see media/bridge note
  // in README — AgentLatencyLab.jsx reads `window.__initialTrace` on mount
  // when present, and also listens for postMessage-driven updates).
  const bridge = `
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg && msg.type === 'loadTrace') {
          window.dispatchEvent(new CustomEvent('agent-latency-lab:load-trace', { detail: msg.trace }));
        }
      });
      window.addEventListener('DOMContentLoaded', () => vscode.postMessage({ type: 'ready' }));
    </script>
  `;
  html = html.replace("</body>", `${bridge}\n</body>`);

  return html;
}

function errorHtml(message: string): string {
  return `<!doctype html><html><body style="font-family: sans-serif; background:#10141F; color:#E8ECF6; padding: 2rem;">
    <h2>Agent Latency Lab</h2>
    <p>${message}</p>
  </body></html>`;
}

export function deactivate() {}
