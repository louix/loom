import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig as parse } from "@loom/daemon/config/config";
import { normalizeConfig } from "@loom/daemon/config/config";
import { decodeManifest, resolveRuntime, runtimeKey } from "../runtime/src/packaged/artifact.ts";
import { prepareRuntime } from "../cli/src/runtime.ts";
import { join } from "node:path";
import {
  vmArguments,
  type VmBinding,
  vmEnvironment,
  vmExecArguments,
  vmCreateArguments,
} from "../runtime/src/packaged/vm.ts";
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
  const base = `{
  "vm_tools": {
    "code": {
      "runtime": "tilth",
      "default_for": [
        "read",
        "edit"
      ]
    }
  },
  "session": {
    "vm_tools": [
      "code"
    ]
  }
}`;
  assert.deepEqual(normalizeConfig(parse(base)).mcp, [
    {
      name: "code",
      required: true,
      runtime: "tilth",
      isolation: "vm",
      defaultFor: ["read", "edit"],
    },
  ]);
  for (const extra of [
    { command: "tilth" },
    { args: [] },
    { env: { TOKEN: "secret" } },
    { network: true },
    { hosts: ["example.com"] },
    { allowed_hosts: ["example.com"] },
    { mounts: [] },
  ]) {
    assert.throws(() =>
      normalizeConfig({
        vm_tools: {
          code: { runtime: "tilth", ...extra },
        },
      }),
    );
  }
  assert.throws(() => normalizeConfig(parse(base.replace('"runtime":', '"command":'))));
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
    { closureFormat: "ext4" },
    { guestImage: "../../host.tar" },
    { guestImage: "debian:latest" },
  ]) {
    assert.throws(() => decodeManifest({ ...manifest, ...extra }));
  }
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
  const imageBinding: VmBinding = {
    ...b,
    manifest: {
      ...manifest,
      closureFormat: "erofs",
      args: ["$(touch /tmp/unsafe)", "a b"],
    },
  };
  assert.deepEqual(decodeManifest(imageBinding.manifest), imageBinding.manifest);
  const imageArgs = vmArguments(imageBinding);
  assert.ok(imageArgs.includes(`${b.artifact}:/run/loom/runtime:ro`));
  assert.ok(!imageArgs.includes(`${b.artifact}/nix/store:/nix/store:ro`));
  for (const command of [imageArgs, vmExecArguments(imageBinding)]) {
    // Provider arguments remain argv entries, never interpolated into the mount script.
    assert.deepEqual(command.slice(-3), [manifest.entrypoint, "$(touch /tmp/unsafe)", "a b"]);
    assert.match(command[command.indexOf("-c") + 1]!, /mount -t erofs -o loop,ro/);
  }
  const guestBinding: VmBinding = {
    ...imageBinding,
    manifest: { ...imageBinding.manifest, guestImage: "guest-image.tar" },
  };
  assert.deepEqual(decodeManifest(guestBinding.manifest), guestBinding.manifest);
  const createArgs = vmCreateArguments(guestBinding);
  assert.equal(createArgs[createArgs.indexOf("--image") + 1], `${b.state}/guest-image.tar`);
  assert(!createArgs.includes("--net"));
  assert(!createArgs.includes(`${b.artifact}:/run/loom/runtime:ro`));
  assert(!createArgs.includes(`${b.artifact}/nix/store:/nix/store:ro`));
  const guestExec = vmExecArguments(guestBinding);
  assert.deepEqual(guestExec.slice(-3), [manifest.entrypoint, "$(touch /tmp/unsafe)", "a b"]);
  assert(!guestExec[guestExec.indexOf("-c") + 1]!.includes("mount -t erofs"));
  assert.deepEqual(Object.keys(vmEnvironment(b.state)).sort(), [
    "HOME",
    "PATH",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
  ]);
  for (const workspace of ["/", "/nix/store", "/tmp/a:b", "/tmp/a,b", "/proc/self", "/etc"]) {
    assert.throws(() => vmArguments({ ...b, workspace }));
  }
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
            {
              name: "tilth",
              spec: { transport: "runtime", runtime: "tilth", isolation: "vm" },
            },
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
          if (p === "createSession") {
            return (o: CreateSessionOptions) => {
              seen.push(o);
              return t.createSession(o);
            };
          }
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
        handle: {
          name,
          spec: { transport: "http", url: "http://127.0.0.1:1234/mcp" },
        },
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
  const b = await provider.createSession({
    ...opts,
    sessionId: "b",
    cwd: "/repo/session-b",
  });
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

test("bundles take precedence, reject mutable updates, and never hide broken package metadata", async () => {
  const { bundledRuntime } = await import("../runtime/src/packaged/artifact.ts");
  const home = await Deno.makeTempDir();
  const before = Deno.env.get("LOOM_BUNDLED_RUNTIMES");
  const file = join(home, "bundle.json");
  try {
    Deno.env.set("LOOM_BUNDLED_RUNTIMES", file);
    const lock = {
      version: 1,
      source: "tilth",
      artifact: `/nix/store/${"a".repeat(32)}-missing-bundle`,
      smolvm: `/nix/store/${"b".repeat(32)}-smolvm/bin/smolvm`,
      preparedAt: "bundled",
    };
    await Deno.writeTextFile(file, JSON.stringify({ tilth: lock }));
    assert.deepEqual(await bundledRuntime("tilth"), lock);
    assert.equal(await bundledRuntime("external"), undefined);
    await assert.rejects(prepareRuntime("tilth", { home, update: true }), /bundled.*upgrade loom/);
    // A broken bundle is an installation error, not permission to use a mutable pin.
    const current = join(home, await runtimeKey("tilth"), "current");
    await Deno.mkdir(current, { recursive: true });
    await Deno.writeTextFile(join(current, "lock.json"), "invalid development pin");
    await assert.rejects(resolveRuntime("tilth", home), /Upgrade the Loom Nix package/);
    await assert.rejects(resolveRuntime("external", home), /Run loom runtime prepare/);
    await Deno.writeTextFile(file, JSON.stringify({ tilth: null }));
    await assert.rejects(resolveRuntime("tilth", home), /Invalid bundled runtime entry/);
  } finally {
    if (before === undefined) Deno.env.delete("LOOM_BUNDLED_RUNTIMES");
    else Deno.env.set("LOOM_BUNDLED_RUNTIMES", before);
    await Deno.remove(home, { recursive: true });
  }
});
