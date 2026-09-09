/** Network-enabled installation commands, deliberately outside the daemon. */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { onPath } from "@loom/core/paths";
import { loadConfig } from "../../backend/daemon/src/config/config.ts";
import { userConfigPath } from "../../backend/daemon/src/scaffold.ts";
import {
  inspectArtifact,
  requireVmHost,
  bundledRuntime,
  resolveRuntime,
  runtimeHome,
  runtimeKey,
  type RuntimeLock,
} from "../../runtime/src/packaged/artifact.ts";

const recipe = (source: string): string => {
  if (source === "tilth")
    return `path:${fileURLToPath(new URL("../../packaging/runtimes", import.meta.url))}`;
  if (!/^(github:|gitlab:|git\+https:\/\/|path:\/)/.test(source))
    throw new Error(
      `Unknown runtime ${source}; use tilth or a Nix flake reference producing a Loom runtime artifact`,
    );
  return source;
};
const checked = async (command: string, args: string[]) => {
  let result: Deno.CommandOutput;
  try {
    result = await new Deno.Command(command, { args, stdout: "piped", stderr: "inherit" }).output();
  } catch (cause) {
    throw new Error(`Cannot run ${command}; install it before preparing runtimes`, { cause });
  }
  if (!result.success)
    throw new Error(`${command} failed (${result.code}); the previous runtime remains selected`);
  return new TextDecoder().decode(result.stdout).trim();
};
export const prepareRuntime = async (
  source: string,
  opts: { home?: string; smolvm?: string; update?: boolean } = {},
) => {
  requireVmHost();
  if (await bundledRuntime(source)) {
    if (opts.update)
      throw new Error(
        `Runtime ${source} is bundled with Loom; update the Loom Nix package (nix profile upgrade loom) instead.`,
      );
    return await resolveRuntime(source);
  }
  const home = opts.home ?? runtimeHome();
  if (!opts.update) {
    let exists = false;
    try {
      await Deno.lstat(join(home, await runtimeKey(source), "current"));
      exists = true;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (exists) {
      try {
        return await resolveRuntime(source, home);
      } catch (cause) {
        throw new Error(
          `Prepared runtime ${source} is damaged; restore its pinned store paths or explicitly run loom runtime update ${source}`,
          { cause },
        );
      }
    }
  }
  const flake = recipe(source);
  let previousBackend: string | undefined;
  if (opts.update) {
    try {
      previousBackend = (await resolveRuntime(source, home)).lock.smolvm;
    } catch {
      /* A damaged selection may need a freshly installed backend too. */
    }
  }
  const executable = opts.smolvm ?? previousBackend ?? (onPath("smolvm") ? "smolvm" : undefined);
  if (!executable)
    throw new Error(
      "smolvm is not installed; install its Nix package or pass --smolvm /nix/store/.../bin/smolvm",
    );
  // PATH lookup is preparation-only; session launch always uses the pinned executable.
  let smolvm: string;
  if (executable.includes("/")) smolvm = await Deno.realPath(resolve(executable));
  else {
    const found = (Deno.env.get("PATH") ?? "")
      .split(":")
      .map((p) => join(p, executable))
      .find((p) => {
        try {
          return Deno.statSync(p).isFile;
        } catch {
          return false;
        }
      });
    if (!found) throw new Error("smolvm executable not found");
    smolvm = await Deno.realPath(found);
  }
  const backendStore = smolvm.match(/^(\/nix\/store\/[a-z0-9]{32}-[^/\s]+)\/bin\/[^/\s]+$/)?.[1];
  if (!backendStore)
    throw new Error("For reproducible VM preparation, smolvm must come from a Nix store package");
  await checked(smolvm, ["--version"]);
  const parent = join(home, await runtimeKey(source));
  await Deno.mkdir(parent, { recursive: true, mode: 0o700 });
  // Generations are retained: an update cannot GC an artifact used by a live session.
  const generation = await Deno.makeTempDir({ dir: parent, prefix: "generation-" });
  try {
    await checked("nix", [
      "--extra-experimental-features",
      "nix-command flakes",
      "build",
      "--no-write-lock-file",
      "--out-link",
      join(generation, "artifact"),
      flake,
    ]);
    const artifact = await Deno.realPath(join(generation, "artifact"));
    const manifest = await inspectArtifact(artifact);
    await checked("nix-store", [
      "--add-root",
      join(generation, "backend"),
      "--indirect",
      "--realise",
      backendStore,
    ]);
    const lock: RuntimeLock = {
      version: 1,
      source,
      artifact,
      smolvm,
      preparedAt: new Date().toISOString(),
    };
    await Deno.writeTextFile(join(generation, "lock.json"), JSON.stringify(lock, null, 2) + "\n", {
      mode: 0o600,
    });
    const next = join(parent, `next-${crypto.randomUUID()}`);
    await Deno.symlink(generation, next);
    await Deno.rename(next, join(parent, "current"));
    return { lock, manifest };
  } catch (error) {
    await Deno.remove(generation, { recursive: true }).catch(() => {});
    throw error;
  }
};
export const runtimeCommand = async (
  args: string[],
  repoRoot: string,
  opts: { smolvm?: string; json: boolean },
) => {
  const [action, name, ...rest] = args;
  if (!action || !["prepare", "status", "update"].includes(action) || rest.length)
    throw new Error("Usage: loom runtime prepare|status|update [runtime] [--smolvm PATH] [--json]");
  const config = loadConfig(join(repoRoot, ".loom/config.toml"), userConfigPath());
  const sources = name
    ? [name]
    : [
        ...new Set([
          ...(action === "update" ? ["tilth"] : []),
          ...config.mcp.flatMap((m) => ("runtime" in m ? [m.runtime] : [])),
        ]),
      ];
  const rows = [];
  for (const source of sources) {
    try {
      const prepared =
        action === "status"
          ? await resolveRuntime(source)
          : await prepareRuntime(source, {
              ...(opts.smolvm ? { smolvm: opts.smolvm } : {}),
              update: action === "update",
            });
      rows.push({
        runtime: source,
        status: "ready",
        system: prepared.manifest.system,
        artifact: prepared.lock.artifact,
        smolvm: prepared.lock.smolvm,
      });
    } catch (error) {
      rows.push({
        runtime: source,
        status: "not ready",
        error: error instanceof Error ? error.message : String(error),
      });
      Deno.exitCode = 1;
    }
  }
  if (opts.json) return JSON.stringify(rows, null, 2) + "\n";
  if (!rows.length) return "No packaged runtimes configured.\n";
  return (
    rows
      .map((r) => `${r.runtime}: ${r.status}${"error" in r ? ` — ${r.error}` : ` (${r.system})`}`)
      .join("\n") + "\n"
  );
};
