// Format detection: the share of sampled lines each format matches.

import { BUILTIN_FORMATS, PLAIN } from "./formats.ts";
import { CONTINUATION, lineMatcher } from "./parse.ts";
import type { LogFormat } from "./types.ts";

export interface DetectOptions {
  /** Number of non-empty lines sampled from the start of the file. */
  sampleLines: number;
  /** Minimum score (matched / sampled lines) for a format to be chosen. */
  threshold: number;
}

export const DEFAULT_DETECT_OPTIONS: DetectOptions = { sampleLines: 200, threshold: 0.6 };

export interface Detection {
  format: LogFormat;
  /** Score of the chosen format (0 for the plain-text fallback). */
  score: number;
}

/** Candidates in tie-break order: custom formats win ties, then the most specific built-in. */
export function candidateFormats(custom: readonly LogFormat[]): LogFormat[] {
  return [...custom, ...BUILTIN_FORMATS];
}

/** Score of one format on sampled lines (lines without "\r", none empty). */
export function scoreFormat(format: LogFormat, sample: readonly string[]): number {
  const matcher = lineMatcher(format);
  const multiline = format.multiline ?? true;
  let matched = 0;
  let counted = 0;
  for (const line of sample) {
    if (matcher.test(line)) {
      matched++;
      counted++;
    } else if (!multiline || !CONTINUATION.test(line)) {
      // Continuation lines of multi-line formats (stack traces) do not count.
      counted++;
    }
  }
  return counted === 0 ? 0 : matched / counted;
}

/** The first `count` non-empty lines, without trailing "\r". */
export function sampleLines(lines: readonly string[], count: number): string[] {
  const sample: string[] = [];
  for (let i = 0; i < lines.length && sample.length < count; i++) {
    let line = lines[i];
    if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
    if (line.trim()) sample.push(line);
  }
  return sample;
}

/** The best-matching format, or the plain-text fallback below the threshold. */
export function detectFormat(
  lines: readonly string[],
  formats: readonly LogFormat[],
  options: DetectOptions = DEFAULT_DETECT_OPTIONS,
): Detection {
  const sample = sampleLines(lines, Math.max(1, options.sampleLines));
  let best: Detection = { format: PLAIN, score: 0 };
  for (const format of formats) {
    let score: number;
    try {
      score = scoreFormat(format, sample);
    } catch {
      continue;
    }
    // Strictly greater: on ties the earlier (more specific) format wins.
    if (score > best.score) best = { format, score };
  }
  return best.score >= options.threshold ? best : { format: PLAIN, score: 0 };
}
