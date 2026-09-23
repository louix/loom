import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { gitFixture } from "../scripts/lib/git-fixture.ts";
import { changesCommand, vmMonitorText } from "../backend/daemon/src/daemon/session-inspection.ts";
import { executeShellHook } from "../core/src/shell-hook.ts";

test("Changes includes committed, staged, unstaged and untracked files without altering Git state", async () => {
  const f = await gitFixture();
  try {
    await Deno.writeTextFile(join(f.workspace, "committed.txt"), "committed content\n");
    await f.git("-C", f.workspace, "add", ".");
    await f.git("-C", f.workspace, "commit", "-m", "session work");
    await Deno.writeTextFile(join(f.workspace, "staged.txt"), "staged content\n");
    await f.git("-C", f.workspace, "add", "staged.txt");
    await Deno.writeTextFile(join(f.workspace, "file.txt"), "unstaged content\n");
    await Deno.writeTextFile(join(f.workspace, "untracked.txt"), "untracked content\n");
    const before = await f.git("-C", f.workspace, "status", "--porcelain");
    for (const patch of [false, true]) {
      const result = await executeShellHook(
        changesCommand("main", patch),
        f.workspace,
        Deno.env.toObject(),
        15000,
        new AbortController().signal,
      );
      assert.equal(result.code, 0, result.output);
      for (const name of ["committed.txt", "staged.txt", "file.txt", "untracked.txt"])
        assert.ok(result.output.includes(name));
      if (patch) assert.match(result.output, /\+committed content/);
    }
    assert.equal(await f.git("-C", f.workspace, "status", "--porcelain"), before);
    const fallback = await executeShellHook(
      changesCommand("missing-ref", true),
      f.workspace,
      Deno.env.toObject(),
      15000,
      new AbortController().signal,
    );
    assert.equal(fallback.code, 0);
    assert.match(fallback.output, /against HEAD/);
    assert.doesNotMatch(fallback.output, /\+committed content/);
  } finally {
    await f.close();
  }
});

test("VM monitor filters sessions, includes MCPs, and tolerates unavailable counters", async () => {
  const { registerVm, listVms } = await import("../runtime/src/session-vm/inventory.ts");
  const home = await Deno.makeTempDir();
  const owners = [];
  try {
    for (const [sessionId, kind, state] of [
      ["selected", "session", "running"],
      ["selected", "mcp", "running"],
      ["selected", "prepare", "stopped"],
      ["other", "session", "running"],
      ["stopped-only", "session", "stopped"],
    ] as const) {
      owners.push(
        await registerVm(
          {
            version: 1,
            id: crypto.randomUUID(),
            repo: home,
            sessionId,
            kind,
            provider: "test",
            workload: kind === "mcp" ? "tilth" : "working",
            state,
            createdAt: new Date().toISOString(),
            observedAt: new Date().toISOString(),
            stoppedAt: null,
            source: "owner",
            error: null,
            paths: {
              workspace: home,
              runtime: home,
              state: home,
              session: null,
              profile: null,
              backend: null,
              base: null,
            },
          },
          home,
        ),
      );
    }
    const sampled: string[] = [];
    const text = await vmMonitorText(
      home,
      "selected",
      new AbortController().signal,
      (repo) => listVms(repo, home),
      async (vm) => {
        sampled.push(vm.kind);
        if (vm.kind === "mcp") throw new Error("gone");
        return {
          cpuPercent: 25,
          memoryUsed: 1048576,
          memoryTotal: 2097152,
          diskUsed: 3145728,
          diskTotal: 4194304,
        };
      },
    );
    assert.match(text, /AGENT · test/);
    assert.match(text, /MCP · tilth/);
    assert.doesNotMatch(text, /PREPARATION|DAEMON HOST|LOOM DAEMON/);
    assert.match(text, /CPU\s+25.0%/);
    assert.match(text, /RAM\s+1 MiB \/ 2 MiB/);
    assert.match(text, /DISK\s+3 MiB \/ 4 MiB/);
    assert.match(text, /CPU\s+—/);
    assert.deepEqual(sampled.sort(), ["mcp", "session"]);
    const empty = await vmMonitorText(home, "absent", new AbortController().signal, (repo) =>
      listVms(repo, home),
    );
    assert.equal(empty, "No VMs running for this session.");
    const stopped = await vmMonitorText(
      home,
      "stopped-only",
      new AbortController().signal,
      (repo) => listVms(repo, home),
    );
    assert.equal(stopped, empty);
  } finally {
    for (const owner of owners) await owner.finish();
    await Deno.remove(home, { recursive: true });
  }
});

test("guest usage computes interval CPU and available-memory usage", async () => {
  const { parseVmUsage } = await import("../runtime/src/session-vm/usage.ts");
  const usage = parseVmUsage(
    [
      "cpu 100 0 0 100 0 0 0 0 50 0",
      "cpu 125 0 0 175 0 0 0 0 60 0",
      "MemTotal: 2048 kB",
      "MemAvailable: 1024 kB",
      "",
      "DISK",
      "Filesystem 1024-blocks Used Available Capacity Mounted on",
      "/dev/vdb 4096 1024 3072 25% /storage",
    ].join("\n"),
  );
  assert.deepEqual(usage, {
    cpuPercent: 25,
    memoryUsed: 1048576,
    memoryTotal: 2097152,
    diskUsed: 1048576,
    diskTotal: 4194304,
  });
  assert.deepEqual(parseVmUsage("unavailable"), {
    cpuPercent: null,
    memoryUsed: null,
    memoryTotal: null,
    diskUsed: null,
    diskTotal: null,
  });
});

test("VM sampler targets named and ephemeral machines without starting stopped VMs", async () => {
  const { sampleVmUsage } = await import("../runtime/src/session-vm/usage.ts");
  const home = await Deno.makeTempDir();
  try {
    const executable = join(home, "smolvm");
    for (const name of ["loom-session", "vm-abc123"]) {
      await Deno.writeTextFile(
        executable,
        `#!/bin/sh
set -eu
[ "$1" = machine ]
case "$2" in
ls) printf '[{"name":"${name}"}]' ;;
exec)
  [ "$3" = --name ] && [ "$4" = ${name} ]
  printf 'cpu 0 0 0 100\\ncpu 25 0 0 175\\nMemTotal: 2048 kB\\nMemAvailable: 1024 kB\\n'
  ;;
*) exit 1 ;;
esac
`,
      );
      await Deno.chmod(executable, 0o700);
      const vm = {
        version: 1 as const,
        id: "fixture",
        repo: home,
        sessionId: "s",
        kind: "session" as const,
        provider: null,
        workload: "test",
        state: "running" as const,
        smolvm: executable,
        createdAt: "",
        observedAt: "",
        stoppedAt: null,
        source: "owner" as const,
        error: null,
        paths: {
          workspace: home,
          runtime: home,
          state: home,
          session: null,
          profile: null,
          backend: null,
          base: null,
        },
      };
      const signal = new AbortController().signal;
      const usage = await sampleVmUsage(vm, signal);
      assert.equal(usage.cpuPercent, 25);
      assert.equal(usage.memoryUsed, 1048576);
      assert.equal(usage.diskUsed, null);
      await assert.rejects(sampleVmUsage({ ...vm, state: "stopped" }, signal), /unavailable/);
      await assert.rejects(sampleVmUsage(vm, AbortSignal.abort()));
    }
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
