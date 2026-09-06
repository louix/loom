/**
 * Metadata-only ChatGPT model catalog: subscription-authenticated REST lookup
 * of context-window sizes for the picker. Codex app-server's own `model/list`
 * genuinely has no context-window field (confirmed against the generated
 * `Model.ts` protocol binding) — this file exists purely to fill that one
 * gap, never to run a turn. It shares Codex's file-based `auth.json` (same
 * `CodexHome`, no API-key fallback) with the execution path in
 * `app-server.ts`, but is otherwise unrelated to it: a catalog-lookup failure
 * (timeout, expired token, malformed response) must never block model
 * discovery or session creation — see `index.ts`'s `listModels()`, which
 * treats this as best-effort.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { CodexHome } from "./codex-home.ts";

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const REFRESH_URL = "https://auth.openai.com/oauth/token";
// Codex's public OAuth client id. Refreshing stays in memory: Loom never
// rewrites the user's Codex credential file.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export interface ChatGPTCatalogModel {
  slug: string;
  context_window?: number;
  max_context_window?: number;
}

interface Credentials {
  accessToken: string;
  refreshToken?: string;
  accountId: string;
  expiresAt?: number;
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

const expiryFromToken = (token: string): number | undefined => {
  const exp = jwtPayload(token)["exp"];
  return typeof exp === "number" ? exp * 1000 : undefined;
};

class CodexAuth {
  #credentials: Credentials | undefined;
  #refreshing: Promise<Credentials> | undefined;
  readonly home: CodexHome;

  constructor(home: CodexHome) {
    this.home = home;
  }

  async credentials(): Promise<Credentials> {
    if (!this.#credentials) this.#credentials = await this.#load();
    if ((this.#credentials.expiresAt ?? Infinity) - Date.now() < 60_000) {
      if (!this.#refreshing) this.#refreshing = this.#refresh(this.#credentials);
      try {
        this.#credentials = await this.#refreshing;
      } finally {
        this.#refreshing = undefined;
      }
    }
    return this.#credentials;
  }

  async #load(): Promise<Credentials> {
    const path = this.home.authJsonPath;
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
    const expiry = expiryFromToken(accessToken) ?? expiryFromToken(idToken);
    return {
      accessToken,
      accountId,
      ...(typeof tokens?.["refresh_token"] === "string"
        ? { refreshToken: tokens.refresh_token }
        : {}),
      ...(expiry ? { expiresAt: expiry } : {}),
    };
  }

  async #refresh(credentials: Credentials): Promise<Credentials> {
    if (!credentials.refreshToken)
      throw new Error("Codex OAuth token expired and has no refresh token — run `codex login` to re-authenticate");
    const res = await fetch(REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credentials.refreshToken,
        client_id: CLIENT_ID,
      }),
    });
    if (!res.ok) throw new Error(`Codex OAuth refresh failed: ${res.status} ${res.statusText}`);
    const body = (await res.json()) as Record<string, unknown>;
    if (typeof body["access_token"] !== "string")
      throw new Error("Codex OAuth refresh returned no access token");
    return {
      accessToken: body.access_token,
      accountId: credentials.accountId,
      refreshToken:
        typeof body["refresh_token"] === "string" ? body.refresh_token : credentials.refreshToken,
      ...(typeof body["expires_in"] === "number"
        ? { expiresAt: Date.now() + body.expires_in * 1000 }
        : {}),
    };
  }
}

/** One shared authenticated catalog fetch — just the fields the model picker needs. */
export class ChatGPTCatalog {
  #models: ChatGPTCatalogModel[] | undefined;
  #loading: Promise<ChatGPTCatalogModel[]> | undefined;
  readonly #auth: CodexAuth;
  readonly #baseUrl: string;

  constructor(codexHome: CodexHome, baseUrl = DEFAULT_BASE_URL) {
    this.#auth = new CodexAuth(codexHome);
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
    const credentials = await this.#auth.credentials();
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
