/**
 * A session's only Git remote. Serves upload-pack and receive-pack on one fixed
 * repository under a host-owned ref policy. The guest supplies a service name,
 * ref names and pack data; it never selects a path, a host or an argument.
 */
import { z } from "zod";

/** Branch names reach `git -c` values, so accept a conservative subset of check-ref-format. */
const component = /^(?!\.)(?!.*\.\.)(?!.*\.lock$)(?!.*\.$)[A-Za-z0-9._+@-]+$/;
const validPath = (value: string) =>
  value.length <= 200 && !value.includes("@{") && value.split("/").every((c) => component.test(c));
export const gitBranchSchema = z.string().refine((v) => !v.startsWith("-") && validPath(v));
/** Extra readable ref prefixes. A trailing slash exposes a whole namespace. */
const prefixSchema = z
  .string()
  .refine((v) => v.startsWith("refs/") && v !== "refs/" && validPath(v.replace(/\/$/, "")));

export const gitPolicySchema = z.strictObject({
  /** The only ref the guest may move. */
  branch: gitBranchSchema,
  /** The branch the session was created from. Read-only. */
  base: gitBranchSchema,
  visible: z.array(prefixSchema).max(32).default([]),
});
export type GitPolicy = z.infer<typeof gitPolicySchema>;

export type GitService = "git-upload-pack" | "git-receive-pack";
export const gitRelayPath = "/repo";

/** The git-daemon request line: `<service> <path>\0host=...\0[\0version=N\0]`. */
export const parseGitRequest = (payload: Uint8Array): GitService | undefined => {
  const end = payload.indexOf(0);
  const line = new TextDecoder().decode(end === -1 ? payload : payload.subarray(0, end));
  const command = line.endsWith("\n") ? line.slice(0, -1) : line;
  // Extra parameters, including the requested protocol version, are ignored.
  if (command === `git-upload-pack ${gitRelayPath}`) return "git-upload-pack";
  if (command === `git-receive-pack ${gitRelayPath}`) return "git-receive-pack";
  return;
};

const hide = (section: string, visible: string[]) => [
  // `refs/` does not cover HEAD, which names whatever the host has checked out.
  "-c",
  `${section}.hideRefs=HEAD`,
  "-c",
  `${section}.hideRefs=refs/`,
  // Later entries win, and command-line config is read after the repository's own.
  ...visible.flatMap((ref) => ["-c", `${section}.hideRefs=!${ref}`]),
];

export const gitServiceArguments = (
  service: GitService,
  policy: GitPolicy,
  maxPushBytes: number,
): string[] => {
  const own = `refs/heads/${policy.branch}`;
  if (service === "git-upload-pack")
    return [
      ...hide("uploadpack", [`refs/heads/${policy.base}`, own, ...policy.visible]),
      // Any by-hash want reaches hidden history: reachability is computed from every ref.
      // Partial clones need by-hash wants, so filters are refused too.
      "-c",
      "uploadpack.allowFilter=false",
      "-c",
      "uploadpack.allowAnySHA1InWant=false",
      "-c",
      "uploadpack.allowTipSHA1InWant=false",
      "-c",
      "uploadpack.allowReachableSHA1InWant=false",
      "-c",
      "uploadpack.allowRefInWant=false",
      "upload-pack",
      "--strict",
      "--timeout=120",
      ".",
    ];
  return [
    // receive-pack refuses to update a hidden ref, so the policy needs no hook file.
    ...hide("receive", [own]),
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "receive.denyDeletes=true",
    "-c",
    "receive.denyNonFastForwards=false",
    "-c",
    "receive.denyCurrentBranch=refuse",
    "-c",
    "receive.fsckObjects=true",
    "-c",
    `receive.maxInputSize=${maxPushBytes}`,
    "-c",
    "receive.advertisePushOptions=false",
    "-c",
    "receive.autogc=false",
    "receive-pack",
    ".",
  ];
};

export interface GitRelayOptions {
  /** The host repository's common Git directory. */
  gitDir: string;
  /** Host-owned {@link GitPolicy}; read per connection so renames apply without a restart. */
  policyFile: string;
  maxPushBytes?: number;
  maxConnections?: number;
  requestTimeoutMs?: number;
  idleTimeoutMs?: number;
  git?: string;
}

const packet = (text: string) => {
  const body = new TextEncoder().encode(text);
  const out = new Uint8Array(body.length + 4);
  out.set(new TextEncoder().encode((body.length + 4).toString(16).padStart(4, "0")));
  out.set(body, 4);
  return out;
};

const readExactly = async (conn: Deno.Conn, size: number) => {
  const out = new Uint8Array(size);
  let filled = 0;
  while (filled < size) {
    const count = await conn.read(out.subarray(filled));
    if (count === null) throw new Error("Git request ended early");
    filled += count;
  }
  return out;
};

const readRequest = async (conn: Deno.Conn) => {
  const header = new TextDecoder().decode(await readExactly(conn, 4));
  if (!/^[0-9a-f]{4}$/.test(header)) throw new Error("Invalid Git request");
  const length = Number.parseInt(header, 16);
  if (length < 5 || length > 4096) throw new Error("Invalid Git request");
  return parseGitRequest(await readExactly(conn, length - 4));
};

export const startGitRelay = (path: string, options: GitRelayOptions) => {
  const maxConnections = options.maxConnections ?? 4;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
  const maxPushBytes = options.maxPushBytes ?? 512 * 1024 * 1024;
  if (!Number.isSafeInteger(maxPushBytes) || maxPushBytes < 1)
    throw new Error("Invalid Git push limit");
  const listener = Deno.listen({ transport: "unix", path });
  const active = new Map<Deno.Conn, () => void>();
  const tasks = new Set<Promise<void>>();
  const close = (c: Deno.Conn) => {
    try {
      c.close();
    } catch {
      /*closed*/
    }
  };
  const refuse = async (client: Deno.Conn, reason: string) => {
    try {
      await client.write(packet(`ERR ${reason}\n`));
    } catch {
      /*peer closed*/
    }
  };
  const serve = async (client: Deno.Conn) => {
    const abort = new AbortController();
    let child: Deno.ChildProcess | undefined;
    const stop = () => {
      abort.abort();
      try {
        child?.kill("SIGKILL");
      } catch {
        /*exited*/
      }
      close(client);
    };
    active.set(client, stop);
    let timer = setTimeout(stop, requestTimeoutMs);
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(stop, idleTimeoutMs);
    };
    const watched = () =>
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          touch();
          controller.enqueue(chunk);
        },
      });
    try {
      const service = await readRequest(client);
      if (!service) return await refuse(client, "unsupported Git request");
      let policy;
      try {
        policy = gitPolicySchema.parse(JSON.parse(await Deno.readTextFile(options.policyFile)));
      } catch {
        return await refuse(client, "session Git policy is unavailable");
      }
      touch();
      child = new Deno.Command(options.git ?? "git", {
        args: gitServiceArguments(service, policy, maxPushBytes),
        cwd: options.gitDir,
        // Built from scratch: no GIT_PROTOCOL, so both services speak protocol v0.
        // Protocol v2 upload-pack serves hidden objects named by hash.
        clearEnv: true,
        env: {
          PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
        },
        stdin: "piped",
        stdout: "piped",
        stderr: "null",
      }).spawn();
      const inbound = client.readable
        .pipeThrough(watched(), { signal: abort.signal })
        .pipeTo(child.stdin, { signal: abort.signal })
        .catch(() => {});
      await child.stdout
        .pipeThrough(watched())
        .pipeTo(client.writable, { preventClose: true, signal: abort.signal });
      await child.status;
      stop();
      await inbound;
    } catch {
      /*peer closed, deadline, or relay shutdown*/
    } finally {
      clearTimeout(timer);
      stop();
      await child?.status.catch(() => {});
      active.delete(client);
    }
  };
  const serving = (async () => {
    try {
      for await (const client of listener) {
        if (active.size >= maxConnections) {
          void refuse(client, "too many Git connections").finally(() => close(client));
          continue;
        }
        const task = serve(client);
        tasks.add(task);
        void task.finally(() => tasks.delete(task));
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.BadResource)) throw error;
    }
  })();
  let closing: Promise<void> | undefined;
  return {
    close: () =>
      (closing ??= (async () => {
        listener.close();
        for (const stop of active.values()) stop();
        await serving;
        await Promise.allSettled(tasks);
      })()),
  };
};
