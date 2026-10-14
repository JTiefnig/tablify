// Timestamp parsing to epoch milliseconds, for sorting and the time filter. The
// displayed value is always the original string.
//
// Shapes: ISO 8601 (`,` or `.` fractions), syslog `MMM d HH:mm:ss` (no year, no
// zone), CLF `dd/MMM/yyyy:HH:mm:ss Z`, Apache `EEE MMM dd HH:mm:ss.SSSSSS yyyy`,
// `yyyy/MM/dd HH:mm:ss`, and Unix epoch (s / ms). Without a zone, local time.

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
const SLASH = /^(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?$/;
const SYSLOG = /^([A-Za-z]{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/;
const CLF = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?(?: ([+-]\d{2}:?\d{2}))?$/;
const APACHE = /^[A-Za-z]{3} ([A-Za-z]{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))? (\d{4})$/;
const EPOCH = /^\d{1,13}(?:\.\d+)?$/;

/** Time zone offset in minutes: "Z", "+02:00", "+0200", "+02". */
function offsetMinutes(zone: string): number {
  if (zone === "Z" || zone === "z") return 0;
  const sign = zone[0] === "-" ? -1 : 1;
  const digits = zone.slice(1).replace(":", "");
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || 0));
}

function millis(fraction: string | undefined): number {
  return fraction ? Number(fraction.slice(0, 3).padEnd(3, "0")) : 0;
}

function build(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  zone: string | undefined,
): number | undefined {
  if (month < 0 || month > 11 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) {
    return undefined;
  }
  if (zone === undefined) {
    return new Date(year, month, day, hour, minute, second, ms).getTime();
  }
  return Date.UTC(year, month, day, hour, minute, second, ms) - offsetMinutes(zone) * 60_000;
}

function month(name: string): number {
  return MONTHS[name.toLowerCase()] ?? -1;
}

export interface TimestampContext {
  /** The file's modification time: supplies the year for syslog timestamps. */
  reference: Date;
}

type ShapeParser = (text: string, context: TimestampContext) => number | undefined;

const SHAPES: ShapeParser[] = [
  (text) => {
    const m = ISO.exec(text);
    return m ? build(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0), millis(m[7]), m[8]) : undefined;
  },
  (text, { reference }) => {
    const m = SYSLOG.exec(text);
    if (!m) return undefined;
    const index = month(m[1]);
    // No year: the file's year, or the previous one for months later than the file.
    const year = index > reference.getMonth() + 1 ? reference.getFullYear() - 1 : reference.getFullYear();
    return build(year, index, +m[2], +m[3], +m[4], +m[5], millis(m[6]), undefined);
  },
  (text) => {
    const m = CLF.exec(text);
    return m ? build(+m[3], month(m[2]), +m[1], +m[4], +m[5], +m[6], millis(m[7]), m[8]) : undefined;
  },
  (text) => {
    const m = APACHE.exec(text);
    return m ? build(+m[7], month(m[1]), +m[2], +m[3], +m[4], +m[5], millis(m[6]), undefined) : undefined;
  },
  (text) => {
    const m = SLASH.exec(text);
    return m ? build(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], millis(m[7]), undefined) : undefined;
  },
  (text) => (EPOCH.test(text) ? epoch(Number(text)) : undefined),
];

/** Unix epoch in seconds or milliseconds (values from 1e11 on are milliseconds). Fractions are kept. */
function epoch(value: number): number | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value >= 1e11 ? value : value * 1000;
}

/**
 * Parses timestamps of any known shape. Remembers the shape that matched last
 * and tries it first, since a file uses the same shape throughout.
 */
export class TimestampParser {
  private last = 0;
  private readonly context: TimestampContext;

  constructor(context: TimestampContext) {
    this.context = context;
  }

  parse(value: unknown): number | undefined {
    if (typeof value === "number") return epoch(value);
    if (typeof value !== "string") return undefined;
    const text = value.trim();
    if (!text) return undefined;
    const first = SHAPES[this.last](text, this.context);
    if (first !== undefined && !Number.isNaN(first)) return first;
    for (let i = 0; i < SHAPES.length; i++) {
      if (i === this.last) continue;
      const result = SHAPES[i](text, this.context);
      if (result !== undefined && !Number.isNaN(result)) {
        this.last = i;
        return result;
      }
    }
    return undefined;
  }
}

/** Timestamp shapes at the start of a line (for the plain-text fallback). */
export const LEADING_TIMESTAMP = new RegExp(
  [
    String.raw`\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d{1,9})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?`,
    String.raw`\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?`,
    String.raw`[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}(?:\.\d{1,9})?`,
    String.raw`\[\d{2}\/[A-Za-z]{3}\/\d{4}:\d{2}:\d{2}:\d{2}(?: [+-]\d{4})?\]`,
    String.raw`\[[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}(?:\.\d{1,9})? \d{4}\]`,
  ]
    .map((shape) => `(?:${shape})`)
    .join("|")
    .replace(/^/, "^(")
    .replace(/$/, ")"),
);
