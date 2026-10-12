/**
 * Credential-free live check of the egress connection limit through a real session VM:
 * idle keep-alive tunnels below the limit leave room for another client, and a client
 * over it is refused at once and reported, rather than queued until it times out.
 * Needs network access to registry.npmjs.org and nodejs.org.
 *
 *   deno run -A scripts/test-egress-limit-vm.ts /path/to/session-runtime [/path/to/smolvm]
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { gitFixture } from "./lib/git-fixture.ts";
import { closeTestLaunchers, launchTestSessionVm } from "./lib/session-launch.ts";
import { RemoteWorkerSession } from "../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import { sessionVmName, vmEnvironment } from "../runtime/src/packaged/vm.ts";
import { EGRESS_CONNECTION_LIMIT } from "../runtime/src/session-vm/relay-limits.ts";

const [artifact, smolvm = "smolvm"] = Deno.args;
assert(artifact, "Pass a session runtime artifact built from this checkout");

interface ProbeReport {
  established: number;
  belowLimit: FetchOutcome;
  refusal: { outcome: string; ms: number };
  saturated: FetchOutcome;
  released: FetchOutcome;
  relay?: { openFiles: string; sockets: number };
}
type FetchOutcome = { status: number; ms: number } | { error: string; ms: number };

// Each tunnel completes TLS and one request: registry.npmjs.org drops a silent CONNECT
// tunnel within seconds, but keeps a keep-alive HTTPS connection, as pnpm's agent holds.
const probe = (limit: number) => `
  const timeout = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
  const encoder = new TextEncoder();
  const open = [];
  const tunnel = async () => {
    const started = performance.now();
    const socket = await Deno.connect({ hostname: "127.0.0.1", port: 3128 });
    open.push(socket);
    await socket.write(encoder.encode("CONNECT registry.npmjs.org:443 HTTP/1.1\\r\\nHost: registry.npmjs.org:443\\r\\n\\r\\n")).catch(() => {});
    const bytes = new Uint8Array(256);
    const outcome = await Promise.race([
      socket.read(bytes).then(
        (n) => n !== null && new TextDecoder().decode(bytes.subarray(0, n)).includes(" 200 ") ? "established" : "closed",
        () => "closed"),
      timeout(5000, "hung"),
    ]);
    if (outcome === "established") {
      const tls = await Deno.startTls(socket, { hostname: "registry.npmjs.org" });
      open[open.length - 1] = tls;
      await tls.write(encoder.encode("HEAD /is-number HTTP/1.1\\r\\nHost: registry.npmjs.org\\r\\n\\r\\n"));
      await tls.read(new Uint8Array(4096));
    }
    return { outcome, ms: Math.round(performance.now() - started) };
  };
  // A fresh client per request, so its own pooled connection does not hold a slot.
  const fetchOnce = async () => {
    const client = Deno.createHttpClient({ proxy: { url: "http://127.0.0.1:3128" } });
    const started = performance.now();
    try {
      const response = await fetch("https://nodejs.org/dist/index.json", { method: "HEAD", client, signal: AbortSignal.timeout(15000) });
      await response.body?.cancel();
      return { status: response.status, ms: Math.round(performance.now() - started) };
    } catch (error) {
      return { error: String(error).slice(0, 200), ms: Math.round(performance.now() - started) };
    } finally {
      client.close();
    }
  };
  let established = 0;
  for (let i = 0; i < ${limit - 1}; i++) if ((await tunnel()).outcome === "established") established++;
  const belowLimit = await fetchOnce();
  // The relay frees the fetch's slot once it sees the closed connection.
  await timeout(500);
  if ((await tunnel()).outcome === "established") established++;
  const refusal = await tunnel();
  const saturated = await fetchOnce();
  // The relay is the process holding the socket that listens on 3128 (0x0C38).
  const listening = Deno.readTextFileSync("/proc/net/tcp").split("\\n")
    .map((line) => line.trim().split(/\\s+/))
    .find((fields) => fields[1]?.endsWith(":0C38") && fields[3] === "0A")?.[9];
  const descriptors = (pid) => { try { return [...Deno.readDirSync("/proc/" + pid + "/fd")].map((e) => { try { return Deno.readLinkSync("/proc/" + pid + "/fd/" + e.name); } catch { return ""; } }); } catch { return []; } };
  const pid = [...Deno.readDirSync("/proc")].map((e) => e.name).filter((name) => /^\\d+$/.test(name))
    .find((name) => descriptors(name).includes("socket:[" + listening + "]"));
  const relay = pid ? {
    openFiles: Deno.readTextFileSync("/proc/" + pid + "/limits").split("\\n").find((l) => l.startsWith("Max open files")).replace(/\\s+/g, " ").trim(),
    sockets: descriptors(pid).filter((link) => link.startsWith("socket:")).length,
  } : undefined;
  open.shift().close();
  await timeout(500);
  const released = await fetchOnce();
  for (const conn of open) try { conn.close(); } catch {}
  console.log(JSON.stringify({ established, belowLimit, refusal, saturated, released, relay }));
`;

const f = await gitFixture();
// Keep this run's VM inventory and session state out of the user's.
Deno.env.set("XDG_STATE_HOME", join(f.root, "xdg-state"));
const progress: string[] = [];
const worker = await launchTestSessionVm({
  workspace: f.workspace,
  artifact,
  smolvm,
  extraAllowedHosts: ["registry.npmjs.org", "nodejs.org"],
  auth: { ANTHROPIC_API_KEY: "disposable-test-key" },
  onProgress: (message) => progress.push(message),
});
try {
  const { session } = await RemoteWorkerSession.connect(
    "egress-limit-test",
    "mock",
    mockLaunchSpec(f.workspace),
    () => worker,
    120_000,
  );
  try {
    const inventory = (await Deno.readTextFile(worker.binding.artifact + "/store-paths"))
      .trim()
      .split("\n");
    const deno = inventory.find((path) => /-deno-[0-9]/.test(path)) + "/bin/deno";
    const result = await Deno.spawnAndWait(
      smolvm,
      [
        "machine",
        "exec",
        "--name",
        sessionVmName,
        "--timeout",
        "600s",
        "--",
        deno,
        "eval",
        probe(EGRESS_CONNECTION_LIMIT),
      ],
      {
        clearEnv: true,
        env: vmEnvironment(worker.binding.state),
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      },
    );
    assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
    // The probe's output is this script's own JSON report.
    const report = JSON.parse(new TextDecoder().decode(result.stdout)) as ProbeReport;
    console.log(JSON.stringify(report));
    const refused = progress.filter((message) => message.startsWith("VM relay egress[0] refused"));
    console.log(refused.join("\n"));
    assert.equal(report.established, EGRESS_CONNECTION_LIMIT);
    assert("status" in report.belowLimit, `fetch below the limit: ${JSON.stringify(report)}`);
    assert.equal(report.refusal.outcome, "closed");
    assert(report.refusal.ms < 1000, "refusal must not wait for a timeout");
    assert("error" in report.saturated && report.saturated.ms < 2000, "saturated fetch fails fast");
    assert("status" in report.released, "a released slot serves the next client");
    assert(refused.length > 0, "refusal is reported");
  } finally {
    await session.close();
  }
} finally {
  worker.terminate();
  await worker.cleanup?.();
  await closeTestLaunchers();
  await f.close();
}
