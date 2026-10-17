import * as vscode from "vscode";
import { LogEditorProvider } from "./log/logEditorProvider.ts";
import { openAsText, TableEditorProvider } from "./tableEditorProvider.ts";

export function activate(context: vscode.ExtensionContext) {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const provider = new TableEditorProvider(context.extensionUri, statusBar, context.workspaceState);
  const logProvider = new LogEditorProvider(context);

  context.subscriptions.push(
    statusBar,
    provider,
    logProvider,

    vscode.window.registerCustomEditorProvider(TableEditorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: false },
    }),

    vscode.window.registerCustomEditorProvider(LogEditorProvider.viewType, logProvider, {
      webviewOptions: { retainContextWhenHidden: false },
      supportsMultipleEditorsPerDocument: true,
    }),

    vscode.commands.registerCommand("tablify.openAsLogTable", (uri?: vscode.Uri) => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      const target =
        uri ??
        vscode.window.activeTextEditor?.document.uri ??
        (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText ? input.uri : undefined);
      if (!target) {
        void vscode.window.showInformationMessage("Tablify: open a log file first.");
        return;
      }
      return vscode.commands.executeCommand("vscode.openWith", target, LogEditorProvider.viewType);
    }),

    vscode.commands.registerCommand("tablify.selectLogFormat", () => logProvider.selectFormat()),

    vscode.commands.registerCommand("tablify.openAsTable", (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        void vscode.window.showInformationMessage("Tablify: open a JSON, YAML or CSV file first.");
        return;
      }
      return vscode.commands.executeCommand("vscode.openWith", target, TableEditorProvider.viewType);
    }),

    vscode.commands.registerCommand("tablify.openAsText", (uri?: vscode.Uri) => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      const target = uri ?? (input instanceof vscode.TabInputCustom ? input.uri : undefined);
      return target ? openAsText(target) : undefined;
    }),

    vscode.commands.registerCommand("tablify.filter", () => {
      provider.postToActive({ type: "focusFilter" });
      logProvider.focusSearch();
    }),

    vscode.commands.registerCommand("tablify.saveView", () => provider.saveActiveView()),
    vscode.commands.registerCommand("tablify.saveFilter", () => provider.saveActiveFilter()),
    vscode.commands.registerCommand("tablify.resetView", () => provider.resetActiveView()),

    vscode.commands.registerCommand("tablify.clearFilter", () => {
      provider.postToActive({ type: "clearFilter" });
      logProvider.clearFilter();
    }),
  );
}

export function deactivate() {}
