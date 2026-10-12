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

test("planTests splits flags from files and own-process files from the rest", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "nested"));
    await Deno.writeTextFile(join(dir, "a.test.ts"), `${OWN_PROCESS_MARKER} — sets PATH.\n`);
    await Deno.writeTextFile(join(dir, "nested/b.test.tsx"), "");
    await Deno.writeTextFile(join(dir, "c_test.ts"), `// ${OWN_PROCESS_MARKER} quoted\n`);
    await Deno.writeTextFile(join(dir, "fixtures.ts"), "");
    const plan = planTests(["--filter", "x", "--parallel", dir], Deno.readTextFileSync);
    assert.deepEqual(plan.flags, ["--filter", "x"]);
    assert.deepEqual(plan.ownProcess, [join(dir, "a.test.ts")]);
    assert.deepEqual(plan.parallel, [join(dir, "c_test.ts"), join(dir, "nested/b.test.tsx")]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("only a line starting with the marker claims a process", () => {
  assert.equal(ownsProcess(`import x;\n${OWN_PROCESS_MARKER} — sets PATH.\n`), true);
  assert.equal(ownsProcess(`const marker = "${OWN_PROCESS_MARKER}";\n`), false);
});
