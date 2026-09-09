/** The only credential shape permitted across the session VM boundary. */
import { join } from "node:path";
export interface ClaudeAccess {
  accessToken: string;
  expiresAt: number;
  scopes: string[];
}
export interface CodexAccess {
  accessToken: string;
  idToken: string;
  accountId: string;
  expiresAt: number;
}
export interface SessionAuth {
  codexOauth?: CodexAccess;
  ANTHROPIC_API_KEY?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  claudeAiOauth?: ClaudeAccess;
}
export const sessionAuth = (value: SessionAuth): SessionAuth => {
  const result: SessionAuth = {};
  for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const) {
    const token = value[key];
    if (token !== undefined) {
      if (typeof token !== "string" || !token || token.length > 16_384)
        throw new Error("Invalid session credential");
      result[key] = token;
    }
  }
  if (value.claudeAiOauth) {
    const { accessToken, expiresAt, scopes } = value.claudeAiOauth;
    if (
      typeof accessToken !== "string" ||
      !accessToken ||
      accessToken.length > 16_384 ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= 0 ||
      !Array.isArray(scopes) ||
      scopes.length > 64 ||
      !scopes.every((s) => typeof s === "string" && s.length <= 512)
    )
      throw new Error("Invalid session OAuth credential");
    result.claudeAiOauth = { accessToken, expiresAt, scopes: [...scopes] };
  }
  if (value.codexOauth) {
    const { accessToken, idToken, accountId, expiresAt } = value.codexOauth;
    if (
      ![accessToken, idToken, accountId].every(
        (v) => typeof v === "string" && v.length > 0 && v.length <= 16384,
      ) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= 0
    )
      throw new Error("Invalid Codex session credential");
    result.codexOauth = { accessToken, idToken, accountId, expiresAt };
  }
  if (Object.keys(result).length > 1) throw new Error("Choose one session authentication source");
  return result;
};
/** Never recreates a deleted session directory; cleanup and publication may race. */
export const writeSessionAuth = async (dir: string, value: SessionAuth) => {
  const safe = sessionAuth(value);
  const data = JSON.stringify(safe);
  if (safe.codexOauth) {
    const { accessToken, idToken, accountId } = safe.codexOauth;
    const next = join(dir, `codex-${crypto.randomUUID()}.tmp`);
    try {
      await Deno.writeTextFile(
        next,
        JSON.stringify({
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          tokens: {
            access_token: accessToken,
            id_token: idToken,
            account_id: accountId,
            refresh_token: "",
          },
          last_refresh: new Date().toISOString(),
        }),
        { mode: 0o600, createNew: true },
      );
      await Deno.rename(next, join(dir, "codex.json"));
    } finally {
      await Deno.remove(next).catch((e) => {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      });
    }
  }
  const temporary = join(dir, `auth-${crypto.randomUUID()}.tmp`);
  let failure: unknown;
  try {
    await Deno.writeTextFile(temporary, data, { mode: 0o600, createNew: true });
    await Deno.rename(temporary, join(dir, "auth.json"));
  } catch (error) {
    failure = error;
  }
  try {
    await Deno.remove(temporary);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) failure ??= error;
  }
  if (failure) throw failure;
};
