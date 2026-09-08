/** Controlled Git capability served by a separate, session-scoped host worker. */
import { isAbsolute, join, resolve } from "node:path";
import { sessionGitArgs, isGitWrite } from "./arguments.ts";
import { validateGitLayout } from "./layout.ts";
import { boundBranch, checkWriteState, finishWriteState } from "./write-state.ts";

const MAX_REQUEST = 4096;
const MAX_OUTPUT = 64 * 1024;
const MAX_CONNECTIONS = 8;
const REQUEST_TIMEOUT = 65_000;
const encoder = new TextEncoder();
// Serialize requests locally as well as across Git worker processes.
const operations = new Map<string, Promise<void>>();

export const gitArguments = function (value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid request");
  const r = value as Record<string, unknown>;
  if (r.version !== 1) throw new Error("unsupported version");
  const keys = (allowed: string[]) => {
    if (Object.keys(r).some((k) => !["version", "op", ...allowed].includes(k)))
      throw new Error("unsupported field");
  };
  switch (r.op) {
    case "git":
      keys(["args", "cwd"]);
      if (typeof r.cwd !== "string") throw new Error("Missing Git cwd");
      return sessionGitArgs(r.args);
    case "status":
      keys([]);
      return ["status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=all"];
    case "diff":
      keys(["staged"]);
      if (r.staged !== undefined && typeof r.staged !== "boolean")
        throw new Error("invalid staged flag");
      return [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--ignore-submodules=all",
        ...(r.staged ? ["--cached"] : []),
        "--",
      ];
    case "log": {
      keys(["limit", "ref"]);
      const limit = r.limit ?? 10;
      if (!Number.isInteger(limit) || typeof limit !== "number" || limit < 1 || limit > 50)
        throw new Error("invalid limit");
      const ref = r.ref ?? "HEAD";
      // No options, rev:path, reflog selectors, ranges, magic pathspecs or arbitrary expressions.
      if (
        typeof ref !== "string" ||
        ref.length > 200 ||
        !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(ref) ||
        ref.includes("..") ||
        ref.includes("//") ||
        ref.endsWith("/") ||
        ref.endsWith(".") ||
        ref.split("/").some((p) => p.startsWith(".") || p.endsWith(".lock"))
      )
        throw new Error("invalid ref");
      return [
        "log",
        "--no-color",
        "--no-decorate",
        "--no-show-signature",
        "--format=%h %s",
        `--max-count=${limit}`,
        ref,
        "--",
      ];
    }
    default:
      throw new Error("unsupported operation");
  }
};

export interface GitBridgeOptions {
  /** All paths are selected by the trusted host, never supplied in a request. */
  workspace: string;
  gitDir: string;
  commonDir: string;
  git: string;
  /** Existing private supervisor directory outside the guest workspace. */
  state: string;
  writable?: boolean;
  /** Permit configured programs to execute on the host. Host policy only. */
  allowRepoPrograms?: boolean;
}

/** Trusted supervisor setup. Deno restricts symlink creation to unscoped grants. */
export const prepareGitBridge = async function (options: GitBridgeOptions) {
  const [workspace, gitDir, commonDir, state, git] = await Promise.all([
    Deno.realPath(options.workspace),
    Deno.realPath(options.gitDir),
    Deno.realPath(options.commonDir),
    Deno.realPath(options.state),
    Deno.realPath(options.git),
  ]);
  for (const path of [gitDir, commonDir, state]) {
    if (path === workspace || path.startsWith(workspace + "/"))
      throw new Error("Git metadata and bridge state must be outside the guest workspace");
  }
  // Bind the supplied linked-worktree admin directory without reading the guest's .git pointer.
  const backlink = (await Deno.readTextFile(join(gitDir, "gitdir"))).trim();
  if (!isAbsolute(backlink) || resolve(backlink) !== join(workspace, ".git"))
    throw new Error("Worktree backlink mismatch");
  const common = await Deno.realPath(
    resolve(gitDir, (await Deno.readTextFile(join(gitDir, "commondir"))).trim()),
  );
  if (common !== commonDir) throw new Error("Git common directory mismatch");
  const dir = await Deno.makeTempDir({ dir: state, prefix: "git-bridge-" });
  try {
    await Deno.chmod(dir, 0o700);
    const shadow = join(dir, "metadata");
    await Deno.mkdir(shadow);
    // Expose only data to Git. Never load the original config, includes, hooks,
    // info/attributes, worktree config or repo-defined executable helpers.
    await Deno.writeTextFile(
      join(shadow, "config"),
      "[core]\nrepositoryformatversion = 0\nbare = false\n",
    );
    for (const name of ["objects", "refs", "packed-refs"])
      await Deno.symlink(join(commonDir, name), join(shadow, name));
    const control = join(gitDir, "loom-bridge");
    await Deno.mkdir(control, { recursive: true, mode: 0o700 });
    const writable = options.writable === true;
    const allowRepoPrograms = options.allowRepoPrograms === true;
    const programPath = allowRepoPrograms ? (Deno.env.get("PATH") ?? "") : "";
    return {
      workspace,
      gitDir,
      commonDir,
      state,
      git,
      dir,
      shadow,
      control,
      writable,
      allowRepoPrograms,
      programPath,
    };
  } catch (error) {
    await Deno.remove(dir, { recursive: true });
    throw error;
  }
};

export type PreparedGitBridge = Awaited<ReturnType<typeof prepareGitBridge>>;

export const startGitBridge = async function (options: GitBridgeOptions) {
  return await startPreparedGitBridge(await prepareGitBridge(options));
};

/** Binding comes from a private host-created file, never the guest protocol. */
export const startPreparedGitBridge = async function (prepared: PreparedGitBridge) {
  const { workspace, gitDir, git, dir, shadow } = prepared;
  try {
    const identity = await validateGitLayout(prepared);
    await Deno.writeTextFile(
      join(shadow, "config"),
      `[core]\nrepositoryformatversion=0\nbare=false\n[user]\nname=${JSON.stringify(identity.name)}\nemail=${JSON.stringify(identity.email)}\n`,
    );
    const branch = await boundBranch(prepared);
    const gitPath = prepared.writable ? git.slice(0, git.lastIndexOf("/")) : dir;
    const env = {
      HOME: dir,
      XDG_CONFIG_HOME: dir,
      PATH: prepared.allowRepoPrograms ? prepared.programPath : gitPath,
      GIT_EDITOR: ":",
      GIT_SEQUENCE_EDITOR: ":",
      LC_ALL: "C",
      TZ: "UTC",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      GIT_INDEX_FILE: join(gitDir, "index"),
      ...(!prepared.writable ? { GIT_EXEC_PATH: dir } : {}),
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_NO_LAZY_FETCH: "1",
    };
    const run = async (args: string[], signal: AbortSignal) => {
      signal.throwIfAborted();
      // Git treats a symlink HEAD as a symbolic ref, not a file to dereference.
      // Refresh its tiny contents atomically so host checkout/rebase is visible.
      const head = join(shadow, `HEAD-${crypto.randomUUID()}`);
      await Deno.copyFile(join(gitDir, "HEAD"), head);
      await Deno.rename(head, join(shadow, "HEAD"));
      signal.throwIfAborted();
      const commandArgs = [
        "--no-pager",
        "--literal-pathspecs",
        `--git-dir=${prepared.writable ? gitDir : shadow}`,
        `--work-tree=${workspace}`,
        ...(!prepared.allowRepoPrograms
          ? ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"]
          : []),
        ...[
          "commit.gpgSign=false",
          "gc.auto=0",
          "maintenance.auto=false",
          "rebase.updateRefs=false",
          "rebase.autoStash=false",
          "rebase.autoSquash=false",
          "rebase.rebaseMerges=false",
          "rebase.instructionFormat=%s",
          "rebase.abbreviateCommands=false",
          "rerere.enabled=false",
          "submodule.recurse=false",
          `user.name=${identity.name}`,
          `user.email=${identity.email}`,
        ].flatMap((value) => ["-c", value]),
        "-c",
        "core.attributesFile=/dev/null",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "core.quotePath=true",
        ...args,
      ];
      const child = new Deno.Command(git, {
        args: commandArgs,
        clearEnv: true,
        env,
        cwd: workspace,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const kill = () => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already exited */
        }
      };
      signal.addEventListener("abort", kill, { once: true });
      let size = 0;
      const read = async (stream: ReadableStream<Uint8Array>) => {
        const chunks: Uint8Array[] = [];
        for await (const bytes of stream) {
          size += bytes.length;
          if (size > MAX_OUTPUT) {
            kill();
            throw new Error("output limit exceeded");
          }
          chunks.push(bytes);
        }
        const result = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.length;
        }
        return new TextDecoder().decode(result);
      };
      try {
        const results = await Promise.allSettled([
          read(child.stdout),
          read(child.stderr),
          child.status,
        ]);
        for (const result of results) if (result.status === "rejected") throw result.reason;
        signal.throwIfAborted();
        const stdout = (results[0] as PromiseFulfilledResult<string>).value;
        const stderr = (results[1] as PromiseFulfilledResult<string>).value;
        const status = (results[2] as PromiseFulfilledResult<Deno.CommandStatus>).value;
        return { version: 1, ok: true, code: status.code, stdout, stderr };
      } finally {
        signal.removeEventListener("abort", kill);
        kill();
        await child.status;
      }
    };
    const execute = async (args: string[], signal: AbortSignal) => {
      const previous = operations.get(prepared.control);
      const turn = Promise.withResolvers<void>();
      operations.set(prepared.control, turn.promise);
      await previous;
      let lock: Deno.FsFile | undefined;
      let started = false;
      try {
        lock = await Deno.open(join(prepared.control, "operation.lock"), {
          create: true,
          read: true,
          write: true,
        });
        await lock.lock(true);
        signal.throwIfAborted();
        if (prepared.writable) await validateGitLayout(prepared);
        if (isGitWrite(args)) {
          await checkWriteState(prepared, branch, args);
          started = true;
        }
        return await run(args, signal);
      } finally {
        try {
          if (started) await finishWriteState(prepared);
        } finally {
          lock?.close();
          turn.resolve();
          if (operations.get(prepared.control) === turn.promise)
            operations.delete(prepared.control);
        }
      }
    };
    const socket = join(dir, "git.sock");
    const listener = Deno.listen({ transport: "unix", path: socket });
    await Deno.chmod(socket, 0o600);
    const tasks = new Set<Promise<void>>();
    const active = new Map<Deno.UnixConn, AbortController>();
    const disconnect = (conn: Deno.UnixConn) => {
      try {
        conn.close();
      } catch {
        /* closed */
      }
    };
    const serve = async (conn: Deno.UnixConn, controller: AbortController) => {
      const timer = setTimeout(() => {
        controller.abort();
        disconnect(conn);
      }, REQUEST_TIMEOUT);
      try {
        const bytes = new Uint8Array(MAX_REQUEST);
        let size = 0;
        while (size < bytes.length) {
          const n = await conn.read(bytes.subarray(size));
          if (n === null) return;
          size += n;
          const newline = bytes.subarray(0, size).indexOf(10);
          if (newline < 0) continue;
          let args: string[];
          let response: unknown;
          try {
            const request = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, newline)),
            );
            if (request?.op === "git" && request.cwd !== workspace)
              throw new Error("Git bridge currently requires the session worktree root");
            args = gitArguments(request);
          } catch {
            args = [];
            response = { version: 1, ok: false, error: "invalid-request" };
          }
          if (args.length) {
            try {
              response = await execute(args, controller.signal);
            } catch (error) {
              response = {
                version: 1,
                ok: false,
                error: "execution-failed",
                ...(isGitWrite(args)
                  ? { message: error instanceof Error ? error.message : "Git operation failed" }
                  : {}),
              };
            }
          }
          const reply = encoder.encode(JSON.stringify(response) + "\n");
          let offset = 0;
          while (offset < reply.length) offset += await conn.write(reply.subarray(offset));
          return;
        }
      } catch {
        /* A cancelled write can leave normal Git recovery state; never replay it. */
      } finally {
        clearTimeout(timer);
        controller.abort();
        active.delete(conn);
        disconnect(conn);
      }
    };
    const serving = (async () => {
      try {
        for await (const conn of listener) {
          if (active.size >= MAX_CONNECTIONS) {
            disconnect(conn);
            continue;
          }
          const controller = new AbortController();
          active.set(conn, controller);
          const task = serve(conn, controller);
          tasks.add(task);
          void task.finally(() => tasks.delete(task));
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.BadResource)) throw error;
      }
    })();
    let closing: Promise<void> | undefined;
    return {
      socket,
      close: () =>
        (closing ??= (async () => {
          listener.close();
          for (const [conn, controller] of active) {
            controller.abort();
            disconnect(conn);
          }
          await serving;
          await Promise.all(tasks);
          await Deno.remove(dir, { recursive: true });
        })()),
    };
  } catch (error) {
    await Deno.remove(dir, { recursive: true });
    throw error;
  }
};
