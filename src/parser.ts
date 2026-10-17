// Turns JSON / YAML / CSV text into table rows. Free of the vscode API so it can be
// unit-tested with plain Node.
//
// Supported shapes, at the top level of the file or at a configured data path
// (e.g. `document.data.objects`, see `parseDataPath`):
//   array:    [ {...}, ... ]         a list of entries
//   mapping:  { ID: {...}, ... }     a hash of ID -> entry (every value an object)
// CSV / TSV files are always a list: the header names the fields (see csv.ts).

import * as jsonc from "jsonc-parser";
import * as YAML from "yaml";
import { parseCsv } from "./csv.ts";
import {
  ROW_INDEX,
  ROW_LOCKED,
  type Cell,
  type ErrorKind,
  type Row,
  type Scalar,
} from "./messages.ts";

export type Language = "json" | "yaml" | "csv";
export type Shape = "array" | "mapping";
/** Location of a row's object in the document: [3] (list) or ["REQ-001"] (hash), after `root`. */
export type RowPath = (string | number)[];

export interface ParseOptions {
  /** Field name for the key of each entry in the `mapping` shape. */
  idField: string;
  /** Path to the entries in the document (see `parseDataPath`); null or [] = the top level. */
  dataPath?: string[] | null;
}

export interface Table {
  shape: Shape;
  /** Document path of the list or hash that holds the entries ([] = the top level). */
  root: RowPath;
  rows: Row[];
  /** Union of all row fields in first-seen order (excludes ROW_INDEX). */
  fields: string[];
  /** Source offset of each row's entry, indexed like `rows`. */
  offsets: number[];
  /** Document path of each row's object, indexed like `rows`. */
  paths: RowPath[];
}

export type ParseResult =
  | { ok: true; table: Table }
  | {
      ok: false;
      kind: ErrorKind;
      message: string;
      line?: number;
      /** Data path of a nested table, offered when the top level is not one. */
      suggestedPath?: string[];
    };

export function languageForPath(path: string): Language {
  if (/\.ya?ml$/i.test(path)) return "yaml";
  if (/\.(csv|tsv)$/i.test(path)) return "csv";
  return "json";
}

export function parseTable(
  text: string,
  language: Language,
  options: ParseOptions,
): ParseResult {
  if (!text.trim()) {
    return { ok: false, kind: "empty", message: "The file is empty." };
  }

  if (language === "csv") {
    return parseCsvTable(text);
  }

  const source = language === "yaml" ? loadYaml(text) : loadJson(text);
  if ("error" in source) {
    return { ok: false, kind: "syntax", ...source.error };
  }

  const dataPath = options.dataPath ?? [];
  const resolved = resolveDataPath(source.value, dataPath);
  if ("missing" in resolved) {
    return { ok: false, kind: "shape", message: resolved.missing };
  }
  const { root, value } = resolved;

  const shape = detectShape(value);
  if (!shape) {
    if (dataPath.length > 0) {
      return {
        ok: false,
        kind: "shape",
        message: `Expected a list of entries or a hash of ID -> entry at "${formatDataPath(dataPath)}".`,
      };
    }
    const nested = findNestedTable(value)?.map(String);
    const hint = nested && formatDataPath(nested);
    return {
      ok: false,
      kind: "shape",
      message:
        "Expected a list of entries or a hash of ID -> entry at the top level of the file." +
        (hint ? ` There is one at "${hint}". To always show it, set \`path: ${hint}\` in a view in .vscode/tablify.yaml.` : ""),
      ...(nested && { suggestedPath: nested }),
    };
  }

  const items = rawItems(value, shape);
  const entries = toEntries(value, shape, options.idField);
  const offsets = source.offsets(root, shape);
  const fields: string[] = [];
  const seen = new Set<string>();

  const rows = entries.map((entry, index) => {
    const row: Row = {};
    // Cells that cannot be edited in place: the key of a mapping entry,
    // nested structures, and everything in rows that are not objects.
    const locked: string[] = isPlainObject(items[index].value) ? [] : ["*"];
    if (shape === "mapping") {
      locked.push(options.idField);
    }

    for (const [key, value] of Object.entries(entry)) {
      if (value === undefined) {
        continue;
      }
      const cell = toCell(value);
      row[key] = cell;
      if (isComplex(value)) {
        locked.push(key);
      }
      if (!seen.has(key)) {
        seen.add(key);
        fields.push(key);
      }
    }
    row[ROW_INDEX] = index;
    if (locked.length > 0) {
      row[ROW_LOCKED] = locked;
    }
    return row;
  });

  const paths = items.map(({ key }): RowPath => [...root, key]);
  return { ok: true, table: { shape, root, rows, fields, offsets, paths } };
}

/**
 * Parses a data path: keys separated by "." or "/", array indices as `[0]` or
 * plain `0`, and keys with special characters quoted as `["a.b"]`. A leading
 * `$`, `$.` or `/` is allowed, so JSONPath and XPath-like spellings work:
 * `document.data.objects`, `$.document.data.objects`, `/document/data/objects`,
 * `items[0].rows`. Returns null when the syntax is invalid; "" is the top level.
 */
export function parseDataPath(text: string): string[] | null {
  const source = text.trim().replace(/^\$/, "");
  const token = /\[(\d+)\]|\[\s*"((?:[^"\\]|\\.)*)"\s*\]|\[\s*'([^']*)'\s*\]|([^./[\]]+)|([./])/y;
  const segments: string[] = [];
  // At the start, or right after a separator: a plain key may follow.
  let expectKey = true;
  while (token.lastIndex < source.length) {
    const start = token.lastIndex;
    const match = token.exec(source);
    if (!match) return null;
    const [, index, double, single, key, separator] = match;
    if (separator !== undefined) {
      if (expectKey && start > 0) return null;
      expectKey = true;
      continue;
    }
    if (key !== undefined && !expectKey) return null;
    if (double !== undefined) {
      try {
        segments.push(JSON.parse(`"${double}"`) as string);
      } catch {
        return null;
      }
    } else {
      segments.push(index ?? single ?? key);
    }
    expectKey = false;
  }
  return expectKey && segments.length > 0 ? null : segments;
}

export function formatDataPath(segments: string[]): string {
  return segments
    .map((segment, i) =>
      /^[^./[\]"']+$/.test(segment) ? `${i > 0 ? "." : ""}${segment}` : `[${JSON.stringify(segment)}]`,
    )
    .join("");
}

/** Follows `segments` into `value`; array indices become numbers in `root`. */
function resolveDataPath(
  value: unknown,
  segments: string[],
): { root: RowPath; value: unknown } | { missing: string } {
  const root: RowPath = [];
  let current = value;
  for (const segment of segments) {
    if (Array.isArray(current) && /^\d+$/.test(segment) && Number(segment) < current.length) {
      root.push(Number(segment));
      current = current[Number(segment)];
    } else if (isPlainObject(current) && Object.hasOwn(current, segment)) {
      root.push(segment);
      current = current[segment];
    } else {
      const at = root.length > 0 ? ` in "${formatDataPath(root.map(String))}"` : " at the top level";
      return { missing: `The data path "${formatDataPath(segments)}" does not exist in this file: no "${segment}"${at}.` };
    }
  }
  return { root, value: current };
}

/** The shallowest nested list of objects or hash of entries, breadth first. */
function findNestedTable(value: unknown): RowPath | null {
  const queue: { path: RowPath; value: unknown }[] = [{ path: [], value }];
  for (let i = 0; i < queue.length && i < 10_000; i++) {
    const { path, value: current } = queue[i];
    if (path.length > 0 && isTableLike(current)) return path;
    if (Array.isArray(current)) {
      current.forEach((item, index) => queue.push({ path: [...path, index], value: item }));
    } else if (isPlainObject(current)) {
      Object.entries(current).forEach(([key, item]) => queue.push({ path: [...path, key], value: item }));
    }
  }
  return null;
}

/** A non-empty list of objects, or a hash of entries: worth suggesting as a data path. */
function isTableLike(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0 && value.every(isPlainObject);
  return detectShape(value) === "mapping";
}

/** Every field is a string; empty fields are left out, like missing fields in JSON. */
function parseCsvTable(text: string): ParseResult {
  const result = parseCsv(text);
  if (!result.ok) {
    return { ok: false, kind: "syntax", message: result.message, line: result.line };
  }
  const { columns, records } = result.doc;
  const rows = records.map((record, index) => {
    const row: Row = {};
    record.fields.forEach((field, i) => {
      if (i < columns.length && field.value !== "") row[columns[i]] = field.value;
    });
    row[ROW_INDEX] = index;
    return row;
  });
  return {
    ok: true,
    table: {
      shape: "array",
      root: [],
      rows,
      fields: columns,
      offsets: records.map((record) => record.start),
      paths: records.map((_, index): RowPath => [index]),
    },
  };
}

interface Source {
  value: unknown;
  /** Source offsets of the entries of the collection at `root`. */
  offsets(root: RowPath, shape: Shape): number[];
}

interface SourceError {
  error: { message: string; line?: number };
}

function loadJson(text: string): Source | SourceError {
  const errors: jsonc.ParseError[] = [];
  const root = jsonc.parseTree(text, errors, { allowTrailingComma: true });

  if (errors.length > 0 || !root) {
    const first = errors[0];
    return {
      error: {
        message: first
          ? `${jsonc.printParseErrorCode(first.error)} at line ${lineAt(text, first.offset)}.`
          : "Invalid JSON.",
        line: first ? lineAt(text, first.offset) : undefined,
      },
    };
  }

  return {
    value: jsonc.getNodeValue(root),
    offsets(path) {
      const container = path.length > 0 ? jsonc.findNodeAtLocation(root, path) : root;
      // Array items, or property nodes (which start at their key) of an object.
      return (container?.children ?? []).map((item) => item.offset);
    },
  };
}

function loadYaml(text: string): Source | SourceError {
  const doc = YAML.parseDocument(text);

  if (doc.errors.length > 0) {
    const first = doc.errors[0];
    return {
      error: {
        message: first.message.split("\n")[0],
        line: first.linePos?.[0].line,
      },
    };
  }

  const start = (node: unknown) =>
    YAML.isNode(node) && node.range ? node.range[0] : 0;

  return {
    value: doc.toJS(),
    offsets(path, shape) {
      const container = doc.getIn(path, true);
      switch (shape) {
        case "array":
          return YAML.isSeq(container) ? container.items.map(start) : [];
        case "mapping":
          return YAML.isMap(container)
            ? container.items.map((pair) => start(pair.key))
            : [];
      }
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function detectShape(value: unknown): Shape | null {
  if (Array.isArray(value)) {
    return "array";
  }
  if (!isPlainObject(value)) {
    return null;
  }
  const entries = Object.values(value);
  if (entries.length > 0 && entries.every((entry) => isPlainObject(entry) || entry === null)) {
    return "mapping";
  }
  return null;
}

function toEntries(
  value: unknown,
  shape: Shape,
  idField: string,
): Record<string, unknown>[] {
  const asObject = (item: unknown): Record<string, unknown> =>
    isPlainObject(item) ? item : { value: item };

  switch (shape) {
    case "array":
      return (value as unknown[]).map(asObject);
    case "mapping":
      // The mapping key wins over a field of the same name.
      return Object.entries(value as Record<string, unknown>).map(([id, fields]) => {
        const { [idField]: _ignored, ...rest } = isPlainObject(fields) ? fields : {};
        return { [idField]: id, ...rest };
      });
  }
}

function rawItems(value: unknown, shape: Shape): { key: string | number; value: unknown }[] {
  switch (shape) {
    case "array":
      return (value as unknown[]).map((item, key) => ({ key, value: item }));
    case "mapping":
      return Object.entries(value as Record<string, unknown>).map(([key, item]) => ({ key, value: item }));
  }
}

function isComplex(value: unknown): boolean {
  return !isScalar(value) && !(Array.isArray(value) && value.every(isScalar));
}

function isScalar(value: unknown): value is Scalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function toCell(value: unknown): Cell {
  if (isScalar(value)) {
    return value;
  }
  if (Array.isArray(value) && value.every(isScalar)) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return JSON.stringify(value);
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
    }
  }
  return line;
}
