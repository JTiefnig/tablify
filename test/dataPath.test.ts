import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../src/config.ts";
import { applyEdits, computeEdit, deleteRow, insertRow, moveRow, type EditResult } from "../src/edit.ts";
import { locateRow } from "../src/locate.ts";
import { formatDataPath, parseDataPath, parseTable, type Language, type Table } from "../src/parser.ts";

test("parseDataPath: dot, slash, JSONPath and bracket spellings", () => {
  const expected = ["document", "data", "objects"];
  for (const text of ["document.data.objects", "/document/data/objects", "$.document.data.objects", " document/data.objects "]) {
    assert.deepEqual(parseDataPath(text), expected, text);
  }
  assert.deepEqual(parseDataPath("items[0].rows"), ["items", "0", "rows"]);
  assert.deepEqual(parseDataPath("items.0.rows"), ["items", "0", "rows"]);
  assert.deepEqual(parseDataPath(`a["b.c"]['d/e'].f`), ["a", "b.c", "d/e", "f"]);
  assert.deepEqual(parseDataPath(""), []);
  assert.deepEqual(parseDataPath("$"), []);
  assert.deepEqual(parseDataPath("/"), []);
  for (const bad of ["a..b", "a.", "a[", "a[x]", "a]b", "[0]b"]) {
    assert.equal(parseDataPath(bad), null, bad);
  }
  assert.equal(formatDataPath(["a", "b.c", "0"]), `a["b.c"].0`);
});

test("config: view path", () => {
  const result = parseConfig("views:\n  - path: /document/data/objects\n  - path: ''\n");
  assert.ok(result.ok);
  assert.deepEqual(result.config.views[0].dataPath, ["document", "data", "objects"]);
  assert.equal(result.config.views[1].dataPath, null);
  const invalid = parseConfig("views:\n  - path: a..b\n");
  assert.ok(!invalid.ok);
  assert.match(invalid.message, /^views\[0\]\.path:/);
});

const YAML_TEXT = `# header
document:
  title: Example
  data:
    objects:
      - id: a
        x: 1
      - id: b
        x: 2
      - id: c
        x: 3
  other: [1, 2]
`;

const JSON_TEXT = `{
  "document": {
    "title": "Example",
    "data": {
      "objects": [
        { "id": "a", "x": 1 },
        { "id": "b", "x": 2 },
        { "id": "c", "x": 3 }
      ]
    }
  }
}
`;

const dataPath = ["document", "data", "objects"];

function table(text: string, language: Language, path: string[] | null = dataPath): Table {
  const result = parseTable(text, language, { idField: "id", dataPath: path });
  assert.ok(result.ok, result.ok ? "" : result.message);
  return result.table;
}

function apply(text: string, result: EditResult): string {
  assert.ok(result.ok, result.ok ? "" : result.message);
  return applyEdits(text, result.edits);
}

const ids = (text: string, language: Language) => table(text, language).rows.map((row) => row.id);

for (const [language, text] of [["yaml", YAML_TEXT], ["json", JSON_TEXT]] as const) {
  test(`${language}: entries at a data path`, () => {
    const t = table(text, language);
    assert.equal(t.shape, "array");
    assert.deepEqual(t.root, dataPath);
    assert.deepEqual(ids(text, language), ["a", "b", "c"]);
    assert.deepEqual(t.paths[1], [...dataPath, 1]);
    assert.ok(text.slice(t.offsets[1]).replace(/^[-{ ]+/, "").startsWith(language === "json" ? `"id": "b"` : "id: b"));
  });

  test(`${language}: edit, insert, delete and move at a data path`, () => {
    const t = table(text, language);
    const edited = apply(text, computeEdit(text, language, t.paths[1], "x", 20));
    assert.equal(table(edited, language).rows[1].x, 20);
    assert.ok(edited.includes("title") && edited.includes("Example"));

    const inserted = apply(text, insertRow(text, language, t, 0, "below", "n", "id"));
    assert.deepEqual(ids(inserted, language), ["a", "n", "b", "c"]);
    const deleted = apply(text, deleteRow(text, language, t, 0));
    assert.deepEqual(ids(deleted, language), ["b", "c"]);
    const moved = apply(text, moveRow(text, language, t, 0, 2, "below"));
    assert.deepEqual(ids(moved, language), ["b", "c", "a"]);
    if (language === "yaml") assert.ok(moved.endsWith("  other: [1, 2]\n"));
  });

  test(`${language}: locateRow at a data path`, () => {
    const t = table(text, language);
    const location = locateRow(text, language, t.paths[2]);
    assert.ok(location);
    assert.match(text.slice(...location.fields.x), /x"?: 3/);
  });
}

test("YAML: hash of entries at a data path, row starts at its key", () => {
  const text = "meta: 1\nreqs:\n  R1:\n    title: one\n  R2:\n    title: two\n";
  const t = table(text, "yaml", ["reqs"]);
  assert.equal(t.shape, "mapping");
  assert.deepEqual(t.rows.map((row) => row.id), ["R1", "R2"]);
  const location = locateRow(text, "yaml", t.paths[1]);
  assert.ok(location);
  assert.equal(text.slice(location.row[0], location.row[0] + 3), "R2:");
  const inserted = apply(text, insertRow(text, "yaml", t, 1, "below", "R3", "id"));
  assert.deepEqual(table(inserted, "yaml", ["reqs"]).rows.map((row) => row.id), ["R1", "R2", "R3"]);
  assert.ok(inserted.startsWith("meta: 1\n"));
});

test("array index in a data path", () => {
  const text = `{"sheets": [{"rows": [{"id": "a"}]}, {"rows": [{"id": "b"}, {"id": "c"}]}]}`;
  const t = table(text, "json", ["sheets", "1", "rows"]);
  assert.deepEqual(t.root, ["sheets", 1, "rows"]);
  assert.deepEqual(t.rows.map((row) => row.id), ["b", "c"]);
});

test("data path errors and the nested table hint", () => {
  const missing = parseTable(YAML_TEXT, "yaml", { idField: "id", dataPath: ["document", "items"] });
  assert.ok(!missing.ok);
  assert.match(missing.message, /no "items" in "document"/);

  const notTable = parseTable(YAML_TEXT, "yaml", { idField: "id", dataPath: ["document", "title"] });
  assert.ok(!notTable.ok);
  assert.match(notTable.message, /at "document\.title"/);

  // (Without `version`, the top level would be a hash with the single entry `document`.)
  const topLevel = parseTable(`version: 1\n${YAML_TEXT}`, "yaml", { idField: "id" });
  assert.ok(!topLevel.ok);
  assert.match(topLevel.message, /set `path: document\.data\.objects`/);
});
