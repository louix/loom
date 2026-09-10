/** Read-only runtime resolution. Session launch never invokes Nix or fetches. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface RuntimeManifest {
  version: 1;
  system: string;
  backend: "smolvm";
  entrypoint: string;
  args: string[];
  closureFormat?: "erofs";
}
export interface RuntimeLock {
  version: 1;
  source: string;
  artifact: string;
  smolvm: string;
  preparedAt: string;
}
export const runtimeHome = () =>
  join(Deno.env.get("XDG_DATA_HOME") || join(homedir(), ".local/share"), "loom/runtimes");
export const runtimeKey = async (source: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
/** Artifact system is the Linux guest target, never the native smolvm host. */
export const guestSystem = () => `${Deno.build.arch}-linux`;
export const requireVmHost = () => {
  if (Deno.build.os !== "linux" && !(Deno.build.os === "darwin" && Deno.build.arch === "aarch64")) {
    throw new Error("VM isolation supports Linux and Apple Silicon macOS hosts");
  }
};
const storePath = /^\/nix\/store\/[a-z0-9]{32}-[^/\s]+$/;
export const decodeManifest = (value: unknown): RuntimeManifest => {
  const v = value as Partial<RuntimeManifest> | null;
  if (
    !v ||
    v.version !== 1 ||
    v.backend !== "smolvm" ||
    typeof v.system !== "string" ||
    typeof v.entrypoint !== "string" ||
    !/^\/nix\/store\/[a-z0-9]{32}-[^/\s]+\/bin\/[^/\s]+$/.test(v.entrypoint) ||
    !Array.isArray(v.args) ||
    !v.args.every((a) => typeof a === "string" && !a.includes("\0")) ||
    (v.closureFormat !== undefined && v.closureFormat !== "erofs")
  ) {
    throw new Error(
      "Invalid runtime manifest (expected version 1, smolvm, store executable and string args)",
    );
  }
  // Authority is never read from package metadata.
  if (
    Object.keys(v).some(
      (k) => !["version", "system", "backend", "entrypoint", "args", "closureFormat"].includes(k),
    )
  ) {
    throw new Error("Unknown runtime manifest field; permissions belong in Loom configuration");
  }
  return v as RuntimeManifest;
};
export const inspectArtifact = async (artifact: string): Promise<RuntimeManifest> => {
  requireVmHost();
  if (!storePath.test(artifact)) {
    throw new Error("Runtime artifact must be an immutable Nix store path");
  }
  const manifest = decodeManifest(
    JSON.parse(await Deno.readTextFile(join(artifact, "manifest.json"))),
  );
  if (manifest.system !== guestSystem()) {
    throw new Error(`Runtime guest system ${manifest.system} does not match ${guestSystem()}`);
  }
  const paths = (await Deno.readTextFile(join(artifact, "store-paths"))).trim().split("\n");
  if (
    !paths.length ||
    !paths.every((p) => storePath.test(p)) ||
    !paths.some((p) => manifest.entrypoint.startsWith(p + "/"))
  ) {
    throw new Error("Invalid runtime closure inventory");
  }
  if (manifest.closureFormat === "erofs") {
    const image = await Deno.lstat(join(artifact, "runtime.erofs"));
    if (!image.isFile || image.size < 4096) {
      throw new Error("Runtime closure image is missing or invalid");
    }
    // The pinned package supplies the image; the guest mounts it read-only.
    // Linux filenames cannot be inspected by unpacking onto a macOS host.
    return manifest;
  }
  for (const path of paths) {
    const staged = join(artifact, path);
    if (!(await Deno.lstat(staged)).isDirectory) {
      throw new Error("Runtime closure entries must be copied directories");
    }
    if (!(await Deno.realPath(staged)).startsWith(artifact + "/nix/store/")) {
      throw new Error("Runtime closure escapes artifact");
    }
  }
  const executable = await Deno.stat(join(artifact, manifest.entrypoint));
  if (!executable.isFile || !(executable.mode! & 0o111)) {
    throw new Error("Runtime entrypoint is not executable");
  }
  return manifest;
};
/** Resolve guest absolute links against the staged store, never the host store. */
export const inspectGitShim = async (artifact: string): Promise<void> => {
  const target = await Deno.readLink(join(artifact, "bin/git"));
  if (
    (await Deno.readTextFile(join(artifact, "git-bridge-version"))).trim() !== "2" ||
    !/^\/nix\/store\/[a-z0-9]{32}-[^/\s]+\/bin\/git$/.test(target)
  ) {
    throw new Error("Invalid Git bridge shim");
  }
  const staged = join(artifact, target);
  if (!(await Deno.realPath(staged)).startsWith(artifact + "/nix/store/")) {
    throw new Error("Git bridge shim escapes artifact");
  }
  const executable = await Deno.stat(staged);
  if (!executable.isFile || !(executable.mode! & 0o111)) {
    throw new Error("Git bridge shim is not executable");
  }
};
/** A package-owned manifest takes precedence over mutable development pins. */
export const bundledRuntime = (source: string): RuntimeLock | undefined => {
  const file = Deno.env.get("LOOM_BUNDLED_RUNTIMES");
  if (!file) return undefined;
  const runtimes = JSON.parse(readFileSync(file, "utf8"));
  if (!runtimes || typeof runtimes !== "object" || Array.isArray(runtimes)) {
    throw new Error("Invalid bundled runtime manifest");
  }
  if (!Object.hasOwn(runtimes, source)) return undefined;
  const lock = runtimes[source];
  if (!lock || typeof lock !== "object" || Array.isArray(lock)) {
    throw new Error(`Invalid bundled runtime entry for ${source}`);
  }
  return lock as RuntimeLock;
};
export const resolveRuntime = async (source: string, home = runtimeHome()) => {
  let bundled = false;
  try {
    const current = join(home, await runtimeKey(source), "current");
    const bundle = await bundledRuntime(source);
    bundled = bundle !== undefined;
    const lock =
      bundle ?? (JSON.parse(await Deno.readTextFile(join(current, "lock.json"))) as RuntimeLock);
    if (
      lock.version !== 1 ||
      lock.source !== source ||
      typeof lock.smolvm !== "string" ||
      !/^\/nix\/store\/[a-z0-9]{32}-[^/\s]+\/bin\/[^/\s]+$/.test(lock.smolvm)
    ) {
      throw new Error("Invalid runtime lock");
    }
    const manifest = await inspectArtifact(lock.artifact);
    if (!(await Deno.stat(lock.smolvm)).isFile) {
      throw new Error("Prepared smolvm is missing");
    }
    return { lock, manifest };
  } catch (cause) {
    throw new Error(
      `Runtime ${source} is not ready: ${cause instanceof Error ? cause.message : cause}. ${
        bundled
          ? "Upgrade the Loom Nix package to repair its bundled runtime."
          : "Run loom runtime prepare."
      }`,
      { cause },
    );
  }
};
