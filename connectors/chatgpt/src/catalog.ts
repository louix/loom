/**
 * Metadata-only ChatGPT model catalog: subscription-authenticated REST lookup
 * of context-window sizes for the picker. Codex app-server's own `model/list`
 * genuinely has no context-window field (confirmed against the generated
 * `Model.ts` protocol binding) — this file exists purely to fill that one
 * gap, never to run a turn.
 *
 * Deliberately **read-only** with respect to authentication: it re-reads
 * `auth.json` fresh on every call and never refreshes or writes it. Codex's
 * own app-server process is the sole owner of token renewal. OAuth refresh
 * tokens here are single-use (rotated on every refresh) — if this file
 * refreshed independently, the new refresh token would live only in this
 * process's memory (never written back to auth.json, so a session-only
 * connector can't safely mutate the user's shared credential file), while
 * Codex's own process would still hold the now-superseded one. The next
 * time Codex tries to refresh with it, the provider rejects it as reused and
 * forces the user to sign in again — a real, observed Codex auth failure
 * mode (`refresh_token_reused`), not a theoretical one. A stale/expired
 * access token here simply fails the REST call with 401, which `index.ts`'s
 * `listModels()` already treats as "no catalog context data", not fatal.
 */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { CodexHome } from "./codex-home.ts";

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";

export interface ChatGPTCatalogModel {
  slug: string;
  context_window?: number;
  max_context_window?: number;
}

interface Credentials {
  accessToken: string;
  accountId: string;
}

interface CatalogResponse {
  models?: ChatGPTCatalogModel[];
}

const jwtPayload = (token: string): Record<string, unknown> => {
  try {
    const payload = token.split(".")[1];
    if (!payload) return {};
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const accountIdFromToken = (token: string): string => {
  const payload = jwtPayload(token);
  const nested = payload["https://api.openai.com/auth"];
  const account =
    payload["https://chatgpt.com/account_id"] ??
    (nested && typeof nested === "object"
      ? (nested as Record<string, unknown>)["chatgpt_account_id"]
      : undefined) ??
    payload["account_id"];
  return typeof account === "string" ? account : "";
};

/** Reads `auth.json` as Codex's own process currently has it — no caching,
 *  no refresh. Call again to see whatever Codex itself has since refreshed. */
const readCredentials = async (home: CodexHome): Promise<Credentials> => {
  const path = home.authJsonPath;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new Error(
      `Codex is not authenticated — no credentials at ${path}. Run \`codex login\` (or check config_dir / CODEX_HOME if you use a custom Codex home), then retry.`,
      { cause: err },
    );
  }
  const tokens =
    parsed && typeof parsed === "object" && (parsed as Record<string, unknown>)["tokens"]
      ? ((parsed as Record<string, unknown>)["tokens"] as Record<string, unknown>)
      : undefined;
  const accessToken = typeof tokens?.["access_token"] === "string" ? tokens.access_token : "";
  const idToken = typeof tokens?.["id_token"] === "string" ? tokens.id_token : "";
  const accountId =
    (typeof tokens?.["account_id"] === "string" ? tokens.account_id : "") ||
    accountIdFromToken(idToken || accessToken);
  if (!accessToken || !accountId)
    throw new Error(
      `Codex is not authenticated — ${path} does not contain usable ChatGPT OAuth credentials. Run \`codex login\`, then retry.`,
    );
  return { accessToken, accountId };
};

/** One shared authenticated catalog fetch — just the fields the model picker needs. */
export class ChatGPTCatalog {
  #models: ChatGPTCatalogModel[] | undefined;
  #loading: Promise<ChatGPTCatalogModel[]> | undefined;
  readonly #home: CodexHome;
  readonly #baseUrl: string;

  constructor(codexHome: CodexHome, baseUrl = DEFAULT_BASE_URL) {
    this.#home = codexHome;
    this.#baseUrl = baseUrl;
  }

  async list(): Promise<ChatGPTCatalogModel[]> {
    if (this.#models) return this.#models;
    if (!this.#loading) this.#loading = this.#fetch();
    try {
      this.#models = await this.#loading;
      return this.#models;
    } finally {
      this.#loading = undefined;
    }
  }

  async #headers(): Promise<Record<string, string>> {
    const credentials = await readCredentials(this.#home);
    return {
      Authorization: `Bearer ${credentials.accessToken}`,
      "ChatGPT-Account-ID": credentials.accountId,
      "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs",
      session_id: randomUUID(),
    };
  }

  async #fetch(): Promise<ChatGPTCatalogModel[]> {
    const res = await fetch(
      `${this.#baseUrl.replace(/\/$/, "")}/codex/models?client_version=0.0.0`,
      {
        headers: { Accept: "application/json", ...(await this.#headers()) },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!res.ok) throw new Error(`Codex model catalog fetch failed: ${res.status} ${res.statusText}`);
    const body = (await res.json()) as CatalogResponse;
    return (body.models ?? []).filter(
      (model) => typeof model.slug === "string" && model.slug !== "",
    );
  }
}
