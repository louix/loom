/** Offline glibc guest feasibility check; see docs/glibc-guest-experiment.md. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { vmEnvironment } from "../runtime/src/packaged/vm.ts";
import { attachDiskTemplates } from "../runtime/src/packaged/disk-templates.ts";
import { sessionDiskSizes } from "../runtime/src/session-vm/disks.ts";

const [binary, image, runtime, node] = Deno.args;
assert(binary && image && runtime && node);
assert(
  Deno.args.length === 4,
  "Pass smolvm, local rootfs, test runtime directory, guest Node path",
);
assert(/^\/nix\/store\/[a-zA-Z0-9.+_-]+\/bin\/node$/.test(node));
const smolvm = await Deno.realPath(binary);
const rootfs = await Deno.realPath(image);
const fixture = await Deno.realPath(runtime);
// Never expose the host store. Supply a dedicated copy of the Node closure.
assert(fixture !== "/nix" && fixture !== "/nix/store");
assert((await Deno.lstat(join(fixture, "store"))).isDirectory);
const imageInfo = await Deno.lstat(rootfs);
assert(imageInfo.isDirectory || imageInfo.isFile, "Pass a local rootfs directory or image archive");
const state = await Deno.realPath(await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-glibc-" }));
const socket = join(state, "bridge.sock");
const listener = Deno.listen({ transport: "unix", path: socket });
let created = false;
const command = async (action: string, args: string[] = []) => {
  const result = await new Deno.Command(smolvm, {
    args: ["machine", action, "--name", "glibc-test", ...args],
    clearEnv: true,
    env: vmEnvironment(state),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = new TextDecoder().decode(result.stdout);
  assert(result.success, `${action}: ${out}\n${new TextDecoder().decode(result.stderr)}`);
  return out.trim();
};
const exec = (script: string) => command("exec", ["--", "/bin/sh", "-ec", script]);
try {
  await attachDiskTemplates(state, smolvm);
  await Deno.mkdir(join(state, "work"));
  await command("create", [
    "--image",
    rootfs,
    "--mem",
    "2048",
    "--cpus",
    "1",
    ...sessionDiskSizes,
    "-v",
    `${fixture}/store:/run/loom/runtime/nix/store:ro`,
    "-v",
    `${fixture}/fixture:/fixture:ro`,
    "-v",
    `${state}/work:/workspace`,
    "--mount-socket",
    `${socket}:/run/loom/bridge.sock`,
  ]);
  created = true;
  await command("start");
  console.log(
    await exec(`
    cat /etc/os-release
    mkdir -p /nix/store /run/loom/store-lower /storage/loom-nix/upper /storage/loom-nix/work
    mount --bind /run/loom/runtime/nix/store /run/loom/store-lower
    mount -t overlay overlay -o lowerdir=/run/loom/store-lower,upperdir=/storage/loom-nix/upper,workdir=/storage/loom-nix/work /nix/store
    echo warm > /nix/store/loom-probe
    echo shared > /workspace/marker
    ${node} -e 'const fs=require("node:fs"); if(fs.readFileSync("/usr/bin/ldd","utf8").includes("musl") || !process.report.getReport().header.glibcVersionRuntime) process.exit(1)'
    ${node} /fixture/test.mjs
  `),
  );
  console.log("Passed native loading and writable Nix overlay");
  const client = exec(
    `${node} -e 'const s=require("node:net").connect("/run/loom/bridge.sock"); s.setTimeout(5000,()=>{process.exit(1)}); s.on("error",()=>process.exit(1)); s.on("data",d=>{if(d.toString()!=="bridge-ok")process.exit(1); s.end()})'`,
  );
  // Bound the accept as well as the guest client, so a broken bridge cannot hang the test.
  const timer = setTimeout(() => listener.close(), 10_000);
  try {
    const connection = await listener.accept();
    try {
      await connection.write(new TextEncoder().encode("bridge-ok"));
    } finally {
      connection.close();
    }
  } finally {
    clearTimeout(timer);
    await client;
  }
  console.log("Passed host socket bridge with guest networking disabled");
  await command("stop");
  await command("start");
  assert.equal(
    await exec("cat /storage/loom-nix/upper/loom-probe /workspace/marker"),
    "warm\nshared",
  );
  assert.equal(await Deno.readTextFile(join(state, "work/marker")), "shared\n");
  console.log("Passed persistent overlay data and immediate host worktree writes");
} finally {
  try {
    listener.close();
  } catch {
    /* already closed by timeout */
  }
  // Retain state if shutdown fails; never delete disks underneath a live VM.
  if (created) await command("delete", ["--force"]);
  await Deno.remove(state, { recursive: true });
}
