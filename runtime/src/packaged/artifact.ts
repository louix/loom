/** Read-only runtime resolution. Session launch never invokes Nix or fetches. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { userDirectory } from "../../../core/src/user-dirs.ts";

export interface RuntimeManifest {
  version: 1;
  system: string;
  backend: "smolvm";
  entrypoint: string;
  args: string[];
  closureFormat?: "erofs";
  /** A package-owned Docker archive, unpacked inside the VM on both hosts. */
  guestImage?: "guest-image.tar";
  /** Stable guest image + environment format identity; code is mounted separately. */
  environmentCompatibility?: string;
}
export interface RuntimeLock {
  version: 1;
  source: string;
  artifact: string;
  smolvm: string;
  preparedAt: string;
  /** Set when the package has no Nix-built runtime: `artifact` is where Loom builds it. */
  build?: RuntimeBuild;
}
/**
 * How an Apple Silicon package without a matching pinned runtime builds one on
 * first use (flake.nix `runtimeBuild`): the same smolvm builder the pinned
 * fixed-output derivation runs, named by its guest source and recipe.
 */
export interface RuntimeBuild {
  version: 1;
  identity: string;
  builder: string;
}
export const runtimeHome = () => join(userDirectory("data"), "loom/runtimes");
/** Built runtimes, one GC-rooted link to an immutable store path per identity. */
export const builtRuntimeHome = (home = runtimeHome()) => join(home, "built");
export const builtRuntimePath = (build: RuntimeBuild, home = runtimeHome()) =>
  join(builtRuntimeHome(home), build.identity);
export const decodeRuntimeBuild = (value: unknown): RuntimeBuild => {
  const v = value as Partial<RuntimeBuild> | null;
  if (
    !v ||
    v.version !== 1 ||
    typeof v.identity !== "string" ||
    !/^[a-f0-9]{32}$/.test(v.identity) ||
    typeof v.builder !== "string" ||
    !/^\/nix\/store\/[a-z0-9]{32}-[^/\s]+\/bin\/[^/\s]+$/.test(v.builder)
  )
    throw new Error("Invalid runtime build (expected version 1, identity and a store builder)");
  return { version: 1, identity: v.identity, builder: v.builder };
};
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
    (v.closureFormat !== undefined && v.closureFormat !== "erofs") ||
    (v.guestImage !== undefined &&
      (v.guestImage !== "guest-image.tar" || v.environmentCompatibility === undefined)) ||
    (v.environmentCompatibility !== undefined &&
      (typeof v.environmentCompatibility !== "string" ||
        !/^[a-f0-9]{64}$/.test(v.environmentCompatibility) ||
        !v.guestImage))
  ) {
    throw new Error(
      "Invalid runtime manifest (expected version 1, smolvm, store executable and string args)",
    );
  }
  // Authority is never read from package metadata.
  if (
    Object.keys(v).some(
      (k) =>
        ![
          "version",
          "system",
          "backend",
          "entrypoint",
          "args",
          "closureFormat",
          "guestImage",
          "environmentCompatibility",
        ].includes(k),
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
  if (manifest.guestImage) {
    const image = await Deno.lstat(join(artifact, manifest.guestImage));
    if (!image.isFile || image.size < 1024) {
      throw new Error("Runtime guest image is missing or invalid");
    }
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
const bundledRuntimes = (): Record<string, unknown> | undefined => {
  const file = Deno.env.get("LOOM_BUNDLED_RUNTIMES");
  if (!file) return undefined;
  const runtimes = JSON.parse(readFileSync(file, "utf8"));
  if (!runtimes || typeof runtimes !== "object" || Array.isArray(runtimes)) {
    throw new Error("Invalid bundled runtime manifest");
  }
  return runtimes;
};
/** A package-owned manifest takes precedence over mutable development pins. */
export const bundledRuntime = (source: string): RuntimeLock | undefined => {
  const runtimes = bundledRuntimes();
  if (!runtimes || !Object.hasOwn(runtimes, source)) return undefined;
  const lock = runtimes[source] as RuntimeLock | null;
  if (!lock || typeof lock !== "object" || Array.isArray(lock)) {
    throw new Error(`Invalid bundled runtime entry for ${source}`);
  }
  if (lock.build === undefined) return lock;
  const build = decodeRuntimeBuild(lock.build);
  return { ...lock, build, artifact: builtRuntimePath(build) };
};
/** The package's on-demand session runtime build, if it has one. */
export const bundledRuntimeBuild = (): RuntimeBuild | undefined => {
  for (const source of Object.keys(bundledRuntimes() ?? {})) {
    const build = bundledRuntime(source)?.build;
    if (build) return build;
  }
  return undefined;
};
/** The package's on-demand build that publishes `artifact`, if it is one. */
export const runtimeBuildFor = (artifact: string): RuntimeBuild | undefined => {
  const build = bundledRuntimeBuild();
  return build && builtRuntimePath(build) === artifact ? build : undefined;
};
export const resolveRuntime = async (source: string, home = runtimeHome()) => {
  let bundle: RuntimeLock | undefined;
  try {
    const current = join(home, await runtimeKey(source), "current");
    bundle = await bundledRuntime(source);
    let lock =
      bundle ?? (JSON.parse(await Deno.readTextFile(join(current, "lock.json"))) as RuntimeLock);
    if (
      lock.version !== 1 ||
      lock.source !== source ||
      typeof lock.smolvm !== "string" ||
      !/^\/nix\/store\/[a-z0-9]{32}-[^/\s]+\/bin\/[^/\s]+$/.test(lock.smolvm)
    ) {
      throw new Error("Invalid runtime lock");
    }
    if (lock.build) {
      const built = await Deno.realPath(lock.artifact).catch((error) => {
        if (error instanceof Deno.errors.NotFound)
          throw new Error("it has not been built for this Loom version yet");
        throw error;
      });
      lock = { ...lock, artifact: built };
    }
    const manifest = await inspectArtifact(lock.artifact);
    if (!(await Deno.stat(lock.smolvm)).isFile) {
      throw new Error("Prepared smolvm is missing");
    }
    return { lock, manifest };
  } catch (cause) {
    let remedy = "Run loom runtime prepare.";
    if (bundle?.build)
      remedy = "Run loom runtime update to build it; starting a session also builds it.";
    else if (bundle) remedy = "Upgrade the Loom Nix package to repair its bundled runtime.";
    throw new Error(
      `Runtime ${source} is not ready: ${cause instanceof Error ? cause.message : cause}. ${remedy}`,
      { cause },
    );
  }
};
