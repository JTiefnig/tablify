import "tabulator-tables/dist/css/tabulator.min.css";
import "./styles.css";

import type { ColumnComponent } from "tabulator-tables";
import type { BlameResult, SavedFilter, ToHost, ToWebview } from "../src/messages.ts";
import { buildFilter, clauseValue, formatClause, queryFields, setClause } from "./filter.ts";
import { setBaseUri } from "./format.ts";
import { closeHistory, showHistory } from "./history.ts";
import { suggest, type Suggestion } from "./suggest.ts";
import { TableView, type FilterOption, type ViewState } from "./table.ts";

interface VsCodeApi {
  postMessage(message: ToHost): void;
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface PersistedState extends ViewState {
  filter: string;
  filterOpen: boolean;
}

const vscode = acquireVsCodeApi();
const state: PersistedState = {
  filter: "",
  filterOpen: false,
  widths: {},
  scrollTop: 0,
  scrollLeft: 0,
  ...vscode.getState(),
};

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => vscode.setState(state), 150);
}

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const widgetEl = byId<HTMLDivElement>("filter-widget");
const filterEl = byId<HTMLInputElement>("filter");
const suggestEl = byId<HTMLDivElement>("filter-suggest");
const clearFilterEl = byId<HTMLButtonElement>("clear-filter");
const savedFiltersEl = byId<HTMLButtonElement>("saved-filters");
const matchCountEl = byId<HTMLSpanElement>("match-count");
const tableEl = byId<HTMLElement>("table");
const messageEl = byId<HTMLElement>("message");
const messageTitleEl = byId<HTMLDivElement>("message-title");
const messageTextEl = byId<HTMLDivElement>("message-text");

let counts = { shown: 0, total: 0 };
/** Document version of the displayed rows; sent with edits so stale edits are rejected. */
let version = 0;

const table = new TableView(tableEl, {
  onHeaderClick: (column, options) => {
    if (options.length > 0) {
      showFilterDropdown(column, options);
      return;
    }
    const field = column.getField();
    if (!queryFields(filterEl.value, [field]).has(field)) {
      setQuery(filterEl.value.trim() ? `${filterEl.value.trim()} AND ${field}=` : `${field}=`);
    }
    openFilter();
  },
  onReveal: (index) => vscode.postMessage({ type: "reveal", index }),
  onShowHistory: (index, anchor) => {
    const row = table.row(index);
    if (!row) return;
    const id = table.fields.includes("id") ? row.id : undefined;
    showHistory(anchor, {
      title: id !== undefined && id !== null ? String(id) : `Row ${index + 1}`,
      row,
      change: table.changes[index],
      fields: table.visible.map((name) => ({ name, label: table.label(name) })),
      loadBlame: () => requestBlame(index),
      onReveal: () => vscode.postMessage({ type: "reveal", index }),
    });
  },
  onInsertRow: (index, placement) => {
    const id = newRowId();
    pendingReveal = id;
    vscode.postMessage({ type: "insertRow", version, index, placement, id });
  },
  onDeleteRow: (index) => vscode.postMessage({ type: "deleteRow", version, index }),
  onMoveRow: (index, target, placement) => vscode.postMessage({ type: "moveRow", version, index, target, placement }),
  onLayoutChanged: (layout, modified) => {
    saveState();
    vscode.postMessage({ type: "layout", layout, modified });
  },
  onSaveView: () => vscode.postMessage({ type: "saveView" }),
  onChangesOnlyChanged: () => {
    saveState();
    postFilterState();
  },
  onEdit: (index, field, value, remove) =>
    vscode.postMessage({ type: "edit", version, index, field, value, remove }),
  onCountChanged: (shown, total) => {
    counts = { shown, total };
    matchCountEl.textContent = `${shown} of ${total}`;
    postFilterState();
  },
  onColumnResized: (field, width) => {
    state.widths[field] = width;
    table.emitLayout();
  },
  onScroll: (top, left) => {
    state.scrollTop = top;
    state.scrollLeft = left;
    saveState();
  },
});

// --- New rows ------------------------------------------------------------------------

/** ID of a just-added row, to scroll to once the host sends the updated rows. */
let pendingReveal: string | null = null;

const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** Short random ID (8 characters, no look-alike characters), unique among the current rows. */
function newRowId(): string {
  const existing = table.stringValues();
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const id = Array.from(bytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
    if (!existing.has(id)) return id;
  }
}

// --- Git blame (lazy, cached per document version) -------------------------------

let nextRequestId = 1;
const pendingBlame = new Map<number, (result: BlameResult) => void>();
const blameCache = new Map<string, Promise<BlameResult>>();

function requestBlame(index: number): Promise<BlameResult> {
  const key = `${version}:${index}`;
  let result = blameCache.get(key);
  if (!result) {
    const requestId = nextRequestId++;
    result = new Promise<BlameResult>((resolve) => pendingBlame.set(requestId, resolve));
    blameCache.set(key, result);
    vscode.postMessage({ type: "blame", requestId, index });
  }
  return result;
}

// --- Filter ----------------------------------------------------------------------

function postFilterState() {
  const query = filterEl.value.trim();
  const changes = table.isChangesOnly() ? "changes since last commit" : "";
  vscode.postMessage({ type: "filterState", query: [changes, query].filter(Boolean).join(" AND "), ...counts });
}

function applyFilter() {
  const query = filterEl.value;
  const fields = table.fields;
  table.setFilter(buildFilter(query, fields, table.attributes));
  table.setLinkedFields(queryFields(query, fields));
  clearFilterEl.disabled = !query;
  updateSavedFiltersButton();
  state.filter = query;
  saveState();
  postFilterState();
}

function setQuery(query: string) {
  filterEl.value = query;
  applyFilter();
}

function openFilter() {
  widgetEl.hidden = false;
  state.filterOpen = true;
  saveState();
  filterEl.focus();
  filterEl.select();
}

function closeFilter() {
  hideSuggestions();
  widgetEl.hidden = true;
  state.filterOpen = false;
  saveState();
  tableEl.querySelector<HTMLElement>(".tabulator-tableholder")?.focus();
}

filterEl.value = state.filter;
clearFilterEl.disabled = !state.filter;
widgetEl.hidden = !state.filterOpen;

filterEl.addEventListener("input", () => {
  applyFilter();
  showSuggestions();
});
clearFilterEl.addEventListener("click", () => {
  setQuery("");
  filterEl.focus();
});
byId<HTMLButtonElement>("close-filter").addEventListener("click", closeFilter);

// --- Saved filters ---------------------------------------------------------------

/** Saved filters of the file's view (`filters` in .vscode/tablify.yaml). */
let savedFilters: SavedFilter[] = [];

function currentSavedFilter(): SavedFilter | undefined {
  const query = filterEl.value.trim();
  return query ? savedFilters.find((filter) => filter.query.trim() === query) : undefined;
}

function updateSavedFiltersButton() {
  const current = currentSavedFilter();
  savedFiltersEl.classList.toggle("saved", !!current);
  savedFiltersEl.title = current ? `Saved Filters (current: ${current.name})` : "Saved Filters";
}

function menuItem(label: string, onSelect: () => void): HTMLDivElement {
  const item = document.createElement("div");
  item.className = "filter-dropdown-item";
  item.setAttribute("role", "menuitem");
  const name = document.createElement("span");
  name.className = "saved-filter-name";
  name.textContent = label;
  item.appendChild(name);
  item.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeFilterDropdown();
    onSelect();
  });
  return item;
}

function showSavedFilters() {
  closeFilterDropdown();
  const rect = savedFiltersEl.getBoundingClientRect();
  const current = currentSavedFilter();

  const menu = document.createElement("div");
  menu.className = "filter-dropdown saved-filters-menu";
  menu.setAttribute("role", "menu");
  menu.style.top = `${rect.bottom + 2}px`;

  const title = document.createElement("div");
  title.className = "filter-dropdown-title";
  title.textContent = "Saved filters";
  menu.appendChild(title);

  if (savedFilters.length === 0) {
    const notice = document.createElement("div");
    notice.className = "filter-dropdown-notice";
    notice.textContent = "No saved filters";
    menu.appendChild(notice);
  }
  for (const filter of savedFilters) {
    const item = menuItem(filter.name, () => {
      setQuery(filter.query);
      filterEl.focus();
    });
    item.title = filter.query;
    item.classList.toggle("active", filter === current);
    const remove = document.createElement("span");
    remove.className = "saved-filter-delete";
    remove.textContent = "×";
    remove.title = "Delete saved filter";
    remove.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeFilterDropdown();
      vscode.postMessage({ type: "deleteFilter", name: filter.name });
    });
    item.appendChild(remove);
    menu.appendChild(item);
  }

  const separator = document.createElement("div");
  separator.className = "filter-dropdown-separator";
  menu.appendChild(separator);
  const save = menuItem("Save Current Filter…", () =>
    vscode.postMessage({ type: "saveFilter", query: filterEl.value.trim() }),
  );
  save.classList.toggle("disabled", !filterEl.value.trim());
  menu.appendChild(save);

  document.body.appendChild(menu);
  dropdown = menu;
  // Right-aligned with the button, kept inside the window.
  menu.style.left = `${Math.max(8, Math.min(rect.right, window.innerWidth - 8) - menu.getBoundingClientRect().width)}px`;
}

savedFiltersEl.addEventListener("click", () => {
  if (dropdown?.classList.contains("saved-filters-menu")) {
    closeFilterDropdown();
  } else {
    showSavedFilters();
  }
});

// --- Autocomplete ----------------------------------------------------------------

let suggestions: Suggestion[] = [];
let selected = 0;

function hideSuggestions() {
  suggestions = [];
  suggestEl.hidden = true;
  suggestEl.replaceChildren();
}

function renderSuggestions() {
  suggestEl.replaceChildren(
    ...suggestions.map((suggestion, index) => {
      const item = document.createElement("div");
      item.className = `filter-dropdown-item${index === selected ? " active" : ""}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === selected));
      item.textContent = suggestion.label;
      const kind = document.createElement("span");
      kind.className = "suggest-kind";
      kind.textContent = suggestion.kind;
      item.appendChild(kind);
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        acceptSuggestion(suggestion);
      });
      return item;
    }),
  );
  suggestEl.hidden = suggestions.length === 0;
}

function showSuggestions() {
  suggestions = suggest(filterEl.value, filterEl.selectionStart ?? filterEl.value.length, table.fields, table.options);
  selected = 0;
  renderSuggestions();
}

function acceptSuggestion(suggestion: Suggestion) {
  filterEl.value = suggestion.text;
  filterEl.setSelectionRange(suggestion.caret, suggestion.caret);
  applyFilter();
  // Accepting a field continues straight into its values.
  if (suggestion.kind === "field") {
    showSuggestions();
  } else {
    hideSuggestions();
  }
}

filterEl.addEventListener("keydown", (event) => {
  if (suggestions.length === 0) {
    if (event.key === "ArrowDown") {
      showSuggestions();
      event.preventDefault();
    }
    return;
  }
  switch (event.key) {
    case "ArrowDown":
    case "ArrowUp":
      selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length;
      renderSuggestions();
      break;
    case "Tab":
    case "Enter":
      acceptSuggestion(suggestions[selected]);
      break;
    case "Escape":
      hideSuggestions();
      break;
    default:
      return;
  }
  event.preventDefault();
  event.stopPropagation();
});
filterEl.addEventListener("blur", hideSuggestions);

// --- Keyboard ----------------------------------------------------------------------

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
    event.preventDefault();
    openFilter();
    return;
  }
  if (event.key === "Escape") {
    if (dropdown) {
      closeFilterDropdown();
    } else if (!widgetEl.hidden) {
      closeFilter();
    }
  }
});

// --- Header filter dropdown --------------------------------------------------

let dropdown: HTMLElement | null = null;

function closeFilterDropdown() {
  dropdown?.remove();
  dropdown = null;
}

function showFilterDropdown(column: ColumnComponent, options: FilterOption[]) {
  closeFilterDropdown();
  const field = column.getField();
  const rect = column.getElement().getBoundingClientRect();
  const active = clauseValue(filterEl.value, field);

  const menu = document.createElement("div");
  menu.className = "filter-dropdown";
  menu.style.top = `${rect.bottom + 2}px`;
  menu.style.left = `${rect.left}px`;

  const title = document.createElement("div");
  title.className = "filter-dropdown-title";
  title.textContent = `Filter by ${field.replace(/_/g, " ")}`;
  menu.appendChild(title);

  for (const option of options) {
    const item = document.createElement("div");
    const isActive = active === option.value.toLowerCase();
    item.className = `filter-dropdown-item${isActive ? " active" : ""}`;
    item.textContent = option.label;
    item.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const clause = isActive ? null : formatClause(field, option.operator, option.value);
      setQuery(setClause(filterEl.value, field, clause));
      closeFilterDropdown();
      openFilter();
    });
    menu.appendChild(item);
  }

  document.body.appendChild(menu);
  dropdown = menu;

  const menuRect = menu.getBoundingClientRect();
  if (menuRect.right > window.innerWidth - 8) {
    menu.style.left = `${Math.max(8, window.innerWidth - menuRect.width - 8)}px`;
  }
}

document.addEventListener("mousedown", (event) => {
  // The saved filters button toggles its menu itself.
  if (dropdown && !dropdown.contains(event.target as Node) && !savedFiltersEl.contains(event.target as Node)) {
    closeFilterDropdown();
  }
});
window.addEventListener("resize", closeFilterDropdown);

// --- Links in cells ----------------------------------------------------------

tableEl.addEventListener("click", (event) => {
  const link = (event.target as Element).closest?.("a[href]");
  if (link) {
    event.preventDefault();
    vscode.postMessage({ type: "openLink", href: link.getAttribute("href") ?? "" });
  }
});

// --- Host messages -----------------------------------------------------------

const ERROR_TITLES = {
  syntax: "Could not parse this file",
  shape: "Not a table file",
  empty: "Empty file",
};

byId<HTMLButtonElement>("open-as-text").addEventListener("click", () =>
  vscode.postMessage({ type: "openAsText" }),
);

const showDataPathEl = byId<HTMLButtonElement>("show-data-path");
/** Data path offered by the last error message. */
let suggestedPath: string[] | null = null;
showDataPathEl.addEventListener("click", () => {
  if (suggestedPath) vscode.postMessage({ type: "showDataPath", segments: suggestedPath });
});

window.addEventListener("message", (event: MessageEvent<ToWebview>) => {
  const message = event.data;

  switch (message.type) {
    case "focusFilter":
      openFilter();
      return;
    case "blame":
      pendingBlame.get(message.requestId)?.(message.result);
      pendingBlame.delete(message.requestId);
      return;
    case "clearFilter":
      table.setChangesOnly(false);
      setQuery("");
      return;
    case "resetLayout":
      table.resetLayout();
      return;
    case "error":
      // Keep the last good table hidden, so fixing a typo restores the view in place.
      tableEl.hidden = true;
      messageEl.hidden = false;
      messageTitleEl.textContent = ERROR_TITLES[message.kind];
      messageTextEl.textContent = message.message;
      suggestedPath = message.suggestedPath?.segments ?? null;
      showDataPathEl.hidden = !suggestedPath;
      showDataPathEl.textContent = message.suggestedPath ? `Show ${message.suggestedPath.label}` : "";
      return;
    case "data":
      messageEl.hidden = true;
      tableEl.hidden = false;
      // Blame can change with the text and with commits (which keep the version).
      blameCache.clear();
      if (message.version !== version) {
        closeHistory();
      }
      version = message.version;
      savedFilters = message.view?.filters ?? [];
      setBaseUri(message.baseUri);
      table.setData(message.rows, message.fields, message.view, state, {
        enabled: message.git,
        changes: message.changes,
        deleted: message.deleted,
      });
      if (pendingReveal && message.rows.some((row) => row.id === pendingReveal)) {
        table.revealRowById(pendingReveal);
        pendingReveal = null;
      }
      applyFilter();
      if (message.rows.length === 0) {
        table.callbacks.onCountChanged(0, 0);
      }
      return;
  }
});

vscode.postMessage({ type: "ready" });
