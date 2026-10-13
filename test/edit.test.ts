import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { applyEdits, computeEdit } from "../src/edit.ts";
import type { Cell } from "../src/messages.ts";
import { languageForPath, parseTable, type Language } from "../src/parser.ts";

const dataDir = join(import.meta.dirname, "..", "test_data");

/** Applies one edit and returns the new text plus the re-parsed row. */
function edit(text: string, language: Language, index: number, field: string, value: Cell | undefined) {
  const before = parseTable(text, language, { idField: "id" });
  assert.ok(before.ok);
  const result = computeEdit(text, language, before.table.paths[index], field, value);
  assert.ok(result.ok, result.ok ? "" : result.message);
  const next = applyEdits(text, result.edits);
  const after = parseTable(next, language, { idField: "id" });
  assert.ok(after.ok, `edited text no longer parses:\n${next}`);
  return { next, row: after.table.rows[index], rows: after.table.rows, before: before.table.rows };
}

/** Everything outside the changed region must be byte-identical. */
function changedRegion(before: string, after: string): string {
  let start = 0;
  while (start < before.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return after.slice(start, after.length - end);
}

for (const file of ["req_test_data_3.json", "req_test_data_3.yaml"]) {
  const language = languageForPath(file);
  const text = readFileSync(join(dataDir, file), "utf8");

  test(`${file}: replace a scalar`, () => {
    const { next, row, rows, before } = edit(text, language, 2, "status", "draft");
    assert.equal(row.status, "draft");
    assert.equal(changedRegion(text, next).length <= 8, true, changedRegion(text, next));
    rows.forEach((other, i) => i !== 2 && assert.deepEqual(other, before[i]));
  });

  test(`${file}: multi-line text`, () => {
    const value = "line one\nline two: with colon\n  indented";
    const { row, rows, before } = edit(text, language, 2, "comment", value);
    assert.equal(row.comment, value);
    rows.forEach((other, i) => i !== 2 && assert.deepEqual(other, before[i]));
  });

  test(`${file}: replace a list`, () => {
    const { row, rows, before } = edit(text, language, 2, "tags", ["Functional", "New, Tag", "Security"]);
    assert.deepEqual(row.tags, ["Functional", "New, Tag", "Security"]);
    rows.forEach((other, i) => i !== 2 && assert.deepEqual(other, before[i]));
  });

  test(`${file}: empty list and list from empty`, () => {
    const cleared = edit(text, language, 2, "tags", []);
    assert.deepEqual(cleared.row.tags, []);
    const filled = edit(text, language, 0, "tags", ["Security"]);
    assert.deepEqual(filled.row.tags, ["Security"]);
    filled.rows.forEach((other, i) => i !== 0 && assert.deepEqual(other, filled.before[i]));
  });

  test(`${file}: add a missing field`, () => {
    const { row, rows, before } = edit(text, language, 0, "asil", "QM");
    assert.equal(row.asil, "QM");
    assert.equal(row.cluster_bis, before[0].cluster_bis);
    rows.forEach((other, i) => i !== 0 && assert.deepEqual(other, before[i]));
  });

  test(`${file}: remove a field`, () => {
    const { row, rows, before } = edit(text, language, 2, "comment", undefined);
    assert.equal("comment" in row, false);
    assert.equal(row.miscellaneous, before[2].miscellaneous);
    rows.forEach((other, i) => i !== 2 && assert.deepEqual(other, before[i]));
  });

  test(`${file}: values that need quoting`, () => {
    for (const value of ["yes", "true", "123", "a: b", "# not a comment", "", "- dash", "it's"]) {
      assert.equal(edit(text, language, 2, "developer", value).row.developer, value, value);
    }
    assert.equal(edit(text, language, 2, "developer", 42).row.developer, 42);
    assert.equal(edit(text, language, 2, "security", true).row.security, true);
  });
}

test("YAML keeps comments and the layout of untouched entries", () => {
  const text = "# header\nA:\n  status: valid # inline\n  tags:\n  - x\n  - y\nB:\n  status: draft\n";
  const { next } = edit(text, "yaml", 0, "status", "invalid");
  assert.equal(next, "# header\nA:\n  status: invalid # inline\n  tags:\n  - x\n  - y\nB:\n  status: draft\n");

  const tags = edit(text, "yaml", 0, "tags", ["z"]).next;
  assert.equal(tags, "# header\nA:\n  status: valid # inline\n  tags:\n  - z\nB:\n  status: draft\n");
});

test("YAML sequence items: edit, add and remove the first key", () => {
  const text = "- id: 1\n  text: a\n- id: 2\n";
  assert.equal(edit(text, "yaml", 0, "id", 7).next, "- id: 7\n  text: a\n- id: 2\n");
  assert.equal(edit(text, "yaml", 1, "text", "b").next, "- id: 1\n  text: a\n- id: 2\n  text: b\n");
  assert.equal(edit(text, "yaml", 0, "id", undefined).next, "- text: a\n- id: 2\n");
  assert.equal(edit(text, "yaml", 1, "id", undefined).next, "- id: 1\n  text: a\n- {}\n");
});

test("YAML flow maps", () => {
  const text = "A: {key: 1, other: x}\nB: {key: 2}\n";
  assert.equal(edit(text, "yaml", 0, "key", 5).next, "A: {key: 5, other: x}\nB: {key: 2}\n");
  assert.equal(edit(text, "yaml", 1, "added", "a, b").next, 'A: {key: 1, other: x}\nB: {key: 2, added: "a, b"}\n');
  assert.equal(edit(text, "yaml", 0, "other", undefined).next, "A: {key: 1}\nB: {key: 2}\n");
  assert.equal(edit(text, "yaml", 0, "key", undefined).next, "A: {other: x}\nB: {key: 2}\n");
  assert.equal(edit(text, "yaml", 0, "key", "two\nlines").row.key, "two\nlines");
});

test("YAML block scalar replaced and removed cleanly", () => {
  const text = "A:\n  text: |-\n    one\n    two\n  next: 1\n";
  assert.equal(edit(text, "yaml", 0, "text", "x").next, "A:\n  text: x\n  next: 1\n");
  assert.equal(edit(text, "yaml", 0, "text", undefined).next, "A:\n  next: 1\n");
  assert.equal(edit(text, "yaml", 0, "text", "a\nb\n").row.text, "a\nb\n");
});

test("JSON keeps indentation style", () => {
  const text = '[\n\t{ "id": 1 },\n\t{ "id": 2 }\n]\n';
  const { next } = edit(text, "json", 0, "status", "valid");
  assert.match(next, /\t\t\t"status": "valid"|"status": "valid"/);
  assert.ok(!next.includes("  "), next);
});

test("YAML quotes strings that YAML 1.1 tools would read as booleans", () => {
  const text = "A:\n  x: 1\n";
  assert.equal(edit(text, "yaml", 0, "x", "yes").next, "A:\n  x: 'yes'\n");
  assert.equal(edit(text, "yaml", 0, "x", "off").next, "A:\n  x: 'off'\n");
  assert.equal(edit(text, "yaml", 0, "x", "plain text").next, "A:\n  x: plain text\n");
});

test("YAML errors and non-object rows are refused", () => {
  assert.equal(computeEdit("a: [1\n", "yaml", ["a"], "x", 1).ok, false);
  assert.equal(computeEdit("- 1\n- 2\n", "yaml", [0], "value", 3).ok, false);
});
