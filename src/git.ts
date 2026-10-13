// Git access through the git CLI: the committed version of a file and blame
// for a range of lines. Free of the vscode API so it can be tested directly.

import { spawn } from "node:child_process";
import { dirname, relative, sep } from "node:path";
import type { BlameCommit, FieldBlame } from "./messages.ts";
import type { Span } from "./locate.ts";

export function runGit(gitPath: string, args: string[], cwd: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitPath, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
      } else {
        reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `git exited with ${code}`));
      }
    });
    // git may exit before reading its input (EPIPE); the exit code reports the outcome.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** A file inside a git repository. */
export class GitFile {
  readonly root: string;
  /** Path relative to the repository root, with "/" separators. */
  readonly path: string;
  private readonly gitPath: string;

  private constructor(gitPath: string, root: string, path: string) {
    this.gitPath = gitPath;
    this.root = root;
    this.path = path;
  }

  /** The tracked file at `fsPath`, or null when it is not in a repository or untracked. */
  static async open(fsPath: string, gitPath = "git"): Promise<GitFile | null> {
    try {
      const root = (await runGit(gitPath, ["rev-parse", "--show-toplevel"], dirname(fsPath))).trim();
      const path = relative(root, fsPath).split(sep).join("/");
      await runGit(gitPath, ["ls-files", "--error-unmatch", "--", path], root);
      return new GitFile(gitPath, root, path);
    } catch {
      return null;
    }
  }

  private run(args: string[], input?: string) {
    return runGit(this.gitPath, args, this.root, input);
  }

  /** Content in the last commit; null when the file is not in HEAD yet (e.g. only staged). */
  async headText(): Promise<string | null> {
    try {
      return await this.run(["show", `HEAD:${this.path}`]);
    } catch {
      return null;
    }
  }

  /** Blame for 1-based lines `start`..`end` of `text` (the current, possibly unsaved, content). */
  async blame(text: string, start: number, end: number): Promise<Map<number, BlameCommit>> {
    const output = await this.run(
      ["blame", "--porcelain", "-L", `${start},${end}`, "--contents", "-", "--", this.path],
      text,
    );
    return parseBlame(output);
  }
}

const UNCOMMITTED = /^0{40}$/;

/** Parses `git blame --porcelain` output into commit info per final line number. */
export function parseBlame(output: string): Map<number, BlameCommit> {
  const commits = new Map<string, BlameCommit>();
  const lines = new Map<number, BlameCommit>();
  let current: BlameCommit | null = null;

  for (const line of output.split("\n")) {
    const header = line.match(/^([0-9a-f]{40}) \d+ (\d+)/);
    if (header) {
      const hash = header[1];
      let commit = commits.get(hash);
      if (!commit) {
        const uncommitted = UNCOMMITTED.test(hash);
        commit = { hash, author: "", time: 0, summary: "", uncommitted };
        commits.set(hash, commit);
      }
      current = commit;
      lines.set(Number(header[2]), commit);
      continue;
    }
    if (!current || line.startsWith("\t")) continue;
    const space = line.indexOf(" ");
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? "" : line.slice(space + 1);
    if (key === "author") current.author = value;
    else if (key === "author-time") current.time = Number(value);
    else if (key === "summary") current.summary = value;
  }

  for (const commit of commits.values()) {
    if (commit.uncommitted) {
      commit.author = "You";
      commit.summary = "Uncommitted changes";
    }
  }
  return lines;
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * The most recent commit per field: uncommitted lines win, otherwise the
 * newest author time among the field's lines.
 */
export function blameFields(
  text: string,
  fields: Record<string, Span>,
  lines: Map<number, BlameCommit>,
): FieldBlame[] {
  const result: FieldBlame[] = [];
  for (const [field, [start, end]] of Object.entries(fields)) {
    const first = lineOf(text, start);
    const last = lineOf(text, Math.max(start, end - 1));
    let latest: BlameCommit | undefined;
    for (let line = first; line <= last; line++) {
      const commit = lines.get(line);
      if (!commit) continue;
      if (
        !latest ||
        (commit.uncommitted && !latest.uncommitted) ||
        (!latest.uncommitted && commit.time > latest.time)
      ) {
        latest = commit;
      }
    }
    if (latest) {
      result.push({ field, line: first, commit: latest });
    }
  }
  return result;
}

export { lineOf };
