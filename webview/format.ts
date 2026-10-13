// Cell value formatting. Without an attribute definition values are shown as
// escaped text, or sanitized HTML for `<html>...</html>` values; with one, the
// attribute type decides.

import DOMPurify from "dompurify";
import type { Attribute, Cell } from "../src/messages.ts";
import { findEnumValue, itemsOf, parseBoolean, scalarText } from "./attributes.ts";

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function cellText(value: Cell | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  return Array.isArray(value) ? value.join(", ") : String(value);
}

// --- HTML content ------------------------------------------------------------

let baseUri = "";

/** Base for relative `src` / `poster` attributes in HTML cell content. */
export function setBaseUri(uri: string) {
  baseUri = uri;
}

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  for (const name of ["src", "poster"]) {
    const value = node.getAttribute(name)?.trim();
    if (!value || !baseUri || /^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(value)) {
      continue;
    }
    try {
      node.setAttribute(name, new URL(value, baseUri).href);
      // Remembered so the rich-text editor can write the original path back.
      node.setAttribute(`data-tablify-${name}`, value);
    } catch {
      // Keep the original value if it cannot be resolved.
    }
  }
});

export function isHtml(value: unknown): value is string {
  return typeof value === "string" && /^\s*<html>[\s\S]*<\/html>\s*$/i.test(value);
}

function plainText(value: Cell | undefined): string {
  return escapeHtml(cellText(value)).replace(/\n/g, "<br/>");
}

/** Sanitized HTML for `<html>...</html>` values; escaped text otherwise. */
export function formatRichText(value: Cell | undefined): string {
  return isHtml(value) ? DOMPurify.sanitize(value) : plainText(value);
}

// --- Typed values ----------------------------------------------------------------

function badge(label: string, color: string | undefined, title: string | undefined): string {
  const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
  return `<span class="badge ${color ?? "gray"}"${titleAttribute}>${escapeHtml(label)}</span>`;
}

function enumBadge(attribute: Attribute, raw: string): string {
  const option = findEnumValue(attribute, raw);
  if (!option) {
    return `<span class="badge undefined-value" title="${escapeHtml(`"${raw}" is not a defined ${attribute.label} value`)}">${escapeHtml(raw)}</span>`;
  }
  const title = [option.description, option.label !== option.value ? option.value : ""]
    .filter(Boolean)
    .join(" — ");
  return badge(option.label, option.color, title);
}

export function formatCell(value: Cell | undefined, attribute: Attribute | undefined): string {
  if (!attribute) {
    return formatRichText(value);
  }
  if (value === null || value === undefined || value === "") {
    return "";
  }

  switch (attribute.type) {
    case "string":
    case "number":
    case "date":
      return escapeHtml(cellText(value));
    case "text":
      return plainText(value);
    case "html":
      return typeof value === "string" ? DOMPurify.sanitize(value) : plainText(value);
    case "enum":
      return enumBadge(attribute, scalarText(Array.isArray(value) ? value[0] : value));
    case "multienum":
      return `<span class="badge-list">${itemsOf(value, attribute).map((item) => enumBadge(attribute, item)).join("")}</span>`;
    case "list":
      return `<span class="badge-list">${itemsOf(value, attribute).map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("")}</span>`;
    case "boolean": {
      const parsed = parseBoolean(value);
      if (parsed === null) {
        return `<span class="undefined-value" title="Not a boolean value">${escapeHtml(cellText(value))}</span>`;
      }
      return parsed
        ? `<span class="boolean true" title="${escapeHtml(cellText(value))}">✓</span>`
        : `<span class="boolean false" title="${escapeHtml(cellText(value))}">–</span>`;
    }
  }
}
