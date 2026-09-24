/** Explicit host login entrypoint. Only loopback callback network authority. */
import { loadConfig } from "../../backend/daemon/src/config/config.ts";
import { loginMcpOAuth } from "../../backend/daemon/src/daemon/mcp-oauth-login.ts";
import { McpOAuthError } from "../../backend/daemon/src/daemon/mcp-oauth-model.ts";
const [repo, name, ...flags] = Deno.args;
const stop = new AbortController();
const cancel = () => stop.abort();
Deno.addSignalListener("SIGINT", cancel);
Deno.addSignalListener("SIGTERM", cancel);
try {
  if (!repo || !name || flags.some((f) => !["--json", "--no-browser"].includes(f)))
    throw new Error("Invalid MCP login arguments");
  const entry = loadConfig(repo).mcpServers?.[name];
  if (!entry || entry.source.kind !== "http" || !entry.auth?.oauth)
    throw new Error("Named server is not configured for OAuth");
  const resource = entry.source.url;
  const result = await loginMcpOAuth({
    name,
    resource,
    config: entry.auth.oauth,
    signal: stop.signal,
    async present(url, scopes) {
      console.error(
        "MCP: " +
          resource +
          "\nAuthorization: " +
          new URL(url).origin +
          "\nScopes: " +
          (scopes?.join(" ") || "(server default)"),
      );
      if (!flags.includes("--no-browser")) {
        try {
          const browser = new Deno.Command(Deno.build.os === "darwin" ? "open" : "xdg-open", {
            args: [url],
            stdin: "null",
            stdout: "null",
            stderr: "null",
            signal: stop.signal,
          }).spawn();
          const deadline = setTimeout(() => {
            try {
              browser.kill("SIGKILL");
            } catch {
              /* exited */
            }
          }, 3000);
          try {
            if ((await browser.status).success) return;
          } finally {
            clearTimeout(deadline);
          }
        } catch {
          /* Print the URL if no desktop opener is available. */
        }
      }
      console.error(url);
    },
  });
  console.log(
    flags.includes("--json")
      ? JSON.stringify({ name, status: "ready", ...result })
      : name + ": logged in",
  );
} catch (error) {
  const reason = error instanceof McpOAuthError ? error.code : "login_failed";
  console.error("MCP OAuth: " + reason);
  Deno.exitCode = 1;
} finally {
  Deno.removeSignalListener("SIGINT", cancel);
  Deno.removeSignalListener("SIGTERM", cancel);
}
