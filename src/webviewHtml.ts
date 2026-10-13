import * as vscode from "vscode";

export function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = createNonce();
  const asset = (file: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", file));

  // Inline styles are needed for Tabulator's sizing and for style attributes
  // in (sanitized) HTML cell content. Scripts are limited to the nonce.
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} https: data:`,
    `media-src ${webview.cspSource} https: data:`,
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
    <link rel="stylesheet" href="${asset("webview.css")}" />
    <title>Tablify</title>
  </head>
  <body>
    <div id="filter-widget" class="filter-widget" role="search" hidden>
      <div class="filter-input-wrap">
        <input
          id="filter"
          type="text"
          spellcheck="false"
          autocomplete="off"
          placeholder="Filter (field=value AND text~word)"
          aria-label="Filter rows"
          aria-autocomplete="list"
          aria-controls="filter-suggest"
        />
        <div id="filter-suggest" class="filter-suggest" role="listbox" hidden></div>
      </div>
      <span id="match-count" class="match-count" aria-live="polite"></span>
      <button id="saved-filters" class="icon-button" type="button" title="Saved Filters" aria-label="Saved filters" aria-haspopup="menu">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h8v11L8 10.5l-4 3z" fill="none" stroke="currentColor" stroke-linejoin="round"/></svg>
      </button>
      <button id="clear-filter" class="icon-button" type="button" title="Clear Filter" aria-label="Clear filter">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h12l-4.5 5.5V13l-3 1.5v-6L2 3z" fill="none" stroke="currentColor"/><path d="M10.5 10.5l4 4m0-4l-4 4" stroke="currentColor"/></svg>
      </button>
      <button id="close-filter" class="icon-button" type="button" title="Close (Escape)" aria-label="Close filter">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8m0-8l-8 8" stroke="currentColor" stroke-width="1.2"/></svg>
      </button>
    </div>
    <section id="message" class="message" hidden>
      <div id="message-title" class="message-title"></div>
      <div id="message-text" class="message-text"></div>
      <button id="open-as-text" type="button">Open as Text</button>
    </section>
    <main id="table"></main>
    <script nonce="${nonce}" src="${asset("webview.js")}"></script>
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
