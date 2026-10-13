// Value semantics per attribute type, shared by formatting, filtering and
// the header dropdowns.

import type { Attribute, Cell, EnumValue, ViewSettings } from "../src/messages.ts";

export type AttributeMap = Map<string, Attribute>;

export function attributeMap(view: ViewSettings | null): AttributeMap {
  return new Map((view?.attributes ?? []).map((attribute) => [attribute.name, attribute]));
}

export function scalarText(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

/** Individual items of a cell: list elements, or comma-separated multienum strings. */
export function itemsOf(value: Cell | undefined, attribute?: Attribute): string[] {
  if (Array.isArray(value)) {
    return value.map(scalarText);
  }
  const text = scalarText(value);
  if (attribute?.type === "multienum") {
    return text.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return text ? [text] : [];
}

export function findEnumValue(attribute: Attribute, raw: string): EnumValue | undefined {
  const needle = raw.trim().toLowerCase();
  return attribute.values.find((option) => option.value.toLowerCase() === needle);
}

const TRUE = new Set(["true", "yes", "y", "1", "on"]);
const FALSE = new Set(["false", "no", "n", "0", "off"]);

export function parseBoolean(value: unknown): boolean | null {
  const text = scalarText(value).trim().toLowerCase();
  if (TRUE.has(text)) return true;
  if (FALSE.has(text)) return false;
  return null;
}

export function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Strings a cell matches on: the raw items, plus enum labels and the text of
 * HTML content.
 */
export function searchTerms(value: Cell | undefined, attribute?: Attribute): string[] {
  const items = itemsOf(value, attribute);
  if (!attribute) {
    return items.map((item) => (/^\s*<html>/i.test(item) ? stripTags(item) : item));
  }
  switch (attribute.type) {
    case "html":
      return items.map(stripTags);
    case "enum":
    case "multienum":
      return items.flatMap((item) => {
        const option = findEnumValue(attribute, item);
        return option && option.label !== item ? [item, option.label] : [item];
      });
    case "boolean": {
      const parsed = parseBoolean(value);
      return parsed === null ? items : [String(parsed), ...items];
    }
    default:
      return items;
  }
}
