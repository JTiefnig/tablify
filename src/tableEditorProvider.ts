import * as vscode from "vscode";
import {
  CONFIG_FILES,
  deleteFilter,
  findView,
  parseConfig,
  saveFilter,
  saveLayout,
  type SaveTarget,
} from "./config.ts";
import { computeEdit, deleteRow, insertRow, moveRow, type EditResult } from "./edit.ts";
import { blameFields, GitFile } from "./git.ts";
import { deletedRows, diffRows } from "./gitDiff.ts";
import { locateRow } from "./locate.ts";
import {
  ROW_LOCKED,
  type BlameResult,
  type ColumnLayout,
  type ToHost,
  type ToWebview,
  type ViewSettings,
} from "./messages.ts";
import { expandCommand, runCommand } from "./onSave.ts";
import { formatDataPath, languageForPath, parseTable, type Table } from "./parser.ts";
import { getWebviewHtml } from "./webviewHtml.ts";

const UPDATE_DELAY_MS = 200;
const STATUS_QUERY_MAX = 40;
const ON_SAVE_TIMEOUT_MS = 30_000;
const POPUP_OUTPUT_MAX = 500;

interface FilterState {
  query: string;
  shown: number;
  total: number;
}

/** Where a file's view comes from: the workspace folder's config file and the matching view. */
interface ViewSource {
  folder: vscode.WorkspaceFolder;
  /** The config file (it may not exist yet). */
  configUri: vscode.Uri;
  /** File path relative to the workspace folder. */
  relativePath: string;
  /** Index of the matching view, or null when no view matches. */
  index: number | null;
  view: ViewSettings | null;
}

interface TablePanel {
  panel: vscode.WebviewPanel;
  document: vscode.TextDocument;
  filter: FilterState;
  source: ViewSource | null;
  /** Current column layout in the webview, and whether it differs from the saved view. */
  layout: ColumnLayout | null;
  layoutModified: boolean;
  /** Nested data path chosen from the "Not a table file" page; used when the view sets no `path`. */
  dataPath: string[] | null;
}

export class TableEditorProvider implements vscode.CustomTextEditorProvider, vscode.Disposable {
  static readonly viewType = "tablify.tableView";

  private readonly extensionUri: vscode.Uri;
  private readonly statusBar: vscode.StatusBarItem;
  private readonly configWatcher: vscode.FileSystemWatcher;
  private readonly configChanged = new vscode.EventEmitter<void>();
  private active: TablePanel | undefined;
  private readonly output = vscode.window.createOutputChannel("Tablify");
  /** Running `onSave` commands by document URI, and whether another save came in meanwhile. */
  private readonly onSaveRuns = new Map<string, { again: boolean }>();
  private untrustedWarned = false;
  /** Workspace state: the data path chosen per file (see `TablePanel.dataPath`). */
  private readonly state: vscode.Memento;

  constructor(extensionUri: vscode.Uri, statusBar: vscode.StatusBarItem, state: vscode.Memento) {
    this.extensionUri = extensionUri;
    this.statusBar = statusBar;
    this.state = state;
    statusBar.command = "tablify.filter";

    // Any config change may affect any open table (files can move in or out of a view).
    this.configWatcher = vscode.workspace.createFileSystemWatcher(`**/{${CONFIG_FILES.join(",")}}`);
    const fire = () => this.configChanged.fire();
    this.configWatcher.onDidCreate(fire);
    this.configWatcher.onDidChange(fire);
    this.configWatcher.onDidDelete(fire);
  }

  dispose() {
    this.configWatcher.dispose();
    this.configChanged.dispose();
    this.output.dispose();
  }

  /**
   * Runs the view's `onSave` command for a saved document (one run at a time
   * per file; a save during a run runs it once more afterwards). Only in
   * trusted workspaces.
   */
  private async runOnSave(document: vscode.TextDocument, source: ViewSource | null) {
    const template = source?.view?.onSave;
    if (!source || !template) {
      return;
    }
    if (!vscode.workspace.isTrusted) {
      if (!this.untrustedWarned) {
        this.untrustedWarned = true;
        void vscode.window.showWarningMessage("Tablify: the on-save command only runs in trusted workspaces.");
      }
      return;
    }
    const key = document.uri.toString();
    const running = this.onSaveRuns.get(key);
    if (running) {
      running.again = true;
      return;
    }
    const run = { again: true };
    this.onSaveRuns.set(key, run);
    try {
      while (run.again) {
        run.again = false;
        const file = document.uri.fsPath;
        const folder = source.folder.uri.fsPath;
        const command = expandCommand(template, {
          file,
          relativeFile: source.relativePath,
          fileDirname: vscode.Uri.joinPath(document.uri, "..").fsPath,
          workspaceFolder: folder,
        });
        this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${command}`);
        const status = vscode.window.setStatusBarMessage("$(sync~spin) Tablify: running on-save command…");
        const result = await runCommand(command, folder, ON_SAVE_TIMEOUT_MS).finally(() => status.dispose());
        if (result.stdout.trim()) this.output.appendLine(result.stdout.trimEnd());
        if (result.stderr.trim()) this.output.appendLine(result.stderr.trimEnd());
        const outcome = result.timedOut ? `timed out after ${ON_SAVE_TIMEOUT_MS / 1000} s` : `exit code ${result.code}`;
        this.output.appendLine(`→ ${outcome}`);
        const output = popupText([result.stdout, result.stderr].join("\n"));
        const showOutput = (choice: string | undefined) => choice && this.output.show(true);
        if (result.timedOut || result.code !== 0) {
          const message = `Tablify: on-save command failed (${outcome})${output ? `: ${output}` : "."}`;
          void vscode.window.showErrorMessage(message, "Show Output").then(showOutput);
        } else if (output) {
          void vscode.window.showInformationMessage(`Tablify: ${output}`, "Show Output").then(showOutput);
        } else {
          vscode.window.setStatusBarMessage("$(check) Tablify: on-save command done", 3000);
        }
      }
    } finally {
      this.onSaveRuns.delete(key);
    }
  }

  /** Mirrors whether the active table has unsaved column layout changes (`tablify.layoutModified`). */
  private refreshLayoutUi() {
    void vscode.commands.executeCommand("setContext", "tablify.layoutModified", !!this.active?.layoutModified);
  }

  /** Discards the active table's unsaved column layout changes. */
  resetActiveView() {
    this.postToActive({ type: "resetLayout" });
  }

  /**
   * Saves the active table's column layout to `.vscode/tablify.yaml`: into the
   * matching view, or into a new view for this file or folder.
   */
  async saveActiveView() {
    const entry = this.active;
    const source = this.configSource(entry);
    if (!entry?.layout || !source) {
      return;
    }
    const target = await pickTarget(source, pathToSave(entry), {
      title: "Save Tablify View",
      placeHolder: `Column order, hidden columns and widths go to ${vscode.workspace.asRelativePath(source.configUri)}`,
    });
    const layout = entry.layout;
    if (target && (await writeConfig(source, (text) => saveLayout(text, target, layout)))) {
      // The config watcher reloads the view; the table drops its local changes.
      entry.panel.webview.postMessage({ type: "resetLayout" } satisfies ToWebview);
      this.configChanged.fire();
    }
  }

  /** Saves the active table's filter query under a name in the matching view (or a new view). */
  async saveActiveFilter(query = this.active?.filter.query ?? "") {
    const source = this.configSource(this.active);
    if (!source || !query.trim()) {
      return;
    }
    const filters = source.view?.filters ?? [];
    const name = await vscode.window.showInputBox({
      title: "Save Tablify Filter",
      prompt: query,
      placeHolder: "Filter name",
      value: filters.find((filter) => filter.query === query)?.name ?? "",
      validateInput: (value) => {
        const existing = filters.find((filter) => filter.name === value.trim());
        if (!value.trim()) return "Enter a name.";
        return existing && existing.query !== query
          ? { message: `Replaces "${existing.name}" (${existing.query}).`, severity: vscode.InputBoxValidationSeverity.Warning }
          : null;
      },
    });
    if (!name?.trim()) {
      return;
    }
    const path = pathToSave(this.active);
    const target: SaveTarget | undefined =
      source.index !== null
        ? { kind: "existing", index: source.index, path }
        : await pickTarget(source, path, {
            title: "Save Tablify Filter",
            placeHolder: "No view applies to this file yet: create one for the filter",
          });
    if (target && (await writeConfig(source, (text) => saveFilter(text, target, { name: name.trim(), query: query.trim() })))) {
      this.configChanged.fire();
    }
  }

  /** Removes a saved filter from the active table's view. */
  async deleteActiveFilter(name: string) {
    const source = this.configSource(this.active);
    const index = source?.index;
    if (!source || index === null || index === undefined) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(`Delete the saved filter "${name}"?`, { modal: true }, "Delete");
    if (choice === "Delete" && (await writeConfig(source, (text) => deleteFilter(text ?? "", index, name)))) {
      this.configChanged.fire();
    }
  }

  private configSource(entry: TablePanel | undefined): ViewSource | null {
    if (entry && !entry.source) {
      void vscode.window.showWarningMessage("Tablify: views can only be saved for files in a workspace folder.");
    }
    return entry?.source ?? null;
  }

  /** Sends a message to the table editor that currently has focus. */
  postToActive(message: ToWebview) {
    void this.active?.panel.webview.postMessage(message);
  }

  /** Mirrors the active table's filter in the status bar and the `tablify.filterActive` context. */
  private refreshFilterUi() {
    const filter = this.active?.filter;
    void vscode.commands.executeCommand("setContext", "tablify.filterActive", !!filter?.query);

    if (!filter?.query) {
      this.statusBar.hide();
      return;
    }
    const query =
      filter.query.length > STATUS_QUERY_MAX
        ? `${filter.query.slice(0, STATUS_QUERY_MAX - 1)}…`
        : filter.query;
    this.statusBar.text = `$(filter) ${query} · ${filter.shown}/${filter.total}`;
    this.statusBar.tooltip = `Tablify filter: ${filter.query}\nClick to edit`;
    this.statusBar.show();
  }

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
  ): void {
    const webview = panel.webview;
    const documentDir = vscode.Uri.joinPath(document.uri, "..");

    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "dist"),
        documentDir,
        ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri),
      ],
    };
    webview.html = getWebviewHtml(webview, this.extensionUri);

    const entry: TablePanel = {
      panel,
      document,
      filter: { query: "", shown: 0, total: 0 },
      source: null,
      layout: null,
      layoutModified: false,
      dataPath: null,
    };
    const dataPathKey = `dataPath:${document.uri.toString()}`;
    entry.dataPath = this.state.get<string[]>(dataPathKey) ?? null;
    const setDataPath = (segments: string[] | null) => {
      entry.dataPath = segments;
      void this.state.update(dataPathKey, segments ?? undefined);
    };

    // Source offset of each row, from the most recent successful parse.
    let offsets: number[] = [];
    let lastConfigError = "";
    // Git: the tracked file, and its rows in the last commit
    // (null = not in HEAD yet, so every row is new; undefined = not loaded).
    let git: GitFile | null = null;
    let headTable: Table | null | undefined;
    let ready = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const post = (message: ToWebview) => void webview.postMessage(message);

    const language = languageForPath(document.uri.path);
    const idField = () => vscode.workspace.getConfiguration("tablify", document.uri).get<string>("idField", "id");
    const dataPath = () => entry.source?.view?.dataPath ?? entry.dataPath;
    const parse = (text = document.getText()) => parseTable(text, language, { idField: idField(), dataPath: dataPath() });
    // The view's data path decides what the rows are: show nothing before it is known.
    let configLoaded = false;

    const update = () => {
      if (!ready || !configLoaded) {
        return;
      }
      const result = parse();

      if (!result.ok) {
        if (result.kind === "shape" && entry.dataPath && !entry.source?.view?.dataPath) {
          // The chosen nested path no longer fits the file: back to the top level.
          setDataPath(null);
          update();
          return;
        }
        const suggested = result.suggestedPath;
        post({
          type: "error",
          kind: result.kind,
          message: result.message,
          line: result.line,
          suggestedPath: suggested && { segments: suggested, label: formatDataPath(suggested) },
        });
        return;
      }
      offsets = result.table.offsets;
      post({
        type: "data",
        version: document.version,
        rows: result.table.rows,
        fields: result.table.fields,
        view: entry.source?.view ?? null,
        git: git !== null,
        changes: git && headTable !== undefined ? diffRows(headTable, result.table, idField()) : null,
        deleted: git && headTable !== undefined ? deletedRows(headTable, result.table, idField()) : null,
        baseUri: `${webview.asWebviewUri(documentDir).toString()}/`,
      });
    };

    /**
     * Applies an edit computed on the current text as one WorkspaceEdit (one
     * undo step). Refused when the webview's rows are stale.
     */
    const applyEdit = async (version: number, compute: (text: string, table: Table) => EditResult): Promise<boolean> => {
      if (version !== document.version) {
        void vscode.window.showWarningMessage("Tablify: the file changed while you were editing; the edit was not applied.");
        return false;
      }
      const text = document.getText();
      const result = parse(text);
      if (!result.ok) {
        return false;
      }
      const edit = compute(text, result.table);
      if (!edit.ok) {
        void vscode.window.showErrorMessage(`Tablify: ${edit.message}`);
        return false;
      }
      if (edit.edits.length === 0) {
        return true;
      }

      const workspaceEdit = new vscode.WorkspaceEdit();
      for (const { offset, length, text: newText } of edit.edits) {
        workspaceEdit.replace(
          document.uri,
          new vscode.Range(document.positionAt(offset), document.positionAt(offset + length)),
          newText,
        );
      }
      return vscode.workspace.applyEdit(workspaceEdit);
    };

    const applyCellEdit = (message: Extract<ToHost, { type: "edit" }>) =>
      applyEdit(message.version, (text, table) => {
        const locked = (table.rows[message.index]?.[ROW_LOCKED] as string[] | undefined) ?? [];
        if (!table.rows[message.index] || locked.includes("*") || locked.includes(message.field)) {
          return { ok: false, message: `"${message.field}" cannot be edited in the table.` };
        }
        const value = message.remove ? undefined : message.value;
        return computeEdit(text, language, table.paths[message.index], message.field, value);
      });

    /** Finds the repository and loads the committed rows (lazy: one `git show`, no blame). */
    const loadGit = async () => {
      const enabled = vscode.workspace.getConfiguration("tablify", document.uri).get<boolean>("git.enabled", true);
      git = enabled && document.uri.scheme === "file" ? await GitFile.open(document.uri.fsPath, gitPath()) : null;
      if (!git) {
        headTable = undefined;
        return;
      }
      const head = await git.headText();
      if (head === null) {
        headTable = null;
      } else {
        const parsed = parse(head);
        headTable = parsed.ok ? parsed.table : undefined;
      }
    };

    const refreshGit = async () => {
      await loadGit();
      update();
    };

    const blame = async (index: number): Promise<BlameResult> => {
      if (!git) {
        return { ok: false, message: "This file is not tracked by git." };
      }
      const text = document.getText();
      const result = parse(text);
      if (!result.ok || !result.table.paths[index]) {
        return { ok: false, message: "The file cannot be read." };
      }
      const location = locateRow(text, language, result.table.paths[index]);
      if (!location) {
        return { ok: false, message: "Cannot locate the entry in the file." };
      }
      const fields = { ...location.fields };
      if (result.table.shape === "mapping") {
        // The key of a mapping entry is its ID: blame its line.
        fields[idField()] = [location.row[0], location.row[0] + 1];
      }
      try {
        const start = document.positionAt(location.row[0]).line + 1;
        const end = document.positionAt(location.row[1]).line + 1;
        return { ok: true, fields: blameFields(text, fields, await git.blame(text, start, end)) };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    };

    const loadConfig = async () => {
      const found = await findViewSource(document.uri);
      const previousPath = JSON.stringify(dataPath());
      entry.source = found.source;
      configLoaded = true;
      if (found.error && found.error !== lastConfigError) {
        void vscode.window.showWarningMessage(`Tablify: ${found.error}`);
      }
      lastConfigError = found.error ?? "";
      if (JSON.stringify(dataPath()) !== previousPath && git) {
        // The committed rows were read at the old path.
        await refreshGit();
      } else {
        update();
      }
    };

    const scheduleUpdate = () => {
      clearTimeout(timer);
      timer = setTimeout(update, UPDATE_DELAY_MS);
    };


    if (panel.active) {
      this.active = entry;
    }

    const subscriptions = [
      panel.onDidChangeViewState(({ webviewPanel }) => {
        if (webviewPanel.active) {
          this.active = entry;
          this.refreshLayoutUi();
          // Commits, checkouts etc. may have happened while the table was in the background.
          if (ready) void refreshGit();
        } else if (this.active === entry) {
          this.active = undefined;
        }
        this.refreshFilterUi();
      }),
      this.configChanged.event(() => void loadConfig()),
      vscode.workspace.onDidSaveTextDocument((saved) => {
        if (saved.uri.toString() === document.uri.toString()) void this.runOnSave(document, entry.source);
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.toString() === document.uri.toString()) {
          scheduleUpdate();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("tablify.idField", document.uri)) {
          update();
        }
        if (event.affectsConfiguration("tablify.git.enabled", document.uri)) {
          void refreshGit();
        }
      }),
      onGitStateChange(() => {
        if (ready) void refreshGit();
      }),
      webview.onDidReceiveMessage((message: ToHost) => {
        switch (message.type) {
          case "ready":
            ready = true;
            void loadConfig();
            void refreshGit();
            break;
          case "blame":
            void blame(message.index).then((result) =>
              post({ type: "blame", requestId: message.requestId, index: message.index, result }),
            );
            break;
          case "reveal":
            void revealOffset(document, offsets[message.index]);
            break;
          case "openLink":
            void openLink(documentDir, message.href);
            break;
          case "openAsText":
            void openAsText(document.uri);
            break;
          case "showDataPath":
            setDataPath(message.segments);
            // The committed rows are read at the data path as well.
            void refreshGit();
            break;
          case "edit":
            // Resync right away: on success the webview needs the new document version
            // for its next edit; on failure the table still shows the typed value.
            void applyCellEdit(message).then(update);
            break;
          case "insertRow":
            void applyEdit(message.version, (text, table) =>
              insertRow(text, language, table, message.index, message.placement, message.id, idField()),
            ).then(update);
            break;
          case "deleteRow":
            void applyEdit(message.version, (text, table) => deleteRow(text, language, table, message.index)).then(update);
            break;
          case "moveRow":
            void applyEdit(message.version, (text, table) =>
              moveRow(text, language, table, message.index, message.target, message.placement),
            ).then(update);
            break;
          case "layout":
            entry.layout = message.layout;
            entry.layoutModified = message.modified;
            if (this.active === entry) this.refreshLayoutUi();
            break;
          case "saveView":
            if (this.active === entry) void this.saveActiveView();
            break;
          case "saveFilter":
            if (this.active === entry) void this.saveActiveFilter(message.query);
            break;
          case "deleteFilter":
            if (this.active === entry) void this.deleteActiveFilter(message.name);
            break;
          case "filterState":
            entry.filter = { query: message.query, shown: message.shown, total: message.total };
            if (this.active === entry) {
              this.refreshFilterUi();
            }
            break;
        }
      }),
    ];

    panel.onDidDispose(() => {
      if (this.active === entry) {
        this.active = undefined;
        this.refreshFilterUi();
      }
      clearTimeout(timer);
      subscriptions.forEach((subscription) => subscription.dispose());
    });
  }
}

export function openAsText(uri: vscode.Uri): Thenable<unknown> {
  return vscode.commands.executeCommand("vscode.openWith", uri, "default");
}

async function revealOffset(document: vscode.TextDocument, offset: number | undefined) {
  if (offset === undefined) {
    return;
  }
  const position = document.positionAt(offset);
  const existing = vscode.window.visibleTextEditors.find(
    (editor) => editor.document.uri.toString() === document.uri.toString(),
  );
  const editor = await vscode.window.showTextDocument(document, {
    viewColumn: existing?.viewColumn ?? vscode.ViewColumn.Beside,
    selection: new vscode.Range(position, position),
  });
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.AtTop);
}

async function openLink(documentDir: vscode.Uri, href: string) {
  if (/^(https?|mailto):/i.test(href)) {
    await vscode.env.openExternal(vscode.Uri.parse(href));
    return;
  }
  if (/^[a-z][\w+.-]*:/i.test(href) || href.startsWith("#")) {
    return;
  }
  const [path] = href.split(/[?#]/);
  await vscode.commands.executeCommand(
    "vscode.open",
    vscode.Uri.joinPath(documentDir, decodeURIComponent(path)),
  );
}

/** Command output for a notification: trimmed and shortened (the full text is in the output channel). */
function popupText(text: string): string {
  const trimmed = text.trim().replace(/\n{2,}/g, "\n");
  return trimmed.length > POPUP_OUTPUT_MAX ? `${trimmed.slice(0, POPUP_OUTPUT_MAX - 1)}…` : trimmed;
}

/**
 * Asks where to save: the view that applies to the file (if any), or a new
 * view for this file, this folder, or this folder and its subfolders.
 */
async function pickTarget(
  source: ViewSource,
  dataPath: string | undefined,
  options: { title: string; placeHolder: string },
): Promise<SaveTarget | undefined> {
  const path = source.relativePath;
  const name = path.split("/").pop() ?? path;
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  type Choice = vscode.QuickPickItem & { target: SaveTarget };
  const choices: Choice[] = [];
  if (source.index !== null) {
    const view = source.view?.name ? `"${source.view.name}"` : `#${source.index + 1}`;
    choices.push({ label: `$(save) Update view ${view}`, description: "used by this file", target: { kind: "existing", index: source.index } });
  }
  choices.push(
    { label: "$(file) New view for this file", description: path, target: { kind: "new", name, files: [path] } },
    {
      label: "$(folder) New view for this folder",
      description: `${dir ? `${dir}/` : ""}*${extension}`,
      target: { kind: "new", name: dir || "workspace root", files: [`${dir ? `${dir}/` : ""}*${extension}`] },
    },
    {
      label: "$(folder-library) New view for this folder and subfolders",
      description: `${dir ? `${dir}/` : ""}**/*${extension}`,
      target: { kind: "new", name: `${dir || "workspace"} (all)`, files: [`${dir ? `${dir}/` : ""}**/*${extension}`] },
    },
  );
  const target = (await vscode.window.showQuickPick(choices, options))?.target;
  return target && { ...target, path: dataPath };
}

/** The data path chosen for the table, when its view does not set one: saved into the view. */
function pathToSave(entry: TablePanel | undefined): string | undefined {
  return entry?.dataPath && !entry.source?.view?.dataPath ? formatDataPath(entry.dataPath) : undefined;
}

/**
 * Rewrites the config file with `update` (which gets null when there is no
 * file yet). An open config document is edited and saved, so it stays in sync.
 * Returns false (after showing the error) when it fails.
 */
async function writeConfig(source: ViewSource, update: (text: string | null) => string): Promise<boolean> {
  try {
    const open = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === source.configUri.toString());
    let text: string | null = open?.getText() ?? null;
    if (!open) {
      try {
        text = new TextDecoder().decode(await vscode.workspace.fs.readFile(source.configUri));
      } catch {
        text = null;
      }
    }
    const updated = update(text);
    if (open) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(open.uri, new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length)), updated);
      await vscode.workspace.applyEdit(edit);
      await open.save();
    } else {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(source.configUri, ".."));
      await vscode.workspace.fs.writeFile(source.configUri, new TextEncoder().encode(updated));
    }
    return true;
  } catch (error) {
    void vscode.window.showErrorMessage(`Tablify: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** The workspace folder config and the view in it that applies to a data file. */
async function findViewSource(documentUri: vscode.Uri): Promise<{ source: ViewSource | null; error?: string }> {
  const folder = vscode.workspace.getWorkspaceFolder(documentUri);
  if (!folder) {
    return { source: null };
  }
  const relativePath = documentUri.path.slice(folder.uri.path.replace(/\/$/, "").length + 1);

  for (const name of CONFIG_FILES) {
    const configUri = vscode.Uri.joinPath(folder.uri, name);
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(configUri);
    } catch {
      continue;
    }
    const result = parseConfig(new TextDecoder().decode(bytes));
    const base = { folder, configUri, relativePath, index: null, view: null };
    if (!result.ok) {
      return { source: base, error: `${vscode.workspace.asRelativePath(configUri)}: ${result.message}` };
    }
    const match = findView(result.config, relativePath);
    return { source: { ...base, index: match?.index ?? null, view: match?.view ?? null } };
  }
  const configUri = vscode.Uri.joinPath(folder.uri, CONFIG_FILES[0]);
  return { source: { folder, configUri, relativePath, index: null, view: null } };
}

function gitPath(): string {
  const configured = vscode.workspace.getConfiguration("git").get<string | string[]>("path");
  return (Array.isArray(configured) ? configured[0] : configured) || "git";
}

interface GitExtensionApi {
  repositories: { state: { onDidChange: vscode.Event<void> } }[];
  onDidOpenRepository: vscode.Event<{ state: { onDidChange: vscode.Event<void> } }>;
}

/**
 * Fires when any repository's state changes (commit, checkout, stage, ...),
 * using VS Code's built-in git extension when it is available. Debounced.
 */
function onGitStateChange(listener: () => void): vscode.Disposable {
  const subscriptions: vscode.Disposable[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(listener, 500);
  };

  const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitExtensionApi }>("vscode.git");
  if (extension) {
    void Promise.resolve(extension.isActive ? extension.exports : extension.activate()).then(
      (exports) => {
        const api = exports.getAPI(1);
        api.repositories.forEach((repository) => subscriptions.push(repository.state.onDidChange(fire)));
        subscriptions.push(
          api.onDidOpenRepository((repository) => subscriptions.push(repository.state.onDidChange(fire))),
        );
      },
      () => undefined,
    );
  }
  return new vscode.Disposable(() => {
    clearTimeout(timer);
    subscriptions.forEach((subscription) => subscription.dispose());
  });
}
