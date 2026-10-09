/**
 * loom-isolate: run commands in a smolvm environment over a caller's workspace,
 * through the isolation library, with no Loom daemon, client, TUI or agent code.
 * Ownership is foreground-only: each command owns its environment for its own
 * lifetime and stops the VM before it exits.
 */
import { parseArgs } from "node:util";
import { join } from "node:path";
import { ExecutionLeases } from "@loom/isolation/execution-leases";
import { executionOptionsSchema } from "../../../core/src/execution.ts";
import { LOOM_VERSION } from "../../../core/src/version.ts";
import { vmCommand } from "../../../runtime/src/session-vm/command.ts";
import { createVmEnvironmentCoordinator } from "../../../runtime/src/session-vm/coordinator.ts";
import { launchEnvironmentVm } from "../../../runtime/src/session-vm/environment-launch.ts";
import { normalizeExtraHosts } from "../../../runtime/src/session-vm/network-policy.ts";
import { SessionVmBusyError } from "../../../runtime/src/session-vm/persistence.ts";
import {
  guestCommand,
  guestSignalScript,
  routeSignals,
  signalStatus,
  spawnForeground,
  type ForegroundChild,
  type HostSignal,
} from "./foreground.ts";
import { selectRuntime, verifyRuntime, type RuntimeReport } from "./runtime.ts";
import {
  environmentId,
  environmentStatus,
  isolateStateRoot,
  listEnvironmentIds,
  ownEnvironment,
  ownEnvironmentById,
  resolveWorkspace,
  UsageError,
  type OwnedEnvironment,
} from "./state.ts";

export const HELP = `loom-isolate — run commands in a smolvm VM over a workspace

usage:
  loom-isolate prepare [options]               verify the runtime and boot the environment once
  loom-isolate exec [options] -- CMD [ARG]...  run CMD with literal arguments in the VM
  loom-isolate inspect [--all] [--json]        show environment and runtime status
  loom-isolate cleanup [--all]                 recover leftovers and remove this tool's state

options:
  -w, --workspace DIR    directory mounted read-write in the VM (default: current directory)
  -n, --name NAME        environment of the workspace (default: "default")
      --artifact PATH    Loom session runtime (default: packaged runtime, then last prepare)
      --smolvm PATH      smolvm executable (default: packaged smolvm, then last prepare)
      --allow-host HOST  exec only: allow HTTPS egress to HOST (repeatable); all else is denied
  -t, --tty              exec only: allocate a terminal (needs interactive stdin and stdout)
      --no-stdin         exec only: do not forward stdin
  -q, --quiet            omit startup progress
      --json             inspect only: machine-readable output
      --all              inspect/cleanup every loom-isolate environment
  -h, --help             show this help
      --version          show the version

Each command owns its environment while it runs; the VM stops when it exits.
State lives in \${XDG_STATE_HOME:-~/.local/state}/loom-isolate, apart from Loom's.
exec exits with the command's status (128+N if ended by signal N), 125 when
loom-isolate itself fails, and 2 for usage errors.
`;

/** Injected by tests; production uses the smolvm launcher and its runtime checks. */
export interface IsolateDependencies {
  backend?: { launch: typeof launchEnvironmentVm; command: typeof vmCommand };
  verifyRuntime?: typeof verifyRuntime;
  leases?: ExecutionLeases;
}

const encoder = new TextEncoder();
const out = (text: string) => void Deno.stdout.writeSync(encoder.encode(text));
const err = (text: string) => void Deno.stderr.writeSync(encoder.encode(text));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Values = ReturnType<typeof parse>["values"];
const parse = (args: string[]) =>
  parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      workspace: { type: "string", short: "w" },
      name: { type: "string", short: "n", default: "default" },
      artifact: { type: "string" },
      smolvm: { type: "string" },
      "allow-host": { type: "string", multiple: true },
      tty: { type: "boolean", short: "t" },
      "no-stdin": { type: "boolean" },
      quiet: { type: "boolean", short: "q" },
      json: { type: "boolean" },
      all: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
    },
  });

export const isolateCli = async (
  args: string[],
  dependencies: IsolateDependencies = {},
): Promise<number> => {
  try {
    // Everything after "--" is the guest argv, never parsed as options.
    const separator = args.indexOf("--");
    const argv = separator < 0 ? [] : args.slice(separator + 1);
    let parsed: ReturnType<typeof parse>;
    try {
      parsed = parse(separator < 0 ? args : args.slice(0, separator));
    } catch (error) {
      throw new UsageError(message(error));
    }
    const { values, positionals } = parsed;
    if (values.help) {
      out(HELP);
      return 0;
    }
    if (values.version) {
      out(`loom-isolate ${LOOM_VERSION}\n`);
      return 0;
    }
    const [command, ...rest] = positionals;
    if (rest.length) throw new UsageError("Unexpected argument: " + rest[0]);
    if (command !== "exec" && separator >= 0)
      throw new UsageError("Only exec takes a command after --.");
    const execOnly = (["allow-host", "tty", "no-stdin"] as const).find(
      (flag) => values[flag] !== undefined,
    );
    if (execOnly && command !== "exec") throw new UsageError(`--${execOnly} applies only to exec.`);
    if (values.json && command !== "inspect")
      throw new UsageError("--json applies only to inspect.");
    if (values.all && command !== "inspect" && command !== "cleanup")
      throw new UsageError("--all applies only to inspect and cleanup.");
    switch (command) {
      case "prepare":
        return await prepare(values, dependencies);
      case "exec":
        return await exec(values, argv, dependencies);
      case "inspect":
        return await inspect(values, dependencies);
      case "cleanup":
        return await cleanup(values);
      case undefined:
        throw new UsageError("Choose a command: prepare, exec, inspect or cleanup.");
      default:
        throw new UsageError("Unknown command: " + command);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      err(`loom-isolate: ${error.message}\nRun loom-isolate --help for usage.\n`);
      return 2;
    }
    err(`loom-isolate: ${message(error)}\n`);
    return 125;
  }
};

/** A crashed predecessor's supervisor may still be reaping; wait for it, then recover. */
const recover = async (
  environment: OwnedEnvironment,
  progress: (text: string) => void,
  signal: AbortSignal,
) => {
  const deadline = Date.now() + 60_000;
  for (let waiting = false; ;) {
    try {
      await environment.storage.withStopped(environment.id, async () => {});
      return;
    } catch (error) {
      if (!(error instanceof SessionVmBusyError) || Date.now() >= deadline) throw error;
      signal.throwIfAborted();
      if (!waiting) progress("Waiting for the previous VM of this environment to stop…");
      waiting = true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
};

interface Session {
  environment: OwnedEnvironment;
  runtime: RuntimeReport;
  coordinator: ReturnType<typeof createVmEnvironmentCoordinator>;
  /** Owns every lease this process takes; aborting it disconnects them. */
  owner: AbortController;
}

/**
 * Own the workspace's environment and boot it, cancelling on any routed signal.
 * Always stops the VM and releases ownership before returning.
 */
const withEnvironment = async (
  values: Values,
  dependencies: IsolateDependencies,
  options: { activity: string; extraAllowedHosts?: string[] },
  run: (
    session: Session,
    setSignal: (handle: (signal: HostSignal) => void) => void,
  ) => Promise<number>,
): Promise<number> => {
  const workspace = await resolveWorkspace(values.workspace ?? Deno.cwd());
  environmentId(workspace, values.name);
  let phase: "starting" | "running" | "stopping" = "starting";
  const progress = (text: string) => {
    if (!values.quiet) err(`loom-isolate: ${text}\n`);
  };
  let received: HostSignal | undefined;
  const cancelled = new AbortController();
  let onSignal = (signal: HostSignal) => {
    received ??= signal;
    cancelled.abort();
  };
  const unroute = routeSignals((signal) => onSignal(signal));
  try {
    const environment = await ownEnvironment(workspace, values.name, true);
    if (!environment) throw new Error("Could not create the environment");
    try {
      const runtime = await (dependencies.verifyRuntime ?? verifyRuntime)(
        selectRuntime(values, environment.record.runtime),
      );
      await recover(environment, progress, cancelled.signal);
      cancelled.signal.throwIfAborted();
      const coordinator = createVmEnvironmentCoordinator(
        environment.storage,
        dependencies.backend,
        dependencies.leases ?? new ExecutionLeases(),
      );
      const owner = new AbortController();
      const stopStartup = () => {
        if (coordinator.inspect(environment.id).phase === "starting")
          void coordinator.stop(environment.id).catch(() => {});
      };
      cancelled.signal.addEventListener("abort", stopStartup, { once: true });
      try {
        await coordinator.start(environment.id, {
          mode: "execution",
          workspace,
          artifact: runtime.artifact,
          smolvm: runtime.smolvm,
          activity: () => options.activity,
          ...(options.extraAllowedHosts?.length
            ? { extraAllowedHosts: options.extraAllowedHosts }
            : {}),
          onProgress: (text, termination) => {
            // Startup progress, and a VM ending under a running command; not our own stop.
            if (phase === "starting" || (phase === "running" && termination)) progress(text);
          },
        });
        cancelled.signal.removeEventListener("abort", stopStartup);
        cancelled.signal.throwIfAborted();
        phase = "running";
        return await run({ environment, runtime, coordinator, owner }, (handle) => {
          onSignal = handle;
        });
      } catch (error) {
        if (received) return signalStatus(received);
        throw error;
      } finally {
        phase = "stopping";
        // Teardown is bounded by the supervisor; further signals must not interrupt it.
        onSignal = () => {};
        // Disconnect this process's leases; forced shutdown waits for in-flight
        // signal deliveries to settle, then stops the VM.
        owner.abort();
        await coordinator.close();
      }
    } finally {
      environment.release();
    }
  } catch (error) {
    if (received) return signalStatus(received);
    throw error;
  } finally {
    unroute();
  }
};

const prepare = async (values: Values, dependencies: IsolateDependencies) => {
  const started = Date.now();
  return await withEnvironment(
    values,
    dependencies,
    { activity: "loom-isolate prepare" },
    async ({ environment, runtime }) => {
      await environment.update({
        runtime: { artifact: runtime.artifact, smolvm: runtime.smolvm },
        preparedAt: new Date().toISOString(),
      });
      out(
        `Prepared ${environment.id} for ${environment.record.workspace} in ${Math.round((Date.now() - started) / 1000)}s\n` +
          `  runtime ${runtime.artifact}\n  smolvm  ${runtime.smolvm} (${runtime.smolvmVersion})\n`,
      );
      return 0;
    },
  );
};

const exec = async (values: Values, argv: string[], dependencies: IsolateDependencies) => {
  if (!argv.length) throw new UsageError("Pass the command after --, e.g. exec -- make test.");
  const stdin = !values["no-stdin"];
  const tty = values.tty ?? false;
  if (tty && !stdin) throw new UsageError("--tty requires stdin.");
  if (tty && (!Deno.stdin.isTerminal() || !Deno.stdout.isTerminal()))
    throw new UsageError("--tty requires an interactive terminal on stdin and stdout.");
  const user = executionOptionsSchema.safeParse({ argv, stdin, tty });
  if (!user.success)
    throw new UsageError("Invalid command: pass an executable that does not start with '-'.");
  let extraAllowedHosts: string[];
  try {
    extraAllowedHosts = normalizeExtraHosts(values["allow-host"] ?? []);
  } catch {
    throw new UsageError(
      "--allow-host takes exact DNS names (HTTPS only; no URLs, IPs or wildcards).",
    );
  }
  const terminal = Object.fromEntries(
    ["TERM", "COLORTERM"].flatMap((key) => {
      const value = Deno.env.get(key);
      return value && /^[a-zA-Z0-9._+-]{1,128}$/.test(value) ? [[key, value]] : [];
    }),
  );
  return await withEnvironment(
    values,
    dependencies,
    { activity: "loom-isolate exec", extraAllowedHosts },
    async ({ environment, coordinator, owner }, setSignal) => {
      const pidFile = `/tmp/loom-isolate-${crypto.randomUUID()}.pid`;
      const target = coordinator.openExecution(
        environment.id,
        {
          argv: guestCommand(pidFile, argv),
          stdin,
          tty,
          ...(tty ? { terminal } : {}),
        },
        owner,
      );
      let child: ForegroundChild | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let terminatedBy: HostSignal | undefined;
      let forced = false;
      const resize = () => child?.kill("SIGWINCH");
      try {
        const deliver = (signal: "INT" | "QUIT" | "TERM" | "HUP") =>
          coordinator
            .command(environment.id, guestSignalScript(pidFile, signal), 10_000, owner)
            .catch(() => {});
        child = spawnForeground(target.vm, stdin);
        // The transport runs in its own session: forward terminal resizes explicitly.
        if (tty) Deno.addSignalListener("SIGWINCH", resize);
        setSignal((signal) => {
          if (signal === "SIGINT" || signal === "SIGQUIT") {
            void deliver(signal === "SIGINT" ? "INT" : "QUIT");
            return;
          }
          // Hangup or termination: give the command a moment, then end the transport.
          if (terminatedBy) return;
          terminatedBy = signal;
          void deliver("TERM");
          killTimer = setTimeout(() => {
            forced = true;
            child?.kill("SIGKILL");
          }, 3_000);
        });
        const status = await child.status;
        return forced && terminatedBy ? signalStatus(terminatedBy) : status;
      } finally {
        clearTimeout(killTimer);
        if (tty) Deno.removeSignalListener("SIGWINCH", resize);
        coordinator.closeExecution(target.token, owner);
      }
    },
  );
};

const inspect = async (values: Values, dependencies: IsolateDependencies) => {
  const ids = values.all
    ? await listEnvironmentIds()
    : [environmentId(await Deno.realPath(values.workspace ?? Deno.cwd()), values.name)];
  const environments = await Promise.all(ids.map((id) => environmentStatus(id)));
  const runtimes = await Promise.all(
    environments.map(async (status) => {
      try {
        const runtime = selectRuntime(values, status.record?.runtime ?? null);
        return await (dependencies.verifyRuntime ?? verifyRuntime)(runtime);
      } catch (error) {
        return { error: message(error) };
      }
    }),
  );
  const report = environments.map((status, index) => ({
    ...status,
    exists: status.record !== null,
    runtime: runtimes[index]!,
  }));
  if (values.json) {
    out(JSON.stringify({ stateRoot: isolateStateRoot(), environments: report }, null, 2) + "\n");
    return 0;
  }
  out(`state ${isolateStateRoot()}\n`);
  if (!report.length) out("no environments\n");
  for (const entry of report) {
    const runtime = entry.runtime;
    out(
      [
        `environment ${entry.id}${entry.exists ? "" : " (not created)"}`,
        ...(entry.record
          ? [
              `  workspace ${entry.record.workspace}`,
              `  name      ${entry.record.name}`,
              `  created   ${entry.record.createdAt}`,
              `  prepared  ${entry.record.preparedAt ?? "never"}`,
            ]
          : []),
        `  owner     ${entry.inUse ? "in use" + (entry.ownerPid ? " by pid " + entry.ownerPid : "") : "free"}`,
        `  vm        ${entry.vmActive ? "running or awaiting recovery" : "stopped"}`,
        "error" in runtime
          ? `  runtime   unavailable: ${runtime.error}`
          : `  runtime   ${runtime.artifact}\n  smolvm    ${runtime.smolvm} (${runtime.smolvmVersion})`,
        ...(entry.error ? [`  error     ${entry.error}`] : []),
      ].join("\n") + "\n",
    );
  }
  return 0;
};

const cleanup = async (values: Values) => {
  const targets = values.all
    ? (await listEnvironmentIds()).map((id) => ({ id, own: () => ownEnvironmentById(id) }))
    : await (async () => {
        const workspace = await Deno.realPath(values.workspace ?? Deno.cwd());
        return [
          {
            id: environmentId(workspace, values.name),
            own: () => ownEnvironment(workspace, values.name, false),
          },
        ];
      })();
  let failed = 0;
  let removed = 0;
  for (const target of targets) {
    try {
      const environment = await target.own();
      if (!environment) continue;
      try {
        await environment.remove();
        removed++;
        out(`removed ${target.id}\n`);
      } finally {
        environment.release();
      }
    } catch (error) {
      failed++;
      err(`loom-isolate: ${target.id}: ${message(error)}\n`);
    }
  }
  if (!removed && !failed) out("nothing to clean up\n");
  if (values.all && !failed) {
    // Remove the namespace itself once empty; leave anything unexpected in place.
    await Deno.remove(join(isolateStateRoot(), "environments")).catch(() => {});
    await Deno.remove(isolateStateRoot()).catch(() => {});
  }
  return failed ? 125 : 0;
};
