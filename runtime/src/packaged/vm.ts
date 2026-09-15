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
  preparationOnly?: boolean;
  repoBaseDirectory?: string;
  packageCache?: string;
  mounts?: string[];
  sessionDirectory?: string;
  mcpRelays?: Array<{ port: number; guestPort: number }>;
}
export const sessionVmName = "loom-session";
// Guest UID differs from host file ownership. All mounted repositories are
// explicitly trusted; this exception is process-local and never edits host config.
const guestGitEnvironment = [
  "-e",
  "GIT_CONFIG_COUNT=1",
  "-e",
  "GIT_CONFIG_KEY_0=safe.directory",
  "-e",
  "GIT_CONFIG_VALUE_0=*",
];
/** Keep the archive timestamp stable when smolvm hard-links its private cache.
 * Its copy fallback from the root-owned Nix store resets mtime, unnecessarily
 * invalidating the extracted image on every clone of a prepared disk.
 */
export const stageGuestImage = async (b: VmBinding) => {
  if (!b.manifest.guestImage) return;
  const target = join(b.state, b.manifest.guestImage);
  await Deno.copyFile(join(b.artifact, b.manifest.guestImage), target);
  await Deno.chmod(target, 0o400);
  await Deno.utime(target, 1, 1);
};
// OCI workloads get a minimal /dev even though the guest kernel supports loops.
// libmount needs these nodes to attach the read-only EROFS image on macOS.
const mountErofs = (image: string, target: string) =>
  [
    "[ -c /dev/loop-control ] || mknod /dev/loop-control c 10 237",
    "[ -b /dev/loop0 ] || mknod /dev/loop0 b 7 0",
    `mount -t erofs -o loop,ro ${image} ${target}`,
  ].join("; ");
const runtimeCommand = (b: VmBinding) => {
  if (b.manifest.environmentCompatibility) {
    // The image and its registered Nix closure stay fixed across Loom upgrades.
    // Current code is another read-only lower layer, never saved in the base.
    const script = [
      "set -eu",
      "mkdir -p /run/loom/store-base /run/loom/store-code",
      "mount --bind /nix/store /run/loom/store-base",
      b.manifest.closureFormat === "erofs"
        ? mountErofs("/run/loom/code/runtime.erofs", "/run/loom/store-code")
        : "mount --bind /run/loom/code/nix/store /run/loom/store-code",
      "ln -sfn /opt/loom/runtime /run/loom/runtime",
      ...(b.writableNix
        ? [
            "mkdir -p /storage/loom-nix/upper /storage/loom-nix/work /storage/loom-nix/var /storage/loom-nix/tmp /nix/var",
            "mount -t overlay overlay -o lowerdir=/run/loom/store-code:/run/loom/store-base,upperdir=/storage/loom-nix/upper,workdir=/storage/loom-nix/work /nix/store",
            "mount --bind /storage/loom-nix/var /nix/var",
          ]
        : [
            "mount -t overlay overlay -o ro,lowerdir=/run/loom/store-code:/run/loom/store-base /nix/store",
          ]),
      'exec "$@"',
    ].join("; ");
    return ["/bin/sh", "-c", script, "loom-runtime", b.manifest.entrypoint, ...b.manifest.args];
  }
  let mount: string | undefined;
  if (b.writableNix) {
    const lower = b.manifest.guestImage ? "/nix/store" : "/run/loom/runtime/nix/store";
    let mountLower = `mount --bind ${lower} /run/loom/store-lower`;
    if (!b.manifest.guestImage && b.manifest.closureFormat === "erofs")
      mountLower = mountErofs("/run/loom/runtime/runtime.erofs", "/run/loom/store-lower");
    mount = [
      "set -eu",
      // /storage is smolvm's ext4 disk; its overlay-backed root cannot
      // itself be an OverlayFS upper. Keep the DB and build temp files here too.
      "mkdir -p /nix/store /nix/var /run/loom/store-lower /storage/loom-nix/upper /storage/loom-nix/work /storage/loom-nix/var /storage/loom-nix/tmp",
      mountLower,
      "mount -t overlay overlay -o lowerdir=/run/loom/store-lower,upperdir=/storage/loom-nix/upper,workdir=/storage/loom-nix/work /nix/store",
      "mount --bind /storage/loom-nix/var /nix/var",
      'exec "$@"',
    ].join("; ");
  } else if (!b.manifest.guestImage && b.manifest.closureFormat === "erofs") {
    mount = `set -eu; mkdir -p /nix/store; ${mountErofs("/run/loom/runtime/runtime.erofs", "/nix/store")}; exec "$@"`;
  }
  if (b.manifest.guestImage) {
    // /run is ephemeral; the image keeps closure registration under /opt.
    const metadata = "mkdir -p /run/loom; ln -sfn /opt/loom/runtime /run/loom/runtime";
    mount = mount
      ? mount.replace("set -eu; ", `set -eu; ${metadata}; `)
      : `set -eu; ${metadata}; mount --bind /nix/store /nix/store; mount -o remount,bind,ro /nix/store; exec "$@"`;
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
  for (const path of b.mounts ?? [b.workspace]) {
    if (!isAbsolute(path) || path === "/" || /[:,;|\n\0]/.test(path))
      throw new Error("Unsupported repository mount path");
    if (
      ["/nix", "/proc", "/sys", "/dev", "/etc", "/bin", "/usr", "/run"].some(
        (system) => path === system || path.startsWith(system + "/"),
      )
    )
      throw new Error("Repository mount overlaps the VM system filesystem");
    if (
      [b.state, b.sessionDirectory].some(
        (privatePath) =>
          privatePath &&
          (privatePath === path ||
            privatePath.startsWith(path + "/") ||
            path.startsWith(privatePath + "/")),
      )
    )
      throw new Error("VM private state must be outside repository mounts");
  }
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
    ...(b.manifest.guestImage ? ["--image", join(b.state, b.manifest.guestImage)] : []),
    "--cpus",
    "1",
    "--mem",
    "512",
    "-i",
    ...(b.manifest.guestImage
      ? []
      : [
          "-v",
          b.writableNix || b.manifest.closureFormat === "erofs"
            ? `${b.artifact}:/run/loom/runtime:ro`
            : `${b.artifact}/nix/store:/nix/store:ro`,
        ]),
    ...(b.manifest.environmentCompatibility ? ["-v", `${b.artifact}:/run/loom/code:ro`] : []),
    ...(b.mounts ?? [b.workspace]).flatMap((path) => ["-v", `${path}:${path}`]),
    "-w",
    b.workspace,
    "-e",
    "HOME=/tmp/loom-home",
    "-e",
    "XDG_CACHE_HOME=/tmp/loom-cache",
    ...guestGitEnvironment,

    "--",
    ...runtimeCommand(b),
  ];
};
export const vmCreateArguments = (
  b: VmBinding,
  resources?: Pick<SessionEnvironment, "memoryMiB" | "cpus">,
) => {
  const args = vmArguments(b);
  args[args.indexOf("--mem") + 1] = String(resources?.memoryMiB ?? 2048);
  args[args.indexOf("--cpus") + 1] = String(resources?.cpus ?? 1);
  return [
    "machine",
    "create",
    "--name",
    sessionVmName,
    ...args.slice(2, args.indexOf("--")).filter((a) => a !== "-i"),
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
  ...guestGitEnvironment,
  "-e",
  "PATH=/usr/bin:/bin",
  "--",
  ...runtimeCommand(b),
];
export const reapVm = async (b: Pick<VmBinding, "smolvm" | "state">) => {
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
      if (!(m.ephemeral && /^vm-[a-z0-9]+$/.test(m.name)) && m.name !== sessionVmName) {
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
