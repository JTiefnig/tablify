// Turns log lines into records: record splitting (multi-line entries), field
// extraction (regex / JSON / logfmt / plain text), enrichers and normalization.
// Streaming: lines are fed in chunks, so the first records are available early.
// Free of the vscode API so it can be unit-tested with plain Node.

import { groupNames, KEY_ROLES } from "./formats.ts";
import { normalizeLevel, syslogSeverityLevel } from "./levels.ts";
import { LEADING_TIMESTAMP, TimestampParser, type TimestampContext } from "./timestamps.ts";
import type { FieldRole, FieldValue, LogColumn, LogFormat, LogRecord } from "./types.ts";

/** Longer lines are truncated for matching (the record keeps the full text). */
export const MATCH_CAP = 64 * 1024;

/** Lines that look like the continuation of a multi-line entry (stack traces). */
export const CONTINUATION = /^(?:\s|at |Caused by:|Traceback|\.\.\.)/;

const LOGFMT_PAIR = /(?<key>[^\s=]+)=(?:"(?<q>(?:[^"\\]|\\.)*)"|(?<v>\S*))/g;
const HTTP_REQUEST = /^(?<method>\S+) (?<path>\S+)(?: (?<protocol>\S+))?$/;
const SD_ELEMENT = /\[([^\s\]]+)((?:\s+[^=\s\]]+="(?:[^"\\]|\\.)*")*)\s*\]/g;
const SD_PARAM = /([^=\s\]]+)="((?:[^"\\]|\\.)*)"/g;
const LEVEL_NAMES = "TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|ERR|SEVERE|FATAL|CRITICAL|CRIT|ALERT|EMERG|PANIC";
/** A level keyword: upper case as a word, or any case in brackets ("[warn]"). */
const LEVEL_WORD = new RegExp(`(?:^|[\\s[(<|:])(${LEVEL_NAMES})(?=$|[\\s\\])>|:,])`);
const LEVEL_BRACKETED = new RegExp(`[[(<](${LEVEL_NAMES})[\\])>]`, "i");

// --- Enrichers -----------------------------------------------------------------------

interface Enricher {
  /** The added fields become columns right after this one. */
  after?: string;
  adds?: string[];
  /** Columns hidden by default because the added ones supersede them. */
  hides?: string[];
  /** Fields it adds with this prefix are hidden by default (many sparse columns). */
  hiddenPrefix?: string;
  apply(record: LogRecord): void;
}

const ENRICHERS: Record<string, Enricher> = {
  /** facility = floor(pri / 8), severity = pri % 8, which also gives the level. */
  "syslog-pri": {
    after: "pri",
    adds: ["facility", "severity"],
    hides: ["pri"],
    apply(record) {
      const pri = record.fields.pri;
      if (pri === undefined || pri === null || pri === "") return;
      const value = Number(pri);
      if (!Number.isInteger(value)) return;
      record.fields.facility = Math.floor(value / 8);
      record.fields.severity = value % 8;
      record.level ??= syslogSeverityLevel(value % 8);
    },
  },
  "split-http-request": {
    after: "request",
    adds: ["method", "path", "protocol"],
    hides: ["request"],
    apply(record) {
      const request = record.fields.request;
      const match = typeof request === "string" ? HTTP_REQUEST.exec(request) : null;
      if (!match?.groups) return;
      record.fields.method = match.groups.method;
      record.fields.path = match.groups.path;
      if (match.groups.protocol !== undefined) record.fields.protocol = match.groups.protocol;
    },
  },
  /** Access logs have no level: 5xx = error, 4xx = warn, everything else = info. */
  "status-level": {
    apply(record) {
      if (record.level) return;
      const status = Number(record.fields.status);
      if (!Number.isFinite(status)) return;
      record.level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
    },
  },
  /** RFC 5424: "-" in a header field means nil. */
  "nil-dash": {
    apply(record) {
      for (const key in record.fields) {
        if (key !== "message" && record.fields[key] === "-") record.fields[key] = null;
      }
    },
  },
  /** RFC 5424 structured data: `[id param="value"]` -> column `sd.id.param`. */
  "sd-params": {
    hiddenPrefix: "sd.",
    apply(record) {
      const sd = record.fields.sd;
      if (typeof sd !== "string" || !sd.startsWith("[")) return;
      for (const element of sd.matchAll(SD_ELEMENT)) {
        for (const param of element[2].matchAll(SD_PARAM)) {
          record.fields[`sd.${element[1]}.${param[1]}`] = param[2].replace(/\\(["\\\]])/g, "$1");
        }
      }
    },
  },
};

export const ENRICHER_IDS = Object.keys(ENRICHERS);

// --- Line matching (shared with detection) -------------------------------------------

export interface LineMatcher {
  /** Whether the line starts a record of this format. */
  test(line: string): boolean;
}

/** Whether a line is a logfmt record for detection: ≥ 2 pairs covering most of the line. */
function isLogfmtLine(line: string): boolean {
  const text = line.trim();
  if (!text) return false;
  let pairs = 0;
  let covered = 0;
  for (const match of text.matchAll(LOGFMT_PAIR)) {
    pairs++;
    covered += match[0].length;
  }
  return pairs >= 2 && covered >= 0.7 * text.replace(/\s+/g, "").length;
}

function isJsonObjectLine(line: string): boolean {
  const text = line.trim();
  if (!text.startsWith("{")) return false;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

export function lineMatcher(format: LogFormat): LineMatcher {
  switch (format.kind) {
    case "jsonl":
      return { test: (line) => isJsonObjectLine(capped(line)) };
    case "logfmt":
      return { test: (line) => isLogfmtLine(capped(line)) };
    case "plain":
      return { test: () => true };
    case "regex": {
      const regex = new RegExp(format.pattern ?? "^$");
      return { test: (line) => regex.test(capped(line)) };
    }
  }
}

function capped(line: string): string {
  return line.length > MATCH_CAP ? line.slice(0, MATCH_CAP) : line;
}

// --- Values --------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalar(value: unknown): FieldValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** Nested objects become dot-notation keys up to depth 2; deeper values are JSON strings. */
function flatten(object: Record<string, unknown>, out: Record<string, FieldValue>, prefix = "", depth = 1) {
  for (const [key, value] of Object.entries(object)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value) && depth < 2) {
      flatten(value, out, name, depth + 1);
    } else {
      out[name] = scalar(value);
    }
  }
}

function isEmptyValue(value: FieldValue | undefined): boolean {
  return value === undefined || value === null || value === "" || value === "-";
}

// --- Parser --------------------------------------------------------------------------

export interface ParseContext extends TimestampContext {}

type SingleRole = "timestamp" | "level" | "message";

/** A column with its stable key index (discovery order; indices never change). */
export interface ColumnState extends LogColumn {
  key: number;
  /** Records with a value other than empty or "-". */
  nonEmpty: number;
  /** Hidden by default by an enricher: superseded (e.g. `request` by `method` / `path`) or sparse (`sd.*`). */
  superseded: boolean;
}

/**
 * Streaming parser for one format. Feed lines in order, then call `finish()`.
 * Completed records accumulate in `records`; the last record stays open until
 * the next record starts (continuation lines may follow).
 */
export class LogParser {
  readonly format: LogFormat;
  readonly records: LogRecord[] = [];

  private readonly timestamps: TimestampParser;
  private readonly regex: RegExp | null;
  private readonly groups: string[];
  private readonly multiline: boolean;
  private readonly enrichers: Enricher[];

  /** Field names in discovery order (the column keys). */
  private readonly keys: string[] = [];
  private readonly keyIndex = new Map<string, number>();
  private readonly nonEmpty: number[] = [];
  private readonly roles = new Map<string, FieldRole>();
  private readonly superseded = new Set<string>();
  /** Keys with a timestamp / level / message role, most preferred first: a record uses the first it has. */
  private readonly roleKeys: Record<SingleRole, string[]> = { timestamp: [], level: [], message: [] };

  private current: LogRecord | null = null;
  /** Blank lines after the current record's last line (kept only if more text follows). */
  private blankRun = 0;

  constructor(format: LogFormat, context: ParseContext) {
    this.format = format;
    this.timestamps = new TimestampParser(context);
    this.multiline = format.multiline ?? true;
    this.enrichers = (format.postProcess ?? []).flatMap((id) => (ENRICHERS[id] ? [ENRICHERS[id]] : []));
    this.regex = format.kind === "regex" && format.pattern ? new RegExp(format.pattern) : null;
    this.groups = format.kind === "regex" && format.pattern ? groupNames(format.pattern) : [];

    if (format.kind === "regex") {
      // Columns in pattern order, with enricher fields right after their source.
      for (const group of this.groups) {
        const role = format.roles?.[group] ?? defaultRole(group);
        this.addKey(group, role);
        for (const enricher of this.enrichers) {
          if (enricher.after === group) enricher.adds?.forEach((name) => this.addKey(name, "none"));
        }
      }
      for (const enricher of this.enrichers) enricher.hides?.forEach((name) => this.superseded.add(name));
    }
  }

  /** Columns in display order: timestamp, level, sources, other fields, message last. */
  columns(): ColumnState[] {
    const all = this.keys.map((name, key): ColumnState => ({
      name,
      key,
      role: this.roles.get(name) ?? "none",
      nonEmpty: this.nonEmpty[key],
      superseded: this.superseded.has(name) || this.enrichers.some((enricher) => enricher.hiddenPrefix && name.startsWith(enricher.hiddenPrefix)),
    }));
    const rank: Record<FieldRole, number> = { timestamp: 0, level: 1, source: 2, none: 3, message: 4 };
    // Array sort is stable: within a rank, discovery (pattern) order.
    return all.sort((a, b) => rank[a.role] - rank[b.role]);
  }

  /** The record's message field (searched by the text filter); null: none, search the raw text. */
  messageKey(record: LogRecord): string | null {
    return this.recordKey(record, "message");
  }

  /** The record's key for a role: the most preferred one it has a value for. */
  private recordKey(record: LogRecord, role: SingleRole): string | null {
    for (const key of this.roleKeys[role]) {
      const value = record.fields[key];
      if (value !== undefined && value !== null) return key;
    }
    return null;
  }

  /** Processes `lines[from..to)`; `firstLine` is the 0-based line number of `lines[0]`. */
  feed(lines: readonly string[], from = 0, to = lines.length, firstLine = 0) {
    for (let i = from; i < to; i++) {
      let line = lines[i];
      if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
      this.line(line, firstLine + i);
    }
  }

  finish() {
    this.emit();
  }

  private line(line: string, lineNo: number) {
    if (line.trim() === "") {
      // Blank lines only matter inside multi-line records.
      if (this.current && this.multiline) this.blankRun++;
      return;
    }
    switch (this.format.kind) {
      case "regex":
        return this.regexLine(line, lineNo);
      case "jsonl":
        return this.jsonLine(line, lineNo);
      case "logfmt":
        return this.logfmtLine(line, lineNo);
      case "plain":
        return this.plainLine(line, lineNo);
    }
  }

  private regexLine(line: string, lineNo: number) {
    const truncated = line.length > MATCH_CAP;
    const match = this.regex?.exec(truncated ? line.slice(0, MATCH_CAP) : line);
    if (!match) {
      this.unmatched(line, lineNo);
      return;
    }
    const fields: Record<string, FieldValue> = {};
    const groups = match.groups ?? {};
    for (const name of this.groups) {
      const value = groups[name];
      if (value !== undefined) fields[name] = value;
    }
    const messageKey = this.roleKeys.message[0];
    if (truncated && messageKey && typeof fields[messageKey] === "string") {
      fields[messageKey] += line.slice(MATCH_CAP);
    }
    this.start({ lineStart: lineNo, lineEnd: lineNo, raw: line, fields });
  }

  private jsonLine(line: string, lineNo: number) {
    let value: unknown;
    try {
      value = line.trimStart().startsWith("{") ? JSON.parse(line) : undefined;
    } catch {
      value = undefined;
    }
    if (!isPlainObject(value)) {
      this.unmatched(line, lineNo);
      return;
    }
    const fields: Record<string, FieldValue> = {};
    flatten(value, fields);
    this.discover(fields);
    this.start({ lineStart: lineNo, lineEnd: lineNo, raw: line, fields });
  }

  private logfmtLine(line: string, lineNo: number) {
    const fields: Record<string, FieldValue> = {};
    let pairs = 0;
    for (const match of capped(line).matchAll(LOGFMT_PAIR)) {
      const { key, q, v } = match.groups ?? {};
      fields[key] = q !== undefined ? q.replace(/\\(.)/g, (_, char: string) => (char === "n" ? "\n" : char)) : (v ?? "");
      pairs++;
    }
    if (pairs === 0) {
      this.unmatched(line, lineNo);
      return;
    }
    this.discover(fields);
    this.start({ lineStart: lineNo, lineEnd: lineNo, raw: line, fields });
  }

  /** Fallback: a leading timestamp and a level keyword when present, else the whole line. */
  private plainLine(line: string, lineNo: number) {
    const stamp = LEADING_TIMESTAMP.exec(line);
    if (!stamp && this.current && CONTINUATION.test(line) && this.current.fields.timestamp !== undefined) {
      this.append(line, lineNo);
      return;
    }
    const fields: Record<string, FieldValue> = {};
    let rest = line;
    if (stamp) {
      fields.timestamp = stamp[1].replace(/^\[(.*)\]$/, "$1");
      rest = line.slice(stamp[0].length).trimStart();
    }
    const head = line.slice(0, 40);
    const level = LEVEL_WORD.exec(head) ?? LEVEL_BRACKETED.exec(head);
    if (level) {
      fields.level = level[1];
      // A level right at the start of the message is not part of it.
      const lead = new RegExp(`^[\\[(<]?${level[1]}[\\])>]?[\\s:|-]*`, "i").exec(rest);
      if (lead) rest = rest.slice(lead[0].length);
    }
    fields.message = rest;
    if (fields.timestamp !== undefined) this.addKey("timestamp", "timestamp");
    if (fields.level !== undefined) this.addKey("level", "level");
    this.addKey("message", "message");
    this.start({ lineStart: lineNo, lineEnd: lineNo, raw: line, fields });
  }

  /** A line that does not start a record. */
  private unmatched(line: string, lineNo: number) {
    if (this.multiline && this.current) {
      this.append(line, lineNo);
      return;
    }
    // Before the first record (multi-line: one leading record), or a line of a
    // single-line format that does not match.
    const key = this.roleKeys.message[0] ?? "message";
    this.addKey(key, "message");
    this.start({ lineStart: lineNo, lineEnd: lineNo, raw: line, fields: { [key]: line }, parseError: true }, false);
  }

  private append(line: string, lineNo: number) {
    const record = this.current;
    if (!record) return;
    const gap = "\n".repeat(this.blankRun + 1);
    this.blankRun = 0;
    const key = this.recordKey(record, "message") ?? this.roleKeys.message[0] ?? "message";
    this.addKey(key, "message");
    const message = record.fields[key];
    record.fields[key] = typeof message === "string" && message !== "" ? message + gap + line : line;
    record.raw += gap + line;
    record.lineEnd = lineNo;
  }

  /** Starts a record: the previous one is complete. */
  private start(record: LogRecord, normalize = true) {
    this.emit();
    if (normalize) {
      const timestampKey = this.recordKey(record, "timestamp");
      if (timestampKey) {
        const epochMs = this.timestamps.parse(record.fields[timestampKey]);
        if (epochMs !== undefined) record.epochMs = epochMs;
      }
      const levelKey = this.recordKey(record, "level");
      if (levelKey) {
        const level = normalizeLevel(record.fields[levelKey]);
        if (level) record.level = level;
      }
      for (const enricher of this.enrichers) enricher.apply(record);
    }
    this.current = record;
  }

  private emit() {
    const record = this.current;
    if (!record) return;
    this.current = null;
    this.blankRun = 0;
    for (const name in record.fields) {
      let key = this.keyIndex.get(name);
      if (key === undefined) key = this.addKey(name, "none");
      if (!isEmptyValue(record.fields[name])) this.nonEmpty[key]++;
    }
    this.records.push(record);
  }

  /** Registers new keys of a JSON / logfmt record, with roles by key name. */
  private discover(fields: Record<string, FieldValue>) {
    for (const name in fields) {
      if (!this.keyIndex.has(name)) this.addKey(name, keyRole(name));
    }
  }

  private addKey(name: string, role: FieldRole): number {
    const existing = this.keyIndex.get(name);
    if (existing !== undefined) return existing;
    const index = this.keys.length;
    this.keys.push(name);
    this.keyIndex.set(name, index);
    this.nonEmpty.push(0);
    this.roles.set(name, role);
    if (role === "timestamp" || role === "level" || role === "message") {
      // Known key names in their order of preference (`@timestamp` before `time`), others in discovery order.
      const rank = (key: string) => {
        const position = KEY_ROLES[role].indexOf(key.toLowerCase());
        return position < 0 ? KEY_ROLES[role].length : position;
      };
      this.roleKeys[role].push(name);
      this.roleKeys[role].sort((a, b) => rank(a) - rank(b));
    }
    return index;
  }
}

function defaultRole(group: string): FieldRole {
  return group === "timestamp" || group === "level" || group === "message" ? group : "none";
}

/** Role of a JSON Lines / logfmt key by its name. */
function keyRole(name: string): FieldRole {
  const lower = name.toLowerCase();
  for (const role of ["timestamp", "level", "message", "source"] as const) {
    if (KEY_ROLES[role].includes(lower)) return role;
  }
  return "none";
}

/** Parses a whole text at once (tests and small files). */
export function parseLog(text: string, format: LogFormat, context: ParseContext): { records: LogRecord[]; columns: ColumnState[] } {
  const parser = new LogParser(format, context);
  parser.feed(splitLines(text));
  parser.finish();
  return { records: parser.records, columns: parser.columns() };
}

/** Lines of a text (without a byte order mark; a trailing newline does not add an empty line). "\r" is stripped by the parser. */
export function splitLines(text: string): string[] {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
