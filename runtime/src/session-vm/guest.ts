/** Guest-only bootstrap: local proxy adapter, isolated auth, then the normal worker. */
import { sessionAuth } from "./auth.ts";
const auth = sessionAuth(JSON.parse(await Deno.readTextFile("/run/loom/private/auth.json")));
if (auth.claudeAiOauth) {
  await Deno.mkdir("/tmp/loom-home/.claude", { recursive: true });
  await Deno.symlink("/run/loom/private/auth.json", "/tmp/loom-home/.claude/.credentials.json");
}
for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const)
  if (typeof auth[key] === "string") Deno.env.set(key, auth[key]);
Deno.env.set("HTTPS_PROXY", "http://127.0.0.1:3128");
Deno.env.set("HTTP_PROXY", "http://127.0.0.1:3128");
Deno.env.set("NO_PROXY", "localhost,127.0.0.1");
Deno.env.set("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
Deno.env.set("DISABLE_AUTOUPDATER", "1");
Deno.env.set("IS_SANDBOX", "1");
Deno.env.set("SHELL", Deno.env.get("LOOM_GUEST_SHELL")!);
await Deno.mkdir("/tmp/loom-home", { recursive: true });
await Deno.writeTextFile(
  "/tmp/loom-home/.claude.json",
  JSON.stringify({ hasCompletedOnboarding: true }),
);
const listener = Deno.listen({ hostname: "127.0.0.1", port: 3128 });
const relay = async (client: Deno.Conn) => {
  let host: Deno.Conn | undefined;
  try {
    host = await Deno.connect({ transport: "unix", path: "/run/loom/egress.sock" });
    await Promise.race([
      client.readable.pipeTo(host.writable, { preventClose: true }),
      host.readable.pipeTo(client.writable, { preventClose: true }),
    ]);
  } catch {
    /* Endpoint closed. */
  } finally {
    try {
      client.close();
    } catch {
      /* closed */
    }
    try {
      host?.close();
    } catch {
      /* closed */
    }
  }
};
void (async () => {
  for await (const conn of listener) void relay(conn);
})();
// The launcher binds the native CLI by its fixed guest PATH name.
await import("../worker/main.ts");
