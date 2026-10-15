// Filtering and sorting on the full record set, in the extension host. The
// webview only receives the window of rows it shows.

import type { ColumnInfo, LevelKey, LogQuery, RecordDetail, WindowRow } from "./messages.ts";
import type { FieldValue, LogRecord } from "./types.ts";

/** Longest cell text sent to the webview (the detail view has the full text). */
const CELL_MAX = 500;

export type TextMatcher = (text: string) => boolean;

/** The record's message field; null: the text filter searches the raw text. */
export type MessageKey = (record: LogRecord) => string | null;

/** Compiles the search text: `/regex/flags`, or plain case-insensitive text. */
export function textMatcher(text: string): { match: TextMatcher | null; error: string | null } {
  const trimmed = text.trim();
  if (!trimmed) return { match: null, error: null };
  const regex = /^\/(.+)\/([a-z]*)$/s.exec(trimmed);
  if (regex) {
    try {
      const pattern = new RegExp(regex[1], regex[2].replace(/[gy]/g, ""));
      return { match: (value) => pattern.test(value), error: null };
    } catch (error) {
      return { match: null, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const needle = trimmed.toLowerCase();
  // Most text is ASCII-cased the same either way: a quick check before lowercasing.
  return { match: (value) => value.includes(trimmed) || value.toLowerCase().includes(needle), error: null };
}

function levelKey(record: LogRecord): LevelKey {
  return record.level ?? "none";
}

export function cellText(value: FieldValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value);
  const newline = text.indexOf("\n");
  const first = newline >= 0 ? text.slice(0, newline) : text;
  return first.length > CELL_MAX ? `${first.slice(0, CELL_MAX)}…` : first;
}

export class LogStore {
  records: LogRecord[] = [];
  /** Record indices matching the query, in display order. */
  view: number[] = [];
  levelCounts: Partial<Record<LevelKey, number>> = {};
  queryError: string | null = null;

  private query: LogQuery;
  private match: TextMatcher | null = null;
  private levels: Set<LevelKey> | null = null;
  /** Records already filtered into the view. */
  private processed = 0;
  private messageKey: MessageKey;

  constructor(query: LogQuery, messageKey: MessageKey) {
    this.query = query;
    this.messageKey = messageKey;
    this.compile();
  }

  /** New data (e.g. after a reload or a format change). */
  reset(records: LogRecord[], messageKey: MessageKey) {
    this.records = records;
    this.messageKey = messageKey;
    this.restart();
  }

  setQuery(query: LogQuery) {
    this.query = query;
    this.compile();
    this.restart();
  }

  getQuery(): LogQuery {
    return this.query;
  }

  private compile() {
    const { match, error } = textMatcher(this.query.text);
    this.match = match;
    this.queryError = error;
    this.levels = this.query.levels ? new Set(this.query.levels) : null;
  }

  private restart() {
    this.view = [];
    this.levelCounts = {};
    this.processed = 0;
    this.update();
  }

  /** Adds records loaded since the last call to the view (appended; call `sort()` afterwards). */
  update() {
    const { records } = this;
    const { allFields } = this.query;
    const messageKey = this.messageKey;
    const match = this.match;
    const levels = this.levels;
    const counts = this.levelCounts;
    for (let i = this.processed; i < records.length; i++) {
      const record = records[i];
      if (match) {
        const key = allFields ? null : messageKey(record);
        if (!match(key === null ? record.raw : String(record.fields[key]))) continue;
      }
      const level = levelKey(record);
      counts[level] = (counts[level] ?? 0) + 1;
      if (!levels || levels.has(level)) this.view.push(i);
    }
    this.processed = records.length;
  }

  /**
   * Sorts the view by the query's sort column. The timestamp column sorts by
   * parsed time; empty values and unparsed timestamps sort last either way.
   * Ties keep file order.
   */
  sort(timestampColumns: ReadonlySet<string>) {
    const sort = this.query.sort;
    if (!sort) return;
    const { records } = this;
    const direction = sort.descending ? -1 : 1;
    let key: (index: number) => number | string | undefined;
    if (timestampColumns.has(sort.column)) {
      key = (index) => records[index].epochMs;
    } else {
      const numeric = this.view.every((index) => {
        const value = records[index].fields[sort.column];
        return value === undefined || value === null || value === "" || typeof value === "number" || isNumeric(value);
      });
      key = numeric
        ? (index) => {
            const value = records[index].fields[sort.column];
            return value === undefined || value === null || value === "" ? undefined : Number(value);
          }
        : (index) => {
            const value = records[index].fields[sort.column];
            return value === undefined || value === null || value === "" ? undefined : String(value).toLowerCase();
          };
    }
    // Keys by record index, computed once (not per comparison).
    const keys: (number | string | undefined)[] = new Array(records.length);
    for (const index of this.view) keys[index] = key(index);
    this.view.sort((a, b) => {
      const x = keys[a];
      const y = keys[b];
      if (x === undefined || y === undefined) return x === y ? a - b : x === undefined ? 1 : -1;
      if (x === y) return a - b;
      return (x < y ? -1 : 1) * direction;
    });
  }

  /** Rows `start..start+count` of the view, with cell values by column key. */
  window(start: number, count: number, columns: ColumnInfo[]): WindowRow[] {
    const rows: WindowRow[] = [];
    const end = Math.min(this.view.length, start + Math.max(0, count));
    for (let position = Math.max(0, start); position < end; position++) {
      const index = this.view[position];
      const record = this.records[index];
      const values: (string | null)[] = [];
      for (const column of columns) values[column.key] = cellText(record.fields[column.name]);
      const row: WindowRow = { index, line: record.lineStart + 1, lines: record.lineEnd - record.lineStart + 1, values };
      if (record.level) row.level = record.level;
      if (record.parseError) row.error = true;
      rows.push(row);
    }
    return rows;
  }

  detail(index: number, columns: ColumnInfo[]): RecordDetail | null {
    const record = this.records[index];
    if (!record) return null;
    const known = new Set(columns.map((column) => column.name));
    const names = [...columns.map((column) => column.name), ...Object.keys(record.fields).filter((name) => !known.has(name))];
    const detail: RecordDetail = {
      index,
      messageField: this.messageKey(record),
      line: record.lineStart + 1,
      lineEnd: record.lineEnd + 1,
      raw: record.raw,
      fields: names.flatMap((name) => {
        const value = record.fields[name];
        return value === undefined || value === null ? [] : [{ name, value: String(value) }];
      }),
    };
    if (record.level) detail.level = record.level;
    if (record.epochMs !== undefined) detail.epochMs = record.epochMs;
    if (record.parseError) detail.error = true;
    return detail;
  }
}

function isNumeric(value: string): boolean {
  return value.trim() !== "" && !Number.isNaN(Number(value));
}
