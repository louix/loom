import {
  applyEnvironmentChanges,
  environmentChanges,
  type EnvironmentChanges,
} from "../../../../core/src/environment-changes.ts";
import {
  detectNixActivation,
  nixActivationCommand,
  shellQuote,
} from "../../../../core/src/nix-activation.ts";
import { executeShellHook } from "../../../../core/src/shell-hook.ts";
import { isAbsolute, join, delimiter } from "node:path";
import type { WorkerLaunchSpec } from "./worker-launch.ts";

/** Host-only launch metadata: symbols survive wrapper spreads, but never cross the worker wire. */
export const localSessionEnvironment = Symbol("localSessionEnvironment");
export type LocalSessionEnvironment = { [localSessionEnvironment]?: EnvironmentChanges };
export { applyEnvironmentChanges };
export type { EnvironmentChanges };

export const activateLocalEnvironment = async (
  cwd: string,
  allowed: boolean,
  signal: AbortSignal,
  progress: (message: string) => void | Promise<void> = () => {},
  timeoutMs = 900_000,
): Promise<EnvironmentChanges | undefined> => {
  signal.throwIfAborted();
  const activation = detectNixActivation(cwd, allowed);
  if (!activation) return;
  await progress(
    `Activating ${activation.kind === "devenv" ? "devenv" : `Nix ${activation.kind}.nix`}…`,
  );
  const directory = await Deno.makeTempDir({ prefix: "loom-activation-" });
  try {
    const snapshot = directory + "/environment.json";
    // Keep activation independent of inherited dev-shell exports, and avoid forwarding
    // unrelated daemon credentials to the worker through the captured environment.
    const before = Object.fromEntries(
      Object.entries(Deno.env.toObject()).filter(([key]) =>
        [
          "HOME",
          "PATH",
          "USER",
          "LOGNAME",
          "SHELL",
          "LANG",
          "LC_ALL",
          "TZ",
          "TMPDIR",
          "SSL_CERT_FILE",
          "SSL_CERT_DIR",
          "NIX_SSL_CERT_FILE",
          "NIX_PATH",
          "NIX_CONFIG",
          "NIX_REMOTE",
          "NIX_USER_CONF_FILES",
          "XDG_CONFIG_HOME",
          "XDG_CACHE_HOME",
          "XDG_DATA_HOME",
          "HTTP_PROXY",
          "HTTPS_PROXY",
          "NO_PROXY",
          "http_proxy",
          "https_proxy",
          "no_proxy",
        ].includes(key),
      ),
    );
    const argv = nixActivationCommand(activation, [
      Deno.execPath(),
      "eval",
      "--no-config",
      "--no-lock",
      "Deno.writeTextFileSync(Deno.args[0], JSON.stringify(Deno.env.toObject()))",
      snapshot,
    ]);
    const result = await executeShellHook(
      argv.map(shellQuote).join(" "),
      cwd,
      before,
      timeoutMs,
      signal,
    );
    signal.throwIfAborted();
    if (result.code !== 0)
      throw new Error(
        `Nix activation ${result.timedOut ? "timed out" : `exited ${result.code}`}:\n${result.output || "(no output)"}\nCheck Nix and the selected dev shell, or set session.auto_nix to false.`,
      );
    if ((await Deno.stat(snapshot)).size > 1024 * 1024)
      throw new Error("Nix environment exceeds 1 MiB");
    const after = JSON.parse(await Deno.readTextFile(snapshot));
    if (
      !after ||
      typeof after !== "object" ||
      Array.isArray(after) ||
      !Object.entries(after).every(
        ([key, value]) =>
          key.length > 0 &&
          !/[=\0]/.test(key) &&
          typeof value === "string" &&
          !value.includes("\0"),
      )
    )
      throw new Error("Invalid Nix environment snapshot");
    const changes = environmentChanges({}, after);
    changes.unset = environmentChanges(before, after).unset;
    return changes;
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
};

/** Apply before launch, retaining the worker's private scratch and profile paths. */
export const applyLocalSessionEnvironment = (
  spec: WorkerLaunchSpec,
  changes?: EnvironmentChanges,
): void => {
  if (!changes) return;
  spec.env = applyEnvironmentChanges(spec.env, changes);
  // Native Bash tools may start login shells whose profiles replace PATH.
  // BASH_ENV is read after those profiles by noninteractive Bash commands.
  const directory = Deno.makeTempDirSync({
    dir: spec.env.TMPDIR || "/tmp",
    prefix: "loom-shell-env-",
  });
  (spec.cleanupPaths ??= []).push(directory);
  const bootstrap = join(directory, "environment.sh");
  const previous = spec.env.BASH_ENV;
  const lines = previous
    ? [`if [ -f ${shellQuote(previous)} ]; then . ${shellQuote(previous)}; fi`]
    : [];
  for (const key of changes.unset)
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) lines.push(`unset ${key}`);
  for (const [key, value] of Object.entries(changes.set))
    if (key !== "BASH_ENV" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      lines.push(`export ${key}=${shellQuote(value)}`);
  Deno.writeTextFileSync(bootstrap, lines.join("\n") + "\n", { mode: 0o600 });
  spec.env.BASH_ENV = bootstrap;
  spec.env.LOOM_PROJECT_ENVIRONMENT = "1";
  spec.permissions.read.push(bootstrap);
  for (const directory of (spec.env.PATH ?? "").split(delimiter).filter(isAbsolute))
    for (const binary of ["claude", "codex", "node", "deno", "git", "bash"])
      spec.permissions.read.push(join(directory, binary));
  for (const key of ["SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"])
    if (spec.env[key]) spec.permissions.read.push(spec.env[key]!);
  spec.permissions.read = [...new Set(spec.permissions.read)];
};
