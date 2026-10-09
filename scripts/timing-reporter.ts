// Timing runner for `deno test`: prints a per-file duration table (slowest
// first). Exit code mirrors the child `deno test` run; also prints every
// failing test, so `deno task test:timing` doubles as a failure check.
//
// Deno runs test files in one process rather than one child per file, and
// its JUnit output has no per-suite duration — so unlike the old Node
// version's wall-vs-Σ(files) overlap ratio, "file time" here is just the sum
// of that file's own test-case durations, not a measured wall/spawn cost.
//
// Runs inside a throwaway HOME/XDG root (scripts/lib/test-home.ts).
//
// Usage: deno task test:timing [deno test flags...] [files or dirs; default test/]

import { parseJunit, stripTrailingTestFailedNotice } from "./junit.ts";
import { runIsolatedTests } from "./lib/test-home.ts";

const fmtMs = (ms: number) => (ms >= 10_000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);

const { code, stdout, stderr } = await runIsolatedTests(["--reporter=junit", ...Deno.args], {
  stdout: "piped",
  stderr: "piped",
});

const cleanedStderr = stripTrailingTestFailedNotice(stderr);
if (cleanedStderr) await Deno.stderr.write(new TextEncoder().encode(cleanedStderr));

const { wallMs, suites } = parseJunit(stdout);

let pass = 0;
let fail = 0;
const files: { name: string; ms: number; failed: boolean }[] = [];

for (const suite of suites) {
  let fileMs = 0;
  let fileFailed = false;
  for (const c of suite.cases) {
    fileMs += c.ms;
    if (c.failureBody !== null) {
      fail++;
      fileFailed = true;
      console.log(`✖ ${suite.file} — ${c.name}`);
      console.log(
        c.failureBody
          .split("\n")
          .map((l) => `  ${l}`)
          .join("\n"),
      );
    } else {
      pass++;
    }
  }
  files.push({ name: suite.file, ms: fileMs, failed: fileFailed });
}

const total = files.reduce((acc, f) => acc + f.ms, 0);
const ranked = [...files].sort((a, b) => b.ms - a.ms);
const rest = ranked.slice(12);

console.log("");
console.log(`── test timing ${"─".repeat(48)}`);
console.log(`wall ${fmtMs(wallMs)} · Σ(files) ${fmtMs(total)}`);
console.log(`files ${files.length} · cases ${pass} pass / ${fail} fail`);
console.log("slowest files:");
for (const [i, f] of ranked.slice(0, 12).entries()) {
  console.log(
    `${String(i + 1).padStart(3)}. ${fmtMs(f.ms).padStart(8)}  ${f.name}${f.failed ? "  ✖" : ""}`,
  );
}
if (rest.length > 0) {
  console.log(
    `     … ${rest.length} more files, ${fmtMs(rest.reduce((acc, f) => acc + f.ms, 0))} combined`,
  );
}
console.log("");

Deno.exit(code);
