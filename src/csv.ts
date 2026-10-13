// CSV / TSV files: the first record is the header (column names), every other
// record is a row. Fields keep their source ranges, so edits replace single
// fields and leave the rest of the file (quoting, line endings) untouched.
// Free of the vscode API.

import type { EditResult, Placement, TextEdit } from "./edit.ts";
import type { RowLocation, Span } from "./locate.ts";
import type { Cell } from "./messages.ts";

export interface CsvField {
  value: string;
  /** Source range of the field, including its quotes. */
  start: number;
  end: number;
}

export interface CsvRecord {
  fields: CsvField[];
  /** Start of the record's first line. */
  start: number;
  /** Start of the next record (after the line break), or the end of the text. */
  end: number;
}

export interface CsvDocument {
  delimiter: string;
  /** Line break used by the file ("\n" when it has none). */
  eol: string;
  /** Column names from the header, made unique and non-empty. */
  columns: string[];
  header: CsvRecord;
  /** Data records, without blank lines. */
  records: CsvRecord[];
}

export type CsvParseResult = { ok: true; doc: CsvDocument } | { ok: false; message: string; line: number };

const DELIMITERS = [",", ";", "\t", "|"];

/** The delimiter that occurs most often in the header line (outside quotes); "," by default. */
export function detectDelimiter(text: string): string {
  const counts = new Map(DELIMITERS.map((delimiter) => [delimiter, 0]));
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === "\n" || char === "\r")) break;
    else if (!quoted && counts.has(char)) counts.set(char, counts.get(char)! + 1);
  }
  let best = ",";
  for (const [delimiter, count] of counts) {
    if (count > counts.get(best)!) best = delimiter;
  }
  return best;
}

export function parseCsv(text: string): CsvParseResult {
  const delimiter = detectDelimiter(text);
  const eol = text.match(/\r?\n/)?.[0] ?? "\n";
  const records: CsvRecord[] = [];
  // A UTF-8 byte order mark is not part of the first field.
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  while (i < text.length) {
    const recordStart = i;
    const fields: CsvField[] = [];
    for (;;) {
      const start = i;
      let value = "";
      if (text[i] === '"') {
        i++;
        for (;;) {
          if (i >= text.length) {
            return { ok: false, message: `Unterminated quoted field at line ${lineAt(text, start)}.`, line: lineAt(text, start) };
          }
          if (text[i] === '"') {
            if (text[i + 1] === '"') {
              value += '"';
              i += 2;
              continue;
            }
            i++;
            break;
          }
          value += text[i++];
        }
        // Text between the closing quote and the delimiter is kept, like most readers do.
        while (i < text.length && text[i] !== delimiter && text[i] !== "\n" && text[i] !== "\r") value += text[i++];
      } else {
        while (i < text.length && text[i] !== delimiter && text[i] !== "\n" && text[i] !== "\r") value += text[i++];
      }
      fields.push({ value, start, end: i });
      if (text[i] === delimiter) {
        i++;
        continue;
      }
      break;
    }
    if (text[i] === "\r") i++;
    if (text[i] === "\n") i++;
    // Blank lines are not records.
    if (!(fields.length === 1 && fields[0].value === "" && fields[0].start === fields[0].end)) {
      records.push({ fields, start: recordStart, end: i });
    }
  }

  const [header, ...rest] = records;
  if (!header) {
    return { ok: false, message: "The file is empty.", line: 1 };
  }
  return { ok: true, doc: { delimiter, eol, columns: columnNames(header), header, records: rest } };
}

/** Header names, trimmed; empty ones become `column_N`, duplicates get a `_2`, `_3`, ... suffix. */
function columnNames(header: CsvRecord): string[] {
  const seen = new Set<string>();
  return header.fields.map((field, index) => {
    const base = field.value.trim() || `column_${index + 1}`;
    let name = base;
    for (let n = 2; seen.has(name); n++) name = `${base}_${n}`;
    seen.add(name);
    return name;
  });
}

/** A value as a CSV field: quoted when it contains the delimiter, quotes, line breaks or edge spaces. */
export function csvField(value: string, delimiter: string): string {
  const needsQuotes = value.includes(delimiter) || /["\r\n]/.test(value) || value !== value.trim();
  return needsQuotes ? `"${value.replace(/"/g, '""')}"` : value;
}

// --- Editing ---------------------------------------------------------------------

function parsed(text: string, rows?: number): { ok: false; message: string } | { ok: true; doc: CsvDocument } {
  const result = parseCsv(text);
  if (!result.ok) return { ok: false, message: `The file has CSV errors; fix them before editing in the table. ${result.message}` };
  if (rows !== undefined && result.doc.records.length !== rows) return { ok: false, message: "Cannot locate the rows in the file." };
  return result;
}

/** A cell value as CSV text: lists are comma-separated, null and removed values are empty. */
function cellText(value: Cell | undefined): string {
  if (value === null || value === undefined) return "";
  return Array.isArray(value) ? value.map((item) => (item === null ? "" : String(item))).join(", ") : String(value);
}

/** Sets the field of row `index` in column `column` (an empty field when `value` is undefined). */
export function editCsv(text: string, index: number, column: string, value: Cell | undefined): EditResult {
  const result = parsed(text);
  if (!result.ok) return result;
  const { doc } = result;
  const record = doc.records[index];
  const at = doc.columns.indexOf(column);
  if (!record) return { ok: false, message: "Cannot locate the row in the file." };
  if (at === -1) return { ok: false, message: `"${column}" is not a column of this file.` };

  const field = csvField(cellText(value), doc.delimiter);
  if (at < record.fields.length) {
    const { start, end } = record.fields[at];
    return { ok: true, edits: [{ offset: start, length: end - start, text: field }] };
  }
  // A short record: pad it with empty fields up to the column.
  const last = record.fields[record.fields.length - 1];
  return { ok: true, edits: [{ offset: last.end, length: 0, text: doc.delimiter.repeat(at - record.fields.length + 1) + field }] };
}

/** Adds a record with only an ID (when there is an `idField` column) next to row `index`. */
export function insertCsvRow(text: string, rows: number, index: number, placement: Placement, id: string, idField: string): EditResult {
  const result = parsed(text, rows);
  if (!result.ok) return result;
  const { doc } = result;
  let line = doc.columns.map((column) => (column === idField ? csvField(id, doc.delimiter) : "")).join(doc.delimiter);
  // A single empty field would be a blank line, which is not a record.
  if (line === "") line = '""';
  const record = doc.records[index];
  if (placement === "above") {
    return { ok: true, edits: [{ offset: record.start, length: 0, text: line + doc.eol }] };
  }
  const endsWithBreak = /\n$/.test(text.slice(record.start, record.end));
  return { ok: true, edits: [{ offset: record.end, length: 0, text: endsWithBreak ? line + doc.eol : doc.eol + line }] };
}

export function deleteCsvRow(text: string, rows: number, index: number): EditResult {
  const result = parsed(text, rows);
  if (!result.ok) return result;
  let { start, end } = result.doc.records[index];
  if (!/\n$/.test(text.slice(start, end))) {
    // The last line has no line break: remove the one before it instead.
    if (text[start - 1] === "\n") start--;
    if (text[start - 1] === "\r") start--;
  }
  return { ok: true, edits: [{ offset: start, length: end - start, text: "" }] };
}

/** Reorders the records (each with the blank lines after it) into `order`. */
export function moveCsvRows(text: string, rows: number, order: number[]): EditResult {
  const result = parsed(text, rows);
  if (!result.ok) return result;
  const { records, eol } = result.doc;
  const segments = records.map((record, i) => text.slice(record.start, i < records.length - 1 ? records[i + 1].start : record.end));
  const last = segments.length - 1;
  const finalBreak = /\n$/.test(segments[last]);
  if (!finalBreak) segments[last] += eol;
  let region = order.map((i) => segments[i]).join("");
  if (!finalBreak) region = region.slice(0, -eol.length);
  const start = records[0].start;
  const edit: TextEdit = { offset: start, length: records[last].end - start, text: region };
  return { ok: true, edits: [edit] };
}

export function locateCsvRow(text: string, index: number): RowLocation | null {
  const result = parseCsv(text);
  const record = result.ok ? result.doc.records[index] : undefined;
  if (!result.ok || !record) return null;
  const fields: Record<string, Span> = {};
  record.fields.forEach((field, i) => {
    if (i < result.doc.columns.length) fields[result.doc.columns[i]] = [field.start, field.end];
  });
  return { row: [record.start, record.fields[record.fields.length - 1].end], fields };
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}
