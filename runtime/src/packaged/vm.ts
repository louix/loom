/** Fixed-policy VM launch and reaping, shared by supervisor and daemon fallback. */
import { isAbsolute, join } from "node:path";
import type { SessionEnvironment } from "../../../core/src/session-environment.ts";
import type { RuntimeManifest } from "./artifact.ts";
export interface VmBinding {
  version: 1;
  artifact: string;
  smolvm: string;
  manifest: RuntimeManifest;
  workspace: string;
  state: string;
  token: string;
  /** Private guest OverlayFS upper, never a writable host store. */
  writableNix?: boolean;
  /** Raw disks owned by sessionDirectory; launch-local links are disposable. */
  persistentDisks?: boolean;
  preparationOnly?: boolean;
  repoBaseDirectory?: string;
  gitSocket?: string;
  sessionDirectory?: string;
  mcpRelays?: Array<{ port: number; guestPort: number }>;
}
export const sessionVmName = "loom-session";
const runtimeCommand = (b: VmBinding) => {
  let mount: string | undefined;
  if (b.writableNix) {
    mount = [
      "set -eu",
      // /storage is smolvm's ext4 disk; its overlay-backed root cannot
      // itself be an OverlayFS upper. Keep the DB and build temp files here too.
      "mkdir -p /nix/store /nix/var /run/loom/store-lower /storage/loom-nix/upper /storage/loom-nix/work /storage/loom-nix/var /storage/loom-nix/tmp",
      b.manifest.closureFormat === "erofs"
        ? "mount -t erofs -o loop,ro /run/loom/runtime/runtime.erofs /run/loom/store-lower"
        : "mount --bind /run/loom/runtime/nix/store /run/loom/store-lower",
      "mount -t overlay overlay -o lowerdir=/run/loom/store-lower,upperdir=/storage/loom-nix/upper,workdir=/storage/loom-nix/work /nix/store",
      "mount --bind /storage/loom-nix/var /nix/var",
      'exec "$@"',
    ].join("; ");
  } else if (b.manifest.closureFormat === "erofs") {
    mount =
      'set -eu; mkdir -p /nix/store; mount -t erofs -o loop,ro /run/loom/runtime/runtime.erofs /nix/store; exec "$@"';
  }
  return [
    ...(mount ? ["/bin/sh", "-c", mount, "loom-runtime"] : []),
    b.manifest.entrypoint,
    ...b.manifest.args,
  ];
};
export const vmEnvironment = (state: string) => {
  return {
    HOME: join(state, "home"),
    XDG_CACHE_HOME: join(state, "cache"),
    XDG_DATA_HOME: join(state, "data"),
    XDG_CONFIG_HOME: join(state, "config"),
    PATH: "/usr/bin:/bin",
  };
};
export const vmArguments = (b: VmBinding) => {
  if (b.state === b.workspace || b.state.startsWith(b.workspace + "/")) {
    throw new Error("VM supervisor state must be outside the session workspace");
  }
  if (
    !isAbsolute(b.workspace) ||
    b.workspace === "/" ||
    [b.workspace, b.artifact, b.state].some((p) => /[:,;|\n\0]/.test(p))
  ) {
    throw new Error(
      "Unsupported VM mount path (must be absolute, non-root, without colon, comma or newline)",
    );
  }
  if (
    b.workspace === "/nix" ||
    b.workspace.startsWith("/nix/") ||
    ["/proc", "/sys", "/dev", "/etc", "/bin", "/usr", "/run"].some(
      (p) => b.workspace === p || b.workspace.startsWith(p + "/"),
    )
  ) {
    throw new Error("Session workspace overlaps the VM system filesystem");
  }
  return [
    "machine",
    "run",
    "--cpus",
    "1",
    "--mem",
    "512",
    "-i",
    "-v",
    b.writableNix || b.manifest.closureFormat === "erofs"
      ? `${b.artifact}:/run/loom/runtime:ro`
      : `${b.artifact}/nix/store:/nix/store:ro`,
    "-v",
    `${b.workspace}:${b.workspace}`,
    ...(b.gitSocket ? ["-v", `${b.artifact}/bin:/run/loom/bin:ro`] : []),
    "-w",
    b.workspace,
    "-e",
    "HOME=/tmp/loom-home",
    "-e",
    "XDG_CACHE_HOME=/tmp/loom-cache",
    ...(b.gitSocket ? ["-e", "PATH=/run/loom/bin:/usr/bin:/bin"] : []),
    "--",
    ...runtimeCommand(b),
  ];
};
export const vmCreateArguments = (
  b: VmBinding,
  resources?: Pick<SessionEnvironment, "memoryMiB" | "cpus">,
) => {
  if (!b.gitSocket || !b.gitSocket.startsWith(b.state + "/") || /[:,;|\n\0]/.test(b.gitSocket)) {
    throw new Error("Git endpoint must be in private VM state");
  }
  const args = vmArguments(b);
  args[args.indexOf("--mem") + 1] = String(resources?.memoryMiB ?? 2048);
  args[args.indexOf("--cpus") + 1] = String(resources?.cpus ?? 1);
  return [
    "machine",
    "create",
    "--name",
    sessionVmName,
    ...args.slice(2, args.indexOf("--")).filter((a) => a !== "-i"),
    "--mount-socket",
    `${b.gitSocket}:/run/loom/git.sock`,
  ];
};
export const vmExecArguments = (b: VmBinding) => [
  "machine",
  "exec",
  "--name",
  sessionVmName,
  "-i",
  "-w",
  b.workspace,
  "-e",
  "HOME=/tmp/loom-home",
  "-e",
  "XDG_CACHE_HOME=/tmp/loom-cache",
  "-e",
  "PATH=/run/loom/bin:/usr/bin:/bin",
  "--",
  ...runtimeCommand(b),
];
export const reapVm = async (b: Pick<VmBinding, "smolvm" | "state" | "gitSocket">) => {
  const command = async (args: string[]) => {
    const child = Deno.spawn(b.smolvm, args, {
      clearEnv: true,
      env: vmEnvironment(b.state),
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* exited */
      }
    }, 5000);
    try {
      const r = await child.output();
      if (!r.success) {
        throw new Error(`smolvm cleanup failed (${r.code}); state retained at ${b.state}`);
      }
      return new TextDecoder().decode(r.stdout);
    } finally {
      clearTimeout(timer);
    }
  };
  const list = async () =>
    JSON.parse(await command(["machine", "ls", "--json"])) as Array<{
      name: string;
      ephemeral: boolean;
    }>;
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  for (;;) {
    const machines = await list();
    if (!machines.length) return;
    for (const m of machines) {
      if (
        !(m.ephemeral && /^vm-[a-z0-9]+$/.test(m.name)) &&
        !(b.gitSocket && m.name === sessionVmName)
      ) {
        throw new Error("Unexpected VM in private state; refusing to delete it");
      }
      try {
        await command(["machine", "stop", "--name", m.name]);
      } catch (error) {
        lastError = error;
      }
      try {
        await command(["machine", "delete", "--name", m.name, "--force"]);
      } catch (error) {
        lastError = error;
      }
    }
    // Foreground smolvm removes ephemeral records asynchronously; stop/delete
    // can race that removal. Retry until empty, with a strict overall budget.
    if (Date.now() >= deadline) {
      throw new Error("VM cleanup incomplete; state retained at " + b.state, {
        cause: lastError,
      });
    }
    await new Promise((r) => setTimeout(r, 100));
  }
};
