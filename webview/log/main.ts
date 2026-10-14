import "./styles.css";

import {
  EMPTY_QUERY,
  type ColumnInfo,
  type LevelKey,
  type LogQuery,
  type RecordDetail,
  type ToLogHost,
  type ToLogWebview,
  type WindowRow,
} from "../../src/log/messages.ts";
import { LEVELS } from "../../src/log/types.ts";
import { LogGrid } from "./grid.ts";

interface VsCodeApi {
  postMessage(message: ToLogHost): void;
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface PersistedState {
  query: LogQuery;
  /** Columns hidden / shown by the user (on top of the defaults). */
  hidden: string[];
  shown: string[];
  widths: Record<string, number>;
  scrollTop: number;
  selected: number | null;
}

const vscode = acquireVsCodeApi();
const state: PersistedState = {
  query: { ...EMPTY_QUERY },
  hidden: [],
  shown: [],
  widths: {},
  scrollTop: 0,
  selected: null,
  ...vscode.getState(),
};

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => vscode.setState(state), 150);
}

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const searchEl = byId<HTMLInputElement>("search");
const allFieldsEl = byId<HTMLInputElement>("all-fields");
const levelsEl = byId<HTMLDivElement>("levels");
const timeEl = byId<HTMLDivElement>("time");
const fromEl = byId<HTMLInputElement>("time-from");
const toEl = byId<HTMLInputElement>("time-to");
const timeClearEl = byId<HTMLButtonElement>("time-clear");
const countEl = byId<HTMLSpanElement>("count");
const columnsEl = byId<HTMLButtonElement>("columns");
const formatEl = byId<HTMLButtonElement>("format");
const progressEl = byId<HTMLDivElement>("progress");
const progressBarEl = byId<HTMLDivElement>("progress-bar");
const noticeEl = byId<HTMLDivElement>("notice");
const messageEl = byId<HTMLElement>("message");
const messageTitleEl = byId<HTMLDivElement>("message-title");
const messageTextEl = byId<HTMLDivElement>("message-text");
const messageActionsEl = byId<HTMLDivElement>("message-actions");
const gridEl = byId<HTMLElement>("grid");
const toolbarEl = byId<HTMLElement>("toolbar");
const detailEl = byId<HTMLElement>("detail");
const detailTitleEl = byId<HTMLSpanElement>("detail-title");
const detailBodyEl = byId<HTMLDivElement>("detail-body");

const number = (value: number) => value.toLocaleString();

// --- Host state ------------------------------------------------------------------------

let columns: ColumnInfo[] = [];
let columnsKey = "";
let generation = -1;
let restoreScroll = true;
let levelCounts: Partial<Record<LevelKey, number>> = {};

function sendQuery() {
  saveState();
  vscode.postMessage({ type: "query", query: state.query });
}

// --- Grid --------------------------------------------------------------------------------

const grid = new LogGrid(gridEl, byId("grid-header"), byId("grid-body"), {
  requestRows: (start, count) => vscode.postMessage({ type: "rows", generation, start, count }),
  onSelect: (row) => {
    state.selected = row?.index ?? null;
    saveState();
    showDetail(row);
  },
  onActivate: (row) => vscode.postMessage({ type: "reveal", index: row.index }),
  onSort: (column) => {
    const sort = state.query.sort;
    // Ascending, descending, then file order again.
    state.query.sort =
      !column || (sort?.column === column && sort.descending)
        ? null
        : { column, descending: sort?.column === column };
    applyColumns(true);
    sendQuery();
  },
  onHeaderMenu: (event, column) => showColumnMenu(event.clientX, event.clientY, column),
  onResize: (column, width) => {
    state.widths[column] = width;
    saveState();
  },
  onScroll: (top) => {
    state.scrollTop = top;
    saveState();
  },
});
grid.restoreSelection(state.selected);

function visibleColumns(): ColumnInfo[] {
  const hidden = new Set(state.hidden);
  const shown = new Set(state.shown);
  const visible = columns.filter((column) => shown.has(column.name) || (!hidden.has(column.name) && !column.hiddenByDefault));
  return visible.length > 0 ? visible : columns.slice(0, 1);
}

function applyColumns(force = false) {
  const visible = visibleColumns();
  const key = JSON.stringify([visible.map((column) => column.name), state.query.sort]);
  if (!force && key === columnsKey) return;
  columnsKey = key;
  grid.setColumns(visible, state.widths, state.query.sort);
}

// --- Search --------------------------------------------------------------------------------

let searchTimer: ReturnType<typeof setTimeout> | undefined;
searchEl.value = state.query.text;
allFieldsEl.checked = state.query.allFields;

function applySearch() {
  clearTimeout(searchTimer);
  if (state.query.text === searchEl.value) return;
  state.query.text = searchEl.value;
  sendQuery();
}

searchEl.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(applySearch, 200);
});
searchEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") applySearch();
  if (event.key === "Escape" && searchEl.value) {
    searchEl.value = "";
    applySearch();
    event.stopPropagation();
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    grid.focus();
  }
});
allFieldsEl.addEventListener("change", () => {
  state.query.allFields = allFieldsEl.checked;
  sendQuery();
});

// --- Levels ----------------------------------------------------------------------------------

const LEVEL_KEYS: LevelKey[] = [...LEVELS, "none"];
const LEVEL_LABELS: Record<LevelKey, string> = {
  trace: "Trace",
  debug: "Debug",
  info: "Info",
  warn: "Warn",
  error: "Error",
  fatal: "Fatal",
  none: "Other",
};

function levelShown(level: LevelKey): boolean {
  return !state.query.levels || state.query.levels.includes(level);
}

function toggleLevel(level: LevelKey, only: boolean) {
  const current = state.query.levels ?? LEVEL_KEYS;
  let next: LevelKey[];
  if (only) {
    // Only this level; again: all levels.
    next = current.length === 1 && current[0] === level ? LEVEL_KEYS : [level];
  } else {
    next = current.includes(level) ? current.filter((item) => item !== level) : [...current, level];
  }
  state.query.levels = LEVEL_KEYS.every((item) => next.includes(item)) ? null : next;
  renderLevels();
  sendQuery();
}

function renderLevels() {
  const present = LEVEL_KEYS.filter((level) => (levelCounts[level] ?? 0) > 0 || !levelShown(level));
  // Without any levels (e.g. plain text), the chips would only say "Other".
  levelsEl.hidden = present.length === 0 || (present.length === 1 && present[0] === "none" && !state.query.levels);
  levelsEl.replaceChildren(
    ...LEVEL_KEYS.filter((level) => level !== "none" || present.includes("none")).map((level) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `chip chip-${level}`;
      chip.setAttribute("aria-pressed", String(levelShown(level)));
      chip.title = `Show or hide ${LEVEL_LABELS[level].toLowerCase()} entries · Alt+click: only this level`;
      const dot = document.createElement("span");
      dot.className = "dot";
      const label = document.createElement("span");
      label.textContent = LEVEL_LABELS[level];
      const count = document.createElement("span");
      count.className = "chip-count";
      count.textContent = number(levelCounts[level] ?? 0);
      chip.append(dot, label, count);
      chip.addEventListener("click", (event) => toggleLevel(level, event.altKey || event.metaKey || event.ctrlKey));
      return chip;
    }),
  );
}

// --- Time range ------------------------------------------------------------------------------

/** Epoch ms -> `datetime-local` value (local time, seconds). */
function toLocalInput(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function fromLocalInput(value: string, end: boolean): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return null;
  // Inputs have second precision: "to" includes the whole second.
  return end ? time + 999 : time;
}

function syncTimeInputs() {
  fromEl.value = state.query.from !== null ? toLocalInput(state.query.from) : "";
  toEl.value = state.query.to !== null ? toLocalInput(state.query.to) : "";
  timeClearEl.disabled = state.query.from === null && state.query.to === null;
}

function onTimeChange() {
  state.query.from = fromLocalInput(fromEl.value, false);
  state.query.to = fromLocalInput(toEl.value, true);
  timeClearEl.disabled = state.query.from === null && state.query.to === null;
  sendQuery();
}

fromEl.addEventListener("change", onTimeChange);
toEl.addEventListener("change", onTimeChange);
timeClearEl.addEventListener("click", () => {
  state.query.from = null;
  state.query.to = null;
  syncTimeInputs();
  sendQuery();
});
syncTimeInputs();

// --- Column menu -------------------------------------------------------------------------------

let menu: HTMLElement | null = null;

function closeMenu() {
  menu?.remove();
  menu = null;
}

function menuItem(label: string, onSelect: () => void, options: { checked?: boolean; disabled?: boolean } = {}): HTMLElement {
  const item = document.createElement("div");
  item.className = `menu-item${options.disabled ? " disabled" : ""}`;
  item.setAttribute("role", options.checked === undefined ? "menuitem" : "menuitemcheckbox");
  if (options.checked !== undefined) item.setAttribute("aria-checked", String(options.checked));
  const check = document.createElement("span");
  check.className = "menu-check";
  check.textContent = options.checked ? "✓" : "";
  const text = document.createElement("span");
  text.textContent = label;
  item.append(check, text);
  item.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!options.disabled) onSelect();
  });
  return item;
}

function setColumnVisible(name: string, visible: boolean) {
  state.hidden = state.hidden.filter((item) => item !== name);
  state.shown = state.shown.filter((item) => item !== name);
  const column = columns.find((item) => item.name === name);
  const byDefault = column ? !column.hiddenByDefault : true;
  if (visible !== byDefault) (visible ? state.shown : state.hidden).push(name);
  saveState();
  applyColumns();
}

function showColumnMenu(x: number, y: number, column?: string) {
  closeMenu();
  const element = document.createElement("div");
  element.className = "menu";
  element.setAttribute("role", "menu");
  const visible = new Set(visibleColumns().map((item) => item.name));
  const rerender = () => showColumnMenu(x, y, column);

  if (column) {
    element.appendChild(
      menuItem(`Hide “${column}”`, () => {
        setColumnVisible(column, false);
        closeMenu();
      }, { disabled: visible.size <= 1 }),
    );
    element.appendChild(separator());
  }
  const title = document.createElement("div");
  title.className = "menu-title";
  title.textContent = "Columns";
  element.appendChild(title);
  for (const item of columns) {
    const shown = visible.has(item.name);
    element.appendChild(
      menuItem(item.name, () => {
        setColumnVisible(item.name, !shown);
        rerender();
      }, { checked: shown, disabled: shown && visible.size <= 1 }),
    );
  }
  element.appendChild(separator());
  element.appendChild(
    menuItem("Reset Columns", () => {
      state.hidden = [];
      state.shown = [];
      state.widths = {};
      saveState();
      applyColumns(true);
      closeMenu();
    }),
  );

  document.body.appendChild(element);
  menu = element;
  const rect = element.getBoundingClientRect();
  element.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  element.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
}

function separator(): HTMLElement {
  const element = document.createElement("div");
  element.className = "menu-separator";
  return element;
}

columnsEl.addEventListener("click", () => {
  if (menu) {
    closeMenu();
    return;
  }
  const rect = columnsEl.getBoundingClientRect();
  showColumnMenu(rect.right - 200, rect.bottom + 2);
});
document.addEventListener("mousedown", (event) => {
  if (menu && !menu.contains(event.target as Node) && !columnsEl.contains(event.target as Node)) closeMenu();
});
window.addEventListener("resize", closeMenu);

formatEl.addEventListener("click", () => vscode.postMessage({ type: "selectFormat" }));

// --- Detail pane --------------------------------------------------------------------------------

let detail: RecordDetail | null = null;

function showDetail(row: WindowRow | null) {
  if (!row) {
    detailEl.hidden = true;
    detail = null;
    return;
  }
  if (detail?.index === row.index && !detailEl.hidden) return;
  detail = null;
  detailEl.hidden = false;
  detailTitleEl.textContent = lineLabel(row.line, row.line + row.lines - 1);
  detailBodyEl.replaceChildren();
  vscode.postMessage({ type: "detail", index: row.index });
}

function lineLabel(line: number, lineEnd: number): string {
  return lineEnd > line ? `Lines ${number(line)}–${number(lineEnd)}` : `Line ${number(line)}`;
}

function renderDetail(value: RecordDetail) {
  if (grid.selection !== value.index) return;
  detail = value;
  const parts = [lineLabel(value.line, value.lineEnd)];
  if (value.level) parts.push(value.level);
  if (value.epochMs !== undefined) parts.push(new Date(value.epochMs).toLocaleString());
  if (value.error) parts.push("does not match the format");
  detailTitleEl.textContent = parts.join(" · ");
  detailTitleEl.className = `detail-title${value.level ? ` text-${value.level}` : ""}`;

  const fields = document.createElement("dl");
  fields.className = "detail-fields";
  let message: string | null = null;
  for (const { name, value: text } of value.fields) {
    if (name === value.messageField) {
      message = text;
      continue;
    }
    const term = document.createElement("dt");
    term.textContent = name;
    const definition = document.createElement("dd");
    definition.textContent = text;
    fields.append(term, definition);
  }
  const pre = document.createElement("pre");
  pre.className = "detail-message";
  pre.textContent = message ?? value.raw;
  detailBodyEl.replaceChildren(...(fields.childElementCount > 0 ? [fields] : []), pre);
}

byId<HTMLButtonElement>("detail-close").addEventListener("click", () => {
  grid.clearSelection();
  grid.focus();
});
byId<HTMLButtonElement>("detail-reveal").addEventListener("click", () => {
  if (grid.selection !== null) vscode.postMessage({ type: "reveal", index: grid.selection });
});
byId<HTMLButtonElement>("detail-copy").addEventListener("click", () => {
  if (detail) void navigator.clipboard.writeText(detail.raw);
});

// --- Keyboard ----------------------------------------------------------------------------------

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
    event.preventDefault();
    searchEl.focus();
    searchEl.select();
    return;
  }
  if (event.key === "Escape") {
    if (menu) closeMenu();
    else if (!detailEl.hidden) grid.clearSelection();
  }
});

// --- Messages ----------------------------------------------------------------------------------

function showMessage(title: string, text: string, actions: { label: string; onClick: () => void }[]) {
  messageEl.hidden = false;
  toolbarEl.hidden = true;
  progressEl.hidden = true;
  noticeEl.hidden = true;
  gridEl.hidden = true;
  detailEl.hidden = true;
  messageTitleEl.textContent = title;
  messageTextEl.textContent = text;
  messageActionsEl.replaceChildren(
    ...actions.map(({ label, onClick }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", onClick);
      return button;
    }),
  );
}

const openAsText = { label: "Open as Text", onClick: () => vscode.postMessage({ type: "openAsText" }) };

function onState(message: Extract<ToLogWebview, { type: "state" }>) {
  messageEl.hidden = true;
  toolbarEl.hidden = false;
  gridEl.hidden = false;
  detailEl.hidden = grid.selection === null;
  generation = message.generation;
  levelCounts = message.levelCounts;

  const newColumns = JSON.stringify(message.columns);
  if (newColumns !== JSON.stringify(columns)) {
    columns = message.columns;
    applyColumns();
  }
  grid.setData(message.generation, message.count);
  if (restoreScroll && message.count > 0) {
    restoreScroll = false;
    gridEl.scrollTop = state.scrollTop;
  }

  renderLevels();
  const hasTime = message.timeRange !== null;
  timeEl.classList.toggle("disabled", !hasTime);
  fromEl.disabled = toEl.disabled = !hasTime && state.query.from === null && state.query.to === null;
  if (message.timeRange) {
    fromEl.min = toEl.min = toLocalInput(message.timeRange.min);
    fromEl.max = toEl.max = toLocalInput(message.timeRange.max + 1000);
    timeEl.title = `Entries from ${new Date(message.timeRange.min).toLocaleString()} to ${new Date(message.timeRange.max).toLocaleString()}`;
  } else {
    timeEl.title = "No timestamps found";
  }

  searchEl.classList.toggle("invalid", message.queryError !== null);
  searchEl.title = message.queryError ? `Invalid regular expression: ${message.queryError}` : "";

  const filtered = message.count !== message.total;
  countEl.textContent = message.loading
    ? `Loading… ${number(message.total)} entries`
    : filtered
      ? `${number(message.count)} of ${number(message.total)} entries`
      : `${number(message.total)} entries`;
  progressEl.hidden = !message.loading;
  progressBarEl.style.width = `${Math.round(message.progress * 100)}%`;

  formatEl.textContent = message.format.label;
  formatEl.title = `${message.format.detected ? "Detected" : "Selected"} log format · click to change`;
  noticeEl.hidden = !message.notice;
  noticeEl.textContent = message.notice ?? "";
}

window.addEventListener("message", (event: MessageEvent<ToLogWebview>) => {
  const message = event.data;
  switch (message.type) {
    case "state":
      onState(message);
      return;
    case "rows":
      grid.addRows(message.generation, message.start, message.rows);
      return;
    case "detail":
      renderDetail(message.detail);
      return;
    case "focusSearch":
      searchEl.focus();
      searchEl.select();
      return;
    case "error":
      showMessage("Could not read this file", message.message, [openAsText]);
      return;
    case "largeFile":
      showMessage(
        "Large file",
        `This file is ${message.sizeMB.toFixed(0)} MB. Loading all of it can take a while and needs a lot of memory.`,
        [
          { label: `First ${number(message.lines)} Lines`, onClick: () => vscode.postMessage({ type: "loadLarge", mode: "head" }) },
          { label: `Last ${number(message.lines)} Lines`, onClick: () => vscode.postMessage({ type: "loadLarge", mode: "tail" }) },
          { label: "Load All", onClick: () => vscode.postMessage({ type: "loadLarge", mode: "all" }) },
          openAsText,
        ],
      );
      return;
  }
});

vscode.postMessage({ type: "ready", query: state.query });
