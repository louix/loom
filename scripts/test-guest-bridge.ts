/** Opt-in transport prototype. The forwarded socket is a dummy service, never an SSH agent. */
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { inspectArtifact } from "../runtime/src/packaged/artifact.ts";
import { vmArguments, vmEnvironment, reapVm, type VmBinding } from "../runtime/src/packaged/vm.ts";

const [artifactArg, smolvmArg] = Deno.args;
if (!artifactArg || !smolvmArg)
  throw new Error("Usage: deno run -A scripts/test-guest-bridge.ts ARTIFACT SMOLVM_EXECUTABLE");
const artifact = await Deno.realPath(artifactArg);
const manifest = await inspectArtifact(artifact);
const smolvm = resolve(smolvmArg);
const scratch = await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-bridge-" });
const report: Array<Record<string, unknown>> = [];
let completed = false;

const endpoint = async (session: string) => {
  const dir = join(scratch, session);
  await Deno.mkdir(dir, { mode: 0o700 });
  const path = join(dir, "bridge.sock");
  const listener = Deno.listen({ transport: "unix", path });
  await Deno.chmod(path, 0o600);
  const connections = new Set<Deno.UnixConn>();
  const tasks = new Set<Promise<void>>();
  let accepted = 0;
  const serving = (async () => {
    try {
      for await (const conn of listener) {
        connections.add(conn);
        const task = (async () => {
          const timer = setTimeout(() => {
            try {
              conn.close();
            } catch {
              /* closed */
            }
          }, 5000);
          try {
            const buffer = new Uint8Array(4096);
            let size = 0;
            while (size < buffer.length) {
              const n = await conn.read(buffer.subarray(size));
              if (n === null) return;
              size += n;
              const newline = buffer.subarray(0, size).indexOf(10);
              if (newline < 0) continue;
              let response: unknown = { error: "unsupported request" };
              try {
                const request = JSON.parse(
                  new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, newline)),
                );
                if (
                  request?.op === "ping" &&
                  typeof request.nonce === "string" &&
                  Object.keys(request).every((k) => ["op", "nonce"].includes(k))
                ) {
                  accepted++;
                  response = { session, nonce: request.nonce };
                }
              } catch {
                /* Malformed frames receive the same bounded rejection. */
              }
              const bytes = new TextEncoder().encode(JSON.stringify(response) + "\n");
              let offset = 0;
              while (offset < bytes.length) offset += await conn.write(bytes.subarray(offset));
              return;
            }
          } catch (error) {
            if (
              !(error instanceof Deno.errors.BadResource) &&
              !(error instanceof Deno.errors.BrokenPipe) &&
              !(error instanceof Deno.errors.ConnectionReset)
            )
              throw error;
          } finally {
            clearTimeout(timer);
            connections.delete(conn);
            try {
              conn.close();
            } catch {
              /* closed */
            }
          }
        })();
        tasks.add(task);
        void task.finally(() => tasks.delete(task)).catch(() => {});
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.BadResource)) throw error;
    }
  })();
  return {
    dir,
    path,
    session,
    get accepted() {
      return accepted;
    },
    close: async () => {
      listener.close();
      for (const conn of connections) {
        try {
          conn.close();
        } catch {
          /* closed */
        }
      }
      await serving;
      const results = await Promise.allSettled(tasks);
      for (const result of results) if (result.status === "rejected") throw result.reason;
    },
  };
};
const a = await endpoint("session-a");
const b = await endpoint("session-b");
const states: VmBinding[] = [];
try {
  for (const service of [a, b]) {
    const state = await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-vm-" });
    for (const dir of ["home", "cache", "data", "config"]) await Deno.mkdir(join(state, dir));
    const workspace = join(scratch, service.session + "-workspace");
    await Deno.mkdir(workspace);
    states.push({
      version: 1,
      artifact,
      smolvm,
      manifest,
      workspace,
      state,
      token: "unused-transport-prototype",
    });
  }
  const run = async (index: number, forward: boolean, command: string[], extra: string[] = []) => {
    const binding = states[index]!;
    const service = index === 0 ? a : b;
    const args = vmArguments(binding);
    const prefix = args.slice(0, args.indexOf("--")).filter((arg) => arg !== "-i");
    try {
      return await new Deno.Command(smolvm, {
        args: [
          ...prefix,
          "--timeout",
          "15s",
          ...(forward ? ["--ssh-agent"] : []),
          ...extra,
          "--",
          ...command,
        ],
        clearEnv: true,
        env: { ...vmEnvironment(binding.state), SSH_AUTH_SOCK: service.path },
        cwd: binding.state,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
    } finally {
      await reapVm(binding);
    }
  };
  const decoded = (r: Deno.CommandOutput) => {
    assert.ok(r.success, new TextDecoder().decode(r.stderr));
    return JSON.parse(new TextDecoder().decode(r.stdout));
  };
  const request = JSON.stringify({ op: "ping", nonce: "guest-request" });
  const probe = (kind: string, target: string, payload = request) => [
    manifest.entrypoint,
    kind,
    target,
    payload,
  ];
  // The host listener itself must be live before the failed shared-socket test.
  const local = await Deno.connect({ transport: "unix", path: a.path });
  try {
    await local.write(new TextEncoder().encode(request + "\n"));
    const bytes = new Uint8Array(4096);
    const n = await local.read(bytes);
    assert.ok(n);
    assert.equal(JSON.parse(new TextDecoder().decode(bytes.subarray(0, n))).session, a.session);
  } finally {
    local.close();
  }
  let before = a.accepted;
  const shared = await run(
    0,
    false,
    [
      "/bin/sh",
      "-c",
      'test -S /control/bridge.sock && exec "$@"',
      "shared-unix",
      ...probe("unix", "/control/bridge.sock"),
    ],
    ["-v", `${a.dir}:/control:ro`],
  );
  assert.equal(shared.code, 3, new TextDecoder().decode(shared.stderr));
  assert.equal(a.accepted, before);
  report.push({
    check: "plain shared Unix socket",
    result: "connect refused; host listener remained unreachable",
  });
  const disabled = await run(0, false, probe("vsock", "6001"));
  assert.equal(disabled.code, 3, new TextDecoder().decode(disabled.stderr));
  assert.equal(a.accepted, before);
  report.push({ check: "unconfigured vsock port", result: "denied" });
  assert.deepEqual(decoded(await run(0, true, probe("vsock", "6001"))), {
    session: a.session,
    nonce: "guest-request",
  });
  assert.deepEqual(decoded(await run(0, true, probe("unix", "/tmp/ssh-agent.sock"))), {
    session: a.session,
    nonce: "guest-request",
  });
  report.push({
    check: "vsock and guest-local Unix relay",
    result: "both reached the chosen dummy endpoint",
  });
  const malformed = await run(0, true, probe("vsock", "6001", '{"op":"git","argv":["status"]}'));
  assert.deepEqual(decoded(malformed), { error: "unsupported request" });
  assert.deepEqual(
    decoded(
      await run(
        0,
        true,
        probe(
          "vsock",
          "6001",
          JSON.stringify({ op: "ping", nonce: "wrong-session", session: b.session }),
        ),
      ),
    ),
    { error: "unsupported request" },
  );
  before = a.accepted;
  const unmapped = await run(0, true, probe("vsock", "65000"));
  assert.equal(unmapped.code, 3, new TextDecoder().decode(unmapped.stderr));
  assert.equal(a.accepted, before);
  report.push({ check: "unmapped port and unsupported/retargeted requests", result: "denied" });
  const host = Deno.networkInterfaces().find(
    (i) => i.family === "IPv4" && !i.address.startsWith("127."),
  )?.address;
  assert.ok(host, "IP negative control requires a reachable non-loopback IPv4 address");
  let httpHits = 0;
  const http = Deno.serve({ hostname: host, port: 0, onListen() {} }, () => {
    httpHits++;
    return new Response("ip-control");
  });
  try {
    const wget = [
      "/bin/busybox",
      "wget",
      "-q",
      "-T",
      "2",
      "-O",
      "-",
      `http://${host}:${http.addr.port}/`,
    ];
    const allowed = await run(0, true, wget, ["--allow-cidr", `${host}/32`]);
    assert.ok(allowed.success, new TextDecoder().decode(allowed.stderr));
    assert.equal(new TextDecoder().decode(allowed.stdout), "ip-control");
    const count = httpHits;
    const denied = await run(0, true, [
      "/bin/sh",
      "-c",
      '"$1" vsock 6001 "$2" && shift 2 && exec "$@"',
      "vsock-and-no-ip",
      manifest.entrypoint,
      request,
      ...wget,
    ]);
    assert.ok(!denied.success);
    assert.match(new TextDecoder().decode(denied.stdout), /session-a/);
    assert.match(new TextDecoder().decode(denied.stderr), /Network unreachable/);
    assert.equal(httpHits, count);
    report.push({
      check: "vsock works while IP is disabled",
      result: "passed with IP positive control",
    });
  } finally {
    await http.shutdown();
  }
  const concurrent = await Promise.all([
    run(0, true, probe("vsock", "6001")),
    run(1, true, probe("vsock", "6001")),
  ]);
  assert.equal(decoded(concurrent[0]!).session, a.session);
  assert.equal(decoded(concurrent[1]!).session, b.session);
  report.push({
    check: "concurrent guests using the same vsock port",
    result: "each reached its own host endpoint",
  });
  console.log(JSON.stringify(report, null, 2));
  completed = true;
} finally {
  await Promise.all([a.close(), b.close()]);
  for (const binding of states) {
    await reapVm(binding);
    await Deno.remove(binding.state, { recursive: true });
  }
  if (completed) await Deno.remove(scratch, { recursive: true });
  else console.error(`Prototype fixtures retained at ${scratch}`);
}
