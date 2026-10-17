// Workspace configuration: `.vscode/tablify.yaml` in a workspace folder.
// Free of the vscode API so it can be unit-tested with plain Node.
//
//   views:                                 # the first view whose `files` match is used
//     - name: Requirements
//       files: ["requirements/**/*.yaml"]  # globs, relative to the workspace folder
//       path: document.data.objects        # where the entries are (default: top level)
//       columns: [id, type, status, text]  # column order
//       hiddenColumns: [comment]
//       otherColumns: show                 # show | hide fields not in `columns`
//       widths: { id: 90, text: 420 }
//       readonlyColumns: [created]         # not editable in the table
//       onSave: npx prettier --write ${file}   # run after saving (trusted workspaces only)
//       filters:                           # saved filters, offered in the filter bar
//         - { name: Open, query: "status=draft" }
//       attributes:
//         id: { type: string, readonly: true }
//         title: string                    # shorthand: just the type
//         status:
//           type: enum
//           label: Status
//           description: Lifecycle state
//           values:
//             - draft                      # shorthand: just the value
//             - { value: valid, label: Valid, color: green }

import * as YAML from "yaml";
import { parseDataPath } from "./parser.ts";
import {
  ATTRIBUTE_TYPES,
  BADGE_COLORS,
  type Attribute,
  type AttributeType,
  type BadgeColor,
  type ColumnLayout,
  type EnumValue,
  type SavedFilter,
  type ViewSettings,
} from "./messages.ts";

/** Candidate config files, relative to a workspace folder; the first that exists is used. */
export const CONFIG_FILES = [".vscode/tablify.yaml", ".vscode/tablify.yml", ".vscode/tablify.json"];

export interface ViewConfig extends ViewSettings {
  /** Glob patterns of data files the view applies to; null = all files. */
  files: string[] | null;
}

export interface Config {
  views: ViewConfig[];
}

export type ConfigParseResult = { ok: true; config: Config } | { ok: false; message: string };

export const DEFAULT_LAYOUT: ColumnLayout = { columns: null, hidden: [], showOthers: true, widths: {} };

class ConfigError extends Error {}

function fail(path: string, message: string): never {
  throw new ConfigError(`${path}: ${message}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") fail(path, "expected a string");
  return value;
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") fail(path, "expected true or false");
  return value;
}

function stringList(value: unknown, path: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || !list.every((item) => typeof item === "string")) {
    fail(path, "expected a list of strings");
  }
  return list;
}

function parseValue(raw: unknown, path: string): EnumValue {
  if (!isObject(raw)) {
    if (raw === null || typeof raw === "object") fail(path, "expected a value or { value, label, color }");
    return { value: String(raw), label: String(raw) };
  }
  if (raw.value === undefined || raw.value === null || typeof raw.value === "object") {
    fail(`${path}.value`, "required");
  }
  const value = String(raw.value);
  const color = optionalString(raw.color, `${path}.color`);
  if (color !== undefined && !BADGE_COLORS.includes(color as BadgeColor)) {
    fail(`${path}.color`, `expected one of ${BADGE_COLORS.join(", ")}`);
  }
  return {
    value,
    label: optionalString(raw.label, `${path}.label`) ?? value,
    color: color as BadgeColor | undefined,
    description: optionalString(raw.description, `${path}.description`),
  };
}

function parseAttribute(name: string, raw: unknown, base: string): Attribute {
  const path = `${base}.${name}`;
  const spec = typeof raw === "string" ? { type: raw } : raw;
  if (!isObject(spec)) fail(path, "expected a type name or an object with `type`");

  const type = spec.type;
  if (typeof type !== "string" || !ATTRIBUTE_TYPES.includes(type as AttributeType)) {
    fail(`${path}.type`, `expected one of ${ATTRIBUTE_TYPES.join(", ")}`);
  }

  let values: EnumValue[] = [];
  if (type === "enum" || type === "multienum") {
    if (!Array.isArray(spec.values) || spec.values.length === 0) {
      fail(`${path}.values`, `required for ${type}`);
    }
    values = spec.values.map((value, index) => parseValue(value, `${path}.values[${index}]`));
  }

  return {
    name,
    type: type as AttributeType,
    label: optionalString(spec.label, `${path}.label`) ?? name,
    description: optionalString(spec.description, `${path}.description`),
    readonly: optionalBoolean(spec.readonly, `${path}.readonly`) ?? false,
    values,
  };
}

function parseFilters(raw: unknown, path: string): SavedFilter[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail(path, "expected a list of { name, query }");
  return raw.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isObject(item)) fail(itemPath, "expected { name, query }");
    const name = optionalString(item.name, `${itemPath}.name`);
    const query = optionalString(item.query, `${itemPath}.query`);
    if (!name) fail(`${itemPath}.name`, "required");
    if (query === undefined) fail(`${itemPath}.query`, "required");
    return { name, query };
  });
}

function parseView(raw: unknown, index: number): ViewConfig {
  const path = `views[${index}]`;
  if (!isObject(raw)) fail(path, "expected an object");

  const attributes = raw.attributes ?? {};
  if (!isObject(attributes)) fail(`${path}.attributes`, "expected a mapping of attribute name -> definition");

  const other = raw.otherColumns ?? "show";
  if (other !== "show" && other !== "hide") fail(`${path}.otherColumns`, "expected show or hide");

  const widths: Record<string, number> = {};
  if (raw.widths !== undefined && raw.widths !== null) {
    if (!isObject(raw.widths)) fail(`${path}.widths`, "expected a mapping of column -> width");
    for (const [column, width] of Object.entries(raw.widths)) {
      if (typeof width !== "number" || width <= 0) fail(`${path}.widths.${column}`, "expected a positive number");
      widths[column] = width;
    }
  }

  let dataPath: string[] | null = null;
  const dataPathText = optionalString(raw.path, `${path}.path`);
  if (dataPathText !== undefined) {
    dataPath = parseDataPath(dataPathText);
    if (!dataPath) fail(`${path}.path`, "expected keys separated by . or /, e.g. document.data.objects or items[0].rows");
  }

  return {
    name: optionalString(raw.name, `${path}.name`) ?? null,
    files: stringList(raw.files, `${path}.files`) ?? null,
    dataPath: dataPath && dataPath.length > 0 ? dataPath : null,
    attributes: Object.entries(attributes).map(([name, spec]) => parseAttribute(name, spec, `${path}.attributes`)),
    layout: {
      columns: stringList(raw.columns, `${path}.columns`) ?? null,
      hidden: stringList(raw.hiddenColumns, `${path}.hiddenColumns`) ?? [],
      showOthers: other === "show",
      widths,
    },
    readonlyColumns: stringList(raw.readonlyColumns, `${path}.readonlyColumns`) ?? [],
    filters: parseFilters(raw.filters, `${path}.filters`),
    onSave: optionalString(raw.onSave, `${path}.onSave`) ?? null,
  };
}

export function parseConfig(text: string): ConfigParseResult {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length > 0) {
    return { ok: false, message: doc.errors[0].message.split("\n")[0] };
  }
  try {
    const raw: unknown = doc.toJS();
    if (raw === null || raw === undefined) return { ok: true, config: { views: [] } };
    if (!isObject(raw)) fail("(root)", "expected an object with `views`");
    const views = raw.views ?? [];
    if (!Array.isArray(views)) fail("views", "expected a list of views");
    return { ok: true, config: { views: views.map(parseView) } };
  } catch (error) {
    if (error instanceof ConfigError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
}

/** The first view whose `files` match `relativePath` (relative to the workspace folder). */
export function findView(config: Config, relativePath: string): { index: number; view: ViewConfig } | null {
  const index = config.views.findIndex(
    (view) => view.files === null || view.files.some((pattern) => matchesGlob(pattern, relativePath)),
  );
  return index === -1 ? null : { index, view: config.views[index] };
}

/**
 * Glob match against a "/"-separated relative path. Supports `*`, `**`, `?`
 * and `{a,b}`. Patterns without "/" match the file name at any depth (like
 * .gitignore).
 */
export function matchesGlob(pattern: string, relativePath: string): boolean {
  const target = pattern.includes("/") ? relativePath : relativePath.split("/").pop() ?? "";
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      source += pattern[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += pattern[i + 2] === "/" ? 2 : 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        source += "\\{";
        continue;
      }
      const options = pattern.slice(i + 1, end).split(",").map(escapeRegExp);
      source += `(?:${options.join("|")})`;
      i = end;
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`).test(target.replace(/^\.\//, ""));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Saving a view's column layout ---------------------------------------------------

const NEW_CONFIG_HEADER = `# Tablify configuration for this workspace folder.
# Views apply to the data files matched by \`files\` (globs relative to the workspace
# folder); the first matching view is used. See the Tablify README for all options.
`;

/** `path`: the data path shown in the table, written to the view when it has none. */
export type SaveTarget = ({ kind: "existing"; index: number } | { kind: "new"; name: string; files: string[] }) & {
  path?: string;
};

/**
 * Applies `change` to one view of the config: an existing view, or a new view
 * placed first (so it takes precedence over broader views). Other content,
 * including comments, is kept. `text` is null when there is no config file yet.
 */
function updateView(text: string | null, target: SaveTarget, change: (view: ViewEditor) => void): string {
  const doc = text?.trim() ? YAML.parseDocument(text) : YAML.parseDocument(`${NEW_CONFIG_HEADER}views: []\n`);
  if (doc.errors.length > 0) {
    throw new Error(`The config file has YAML errors: ${doc.errors[0].message.split("\n")[0]}`);
  }
  if (!YAML.isMap(doc.contents)) {
    doc.contents = doc.createNode({ views: [] }) as unknown as typeof doc.contents;
  }
  let views = doc.get("views", true);
  if (!YAML.isSeq(views)) {
    doc.set("views", doc.createNode([]));
    views = doc.get("views", true);
  }
  if (!YAML.isSeq(views)) throw new Error("Cannot update `views` in the config file.");
  views.flow = false;

  let view: YAML.YAMLMap;
  if (target.kind === "new") {
    view = doc.createNode({ name: target.name }) as YAML.YAMLMap;
    view.set("files", flow(doc, target.files));
    views.items.unshift(view);
  } else {
    const existing = views.items[target.index];
    if (!YAML.isMap(existing)) throw new Error(`views[${target.index}] is not an object.`);
    view = existing;
  }

  const editor = new ViewEditor(doc, view);
  if (target.path && !view.has("path")) {
    editor.set("path", doc.createNode(target.path));
  }
  change(editor);
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

function flow(doc: YAML.Document, value: unknown): YAML.Node {
  const node = doc.createNode(value);
  if (YAML.isCollection(node)) node.flow = true;
  return node;
}

class ViewEditor {
  readonly doc: YAML.Document;
  readonly view: YAML.YAMLMap;

  constructor(doc: YAML.Document, view: YAML.YAMLMap) {
    this.doc = doc;
    this.view = view;
  }

  /** Sets `key` (null deletes it). New keys go above `attributes`, which can be long. */
  set(key: string, node: YAML.Node | null) {
    if (node === null) {
      this.view.delete(key);
    } else if (this.view.has(key)) {
      this.view.set(key, node);
    } else {
      const pair = this.doc.createPair(key, node);
      const at = this.view.items.findIndex((item) => YAML.isScalar(item.key) && item.key.value === "attributes");
      if (at === -1) this.view.items.push(pair);
      else this.view.items.splice(at, 0, pair);
    }
  }

  /** The `filters` list, created when missing. */
  filters(): YAML.YAMLSeq {
    const existing = this.view.get("filters", true);
    if (YAML.isSeq(existing)) return existing;
    const seq = this.doc.createNode([]) as YAML.YAMLSeq;
    this.set("filters", seq);
    return seq;
  }
}

function filterName(item: unknown): unknown {
  return YAML.isMap(item) ? item.get("name") : undefined;
}

/** Writes `layout` into the config (see `updateView`). */
export function saveLayout(text: string | null, target: SaveTarget, layout: ColumnLayout): string {
  return updateView(text, target, (view) => {
    const keep = <T>(value: T, condition: boolean) => (condition ? flow(view.doc, value) : null);
    view.set("columns", keep(layout.columns ?? [], layout.columns !== null && layout.columns.length > 0));
    view.set("hiddenColumns", keep(layout.hidden, layout.hidden.length > 0));
    view.set("otherColumns", keep("hide", !layout.showOthers));
    view.set("widths", keep(layout.widths, Object.keys(layout.widths).length > 0));
  });
}

/** Adds a saved filter to a view, or replaces the query of the filter with the same name. */
export function saveFilter(text: string | null, target: SaveTarget, filter: SavedFilter): string {
  return updateView(text, target, (view) => {
    const filters = view.filters();
    filters.flow = false;
    const existing = filters.items.find((item) => filterName(item) === filter.name);
    if (YAML.isMap(existing)) {
      existing.set("query", filter.query);
    } else {
      filters.items.push(flow(view.doc, filter));
    }
  });
}

/** Removes the saved filter `name` from a view (and `filters` when it becomes empty). */
export function deleteFilter(text: string, index: number, name: string): string {
  return updateView(text, { kind: "existing", index }, (view) => {
    const filters = view.filters();
    filters.items = filters.items.filter((item) => filterName(item) !== name);
    if (filters.items.length === 0) view.set("filters", null);
  });
}
