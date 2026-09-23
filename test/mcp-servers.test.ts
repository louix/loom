import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeConfig, loadConfig } from "@loom/daemon/config/config";
import { mcpGrantsSchema, nixMcpRuntime, parseNixMcpRuntime } from "../core/src/mcp-config.ts";
import {
  vmArguments,
  vmCreateArguments,
  vmExecArguments,
  type VmBinding,
} from "../runtime/src/packaged/vm.ts";
import { mcpBuildExpression, nixString, nixMcpBuildArgs } from "../cli/src/mcp-package.ts";
import { runtimeMcpDiagnostic } from "../backend/daemon/src/daemon/mcp-runtime-diagnostics.ts";
import { runtimeCommand } from "../cli/src/runtime.ts";
import { mcpCommand } from "../cli/src/mcp.ts";

const tilth = {
  source: { kind: "runtime", ref: "tilth" },
  execution: "vm",
  grants: { workspace: "read-write", network: [] },
  default_for: ["read", "edit"],
};
const kagi = {
  source: { kind: "http", url: "https://mcp.kagi.com/mcp" },
  auth: { bearer_token_env: "LOOM_TEST_KAGI_TOKEN" },
  default_for: ["web_search", "web_fetch"],
};
const catalog = { tilth, kagi };

test("Tilth and Kagi definitions resolve only when selected, with independent grants", () => {
  const inert = normalizeConfig({ mcp_servers: catalog });
  assert.deepEqual(inert.mcp, []);
  assert.deepEqual(inert.httpMcp, []);
  assert.equal(Object.keys(inert.mcpServers!).length, 2);
  const selected = normalizeConfig({
    mcp_servers: catalog,
    session: { mcp_servers: ["tilth", "kagi"] },
  });
  assert.deepEqual(selected.mcp, [
    {
      name: "tilth",
      runtime: "tilth",
      isolation: "vm",
      required: true,
      grants: { workspace: "read-write", network: [] },
      defaultFor: ["read", "edit"],
    },
  ]);
  assert.deepEqual(selected.httpMcp, [
    {
      name: "kagi",
      url: "https://mcp.kagi.com/mcp",
      required: true,
      bearerTokenEnv: "LOOM_TEST_KAGI_TOKEN",
      defaultFor: ["web_search", "web_fetch"],
    },
  ]);
  const minimal = normalizeConfig({
    mcp_servers: { minimal: { source: tilth.source, execution: "vm" } },
    session: { mcp_servers: ["minimal"] },
  });
  assert.deepEqual("runtime" in minimal.mcp[0]! && minimal.mcp[0].grants, {
    workspace: "none",
    network: [],
  });
});

test("MCP catalogs reject permissions on remote servers and malformed local grants", () => {
  for (const definition of [
    { ...kagi, grants: {} },
    { ...kagi, execution: "vm" },
    { ...tilth, auth: kagi.auth },
    { source: tilth.source },
    { ...tilth, grants: { workspace: "all" } },
    { ...tilth, grants: { network: ["https://example.com"] } },
    { ...tilth, grants: { network: ["*.example.com"] } },
    { ...tilth, grants: { network: ["127.0.0.1"] } },
    { ...tilth, grants: { mounts: ["/"] } },
    { ...tilth, source: { kind: "nix", ref: "github:org/repo", executable: "../sh" } },
  ])
    assert.throws(() => normalizeConfig({ mcp_servers: { bad: definition } }));
  for (const names of [["missing"], ["tilth", "tilth"]])
    assert.throws(() => normalizeConfig({ mcp_servers: catalog, session: { mcp_servers: names } }));
  assert.throws(
    () =>
      normalizeConfig({
        mcp_servers: catalog,
        vm_tools: { tilth: { runtime: "tilth" } },
        session: { mcp_servers: ["tilth"], vm_tools: ["tilth"] },
      }),
    /multiple groups/,
  );
  assert.deepEqual(mcpGrantsSchema.parse({ network: ["EXAMPLE.com", "example.com"] }).network, [
    "example.com",
  ]);
});

test("repo selections replace without changing running config snapshots", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = dir + "/config.jsonc";
    await Deno.writeTextFile(
      file,
      JSON.stringify({
        mcp_servers: catalog,
        session: { mcp_servers: ["tilth", "kagi"] },
        repos: [{ path: dir, session: { mcp_servers: [] } }],
      }),
    );
    assert.deepEqual(loadConfig(dir, file).mcp, []);
    const before = loadConfig(dir + "/other", file);
    await Deno.writeTextFile(
      file,
      JSON.stringify({ mcp_servers: catalog, session: { mcp_servers: ["kagi"] } }),
    );
    assert.equal(loadConfig(dir + "/other", file).mcp.length, 0);
    assert.equal(before.mcp.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const binding: VmBinding = {
  version: 1,
  workspace: "/home/test/repo",
  mounts: ["/home/test/repo", "/home/test/git"],
  state: "/tmp/loom-test",
  token: "x".repeat(64),
  smolvm: "/backend/bin/smolvm",
  artifact: "/nix/store/runtime",
  manifest: {
    version: 1,
    system: "x86_64-linux",
    backend: "smolvm",
    entrypoint: "/nix/store/tool/bin/tool",
    args: [],
  },
};
test("VM grants enforce no mounts, read-only mounts, and independent network", () => {
  for (const workspace of ["none", "read-only", "read-write"] as const) {
    for (const network of [[], ["example.com"]]) {
      const b = { ...binding, mcpGrants: { workspace, network } };
      const args = vmCreateArguments(b);
      assert.equal(args.includes("--net"), false);
      assert.equal(args.includes("--allow-host"), network.length > 0);
      if (network.length) assert.equal(args[args.indexOf("--allow-host") + 1], "example.com");
      for (const mount of binding.mounts!) {
        assert.equal(args.includes(mount + ":" + mount), workspace === "read-write");
        assert.equal(args.includes(mount + ":" + mount + ":ro"), workspace === "read-only");
      }
      const exec = vmExecArguments(b);
      assert.equal(exec[exec.indexOf("-w") + 1], workspace === "none" ? "/tmp" : binding.workspace);
    }
  }
  const privateBinding = {
    ...binding,
    workspace: "/private/session/checkout",
    privateWorkspace: "/private/session",
    mounts: [],
    mcpGrants: mcpGrantsSchema.parse({ workspace: "read-only" }),
  };
  assert(vmArguments(privateBinding).includes("/private/session:/workspace:ro"));
  assert.throws(() =>
    vmArguments({ ...binding, mcpGrants: { workspace: "none", network: ["--net"] } }),
  );
  assert(!vmCreateArguments(binding).includes("--allow-host")); // legacy and agent policy preserved
});

test("Nix identity excludes grants and executable arguments remain inert Nix data", async () => {
  const source = {
    kind: "nix" as const,
    ref: "github:org/tools/revision#tool",
    executable: "tool",
    args: ['${builtins.abort "injected"}', "a b", "line\nnext", "\\", "$(touch /tmp/nope)"],
  };
  const identity = nixMcpRuntime(source);
  assert.deepEqual(parseNixMcpRuntime(identity), source);
  assert.notEqual(nixMcpRuntime({ ...source, args: [] }), identity);
  assert.equal(parseNixMcpRuntime("tilth"), undefined);
  const expression = mcpBuildExpression({
    ref: source.ref,
    nixpkgs: "github:org/nixpkgs/rev",
    system: "x86_64-linux",
    attribute: "tool",
    helper: "/helper",
    executable: source.executable,
    args: source.args,
  });
  assert(expression.includes("\\\${builtins.abort"));
  const result = await new Deno.Command("nix", {
    args: [
      "--extra-experimental-features",
      "nix-command",
      "eval",
      "--json",
      "--expr",
      "builtins.fromJSON " + nixString(JSON.stringify(source)),
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(result.stdout)), source);
  let calls = 0;
  const build = await nixMcpBuildArgs(source, async (command, args) => {
    calls++;
    assert.equal(command, "nix");
    if (args.at(-1)?.startsWith("path:"))
      return JSON.stringify({
        locked: { narHash: "sha256-helper" },
        url: "path:/helper?narHash=sha256-helper",
      });
    assert(args.includes("github:org/tools/revision"));
    return JSON.stringify({
      locked: { narHash: "sha256-test" },
      url: "github:org/tools/locked-revision",
    });
  });
  assert.equal(calls, 2);
  assert(!build.includes("--impure"));
  assert(build.includes("--expr"));
  assert(build.at(-1)!.includes("locked-revision"));
});

test("named MCP preparation can inspect unselected definitions without connecting HTTP", async () => {
  const dir = await Deno.makeTempDir();
  const previous = Deno.env.get("XDG_CONFIG_HOME");
  const credential = Deno.env.get("LOOM_TEST_KAGI_TOKEN");
  try {
    Deno.env.set("XDG_CONFIG_HOME", dir);
    Deno.env.set("LOOM_TEST_KAGI_TOKEN", "fixture-secret");
    await Deno.mkdir(dir + "/loom");
    await Deno.writeTextFile(dir + "/loom/config.jsonc", JSON.stringify({ mcp_servers: catalog }));
    assert.match(await mcpCommand(["status"], dir, { json: false }), /No MCP servers selected/);
    const result = await mcpCommand(["prepare", "kagi"], dir, { json: true });
    assert.equal(JSON.parse(result)[0].status, "configured");
    assert(!result.includes("fixture-secret"));
    await assert.rejects(mcpCommand(["prepare", "unknown"], dir, { json: false }), /Unknown/);
  } finally {
    if (previous === undefined) Deno.env.delete("XDG_CONFIG_HOME");
    else Deno.env.set("XDG_CONFIG_HOME", previous);
    if (credential === undefined) Deno.env.delete("LOOM_TEST_KAGI_TOKEN");
    else Deno.env.set("LOOM_TEST_KAGI_TOKEN", credential);
    await Deno.remove(dir, { recursive: true });
  }
});

test("inline HTTP credentials survive migration and override environment references", () => {
  const config = normalizeConfig({
    mcp_servers: {
      kagi: { ...kagi, auth: { bearer_token: "fixture-token", bearer_token_env: "MISSING_TOKEN" } },
    },
    session: { mcp_servers: ["kagi"] },
  });
  assert.equal(config.httpMcp[0]!.bearerToken, "fixture-token");
  assert.equal(config.httpMcp[0]!.bearerTokenEnv, "MISSING_TOKEN");
});

test("doctor describes arbitrary MCP names and grants without exposing arguments", async () => {
  const runtime = nixMcpRuntime({
    kind: "nix",
    ref: "github:org/tools/rev#tool",
    executable: "tool",
    args: ["private-argument"],
  });
  for (const workspace of ["none", "read-only", "read-write"] as const) {
    for (const network of [[], ["api.example.com"]]) {
      const server = {
        name: "inspector",
        isolation: "vm" as const,
        runtime,
        required: true,
        grants: { workspace, network },
      };
      const missing = await runtimeMcpDiagnostic(server, () =>
        Promise.reject(new Error(`Runtime ${runtime} missing. Run loom runtime prepare.`)),
      );
      assert.equal(missing.name, "inspector");
      assert.equal(missing.status, "missing");
      assert.match(missing.note!, new RegExp("workspace: " + workspace));
      assert(
        missing.note!.includes(network.length ? "api.example.com (all ports)" : "network disabled"),
      );
      assert(missing.note!.includes("loom mcp prepare inspector"));
      assert(!JSON.stringify(missing).includes("private-argument"));
      const ready = await runtimeMcpDiagnostic(server, () =>
        Promise.resolve({
          lock: {
            version: 1,
            source: runtime,
            artifact: "/artifact",
            smolvm: "/backend",
            preparedAt: "now",
          },
          manifest: binding.manifest,
        }),
      );
      assert.equal(ready.status, "ok");
      assert.equal(ready.resolved, binding.manifest.entrypoint);
    }
  }
});

test("runtime update does not implicitly prepare any server", async () => {
  const dir = await Deno.makeTempDir();
  const keys = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"] as const;
  const before = keys.map((k) => Deno.env.get(k));
  try {
    for (const k of keys) Deno.env.set(k, dir);
    await Deno.mkdir(dir + "/loom");
    await Deno.writeTextFile(dir + "/loom/config.jsonc", "{}");
    assert.deepEqual(JSON.parse(await runtimeCommand(["update"], dir, { json: true })), []);
  } finally {
    keys.forEach((k, i) =>
      before[i] === undefined ? Deno.env.delete(k) : Deno.env.set(k, before[i]!),
    );
    await Deno.remove(dir, { recursive: true });
  }
});
