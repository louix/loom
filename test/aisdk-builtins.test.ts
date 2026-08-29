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

test("BashShell: an unbalanced quote is caught by the syntax pre-check, not by wedging", async () => {
  const { dir, cleanup } = tmp();
  try {
    const sh = new BashShell(dir);
    const started = Date.now();
    const r = await sh.run('echo "oops', 120_000); // would block for the full timeout without the pre-check
    assert.equal(r.exitCode, 2);
    assert.ok(Date.now() - started < 5_000, "returned fast instead of blocking");
    // the persistent shell is untouched
    await sh.run("export KEEP=1");
    const after = await sh.run("echo [${KEEP}]");
    assert.equal(after.output.trim(), "[1]");
    sh.close();
  } finally {
    cleanup();
  }
});

test("BashShell: an unterminated heredoc is caught, but a valid extglob pattern runs", async () => {
  const { dir, cleanup } = tmp();
  try {
    const sh = new BashShell(dir);
    // unterminated heredoc → rejected fast, not a 120s wedge
    const bad = await sh.run("cat <<EOF\nhello", 120_000);
    assert.equal(bad.exitCode, 2);

    // a plain syntax error is NOT pre-rejected — it runs and the shell reports it
    const syn = await sh.run("if then", 3_000);
    assert.equal(syn.timedOut, false);
    assert.match(syn.output, /syntax error/);

    // extglob after `shopt -s extglob` must NOT be blocked by the pre-check
    await sh.run("shopt -s extglob");
    await sh.run("touch keep.md drop.txt");
    const ls = await sh.run("ls !(*.txt)", 3_000);
    assert.equal(ls.timedOut, false);
    assert.match(ls.output, /keep\.md/);
    assert.doesNotMatch(ls.output, /drop\.txt/);
    sh.close();
  } finally {
    cleanup();
  }
});

test("BashShell: a command that exits the shell doesn't block; the shell is reset", async () => {
  const { dir, cleanup } = tmp();
  try {
    const sh = new BashShell(dir);
    await sh.run("export KEEP=1");
    const started = Date.now();
    const r = await sh.run("exit", 120_000);
    assert.ok(Date.now() - started < 5_000, "detected the shell exit instead of timing out");
    assert.equal(r.exitCode, null);
    const after = await sh.run("echo [${KEEP}]");
    assert.equal(after.output.trim(), "[]"); // fresh shell
    sh.close();
  } finally {
    cleanup();
  }
});

test("BashShell: a `read` in the command gets EOF, not the sentinel", async () => {
  const { dir, cleanup } = tmp();
  try {
    const sh = new BashShell(dir);
    const r = await sh.run("read -r x; echo \"got:[$x]\"", 3_000);
    assert.equal(r.timedOut, false);
    assert.equal(r.output.trim(), "got:[]");
    // the next command still frames cleanly
    const next = await sh.run("echo ok");
    assert.equal(next.output.trim(), "ok");
    sh.close();
  } finally {
    cleanup();
  }
});

test("BashShell: an unspawnable shell surfaces an error instead of crashing", async () => {
  const { dir, cleanup } = tmp();
  const savedPath = process.env["PATH"];
  try {
    process.env["PATH"] = "/nonexistent-loom-test";
    const sh = new BashShell(dir);
    const r = await sh.run("echo hi", 2_000);
    assert.equal(r.exitCode, null);
    assert.match(r.output, /ENOENT|not found|spawn/i);
    sh.close();
  } finally {
    process.env["PATH"] = savedPath;
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

test("applyEdit: an empty old_string is rejected, not appended", () => {
  const { dir, cleanup } = tmp();
  try {
    const f = join(dir, "f.txt");
    writeFileSync(f, "line1\nline2\n");
    const r = applyEdit(f, "", "INSERTED", false);
    assert.equal(r.ok, false);
    assert.match(r.message ?? "", /must not be empty/);
    assert.equal(readFileSync(f, "utf8"), "line1\nline2\n");
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
