# Changelog

## Unreleased

- Log files as a table: **Open as Log Table** shows a log file as a read-only, sortable,
  filterable table with one row per event. Detects JSON Lines, logfmt, syslog (RFC 3164 and
  5424), access logs, Nginx and Apache error logs, Log4j-style application logs and Python
  `logging`, with a plain-text fallback; the format can be changed from the status bar.
  Multi-line entries (stack traces), normalized levels with colors, a level filter in the
  level column's header, message search (text or regex) in the same filter bar as the table
  view, column menu, entry details and reveal in source.
  Parsing and filtering run in the extension host and only visible rows are rendered, for
  files with millions of lines; large files can be opened partially. Custom formats in
  `tablify.log.customFormats`.
- CSV and TSV files (`.csv`, `.tsv`): header line as column names, delimiter detected
  (`,` `;` tab `|`). Editing, adding, deleting and moving rows, git changes and blame work as
  for JSON and YAML.
- `onSave` in a view runs a shell command (e.g. a formatter) after a table file is saved, with
  `${file}` and other placeholders. Output goes to the **Tablify** output channel; trusted
  workspaces only.
- "Changes only" filter: clicking the baseline column header shows only entries changed since
  the last commit, including deleted entries (read-only, where they used to be).
- Saved filters: the bookmark button in the filter bar lists the view's `filters` and saves
  the current query under a name (also **Tablify: Save Filter…**). They are stored in
  `.vscode/tablify.yaml`.
- Read-only columns: `readonly: true` on an attribute, or `readonlyColumns` in a view. Their
  cells cannot be edited in the table.
- Workspace configuration in `.vscode/tablify.yaml` with views per file pattern (replaces
  `tablify.attributes.yaml`). Columns can be dragged, hidden and shown from the header menu;
  **Save View** stores order, hidden columns and widths for the file, folder or matching view.
  Attribute `width` / `hidden` moved to the view (`widths`, `hiddenColumns`).
- Ctrl/Cmd+S in the table view saves without formatting, so format-on-save (e.g. Prettier)
  no longer rewrites untouched entries. Setting `tablify.saveWithoutFormatting`.
- Simpler file format: the top level is a list of entries or a hash of ID → entry. The
  `{"elements": [...]}` wrapper is no longer supported; the JSON test data was converted.
- Add, delete and move rows from the baseline column: hover toolbar (add above / below,
  delete) and drag & drop. New rows get a short unique ID.
- Git support: a change bar marks entries added or modified since the last commit (compared
  by ID and value), and clicking it shows the entry's history with per-field git blame,
  loaded on demand. Setting `tablify.git.enabled`.
- Edit cells in the table: type-specific editors (dropdowns, multi-select, checkbox toggle,
  text box, rich-text editor for HTML) write minimal edits to the JSON/YAML file, preserving
  formatting and comments. Reveal in text editor moved to Cmd/Ctrl+click.
- Optional attribute definitions (`tablify.attributes.yaml`): column order, labels, widths,
  hidden columns, and the types string, text, html, enum, multienum, list, number,
  boolean and date with type-aware display and filtering. Includes a JSON schema.
- Filter operators `!=`, `<`, `<=`, `>`, `>=`.
- Replaced the filter toolbar with a compact Find-style widget (Cmd/Ctrl+F, title-bar
  icon) with field and value autocompletion. The active filter shows in the status bar.
- Removed attribute-specific cell formatting (badges, type codes, merged cluster and
  ASIL/SEC columns) and cluster-range filtering. All fields now display generically;
  HTML values still render.

## 0.1.0

- First version as a VS Code extension: a read-only table view for JSON and YAML files
  (`elements` list, list of objects, or ID -> fields mapping).
- JQL-like filter with header dropdowns, VS Code theme colors, live updates, reveal row in
  the text editor.
