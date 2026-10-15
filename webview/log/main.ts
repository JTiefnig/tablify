import "./styles.css";

import {
  EMPTY_QUERY,
  type ColumnInfo,
  type LogSort,
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
  filterOpen: boolean;
}

const vscode = acquireVsCodeApi();
const state: PersistedState = {
  query: { ...EMPTY_QUERY },
  hidden: [],
  shown: [],
  widths: {},
  scrollTop: 0,
  selected: null,
  filterOpen: false,
  ...vscode.getState(),
};
// Older states had a time range; it is not a filter any more.
state.query = { levels: state.query.levels, text: state.query.text, allFields: state.query.allFields, sort: state.query.sort };

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => vscode.setState(state), 150);
}

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const widgetEl = byId<HTMLDivElement>("filter-widget");
const searchEl = byId<HTMLInputElement>("search");
const allFieldsEl = byId<HTMLButtonElement>("all-fields");
const clearFilterEl = byId<HTMLButtonElement>("clear-filter");
const countEl = byId<HTMLSpanElement>("count");
const progressEl = byId<HTMLDivElement>("progress");
const progressBarEl = byId<HTMLDivElement>("progress-bar");
const noticeEl = byId<HTMLDivElement>("notice");
const messageEl = byId<HTMLElement>("message");
const messageTitleEl = byId<HTMLDivElement>("message-title");
const messageTextEl = byId<HTMLDivElement>("message-text");
const messageActionsEl = byId<HTMLDivElement>("message-actions");
const gridEl = byId<HTMLElement>("grid");
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
  clearFilterEl.disabled = !filterActive();
  vscode.postMessage({ type: "query", query: state.query });
}

function filterActive(): boolean {
  return state.query.text.trim() !== "" || state.query.levels !== null;
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
    setSort(
      !column || (sort?.column === column && sort.descending)
        ? null
        : { column, descending: sort?.column === column },
    );
  },
  onHeaderFilter: (cell) => {
    if (menu) {
      closeMenu();
      return;
    }
    const rect = cell.getBoundingClientRect();
    showLevelMenu(rect.left, rect.bottom + 2);
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
  const filtered = new Set(state.query.levels ? columns.filter((column) => column.role === "level").map((column) => column.name) : []);
  const key = JSON.stringify([visible.map((column) => column.name), state.query.sort, [...filtered]]);
  if (!force && key === columnsKey) return;
  columnsKey = key;
  grid.setColumns(visible, state.widths, state.query.sort, filtered);
}

function setSort(sort: LogSort | null) {
  state.query.sort = sort;
  applyColumns(true);
  sendQuery();
}

// --- Filter widget ---------------------------------------------------------------------

function openFilter() {
  widgetEl.hidden = false;
  state.filterOpen = true;
  saveState();
  searchEl.focus();
  searchEl.select();
}

function closeFilter() {
  widgetEl.hidden = true;
  state.filterOpen = false;
  saveState();
  grid.focus();
}

function clearFilter() {
  searchEl.value = "";
  state.query.text = "";
  state.query.levels = null;
  applyColumns();
  sendQuery();
}

widgetEl.hidden = !state.filterOpen;
clearFilterEl.disabled = !filterActive();
clearFilterEl.addEventListener("click", () => {
  clearFilter();
  searchEl.focus();
});
byId<HTMLButtonElement>("close-filter").addEventListener("click", closeFilter);

// --- Search --------------------------------------------------------------------------------

let searchTimer: ReturnType<typeof setTimeout> | undefined;
searchEl.value = state.query.text;
allFieldsEl.setAttribute("aria-pressed", String(state.query.allFields));

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
  if (event.key === "Escape" && !menu) {
    closeFilter();
    event.stopPropagation();
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    grid.focus();
  }
});
allFieldsEl.addEventListener("click", () => {
  state.query.allFields = !state.query.allFields;
  allFieldsEl.setAttribute("aria-pressed", String(state.query.allFields));
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
  applyColumns();
  sendQuery();
}

/** Levels listed in the level filter: those with entries, and those filtered out. */
function presentLevels(): LevelKey[] {
  return LEVEL_KEYS.filter((level) => (levelCounts[level] ?? 0) > 0 || !levelShown(level));
}

function showLevelMenu(x: number, y: number) {
  closeMenu();
  const element = document.createElement("div");
  element.className = "menu";
  element.setAttribute("role", "menu");
  const rerender = () => showLevelMenu(x, y);

  const title = document.createElement("div");
  title.className = "menu-title";
  title.textContent = "Filter by level · Alt+click: only this level";
  element.appendChild(title);
  element.appendChild(
    menuItem("All Levels", () => {
      state.query.levels = null;
      applyColumns();
      sendQuery();
      rerender();
    }, { checked: state.query.levels === null }),
  );
  element.appendChild(separator());
  for (const level of presentLevels()) {
    const item = menuItem(LEVEL_LABELS[level], (event) => {
      toggleLevel(level, event.altKey || event.metaKey || event.ctrlKey);
      rerender();
    }, { checked: levelShown(level), level, count: levelCounts[level] ?? 0 });
    element.appendChild(item);
  }
  placeMenu(element, x, y);
}

// --- Column menu -------------------------------------------------------------------------------

let menu: HTMLElement | null = null;

function closeMenu() {
  menu?.remove();
  menu = null;
}

interface MenuItemOptions {
  checked?: boolean;
  disabled?: boolean;
  /** Level color dot. */
  level?: LevelKey;
  count?: number;
}

function menuItem(label: string, onSelect: (event: MouseEvent) => void, options: MenuItemOptions = {}): HTMLElement {
  const item = document.createElement("div");
  item.className = `menu-item${options.disabled ? " disabled" : ""}`;
  item.setAttribute("role", options.checked === undefined ? "menuitem" : "menuitemcheckbox");
  if (options.checked !== undefined) item.setAttribute("aria-checked", String(options.checked));
  const check = document.createElement("span");
  check.className = "menu-check";
  check.textContent = options.checked ? "✓" : "";
  item.appendChild(check);
  if (options.level) {
    const dot = document.createElement("span");
    dot.className = `dot dot-${options.level}`;
    item.appendChild(dot);
  }
  const text = document.createElement("span");
  text.className = "menu-label";
  text.textContent = label;
  item.appendChild(text);
  if (options.count !== undefined) {
    const count = document.createElement("span");
    count.className = "menu-count";
    count.textContent = number(options.count);
    item.appendChild(count);
  }
  item.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!options.disabled) onSelect(event);
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
    const sort = state.query.sort?.column === column ? state.query.sort : null;
    element.append(
      menuItem("Sort Ascending", () => {
        setSort({ column, descending: false });
        closeMenu();
      }, { checked: sort?.descending === false }),
      menuItem("Sort Descending", () => {
        setSort({ column, descending: true });
        closeMenu();
      }, { checked: sort?.descending === true }),
      menuItem("File Order", () => {
        setSort(null);
        closeMenu();
      }, { disabled: !state.query.sort }),
      separator(),
      menuItem(`Hide “${column}”`, () => {
        setColumnVisible(column, false);
        closeMenu();
      }, { disabled: visible.size <= 1 }),
      separator(),
    );
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

  placeMenu(element, x, y);
}

function placeMenu(element: HTMLElement, x: number, y: number) {
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

document.addEventListener("mousedown", (event) => {
  // The level header toggles its menu itself.
  const target = event.target as Element;
  if (menu && !menu.contains(target) && !target.closest?.(".hcell.has-filter-options")) closeMenu();
});
window.addEventListener("resize", closeMenu);

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
    openFilter();
    return;
  }
  if (event.key === "Escape") {
    if (menu) closeMenu();
    else if (!detailEl.hidden) grid.clearSelection();
    else if (!widgetEl.hidden) closeFilter();
  }
});

// --- Messages ----------------------------------------------------------------------------------

function showMessage(title: string, text: string, actions: { label: string; onClick: () => void }[]) {
  messageEl.hidden = false;
  widgetEl.hidden = true;
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
  widgetEl.hidden = !state.filterOpen;
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

  searchEl.classList.toggle("invalid", message.queryError !== null);
  searchEl.title = message.queryError ? `Invalid regular expression: ${message.queryError}` : "";

  countEl.textContent = `${number(message.count)} of ${number(message.total)}`;
  progressEl.hidden = !message.loading;
  progressBarEl.style.width = `${Math.round(message.progress * 100)}%`;

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
      openFilter();
      return;
    case "clearFilter":
      clearFilter();
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
