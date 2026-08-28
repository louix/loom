import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveClaudeCli } from "../src/provider/claude/cli.ts";

test("an explicit executable path is used as-is", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-cli-"));
  try {
    const bin = join(dir, "claude");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    assert.equal(resolveClaudeCli(bin), bin);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit path that isn't executable throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-cli-"));
  try {
    const f = join(dir, "notexec");
    writeFileSync(f, "x");
    chmodSync(f, 0o644);
    assert.throws(() => resolveClaudeCli(f), /not an executable file/);
    assert.throws(() => resolveClaudeCli(join(dir, "missing")), /not an executable file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with no explicit path, discovers `claude` on PATH (or returns undefined)", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-cli-"));
  const savedPath = process.env["PATH"];
  try {
    const bin = join(dir, "claude");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    process.env["PATH"] = dir;
    assert.equal(resolveClaudeCli(""), bin);

    process.env["PATH"] = mkdtempSync(join(tmpdir(), "loom-empty-"));
    assert.equal(resolveClaudeCli(""), undefined);
  } finally {
    if (savedPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = savedPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
