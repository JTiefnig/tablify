// Tabulator setup. Columns come from the attribute definitions when there are
// any (order, label, width, type), and generically from the data fields otherwise.

import {
  TabulatorFull as Tabulator,
  type CellComponent,
  type ColumnComponent,
  type ColumnDefinition,
  type MenuObject,
  type MenuSeparator,
  type RowComponent,
} from "tabulator-tables";
import {
  ROW_INDEX,
  ROW_LOCKED,
  type Attribute,
  type ColumnLayout,
  type AttributeType,
  type Cell,
  type DeletedRow,
  type Row,
  type RowChange,
  type ViewSettings,
} from "../src/messages.ts";
import { attributeMap, itemsOf, type AttributeMap } from "./attributes.ts";
import {
  coerce,
  editMode,
  editorColumn,
  editType,
  openRichTextEditor,
  toggledBoolean,
} from "./editors.ts";
import { cellText, formatCell, isHtml } from "./format.ts";
import { GRIP_ICON, RowActions } from "./rowActions.ts";

export interface FilterOption {
  label: string;
  value: string;
  operator: "=" | "~";
}

export interface TableCallbacks {
  onHeaderClick(column: ColumnComponent, options: FilterOption[]): void;
  onReveal(index: number): void;
  /** A cell was edited; `remove` deletes the field from the row. */
  onEdit(index: number, field: string, value: Cell, remove: boolean): void;
  onCountChanged(shown: number, total: number): void;
  /** The baseline header was clicked: the "changes only" filter was switched. */
  onChangesOnlyChanged(on: boolean): void;
  /** The baseline of a row was clicked (git history). */
  onShowHistory(index: number, anchor: HTMLElement): void;
  /** A row action from the baseline: add above/below, delete, or a drag & drop move. */
  onInsertRow(index: number, placement: "above" | "below"): void;
  onDeleteRow(index: number): void;
  onMoveRow(index: number, target: number, placement: "above" | "below"): void;
  /** The effective column layout changed (or was rebuilt); `modified` = differs from the saved view. */
  onLayoutChanged(layout: ColumnLayout, modified: boolean): void;
  onSaveView(): void;
  onColumnResized(field: string, width: number): void;
  onScroll(top: number, left: number): void;
}

export interface GitState {
  /** The file is tracked by git: show the change bar. */
  enabled: boolean;
  /** Rows changed since the last commit, by row index; null while unknown. */
  changes: Record<number, RowChange> | null;
  /** Rows deleted since the last commit; null while unknown. */
  deleted: DeletedRow[] | null;
}

const BASELINE_FIELD = "__tablifyBaseline";
/** Marks a row deleted since the last commit (shown, read-only, in "changes only" mode). */
const ROW_DELETED = "__tablifyDeleted";

/** Per-tab view state; the column fields are unsaved changes on top of the configured view. */
export interface ViewState {
  widths: Record<string, number>;
  scrollTop: number;
  scrollLeft: number;
  /** Column order changed in this tab (dragged headers). */
  columns?: string[];
  /** Hidden columns changed in this tab. */
  hidden?: string[];
  /** Only rows changed since the last commit, including deleted ones. */
  changesOnly?: boolean;
}

const NO_LAYOUT: ColumnLayout = { columns: null, hidden: [], showOthers: true, widths: {} };

/** The configured layout with this tab's unsaved changes applied. */
function effectiveLayout(view: ViewSettings | null, state: ViewState): ColumnLayout {
  const saved = view?.layout ?? NO_LAYOUT;
  return {
    columns: state.columns ?? saved.columns,
    hidden: state.hidden ?? saved.hidden,
    showOthers: saved.showOthers,
    widths: { ...saved.widths, ...state.widths },
  };
}

function isModified(state: ViewState): boolean {
  return state.columns !== undefined || state.hidden !== undefined || Object.keys(state.widths).length > 0;
}

const MAX_FILTER_OPTIONS = 15;
const WRAP_THRESHOLD = 40;

const WRAP_TYPES = new Set(["text", "html", "multienum", "list"]);

/** Long or HTML text wraps; everything else stays on one line. */
function isWrapColumn(field: string, rows: Row[], attribute: Attribute | undefined): boolean {
  if (attribute) {
    return WRAP_TYPES.has(attribute.type);
  }
  let total = 0;
  for (const row of rows) {
    const value = row[field];
    if (isHtml(value)) {
      return true;
    }
    total += cellText(value).length;
  }
  return total / Math.max(rows.length, 1) > WRAP_THRESHOLD;
}

/**
 * Header dropdown values: the defined values of enums and booleans, otherwise
 * the distinct values of a column when there are few.
 */
function filterOptions(field: string, rows: Row[], attribute: Attribute | undefined): FilterOption[] {
  switch (attribute?.type) {
    case "enum":
    case "multienum":
      return attribute.values.map(({ value, label }) => ({ label, value, operator: "=" }));
    case "boolean":
      return [
        { label: "true", value: "true", operator: "=" },
        { label: "false", value: "false", operator: "=" },
      ];
    case "text":
    case "html":
      return [];
  }

  const values = new Set<string>();
  for (const row of rows) {
    for (const item of itemsOf(row[field], attribute)) {
      const text = item.trim();
      if (text && text.length <= WRAP_THRESHOLD) values.add(text);
    }
  }

  if (values.size < 2 || values.size > MAX_FILTER_OPTIONS) {
    return [];
  }
  return [...values]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((value) => ({ label: value, value, operator: "=" }));
}

/**
 * Columns in display order: the layout's `columns` (or else the defined
 * attributes), then the remaining fields in data order unless `showOthers` is
 * off; without hidden columns.
 */
function visibleFields(fields: string[], view: ViewSettings | null, layout: ColumnLayout): string[] {
  const present = new Set(fields);
  const listed = layout.columns ?? view?.attributes.map((attribute) => attribute.name) ?? [];
  const first = listed.filter((field) => present.has(field));
  const others = layout.showOthers ? fields.filter((field) => !first.includes(field)) : [];
  const hidden = new Set(layout.hidden);
  return [...first, ...others].filter((field) => !hidden.has(field));
}

function rowIndex(cell: CellComponent): number {
  return (cell.getRow().getData() as Row)[ROW_INDEX] as number;
}

function isDeleted(row: Row): boolean {
  return row[ROW_DELETED] === true;
}

/**
 * The deleted rows as read-only table rows, with negative indices (they have no
 * index in the file), each inserted after the row it followed.
 */
function withDeletedRows(rows: Row[], deleted: DeletedRow[]): Row[] {
  const after = new Map<number, Row[]>();
  deleted.forEach(({ row, after: index }, i) => {
    const ghost = { ...row, [ROW_INDEX]: -(i + 1), [ROW_LOCKED]: ["*"], [ROW_DELETED]: true };
    after.set(index, [...(after.get(index) ?? []), ghost]);
  });
  return [...(after.get(-1) ?? []), ...rows.flatMap((row) => [row, ...(after.get(row[ROW_INDEX] as number) ?? [])])];
}

/** Locked by the row itself: keys and nested data. */
function isRowLocked(cell: CellComponent): boolean {
  const locked = (cell.getRow().getData() as Row)[ROW_LOCKED];
  return Array.isArray(locked) && (locked.includes("*") || locked.includes(cell.getField()));
}

function overflowTooltip(_event: MouseEvent, cell: CellComponent): string {
  const element = cell.getElement();
  // The element can already be detached when a data refresh re-rendered the row.
  if (!element?.isConnected || (element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight)) {
    return "";
  }
  return (element.innerText ?? "").trim();
}

export class TableView {
  private readonly element: HTMLElement;
  readonly callbacks: TableCallbacks;
  private table: Tabulator | null = null;
  private built = false;
  private columnsKey = "";
  /** The filter query; combined with "changes only" in `applyFilter`. */
  private filter: ((row: Row) => boolean) | null = null;
  private pending: (() => void)[] = [];
  options = new Map<string, FilterOption[]>();
  /** All data fields (the filter can address hidden ones too). */
  fields: string[] = [];
  attributes: AttributeMap = new Map();
  /** Rows as read from the file, by row index; edits are compared against these. */
  private sourceRows = new Map<number, Row>();
  /** Edit type per visible column. */
  private editTypes = new Map<string, AttributeType>();
  /** Columns that cannot be edited (`readonlyColumns` and `readonly` attributes). */
  private readonlyFields = new Set<string>();
  /** Visible data columns, in order. */
  visible: string[] = [];
  changes: Record<number, RowChange> = {};

  private readonly rowActions: RowActions;

  constructor(element: HTMLElement, callbacks: TableCallbacks) {
    this.element = element;
    this.callbacks = callbacks;
    this.rowActions = new RowActions((action, index) => {
      if (action === "delete") callbacks.onDeleteRow(index);
      else callbacks.onInsertRow(index, action === "addAbove" ? "above" : "below");
    });
  }

  setData(sourceRows: Row[], fields: string[], view: ViewSettings | null, state: ViewState, git: GitState) {
    this.last = { sourceRows, fields, view, state, git };
    this.fields = fields;
    this.changes = git.changes ?? {};
    const changesOnly = this.changesOnly;
    this.attributes = attributeMap(view);
    this.readonlyFields = new Set([
      ...(view?.readonlyColumns ?? []),
      ...(view?.attributes ?? []).filter((attribute) => attribute.readonly).map((attribute) => attribute.name),
    ]);
    this.sourceRows = new Map(sourceRows.map((row) => [row[ROW_INDEX] as number, row]));
    const rows = this.tableRows(sourceRows);
    const shown = changesOnly && git.deleted ? this.tableRows(withDeletedRows(sourceRows, git.deleted)) : rows;
    const layout = effectiveLayout(view, state);
    const visible = visibleFields(fields, view, layout);
    this.visible = visible;
    this.callbacks.onLayoutChanged(layout, isModified(state));
    // Widths are not part of the key: resizing must not rebuild the table.
    const key = JSON.stringify([visible, view, git.enabled]);
    const wrapFields = new Set(
      visible.filter((field) => isWrapColumn(field, rows, this.attributes.get(field))),
    );

    this.editTypes = new Map(
      visible.map((field) => [field, editType(field, rows, this.attributes.get(field), wrapFields.has(field))]),
    );

    this.options = new Map(
      fields.map((field) => {
        const attribute = this.attributes.get(field);
        const generic = !attribute && wrapFields.has(field);
        return [field, generic ? [] : filterOptions(field, rows, attribute)];
      }),
    );

    if (this.table && key === this.columnsKey) {
      // Same columns (e.g. a live edit): keep scroll position and widths.
      this.whenBuilt(() => {
        this.markChangesOnly();
        this.applyFilter();
        void this.table?.replaceData(shown).then(() => this.updateCount());
      });
      this.whenBuilt(() => this.markFilterColumns());
      return;
    }

    this.destroy();
    this.columnsKey = key;
    this.createTable(shown, visible, wrapFields, state, layout, git.enabled);
  }

  /** "Changes only" is on and the changes are known. */
  private get changesOnly(): boolean {
    return !!this.last?.state.changesOnly && !!this.last.git.enabled && this.last.git.changes !== null;
  }

  /** Shows only rows changed since the last commit, including deleted rows. */
  setChangesOnly(on: boolean) {
    if (!this.last || !!this.last.state.changesOnly === on) return;
    this.last.state.changesOnly = on;
    this.callbacks.onChangesOnlyChanged(on);
    this.relayout();
  }

  isChangesOnly(): boolean {
    return this.changesOnly;
  }

  // --- Column layout -------------------------------------------------------------------

  private last: { sourceRows: Row[]; fields: string[]; view: ViewSettings | null; state: ViewState; git: GitState } | null = null;

  /** Rebuilds the table after a layout change, from the last data. */
  private relayout() {
    if (this.last) {
      const { sourceRows, fields, view, state, git } = this.last;
      this.setData(sourceRows, fields, view, state, git);
    }
  }

  /** Reports the current layout (e.g. after a column was resized). */
  emitLayout() {
    if (this.last) {
      const { view, state } = this.last;
      this.callbacks.onLayoutChanged(effectiveLayout(view, state), isModified(state));
    }
  }

  /** Drops this tab's unsaved layout changes (back to the configured view). */
  resetLayout() {
    if (!this.last) return;
    const { state } = this.last;
    delete state.columns;
    delete state.hidden;
    state.widths = {};
    this.columnsKey = "";
    this.relayout();
  }

  private hideColumn(field: string) {
    if (!this.last) return;
    const { state, view } = this.last;
    const hidden = state.hidden ?? view?.layout.hidden ?? [];
    state.hidden = [...hidden.filter((name) => name !== field), field];
    this.relayout();
  }

  private showColumn(field: string) {
    if (!this.last) return;
    const { state, view } = this.last;
    const layout = effectiveLayout(view, state);
    state.hidden = layout.hidden.filter((name) => name !== field);
    // Columns hidden by `otherColumns: hide` are added to the order to show them.
    if (layout.columns && !layout.columns.includes(field)) {
      state.columns = [...layout.columns, field];
    } else if (!layout.columns && !layout.showOthers) {
      state.columns = [...this.visible, field];
    }
    this.relayout();
  }

  /** Dragged headers: the new order becomes this tab's column order. */
  private onColumnMoved() {
    if (!this.last || !this.table) return;
    this.last.state.columns = this.table
      .getColumns()
      .map((column) => column.getField())
      .filter((field) => field && field !== BASELINE_FIELD);
    this.relayout();
  }

  private headerMenu(field: string): (MenuObject<ColumnComponent> | MenuSeparator)[] {
    const hiddenFields = this.fields.filter((name) => !this.visible.includes(name));
    const modified = this.last ? isModified(this.last.state) : false;
    return [
      { label: `Hide “${this.label(field)}”`, disabled: this.visible.length <= 1, action: () => this.hideColumn(field) },
      {
        label: "Show Column",
        disabled: hiddenFields.length === 0,
        menu: hiddenFields.map((name) => ({ label: this.label(name), action: () => this.showColumn(name) })),
      },
      { separator: true },
      { label: "Save View…", action: () => this.callbacks.onSaveView() },
      { label: "Reset View", disabled: !modified, action: () => this.resetLayout() },
    ];
  }

  /** Column title of a field. */
  label(field: string): string {
    return this.attributes.get(field)?.label ?? field;
  }

  /** Row as read from the file. */
  row(index: number): Row | undefined {
    return this.sourceRows.get(index);
  }

  /** All string cell values (to keep generated IDs unique). */
  stringValues(): Set<string> {
    const values = new Set<string>();
    for (const row of this.sourceRows.values()) {
      for (const value of Object.values(row)) {
        if (typeof value === "string") values.add(value);
      }
    }
    return values;
  }

  /**
   * Baseline: a narrow first column that is the drag handle for moving rows
   * and shows row actions (add above/below, delete) on hover. For files in
   * git it carries the change bar (green: new since the last commit, blue:
   * modified); clicking it opens the entry's history.
   */
  private baselineColumn(git: boolean): ColumnDefinition {
    const describe = (cell: CellComponent) => {
      const index = rowIndex(cell);
      if (!git) return "Drag to move";
      if (isDeleted(cell.getRow().getData() as Row)) return "Deleted since last commit";
      const change = this.changes[index];
      if (!change) return "Unchanged since last commit · click for history, drag to move";
      if (change.status === "added") return "New since last commit · click for history, drag to move";
      const fields = Object.keys(change.fields).map((field) => this.label(field));
      return `Changed since last commit: ${fields.join(", ")} · click for details, drag to move`;
    };
    return {
      field: BASELINE_FIELD,
      title: "",
      width: 18,
      minWidth: 18,
      resizable: false,
      frozen: true,
      rowHandle: true,
      cssClass: "baseline-column",
      headerTooltip: git
        ? () => (this.changesOnly ? "Showing changes since the last commit · click to show all rows" : "Show only changes since the last commit, including deleted rows")
        : undefined,
      titleFormatter: () => (git ? '<div class="changes-toggle"></div>' : ""),
      headerClick: () => {
        if (git) this.setChangesOnly(!this.last?.state.changesOnly);
      },
      tooltip: (_event, cell) => describe(cell),
      formatter: (cell) => {
        const deleted = isDeleted(cell.getRow().getData() as Row);
        const status = !git ? "none" : deleted ? "deleted" : (this.changes[rowIndex(cell)]?.status ?? "unchanged");
        return `<div class="change-bar ${status}"></div>${deleted ? "" : GRIP_ICON}`;
      },
      cellClick: (_event, cell) => {
        if (git && rowIndex(cell) >= 0) this.callbacks.onShowHistory(rowIndex(cell), cell.getElement());
      },
      cellMouseEnter: (_event, cell) => {
        if (rowIndex(cell) >= 0) this.rowActions.show(cell.getElement(), rowIndex(cell));
      },
      cellMouseLeave: () => this.rowActions.scheduleHide(),
      cellMouseDown: () => this.rowActions.suspend(),
    };
  }

  /** Drag & drop: place the row relative to its new visible neighbour (deleted rows do not count). */
  private onRowMoved(row: RowComponent) {
    const index = (row.getData() as Row)[ROW_INDEX] as number;
    const neighbour = (step: (row: RowComponent) => RowComponent | false) => {
      let candidate = step(row);
      while (candidate && isDeleted(candidate.getData() as Row)) candidate = step(candidate);
      return candidate;
    };
    const previous = neighbour((current) => current.getPrevRow());
    const next = neighbour((current) => current.getNextRow());
    if (index < 0) {
      // Deleted rows cannot be moved: put it back.
      this.relayout();
    } else if (previous) {
      this.callbacks.onMoveRow(index, (previous.getData() as Row)[ROW_INDEX] as number, "below");
    } else if (next) {
      this.callbacks.onMoveRow(index, (next.getData() as Row)[ROW_INDEX] as number, "above");
    }
  }

  /** Scrolls to the row with this ID and highlights it briefly (e.g. after adding it). */
  revealRowById(id: string) {
    this.whenBuilt(() => {
      const row = this.table?.getRows().find((candidate) => String((candidate.getData() as Row).id ?? "") === id);
      if (!row) return;
      void this.table?.scrollToRow(row, "center", false).catch(() => undefined);
      const element = row.getElement();
      element.classList.remove("row-flash");
      void element.offsetWidth;
      element.classList.add("row-flash");
    });
  }


  /**
   * Table copy of the rows (Tabulator edits its data in place, and edits are
   * compared against the originals). Multienum strings become lists, so the
   * list editor can preselect them.
   */
  private tableRows(rows: Row[]): Row[] {
    const multienum = [...this.attributes.values()].filter((attribute) => attribute.type === "multienum");
    return rows.map((row) => {
      const copy = { ...row };
      for (const attribute of multienum) {
        if (typeof copy[attribute.name] === "string") copy[attribute.name] = itemsOf(copy[attribute.name], attribute);
      }
      return copy;
    });
  }

  private isLocked(cell: CellComponent): boolean {
    return this.readonlyFields.has(cell.getField()) || isRowLocked(cell);
  }

  private edit(cell: CellComponent, raw: unknown) {
    const index = rowIndex(cell);
    const field = cell.getField();
    const original = this.sourceRows.get(index)?.[field];
    const result = coerce(this.editTypes.get(field) ?? "string", raw, original);
    if (result === "invalid") {
      cell.restoreOldValue();
      return;
    }
    if (result !== "unchanged") {
      this.callbacks.onEdit(index, field, result.value, !!result.remove);
    }
  }

  private onCellClick(event: UIEvent, cell: CellComponent) {
    if (rowIndex(cell) < 0) return;
    if ((event as MouseEvent).metaKey || (event as MouseEvent).ctrlKey) {
      this.callbacks.onReveal(rowIndex(cell));
      return;
    }
    if (editMode(this.editTypes.get(cell.getField()) ?? "string") !== "toggle" || this.isLocked(cell)) {
      return;
    }
    const original = this.sourceRows.get(rowIndex(cell))?.[cell.getField()];
    this.callbacks.onEdit(rowIndex(cell), cell.getField(), toggledBoolean(original), false);
  }

  private onCellDblClick(cell: CellComponent) {
    if (editMode(this.editTypes.get(cell.getField()) ?? "string") !== "richText" || this.isLocked(cell)) {
      return;
    }
    const index = rowIndex(cell);
    const field = cell.getField();
    openRichTextEditor(cell, this.sourceRows.get(index)?.[field], (value) =>
      this.callbacks.onEdit(index, field, value, false),
    );
  }

  setFilter(filter: ((row: Row) => boolean) | null) {
    this.filter = filter;
    this.whenBuilt(() => {
      this.applyFilter();
      this.updateCount();
    });
  }

  /** The filter query, and in "changes only" mode: changed or deleted rows. */
  private applyFilter() {
    if (!this.table) return;
    const filter = this.filter;
    const changesOnly = this.changesOnly;
    if (!filter && !changesOnly) {
      this.table.clearFilter(true);
      return;
    }
    this.table.setFilter((data: Row) => {
      if (changesOnly && !isDeleted(data) && !this.changes[data[ROW_INDEX] as number]) return false;
      return !filter || filter(data);
    });
  }

  private markChangesOnly() {
    const column = this.table?.getColumn(BASELINE_FIELD);
    column?.getElement().classList.toggle("changes-only", this.changesOnly);
  }

  setLinkedFields(fields: Set<string>) {
    this.whenBuilt(() => {
      for (const column of this.table?.getColumns() ?? []) {
        column.getElement().classList.toggle("header-linked", fields.has(column.getField()));
      }
    });
  }

  destroy() {
    this.table?.destroy();
    this.table = null;
    this.built = false;
    this.pending = [];
  }

  private whenBuilt(action: () => void) {
    if (this.built) {
      action();
    } else {
      this.pending.push(action);
    }
  }

  private updateCount() {
    if (this.table) {
      // Deleted rows are not part of the file: not counted in the total.
      this.callbacks.onCountChanged(this.table.getDataCount("active"), this.sourceRows.size);
    }
  }

  private markFilterColumns() {
    for (const column of this.table?.getColumns() ?? []) {
      const hasOptions = (this.options.get(column.getField())?.length ?? 0) > 0;
      column.getElement().classList.toggle("has-filter-options", hasOptions);
    }
  }

  private createTable(
    rows: Row[],
    visible: string[],
    wrapFields: Set<string>,
    state: ViewState,
    layout: ColumnLayout,
    git: boolean,
  ) {
    const columns: ColumnDefinition[] = visible.map((field) => {
      const attribute = this.attributes.get(field);
      const wrap = wrapFields.has(field);
      const width = layout.widths[field];
      const type = this.editTypes.get(field) ?? "string";
      const mode = editMode(type);

      return {
        ...(mode === "editor" ? editorColumn(type, attribute) : {}),
        editable: (cell: CellComponent) => !this.isLocked(cell),
        title: attribute?.label ?? field,
        field,
        width,
        minWidth: width ? Math.min(width, 40) : wrap ? 200 : 80,
        widthGrow: wrap ? 3 : 1,
        hozAlign: attribute?.type === "number" ? "right" : "left",
        headerTooltip: attribute?.description ?? (attribute && attribute.label !== field ? field : undefined),
        cssClass: [wrap ? "wrap" : "", `edit-${mode}`].join(" ").trim(),
        formatter: (cell, _params, onRendered) => {
          const element = cell.getElement();
          element.classList.toggle("locked", this.isLocked(cell));
          const kind = this.changes[rowIndex(cell)]?.fields[field]?.kind;
          element.classList.toggle("cell-modified", kind === "modified");
          element.classList.toggle("cell-added", kind === "added" && this.changes[rowIndex(cell)]?.status === "modified");
          if (wrap) {
            onRendered(() => normalizeAfterImages(cell));
          }
          return formatCell(cell.getValue(), attribute);
        },
        headerClick: (_event, column) => {
          this.callbacks.onHeaderClick(column, this.options.get(field) ?? []);
        },
        // Tabulator also accepts a function (built when the menu opens); its types only list arrays.
        headerContextMenu: (() => this.headerMenu(field)) as unknown as ColumnDefinition["headerContextMenu"],
      };
    });

    const table = new Tabulator(this.element, {
      data: rows,
      index: ROW_INDEX,
      columns: [this.baselineColumn(git), ...columns],
      movableRows: true,
      movableColumns: true,
      layout: "fitColumns",
      height: "100%",
      editTriggerEvent: "dblclick",
      nestedFieldSeparator: false,
      columnDefaults: {
        headerSort: false,
        resizable: true,
        tooltip: overflowTooltip,
      },
      rowContextMenu: [
        {
          label: "Reveal in Text Editor",
          disabled: (row) => isDeleted(row.getData() as Row),
          action: (_event, row) => this.callbacks.onReveal((row.getData() as Row)[ROW_INDEX] as number),
        },
      ],
      rowFormatter: (row) => row.getElement().classList.toggle("row-deleted", isDeleted(row.getData() as Row)),
    });
    this.table = table;

    table.on("tableBuilt", () => {
      this.built = true;
      this.applyFilter();
      this.markChangesOnly();
      this.markFilterColumns();
      this.updateCount();

      const holder = this.element.querySelector<HTMLElement>(".tabulator-tableholder");
      if (holder) {
        holder.scrollTop = state.scrollTop;
        holder.scrollLeft = state.scrollLeft;
        holder.addEventListener("scroll", () =>
          this.callbacks.onScroll(holder.scrollTop, holder.scrollLeft),
        );
      }

      const pending = this.pending;
      this.pending = [];
      pending.forEach((action) => action());
    });

    table.on("dataFiltered", () => queueMicrotask(() => this.updateCount()));
    table.on("rowMoved", (row) => this.onRowMoved(row));
    table.on("columnMoved", () => this.onColumnMoved());
    table.on("scrollVertical", () => this.rowActions.hide());
    table.on("cellEdited", (cell) => this.edit(cell, cell.getValue()));
    table.on("cellClick", (event, cell) => this.onCellClick(event, cell));
    table.on("cellDblClick", (_event, cell) => this.onCellDblClick(cell));
    table.on("columnResized", (column) =>
      this.callbacks.onColumnResized(column.getField(), column.getWidth()),
    );
  }
}

function normalizeAfterImages(cell: CellComponent) {
  const row = cell.getRow();
  const images = Array.from(cell.getElement().querySelectorAll("img"));
  row.normalizeHeight();
  for (const image of images) {
    if (!image.complete) {
      image.addEventListener("load", () => row.normalizeHeight(), { once: true });
      image.addEventListener("error", () => row.normalizeHeight(), { once: true });
    }
  }
}
