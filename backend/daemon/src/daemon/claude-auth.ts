import { CredentialOwner, CredentialAuthError as ClaudeAuthError } from "./credential-owner.ts";
export { CredentialAuthError as ClaudeAuthError } from "./credential-owner.ts";
import { readClaudeCredentials } from "./claude-credentials.ts";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

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

/** Exchange in a separate, narrowly permissioned process; never run auth login. */
const runRefresh = async (
  profile: string,
  _cli: string,
  credential: ClaudeAccess & { refreshToken?: string },
  signal: AbortSignal,
) => {
  if (!credential.refreshToken) throw new ClaudeAuthError("needs_login");
  signal.throwIfAborted();
  profile = resolve(profile);
  const canonical = await Deno.realPath(profile);
  const paths = [...new Set([profile, canonical, canonical + ".lock"])];
  if (paths.some((path) => path.includes(",")))
    throw new ClaudeAuthError("refresh_failed", "Unsupported profile path");
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--quiet",
      "--no-config",
      "--no-lock",
      "--no-prompt",
      "--cached-only",
      "--allow-read=" + paths.join(","),
      "--allow-write=" + paths.join(","),
      "--allow-net=platform.claude.com:443",
      "--allow-env=HOME",
      "--allow-sys",
      ...(Deno.build.os === "darwin" ? ["--allow-run=/usr/bin/security"] : []),
      fileURLToPath(new URL("./claude-refresh-worker.ts", import.meta.url)),
    ],
    cwd: profile,
    clearEnv: true,
    env: { HOME: homedir(), DENO_TLS_CA_STORE: "system,mozilla", DENO_NO_UPDATE_CHECK: "1" },
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const kill = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* exited */
    }
  };
  signal.addEventListener("abort", kill, { once: true });
  if (signal.aborted) kill();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, 60_000);
  const output = child.output();
  try {
    const writer = child.stdin.getWriter();
    try {
      await writer.write(
        new TextEncoder().encode(JSON.stringify({ profile, accessToken: credential.accessToken })),
      );
      await writer.close();
    } finally {
      writer.releaseLock();
    }
    const result = await output;
    if (signal.aborted) throw new ClaudeAuthError("closed");
    if (timedOut) throw new ClaudeAuthError("refresh_timeout");
    let reply;
    try {
      reply = JSON.parse(new TextDecoder().decode(result.stdout));
    } catch {
      throw new ClaudeAuthError("refresh_failed", "Refresh worker exited without a result");
    }
    if (!result.success || reply.ok !== true) {
      const code = ["needs_login", "refresh_failed", "refresh_timeout"].includes(reply.code)
        ? reply.code
        : "refresh_failed";
      throw new ClaudeAuthError(code, typeof reply.detail === "string" ? reply.detail : "");
    }
  } catch (error) {
    if (signal.aborted) throw new ClaudeAuthError("closed");
    if (timedOut) throw new ClaudeAuthError("refresh_timeout");
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", kill);
    kill();
    await output.catch(() => {});
  }
};
export interface ClaudeAuthOptions {
  profile: string;
  /** Retained for injected refresh implementations; production does not invoke the CLI. */
  cli?: string;
  report?: (code: ClaudeAuthError["code"] | "publish_failed", detail?: string) => void;
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
      cli: options.cli ?? "",
      read,
      snapshot,
      expiresAt: (s) => s.claudeAiOauth.expiresAt,
      refresh: options.refresh ?? runRefresh,
    });
  }
}
