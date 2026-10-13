// JQL-like row filter: clauses joined by AND.
//   field=value   exact match (case-insensitive; any element for lists)
//   field:value   same as =
//   field!=value  no element matches
//   field~value   contains
//   field<value   also <=, >, >= — numeric when both sides are numbers,
//                 otherwise text order (works for ISO dates)
//   text          free text across all fields
// Values containing spaces can be quoted: tags="API Design".
// HTML values are matched on their text; enum values also match their label.

import type { Row } from "../src/messages.ts";
import { parseBoolean, searchTerms, type AttributeMap } from "./attributes.ts";

const OPERATOR = "!=|<=|>=|=|~|:|<|>";
const CLAUSE = new RegExp(`^([A-Za-z_][\\w.-]*)\\s*(${OPERATOR})\\s*(.+)$`);
/** A clause still being typed, e.g. `status=` — ignored rather than matching nothing. */
const INCOMPLETE_CLAUSE = new RegExp(`^([A-Za-z_][\\w.-]*)\\s*(${OPERATOR})\\s*"?$`);
const CLAUSE_GLOBAL = new RegExp(`([A-Za-z_][\\w.-]*)\\s*(?:${OPERATOR})`, "g");

function splitClauses(query: string): string[] {
  return query
    .trim()
    .replace(/\s+AND$/i, "")
    .split(/\s+AND\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

function unquote(value: string): string {
  return value.trim().replace(/^"(.*)"$/, "$1");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Maps lower-cased names to the actual field names. */
function fieldLookup(fields: string[]): Map<string, string> {
  return new Map(fields.map((field) => [field.toLowerCase(), field]));
}

function compare(left: string, right: string): number {
  const a = Number(left);
  const b = Number(right);
  if (left.trim() !== "" && right.trim() !== "" && !Number.isNaN(a) && !Number.isNaN(b)) {
    return a - b;
  }
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

const COMPARISONS: Record<string, (order: number) => boolean> = {
  "<": (order) => order < 0,
  "<=": (order) => order <= 0,
  ">": (order) => order > 0,
  ">=": (order) => order >= 0,
};

export function buildFilter(
  query: string,
  fields: string[],
  attributes: AttributeMap,
): ((row: Row) => boolean) | null {
  const lookup = fieldLookup(fields);
  const clauses = splitClauses(query).filter((clause) => {
    const incomplete = clause.match(INCOMPLETE_CLAUSE);
    return !(incomplete && lookup.has(incomplete[1].toLowerCase()));
  });
  if (clauses.length === 0) {
    return null;
  }

  const terms = (row: Row, field: string) =>
    searchTerms(row[field], attributes.get(field)).map((term) => term.toLowerCase());

  const predicates = clauses.map((clause): ((row: Row) => boolean) => {
    const match = clause.match(CLAUSE);
    const field = match && lookup.get(match[1].toLowerCase());

    if (!match || !field) {
      const needle = unquote(clause).toLowerCase();
      return (row) => fields.some((name) => terms(row, name).some((term) => term.includes(needle)));
    }

    const operator = match[2];
    const raw = unquote(match[3]);
    const value = raw.toLowerCase();
    const attribute = attributes.get(field);

    if (operator === "~") {
      return (row) => terms(row, field).some((term) => term.includes(value));
    }

    const comparison = COMPARISONS[operator];
    if (comparison) {
      return (row) => terms(row, field).some((term) => comparison(compare(term, raw)));
    }

    const equals = (row: Row) => {
      if (attribute?.type === "boolean") {
        const wanted = parseBoolean(raw);
        if (wanted !== null) return parseBoolean(row[field]) === wanted;
      }
      return terms(row, field).some((term) => term === value);
    };
    return operator === "!=" ? (row) => !equals(row) : equals;
  });

  return (row) => predicates.every((predicate) => predicate(row));
}

/** Fields referenced by `field<operator>value` clauses in the query. */
export function queryFields(query: string, fields: string[]): Set<string> {
  const lookup = fieldLookup(fields);
  const active = new Set<string>();
  for (const match of query.matchAll(CLAUSE_GLOBAL)) {
    const field = lookup.get(match[1].toLowerCase());
    if (field) {
      active.add(field);
    }
  }
  return active;
}

function clausePattern(field: string): RegExp {
  return new RegExp(
    `(^|\\s+AND\\s+)${escapeRegExp(field)}\\s*(?:${OPERATOR})\\s*("[^"]*"|\\S+)`,
    "i",
  );
}

export function formatClause(field: string, operator: string, value: string): string {
  return `${field}${operator}${/\s/.test(value) ? `"${value}"` : value}`;
}

/** Value of the existing clause for `field`, lower-cased and unquoted. */
export function clauseValue(query: string, field: string): string | null {
  const match = query.match(clausePattern(field));
  return match ? unquote(match[2]).toLowerCase() : null;
}

/** Adds, replaces, or (with `clause = null`) removes the clause for `field`. */
export function setClause(query: string, field: string, clause: string | null): string {
  const current = query.trim();
  const pattern = clausePattern(field);

  if (clause === null) {
    return current
      .replace(pattern, "")
      .replace(/^\s*AND\s+/i, "")
      .replace(/\s+AND\s*$/i, "")
      .trim();
  }
  if (!current) {
    return clause;
  }
  if (pattern.test(current)) {
    return current.replace(pattern, (_match, prefix: string) => `${prefix}${clause}`);
  }
  return `${current} AND ${clause}`;
}
