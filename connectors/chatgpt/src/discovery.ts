/**
 * Short-lived `codex app-server` discovery: list models and their reasoning
 * efforts through the same subprocess mechanism (and the same resolved
 * `CODEX_HOME`) session startup uses, rather than a separate REST credential
 * path. See `docs/chatgpt-provider-plan.md` Phase 2.
 */
import type { DiscoveredModel } from "@loom/core/types";
import { CodexRpcClient } from "./rpc.ts";
import { verifyChatGptAccount } from "./account.ts";
import type { CodexHome } from "./codex-home.ts";
import { spawnCodex, type CodexLauncher } from "./launch.ts";

interface ModelListRow {
  model?: string;
  displayName?: string;
  hidden?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>;
}
interface ModelListResult {
  data?: ModelListRow[];
  nextCursor?: string | null;
}

/** A `model/list` row, with the account's own hidden/visible flag preserved
 *  so callers can decide the automatic picker list themselves. */
export interface DiscoveredCodexModel extends DiscoveredModel {
  hidden: boolean;
}

/** Spawns a throwaway app-server, lists every model (paginating `nextCursor`),
 *  and always closes the process — on success or failure — so a discovery
 *  error never leaves a process or a pending request behind. */
export const discoverCodexModels = async (opts: {
  cliPath: string;
  codexHome: CodexHome;
  launch?: CodexLauncher;
}): Promise<DiscoveredCodexModel[]> => {
  const launch = opts.launch ?? spawnCodex;
  const proc = launch({
    cliPath: opts.cliPath,
    args: ["app-server", "-c", 'cli_auth_credentials_store="file"'],
    cwd: Deno.cwd(),
    env: { ...Deno.env.toObject(), CODEX_HOME: opts.codexHome.dir },
    codexHome: opts.codexHome,
  });
  const rpc = new CodexRpcClient(proc);
  try {
    await rpc.requestStartup("initialize", {
      clientInfo: { name: "loom", title: "Loom", version: "0.0.1" },
      capabilities: { experimentalApi: true },
    });
    rpc.notify("initialized", {});
    await verifyChatGptAccount(rpc);
    const models: DiscoveredCodexModel[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = (await rpc.request("model/list", {
        limit: 100,
        includeHidden: true,
        ...(cursor ? { cursor } : {}),
      })) as ModelListResult;
      for (const row of page.data ?? []) {
        if (!row.model) continue;
        const efforts = (row.supportedReasoningEfforts ?? [])
          .map((e) => e.reasoningEffort)
          .filter((e): e is string => typeof e === "string" && e !== "");
        models.push({
          id: row.model,
          hidden: row.hidden === true,
          ...(row.displayName ? { label: row.displayName } : {}),
          ...(efforts.length > 0
            ? {
                supportsEffort: true,
                effortLevels: efforts,
                ...(row.defaultReasoningEffort
                  ? { defaultEffort: row.defaultReasoningEffort }
                  : {}),
              }
            : {}),
        });
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return models;
  } finally {
    rpc.close();
  }
};
