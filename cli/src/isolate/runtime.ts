/**
 * VM runtime selection for loom-isolate. Read-only, except that a package
 * without a Nix-built runtime (an unpinned Mac) builds its own before a run.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  builtRuntimePath,
  decodeRuntimeBuild,
  inspectArtifact,
  requireVmHost,
  type RuntimeBuild,
} from "../../../runtime/src/packaged/artifact.ts";
import { ensureRuntimeArtifact } from "../../../runtime/src/packaged/build.ts";
import { environmentRuntimeVersion } from "../../../runtime/src/session-vm/launch.ts";
import { UsageError, type IsolateRuntime } from "./state.ts";

/** Set by the Nix package to its bundled session runtime (or how to build it) and smolvm. */
export const runtimeEnvironment = {
  artifact: "LOOM_ISOLATE_ARTIFACT",
  build: "LOOM_ISOLATE_RUNTIME_BUILD",
  smolvm: "LOOM_ISOLATE_SMOLVM",
} as const;

const packageBuild = (): RuntimeBuild | undefined => {
  const file = Deno.env.get(runtimeEnvironment.build);
  return file ? decodeRuntimeBuild(JSON.parse(readFileSync(file, "utf8"))) : undefined;
};
const packageArtifact = () => {
  const build = packageBuild();
  return Deno.env.get(runtimeEnvironment.artifact) ?? (build && builtRuntimePath(build));
};

/** Build the package's own runtime first if `runtime` selects it and it is not built yet. */
export const buildPackageRuntime = async (
  runtime: IsolateRuntime,
  onProgress: (message: string) => void,
  signal?: AbortSignal,
) => {
  const build = packageBuild();
  if (build && runtime.artifact === builtRuntimePath(build))
    await ensureRuntimeArtifact(
      runtime.artifact,
      { onProgress, ...(signal ? { signal } : {}) },
      build,
    );
};

/**
 * Flags, then trusted configuration (a launch profile's artifact, then the user
 * backend), then the package default, then what the environment was last prepared with.
 */
export const selectRuntime = (
  flags: { artifact?: string | undefined; smolvm?: string | undefined },
  prepared: IsolateRuntime | null,
  configured: { artifact?: string | undefined; smolvm?: string | undefined } = {},
): IsolateRuntime => {
  const artifact = flags.artifact ?? configured.artifact ?? packageArtifact() ?? prepared?.artifact;
  const smolvm =
    flags.smolvm ??
    configured.smolvm ??
    Deno.env.get(runtimeEnvironment.smolvm) ??
    prepared?.smolvm;
  if (!artifact || !smolvm)
    throw new UsageError(
      "No VM runtime selected: pass --artifact and --smolvm (a Loom session runtime and a smolvm executable), " +
        "set backend in the environment config, or use the packaged loom-isolate, which bundles both.",
    );
  return { artifact, smolvm };
};

export interface RuntimeReport extends IsolateRuntime {
  system: string;
  environmentCompatibility: string | null;
  /** Standalone environment protocol of the runtime; at least 1 is required. */
  environmentVersion: number;
  smolvmVersion: string;
}

/** Canonical, compatible runtime and a working smolvm, or a specific error. */
export const verifyRuntime = async (runtime: IsolateRuntime): Promise<RuntimeReport> => {
  requireVmHost();
  const resolve = async (path: string, label: string) => {
    try {
      return await Deno.realPath(path);
    } catch {
      throw new UsageError(`${label} not found: ${path}`);
    }
  };
  const artifact = await resolve(runtime.artifact, "VM runtime");
  const smolvm = await resolve(runtime.smolvm, "smolvm executable");
  const manifest = await inspectArtifact(artifact);
  const session = await Deno.readTextFile(join(artifact, "claude-session-version")).catch(() => "");
  const environmentVersion = await environmentRuntimeVersion(artifact);
  if (session.trim() !== "2" || !manifest.environmentCompatibility || environmentVersion < 1)
    throw new Error(
      "VM runtime is not a compatible Loom session runtime with standalone environments: " +
        artifact,
    );
  const info = await Deno.stat(smolvm);
  if (!info.isFile || !((info.mode ?? 0) & 0o111))
    throw new UsageError("smolvm is not an executable file: " + smolvm);
  const version = await new Deno.Command(smolvm, {
    args: ["--version"],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!version.success)
    throw new Error(
      `smolvm --version failed (${version.code}): ` +
        new TextDecoder().decode(version.stderr).trim(),
    );
  return {
    artifact,
    smolvm,
    system: manifest.system,
    environmentCompatibility: manifest.environmentCompatibility ?? null,
    environmentVersion,
    smolvmVersion: new TextDecoder().decode(version.stdout).trim(),
  };
};
