// The view's `onSave` command (e.g. a formatter), run after a table file is
// saved. Free of the vscode API so it can be tested directly.

import { spawn } from "node:child_process";

export interface CommandResult {
  /** Exit code; null when the process was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Shell-quotes a value for /bin/sh (single quotes; `'` becomes `'\''`). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Replaces `${name}` placeholders with the shell-quoted value of `vars[name]`.
 * Unknown placeholders are left as they are.
 */
export function expandCommand(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(vars, name) ? shellQuote(vars[name]) : placeholder,
  );
}

/** Runs `command` in a shell; it is killed after `timeoutMs`. */
export function runCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const finish = (code: number | null, error?: Error) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: error ? error.message : Buffer.concat(stderr).toString("utf8"),
        timedOut,
      });
    };
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
  });
}
