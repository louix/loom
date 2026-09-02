// Silent reporter for `node --test`: prints only failing tests (and suites),
// nothing on success. Exit code still reflects the run status.
// Usage: node --test --test-reporter ./scripts/fail-only-reporter.mjs "test/*.test.ts"
// Note: console output from inside tests is swallowed; use `pnpm test` for the
// verbose spec reporter when debugging.

import { resolve } from "node:path";

const fmtMs = (ms) => `${Math.round(ms * 1000) / 1000}ms`;
const indent = (n) => "  ".repeat(n);
const abs = (f) => (f ? resolve(f) : "");

// node:test wraps file-level failures (parse/import errors, crashes) in an
// ERR_TEST_FAILURE whose only text is "test failed"; the real error goes to the
// child's stderr, reported as test:stderr events tagged with the file. Buffer
// them per file (tail-capped) and surface them for such failures.
const MAX_CAPTURED = 16 * 1024;
const stderrByFile = new Map();

export default async function* failuresOnly(source) {
  for await (const event of source) {
    const d = event.data ?? {};
    if (event.type === "test:stderr") {
      const key = abs(d.file);
      const buf = (stderrByFile.get(key) ?? "") + (d.message ?? "");
      stderrByFile.set(key, buf.length > MAX_CAPTURED ? buf.slice(-MAX_CAPTURED) : buf);
    } else if (event.type === "test:pass" && (d.nesting ?? 0) === 0) {
      stderrByFile.delete(abs(d.file));
    } else if (event.type === "test:fail") {
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
        if (captured) lines.push(...captured.trimEnd().split("\n").map((l) => pad + l));
      }
      yield lines.join("\n") + "\n";
    }
  }
}
