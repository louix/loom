import {
  environmentEnabled,
  type SessionEnvironment,
} from "../../../core/src/session-environment.ts";
import { WorkerDiagnostic } from "../../../core/src/worker.ts";
import { fileURLToPath } from "node:url";
import { detectNixActivation, nixActivationCommand } from "../../../core/src/nix-activation.ts";
import { readStartupProgress, reportStartup } from "./progress.ts";

/** Debian login shells reset PATH before sourcing /etc/profile.d. */
export const guestPathProfile = (path: string): string =>
  `export PATH='${path.replaceAll("'", "'\\''")}'\n`;

/** Build the environment during explicit preparation; setup output stays off the worker protocol. */
export const prepareEnvironment = async (
  config: SessionEnvironment | undefined,
  options: {
    shell: string;
    cwd?: string;
    initializeNix?: (signal: AbortSignal) => Promise<void>;
    output?: "inherit";
  },
): Promise<Record<string, string> | undefined> => {
  if (!environmentEnabled(config)) return;
  const activation = config!.commandPrefix.length
    ? undefined
    : detectNixActivation(options.cwd ?? Deno.cwd(), config!.autoNix);
  if (!activation && !config!.commandPrefix.length && !config!.prepare) return;
  const directory = await Deno.makeTempDir({ prefix: "loom-environment-" });
  const snapshot = directory + "/environment.json";
  let child: Deno.ChildProcess | undefined;
  let timedOut = false;
  const stop = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    stop.abort();
    try {
      child?.kill("SIGKILL");
    } catch {
      /* exited */
    }
  }, config!.timeoutMs);
  try {
    reportStartup("nix");
    await options.initializeNix?.(stop.signal);
    if (timedOut) {
      throw new WorkerDiagnostic(activation ? "sessionNixTimeout" : "sessionEnvironmentTimeout");
    }
    // Prefix entries and the setup body are separate argv entries. Only the
    // explicitly configured shell body is interpreted as code.
    const command = [
      options.shell,
      "-c",
      'set -e\nif [ -n "$2" ]; then if [ -n "$1" ]; then printf "\\nRunning repo setup…\\n" >&2; else printf \'{"loomStartup":"prepare"}\\n\' >&2; fi; fi\nshift\neval "$1"\nshift\nexec "$@"',
      "loom-prepare",
      options.output ?? "",
      config!.prepare,
      Deno.execPath(),
      "run",
      "--no-config",
      "--no-lock",
      "--allow-env",
      `--allow-write=${snapshot}`,
      fileURLToPath(new URL("./capture-environment.ts", import.meta.url)),
      snapshot,
    ];
    let argv = command;
    if (config!.commandPrefix.length) {
      argv = [...config!.commandPrefix, ...command];
    } else if (activation) argv = nixActivationCommand(activation, command);
    reportStartup(activation?.kind ?? "activate");
    child = new Deno.Command(argv[0]!, {
      args: argv.slice(1),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      stdin: "null",
      stdout: options.output ?? "null",
      stderr: options.output ?? "piped",
    }).spawn();
    const diagnostics = options.output
      ? undefined
      : readStartupProgress(child.stderr, (stage, elapsed) => reportStartup(stage, elapsed));
    const result = await child.status;
    await diagnostics;
    if (timedOut)
      throw new WorkerDiagnostic(activation ? "sessionNixTimeout" : "sessionEnvironmentTimeout");
    if (!result.success) {
      if (options.output) {
        console.error(`Repo setup exited with status ${result.code}.`);
      }
      throw new WorkerDiagnostic(activation ? "sessionNixFailed" : "sessionEnvironmentFailed");
    }
    if ((await Deno.stat(snapshot)).size > 1024 * 1024) {
      throw new WorkerDiagnostic("sessionEnvironmentFailed");
    }
    const env: unknown = JSON.parse(await Deno.readTextFile(snapshot));
    if (
      !env ||
      typeof env !== "object" ||
      Array.isArray(env) ||
      !Object.entries(env).every(
        ([k, v]) => k.length > 0 && !/[=\0]/.test(k) && typeof v === "string" && !v.includes("\0"),
      )
    ) {
      throw new WorkerDiagnostic("sessionEnvironmentFailed");
    }
    return env as Record<string, string>;
  } catch (error) {
    if (error instanceof WorkerDiagnostic) throw error;
    if (options.output) {
      console.error(error instanceof Error ? error.message : String(error));
    }
    if (activation) {
      throw new WorkerDiagnostic(timedOut ? "sessionNixTimeout" : "sessionNixFailed");
    }
    throw new WorkerDiagnostic(timedOut ? "sessionEnvironmentTimeout" : "sessionEnvironmentFailed");
  } finally {
    clearTimeout(timer);
    await Deno.remove(directory, { recursive: true });
  }
};

/** Activate and reconcile the current checkout; preparation remains a separate command. */
export const activateSessionEnvironment = (
  config: SessionEnvironment | undefined,
  options: Parameters<typeof prepareEnvironment>[1],
): Promise<Record<string, string> | undefined> =>
  prepareEnvironment(config ? { ...config, prepare: config.init ?? "" } : undefined, options);

/** The immutable artifact supplies both store files and their reference metadata. */
export const initializeGuestNix = async (signal: AbortSignal): Promise<void> => {
  Deno.env.set("TMPDIR", "/storage/loom-nix/tmp");
  await Deno.mkdir("/nix/var/nix/gcroots/loom", { recursive: true });
  const child = new Deno.Command("nix-store", {
    args: ["--load-db"],
    stdin: "piped",
    stdout: "null",
    stderr: "null",
    signal,
  }).spawn();
  const registration = await Deno.open("/run/loom/runtime/registration");
  await registration.readable.pipeTo(child.stdin);
  if (!(await child.status).success) {
    throw new WorkerDiagnostic("sessionEnvironmentFailed");
  }
  for (const path of (await Deno.readTextFile("/run/loom/runtime/store-paths"))
    .trim()
    .split("\n")) {
    const root = "/nix/var/nix/gcroots/loom/" + path.split("/").at(-1);
    try {
      await Deno.symlink(path, root);
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists) || (await Deno.readLink(root)) !== path) {
        throw error;
      }
    }
  }
};
