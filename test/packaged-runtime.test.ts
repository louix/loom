import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "smol-toml";
import { normalizeConfig } from "@loom/daemon/config/config";
import { decodeManifest, resolveRuntime, runtimeKey } from "../runtime/src/packaged/artifact.ts";
import { prepareRuntime } from "../cli/src/runtime.ts";
import { join } from "node:path";
import { vmArguments, vmEnvironment, type VmBinding } from "../runtime/src/packaged/vm.ts";
import { decodeWorkerRequest } from "../core/src/worker.ts";
import { withExternalMcp } from "../backend/daemon/src/daemon/mcp-provider.ts";
import { FakeProvider } from "@loom/connector-mock";
import { makeLogger } from "@loom/core/logger";
import type { CreateSessionOptions } from "@loom/core/types";

const manifest = {
  version: 1 as const,
  system: "x86_64-linux",
  backend: "smolvm" as const,
  entrypoint: `/nix/store/${"a".repeat(32)}-tool/bin/tool`,
  args: ["--mcp"],
};
test("packaged MCP config rejects ambiguous commands and unsupported permission grants", () => {
  const base =
    '[[command-mcp]]\nname="code"\nruntime="tilth"\nisolation="vm"\ndefault_for=["read","edit"]';
  assert.deepEqual(normalizeConfig(parse(base)).mcp, [
    { name: "code", runtime: "tilth", isolation: "vm", defaultFor: ["read", "edit"] },
  ]);
  for (const extra of [
    '\ncommand="tilth"',
    "\nargs=[]",
    '\nenv={TOKEN="secret"}',
    "\nnetwork=true",
    '\nhosts=["example.com"]',
    "\nmounts=[]",
  ])
    assert.throws(() => normalizeConfig(parse(base + extra)));
  assert.throws(() => normalizeConfig(parse(base.replace('isolation="vm"', 'isolation="host"'))));
  assert.throws(() => normalizeConfig(parse(base.replace('runtime="tilth"', 'command="tilth"'))));
  assert.throws(() => normalizeConfig(parse(base.replace('isolation="vm"', ""))));
});
test("manifest cannot grant authority; VM mount and environment policies are fixed", () => {
  assert.deepEqual(decodeManifest(manifest), manifest);
  for (const extra of [
    { hosts: ["evil"] },
    { mounts: ["/"] },
    { env: { TOKEN: "secret" } },
    { version: 2 },
    { entrypoint: "/bin/sh" },
    { args: [1] },
  ])
    assert.throws(() => decodeManifest({ ...manifest, ...extra }));
  const b: VmBinding = {
    version: 1,
    manifest,
    artifact: `/nix/store/${"b".repeat(32)}-runtime`,
    smolvm: "/backend/bin/smolvm",
    workspace: "/home/test/repo",
    state: "/tmp/loom-vm-test",
    token: "x".repeat(32),
  };
  const args = vmArguments(b);
  assert.ok(args.includes(`${b.workspace}:${b.workspace}`));
  assert.ok(args.includes(`${b.artifact}/nix/store:/nix/store:ro`));
  assert.ok(!args.some((a) => /^--(net|allow|dns)/.test(a)));
  assert.deepEqual(Object.keys(vmEnvironment(b.state)).sort(), [
    "HOME",
    "PATH",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
  ]);
  for (const workspace of ["/", "/nix/store", "/tmp/a:b", "/tmp/a,b", "/proc/self", "/etc"])
    assert.throws(() => vmArguments({ ...b, workspace }));
  assert.throws(() =>
    decodeWorkerRequest({
      kind: "request",
      id: 1,
      method: "create",
      args: [
        {
          sessionId: "s",
          cwd: "/repo",
          prompt: "",
          mode: "default",
          mcpServers: [
            { name: "tilth", spec: { transport: "runtime", runtime: "tilth", isolation: "vm" } },
          ],
        },
      ],
    }),
  );
});
test("missing prepared artifact is actionable and resolution never builds", async () => {
  const home = await Deno.makeTempDir();
  try {
    await assert.rejects(resolveRuntime("tilth", home), /Run loom runtime prepare/);
    assert.deepEqual(await Array.fromAsync(Deno.readDir(home)), []);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
test("prepare never silently replaces a damaged pin", async () => {
  const home = await Deno.makeTempDir();
  try {
    const current = join(home, await runtimeKey("tilth"), "current");
    await Deno.mkdir(current, { recursive: true });
    await Deno.writeTextFile(join(current, "lock.json"), "{}");
    await assert.rejects(
      prepareRuntime("tilth", { home, smolvm: "/must-not-run" }),
      /damaged.*explicitly run loom runtime update/,
    );
    assert.equal(await Deno.readTextFile(join(current, "lock.json")), "{}");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
test("runtime mounts are session-scoped, preserve preferences, and never reach connector unresolved", async () => {
  const seen: CreateSessionOptions[] = [];
  const launched: Array<{ cwd: string; closed: boolean }> = [];
  const fake = new FakeProvider();
  const provider = await withExternalMcp(
    () =>
      new Proxy(fake, {
        get(t, p) {
          if (p === "createSession")
            return (o: CreateSessionOptions) => {
              seen.push(o);
              return t.createSession(o);
            };
          const v = Reflect.get(t, p, t);
          return typeof v === "function" ? v.bind(t) : v;
        },
      }),
    { id: "mock", config: {}, logger: makeLogger("test") },
    undefined,
    async (name, runtime, cwd) => {
      assert.equal(runtime, "tilth");
      const record = { cwd, closed: false };
      launched.push(record);
      return {
        handle: { name, spec: { transport: "http", url: "http://127.0.0.1:1234/mcp" } },
        pid: 1,
        exited: new Promise(() => {}),
        close: async () => {
          record.closed = true;
        },
      };
    },
  );
  const opts: CreateSessionOptions = {
    sessionId: "a",
    cwd: "/repo/session-a",
    prompt: "",
    mode: "default",
    mcpServers: [
      {
        name: "code",
        defaultFor: ["read"],
        spec: { transport: "runtime", runtime: "tilth", isolation: "vm" },
      },
    ],
  };
  const a = await provider.createSession(opts);
  const b = await provider.createSession({ ...opts, sessionId: "b", cwd: "/repo/session-b" });
  assert.deepEqual(
    launched.map((x) => x.cwd),
    ["/repo/session-a", "/repo/session-b"],
  );
  assert.equal(seen[0]?.mcpServers[0]?.spec.transport, "http");
  assert.deepEqual(seen[0]?.mcpServers[0]?.defaultFor, ["read"]);
  await a.close();
  assert.ok(launched[0]?.closed);
  assert.ok(!launched[1]?.closed);
  await b.close();
});
