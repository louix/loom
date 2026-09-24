import { fileURLToPath } from "node:url";
import { McpOAuthError } from "./mcp-oauth-model.ts";
import { readOAuthJson, writeOAuthJson, oauthRecord } from "./mcp-oauth-helper-io.ts";

/** Keychain calls must not block the daemon or put secret payloads in argv. */
export const oauthKeychain = async (
  service: string,
  value?: string,
): Promise<string | undefined> => {
  if (Deno.build.os !== "darwin") throw new McpOAuthError("storage_unavailable");
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--cached-only",
      "--no-prompt",
      "--deny-net",
      "--deny-read",
      "--deny-write",
      "--deny-env",
      "--deny-run",
      "--deny-sys",
      "--allow-ffi=/System/Library/Frameworks/Security.framework/Security,/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
      fileURLToPath(new URL("./mcp-oauth-keychain-worker.ts", import.meta.url)),
    ],
    clearEnv: true,
    env: { DENO_NO_UPDATE_CHECK: "1" },
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const terminate = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* exited */
    }
  };
  const timer = setTimeout(terminate, 10000);
  try {
    const [, output, status] = await Promise.all([
      writeOAuthJson(child.stdin, { service, ...(value === undefined ? {} : { value }) }),
      readOAuthJson(child.stdout, 2 * 1024 * 1024),
      child.status,
    ]);
    const result = oauthRecord(output);
    if (
      !status.success ||
      result.ok !== true ||
      (result.value !== undefined && typeof result.value !== "string")
    )
      throw new McpOAuthError("storage_unavailable");
    return result.value as string | undefined;
  } catch {
    throw new McpOAuthError("storage_unavailable");
  } finally {
    clearTimeout(timer);
    terminate();
    await child.status;
  }
};
