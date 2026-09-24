import { fileURLToPath } from "node:url";
import {
  mcpOAuthStatus,
  mcpOAuthDiagnostic,
} from "../../backend/daemon/src/daemon/mcp-oauth-status.ts";
import { logoutMcpOAuth } from "../../backend/daemon/src/daemon/mcp-oauth-logout.ts";
import { loadConfig } from "../../backend/daemon/src/config/config.ts";
import { nixMcpRuntime, mcpGrantsSchema } from "../../core/src/mcp-config.ts";
import { resolveRuntime } from "../../runtime/src/packaged/artifact.ts";
import { prepareRuntime } from "./runtime.ts";

/** Operate on definitions by name; defining/preparing a server does not select it. */
export const mcpCommand = async (
  args: string[],
  repo: string,
  opts: { json: boolean; smolvm?: string; noBrowser?: boolean },
) => {
  const [action, name, ...rest] = args;
  if (
    !action ||
    !["prepare", "status", "update", "login", "logout"].includes(action) ||
    rest.length
  )
    throw new Error(
      "Usage: loom mcp prepare|status|update [name] | login|logout <name> [--no-browser] [--json]",
    );
  if ((action === "login" || action === "logout") && !name)
    throw new Error("An MCP server name is required");
  if (opts.noBrowser && action !== "login")
    throw new Error("--no-browser is only valid for mcp login");
  if (action === "logout") {
    const result = await logoutMcpOAuth(name!);
    if (!result.invalidated) Deno.exitCode = 1;
    return opts.json
      ? JSON.stringify(result) + "\n"
      : name +
          ": logged out locally; revocation " +
          result.revocation +
          (result.invalidated ? "\n" : "; live relay invalidation incomplete — retry logout\n");
  }
  if (action === "login") {
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        "--allow-sys",
        "--allow-ffi",
        "--allow-net=127.0.0.1",
        fileURLToPath(new URL("./mcp-login.ts", import.meta.url)),
        repo,
        name!,
        ...(opts.noBrowser ? ["--no-browser"] : []),
        ...(opts.json ? ["--json"] : []),
      ],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    const status = await child.status;
    Deno.exitCode = status.code;
    return "";
  }
  const config = loadConfig(repo);
  const catalog = config.mcpServers ?? {};
  const names = name
    ? [name]
    : [...config.mcp, ...config.httpMcp]
        .map((m) => m.name)
        .filter((n) => Object.hasOwn(catalog, n));
  const rows: Array<Record<string, unknown>> = [];
  for (const name of names) {
    if (!Object.hasOwn(catalog, name)) throw new Error(`Unknown mcp_servers.${name}`);
    const entry = catalog[name]!;
    try {
      if (entry.source.kind === "http") {
        if (entry.auth?.oauth) {
          const auth = await mcpOAuthStatus(name, entry.source.url, entry.auth.oauth);
          rows.push({
            name,
            transport: "http",
            status: auth.state,
            auth,
            ...(!["ready", "refresh_required"].includes(auth.state)
              ? { error: mcpOAuthDiagnostic(name, auth.state) }
              : {}),
          });
          if (!["ready", "refresh_required"].includes(auth.state)) Deno.exitCode = 1;
          continue;
        }
        const credential = entry.auth?.bearer_token_env;
        if (!entry.auth?.bearer_token && credential && !Deno.env.get(credential))
          throw new Error(`Missing credential environment variable ${credential}`);
        rows.push({
          name,
          status: "configured",
          transport: "http",
          connectivity: "checked at session launch",
        });
        continue;
      }
      const runtime = entry.source.kind === "nix" ? nixMcpRuntime(entry.source) : entry.source.ref;
      const prepared =
        action === "status"
          ? await resolveRuntime(runtime)
          : await prepareRuntime(runtime, {
              ...(opts.smolvm ? { smolvm: opts.smolvm } : {}),
              update: action === "update",
            });
      rows.push({
        name,
        status: "ready",
        artifact: prepared.lock.artifact,
        system: prepared.manifest.system,
        grants: mcpGrantsSchema.parse(entry.grants ?? {}),
      });
    } catch (error) {
      rows.push({
        name,
        status: "not ready",
        error: error instanceof Error ? error.message : String(error),
      });
      Deno.exitCode = 1;
    }
  }
  if (opts.json) return JSON.stringify(rows, null, 2) + "\n";
  if (!rows.length)
    return "No MCP servers selected. Define mcp_servers and select session.mcp_servers.\n";
  return (
    rows
      .map((r) => {
        if (r.auth) {
          const auth = r.auth as Awaited<ReturnType<typeof mcpOAuthStatus>>;
          if (r.error) return String(r.error);
          const expiry = auth.expiresAt ? " · expires " + auth.expiresAt : " · expiry unknown";
          return r.name + ": oauth · " + auth.state.replaceAll("_", " ") + expiry;
        }
        return `${r.name}: ${r.status}${r.error ? " — " + r.error : ""}`;
      })
      .join("\n") + "\n"
  );
};
