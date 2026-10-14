import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { candidateFormats, detectFormat } from "../src/log/detect.ts";
import { BUILTIN_FORMATS, parseCustomFormats, PLAIN } from "../src/log/formats.ts";
import { normalizeLevel } from "../src/log/levels.ts";
import { EMPTY_QUERY, type LogQuery } from "../src/log/messages.ts";
import { LogParser, parseLog, splitLines } from "../src/log/parse.ts";
import { excerpt, readHead, readTail } from "../src/log/read.ts";
import { LogStore, textMatcher } from "../src/log/store.ts";
import { TimestampParser } from "../src/log/timestamps.ts";
import type { LogFormat, LogRecord } from "../src/log/types.ts";

// Zone-less timestamps are local time: a fixed zone (with DST) keeps results and snapshots stable.
process.env.TZ = "Europe/Vienna";

const FIXTURES = join(import.meta.dirname, "fixtures", "logs");
const SNAPSHOTS = join(FIXTURES, "__snapshots__");
/** Reference "file modification time" for syslog timestamps without a year. */
const context = { reference: new Date(2027, 0, 5, 12, 0, 0) };

const fixture = (id: string) => readFileSync(join(FIXTURES, `${id}.log`), "utf8");
const format = (id: string): LogFormat => [...BUILTIN_FORMATS, PLAIN].find((candidate) => candidate.id === id)!;
const detect = (text: string, custom: LogFormat[] = []) => detectFormat(splitLines(text), candidateFormats(custom)).format.id;

function parse(id: string, text = fixture(id)) {
  return parseLog(text, format(id), context);
}

const field = (record: LogRecord, name: string) => record.fields[name];
const iso = (record: LogRecord) => (record.epochMs === undefined ? undefined : new Date(record.epochMs).toISOString());
const local = (...parts: number[]) => new Date(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5] ?? 0).getTime();

// --- Detection ---------------------------------------------------------------------------

const FIXTURE_IDS = readdirSync(FIXTURES)
  .filter((name) => name.endsWith(".log"))
  .map((name) => name.slice(0, -4));

test("fixtures: one per built-in format and the fallback", () => {
  assert.deepEqual(new Set(FIXTURE_IDS), new Set([...BUILTIN_FORMATS.map((item) => item.id), PLAIN.id]));
});

for (const id of FIXTURE_IDS) {
  test(`detect: ${id}.log detects as ${id}`, () => {
    assert.equal(detect(fixture(id)), id);
  });
}

test("detect: mixed or garbage input falls back to plain text without throwing", () => {
  assert.equal(detect(""), "plain");
  assert.equal(detect("\n\n\n"), "plain");
  assert.equal(detect("\u0000\u0001� binary \u0007 junk\n{not json\n<<<>>>\n"), "plain");
  const mixed = [fixture("clf"), fixture("python"), fixture("logfmt"), fixture("syslog-3164")].join("\n");
  assert.equal(detect(mixed), "plain");
});

test("detect: continuation lines do not count against multi-line formats", () => {
  const text = [
    "2026-10-14 10:37:02,123 ERROR [main] a.B - boom",
    ...Array.from({ length: 20 }, (_, i) => `\tat a.B.m${i}(B.java:${i})`),
    "Caused by: java.io.IOException",
    "\t... 3 more",
  ].join("\n");
  assert.equal(detect(text), "generic-app");
});

test("detect: threshold and sample size options", () => {
  const lines = splitLines(["ts=1 level=info msg=a", "ts=2 level=info msg=b", "free text", "more free text"].join("\n"));
  const formats = candidateFormats([]);
  assert.equal(detectFormat(lines, formats, { sampleLines: 200, threshold: 0.6 }).format.id, "plain");
  assert.equal(detectFormat(lines, formats, { sampleLines: 200, threshold: 0.5 }).format.id, "logfmt");
  assert.equal(detectFormat(lines, formats, { sampleLines: 2, threshold: 0.6 }).format.id, "logfmt");
});

test("detect: ties go to the more specific format; custom formats win ties", () => {
  // Matches both the rsyslog file format and the generic app pattern: syslog is listed first.
  const tie = "2026-10-14T10:37:02Z INFO app: started";
  assert.equal(detect(tie), "syslog-3164");
  const python = "2026-10-14 10:37:02,123 - orders - ERROR - Payment failed";
  assert.equal(detect(python), "python");
  const custom = parseCustomFormats([{ id: "mine", pattern: String.raw`^(?<timestamp>\S+ \S+) - (?<message>.*)$` }]).formats;
  assert.equal(detect(python, custom), "mine");
});

// --- Syslog RFC 3164 -------------------------------------------------------------------------

test("syslog-3164: fields, roles and column order", () => {
  const { records, columns } = parse("syslog-3164");
  assert.equal(records.length, 26);
  assert.deepEqual(
    columns.map((column) => `${column.name}:${column.role}`),
    ["timestamp:timestamp", "host:source", "app:source", "pri:none", "facility:none", "severity:none", "pid:none", "message:message"],
  );
  assert.deepEqual(records[4].fields, {
    timestamp: "Jan  1 00:03:17",
    host: "web01",
    app: "sshd",
    pid: "2341",
    message: "Accepted password for alice from 10.0.0.5 port 52211 ssh2",
  });
});

test("syslog-3164: single-digit day, no PID, no colon-space", () => {
  const { records } = parse("syslog-3164");
  assert.equal(field(records[7], "timestamp"), "Jan  1 00:05:44");
  assert.equal(field(records[7], "app"), "kernel");
  assert.equal(field(records[7], "pid"), undefined);
  assert.equal(field(records[13], "message"), "DHCPREQUEST for 10.0.0.12 on eth0 to 10.0.0.1 port 67");
  assert.equal(field(records[15], "app"), "avahi-daemon");
});

test("syslog-3164: year from the file's mtime, previous year for later months (Dec -> Jan rollover)", () => {
  const { records } = parse("syslog-3164");
  assert.equal(records[0].epochMs, local(2026, 11, 31, 23, 58, 1));
  assert.equal(records[2].epochMs, local(2027, 0, 1, 0, 0, 2));
  // The ISO variant (rsyslog file format) carries its own year and zone.
  assert.equal(iso(records[24]), "2026-01-04T09:03:00.123Z");
  // February is only one month after the January mtime: still this year.
  const parser = new TimestampParser(context);
  assert.equal(parser.parse("Feb  3 10:00:00"), local(2027, 1, 3, 10, 0, 0));
  assert.equal(parser.parse("Mar  3 10:00:00"), local(2026, 2, 3, 10, 0, 0));
});

test("syslog-3164: syslog-pri enricher", () => {
  const { records } = parse("syslog-3164");
  assert.equal(records[22].fields.facility, 3);
  assert.equal(records[22].fields.severity, 6);
  assert.equal(records[22].level, "info");
  assert.equal(records[23].level, "error");
  assert.equal(records[0].level, undefined);
});

// --- Syslog RFC 5424 -------------------------------------------------------------------------

test("syslog-5424: nil fields render as empty", () => {
  const { records } = parse("syslog-5424");
  assert.equal(records[3].fields.msgid, null);
  assert.equal(records[3].fields.sd, null);
  assert.equal(records[11].fields.timestamp, null);
  assert.equal(records[11].epochMs, undefined);
  assert.deepEqual(
    ["host", "app", "procid", "msgid", "sd"].map((name) => records[12].fields[name]),
    [null, null, null, null, null],
  );
});

test("syslog-5424: structured data, multiple elements, escapes", () => {
  const { records, columns } = parse("syslog-5424");
  assert.equal(records[2].fields["sd.examplePriority@32473.class"], "high");
  assert.equal(records[2].fields["sd.exampleSDID@32473.eventID"], "1011");
  assert.equal(records[2].fields.message, undefined);
  assert.equal(records[10].fields["sd.audit.cmd"], '/usr/bin/apt "update"');
  assert.equal(records[10].fields["sd.audit.note"], "bracket ] inside");
  assert.equal(records[10].fields.message, "alice : TTY=pts/0 ; COMMAND=/usr/bin/apt update");
  assert.equal(columns.at(-1)?.name, "message");
});

test("syslog-5424: level from PRI, timestamp with offset", () => {
  const { records } = parse("syslog-5424");
  assert.deepEqual(
    records.slice(3, 10).map((record) => record.level),
    ["info", "error", "warn", "info", "debug", "fatal", "fatal"],
  );
  assert.equal(iso(records[0]), "2026-10-14T08:37:02.123Z");
});

// --- Access logs --------------------------------------------------------------------------------

test("clf: request split, '-' bytes, escaped quotes, IPv6 client", () => {
  const { records, columns } = parse("clf");
  assert.equal(records.length, 22);
  assert.deepEqual(
    [records[0].fields.method, records[0].fields.path, records[0].fields.protocol],
    ["GET", "/index.html", "HTTP/1.1"],
  );
  assert.equal(records[2].fields.bytes, "-");
  assert.equal(records[10].fields.userAgent, String.raw`Mozilla/5.0 \"quoted agent\" Test/1.0`);
  assert.equal(records[5].fields.client, "2001:db8::1");
  assert.equal(records[18].fields.referer, undefined);
  assert.equal(columns.find((column) => column.name === "request")?.superseded, true);
  assert.equal(columns.find((column) => column.name === "ident")?.nonEmpty, 0);
});

test("clf: pseudo-level from status, CLF timestamp, non-matching lines flagged", () => {
  const { records } = parse("clf");
  assert.deepEqual(
    [records[0], records[3], records[8], records[2]].map((record) => record.level),
    ["info", "warn", "error", "info"],
  );
  assert.equal(iso(records[0]), "2026-10-14T08:37:02.000Z");
  assert.equal(records[20].parseError, true);
  assert.equal(records[20].fields.message, "this line is not an access log entry");
  assert.equal(records[21].lineStart, 21);
});

// --- Error logs ---------------------------------------------------------------------------------

test("nginx-error: fields, levels and multi-line messages", () => {
  const { records } = parse("nginx-error");
  assert.equal(records.length, 18);
  assert.equal(records[4].fields.connection, "56");
  assert.equal(records[0].fields.connection, undefined);
  assert.deepEqual(
    records.slice(9, 14).map((record) => record.level),
    ["fatal", "fatal", "info", "fatal", "debug"],
  );
  assert.equal(records[15].lineStart, 15);
  assert.equal(records[15].lineEnd, 18);
  assert.match(String(records[15].fields.message), /boom in \/var\/www\/index.php:12\nStack trace:\n#0 \{main\}\n {2}thrown/);
});

test("apache-error: module, client, empty module name, Python traceback", () => {
  const { records } = parse("apache-error");
  assert.equal(records.length, 18);
  assert.equal(records[2].fields.module, "core");
  assert.equal(records[2].fields.client, "10.0.0.5:52211");
  assert.equal(records[9].fields.tid, undefined);
  assert.equal(records[11].fields.module, "");
  assert.equal(records[11].level, "error");
  assert.equal(records[12].lineEnd - records[12].lineStart, 3);
  assert.equal(iso(records[0]), "2026-10-14T08:37:02.123Z");
});

// --- Application logs --------------------------------------------------------------------------

test("generic-app: lines before the first record, stack traces, Caused by chains", () => {
  const { records, columns } = parse("generic-app");
  assert.deepEqual(
    columns.map((column) => column.name),
    ["timestamp", "level", "logger", "thread", "message"],
  );
  assert.equal(records[0].parseError, true);
  assert.equal(records[0].lineEnd, 2);
  assert.match(String(records[0].fields.message), /^Picked up JAVA_TOOL_OPTIONS/);
  const error = records[4];
  assert.equal(error.level, "error");
  assert.equal(error.fields.logger, "com.example.OrderService");
  assert.equal(error.lineStart, 6);
  assert.equal(error.lineEnd, 15);
  const message = String(error.fields.message).split("\n");
  assert.equal(message[0], "Payment failed");
  assert.equal(message.length, 10);
  assert.ok(message.includes("Caused by: java.net.ConnectException: Connection refused"));
  assert.ok(error.raw.startsWith("2026-10-14 10:37:02,123 ERROR"));
});

test("generic-app: level and timestamp variants", () => {
  const { records } = parse("generic-app");
  const byLine = (line: number) => records.find((record) => record.lineStart === line)!;
  assert.equal(iso(byLine(17)), "2026-10-14T10:37:03.000Z");
  assert.equal(iso(byLine(18)), "2026-10-14T08:37:03.500Z");
  assert.equal(byLine(18).fields.level, "INFO");
  assert.equal(byLine(19).level, "warn");
  assert.equal(byLine(20).level, "error");
  // The blank line after the SEVERE entry is not part of it.
  assert.equal(byLine(20).lineEnd, 20);
  assert.equal(byLine(23).fields.thread, undefined);
  assert.equal(byLine(23).fields.logger, undefined);
  assert.equal(byLine(25).level, "fatal");
});

test("python: logger, levels, traceback", () => {
  const { records } = parse("python");
  assert.equal(records.length, 14);
  assert.equal(records[3].fields.logger, "orders.payment");
  assert.equal(records[3].lineEnd, 9);
  assert.match(String(records[3].fields.message), /\nhttpx.ConnectError: \[Errno 111\] Connection refused$/);
  assert.equal(records[6].level, "fatal");
  assert.equal(records[10].fields.message, "Deadlock detected - retrying transaction");
});

// --- JSON Lines / logfmt ------------------------------------------------------------------------

test("jsonl: heterogeneous keys, roles by name, union of columns", () => {
  const { records, columns } = parse("jsonl");
  assert.equal(records.length, 22);
  assert.deepEqual(
    columns.filter((column) => column.role !== "none").map((column) => `${column.name}:${column.role}`),
    [
      "time:timestamp",
      "@timestamp:timestamp",
      "timestamp:timestamp",
      "ts:timestamp",
      "asctime:timestamp",
      "t:timestamp",
      "datetime:timestamp",
      "level:level",
      "log.level:level",
      "severity:level",
      "lvl:level",
      "levelname:level",
      "name:source",
      "logger:source",
      "component:source",
      "module:source",
      "msg:message",
      "message:message",
      "text:message",
    ],
  );
  assert.ok(records.every((record) => record.parseError || (record.level && record.epochMs !== undefined)));
  assert.equal(records[7].level, "error");
  assert.equal(iso(records[7]), "2026-10-14T08:37:08.000Z");
});

test("jsonl: numeric levels, epoch seconds and milliseconds", () => {
  const { records } = parse("jsonl");
  assert.deepEqual(
    records.slice(0, 5).map((record) => record.level),
    ["info", "debug", "warn", "error", "fatal"],
  );
  assert.equal(records[0].epochMs, 1792046222123);
  assert.equal(records[8].epochMs, 1792046229000);
});

test("jsonl: nested objects flattened to depth 2, deeper values as JSON", () => {
  const { records } = parse("jsonl");
  assert.equal(records[1].fields["pool.size"], 5);
  assert.equal(records[2].fields["query.sql"], "SELECT * FROM orders");
  assert.equal(records[2].fields["query.params"], '{"limit":1000}');
  assert.equal(records[5].fields.tags, '["a","b"]');
  assert.equal(records[6].fields["log.level"], "warn");
  assert.equal(records[7].fields.ok, "false");
  assert.equal(records[10].fields.extra, null);
});

test("jsonl: malformed lines become flagged records", () => {
  const { records } = parse("jsonl");
  assert.equal(records[9].parseError, true);
  assert.equal(records[9].fields.message, "not json at all");
  assert.equal(records[11].parseError, true);
  assert.equal(records[12].level, "trace");
});

test("logfmt: quoted values, escapes, empty values, roles", () => {
  const { records, columns } = parse("logfmt");
  assert.equal(records.length, 22);
  assert.equal(columns[0].name, "ts");
  assert.equal(columns.at(-1)?.name, "msg");
  assert.equal(records[2].fields.err, "connection refused");
  assert.equal(records[6].fields.msg, 'quoted "value" inside');
  assert.equal(records[8].fields.msg, "");
  assert.equal(records[7].level, "fatal");
  assert.equal(iso(records[0]), "2026-10-14T10:37:02.000Z");
});

// --- Plain text fallback ------------------------------------------------------------------------

test("plain: leading timestamp and level keyword when present", () => {
  const text = [
    "2026-10-14 10:37:02 ERROR something broke",
    "  at frame one",
    "[14/Oct/2026:10:37:03 +0200] [warn] slow",
    "no timestamp here, INFO in the middle",
    "trailing text without anything",
  ].join("\n");
  const { records, columns } = parse("plain", text);
  assert.deepEqual(
    columns.map((column) => column.name),
    ["timestamp", "level", "message"],
  );
  assert.equal(records.length, 4);
  assert.deepEqual(records[0].fields, { timestamp: "2026-10-14 10:37:02", level: "ERROR", message: "something broke\n  at frame one" });
  assert.equal(records[0].lineEnd, 1);
  assert.equal(records[1].fields.timestamp, "14/Oct/2026:10:37:03 +0200");
  assert.equal(records[1].level, "warn");
  assert.equal(iso(records[1]), "2026-10-14T08:37:03.000Z");
  assert.equal(records[2].level, "info");
  assert.equal(records[3].fields.message, "trailing text without anything");
});

test("plain: one record per line, never fails", () => {
  const { records } = parse("plain");
  assert.equal(records.length, 20);
  assert.equal(records[2].level, "warn");
  assert.equal(records[19].lineStart, 19);
  assert.deepEqual(parse("plain", "").records, []);
  assert.equal(parse("plain", "\u0000\u0001\n\r\n\n x").records.length, 2);
});

// --- Splitting ------------------------------------------------------------------------------------

test("splitting: CRLF, streaming chunks give the same records as one pass", () => {
  const text = fixture("generic-app").replace(/\n/g, "\r\n");
  const whole = parseLog(text, format("generic-app"), context);
  assert.ok(whole.records.every((record) => !record.raw.includes("\r")));
  const lines = splitLines(text);
  const parser = new LogParser(format("generic-app"), context);
  for (let start = 0; start < lines.length; start += 3) parser.feed(lines, start, Math.min(lines.length, start + 3));
  parser.finish();
  assert.deepEqual(parser.records, whole.records);
});

test("splitting: a byte order mark is not part of the first line", () => {
  assert.deepEqual(splitLines("\ufeffa\nb\n"), ["a", "b"]);
});

test("splitting: line offset for excerpts", () => {
  const parser = new LogParser(format("python"), context);
  parser.feed(splitLines(fixture("python")), 0, 3, 1000);
  parser.finish();
  assert.deepEqual(
    parser.records.map((record) => record.lineStart),
    [1000, 1001, 1002],
  );
});

test("splitting: very long lines are matched truncated, the message keeps the full text", () => {
  const long = "x".repeat(100_000);
  const { records } = parseLog(`2026-10-14 10:37:02,123 INFO [main] a.B - ${long}\n`, format("generic-app"), context);
  assert.equal(records.length, 1);
  assert.equal(String(records[0].fields.message).length, long.length);
});

test("excerpt: first and last lines, with the starting line number", () => {
  const text = "a\nb\nc\nd\ne\n";
  assert.deepEqual(excerpt(text, "head", 2), { text: "a\nb\n", firstLine: 0 });
  assert.deepEqual(excerpt(text, "tail", 2), { text: "d\ne\n", firstLine: 3 });
  assert.deepEqual(excerpt("a\nb", "tail", 1), { text: "b", firstLine: 1 });
  assert.deepEqual(excerpt(text, "tail", 10), { text, firstLine: 0 });
});

test("readHead / readTail: lines of a file larger than one read chunk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tablify-log-"));
  try {
    const path = join(dir, "big.log");
    const lines = Array.from({ length: 300_000 }, (_, i) => `line ${i} ${"ü".repeat(i % 5)}`);
    writeFileSync(path, `${lines.join("\n")}\n`);
    const head = await readHead(path, 1000);
    assert.equal(head.firstLine, 0);
    assert.deepEqual(splitLines(head.text), lines.slice(0, 1000));
    const tail = await readTail(path, 1000);
    assert.equal(tail.firstLine, 299_000);
    assert.deepEqual(splitLines(tail.text), lines.slice(-1000));
    // Without a trailing newline, and asking for more lines than there are.
    writeFileSync(path, "a\nb\nc");
    assert.deepEqual(await readTail(path, 2), { text: "b\nc", firstLine: 1 });
    assert.deepEqual(await readTail(path, 10), { text: "a\nb\nc", firstLine: 0 });
    assert.deepEqual(await readHead(path, 10), { text: "a\nb\nc", firstLine: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Normalization --------------------------------------------------------------------------------

test("levels: canonical mapping", () => {
  const cases: Record<string, string | undefined> = {
    TRACE: "trace", finest: "trace", finer: "trace",
    Debug: "debug", fine: "debug", verbose: "debug", dbg: "debug",
    info: "info", Information: "info", notice: "info", informational: "info",
    warn: "warn", WARNING: "warn",
    error: "error", err: "error", severe: "error",
    fatal: "fatal", critical: "fatal", crit: "fatal", alert: "fatal", emerg: "fatal", emergency: "fatal", panic: "fatal",
    E: "error", W: "warn", trace3: "trace", trace8: "trace",
    nonsense: undefined,
  };
  for (const [raw, expected] of Object.entries(cases)) assert.equal(normalizeLevel(raw), expected, raw);
  assert.equal(normalizeLevel(10), "trace");
  assert.equal(normalizeLevel(35), "info");
  assert.equal(normalizeLevel("50"), "error");
  assert.equal(normalizeLevel(60), "fatal");
});

test("timestamps: supported shapes", () => {
  const parser = new TimestampParser(context);
  const utc = (text: string) => {
    const value = parser.parse(text);
    return value === undefined ? undefined : new Date(value).toISOString();
  };
  assert.equal(utc("2026-10-14T10:37:02Z"), "2026-10-14T10:37:02.000Z");
  assert.equal(utc("2026-10-14T10:37:02.123456+02:00"), "2026-10-14T08:37:02.123Z");
  assert.equal(utc("2026-10-14 10:37:02,5+0200"), "2026-10-14T08:37:02.500Z");
  assert.equal(utc("14/Oct/2026:10:37:02 -0500"), "2026-10-14T15:37:02.000Z");
  assert.equal(parser.parse("2026-10-14 10:37:02,123"), local(2026, 9, 14, 10, 37, 2) + 123);
  assert.equal(parser.parse("Wed Oct 14 10:37:02.123456 2026"), local(2026, 9, 14, 10, 37, 2) + 123);
  assert.equal(parser.parse("2026/10/14 10:37:02"), local(2026, 9, 14, 10, 37, 2));
  assert.equal(parser.parse("1792046222"), 1792046222000);
  assert.equal(parser.parse(1792046222123), 1792046222123);
  assert.equal(parser.parse("not a time"), undefined);
  assert.equal(parser.parse("2026-13-40T99:00:00Z"), undefined);
  assert.equal(parser.parse(""), undefined);
});

// --- Custom formats -------------------------------------------------------------------------------

test("custom formats: valid definitions take part in detection and parse", () => {
  const { formats, errors } = parseCustomFormats([
    {
      id: "my-ecu-trace",
      label: "ECU trace",
      pattern: String.raw`^(?<timestamp>\d+\.\d+)\s+(?<channel>\w+)\s+(?<level>[A-Z])\s+(?<message>.*)$`,
      roles: { timestamp: "timestamp", level: "level", channel: "source", message: "message" },
      multiline: false,
    },
  ]);
  assert.deepEqual(errors, []);
  const text = ["12.000100 CAN0 I Wakeup", "12.000200 CAN1 E Bus off", "12.000300 LIN0 W Timeout"].join("\n");
  assert.equal(detect(text, formats), "my-ecu-trace");
  const { records, columns } = parseLog(text, formats[0], context);
  assert.deepEqual(
    columns.map((column) => `${column.name}:${column.role}`),
    ["timestamp:timestamp", "level:level", "channel:source", "message:message"],
  );
  assert.deepEqual(
    records.map((record) => record.level),
    ["info", "error", "warn"],
  );
  assert.ok(records[0].epochMs! < records[1].epochMs!);
});

test("custom formats: invalid definitions are reported and skipped", () => {
  const { formats, errors } = parseCustomFormats([
    { id: "bad-regex", pattern: "^(?<a>unclosed" },
    { id: "no-groups", pattern: "^(\\d+) (.*)$" },
    { id: "bad-role", pattern: "^(?<a>.*)$", roles: { b: "message" } },
    { id: "unknown-role", pattern: "^(?<a>.*)$", roles: { a: "body" } },
    { pattern: "^(?<a>.*)$" },
    { id: "clf", pattern: "^(?<a>.*)$" },
    "not an object",
    { id: "ok", pattern: "^(?<message>.*)$" },
    { id: "ok", pattern: "^(?<message>.*)$" },
  ]);
  assert.deepEqual(
    formats.map((item) => item.id),
    ["ok"],
  );
  assert.equal(errors.length, 8);
  assert.match(errors[0], /"bad-regex": invalid pattern/);
  assert.match(errors[1], /no named groups/);
  assert.match(errors[2], /"b", which is not a named group/);
  assert.match(errors[3], /unknown role "body"/);
  assert.deepEqual(parseCustomFormats(undefined), { formats: [], errors: [] });
  assert.equal(parseCustomFormats({}).errors.length, 1);
});

// --- Store: filtering, sorting, windows -----------------------------------------------------------

function store(id: string, query: Partial<LogQuery> = {}) {
  const parser = new LogParser(format(id), context);
  parser.feed(splitLines(fixture(id)));
  parser.finish();
  const result = new LogStore({ ...EMPTY_QUERY, ...query }, (record) => parser.messageKey(record));
  result.reset(parser.records, (record) => parser.messageKey(record));
  const timestamps = new Set(parser.columns().filter((column) => column.role === "timestamp").map((column) => column.name));
  result.sort(timestamps);
  return { store: result, records: parser.records, columns: parser.columns() };
}

test("store: level filter with counts per level", () => {
  const { store: all } = store("python");
  assert.equal(all.view.length, 14);
  assert.deepEqual(all.levelCounts, { info: 6, debug: 3, error: 2, warn: 2, fatal: 1 });
  const { store: errors } = store("python", { levels: ["error", "fatal"] });
  assert.equal(errors.view.length, 3);
  // Counts ignore the level filter itself.
  assert.deepEqual(errors.levelCounts, all.levelCounts);
});

test("store: text search over the message, all fields, regex", () => {
  assert.equal(store("python", { text: "payment" }).store.view.length, 2);
  assert.equal(store("python", { text: "PAYMENT" }).store.view.length, 2);
  // The logger is not part of the message...
  assert.equal(store("python", { text: "orders.payment" }).store.view.length, 0);
  // ...but of the whole entry.
  assert.equal(store("python", { text: "orders.payment", allFields: true }).store.view.length, 3);
  assert.equal(store("python", { text: "/^(GET|POST) /" }).store.view.length, 2);
  // Continuation lines are part of the message.
  assert.equal(store("python", { text: "ConnectError" }).store.view.length, 1);
  const invalid = store("python", { text: "/(unclosed/" }).store;
  assert.ok(invalid.queryError);
  assert.equal(invalid.view.length, 14);
  assert.equal(textMatcher("  ").match, null);
});

test("store: time range hides entries outside it and without a timestamp", () => {
  const from = Date.parse("2026-10-14T08:37:05Z");
  const to = Date.parse("2026-10-14T08:37:10Z");
  const { store: ranged, records } = store("clf", { from, to });
  assert.ok(ranged.view.every((index) => records[index].epochMs! >= from && records[index].epochMs! <= to));
  assert.equal(ranged.view.length, 5);
  assert.deepEqual(store("clf").store.timeRange, {
    min: Date.parse("2026-10-14T08:37:02Z"),
    max: Date.parse("2026-10-14T08:37:23Z"),
  });
});

test("store: sorting by time, numbers and text; missing values last", () => {
  const { store: byTime, records } = store("jsonl", { sort: { column: "time", descending: true } });
  const times = byTime.view.map((index) => records[index].epochMs);
  const known = times.filter((time) => time !== undefined) as number[];
  assert.deepEqual(known, [...known].sort((a, b) => b - a));
  assert.deepEqual(times.slice(-2), [undefined, undefined]);

  const { store: byStatus, records: clf } = store("clf", { sort: { column: "status", descending: false } });
  const statuses = byStatus.view.map((index) => clf[index].fields.status);
  assert.equal(statuses[0], "200");
  assert.equal(statuses.at(-1), undefined); // the line that does not match
  assert.deepEqual(statuses.slice(-4, -1), ["502", "503", "500"].sort());

  const { store: byPath, records: paths } = store("clf", { sort: { column: "path", descending: false } });
  assert.equal(paths[byPath.view[0]].fields.path, "/admin");
});

test("store: windows carry first-line cell text by column key", () => {
  const { store: result, columns } = store("generic-app");
  const info = columns.map(({ name, key, role }) => ({ name, key, role, hiddenByDefault: false }));
  const [leading, , , , error] = result.window(0, 5, info);
  const message = columns.find((column) => column.name === "message")!.key;
  assert.equal(leading.error, true);
  assert.equal(error.level, "error");
  assert.equal(error.line, 7);
  assert.equal(error.lines, 10);
  assert.equal(error.values[message], "Payment failed");
  assert.equal(result.window(1000, 10, info).length, 0);
  const detail = result.detail(4, info)!;
  assert.equal(detail.messageField, "message");
  assert.match(detail.fields.find((item) => item.name === "message")!.value, /Caused by/);
});

test("store: incremental updates while loading match a full pass", () => {
  const lines = splitLines(fixture("syslog-5424"));
  const parser = new LogParser(format("syslog-5424"), context);
  const incremental = new LogStore({ ...EMPTY_QUERY, levels: ["info"], text: "web" }, (record) => parser.messageKey(record));
  incremental.reset(parser.records, (record) => parser.messageKey(record));
  for (let start = 0; start < lines.length; start += 4) {
    parser.feed(lines, start, Math.min(lines.length, start + 4));
    incremental.update();
  }
  parser.finish();
  incremental.update();
  const full = new LogStore({ ...EMPTY_QUERY, levels: ["info"], text: "web" }, (record) => parser.messageKey(record));
  full.reset(parser.records, (record) => parser.messageKey(record));
  assert.deepEqual(incremental.view, full.view);
  assert.deepEqual(incremental.levelCounts, full.levelCounts);
});

// --- Snapshots ------------------------------------------------------------------------------------

/** Compares with the stored snapshot; writes it when missing or with UPDATE_SNAPSHOTS=1. */
function matchSnapshot(name: string, value: unknown) {
  const path = join(SNAPSHOTS, `${name}.json`);
  const json = `${JSON.stringify(value, null, 2)}\n`;
  if (process.env.UPDATE_SNAPSHOTS === "1" || !existsSync(path)) {
    mkdirSync(SNAPSHOTS, { recursive: true });
    writeFileSync(path, json);
    return;
  }
  assert.deepEqual(JSON.parse(json), JSON.parse(readFileSync(path, "utf8")), `snapshot ${name} differs (UPDATE_SNAPSHOTS=1 to update)`);
}

for (const id of FIXTURE_IDS) {
  test(`snapshot: ${id} table model (columns + first records)`, () => {
    const { records, columns } = parse(id);
    matchSnapshot(id, {
      columns: columns.map(({ name, role, nonEmpty, superseded }) => ({ name, role, nonEmpty, superseded })),
      records: records.slice(0, 8).map(({ raw: _raw, ...record }) => record),
    });
  });
}

// --- Performance ----------------------------------------------------------------------------------

test("performance: 1M lines parse in under 10 s, first chunk in under 500 ms", () => {
  const levels = ["INFO ", "DEBUG", "WARN ", "ERROR"];
  const lines: string[] = [];
  for (let i = 0; i < 1_000_000; i++) {
    if (i % 50 === 49) {
      lines.push(`\tat com.example.Service.method${i % 7}(Service.java:${i % 400})`);
      continue;
    }
    const second = String(Math.floor(i / 1000) % 60).padStart(2, "0");
    const ms = String(i % 1000).padStart(3, "0");
    lines.push(`2026-10-14 10:37:${second},${ms} ${levels[i % 4]} [worker-${i % 8}] com.example.Service - Processed request ${i} in ${i % 97} ms`);
  }
  const text = lines.join("\n");

  const started = performance.now();
  const split = splitLines(text);
  const detected = detectFormat(split, candidateFormats([])).format;
  assert.equal(detected.id, "generic-app");
  const parser = new LogParser(detected, context);
  parser.feed(split, 0, 5_000);
  const firstChunk = performance.now() - started;
  parser.feed(split, 5_000, split.length);
  parser.finish();
  const result = new LogStore({ ...EMPTY_QUERY, text: "request 4242" }, (record) => parser.messageKey(record));
  result.reset(parser.records, (record) => parser.messageKey(record));
  const total = performance.now() - started;

  assert.equal(parser.records.length, 980_000);
  assert.ok(result.view.length > 0);
  assert.ok(firstChunk < 500, `first chunk took ${firstChunk.toFixed(0)} ms`);
  assert.ok(total < 10_000, `1M lines took ${total.toFixed(0)} ms`);
});
