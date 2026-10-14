// Read-only custom editor that shows a log file as a table. The file is read
// directly (not as a TextDocument, which VS Code does not sync above 50 MB),
// parsed in chunks in the extension host, and filtered / sorted here; the
// webview only receives the rows it shows.

import * as vscode from "vscode";
import { openAsText } from "../tableEditorProvider.ts";
import { candidateFormats, detectFormat, type Detection } from "./detect.ts";
import { BUILTIN_FORMATS, parseCustomFormats, PLAIN } from "./formats.ts";
import { EMPTY_QUERY, type ColumnInfo, type LogQuery, type ToLogHost, type ToLogWebview } from "./messages.ts";
import { LogParser, splitLines } from "./parse.ts";
import { excerpt, readHead, readTail, type Excerpt } from "./read.ts";
import { LogStore } from "./store.ts";
import type { LogFormat } from "./types.ts";
import { getLogWebviewHtml } from "./webviewHtml.ts";

/** Lines loaded with "first / last N lines" for large files. */
export const PARTIAL_LINES = 100_000;
/** The first chunk is small so the first screen appears right away. */
const FIRST_CHUNK_LINES = 5_000;
const CHUNK_LINES = 50_000;
const PROGRESS_INTERVAL_MS = 250;
const RELOAD_DELAY_MS = 500;
/** Most rows sent per window request. */
const WINDOW_MAX = 1_000;
/** Format overrides per file URI, in workspaceState. */
const FORMAT_OVERRIDES_KEY = "tablify.log.formatOverrides";

type LoadMode = "all" | "head" | "tail";

interface LogSettings {
  sampleLines: number;
  threshold: number;
  largeFileThresholdMB: number;
  defaultHiddenColumns: string[];
}

export class LogEditorProvider implements vscode.CustomReadonlyEditorProvider, vscode.Disposable {
  static readonly viewType = "tablify.logView";

  readonly extensionUri: vscode.Uri;
  private readonly context: vscode.ExtensionContext;
  private readonly statusBar: vscode.StatusBarItem;
  private readonly sessions = new Set<LogSession>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private active: LogSession | undefined;
  customFormats: LogFormat[] = [];
  private readonly reportedErrors = new Set<string>();

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.extensionUri = context.extensionUri;
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.statusBar.command = "tablify.selectLogFormat";
    this.loadCustomFormats();
    this.subscriptions.push(
      this.statusBar,
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration("tablify.log")) return;
        this.loadCustomFormats();
        this.sessions.forEach((session) => void session.load());
      }),
    );
  }

  dispose() {
    this.subscriptions.forEach((subscription) => subscription.dispose());
  }

  /** Reads `tablify.log.customFormats`; invalid definitions are reported once and skipped. */
  private loadCustomFormats() {
    const { formats, errors } = parseCustomFormats(vscode.workspace.getConfiguration("tablify.log").get("customFormats"));
    this.customFormats = formats;
    for (const error of errors) {
      if (this.reportedErrors.has(error)) continue;
      this.reportedErrors.add(error);
      void vscode.window.showWarningMessage(`Tablify: tablify.log.${error} The format is skipped.`);
    }
  }

  settings(uri: vscode.Uri): LogSettings {
    const config = vscode.workspace.getConfiguration("tablify.log", uri);
    return {
      sampleLines: config.get<number>("detectionSampleLines", 200),
      threshold: config.get<number>("detectionThreshold", 0.6),
      largeFileThresholdMB: config.get<number>("largeFileThresholdMB", 50),
      defaultHiddenColumns: config.get<string[]>("defaultHiddenColumns", ["ident", "version", "tid"]),
    };
  }

  /** All formats for the picker: custom, built-in, plain text. */
  allFormats(): LogFormat[] {
    return [...this.customFormats, ...BUILTIN_FORMATS, PLAIN];
  }

  formatOverride(uri: vscode.Uri): LogFormat | undefined {
    const id = this.context.workspaceState.get<Record<string, string>>(FORMAT_OVERRIDES_KEY, {})[uri.toString()];
    return id ? this.allFormats().find((format) => format.id === id) : undefined;
  }

  private async setFormatOverride(uri: vscode.Uri, id: string | null) {
    const overrides = { ...this.context.workspaceState.get<Record<string, string>>(FORMAT_OVERRIDES_KEY, {}) };
    if (id === null) delete overrides[uri.toString()];
    else overrides[uri.toString()] = id;
    await this.context.workspaceState.update(FORMAT_OVERRIDES_KEY, overrides);
  }

  /** Quick pick to override the detected format of the active log table (remembered per file). */
  async selectFormat(session = this.active) {
    if (!session) {
      void vscode.window.showInformationMessage("Tablify: open a log file as a table first.");
      return;
    }
    type Item = vscode.QuickPickItem & { id?: string | null };
    const override = this.formatOverride(session.uri);
    const detected = session.detection?.format;
    const items: Item[] = [
      {
        label: "$(sparkle) Auto-detect",
        description: detected ? `detected: ${detected.label}` : undefined,
        picked: !override,
        id: null,
      },
      { label: "Formats", kind: vscode.QuickPickItemKind.Separator },
      ...this.allFormats().map((format): Item => ({
        label: `${format === session.format ? "$(check) " : ""}${format.label}`,
        description: [format.custom ? "custom" : "", format === detected ? "detected" : ""].filter(Boolean).join(" · "),
        id: format.id,
      })),
    ];
    const choice = await vscode.window.showQuickPick(items, {
      title: "Log Table: Select Format",
      placeHolder: `Current: ${session.format?.label ?? "…"}`,
    });
    if (!choice || choice.id === undefined) return;
    await this.setFormatOverride(session.uri, choice.id);
    void session.load();
  }

  focusSearch() {
    this.active?.post({ type: "focusSearch" });
  }

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose() {} };
  }

  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    const session = new LogSession(this, document.uri, panel);
    this.sessions.add(session);
    if (panel.active) this.setActive(session);
    panel.onDidChangeViewState(({ webviewPanel }) => {
      if (webviewPanel.active) this.setActive(session);
      else if (this.active === session) this.setActive(undefined);
    });
    panel.onDidDispose(() => {
      this.sessions.delete(session);
      if (this.active === session) this.setActive(undefined);
      session.dispose();
    });
  }

  private setActive(session: LogSession | undefined) {
    this.active = session;
    this.refreshStatusBar();
  }

  /** Shows the active log table's format in the status bar ("Log: Syslog RFC 3164"). */
  refreshStatusBar(session?: LogSession) {
    if (session && session !== this.active) return;
    const format = this.active?.format;
    if (!format) {
      this.statusBar.hide();
      return;
    }
    const detected = !this.formatOverride(this.active!.uri);
    this.statusBar.text = `$(list-flat) Log: ${format.label}`;
    this.statusBar.tooltip = `${detected ? "Detected" : "Selected"} log format · click to change`;
    this.statusBar.show();
  }
}

class LogSession {
  readonly uri: vscode.Uri;
  format: LogFormat | undefined;
  detection: Detection | undefined;

  private readonly provider: LogEditorProvider;
  private readonly panel: vscode.WebviewPanel;
  private readonly store = new LogStore(EMPTY_QUERY, () => null);
  private readonly subscriptions: vscode.Disposable[] = [];
  private parser: LogParser | null = null;
  private columns: ColumnInfo[] = [];
  private generation = 0;
  private loading = false;
  private progress = 0;
  private notice: string | null = null;
  /** How much of a large file to load; null until asked. */
  private mode: LoadMode | null = null;
  /** Increments with every load; a running load stops when it is outdated. */
  private loadId = 0;
  private started = false;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(provider: LogEditorProvider, uri: vscode.Uri, panel: vscode.WebviewPanel) {
    this.provider = provider;
    this.uri = uri;
    this.panel = panel;

    const webview = panel.webview;
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(provider.extensionUri, "dist")] };
    webview.html = getLogWebviewHtml(webview, provider.extensionUri);
    this.subscriptions.push(webview.onDidReceiveMessage((message: ToLogHost) => this.receive(message)));

    // Reload when the file changes on disk (appended log lines, rotation, saves).
    const folder = vscode.Uri.joinPath(uri, "..");
    const name = uri.path.slice(uri.path.lastIndexOf("/") + 1);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, name));
    const reload = () => {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => void this.load(), RELOAD_DELAY_MS);
    };
    this.subscriptions.push(watcher, watcher.onDidChange(reload), watcher.onDidCreate(reload));
  }

  dispose() {
    this.loadId++;
    clearTimeout(this.reloadTimer);
    this.subscriptions.forEach((subscription) => subscription.dispose());
  }

  post(message: ToLogWebview) {
    void this.panel.webview.postMessage(message);
  }

  private receive(message: ToLogHost) {
    switch (message.type) {
      case "ready":
        // Also sent again when a hidden webview is restored: keep the loaded data.
        this.store.setQuery(message.query);
        if (!this.started) {
          this.started = true;
          void this.load();
        } else {
          this.resort();
        }
        break;
      case "query":
        this.store.setQuery(message.query);
        this.resort();
        break;
      case "rows":
        if (message.generation === this.generation) {
          const rows = this.store.window(message.start, Math.min(message.count, WINDOW_MAX), this.columns);
          this.post({ type: "rows", generation: this.generation, start: message.start, rows });
        }
        break;
      case "detail": {
        const detail = this.store.detail(message.index, this.columns);
        if (detail) this.post({ type: "detail", detail });
        break;
      }
      case "reveal":
        void this.reveal(message.index);
        break;
      case "selectFormat":
        void this.provider.selectFormat(this);
        break;
      case "openAsText":
        void openAsText(this.uri);
        break;
      case "loadLarge":
        this.mode = message.mode;
        void this.load();
        break;
    }
  }

  /** After a query change: sort (once loaded) and send the new view. */
  private resort() {
    if (!this.loading) this.store.sort(this.timestampColumns());
    this.generation++;
    this.postState();
  }

  private timestampColumns(): Set<string> {
    return new Set(this.columns.filter((column) => column.role === "timestamp").map((column) => column.name));
  }

  private postState() {
    const parser = this.parser;
    if (parser) {
      const hidden = new Set(this.provider.settings(this.uri).defaultHiddenColumns);
      this.columns = parser.columns().map(({ name, key, role, nonEmpty, superseded }) => ({
        name,
        key,
        role,
        hiddenByDefault: role !== "message" && (nonEmpty === 0 || superseded || hidden.has(name)),
      }));
    }
    this.post({
      type: "state",
      generation: this.generation,
      loading: this.loading,
      progress: this.progress,
      total: this.store.records.length,
      count: this.store.view.length,
      levelCounts: this.store.levelCounts,
      columns: this.columns,
      timeRange: this.store.timeRange,
      format: { id: this.format?.id ?? "", label: this.format?.label ?? "", detected: !this.provider.formatOverride(this.uri) },
      queryError: this.store.queryError,
      notice: this.notice,
    });
  }

  /** (Re)reads and parses the file in chunks, posting progress as records come in. */
  async load() {
    if (!this.started) return;
    const id = ++this.loadId;
    const settings = this.provider.settings(this.uri);
    let source: Excerpt;
    let mtime: number;
    try {
      const stat = await vscode.workspace.fs.stat(this.uri);
      mtime = stat.mtime;
      const sizeMB = stat.size / (1024 * 1024);
      if (this.mode === null) {
        if (sizeMB > settings.largeFileThresholdMB) {
          this.post({ type: "largeFile", sizeMB, lines: PARTIAL_LINES });
          return;
        }
        this.mode = "all";
      }
      source = await this.read(this.mode);
    } catch (error) {
      if (id === this.loadId) this.post({ type: "error", message: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (id !== this.loadId) return;

    const lines = splitLines(source.text);
    this.notice =
      this.mode === "head"
        ? `Showing the first ${PARTIAL_LINES.toLocaleString()} lines.`
        : this.mode === "tail"
          ? `Showing the last ${PARTIAL_LINES.toLocaleString()} lines (from line ${(source.firstLine + 1).toLocaleString()}).`
          : null;

    const formats = candidateFormats(this.provider.customFormats);
    this.detection = detectFormat(lines, formats, { sampleLines: settings.sampleLines, threshold: settings.threshold });
    this.format = this.provider.formatOverride(this.uri) ?? this.detection.format;
    this.provider.refreshStatusBar(this);

    const parser = new LogParser(this.format, { reference: new Date(mtime) });
    this.parser = parser;
    this.store.reset(parser.records, (record) => parser.messageKey(record));
    this.generation++;
    this.loading = true;
    this.progress = 0;

    let lastPost = 0;
    for (let start = 0; start < lines.length || start === 0; ) {
      const end = Math.min(lines.length, start + (start === 0 ? FIRST_CHUNK_LINES : CHUNK_LINES));
      parser.feed(lines, start, end, source.firstLine);
      start = end;
      const done = start >= lines.length;
      if (done) parser.finish();
      this.store.update();
      this.progress = lines.length ? start / lines.length : 1;
      if (done) break;
      if (Date.now() - lastPost >= PROGRESS_INTERVAL_MS) {
        lastPost = Date.now();
        this.postState();
      }
      await new Promise((resolve) => setImmediate(resolve));
      if (id !== this.loadId) return;
    }
    this.loading = false;
    this.postState(); // columns are final: the timestamp column is known for sorting
    if (this.store.getQuery().sort) this.resort();
  }

  private async read(mode: LoadMode): Promise<Excerpt> {
    if (mode !== "all" && this.uri.scheme === "file") {
      return mode === "head" ? readHead(this.uri.fsPath, PARTIAL_LINES) : readTail(this.uri.fsPath, PARTIAL_LINES);
    }
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(this.uri));
    return mode === "all" ? { text, firstLine: 0 } : excerpt(text, mode, PARTIAL_LINES);
  }

  /** Opens the text editor at the entry's first line. */
  private async reveal(index: number) {
    const record = this.store.records[index];
    if (!record) return;
    const range = new vscode.Range(record.lineStart, 0, record.lineStart, 0);
    const existing = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === this.uri.toString());
    // `vscode.openWith` with the default editor: works for files too large to open as a TextDocument,
    // and does not reopen the log table when it is the configured editor for the file.
    await vscode.commands.executeCommand("vscode.openWith", this.uri, "default", {
      viewColumn: existing?.viewColumn ?? vscode.ViewColumn.Beside,
      selection: range,
      preview: false,
    } satisfies vscode.TextDocumentShowOptions);
  }
}
