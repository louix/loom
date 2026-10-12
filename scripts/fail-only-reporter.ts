// Silent runner for `deno test`: prints only failing tests, nothing on
// success. Exit code mirrors the child `deno test` runs.
//
// Unlike the old `node --test --test-reporter` version, this can't stream
// failures as they happen — `deno test` has no per-event reporter hook, only
// a final report (`--reporter=junit`), so output is batched until the whole
// suite finishes. Use `deno task test` for live output when debugging.
// Runs inside a throwaway HOME/XDG root (scripts/lib/test-run.ts).
//
// Usage: deno task test:silent [deno test flags...] [files or dirs; default test/]

import { runTests } from "./lib/test-run.ts";

const { code, report, stderr } = await runTests(Deno.args, "junit");

if (stderr) await Deno.stderr.write(new TextEncoder().encode(stderr));

for (const suite of report?.suites ?? []) {
  for (const c of suite.cases) {
    if (c.failureBody === null) continue;
    console.log(`✖ ${suite.file} — ${c.name}`);
    console.log(
      c.failureBody
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n"),
    );
  }
}

Deno.exit(code);
