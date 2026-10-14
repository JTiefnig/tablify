import * as vscode from "vscode";

export function getLogWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = createNonce();
  const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", file));

  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  return /* html */ `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${asset("logview.css")}" />
    <title>Log Table</title>
  </head>
  <body>
    <header id="toolbar" class="toolbar">
      <div class="search">
        <input id="search" type="text" spellcheck="false" autocomplete="off" placeholder="Search messages (text or /regex/)" aria-label="Search" />
        <label class="check" title="Search the whole entry, not only the message">
          <input id="all-fields" type="checkbox" /> All fields
        </label>
      </div>
      <div id="levels" class="levels" role="group" aria-label="Levels"></div>
      <div id="time" class="time" role="group" aria-label="Time range">
        <input id="time-from" type="datetime-local" step="1" aria-label="From" title="From" />
        <span class="time-sep">–</span>
        <input id="time-to" type="datetime-local" step="1" aria-label="To" title="To" />
        <button id="time-clear" class="icon-button" type="button" title="Clear time range" aria-label="Clear time range">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8m0-8l-8 8" stroke="currentColor" stroke-width="1.2"/></svg>
        </button>
      </div>
      <span class="spacer"></span>
      <span id="count" class="count" aria-live="polite"></span>
      <button id="columns" class="toolbar-button" type="button" aria-haspopup="menu">Columns</button>
      <button id="format" class="toolbar-button" type="button" title="Log format · click to change"></button>
    </header>
    <div id="progress" class="progress" hidden><div id="progress-bar"></div></div>
    <div id="notice" class="notice" hidden></div>
    <section id="message" class="message" hidden>
      <div id="message-title" class="message-title"></div>
      <div id="message-text" class="message-text"></div>
      <div id="message-actions" class="message-actions"></div>
    </section>
    <main id="grid" class="grid" tabindex="0" role="grid" aria-label="Log entries">
      <div id="grid-header" class="grid-header" role="row"></div>
      <div id="grid-body" class="grid-body"></div>
    </main>
    <aside id="detail" class="detail" hidden>
      <div class="detail-bar">
        <span id="detail-title" class="detail-title"></span>
        <span class="spacer"></span>
        <button id="detail-reveal" class="toolbar-button" type="button" title="Open the text editor at this entry">Reveal in Source</button>
        <button id="detail-copy" class="toolbar-button" type="button" title="Copy the entry's text">Copy</button>
        <button id="detail-close" class="icon-button" type="button" title="Close (Escape)" aria-label="Close details">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8m0-8l-8 8" stroke="currentColor" stroke-width="1.2"/></svg>
        </button>
      </div>
      <div id="detail-body" class="detail-body"></div>
    </aside>
    <script nonce="${nonce}" src="${asset("logview.js")}"></script>
  </body>
</html>`;
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
