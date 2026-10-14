// Severity normalization: raw level values -> canonical levels.

import type { CanonicalLevel } from "./types.ts";

const NAMES: Record<string, CanonicalLevel> = {
  trace: "trace",
  finest: "trace",
  finer: "trace",
  debug: "debug",
  fine: "debug",
  verbose: "debug",
  dbg: "debug",
  info: "info",
  information: "info",
  informational: "info",
  notice: "info",
  warn: "warn",
  warning: "warn",
  error: "error",
  err: "error",
  severe: "error",
  fatal: "fatal",
  critical: "fatal",
  crit: "fatal",
  alert: "fatal",
  emerg: "fatal",
  emergency: "fatal",
  panic: "fatal",
  // Single letters (logcat style, common in embedded traces).
  t: "trace",
  v: "debug",
  d: "debug",
  i: "info",
  w: "warn",
  e: "error",
  f: "fatal",
};

/** Syslog severity 0–7. */
export function syslogSeverityLevel(severity: number): CanonicalLevel | undefined {
  if (!Number.isInteger(severity) || severity < 0 || severity > 7) return undefined;
  if (severity <= 2) return "fatal";
  if (severity === 3) return "error";
  if (severity === 4) return "warn";
  if (severity <= 6) return "info";
  return "debug";
}

/** Numeric levels: pino / bunyan (10 trace … 60 fatal); 0–7 are syslog severities. */
function numericLevel(value: number): CanonicalLevel | undefined {
  if (!Number.isFinite(value)) return undefined;
  if (value < 10) return syslogSeverityLevel(value);
  if (value < 20) return "trace";
  if (value < 30) return "debug";
  if (value < 40) return "info";
  if (value < 50) return "warn";
  if (value < 60) return "error";
  return "fatal";
}

export function normalizeLevel(value: unknown): CanonicalLevel | undefined {
  if (typeof value === "number") return numericLevel(value);
  if (typeof value !== "string") return undefined;
  const text = value.trim().toLowerCase();
  const named = NAMES[text];
  if (named) return named;
  // Apache 2.4: trace1 … trace8.
  if (/^trace[1-8]$/.test(text)) return "trace";
  if (/^\d+$/.test(text)) return numericLevel(Number(text));
  return undefined;
}
