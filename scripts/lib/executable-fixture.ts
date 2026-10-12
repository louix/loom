// Fake executables for tests (a smolvm, a Git hook, a backend wrapper),
// written by `sh` rather than by the test's own process.
//
// Under `deno test --parallel`, another file's thread can fork while this one
// has the file open for writing; the child holds a copy of that descriptor
// until its exec, and running the file meanwhile fails with ETXTBSY ("Text
// file busy"). Written by a child process, the file is never open for writing
// here.

import assert from "node:assert/strict";

const command = (path: string, text: string, mode: number) =>
  new Deno.Command("sh", {
    args: ["-c", 'printf %s "$1" > "$2" && chmod "$3" "$2"', "sh", text, path, mode.toString(8)],
  });

const written = (output: Deno.CommandOutput, path: string) =>
  assert(output.success, `writing ${path}: ${new TextDecoder().decode(output.stderr)}`);

export const writeExecutable = async (path: string, text: string, mode: number): Promise<void> =>
  written(await command(path, text, mode).output(), path);

export const writeExecutableSync = (path: string, text: string, mode: number): void =>
  written(command(path, text, mode).outputSync(), path);
