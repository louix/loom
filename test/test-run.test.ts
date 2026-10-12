import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { OWN_PROCESS_MARKER, ownsProcess, planTests } from "../scripts/lib/test-run.ts";

// What one file's thread in `deno test --parallel` would change for every other file's.
const PROCESS_STATE_WRITE =
  /Deno\.env\.(set|delete)\(|Deno\.chdir\(|process\.chdir\(|Deno\.umask\(|process\.env(\.\w+|\[[^\]]+\])\s*=[^=]|delete process\.env/;

test("a test file that changes process-wide state runs in a process of its own", () => {
  const { parallel } = planTests(["test"], Deno.readTextFileSync);
  const offenders = parallel.filter((file) =>
    PROCESS_STATE_WRITE.test(Deno.readTextFileSync(file)),
  );
  assert.deepEqual(
    offenders,
    [],
    `pass the environment to the code under test, or start the file with \`${OWN_PROCESS_MARKER} — <why>\``,
  );
});

test("planTests splits flags from files and own-process files from the rest, largest first", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "nested"));
    await Deno.writeTextFile(join(dir, "a.test.ts"), `${OWN_PROCESS_MARKER} — sets PATH.\n`);
    await Deno.writeTextFile(
      join(dir, "nested/b.test.tsx"),
      "// the largest file starts first\n".repeat(4),
    );
    await Deno.writeTextFile(join(dir, "c_test.ts"), `// ${OWN_PROCESS_MARKER} quoted\n`);
    await Deno.writeTextFile(join(dir, "fixtures.ts"), "");
    const plan = planTests(["--filter", "x", "--parallel", dir], Deno.readTextFileSync);
    assert.deepEqual(plan.flags, ["--filter", "x"]);
    assert.deepEqual(plan.ownProcess, [join(dir, "a.test.ts")]);
    assert.deepEqual(plan.parallel, [join(dir, "nested/b.test.tsx"), join(dir, "c_test.ts")]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("only a line starting with the marker claims a process", () => {
  assert.equal(ownsProcess(`import x;\n${OWN_PROCESS_MARKER} — sets PATH.\n`), true);
  assert.equal(ownsProcess(`const marker = "${OWN_PROCESS_MARKER}";\n`), false);
});

test("a shard stands for its whole file, scheduled where the file is", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, "big.test.ts"), "// a large file\n".repeat(8));
    await Deno.writeTextFile(join(dir, "big.2.test.ts"), 'import "./big.test.ts";\n');
    await Deno.writeTextFile(join(dir, "mid.test.ts"), "// a mid-sized file\n".repeat(4));
    const shard = planTests([join(dir, "big.2.test.ts")], Deno.readTextFileSync);
    assert.deepEqual(shard.parallel, [join(dir, "big.test.ts"), join(dir, "big.2.test.ts")]);
    const all = planTests([dir], Deno.readTextFileSync);
    assert.deepEqual(all.parallel, [
      join(dir, "big.test.ts"),
      join(dir, "big.2.test.ts"),
      join(dir, "mid.test.ts"),
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
