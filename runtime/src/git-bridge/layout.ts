import { join, resolve, dirname } from "node:path";
import type { PreparedGitBridge } from "./service.ts";

/** Discover only a linked worktree; the host admin backlink is checked during preparation. */
export const discoverGitWorktree = async (workspace: string) => {
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.lstat(join(workspace, ".git"));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  if (!stat.isFile || stat.isSymlink || stat.size > 4096)
    throw new Error(
      "VM Git requires a linked worktree; refusing to mount repository metadata. Enable session worktrees.",
    );
  const pointer = (await Deno.readTextFile(join(workspace, ".git"))).trim();
  if (!pointer.startsWith("gitdir: ")) throw new Error("Invalid worktree .git pointer");
  const gitDir = await Deno.realPath(resolve(workspace, pointer.slice(8)));
  const commonDir = await Deno.realPath(
    resolve(gitDir, (await Deno.readTextFile(join(gitDir, "commondir"))).trim()),
  );
  if (
    dirname(dirname(gitDir)) !== commonDir ||
    !gitDir.startsWith(join(commonDir, "worktrees") + "/")
  )
    throw new Error("Unsupported Git worktree admin layout");
  return { gitDir, commonDir };
};

/** Parse only index framing to detect unsupported split/sparse layouts, never its paths. */
export const validateIndex = (bytes: Uint8Array) => {
  const fail = () => {
    throw new Error("Git bridge requires a normal SHA-1 index (no split/sparse index)");
  };
  if (bytes.length < 32 || new TextDecoder().decode(bytes.subarray(0, 4)) !== "DIRC") return fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4),
    count = view.getUint32(8);
  if (![2, 3, 4].includes(version)) return fail();
  let offset = 12;
  const end = bytes.length - 20;
  for (let i = 0; i < count; i++) {
    const start = offset;
    if (offset + 62 > end) return fail();
    if ((view.getUint32(offset + 24) & 0o170000) === 0o040000) return fail();
    const flags = view.getUint16(offset + 60);
    offset += 62;
    if (flags & 0x4000) {
      if (version === 2 || offset + 2 > end) return fail();
      offset += 2;
    }
    if (version === 4) {
      let n = 0;
      do {
        if (offset >= end || ++n > 8) return fail();
      } while (bytes[offset++]! & 0x80);
    }
    while (offset < end && bytes[offset] !== 0) offset++;
    if (offset >= end) return fail();
    offset++;
    if (version !== 4) offset = start + Math.ceil((offset - start) / 8) * 8;
  }
  while (offset < end) {
    if (offset + 8 > end) return fail();
    const signature = new TextDecoder().decode(bytes.subarray(offset, offset + 4));
    if (signature === "link" || signature === "sdir") return fail();
    offset += 8 + view.getUint32(offset + 4);
    if (offset > end) return fail();
  }
  if (offset !== end) return fail();
};

export const validateGitLayout = async (b: PreparedGitBridge) => {
  const identity = { name: "Loom", email: "loom@localhost" };
  for (const file of [join(b.commonDir, "config"), join(b.gitDir, "config.worktree")]) {
    try {
      if ((await Deno.stat(file)).size > 1024 * 1024)
        throw new Error("Git configuration exceeds bridge validation limit");
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) continue;
      throw e;
    }
    // Git parses its own config syntax, with includes disabled. No repo discovery, helpers or env.
    const child = new Deno.Command(b.git, {
      args: ["config", "--file", file, "--no-includes", "--null", "--list"],
      clearEnv: true,
      env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      cwd: b.state,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* exited */
      }
    }, 5000);
    let result: Deno.CommandOutput;
    try {
      result = await child.output();
    } finally {
      clearTimeout(timer);
    }
    if (!result.success || result.stdout.length > 1024 * 1024)
      throw new Error("Cannot validate repository configuration for Git bridge");
    for (const entry of new TextDecoder().decode(result.stdout).split("\0")) {
      const [key, value = ""] = entry.split("\n");
      if (!key) continue;
      if (
        b.writable &&
        !b.allowRepoPrograms &&
        (key === "include.path" ||
          key.startsWith("includeif.") ||
          /^filter\..*\.(clean|smudge|process)$/.test(key) ||
          /^merge\..*\.driver$/.test(key))
      )
        throw new Error(
          `Git bridge blocks repository setting ${key}; remove it or explicitly enable isolation.git.allow_repo_programs (executes programs on the host)`,
        );
      if (
        ["user.name", "user.email"].includes(key) &&
        value.trim() &&
        // Git identity must remain a single printable config value.
        // eslint-disable-next-line no-control-regex
        !/[\x00-\x1f\x7f]/.test(value)
      )
        identity[key === "user.name" ? "name" : "email"] = value;
      if (
        (key.startsWith("extensions.") &&
          !["extensions.worktreeconfig"].includes(key) &&
          !(key === "extensions.objectformat" && value === "sha1")) ||
        (key === "core.repositoryformatversion" && !["0", "1"].includes(value)) ||
        (["core.sparsecheckout", "core.splitindex"].includes(key) &&
          !["false", "no", "off", "0"].includes(value.toLowerCase()))
      )
        throw new Error(
          `Unsupported Git bridge repository setting: ${key}. Use a normal SHA-1 linked worktree with file refs and a full index.`,
        );
    }
  }
  try {
    const file = join(b.gitDir, "index");
    if ((await Deno.stat(file)).size > 64 * 1024 * 1024)
      throw new Error("Git index exceeds bridge validation limit");
    validateIndex(await Deno.readFile(file));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return identity;
};
