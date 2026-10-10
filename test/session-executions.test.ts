import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { makeHarness } from "@loom/harness";
import { LoomClient } from "@loom/client";
import { FakeProvider } from "@loom/connector-mock";
import { ExecutionLeases } from "@loom/isolation/execution-leases";
import type { ConnectorManifest, SessionExecutions } from "@loom/core/connector";
import type { SessionSnapshot } from "@loom/core/wire";
import type { ExecutionOptions } from "../core/src/execution.ts";
import type { SessionShell } from "../core/src/shell.ts";
import { guestShellArgv } from "../runtime/src/session-vm/shell.ts";
import { sessionVmDirectory } from "../backend/daemon/src/daemon/session-vm-state.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const until = async (check: () => boolean | Promise<boolean>, what: string) => {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error("condition did not settle: " + what);
};

test("session VM shells, hooks and inspection use the environment's leases", async () => {
  const state = await Deno.makeTempDir({ prefix: "loom-executions-" });
  const previous = Deno.env.get("XDG_STATE_HOME");
  Deno.env.set("XDG_STATE_HOME", state);
  const fake = new FakeProvider();
  // The coordinator's leases; the worker's own lease is held throughout, as in the adapter.
  const leases = new ExecutionLeases();
  const commands: Array<{ command: string; env: Record<string, string> }> = [];
  const opened: ExecutionOptions[] = [];
  let published = 0;
  let hooksSettled = 0;
  let withdrawn = 0;
  /** What the adapter publishes for a running environment, run on the host clone. */
  const executions = (id: string, cwd: string): SessionExecutions => ({
    workspace: cwd,
    command: (command, _timeoutMs, signal, env = {}) =>
      leases.run(id, { signal }, async (leased) => {
        commands.push({ command, env });
        const result = await new Deno.Command("sh", {
          args: ["-c", command],
          cwd,
          signal: leased,
          env: Object.fromEntries(
            Object.entries(env).map(([key, value]) => [
              key,
              value.replaceAll("/workspace/checkout", cwd),
            ]),
          ),
        }).output();
        const text = new TextDecoder();
        if (env.LOOM_HOOK) hooksSettled++;
        return {
          code: result.code,
          output: text.decode(result.stdout) + text.decode(result.stderr),
          timedOut: false,
        };
      }),
    open(options, owner) {
      opened.push(options);
      const { token } = leases.acquire(id, owner, true);
      return { token, vm: { executable: "/fake/smolvm", args: ["exec", "--"], env: {} } };
    },
    close: (token, owner) => leases.close(token, owner),
  });
  const connectors: ConnectorManifest = {
    "@loom/connector-claude": async () => ({
      createProvider: (ctx) => {
        const start = async (opts: { sessionId: string; cwd: string }, created: boolean) => {
          if (created) {
            const branch = ctx.vmLifecycle!.clone!(opts.sessionId)!.branch;
            const repo = ctx.config.sessionVm!.repoRoot;
            execFileSync("git", ["clone", "-q", "--no-local", "-b", branch, repo, opts.cwd]);
            git(opts.cwd, "config", "user.name", "test");
            git(opts.cwd, "config", "user.email", "test@localhost");
            // The saved VM history a resume requires.
            const history = join(
              sessionVmDirectory(repo, opts.sessionId),
              "profile/projects/loom-session",
            );
            await Deno.mkdir(history, { recursive: true });
            await Deno.writeTextFile(join(history, `${opts.sessionId}.jsonl`), "{}\n");
          }
          const session = await (created
            ? fake.createSession(opts as never)
            : fake.resumeSession({ ...opts, providerRef: opts.sessionId } as never));
          Object.defineProperty(session, "providerRef", { value: opts.sessionId });
          // Published while the worker runs, withdrawn once it has gone.
          const workerLease = leases.acquire(opts.sessionId, new AbortController());
          const withdraw = ctx.vmLifecycle!.executions!(
            opts.sessionId,
            executions(opts.sessionId, opts.cwd),
          );
          published++;
          const close = session.close.bind(session);
          session.close = async (...args) => {
            withdraw();
            withdrawn++;
            workerLease.release();
            await close(...args);
          };
          return session;
        };
        return {
          id: ctx.id,
          capabilities: fake.capabilities,
          listPersistedSessions: () => fake.listPersistedSessions(),
          createSession: (opts) => start(opts, true),
          resumeSession: (opts) => start(opts, false),
        };
      },
    }),
  };
  const h = await makeHarness({
    connectors,
    config: JSON.stringify({
      session: {
        titles: { enabled: false },
        auto_resume: { enabled: false },
        auto_rebase: { enabled: false },
        isolation: {
          enabled: true,
          claude: { artifact: "/test-runtime" },
          checkout: { mode: "clone" },
        },
      },
      hooks: [
        {
          name: "check edits",
          on: "file_write",
          kind: "check",
          match: "**/*.ts",
          run: 'test -f "$LOOM_FILE"',
        },
      ],
    }),
  });
  const connect = () =>
    LoomClient.connect({
      repoRoot: h.repoRoot,
      sockPath: h.sockPath,
      autospawn: false,
      reconnect: false,
    });
  const c = await connect();
  try {
    const s = await c.request<SessionSnapshot>("session.create", {
      provider: "claude",
      prompt: "work",
    });
    assert.equal(s.isolation, "vm");
    const session = fake.session(s.id)!;
    session.finishTurn();
    await until(() => h.daemon.registry.get(s.id)?.status.kind === "idle", "idle");

    // Inspection runs its Git command in the guest, under a lease.
    const inspection = await c.request<{ text: string }>("session.inspect", {
      id: s.id,
      tab: "changes",
    });
    assert.match(inspection.text, /WORKING TREE\nWorking tree clean/);
    assert(commands.some((call) => call.command.includes("--no-pager diff")));

    // A daemon hook does too, with guest paths.
    await Deno.writeTextFile(join(s.worktree!, "a.ts"), "export {}");
    session.emit({
      type: "tool_call",
      id: "write",
      name: "Write",
      input: { file_path: "/workspace/checkout/a.ts" },
    });
    session.emit({ type: "tool_result", id: "write", ok: true, output: "ok" });
    await until(() => commands.some((call) => call.env.LOOM_HOOK === "check edits"), "hook");
    assert.equal(
      commands.find((call) => call.env.LOOM_HOOK === "check edits")!.env.LOOM_FILE,
      "/workspace/checkout/a.ts",
    );
    await until(() => hooksSettled === 1, "hook finished");
    // A clean checkout: no end-of-turn commit reminder wakes the agent again.
    await Deno.remove(join(s.worktree!, "a.ts"));
    session.finishTurn();
    await until(() => h.daemon.registry.get(s.id)?.status.kind === "idle", "turn ended");
    await delay(50);

    // A shell is a terminal execution beside the worker; the client runs its transport.
    const shell = await c.request<SessionShell>("session.openShell", { id: s.id });
    assert.equal(shell.isolation, "vm");
    assert.deepEqual(shell.vm, { executable: "/fake/smolvm", args: ["exec", "--"], env: {} });
    assert.deepEqual(opened, [{ argv: guestShellArgv, stdin: true, tty: true }]);

    // Idle suspension never stops the environment under an open shell...
    const now = Date.now();
    for (let i = 0; i < 5; i++) await h.daemon.sweepIdleVms(now + i * 11 * 60_000);
    assert.equal(session.closed, false, "an open shell pins the VM");
    // ...and proceeds once it has closed.
    await c.request("session.closeShell", { token: shell.token });
    for (let i = 0; i < 300 && !session.closed; i++) {
      await h.daemon.sweepIdleVms(now + i * 11 * 60_000);
      if (!session.closed) await delay(5);
    }
    assert.equal(session.closed, true, "idle runtime is closed");
    assert.equal(withdrawn, 1);
    assert.equal(leases.has(s.id), false, "no lease outlives the worker");
    // Without a running environment there is no fallback to another transport.
    await assert.rejects(c.request("session.openShell", { id: s.id }), /VM is not running/);
    await assert.rejects(
      c.request("session.inspect", { id: s.id, tab: "changes" }),
      /VM is not running/,
    );

    // After a resume, a shell lease ends with its client's connection.
    await c.request("session.send", { id: s.id, text: "wake" });
    await until(() => published === 2, "resumed");
    fake.session(s.id)!.finishTurn();
    await until(() => h.daemon.registry.get(s.id)?.status.kind === "idle", "idle again");
    const other = await connect();
    await other.request<SessionShell>("session.openShell", { id: s.id });
    await assert.rejects(c.request("session.markDone", { id: s.id }), /open shells/);
    other.close();
    await until(async () => {
      try {
        await c.request("session.markDone", { id: s.id });
        return true;
      } catch {
        return false;
      }
    }, "shell released on disconnect");
    await until(() => !leases.has(s.id), "archived session holds no lease");
    assert.equal(withdrawn, 2);
  } finally {
    c.close();
    await h.cleanup();
    if (previous === undefined) Deno.env.delete("XDG_STATE_HOME");
    else Deno.env.set("XDG_STATE_HOME", previous);
    await Deno.remove(state, { recursive: true });
  }
});
