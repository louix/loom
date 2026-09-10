/** Credential-free backend log acceptance: boot, verify exec, then reboot the test guest.
 * Run: deno run -A scripts/test-preparation-backend-vm.ts /path/to/smolvm
 */
import assert from "node:assert/strict";
import { vmEnvironment } from "../runtime/src/packaged/vm.ts";
import { attachDiskTemplates } from "../runtime/src/packaged/disk-templates.ts";
import { preparationBackendTail } from "../runtime/src/session-vm/prepare-diagnostics.ts";
assert.equal(Deno.args.length, 1, "Pass the pinned smolvm executable");
const binary = await Deno.realPath(Deno.args[0]!);
const state = await Deno.makeTempDir({ prefix: "loom-backend-smoke-", dir: "/tmp" });
const name = "backend-log-check";
const command = async (action: string, extra: string[] = []) => {
  const capture = action === "start";
  const args = ["machine", action, "--name", name, ...extra];
  const result = await new Deno.Command(binary, {
    args,
    clearEnv: true,
    env: {
      ...vmEnvironment(state),
      ...(capture
        ? {
            SMOLVM_KRUN_LOG_LEVEL: "3",
            RUST_LOG: "warn,vmm=info,krun_vmm=info,krun_devices::virtio::vsock=error",
          }
        : {}),
    },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(result.success, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout);
};
try {
  await attachDiskTemplates(state, binary);
  await command("create", ["--mem", "512", "--cpus", "1", "--storage", "32", "--overlay", "8"]);
  await command("start");
  console.log("start returned while VM remains alive");
  assert.match(await command("exec", ["--", "/bin/sh", "-c", "echo guest-alive"]), /guest-alive/);
  await command("exec", ["--", "/sbin/reboot", "-f"]).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 200));
  const log = await preparationBackendTail((await command("data-dir")).trim());
  console.log(log);
  assert.match(log, /Vmm is stopping|KVM_EXIT|KVM_SYSTEM_EVENT/);
  console.log("backend capture passed");
} finally {
  await command("delete");
  await Deno.remove(state, { recursive: true });
}
