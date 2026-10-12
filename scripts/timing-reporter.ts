// Timing runner for `deno test`: prints a per-file duration table (slowest
// first). Exit code mirrors the child `deno test` runs; also prints every
// failing test, so `deno task test:timing` doubles as a failure check.
//
// Deno's JUnit output has no per-suite duration, so "file time" here is the
// sum of that file's own top-level test-case durations (steps and `describe`
// children are inside their parent's), not a measured wall/spawn cost. Files
// run in parallel, so Σ(files) over wall is the overlap the run achieved;
// under that load each case also takes longer than it would alone.
//
// Runs inside a throwaway HOME/XDG root (scripts/lib/test-run.ts).
//
// Usage: deno task test:timing [deno test flags...] [files or dirs; default test/]

import { runTests } from "./lib/test-run.ts";

const fmtMs = (ms: number) => (ms >= 10_000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);

const { code, report, stderr } = await runTests(Deno.args, "junit");

if (stderr) await Deno.stderr.write(new TextEncoder().encode(stderr));

let pass = 0;
let fail = 0;
const files: { name: string; ms: number; failed: boolean }[] = [];

for (const suite of report?.suites ?? []) {
  let fileMs = 0;
  let fileFailed = false;
  for (const c of suite.cases) {
    if (!c.nested) fileMs += c.ms;
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
console.log(`wall ${fmtMs(report?.wallMs ?? 0)} · Σ(files) ${fmtMs(total)}`);
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
