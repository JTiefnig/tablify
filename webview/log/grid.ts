// Virtualized log grid: fixed-height rows, only the visible ones in the DOM.
// Rows are fetched from the extension host in blocks by view position.

import type { ColumnInfo, LogSort, WindowRow } from "../../src/log/messages.ts";

export const ROW_HEIGHT = 28;
const BLOCK = 200;
const OVERSCAN = 15;
const CACHE_MAX = 20_000;
const MESSAGE_MIN_WIDTH = 320;
const AUTO_MIN = 48;
const AUTO_MAX = 360;
const CELL_PADDING = 18;

const DEFAULT_WIDTHS: Record<string, number> = { timestamp: 190, level: 64, source: 130, none: 110 };

export interface GridCallbacks {
  requestRows(start: number, count: number): void;
  /** The selected entry changed (null: selection cleared or not loaded yet). */
  onSelect(row: WindowRow | null): void;
  /** Double-click or Enter. */
  onActivate(row: WindowRow): void;
  onSort(column: string): void;
  /** Click on a header with a filter (the level column). */
  onHeaderFilter(cell: HTMLElement, column: ColumnInfo): void;
  onHeaderMenu(event: MouseEvent, column: string): void;
  /** A column was resized by dragging its header edge. */
  onResize(column: string, width: number): void;
  onScroll(top: number): void;
}

export class LogGrid {
  private readonly root: HTMLElement;
  private readonly header: HTMLElement;
  private readonly body: HTMLElement;
  private readonly callbacks: GridCallbacks;

  /** Visible columns in display order. */
  private columns: ColumnInfo[] = [];
  private userWidths: Record<string, number> = {};
  private readonly autoWidths = new Map<string, number>();
  private sort: LogSort | null = null;
  /** Columns with an active filter (highlighted header). */
  private filtered = new Set<string>();

  private generation = -1;
  private count = 0;
  private readonly cache = new Map<number, WindowRow>();
  private readonly requested = new Set<number>();
  /** Selected entry (record index) and its view position, when known. */
  private selected: number | null = null;
  private selectedPosition: number | null = null;
  private gutterWidth = 48;
  private frame = 0;
  /** Rendered rows by view position; `layout` invalidates them when columns or widths change. */
  private readonly rendered = new Map<number, { element: HTMLElement; row: WindowRow | undefined; layout: number }>();
  private layout = 0;
  private measure: CanvasRenderingContext2D | null = null;

  constructor(root: HTMLElement, header: HTMLElement, body: HTMLElement, callbacks: GridCallbacks) {
    this.root = root;
    this.header = header;
    this.body = body;
    this.callbacks = callbacks;

    root.addEventListener("scroll", () => {
      this.schedule();
      callbacks.onScroll(root.scrollTop);
    });
    new ResizeObserver(() => this.schedule()).observe(root);

    body.addEventListener("mousedown", (event) => {
      const position = this.positionOf(event.target);
      if (position !== null) this.select(position);
    });
    body.addEventListener("dblclick", (event) => {
      const position = this.positionOf(event.target);
      const row = position === null ? undefined : this.cache.get(position);
      if (row) callbacks.onActivate(row);
    });
    root.addEventListener("keydown", (event) => this.onKey(event));
  }

  setColumns(columns: ColumnInfo[], widths: Record<string, number>, sort: LogSort | null, filtered: Set<string>) {
    this.columns = columns;
    this.userWidths = widths;
    this.sort = sort;
    this.filtered = filtered;
    this.renderHeader();
    this.schedule();
  }

  /** New row count; a new generation drops the cached rows. */
  setData(generation: number, count: number) {
    if (generation !== this.generation) {
      this.generation = generation;
      this.cache.clear();
      this.requested.clear();
      this.layout++;
      this.selectedPosition = null;
    } else if (count !== this.count) {
      // Rows were appended (loading): the last, partial block needs fetching again.
      this.requested.delete(Math.floor(this.count / BLOCK));
    }
    this.count = count;
    this.body.style.height = `${count * ROW_HEIGHT}px`;
    this.schedule();
  }

  addRows(generation: number, start: number, rows: WindowRow[]) {
    if (generation !== this.generation) return;
    rows.forEach((row, offset) => this.cache.set(start + offset, row));
    const maxLine = rows.reduce((max, row) => Math.max(max, row.line + row.lines - 1), 0);
    const digits = String(maxLine).length;
    const gutter = Math.max(48, digits * 8 + 20);
    if (gutter > this.gutterWidth) {
      this.gutterWidth = gutter;
      this.renderHeader();
    }
    if (this.autoSize(rows)) this.renderHeader();
    // A selection made before its row arrived.
    if (this.selectedPosition !== null && this.selected === null) {
      const row = this.cache.get(this.selectedPosition);
      if (row) {
        this.selected = row.index;
        this.callbacks.onSelect(row);
      }
    }
    this.schedule();
  }

  get selection(): number | null {
    return this.selected;
  }

  clearSelection() {
    this.selected = null;
    this.selectedPosition = null;
    this.callbacks.onSelect(null);
    this.schedule();
  }

  /** Restores the selection by record index (the row is highlighted once loaded). */
  restoreSelection(index: number | null) {
    this.selected = index;
  }

  focus() {
    this.root.focus({ preventScroll: true });
  }

  // --- Widths --------------------------------------------------------------------------

  private width(column: ColumnInfo): number {
    return this.userWidths[column.name] ?? this.autoWidths.get(column.name) ?? DEFAULT_WIDTHS[column.role] ?? 110;
  }

  /** The last column (normally the message) takes the remaining width. */
  private isFlex(column: ColumnInfo): boolean {
    return column === this.columns[this.columns.length - 1];
  }

  /** Sizes columns without a width to their content in the first rows. Returns whether any changed. */
  private autoSize(rows: WindowRow[]): boolean {
    let changed = false;
    for (const column of this.columns) {
      if (this.autoWidths.has(column.name) || column.role === "message" || rows.length === 0) continue;
      let longest = "";
      for (const row of rows) {
        const text = row.values[column.key];
        if (text && text.length > longest.length) longest = text;
      }
      // The header is bold and has room for the sort arrow.
      const header = this.textWidth(column.name) * 1.1 + CELL_PADDING + 14;
      const content = this.textWidth(longest) + CELL_PADDING;
      this.autoWidths.set(column.name, Math.min(AUTO_MAX, Math.max(AUTO_MIN, Math.ceil(Math.max(header, content)))));
      changed = true;
    }
    return changed;
  }

  private textWidth(text: string): number {
    if (!this.measure) {
      this.measure = document.createElement("canvas").getContext("2d");
      if (this.measure) this.measure.font = getComputedStyle(this.root).font;
    }
    return this.measure ? this.measure.measureText(text).width : text.length * 7;
  }

  private rowWidth(): number {
    return this.columns.reduce(
      (sum, column) => sum + (this.isFlex(column) ? Math.max(this.width(column), MESSAGE_MIN_WIDTH) : this.width(column)),
      this.gutterWidth,
    );
  }

  private applyWidth(cell: HTMLElement, column: ColumnInfo) {
    const width = this.width(column);
    if (this.isFlex(column)) {
      cell.classList.add("flex");
      cell.style.minWidth = `${Math.max(width, MESSAGE_MIN_WIDTH)}px`;
    } else {
      cell.style.width = `${width}px`;
    }
  }

  // --- Header --------------------------------------------------------------------------

  private renderHeader() {
    this.layout++;
    const cells: HTMLElement[] = [];
    const gutter = document.createElement("div");
    gutter.className = "hcell gutter";
    gutter.style.width = `${this.gutterWidth}px`;
    gutter.textContent = "Line";
    gutter.title = "Line in the file · click to sort by file order";
    gutter.addEventListener("click", () => this.sort && this.callbacks.onSort(""));
    cells.push(gutter);

    for (const column of this.columns) {
      const cell = document.createElement("div");
      const filterable = column.role === "level";
      cell.className = `hcell role-${column.role}${filterable ? " has-filter-options" : ""}${this.filtered.has(column.name) ? " header-linked" : ""}`;
      cell.setAttribute("role", "columnheader");
      this.applyWidth(cell, column);
      const label = document.createElement("span");
      label.className = "hlabel";
      label.textContent = column.name;
      cell.title = `${column.name}${column.role !== "none" ? ` (${column.role})` : ""} · click to ${filterable ? "filter" : "sort"}, right-click for more`;
      cell.appendChild(label);
      if (this.sort?.column === column.name) {
        const arrow = document.createElement("span");
        arrow.className = "sort";
        arrow.textContent = this.sort.descending ? "▼" : "▲";
        cell.appendChild(arrow);
        cell.setAttribute("aria-sort", this.sort.descending ? "descending" : "ascending");
      }
      cell.addEventListener("click", () =>
        filterable ? this.callbacks.onHeaderFilter(cell, column) : this.callbacks.onSort(column.name),
      );
      cell.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.callbacks.onHeaderMenu(event, column.name);
      });
      if (!this.isFlex(column)) {
        const resizer = document.createElement("div");
        resizer.className = "resizer";
        resizer.addEventListener("click", (event) => event.stopPropagation());
        resizer.addEventListener("mousedown", (event) => this.startResize(event, column, cell));
        cell.appendChild(resizer);
      }
      cells.push(cell);
    }
    this.header.replaceChildren(...cells);
    const width = `${this.rowWidth()}px`;
    this.header.style.minWidth = width;
    this.body.style.minWidth = width;
  }

  private startResize(event: MouseEvent, column: ColumnInfo, cell: HTMLElement) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = this.width(column);
    let width = startWidth;
    const move = (moveEvent: MouseEvent) => {
      width = Math.max(32, Math.round(startWidth + moveEvent.clientX - startX));
      this.userWidths = { ...this.userWidths, [column.name]: width };
      cell.style.width = `${width}px`;
      this.layout++;
      const rowWidth = `${this.rowWidth()}px`;
      this.header.style.minWidth = rowWidth;
      this.body.style.minWidth = rowWidth;
      this.schedule();
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
      if (width !== startWidth) this.callbacks.onResize(column.name, width);
    };
    document.body.classList.add("resizing");
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  // --- Rows ----------------------------------------------------------------------------

  private schedule() {
    if (!this.frame) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.render();
      });
    }
  }

  private visibleRange(): { first: number; last: number } {
    const top = this.root.scrollTop;
    const height = Math.max(0, this.root.clientHeight - this.header.offsetHeight);
    const first = Math.max(0, Math.floor(top / ROW_HEIGHT));
    const last = Math.min(this.count, Math.ceil((top + height) / ROW_HEIGHT));
    return { first, last };
  }

  private render() {
    const visible = this.visibleRange();
    const first = Math.max(0, visible.first - OVERSCAN);
    const last = Math.min(this.count, visible.last + OVERSCAN);
    this.fetch(first, last);
    this.evict(first, last);

    // Rows whose data and layout did not change keep their element (a
    // double-click must land on the element that got the first click).
    for (const [position, entry] of this.rendered) {
      const row = this.cache.get(position);
      if (position < first || position >= last || entry.row !== row || entry.layout !== this.layout) {
        entry.element.remove();
        this.rendered.delete(position);
      }
    }
    for (let position = first; position < last; position++) {
      const row = this.cache.get(position);
      const entry = this.rendered.get(position);
      if (entry) {
        const selected = !!row && row.index === this.selected;
        entry.element.classList.toggle("selected", selected);
        entry.element.setAttribute("aria-selected", String(selected));
        if (selected) this.selectedPosition = position;
        continue;
      }
      const element = this.renderRow(position, row);
      this.rendered.set(position, { element, row, layout: this.layout });
      this.body.appendChild(element);
    }
  }

  private fetch(first: number, last: number) {
    if (last <= first) return;
    for (let block = Math.floor(first / BLOCK); block <= Math.floor((last - 1) / BLOCK); block++) {
      if (this.requested.has(block)) continue;
      const start = block * BLOCK;
      const end = Math.min(this.count, start + BLOCK);
      let complete = true;
      for (let position = start; position < end && complete; position++) complete = this.cache.has(position);
      if (complete) continue;
      this.requested.add(block);
      this.callbacks.requestRows(start, BLOCK);
    }
  }

  private evict(first: number, last: number) {
    if (this.cache.size <= CACHE_MAX) return;
    const keep = CACHE_MAX / 2;
    for (const position of this.cache.keys()) {
      if (position < first - keep || position > last + keep) {
        this.cache.delete(position);
        this.requested.delete(Math.floor(position / BLOCK));
      }
    }
  }

  private renderRow(position: number, row: WindowRow | undefined): HTMLElement {
    const element = document.createElement("div");
    element.style.top = `${position * ROW_HEIGHT}px`;
    element.dataset.position = String(position);
    element.setAttribute("role", "row");
    const gutter = document.createElement("div");
    gutter.className = "cell gutter";
    gutter.style.width = `${this.gutterWidth}px`;
    element.appendChild(gutter);

    if (!row) {
      element.className = "row pending";
      return element;
    }
    const selected = row.index === this.selected;
    if (selected) this.selectedPosition = position;
    element.className = `row${position % 2 ? " alt" : ""}${row.level ? ` level-${row.level}` : ""}${row.error ? " parse-error" : ""}${selected ? " selected" : ""}`;
    element.setAttribute("aria-selected", String(selected));
    gutter.textContent = String(row.line);

    for (const column of this.columns) {
      const cell = document.createElement("div");
      cell.className = `cell role-${column.role}`;
      this.applyWidth(cell, column);
      const text = row.values[column.key];
      if (text !== null && text !== undefined) {
        cell.textContent = text;
        if (column.role === "level" && row.level) cell.classList.add(`text-${row.level}`);
      }
      if (column.role === "message" && row.lines > 1) {
        const more = document.createElement("span");
        more.className = "more";
        more.textContent = `+${row.lines - 1} line${row.lines > 2 ? "s" : ""}`;
        cell.prepend(more);
      }
      element.appendChild(cell);
    }
    return element;
  }

  private positionOf(target: EventTarget | null): number | null {
    const row = (target as Element | null)?.closest?.<HTMLElement>(".row");
    return row?.dataset.position !== undefined ? Number(row.dataset.position) : null;
  }

  // --- Selection and keyboard ------------------------------------------------------------

  private select(position: number) {
    position = Math.max(0, Math.min(this.count - 1, position));
    if (this.count === 0) return;
    this.selectedPosition = position;
    const row = this.cache.get(position);
    this.selected = row ? row.index : null;
    this.callbacks.onSelect(row ?? null);
    this.scrollIntoView(position);
    this.schedule();
  }

  private scrollIntoView(position: number) {
    const top = position * ROW_HEIGHT;
    const viewHeight = this.root.clientHeight - this.header.offsetHeight;
    if (top < this.root.scrollTop) this.root.scrollTop = top;
    else if (top + ROW_HEIGHT > this.root.scrollTop + viewHeight) this.root.scrollTop = top + ROW_HEIGHT - viewHeight;
  }

  private onKey(event: KeyboardEvent) {
    const page = Math.max(1, Math.floor((this.root.clientHeight - this.header.offsetHeight) / ROW_HEIGHT) - 1);
    const current = this.selectedPosition ?? this.visibleRange().first - 1;
    let target: number | null = null;
    switch (event.key) {
      case "ArrowDown":
        target = current + 1;
        break;
      case "ArrowUp":
        target = current - 1;
        break;
      case "PageDown":
        target = current + page;
        break;
      case "PageUp":
        target = current - page;
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = this.count - 1;
        break;
      case "Enter": {
        const row = this.selectedPosition !== null ? this.cache.get(this.selectedPosition) : undefined;
        if (row) this.callbacks.onActivate(row);
        event.preventDefault();
        return;
      }
      default:
        return;
    }
    event.preventDefault();
    this.select(target);
  }
}
