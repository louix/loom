// Timing reporter for `node --test`: prints a per-file duration table (slowest
// first) plus a wall-vs-Σ(files) ratio — wall ≈ Σ means the file run is
// effectively serial, wall ≪ Σ means files are overlapping (Node's runner
// default is cores − 1 concurrent files). Also prints every failing test, so
// `pnpm run test:timing` doubles as a failure check. Exit code still reflects
// the run status.
// Usage: node --test --test-reporter ./scripts/timing-reporter.mjs "test/*.test.ts"
// Event model (Node ≥24): every file also emits a file-level `test:complete`
// whose name is the file path and whose duration covers the child's whole run
// (spawn + import + tests); `test:pass`/`test:fail` events are individual tests
// and always arrive at nesting 0 in this stream.

import { resolve } from "node:path";

const fmtMs = (ms) => (ms >= 10_000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);
const abs = (f) => (f ? resolve(f) : "");
const indent = (n) => "  ".repeat(n);

// node:test wraps file-level failures (parse/import errors, crashes) in an
// ERR_TEST_FAILURE whose only text is "test failed"; the real error goes to the
// child's stderr, reported as test:stderr events tagged with the file. Buffer
// them per file (tail-capped) and surface them for such failures.
const MAX_CAPTURED = 16 * 1024;
const stderrByFile = new Map();

const files = new Map(); // resolved path → { name, ms, failed }
const failsByFile = new Map(); // resolved path → failing tests seen so far
let pass = 0;
let fail = 0;
const startedAt = Date.now();

const failureLines = function* (d) {
  const details = d.details ?? {};
  const pad = indent((d.nesting ?? 0) + 1);
  const lines = [`${indent(d.nesting ?? 0)}✖ ${d.name} (${fmtMs(details.duration_ms ?? 0)})`];
  let err = details.error ?? d.error ?? d.cause;
  // Serialized errors may not pass `instanceof Error`; unwrap the cause chain
  // structurally to reach the useful stack.
  while (err?.cause && (err.cause.stack ?? err.cause.message)) err = err.cause;
  const text = err?.stack ?? err?.message ?? (err == null ? null : String(err));
  if (text) lines.push(...text.split("\n").map((l) => pad + l));
  const uninformative = !text || /^(Error:\s*)?test failed$/.test(text.trim());
  if (uninformative) {
    const captured = stderrByFile.get(abs(d.file));
    if (captured)
      lines.push(
        ...captured
          .trimEnd()
          .split("\n")
          .map((l) => pad + l),
      );
  }
  yield lines.join("\n") + "\n";
};

const isFileWrapper = (d) =>
  typeof d.name === "string" && /\.(test|spec)\.[cm]?[jt]sx?$/.test(d.name);

export default async function* timing(source) {
  for await (const event of source) {
    const d = event.data ?? {};
    if (event.type === "test:stderr") {
      const key = abs(d.file);
      const buf = (stderrByFile.get(key) ?? "") + (d.message ?? "");
      stderrByFile.set(key, buf.length > MAX_CAPTURED ? buf.slice(-MAX_CAPTURED) : buf);
      continue;
    }
    if (event.type === "test:pass") {
      pass++;
    } else if (event.type === "test:fail") {
      fail++;
      if (isFileWrapper(d)) {
        // A file whose wrapper failed without per-test events (import/crash).
        files.set(abs(d.file) || String(d.name), {
          name: d.file ?? d.name,
          ms: 0,
          failed: true,
        });
      } else {
        const key = abs(d.file);
        if (key) failsByFile.set(key, (failsByFile.get(key) ?? 0) + 1);
        yield* failureLines(d);
      }
    } else if (event.type === "test:complete" && isFileWrapper(d)) {
      // File-level wrapper: its duration is the child's whole run.
      const name = d.file ?? d.name;
      const key = abs(d.file);
      files.set(key || String(name), {
        name,
        ms: d.details?.duration_ms ?? 0,
        failed: (failsByFile.get(key) ?? 0) > 0,
      });
      stderrByFile.delete(key);
    }
  }

  const wall = Date.now() - startedAt;
  const total = [...files.values()].reduce((acc, f) => acc + f.ms, 0);
  const overlap = total > 0 ? total / Math.max(wall, 1) : 0;
  const ranked = [...files.values()].sort((a, b) => b.ms - a.ms);
  const rest = ranked.slice(12);
  const lines = [
    "",
    `── test timing ${"─".repeat(48)}`,
    `wall ${fmtMs(wall)} · Σ(files) ${fmtMs(total)} · ×${overlap.toFixed(2)} overlap (×1 = serial)`,
    `files ${files.size} · cases ${pass} pass / ${fail} fail`,
    "slowest files:",
    ...ranked
      .slice(0, 12)
      .map(
        (f, i) =>
          `${String(i + 1).padStart(3)}. ${fmtMs(f.ms).padStart(8)}  ${f.name}${f.failed ? "  ✖" : ""}`,
      ),
    ...(rest.length > 0
      ? [
          `     … ${rest.length} more files, ${fmtMs(rest.reduce((acc, f) => acc + f.ms, 0))} combined`,
        ]
      : []),
    "",
  ];
  yield lines.join("\n") + "\n";
}
