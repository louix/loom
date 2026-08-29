import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BashShell } from "../src/provider/aisdk/tools/bash.ts";
import { applyEdit } from "../src/provider/aisdk/tools/edit.ts";
import { runRipgrep } from "../src/provider/aisdk/tools/grep.ts";

function tmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-builtins-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// --- bash ----------------------------------------------------------------

test("BashShell runs a command and returns output + exit code", async () => {
  const { dir, cleanup } = tmp();
  try {
    const sh = new BashShell(dir);
    const r = await sh.run("echo hello");
    assert.equal(r.output.trim(), "hello");
    assert.equal(r.exitCode, 0);

    const bad = await sh.run("false");
    assert.equal(bad.exitCode, 1);
    sh.close();
  } finally {
    cleanup();
  }
});

test("BashShell keeps cwd and exported env between calls", async () => {
  const { dir, cleanup } = tmp();
  try {
    mkdirSync(join(dir, "sub"));
    const sh = new BashShell(dir);
    await sh.run("cd sub");
    const pwd = await sh.run("pwd");
    assert.match(pwd.output.trim(), /\/sub$/);

    await sh.run("export LOOM_TEST=42");
    const echoed = await sh.run("echo $LOOM_TEST");
    assert.equal(echoed.output.trim(), "42");
    sh.close();
  } finally {
    cleanup();
  }
});

test("BashShell times out a slow command and resets the shell", async () => {
  const { dir, cleanup } = tmp();
  try {
    const sh = new BashShell(dir);
    await sh.run("export KEEP=1");
    const r = await sh.run("sleep 5", 200);
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, null);
    // shell was reset — the earlier export is gone
    const after = await sh.run("echo [${KEEP}]");
    assert.equal(after.output.trim(), "[]");
    sh.close();
  } finally {
    cleanup();
  }
});

test("BashShell clamps very large output", async () => {
  const { dir, cleanup } = tmp();
  try {
    const sh = new BashShell(dir);
    const r = await sh.run("head -c 400000 /dev/zero | tr '\\0' 'x'");
    assert.ok(r.output.length < 200_000);
    assert.match(r.output, /output truncated/);
    sh.close();
  } finally {
    cleanup();
  }
});

// --- edit --------------------------------------------------------------------

test("applyEdit: exact single replacement", () => {
  const { dir, cleanup } = tmp();
  try {
    const f = join(dir, "a.txt");
    writeFileSync(f, "one two three\n");
    const r = applyEdit(f, "two", "TWO", false);
    assert.equal(r.ok, true);
    assert.equal(r.tier, "exact");
    assert.equal(readFileSync(f, "utf8"), "one TWO three\n");
  } finally {
    cleanup();
  }
});

test("applyEdit: ambiguous exact match needs replace_all", () => {
  const { dir, cleanup } = tmp();
  try {
    const f = join(dir, "a.txt");
    writeFileSync(f, "x x x\n");
    const bad = applyEdit(f, "x", "y", false);
    assert.equal(bad.ok, false);
    assert.match(bad.message, /occurs 3 times/);

    const ok = applyEdit(f, "x", "y", true);
    assert.equal(ok.ok, true);
    assert.equal(ok.replacements, 3);
    assert.equal(readFileSync(f, "utf8"), "y y y\n");
  } finally {
    cleanup();
  }
});

test("applyEdit: falls back to trailing-whitespace-insensitive matching", () => {
  const { dir, cleanup } = tmp();
  try {
    const f = join(dir, "code.ts");
    writeFileSync(f, "function f() {  \n  return 1;\n}\n"); // trailing spaces after {
    const r = applyEdit(f, "function f() {\n  return 1;\n}", "function f() {\n  return 2;\n}", false);
    assert.equal(r.ok, true);
    assert.equal(r.tier, "trailing-insensitive");
    assert.match(readFileSync(f, "utf8"), /return 2;/);
  } finally {
    cleanup();
  }
});

test("applyEdit: dedented matching when indentation differs", () => {
  const { dir, cleanup } = tmp();
  try {
    const f = join(dir, "code.ts");
    writeFileSync(f, "class C {\n    method() {\n        return 1;\n    }\n}\n");
    // old_string is dedented relative to the file
    const r = applyEdit(f, "method() {\n    return 1;\n}", "method() {\n    return 42;\n}", false);
    assert.equal(r.ok, true);
    assert.equal(r.tier, "dedented");
    assert.match(readFileSync(f, "utf8"), /return 42;/);
  } finally {
    cleanup();
  }
});

test("applyEdit: not found is a clean failure", () => {
  const { dir, cleanup } = tmp();
  try {
    const f = join(dir, "a.txt");
    writeFileSync(f, "hello\n");
    const r = applyEdit(f, "goodbye", "x", false);
    assert.equal(r.ok, false);
    assert.match(r.message, /not found/);
  } finally {
    cleanup();
  }
});

// --- grep ------------------------------------------------------------------

test("runRipgrep returns path:line:match lines and (no matches)", async () => {
  const { dir, cleanup } = tmp();
  try {
    writeFileSync(join(dir, "a.ts"), "const foo = 1;\nconst bar = 2;\n");
    writeFileSync(join(dir, "b.ts"), "// nothing here\n");

    const hit = await runRipgrep({ pattern: "foo" }, dir);
    assert.equal(hit.ok, true);
    assert.match(hit.output, /a\.ts:1:.*foo/);

    const miss = await runRipgrep({ pattern: "zzznope" }, dir);
    assert.equal(miss.ok, true);
    assert.equal(miss.output, "(no matches)");

    const scoped = await runRipgrep({ pattern: "const", glob: "b.ts" }, dir);
    assert.equal(scoped.output, "(no matches)");
  } finally {
    cleanup();
  }
});

test("runRipgrep reports a missing binary instead of throwing", async () => {
  const { dir, cleanup } = tmp();
  try {
    const r = await runRipgrep({ pattern: "x", bin: "definitely-not-ripgrep-xyz" }, dir);
    assert.equal(r.ok, false);
    assert.match(r.output, /not installed|not on PATH/);
  } finally {
    cleanup();
  }
});
