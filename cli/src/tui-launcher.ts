import { join } from "node:path";
import { findRepoRoot, loomPaths } from "@loom/core/paths";
import { runWithIpc } from "@loom/core/network-permissions";

export const TUI_HANDOFF = "LOOM_TUI_HANDOFF";

/** Keep one launcher and one client, even after many repository switches. */
export const launchRepositoryTui = async (entry: string, initial: string): Promise<number> => {
  const directory = await Deno.makeTempDir({ prefix: "loom-tui-" });
  const handoff = join(directory, "repository");
  try {
    let repo = initial;
    while (true) {
      await Deno.writeTextFile(handoff, "");
      const code = await runWithIpc(entry, loomPaths(repo).sock, ["--repo", repo, "tui"], {
        [TUI_HANDOFF]: handoff,
      });
      if (code !== 0) return code;
      const next = await Deno.readTextFile(handoff);
      if (!next) return code;
      repo = findRepoRoot(next);
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
};
