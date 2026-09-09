/** Credential-free live check of trusted repo policy through a real provider VM. */
import assert from "node:assert/strict";
import { gitFixture } from "./lib/git-bridge-fixture.ts";
import { loadConfig } from "../backend/daemon/src/config/config.ts";
import { launchSessionVm } from "../backend/daemon/src/daemon/session-vm-worker.ts";
import { RemoteWorkerSession } from "../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import { sessionVmName, vmEnvironment } from "../runtime/src/packaged/vm.ts";
const [repo, configFile] = Deno.args;
assert(repo, "Pass a repo with registry.npmjs.org in isolation.extra_allowed_hosts");
const config = loadConfig(repo, configFile);
const vm = config.isolation.claude;
assert(vm, "Missing session VM runtime");
assert(config.isolation.extraAllowedHosts.includes("registry.npmjs.org"), "Missing registry grant");
const f = await gitFixture();
const worker = await launchSessionVm({
  workspace: f.workspace,
  artifact: vm.artifact,
  smolvm: vm.smolvm,
  extraAllowedHosts: config.isolation.extraAllowedHosts,
  auth: { ANTHROPIC_API_KEY: "disposable-test-key" },
});
try {
  const { session } = await RemoteWorkerSession.connect(
    "egress-test",
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
    // Install an actual project dependency in the writable worktree with a fresh cache.
    await Deno.writeTextFile(
      f.workspace + "/deno.json",
      JSON.stringify({ nodeModulesDir: "auto" }),
    );
    const install = await Deno.spawnAndWait(
      vm.smolvm,
      [
        "machine",
        "exec",
        "--name",
        sessionVmName,
        "--timeout",
        "45s",
        "-w",
        f.workspace,
        "-e",
        "HOME=/tmp/loom-home",
        "-e",
        "DENO_DIR=/tmp/loom-install-cache",
        "-e",
        "HTTPS_PROXY=http://127.0.0.1:3128",
        "-e",
        "HTTP_PROXY=http://127.0.0.1:3128",
        "-e",
        "DENO_NO_UPDATE_CHECK=1",
        "--",
        deno,
        "install",
        "npm:is-number@7.0.0",
      ],
      {
        clearEnv: true,
        env: vmEnvironment(worker.binding.state),
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      },
    );
    assert.equal(install.code, 0, new TextDecoder().decode(install.stderr));
    assert((await Deno.stat(f.workspace + "/node_modules/is-number/package.json")).isFile);
    const probe = `
      const proxy = Deno.createHttpClient({proxy:{url:"http://127.0.0.1:3128"}});
      try {
        const response = await fetch("https://registry.npmjs.org/is-number/latest", {client:proxy,signal:AbortSignal.timeout(15000)});
        if (!response.ok || (await response.json()).name !== "is-number") throw new Error("Registry request failed");
        for (const target of ["example.com:443", "registry.npmjs.org:444"]) {
          const socket = await Deno.connect({hostname:"127.0.0.1",port:3128});
          try {
            await socket.write(new TextEncoder().encode("CONNECT " + target + " HTTP/1.1\\r\\n\\r\\n"));
            const bytes = new Uint8Array(1024); const size = await socket.read(bytes);
            if (!new TextDecoder().decode(bytes.subarray(0,size)).includes("403 Forbidden")) throw new Error("Unapproved destination accessible");
          } finally { socket.close(); }
        }
        try {
          const socket = await Deno.connect({hostname:"1.1.1.1",port:443});
          socket.close(); throw new Error("Direct IP accessible");
        } catch (error) { if (!/network is unreachable|networkunreachable/i.test(String(error))) throw error; }
        console.log(JSON.stringify({denoInstallSucceeded:true,registryReachable:true,otherHostsDenied:true,alternatePortDenied:true,directIpDenied:true}));
      } finally { proxy.close(); }
    `;
    const result = await Deno.spawnAndWait(
      vm.smolvm,
      ["machine", "exec", "--name", sessionVmName, "--timeout", "30s", "--", deno, "eval", probe],
      {
        clearEnv: true,
        env: vmEnvironment(worker.binding.state),
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      },
    );
    assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
    console.log(new TextDecoder().decode(result.stdout).trim());
  } finally {
    await session.close();
  }
} finally {
  worker.terminate();
  await worker.cleanup?.();
  await f.close();
}
