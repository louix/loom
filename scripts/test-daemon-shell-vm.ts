/**
 * Interactive `loom shell` into a VM session of a real in-process daemon, driven
 * through a real PTY (script(1)): prompt and TTY, window resize, Ctrl-C at
 * the shell, exit status, and the shell's lease ending without disturbing the
 * worker.
 *
 * The session is an AISDK VM session whose endpoint never resolves: its one
 * turn fails without credentials or provider traffic, and the worker stays up. All daemon, VM and worktree state stays under a disposable root.
 *
 * Usage: deno run -A scripts/test-daemon-shell-vm.ts <session-runtime> <smolvm>
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { LoomClient } from "@loom/client";
import { setLogLevel } from "@loom/core/logger";
import type { SessionSnapshot } from "@loom/core/wire";
import type { SessionShell } from "../core/src/shell.ts";
import { Daemon } from "../backend/daemon/src/daemon/daemon.ts";
import { CONNECTORS } from "../cli/src/connectors.ts";
import { listVms } from "../runtime/src/session-vm/inventory.ts";
import { gitFixture } from "./lib/git-fixture.ts";
import { hostProcesses, ptyCommand, resizeTerminal } from "./lib/host-processes.ts";

const [runtime, backend] = Deno.args;
assert(runtime && backend, "Pass a rebuilt session runtime and smolvm");
const artifact = await Deno.realPath(runtime);
const smolvm = await Deno.realPath(backend);
setLogLevel("error");
const f = await gitFixture();
// The daemon's state, config, worktrees, socket and VM inventory: all private.
for (const [name, dir] of [
  ["XDG_STATE_HOME", "state"],
  ["XDG_CONFIG_HOME", "config"],
  ["XDG_DATA_HOME", "data"],
  ["XDG_RUNTIME_DIR", "run"],
] as const) {
  await Deno.mkdir(join(f.root, dir), { recursive: true, mode: 0o700 });
  Deno.env.set(name, join(f.root, dir));
}
await Deno.mkdir(join(f.root, "config/loom"), { recursive: true });
await Deno.writeTextFile(
  join(f.root, "config/loom/config.jsonc"),
  JSON.stringify({
    session: {
      titles: { enabled: false },
      auto_resume: { enabled: false },
      isolation: { enabled: true, aisdk: { artifact, smolvm } },
    },
    providers: {
      openai_compatible: {
        profiles: {
          // .invalid never resolves: the first turn fails at the egress proxy.
          fixture: {
            base_url: "https://loom-fixture.invalid/v1",
            api_key: "disposable-test-key",
            model: "fixture",
          },
        },
      },
    },
  }),
);

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
/** `smolvm machine exec -t` processes that loom shell started in this workspace. */
const terminalExecs = async (workspace: string) =>
  (await hostProcesses({ cwd: true }))
    .filter(({ argv, cwd }) => argv.includes("exec") && argv.includes("-t") && cwd === workspace)
    .map(({ pid }) => pid);
/** The terminal device `loom shell` runs on inside script's PTY. */
const loomTerminal = async (repo: string) =>
  (await hostProcesses({ tty: true })).find(
    ({ text, tty }) =>
      text.includes("cli/src/loom.ts") &&
      text.includes(repo) &&
      /^\/dev\/(?:pts\/|ttys)\d+$/.test(tty ?? ""),
  )?.tty;

let daemon: Daemon | undefined;
let client: LoomClient | undefined;
let passed = false;
try {
  daemon = await Daemon.start({ repoRoot: f.repo, standalone: true, connectors: CONNECTORS });
  client = await LoomClient.connect({
    repoRoot: f.repo,
    sockPath: daemon.sockPath,
    autospawn: false,
  });
  const s = await client.request<SessionSnapshot>("session.create", {
    provider: "fixture",
    prompt: "hello",
    worktree: true,
    isolation: "vm",
  });
  const deadline = Date.now() + 240_000;
  while (daemon.registry.get(s.id)?.status.kind === "starting") {
    assert(Date.now() < deadline, "the VM session did not start");
    await delay(100);
  }
  const running = async () =>
    (await listVms(await Deno.realPath(f.repo))).vms.some(
      (vm) => vm.sessionId === s.id && vm.state === "running",
    );
  assert(await running(), "the session VM runs");
  const workspace = await Deno.realPath(s.worktree!);
  const before = await terminalExecs(workspace);

  const pty = ptyCommand(
    [
      Deno.execPath(),
      "run",
      "-A",
      fileURLToPath(new URL("../cli/src/loom.ts", import.meta.url)),
      "--repo",
      f.repo,
      "shell",
      s.id.slice(0, 8),
    ]
      .map(quote)
      .join(" "),
  );
  const p = new Deno.Command(pty.command, {
    args: pty.args,
    env: { TERM: "xterm-256color" },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let output = "";
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    for await (const bytes of stream) output += new TextDecoder().decode(bytes);
  };
  const drains = Promise.all([drain(p.stdout), drain(p.stderr)]);
  const writer = p.stdin.getWriter();
  const send = (text: string) => writer.write(new TextEncoder().encode(text));
  let exited = false;
  void p.status.then(() => (exited = true));
  const timer = setTimeout(() => p.kill("SIGKILL"), 120_000);
  const waitFor = async (pattern: RegExp, what: string) => {
    while (!pattern.test(output)) {
      if (exited) throw new Error(`Terminal ended before ${what}:\n${output}`);
      await delay(20);
    }
  };
  try {
    await waitFor(/Session \w+ · VM ·/, "the VM banner");
    await waitFor(/[$#>] $/m, "a shell prompt");
    await send("printf 'LOOM_%s\\n' READY\n");
    await waitFor(/LOOM_READY/, "the shell");
    await send("pwd; test -t 0 && test -t 1 && printf 'LOOM_%s\\n' TTY\n");
    await waitFor(/LOOM_TTY/, "a guest TTY");
    assert(output.includes(workspace), output);
    const execs = (await terminalExecs(workspace)).filter((pid) => !before.includes(pid));
    assert.equal(execs.length, 1, "one terminal execution for the shell");
    console.log("prompt, TTY and workspace: ok");

    // Resize the PTY loom shell runs on; the guest terminal must follow.
    const tty = await loomTerminal(f.repo);
    assert(tty, "found loom shell's terminal");
    for (const [rows, cols] of [
      [41, 133],
      [17, 61],
    ]) {
      const stty = await resizeTerminal(tty, rows!, cols!);
      assert(stty.success, new TextDecoder().decode(stty.stderr));
      await delay(300);
      await send("printf 'LOOM_SIZE %s\\n' \"$(stty size)\"\n");
      await waitFor(new RegExp(`LOOM_SIZE ${rows} ${cols}`), `size ${rows}x${cols}`);
    }
    console.log("resize: ok");

    // Ctrl-C reaches the guest's foreground job, not loom shell or its lease.
    output = "";
    const started = Date.now();
    await send("sleep 30; printf 'LOOM_%s\\n' UNINTERRUPTED\n");
    await delay(1000);
    await send("\x03");
    await delay(300);
    await send("printf 'LOOM_%s\\n' SURVIVED\n");
    await waitFor(/LOOM_SURVIVED/, "the shell after Ctrl-C");
    assert(Date.now() - started < 20_000, "Ctrl-C interrupted the guest job");
    assert(!output.includes("LOOM_UNINTERRUPTED"), output);
    assert.equal(exited, false);
    console.log("Ctrl-C: ok");

    // The guest shell's exit status is loom shell's.
    await send("exit 7\n");
    assert.equal((await p.status).code, 7, output);
    console.log("exit status: ok");
  } finally {
    clearTimeout(timer);
    await writer.close().catch(() => {});
    try {
      p.kill("SIGKILL");
    } catch {
      /* exited */
    }
    await drains;
  }

  // The shell's execution ended and its lease went with it; the worker did not.
  for (let i = 0; (await terminalExecs(workspace)).some((pid) => !before.includes(pid)); i++) {
    assert(i < 100, "the shell's terminal execution outlived loom shell");
    await delay(100);
  }
  assert(await running(), "the session VM still runs");
  // This needs the worker's live executions.
  const again = await client.request<SessionShell>("session.openShell", { id: s.id });
  assert.equal(again.isolation, "vm");
  await client.request("session.closeShell", { token: again.token });
  console.log("lease released, worker unaffected: ok");
  await client.request("session.markDone", { id: s.id });
  passed = true;
} finally {
  await client?.close();
  await daemon?.stop("shell-test");
  const { vms } = await listVms(await Deno.realPath(f.repo));
  const live = vms.filter((vm) => vm.state !== "stopped");
  if (live.length) console.error("VMs still recorded: " + JSON.stringify(live));
  if (passed && !live.length) await f.close();
  else console.error("Retained fixture: " + f.root);
  if (live.length) Deno.exitCode = 1;
}
console.log("Passed: loom shell in a real PTY");
