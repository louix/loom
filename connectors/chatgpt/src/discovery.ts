/**
 * Short-lived `codex app-server` discovery: list models and their reasoning
 * efforts through the same subprocess mechanism (and the same resolved
 * `CODEX_HOME`) session startup uses, rather than a separate REST credential
 * path. See `docs/connectors.md#codex-subscription`.
 *
 * Metadata only: no thread is started, so nothing reaches the user's history,
 * and the user's own MCP servers are switched off for the probe. The real
 * `CODEX_HOME` is kept rather than a credential copy because app-server may
 * rotate the refresh token while reading the catalogue, and a rotation written
 * to a throwaway copy would sign the user out.
 */
import type { DiscoveredModel } from "@loom/core/types";
import { CodexRpcClient } from "./rpc.ts";
import { verifyChatGptAccount } from "./account.ts";
import type { CodexHome } from "./codex-home.ts";
import { spawnCodex, type CodexLauncher } from "./launch.ts";

interface ModelListRow {
  model?: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>;
}
interface ModelListResult {
  data?: ModelListRow[];
  nextCursor?: string | null;
}

/** `model/list` pages read before giving up — 4 × 100 rows outruns any real
 *  catalogue, and a server that keeps paging is refused rather than followed. */
export const CODEX_MODEL_PAGES = 4;

/** A `model/list` row, with the account's own hidden/visible flag preserved
 *  so callers can decide the automatic picker list themselves. */
export interface DiscoveredCodexModel extends DiscoveredModel {
  hidden: boolean;
}

/** Spawns a throwaway app-server, lists every model (paginating `nextCursor`,
 *  bounded by {@link CODEX_MODEL_PAGES}), and always closes the process — on
 *  success or failure — so a discovery error never leaves a process or a
 *  pending request behind. */
export const discoverCodexModels = async (opts: {
  cliPath: string;
  codexHome: CodexHome;
  launch?: CodexLauncher;
}): Promise<DiscoveredCodexModel[]> => {
  const launch = opts.launch ?? spawnCodex;
  const proc = launch({
    cliPath: opts.cliPath,
    args: ["app-server", "-c", 'cli_auth_credentials_store="file"', "-c", "mcp_servers={}"],
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
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= CODEX_MODEL_PAGES)
        throw new Error("The Codex model catalogue exceeds discovery bounds.");
      const result = (await rpc.request("model/list", {
        limit: 100,
        includeHidden: true,
        ...(cursor ? { cursor } : {}),
      })) as ModelListResult;
      for (const row of result.data ?? []) {
        if (!row.model) continue;
        const efforts = (row.supportedReasoningEfforts ?? [])
          .map((e) => e.reasoningEffort)
          .filter((e): e is string => typeof e === "string" && e !== "");
        models.push({
          id: row.model,
          hidden: row.hidden === true,
          ...(row.displayName ? { label: row.displayName } : {}),
          ...(row.description ? { description: row.description } : {}),
          ...(row.isDefault === true ? { isDefault: true } : {}),
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
      if (!result.nextCursor) break;
      if (seen.has(result.nextCursor)) throw new Error("Codex repeated a model catalogue cursor.");
      seen.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    return models;
  } finally {
    rpc.close();
  }
};
