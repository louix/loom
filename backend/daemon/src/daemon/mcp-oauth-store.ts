import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import {
  McpOAuthError,
  mcpOAuthStateSchema,
  oauthHash,
  sameOAuthIdentity,
  type McpOAuthCredential,
  type McpOAuthIdentity,
  type McpOAuthState,
} from "./mcp-oauth-model.ts";

const MAX_BYTES = 256 * 1024;
export const mcpOAuthStateDirectory = (env = Deno.env.toObject()): string => {
  const xdg = env["XDG_STATE_HOME"];
  return join(
    xdg && isAbsolute(xdg) ? xdg : join(env["HOME"] || homedir(), ".local", "state"),
    "loom",
    "mcp-auth",
  );
};
const check = (stat: Deno.FileInfo, directory: boolean) => {
  if (
    stat.isSymlink ||
    (directory ? !stat.isDirectory : !stat.isFile) ||
    stat.uid !== Deno.uid() ||
    ((stat.mode ?? 0) & 0o777) !== (directory ? 0o700 : 0o600) ||
    (!directory && stat.nlink !== 1)
  )
    throw new McpOAuthError("storage_unsafe");
};
const directories = async (path: string): Promise<void> => {
  // Reject symlinks in the entire path, including a configured state namespace.
  let parent = parse(path).root;
  for (const segment of path.slice(parent.length).split("/").filter(Boolean)) {
    parent = join(parent, segment);
    try {
      await Deno.mkdir(parent, { mode: 0o700 });
    } catch (e) {
      if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
    }
    const stat = await Deno.lstat(parent);
    if (!stat.isDirectory || stat.isSymlink) throw new McpOAuthError("storage_unsafe");
  }
  check(await Deno.lstat(path), true);
};
const openFile = async (path: string, create = false): Promise<Deno.FsFile> => {
  if (create) {
    try {
      const created = await Deno.open(path, {
        createNew: true,
        read: true,
        write: true,
        mode: 0o600,
      });
      created.close();
    } catch (e) {
      if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
    }
  }
  const before = await Deno.lstat(path);
  check(before, false);
  const file = await Deno.open(path, { read: true, write: create });
  try {
    const after = await file.stat();
    check(after, false);
    if (before.ino !== after.ino || before.dev !== after.dev)
      throw new McpOAuthError("storage_unsafe");
    return file;
  } catch (e) {
    file.close();
    throw e;
  }
};
const readState = async (path: string, name: string): Promise<McpOAuthState> => {
  let file;
  try {
    file = await openFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return { version: 1, generation: 0 };
    throw e;
  }
  try {
    if ((await file.stat()).size > MAX_BYTES) throw new McpOAuthError("storage_corrupt");
    const bytes = new Uint8Array(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const n = await file.read(bytes.subarray(length));
      if (n === null) break;
      length += n;
    }
    if (length > MAX_BYTES) throw new McpOAuthError("storage_corrupt");
    const state = mcpOAuthStateSchema.safeParse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))),
    );
    if (!state.success || (state.data.credential && state.data.credential.identity.name !== name))
      throw new McpOAuthError("storage_corrupt");
    return state.data;
  } catch (e) {
    throw e instanceof McpOAuthError ? e : new McpOAuthError("storage_corrupt");
  } finally {
    file.close();
  }
};
const publish = async (path: string, state: McpOAuthState, signal?: AbortSignal) => {
  const serialized = new TextEncoder().encode(JSON.stringify(state));
  if (serialized.length > MAX_BYTES) throw new McpOAuthError("storage_corrupt");
  const temporary = join(dirname(path), ".pending-" + crypto.randomUUID());
  const file = await Deno.open(temporary, { createNew: true, write: true, mode: 0o600 });
  try {
    try {
      let offset = 0;
      while (offset < serialized.length) offset += await file.write(serialized.subarray(offset));
      await file.sync();
    } finally {
      file.close();
    }
    if (signal?.aborted) throw new McpOAuthError("cancelled");
    await Deno.rename(temporary, path);
    const directory = await Deno.open(dirname(path), { read: true });
    try {
      await directory.sync();
    } finally {
      directory.close();
    }
  } finally {
    await Deno.remove(temporary).catch((e) => {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    });
  }
};

export interface McpOAuthStore {
  read(signal?: AbortSignal): Promise<McpOAuthState>;
  commit(
    expectedGeneration: number,
    credential: McpOAuthCredential,
    signal?: AbortSignal,
  ): Promise<McpOAuthState>;
  clear(signal?: AbortSignal): Promise<McpOAuthState>;
}
export const matchingOAuthCredential = (
  state: McpOAuthState,
  identity: McpOAuthIdentity,
): McpOAuthCredential | undefined => {
  if (state.credential && !sameOAuthIdentity(state.credential.identity, identity))
    throw new McpOAuthError("config_changed");
  return state.credential;
};

/** Linux storage. macOS fails closed until the separate Keychain backend is installed. */
export const createMcpOAuthStore = (
  name: string,
  root = mcpOAuthStateDirectory(),
): McpOAuthStore => {
  const namespace = resolve(root);
  const directory = join(namespace, oauthHash(name));
  const path = join(directory, "credential.json");
  const locked = async <T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (Deno.build.os !== "linux") throw new McpOAuthError("storage_unavailable");
    let lock: Deno.FsFile | undefined;
    try {
      await directories(namespace);
      await directories(directory);
      lock = await openFile(join(directory, "lock"), true);
      const deadline = Date.now() + 30000;
      while (!(await lock.tryLock(true))) {
        if (signal?.aborted) throw new McpOAuthError("cancelled");
        if (Date.now() >= deadline) throw new McpOAuthError("lock_timeout");
        await sleep(25, undefined, signal ? { signal } : {});
      }
      if (signal?.aborted) throw new McpOAuthError("cancelled");
      return await run();
    } catch (e) {
      if (signal?.aborted) throw new McpOAuthError("cancelled");
      throw e instanceof McpOAuthError ? e : new McpOAuthError("storage_unavailable");
    } finally {
      lock?.close();
    }
  };
  const replace = (
    expected: number | undefined,
    credential?: McpOAuthCredential,
    signal?: AbortSignal,
  ) =>
    locked(async () => {
      const current = await readState(path, name);
      if (expected !== undefined && expected !== current.generation)
        throw new McpOAuthError("stale_login");
      const parsed = mcpOAuthStateSchema.safeParse({
        version: 1,
        generation: current.generation + 1,
        ...(credential ? { credential } : {}),
      });
      if (!parsed.success || (credential && credential.identity.name !== name))
        throw new McpOAuthError("storage_corrupt");
      if (signal?.aborted) throw new McpOAuthError("cancelled");
      await publish(path, parsed.data, signal);
      return parsed.data;
    }, signal);
  return {
    read: (signal) => locked(() => readState(path, name), signal),
    commit: (expected, credential, signal) => replace(expected, credential, signal),
    clear: (signal) => replace(undefined, undefined, signal),
  };
};
