// Computes minimal text edits that change one field of one row, keeping the
// rest of the file (formatting, comments, quoting) untouched. Free of the
// vscode API so it can be unit-tested with plain Node.
//
// JSON uses jsonc-parser's `modify`. YAML is edited in place using the source
// ranges of the parsed document, because re-serializing the whole document
// would reformat it.

import * as jsonc from "jsonc-parser";
import * as YAML from "yaml";
import { deleteCsvRow, editCsv, insertCsvRow, moveCsvRows } from "./csv.ts";
import type { Cell, Scalar } from "./messages.ts";
import type { Language, RowPath, Table } from "./parser.ts";

export interface TextEdit {
  offset: number;
  length: number;
  text: string;
}

export type EditResult = { ok: true; edits: TextEdit[] } | { ok: false; message: string };

/** Sets `field` of the row at `rowPath` to `value`, or removes it when `value` is undefined. */
export function computeEdit(
  text: string,
  language: Language,
  rowPath: RowPath,
  field: string,
  value: Cell | undefined,
): EditResult {
  switch (language) {
    case "yaml":
      return editYaml(text, rowPath, field, value);
    case "csv":
      return editCsv(text, rowPath[0] as number, field, value);
    case "json":
      return editJson(text, rowPath, field, value);
  }
}

export function applyEdits(text: string, edits: TextEdit[]): string {
  return [...edits]
    .sort((a, b) => b.offset - a.offset)
    .reduce((result, edit) => result.slice(0, edit.offset) + edit.text + result.slice(edit.offset + edit.length), text);
}

// --- JSON ------------------------------------------------------------------------

function jsonFormatting(text: string): jsonc.FormattingOptions {
  const indent = text.match(/^([ \t]+)\S/m)?.[1] ?? "  ";
  return {
    insertSpaces: !indent.startsWith("\t"),
    tabSize: indent.startsWith("\t") ? 1 : indent.length,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
  };
}

function jsonEdits(edits: jsonc.Edit[]): EditResult {
  return { ok: true, edits: edits.map(({ offset, length, content }) => ({ offset, length, text: content })) };
}

function editJson(text: string, rowPath: RowPath, field: string, value: Cell | undefined): EditResult {
  return jsonEdits(jsonc.modify(text, [...rowPath, field], value, { formattingOptions: jsonFormatting(text) }));
}

// --- YAML ------------------------------------------------------------------------

type Range = [number, number, number];

function fail(message: string): EditResult {
  return { ok: false, message };
}

function rangeOf(node: unknown): Range | undefined {
  return YAML.isNode(node) && node.range ? (node.range as Range) : undefined;
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

function lineEnd(text: string, offset: number): number {
  const end = text.indexOf("\n", offset);
  return end === -1 ? text.length : end;
}

/** End of a value, excluding trailing whitespace and line breaks. */
function trimmedEnd(text: string, start: number, end: number): number {
  while (end > start && /\s/.test(text[end - 1])) end--;
  return end;
}

/**
 * A single-line YAML scalar: plain when safe, quoted otherwise. Uses YAML 1.1
 * rules so strings like `yes` / `no` stay strings for 1.1 tools (e.g. PyYAML) too.
 */
function inlineScalar(value: Scalar, flow: boolean): string {
  if (value === null) return "null";
  if (typeof value !== "string") return String(value);
  const plain = YAML.stringify(value, { lineWidth: 0, version: "1.1", singleQuote: true }).trimEnd();
  const quoted = /^["']/.test(plain);
  if (plain.includes("\n") || /^[|>]/.test(plain) || (flow && !quoted && /[,[\]{}]/.test(plain))) {
    return JSON.stringify(value);
  }
  return plain;
}

/**
 * Text that follows `key:` for a value. Block forms (literal scalars,
 * sequences) are indented relative to the key's column.
 */
function serializeValue(value: Cell, flow: boolean, keyColumn: number, seqColumn: number): string {
  if (Array.isArray(value)) {
    if (flow || value.length === 0) {
      return ` [${value.map((item) => inlineScalar(item, true)).join(", ")}]`;
    }
    const indent = " ".repeat(seqColumn);
    return value.map((item) => `\n${indent}- ${inlineScalar(item, false)}`).join("");
  }

  if (typeof value === "string" && value.includes("\n") && !flow && !/^[ \t]/.test(value)) {
    const chomp = value.endsWith("\n\n") ? "+" : value.endsWith("\n") ? "" : "-";
    const lines = (chomp === "-" ? value : value.slice(0, -1)).split("\n");
    const indent = " ".repeat(keyColumn + 2);
    return ` |${chomp}${lines.map((line) => `\n${line ? indent + line : ""}`).join("")}`;
  }
  return ` ${inlineScalar(value, flow)}`;
}

function editYaml(text: string, rowPath: RowPath, field: string, value: Cell | undefined): EditResult {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length > 0) {
    return fail("The file has YAML errors; fix them before editing in the table.");
  }
  const row = doc.getIn(rowPath, true);
  if (!YAML.isMap(row)) {
    return fail("This entry is not an object and cannot be edited in the table.");
  }
  const flow = !!row.flow;
  const index = row.items.findIndex((pair) => YAML.isScalar(pair.key) && String(pair.key.value) === field);
  const pair = row.items[index];

  if (!pair) {
    return value === undefined ? { ok: true, edits: [] } : insertPair(text, row, flow, field, value);
  }

  const keyRange = rangeOf(pair.key);
  if (!keyRange) {
    return fail(`Cannot locate "${field}" in the file.`);
  }
  const keyStart = keyRange[0];
  const colon = text.indexOf(":", keyRange[1]);
  const valueRange = rangeOf(pair.value);
  const valueEnd = valueRange ? trimmedEnd(text, colon + 1, valueRange[1]) : colon + 1;

  if (value === undefined) {
    return removePair(text, row, flow, index, keyStart, valueEnd);
  }

  const keyColumn = keyStart - lineStart(text, keyStart);
  const existingBlockSeq = YAML.isSeq(pair.value) && !pair.value.flow && valueRange;
  const seqColumn = existingBlockSeq ? valueRange[0] - lineStart(text, valueRange[0]) : keyColumn + 2;
  const replacement = serializeValue(value, flow, keyColumn, seqColumn);
  return { ok: true, edits: [{ offset: colon + 1, length: valueEnd - colon - 1, text: replacement }] };
}

function insertPair(text: string, row: YAML.YAMLMap, flow: boolean, field: string, value: Cell): EditResult {
  const key = inlineScalar(field, flow);

  if (flow) {
    const rowRange = rangeOf(row);
    const close = rowRange ? text.lastIndexOf("}", rowRange[1]) : -1;
    if (!rowRange || close === -1) return fail("Cannot locate the entry in the file.");

    // An empty `{}` that is the value of a block key (e.g. a newly added
    // mapping entry `ID: {}`) becomes a regular indented block.
    const linePrefix = text.slice(lineStart(text, rowRange[0]), rowRange[0]);
    if (row.items.length === 0 && /^\s*\S.*:\s*$/.test(linePrefix) && !/[[{]/.test(linePrefix)) {
      const keyColumn = linePrefix.search(/\S/) + 2;
      const block = `\n${" ".repeat(keyColumn)}${inlineScalar(field, false)}:${serializeValue(value, false, keyColumn, keyColumn + 2)}`;
      const start = trimmedEnd(text, 0, rowRange[0]);
      return { ok: true, edits: [{ offset: start, length: close + 1 - start, text: block }] };
    }
    const separator = row.items.length > 0 ? ", " : "";
    const before = trimmedEnd(text, 0, close);
    return {
      ok: true,
      edits: [{ offset: before, length: 0, text: `${separator}${key}:${serializeValue(value, true, 0, 0)}` }],
    };
  }

  const first = rangeOf(row.items[0]?.key);
  const last = row.items[row.items.length - 1];
  const lastRange = rangeOf(last?.value) ?? rangeOf(last?.key);
  if (!first || !lastRange) return fail("Cannot locate the entry in the file.");

  const keyColumn = first[0] - lineStart(text, first[0]);
  const at = lineEnd(text, trimmedEnd(text, first[0], lastRange[1]));
  const line = `\n${" ".repeat(keyColumn)}${key}:${serializeValue(value, false, keyColumn, keyColumn + 2)}`;
  return { ok: true, edits: [{ offset: at, length: 0, text: line }] };
}

function removePair(
  text: string,
  row: YAML.YAMLMap,
  flow: boolean,
  index: number,
  keyStart: number,
  valueEnd: number,
): EditResult {
  const next = rangeOf(row.items[index + 1]?.key);
  const edit = (start: number, end: number, replacement = ""): EditResult => ({
    ok: true,
    edits: [{ offset: start, length: end - start, text: replacement }],
  });

  if (flow) {
    if (index > 0) {
      const previous = row.items[index - 1];
      const previousRange = rangeOf(previous.value) ?? rangeOf(previous.key);
      if (!previousRange) return fail("Cannot locate the entry in the file.");
      return edit(trimmedEnd(text, 0, previousRange[1]), valueEnd);
    }
    return next ? edit(keyStart, next[0]) : edit(keyStart, valueEnd);
  }

  const start = lineStart(text, keyStart);
  if (/^\s*$/.test(text.slice(start, keyStart))) {
    // The pair has its own line(s): drop them.
    const end = lineEnd(text, valueEnd);
    return edit(start, Math.min(end + 1, text.length));
  }
  // First pair after a "- " sequence marker: pull the next key up, or leave an empty object.
  return next ? edit(keyStart, next[0]) : edit(keyStart, valueEnd, "{}");
}

// --- Rows: add, delete, move -------------------------------------------------------

export type Placement = "above" | "below";

/** Adds an entry with only an ID next to row `index` (for mappings, the ID is the key). */
export function insertRow(
  text: string,
  language: Language,
  table: Pick<Table, "shape" | "paths">,
  index: number,
  placement: Placement,
  id: string,
  idField: string,
): EditResult {
  const at = placement === "above" ? index : index + 1;
  if (language === "csv") {
    return insertCsvRow(text, table.paths.length, index, placement, id, idField);
  }
  if (language === "json") {
    const formattingOptions = jsonFormatting(text);
    if (table.shape === "mapping") {
      return jsonEdits(jsonc.modify(text, [id], {}, { formattingOptions, getInsertionIndex: () => at }));
    }
    return jsonEdits(
      jsonc.modify(text, [at], { [idField]: id }, { formattingOptions, isArrayInsertion: true }),
    );
  }

  const blocks = yamlBlocks(text, table);
  if (!blocks.ok) return blocks;
  const reference = blocks.items[Math.min(index, blocks.items.length - 1)];
  const line =
    table.shape === "mapping"
      ? `${reference.indent}${inlineScalar(id, false)}: {}\n`
      : `${reference.indent}- ${inlineScalar(idField, false)}: ${inlineScalar(id, false)}\n`;
  const offset = placement === "above" ? blocks.items[index].start : blocks.items[index].end;
  return blocks.apply([{ offset, length: 0, text: line }]);
}

export function deleteRow(text: string, language: Language, table: Pick<Table, "shape" | "paths">, index: number): EditResult {
  if (language === "csv") {
    return deleteCsvRow(text, table.paths.length, index);
  }
  if (language === "json") {
    return jsonEdits(jsonc.modify(text, table.paths[index], undefined, { formattingOptions: jsonFormatting(text) }));
  }
  const blocks = yamlBlocks(text, table);
  if (!blocks.ok) return blocks;
  if (blocks.items.length === 1) {
    return fail("The last entry cannot be deleted in the table.");
  }
  const { start, end } = blocks.items[index];
  return blocks.apply([{ offset: start, length: end - start, text: "" }]);
}

/** Moves row `from` directly above or below row `target`. */
export function moveRow(
  text: string,
  language: Language,
  table: Pick<Table, "shape" | "paths">,
  from: number,
  target: number,
  placement: Placement,
): EditResult {
  if (from === target) return { ok: true, edits: [] };
  const order = table.paths.map((_, index) => index).filter((index) => index !== from);
  order.splice(order.indexOf(target) + (placement === "below" ? 1 : 0), 0, from);
  if (order.every((index, position) => index === position)) return { ok: true, edits: [] };

  if (language === "csv") {
    return moveCsvRows(text, table.paths.length, order);
  }
  if (language === "json") {
    const root = jsonc.parseTree(text, [], { allowTrailingComma: true });
    const items = root?.children;
    if (!items || items.length !== table.paths.length) return fail("Cannot locate the entries in the file.");
    // Keep the separators (commas, line breaks, indentation) in place; move the items.
    const spans = items.map((item) => [item.offset, item.offset + item.length] as const);
    let region = "";
    order.forEach((index, position) => {
      region += text.slice(...spans[index]);
      if (position < spans.length - 1) region += text.slice(spans[position][1], spans[position + 1][0]);
    });
    const start = spans[0][0];
    return { ok: true, edits: [{ offset: start, length: spans[spans.length - 1][1] - start, text: region }] };
  }

  const blocks = yamlBlocks(text, table);
  if (!blocks.ok) return blocks;
  const start = blocks.items[0].start;
  const end = blocks.items[blocks.items.length - 1].end;
  const region = order.map((index) => blocks.text.slice(blocks.items[index].start, blocks.items[index].end)).join("");
  return blocks.apply([{ offset: start, length: end - start, text: region }]);
}

interface YamlBlock {
  /** Start of the entry's first line. */
  start: number;
  /** Start of the next entry's first line (or the end of this entry's last line). */
  end: number;
  /** Indentation of the entry's first line, without the "- " marker. */
  indent: string;
}

/**
 * The rows of a block-style YAML collection as whole lines, so they can be
 * moved and removed as units (comments inside an entry move with it). Works on
 * the text with a final newline; `apply` maps edits back to the original text.
 */
function yamlBlocks(
  original: string,
  table: Pick<Table, "shape" | "paths">,
): { ok: false; message: string } | { ok: true; items: YamlBlock[]; text: string; apply(edits: TextEdit[]): EditResult } {
  const text = original.endsWith("\n") ? original : `${original}\n`;
  const doc = YAML.parseDocument(text);
  if (doc.errors.length > 0) {
    return { ok: false, message: "The file has YAML errors; fix them before editing in the table." };
  }
  const container = doc.contents;
  if (!(YAML.isSeq(container) || YAML.isMap(container)) || container.flow) {
    return { ok: false, message: "Rows can only be added, removed or moved in block-style YAML collections." };
  }

  const starts: number[] = [];
  const ends: number[] = [];
  for (const item of container.items as unknown[]) {
    const node = YAML.isPair(item) ? item.key : item;
    const range = rangeOf(node);
    const valueRange = YAML.isPair(item) ? (rangeOf(item.value) ?? range) : range;
    if (!range || !valueRange) {
      return { ok: false, message: "Cannot locate the entries in the file." };
    }
    starts.push(lineStart(text, range[0]));
    ends.push(Math.min(lineEnd(text, trimmedEnd(text, range[0], valueRange[1])) + 1, text.length));
  }

  const items = starts.map((start, i) => {
    const prefix = text.slice(start, i < starts.length - 1 ? starts[i + 1] : ends[i]).match(/^[ \t]*/)?.[0] ?? "";
    return { start, end: i < starts.length - 1 ? starts[i + 1] : ends[i], indent: prefix };
  });

  return {
    ok: true,
    items,
    text,
    apply(edits) {
      // Edits never reach past the added final newline except at its very end.
      if (text === original) return { ok: true, edits };
      return {
        ok: true,
        edits: edits.map((edit) => {
          if (edit.offset >= original.length && edit.length === 0) {
            // Appending after a last line that has no newline.
            return { offset: original.length, length: 0, text: `\n${edit.text.replace(/\n$/, "")}` };
          }
          if (edit.offset + edit.length <= original.length) return edit;
          const length = original.length - edit.offset;
          return { offset: edit.offset, length, text: edit.text.endsWith("\n") ? edit.text.slice(0, -1) : edit.text };
        }),
      };
    },
  };
}
