import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { detectDelimiter, parseCsv } from "../src/csv.ts";
import { applyEdits, computeEdit, deleteRow, insertRow, moveRow, type EditResult } from "../src/edit.ts";
import { locateRow } from "../src/locate.ts";
import type { Cell } from "../src/messages.ts";
import { languageForPath, parseTable, type Table } from "../src/parser.ts";

const options = { idField: "id" };

function table(text: string): Table {
  const result = parseTable(text, "csv", options);
  assert.ok(result.ok, result.ok ? "" : result.message);
  return result.table;
}

function apply(text: string, result: EditResult): string {
  assert.ok(result.ok, result.ok ? "" : result.message);
  return applyEdits(text, result.edits);
}

function set(text: string, index: number, field: string, value: Cell | undefined): string {
  return apply(text, computeEdit(text, "csv", table(text).paths[index], field, value));
}

const ids = (text: string) => table(text).rows.map((row) => row.id);

test("languageForPath: csv and tsv", () => {
  assert.equal(languageForPath("a/b.CSV"), "csv");
  assert.equal(languageForPath("b.tsv"), "csv");
});

test("parse: header names the fields, quoted fields, empty fields left out", () => {
  const { rows, fields, paths, offsets } = table('id,text,n\r\nA,"x, ""y""\r\nz",1\r\n\r\nB,,2\r\n');
  assert.deepEqual(fields, ["id", "text", "n"]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].text, 'x, "y"\r\nz');
  assert.equal(rows[0].n, "1");
  assert.ok(!("text" in rows[1]));
  assert.deepEqual(paths, [[0], [1]]);
  assert.equal(offsets[1], 'id,text,n\r\nA,"x, ""y""\r\nz",1\r\n\r\n'.length);
});

test("parse: delimiter detection, BOM, duplicate and empty column names", () => {
  assert.equal(detectDelimiter("a;b;c\n1,2;3"), ";");
  assert.equal(detectDelimiter("a\tb\n"), "\t");
  assert.equal(detectDelimiter('"a,b";c\n'), ";");
  const result = parseCsv("\uFEFFid;name;name;\n1;x;y;z\n");
  assert.ok(result.ok);
  assert.deepEqual(result.doc.columns, ["id", "name", "name_2", "column_4"]);
  assert.equal(table("\uFEFFid,x\n1,2\n").rows[0].id, "1");
});

test("parse: unterminated quote is a syntax error with its line", () => {
  const result = parseTable('id,x\n1,"open\n2,3\n', "csv", options);
  assert.ok(!result.ok);
  assert.equal(result.kind, "syntax");
  assert.equal(result.line, 2);
});

test("edit: replaces only the field, quotes when needed", () => {
  const text = 'id,text,n\nA,old,1\nB,"keep, this",2\n';
  assert.equal(set(text, 0, "text", "new"), 'id,text,n\nA,new,1\nB,"keep, this",2\n');
  assert.equal(set(text, 0, "text", 'a, "b"'), 'id,text,n\nA,"a, ""b""",1\nB,"keep, this",2\n');
  assert.equal(set(text, 1, "text", undefined), "id,text,n\nA,old,1\nB,,2\n");
  assert.equal(set(text, 0, "n", 3), "id,text,n\nA,old,3\nB,\"keep, this\",2\n");
  assert.equal(set(text, 0, "text", ["x", "y"]), 'id,text,n\nA,"x, y",1\nB,"keep, this",2\n');
  // Short records are padded; semicolon files stay semicolon files.
  assert.equal(set("id;a;b\nA\n", 0, "b", "x;y"), 'id;a;b\nA;;"x;y"\n');
});

test("rows: insert, delete and move keep line endings and other records", () => {
  const text = "id,v\r\nA,1\r\nB,2\r\nC,3";
  const shape = table(text);
  assert.equal(apply(text, insertRow(text, "csv", shape, 0, "above", "N", "id")), "id,v\r\nN,\r\nA,1\r\nB,2\r\nC,3");
  assert.equal(apply(text, insertRow(text, "csv", shape, 2, "below", "N", "id")), "id,v\r\nA,1\r\nB,2\r\nC,3\r\nN,");
  assert.equal(apply(text, deleteRow(text, "csv", shape, 1)), "id,v\r\nA,1\r\nC,3");
  assert.equal(apply(text, deleteRow(text, "csv", shape, 2)), "id,v\r\nA,1\r\nB,2");
  assert.equal(apply(text, moveRow(text, "csv", shape, 2, 0, "above")), "id,v\r\nC,3\r\nA,1\r\nB,2");
  assert.equal(apply(text, moveRow(text, "csv", shape, 0, 2, "below")), "id,v\r\nB,2\r\nC,3\r\nA,1");
  // Without an id column the new record is empty.
  assert.equal(apply("v\n1\n", insertRow("v\n1\n", "csv", table("v\n1\n"), 0, "below", "N", "id")), 'v\n1\n""\n');
});

test("locateRow: record and field spans for blame", () => {
  const text = 'id,text\nA,"two\nlines"\nB,x\n';
  const location = locateRow(text, "csv", [0]);
  assert.ok(location);
  assert.equal(text.slice(...location.row), 'A,"two\nlines"');
  assert.equal(text.slice(...location.fields.text), '"two\nlines"');
});

test("sample file matches its JSON twin", () => {
  const dataDir = join(import.meta.dirname, "..", "test_data");
  const csv = table(readFileSync(join(dataDir, "req_test_data_4.csv"), "utf8"));
  const json = parseTable(readFileSync(join(dataDir, "req_test_data_3.json"), "utf8"), "json", options);
  assert.ok(json.ok);
  assert.deepEqual(ids(readFileSync(join(dataDir, "req_test_data_4.csv"), "utf8")), json.table.rows.map((row) => row.id));
  assert.equal(csv.rows[2].lables, "Functional, API Design");
  assert.equal(csv.rows[2].text, json.table.rows[2].text);
});
