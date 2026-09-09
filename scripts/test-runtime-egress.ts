/** Opt-in live KVM check: public HTTPS, denied hosts, direct IPs and teardown. */
import { gitFixture } from "./lib/git-bridge-fixture.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { startRuntimeMcp } from "../backend/daemon/src/daemon/runtime-mcp.ts";
import {
  launchLocalWorker,
  type WorkerProcess,
} from "../backend/daemon/src/daemon/worker-launch.ts";
const [artifact, smolvm] = Deno.args;
assert(artifact && smolvm, "Pass network-probe runtime and smolvm executable");
const git = await gitFixture();
const scratch = await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-egress-test-" });
const before = Deno.env.get("LOOM_BUNDLED_RUNTIMES");
const bundle = join(scratch, "bundle.json");
await Deno.writeTextFile(
  bundle,
  JSON.stringify({
    probe: {
      version: 1,
      source: "probe",
      artifact: await Deno.realPath(artifact),
      smolvm: await Deno.realPath(smolvm),
      preparedAt: "test",
    },
  }),
);
Deno.env.set("LOOM_BUNDLED_RUNTIMES", bundle);
try {
  for (const mode of ["offline", "network", "git-network"]) {
    const hosts = mode === "offline" ? [] : ["example.com"];
    const workspace = mode === "git-network" ? git.workspace : join(scratch, mode);
    await Deno.mkdir(workspace, { recursive: true });
    let child: WorkerProcess | undefined;
    let state = "";
    const worker = await startRuntimeMcp(
      "probe",
      "probe",
      workspace,
      (spec) => {
        state = spec.cwd;
        child = launchLocalWorker(spec);
        return child;
      },
      undefined,
      false,
      hosts,
    );
    try {
      assert(worker.handle.spec.transport === "http");
      const endpoint = worker.handle.spec;
      let id = 0;
      const probe = async (url: string, direct = false) => {
        const response = await fetch(endpoint.url, {
          method: "POST",
          headers: { ...endpoint.headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: ++id,
            method: "tools/call",
            params: {
              name: "probe",
              arguments: { url, direct },
            },
          }),
        });
        assert.equal(response.status, 200);
        const message = await response.json();
        assert(!message.error, JSON.stringify(message));
        return JSON.parse(message.result.content[0].text);
      };
      const direct = await probe("https://1.1.1.1", true);
      assert.equal(direct.errno, 101, "Direct IP must fail with Linux ENETUNREACH, not a timeout");
      const allowed = await probe("https://example.com");
      if (hosts.length) {
        assert.equal(allowed.code, 0, JSON.stringify(allowed));
        assert.equal(allowed.status, "200");
        const denied = await probe("https://example.org");
        assert.notEqual(denied.code, 0);
        assert.match(denied.error, /403/);
        const port = await probe("https://example.com:444");
        assert.match(port.error, /403/);
        child!.terminate(); // host fallback must also revoke egress and reap the VM.
      } else assert.notEqual(allowed.code, 0, "No policy must keep network access off");
      console.log(JSON.stringify({ mode, hosts, directBlocked: true, policyVerified: true }));
    } finally {
      await worker.close();
    }
    await assert.rejects(Deno.stat(state), Deno.errors.NotFound);
  }
} finally {
  if (before === undefined) Deno.env.delete("LOOM_BUNDLED_RUNTIMES");
  else Deno.env.set("LOOM_BUNDLED_RUNTIMES", before);
  await Deno.remove(scratch, { recursive: true });
  await git.close();
}
