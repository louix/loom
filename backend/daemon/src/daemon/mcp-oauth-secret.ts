import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { McpOAuthError, type McpOAuthConfig } from "./mcp-oauth-model.ts";

/** Explicit-login only. Never called by preflight, status or refresh. */
export const resolveOAuthClientSecret = async (
  config: McpOAuthConfig,
  signal?: AbortSignal,
): Promise<string | undefined> => {
  if (signal?.aborted) throw new McpOAuthError("cancelled");
  const valid = (value: string | undefined): string => {
    // eslint-disable-next-line no-control-regex -- Reject control bytes from secret providers.
    if (!value || new TextEncoder().encode(value).length > 65536 || /[\x00-\x1f\x7f]/.test(value))
      throw new McpOAuthError("secret_failed");
    return value;
  };
  if (config.client_secret_env) return valid(Deno.env.get(config.client_secret_env));
  if (!config.client_secret_command) return undefined;
  const [command, ...args] = config.client_secret_command;
  const child = spawn(command!, args, {
    cwd: homedir(),
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let stopped = false;
  const kill = () => {
    if (!stopped) {
      stopped = true;
      try {
        if (child.pid) Deno.kill(-child.pid, "SIGKILL");
      } catch {
        /* already exited */
      }
    }
  };
  try {
    return await new Promise<string>((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      const fail = () => {
        kill();
        reject(new McpOAuthError(signal?.aborted ? "cancelled" : "secret_failed"));
      };
      const timer = setTimeout(fail, 60000);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", fail);
      };
      signal?.addEventListener("abort", fail, { once: true });
      if (signal?.aborted) fail();
      child.once("error", () => {
        cleanup();
        fail();
      });
      child.stdout!.on("data", (chunk: Uint8Array) => {
        size += chunk.length;
        if (size > 65536) fail();
        else if (!stopped) chunks.push(chunk);
      });
      child.once("close", (code) => {
        cleanup();
        if (stopped || code !== 0) {
          fail();
          return;
        }
        try {
          const value = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
          resolve(valid(value.replace(/\r?\n$/, "")));
        } catch {
          fail();
        }
      });
    });
  } finally {
    kill();
    child.stdout!.destroy();
  }
};
