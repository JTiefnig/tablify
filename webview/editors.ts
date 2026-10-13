// Cell editing: which editor each attribute type gets, how edited values are
// converted back to what is stored in the file, and the rich-text popup for
// HTML content.

import DOMPurify from "dompurify";
import type { CellComponent, ColumnDefinition, Editor } from "tabulator-tables";
import type { Attribute, AttributeType, Cell, Row } from "../src/messages.ts";
import { itemsOf, parseBoolean } from "./attributes.ts";
import { escapeHtml, isHtml } from "./format.ts";

/** How a column is edited: by a Tabulator editor, a click toggle, or the rich-text popup. */
export type EditMode = "editor" | "toggle" | "richText";

/** Attribute type used for editing; for fields without a definition it is inferred from the data. */
export function editType(field: string, rows: Row[], attribute: Attribute | undefined, wrap: boolean): AttributeType {
  if (attribute) {
    return attribute.type;
  }
  const values = rows.map((row) => row[field]).filter((value) => value !== null && value !== undefined && value !== "");
  if (values.length > 0 && values.every((value) => typeof value === "number")) return "number";
  if (values.length > 0 && values.every((value) => typeof value === "boolean")) return "boolean";
  if (values.some(Array.isArray)) return "list";
  if (values.some(isHtml)) return "html";
  return wrap ? "text" : "string";
}

export function editMode(type: AttributeType): EditMode {
  return type === "boolean" ? "toggle" : type === "html" ? "richText" : "editor";
}

/** Tabulator editor settings for the `editor` edit mode. */
export function editorColumn(type: AttributeType, attribute: Attribute | undefined): Partial<ColumnDefinition> {
  switch (type) {
    case "number":
      return { editor: "number" };
    case "date":
      return { editor: "date" };
    case "text":
      return { editor: "textarea", editorParams: { shiftEnterSubmit: true } };
    case "list":
      return { editor: listEditor };
    case "enum":
    case "multienum":
      return {
        editor: "list",
        editorParams: {
          values: (attribute?.values ?? []).map(({ value, label }) => ({
            value,
            label: label.toLowerCase() === value.toLowerCase() ? label : `${label} (${value})`,
          })),
          multiselect: type === "multienum",
          clearable: true,
          listOnEmpty: true,
          autocomplete: type === "enum",
          filterFunc: (term: string, label: string) => label.toLowerCase().includes(term.toLowerCase()),
        },
      };
    default:
      return { editor: "input" };
  }
}

/** Free lists: one item per line. Ctrl/Cmd+Enter or leaving the field saves, Escape cancels. */
const listEditor: Editor = (cell, onRendered, success, cancel) => {
  const area = document.createElement("textarea");
  area.className = "list-editor";
  area.value = itemsOf(cell.getValue()).join("\n");
  area.rows = Math.max(2, area.value.split("\n").length + 1);
  area.title = "One item per line";
  const commit = () => success(area.value.split("\n").map((item) => item.trim()).filter(Boolean));
  area.addEventListener("blur", commit);
  area.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      area.removeEventListener("blur", commit);
      cancel(undefined);
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      commit();
    }
    event.stopPropagation();
  });
  onRendered(() => area.focus());
  return area;
};

// --- Converting edited values -----------------------------------------------

export type Coerced = { value: Cell; remove?: boolean } | "unchanged" | "invalid";

const isEmpty = (value: unknown) =>
  value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);

/**
 * Converts an edited value to what is written to the file, keeping the file's
 * representation where possible (e.g. comma-separated strings stay strings).
 */
export function coerce(type: AttributeType, raw: unknown, original: Cell | undefined): Coerced {
  const result = convert(type, raw, original);
  if (typeof result === "string") return result;
  if (result.remove ? original === undefined : JSON.stringify(result.value) === JSON.stringify(original)) {
    return "unchanged";
  }
  return result;
}

function convert(type: AttributeType, raw: unknown, original: Cell | undefined): Coerced {
  const remove: Coerced = { value: null, remove: true };

  switch (type) {
    case "number": {
      if (isEmpty(raw)) return remove;
      const number = Number(raw);
      return Number.isNaN(number) ? "invalid" : { value: number };
    }
    case "enum":
    case "date":
      return isEmpty(raw) ? remove : { value: String(raw) };
    case "multienum":
    case "list": {
      const items = Array.isArray(raw) ? raw.map(String) : itemsOf(raw as Cell);
      if (typeof original === "string") return { value: items.join(", ") };
      return { value: items };
    }
    default:
      if (isEmpty(raw) && original === undefined) return "unchanged";
      return { value: raw === null || raw === undefined ? "" : String(raw) };
  }
}

const BOOLEAN_PAIRS: [string, string][] = [
  ["true", "false"],
  ["yes", "no"],
  ["y", "n"],
  ["on", "off"],
  ["1", "0"],
];

/** The negated value, written the way the file already writes it (yes/no, 1/0, true/false). */
export function toggledBoolean(original: Cell | undefined): Cell {
  const next = !(parseBoolean(original) ?? false);
  if (typeof original === "number") return next ? 1 : 0;
  if (typeof original === "string") {
    const lower = original.trim().toLowerCase();
    const pair = BOOLEAN_PAIRS.find(([yes, no]) => lower === yes || lower === no);
    if (pair) {
      const text = next ? pair[0] : pair[1];
      return /^[A-Z]/.test(original.trim()) ? text[0].toUpperCase() + text.slice(1) : text;
    }
  }
  return next;
}

// --- Rich-text popup -------------------------------------------------------------

const TOOLBAR: { command: string; label: string; title: string; value?: string }[] = [
  { command: "bold", label: "B", title: "Bold (Ctrl+B)" },
  { command: "italic", label: "I", title: "Italic (Ctrl+I)" },
  { command: "underline", label: "U", title: "Underline (Ctrl+U)" },
  { command: "strikeThrough", label: "S", title: "Strikethrough" },
  { command: "formatBlock", label: "H", title: "Heading", value: "h3" },
  { command: "formatBlock", label: "¶", title: "Paragraph", value: "p" },
  { command: "insertUnorderedList", label: "•", title: "Bulleted list" },
  { command: "insertOrderedList", label: "1.", title: "Numbered list" },
  { command: "removeFormat", label: "⌫", title: "Clear formatting" },
];

let openEditor: { close(save: boolean): void } | null = null;

/** Turns editor HTML back into stored HTML: original relative image paths, sanitized. */
function toStoredHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = DOMPurify.sanitize(html);
  for (const name of ["src", "poster"]) {
    for (const element of template.content.querySelectorAll(`[data-tablify-${name}]`)) {
      element.setAttribute(name, element.getAttribute(`data-tablify-${name}`) ?? "");
      element.removeAttribute(`data-tablify-${name}`);
    }
  }
  // contenteditable inserts &nbsp; for typed spaces; HTML collapses spaces anyway.
  return template.innerHTML.replace(/&nbsp;/g, " ").trim();
}

/**
 * Opens a small WYSIWYG editor over a cell. Values that were wrapped in
 * `<html>…</html>`, or that gain markup, are saved wrapped; plain text stays plain.
 */
export function openRichTextEditor(cell: CellComponent, original: Cell | undefined, onSave: (value: string) => void) {
  openEditor?.close(true);

  const originalText = original === null || original === undefined ? "" : String(original);
  const wasHtml = isHtml(originalText);

  const panel = document.createElement("div");
  panel.className = "rich-text-editor";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Edit formatted text");

  const toolbar = document.createElement("div");
  toolbar.className = "rte-toolbar";
  const content = document.createElement("div");
  content.className = "rte-content";
  content.contentEditable = "true";
  content.innerHTML = wasHtml
    ? DOMPurify.sanitize(originalText)
    : escapeHtml(originalText).replace(/\n/g, "<br>");

  const buttons = TOOLBAR.map((tool) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `rte-button rte-${tool.command}`;
    button.textContent = tool.label;
    button.title = tool.title;
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      document.execCommand(tool.command, false, tool.value);
      content.focus();
      refreshToolbar();
    });
    toolbar.appendChild(button);
    return { button, tool };
  });

  const refreshToolbar = () => {
    for (const { button, tool } of buttons) {
      if (!tool.value && tool.command !== "removeFormat") {
        button.classList.toggle("active", document.queryCommandState(tool.command));
      }
    }
  };

  const footer = document.createElement("div");
  footer.className = "rte-footer";
  footer.innerHTML = `<span class="rte-hint">Ctrl+Enter to save · Esc to cancel</span>`;
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "rte-secondary";
  cancelButton.textContent = "Cancel";
  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "rte-primary";
  saveButton.textContent = "Save";
  footer.append(cancelButton, saveButton);

  panel.append(toolbar, content, footer);
  document.body.appendChild(panel);

  // Position over the cell, kept inside the viewport.
  const rect = cell.getElement().getBoundingClientRect();
  const width = Math.min(Math.max(rect.width, 460), window.innerWidth - 16);
  panel.style.width = `${width}px`;
  panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  const top = Math.min(rect.top, window.innerHeight - panel.offsetHeight - 8);
  panel.style.top = `${Math.max(8, top)}px`;

  const close = (save: boolean) => {
    if (openEditor !== handle) return;
    openEditor = null;
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("selectionchange", refreshToolbar);
    panel.remove();
    if (!save) return;

    const html = toStoredHtml(content.innerHTML);
    const template = document.createElement("template");
    template.innerHTML = html;
    const hasMarkup = template.content.querySelector("*") !== null;
    const value = wasHtml || hasMarkup ? `<html>${html}</html>` : (template.content.textContent ?? "");
    if (value !== originalText) {
      onSave(value);
    }
  };
  const handle = { close };
  openEditor = handle;

  const onOutside = (event: MouseEvent) => {
    if (!panel.contains(event.target as Node)) close(true);
  };
  document.addEventListener("mousedown", onOutside, true);
  document.addEventListener("selectionchange", refreshToolbar);
  saveButton.addEventListener("click", () => close(true));
  cancelButton.addEventListener("click", () => close(false));
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      close(false);
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      close(true);
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  });

  document.execCommand("defaultParagraphSeparator", false, "p");
  // Focus after the double-click that opened the editor has been fully handled
  // (the table moves focus to the cell otherwise), with the caret at the end.
  requestAnimationFrame(() => {
    content.focus();
    const selection = window.getSelection();
    selection?.selectAllChildren(content);
    selection?.collapseToEnd();
  });
}
