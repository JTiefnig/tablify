import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { applyEdits, computeEdit, deleteRow, insertRow, moveRow, type EditResult } from "../src/edit.ts";
import { languageForPath, parseTable, type Language, type Table } from "../src/parser.ts";

const dataDir = join(import.meta.dirname, "..", "test_data");

function table(text: string, language: Language): Table {
  const result = parseTable(text, language, { idField: "id" });
  assert.ok(result.ok, `does not parse:\n${text}`);
  return result.table;
}

function apply(text: string, result: EditResult): string {
  assert.ok(result.ok, result.ok ? "" : result.message);
  return applyEdits(text, result.edits);
}

const ids = (text: string, language: Language) => table(text, language).rows.map((row) => row.id);

for (const file of ["req_test_data_3.json", "req_test_data_3.yaml", "req_test_data.json"]) {
  const language = languageForPath(file);
  const text = readFileSync(join(dataDir, file), "utf8");
  const before = table(text, language);
  const original = before.rows.map((row) => row.id);

  test(`${file}: insert above and below`, () => {
    const above = apply(text, insertRow(text, language, before, 2, "above", "n3w1d000", "id"));
    assert.deepEqual(ids(above, language), [...original.slice(0, 2), "n3w1d000", ...original.slice(2)]);
    const below = apply(text, insertRow(text, language, before, before.rows.length - 1, "below", "n3w1d001", "id"));
    assert.deepEqual(ids(below, language), [...original, "n3w1d001"]);
    // The other rows are untouched.
    const after = table(above, language).rows.filter((row) => row.id !== "n3w1d000");
    assert.deepEqual(after.map(({ __tablifyIndex, ...row }) => row), before.rows.map(({ __tablifyIndex, ...row }) => row));
  });

  test(`${file}: a new row can be filled in`, () => {
    const inserted = apply(text, insertRow(text, language, before, 0, "below", "n3w1d000", "id"));
    const t = table(inserted, language);
    const filled = apply(inserted, computeEdit(inserted, language, t.paths[1], "status", "draft"));
    const row = table(filled, language).rows[1];
    assert.equal(row.id, "n3w1d000");
    assert.equal(row.status, "draft");
    const second = apply(filled, computeEdit(filled, language, table(filled, language).paths[1], "text", "line\nline"));
    assert.equal(table(second, language).rows[1].text, "line\nline");
  });

  test(`${file}: delete`, () => {
    const deleted = apply(text, deleteRow(text, language, before, 3));
    assert.deepEqual(ids(deleted, language), original.filter((_, i) => i !== 3));
    const last = apply(text, deleteRow(text, language, before, original.length - 1));
    assert.deepEqual(ids(last, language), original.slice(0, -1));
  });

  test(`${file}: move`, () => {
    const down = apply(text, moveRow(text, language, before, 1, 4, "below"));
    assert.deepEqual(ids(down, language), [original[0], original[2], original[3], original[4], original[1], ...original.slice(5)]);
    const up = apply(text, moveRow(text, language, before, 5, 0, "above"));
    assert.deepEqual(ids(up, language), [original[5], ...original.slice(0, 5), ...original.slice(6)]);
    const toEnd = apply(text, moveRow(text, language, before, 0, original.length - 1, "below"));
    assert.deepEqual(ids(toEnd, language), [...original.slice(1), original[0]]);
    // Moved rows keep all their content.
    const moved = table(down, language).rows[4];
    const { __tablifyIndex: _a, ...movedFields } = moved;
    const { __tablifyIndex: _b, ...originalFields } = before.rows[1];
    assert.deepEqual(movedFields, originalFields);
    assert.deepEqual(moveRow(text, language, before, 2, 1, "below"), { ok: true, edits: [] });
  });
}

test("YAML: comments move with their entry; files without a final newline", () => {
  const text = "- id: a\n  # about a\n  x: 1\n- id: b\n- id: c";
  assert.equal(apply(text, moveRow(text, "yaml", table(text, "yaml"), 0, 2, "below")), "- id: b\n- id: c\n- id: a\n  # about a\n  x: 1");
  assert.equal(apply(text, insertRow(text, "yaml", table(text, "yaml"), 2, "below", "x7", "id")), "- id: a\n  # about a\n  x: 1\n- id: b\n- id: c\n- id: x7");
  assert.equal(apply(text, deleteRow(text, "yaml", table(text, "yaml"), 2)), "- id: a\n  # about a\n  x: 1\n- id: b\n");
});

test("YAML mapping: new entry starts as {} and becomes a block when filled", () => {
  const text = "A:\n  s: 1\nB:\n  s: 2\n";
  const inserted = apply(text, insertRow(text, "yaml", table(text, "yaml"), 0, "below", "k9", "id"));
  assert.equal(inserted, "A:\n  s: 1\nk9: {}\nB:\n  s: 2\n");
  const filled = apply(inserted, computeEdit(inserted, "yaml", ["k9"], "s", 3));
  assert.equal(filled, "A:\n  s: 1\nk9:\n  s: 3\nB:\n  s: 2\n");
});

test("refused: last YAML entry, flow collections", () => {
  const single = "- id: a\n";
  assert.equal(deleteRow(single, "yaml", table(single, "yaml"), 0).ok, false);
  const flow = "[{id: a}, {id: b}]\n";
  assert.equal(moveRow(flow, "yaml", table(flow, "yaml"), 0, 1, "below").ok, false);
});
