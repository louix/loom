import assert from "node:assert/strict";
import { join } from "node:path";
import { executionOptionsSchema } from "../core/src/execution.ts";
import { vmExecutionCommand } from "../runtime/src/session-vm/execution.ts";
import { guestShellEnvironmentPath, shellEnvironment } from "../runtime/src/session-vm/shell.ts";
import type { VmBinding } from "../runtime/src/packaged/vm.ts";

const binding = {
  smolvm: "/smolvm",
  workspace: "/worktree",
  state: "/state",
} as VmBinding;

Deno.test("direct execution preserves literal argv, activated environment, separate streams and exit code", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const profile = join(dir, "env.sh");
    await Deno.writeTextFile(profile, shellEnvironment({ LOOM_EXEC_TEST: "activated" }));
    const values = [
      "",
      "two words",
      "'quoted'",
      "$(touch injected)",
      "`touch injected`",
      "*",
      "line\nbreak",
      "--",
      "λ",
    ];
    const command = executionOptionsSchema.parse({
      argv: [
        "/bin/sh",
        "-c",
        'test "$LOOM_EXEC_TEST" = activated || exit 99; printf "%s\\0" "$@"; printf "error\\0bytes" >&2; exit 7',
        "test",
        ...values,
      ],
      stdin: false,
    });
    const target = vmExecutionCommand(binding, command);
    assert(!target.args.includes("-t"));
    assert(!target.args.includes("-i"));
    const args = target.args.slice(target.args.indexOf("--") + 1);
    // Execute the exact guest wrapper locally, substituting only its private profile path.
    args[2] = args[2]!.replace(
      guestShellEnvironmentPath,
      "'" + profile.replaceAll("'", "'\\''") + "'",
    );
    const result = await new Deno.Command(args[0]!, {
      args: args.slice(1),
      cwd: dir,
      clearEnv: true,
      env: { PATH: "/usr/bin:/bin" },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(result.code, 7);
    assert.deepEqual(result.stdout, new TextEncoder().encode(values.join("\0") + "\0"));
    assert.deepEqual(result.stderr, new TextEncoder().encode("error\0bytes"));
    await assert.rejects(Deno.stat(join(dir, "injected")), Deno.errors.NotFound);
    assert(!Object.hasOwn(target.env, "LOOM_EXEC_TEST"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("execution selects guest clone cwd and requests a PTY only explicitly", () => {
  const target = vmExecutionCommand(
    { ...binding, privateWorkspace: "/private/checkout" },
    executionOptionsSchema.parse({ argv: ["claude"], tty: true }),
  );
  assert.equal(target.args[target.args.indexOf("-w") + 1], "/workspace/checkout");
  assert(target.args.includes("-i"));
  assert(target.args.includes("-t"));
  assert.equal(target.executable, binding.smolvm);
  assert.equal(target.env.HOME, "/state/home");
});

Deno.test("execution rejects malformed argv and implicit transport overrides", () => {
  for (const command of [
    { argv: [] },
    { argv: [""] },
    { argv: ["-c", "echo unsafe"] },
    { argv: ["echo", "nul\0byte"] },
    { argv: "echo unsafe" },
    { argv: ["echo"], cwd: "/host" },
    { argv: ["echo"], env: { SECRET: "value" } },
    { argv: ["echo"], tty: true, stdin: false },
    { argv: ["echo", "a".repeat(65536), "b".repeat(65536)] },
  ])
    assert.equal(executionOptionsSchema.safeParse(command).success, false);
});

Deno.test("terminal hints are validated and compiled by the backend", () => {
  const target = vmExecutionCommand(
    binding,
    executionOptionsSchema.parse({
      argv: ["sh"],
      tty: true,
      terminal: { TERM: "xterm-256color", COLORTERM: "truecolor" },
    }),
  );
  assert(target.args.includes("TERM=xterm-256color"));
  assert.equal(target.env.COLORTERM, "truecolor");
  assert.equal(
    executionOptionsSchema.safeParse({ argv: ["sh"], terminal: { HOME: "/host" } }).success,
    false,
  );
  assert.equal(
    executionOptionsSchema.safeParse({ argv: ["sh"], terminal: { TERM: "x\nINJECT=value" } })
      .success,
    false,
  );
});
