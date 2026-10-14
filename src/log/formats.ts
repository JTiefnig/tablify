// Built-in log formats, and validation of user-defined ones. Adding a format
// never needs new parsing code: a regex with named groups plus roles is enough.

import type { FieldRole, LogFormat } from "./types.ts";

const SYSLOG_3164: LogFormat = {
  id: "syslog-3164",
  label: "Syslog RFC 3164",
  kind: "regex",
  pattern: String.raw`^(?:<(?<pri>\d{1,3})>)?(?<timestamp>[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T\S+) (?<host>\S+) (?<app>[^:\[\s]+)(?:\[(?<pid>\d+)\])?: ?(?<message>.*)$`,
  roles: { timestamp: "timestamp", host: "source", app: "source", message: "message" },
  timestampFormat: "MMM d HH:mm:ss",
  multiline: true,
  postProcess: ["syslog-pri"],
};

const SYSLOG_5424: LogFormat = {
  id: "syslog-5424",
  label: "Syslog RFC 5424",
  kind: "regex",
  pattern: String.raw`^<(?<pri>\d{1,3})>(?<version>\d{1,2}) (?<timestamp>\S+) (?<host>\S+) (?<app>\S+) (?<procid>\S+) (?<msgid>\S+) (?<sd>-|(?:\[(?:[^\]\\"]|\\.|"(?:[^"\\]|\\.)*")*\])+)(?: (?<message>.*))?$`,
  roles: { timestamp: "timestamp", host: "source", app: "source", message: "message" },
  timestampFormat: "ISO 8601",
  multiline: true,
  postProcess: ["nil-dash", "syslog-pri", "sd-params"],
};

const CLF: LogFormat = {
  id: "clf",
  label: "Access Log (Common / Combined)",
  kind: "regex",
  pattern: String.raw`^(?<client>\S+) (?<ident>\S+) (?<user>\S+) \[(?<timestamp>[^\]]+)\] "(?<request>(?:[^"\\]|\\.)*)" (?<status>\d{3}) (?<bytes>\d+|-)(?: "(?<referer>(?:[^"\\]|\\.)*)" "(?<userAgent>(?:[^"\\]|\\.)*)")?.*$`,
  roles: { timestamp: "timestamp", client: "source" },
  timestampFormat: "dd/MMM/yyyy:HH:mm:ss Z",
  multiline: false,
  postProcess: ["split-http-request", "status-level"],
};

const NGINX_ERROR: LogFormat = {
  id: "nginx-error",
  label: "Nginx Error Log",
  kind: "regex",
  pattern: String.raw`^(?<timestamp>\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}) \[(?<level>\w+)\] (?<pid>\d+)#(?<tid>\d+): (?:\*(?<connection>\d+) )?(?<message>.*)$`,
  roles: { timestamp: "timestamp", level: "level", message: "message" },
  timestampFormat: "yyyy/MM/dd HH:mm:ss",
  multiline: true,
};

const APACHE_ERROR: LogFormat = {
  id: "apache-error",
  label: "Apache Error Log",
  kind: "regex",
  pattern: String.raw`^\[(?<timestamp>[^\]]+)\] \[(?:(?<module>[^:\]]*):)?(?<level>\w+)\] \[pid (?<pid>\d+)(?::tid (?<tid>\d+))?\] (?:\[client (?<client>[^\]]+)\] )?(?<message>.*)$`,
  roles: { timestamp: "timestamp", level: "level", module: "source", message: "message" },
  timestampFormat: "EEE MMM dd HH:mm:ss.SSSSSS yyyy",
  multiline: true,
};

const GENERIC_APP: LogFormat = {
  id: "generic-app",
  label: "Application Log (Log4j / Logback / Serilog)",
  kind: "regex",
  pattern: String.raw`^(?<timestamp>\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)\s+(?:\[\s*)?(?<level>TRACE|DEBUG|INFO|NOTICE|WARN(?:ING)?|ERROR|SEVERE|FATAL|CRITICAL)(?:\s*\])?\s+(?:\[(?<thread>[^\]]+)\]\s+)?(?:(?<logger>[\w.$]+)\s+[-:]\s+)?(?<message>.*)$`,
  roles: { timestamp: "timestamp", level: "level", logger: "source", message: "message" },
  timestampFormat: "ISO 8601",
  multiline: true,
};

const PYTHON: LogFormat = {
  id: "python",
  label: "Python logging",
  kind: "regex",
  pattern: String.raw`^(?<timestamp>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3}) - (?<logger>.+?) - (?<level>[A-Z]+) - (?<message>.*)$`,
  roles: { timestamp: "timestamp", level: "level", logger: "source", message: "message" },
  timestampFormat: "yyyy-MM-dd HH:mm:ss,SSS",
  multiline: true,
};

const JSONL: LogFormat = { id: "jsonl", label: "JSON Lines", kind: "jsonl", multiline: false };
const LOGFMT: LogFormat = { id: "logfmt", label: "logfmt", kind: "logfmt", multiline: false };

/** Fallback when no format reaches the detection threshold. */
export const PLAIN: LogFormat = { id: "plain", label: "Plain Text", kind: "plain", multiline: true };

/** Built-in formats, most specific first (the detection tie-break order). */
export const BUILTIN_FORMATS: readonly LogFormat[] = [
  JSONL,
  SYSLOG_5424,
  NGINX_ERROR,
  APACHE_ERROR,
  CLF,
  SYSLOG_3164,
  PYTHON,
  GENERIC_APP,
  LOGFMT,
];

/** Role of a JSON Lines / logfmt key, by name (case-insensitive), in order of preference. */
export const KEY_ROLES: Record<Exclude<FieldRole, "none">, string[]> = {
  timestamp: ["@timestamp", "timestamp", "time", "ts", "t", "datetime", "asctime"],
  level: ["level", "lvl", "severity", "levelname", "log.level"],
  message: ["message", "msg", "@message", "text"],
  source: ["logger", "service", "component", "module", "name"],
};

/** Names of a regex's named groups, in pattern order. */
export function groupNames(pattern: string): string[] {
  return [...pattern.matchAll(/\(\?<([A-Za-z_$][\w$]*)>/g)].map((match) => match[1]);
}

const ROLES: readonly FieldRole[] = ["timestamp", "level", "message", "source", "none"];

export interface CustomFormatsResult {
  formats: LogFormat[];
  /** One message per skipped definition. */
  errors: string[];
}

/**
 * Validates `tablify.log.customFormats`. Invalid regexes, missing named groups
 * and other problems skip the definition with an error message.
 */
export function parseCustomFormats(value: unknown): CustomFormatsResult {
  const formats: LogFormat[] = [];
  const errors: string[] = [];
  if (value === undefined || value === null) return { formats, errors };
  if (!Array.isArray(value)) return { formats, errors: ["customFormats must be a list."] };

  const ids = new Set(BUILTIN_FORMATS.map((format) => format.id).concat(PLAIN.id));
  value.forEach((entry: unknown, index) => {
    const where = `customFormats[${index}]`;
    if (typeof entry !== "object" || entry === null) {
      errors.push(`${where}: expected an object.`);
      return;
    }
    const raw = entry as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const name = id ? `"${id}"` : where;
    if (!id) {
      errors.push(`${where}: "id" is missing.`);
      return;
    }
    if (ids.has(id)) {
      errors.push(`${name}: the id is already used.`);
      return;
    }
    const kind = raw.kind ?? "regex";
    if (kind !== "regex" && kind !== "jsonl" && kind !== "logfmt") {
      errors.push(`${name}: unknown kind "${String(kind)}".`);
      return;
    }
    const format: LogFormat = {
      id,
      label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : id,
      kind,
      custom: true,
    };
    if (typeof raw.multiline === "boolean") format.multiline = raw.multiline;
    if (typeof raw.timestampFormat === "string") format.timestampFormat = raw.timestampFormat;
    if (Array.isArray(raw.postProcess)) {
      format.postProcess = raw.postProcess.filter((item): item is string => typeof item === "string");
    }

    if (kind === "regex") {
      if (typeof raw.pattern !== "string" || !raw.pattern) {
        errors.push(`${name}: "pattern" is missing.`);
        return;
      }
      try {
        new RegExp(raw.pattern);
      } catch (error) {
        errors.push(`${name}: invalid pattern (${error instanceof Error ? error.message : String(error)}).`);
        return;
      }
      const groups = groupNames(raw.pattern);
      if (groups.length === 0) {
        errors.push(`${name}: the pattern has no named groups, e.g. (?<message>.*).`);
        return;
      }
      format.pattern = raw.pattern;
      if (raw.roles !== undefined) {
        if (typeof raw.roles !== "object" || raw.roles === null || Array.isArray(raw.roles)) {
          errors.push(`${name}: "roles" must map group names to roles.`);
          return;
        }
        const roles: Record<string, FieldRole> = {};
        for (const [group, role] of Object.entries(raw.roles as Record<string, unknown>)) {
          if (!groups.includes(group)) {
            errors.push(`${name}: role for "${group}", which is not a named group of the pattern.`);
            return;
          }
          if (!ROLES.includes(role as FieldRole)) {
            errors.push(`${name}: unknown role "${String(role)}" for "${group}".`);
            return;
          }
          roles[group] = role as FieldRole;
        }
        format.roles = roles;
      }
    }
    ids.add(id);
    formats.push(format);
  });
  return { formats, errors };
}
