// Autocomplete for the filter input: field names while typing a clause,
// known values after `field=` / `field~` / `field!=` etc.

import { formatClause } from "./filter.ts";
import type { FilterOption } from "./table.ts";

export interface Suggestion {
  label: string;
  kind: "field" | "value";
  /** Full input value after accepting, and the caret position in it. */
  text: string;
  caret: number;
}

const MAX_SUGGESTIONS = 12;
const SEPARATOR = /\s+AND\s+/gi;

export function suggest(
  value: string,
  caret: number,
  fields: string[],
  options: Map<string, FilterOption[]>,
): Suggestion[] {
  const before = value.slice(0, caret);
  let start = 0;
  for (const match of before.matchAll(SEPARATOR)) {
    start = match.index + match[0].length;
  }
  start += before.slice(start).length - before.slice(start).trimStart().length;

  const nextSeparator = new RegExp(SEPARATOR.source, "i").exec(value.slice(caret));
  const end = nextSeparator ? caret + nextSeparator.index : value.length;
  const clause = before.slice(start);

  const replace = (from: number, to: number, insert: string): Pick<Suggestion, "text" | "caret"> => ({
    text: value.slice(0, from) + insert + value.slice(to),
    caret: from + insert.length,
  });

  const valueMatch = clause.match(/^([A-Za-z_][\w.-]*)\s*(!=|<=|>=|=|~|:|<|>)\s*("?)(.*)$/);
  if (valueMatch) {
    const field = fields.find((name) => name.toLowerCase() === valueMatch[1].toLowerCase());
    const partial = valueMatch[4].toLowerCase();
    if (!field) {
      return [];
    }
    return (options.get(field) ?? [])
      .filter((option) => `${option.value}\n${option.label}`.toLowerCase().includes(partial))
      .filter((option) => option.value.toLowerCase() !== partial)
      .slice(0, MAX_SUGGESTIONS)
      .map((option) => ({
        label: option.label === option.value ? option.label : `${option.label} (${option.value})`,
        kind: "value",
        ...replace(start, end, formatClause(field, valueMatch[2], option.value)),
      }));
  }

  if (!/^[A-Za-z_][\w.-]*$/.test(clause)) {
    return [];
  }
  const partial = clause.toLowerCase();
  return fields
    .filter((field) => field.toLowerCase().startsWith(partial) && field.toLowerCase() !== partial)
    .slice(0, MAX_SUGGESTIONS)
    .map((field) => ({ label: field, kind: "field", ...replace(start, caret, `${field}=`) }));
}
