/** Only the bound branch and bridge-owned rebases may be changed by guest requests. */
import { join } from "node:path";
import type { PreparedGitBridge } from "./service.ts";

const exists = async (path: string) => {
  try {
    await Deno.lstat(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
};
const headRef = async (b: PreparedGitBridge) =>
  (await Deno.readTextFile(join(b.gitDir, "HEAD"))).trim();
const markerPath = (b: PreparedGitBridge) => join(b.control, "rebase.json");
const marker = async (b: PreparedGitBridge): Promise<{ branch: string } | undefined> => {
  if (!(await exists(markerPath(b)))) return undefined;
  const value = JSON.parse(await Deno.readTextFile(markerPath(b)));
  if (
    !value ||
    typeof value.branch !== "string" ||
    !/^refs\/heads\/[A-Za-z0-9_./-]+$/.test(value.branch)
  )
    throw new Error("Invalid bridge rebase ownership record");
  return value;
};
export const boundBranch = async (b: PreparedGitBridge) => {
  const record = await marker(b);
  const head = await headRef(b);
  if (head.startsWith("ref: refs/heads/")) return head.slice(5);
  if (record && (await exists(join(b.gitDir, "rebase-merge")))) return record.branch;
  return undefined; // Detached read-only inspection is still permitted.
};
export const checkWriteState = async (
  b: PreparedGitBridge,
  branch: string | undefined,
  args: string[],
) => {
  if (!b.writable) throw new Error("This Git bridge is read-only");
  if (!branch) throw new Error("Git writes require an attached session branch");
  const dir = join(b.gitDir, "rebase-merge");
  const rebasing = await exists(dir);
  const record = await marker(b);
  if (
    (await exists(join(b.gitDir, "rebase-apply"))) ||
    (await exists(join(b.gitDir, "MERGE_HEAD"))) ||
    (await exists(join(b.gitDir, "sequencer")))
  )
    throw new Error("Finish the host-managed Git operation before using bridge writes");
  if (rebasing) {
    if (
      !record ||
      record.branch !== branch ||
      (await Deno.readTextFile(join(dir, "head-name"))).trim() !== branch
    )
      throw new Error("This rebase was not started by the session bridge; finish it on the host");
    for (const file of args[0] === "rebase" && args[1] === "--abort"
      ? []
      : ["git-rebase-todo", "done"]) {
      if (!(await exists(join(dir, file)))) continue;
      const text = await Deno.readTextFile(join(dir, file));
      if (
        text.length > 1024 * 1024 ||
        text.split("\n").some((line) => {
          const s = line.trim();
          return s && !s.startsWith("#") && s !== "noop" && !/^pick [0-9a-f]{7,40}(?:\s|$)/.test(s);
        })
      )
        throw new Error("Rebase instructions were edited; finish this rebase on the host");
    }
    if (
      !["add", "restore"].includes(args[0]!) &&
      !(args[0] === "rebase" && ["--continue", "--abort", "--skip"].includes(args[1]!))
    )
      throw new Error("Resolve and stage conflicts, then rebase --continue, --skip or --abort");
  } else {
    if ((await headRef(b)) !== `ref: ${branch}`)
      throw new Error("The host changed the session branch; resume the session before writing");
    if (args[0] === "rebase" && ["--continue", "--abort", "--skip"].includes(args[1]!))
      throw new Error("No bridge rebase is in progress");
    if (record) await Deno.remove(markerPath(b));
    if (args[0] === "rebase")
      await Deno.writeTextFile(markerPath(b), JSON.stringify({ branch }), {
        createNew: true,
        mode: 0o600,
      });
  }
};
export const finishWriteState = async (b: PreparedGitBridge) => {
  if (!(await exists(join(b.gitDir, "rebase-merge"))) && (await exists(markerPath(b))))
    await Deno.remove(markerPath(b));
};
