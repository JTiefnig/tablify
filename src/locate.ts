// Source positions of a row and its fields, used to map line-based git
// information (blame) to fields. Free of the vscode API.

import * as jsonc from "jsonc-parser";
import * as YAML from "yaml";
import { locateCsvRow } from "./csv.ts";
import type { Language, RowPath } from "./parser.ts";

export type Span = [start: number, end: number];

export interface RowLocation {
  /** The whole entry, including its key for mapping entries. */
  row: Span;
  fields: Record<string, Span>;
}

export function locateRow(text: string, language: Language, rowPath: RowPath): RowLocation | null {
  switch (language) {
    case "yaml":
      return locateYaml(text, rowPath);
    case "csv":
      return locateCsvRow(text, rowPath[0] as number);
    case "json":
      return locateJson(text, rowPath);
  }
}

function locateJson(text: string, rowPath: RowPath): RowLocation | null {
  const root = jsonc.parseTree(text, [], { allowTrailingComma: true });
  const node = root && jsonc.findNodeAtLocation(root, rowPath);
  if (!node || node.type !== "object") {
    return null;
  }
  // A mapping entry starts at its key (the parent property node).
  const outer = node.parent?.type === "property" ? node.parent : node;
  const fields: Record<string, Span> = {};
  for (const property of node.children ?? []) {
    const key = property.children?.[0];
    if (key?.type === "string") {
      fields[String(key.value)] = [property.offset, property.offset + property.length];
    }
  }
  return { row: [outer.offset, outer.offset + outer.length], fields };
}

function locateYaml(text: string, rowPath: RowPath): RowLocation | null {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length > 0) {
    return null;
  }
  const node = doc.getIn(rowPath, true);
  if (!YAML.isMap(node) || !node.range) {
    return null;
  }

  const fields: Record<string, Span> = {};
  let end = node.range[1];
  for (const pair of node.items) {
    if (!YAML.isScalar(pair.key) || !pair.key.range) continue;
    const valueEnd = YAML.isNode(pair.value) && pair.value.range ? pair.value.range[1] : pair.key.range[1];
    fields[String(pair.key.value)] = [pair.key.range[0], trimEnd(text, valueEnd)];
    end = Math.max(end, valueEnd);
  }

  // A mapping entry starts at its key.
  let start = node.range[0];
  const parent = rowPath.length === 1 ? doc.contents : null;
  if (YAML.isMap(parent)) {
    const pair = parent.items.find((item) => YAML.isScalar(item.key) && String(item.key.value) === String(rowPath[0]));
    if (YAML.isScalar(pair?.key) && pair.key.range) start = pair.key.range[0];
  }
  return { row: [start, trimEnd(text, end)], fields };
}

function trimEnd(text: string, end: number): number {
  while (end > 0 && /\s/.test(text[end - 1])) end--;
  return end;
}
