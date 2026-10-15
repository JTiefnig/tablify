// Message protocol between the extension host and the log table webview. The
// host keeps all records; the webview asks for the rows it shows (a window).

import type { CanonicalLevel, FieldRole } from "./types.ts";

/** A canonical level, or "none" for records without a level. */
export type LevelKey = CanonicalLevel | "none";

export interface LogSort {
  column: string;
  descending: boolean;
}

export interface LogQuery {
  /** Levels shown; null = all. */
  levels: LevelKey[] | null;
  /** Plain text (case-insensitive) or `/regex/flags`. */
  text: string;
  /** Search the whole entry instead of the message only. */
  allFields: boolean;
  /** null = file order. */
  sort: LogSort | null;
}

export const EMPTY_QUERY: LogQuery = { levels: null, text: "", allFields: false, sort: null };

export interface ColumnInfo {
  name: string;
  /** Index into `WindowRow.values` (stable while the file is loaded). */
  key: number;
  role: FieldRole;
  /** Always empty or "-", superseded by enricher columns, or listed in `tablify.log.defaultHiddenColumns`. */
  hiddenByDefault: boolean;
}

export interface WindowRow {
  /** Record index. */
  index: number;
  /** 1-based first line in the file. */
  line: number;
  /** Number of lines of the entry. */
  lines: number;
  level?: CanonicalLevel;
  /** The entry did not match the format. */
  error?: boolean;
  /** Cell text by column key: first line only, shortened. */
  values: (string | null)[];
}

export interface RecordDetail {
  index: number;
  line: number;
  lineEnd: number;
  level?: CanonicalLevel;
  epochMs?: number;
  error?: boolean;
  raw: string;
  /** Field holding the message (shown as the full text). */
  messageField: string | null;
  fields: { name: string; value: string }[];
}

export type ToLogWebview =
  | {
      type: "state";
      /** Changes whenever row positions change (new query, reload); cached rows are dropped. */
      generation: number;
      loading: boolean;
      /** Loading progress, 0–1. */
      progress: number;
      /** Records loaded. */
      total: number;
      /** Records matching the query. */
      count: number;
      /** Records per level matching the query apart from the level filter. */
      levelCounts: Partial<Record<LevelKey, number>>;
      columns: ColumnInfo[];
      /** Invalid regex in the search, etc. */
      queryError: string | null;
      /** Set when only part of a large file is shown. */
      notice: string | null;
    }
  | { type: "rows"; generation: number; start: number; rows: WindowRow[] }
  | { type: "detail"; detail: RecordDetail }
  /** The file is above `tablify.log.largeFileThresholdMB`: ask how much to load. */
  | { type: "largeFile"; sizeMB: number; lines: number }
  | { type: "error"; message: string }
  | { type: "focusSearch" }
  | { type: "clearFilter" };

export type ToLogHost =
  | { type: "ready"; query: LogQuery }
  | { type: "query"; query: LogQuery }
  | { type: "rows"; generation: number; start: number; count: number }
  | { type: "detail"; index: number }
  | { type: "reveal"; index: number }
  | { type: "openAsText" }
  | { type: "loadLarge"; mode: "all" | "head" | "tail" };
