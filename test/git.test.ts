import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { applyEdits, computeEdit } from "../src/edit.ts";
import { blameFields, GitFile, parseBlame } from "../src/git.ts";
import { deletedRows, diffRows } from "../src/gitDiff.ts";
import { locateRow } from "../src/locate.ts";
import { parseTable, type Language, type Table } from "../src/parser.ts";

const options = { idField: "id" };

function table(text: string, language: Language): Table {
  const result = parseTable(text, language, options);
  assert.ok(result.ok);
  return result.table;
}

test("diffRows: added, modified and removed fields; unchanged rows omitted", () => {
  const head = table('[{"id": "A", "s": "x", "t": [1]}, {"id": "B", "s": "y"}, {"id": "C"}]', "json");
  const now = table('[\n {"id": "B", "s": "z", "n": 1},\n {"id": "A", "s": "x", "t": [1]},\n {"id": "D", "s": "new"}\n]', "json");
  assert.deepEqual(diffRows(head, now, "id"), {
    0: { status: "modified", fields: { s: { kind: "modified", before: "y" }, n: { kind: "added" } } },
    2: { status: "added", fields: { id: { kind: "added" }, s: { kind: "added" } } },
  });
});

test("diffRows: YAML mappings match by key, formatting changes are ignored", () => {
  const head = table("A:\n  s: x\n  tags: [a, b]\nB:\n  s: y\n", "yaml");
  const now = table("A:\n  s:   x\n  tags:\n  - a\n  - b\nB:\n  t: 1\n", "yaml");
  assert.deepEqual(diffRows(head, now, "id"), {
    1: { status: "modified", fields: { s: { kind: "removed", before: "y" }, t: { kind: "added" } } },
  });
  // Not in the last commit: everything is added.
  assert.deepEqual(Object.keys(diffRows(null, now, "id")), ["0", "1"]);
});

test("deletedRows: rows no longer in the file, placed after their former predecessor", () => {
  const head = table('[{"id": "A"}, {"id": "B"}, {"id": "C"}, {"id": "D"}, {"id": "E"}]', "json");
  const now = table('[{"id": "D"}, {"id": "C"}]', "json");
  const deleted = deletedRows(head, now, "id");
  assert.deepEqual(
    deleted.map(({ row, after }) => [row.id, after]),
    [["A", -1], ["B", -1], ["E", 0]],
  );
  assert.deepEqual(deletedRows(null, now, "id"), []);
  assert.deepEqual(deletedRows(table("A: {s: 1}\nB: {s: 2}\n", "yaml"), table("B: {s: 3}\n", "yaml"), "id").map(({ row }) => row.id), ["A"]);
});

test("locateRow finds rows and fields in JSON and YAML", () => {
  const json = '[\n  {"id": "A",\n   "s": "x"}\n]';
  const j = locateRow(json, "json", [0]);
  assert.ok(j);
  assert.equal(json.slice(...j.row), '{"id": "A",\n   "s": "x"}');
  assert.equal(json.slice(...j.fields.s), '"s": "x"');

  const hash = '{\n  "A": {"s": "x"},\n  "B": {"s": "y"}\n}';
  const h = locateRow(hash, "json", ["B"]);
  assert.ok(h);
  assert.equal(hash.slice(...h.row), '"B": {"s": "y"}');

  const yaml = "A:\n  s: x\n  text: |-\n    one\n    two\nB:\n  s: y\n";
  const y = locateRow(yaml, "yaml", ["A"]);
  assert.ok(y);
  assert.equal(yaml.slice(...y.row), "A:\n  s: x\n  text: |-\n    one\n    two");
  assert.equal(yaml.slice(...y.fields.text), "text: |-\n    one\n    two");
  assert.equal(locateRow(yaml, "yaml", ["missing"]), null);
});

test("parseBlame reads porcelain output and marks uncommitted lines", () => {
  const hash = "a".repeat(40);
  const zero = "0".repeat(40);
  const output = [
    `${hash} 1 1 2`,
    "author Ada",
    "author-time 1700000000",
    "summary Add things",
    "filename f.yaml",
    "\tA:",
    `${hash} 2 2`,
    "\t  s: x",
    `${zero} 3 3 1`,
    "author External file (--contents)",
    "author-time 1800000000",
    "summary Version of f.yaml from f.yaml",
    "filename f.yaml",
    "\t  t: y",
  ].join("\n");
  const lines = parseBlame(output);
  assert.equal(lines.get(1)?.author, "Ada");
  assert.equal(lines.get(2)?.summary, "Add things");
  assert.equal(lines.get(3)?.uncommitted, true);
  assert.equal(lines.get(3)?.author, "You");

  const text = "A:\n  s: x\n  t: y\n";
  const fields = blameFields(text, { s: [5, 9], t: [12, 16] }, lines);
  assert.deepEqual(fields.map((field) => [field.field, field.line, field.commit.author]), [
    ["s", 2, "Ada"],
    ["t", 3, "You"],
  ]);
});

test("GitFile: committed text and blame of unsaved changes (this repository)", async () => {
  const file = await GitFile.open(join(import.meta.dirname, "..", "test_data", "req_test_data_3.yaml"));
  if (!file) {
    return; // Not running inside a git checkout.
  }
  assert.equal(file.path, "test_data/req_test_data_3.yaml");
  const head = await file.headText();
  assert.ok(head !== null && head.includes("API-003:"));

  const parsed = table(head, "yaml");
  const edit = computeEdit(head, "yaml", parsed.paths[2], "status", "draft");
  assert.ok(edit.ok);
  const text = applyEdits(head, edit.edits);
  const location = locateRow(text, "yaml", parsed.paths[2]);
  assert.ok(location);

  const start = text.slice(0, location.row[0]).split("\n").length;
  const end = text.slice(0, location.row[1]).split("\n").length;
  const blame = blameFields(text, location.fields, await file.blame(text, start, end));
  const status = blame.find((field) => field.field === "status");
  const type = blame.find((field) => field.field === "type");
  assert.equal(status?.commit.uncommitted, true);
  assert.equal(type?.commit.uncommitted, false);
  assert.match(type?.commit.hash ?? "", /^[0-9a-f]{40}$/);

  assert.equal(await GitFile.open("/"), null);
});
