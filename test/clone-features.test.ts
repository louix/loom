import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { makeHarness } from "@loom/harness";
import { LoomClient } from "@loom/client";
import { FakeProvider } from "@loom/connector-mock";
import type { ConnectorManifest } from "@loom/core/connector";
import type { SessionSnapshot } from "@loom/core/wire";
import { setTimeout as delay } from "node:timers/promises";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error("condition did not settle");
};
test("clone daemon routes auto/manual rebase, dirty reminders and checks through guest execution", async () => {
  const fake = new FakeProvider();
  let cwd = "",
    branch = "",
    repo = "";
  let holdSync: Promise<void> | undefined;
  const connectors: ConnectorManifest = {
    "@loom/connector-claude": async () => ({
      createProvider: (ctx) => ({
        id: ctx.id,
        capabilities: fake.capabilities,
        listPersistedSessions: () => fake.listPersistedSessions(),
        createSession: async (opts) => {
          cwd = opts.cwd;
          repo = ctx.config.sessionVm!.repoRoot;
          branch = ctx.vmLifecycle!.clone!(opts.sessionId)!.branch;
          execFileSync("git", ["clone", "--no-local", "-b", branch, repo, cwd]);
          git(cwd, "config", "user.name", "test");
          git(cwd, "config", "user.email", "test@localhost");
          return fake.createSession(opts);
        },
        resumeSession: (opts) => fake.resumeSession(opts),
      }),
    }),
  };
  const calls: Array<{ command: string; env: Record<string, string> }> = [];
  const h = await makeHarness({
    connectors,
    guestCommand: async (s, command, _timeout, signal, env = {}) => {
      assert.equal(s.worktree, cwd);
      calls.push({ command, env });
      if (command.includes("git fetch") && holdSync) await holdSync;
      // The fake transport substitutes the guest path; production uses machine exec.
      const mapped = Object.fromEntries(
        Object.entries(env).map(([k, v]) => [k, v.replaceAll("/workspace/checkout", cwd)]),
      );
      const r = await new Deno.Command("sh", {
        args: ["-c", command],
        cwd,
        signal,
        env: mapped,
      }).output();
      return {
        code: r.code,
        output: new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr),
        timedOut: false,
      };
    },
    config: JSON.stringify({
      session: {
        titles: { enabled: false },
        auto_resume: { enabled: false },
        auto_rebase: { enabled: true },
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
          run: 'test -f "$LOOM_FILE"; echo guest-check-failed; exit 1',
        },
      ],
    }),
  });
  const c = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
  });
  const messages: string[] = [];
  c.onPush((f) => {
    if (f.type === "event" && (f.event as { type?: string }).type === "user_message")
      messages.push((f.event as { text: string }).text);
  });
  try {
    const s = await c.request<SessionSnapshot>("session.create", {
      provider: "claude",
      prompt: "test",
    });
    const session = fake.session(s.id)!;
    git(repo, "commit", "--allow-empty", "-m", "advanced base");
    session.finishTurn();
    await until(() => git(repo, "rev-parse", branch) === git(repo, "rev-parse", "main"));
    await until(
      async () => !(await c.request<SessionSnapshot>("session.get", { id: s.id })).git?.dirty,
    );
    assert(calls.some((c) => c.command.includes("git fetch")));
    // Manual r follows the same route after the base moves again.
    git(repo, "commit", "--allow-empty", "-m", "manual base");
    let release!: () => void;
    holdSync = new Promise<void>((resolve) => {
      release = resolve;
    });
    const syncing = c.request<{ outcome: string }>("session.rebase", { id: s.id });
    await until(() => calls.filter((c) => c.command.includes("git fetch")).length >= 2);
    await assert.rejects(
      c.request("session.send", { id: s.id, text: "race rebase" }),
      /workspace operation/,
    );
    release();
    holdSync = undefined;
    const rebased = await syncing;
    assert.equal(rebased.outcome, "updated");
    await Deno.writeTextFile(join(cwd, "scratch"), "private untracked work");
    session.emit({ type: "assistant_text", text: "done" });
    await until(() => h.daemon.registry.get(s.id)?.status.kind === "running");
    session.finishTurn();
    await until(() => messages.some((m) => m.includes("This turn ended with uncommitted changes")));
    const dirty = await c.request<SessionSnapshot>("session.get", { id: s.id });
    assert.equal(dirty.git?.dirty, true);
    assert(calls.some((c) => c.command.includes("git status --porcelain")));
    // A check runs with guest paths and no forwarded host environment.
    await Deno.writeTextFile(join(cwd, "a.ts"), "export {}");
    session.emit({
      type: "tool_call",
      id: "write",
      name: "Write",
      input: { file_path: "/workspace/checkout/a.ts" },
    });
    session.emit({ type: "tool_result", id: "write", ok: true, output: "ok" });
    await until(() => calls.some((c) => c.env.LOOM_HOOK === "check edits"));
    const check = calls.find((c) => c.env.LOOM_HOOK === "check edits")!;
    assert.equal(check.env.LOOM_FILE, "/workspace/checkout/a.ts");
    assert.equal(check.env.LOOM_WORKTREE, "/workspace/checkout");
    assert.equal(check.env.HOME, undefined);
    await until(() => messages.some((m) => m.includes("guest-check-failed")));
    await assert.rejects(c.request("session.rebase", { id: s.id }), /Wait for the agent/);
  } finally {
    c.close();
    await h.cleanup();
  }
});
