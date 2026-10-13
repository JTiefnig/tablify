// Compares the rows of the current text with the rows of the last commit.
// Rows are matched by identity (mapping key, or the ID field, or position as a
// fallback), so reformatting the file does not count as a change. Free of the
// vscode API.

import { ROW_INDEX, ROW_LOCKED, type Cell, type DeletedRow, type Row, type RowChange } from "./messages.ts";
import type { Table } from "./parser.ts";

const HIDDEN = new Set([ROW_INDEX, ROW_LOCKED]);

function rowKey(table: Table, index: number, idField: string): string {
  if (table.shape === "mapping") {
    return `key:${table.paths[index][0]}`;
  }
  const id = table.rows[index][idField];
  return id !== null && id !== undefined && !Array.isArray(id) ? `id:${String(id)}` : `index:${index}`;
}

function same(a: Cell | undefined, b: Cell | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function fieldsOf(row: Row): string[] {
  return Object.keys(row).filter((field) => !HIDDEN.has(field));
}

/**
 * Changes of `current` relative to `head`. With `head` null (file not in the
 * last commit) every row is added.
 */
export function diffRows(head: Table | null, current: Table, idField: string): Record<number, RowChange> {
  const before = new Map<string, Row>();
  if (head) {
    head.rows.forEach((row, index) => before.set(rowKey(head, index, idField), row));
  }

  const changes: Record<number, RowChange> = {};
  current.rows.forEach((row, index) => {
    const old = before.get(rowKey(current, index, idField));
    if (!old) {
      changes[index] = {
        status: "added",
        fields: Object.fromEntries(fieldsOf(row).map((field) => [field, { kind: "added" as const }])),
      };
      return;
    }

    const fields: RowChange["fields"] = {};
    for (const field of new Set([...fieldsOf(old), ...fieldsOf(row)])) {
      if (!(field in row)) {
        fields[field] = { kind: "removed", before: old[field] };
      } else if (!(field in old)) {
        fields[field] = { kind: "added" };
      } else if (!same(old[field], row[field])) {
        fields[field] = { kind: "modified", before: old[field] };
      }
    }
    if (Object.keys(fields).length > 0) {
      changes[index] = { status: "modified", fields };
    }
  });
  return changes;
}

/**
 * Rows of `head` that are no longer in `current`, each placed after the current
 * row that preceded it in `head` (so they can be shown where they were).
 */
export function deletedRows(head: Table | null, current: Table, idField: string): DeletedRow[] {
  if (!head) {
    return [];
  }
  const now = new Map(current.rows.map((_, index) => [rowKey(current, index, idField), index]));
  const deleted: DeletedRow[] = [];
  let after = -1;
  head.rows.forEach((row, index) => {
    const kept = now.get(rowKey(head, index, idField));
    if (kept !== undefined) {
      after = kept;
    } else {
      deleted.push({ row, after });
    }
  });
  return deleted;
}
