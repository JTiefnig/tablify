import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROW_INDEX, ROW_LOCKED } from "../src/messages.ts";
import { languageForPath, parseTable } from "../src/parser.ts";

const dataDir = join(import.meta.dirname, "..", "test_data");
const options = { idField: "id" };

function parseFile(name: string) {
  const text = readFileSync(join(dataDir, name), "utf8");
  return { text, result: parseTable(text, languageForPath(name), options) };
}

function lineOf(text: string, offset: number) {
  return text.slice(0, offset).split("\n").length;
}

test("JSON list file", () => {
  const { text, result } = parseFile("req_test_data.json");
  assert.ok(result.ok);
  const { table } = result;
  assert.equal(table.shape, "array");
  assert.equal(table.rows.length, 30);
  assert.equal(table.offsets.length, 30);
  assert.equal(table.rows[0].id, "REQ-001");
  assert.equal(table.rows[0][ROW_INDEX], 0);
  assert.equal(table.rows[0][ROW_LOCKED], undefined);
  assert.deepEqual(table.paths[1], [1]);
  assert.ok(!table.fields.includes(ROW_INDEX));
  assert.equal(text.slice(table.offsets[1], table.offsets[1] + 1), "{");
});

test("JSON hash file", () => {
  const { text, result } = parseFile("req_test_data_3.json");
  assert.ok(result.ok);
  const { table } = result;
  assert.equal(table.shape, "mapping");
  assert.equal(table.rows.length, 24);
  assert.equal(table.rows[0].id, "API-001");
  assert.deepEqual(table.rows[2].lables, ["Functional", "API Design"]);
  assert.deepEqual(table.paths[1], ["API-002"]);
  assert.equal(text.slice(table.offsets[1], table.offsets[1] + 9), '"API-002"');
});

test("the old `elements` wrapper is not a table", () => {
  const result = parseTable('{"elements": [{"id": 1}]}', "json", options);
  assert.ok(!result.ok);
  assert.equal(result.kind, "shape");
});

test("YAML mapping file matches its JSON twin", () => {
  const json = parseFile("req_test_data_3.json").result;
  const { text, result } = parseFile("req_test_data_3.yaml");
  assert.ok(json.ok && result.ok);
  assert.equal(result.table.shape, "mapping");
  assert.deepEqual(result.table.rows, json.table.rows);
  // Hash keys are locked for editing.
  assert.deepEqual(result.table.rows[0][ROW_LOCKED], ["id"]);
  assert.deepEqual(result.table.paths, json.table.paths);
  assert.equal(result.table.fields[0], "id");
  assert.equal(text.slice(result.table.offsets[1]).split(":")[0], "API-002");
  assert.equal(lineOf(text, result.table.offsets[1]), 10);
});

test("top-level array of objects", () => {
  const { result } = parseFile("initialtest.json");
  assert.ok(result.ok);
  assert.equal(result.table.shape, "array");
  assert.deepEqual(result.table.fields, ["name", "value"]);
  assert.equal(result.table.rows[2].value, 3);
});

test("custom id field for mappings", () => {
  const result = parseTable("A: {key: 1}\nB: {key: 2}\n", "yaml", { idField: "name" });
  assert.ok(result.ok);
  assert.deepEqual(result.table.fields, ["name", "key"]);
  assert.equal(result.table.rows[1].name, "B");
});

test("nested values are stringified", () => {
  const result = parseTable('[{"a": {"b": 1}, "c": [{"d": 2}]}]', "json", options);
  assert.ok(result.ok);
  assert.equal(result.table.rows[0].a, '{"b":1}');
  assert.equal(result.table.rows[0].c, '[{"d":2}]');
  assert.deepEqual(result.table.rows[0][ROW_LOCKED], ["a", "c"]);
});

test("JSON syntax error reports a line", () => {
  const result = parseTable('[\n  {"id": 1},\n  {"id": 2,}\n  oops\n]', "json", options);
  assert.ok(!result.ok);
  assert.equal(result.kind, "syntax");
  assert.equal(result.line, 4);
});

test("YAML syntax error reports a line", () => {
  const result = parseTable("a: 1\nb: [1, 2\nc: 3\n", "yaml", options);
  assert.ok(!result.ok);
  assert.equal(result.kind, "syntax");
  assert.equal(typeof result.line, "number");
});

test("unknown shape and empty file", () => {
  const shape = parseTable('{"name": "x", "scripts": {}}', "json", options);
  assert.ok(!shape.ok);
  assert.equal(shape.kind, "shape");

  const empty = parseTable("  \n", "yaml", options);
  assert.ok(!empty.ok);
  assert.equal(empty.kind, "empty");
});

test("the top level is not a table: the shallowest nested table is suggested", () => {
  const response = parseTable('{"status": "ok", "data": {"total": 2, "items": [{"id": 1}, {"id": 2}]}}', "json", options);
  assert.ok(!response.ok);
  assert.equal(response.kind, "shape");
  assert.deepEqual(response.suggestedPath, ["data", "items"]);

  const shown = parseTable('{"status": "ok", "data": {"total": 2, "items": [{"id": 1}, {"id": 2}]}}', "json", {
    ...options,
    dataPath: response.suggestedPath,
  });
  assert.ok(shown.ok);
  assert.deepEqual(shown.table.rows.map((row) => row.id), [1, 2]);

  const nothing = parseTable('{"name": "x", "version": "1.0.0"}', "json", options);
  assert.ok(!nothing.ok);
  assert.equal(nothing.suggestedPath, undefined);

  const yaml = parseTable("kind: List\nitems:\n  - name: a\n  - name: b\n", "yaml", options);
  assert.ok(!yaml.ok);
  assert.deepEqual(yaml.suggestedPath, ["items"]);
});

test("empty collections are empty tables", () => {
  for (const [text, language] of [["[]", "json"], ["[]\n", "yaml"], ["id,name\n", "csv"]] as const) {
    const result = parseTable(text, language, options);
    assert.ok(result.ok, text);
    assert.equal(result.table.rows.length, 0);
  }
});

test("nulls, missing fields and mixed value types", () => {
  const result = parseTable(
    '[{"id": 1, "a": null, "b": true}, {"id": "two", "b": "yes", "c": [1, "x", null]}, {"id": 3.5, "a": 0}]',
    "json",
    options,
  );
  assert.ok(result.ok);
  const { rows, fields } = result.table;
  assert.deepEqual(fields, ["id", "a", "b", "c"]);
  assert.equal(rows[0].a, null);
  assert.equal(rows[0].c, undefined);
  assert.equal(rows[1].a, undefined);
  assert.deepEqual(rows[1].c, [1, "x", null]);
  assert.equal(rows[2].a, 0);
  assert.equal(rows[2].id, 3.5);
});

test("rows that are not objects get a locked `value` column", () => {
  const result = parseTable('[1, "text", null, {"id": "x"}]', "json", options);
  assert.ok(result.ok);
  assert.deepEqual(result.table.rows.map((row) => row.value), [1, "text", null, undefined]);
  assert.deepEqual(result.table.rows[0][ROW_LOCKED], ["*"]);
  assert.equal(result.table.rows[3][ROW_LOCKED], undefined);
});

test("special characters in keys and values", () => {
  const json = parseTable('[{"na.me": "<b>x</b>", "ü ñ": "\\u00e9 \\"q\\"", "emoji": "🚀\\n2"}]', "json", options);
  assert.ok(json.ok);
  assert.deepEqual(json.table.fields, ["na.me", "ü ñ", "emoji"]);
  assert.equal(json.table.rows[0]["na.me"], "<b>x</b>");
  assert.equal(json.table.rows[0]["ü ñ"], 'é "q"');
  assert.equal(json.table.rows[0].emoji, "🚀\n2");

  const yaml = parseTable('"key: with colon":\n  note: "# not a comment"\n', "yaml", options);
  assert.ok(yaml.ok);
  assert.equal(yaml.table.rows[0].id, "key: with colon");
  assert.equal(yaml.table.rows[0].note, "# not a comment");
});

test("JSON with comments and trailing commas (jsonc) is read", () => {
  const result = parseTable('// list\n[\n  {"id": 1}, /* two */ {"id": 2},\n]', "json", options);
  assert.ok(result.ok);
  assert.equal(result.table.rows.length, 2);
});

test("performance: 50,000 rows of JSON and YAML parse in under 3 s", () => {
  const rows = Array.from({ length: 50_000 }, (_, i) => ({ id: `R-${i}`, status: i % 3 ? "open" : "done", n: i, tags: ["a", "b"] }));
  for (const [text, language] of [
    [JSON.stringify(rows, null, 2), "json"],
    [rows.map((row) => `- id: ${row.id}\n  status: ${row.status}\n  n: ${row.n}\n  tags: [a, b]\n`).join(""), "yaml"],
  ] as const) {
    const start = performance.now();
    const result = parseTable(text, language, options);
    const elapsed = performance.now() - start;
    assert.ok(result.ok);
    assert.equal(result.table.rows.length, 50_000);
    assert.ok(elapsed < 3000, `${language}: ${Math.round(elapsed)} ms`);
  }
});
