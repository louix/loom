/**
 * Real-VM acceptance for loom-isolate, run from a standalone package copy (or an
 * installed executable), with a private XDG_STATE_HOME:
 *
 *   deno run -A scripts/test-loom-isolate-vm.ts <session-runtime> <smolvm> [loom-isolate]
 *
 * Covers literal argv, stdio, exit status, workspace mount, denied and granted
 * egress, Ctrl-C forwarding, PTY size/resize/^C, parent loss, SIGKILL recovery,
 * owner exclusion, refusal of Loom-owned state, prepare/inspect/cleanup, and after
 * each run: VM recorded stopped, runtime state reaped, lock free, no process left.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyIsolateCli } from "../packaging/copy-isolate-cli.ts";
import { listVms } from "../runtime/src/session-vm/inventory.ts";
import { processesUsing, ptyCommand, resizeTerminal } from "./lib/host-processes.ts";

const [artifact, smolvm, installed] = Deno.args;
assert(artifact && smolvm, "Pass a rebuilt session runtime and smolvm");
const root = await Deno.realPath(
  await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-isolate-vm-" }),
);
const state = join(root, "xdg-state");
const workspace = join(root, "workspace");
// The VM inventory of this run, under its private XDG_STATE_HOME; never the user's.
const inventory = join(state, "loom/vms");
await Deno.mkdir(workspace);
const env = {
  PATH: Deno.env.get("PATH") ?? "",
  HOME: Deno.env.get("HOME") ?? root,
  XDG_STATE_HOME: state,
  LOOM_ISOLATE_ARTIFACT: artifact,
  LOOM_ISOLATE_SMOLVM: smolvm,
  DENO_NO_UPDATE_CHECK: "1",
  TERM: "xterm-256color",
  ...(Deno.env.get("DENO_DIR") ? { DENO_DIR: Deno.env.get("DENO_DIR")! } : {}),
};
let command: string[];
if (installed) command = [await Deno.realPath(installed)];
else {
  const pkg = join(root, "package");
  await copyIsolateCli(fileURLToPath(new URL("../", import.meta.url)), pkg);
  const install = await new Deno.Command(Deno.execPath(), {
    args: ["install", "--frozen", "--cached-only"],
    cwd: pkg,
    stdout: "null",
    stderr: "inherit",
  }).output();
  assert(install.success, "package install");
  command = [
    Deno.execPath(),
    "run",
    "-A",
    "--deny-net",
    "--frozen",
    "--cached-only",
    "--node-modules-dir=manual",
    join(pkg, "cli/src/loom-isolate.ts"),
  ];
}
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const log = (text: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${text}`);

const run = async (args: string[], stdin?: string) => {
  const child = new Deno.Command(command[0]!, {
    args: [...command.slice(1), ...args],
    cwd: workspace,
    clearEnv: true,
    env,
    stdin: stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
  }
  const result = await child.output();
  return { code: result.code, stdout: decode(result.stdout), stderr: decode(result.stderr) };
};
const start = (argv: string[]) => {
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: workspace,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => (stdout += chunk));
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  return {
    child,
    exited,
    output: () => ({ stdout, stderr }),
    signal: (signal: Deno.Signal) => Deno.kill(child.pid!, signal),
    async waitFor(pattern: RegExp, timeout = 240_000) {
      const deadline = Date.now() + timeout;
      while (!pattern.test(stdout)) {
        if (Date.now() > deadline) throw new Error(`Timed out on ${pattern}: ${stdout}\n${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return stdout.match(pattern)!;
    },
  };
};
const alive = (pid: number) => {
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch {
    return false;
  }
};
const until = async (condition: () => boolean | Promise<boolean>, what: string, ms = 60_000) => {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for " + what);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};
const vmStates = async () => {
  const states = new Set<string>();
  for await (const entry of Deno.readDir("/tmp"))
    if (/^loom-(?:session-vm|svm)-/.test(entry.name)) states.add(join("/tmp", entry.name));
  return states;
};
let seen = 0;
/** This run's VMs are all stopped and reaped; the environment is free; nothing lingers. */
const assertCleaned = async (before: Set<string>, orphaned = false) => {
  const environments = join(state, "loom-isolate/environments");
  await until(async () => (await processesUsing([environments])).length === 0, "processes to exit");
  await until(
    async () => [...(await vmStates())].every((path) => before.has(path)),
    "VM runtime state to be reaped",
  );
  const { vms, errors } = await listVms(workspace, inventory);
  assert.deepEqual(errors, []);
  assert(vms.length > seen, "the run launched a VM");
  for (const vm of vms.slice(0, vms.length - seen)) {
    // A SIGKILLed CLI cannot record the stop its supervisor performed.
    if (!orphaned) assert.equal(vm.state, "stopped", JSON.stringify(vm));
    assert.equal(vm.workload === "stopped" || orphaned, true);
    await assert.rejects(Deno.lstat(vm.paths.state), Deno.errors.NotFound, "VM state reaped");
  }
  seen = vms.length;
  const inspect = JSON.parse((await run(["inspect", "--all", "--json"])).stdout);
  for (const environment of inspect.environments) {
    assert.equal(environment.inUse, false);
    assert.equal(environment.vmActive, false);
  }
};
const step = async (name: string, body: (before: Set<string>) => Promise<void>) => {
  log(name);
  const before = await vmStates();
  await body(before);
};

try {
  await step("literal argv, stdio, exit status, workspace mount, denied egress", async (before) => {
    await Deno.writeTextFile(join(workspace, "input.txt"), "from host\n");
    const result = await run(
      [
        "exec",
        "-q",
        "--",
        "sh",
        "-c",
        'printf "<%s>\\n" "$@"; cat input.txt; while read l; do echo "in:$l"; done; ' +
          "echo from guest > output.txt; echo to-stderr >&2; " +
          "if curl -sS --max-time 10 https://example.com >/dev/null 2>&1; then echo egress-open; fi; exit 5",
        "sh",
        "two words",
        "$(touch injected)",
        "*",
        "'q'",
      ],
      "line1\nline2\n",
    );
    assert.equal(result.code, 5, result.stderr);
    assert.equal(
      result.stdout,
      "<two words>\n<$(touch injected)>\n<*>\n<'q'>\nfrom host\nin:line1\nin:line2\n",
    );
    assert.equal(result.stderr, "to-stderr\n");
    assert.equal(await Deno.readTextFile(join(workspace, "output.txt")), "from guest\n");
    await assert.rejects(Deno.lstat(join(workspace, "injected")), Deno.errors.NotFound);
    await assertCleaned(before);
  });

  const online = await fetch("https://example.com", { signal: AbortSignal.timeout(10_000) }).then(
    (response) => response.body?.cancel().then(() => true) ?? true,
    () => false,
  );
  await step(
    "--allow-host grants egress to that host only; guest signal status" +
      (online ? "" : " (host offline: egress not checked)"),
    async (before) => {
      const result = await run([
        "exec",
        "-q",
        "--allow-host",
        "example.com",
        "--no-stdin",
        "--",
        "sh",
        "-c",
        (online ? "curl -sS --max-time 30 -o /dev/null https://example.com || exit 7; " : "") +
          "if curl -sS --max-time 10 -o /dev/null https://example.org 2>/dev/null; then exit 8; fi; " +
          "kill -TERM $$",
      ]);
      assert.equal(result.code, 143, result.stderr);
      await assertCleaned(before);
    },
  );

  await step("Ctrl-C reaches the guest command, which chooses its exit", async (before) => {
    const cli = start([
      ...command,
      "exec",
      "-q",
      "--no-stdin",
      "--",
      "sh",
      "-c",
      'trap "echo got-INT; exit 9" INT; echo started; while :; do sleep 0.2; done',
    ]);
    await cli.waitFor(/started/);
    cli.signal("SIGINT");
    assert.equal(await cli.exited, 9, cli.output().stderr);
    assert.match(cli.output().stdout, /got-INT/);
    await assertCleaned(before);
  });

  await step("PTY: terminal size, resize and ^C", async (before) => {
    for (const tool of ["script", "stty"]) {
      const found = await new Deno.Command("sh", { args: ["-c", "command -v " + tool] }).output();
      if (!found.success) {
        log("  skipped: no " + tool + " on this host");
        return;
      }
    }
    const inner =
      "echo TTY=$(tty); stty rows 24 cols 80; exec " +
      command.map(quote).join(" ") +
      " exec -q -t -- sh -c " +
      quote(
        'echo size=$(stty size); trap "echo resized=\\$(stty size)" WINCH; ' +
          'trap "echo got-INT; exit 9" INT; echo started; while :; do sleep 0.2; done',
      );
    const pty = ptyCommand(inner);
    const cli = start([pty.command, ...pty.args]);
    const tty = (await cli.waitFor(/TTY=(\/dev\/(?:pts\/\d+|ttys\d+))/))[1]!;
    await cli.waitFor(/started/);
    assert.match(cli.output().stdout, /size=24 80/);
    const resized = await resizeTerminal(tty, 33, 77);
    assert(resized.success, new TextDecoder().decode(resized.stderr));
    await cli.waitFor(/resized=33 77/, 20_000);
    cli.child.stdin!.write(new Uint8Array([3]));
    assert.equal(await cli.exited, 9, cli.output().stdout);
    assert.match(cli.output().stdout, /got-INT/);
    await assertCleaned(before);
  });

  await step("losing the parent ends the command and stops the VM", async (before) => {
    const cli = start([
      "/bin/sh",
      "-c",
      '"$@" & echo "cli=$!"; wait',
      "parent",
      ...command,
      "exec",
      "-q",
      "--no-stdin",
      "--",
      "sh",
      "-c",
      'trap "echo hangup; exit 4" TERM; echo started; while :; do sleep 0.2; done',
    ]);
    const pid = Number((await cli.waitFor(/cli=(\d+)/))[1]);
    await cli.waitFor(/started/);
    cli.signal("SIGKILL");
    await until(() => !alive(pid), "the reparented CLI to exit");
    assert.match(cli.output().stdout, /hangup/);
    await assertCleaned(before);
  });

  await step("one owner per environment; a SIGKILLed owner is recovered", async (before) => {
    const cli = start([
      ...command,
      "exec",
      "-q",
      "--no-stdin",
      "--",
      "sh",
      "-c",
      "echo started; while :; do sleep 0.2; done",
    ]);
    await cli.waitFor(/started/);
    const busy = await run(["exec", "-q", "--", "true"]);
    assert.equal(busy.code, 125);
    assert.match(busy.stderr, /in use by another loom-isolate process/);
    cli.signal("SIGKILL");
    await cli.exited;
    // The supervisor sees its parent go and stops the VM; nothing is left behind.
    await assertCleaned(before, true);
    const after = await run(["exec", "-q", "--", "sh", "-c", "echo recovered"]);
    assert.equal(after.code, 0, after.stderr);
    assert.equal(after.stdout, "recovered\n");
    await assertCleaned(before);
  });

  await step("Loom-owned state is refused without launching", async () => {
    const loom = join(state, "loom/session-vms/0123/session/checkout");
    await Deno.mkdir(loom, { recursive: true });
    for (const target of [loom, root]) {
      const result = await run(["exec", "-q", "-w", target, "--", "true"]);
      assert.equal(result.code, 125);
      assert.match(result.stderr, /Refusing to mount/);
    }
    assert.equal((await listVms(loom, inventory)).vms.length, 0);
  });

  await step("prepare, inspect and cleanup", async (before) => {
    const prepared = await run(["prepare", "-q"]);
    assert.equal(prepared.code, 0, prepared.stderr);
    assert.match(prepared.stdout, /^Prepared /);
    await assertCleaned(before);
    const inspect = JSON.parse((await run(["inspect", "--json"])).stdout);
    assert.equal(inspect.environments[0].record.runtime.artifact, await Deno.realPath(artifact));
    assert.equal(inspect.environments[0].runtime.smolvm, await Deno.realPath(smolvm));
    const cleanup = await run(["cleanup", "--all"]);
    assert.equal(cleanup.code, 0, cleanup.stderr);
    await assert.rejects(Deno.lstat(join(state, "loom-isolate")), Deno.errors.NotFound);
  });

  log(
    "Passed: literal argv, stdio, exit status, mount, egress policy, Ctrl-C, PTY resize, " +
      "parent loss, SIGKILL recovery, owner exclusion, Loom-state refusal, prepare/inspect/cleanup",
  );
} finally {
  await Deno.remove(root, { recursive: true });
}
