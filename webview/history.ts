// Popup for one entry: what changed since the last commit, and git blame per
// field (loaded lazily when the popup opens).

import type { BlameCommit, BlameResult, Cell, FieldChangeKind, Row, RowChange } from "../src/messages.ts";
import { stripTags } from "./attributes.ts";
import { cellText, escapeHtml, isHtml } from "./format.ts";

export interface HistoryOptions {
  title: string;
  row: Row;
  change: RowChange | undefined;
  /** Fields in column order, with their display labels. */
  fields: { name: string; label: string }[];
  loadBlame(): Promise<BlameResult>;
  onReveal(): void;
}

const MAX_VALUE = 90;
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

export function timeAgo(seconds: number, now = Date.now() / 1000): string {
  const delta = seconds - now;
  for (const [unit, size] of UNITS) {
    if (Math.abs(delta) >= size) return relative.format(Math.round(delta / size), unit);
  }
  return "just now";
}

function preview(value: Cell | undefined): string {
  const text = isHtml(value) ? stripTags(value) : cellText(value).replace(/\s+/g, " ");
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text;
}

const KIND_LABEL: Record<FieldChangeKind, string> = { added: "new", modified: "changed", removed: "removed" };

let open: { close(): void } | null = null;

export function closeHistory() {
  open?.close();
}

export function showHistory(anchor: HTMLElement, options: HistoryOptions) {
  closeHistory();
  const { row, change } = options;

  const panel = document.createElement("div");
  panel.className = "history-popup";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", `History of ${options.title}`);

  const status = change?.status ?? "unchanged";
  const statusLabel = { added: "New since last commit", modified: "Changed since last commit", unchanged: "Unchanged since last commit" }[status];
  panel.innerHTML = `
    <div class="history-header">
      <span class="history-title">${escapeHtml(options.title)}</span>
      <span class="history-status ${status}">${statusLabel}</span>
      <button type="button" class="history-close" title="Close (Escape)" aria-label="Close">×</button>
    </div>
    <div class="history-body"></div>
    <div class="history-footer">
      <span class="history-note">Blame includes unsaved changes</span>
      <button type="button" class="history-reveal">Show in Text Editor</button>
    </div>`;

  // Fields in column order, then fields that were removed since the last commit.
  const names = options.fields.map((field) => field.name);
  const removed = Object.entries(change?.fields ?? {})
    .filter(([name, field]) => field.kind === "removed" && !names.includes(name))
    .map(([name]) => ({ name, label: name }));
  const fields = [...options.fields.filter((field) => field.name in row || change?.fields[field.name]), ...removed];

  const body = panel.querySelector<HTMLElement>(".history-body")!;
  const blameCells = new Map<string, HTMLElement>();
  for (const field of fields) {
    const fieldChange = change?.fields[field.name];
    const kind = fieldChange?.kind;
    const item = document.createElement("div");
    item.className = `history-field${kind ? ` ${kind}` : ""}`;

    const value =
      kind === "removed"
        ? `<span class="history-before">${escapeHtml(preview(fieldChange?.before))}</span>`
        : escapeHtml(preview(row[field.name])) || `<span class="history-empty">empty</span>`;
    const before =
      kind === "modified"
        ? `<div class="history-was">was <span class="history-before">${escapeHtml(preview(fieldChange?.before)) || "empty"}</span></div>`
        : "";
    item.innerHTML = `
      <div class="history-name" title="${escapeHtml(field.name)}">${escapeHtml(field.label)}${kind ? `<span class="history-kind">${KIND_LABEL[kind]}</span>` : ""}</div>
      <div class="history-value">${value}${before}</div>
      <div class="history-blame"><span class="history-loading">…</span></div>`;
    blameCells.set(field.name, item.querySelector<HTMLElement>(".history-blame")!);
    body.appendChild(item);
  }

  document.body.appendChild(panel);
  position(panel, anchor);

  const close = () => {
    if (open !== handle) return;
    open = null;
    panel.remove();
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const handle = { close };
  open = handle;
  const onOutside = (event: MouseEvent) => {
    if (!panel.contains(event.target as Node)) close();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  };
  document.addEventListener("mousedown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
  panel.querySelector(".history-close")!.addEventListener("click", close);
  panel.querySelector(".history-reveal")!.addEventListener("click", () => {
    close();
    options.onReveal();
  });

  void options.loadBlame().then((result) => {
    if (open !== handle) return;
    if (!result.ok) {
      for (const cell of blameCells.values()) cell.textContent = "";
      const error = document.createElement("div");
      error.className = "history-error";
      error.textContent = `Blame unavailable: ${result.message}`;
      body.prepend(error);
      return;
    }
    const byField = new Map(result.fields.map((field) => [field.field, field.commit]));
    let previous: string | undefined;
    for (const [name, cell] of blameCells) {
      const commit = byField.get(name);
      // Blame is line-based: a field whose lines were only deleted (e.g. a list
      // item) still blames to the old commit. The value diff is authoritative.
      const changed = change?.fields[name] !== undefined;
      cell.innerHTML = !commit ? "" : changed && !commit.uncommitted ? changedHtml(commit) : blameHtml(commit);
      // Same commit as the field above: dimmed, without repeating the commit line.
      const id = commit && !changed ? commit.hash : undefined;
      cell.classList.toggle("repeat", id !== undefined && id === previous);
      previous = id;
    }
    position(panel, anchor);
  });
}

function blameHtml(commit: BlameCommit): string {
  if (commit.uncommitted) {
    return `<div class="history-author uncommitted">Uncommitted change</div>`;
  }
  const date = new Date(commit.time * 1000);
  return `
    <div class="history-author" title="${escapeHtml(date.toLocaleString())}">${escapeHtml(commit.author)} · ${escapeHtml(timeAgo(commit.time))}</div>
    <div class="history-commit" title="${escapeHtml(commit.hash)}"><span class="history-hash">${commit.hash.slice(0, 7)}</span> ${escapeHtml(commit.summary)}</div>`;
}

function changedHtml(previous: BlameCommit): string {
  return `
    <div class="history-author uncommitted">Uncommitted change</div>
    <div class="history-commit" title="${escapeHtml(previous.hash)}">before: <span class="history-hash">${previous.hash.slice(0, 7)}</span> ${escapeHtml(previous.summary)}</div>`;
}

/** Next to the anchor (the change bar), kept inside the viewport. */
function position(panel: HTMLElement, anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect();
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const left = Math.min(rect.right + 6, window.innerWidth - width - 8);
  const top = Math.min(rect.top, window.innerHeight - height - 8);
  panel.style.left = `${Math.max(8, left)}px`;
  panel.style.top = `${Math.max(8, top)}px`;
}
