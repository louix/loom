import { CredentialOwner, CredentialAuthError as ClaudeAuthError } from "./credential-owner.ts";
export { CredentialAuthError as ClaudeAuthError } from "./credential-owner.ts";
/** Host-only Claude credential owner. Refresh tokens never enter VM snapshots. */
import { readClaudeCredentials } from "./claude-credentials.ts";
import { homedir } from "node:os";

import type { ClaudeAccess } from "../../../../runtime/src/session-vm/auth.ts";
export type { ClaudeAccess } from "../../../../runtime/src/session-vm/auth.ts";
export interface ClaudeAuthSnapshot {
  claudeAiOauth: ClaudeAccess;
}
const read = async (profile: string): Promise<ClaudeAccess & { refreshToken?: string }> => {
  try {
    const value = (
      (await readClaudeCredentials(profile)) as {
        claudeAiOauth?: ClaudeAccess & { refreshToken?: string };
      }
    ).claudeAiOauth;
    if (
      !value ||
      typeof value.accessToken !== "string" ||
      !value.accessToken ||
      !Number.isFinite(value.expiresAt) ||
      !Array.isArray(value.scopes) ||
      !value.scopes.every((scope: unknown) => typeof scope === "string")
    )
      throw new Error();
    return {
      accessToken: value.accessToken,
      expiresAt: value.expiresAt,
      scopes: [...value.scopes],
      ...(typeof value.refreshToken === "string" && value.refreshToken
        ? { refreshToken: value.refreshToken }
        : {}),
    };
  } catch {
    throw new ClaudeAuthError("needs_login");
  }
};
const snapshot = (value: ClaudeAccess): ClaudeAuthSnapshot => ({
  claudeAiOauth: {
    accessToken: value.accessToken,
    expiresAt: value.expiresAt,
    scopes: [...value.scopes],
  },
});
/** The CLI owns its credential format and persists rotated refresh tokens itself. */
const runRefresh = async (
  profile: string,
  cli: string,
  credential: ClaudeAccess & { refreshToken?: string },
  signal: AbortSignal,
) => {
  if (!credential.refreshToken) throw new ClaudeAuthError("needs_login");
  signal.throwIfAborted();
  const child = new Deno.Command(cli, {
    args: ["auth", "login", "--claudeai"],
    cwd: profile,
    clearEnv: true,
    env: {
      HOME: homedir(),
      PATH: Deno.env.get("PATH") ?? "",
      CLAUDE_CONFIG_DIR: profile,
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: credential.refreshToken,
      CLAUDE_CODE_OAUTH_SCOPES: credential.scopes.join(" "),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const kill = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* exited */
    }
  };
  signal.addEventListener("abort", kill, { once: true });
  let diagnostics = "";
  const drain = (stream: ReadableStream<Uint8Array>) =>
    stream
      .pipeTo(
        new WritableStream({
          write(bytes) {
            diagnostics = (diagnostics + new TextDecoder().decode(bytes)).slice(-8192);
          },
        }),
      )
      .catch(() => {});
  const drains = Promise.all([drain(child.stdout), drain(child.stderr)]);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, 60_000);
  try {
    const result = await child.status;
    await drains;
    if (timedOut) throw new ClaudeAuthError("refresh_timeout");
    if (signal.aborted) throw new ClaudeAuthError("closed");
    if (!result.success) {
      const status = /status code (\d{3})/i.exec(diagnostics)?.[1];
      const categories = [
        "certificate",
        "TLS",
        "ENOTFOUND",
        "ECONNREFUSED",
        "ECONNRESET",
        "EACCES",
        "ENOENT",
        "invalid_scope",
        "invalid_grant",
        "unauthorized_client",
      ].filter((code) => diagnostics.includes(code));
      throw new ClaudeAuthError(
        status === "400" ||
          status === "401" ||
          /invalid_grant|revoked|invalid refresh token/i.test(diagnostics)
          ? "needs_login"
          : "refresh_failed",
        [`CLI exit ${result.code}`, ...(status ? [`HTTP ${status}`] : []), ...categories].join(
          ", ",
        ),
      );
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", kill);
  }
};
export interface ClaudeAuthOptions {
  profile: string;
  cli: string;
  report?: (code: ClaudeAuthError["code"] | "publish_failed") => void;
  /** Test seam; production always uses the pinned Claude CLI. */
  refresh?: typeof runRefresh;
  pollMs?: number;
  refreshAheadMs?: number;
}
export class ClaudeAuthOwner extends CredentialOwner<
  ClaudeAccess & { refreshToken?: string },
  ClaudeAuthSnapshot
> {
  constructor(options: ClaudeAuthOptions) {
    super({
      ...options,
      read,
      snapshot,
      expiresAt: (s) => s.claudeAiOauth.expiresAt,
      refresh: options.refresh ?? runRefresh,
    });
  }
}
