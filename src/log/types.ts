// Data model of the log table. Formats are data: every regex-based format is a
// definition object with named capture groups, built-in and user-defined alike.

export type FieldRole = "timestamp" | "level" | "message" | "source" | "none";

export const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type CanonicalLevel = (typeof LEVELS)[number];

export interface LogFormat {
  /** 'syslog-3164', 'clf', ... */
  id: string;
  /** Shown in the format picker and the status bar. */
  label: string;
  /** `plain` is the fallback when no format is detected. */
  kind: "regex" | "jsonl" | "logfmt" | "plain";
  /** JS regex with named groups (kind = 'regex'), applied to each record's first line. */
  pattern?: string;
  /** Group name -> role. Groups named timestamp / level / message get that role by default. */
  roles?: Record<string, FieldRole>;
  /** Hint for the timestamp parser (informational; all known shapes are tried). */
  timestampFormat?: string;
  /** Lines that do not match continue the previous record (default true). */
  multiline?: boolean;
  /** IDs of built-in enrichers, e.g. 'split-http-request', 'syslog-pri'. */
  postProcess?: string[];
  /** User-defined (from `tablify.log.customFormats`). */
  custom?: boolean;
}

export type FieldValue = string | number | null;

export interface LogRecord {
  /** 0-based, for "reveal in editor". */
  lineStart: number;
  /** > lineStart when multi-line. */
  lineEnd: number;
  raw: string;
  fields: Record<string, FieldValue>;
  /** Parsed timestamp, for sorting and the time filter. */
  epochMs?: number;
  /** Normalized severity. */
  level?: CanonicalLevel;
  /** The line did not match the format (rendered dimmed). */
  parseError?: boolean;
}

export interface LogColumn {
  name: string;
  role: FieldRole;
}
