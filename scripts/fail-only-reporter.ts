// Silent runner for `deno test`: prints only failing tests, nothing on
// success. Exit code mirrors the child `deno test` run.
//
// Unlike the old `node --test --test-reporter` version, this can't stream
// failures as they happen — `deno test` has no per-event reporter hook, only
// a final report (`--reporter=junit`), so output is batched until the whole
// suite finishes. Use `deno task test` for live output when debugging.
//
// Usage: deno run -A scripts/fail-only-reporter.ts test/

import { parseJunit, stripTrailingTestFailedNotice } from "./junit.ts";

const command = new Deno.Command(Deno.execPath(), {
  args: ["test", "-A", "--reporter=junit", ...Deno.args],
  stdout: "piped",
  stderr: "piped",
});
const child = command.spawn();
const [stdout, stderr] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
]);
const { code } = await child.status;

const cleanedStderr = stripTrailingTestFailedNotice(stderr);
if (cleanedStderr) await Deno.stderr.write(new TextEncoder().encode(cleanedStderr));

const { suites } = parseJunit(stdout);
for (const suite of suites) {
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
