import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { deleteFilter, findView, matchesGlob, parseConfig, saveFilter, saveLayout, type Config } from "../src/config.ts";

const example = readFileSync(join(import.meta.dirname, "..", "test_data", ".vscode", "tablify.yaml"), "utf8");

function parsed(text: string): Config {
  const result = parseConfig(text);
  assert.ok(result.ok, result.ok ? "" : result.message);
  return result.config;
}

test("example config parses", () => {
  const config = parsed(example);
  assert.equal(config.views.length, 2);
  const [view, nested] = config.views;
  assert.equal(view.name, "Requirements");
  assert.deepEqual(view.files, ["req_test_data*.{json,yaml,yml,csv}"]);
  assert.equal(view.layout.columns?.[0], "id");
  assert.deepEqual(view.layout.hidden, ["miscellaneous"]);
  assert.deepEqual(view.readonlyColumns, ["developer"]);
  assert.equal(view.onSave, "bash test-formatter.sh ${file}");
  assert.deepEqual(view.filters[0], { name: "Open requirements", query: "type=requirement AND status=draft" });
  assert.equal(view.attributes.find((attribute) => attribute.name === "id")?.readonly, true);
  assert.equal(view.layout.showOthers, true);
  assert.equal(view.layout.widths.text, 420);

  const status = view.attributes.find((attribute) => attribute.name === "status");
  assert.equal(status?.type, "enum");
  assert.deepEqual(status?.values[1], { value: "valid", label: "Valid", color: "green", description: undefined });
  const asil = view.attributes.find((attribute) => attribute.name === "asil");
  assert.deepEqual(asil?.values[0], { value: "QM", label: "QM" });

  assert.equal(findView(config, "req_test_data_3.yaml")?.index, 0);
  assert.equal(findView(config, "sub/dir/req_test_data.json")?.index, 0);
  assert.equal(findView(config, "testdata.json"), null);

  assert.equal(nested.name, "Inventory (nested)");
  assert.deepEqual(nested.dataPath, ["document", "data", "objects"]);
  assert.equal(findView(config, "inventory_nested.yaml")?.index, 1);
});

test("first matching view wins; views without files match everything", () => {
  const config = parsed("views:\n  - files: [special/*.yaml]\n    name: special\n  - name: all\n");
  assert.equal(findView(config, "special/a.yaml")?.view.name, "special");
  assert.equal(findView(config, "other/a.yaml")?.view.name, "all");
});

test("defaults and shorthands", () => {
  const config = parsed("views:\n  - attributes:\n      name: string\n      done: boolean\n");
  const [view] = config.views;
  assert.equal(view.files, null);
  assert.equal(view.name, null);
  assert.deepEqual(view.layout, { columns: null, hidden: [], showOthers: true, widths: {} });
  assert.deepEqual(view.readonlyColumns, []);
  assert.deepEqual(view.filters, []);
  assert.equal(view.onSave, null);
  assert.deepEqual(view.attributes[1], {
    name: "done",
    type: "boolean",
    label: "done",
    description: undefined,
    readonly: false,
    values: [],
  });
  assert.deepEqual(parsed("").views, []);
  assert.equal(parsed('{"views": [{"otherColumns": "hide"}]}').views[0].layout.showOthers, false);
});

test("invalid config reports a path", () => {
  const cases: [string, RegExp][] = [
    ["views:\n  - attributes:\n      a: color\n", /views\[0\]\.attributes\.a\.type: expected one of string, text/],
    ["views:\n  - attributes:\n      a: enum\n", /views\[0\]\.attributes\.a\.values: required for enum/],
    ["views:\n  - attributes:\n      a: {type: enum, values: [{value: x, color: pink}]}\n", /values\[0\]\.color/],
    ["views:\n  - widths: {a: -1}\n", /views\[0\]\.widths\.a/],
    ["views:\n  - files: 3\n", /views\[0\]\.files/],
    ["views:\n  - attributes:\n      a: {type: string, readonly: yes}\n", /views\[0\]\.attributes\.a\.readonly/],
    ["views:\n  - readonlyColumns: 3\n", /views\[0\]\.readonlyColumns/],
    ["views:\n  - onSave: 3\n", /views\[0\]\.onSave: expected a string/],
    ["views:\n  - filters: {a: b}\n", /views\[0\]\.filters: expected a list/],
    ["views:\n  - filters: [{query: x}]\n", /views\[0\]\.filters\[0\]\.name: required/],
    ["views:\n  - filters: [{name: x}]\n", /views\[0\]\.filters\[0\]\.query: required/],
    ["views:\n  - otherColumns: maybe\n", /views\[0\]\.otherColumns/],
    ["views: {}\n", /^views: expected a list/],
    ["- a\n", /expected an object/],
    ["views: [\n", /./],
  ];
  for (const [text, expected] of cases) {
    const result = parseConfig(text);
    assert.ok(!result.ok, text);
    assert.match(result.message, expected);
  }
});

test("saveLayout: new config file and new view", () => {
  const layout = { columns: ["id", "status"], hidden: ["comment"], showOthers: false, widths: { id: 80 } };
  const created = saveLayout(null, { kind: "new", name: "data", files: ["data/*.yaml"] }, layout);
  assert.match(created, /^# Tablify configuration/);
  const view = parsed(created).views[0];
  assert.equal(view.name, "data");
  assert.deepEqual(view.files, ["data/*.yaml"]);
  assert.deepEqual(view.layout, layout);
  assert.match(created, /columns: \[ id, status \]|columns: \[id, status\]/);
});

test("saveLayout: a data path chosen in the table is saved with the view, an existing path is kept", () => {
  const layout = { columns: null, hidden: [], showOthers: true, widths: {} };
  const created = saveLayout(null, { kind: "new", name: "api", files: ["api.json"], path: "data.items" }, layout);
  assert.deepEqual(parsed(created).views[0].dataPath, ["data", "items"]);

  const kept = saveLayout(created, { kind: "existing", index: 0, path: "other" }, layout);
  assert.deepEqual(parsed(kept).views[0].dataPath, ["data", "items"]);
});

test("saveLayout: updates an existing view, keeps comments and attributes", () => {
  const updated = saveLayout(example, { kind: "existing", index: 0 }, {
    columns: ["status", "id"],
    hidden: [],
    showOthers: true,
    widths: { status: 120 },
  });
  assert.ok(updated.includes("# Tablify configuration for this workspace folder"));
  const view = parsed(updated).views[0];
  assert.deepEqual(view.layout, { columns: ["status", "id"], hidden: [], showOthers: true, widths: { status: 120 } });
  assert.deepEqual(view.attributes, parsed(example).views[0].attributes);
  assert.doesNotMatch(updated, /^\s+hiddenColumns:/m);
  assert.match(updated, /files: \["req_test_data\*\.\{json,yaml,yml,csv\}"\]/);
  // Layout keys stay above the attributes.
  assert.ok(updated.indexOf("columns:") < updated.indexOf("attributes:"));
});

test("saveLayout: a new view is placed first, so it takes precedence", () => {
  const updated = saveLayout(example, { kind: "new", name: "one file", files: ["req_test_data_3.yaml"] }, {
    columns: ["id"],
    hidden: [],
    showOthers: false,
    widths: {},
  });
  const config = parsed(updated);
  assert.equal(config.views.length, 3);
  assert.equal(findView(config, "req_test_data_3.yaml")?.view.name, "one file");
  assert.equal(findView(config, "req_test_data.json")?.view.name, "Requirements");
  assert.ok(updated.includes("description: Requirement"));
});

test("saveFilter: adds, replaces by name, and deleteFilter removes", () => {
  const added = saveFilter(example, { kind: "existing", index: 0 }, { name: "Mine", query: "developer=SEC" });
  const filters = () => parsed(added).views[0].filters;
  assert.deepEqual(filters().at(-1), { name: "Mine", query: "developer=SEC" });
  assert.ok(added.includes("# Tablify configuration for this workspace folder"));
  assert.match(added, /^ {6}- \{name: Mine, query: developer=SEC\}$/m);

  const replaced = saveFilter(added, { kind: "existing", index: 0 }, { name: "Mine", query: "developer=DEV" });
  const view = parsed(replaced).views[0];
  assert.equal(view.filters.length, filters().length);
  assert.deepEqual(view.filters.at(-1), { name: "Mine", query: "developer=DEV" });

  const removed = deleteFilter(replaced, 0, "Mine");
  assert.deepEqual(parsed(removed).views[0].filters, parsed(example).views[0].filters);
  const none = parsed(example).views[0].filters.reduce((text, filter) => deleteFilter(text, 0, filter.name), example);
  assert.doesNotMatch(none, /^\s+filters:/m);
});

test("saveFilter: into a new config file", () => {
  const created = saveFilter(null, { kind: "new", name: "a.json", files: ["a.json"] }, { name: "Done", query: 'status="done"' });
  assert.deepEqual(parsed(created).views[0].filters, [{ name: "Done", query: 'status="done"' }]);
});

test("glob matching", () => {
  assert.ok(matchesGlob("*.json", "a.json"));
  assert.ok(matchesGlob("*.json", "sub/dir/a.json"));
  assert.ok(!matchesGlob("*.json", "a.yaml"));
  assert.ok(matchesGlob("req_*.{json,yaml}", "req_1.yaml"));
  assert.ok(matchesGlob("sub/*.json", "sub/a.json"));
  assert.ok(!matchesGlob("sub/*.json", "sub/x/a.json"));
  assert.ok(matchesGlob("sub/**/*.json", "sub/x/y/a.json"));
  assert.ok(matchesGlob("sub/**/*.json", "sub/a.json"));
  assert.ok(matchesGlob("file?.json", "file1.json"));
});
