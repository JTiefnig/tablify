import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { expandCommand, runCommand } from "../src/onSave.ts";

test("expandCommand: shell-quotes placeholder values, keeps unknown placeholders", () => {
  const command = expandCommand("fmt ${file} --root ${workspaceFolder} ${other}", {
    file: "/data/it's a file.yaml",
    workspaceFolder: "/data",
  });
  assert.equal(command, "fmt '/data/it'\\''s a file.yaml' --root '/data' ${other}");
});

test("runCommand: exit code and output", async () => {
  const result = await runCommand("echo hi; echo oops >&2; exit 3", tmpdir(), 5000);
  assert.deepEqual(result, { code: 3, stdout: "hi\n", stderr: "oops\n", timedOut: false });
});

test("runCommand: quoted arguments arrive intact", async () => {
  const result = await runCommand(`printf '%s' ${expandCommand("${file}", { file: "a b'c" })}`, tmpdir(), 5000);
  assert.equal(result.stdout, "a b'c");
});

test("runCommand: killed after the timeout", async () => {
  const result = await runCommand("sleep 5", tmpdir(), 100);
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
});
