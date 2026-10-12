/**
 * Confirms a spawned `codex app-server` actually authenticated with a ChatGPT
 * subscription account — not an API key, not some other account type —
 * regardless of what `cli_auth_credentials_store` and the process's Codex home
 * happen to resolve to at runtime. Called once per process, right after
 * `initialize`, before any thread/model call that would otherwise run against
 * the wrong credentials.
 */
import type { CodexRpcClient } from "./rpc.ts";

/** Codex's `PlanType` values (app-server 0.160), in words. `unknown` says nothing. */
const PLAN_LABELS: Record<string, string | null> = {
  free: "ChatGPT Free",
  go: "ChatGPT Go",
  plus: "ChatGPT Plus",
  pro: "ChatGPT Pro",
  prolite: "ChatGPT Pro Lite",
  promax: "ChatGPT Pro Max",
  team: "ChatGPT Team",
  self_serve_business_prolite: "ChatGPT Business Pro Lite",
  self_serve_business_usage_based: "ChatGPT Business (usage-based)",
  business: "ChatGPT Business",
  ent26: "ChatGPT Enterprise (ent26)",
  enterprise_cbp_automation: "ChatGPT Enterprise (automation)",
  enterprise_cbp_usage_based: "ChatGPT Enterprise (usage-based)",
  enterprise: "ChatGPT Enterprise",
  edu: "ChatGPT Edu",
  edu_plus: "ChatGPT Edu Plus",
  edu_pro: "ChatGPT Edu Pro",
  unknown: null,
};

/** A Codex account's plan in words. A plan newer than this table still reads
 *  (`some_new_plan` → `ChatGPT Some New Plan`); `unknown` or garbage gives none. */
export const codexPlanLabel = (planType: unknown): string | undefined => {
  if (typeof planType !== "string" || !planType.trim()) return undefined;
  const known = PLAN_LABELS[planType];
  if (known !== undefined) return known ?? undefined;
  const words = planType
    .trim()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase());
  return words.length ? `ChatGPT ${words.join(" ")}` : undefined;
};

interface AccountReadResult {
  account?: { type?: string; email?: string } | null;
  requiresOpenaiAuth?: boolean;
}

/**
 * Throws with an actionable message if the authenticated account isn't a
 * ChatGPT subscription (`account.type !== "chatgpt"` — null, `apiKey`, or any
 * other type). `refreshToken: false` reads the account Codex already has
 * without forcing a token refresh; Codex stays responsible for normal
 * renewal. Deliberately never sets `forced_login_method` — that setting logs
 * the user out and exits on a mismatch, which is exactly the destructive
 * shortcut this check exists to avoid.
 */
export const verifyChatGptAccount = async (rpc: CodexRpcClient): Promise<void> => {
  const result = (await rpc.requestStartup("account/read", {
    refreshToken: false,
  })) as AccountReadResult;
  const type = result.account?.type;
  if (type !== "chatgpt") {
    throw new Error(
      `Codex is not authenticated with a ChatGPT subscription account (found ${JSON.stringify(type ?? null)}). ` +
        "Run `codex login` with a ChatGPT account, then retry.",
    );
  }
};
