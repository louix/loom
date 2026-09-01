/**
 * Read the OAuth identity behind a Claude profile's config directory, so the
 * TUI can show `<login method> (<org>)` and a user can tell a personal profile
 * from a work one. Pure `fs` + JSON — no SDK, no network. Loom still brokers no
 * auth; this only *reads* what the `claude` CLI already wrote:
 *
 *   <dir>/.credentials.json  → claudeAiOauth.subscriptionType   (the plan)
 *   <dir>/.claude.json       → oauthAccount.{organizationName,emailAddress}
 *
 * For the default `~/.claude` dir the CLI keeps `.claude.json` beside the dir
 * (`~/.claude.json`), not inside it — both locations are tried.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandTilde } from "./config.ts";

export interface ClaudeAccount {
  /** e.g. "Claude Max account", "API key"; "" when nothing identifies it. */
  loginMethod: string;
  /** Organisation name from the OAuth account; "" when absent. */
  org: string;
  /** Account email; "" when absent. Read but not yet surfaced. */
  email: string;
}

/** `subscriptionType` from `.credentials.json` → a human login-method label. */
const LOGIN_METHOD: Record<string, string> = {
  max: "Claude Max account",
  pro: "Claude Pro account",
  team: "Claude Team account",
  enterprise: "Claude Enterprise account",
};

const mtimeMs = (path: string): number => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Config-json path: inside the dir, or beside it for the default `~/.claude`. */
const configJsonCandidates = (dir: string): string[] => {
  const inside = join(dir, ".claude.json");
  const beside = join(homedir(), ".claude.json");
  return dir === join(homedir(), ".claude") ? [inside, beside] : [inside];
};

interface CacheEntry {
  /** Combined mtime signature of the files that fed `value`. */
  sig: string;
  value: ClaudeAccount | null;
}
const CACHE = new Map<string, CacheEntry>();

/**
 * The account behind `dir`, or `null` when neither a login method nor an org
 * could be read. Cached per dir, invalidated when either backing file changes.
 * `.claude.json` can be multi-MB, so this parses it only on an mtime change.
 */
export const readClaudeAccount = (dir: string): ClaudeAccount | null => {
  let root = expandTilde(dir);
  // The `claude` CLI/SDK honours $CLAUDE_CONFIG_DIR for the default profile;
  // match it so the provider-list account line isn't read from `~/.claude`
  // while sessions actually authenticate against the env-pointed dir.
  const envDir = process.env["CLAUDE_CONFIG_DIR"];
  if (envDir && root === join(homedir(), ".claude")) root = expandTilde(envDir);
  const credPath = join(root, ".credentials.json");
  const cfgPaths = configJsonCandidates(root);

  const sig = [credPath, ...cfgPaths].map(mtimeMs).join(":");
  const hit = CACHE.get(root);
  if (hit && hit.sig === sig) return hit.value;

  const oauth = asRecord(readJson(credPath)?.["claudeAiOauth"]);
  const subscriptionType = str(oauth["subscriptionType"]);
  let loginMethod = "";
  if (subscriptionType) loginMethod = LOGIN_METHOD[subscriptionType] ?? "Claude account";
  else if (process.env["ANTHROPIC_API_KEY"]) loginMethod = "API key";

  let account: Record<string, unknown> = {};
  for (const p of cfgPaths) {
    const found = asRecord(readJson(p)?.["oauthAccount"]);
    if (Object.keys(found).length > 0) {
      account = found;
      break;
    }
  }
  const org = str(account["organizationName"]);
  const email = str(account["emailAddress"]);

  const value: ClaudeAccount | null = loginMethod || org ? { loginMethod, org, email } : null;
  CACHE.set(root, { sig, value });
  return value;
};
