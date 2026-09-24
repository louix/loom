import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import {
  OAuthTransportError,
  prepareOAuthEndpoint,
  validateOAuthUrl,
  type OAuthEndpoint,
} from "./mcp-oauth-endpoint.ts";
import { oauthRecord, readOAuthJson, writeOAuthJson } from "./mcp-oauth-helper-io.ts";
import { launchLocalWorker, type WorkerLauncher } from "./worker-launch.ts";

export interface OAuthDiscoveryNetwork {
  resolve(url: string, signal?: AbortSignal): Promise<OAuthEndpoint>;
  get(endpoint: OAuthEndpoint, signal?: AbortSignal): Promise<Response>;
}

interface NetworkOptions {
  /** Enable only when the configured MCP resource is itself loopback. */
  allowLoopback?: boolean;
  timeoutMs?: number;
  launch?: WorkerLauncher;
}

/** All DNS and HTTP happen in isolated children; callers need no network permission. */
export const createOAuthDiscoveryNetwork = (
  options: NetworkOptions = {},
): OAuthDiscoveryNetwork => {
  const allowLoopback = options.allowLoopback === true;
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new OAuthTransportError("invalid_request");
  const root = new URL("../../../../", import.meta.url);
  const launch = options.launch ?? launchLocalWorker;
  const run = async (
    worker: "dns" | "discovery",
    net: readonly string[],
    input: unknown,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    if (signal?.aborted) throw new OAuthTransportError("aborted");
    let child;
    try {
      child = launch({
        executable: Deno.execPath(),
        entrypoint: fileURLToPath(new URL("./mcp-oauth-" + worker + "-worker.ts", import.meta.url)),
        configPath: fileURLToPath(new URL("deno.json", root)),
        cwd: fileURLToPath(root),
        env: { DENO_TLS_CA_STORE: "system,mozilla", DENO_NO_UPDATE_CHECK: "1" },
        permissions: { read: [], write: [], net: [...net], env: [], run: [] },
      });
    } catch {
      throw new OAuthTransportError("network_error");
    }
    // Cover startup, blocked stdin, body reading and process exit with one deadline.
    let timer: ReturnType<typeof setTimeout>;
    let abort = () => {};
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(new OAuthTransportError("aborted"));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(() => reject(new OAuthTransportError("timeout")), timeoutMs);
    });
    const tasks = [
      writeOAuthJson(child.input, input),
      readOAuthJson(child.output, limit),
      child.exited,
    ] as const;
    const operation = Promise.all(tasks);
    try {
      const [, reply, status] = await Promise.race([operation, stopped]);
      // Local workers return Deno.CommandStatus. Test/custom launchers may return void.
      if (status && typeof status === "object" && "success" in status && !status.success)
        throw new OAuthTransportError("network_error");
      return oauthRecord(reply);
    } catch (error) {
      throw error instanceof OAuthTransportError ? error : new OAuthTransportError("network_error");
    } finally {
      clearTimeout(timer!);
      signal?.removeEventListener("abort", abort);
      child.terminate();
      await Promise.allSettled(tasks);
      await child.cleanup?.();
    }
  };
  return {
    async resolve(input, signal) {
      const url = validateOAuthUrl(input, allowLoopback);
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      if (signal?.aborted) throw new OAuthTransportError("aborted");
      if (isIP(hostname))
        return prepareOAuthEndpoint({ url: url.href, addresses: [hostname] }, allowLoopback);
      if (hostname.length > 253) throw new OAuthTransportError("endpoint_denied");
      const reply = await run("dns", [hostname], { hostname }, 4096, signal);
      if (!Array.isArray(reply.addresses) || !reply.addresses.every((a) => typeof a === "string"))
        throw new OAuthTransportError("network_error");
      return prepareOAuthEndpoint({ url: url.href, addresses: reply.addresses }, allowLoopback);
    },
    async get(endpoint, signal) {
      // Rebuild the plan; callers cannot supply broader grants through its net field.
      const plan = prepareOAuthEndpoint(
        {
          url: endpoint.url,
          addresses: endpoint.addresses.map((a) => a.address),
        },
        allowLoopback,
      );
      const reply = await run(
        "discovery",
        plan.net,
        {
          url: plan.url,
          addresses: plan.addresses.map((a) => a.address),
          allowLoopback,
        },
        7 * 1024 * 1024,
        signal,
      );
      if ("error" in reply) {
        switch (reply.error) {
          case "endpoint_denied":
          case "address_denied":
          case "invalid_request":
          case "request_too_large":
          case "response_too_large":
          case "redirect_denied":
          case "encoding_denied":
          case "timeout":
          case "aborted":
          case "network_error":
            throw new OAuthTransportError(reply.error);
          default:
            throw new OAuthTransportError("network_error");
        }
      }
      if (
        !Number.isInteger(reply.status) ||
        Number(reply.status) < 200 ||
        Number(reply.status) > 599 ||
        typeof reply.body !== "string" ||
        !Array.isArray(reply.headers) ||
        !reply.headers.every(
          (h) => Array.isArray(h) && h.length === 2 && h.every((s) => typeof s === "string"),
        )
      )
        throw new OAuthTransportError("network_error");
      try {
        return new Response(reply.status === 204 || reply.status === 205 ? null : reply.body, {
          status: Number(reply.status),
          headers: reply.headers as [string, string][],
        });
      } catch {
        throw new OAuthTransportError("network_error");
      }
    },
  };
};
