/** Real smolvm/tilth spike. Run explicitly; never part of the ordinary unit suite. */
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { FrameWriter, readFrames } from "../../runtime/src/worker/transport.ts";

const [runtimeArg, smolvmArg] = Deno.args;
if (!runtimeArg || !smolvmArg)
  throw new Error("Usage: deno run -A spikes/tilth-vm/smoke.ts RUNTIME_DIR SMOLVM_EXECUTABLE");
const runtime = await Deno.realPath(runtimeArg);
const smolvm = resolve(smolvmArg);
const entrypoint = (await Deno.readTextFile(join(runtime, "entrypoint"))).trim();
const paths = (await Deno.readTextFile(join(runtime, "store-paths"))).trim().split("\n");
assert.ok(paths.every((p) => p.startsWith("/nix/store/")));
// Keep agent socket paths below Unix's length limit, even inside a nested nix shell.
const scratch = await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-vm-" });
const workspace = join(scratch, "workspace");
for (const dir of [workspace, ...["home", "cache", "data", "config"].map((p) => join(scratch, p))])
  await Deno.mkdir(dir);
await Deno.writeTextFile(join(workspace, "sample.ts"), "export const greeting = 'hello';\n");
await Deno.writeTextFile(join(scratch, "host-only-secret"), "dummy-host-secret");
await Deno.symlink(join(scratch, "host-only-secret"), join(workspace, "outside-link"));
const env = {
  HOME: join(scratch, "home"),
  XDG_CACHE_HOME: join(scratch, "cache"),
  XDG_DATA_HOME: join(scratch, "data"),
  XDG_CONFIG_HOME: join(scratch, "config"),
  PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
};
const prefix = [
  "machine",
  "run",
  "--cpus",
  "1",
  "--mem",
  "512",
  "--timeout",
  "30s",
  "-v",
  `${runtime}/nix/store:/nix/store:ro`,
  "-v",
  `${workspace}:/workspace`,
  "-w",
  "/workspace",
  "-e",
  "HOME=/tmp/tilth-home",
  "-e",
  "XDG_CACHE_HOME=/tmp/tilth-cache",
];
const command = (args: string[]) =>
  new Deno.Command(smolvm, { args, clearEnv: true, env, cwd: scratch });
const run = async (args: string[]) => {
  const r = await command(args).output();
  if (!r.success)
    throw new Error(`smolvm failed (${r.code}): ${new TextDecoder().decode(r.stderr)}`);
  return new TextDecoder().decode(r.stdout);
};
const waitForCleanup = async () => {
  const deadline = Date.now() + 5000;
  for (;;) {
    const remaining = JSON.parse(await run(["machine", "ls", "--json"]));
    if (!remaining.length || Date.now() >= deadline) return remaining;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
const report: Record<string, unknown> = {
  runtime,
  entrypoint,
  closurePaths: paths.length,
  architecture: Deno.build.arch,
  smolvm: (await run(["--version"])).trim(),
};
try {
  console.error("Checking network policy...");
  const host = Deno.networkInterfaces().find(
    (i) => i.family === "IPv4" && !i.address.startsWith("127."),
  )?.address;
  assert.ok(host, "A non-loopback IPv4 address is required for the network positive control");
  let requests = 0;
  const server = Deno.serve({ hostname: host, port: 0, onListen() {} }, () => {
    requests++;
    return new Response("loom-network-control");
  });
  try {
    const wget = [
      "--",
      "/bin/busybox",
      "wget",
      "-q",
      "-T",
      "2",
      "-O",
      "-",
      `http://${host}:${server.addr.port}/`,
    ];
    assert.equal(
      await run([...prefix, "--allow-cidr", `${host}/32`, ...wget]),
      "loom-network-control",
    );
    const before = requests;
    const denied = await command([...prefix, ...wget]).output();
    assert.ok(!denied.success, "network-disabled guest unexpectedly reached host");
    assert.match(new TextDecoder().decode(denied.stderr), /Network unreachable/);
    assert.equal(requests, before);
    report.network = "positive control reached host; default guest network unreachable";
  } finally {
    await server.shutdown();
  }
  // Native code probes run as guest root: stronger than testing tilth's own path checks.
  console.error("Checking guest filesystem and executable...");
  const probe = `set -eu
mkdir -p /tmp/tilth-home /tmp/tilth-cache
test -f /workspace/sample.ts
test ! -e '${scratch}/host-only-secret'
test ! -e /workspace/outside-link
test ! -e /home/user/.config/loom/config.toml
test ! -e /nix/var/nix/daemon-socket/socket
if touch /nix/store/loom-must-not-write 2>/dev/null; then exit 31; fi
printf 'store-count='; ls /nix/store | wc -l
printf 'version='; '${entrypoint}' --version
`;
  const checks = await run([...prefix, "--", "/bin/sh", "-c", probe]);
  assert.match(checks, new RegExp(`store-count=\\s*${paths.length}\\b`));
  report.guestChecks = checks.trim();
  console.error("Checking tilth MCP...");
  const child = new Deno.Command(smolvm, {
    args: [...prefix, "-i", "--", entrypoint, "--mcp", "--edit"],
    clearEnv: true,
    env,
    cwd: scratch,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const stderr = new Response(child.stderr).text();
  const writer = new FrameWriter(child.stdin);
  const frames = readFrames(child.stdout, (v) => v as Record<string, any>);
  let id = 0;
  const rpc = async (method: string, params: unknown = {}) => {
    const current = ++id;
    await writer.send({ jsonrpc: "2.0", id: current, method, params });
    for (;;) {
      const next = await frames.next();
      if (next.done) throw new Error(`tilth EOF during ${method}: ${await stderr}`);
      if (next.value.id !== current) continue;
      if (next.value.error) throw new Error(JSON.stringify(next.value.error));
      return next.value.result;
    }
  };
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* Already exited. */
    }
  }, 35_000);
  let exitStatus: Deno.CommandStatus | undefined;
  try {
    const initialized = await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "loom-vm-spike", version: "1" },
    });
    report.server = initialized.serverInfo;
    await writer.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const list = await rpc("tools/list");
    report.tools = list.tools.map((t: { name: string }) => t.name);
    const call = async (name: string, args: unknown) => {
      const result = await rpc("tools/call", { name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result));
      return result.content
        .filter((c: { type: string }) => c.type === "text")
        .map((c: { text: string }) => c.text)
        .join("\n") as string;
    };
    const read = await call("tilth_read", { path: "/workspace/sample.ts" });
    assert.match(read, /export const greeting = 'hello';/);
    const anchor = read.match(/\b(1:[a-zA-Z0-9]+)\|/);
    assert.ok(anchor, `missing hashline anchor: ${read}`);
    await call("tilth_write", {
      files: [
        {
          path: "/workspace/sample.ts",
          mode: "hash",
          edits: [{ start: anchor[1], content: "export const greeting = 'edited';" }],
        },
      ],
    });
    assert.equal(
      await Deno.readTextFile(join(workspace, "sample.ts")),
      "export const greeting = 'edited';\n",
    );
    await call("tilth_write", {
      files: [
        {
          path: "/workspace/generated.ts",
          mode: "overwrite",
          content: "export const created = true;\n",
        },
      ],
    });
    assert.equal(
      await Deno.readTextFile(join(workspace, "generated.ts")),
      "export const created = true;\n",
    );
    assert.match(
      await call("tilth_search", { query: "greeting", kind: "content", root: "/workspace" }),
      /edited/,
    );
    for (const path of [join(scratch, "host-only-secret"), "/workspace/outside-link"]) {
      const denied = await rpc("tools/call", { name: "tilth_read", arguments: { path } });
      assert.equal(denied.isError, true, JSON.stringify(denied));
      assert.ok(!JSON.stringify(denied).includes("dummy-host-secret"));
    }
    report.mcpChecks = [
      "initialize",
      "tools/list",
      "read",
      "hash edit",
      "create",
      "search",
      "host path denied",
      "symlink escape denied",
    ];
  } finally {
    const closing = performance.now();
    await writer.close().catch(() => {});
    exitStatus = await child.status;
    report.stdinCloseMs = Math.round(performance.now() - closing);
    clearTimeout(timer);
    await frames.return(undefined).catch(() => {});
  }
  assert.ok(exitStatus?.success, `tilth VM exit ${exitStatus?.code}: ${await stderr}`);
  report.remainingMachines = await waitForCleanup();
  assert.deepEqual(report.remainingMachines, []);
  console.log(JSON.stringify(report, null, 2));
} finally {
  const remaining = await waitForCleanup();
  if (remaining.length) console.error(`VMs remain; preserving private state in ${scratch}`);
  // Fixture only; never delete files underneath a surviving guest.
  else await Deno.remove(scratch, { recursive: true });
}
