// Message protocol between the extension host and the table webview.

export type Scalar = string | number | boolean | null;
export type Cell = Scalar | Scalar[];
export type Row = Record<string, Cell>;

/** Hidden per-row field holding the row's index in the source document. */
export const ROW_INDEX = "__tablifyIndex";
/** Hidden per-row field listing fields that cannot be edited ("*" = all). */
export const ROW_LOCKED = "__tablifyLocked";

export type ErrorKind = "syntax" | "shape" | "empty";

// --- Attribute definitions (tablify.attributes.yaml) -------------------------------

export const ATTRIBUTE_TYPES = [
  "string", // single-line text
  "text", // multi-line plain text
  "html", // structured text, rendered as sanitized HTML
  "enum", // single select from `values`
  "multienum", // multi select from `values`
  "list", // free list of strings
  "number",
  "boolean",
  "date", // ISO 8601, e.g. 2026-10-08
] as const;
export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];

export const BADGE_COLORS = ["gray", "blue", "green", "yellow", "orange", "red", "purple"] as const;
export type BadgeColor = (typeof BADGE_COLORS)[number];

export interface EnumValue {
  value: string;
  label: string;
  color?: BadgeColor;
  description?: string;
}

export interface Attribute {
  name: string;
  type: AttributeType;
  label: string;
  description?: string;
  /** Not editable in the table. */
  readonly: boolean;
  /** Allowed values, in display order (enum and multienum only). */
  values: EnumValue[];
}

/** Which columns are shown, in which order and width. */
export interface ColumnLayout {
  /** Column order; null = attribute order, then data order. */
  columns: string[] | null;
  hidden: string[];
  /** Show fields that are not in `columns` (after them). */
  showOthers: boolean;
  widths: Record<string, number>;
}

/** A named filter query, saved in the view. */
export interface SavedFilter {
  name: string;
  query: string;
}

/** The view (from .vscode/tablify.yaml) that applies to a file. */
export interface ViewSettings {
  name: string | null;
  attributes: Attribute[];
  layout: ColumnLayout;
  /** Columns that cannot be edited in the table (in addition to `readonly` attributes). */
  readonlyColumns: string[];
  filters: SavedFilter[];
  /** Shell command run after the file is saved (e.g. a formatter); see src/onSave.ts. */
  onSave: string | null;
}

// --- Git ------------------------------------------------------------------------------

/** A row of the last commit that is no longer in the file. */
export interface DeletedRow {
  row: Row;
  /** Index of the current row it followed in the last commit (-1: it came first). */
  after: number;
}

export type FieldChangeKind = "added" | "modified" | "removed";

/** How a row differs from the last commit (HEAD). Unchanged rows have no entry. */
export interface RowChange {
  status: "added" | "modified";
  /** Changed fields; `before` is the committed value (absent for added fields). */
  fields: Record<string, { kind: FieldChangeKind; before?: Cell }>;
}

export interface BlameCommit {
  hash: string;
  author: string;
  /** Unix time in seconds. */
  time: number;
  summary: string;
  /** Line changed in the working tree / editor, not committed yet. */
  uncommitted: boolean;
}

export interface FieldBlame {
  field: string;
  /** 1-based line of the field in the current text. */
  line: number;
  /** Most recent commit among the field's lines. */
  commit: BlameCommit;
}

export type BlameResult = { ok: true; fields: FieldBlame[] } | { ok: false; message: string };

export type ToWebview =
  | {
      type: "data";
      /** Document version the rows were read from; edits must refer to it. */
      version: number;
      rows: Row[];
      fields: string[];
      /** The configured view for this file, if any. */
      view: ViewSettings | null;
      /** Whether the file is tracked by git (enables the change bar and blame). */
      git: boolean;
      /** Rows changed since the last commit, by row index; null while unknown. */
      changes: Record<number, RowChange> | null;
      /** Rows deleted since the last commit; null while unknown. */
      deleted: DeletedRow[] | null;
      /** Webview URI of the document's folder, ending in "/". */
      baseUri: string;
    }
  | {
      type: "error";
      kind: ErrorKind;
      message: string;
      line?: number;
    }
  | { type: "focusFilter" }
  | { type: "clearFilter" }
  /** The current layout was saved to the config, or should be discarded: drop local changes. */
  | { type: "resetLayout" }
  | { type: "blame"; requestId: number; index: number; result: BlameResult };

export type ToHost =
  | { type: "ready" }
  | { type: "reveal"; index: number }
  | { type: "openLink"; href: string }
  | { type: "openAsText" }
  | { type: "blame"; requestId: number; index: number }
  | { type: "filterState"; query: string; shown: number; total: number }
  /** The effective column layout, and whether it differs from the configured view. */
  | { type: "layout"; layout: ColumnLayout; modified: boolean }
  | { type: "saveView" }
  | { type: "saveFilter"; query: string }
  | { type: "deleteFilter"; name: string }
  | {
      type: "edit";
      version: number;
      index: number;
      field: string;
      /** New value; `remove` deletes the field instead. */
      value: Cell;
      remove?: boolean;
    }
  | { type: "insertRow"; version: number; index: number; placement: "above" | "below"; id: string }
  | { type: "deleteRow"; version: number; index: number }
  | { type: "moveRow"; version: number; index: number; target: number; placement: "above" | "below" };
